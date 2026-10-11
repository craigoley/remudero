/**
 * lib/action-executor.ts — W1-T4657: the executor an approved automation-action-v1 step lacked.
 *
 * A CLOSED, VERSIONED CATALOGUE binds a capability ref in the `rmd.` namespace to the SAME function
 * its served route already calls (panel-actions.ts's `arm*`), never a second side-effect path. Each
 * entry names that route's write tier, the risk and approval policy an action must declare, its
 * rollback capability, and the ledger step that proves it ran.
 *
 * {@link executeCatalogueAction} admits through automation-action.ts's own engine (preflight ready,
 * approval satisfied, one execution per idempotency key — a repeat returns the first receipt), then
 * runs the handler and writes the completion receipt ITSELF, with `evidenceRef` naming the handler's
 * own ledger row. Nothing a caller claims enters that receipt. A caller-posted completion is labelled
 * {@link SELF_REPORTED_CODE} by operator-agent.ts instead.
 *
 * TIER SAFETY: the caller tier is the tier the dispatcher proved for the EXECUTING route, and it must
 * satisfy the entry's route tier — so a HIGH capability runs only through a HIGH route (confirm nonce
 * included), never through the MIDDLE execute route. Nothing financial, destructive or
 * credential-touching is catalogued.
 */
import {
  completeAutomationAction,
  evaluateAutomationAction,
  type AutomationAction,
  type AutomationActionReceipt,
  type AutomationApprovalDecision,
  type AutomationPreconditionObservation,
  type AutomationPreflightFinding,
  type AutomationPreflightResult,
  type DelegationRiskTier,
} from "./automation-action.js";
import { systemClock, type Clock } from "./clock.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, lstat, link, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isPrActionSwitchedOff, isSafeTaskId, isStopped, type PrActionName } from "./fleet-control.js";
import { armKick, armPause, armPrAction, armResume, prActionSwitchedOffDetail, type PanelActionDeps, type PanelLedgerRow } from "./panel-actions.js";
import { writeTierSatisfies, type WriteTier } from "./service.js";
import { assessContribution, classifyContribution, readAdmissionRestAsync, type AdmissionSettings,
  type AdmissionTarget, type AdmissionRead, type AdmissionRecord, type AdmissionAssessment } from "./contributor-admission.js";

export const ACTION_CATALOGUE_VERSION = "action-catalogue-v1" as const;
/** Every capability under this prefix is the executor's: an uncatalogued one is `no-executor`, never self-reported. */
export const ACTION_CATALOGUE_NAMESPACE = "rmd.";
/** The completion-receipt `code` for evidence an executor wrote, and for a caller's own claim. */
export const EXECUTOR_EVIDENCE_CODE = "executor";
export const SELF_REPORTED_CODE = "self-reported";

type ExecutorPaths = Pick<PanelActionDeps, "root" | "ledgerPath">;
type Target = { kind: "task"; taskId: string } | { kind: "pr"; prNumber: number } | { kind: "none" };
type Refusal = { code: string; detail: string };
type HandlerResult = { ok: boolean; row: PanelLedgerRow; reason: string };

/** `ledger:<step>@<ts>#<run_id>` — the executor's own row, the only evidence an executor receipt carries. */
export function executorEvidenceRef(row: PanelLedgerRow): string {
  return `ledger:${row.step}@${row.ts}#${row.run_id}`;
}

function prEntry(capability: string, action: PrActionName): CatalogueEntry {
  return {
    capability,
    target: "pr",
    handler: "armPrAction",
    route: "POST /v1/pr-actions",
    tier: "low",
    risk: "low",
    approval: "none",
    rollback: { mode: "irreversible", reason: "a recorded review or repair request enters the daemon's own pipeline and cannot be un-sent" },
    proofStep: "console.pr_action_requested",
    refusal: (paths) => (isPrActionSwitchedOff(paths.root, action) ? { code: "switched-off", detail: prActionSwitchedOffDetail(action) } : undefined),
    run: (paths, target, origin, link) => {
      const outcome = armPrAction(paths, action, (target as { prNumber: number }).prNumber, origin, undefined, link);
      return outcome.switchedOff ? { ok: false, row: outcome.row, reason: prActionSwitchedOffDetail(action) } : { ok: true, row: outcome.row, reason: `${action} requested` };
    },
  };
}

