/**
 * src/lib/emergency-control.ts — W1-T3900: STOP SAFELY UNDER PRESSURE.
 *
 * An `emergency-stop-v1` is an operator's incident-response circuit, independent of the
 * per-capability/per-envelope revocation `capability-grant.ts` (W1-T3880) and
 * `automation-action.ts` (W1-T3883) already carry: one action binds a blast-radius SCOPE
 * (`fleet`/`repository`/`instance`/`principal`), a reason, an issuer, and a linked incident
 * receipt, and while it is active every in-scope admission check below refuses BY NAME rather
 * than falling through to the per-grant/per-envelope checks that predate it.
 *
 * THREE LOAD-BEARING INVARIANTS: (1) NEVER CLAIM A CANCELLATION THAT DID NOT HAPPEN —
 * {@link requestRunningEffectCancellation} reports `cancellation-unsupported` or
 * `cancellation-unobservable` rather than `cancellation-applied` whenever the connector cannot
 * confirm it. (2) CLEARING NEEDS FRESH, AUTHORITATIVE, COMPLETE EVIDENCE —
 * {@link clearEmergencyStop} refuses on stale/non-healthy evidence or partial/unavailable
 * revocation-source coverage, never on trust alone. (3) EVERY REFUSAL, CANCELLATION, AND CLEAR
 * IS A RECEIPT LINKED TO THE STOP'S OWN INCIDENT — see {@link EmergencyReceipt.parentReceiptId}.
 *
 * FALSIFIER: let an in-scope action through an active stop, claim a connector cancelled work it
 * cannot cancel, clear from stale evidence, or omit the incident reason/scope. See
 * test/emergency-control-{scope,admission,running,clear,receipts}.test.ts.
 */

import { randomUUID } from "node:crypto";

export const EMERGENCY_STOP_SCHEMA_VERSION = "emergency-stop-v1" as const;

export const EMERGENCY_STOP_SCOPES = ["fleet", "repository", "instance", "principal"] as const;
export type EmergencyStopScope = (typeof EMERGENCY_STOP_SCOPES)[number];

/** A stop lifts automatically at `expiresAt` ("expires") or only via {@link clearEmergencyStop}
 *  ("explicit-clear-required") — never both, so a caller cannot silently pair an expiry with a
 *  policy that also claims to require explicit human confirmation. */
export const EMERGENCY_STOP_CLEAR_POLICIES = ["expires", "explicit-clear-required"] as const;
export type EmergencyStopClearPolicy = (typeof EMERGENCY_STOP_CLEAR_POLICIES)[number];

/**
 * A bound `emergency-stop-v1` action. Deep-frozen by {@link createEmergencyStop}; whether it is
 * cleared is tracked by the CALLER (a store/ledger), never by mutating this object — the same
 * split `automation-action.ts`'s `DelegationEnvelope`/revocation makes.
 */
export interface EmergencyStop {
  readonly schema: typeof EMERGENCY_STOP_SCHEMA_VERSION;
  readonly id: string;
  readonly scope: EmergencyStopScope;
  /** Required for every scope but `fleet`, which is total by definition and carries none. */
  readonly scopeTarget?: string;
  readonly reason: string;
  readonly issuedBy: string;
  readonly issuedAt: string;
  readonly clearPolicy: EmergencyStopClearPolicy;
  /** Present only when `clearPolicy` is `"expires"`. */
  readonly expiresAt?: string;
  /** `"*"` blocks every capability; otherwise an explicit allowlist this stop blocks. */
  readonly affectedCapabilities: readonly string[] | "*";
  readonly affectedDelegationClasses: readonly string[] | "*";
  /** The incident record this stop is accountable to — required: an unreasoned stop is refused
   *  at issuance, and every receipt this stop's lifecycle produces links back to this id. */
  readonly incidentReceiptId: string;
}

