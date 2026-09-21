/**
 * experiment-promotion-v1 — the guarded flow from a candidate policy to measured production
 * exposure (W1-T3856): deterministic replay, shadow observation, canary promotion, stop
 * conditions, and automatic rollback. Built on the durable `experiment-v1` record (W1-T3853,
 * src/lib/operator-agent.ts) and the automation-action execution seam (W1-T3855): an
 * experiment records the falsifiable hypothesis; a promotion records the bounded, guarded
 * progression a *later approved* experiment may take toward exposure. Acceptance here is never
 * created by an operator decision alone — only later observed guardrail evidence can move a
 * promotion past `approved`.
 *
 * This module owns only the engine: validation, a side-effect-free replay pass over a bounded
 * historical corpus, guardrail evaluation, and the experiment-promotion-v1 state machine. It
 * performs no I/O and holds no ledger or HTTP concerns — src/lib/operator-agent.ts is the durable
 * producer/consumer that persists the records this module validates and advances, mirroring the
 * experiment-v1 split between record shape and ledger wiring.
 */

export const EXPERIMENT_PROMOTION_VERSION = "experiment-promotion-v1";

export const EXPERIMENT_PROMOTION_STATES = [
  "proposed",
  "replayed",
  "approved",
  "shadow",
  "canary",
  "observing",
  "promoted",
  "neutral",
  "regressed",
  "rolled_back",
  "expired",
  "unmeasurable",
] as const;
export type ExperimentPromotionState = (typeof EXPERIMENT_PROMOTION_STATES)[number];

/** A promotion in one of these states is closed: it never advances or rolls back again. */
const TERMINAL_PROMOTION_STATES = new Set<ExperimentPromotionState>(["promoted", "neutral", "rolled_back", "expired"]);

/** A promotion in one of these states still holds its policy scope (W1-T3856 serialization). */
export function isPromotionActive(state: ExperimentPromotionState): boolean {
  return !TERMINAL_PROMOTION_STATES.has(state);
}

export type PromotionFreshness = "verified" | "stale" | "unavailable";

export interface PromotionGuardMetric {
  metricName: string;
  unit: string;
  /** "max": breach when the observed value exceeds abortThreshold. "min": breach when it falls below. */
  direction: "max" | "min";
  abortThreshold: number;
}

export interface PromotionScope {
  repo: string;
  /** The unit a canary is serialized against — at most one active promotion may hold a given (repo, policyScope) pair. */
  policyScope: string;
  taskType?: string;
  lane?: string;
}

export interface PromotionRollback {
  plan: string;
  reason: string;
  receipt?: string;
}

export interface PromotionObservationWindow {
  start: string;
  end: string;
}

export interface PromotionRecord {
  version: typeof EXPERIMENT_PROMOTION_VERSION;
  promotionId: string;
  /** Links to the experiment-v1 record (W1-T3853) this promotion progresses; optional so the engine stays usable standalone. */
  experimentId?: string;
  candidate: string;
  baseline: string;
  scope: PromotionScope;
  comparisonPopulation: string;
  denominatorFloor: number;
  observationWindow: PromotionObservationWindow;
  guardMetrics: PromotionGuardMetric[];
  maxExposure: number;
  owner: string;
  expiresAt: string;
  rollback: PromotionRollback;
  createdAt: string;
  state: ExperimentPromotionState;
}

const MAX_ID = 160;
const MAX_TEXT = 320;
const MAX_SOURCE = 220;
const MAX_GUARD_METRICS = 12;
const MIN_DENOMINATOR_FLOOR = 5;
const MAX_REPLAY_CASES = 500;

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, max: number): value is string {
  return boundedString(value, max) && !/(?:bearer|token|secret|password|api[_-]?key|sk-[A-Za-z0-9])/i.test(value);
}