/** One catalogue entry: what an action must declare to run it, and the served handler it reuses. */
export interface CatalogueEntry {
  readonly capability: string;
  /** `task` and `pr` refs carry their target after a colon (`rmd.task.kick:W1-T1`), so approval binds it. */
  readonly target: Target["kind"];
  readonly handler: string;
  readonly route: string;
  readonly tier: WriteTier;
  /** The action must declare exactly this risk; the validator then forces `human` for a gated one. */
  readonly risk: DelegationRiskTier;
  readonly approval: "none" | "human";
  readonly rollback: { readonly mode: "reversible"; readonly capability: string } | { readonly mode: "irreversible"; readonly reason: string };
  readonly proofStep: string;
  readonly refusal?: (paths: ExecutorPaths) => Refusal | undefined;
  readonly run: (paths: ExecutorPaths, target: Target, origin: string, link: Record<string, unknown>, action: AutomationAction) => HandlerResult;
}

export const ACTION_CATALOGUE: readonly CatalogueEntry[] = Object.freeze([
  {
    capability: "rmd.task.kick",
    target: "task",
    handler: "armKick",
    route: "POST /v1/drain/kick",
    tier: "high",
    risk: "high",
    approval: "human",
    rollback: { mode: "irreversible", reason: "a dispatched task spends before any undo could land" },
    proofStep: "console.kick_requested",
    run: (paths, target, origin, link) => {
      const taskId = (target as { taskId: string }).taskId;
      return { ok: true, row: armKick(paths, taskId, origin, link), reason: `kick armed for ${taskId}` };
    },
  },
  prEntry("rmd.pr.review", "review"),
  prEntry("rmd.pr.repair", "fix"),
  {
    capability: "rmd.fleet.pause",
    target: "none",
    handler: "armPause",
    route: "POST /v1/control/pause",
    tier: "middle",
    risk: "medium",
    approval: "human",
    rollback: { mode: "reversible", capability: "rmd.fleet.resume" },
    proofStep: "panel.pause_requested",
    run: (paths, _target, origin, link, action) => ({ ok: true, row: armPause(paths, action.summary, origin, link).row, reason: "fleet paused" }),
  },
  {
    capability: "rmd.fleet.resume",
    target: "none",
    handler: "armResume",
    route: "POST /v1/control/resume",
    tier: "middle",
    risk: "medium",
    approval: "human",
    rollback: { mode: "reversible", capability: "rmd.fleet.pause" },
    proofStep: "panel.resume_requested",
    // The route clears STOP as well as PAUSE; an automation action may only lift a pause.
    refusal: (paths) => (isStopped(paths.root) ? { code: "stop-active", detail: "a fleet STOP is active; an automation action only lifts a pause, so clear STOP by hand" } : undefined),
    run: (paths, _target, origin, link) => ({ ok: true, row: armResume(paths, origin, link).row, reason: "fleet resumed" }),
  },
]);

/** Resolves a capability ref to its entry and parsed target, or the named reason it has no executor. */
export function resolveCatalogueCapability(capability: string): { ok: true; entry: CatalogueEntry; target: Target } | ({ ok: false } & Refusal) {
  const colon = capability.indexOf(":");
  const ref = colon < 0 ? capability : capability.slice(0, colon);
  const arg = colon < 0 ? undefined : capability.slice(colon + 1);
  const entry = ACTION_CATALOGUE.find((candidate) => candidate.capability === ref);
  if (!entry) return { ok: false, code: "no-executor", detail: `no catalogued executor for capability ${capability}` };
  const invalid = { ok: false as const, code: "invalid-target", detail: `${ref} takes ${entry.target === "none" ? "no target" : `a ${entry.target} target`}, not ${JSON.stringify(arg ?? "")}` };
  if (entry.target === "none") return arg === undefined ? { ok: true, entry, target: { kind: "none" } } : invalid;
  if (entry.target === "task") return isSafeTaskId(arg) ? { ok: true, entry, target: { kind: "task", taskId: arg } } : invalid;
  const prNumber = arg !== undefined && /^[1-9][0-9]{0,8}$/.test(arg) ? Number(arg) : 0;
  return prNumber > 0 ? { ok: true, entry, target: { kind: "pr", prNumber } } : invalid;
}

