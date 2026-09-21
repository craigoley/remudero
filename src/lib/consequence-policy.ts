/**
 * src/lib/consequence-policy.ts — W1-T3894: MAKE IRREVERSIBLE ACTIONS EXPLICIT.
 *
 * `consequence-policy-v1`: what an OPERATOR must see before approving a consequential action —
 * exact target, amount moved, quote/confirmation lifetime, and whether recovery exists at all.
 * W1-T3878/W1-T3880's generic risk label and grant reference stay authoritative but say none of
 * that. Every action classifies into one of {@link CONSEQUENCE_CLASSES}; `financial`/
 * `irreversible` carry a bounded sub-record ({@link ConsequenceFinancialDetails}, {@link
 * ConsequenceIrreversibleDetails}) that {@link classifyConsequenceAction} refuses incomplete.
 *
 * {@link evaluateConsequencePolicy} never upgrades an ambiguous target, stale evidence, an
 * expired quote/confirmation, an exceeded ceiling, or a missing approver into readiness. A
 * capability grant REFERENCE may ride along for provenance only — nothing here reads it to widen
 * a ceiling or approval count. External-sourced text (`source: "external"` on {@link
 * ConsequenceTarget}/{@link ConsequenceApproval}) is refused wherever a target or approval is read.
 *
 * {@link ConsequenceReceipt}s are the only durable record of approval/execution/refusal/recovery;
 * `execution` never manufactures "executed" without an `externalEffectReceiptId`, and `recovery`
 * never claims more than {@link ConsequenceIrreversibleDetails.recoveryAvailable} allows.
 *
 * FALSIFIER: approve an ambiguous target, exceed a ceiling, accept stale/expired evidence, let a
 * grant or external content stand in for approval, or claim impossible recovery. See
 * test/consequence-policy-{classification,financial,confirmation,approval,receipts}.test.ts.
 */

import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.js";

/** Named once so an action's own `schema` field and every doc reference can never drift. */
export const CONSEQUENCE_POLICY_SCHEMA_VERSION = "consequence-policy-v1" as const;

/** The four consequence classes. Closed union: a new class is a reviewable one-line addition
 *  here, never a free-text guess at a call site. */
export const CONSEQUENCE_CLASSES = ["reversible", "disruptive", "irreversible", "financial"] as const;
export type ConsequenceClass = (typeof CONSEQUENCE_CLASSES)[number];

/** Where a field's VALUE came from. `"external"` means an email, a page, a tool result, or any
 *  other content this repo does not treat as an operator's own word — see the module header. */
export type ConsequenceSource = "trusted" | "external";

/** The exact identity the action acts against. Never inferred: an issuer that cannot name one
 *  concrete identity must set `ambiguous: true` rather than guess, so {@link
 *  evaluateConsequencePolicy} can refuse it instead of acting on a best guess. */
export interface ConsequenceTarget {
  readonly identity: string;
  readonly source: ConsequenceSource;
  readonly ambiguous?: boolean;
}

export interface ConsequenceScope {
  readonly repo?: string;
  readonly instance?: string;
}

/** A freshness-bounded observation (a quoted price, a balance, an inventory count, ...) an action
 *  relies on. `maxAgeSeconds` is the ISSUER's own freshness requirement, not a global default, so
 *  a higher-stakes action can demand fresher evidence than a lower-stakes one. */
export interface ConsequenceEvidence {
  readonly label: string;
  readonly observedAt: string;
  readonly maxAgeSeconds: number;
}

/** Required for every `financial` action. Carries the target amount/currency, BOTH ceilings the
 *  rationale calls for (a single action can be under its own ceiling yet push the aggregate over),
 *  the quote's own expiry, and a cooling-off window measured from when it started. */
export interface ConsequenceFinancialDetails {
  readonly amount: number;
  readonly currency: string;
  readonly perActionCeiling: number;
  readonly aggregateCeiling: number;
  readonly aggregateSpentBefore: number;
  readonly quoteExpiresAt: string;
  readonly coolingOffSeconds: number;
  readonly coolingOffStartedAt: string;
}

/** Required for every `irreversible` action. `recoveryAvailable: false` REQUIRES a non-empty
 *  `rollbackUnavailableReason` — see {@link classifyConsequenceAction} — so "no recovery" is
 *  always a stated fact, never a silent omission. */
