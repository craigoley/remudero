/**
 * W1-T4559: action-handoff-v1 — the ONLY path from a console assistant conversation to an operator
 * write, and deliberately separate from the read-only answer-v1 (operator-agent-answer.ts).
 *
 * PREPARE validates a typed intent against a closed allowlist of reversible catalogue verbs
 * (action-executor.ts), binds it to this instance's server-owned repository, runs the verb's own
 * policy as a dry run, and stores an expiring preview behind a single-use confirmation identity.
 * It never touches the target. EXECUTE takes that identity plus an explicit `confirm: true` from
 * the SAME verified operator, claims it exactly once, revalidates freshness, scope, target state and
 * policy, then delegates to {@link executeCatalogueAction}. Every claimed execution ends in one
 * durable receipt whose outcome is `succeeded`, `refused`, or `unresolved` — a throw or a lost
 * receipt is unresolved, never success-shaped. High-tier, irreversible, financial, destructive and
 * credential verbs stay out of v1; the operator's confirmation is a per-action approval, never a
 * standing grant, and nothing a model writes (an answer, a URL, a token) is read as authority.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_CATALOGUE, executeCatalogueAction, type CatalogueEntry, type CatalogueExecution } from "./action-executor.js";
import { AUTOMATION_ACTION_VERSION, automationRedactionViolation, type AutomationAction, type DelegationRiskTier } from "./automation-action.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { isPaused, isStopped } from "./fleet-control.js";
import { appendPanelLedger, jsonAction, sendJson } from "./panel-actions.js";
import { verifiedActor, type Route, type WriteTier } from "./service.js";

export const ACTION_HANDOFF_VERSION = "action-handoff-v1" as const;
export const ACTION_HANDOFF_RECEIPT_STEP = "operator_agent.action_handoff_receipt";
const AUTOMATION_RECEIPT_STEP = "operator_agent.action_handoff_automation_receipt";
const DEFAULT_TTL_MS = 5 * 60_000;
const ID = /^[A-Za-z0-9._:-]{8,128}$/;
const CONFIRMATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** v1 allowlist: verb -> catalogue capability. Eligibility is re-derived from the catalogue entry. */
const HANDOFF_VERBS: Readonly<Record<string, string>> = Object.freeze({ "fleet.pause": "rmd.fleet.pause", "fleet.resume": "rmd.fleet.resume" });
const EXCLUDED_RISKS: ReadonlySet<DelegationRiskTier> = new Set(["high", "production", "financial", "credential", "destructive"]);
const SUMMARY: Readonly<Record<string, string>> = Object.freeze({
  "fleet.pause": "Pause dispatch: running work drains and no new task starts until resumed.",
  "fleet.resume": "Resume dispatch: lifts a pause; a STOP is never lifted by this action.",
});

export interface ActionHandoffDeps {
  /** The fleet-control root the delegated verb writes: the target. */
  root: string;
  ledgerPath: string;
  /** Where preparations, claims and receipts live; never a target. */
  claimRoot: string;
  instance: string;
  repository?: string;
  clock?: Clock;
  ttlMs?: number;
  /** Test seam; production delegates to the catalogue executor. */
  execute?: (request: Parameters<typeof executeCatalogueAction>[0]) => CatalogueExecution;
}

type TargetState = { paused: boolean; stopped: boolean };
export type ActionHandoffOutcome = "succeeded" | "refused" | "unresolved";
export interface ActionHandoffResult { status: number; body: Record<string, unknown> }

interface PrepareInput { intentId: string; verb: string; instance: string; repository: string }
interface ExecuteInput { confirmationId: string; confirm: true; verb: string; instance: string; repository: string }
interface Prepared {
  confirmationId: string; intentId: string; actorHash: string; fingerprint: string; targetDigest: string;
  expiresAtMs: number; preview: Record<string, unknown>;
}