/** Everything the catalogue refuses before the engine may admit: each enters preflight as a refused finding. */
function catalogueFindings(request: CatalogueExecutionRequest): { findings: AutomationPreflightFinding[]; resolved?: { entry: CatalogueEntry; target: Target } } {
  const refuse = (code: string, detail: string): AutomationPreflightFinding => ({ outcome: "refused", code, detail });
  const resolved = resolveCatalogueCapability(request.action.capability);
  if (!resolved.ok) return { findings: [refuse(resolved.code, resolved.detail)] };
  const { entry } = resolved;
  const { action } = request;
  const findings: AutomationPreflightFinding[] = [];
  if (!request.executor) findings.push(refuse("executor-unavailable", `this daemon wired no fleet root for ${entry.capability}`));
  if (!writeTierSatisfies(request.callerTier, entry.tier)) {
    findings.push(refuse("tier-insufficient", `${entry.capability} reuses ${entry.route} (${entry.tier} tier); this request was proven only ${request.callerTier}`));
  }
  if (action.risk !== entry.risk) findings.push(refuse("risk-mismatch", `${entry.capability} must declare risk ${entry.risk}, not ${action.risk}`));
  if (entry.approval === "human" && action.approval.policy !== "human") findings.push(refuse("approval-too-weak", `${entry.capability} requires approval.policy human`));
  if (entry.rollback.mode === "irreversible" && action.rollback.mode === "reversible") {
    findings.push(refuse("rollback-mismatch", `${entry.capability} is irreversible: ${entry.rollback.reason}`));
  }
  const refusal = request.executor ? entry.refusal?.(request.executor) : undefined;
  if (refusal) findings.push(refuse(refusal.code, refusal.detail));
  return { findings, resolved };
}

export interface CatalogueExecutionRequest {
  readonly action: AutomationAction;
  readonly receipts: readonly AutomationActionReceipt[];
  readonly approval?: AutomationApprovalDecision;
  readonly observations: readonly AutomationPreconditionObservation[];
  /** Refusals derived outside the catalogue (an intent plan's withdrawal, a delegation's profile). */
  readonly eligibility?: readonly AutomationPreflightFinding[];
  readonly dryRun?: boolean;
  readonly clock: Clock;
  /** The write tier the dispatcher proved for the executing route — never a caller's claim. */
  readonly callerTier: WriteTier;
  readonly origin: string;
  /** The fleet root and ledger the reused handlers write; absent refuses every entry `executor-unavailable`. */
  readonly executor?: ExecutorPaths;
  /** Ledger fields the admission receipt carries (a delegation's cost usage). */
  readonly admissionExtra?: Record<string, unknown>;
  readonly appendReceipt: (receipt: AutomationActionReceipt, extra: Record<string, unknown>) => void;
}

export interface CatalogueExecution {
  readonly disposition: "completed" | "reused" | "refused" | "dry-run";
  readonly receipt: AutomationActionReceipt;
  readonly admission?: AutomationActionReceipt;
  readonly preflight?: AutomationPreflightResult;
  readonly executor?: PanelLedgerRow;
}

