/**
 * src/lib/delegation-profile.ts — W1-T3878: GIVE EVERY DELEGATION A TRUST BUDGET.
 *
 * A `delegation-profile-v1` record is the durable answer to "what may this delegation read, change,
 * spend, and for how long": principal, purpose, the action or flow it is linked to, a repository or
 * instance scope, readable data classes, allowed capabilities, a risk ceiling, cost and duration
 * budgets, a notification policy, the approval level, the human decision still required, an
 * expiry, a revocation reference, and a fallback owner. An incomplete record is refused BY NAME.
 *
 * FOUR INVARIANTS: (1) IMMUTABLE — a change is a linked REPLACEMENT with its own revision, never a
 * write to the original; the original stays authoritative until the replacement is accepted.
 * (2) ELIGIBILITY IS DERIVED, NEVER INFERRED — only this profile's durable state plus the action's
 * own preflight decide; a prompt, model confidence, UI state, or remembered prior approval is not
 * an input, and a body carrying one is refused (`non-authoritative-signal`). (3) A missing, stale,
 * expired, revoked, or over-budget profile each refuse under their own code. (4) High-risk and
 * irreversible actions stay human-gated even inside an accepted profile.
 *
 * Pure: no I/O, time only through `Clock`. operator-agent.ts ledgers what this validates and feeds
 * {@link delegationEligibility}'s findings into automation-action.ts's `evaluateAutomationAction`.
 */

import {
  automationRedactionViolation,
  delegationRequiresHumanGate,
  type AutomationAction,
  type AutomationApprovalDecision,
  type AutomationPreflightFinding,
  type DelegationRiskTier,
} from "./automation-action.js";
import { fixedClock, type Clock } from "./clock.js";

/** Named once so a record's own `version` and every consumer's pin can never drift. */
export const DELEGATION_PROFILE_VERSION = "delegation-profile-v1" as const;
export const DELEGATION_PROFILE_LEDGER_STEP = "panel.operator_agent_delegation_profile";
export const DELEGATION_DECISION_LEDGER_STEP = "panel.operator_agent_delegation_decision";

/** PRIMARY CONTROL: the only cap on an id-shaped profile field (delegation id, principal, owner,
 *  capability, scope name) — the console drops a delegationId longer than this. */
export const DELEGATION_PROFILE_MAX_ID_CHARS = 160;
/** PRIMARY CONTROL: the only cap on a prose-shaped profile field (purpose, summary, human decision,
 *  receipt note) — the contract carries a bounded summary, never arbitrary model prose. */
export const DELEGATION_PROFILE_MAX_TEXT_CHARS = 320;
/** PRIMARY CONTROL: the only cap on one readable data-class name. */
export const DELEGATION_PROFILE_MAX_CLASS_CHARS = 120;
/** PRIMARY CONTROL: how many data classes, or capabilities, one profile may name. */
export const DELEGATION_PROFILE_MAX_LIST = 32;
/** PRIMARY CONTROL: the longest a profile may live (90 days) — past this, a replacement must be
 *  accepted again rather than one approval standing indefinitely. */
export const DELEGATION_PROFILE_MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
/** PRIMARY CONTROL: the largest cost budget one profile may carry, in US dollars. */
export const DELEGATION_PROFILE_MAX_COST_USD = 10_000;
/** PRIMARY CONTROL: the longest duration budget, counted from acceptance (the lifetime cap). */
export const DELEGATION_PROFILE_MAX_DURATION_MINUTES = 90 * 24 * 60;

/** A field that claims authority the contract never grants: model confidence, a remembered or
 *  prior approval, or browser/UI state. Matched against every KEY, recursively. */
export const DELEGATION_NON_AUTHORITATIVE_FIELD_RE =
  /^(?:model_?)?confidence(?:_?score)?$|^(?:prior|previous|remembered|cached|client)_?approvals?$|^ui_?state$/i;

export type DelegationProfileScope =
  | { readonly kind: "repository"; readonly repository: string }
  | { readonly kind: "instance"; readonly instanceId: string };

/** The action or flow this profile governs. At least one is required. */
export interface DelegationProfileLink {
  readonly flowId?: string;
  readonly actionId?: string;
}

export const DELEGATION_NOTIFICATION_POLICIES = ["silent", "on-refusal", "on-every-action"] as const;
export type DelegationNotificationPolicy = (typeof DELEGATION_NOTIFICATION_POLICIES)[number];

