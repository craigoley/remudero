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
import type { Clock } from "./clock.js";
import { isPrActionSwitchedOff, isSafeTaskId, isStopped, type PrActionName } from "./fleet-control.js";
import { armKick, armPause, armPrAction, armResume, prActionSwitchedOffDetail, type PanelActionDeps, type PanelLedgerRow } from "./panel-actions.js";
import { writeTierSatisfies, type WriteTier } from "./service.js";

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
