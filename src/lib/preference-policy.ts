/**
 * W1-T3895 — learned operator preferences that never become authority.
 *
 * W1-T3824/W1-T3826 persist settings an operator states explicitly. This module is the other half:
 * a preference INFERRED from repeated accept, reject, or more-info decisions. Such a hypothesis may
 * only change presentation (ordering, notification style, clarification wording). It never grants a
 * capability, raises a budget, lowers an approval level, or suppresses a refusal: the effect kinds
 * below are the whole vocabulary, a ledger row naming any other kind is refused at read, and
 * {@link applyScopedPreference} only reorders items whose authority verdict is already settled.
 *
 * A hypothesis is born in shadow mode as `proposed` and applies only once the operator accepts it.
 * Evidence is a list of bounded decision references — never a note, prompt, or transcript. Too few
 * decisions, or none that measure the effect at all, is shown as `unmeasurable`, never as a default.
 */

import { createHash } from "node:crypto";
import { fixedClock } from "./clock.js";
import { OPERATOR_PREFERENCE_EVENT_LEDGER_STEP, OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP } from "./ledger.js";

export const OPERATOR_PREFERENCE_VERSION = "operator-preference-v1" as const;
/** The wire projection the console reads (remudero-console's agent preferences route). */
export const PREFERENCE_PROJECTION_VERSION = "preference-hypothesis-v1" as const;
export const PREFERENCE_NON_AUTHORITY_GUARANTEE = "presentation_only" as const;
export const PREFERENCE_SOURCE = "rmd:core:/v1/operator-agent/preferences#ledger" as const;
const EVIDENCE_SOURCE = "ledger:operator-agent-decisions";
/** Both steps a preference read folds, in write order. Both are in ledger.ts's
 *  DECISION_RELEVANT_LEDGER_STEPS: an opt-out or deletion lost to rotation would silently resume
 *  applying what the operator withdrew. */
export const OPERATOR_PREFERENCE_LEDGER_STEPS = [OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP, OPERATOR_PREFERENCE_EVENT_LEDGER_STEP] as const;

export const PREFERENCE_EFFECT_KINDS = ["ordering", "notification-style", "clarification-wording"] as const;
export const PREFERENCE_ACTIONS = ["accept", "reject", "correct", "opt-out", "delete"] as const;
export const PREFERENCE_LIFECYCLES = ["proposed", "accepted", "rejected", "corrected", "opted_out", "deleted", "expired", "unmeasurable"] as const;

/** PRIMARY CONTROL: the fewest measuring decisions a hypothesis needs before it has a confidence. */
export const PREFERENCE_SAMPLE_FLOOR = 5;
const DAY_MS = 86_400_000;
/** Evidence older than this (from its newest decision) is stale and stops applying. */
export const PREFERENCE_FRESHNESS_MS = 14 * DAY_MS;
/** A hypothesis expires this long after it was proposed, accepted or not. */
export const PREFERENCE_EXPIRY_MS = 30 * DAY_MS;
/** BACKSTOP: the newest decisions one hypothesis keeps as evidence, so a record stays bounded. */
export const PREFERENCE_EVIDENCE_MAX_DECISIONS = 100;
const ANCHORS_SHOWN = 24;
const MAX_SCOPE_TEXT = 200;
const MAX_SURFACE = 160;
const MAX_EFFECT_VALUE = 40;
const MAX_EXPLANATION = 1_000;

