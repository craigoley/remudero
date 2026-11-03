/** Private measurements: unavailable is never zero; task runs own retry cost. */
import { createHash } from "node:crypto";
import { fixedClock } from "./clock.js";
import type { WorkspaceUsageEvidence } from "./workspace-usage.js";
import type { WorkerExecutionEvidenceV1 } from "./worker-execution-evidence.js";

export type CanaryBilling = "api" | "subscription";
export type CanarySourceActivityKind = "coding-dispatch" | "non-dispatch-review" | "synthetic-canary" | "other";
/** Explicit source classification only. Canary family labels do not establish dispatch activity. */
export interface CanarySourceActivity {
  kind: CanarySourceActivityKind;
  source: "benchmark-run-v1" | "model-canary-v1";
  sourceReceiptId: string;
  lane: string;
}
/** One scheduled case across arms. Retention turns and retries stay inside one run. */
export interface CanaryTrialBlock {
  version: "canary-trial-block-v1";
  day: string;
  scheduleDigest: string;
  blockId: string;
  slotId: string;
  plannedSlotIds: string[];
  position: number;
  aaLabel: "A" | "B" | null;
}

export function canaryTrialBlockId(day: string, suiteHash: string, caseId: string,
  scheduleDigest: string, plannedSlotIds: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([
    "canary-trial-block-v1", day, suiteHash, caseId, scheduleDigest, plannedSlotIds,
  ])).digest("hex");
}
export interface CanaryAttempt {
  id: string;
  durationMs: number | null;
  firstTextMs: number | null;
  generationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  usageRatedUsd: number | null;
  billing: CanaryBilling;
  servedModel: string | null;
  terminal: "complete" | "error" | "timeout";
  /** Optional private producer evidence; absent means unavailable, including historical trials. */
  workspaceUsage?: WorkspaceUsageEvidence;
  /** Optional, source-bound worker-spawn evidence. Legacy request measurements remain separate. */
  executionEvidence?: WorkerExecutionEvidenceV1;
}
export interface CanaryRun {
  id: string;
  caseId: string;
  suiteHash: string;
  model: string;
  route: string;
  effort: string;
  family: string;
  verified: boolean | null;
  totalDurationMs: number | null;
  attempts: CanaryAttempt[];
  /** Explicit class evidence; absent or malformed metadata is unclassified, never inferred from family. */
  sourceActivity?: CanarySourceActivity;
  outcomeReason?: string;
  retention?: { turnsObserved: number; violations: number; firstViolationTurn: number | null };
  contextProfile?: { version: "canary-context-v1"; bytes: 2048 | 16384 | 65536;
    treatment: "first-use" | "repeat"; byteUnit: "utf8-bytes"; cacheGuarantee: "none";
    phases: { phase: string; verified: boolean | null; attemptIds: string[] }[];
    probeCache: "unavailable" | "observed-read" | "observed-zero" };
  trial?: CanaryTrialBlock;
}
export const nonnegativeMeasurement = (n: number | null): n is number =>
  n !== null && Number.isFinite(n) && n >= 0;

type EvidenceRead<T> = { state: "observed"; value: T } | { state: "unavailable"; reason: string };
type EvidenceDisposition = { state: "absent" } | { state: "invalid"; reason: string }
  | { state: "observed"; evidence: WorkerExecutionEvidenceV1 };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_EVIDENCE_TEXT = 200;
const MAX_EVIDENCE_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_EVIDENCE_ELAPSED_MS = 7 * 24 * 60 * 60 * 1000;