function runHandler(entry: CatalogueEntry, target: Target, request: CatalogueExecutionRequest): Omit<HandlerResult, "row"> & { row?: PanelLedgerRow } {
  try {
    return entry.run(request.executor!, target, request.origin, { automation_action_id: request.action.actionId }, request.action);
  } catch (err) {
    return { ok: false, reason: `executor threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Runs one catalogue action. Refusals (catalogue or preflight) and dry runs are decided by the
 * engine and appended exactly as the execute route appends them; a duplicate idempotency key
 * returns the first receipt and runs nothing. Only an admission runs the handler, and the
 * completion it appends names that handler's own ledger row.
 */
export function executeCatalogueAction(request: CatalogueExecutionRequest): CatalogueExecution {
  const { findings, resolved } = catalogueFindings(request);
  const step = evaluateAutomationAction({
    action: request.action,
    observations: request.observations,
    receipts: request.receipts,
    ...(request.approval ? { approval: request.approval } : {}),
    ...(request.dryRun ? { dryRun: true } : {}),
    clock: request.clock,
    eligibility: [...(request.eligibility ?? []), ...findings],
  });
  const tag = { catalogue_version: ACTION_CATALOGUE_VERSION };
  const preflight = step.preflight ? { preflight: step.preflight } : {};
  if (step.disposition !== "admitted") {
    if (step.append) request.appendReceipt(step.receipt, tag);
    const disposition = step.disposition === "dry-run" || step.disposition === "reused" ? step.disposition : "refused";
    return { disposition, receipt: step.receipt, ...preflight };
  }
  const admission = step.receipt;
  request.appendReceipt(admission, { ...tag, ...request.admissionExtra });
  const ran = runHandler(resolved!.entry, resolved!.target, request);
  const completion = completeAutomationAction({
    action: request.action,
    receipts: [...request.receipts, admission],
    admissionReceiptId: admission.receiptId,
    outcome: ran.ok ? "succeeded" : "failed",
    ...(ran.row ? { evidenceRef: executorEvidenceRef(ran.row) } : {}),
    reason: ran.reason,
    clock: request.clock,
  });
  const receipt = completion.disposition === "completed" ? { ...completion.receipt, code: EXECUTOR_EVIDENCE_CODE } : completion.receipt;
  const executor = ran.row ? { executor: ran.row } : {};
  if (completion.append) {
    const rowFields = ran.row ? { executor_step: ran.row.step, executor_ts: ran.row.ts, executor_run_id: ran.row.run_id } : {};
    request.appendReceipt(receipt, { ...tag, evidence_source: EXECUTOR_EVIDENCE_CODE, ...rowFields });
  }
  return { disposition: completion.disposition === "completed" ? "completed" : "refused", receipt, admission, ...preflight, ...executor };
}

export type DispositionDomain = "shadow" | "rehearsal";
export type AdmissionDispositionStatus = "not-enabled" | "trusted" | "would-close" | "pending" | "owner-action" | "noop" | "adopted" | "simulated-closed";
export interface AdmissionDispositionReceipt {
  version: "admission-disposition-v1";
  domain: DispositionDomain;
  cause: string;
  sequence: number;
  previous: string;
  firstReason: string;
  reason: string;
  stage: "identity" | "close" | "escalation" | "terminal";
  status: AdmissionDispositionStatus;
  repositoryId: number;
  prNumber: number;
  itemId?: number;
  headSha?: string;
  policy: string;
  atMs: number;
  identityAttempts: number;
  reconciliationAttempts: number;
  closeAttempts: number;
  escalationAttempts: number;
}
export interface AdmissionDispositionStore {
  domain: DispositionDomain;
  load: (cause: string) => Promise<readonly AdmissionDispositionReceipt[]>;
  append: (receipt: AdmissionDispositionReceipt) => Promise<void>;
}
export interface AdmissionDispositionSimulation {
  domain: "rehearsal";
  simulateClose: (receipt: AdmissionDispositionReceipt) => Promise<void>;
  simulateEscalation: (receipt: AdmissionDispositionReceipt) => Promise<void>;
  reconcile: (receipt: AdmissionDispositionReceipt) => Promise<{ closed: boolean; escalated: boolean }>;
}
export interface AdmissionDispositionRequest {
  settings?: AdmissionSettings;
  target: AdmissionTarget;
  ownerInstructionId?: number;
}
export interface AdmissionDispositionResult {
  status: AdmissionDispositionStatus;
  reason: string;
  permission: "not-granted";
  laneReleased: boolean;
  requiredChecks: "ordinary-current-head-checks-required";
  receipt?: AdmissionDispositionReceipt;
}

export async function executeAdmissionDisposition(
  request: AdmissionDispositionRequest, store: AdmissionDispositionStore, sourceRead: AdmissionRead,
  record: AdmissionRecord, clock: Pick<Clock, "now">, simulation?: AdmissionDispositionSimulation,
): Promise<AdmissionDispositionResult> {
  const { settings, target } = request;
  const result = (status: AdmissionDispositionStatus, reason: string,
    receipt?: AdmissionDispositionReceipt): AdmissionDispositionResult => {
    const value: AdmissionDispositionResult = { status, reason, permission: "not-granted", laneReleased: status !== "pending",
      requiredChecks: "ordinary-current-head-checks-required", ...(receipt ? { receipt } : {}) };
    try { record("contributor_disposition.shadow", { status, reason, permission: value.permission,
      mode: "shadow", evidence_domain: store.domain, admission_lane_released: value.laneReleased,
      repository_id: settings?.repositoryId, pr_number: target.prNumber, head_sha: receipt?.headSha,
      cause: receipt?.cause, sequence: receipt?.sequence, first_reason: receipt?.firstReason }); }
    catch { /* A lost diagnostic neither grants permission nor changes the ordinary PR flow. */ }
    return value;
  };
  if (!settings || settings.mode !== "shadow" || settings.disposition !== "shadow") {
    return { status: "not-enabled", reason: "not-enabled", permission: "not-granted", laneReleased: true,
      requiredChecks: "ordinary-current-head-checks-required" };
  }
  if (!positiveId(settings.repositoryId) || !positiveId(target.prNumber)
    || !/^[A-Za-z0-9_.-]+$/.test(target.owner) || !/^[A-Za-z0-9_.-]+$/.test(target.repo)
    || (target.headSha !== undefined && !/^[a-f0-9]{40}$/i.test(target.headSha))) return result("owner-action", "invalid-target");
  if (store.domain !== "shadow" && store.domain !== "rehearsal"
    || (store.domain === "rehearsal") !== (simulation?.domain === "rehearsal")) return result("owner-action", "domain-mismatch");
  const cause = dispositionHash([store.domain, settings.repositoryId, target.owner, target.repo, target.prNumber]);
  let history: readonly AdmissionDispositionReceipt[];
  try { history = await store.load(cause); validateDispositionHistory(history, store.domain, cause); }
  catch { /* Missing/corrupt/incomplete history is unknown, never a fresh effect budget. */
    return result("owner-action", "journal-unreadable"); }
  let last = history.at(-1);
  const started = clock.now();
  const policy = dispositionHash(settings);
  let reads = 0;
  const read: AdmissionRead = async path => {
    if (++reads > 32 || !withinDispositionTime(started, clock.now(), settings.policy.maxEvidenceAgeMs)) {
      throw new Error("disposition-read-bound");
    }
    return sourceRead(path);
  };
  const commit = async (status: AdmissionDispositionStatus, reason: string, stage: AdmissionDispositionReceipt["stage"],
    counts: Partial<Pick<AdmissionDispositionReceipt, "identityAttempts" | "reconciliationAttempts" | "closeAttempts" | "escalationAttempts">> = {},
    itemId?: number): Promise<AdmissionDispositionReceipt> => {
    const row: AdmissionDispositionReceipt = { version: "admission-disposition-v1", domain: store.domain, cause,
      sequence: history.length, previous: last ? dispositionHash(last) : "root", firstReason: last?.firstReason ?? "selected-origin-reconciliation",
      status, reason, stage, repositoryId: settings.repositoryId, prNumber: target.prNumber,
      ...(itemId === undefined ? last?.itemId === undefined ? {} : { itemId: last.itemId } : { itemId }),
      ...(target.headSha === undefined ? {} : { headSha: target.headSha }), policy, atMs: clock.now(),
      identityAttempts: last?.identityAttempts ?? 0, reconciliationAttempts: last?.reconciliationAttempts ?? 0,
      closeAttempts: last?.closeAttempts ?? 0, escalationAttempts: last?.escalationAttempts ?? 0, ...counts };
    validateDispositionHistory([...history, row], store.domain, cause);
    await store.append(row);
    history = [...history, row]; last = row;
    return row;
  };
  const terminal = async (reason: string) => result("owner-action", reason, await commit("owner-action", reason, "terminal"));
  try {
    if (last?.status === "simulated-closed" || last?.status === "noop") return result(last.status, last.reason, last);
    if (request.ownerInstructionId !== undefined) {
      if (!positiveId(request.ownerInstructionId)) return result("owner-action", "invalid-owner-instruction", last);
      const preflight = await dispositionPreflight(settings, target, read, clock);
      if (!preflight.assessment || preflight.status === "noop") return result("owner-action", preflight.reason, last);
      const response = await read(`repos/${target.owner}/${target.repo}/issues/comments/${request.ownerInstructionId}`);
      const instruction = dispositionObject(response.body), actor = dispositionObject(instruction.user);
      const revised = typeof instruction.updated_at === "string" ? Date.parse(instruction.updated_at) : NaN;
      if (response.status !== 200 || instruction.id !== request.ownerInstructionId || actor.type !== "User"
        || !settings.policy.ownerIds.includes(actor.id as number)
        || instruction.issue_url !== `https://api.github.com/repos/${target.owner}/${target.repo}/issues/${target.prNumber}`
        || !Number.isFinite(revised) || revised < (last?.atMs ?? started) || revised > clock.now()
        || clock.now() - revised > settings.policy.maxEvidenceAgeMs
        || instruction.body !== `Remudero-Admission: adopt ${settings.repositoryId}/${target.prNumber}@${preflight.assessment.subject.headSha}`) {
        return result("owner-action", "owner-instruction-unverified", last);
      }
      const final = await dispositionPreflight(settings, target, read, clock);
      if (!final.assessment || final.binding !== preflight.binding || dispositionHash(settings) !== policy) {
        return result("owner-action", "owner-target-changed", last);
      }
      return result("adopted", "owner-current-head-adoption", await commit("adopted", "owner-current-head-adoption", "terminal", {}, final.itemId));
    }
    if (last?.status === "owner-action") return result("owner-action", last.reason, last);
    const escalateSimulation = async (): Promise<AdmissionDispositionResult> => {
      const intent = await commit("pending", "simulated-escalation-intent", "escalation", { escalationAttempts: 1 });
      try { await simulation!.simulateEscalation(intent); }
      catch { /* Lost acknowledgement is pending reconciliation; never blindly repeat the escalation. */
        return result("pending", "simulated-escalation-ambiguous", intent); }
      return result("simulated-closed", "simulated-close-and-escalation-confirmed",
        await commit("simulated-closed", "simulated-close-and-escalation-confirmed", "terminal"));
    };
    if (last?.closeAttempts === 1) {
      if (!simulation) return result("owner-action", "domain-mismatch", last);
      if (last.reconciliationAttempts >= 2) return terminal("ambiguous-effect-exhausted");
      const pending = await commit("pending", "simulated-effect-reconciliation", last.stage,
        { reconciliationAttempts: last.reconciliationAttempts + 1 });
      let evidence: { closed: boolean; escalated: boolean };
      try { evidence = await simulation.reconcile(pending); }
      catch { /* Unreadable simulated effect evidence remains unknown within the same cumulative budget. */
        return pending.reconciliationAttempts >= 2 ? terminal("ambiguous-effect-exhausted") : result("pending", "simulated-reconciliation-unreadable", pending); }
      if (evidence.closed !== true || pending.escalationAttempts === 1 && evidence.escalated !== true) {
        return pending.reconciliationAttempts >= 2 ? terminal("ambiguous-effect-exhausted") : result("pending", "simulated-effect-unresolved", pending);
      }
      if (pending.escalationAttempts === 0) return escalateSimulation();
      return result("simulated-closed", "simulated-close-and-escalation-confirmed",
        await commit("simulated-closed", "simulated-close-and-escalation-confirmed", "terminal"));
    }
    if ((last?.identityAttempts ?? 0) >= 3) return terminal("identity-recovery-exhausted");
    await commit("pending", "identity-assessment-intent", "identity", { identityAttempts: (last?.identityAttempts ?? 0) + 1 });
    const preflight = await dispositionPreflight(settings, target, read, clock);
    if (preflight.status === "pending") {
      return last!.identityAttempts >= 3 ? terminal(preflight.reason)
        : result("pending", preflight.reason, await commit("pending", preflight.reason, "identity"));
    }
    if (preflight.status === "trusted" || preflight.status === "noop") {
      return result(preflight.status, preflight.reason, await commit(preflight.status, preflight.reason, "terminal", {}, preflight.itemId));
    }
    if (!simulation) return result("would-close", preflight.reason, await commit("would-close", preflight.reason, "terminal", {}, preflight.itemId));
    const intent = await commit("pending", "simulated-close-intent", "close", { closeAttempts: 1 }, preflight.itemId);
    const current = await dispositionPreflight(settings, target, read, clock);
    if (current.status !== "would-close" || current.binding !== preflight.binding || dispositionHash(settings) !== policy) {
      return terminal("close-preflight-changed");
    }
    try { await simulation.simulateClose(intent); }
    catch { /* A lost close response is NOT proof that the simulated effect never ran. */
      return result("pending", "simulated-close-ambiguous", intent); }
    return escalateSimulation();
  } catch {
    // Persistence or preflight failure releases only this observer lane, without granting permission or claiming a durable terminal.
    return result("owner-action", "disposition-unavailable", last);
  }
}