const DECISION_REF_KEYS = ["decisionRef", "proposalId", "category", "decision", "at"] as const;
const DECISIONS = new Set(["accepted", "rejected", "more-info"]);
const EFFECT_VALUES: Record<string, ReadonlySet<string> | undefined> = {
  "notification-style": new Set(["compact", "detailed", "digest"]),
  "clarification-wording": new Set(["concise", "detailed"]),
};
const MEASURABILITIES = new Set(["measured", "insufficient", "unmeasurable"]);

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isoText(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoAt(ms: number): string {
  return fixedClock(ms).iso();
}

function digest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export type PreferenceEffectKind = (typeof PREFERENCE_EFFECT_KINDS)[number];
export type PreferenceAction = (typeof PREFERENCE_ACTIONS)[number];
export type PreferenceLifecycle = (typeof PREFERENCE_LIFECYCLES)[number];
export type PreferenceFreshness = "verified" | "stale";
export type PreferenceMeasurability = "measured" | "insufficient" | "unmeasurable";

export interface PreferenceScope {
  principalId: string;
  repository: string;
  surface?: string;
}

export interface PreferenceEffect {
  kind: PreferenceEffectKind;
  value: string;
}

/** One bounded operator decision: identity, category and verdict only — the decision's note, the
 *  proposal's text and its reasoning are deliberately not fields here. */
export interface PreferenceDecisionRef {
  decisionRef: string;
  proposalId: string;
  category: string;
  decision: "accepted" | "rejected" | "more-info";
  at: string;
}

export function validatePreferenceScope(value: unknown): PreferenceScope | null {
  if (!record(value) || !boundedText(value.principalId, MAX_SCOPE_TEXT) || !boundedText(value.repository, MAX_SCOPE_TEXT)) return null;
  if (value.surface !== undefined && !boundedText(value.surface, MAX_SURFACE)) return null;
  return {
    principalId: value.principalId.trim(),
    repository: value.repository.trim(),
    ...(value.surface !== undefined ? { surface: (value.surface as string).trim() } : {}),
  };
}

export function validatePreferenceEffect(value: unknown): PreferenceEffect | null {
  if (!record(value) || !PREFERENCE_EFFECT_KINDS.includes(value.kind as PreferenceEffectKind)) return null;
  if (!boundedText(value.value, MAX_EFFECT_VALUE)) return null;
  const allowed = EFFECT_VALUES[value.kind as string];
  if (allowed !== undefined && !allowed.has(value.value)) return null;
  return { kind: value.kind as PreferenceEffectKind, value: value.value };
}

/** A decision reference carrying ANY key beyond the bounded five (a note, a prompt, a transcript)
 *  is refused whole, so raw text cannot ride into evidence under an unexpected name. */
export function validatePreferenceDecisionRef(value: unknown): PreferenceDecisionRef | null {
  if (!record(value) || Object.keys(value).some((key) => !(DECISION_REF_KEYS as readonly string[]).includes(key))) return null;
  if (!boundedText(value.decisionRef, MAX_SCOPE_TEXT) || !boundedText(value.proposalId, MAX_SCOPE_TEXT) || !boundedText(value.category, MAX_EFFECT_VALUE)) return null;
  if (!DECISIONS.has(value.decision as string) || !isoText(value.at)) return null;
  return value as unknown as PreferenceDecisionRef;
}

/** The bounded decision references a repository's proposal history yields. Reads identity,
 *  category and verdict; a decision's `note` and a proposal's text are never copied. */
export function preferenceDecisionSamples(
  history: ReadonlyArray<{ proposalId: string; repo: string; category: string; decisionHistory: ReadonlyArray<{ decision: string; at: string }> }>,
  repository: string,
): PreferenceDecisionRef[] {
  return history
    .filter((proposal) => proposal.repo === repository)
    .flatMap((proposal) =>
      proposal.decisionHistory.map((event) => ({
        decisionRef: `dec-${digest([proposal.proposalId, event.decision, event.at]).slice(0, 16)}`,
        proposalId: proposal.proposalId,
        category: proposal.category,
        decision: event.decision as PreferenceDecisionRef["decision"],
        at: event.at,
      })),
    );
}

export interface PreferenceEvidence {
  decisions: PreferenceDecisionRef[];
  sampleSize: number;
  supporting: number;
  contradicting: number;
  sampleFloor: number;
  refusedSamples: number;
  newestDecisionAt?: string;
}

export interface OperatorPreference {
  version: typeof OPERATOR_PREFERENCE_VERSION;
  preferenceId: string;
  scope: PreferenceScope;
  effect: PreferenceEffect;
  evidence: PreferenceEvidence;
  /** `null` whenever {@link measurability} is not `measured` — never a guessed default. */
  confidence: number | null;
  measurability: PreferenceMeasurability;
  observedAt: string;
  freshUntil: string;
  expiresAt: string;
  explanation: string;
  mode: "shadow";
  supersedes?: string;
}

type Signal = "supports" | "contradicts" | "neutral";

/** How one decision bears on one effect. `notification-style` has no decision that measures it,
 *  so every hypothesis of that kind is unmeasurable until a signal for it exists. */
const DECISION_SIGNAL: Record<PreferenceEffectKind, (effect: PreferenceEffect, ref: PreferenceDecisionRef) => Signal> = {
  ordering: (effect, ref) => (ref.category !== effect.value || ref.decision === "more-info" ? "neutral" : ref.decision === "accepted" ? "supports" : "contradicts"),
  "clarification-wording": (effect, ref) => ((ref.decision === "more-info") === (effect.value === "detailed") ? "supports" : "contradicts"),
  "notification-style": () => "neutral",
};

const EFFECT_TEXT: Record<PreferenceEffectKind, (value: string) => string> = {
  ordering: (value) => `Show ${value} proposals first.`,
  "notification-style": (value) => `Use ${value} notifications.`,
  "clarification-wording": (value) => `Use ${value} clarification wording.`,
};

export interface PreferenceInferenceInput {
  scope: PreferenceScope;
  effect: PreferenceEffect;
  decisions: readonly unknown[];
  now: number;
  supersedes?: string;
}

/**
 * Replay bounded decisions into one shadow-mode hypothesis. Confidence is computed here, from the
 * ledger's decisions, and is `null` below {@link PREFERENCE_SAMPLE_FLOOR} or when no decision
 * measures the effect. The explanation is built from counts only.
 */
export function inferPreferenceHypothesis(input: PreferenceInferenceInput): OperatorPreference {
  const valid = input.decisions.map(validatePreferenceDecisionRef).filter((ref): ref is PreferenceDecisionRef => ref !== null);
  const decisions = valid.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, PREFERENCE_EVIDENCE_MAX_DECISIONS);
  const signalOf = DECISION_SIGNAL[input.effect.kind];
  const measuring = decisions.filter((ref) => signalOf(input.effect, ref) !== "neutral");
  const supporting = measuring.filter((ref) => signalOf(input.effect, ref) === "supports").length;
  const sampleSize = measuring.length;
  const measurability: PreferenceMeasurability = sampleSize === 0 ? "unmeasurable" : sampleSize < PREFERENCE_SAMPLE_FLOOR ? "insufficient" : "measured";
  const confidence = measurability === "measured" ? Math.round((supporting / sampleSize) * 100) / 100 : null;
  const observedAt = isoAt(input.now);
  const newestDecisionAt = measuring[0]?.at;
  const effectText = EFFECT_TEXT[input.effect.kind](input.effect.value);
  const explanation =
    measurability === "measured"
      ? `${supporting} of ${sampleSize} recent operator decisions support this; proposed in shadow mode: ${effectText}`
      : measurability === "insufficient"
        ? `Only ${sampleSize} of the ${PREFERENCE_SAMPLE_FLOOR}-decision sample floor observed; unmeasurable, not a default: ${effectText}`
        : `No bounded operator decision measures this effect; unmeasurable, not a default: ${effectText}`;
  return {
    version: OPERATOR_PREFERENCE_VERSION,
    preferenceId: `pref-${digest([input.scope, input.effect, observedAt]).slice(0, 20)}`,
    scope: input.scope,
    effect: input.effect,
    evidence: {
      decisions: measuring,
      sampleSize,
      supporting,
      contradicting: sampleSize - supporting,
      sampleFloor: PREFERENCE_SAMPLE_FLOOR,
      refusedSamples: input.decisions.length - valid.length,
      ...(newestDecisionAt ? { newestDecisionAt } : {}),
    },
    confidence,
    measurability,
    observedAt,
    freshUntil: isoAt(Date.parse(newestDecisionAt ?? observedAt) + PREFERENCE_FRESHNESS_MS),
    expiresAt: isoAt(input.now + PREFERENCE_EXPIRY_MS),
    explanation,
    mode: "shadow",
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  };
}