function validObservedOrUnavailable<T>(value: unknown, valid: (item: unknown) => item is T): value is EvidenceRead<T> {
  if (!record(value)) return false;
  if (value.state === "observed") return valid(value.value);
  return value.state === "unavailable" && typeof value.reason === "string"
    && value.reason.length > 0 && value.reason.length <= MAX_EVIDENCE_TEXT;
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_EVIDENCE_TEXT;
}
function boundedNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_EVIDENCE_NUMBER;
}
function boundedElapsed(value: unknown): value is number {
  return boundedNumber(value) && value <= MAX_EVIDENCE_ELAPSED_MS;
}
function boundedToken(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function unavailableOnly(value: unknown): boolean {
  return record(value) && value.state === "unavailable" && typeof value.reason === "string"
    && value.reason.length > 0 && value.reason.length <= MAX_EVIDENCE_TEXT;
}

/** Validate only the frozen v1 fields consumed here. Private JSON is data, not a trusted TS object. */
function inspectExecutionEvidence(value: unknown, attempt: CanaryAttempt): EvidenceDisposition {
  if (value === undefined) return { state: "absent" };
  const invalid = (reason: string): EvidenceDisposition => ({ state: "invalid", reason });
  if (!record(value)) return invalid("evidence-not-object");
  if (!boundedString(attempt.id)) return invalid("attempt-id-invalid");
  if (value.version !== "worker-execution-evidence-v1") return invalid("unsupported-evidence-version");
  if (value.unit !== "worker-spawn" || value.measurementScope !== "returned-terminal-result") return invalid("unsupported-evidence-scope");
  if (value.attemptId !== attempt.id) return invalid("attempt-id-mismatch");
  if (!record(value.identity) || !record(value.execution) || !record(value.accounting)) return invalid("evidence-section-invalid");

  const identity = value.identity, execution = value.execution, accounting = value.accounting;
  const providerValid = (item: unknown): item is string => typeof item === "string"
    && ["claude", "codex", "cash"].includes(item);
  const stringFields: unknown[] = [identity.provider, identity.configuredModel, identity.routedModel,
    identity.sdkRequestedModel, identity.sdkRequestedEffort, identity.servedModel];
  if (!stringFields.every(item => validObservedOrUnavailable(item,
    (entry): entry is string => item === identity.provider ? providerValid(entry) : boundedString(entry))))
    return invalid("identity-evidence-invalid");
  const provider = identity.provider as EvidenceRead<string>;
  const served = identity.servedModel as EvidenceRead<string>;
  if (served.state === "observed" && attempt.servedModel !== null && served.value !== attempt.servedModel)
    return invalid("attempt-served-identity-mismatch");
  if (!validObservedOrUnavailable(value.providerInvoked, (item): item is boolean => typeof item === "boolean"))
    return invalid("provider-invocation-evidence-invalid");
  if (!validObservedOrUnavailable(execution.terminal, (item): item is string => item === "success" || item === "error" || item === "refused")
    || !validObservedOrUnavailable(execution.durationMs, boundedElapsed)
    || !validObservedOrUnavailable(execution.firstTextMs, boundedElapsed)) return invalid("execution-measurement-invalid");
  const duration = execution.durationMs as EvidenceRead<number>, firstText = execution.firstTextMs as EvidenceRead<number>;
  if (duration.state === "observed" && firstText.state === "observed" && firstText.value > duration.value)
    return invalid("first-text-exceeds-worker-duration");
  if (!record(execution.tokenUsage)) return invalid("token-usage-evidence-invalid");
  if (execution.tokenUsage.state === "unavailable") {
    if (!unavailableOnly(execution.tokenUsage)) return invalid("token-usage-evidence-invalid");
  } else if (execution.tokenUsage.state === "observed" || execution.tokenUsage.state === "partial") {
    const usage = execution.tokenUsage.value;
    if (!record(usage) || ![usage.input, usage.output, usage.cacheRead, usage.cacheCreation].every(boundedToken))
      return invalid("token-usage-value-invalid");
  } else return invalid("token-usage-state-invalid");

  if (!validObservedOrUnavailable(accounting.billingMode,
    (item): item is CanaryBilling => item === "api" || item === "subscription")) return invalid("billing-mode-invalid");
  const billingMode = accounting.billingMode as EvidenceRead<CanaryBilling>;
  const observedCashProvider = provider.state === "observed" && provider.value === "cash";
  if (billingMode.state === "observed" && billingMode.value !== attempt.billing)
    return invalid("attempt-billing-scope-mismatch");
  if (observedCashProvider && billingMode.state === "observed" && billingMode.value !== "api")
    return invalid("cash-provider-billing-scope-mismatch");
  const api = accounting.apiUsageRatedUsd, notional = accounting.subscriptionNotionalUsd, billed = accounting.billedCashUsd;
  if (!validObservedOrUnavailable(api, boundedNumber) || !validObservedOrUnavailable(notional, boundedNumber)
    || !validObservedOrUnavailable(billed, boundedNumber)) return invalid("accounting-evidence-invalid");
  if ((billingMode.state !== "observed" || billingMode.value !== "api") && api.state === "observed")
    return invalid("api-cost-scope-mismatch");
  if ((billingMode.state !== "observed" || billingMode.value !== "subscription") && notional.state === "observed")
    return invalid("subscription-cost-scope-mismatch");
  if (!observedCashProvider && billed.state === "observed") return invalid("cash-billing-scope-mismatch");
  if (!unavailableOnly(accounting.invoiceUsd)) return invalid("invoice-is-not-supported-by-worker-evidence-v1");
  if (!unavailableOnly(execution.invocationCount) || !unavailableOnly(execution.fallbackCoverage)
    || !unavailableOnly(execution.peakRssBytes)) return invalid("unsupported-worker-measurement-observed");
  if (!record(accounting.cashBudget)) return invalid("cash-budget-evidence-invalid");
  const budget = accounting.cashBudget;
  const budgetMeasures = [budget.reservedUsd, budget.settledUsd, budget.heldUsd];
  if (!budgetMeasures.every((item): item is EvidenceRead<number> => validObservedOrUnavailable(item, boundedNumber)))
    return invalid("cash-budget-evidence-invalid");
  if (!observedCashProvider && budgetMeasures.some(item => item.state === "observed"))
    return invalid("cash-budget-scope-mismatch");
  return { state: "observed", evidence: value as unknown as WorkerExecutionEvidenceV1 };
}

export interface CanaryEvidenceMetricCoverage {
  attempts: number;
  notApplicable: number;
  observed: number;
  partial: number;
  unavailable: number;
  invalid: number;
  observedLowerBound: number | null;
  total: number | null;
  aggregateOverflow: boolean;
  p50: number | null;
  p95: number | null;
}
export interface CanaryExecutionEvidenceProjection {
  attempts: number;
  observed: number;
  absent: number;
  invalid: number;
  sourceAttemptIds: string[];
  sourceAttemptIdsTruncated: boolean;
  attemptRows: Array<{
    attemptId: string;
    state: "observed" | "absent" | "invalid";
    reason: string | null;
    workerDurationMs: number | null;
    firstTextMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    billingMode: CanaryBilling | null;
    apiUsageRatedUsd: number | null;
    subscriptionNotionalUsd: number | null;
    billedCashUsd: number | null;
    invoiceUsd: null;
    reservedUsd: number | null;
    settledUsd: number | null;
    heldUsd: number | null;
  }>;
  freshness: { state: "unknown"; reason: string };
  workerDurationMs: CanaryEvidenceMetricCoverage;
  firstTextMs: CanaryEvidenceMetricCoverage;
  inputTokens: CanaryEvidenceMetricCoverage;
  outputTokens: CanaryEvidenceMetricCoverage;
  cacheReadTokens: CanaryEvidenceMetricCoverage;
  cacheCreationTokens: CanaryEvidenceMetricCoverage;
  invocationCount: CanaryEvidenceMetricCoverage;
  peakRssBytes: CanaryEvidenceMetricCoverage;
  accounting: {
    apiUsageRatedUsd: CanaryEvidenceMetricCoverage;
    subscriptionNotionalUsd: CanaryEvidenceMetricCoverage;
    billedCashUsd: CanaryEvidenceMetricCoverage;
    invoiceUsd: CanaryEvidenceMetricCoverage;
    reservedUsd: CanaryEvidenceMetricCoverage;
    settledUsd: CanaryEvidenceMetricCoverage;
    heldUsd: CanaryEvidenceMetricCoverage;
  };
  exclusions: Record<string, number>;
}
export interface CanaryCodingCohortCoverage {
  includedAttempts: number;
  excludedNonDispatchReviewAttempts: number;
  excludedSyntheticCanaryAttempts: number;
  excludedOtherAttempts: number;
  unclassifiedAttempts: number;
  sourceReceiptIds: string[];
}

function activityDisposition(value: unknown): { kind: "coding-dispatch" | "non-dispatch-review" | "synthetic-canary" | "other"; sourceReceiptId: string } | null {
  if (!record(value) || typeof value.kind !== "string"
    || !["coding-dispatch", "non-dispatch-review", "synthetic-canary", "other"].includes(value.kind)
    || !boundedString(value.sourceReceiptId) || !boundedString(value.lane)) return null;
  if ((value.kind === "coding-dispatch" || value.kind === "non-dispatch-review") && value.source !== "benchmark-run-v1") return null;
  if (value.kind === "synthetic-canary" && value.source !== "model-canary-v1") return null;
  if (value.kind === "other" && value.source !== "benchmark-run-v1" && value.source !== "model-canary-v1") return null;
  return { kind: value.kind as "coding-dispatch" | "non-dispatch-review" | "synthetic-canary" | "other",
    sourceReceiptId: value.sourceReceiptId };
}

function metricCoverage(samples: Array<{ state: "observed" | "partial" | "unavailable" | "invalid"; value?: number }>,
  attempts: number, notApplicable = 0): CanaryEvidenceMetricCoverage {
  const values = samples.flatMap(sample => sample.value === undefined ? [] : [sample.value]);
  const observed = samples.filter(sample => sample.state === "observed").length;
  const partial = samples.filter(sample => sample.state === "partial").length;
  const invalid = samples.filter(sample => sample.state === "invalid").length;
  const unavailable = Math.max(0, attempts - notApplicable - observed - partial - invalid);
  let sum = 0, aggregateOverflow = false;
  for (const value of values) {
    const next = sum + value;
    if (!Number.isFinite(next) || next > MAX_EVIDENCE_NUMBER) { aggregateOverflow = true; break; }
    sum = next;
  }
  const observedLowerBound = values.length && !aggregateOverflow ? sum : null;
  return { attempts, notApplicable, observed, partial, unavailable, invalid, observedLowerBound, aggregateOverflow,
    total: observed === attempts - notApplicable && attempts > notApplicable && !aggregateOverflow ? sum : null,
    p50: quantile(values, .5), p95: values.length >= 20 ? quantile(values, .95) : null };
}

function executionProjection(attempts: readonly CanaryAttempt[], dispositions: ReadonlyMap<string, EvidenceDisposition>): CanaryExecutionEvidenceProjection {
  const exclusions: Record<string, number> = {};
  const note = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  const rows = attempts.map(attempt => ({ attempt, disposition: dispositions.get(attempt.id) ?? { state: "absent" as const } }));
  const valid = rows.filter(row => row.disposition.state === "observed");
  const amount = (value: EvidenceRead<number>) => value.state === "observed" ? value.value : null;
  const attemptRows = rows.map(({ attempt, disposition }) => {
    if (disposition.state !== "observed") return { attemptId: attempt.id, state: disposition.state,
      reason: disposition.state === "invalid" ? disposition.reason : "worker-execution-evidence-not-present",
      workerDurationMs: null, firstTextMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreationTokens: null, billingMode: null, apiUsageRatedUsd: null,
      subscriptionNotionalUsd: null, billedCashUsd: null, invoiceUsd: null, reservedUsd: null, settledUsd: null, heldUsd: null } as const;
    const evidence = disposition.evidence, tokenUsage = evidence.execution.tokenUsage;
    // A partial usage object does not establish any field as complete. Keep it
    // visible in coverage while withholding per-attempt numeric counters.
    const tokens = tokenUsage.state === "observed" ? tokenUsage.value : null;
    return { attemptId: attempt.id, state: "observed" as const, reason: null,
      workerDurationMs: amount(evidence.execution.durationMs), firstTextMs: amount(evidence.execution.firstTextMs),
      inputTokens: tokens?.input ?? null, outputTokens: tokens?.output ?? null,
      cacheReadTokens: tokens?.cacheRead ?? null, cacheCreationTokens: tokens?.cacheCreation ?? null,
      billingMode: evidence.accounting.billingMode.state === "observed" ? evidence.accounting.billingMode.value : null,
      apiUsageRatedUsd: amount(evidence.accounting.apiUsageRatedUsd),
      subscriptionNotionalUsd: amount(evidence.accounting.subscriptionNotionalUsd),
      billedCashUsd: amount(evidence.accounting.billedCashUsd), invoiceUsd: null,
      reservedUsd: amount(evidence.accounting.cashBudget.reservedUsd),
      settledUsd: amount(evidence.accounting.cashBudget.settledUsd), heldUsd: amount(evidence.accounting.cashBudget.heldUsd) };
  });
  const sample = (field: (e: WorkerExecutionEvidenceV1) => EvidenceRead<number>, applicable: (attempt: CanaryAttempt, e: WorkerExecutionEvidenceV1) => boolean = () => true) => {
    const out: Array<{ state: "observed" | "partial" | "unavailable" | "invalid"; value?: number }> = [];
    for (const row of rows) {
      if (row.disposition.state === "invalid") { out.push({ state: "invalid" }); continue; }
      if (row.disposition.state === "absent") { out.push({ state: "unavailable" }); continue; }
      if (!applicable(row.attempt, row.disposition.evidence)) continue;
      const item = field(row.disposition.evidence);
      out.push(item.state === "observed" ? { state: "observed", value: item.value } : { state: "unavailable" });
    }
    return metricCoverage(out, rows.length, rows.length - out.length);
  };
  for (const row of rows) {
    if (row.disposition.state === "invalid") note(row.disposition.reason);
    if (row.disposition.state === "absent") note("execution-evidence-absent");
    if (row.attempt.billing === "api" && row.disposition.state === "observed"
      && row.disposition.evidence.accounting.apiUsageRatedUsd.state === "unavailable") note("api-usage-rated-unavailable");
    if (row.attempt.billing === "subscription" && row.disposition.state === "observed"
      && row.disposition.evidence.accounting.subscriptionNotionalUsd.state === "unavailable") note("subscription-notional-unavailable");
  }
  const token = (field: "input" | "output" | "cacheRead" | "cacheCreation") => {
    const out: Array<{ state: "observed" | "partial" | "unavailable" | "invalid"; value?: number }> = [];
    for (const row of rows) {
      if (row.disposition.state === "invalid") { out.push({ state: "invalid" }); continue; }
      if (row.disposition.state === "absent") { out.push({ state: "unavailable" }); continue; }
      const usage = row.disposition.evidence.execution.tokenUsage;
      if (usage.state === "unavailable") out.push({ state: "unavailable" });
      else if (usage.state === "partial") out.push({ state: "partial" });
      else out.push({ state: "observed", value: usage.value[field] });
    }
    return metricCoverage(out, rows.length, rows.length - out.length);
  };
  const cashOnly = (field: "reservedUsd" | "settledUsd" | "heldUsd") =>
    (e: WorkerExecutionEvidenceV1): EvidenceRead<number> => e.accounting.cashBudget[field];
  const cashApplicable = (_attempt: CanaryAttempt, e: WorkerExecutionEvidenceV1): boolean | undefined =>
    e.identity.provider.state === "unavailable" ? undefined : e.identity.provider.value === "cash";
  const fieldSamples = (field: (e: WorkerExecutionEvidenceV1) => EvidenceRead<number>,
    applicable: (attempt: CanaryAttempt, e: WorkerExecutionEvidenceV1) => boolean | undefined = () => true,
    applicableAttempt: (attempt: CanaryAttempt) => boolean = () => true) => {
    const out: Array<{ state: "observed" | "partial" | "unavailable" | "invalid"; value?: number }> = [];
    let notApplicable = 0;
    for (const row of rows) {
      if (!applicableAttempt(row.attempt)) { notApplicable++; continue; }
      if (row.disposition.state === "invalid") { out.push({ state: "invalid" }); continue; }
      if (row.disposition.state === "absent") { out.push({ state: "unavailable" }); continue; }
      const applies = applicable(row.attempt, row.disposition.evidence);
      if (applies === false) { notApplicable++; continue; }
      if (applies === undefined) { out.push({ state: "unavailable" }); continue; }
      const item = field(row.disposition.evidence);
      out.push(item.state === "observed" ? { state: "observed", value: item.value } : { state: "unavailable" });
    }
    return metricCoverage(out, rows.length, notApplicable);
  };
  const sourceAttemptIds = valid.map(row => row.attempt.id).sort();
  return { attempts: rows.length, observed: valid.length, absent: rows.filter(row => row.disposition.state === "absent").length,
    invalid: rows.filter(row => row.disposition.state === "invalid").length,
    sourceAttemptIds: sourceAttemptIds.slice(0, 256), sourceAttemptIdsTruncated: sourceAttemptIds.length > 256,
    attemptRows,
    freshness: { state: "unknown", reason: "worker-execution-evidence-v1-has-no-source-timestamp" },
    workerDurationMs: sample(e => e.execution.durationMs), firstTextMs: sample(e => e.execution.firstTextMs),
    inputTokens: token("input"), outputTokens: token("output"), cacheReadTokens: token("cacheRead"), cacheCreationTokens: token("cacheCreation"),
    invocationCount: sample(e => e.execution.invocationCount as EvidenceRead<number>),
    peakRssBytes: sample(e => e.execution.peakRssBytes),
    accounting: {
      apiUsageRatedUsd: fieldSamples(e => e.accounting.apiUsageRatedUsd, () => true, attempt => attempt.billing === "api"),
      subscriptionNotionalUsd: fieldSamples(e => e.accounting.subscriptionNotionalUsd, () => true, attempt => attempt.billing === "subscription"),
      billedCashUsd: fieldSamples(e => e.accounting.billedCashUsd, cashApplicable),
      invoiceUsd: fieldSamples(e => e.accounting.invoiceUsd, () => true),
      reservedUsd: fieldSamples(cashOnly("reservedUsd"), cashApplicable),
      settledUsd: fieldSamples(cashOnly("settledUsd"), cashApplicable),
      heldUsd: fieldSamples(cashOnly("heldUsd"), cashApplicable),
    }, exclusions };
}

function codingCohortProjection(runs: readonly CanaryRun[]): CanaryCodingCohortCoverage {
  const coverage: CanaryCodingCohortCoverage = { includedAttempts: 0, excludedNonDispatchReviewAttempts: 0,
    excludedSyntheticCanaryAttempts: 0, excludedOtherAttempts: 0, unclassifiedAttempts: 0, sourceReceiptIds: [] };
  const sources = new Set<string>();
  for (const run of runs) {
    const activity = activityDisposition(run.sourceActivity);
    if (!activity) { coverage.unclassifiedAttempts += run.attempts.length; continue; }
    sources.add(activity.sourceReceiptId);
    if (activity.kind === "coding-dispatch") coverage.includedAttempts += run.attempts.length;
    else if (activity.kind === "non-dispatch-review") coverage.excludedNonDispatchReviewAttempts += run.attempts.length;
    else if (activity.kind === "synthetic-canary") coverage.excludedSyntheticCanaryAttempts += run.attempts.length;
    else coverage.excludedOtherAttempts += run.attempts.length;
  }
  coverage.sourceReceiptIds = [...sources].sort();
  return coverage;
}

/** Observed text deltas are timed separately from thinking/empty/keepalive events. */
export function canaryStreamClock(startMs: number) {
  let first: number | null = null;
  let last: number | null = null;
  let invalid = !Number.isFinite(startMs);
  return {
    text(atMs: number, delta: string) {
      if (!delta) return;
      if (!Number.isFinite(atMs) || atMs < startMs || (last !== null && atMs < last)) { invalid = true; return; }
      first ??= atMs; last = atMs;
    },
    finish(endMs: number) {
      if (!Number.isFinite(endMs) || endMs < startMs || (last !== null && endMs < last)) invalid = true;
      return { durationMs: invalid ? null : endMs - startMs,
        firstTextMs: invalid || first === null ? null : first - startMs,
        generationMs: invalid || first === null || last === null ? null : last - first };
    },
  };
}

export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(q * sorted.length) - 1] ?? sorted[0]!;
}