const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const dispositionHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dispositionObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const withinDispositionTime = (started: number, now: number, age: number): boolean =>
  Number.isFinite(started) && now >= started && now - started <= Math.min(age, 15_000);

async function dispositionPreflight(settings: AdmissionSettings, target: AdmissionTarget, read: AdmissionRead,
  clock: Pick<Clock, "now">): Promise<{ status: "trusted" | "pending" | "noop" | "would-close"; reason: string;
    assessment?: AdmissionAssessment; binding?: string; itemId?: number }> {
  const unknown = (reason: string) => ({ status: "pending" as const, reason });
  const slug = `${target.owner}/${target.repo}`, repoPath = `repos/${slug}`, policy = dispositionHash(settings);
  try {
    const repository = await read(repoPath), repo = dispositionObject(repository.body);
    if (repository.status !== 200 || repo.id !== settings.repositoryId || repo.full_name !== slug
      || repo.private !== false || repo.archived === true) return unknown("public-target-unverified");
    const response = await read(`${repoPath}/pulls/${target.prNumber}`), first = dispositionObject(response.body);
    if (response.status !== 200 || !positiveId(first.id) || first.number !== target.prNumber) return unknown("ordinary-pr-unverified");
    const fingerprint = (pull: Record<string, unknown>) => {
      const head = dispositionObject(pull.head), base = dispositionObject(pull.base);
      return dispositionHash([pull.id, pull.number, pull.state, pull.merged, pull.merged_at, pull.user, head, base]);
    };
    const head = dispositionObject(first.head), base = dispositionObject(first.base), headRepo = dispositionObject(head.repo), baseRepo = dispositionObject(base.repo);
    if (baseRepo.id !== settings.repositoryId || baseRepo.full_name !== slug || baseRepo.private !== false
      || !positiveId(headRepo.id) || headRepo.private !== false || typeof headRepo.full_name !== "string"
      || !/^[a-f0-9]{40}$/i.test(String(head.sha)) || typeof head.ref !== "string" || typeof base.ref !== "string") {
      return unknown("ordinary-public-context-unverified");
    }
    if (first.state === "closed" || first.merged === true || typeof first.merged_at === "string") {
      return { status: "noop", reason: "already-terminal", itemId: first.id };
    }
    if (first.state !== "open" || first.merged !== false || first.merged_at !== null) return unknown("ordinary-pr-state-unverified");
    if (target.headSha !== undefined && head.sha !== target.headSha) return unknown("head-changed");
    const assessment = await assessContribution(settings, { ...target, headSha: String(head.sha) }, "disposition", read, clock);
    if (!assessment?.currentPull) return unknown(assessment?.decision.reason ?? "origin-unreadable");
    if (fingerprint(assessment.currentPull) !== fingerprint(first)) return unknown("ordinary-pr-context-changed");
    const finalRepo = await read(repoPath), currentRepo = dispositionObject(finalRepo.body);
    if (finalRepo.status !== 200 || currentRepo.id !== repo.id || currentRepo.full_name !== slug
      || currentRepo.private !== false || currentRepo.archived === true || dispositionHash(settings) !== policy) return unknown("target-or-policy-changed");
    const decision = classifyContribution(assessment.subject, "disposition", settings.policy, assessment.memberships, clock.now());
    if (decision.outcome === "unknown") return unknown(decision.reason);
    return { status: decision.outcome === "trusted" ? "trusted" : "would-close", reason: decision.reason,
      assessment, binding: fingerprint(assessment.currentPull), itemId: first.id };
  } catch {
    // HTTP, identity and freshness failures are unknown; none is confirmed external on timeout.
    return unknown("origin-unreadable");
  }
}