export interface ActionHandoffReceipt {
  version: typeof ACTION_HANDOFF_VERSION;
  receiptId: string;
  confirmationId: string;
  intentId: string;
  verb: string;
  capability: string;
  instance: string;
  repository: string;
  actorHash: string;
  outcome: ActionHandoffOutcome;
  code: string;
  reason: string;
  at: string;
  automationReceiptId?: string;
  evidenceRef?: string;
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const refusal = (status: number, code: string, detail: string, extra: Record<string, unknown> = {}): ActionHandoffResult =>
  ({ status, body: { version: ACTION_HANDOFF_VERSION, outcome: "refused", code, detail, ...extra } });

export function actionHandoffPaths(deps: Pick<ActionHandoffDeps, "claimRoot">, confirmationId: string) {
  const dir = join(deps.claimRoot, "state", "assistant-action-handoffs");
  const key = sha(confirmationId);
  return { dir, prepared: join(dir, `${key}.prepared.json`), claim: join(dir, `${key}.claim.json`), receipt: join(dir, `${key}.receipt.json`) };
}

function writeExclusive(path: string, body: string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
}

function writeDurable(path: string, body: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeExclusive(temp, body);
  renameSync(temp, path);
}

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** The catalogue entry a v1 verb delegates to, or why it is unavailable. */
function eligible(verb: string): { ok: true; entry: CatalogueEntry; recovery: string } | { ok: false; code: "unknown_verb" | "excluded_in_v1" } {
  const capability = HANDOFF_VERBS[verb];
  const entry = ACTION_CATALOGUE.find((candidate) => candidate.capability === (capability ?? `rmd.${verb}`));
  if (!entry) return { ok: false, code: "unknown_verb" };
  const rollback = entry.rollback;
  const recovery = rollback.mode === "reversible" ? Object.keys(HANDOFF_VERBS).find((name) => HANDOFF_VERBS[name] === rollback.capability) : undefined;
  if (!capability || recovery === undefined || entry.target !== "none" || entry.tier === "high" || EXCLUDED_RISKS.has(entry.risk)) return { ok: false, code: "excluded_in_v1" };
  return { ok: true, entry, recovery };
}

function observeTarget(deps: ActionHandoffDeps): TargetState {
  return { paused: isPaused(deps.root), stopped: isStopped(deps.root) };
}

function targetDigest(verb: string, instance: string, repository: string, state: TargetState): string {
  return sha(JSON.stringify({ verb, instance, repository, state }));
}

/** The automation-action record the catalogue executor admits; every field is server-owned. */
function automationAction(deps: ActionHandoffDeps, prepared: Pick<Prepared, "confirmationId">, verb: string, entry: CatalogueEntry, repository: string, nowMs: number, expiresAtMs: number): AutomationAction {
  const clock = fixedClock(nowMs);
  return {
    version: AUTOMATION_ACTION_VERSION, actionId: `${ACTION_HANDOFF_VERSION}:${sha(prepared.confirmationId).slice(0, 32)}`,
    capability: entry.capability, summary: SUMMARY[verb] ?? verb,
    scope: { flowId: ACTION_HANDOFF_VERSION, instance: deps.instance, repo: repository }, risk: entry.risk,
    preconditions: [{ id: "target-state", source: "server:fleet-control", description: "fleet-control state equals the previewed state" }],
    freshness: { maxAgeSeconds: Math.max(1, Math.ceil((deps.ttlMs ?? DEFAULT_TTL_MS) / 1000)) },
    idempotencyKey: `${ACTION_HANDOFF_VERSION}:${sha(prepared.confirmationId)}`,
    createdAt: clock.iso(), expiresAt: fixedClock(Math.max(expiresAtMs, nowMs + 1000)).iso(), dryRun: true,
    approval: { policy: entry.approval },
    rollback: entry.rollback.mode === "reversible" ? { mode: "reversible", plan: `run ${entry.rollback.capability}` } : { mode: "irreversible", refusal: entry.rollback.reason },
    receiptRef: `ledger:${ACTION_HANDOFF_RECEIPT_STEP}`,
  };
}

function delegate(deps: ActionHandoffDeps, actor: string, action: AutomationAction, nowMs: number, dryRun: boolean): CatalogueExecution {
  const at = fixedClock(nowMs).iso();
  return (deps.execute ?? executeCatalogueAction)({
    action, receipts: [], dryRun, clock: fixedClock(nowMs), callerTier: "middle", origin: actor,
    // The operator's explicit confirmation of THIS preview is the only approval; no standing grant is read.
    ...(dryRun ? {} : { approval: { decision: "approved" as const, decidedBy: actor, decidedAt: at } }),
    observations: [{ preconditionId: "target-state", state: "satisfied", source: "server:fleet-control", observedAt: at }],
    executor: { root: deps.root, ledgerPath: deps.ledgerPath },
    appendReceipt: dryRun ? () => undefined : (receipt, extra) =>
      appendPanelLedger(deps.ledgerPath, AUTOMATION_RECEIPT_STEP, receipt.actionId, actor, { action_id: receipt.actionId, receipt, ...extra }),
  });
}

/** Refuses anything a model, not the operator's typed choice, would have supplied. */
function screen(body: unknown, fields: readonly string[]): ActionHandoffResult | Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return refusal(400, "invalid_request", "body must be a JSON object");
  const record = body as Record<string, unknown>;
  const redaction = automationRedactionViolation(record);
  if (redaction) return refusal(400, "model_supplied_authority", `field ${redaction.field} carries credential-shaped authority; the console session is the only authority`);
  if (record.version === "answer-v1" || "answer" in record || "citations" in record) return refusal(400, "answer_not_authority", "an answer-v1 payload never executes or confirms an action");
  const unknown = Object.keys(record).find((key) => !fields.includes(key));
  if (unknown) return refusal(400, "unknown_field", `action-handoff-v1 does not accept ${unknown}`);
  for (const key of ["verb", "instance", "repository"]) {
    if (typeof record[key] !== "string" || !record[key] || (record[key] as string).length > 128) return refusal(400, "invalid_request", `${key} is required`);
  }
  return record;
}