function validEvidence(value: unknown): value is PreferenceEvidence {
  if (!record(value) || !Array.isArray(value.decisions) || value.decisions.some((ref) => validatePreferenceDecisionRef(ref) === null)) return false;
  return [value.sampleSize, value.supporting, value.contradicting, value.sampleFloor, value.refusedSamples].every((n) => Number.isInteger(n) && (n as number) >= 0);
}

/** Read one ledgered hypothesis back. An effect outside {@link PREFERENCE_EFFECT_KINDS} — e.g. a
 *  row claiming to grant a capability or raise a budget — is refused here, before anything applies. */
export function validateOperatorPreference(value: unknown): OperatorPreference | null {
  if (!record(value) || value.version !== OPERATOR_PREFERENCE_VERSION || !boundedText(value.preferenceId, MAX_SCOPE_TEXT)) return null;
  if (!validatePreferenceScope(value.scope) || !validatePreferenceEffect(value.effect) || !validEvidence(value.evidence)) return null;
  if (!MEASURABILITIES.has(value.measurability as string) || value.mode !== "shadow" || !boundedText(value.explanation, MAX_EXPLANATION)) return null;
  const confidenceOk = value.measurability === "measured" ? typeof value.confidence === "number" && value.confidence >= 0 && value.confidence <= 1 : value.confidence === null;
  if (!confidenceOk || !isoText(value.observedAt) || !isoText(value.freshUntil) || !isoText(value.expiresAt)) return null;
  return value as unknown as OperatorPreference;
}