/** The caller-supplied shape {@link createEmergencyStop} validates and freezes. `id`/`issuedAt`
 *  default when omitted; `affectedCapabilities`/`affectedDelegationClasses` default to `"*"`. */
export interface EmergencyStopInput {
  id?: string;
  scope: EmergencyStopScope;
  scopeTarget?: string;
  reason: string;
  issuedBy: string;
  issuedAt?: string;
  clearPolicy: EmergencyStopClearPolicy;
  expiresAt?: string;
  affectedCapabilities?: readonly string[] | "*";
  affectedDelegationClasses?: readonly string[] | "*";
  incidentReceiptId: string;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function resolveNowMs(now: string | number | undefined): number {
  if (typeof now === "number") return now;
  if (typeof now === "string") return Date.parse(now);
  return Date.now();
}

/** Validates and freezes an {@link EmergencyStop}. Throws a plain `Error` on any missing or
 *  malformed required field — an incomplete stop is refused at the ISSUER, never stored. */
export function createEmergencyStop(input: EmergencyStopInput): EmergencyStop {
  if (!EMERGENCY_STOP_SCOPES.includes(input.scope)) {
    throw new Error(`emergency stop requires scope to be one of ${EMERGENCY_STOP_SCOPES.join(", ")}`);
  }
  if (input.scope === "fleet" && input.scopeTarget) {
    throw new Error('emergency stop scope "fleet" must not carry a scopeTarget — it is total by definition');
  }
  if (input.scope !== "fleet" && !input.scopeTarget) {
    throw new Error(`emergency stop scope ${JSON.stringify(input.scope)} requires a non-empty scopeTarget`);
  }
  if (!input.reason) throw new Error("emergency stop requires a non-empty reason");
  if (!input.issuedBy) throw new Error("emergency stop requires a non-empty issuedBy");
  if (!input.incidentReceiptId) throw new Error("emergency stop requires a non-empty incidentReceiptId");
  if (!EMERGENCY_STOP_CLEAR_POLICIES.includes(input.clearPolicy)) {
    throw new Error(`emergency stop requires clearPolicy to be one of ${EMERGENCY_STOP_CLEAR_POLICIES.join(", ")}`);
  }
  if (input.clearPolicy === "expires" && (!input.expiresAt || Number.isNaN(Date.parse(input.expiresAt)))) {
    throw new Error('emergency stop with clearPolicy "expires" requires a valid ISO-8601 expiresAt');
  }
  if (input.clearPolicy === "explicit-clear-required" && input.expiresAt) {
    throw new Error('emergency stop with clearPolicy "explicit-clear-required" must not carry an expiresAt');
  }
  const issuedAt = input.issuedAt && !Number.isNaN(Date.parse(input.issuedAt)) ? new Date(input.issuedAt).toISOString() : new Date().toISOString();
  const stop: EmergencyStop = {
    schema: EMERGENCY_STOP_SCHEMA_VERSION,
    id: input.id && input.id.length > 0 ? input.id : `estop-${randomUUID()}`,
    scope: input.scope,
    ...(input.scopeTarget ? { scopeTarget: input.scopeTarget } : {}),
    reason: input.reason,
    issuedBy: input.issuedBy,
    issuedAt,
    clearPolicy: input.clearPolicy,
    ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt).toISOString() } : {}),
    affectedCapabilities: input.affectedCapabilities ?? "*",
    affectedDelegationClasses: input.affectedDelegationClasses ?? "*",
    incidentReceiptId: input.incidentReceiptId,
  };
  return deepFreeze(stop);
}

/** True until `expiresAt` passes (for an `"expires"` stop) or `clearedStopIds` names it —
 *  `"explicit-clear-required"` never lifts on its own, matching the module header's invariant. */