function validFreshness(value: unknown): value is PromotionFreshness {
  return value === "verified" || value === "stale" || value === "unavailable";
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateScope(value: unknown): PromotionScope | null {
  if (!isRecord(value) || !safeText(value.repo, MAX_TEXT) || !safeText(value.policyScope, MAX_TEXT)) return null;
  const scope: PromotionScope = { repo: value.repo.trim(), policyScope: value.policyScope.trim() };
  for (const field of ["taskType", "lane"] as const) {
    if (value[field] !== undefined) {
      if (!safeText(value[field], MAX_TEXT)) return null;
      scope[field] = value[field].trim();
    }
  }
  return scope;
}

function validateGuardMetric(value: unknown): PromotionGuardMetric | null {
  if (!isRecord(value) || !safeText(value.metricName, MAX_TEXT) || !safeText(value.unit, 80)) return null;
  if (value.direction !== "max" && value.direction !== "min") return null;
  if (!finiteNumber(value.abortThreshold)) return null;
  return { metricName: value.metricName.trim(), unit: value.unit.trim(), direction: value.direction, abortThreshold: value.abortThreshold };
}

function validateGuardMetrics(value: unknown): PromotionGuardMetric[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GUARD_METRICS) return null;
  const metrics: PromotionGuardMetric[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const metric = validateGuardMetric(item);
    if (!metric || seen.has(metric.metricName)) return null;
    seen.add(metric.metricName);
    metrics.push(metric);
  }
  return metrics;
}

export function validatePromotionRollback(value: unknown): PromotionRollback | null {
  if (!isRecord(value) || !safeText(value.plan, MAX_TEXT) || !safeText(value.reason, MAX_TEXT)) return null;
  if (value.receipt !== undefined && !safeText(value.receipt, MAX_SOURCE)) return null;
  return { plan: value.plan.trim(), reason: value.reason.trim(), ...(value.receipt ? { receipt: value.receipt.trim() } : {}) };
}

/**
 * Validates a proposed promotion record before it may occupy a policy scope. Requires a
 * comparable baseline (candidate, baseline, comparison population, denominator floor, observation
 * window), at least one guard metric, a bounded maximum exposure, an owner, an expiry, and a
 * rollback plan — the design's "carries comparable baseline and canary guardrails" contract.
 */
export function validatePromotionRecord(value: unknown): PromotionRecord | null {
  if (!isRecord(value) || value.version !== EXPERIMENT_PROMOTION_VERSION || value.state !== "proposed") return null;
  if (!safeText(value.promotionId, MAX_ID) || !safeText(value.candidate, MAX_TEXT) || !safeText(value.baseline, MAX_TEXT)) return null;
  if (value.candidate === value.baseline) return null;
  if (value.experimentId !== undefined && !safeText(value.experimentId, MAX_ID)) return null;
  if (!safeText(value.comparisonPopulation, MAX_TEXT)) return null;
  if (!finiteNumber(value.denominatorFloor) || value.denominatorFloor < MIN_DENOMINATOR_FLOOR) return null;
  if (!isRecord(value.observationWindow) || !iso(value.observationWindow.start) || !iso(value.observationWindow.end)) return null;
  if (Date.parse(value.observationWindow.start) >= Date.parse(value.observationWindow.end)) return null;
  if (!finiteNumber(value.maxExposure) || value.maxExposure <= 0 || value.maxExposure > 1) return null;
  if (!safeText(value.owner, MAX_TEXT) || !iso(value.expiresAt) || !iso(value.createdAt)) return null;
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) return null;
  const scope = validateScope(value.scope);
  const guardMetrics = validateGuardMetrics(value.guardMetrics);
  const rollback = validatePromotionRollback(value.rollback);
  if (!scope || !guardMetrics || !rollback) return null;
  return {
    version: EXPERIMENT_PROMOTION_VERSION,
    promotionId: value.promotionId.trim(),
    ...(value.experimentId ? { experimentId: value.experimentId.trim() } : {}),
    candidate: value.candidate.trim(),
    baseline: value.baseline.trim(),
    scope,
    comparisonPopulation: value.comparisonPopulation.trim(),
    denominatorFloor: Math.floor(value.denominatorFloor),
    observationWindow: { start: new Date(value.observationWindow.start).toISOString(), end: new Date(value.observationWindow.end).toISOString() },
    guardMetrics,
    maxExposure: value.maxExposure,
    owner: value.owner.trim(),
    expiresAt: new Date(value.expiresAt).toISOString(),
    rollback,
    createdAt: new Date(value.createdAt).toISOString(),
    state: "proposed",
  };
}