/** Wilson interval is descriptive per arm; repeated-case causal analyses need clustered pairing. */
export function canaryPassInterval(successes: number, observed: number): [number, number] | null {
  if (observed === 0) return null;
  const z = 1.959963984540054, p = successes / observed, denom = 1 + z * z / observed;
  const center = (p + z * z / (2 * observed)) / denom;
  const radius = z * Math.sqrt(p * (1 - p) / observed + z * z / (4 * observed * observed)) / denom;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

/** Exact duplicates are idempotent. Contradictory IDs refuse the whole projection. */
export function projectCanaryRuns(input: readonly CanaryRun[]) {
  if (input.length > 8192) throw new Error("canary-projection-bound");
  const runs = new Map<string, CanaryRun>();
  const attemptIds = new Set<string>();
  const trialSlots = new Set<string>();
  const executionByAttempt = new Map<string, EvidenceDisposition>();
  for (const run of input) {
    if (!run.id || !run.caseId || !/^[a-f0-9]{64}$/.test(run.suiteHash) || !run.model || !run.route || !run.effort || !run.family)
      throw new Error("canary-run-identity-invalid");
    if ((run.verified !== null && typeof run.verified !== "boolean")
      || (run.totalDurationMs !== null && !nonnegativeMeasurement(run.totalDurationMs))) throw new Error("canary-run-outcome-invalid");
    if (run.trial !== undefined) {
      const t = run.trial, hash = /^[a-f0-9]{64}$/;
      if (!t || t.version !== "canary-trial-block-v1" || !/^\d{4}-\d{2}-\d{2}$/.test(t.day)
        || !Number.isFinite(Date.parse(t.day + "T00:00:00Z"))
        || fixedClock(Date.parse(t.day + "T00:00:00Z")).iso().slice(0, 10) !== t.day
        || !hash.test(t.scheduleDigest) || !hash.test(t.slotId)
        || !Array.isArray(t.plannedSlotIds) || !t.plannedSlotIds.length || t.plannedSlotIds.length > 128
        || t.plannedSlotIds.some(id => typeof id !== "string" || !hash.test(id))
        || new Set(t.plannedSlotIds).size !== t.plannedSlotIds.length
        || !Number.isInteger(t.position) || t.position < 0 || t.plannedSlotIds[t.position] !== t.slotId
        || ![null, "A", "B"].includes(t.aaLabel)
        || t.blockId !== canaryTrialBlockId(t.day, run.suiteHash, run.caseId, t.scheduleDigest, t.plannedSlotIds))
        throw new Error("canary-trial-block-invalid");
    }
    const prior = runs.get(run.id);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(run)) throw new Error("canary-run-conflicting-duplicate");
      continue;
    }
    if (run.trial) {
      if (trialSlots.has(run.trial.slotId)) throw new Error("canary-trial-slot-reused");
      trialSlots.add(run.trial.slotId);
    }
    if (run.attempts.length > (run.family === "retention" ? 50 : 8)
      || (!run.attempts.length && run.verified !== null)) throw new Error("canary-attempt-bound");
    for (const attempt of run.attempts) {
      if (!attempt.id || attemptIds.has(attempt.id)) throw new Error("canary-attempt-identity-reused");
      attemptIds.add(attempt.id);
      executionByAttempt.set(attempt.id, inspectExecutionEvidence(attempt.executionEvidence, attempt));
      for (const value of [attempt.durationMs, attempt.firstTextMs, attempt.generationMs, attempt.inputTokens,
        attempt.outputTokens, attempt.cacheReadTokens, attempt.cacheWriteTokens, attempt.reasoningTokens, attempt.usageRatedUsd])
        if (value !== null && !nonnegativeMeasurement(value)) throw new Error("canary-measurement-invalid");
      if (!["api", "subscription"].includes(attempt.billing)) throw new Error("canary-billing-invalid");
      if (!["complete", "error", "timeout"].includes(attempt.terminal)) throw new Error("canary-terminal-invalid");
      if (attempt.servedModel !== null && (typeof attempt.servedModel !== "string" || !attempt.servedModel.trim()))
        throw new Error("canary-served-model-invalid");
      for (const value of [attempt.inputTokens, attempt.outputTokens, attempt.cacheReadTokens,
        attempt.cacheWriteTokens, attempt.reasoningTokens])
        if (value !== null && !Number.isSafeInteger(value)) throw new Error("canary-token-count-invalid");
    }
    runs.set(run.id, run);
  }
  const groups = new Map<string, CanaryRun[]>();
  for (const run of runs.values()) {
    const key = JSON.stringify([run.suiteHash, run.model, run.route, run.effort, run.family]);
    const rows = groups.get(key) ?? []; rows.push(run); groups.set(key, rows);
  }
  return { version: "model-canary-metrics-v1" as const, private: true as const, uniqueRuns: runs.size,
    groups: [...groups.values()].map(rows => {
      const attempts = rows.flatMap(r => r.attempts);
      const observed = rows.filter(r => r.verified !== null).length;
      const correct = rows.filter(r => r.verified === true).length;
      const durations = rows.filter(r => r.verified === true && r.totalDurationMs !== null).map(r => r.totalDurationMs!);
      const first = attempts.flatMap(a => a.firstTextMs === null ? [] : [a.firstTextMs]);
      const cost = (mode: CanaryBilling) => {
        const calls = attempts.filter(a => a.billing === mode), known = calls.filter(a => a.usageRatedUsd !== null);
        const measured = known.reduce((sum, a) => sum + a.usageRatedUsd!, 0);
        return { attempts: calls.length, known: known.length, observedLowerBoundUsd: calls.length ? measured : null,
          totalUsd: calls.length && known.length === calls.length ? measured : null,
          perCorrectTaskUsd: calls.length && known.length === calls.length && observed === rows.length && correct > 0 ? measured / correct : null };
      };
      const row = rows[0]!;
      return { suiteHash: row.suiteHash, model: row.model, route: row.route, effort: row.effort, family: row.family,
        tasks: rows.length, distinctCases: new Set(rows.map(r => r.caseId)).size, attempts: attempts.length,
        trialBlocks: new Set(rows.flatMap(r => r.trial ? [r.trial.blockId] : [])).size,
        unpairedRuns: rows.filter(r => !r.trial).length,
        unresolved: rows.length - observed, correct, observed, passRate: observed ? correct / observed : null,
        passInterval: canaryPassInterval(correct, observed), intervalBasis: "descriptive-run-not-independent-case" as const,
        durationObserved: durations.length, completionP50Ms: quantile(durations, .5),
        completionP95Ms: durations.length >= 20 ? quantile(durations, .95) : null,
        firstTextObserved: first.length, firstTextP50Ms: quantile(first, .5),
        servedIdentityKnown: attempts.filter(a => a.servedModel !== null).length,
        servedMismatch: attempts.filter(a => a.servedModel !== null && a.servedModel !== row.model).length,
        identityComparable: attempts.length > 0 && attempts.every(a => a.servedModel === row.model),
        failedAttempts: attempts.filter(a => a.terminal !== "complete").length,
        apiEstimate: cost("api"), subscriptionNotional: cost("subscription"), invoiceUsd: null,
        executionEvidence: executionProjection(attempts, executionByAttempt), codingCohort: codingCohortProjection(rows) };
    }) };
}