export function validatePrepare(body: unknown): ActionHandoffResult | PrepareInput {
  const record = screen(body, ["intentId", "verb", "instance", "repository"]);
  if ("status" in record) return record as ActionHandoffResult;
  if (typeof record.intentId !== "string" || !ID.test(record.intentId)) return refusal(400, "invalid_request", "intentId must be an 8-128 character stable identifier");
  return { intentId: record.intentId, verb: String(record.verb), instance: String(record.instance), repository: String(record.repository) };
}

export function validateExecute(body: unknown): ActionHandoffResult | ExecuteInput {
  const record = screen(body, ["confirmationId", "confirm", "verb", "instance", "repository"]);
  if ("status" in record) return record as ActionHandoffResult;
  if (record.confirm !== true) return refusal(400, "confirmation_required", "execute requires the operator's explicit confirm: true");
  if (typeof record.confirmationId !== "string" || !CONFIRMATION_ID.test(record.confirmationId)) return refusal(400, "invalid_request", "confirmationId must be a prepared confirmation identity");
  return { confirmationId: record.confirmationId, confirm: true, verb: String(record.verb), instance: String(record.instance), repository: String(record.repository) };
}

function readPrepared(path: string): Prepared {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Prepared;
  if (typeof parsed.actorHash !== "string" || typeof parsed.targetDigest !== "string" || typeof parsed.expiresAtMs !== "number") throw new Error("preparation is incomplete");
  return parsed;
}