export function isEmergencyStopActive(stop: EmergencyStop, clearedStopIds: ReadonlySet<string>, now: number = Date.now()): boolean {
  if (clearedStopIds.has(stop.id)) return false;
  if (stop.clearPolicy === "expires" && stop.expiresAt && now >= Date.parse(stop.expiresAt)) return false;
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Non-throwing structural validator for a STORED/serialized stop — the deserialization
 * counterpart to {@link createEmergencyStop}'s throwing issuance-time validation. A ledger-backed
 * store reconstructing state from raw JSON needs a row that fails re-validation to drop out
 * rather than throw; unlike {@link createEmergencyStop} this never defaults or normalises a
 * field, so a row only round-trips when it is byte-for-byte what issuance itself produced.
 */
export function parseStoredEmergencyStop(value: unknown): EmergencyStop | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== EMERGENCY_STOP_SCHEMA_VERSION) return null;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.scope !== "string" || !EMERGENCY_STOP_SCOPES.includes(v.scope as EmergencyStopScope)) return null;
  const scope = v.scope as EmergencyStopScope;
  if (scope === "fleet" ? v.scopeTarget !== undefined : typeof v.scopeTarget !== "string" || v.scopeTarget.length === 0) return null;
  if (typeof v.reason !== "string" || v.reason.length === 0) return null;
  if (typeof v.issuedBy !== "string" || v.issuedBy.length === 0) return null;
  if (typeof v.issuedAt !== "string" || Number.isNaN(Date.parse(v.issuedAt))) return null;
  if (typeof v.clearPolicy !== "string" || !EMERGENCY_STOP_CLEAR_POLICIES.includes(v.clearPolicy as EmergencyStopClearPolicy)) return null;
  const clearPolicy = v.clearPolicy as EmergencyStopClearPolicy;
  if (clearPolicy === "expires" ? typeof v.expiresAt !== "string" || Number.isNaN(Date.parse(v.expiresAt)) : v.expiresAt !== undefined) return null;
  if (v.affectedCapabilities !== "*" && !isStringArray(v.affectedCapabilities)) return null;
  if (v.affectedDelegationClasses !== "*" && !isStringArray(v.affectedDelegationClasses)) return null;
  if (typeof v.incidentReceiptId !== "string" || v.incidentReceiptId.length === 0) return null;
  return deepFreeze({
    schema: EMERGENCY_STOP_SCHEMA_VERSION,
    id: v.id,
    scope,
    ...(v.scopeTarget !== undefined ? { scopeTarget: v.scopeTarget as string } : {}),
    reason: v.reason,
    issuedBy: v.issuedBy,
    issuedAt: v.issuedAt,
    clearPolicy,
    ...(v.expiresAt !== undefined ? { expiresAt: v.expiresAt as string } : {}),
    affectedCapabilities: v.affectedCapabilities as readonly string[] | "*",
    affectedDelegationClasses: v.affectedDelegationClasses as readonly string[] | "*",
    incidentReceiptId: v.incidentReceiptId,
  }) as EmergencyStop;
}

/** PRIMARY CONTROL: the only place a receipt's `reason` text is capped, so a test can assert
 *  against this SAME bound. Mirrors automation-action.ts's identically-named precedent. */
export const EMERGENCY_RECEIPT_REASON_MAX_CHARS = 240;

function boundedText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export type EmergencyEventKind = "stop" | "refusal" | "cancellation" | "clear";

/** One bounded, attributable receipt for a stop's own issuance, an admission refusal, a running-
 *  effect cancellation attempt, or a clear — this task's fifth acceptance claim. `parentReceiptId`
 *  is always the stop's own `incidentReceiptId`, so every receipt a stop's lifecycle produces
 *  links back to the ONE incident it is accountable to. */
export interface EmergencyReceipt {
  readonly receiptId: string;
  readonly stopId: string;
  readonly parentReceiptId: string;
  readonly kind: EmergencyEventKind;
  readonly outcome: string;
  readonly decidedAt: string;
  readonly reason: string;
}