function validateDispositionHistory(history: readonly AdmissionDispositionReceipt[], domain: DispositionDomain, cause: string): void {
  if (history.length > 16) throw new Error("disposition-history-bound");
  let prior: AdmissionDispositionReceipt | undefined;
  for (const row of history) {
    if (row.version !== "admission-disposition-v1" || row.domain !== domain || row.cause !== cause
      || row.sequence !== (prior ? prior.sequence + 1 : 0) || row.previous !== (prior ? dispositionHash(prior) : "root")
      || !positiveId(row.repositoryId) || !positiveId(row.prNumber) || !Number.isFinite(row.atMs)
      || !/^[a-f0-9]{64}$/.test(row.policy) || !/^[a-z-]{1,80}$/.test(row.firstReason) || !/^[a-z-]{1,80}$/.test(row.reason)
      || !["pending", "trusted", "would-close", "owner-action", "noop", "adopted", "simulated-closed"].includes(row.status)
      || !["identity", "close", "escalation", "terminal"].includes(row.stage)
      || (row.status === "simulated-closed" && domain !== "rehearsal")) throw new Error("disposition-history-invalid");
    for (const [field, ceiling] of [["identityAttempts", 3], ["reconciliationAttempts", 2], ["closeAttempts", 1], ["escalationAttempts", 1]] as const) {
      if (!Number.isInteger(row[field]) || row[field] < (prior?.[field] ?? 0) || row[field] > ceiling) throw new Error("disposition-budget-invalid");
    }
    if (prior && (row.firstReason !== prior.firstReason || row.repositoryId !== prior.repositoryId
      || row.prNumber !== prior.prNumber || prior.itemId !== undefined && row.itemId !== prior.itemId)) throw new Error("disposition-cause-changed");
    prior = row;
  }
}