// --- Replay ------------------------------------------------------------------------------------

export interface ReplayCase {
  caseId: string;
  input: unknown;
}

export interface ReplayCaseResult {
  caseId: string;
  candidateOutput: unknown;
  baselineOutput: unknown;
  matched: boolean;
}

export interface ReplaySummary {
  version: typeof EXPERIMENT_PROMOTION_VERSION;
  corpusSize: number;
  matched: number;
  mismatched: number;
  deterministic: boolean;
  sideEffectFree: true;
  results: ReplayCaseResult[];
}

export type ReplayPromotionOutcome = { ok: true; summary: ReplaySummary } | { ok: false; error: string };

/**
 * Runs a candidate and its baseline over a bounded historical corpus and compares outputs. `candidate`
 * and `baseline` must be pure functions supplied by the caller — this engine calls only them, so it
 * performs no I/O, network, filesystem, or process access of its own and never mutates `corpus` or
 * production state ("replay evaluates a candidate against a bounded historical corpus without
 * external side effects or production mutation"). Determinism is verified by re-running the same
 * corpus through the same functions and comparing results byte-for-byte, rather than assumed.
 */
export function replayPromotion(corpus: ReplayCase[], candidate: (input: unknown) => unknown, baseline: (input: unknown) => unknown): ReplayPromotionOutcome {
  if (!Array.isArray(corpus) || corpus.length === 0) return { ok: false, error: "replay corpus must be a non-empty bounded array" };
  if (corpus.length > MAX_REPLAY_CASES) return { ok: false, error: `replay corpus exceeds the bound of ${MAX_REPLAY_CASES} cases` };

  const run = (): ReplayCaseResult[] =>
    corpus.map((testCase) => {
      if (!isRecord(testCase) || typeof testCase.caseId !== "string" || testCase.caseId.trim().length === 0) {
        throw new Error("replay case is missing a caseId");
      }
      const candidateOutput = candidate(testCase.input);
      const baselineOutput = baseline(testCase.input);
      return { caseId: testCase.caseId, candidateOutput, baselineOutput, matched: JSON.stringify(candidateOutput) === JSON.stringify(baselineOutput) };
    });

  let results: ReplayCaseResult[];
  try {
    results = run();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "replay failed" };
  }

  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.caseId)) return { ok: false, error: `duplicate replay caseId ${result.caseId}` };
    seen.add(result.caseId);
  }

  // Determinism is measured, not assumed: replay the same pure corpus a second time and require
  // byte-identical output before the summary is trusted.
  const rerun = run();
  const deterministic = JSON.stringify(results) === JSON.stringify(rerun);
  const matched = results.filter((result) => result.matched).length;
  return {
    ok: true,
    summary: {
      version: EXPERIMENT_PROMOTION_VERSION,
      corpusSize: corpus.length,
      matched,
      mismatched: corpus.length - matched,
      deterministic,
      sideEffectFree: true,
      results,
    },
  };
}

/** Bounds check for a `ReplaySummary` submitted as a durable receipt (e.g. over HTTP), without re-executing anything. */
export function validateReplaySummary(value: unknown): ReplaySummary | null {
  if (!isRecord(value) || value.version !== EXPERIMENT_PROMOTION_VERSION) return null;
  if (!Array.isArray(value.results) || value.results.length === 0 || value.results.length > MAX_REPLAY_CASES) return null;
  if (!finiteNumber(value.corpusSize) || !finiteNumber(value.matched) || !finiteNumber(value.mismatched)) return null;
  if (value.corpusSize !== value.results.length || value.matched + value.mismatched !== value.corpusSize) return null;
  if (typeof value.deterministic !== "boolean" || value.sideEffectFree !== true) return null;
  const seen = new Set<string>();
  for (const item of value.results) {
    if (!isRecord(item) || !safeText(item.caseId, MAX_ID) || typeof item.matched !== "boolean") return null;
    if (seen.has(item.caseId)) return null;
    seen.add(item.caseId);
  }
  return value as unknown as ReplaySummary;
}