export interface ConsequenceIrreversibleDetails {
  readonly affectedResource: string;
  readonly recoveryAvailable: boolean;
  readonly recoveryStatement: string;
  readonly rollbackUnavailableReason?: string;
  readonly confirmationNonce: string;
  readonly confirmationExpiresAt: string;
}

/** One human approval. `source: "external"` exists so a call site can be handed an approval-shaped
 *  object extracted from untrusted content and have this module refuse it by construction, rather
 *  than trusting the call site to have filtered it first. */
export interface ConsequenceApproval {
  readonly approverId: string;
  readonly approvedAt: string;
  readonly source: ConsequenceSource;
}

/** A non-secret REFERENCE to a `capability-grant-v1` grant (see capability-grant.ts). This module
 *  never resolves or reads through it — it exists only so a receipt can attribute an action to the
 *  grant that authorized the underlying operation, never to widen a ceiling or approval count. */
export interface ConsequenceCapabilityRef {
  readonly grantId: string;
}

/** The caller-supplied shape {@link classifyConsequenceAction} validates and freezes into a
 *  {@link ConsequenceAction}. */
export interface ConsequenceActionInput {
  id?: string;
  consequenceClass: ConsequenceClass;
  target: ConsequenceTarget;
  scope?: ConsequenceScope;
  evidence?: readonly ConsequenceEvidence[];
  financial?: ConsequenceFinancialDetails;
  irreversible?: ConsequenceIrreversibleDetails;
  requiredApprovers: number;
  approvals?: readonly ConsequenceApproval[];
  capabilityGrant?: ConsequenceCapabilityRef;
}

/**
 * A classified `consequence-policy-v1` action. Every instance this module hands out is deep-frozen
 * ({@link classifyConsequenceAction}), so holding a reference to one is never a path to widening
 * the target, scope, financial ceilings, or recovery boundary it was built with.
 */