export function admissionDispositionStore(root: string, domain: DispositionDomain = "shadow"): AdmissionDispositionStore {
  const directory = join(root, "state", "contributor-disposition", domain);
  const paths = async (cause: string): Promise<string> => {
    if (!isAbsolute(root) || !/^[a-f0-9]{64}$/.test(cause)) throw new Error("disposition-path-invalid");
    for (const path of [root, join(root, "state"), join(root, "state", "contributor-disposition"), directory, join(directory, cause)]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("disposition-path-untrusted");
    }
    return join(directory, cause);
  };
  const readFile = async (path: string): Promise<string | undefined> => {
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) throw new Error("disposition-record-unreadable");
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  };
  return { domain,
    load: async cause => {
      const path = await paths(cause), rows: AdmissionDispositionReceipt[] = [];
      let missing = false;
      for (let sequence = 0; sequence <= 16; sequence++) {
        const text = await readFile(join(path, `${sequence}.json`));
        if (text === undefined) { missing = true; continue; }
        if (missing || sequence === 16) throw new Error("disposition-record-gap-or-bound");
        rows.push(JSON.parse(text) as AdmissionDispositionReceipt);
      }
      validateDispositionHistory(rows, domain, cause);
      return rows;
    },
    append: async receipt => {
      const path = await paths(receipt.cause), temporary = join(path, `.pending-${randomUUID()}`);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); }
      finally { await handle.close(); }
      try {
        await link(temporary, join(path, `${receipt.sequence}.json`));
        const dir = await open(path, "r");
        try { await dir.sync(); } finally { await dir.close(); }
      } finally { await unlink(temporary); }
    } };
}

export async function observeAdmissionDisposition(settings: AdmissionSettings | undefined, target: AdmissionTarget,
  root: string, record: AdmissionRecord, ownerInstructionId?: number,
  read: AdmissionRead = readAdmissionRestAsync, clock: Pick<Clock, "now"> = systemClock): Promise<AdmissionDispositionResult | undefined> {
  if (!settings || settings.disposition !== "shadow") return undefined;
  return executeAdmissionDisposition({ settings, target, ownerInstructionId }, admissionDispositionStore(root), read, record, clock);
}