function makeReceipt(stop: EmergencyStop, kind: EmergencyEventKind, outcome: string, reason: string, decidedAt: string): EmergencyReceipt {
  return {
    receiptId: `ercpt-${randomUUID()}`,
    stopId: stop.id,
    parentReceiptId: stop.incidentReceiptId,
    kind,
    outcome,
    decidedAt,
    reason: boundedText(reason, EMERGENCY_RECEIPT_REASON_MAX_CHARS),
  };
}

/** Issues the "stop" event receipt for a just-created stop — the durable record that this
 *  blast-radius went into effect, linked to its incident like every later refusal/clear. */
export function emergencyStopIssuedReceipt(stop: EmergencyStop, opts: { now?: string | number } = {}): EmergencyReceipt {
  const decidedAt = new Date(resolveNowMs(opts.now)).toISOString();
  return makeReceipt(stop, "stop", "issued", `emergency stop ${stop.id} issued by ${stop.issuedBy}: ${stop.reason}`, decidedAt);
}

// ── Admission ────────────────────────────────────────────────────────────────────────────────

/** The four admission surfaces this task's design names; a stop's `affectedCapabilities`/
 *  `affectedDelegationClasses` narrow only `capability-use`/`agent-handoff` (see
 *  {@link checkEmergencyStop}) — `action-admission`/`follow-up-promotion` are scope-gated only,
 *  since neither names a capability or delegation class of its own. */
export type EmergencyActionKind = "action-admission" | "follow-up-promotion" | "capability-use" | "agent-handoff";

export interface EmergencyAdmissionRequest {
  readonly actionKind: EmergencyActionKind;
  readonly repo?: string;
  readonly instance?: string;
  readonly principal?: string;
  readonly capability?: string;
  readonly delegationClass?: string;
}

export type EmergencyRefusalCode = "emergency-stop-active";

export type EmergencyAdmissionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: EmergencyRefusalCode; readonly stopId: string; readonly receipt: EmergencyReceipt };

function stopMatchesTarget(stop: EmergencyStop, request: EmergencyAdmissionRequest): boolean {
  switch (stop.scope) {
    case "fleet":
      return true;
    case "repository":
      return stop.scopeTarget !== undefined && stop.scopeTarget === request.repo;
    case "instance":
      return stop.scopeTarget !== undefined && stop.scopeTarget === request.instance;
    case "principal":
      return stop.scopeTarget !== undefined && stop.scopeTarget === request.principal;
  }
}

function stopCoversClass(classes: readonly string[] | "*", requested: string | undefined): boolean {
  if (classes === "*") return true;
  if (!requested) return false;
  return classes.includes(requested);
}

/**
 * THE ONE ADMISSION SEAM every in-scope caller (operator-agent.ts's action registration,
 * follow-up promotion advance, and delegation handoff routes) consults before proceeding — see
 * `checkEmergencyStop(` in src/lib/operator-agent.ts. `activeStops` is caller-supplied (already
 * filtered by {@link isEmergencyStopActive}) so this function stays pure and independently
 * testable. Refuses BY NAME: the returned receipt's `reason` names both the blocked
 * `actionKind` and the stop that blocked it.
 */
export function checkEmergencyStop(
  activeStops: readonly EmergencyStop[],
  request: EmergencyAdmissionRequest,
  now: number = Date.now(),
): EmergencyAdmissionResult {
  for (const stop of activeStops) {
    if (!stopMatchesTarget(stop, request)) continue;
    if (request.actionKind === "capability-use" && !stopCoversClass(stop.affectedCapabilities, request.capability)) continue;
    if (request.actionKind === "agent-handoff" && !stopCoversClass(stop.affectedDelegationClasses, request.delegationClass)) continue;
    const decidedAt = new Date(now).toISOString();
    const scopeLabel = stop.scopeTarget ? `${stop.scope}:${stop.scopeTarget}` : stop.scope;
    const reason = `${request.actionKind} refused: emergency stop ${stop.id} (scope ${scopeLabel}) is active — ${stop.reason}`;
    return { ok: false, code: "emergency-stop-active", stopId: stop.id, receipt: makeReceipt(stop, "refusal", request.actionKind, reason, decidedAt) };
  }
  return { ok: true };
}