export interface PreferenceEvent {
  receiptId: string;
  preferenceId: string;
  action: PreferenceAction;
  lifecycle: PreferenceLifecycle;
  previousLifecycle: PreferenceLifecycle;
  at: string;
  scope: PreferenceScope;
  requestId?: string;
  previousReceiptId?: string;
  hasNote?: boolean;
  correctionDigest?: string;
}

export function validatePreferenceEvent(value: unknown): PreferenceEvent | null {
  if (!record(value) || !boundedText(value.receiptId, MAX_SCOPE_TEXT) || !boundedText(value.preferenceId, MAX_SCOPE_TEXT)) return null;
  if (!PREFERENCE_ACTIONS.includes(value.action as PreferenceAction) || !PREFERENCE_LIFECYCLES.includes(value.lifecycle as PreferenceLifecycle)) return null;
  if (!PREFERENCE_LIFECYCLES.includes(value.previousLifecycle as PreferenceLifecycle) || !isoText(value.at) || !validatePreferenceScope(value.scope)) return null;
  return value as unknown as PreferenceEvent;
}

export interface PreferenceState {
  preference: OperatorPreference;
  events: PreferenceEvent[];
  lifecycle: PreferenceLifecycle;
  freshness: PreferenceFreshness;
  applies: boolean;
  /** Why it applies or not: `accepted`, `stale`, `insufficient`, `unmeasurable`, or the lifecycle. */
  reason: string;
}

/** The effective state at `now`: the last event's lifecycle, then expiry and measurability, then
 *  freshness. Only an accepted, measured, unexpired, fresh hypothesis applies. */
export function evaluatePreference(preference: OperatorPreference, events: readonly PreferenceEvent[], now: number): PreferenceState {
  let lifecycle: PreferenceLifecycle = events.at(-1)?.lifecycle ?? "proposed";
  if (lifecycle === "proposed" || lifecycle === "accepted") {
    if (preference.measurability !== "measured") lifecycle = "unmeasurable";
    else if (now >= Date.parse(preference.expiresAt)) lifecycle = "expired";
  }
  const freshness: PreferenceFreshness = now > Date.parse(preference.freshUntil) ? "stale" : "verified";
  const applies = lifecycle === "accepted" && freshness === "verified";
  const reason = lifecycle === "unmeasurable" ? preference.measurability : lifecycle === "accepted" && !applies ? "stale" : lifecycle;
  return { preference, events: [...events], lifecycle, freshness, applies, reason };
}

/** Fold the two ledger steps into evaluated states, first write of an id winning. */
export function foldOperatorPreferences(rows: Iterable<Record<string, unknown>>, now: number): PreferenceState[] {
  const preferences = new Map<string, OperatorPreference>();
  const events = new Map<string, PreferenceEvent[]>();
  for (const row of rows) {
    const preference = row.step === OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP ? validateOperatorPreference(row.preference) : null;
    if (preference && !preferences.has(preference.preferenceId)) preferences.set(preference.preferenceId, preference);
    const event = row.step === OPERATOR_PREFERENCE_EVENT_LEDGER_STEP ? validatePreferenceEvent(row.event) : null;
    if (event) events.set(event.preferenceId, [...(events.get(event.preferenceId) ?? []), event]);
  }
  return [...preferences.values()].map((preference) => evaluatePreference(preference, events.get(preference.preferenceId) ?? [], now));
}