// --- Guardrails ----------------------------------------------------------------------------------

export interface GuardObservation {
  metricName: string;
  value: number;
  denominator: number;
  freshness: PromotionFreshness;
  comparisonPopulation: string;
  observedAt: string;
}

export type GuardEvaluationState = "ready" | "unmeasurable" | "regressed";

export interface GuardEvaluation {
  state: GuardEvaluationState;
  reasons: string[];
  breachedMetrics: string[];
}

export function validateGuardObservation(value: unknown): GuardObservation | null {
  if (!isRecord(value) || !safeText(value.metricName, MAX_TEXT) || !finiteNumber(value.value) || !finiteNumber(value.denominator)) return null;
  if (!validFreshness(value.freshness) || !safeText(value.comparisonPopulation, MAX_TEXT) || !iso(value.observedAt)) return null;
  return {
    metricName: value.metricName.trim(),
    value: value.value,
    denominator: Math.floor(value.denominator),
    freshness: value.freshness,
    comparisonPopulation: value.comparisonPopulation.trim(),
    observedAt: new Date(value.observedAt).toISOString(),
  };
}

export function validateGuardObservations(value: unknown): GuardObservation[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_GUARD_METRICS) return null;
  const observations: GuardObservation[] = [];
  for (const item of value) {
    const observation = validateGuardObservation(item);
    if (!observation) return null;
    observations.push(observation);
  }
  return observations;
}

/**
 * Evaluates a set of observations against a promotion's declared guard metrics, denominator
 * floor, comparison population, observation window, and expiry. Missing evidence, a below-floor
 * denominator, non-verified freshness, a mismatched population, or an observation older than the
 * window all become `unmeasurable` — never a favorable result. Any single breached metric becomes
 * `regressed`, which always outranks `unmeasurable`: a guardrail breach must abort even when other
 * metrics are also short on evidence.
 */
export function evaluateGuardrails(
  record: Pick<PromotionRecord, "guardMetrics" | "denominatorFloor" | "comparisonPopulation" | "observationWindow" | "expiresAt">,
  observations: GuardObservation[],
  nowIso: string,
): GuardEvaluation {
  if (Date.parse(nowIso) >= Date.parse(record.expiresAt)) {
    return { state: "unmeasurable", reasons: ["promotion window has expired"], breachedMetrics: [] };
  }
  if (record.guardMetrics.length === 0) return { state: "unmeasurable", reasons: ["no guard metrics declared"], breachedMetrics: [] };

  const byMetric = new Map(observations.map((observation) => [observation.metricName, observation]));
  const reasons: string[] = [];
  const breached: string[] = [];
  for (const guard of record.guardMetrics) {
    const observation = byMetric.get(guard.metricName);
    if (!observation) {
      reasons.push(`missing guard observation for ${guard.metricName}`);
      continue;
    }
    if (observation.denominator < record.denominatorFloor) {
      reasons.push(`${guard.metricName} denominator ${observation.denominator} is below the floor of ${record.denominatorFloor}`);
      continue;
    }
    if (observation.freshness !== "verified") {
      reasons.push(`${guard.metricName} evidence freshness is ${observation.freshness}`);
      continue;
    }
    if (observation.comparisonPopulation !== record.comparisonPopulation) {
      reasons.push(`${guard.metricName} comparison population does not match the promotion's declared population`);
      continue;
    }
    if (Date.parse(observation.observedAt) < Date.parse(record.observationWindow.start)) {
      reasons.push(`${guard.metricName} observation predates the observation window`);
      continue;
    }
    const breach = guard.direction === "max" ? observation.value > guard.abortThreshold : observation.value < guard.abortThreshold;
    if (breach) breached.push(guard.metricName);
  }

  if (breached.length > 0) return { state: "regressed", reasons: [`guardrail breach: ${breached.join(", ")}`], breachedMetrics: breached };
  if (reasons.length > 0) return { state: "unmeasurable", reasons, breachedMetrics: [] };
  return { state: "ready", reasons: [], breachedMetrics: [] };
}

// --- State machine ---------------------------------------------------------------------------

export type PromotionAdvanceTarget = "shadow" | "canary" | "observing" | "promoted";