export interface ConsequenceAction {
  readonly schema: typeof CONSEQUENCE_POLICY_SCHEMA_VERSION;
  readonly id: string;
  readonly consequenceClass: ConsequenceClass;
  readonly target: ConsequenceTarget;
  readonly scope: ConsequenceScope;
  readonly evidence: readonly ConsequenceEvidence[];
  readonly financial?: ConsequenceFinancialDetails;
  readonly irreversible?: ConsequenceIrreversibleDetails;
  readonly requiredApprovers: number;
  readonly approvals: readonly ConsequenceApproval[];
  readonly capabilityGrant?: ConsequenceCapabilityRef;
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

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateFinancialDetails(financial: ConsequenceFinancialDetails): void {
  if (!Number.isFinite(financial.amount) || financial.amount <= 0) {
    throw new Error("financial consequence action requires a positive finite amount");
  }
  if (!/^[A-Z]{3}$/.test(financial.currency)) {
    throw new Error("financial consequence action requires a 3-letter uppercase ISO-4217 currency code");
  }
  if (!Number.isFinite(financial.perActionCeiling) || financial.perActionCeiling <= 0) {
    throw new Error("financial consequence action requires a positive perActionCeiling");
  }
  if (!Number.isFinite(financial.aggregateCeiling) || financial.aggregateCeiling < financial.perActionCeiling) {
    throw new Error("financial consequence action requires an aggregateCeiling >= perActionCeiling");
  }
  if (!Number.isFinite(financial.aggregateSpentBefore) || financial.aggregateSpentBefore < 0) {
    throw new Error("financial consequence action requires a non-negative aggregateSpentBefore");
  }
  if (!isValidIso(financial.quoteExpiresAt)) {
    throw new Error("financial consequence action requires a valid ISO-8601 quoteExpiresAt");
  }
  if (!Number.isInteger(financial.coolingOffSeconds) || financial.coolingOffSeconds < 0) {
    throw new Error("financial consequence action requires a non-negative integer coolingOffSeconds");
  }
  if (!isValidIso(financial.coolingOffStartedAt)) {
    throw new Error("financial consequence action requires a valid ISO-8601 coolingOffStartedAt");
  }
}

function validateIrreversibleDetails(irreversible: ConsequenceIrreversibleDetails): void {
  if (!isNonEmptyString(irreversible.affectedResource)) {
    throw new Error("irreversible consequence action requires a non-empty affectedResource");
  }
  if (!isNonEmptyString(irreversible.recoveryStatement)) {
    throw new Error("irreversible consequence action requires a non-empty recoveryStatement");
  }
  if (!isNonEmptyString(irreversible.confirmationNonce)) {
    throw new Error("irreversible consequence action requires a non-empty confirmationNonce");
  }
  if (!isValidIso(irreversible.confirmationExpiresAt)) {
    throw new Error("irreversible consequence action requires a valid ISO-8601 confirmationExpiresAt");
  }
  if (typeof irreversible.recoveryAvailable !== "boolean") {
    throw new Error("irreversible consequence action requires a boolean recoveryAvailable");
  }
  if (!irreversible.recoveryAvailable && !isNonEmptyString(irreversible.rollbackUnavailableReason)) {
    throw new Error(
      "irreversible consequence action with recoveryAvailable=false requires a non-empty rollbackUnavailableReason — recovery must never be silently absent",
    );
  }
}

function validateEvidence(evidence: readonly ConsequenceEvidence[]): void {
  for (const item of evidence) {
    if (!isNonEmptyString(item.label)) throw new Error("consequence evidence requires a non-empty label");
    if (!isValidIso(item.observedAt)) throw new Error("consequence evidence requires a valid ISO-8601 observedAt");
    if (!Number.isFinite(item.maxAgeSeconds) || item.maxAgeSeconds <= 0) {
      throw new Error("consequence evidence requires a positive maxAgeSeconds");
    }
  }
}

/**
 * Validates a consequence action input and returns a deep-frozen {@link ConsequenceAction}. Throws
 * a plain `Error` on any missing or malformed field: an incomplete action is a mistake at the
 * ISSUER, refused before it can ever reach {@link evaluateConsequencePolicy}. Preserves every
 * target/scope/recovery field EXACTLY as given — this function never truncates or renames one.
 */
export function classifyConsequenceAction(input: ConsequenceActionInput): ConsequenceAction {
  if (!CONSEQUENCE_CLASSES.includes(input.consequenceClass)) {
    throw new Error(`consequence action requires a valid consequenceClass, got ${JSON.stringify(input.consequenceClass)}`);
  }
  if (!input.target || !isNonEmptyString(input.target.identity)) {
    throw new Error("consequence action requires a non-empty target.identity");
  }
  if (input.target.source !== "trusted" && input.target.source !== "external") {
    throw new Error('consequence action target.source must be "trusted" or "external"');
  }
  if (!Number.isInteger(input.requiredApprovers) || input.requiredApprovers < 0) {
    throw new Error("consequence action requires a non-negative integer requiredApprovers");
  }
  if ((input.consequenceClass === "financial" || input.consequenceClass === "irreversible") && input.requiredApprovers < 1) {
    throw new Error(`${input.consequenceClass} consequence actions require at least one configured approver`);
  }
  if (input.consequenceClass === "financial") {
    if (!input.financial) throw new Error("financial consequence action requires financial details");
    validateFinancialDetails(input.financial);
  } else if (input.financial) {
    throw new Error(`${input.consequenceClass} consequence action must not carry financial details`);
  }
  if (input.consequenceClass === "irreversible") {
    if (!input.irreversible) throw new Error("irreversible consequence action requires irreversible details");
    validateIrreversibleDetails(input.irreversible);
  } else if (input.irreversible) {
    throw new Error(`${input.consequenceClass} consequence action must not carry irreversible details`);
  }
  const evidence = [...(input.evidence ?? [])];
  validateEvidence(evidence);
  const approvals = [...(input.approvals ?? [])];
  for (const approval of approvals) {
    if (!isNonEmptyString(approval.approverId)) throw new Error("consequence approval requires a non-empty approverId");
    if (!isValidIso(approval.approvedAt)) throw new Error("consequence approval requires a valid ISO-8601 approvedAt");
    if (approval.source !== "trusted" && approval.source !== "external") {
      throw new Error('consequence approval.source must be "trusted" or "external"');
    }
  }
  const action: ConsequenceAction = {
    schema: CONSEQUENCE_POLICY_SCHEMA_VERSION,
    id: input.id && input.id.length > 0 ? input.id : `cq-${randomUUID()}`,
    consequenceClass: input.consequenceClass,
    target: { ...input.target },
    scope: { ...(input.scope ?? {}) },
    evidence,
    financial: input.financial ? { ...input.financial } : undefined,
    irreversible: input.irreversible ? { ...input.irreversible } : undefined,
    requiredApprovers: input.requiredApprovers,
    approvals,
    capabilityGrant: input.capabilityGrant ? { ...input.capabilityGrant } : undefined,
  };
  return deepFreeze(action);
}

/** Every reason {@link evaluateConsequencePolicy} can refuse an action for. Closed union so a new
 *  refusal reason is a reviewable one-line addition here, never a free-text guess at a call site. */
export type ConsequencePreflightCode =
  | "ambiguous-target"
  | "external-target"
  | "stale-evidence"
  | "quote-expired"
  | "per-action-ceiling-exceeded"
  | "aggregate-ceiling-exceeded"
  | "cooling-off-active"
  | "expired-confirmation"
  | "missing-approvers"
  | "recovery-exceeds-original-amount"
  | "recovery-unavailable";

/** `ok: true` carries the action preflight found ready; `ok: false` carries a machine-readable
 *  `code` plus a human `reason`. No third state — see the module header's falsifier. */
export type ConsequencePreflightResult =
  | { readonly ok: true; readonly action: ConsequenceAction }
  | { readonly ok: false; readonly action: ConsequenceAction; readonly code: ConsequencePreflightCode; readonly reason: string };

function resolveNowMs(opts: { now?: string | number; clock?: Pick<Clock, "now"> } = {}): number {
  if (opts.clock) return opts.clock.now();
  if (typeof opts.now === "number") return opts.now;
  if (typeof opts.now === "string") return Date.parse(opts.now);
  return Date.now();
}

/**
 * The runtime preflight. Refuses an ambiguous or externally-sourced target, stale evidence, an
 * expired quote or confirmation, an exceeded per-action/aggregate ceiling, an active cooling-off
 * window, or a shortfall of DISTINCT `source: "trusted"` approvers against `requiredApprovers` —
 * NEVER manufactures readiness for any of those. A `capabilityGrant` reference on `action` is never
 * read here: there is no code path in this function that widens a ceiling or an approval count
 * because one is present.
 */
export function evaluateConsequencePolicy(
  action: ConsequenceAction,
  opts: { now?: string | number; clock?: Pick<Clock, "now"> } = {},
): ConsequencePreflightResult {
  const nowMs = resolveNowMs(opts);
  const refuse = (code: ConsequencePreflightCode, reason: string): ConsequencePreflightResult => ({
    ok: false,
    action,
    code,
    reason,
  });

  if (action.target.ambiguous) {
    return refuse("ambiguous-target", `consequence action ${action.id} names an ambiguous target and cannot proceed`);
  }
  if (action.target.source === "external") {
    return refuse(
      "external-target",
      `consequence action ${action.id}'s target was sourced from external content, which can never supply a target`,
    );
  }
  for (const item of action.evidence) {
    const ageMs = nowMs - Date.parse(item.observedAt);
    if (ageMs > item.maxAgeSeconds * 1000) {
      return refuse(
        "stale-evidence",
        `evidence ${JSON.stringify(item.label)} for action ${action.id} is stale (observed ${item.observedAt}, allowed ${item.maxAgeSeconds}s)`,
      );
    }
  }
  if (action.financial) {
    const financial = action.financial;
    if (nowMs >= Date.parse(financial.quoteExpiresAt)) {
      return refuse("quote-expired", `action ${action.id}'s quote expired at ${financial.quoteExpiresAt}`);
    }
    if (financial.amount > financial.perActionCeiling) {
      return refuse(
        "per-action-ceiling-exceeded",
        `action ${action.id} amount ${financial.amount} ${financial.currency} exceeds its per-action ceiling ${financial.perActionCeiling}`,
      );
    }
    if (financial.aggregateSpentBefore + financial.amount > financial.aggregateCeiling) {
      return refuse(
        "aggregate-ceiling-exceeded",
        `action ${action.id} would bring aggregate spend to ${financial.aggregateSpentBefore + financial.amount} ${financial.currency}, exceeding ceiling ${financial.aggregateCeiling}`,
      );
    }
    const coolingOffEndsMs = Date.parse(financial.coolingOffStartedAt) + financial.coolingOffSeconds * 1000;
    if (nowMs < coolingOffEndsMs) {
      return refuse(
        "cooling-off-active",
        `action ${action.id} is inside its ${financial.coolingOffSeconds}s cooling-off period, ends at ${new Date(coolingOffEndsMs).toISOString()}`,
      );
    }
  }
  if (action.irreversible) {
    const irreversible = action.irreversible;
    if (nowMs >= Date.parse(irreversible.confirmationExpiresAt)) {
      return refuse(
        "expired-confirmation",
        `action ${action.id}'s confirmation nonce expired at ${irreversible.confirmationExpiresAt}`,
      );
    }
  }
  if (action.requiredApprovers > 0) {
    const distinctTrusted = new Set(
      action.approvals.filter((a) => a.source === "trusted" && Date.parse(a.approvedAt) <= nowMs).map((a) => a.approverId),
    );
    if (distinctTrusted.size < action.requiredApprovers) {
      return refuse(
        "missing-approvers",
        `action ${action.id} requires ${action.requiredApprovers} distinct trusted approver(s), has ${distinctTrusted.size}`,
      );
    }
  }
  return { ok: true, action };
}

/** One durable record of an approval, execution, refusal, or recovery event. Bounded (every text
 *  field capped, see {@link boundedText}) and linked (`linkedReceiptId` chains execution back to
 *  the approval that authorized it, and recovery back to the execution it recovers). */
export interface ConsequenceReceipt {
  readonly id: string;
  readonly actionId: string;
  readonly consequenceClass: ConsequenceClass;
  readonly event: "approval" | "execution" | "refusal" | "recovery";
  readonly outcome: "approved" | "executed" | "refused" | "recovered" | "recovery-unavailable";
  readonly code?: ConsequencePreflightCode;
  readonly reason: string;
  readonly at: string;
  readonly linkedReceiptId?: string;
}

/** PRIMARY CONTROL: the only place a receipt's derived `reason` text is capped before it enters a
 *  {@link ConsequenceReceipt}. Named, not inlined, so a test can assert against this SAME bound. */
export const CONSEQUENCE_RECEIPT_REASON_MAX_CHARS = 240;

function boundedText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function nowIso(opts: { now?: string | number; clock?: Pick<Clock, "iso"> } = {}): string {
  if (opts.clock) return opts.clock.iso();
  if (typeof opts.now === "number") return new Date(opts.now).toISOString();
  if (typeof opts.now === "string") return new Date(Date.parse(opts.now)).toISOString();
  return new Date().toISOString();
}

function newReceiptId(): string {
  return `cqr-${randomUUID()}`;
}

/**
 * Records a human approval. Refuses (never records `"approved"`) an approval whose
 * `source !== "trusted"` — text extracted from an email, page, or tool result can never supply an
 * approval, exactly the same rule {@link evaluateConsequencePolicy} applies to a target.
 */
export function recordConsequenceApproval(
  action: ConsequenceAction,
  approval: ConsequenceApproval,
  opts: { now?: string | number; clock?: Pick<Clock, "iso"> } = {},
): ConsequenceReceipt {
  const at = nowIso(opts);
  if (approval.source !== "trusted") {
    return {
      id: newReceiptId(),
      actionId: action.id,
      consequenceClass: action.consequenceClass,
      event: "approval",
      outcome: "refused",
      reason: boundedText(
        `approval from source ${JSON.stringify(approval.source)} by ${approval.approverId} cannot authorize action ${action.id}`,
        CONSEQUENCE_RECEIPT_REASON_MAX_CHARS,
      ),
      at,
    };
  }
  return {
    id: newReceiptId(),
    actionId: action.id,
    consequenceClass: action.consequenceClass,
    event: "approval",
    outcome: "approved",
    reason: boundedText(`approved by ${approval.approverId}`, CONSEQUENCE_RECEIPT_REASON_MAX_CHARS),
    at,
  };
}

/** Records a refused action from an already-computed {@link ConsequencePreflightResult}. */
export function recordConsequenceRefusal(
  result: Extract<ConsequencePreflightResult, { ok: false }>,
  opts: { now?: string | number; clock?: Pick<Clock, "iso"> } = {},
): ConsequenceReceipt {
  return {
    id: newReceiptId(),
    actionId: result.action.id,
    consequenceClass: result.action.consequenceClass,
    event: "refusal",
    outcome: "refused",
    code: result.code,
    reason: boundedText(result.reason, CONSEQUENCE_RECEIPT_REASON_MAX_CHARS),
    at: nowIso(opts),
  };
}

/**
 * Records execution. Refuses instead of recording `"executed"` when `preflight.ok` is false — a
 * refused preflight can never be turned into an optimistic success. When `preflight.ok` is true,
 * REQUIRES a non-empty `externalEffectReceiptId`: the caller's own evidence that the real-world
 * effect already happened. This function performs no side effect itself and has no way to know one
 * occurred, so it throws rather than silently recording success without that evidence — success is
 * never shown before the action, per the module header.
 */
export function recordConsequenceExecution(
  preflight: ConsequencePreflightResult,
  externalEffectReceiptId: string,
  approvalReceiptId: string | undefined,
  opts: { now?: string | number; clock?: Pick<Clock, "iso"> } = {},
): ConsequenceReceipt {
  if (!preflight.ok) {
    return recordConsequenceRefusal(preflight, opts);
  }
  if (!isNonEmptyString(externalEffectReceiptId)) {
    throw new Error(
      `consequence execution for action ${preflight.action.id} requires a non-empty externalEffectReceiptId — an execution receipt is never manufactured without evidence the effect happened`,
    );
  }
  return {
    id: newReceiptId(),
    actionId: preflight.action.id,
    consequenceClass: preflight.action.consequenceClass,
    event: "execution",
    outcome: "executed",
    reason: boundedText(
      `executed with external effect receipt ${externalEffectReceiptId}`,
      CONSEQUENCE_RECEIPT_REASON_MAX_CHARS,
    ),
    at: nowIso(opts),
    linkedReceiptId: approvalReceiptId,
  };
}

/**
 * Records a recovery attempt against an executed action, linked back to its execution receipt.
 * Refuses (never records `"recovered"`) when {@link ConsequenceIrreversibleDetails.recoveryAvailable}
 * is `false` — the recorded outcome is `"recovery-unavailable"` carrying the action's own
 * `rollbackUnavailableReason`, never a claim that recovery occurred — or when the requested recovery
 * amount exceeds what the original {@link ConsequenceFinancialDetails.amount} spent: the exact
 * recovery limit the rationale calls for.
 */
export function recordConsequenceRecovery(
  action: ConsequenceAction,
  request: { readonly requestedBy: string; readonly amount?: number },
  linkedExecutionReceiptId: string,
  opts: { now?: string | number; clock?: Pick<Clock, "iso"> } = {},
): ConsequenceReceipt {
  const at = nowIso(opts);
  if (action.irreversible && !action.irreversible.recoveryAvailable) {
    return {
      id: newReceiptId(),
      actionId: action.id,
      consequenceClass: action.consequenceClass,
      event: "recovery",
      outcome: "recovery-unavailable",
      code: "recovery-unavailable",
      reason: boundedText(
        action.irreversible.rollbackUnavailableReason ?? `action ${action.id} has no recovery path`,
        CONSEQUENCE_RECEIPT_REASON_MAX_CHARS,
      ),
      at,
      linkedReceiptId: linkedExecutionReceiptId,
    };
  }
  if (action.financial && request.amount !== undefined && request.amount > action.financial.amount) {
    return {
      id: newReceiptId(),
      actionId: action.id,
      consequenceClass: action.consequenceClass,
      event: "recovery",
      outcome: "refused",
      code: "recovery-exceeds-original-amount",
      reason: boundedText(
        `recovery of ${request.amount} ${action.financial.currency} exceeds action ${action.id}'s original amount ${action.financial.amount}`,
        CONSEQUENCE_RECEIPT_REASON_MAX_CHARS,
      ),
      at,
      linkedReceiptId: linkedExecutionReceiptId,
    };
  }
  return {
    id: newReceiptId(),
    actionId: action.id,
    consequenceClass: action.consequenceClass,
    event: "recovery",
    outcome: "recovered",
    reason: boundedText(`recovery requested by ${request.requestedBy}`, CONSEQUENCE_RECEIPT_REASON_MAX_CHARS),
    at,
    linkedReceiptId: linkedExecutionReceiptId,
  };
}