// ── Running effects ──────────────────────────────────────────────────────────────────────────

/** The four states this task's third acceptance claim names — never `-applied` unless the
 *  connector itself confirms it (module header invariant 1). */
export type RunningEffectCancellationState =
  | "cancellation-requested"
  | "cancellation-unsupported"
  | "cancellation-applied"
  | "cancellation-unobservable";

/** A host adapter's cancellation surface for one already-running external effect. */
export interface RunningEffectConnector {
  readonly supportsCancellation: boolean;
  /** Called only when `supportsCancellation` is true. `"applied"` = connector confirms the effect
   *  stopped; `"requested"` = accepted but not yet confirmed; `"unobservable"` = no confirmable
   *  status at all — never treated as a success. */
  requestCancellation(effectRef: string): "applied" | "requested" | "unobservable";
}

export interface RunningEffectCancellationRequest {
  readonly stop: EmergencyStop;
  readonly effectRef: string;
  readonly effectKind: string;
}

/**
 * Requests cancellation of one running effect in an active stop's scope. Never reports
 * `cancellation-applied` unless the connector itself confirms it — an unsupported connector stays
 * `cancellation-unsupported` and REMAINS observable and bounded, exactly as the module header's
 * first invariant and this task's falsifier require.
 */
export function requestRunningEffectCancellation(
  connector: RunningEffectConnector,
  request: RunningEffectCancellationRequest,
  opts: { now?: string | number } = {},
): { readonly state: RunningEffectCancellationState; readonly receipt: EmergencyReceipt } {
  const decidedAt = new Date(resolveNowMs(opts.now)).toISOString();
  const { stop, effectRef, effectKind } = request;
  if (!connector.supportsCancellation) {
    const reason = `connector for ${effectKind} ${effectRef} does not support cancellation; the effect remains observable and bounded, never claimed cancelled`;
    return { state: "cancellation-unsupported", receipt: makeReceipt(stop, "cancellation", "cancellation-unsupported", reason, decidedAt) };
  }
  const outcome = connector.requestCancellation(effectRef);
  const state: RunningEffectCancellationState =
    outcome === "applied" ? "cancellation-applied" : outcome === "requested" ? "cancellation-requested" : "cancellation-unobservable";
  const reason =
    state === "cancellation-applied"
      ? `connector confirmed cancellation of ${effectKind} ${effectRef}`
      : state === "cancellation-requested"
        ? `cancellation requested for ${effectKind} ${effectRef}; connector has not yet confirmed it stopped`
        : `connector reported no confirmable status for ${effectKind} ${effectRef}; treated as unobservable, never claimed cancelled`;
  return { state, receipt: makeReceipt(stop, "cancellation", state, reason, decidedAt) };
}

// ── Clearing ─────────────────────────────────────────────────────────────────────────────────

export type EmergencyClearRefusalCode =
  | "already-cleared"
  | "confirmation-required"
  | "health-stale"
  | "health-not-healthy"
  | "revocation-source-partial"
  | "revocation-source-unavailable";

/** An explicit human sign-off — never inferred from a prior approval, model confidence, or UI
 *  state, the same rule automation-action.ts's `DelegationHumanApproval` enforces. */
export interface EmergencyClearConfirmation {
  readonly confirmedBy: string;
  readonly confirmedAt: string;
}

export type EmergencyHealthStatus = "healthy" | "degraded" | "unavailable";

/** A fresh, authoritative health/preflight read — never a remembered prior check. */
export interface EmergencyHealthRead {
  readonly source: string;
  readonly status: EmergencyHealthStatus;
  readonly checkedAt: string;
}