/** The one state each advance target may be entered from — canary exposure may advance only serially, one step at a time. */
const ADVANCE_REQUIRES: Record<PromotionAdvanceTarget, ExperimentPromotionState> = {
  shadow: "approved",
  canary: "shadow",
  observing: "canary",
  promoted: "observing",
};

export interface AdvancePromotionInput {
  currentState: ExperimentPromotionState;
  target: PromotionAdvanceTarget;
  guard: GuardEvaluation;
  maxExposure: number;
  exposure?: number;
}

export interface AdvancePromotionResult {
  state: ExperimentPromotionState;
  reason?: string;
}

/**
 * Advances a promotion exactly one guarded step. `shadow` entry is a passive observation mode and
 * requires only that the promotion was approved. Every later step (`canary`, `observing`,
 * `promoted`) requires the guard evaluation computed from freshly submitted observations: a
 * breach becomes `regressed`, insufficient evidence becomes `unmeasurable`, and only a `ready`
 * evaluation reaches the requested target — so a promotion can be pushed to `promoted` only after
 * observed evidence clears its sample floor and guardrails, never by an operator decision alone.
 */
export function advancePromotionState(input: AdvancePromotionInput): AdvancePromotionResult {
  const requiredFrom = ADVANCE_REQUIRES[input.target];
  if (input.currentState !== requiredFrom) {
    return { state: input.currentState, reason: `cannot advance to ${input.target} from ${input.currentState}; expected ${requiredFrom}` };
  }
  if (input.target === "shadow") return { state: "shadow" };
  if (input.exposure !== undefined && (input.exposure <= 0 || input.exposure > input.maxExposure)) {
    return { state: input.currentState, reason: `requested exposure ${input.exposure} exceeds the declared maximum exposure ${input.maxExposure}` };
  }
  if (input.guard.state === "regressed") return { state: "regressed", reason: `guardrail breach: ${input.guard.breachedMetrics.join(", ")}` };
  if (input.guard.state === "unmeasurable") return { state: "unmeasurable", reason: input.guard.reasons.join("; ") };
  return { state: input.target };
}

const ROLLBACK_ALLOWED_FROM = new Set<ExperimentPromotionState>(["approved", "shadow", "canary", "observing", "regressed", "unmeasurable"]);

export type RollbackPromotionOutcome = { ok: true; state: "rolled_back" } | { ok: false; error: string };

/** Rollback is a new linked event, never a rewrite: it is refused once a promotion has already reached a terminal state. */
export function rollbackPromotion(currentState: ExperimentPromotionState): RollbackPromotionOutcome {
  if (!ROLLBACK_ALLOWED_FROM.has(currentState)) return { ok: false, error: `promotion cannot be rolled back from ${currentState}` };
  return { ok: true, state: "rolled_back" };
}

/** A stale, unmeasured promotion never silently stays open: past its declared expiry it becomes `expired`, never `promoted`. */
export function expirePromotionIfDue(currentState: ExperimentPromotionState, expiresAt: string, nowIso: string): ExperimentPromotionState {
  if (TERMINAL_PROMOTION_STATES.has(currentState)) return currentState;
  return Date.parse(nowIso) >= Date.parse(expiresAt) ? "expired" : currentState;
}

export interface PromotionScopeCandidate {
  promotionId: string;
  scope: PromotionScope;
  state: ExperimentPromotionState;
}

/**
 * Canary exposure is serialized per policy scope: at most one active (non-terminal) promotion may
 * hold a given (repo, policyScope) pair at a time. Returns the conflicting promotion id, or `null`
 * when the candidate scope is free.
 */
export function findScopeConflict(activePromotions: PromotionScopeCandidate[], candidateScope: PromotionScope, candidatePromotionId: string): { promotionId: string } | null {
  const conflict = activePromotions.find(
    (promotion) =>
      promotion.promotionId !== candidatePromotionId &&
      promotion.scope.repo === candidateScope.repo &&
      promotion.scope.policyScope === candidateScope.policyScope &&
      isPromotionActive(promotion.state),
  );
  return conflict ? { promotionId: conflict.promotionId } : null;
}