/** PREPARE: typed, allowlisted, instance-scoped, non-mutating. A repeated intent returns its first preview. */
export function prepareActionHandoff(deps: ActionHandoffDeps, actor: string, input: PrepareInput): ActionHandoffResult {
  const verb = eligible(input.verb);
  if (!verb.ok) return refusal(verb.code === "unknown_verb" ? 400 : 403, verb.code, `${input.verb} is not an action-handoff-v1 verb`);
  if (input.instance !== deps.instance) return refusal(409, "cross_instance", `this route acts only for instance ${deps.instance}`);
  if (!deps.repository) return refusal(409, "repository_unverified", "the serving instance has no verified repository identity");
  if (input.repository.toLowerCase() !== deps.repository.toLowerCase()) return refusal(409, "cross_repository", `this instance acts only for ${deps.repository}`);
  const nowMs = (deps.clock ?? systemClock).now();
  const actorHash = sha(actor);
  const fingerprint = sha(JSON.stringify({ actorHash, verb: input.verb, instance: deps.instance, repository: deps.repository }));
  const intentPath = join(actionHandoffPaths(deps, "").dir, `${sha(`${actorHash}:${input.intentId}`)}.intent.json`);
  const existing = (): ActionHandoffResult => {
    const confirmationId = String((JSON.parse(readFileSync(intentPath, "utf8")) as { confirmationId?: unknown }).confirmationId);
    const prior = readPrepared(actionHandoffPaths(deps, confirmationId).prepared);
    if (prior.fingerprint !== fingerprint) return refusal(409, "intent_conflict", `intentId ${input.intentId} already names a different action`);
    return { status: 200, body: { ...prior.preview, existing: true } };
  };
  try {
    return existing();
  } catch (error) {
    const reason = `the handoff store is unreadable: ${(error as Error).message}`;
    if (errno(error) !== "ENOENT") return refusal(503, "store_unavailable", reason);
  }
  const state = observeTarget(deps);
  const expiresAtMs = nowMs + (deps.ttlMs ?? DEFAULT_TTL_MS);
  const confirmationId = randomUUID();
  let preview: CatalogueExecution;
  try {
    preview = delegate(deps, actor, automationAction(deps, { confirmationId }, input.verb, verb.entry, deps.repository, nowMs, expiresAtMs), nowMs, true);
  } catch (error) {
    const reason = `the ${verb.entry.capability} policy could not be evaluated: ${(error as Error).message}`;
    return refusal(503, "policy_unavailable", reason);
  }
  // The dry run precedes the confirmation, so a pending approval is the one finding a preview expects.
  const findings = (preview.preflight?.findings ?? []).filter((finding) => finding.code !== "approval-pending");
  if (preview.disposition !== "dry-run" && (findings.length > 0 || !preview.preflight)) {
    const named = findings.map((finding) => ({ code: finding.code, detail: finding.detail }));
    return refusal(409, "policy_refused", `the ${verb.entry.capability} policy refuses this action now`, { findings: named });
  }
  const body = {
    version: ACTION_HANDOFF_VERSION, confirmationId, intentId: input.intentId, verb: input.verb, capability: verb.entry.capability,
    target: { kind: "fleet-control", instance: deps.instance, repository: deps.repository, state },
    tier: verb.entry.tier satisfies WriteTier,
    consequence: { risk: verb.entry.risk, reversible: true, summary: SUMMARY[input.verb] ?? input.verb },
    recovery: { verb: verb.recovery, capability: HANDOFF_VERBS[verb.recovery], plan: `prepare and confirm ${verb.recovery}` },
    preparedAt: fixedClock(nowMs).iso(), expiresAt: fixedClock(expiresAtMs).iso(),
    mutated: false, confirmation: "explicit-operator-confirmation-required",
  };
  const paths = actionHandoffPaths(deps, confirmationId);
  try {
    mkdirSync(paths.dir, { recursive: true });
    const record: Prepared = { confirmationId, intentId: input.intentId, actorHash, fingerprint, targetDigest: targetDigest(input.verb, deps.instance, deps.repository, state), expiresAtMs, preview: body };
    writeExclusive(paths.prepared, JSON.stringify(record));
    try {
      writeExclusive(intentPath, JSON.stringify({ confirmationId }));
    } catch (error) {
      unlinkSync(paths.prepared);
      if (errno(error) === "EEXIST") return existing();
      throw error;
    }
  } catch (error) {
    const reason = `the preview could not be stored: ${(error as Error).message}`;
    return refusal(503, "store_unavailable", reason);
  }
  return { status: 201, body };
}

function replayed(paths: ReturnType<typeof actionHandoffPaths>, confirmationId: string): ActionHandoffResult {
  try {
    const receipt = JSON.parse(readFileSync(paths.receipt, "utf8")) as ActionHandoffReceipt;
    return { status: 409, body: { version: ACTION_HANDOFF_VERSION, outcome: "refused", code: "replayed", detail: "this confirmation was already used", receipt } };
  } catch (error) {
    const reason = `the confirmation was claimed without a readable receipt (${errno(error) ?? "unreadable"}); reconcile before any new intent`;
    return { status: 409, body: { version: ACTION_HANDOFF_VERSION, outcome: "unresolved", code: "replayed", confirmationId, detail: reason } };
  }
}