export function preferenceInScope(scope: PreferenceScope, requested: PreferenceScope): boolean {
  if (scope.principalId !== requested.principalId || scope.repository !== requested.repository) return false;
  return scope.surface === undefined || scope.surface === requested.surface;
}

/** A listing without a surface shows every surface of the scope; application needs the exact one. */
export function preferenceListedFor(scope: PreferenceScope, requested: PreferenceScope): boolean {
  return preferenceInScope(scope, requested.surface === undefined ? { ...requested, surface: scope.surface } : requested);
}

export function samePreferenceScope(a: PreferenceScope, b: PreferenceScope): boolean {
  return preferenceInScope(a, b) && a.surface === b.surface;
}

export type PreferenceTransition = { ok: true; lifecycle: PreferenceLifecycle } | { ok: false; code: string; detail: string };

/** The only lifecycle moves an operator action can make. Deletion is terminal; an opt-out leaves
 *  only deletion; acceptance needs a measured, unexpired, fresh proposal. */
export function transitionPreference(state: PreferenceState, action: PreferenceAction): PreferenceTransition {
  const from = state.lifecycle;
  const refuse = (code: string): PreferenceTransition => ({ ok: false, code, detail: `cannot ${action} a ${from} preference (${state.reason})` });
  if (from === "deleted") return refuse("already_deleted");
  if (action === "delete") return { ok: true, lifecycle: "deleted" };
  if (from === "opted_out") return refuse("opted_out");
  if (action === "opt-out") return { ok: true, lifecycle: "opted_out" };
  if (action === "correct") return { ok: true, lifecycle: "corrected" };
  if (action === "reject") return from === "proposed" || from === "accepted" ? { ok: true, lifecycle: "rejected" } : refuse("invalid_transition");
  if (from !== "proposed" || state.freshness !== "verified") return refuse(from === "proposed" ? "stale_evidence" : "invalid_transition");
  return { ok: true, lifecycle: "accepted" };
}

export interface PreferenceActionInput {
  action: PreferenceAction;
  at: string;
  requestId?: string;
  note?: string;
  correction?: string;
}

/** The durable, linked receipt for one accepted operator action. A note is recorded as present, a
 *  correction only as a digest: neither raw text is stored. */
export function preferenceReceipt(state: PreferenceState, lifecycle: PreferenceLifecycle, input: PreferenceActionInput): PreferenceEvent {
  const previous = state.events.at(-1);
  return {
    receiptId: `prefrcpt-${digest([state.preference.preferenceId, input.action, input.at, state.events.length]).slice(0, 20)}`,
    preferenceId: state.preference.preferenceId,
    action: input.action,
    lifecycle,
    previousLifecycle: state.lifecycle,
    at: input.at,
    scope: state.preference.scope,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(previous ? { previousReceiptId: previous.receiptId } : {}),
    ...(input.note ? { hasNote: true } : {}),
    ...(input.correction ? { correctionDigest: digest([input.correction]).slice(0, 32) } : {}),
  };
}

/** The console's `preference-hypothesis-v1` projection. A deleted hypothesis keeps its id, scope
 *  and receipts but no longer serves its evidence anchors or explanation. */