export type EmergencyRevocationCoverage = "complete" | "partial" | "unavailable";

/** Whether every revocation source this stop's scope could touch (capability grants, delegation
 *  envelopes, per-connector holds) answered — `"partial"`/`"unavailable"` blocks clearing per this
 *  task's design ("a partial or unavailable revocation source blocks clearing"). */
export interface EmergencyRevocationSourceCheck {
  readonly coverage: EmergencyRevocationCoverage;
}

export interface EmergencyClearRequest {
  readonly stopId: string;
  readonly confirmation: EmergencyClearConfirmation;
  readonly health: EmergencyHealthRead;
  readonly revocation: EmergencyRevocationSourceCheck;
}

/** PRIMARY CONTROL: bounds the freshness window accepted by the emergency clear gate. */
export const EMERGENCY_CLEAR_HEALTH_MAX_AGE_MS = 5 * 60 * 1000;

export type EmergencyClearResult =
  | { readonly ok: true; readonly receipt: EmergencyReceipt }
  | { readonly ok: false; readonly code: EmergencyClearRefusalCode; readonly receipt: EmergencyReceipt };

/**
 * Clears an active stop. Refuses without a fresh EmergencyClearConfirmation, a fresh healthy
 * {@link EmergencyHealthRead}, and complete {@link EmergencyRevocationSourceCheck} coverage — this
 * task's fourth acceptance claim. `stop` must already be resolved (an unknown stop id is the
 * CALLER's `404`, the same split `findProposal`/`findPromotion` already draw in
 * operator-agent.ts); `alreadyCleared` is likewise read from the durable store, so this stays
 * pure like {@link checkEmergencyStop}.
 */
export function clearEmergencyStop(
  stop: EmergencyStop,
  alreadyCleared: boolean,
  request: EmergencyClearRequest,
  opts: { now?: string | number } = {},
): EmergencyClearResult {
  const decidedAt = new Date(resolveNowMs(opts.now)).toISOString();
  const refuse = (code: EmergencyClearRefusalCode, reason: string): EmergencyClearResult => ({
    ok: false,
    code,
    receipt: makeReceipt(stop, "clear", code, reason, decidedAt),
  });
  if (alreadyCleared) return refuse("already-cleared", `emergency stop ${stop.id} has already been cleared`);
  const confirmation = request.confirmation;
  if (!confirmation || !confirmation.confirmedBy || !confirmation.confirmedAt || Number.isNaN(Date.parse(confirmation.confirmedAt))) {
    return refuse("confirmation-required", `clearing emergency stop ${stop.id} requires an explicit human confirmation`);
  }
  const health = request.health;
  const nowMs = resolveNowMs(opts.now);
  const healthAgeMs = health ? nowMs - Date.parse(health.checkedAt) : Number.NaN;
  if (!health || Number.isNaN(healthAgeMs) || healthAgeMs < 0 || healthAgeMs > EMERGENCY_CLEAR_HEALTH_MAX_AGE_MS) {
    return refuse("health-stale", `clearing emergency stop ${stop.id} requires a fresh authoritative health/preflight read`);
  }
  if (health.status !== "healthy") {
    return refuse("health-not-healthy", `clearing emergency stop ${stop.id} refused: health source ${health.source} reports ${health.status}`);
  }
  const revocation = request.revocation;
  if (!revocation || revocation.coverage !== "complete") {
    const code: EmergencyClearRefusalCode = revocation?.coverage === "partial" ? "revocation-source-partial" : "revocation-source-unavailable";
    return refuse(code, `clearing emergency stop ${stop.id} refused: revocation source coverage is ${revocation?.coverage ?? "unavailable"}, not complete`);
  }
  return { ok: true, receipt: makeReceipt(stop, "clear", "cleared", `emergency stop ${stop.id} cleared by ${confirmation.confirmedBy}`, decidedAt) };
}