/** EXECUTE: single-use, explicitly confirmed, revalidated, delegated, receipted. */
export function executeActionHandoff(deps: ActionHandoffDeps, actor: string, input: ExecuteInput): ActionHandoffResult {
  const paths = actionHandoffPaths(deps, input.confirmationId);
  let prepared: Prepared;
  try {
    prepared = readPrepared(paths.prepared);
  } catch (error) {
    const reason = `the preparation is unreadable: ${(error as Error).message}`;
    return errno(error) === "ENOENT"
      ? refusal(404, "unknown_handoff", "no prepared action has this confirmation identity")
      : refusal(503, "store_unavailable", reason);
  }
  const actorHash = sha(actor);
  if (prepared.actorHash !== actorHash) return refusal(403, "actor_mismatch", "only the operator who prepared this action may confirm it");
  const nowMs = (deps.clock ?? systemClock).now();
  try {
    writeExclusive(paths.claim, JSON.stringify({ at: fixedClock(nowMs).iso(), actorHash }));
  } catch (error) {
    const reason = `durable single-use claim unavailable: ${(error as Error).message}`;
    if (errno(error) === "EEXIST") return replayed(paths, input.confirmationId);
    return refusal(503, "claim_unavailable", reason);
  }
  const preview = prepared.preview as { verb: string; capability: string; target: { instance: string; repository: string } };
  const base = { version: ACTION_HANDOFF_VERSION, receiptId: randomUUID(), confirmationId: input.confirmationId, intentId: prepared.intentId,
    verb: preview.verb, capability: preview.capability, instance: preview.target.instance, repository: preview.target.repository, actorHash };
  const finish = (outcome: ActionHandoffOutcome, code: string, reason: string, extra: Partial<ActionHandoffReceipt> = {}): ActionHandoffResult => {
    const receipt: ActionHandoffReceipt = { ...base, outcome, code, reason, at: fixedClock(nowMs).iso(), ...extra };
    try {
      writeDurable(paths.receipt, JSON.stringify(receipt));
      appendPanelLedger(deps.ledgerPath, ACTION_HANDOFF_RECEIPT_STEP, receipt.receiptId, actor, { receipt });
    } catch (error) {
      return { status: 503, body: { ...receipt, outcome: outcome === "refused" ? "refused" : "unresolved", detail: `receipt not durable: ${(error as Error).message}` } };
    }
    return { status: outcome === "succeeded" ? 200 : outcome === "refused" ? 409 : 202, body: { ...receipt } };
  };
  if (nowMs > prepared.expiresAtMs) return finish("refused", "stale_preview", "the preview expired before confirmation");
  if (input.verb !== preview.verb || input.instance !== preview.target.instance || input.repository !== preview.target.repository) {
    return finish("refused", "target_changed", "the confirmed action differs from the previewed action");
  }
  if (deps.instance !== preview.target.instance || (deps.repository ?? "").toLowerCase() !== preview.target.repository.toLowerCase()) {
    return finish("refused", "scope_changed", "this route no longer serves the previewed instance and repository");
  }
  if (targetDigest(preview.verb, preview.target.instance, preview.target.repository, observeTarget(deps)) !== prepared.targetDigest) {
    return finish("refused", "target_changed", "the target state changed after the preview");
  }
  const verb = eligible(preview.verb);
  if (!verb.ok || verb.entry.capability !== preview.capability) return finish("refused", "policy_changed", `${preview.verb} is no longer an action-handoff-v1 verb`);
  let run: CatalogueExecution;
  try {
    run = delegate(deps, actor, automationAction(deps, prepared, preview.verb, verb.entry, preview.target.repository, nowMs, prepared.expiresAtMs), nowMs, false);
  } catch (error) {
    const reason = `the delegated verb did not report an outcome: ${(error as Error).message}`;
    return finish("unresolved", "outcome_unknown", reason);
  }
  const link = { automationReceiptId: run.receipt.receiptId, ...(run.receipt.evidenceRef ? { evidenceRef: run.receipt.evidenceRef } : {}) };
  if (run.disposition === "completed" && run.receipt.outcome === "succeeded") return finish("succeeded", "executed", run.receipt.reason, link);
  if (run.disposition === "refused" && !run.admission) return finish("refused", "policy_refused", `${run.receipt.code ?? "refused"}: ${run.receipt.reason}`, link);
  return finish("unresolved", "outcome_unknown", `admitted without a successful completion: ${run.receipt.reason}`, link);
}

function route(path: string, tier: WriteTier, validate: (body: unknown) => ActionHandoffResult | object, act: (actor: string, input: never) => ActionHandoffResult): Route {
  return {
    method: "POST", path, scope: "write", tier,
    handler: jsonAction((body: unknown) => ({ checked: validate(body) }), ({ checked }, req, res) => {
      const actor = verifiedActor(req);
      if (!actor) return sendJson(res, 403, { version: ACTION_HANDOFF_VERSION, outcome: "refused", code: "verified_operator_required" });
      const result = "status" in checked && "body" in checked ? checked as ActionHandoffResult : act(actor, checked as never);
      sendJson(res, result.status, result.body);
    }),
  };
}

/** Prepare is LOW tier (it writes no target); execute is MIDDLE, the tier of the verbs it delegates to. */
export function buildOperatorAgentActionHandoffRoutes(deps: ActionHandoffDeps): Route[] {
  return [
    route("/v1/operator-agent/action-handoff/prepare", "low", validatePrepare, (actor, input: PrepareInput) => prepareActionHandoff(deps, actor, input)),
    route("/v1/operator-agent/action-handoff/execute", "middle", validateExecute, (actor, input: ExecuteInput) => executeActionHandoff(deps, actor, input)),
  ];
}