/** `profile`: an accepted profile admits in-ceiling, reversible, non-gated actions. `each-action`:
 *  every action also needs its own operator approval. */
export const DELEGATION_APPROVAL_LEVELS = ["profile", "each-action"] as const;
export type DelegationApprovalLevel = (typeof DELEGATION_APPROVAL_LEVELS)[number];

export interface DelegationProfile {
  readonly version: typeof DELEGATION_PROFILE_VERSION;
  readonly delegationId: string;
  /** 1 for an original; a replacement is its predecessor's revision + 1. */
  readonly revision: number;
  /** The profile this one replaces — the link that keeps the authorization history intact. */
  readonly replaces?: string;
  readonly principal: string;
  readonly purpose: string;
  readonly link: DelegationProfileLink;
  readonly scope: DelegationProfileScope;
  readonly dataClasses: readonly string[];
  readonly capabilities: readonly string[];
  readonly capabilitySummary: string;
  /** The HIGHEST risk tier an action under this profile may declare. */
  readonly riskTier: DelegationRiskTier;
  readonly budget: { readonly costUsd: number; readonly durationMinutes: number };
  readonly notification: DelegationNotificationPolicy;
  readonly approvalLevel: DelegationApprovalLevel;
  /** The human decision still required even inside this profile, in the issuer's words. */
  readonly humanDecision: string;
  readonly fallbackOwner: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Where this profile is revoked: the decision route and this profile's id. */
  readonly revocationRef: string;
}

export type DelegationProfileBuildCode =
  | "not-an-object"
  | "forbidden-field"
  | "secret-value"
  | "non-authoritative-signal"
  | "invalid-version"
  | "missing-identity"
  | "missing-link"
  | "missing-scope"
  | "missing-data-classes"
  | "missing-capabilities"
  | "invalid-risk"
  | "missing-budget"
  | "missing-notification"
  | "missing-approval-level"
  | "missing-human-decision"
  | "missing-fallback-owner"
  | "invalid-expiry"
  | "missing-revocation-ref"
  | "immutable-field";

export type DelegationProfileBuild =
  | { readonly ok: true; readonly profile: DelegationProfile }
  | { readonly ok: false; readonly code: DelegationProfileBuildCode; readonly field: string; readonly reason: string };