export function projectOperatorPreference(state: PreferenceState): Record<string, unknown> {
  const { preference, lifecycle } = state;
  const deleted = lifecycle === "deleted";
  const evidence = preference.evidence;
  return {
    version: PREFERENCE_PROJECTION_VERSION,
    preferenceId: preference.preferenceId,
    scope: preference.scope,
    effect: preference.effect,
    evidence: {
      summary: deleted ? "withheld after deletion" : `${evidence.supporting} of ${evidence.sampleSize} bounded operator decisions support this; ${evidence.contradicting} contradict it`,
      sampleFloor: evidence.sampleFloor,
      sampleSize: evidence.sampleSize,
      source: EVIDENCE_SOURCE,
      observedAt: evidence.newestDecisionAt ?? preference.observedAt,
      freshness: state.freshness,
      ...(deleted ? {} : { anchors: evidence.decisions.slice(0, ANCHORS_SHOWN).map((ref) => ref.decisionRef) }),
    },
    confidence: { value: preference.confidence ?? 0, source: preference.confidence === null ? preference.measurability : EVIDENCE_SOURCE, sampleFloor: evidence.sampleFloor },
    freshness: state.freshness,
    expiresAt: preference.expiresAt,
    explanation: deleted ? "Deleted by the operator; this learned preference is no longer served." : preference.explanation,
    application: {
      state: state.applies ? "applied" : lifecycle === "proposed" ? "shadow" : "not_applied",
      effect: EFFECT_TEXT[preference.effect.kind](preference.effect.value),
      nonAuthorityGuarantee: PREFERENCE_NON_AUTHORITY_GUARANTEE,
      reason: state.reason,
    },
    lifecycle,
    source: PREFERENCE_SOURCE,
    observedAt: preference.observedAt,
    ...(preference.supersedes ? { supersedes: preference.supersedes } : {}),
    receipts: state.events.map((event) => ({ receiptId: event.receiptId, action: event.action, lifecycle: event.lifecycle, at: event.at })),
  };
}

/** A settled authority verdict. {@link applyScopedPreference} reads `checked` and never writes it. */
export interface PreferenceAuthorityVerdict {
  checked: boolean;
  actionable: boolean;
  refusal?: string;
}

export interface PresentationItem {
  id: string;
  category: string;
  authority: PreferenceAuthorityVerdict;
}

export interface PreferenceApplicationInput<T extends PresentationItem> {
  scope: PreferenceScope;
  items: readonly T[];
  preferences: readonly PreferenceState[];
}

export interface PreferenceApplication<T extends PresentationItem> {
  items: T[];
  notificationStyle?: string;
  clarificationWording?: string;
  applied: string[];
  skipped: Array<{ preferenceId: string; reason: string }>;
}

function strongestValue(states: readonly PreferenceState[], kind: PreferenceEffectKind): string | undefined {
  return [...states].filter((state) => state.preference.effect.kind === kind).sort((a, b) => (b.preference.confidence ?? 0) - (a.preference.confidence ?? 0))[0]?.preference.effect.value;
}

/**
 * Apply the principal's accepted preferences to ALREADY-DECIDED items. Every item must carry a
 * checked authority verdict, or nothing applies. Ordering moves only actionable items among their
 * own slots, so a refused item keeps its position and its refusal; authority verdicts are passed
 * through untouched, and an effect outside the presentation vocabulary is skipped by name.
 */
export function applyScopedPreference<T extends PresentationItem>(input: PreferenceApplicationInput<T>): PreferenceApplication<T> {
  const unchecked = input.items.some((item) => item.authority.checked !== true);
  const skipped: Array<{ preferenceId: string; reason: string }> = [];
  const applying: PreferenceState[] = [];
  for (const state of input.preferences) {
    const reason = unchecked
      ? "authority_unchecked"
      : !PREFERENCE_EFFECT_KINDS.includes(state.preference.effect.kind)
        ? "authority_effect_forbidden"
        : !preferenceInScope(state.preference.scope, input.scope)
          ? "scope_mismatch"
          : state.applies
            ? undefined
            : state.reason;
    if (reason) skipped.push({ preferenceId: state.preference.preferenceId, reason });
    else applying.push(state);
  }
  const preferred = applying
    .filter((state) => state.preference.effect.kind === "ordering")
    .sort((a, b) => (b.preference.confidence ?? 0) - (a.preference.confidence ?? 0))
    .map((state) => state.preference.effect.value);
  const rank = (item: T): number => (preferred.includes(item.category) ? preferred.indexOf(item.category) : preferred.length);
  const slots = input.items.flatMap((item, index) => (item.authority.actionable ? [index] : []));
  const ordered = slots.map((index) => input.items[index] as T).sort((a, b) => rank(a) - rank(b));
  const items = [...input.items];
  slots.forEach((slot, position) => {
    items[slot] = ordered[position] as T;
  });
  const notificationStyle = strongestValue(applying, "notification-style");
  const clarificationWording = strongestValue(applying, "clarification-wording");
  return {
    items,
    ...(notificationStyle ? { notificationStyle } : {}),
    ...(clarificationWording ? { clarificationWording } : {}),
    applied: applying.map((state) => state.preference.preferenceId),
    skipped,
  };
}