const RISK_RANK: Readonly<Record<DelegationRiskTier, number>> = { low: 0, medium: 1, high: 2, production: 3, financial: 3, credential: 3, destructive: 3 };
const RISK_TIERS = Object.keys(RISK_RANK) as DelegationRiskTier[];
/** Fields a replacement may never change: they ARE the delegation's identity. */
const IMMUTABLE_FIELDS = ["version", "delegationId", "revision", "replaces", "principal", "link", "scope", "createdAt", "revocationRef"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function toIso(value: string): string {
  return fixedClock(Date.parse(value)).iso();
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** The first key anywhere in `value` that claims non-authoritative authority, as a dotted path. */
export function findNonAuthoritativeSignal(value: unknown, path = "", depth = 0): string | undefined {
  if (depth > 8 || typeof value !== "object" || value === null) return undefined;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  for (const [key, child] of entries) {
    const childPath = path ? `${path}.${key}` : key;
    if (!Array.isArray(value) && DELEGATION_NON_AUTHORITATIVE_FIELD_RE.test(key)) return childPath;
    const nested = findNonAuthoritativeSignal(child, childPath, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/** Whether an action at `action` risk fits under a profile whose ceiling is `ceiling`. The four
 *  critical tiers are categorical: a `production` ceiling never admits a `financial` action. */
export function riskWithinProfile(action: DelegationRiskTier, ceiling: DelegationRiskTier): boolean {
  if (RISK_RANK[action] === 3) return action === ceiling;
  return RISK_RANK[action] <= RISK_RANK[ceiling];
}

/** The console's four-tier vocabulary for a core risk tier (every critical tier reads `critical`). */
export function consoleRiskTier(tier: DelegationRiskTier): "low" | "medium" | "high" | "critical" {
  return RISK_RANK[tier] === 3 ? "critical" : (tier as "low" | "medium" | "high");
}

export function delegationRevocationRef(delegationId: string): string {
  return `/v1/operator-agent/delegations/decision#${delegationId}`;
}

function validateScope(value: unknown): DelegationProfileScope | null {
  if (!isPlainObject(value)) return null;
  if (value.kind === "repository" && bounded(value.repository, DELEGATION_PROFILE_MAX_ID_CHARS)) return { kind: "repository", repository: value.repository.trim() };
  if (value.kind === "instance" && bounded(value.instanceId, DELEGATION_PROFILE_MAX_ID_CHARS)) return { kind: "instance", instanceId: value.instanceId.trim() };
  return null;
}

function validateLink(value: unknown): DelegationProfileLink | null {
  if (!isPlainObject(value)) return null;
  const link: { flowId?: string; actionId?: string } = {};
  for (const field of ["flowId", "actionId"] as const) {
    if (value[field] === undefined) continue;
    if (!bounded(value[field], DELEGATION_PROFILE_MAX_ID_CHARS)) return null;
    link[field] = value[field].trim();
  }
  return link.flowId || link.actionId ? link : null;
}

function validateList(value: unknown, maxChars: number): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > DELEGATION_PROFILE_MAX_LIST) return null;
  if (!value.every((item) => bounded(item, maxChars))) return null;
  const items = value.map((item: string) => item.trim());
  return new Set(items).size === items.length ? items : null;
}

function validateBudget(value: unknown): DelegationProfile["budget"] | null {
  if (!isPlainObject(value)) return null;
  const { costUsd, durationMinutes } = value;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0 || costUsd > DELEGATION_PROFILE_MAX_COST_USD) return null;
  if (typeof durationMinutes !== "number" || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > DELEGATION_PROFILE_MAX_DURATION_MINUTES) return null;
  return { costUsd, durationMinutes };
}

/**
 * Validates a COMPLETE `delegation-profile-v1` record — a freshly built one, or one read back from
 * the ledger — and returns a whitelisted, deep-frozen copy. A raw prompt, transcript, credential,
 * browser-owned measurement, or non-authoritative signal anywhere in it refuses the whole record.
 */
export function validateDelegationProfile(value: unknown): DelegationProfileBuild {
  const refuse = (code: DelegationProfileBuildCode, field: string, reason: string): DelegationProfileBuild => ({ ok: false, code, field, reason });
  if (!isPlainObject(value)) return refuse("not-an-object", "profile", "a delegation profile must be a JSON object");
  const redaction = automationRedactionViolation(value);
  if (redaction) return refuse(redaction.code, redaction.field, `field ${redaction.field} may not enter the delegation-profile contract`);
  const signal = findNonAuthoritativeSignal(value);
  if (signal) return refuse("non-authoritative-signal", signal, `field ${signal} claims authority a delegation profile never grants`);
  if (value.version !== DELEGATION_PROFILE_VERSION) return refuse("invalid-version", "version", `version must be ${DELEGATION_PROFILE_VERSION}`);
  const { delegationId, principal, purpose, revision, replaces } = value;
  if (!bounded(delegationId, DELEGATION_PROFILE_MAX_ID_CHARS) || !bounded(principal, DELEGATION_PROFILE_MAX_ID_CHARS) || !bounded(purpose, DELEGATION_PROFILE_MAX_TEXT_CHARS)) {
    return refuse("missing-identity", "delegationId", "delegationId, principal, and a bounded purpose are required");
  }
  const linked = revision === 1 ? replaces === undefined : bounded(replaces, DELEGATION_PROFILE_MAX_ID_CHARS);
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 || !linked) {
    return refuse("missing-identity", "revision", "revision 1 replaces nothing; every later revision names the profile it replaces");
  }
  const link = validateLink(value.link);
  if (!link) return refuse("missing-link", "link", "link must name the flowId or actionId this delegation governs");
  const scope = validateScope(value.scope);
  if (!scope) return refuse("missing-scope", "scope", "scope must be {kind: repository, repository} or {kind: instance, instanceId}");
  const dataClasses = validateList(value.dataClasses, DELEGATION_PROFILE_MAX_CLASS_CHARS);
  if (!dataClasses) return refuse("missing-data-classes", "dataClasses", `1-${DELEGATION_PROFILE_MAX_LIST} unique readable data classes are required`);
  const capabilities = validateList(value.capabilities, DELEGATION_PROFILE_MAX_ID_CHARS);
  if (!capabilities || !bounded(value.capabilitySummary, DELEGATION_PROFILE_MAX_TEXT_CHARS)) {
    return refuse("missing-capabilities", "capabilities", `1-${DELEGATION_PROFILE_MAX_LIST} unique capabilities and a bounded capabilitySummary are required`);
  }
  if (typeof value.riskTier !== "string" || !RISK_TIERS.includes(value.riskTier as DelegationRiskTier)) {
    return refuse("invalid-risk", "riskTier", `riskTier must be one of ${RISK_TIERS.join(", ")}`);
  }
  const budget = validateBudget(value.budget);
  if (!budget) return refuse("missing-budget", "budget", `budget needs costUsd in 0..${DELEGATION_PROFILE_MAX_COST_USD} and integer durationMinutes in 1..${DELEGATION_PROFILE_MAX_DURATION_MINUTES}`);
  const notification = value.notification as DelegationNotificationPolicy;
  if (!DELEGATION_NOTIFICATION_POLICIES.includes(notification)) return refuse("missing-notification", "notification", `notification must be one of ${DELEGATION_NOTIFICATION_POLICIES.join(", ")}`);
  const approvalLevel = value.approvalLevel as DelegationApprovalLevel;
  if (!DELEGATION_APPROVAL_LEVELS.includes(approvalLevel)) return refuse("missing-approval-level", "approvalLevel", `approvalLevel must be one of ${DELEGATION_APPROVAL_LEVELS.join(", ")}`);
  if (!bounded(value.humanDecision, DELEGATION_PROFILE_MAX_TEXT_CHARS)) return refuse("missing-human-decision", "humanDecision", "the human decision still required must be named");
  if (!bounded(value.fallbackOwner, DELEGATION_PROFILE_MAX_ID_CHARS)) return refuse("missing-fallback-owner", "fallbackOwner", "a fallback owner is required");
  const lifetime = validInstant(value.createdAt) && validInstant(value.expiresAt) ? Date.parse(value.expiresAt) - Date.parse(value.createdAt) : Number.NaN;
  if (!(lifetime > 0 && lifetime <= DELEGATION_PROFILE_MAX_LIFETIME_MS)) {
    return refuse("invalid-expiry", "expiresAt", `expiresAt must fall after createdAt and within ${DELEGATION_PROFILE_MAX_LIFETIME_MS / 86_400_000} days of it`);
  }
  if (value.revocationRef !== delegationRevocationRef(delegationId.trim())) return refuse("missing-revocation-ref", "revocationRef", "revocationRef must name this profile's revocation route");
  return {
    ok: true,
    profile: deepFreeze({
      version: DELEGATION_PROFILE_VERSION,
      delegationId: delegationId.trim(),
      revision,
      ...(revision > 1 ? { replaces: (replaces as string).trim() } : {}),
      principal: principal.trim(),
      purpose: purpose.trim(),
      link,
      scope,
      dataClasses,
      capabilities,
      capabilitySummary: (value.capabilitySummary as string).trim(),
      riskTier: value.riskTier as DelegationRiskTier,
      budget,
      notification,
      approvalLevel,
      humanDecision: value.humanDecision.trim(),
      fallbackOwner: value.fallbackOwner.trim(),
      createdAt: toIso(value.createdAt as string),
      expiresAt: toIso(value.expiresAt as string),
      revocationRef: value.revocationRef,
    }),
  };
}

/** The fields a caller supplies; the rest (version, revision, createdAt, revocationRef) are set here. */
const CALLER_FIELDS = [
  "delegationId", "principal", "purpose", "link", "scope", "dataClasses", "capabilities", "capabilitySummary",
  "riskTier", "budget", "notification", "approvalLevel", "humanDecision", "fallbackOwner", "expiresAt",
] as const;

function replacementId(predecessor: DelegationProfile): string {
  const suffix = `@r${predecessor.revision + 1}`;
  const base = predecessor.delegationId.replace(/@r\d+$/, "");
  return `${base.slice(0, DELEGATION_PROFILE_MAX_ID_CHARS - suffix.length)}${suffix}`;
}

/**
 * Builds a new profile from caller input. `createdAt` is the SERVER's clock and `revocationRef` is
 * derived, so neither can be forged; with a `predecessor` the result is its linked replacement
 * (next revision, derived id, `replaces` set). The raw input is screened before whitelisting, so a
 * forbidden field is REFUSED by name rather than silently dropped.
 */
export function buildDelegationProfile(input: unknown, opts: { readonly clock: Clock; readonly predecessor?: DelegationProfile }): DelegationProfileBuild {
  if (!isPlainObject(input)) return { ok: false, code: "not-an-object", field: "profile", reason: "a delegation profile must be a JSON object" };
  const screened = validateScreen(input);
  if (screened) return screened;
  const fields: Record<string, unknown> = {};
  for (const field of CALLER_FIELDS) if (input[field] !== undefined) fields[field] = input[field];
  const { predecessor } = opts;
  const delegationId = predecessor ? replacementId(predecessor) : fields.delegationId;
  return validateDelegationProfile({
    ...fields,
    version: DELEGATION_PROFILE_VERSION,
    delegationId,
    revision: predecessor ? predecessor.revision + 1 : 1,
    ...(predecessor ? { replaces: predecessor.delegationId } : {}),
    createdAt: opts.clock.iso(),
    revocationRef: typeof delegationId === "string" ? delegationRevocationRef(delegationId.trim()) : undefined,
  });
}

function validateScreen(input: Record<string, unknown>): DelegationProfileBuild | undefined {
  const redaction = automationRedactionViolation(input);
  if (redaction) return { ok: false, code: redaction.code, field: redaction.field, reason: `field ${redaction.field} may not enter the delegation-profile contract` };
  const signal = findNonAuthoritativeSignal(input);
  if (signal) return { ok: false, code: "non-authoritative-signal", field: signal, reason: `field ${signal} claims authority a delegation profile never grants` };
  return undefined;
}

/**
 * A change NEVER mutates `predecessor`: it builds a linked replacement carrying every field the
 * change does not name, with a fresh createdAt and — unless the change names one — the same
 * lifetime from now. Naming an identity field (scope, principal, link, id, revision) is refused
 * `immutable-field`: a different delegation is a new profile, not a replacement.
 */
export function buildDelegationReplacement(predecessor: DelegationProfile, changes: unknown, clock: Clock): DelegationProfileBuild {
  const requested = changes === undefined ? {} : changes;
  if (!isPlainObject(requested)) return { ok: false, code: "not-an-object", field: "changes", reason: "changes must be a JSON object" };
  const screened = validateScreen(requested);
  if (screened) return screened;
  const immutable = IMMUTABLE_FIELDS.find((field) => requested[field] !== undefined);
  if (immutable) return { ok: false, code: "immutable-field", field: immutable, reason: `${immutable} identifies the delegation; issue a new profile instead of replacing this one` };
  const lifetime = Date.parse(predecessor.expiresAt) - Date.parse(predecessor.createdAt);
  const carried: Record<string, unknown> = { ...predecessor, expiresAt: fixedClock(clock.now() + lifetime).iso() };
  return buildDelegationProfile({ ...carried, ...requested }, { clock, predecessor });
}

// ── The durable fold: ledger rows -> one state per profile ──────────────────────────────────

export type DelegationApprovalState = "pending" | "approved" | "denied";
export type DelegationProfileStatus = "pending" | "active" | "denied" | "revoked" | "superseded" | "expired";

export interface DelegationProfileReceipt {
  readonly kind: "accept" | "revoke" | "replace";
  readonly at: string;
  readonly note?: string;
}

export interface DelegationProfileState {
  readonly profile: DelegationProfile;
  readonly approval: DelegationApprovalState;
  readonly decidedAt?: string;
  readonly acceptedAt?: string;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
  /** An ACCEPTED replacement: this profile is stale from `supersededAt` on. */
  readonly supersededBy?: string;
  readonly supersededAt?: string;
  /** A replacement issued but not yet accepted; this profile stays authoritative meanwhile. */
  readonly pendingReplacement?: string;
  /** Sum of the estimated cost of every execution admitted under this profile. */
  readonly spentCostUsd: number;
  readonly receipts: readonly DelegationProfileReceipt[];
}

type MutableState = { -readonly [K in keyof DelegationProfileState]: DelegationProfileState[K] } & { receipts: DelegationProfileReceipt[] };

function note(value: unknown): string | undefined {
  return bounded(value, DELEGATION_PROFILE_MAX_TEXT_CHARS) ? value.trim() : undefined;
}

function applyDecision(states: Map<string, MutableState>, row: Readonly<Record<string, unknown>>): void {
  const state = typeof row.delegation_id === "string" ? states.get(row.delegation_id) : undefined;
  if (!state || state.revokedAt || !validInstant(row.at)) return;
  const at = toIso(row.at);
  const detail = note(row.note);
  if (row.decision === "accepted" && state.approval === "pending") {
    Object.assign(state, { approval: "approved", decidedAt: at, acceptedAt: at });
    state.receipts.push({ kind: "accept", at, ...(detail ? { note: detail } : {}) });
    const predecessor = state.profile.replaces ? states.get(state.profile.replaces) : undefined;
    if (predecessor && !predecessor.supersededBy) Object.assign(predecessor, { supersededBy: state.profile.delegationId, supersededAt: at });
  } else if (row.decision === "revoked") {
    Object.assign(state, { revokedAt: at, revokedReason: detail ?? "revoked by operator" }, state.approval === "pending" ? { approval: "denied", decidedAt: at } : {});
    state.receipts.push({ kind: "revoke", at, ...(detail ? { note: detail } : {}) });
  }
}

/**
 * Folds the ledger union into one state per profile: the FIRST record per id wins (a later row can
 * never rewrite it), a revocation is terminal, the first acceptance stands, and a replacement's
 * acceptance marks its predecessor superseded. `usageStep` names the action-receipt step whose
 * admitted executions carry `delegation_id` + `delegation_cost_usd` — the spend side of the budget.
 */
export function foldDelegationProfiles(rows: readonly Readonly<Record<string, unknown>>[], usageStep: string): DelegationProfileState[] {
  const states = new Map<string, MutableState>();
  for (const row of rows) {
    if (row.step === DELEGATION_PROFILE_LEDGER_STEP) {
      const validated = validateDelegationProfile(row.profile);
      if (!validated.ok || states.has(validated.profile.delegationId)) continue;
      const { profile } = validated;
      states.set(profile.delegationId, { profile, approval: "pending", spentCostUsd: 0, receipts: [] });
      const predecessor = profile.replaces ? states.get(profile.replaces) : undefined;
      if (predecessor && !predecessor.pendingReplacement) {
        predecessor.pendingReplacement = profile.delegationId;
        predecessor.receipts.push({ kind: "replace", at: profile.createdAt, note: note(row.note) ?? `replaced by ${profile.delegationId}` });
      }
    } else if (row.step === DELEGATION_DECISION_LEDGER_STEP) {
      applyDecision(states, row);
    } else if (row.step === usageStep && typeof row.delegation_id === "string" && isPlainObject(row.receipt) && row.receipt.outcome === "in-progress") {
      const state = states.get(row.delegation_id);
      const cost = row.delegation_cost_usd;
      if (state && typeof cost === "number" && Number.isFinite(cost) && cost >= 0) state.spentCostUsd += cost;
    }
  }
  return [...states.values()].sort((left, right) => Date.parse(right.profile.createdAt) - Date.parse(left.profile.createdAt) || left.profile.delegationId.localeCompare(right.profile.delegationId));
}

/** The status a profile's durable state implies at `clock` — derived, never stored. */
export function delegationProfileStatus(state: DelegationProfileState, clock: Clock): DelegationProfileStatus {
  if (state.revokedAt) return state.approval === "denied" ? "denied" : "revoked";
  if (state.supersededBy) return "superseded";
  if (clock.now() >= Date.parse(state.profile.expiresAt)) return "expired";
  return state.approval === "approved" ? "active" : "pending";
}

/** The console's lifecycle vocabulary: may this delegation act at all (never folded with freshness). */
export function delegationLifecycleState(status: DelegationProfileStatus): "active" | "expired" | "revoked" {
  if (status === "expired") return "expired";
  return status === "pending" || status === "active" ? "active" : "revoked";
}

/**
 * The public read shape — every field the console's `delegation-profile-v1` normaliser reads, plus
 * core's finer `status`, `actionRiskCeiling`, and spend. Revocation detail is present whenever the
 * ledger carries it (a superseded profile names its replacement), never hidden by lifecycle.
 */
export function projectDelegationProfile(state: DelegationProfileState, clock: Clock) {
  const { profile } = state;
  const status = delegationProfileStatus(state, clock);
  const revocation = state.revokedAt
    ? { reason: state.revokedReason, revokedAt: state.revokedAt }
    : state.supersededBy ? { reason: `superseded by ${state.supersededBy}`, revokedAt: state.supersededAt } : undefined;
  return {
    ...profile,
    riskTier: consoleRiskTier(profile.riskTier),
    actionRiskCeiling: profile.riskTier,
    approval: { state: state.approval, ...(state.decidedAt ? { decidedAt: state.decidedAt } : {}) },
    lifecycleState: delegationLifecycleState(status),
    status,
    ...(revocation ? { revocation } : {}),
    ...(state.supersededBy ? { supersededBy: state.supersededBy } : {}),
    ...(state.pendingReplacement ? { pendingReplacement: state.pendingReplacement } : {}),
    spentCostUsd: state.spentCostUsd,
    receipts: state.receipts,
    observedAt: clock.iso(),
    freshness: "verified" as const,
  };
}

export interface DelegationEligibilityInput {
  readonly state: DelegationProfileState | undefined;
  readonly action: AutomationAction;
  /** The action's OWN durable operator decision — never a decision remembered from another action. */
  readonly approval?: AutomationApprovalDecision;
  readonly estimatedCostUsd?: number;
  readonly clock: Clock;
}

function withinScope(scope: DelegationProfileScope, action: AutomationAction): boolean {
  return scope.kind === "repository" ? action.scope.repo === scope.repository : action.scope.instance === scope.instanceId;
}

/**
 * Whether `action` may run under this profile, as preflight findings (empty = eligible). The first
 * failing check refuses, each under its own code: missing, revoked, stale (superseded), expired,
 * not-approved, over-budget (duration from acceptance, then cost), scope, link, capability, risk
 * ceiling, and — for a gated tier, an irreversible action, or an `each-action` profile — the
 * action's own operator approval. Nothing here reads a confidence, prompt, or UI state.
 */
export function delegationEligibility(input: DelegationEligibilityInput): AutomationPreflightFinding[] {
  const refuse = (code: string, detail: string): AutomationPreflightFinding[] => [{ outcome: "refused", code, detail }];
  const { state, action, clock } = input;
  if (!state) return refuse("delegation-profile-missing", `no delegation profile authorizes action ${action.actionId}`);
  const { profile } = state;
  const id = profile.delegationId;
  const status = delegationProfileStatus(state, clock);
  if (status === "revoked" || status === "denied") return refuse("delegation-profile-revoked", `delegation ${id} was revoked at ${state.revokedAt}`);
  if (status === "superseded") return refuse("delegation-profile-stale", `delegation ${id} was superseded by ${state.supersededBy}`);
  if (status === "expired") return refuse("delegation-profile-expired", `delegation ${id} expired at ${profile.expiresAt}`);
  if (status === "pending") return refuse("delegation-profile-not-approved", `delegation ${id} has not been accepted by an operator`);
  const durationEnd = Date.parse(state.acceptedAt ?? profile.createdAt) + profile.budget.durationMinutes * 60_000;
  if (clock.now() > durationEnd) return refuse("delegation-profile-over-budget", `delegation ${id} spent its ${profile.budget.durationMinutes}-minute duration budget`);
  const projected = state.spentCostUsd + (input.estimatedCostUsd ?? 0);
  if (projected > profile.budget.costUsd) return refuse("delegation-profile-over-budget", `delegation ${id} would spend $${projected} of its $${profile.budget.costUsd} budget`);
  if (!withinScope(profile.scope, action)) return refuse("delegation-scope-mismatch", `action ${action.actionId} is outside delegation ${id}'s scope`);
  if (profile.link.actionId !== action.actionId && profile.link.flowId !== action.scope.flowId) {
    return refuse("delegation-link-mismatch", `action ${action.actionId} is neither the action nor in the flow delegation ${id} is linked to`);
  }
  if (!profile.capabilities.includes(action.capability)) return refuse("delegation-capability-not-allowed", `capability ${action.capability} is not in delegation ${id}'s allowlist`);
  if (!riskWithinProfile(action.risk, profile.riskTier)) return refuse("delegation-risk-exceeds-profile", `a ${action.risk}-risk action exceeds delegation ${id}'s ${profile.riskTier} ceiling`);
  const gated = delegationRequiresHumanGate(action.risk) || action.rollback.mode === "irreversible" || profile.approvalLevel === "each-action";
  if (gated && input.approval?.decision !== "approved") return refuse("delegation-human-gate-required", `action ${action.actionId} still needs its own operator approval under delegation ${id}`);
  return [];
}
