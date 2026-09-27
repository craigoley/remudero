/**
 * W1-T4623 — A MODEL CHANGE IS NOTICED. Providers swap the model behind a name (Luna/Sol 5.6 -> 6,
 * Opus 5 -> 5.5) and nothing recorded when. From the benchmark cohort's joined assignments this
 * derives two read-only records:
 *   1. an exposure timeline: first/last seen per requested and per served model, per fleet (the
 *      ledger row's writer `host`, the only fleet identity a row carries) and harness revision;
 *   2. a drift observation per selected model x task class x metric. The time-ordered stream is cut
 *      into consecutive blocks of DRIFT_BLOCK_SIZE values and the newest complete block is compared
 *      with the one before it, so each block pair is judged once in its lifetime and a series holds
 *      at most three blocks. Verified completion uses Newcombe's hybrid Wilson interval for a
 *      difference of proportions; cost uses a Welch normal interval for a difference of means.
 * Verified completion counts only an OBSERVED resolution from W1-T4608's join: a verified merge is
 * 1, a closed-unmerged PR is 0 (a non-completion, not a model-failure verdict); censored and
 * unavailable joins are excluded with their reasons. DESCRIPTIVE ONLY: an observation says two
 * windows differ, never why, and nothing here is a routing input. A thin sample reads
 * `insufficient`, never a zero rate; cash (api) and subscription-notional cost are separate metrics
 * and are never summed.
 */
export const MODEL_DRIFT_VERSION = "model-drift-v1" as const;

/** PRIMARY CONTROL: values per tumbling block. Two complete blocks are the least evidence a series
 *  is judged on; below that it reads `insufficient`. At 30 a Wilson interval around p=0.5 spans about
 *  +/-0.2 per block, so only a large shift is called — the intended sensitivity for a model swap. */
export const DRIFT_BLOCK_SIZE = 30;
/** PRIMARY CONTROL: family-wise false-alarm rate of one derivation, split evenly (Bonferroni) over
 *  every block pair judged in it, so adding models or task classes cannot inflate the alarm rate. */
export const DRIFT_FAMILY_ALPHA = 0.01;
/** BACKSTOP: series kept in the snapshot, drift first so a cut never hides an alarm. The overflow is
 *  counted, and a dropped series still counted toward the Bonferroni family. */
export const MAX_DRIFT_SERIES = 256;
/** BACKSTOP: timeline entries kept in the snapshot, newest `lastSeen` first; the overflow is counted. */
export const MAX_TIMELINE_ENTRIES = 512;

/** Acklam's rational approximation (relative error < 1.2e-9) of the upper normal quantile, valid
 *  for a tail probability below 0.02425 — the only region a split of DRIFT_FAMILY_ALPHA reaches. */
export function upperNormalQuantile(tail: number): number {
  if (!(tail > 0 && tail < 0.02425)) throw new RangeError("tail probability outside the approximated region");
  const q = Math.sqrt(-2 * Math.log(tail));
  const numerator = ((((-7.784894002430293e-3 * q - 3.223964580411365e-1) * q - 2.400758277161838) * q
    - 2.549732539343734) * q + 4.374664141464968) * q + 2.938163982698783;
  const denominator = (((7.784695709041462e-3 * q + 3.224671290700398e-1) * q + 2.445134137142996) * q
    + 3.754408661907416) * q + 1;
  return -numerator / denominator;
}

export interface ModelExposure {
  at: string | null;
  fleet: string | null;
  harnessRevision: string | null;
  taskClass: string | null;
  requestedModel: string | null;
  selectedModel: string | null;
  servedModel: string | null;
  servedAt: string | null;
  verified: { state: "resolved"; completed: boolean } | { state: "unavailable"; reason: string };
  cost: { state: "observed"; billingMode: "api" | "subscription"; usd: number } | { state: "unavailable"; reason: string };
}

export type DriftMetric = "verified-completion" | "api-cost-usd" | "subscription-notional-cost-usd";

export function wilsonInterval(successes: number, n: number, z: number): { lower: number; upper: number } {
  const p = successes / n;
  const z2 = z * z;
  const scale = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / scale;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / scale;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

type Point = { at: string; value: number; served: string | null };
type Stream = { key: string; selectedModel: string; taskClass: string | null; metric: DriftMetric;
  reference: Point[] | null; recent: Point[] | null; partial: Point[]; observed: number;
  excluded: Record<string, number> };

export interface DriftBlock {
  from: string;
  to: string;
  n: number;
  estimate: number;
  servedModels: string[];
  servedUnrecorded: number;
}

function summarize(block: Point[]): DriftBlock {
  const served = new Set(block.flatMap((point) => point.served === null ? [] : [point.served]));
  return { from: block[0]!.at, to: block.at(-1)!.at, n: block.length,
    estimate: block.reduce((sum, point) => sum + point.value, 0) / block.length,
    servedModels: [...served].sort(), servedUnrecorded: block.filter((point) => point.served === null).length };
}

export interface DriftObservation {
  selectedModel: string;
  taskClass: string | null;
  metric: DriftMetric;
  state: "drift" | "no-drift" | "insufficient";
  reason: string | null;
  observed: number;
  excluded: Record<string, number>;
  window: { reference: DriftBlock; recent: DriftBlock } | null;
  difference: { estimate: number; lower: number; upper: number; confidence: number } | null;
}

function difference(stream: Stream, reference: Point[], recent: Point[], z: number): { lower: number; upper: number } {
  const before = summarize(reference);
  const after = summarize(recent);
  const estimate = after.estimate - before.estimate;
  if (stream.metric === "verified-completion") {
    const a = wilsonInterval(before.estimate * before.n, before.n, z);
    const b = wilsonInterval(after.estimate * after.n, after.n, z);
    return { lower: estimate - Math.hypot(after.estimate - b.lower, a.upper - before.estimate),
      upper: estimate + Math.hypot(b.upper - after.estimate, before.estimate - a.lower) };
  }
  const variance = (block: Point[], mean: number): number =>
    block.reduce((sum, point) => sum + (point.value - mean) ** 2, 0) / (block.length - 1);
  const se = Math.sqrt(variance(reference, before.estimate) / before.n + variance(recent, after.estimate) / after.n);
  return { lower: estimate - z * se, upper: estimate + z * se };
}

export interface ModelDriftReport {
  version: typeof MODEL_DRIFT_VERSION;
  state: "observed" | "unavailable";
  reason: string | null;
  asOf: string | null;
  claim: "descriptive-not-causal";
  routingInput: "never";
  method: { detector: "tumbling-two-block-comparison"; blockSize: number; familyAlpha: number;
    testsInFamily: number; z: number | null; completionInterval: "newcombe-hybrid-wilson";
    costInterval: "welch-normal" };
  timeline: { kind: "requested" | "served"; model: string; fleet: string | null; harnessRevision: string | null;
    firstSeen: string; lastSeen: string; exposures: number }[];
  timelineTruncated: number;
  series: DriftObservation[];
  seriesTruncated: number;
  coverage: { rows: number; unorderedRows: number; unattributedRows: number;
    requestedUnrecorded: number; servedUnrecorded: number };
}

export function unavailableModelDrift(reason: string, asOf: string | null = null): ModelDriftReport {
  return { ...deriveModelDrift([], asOf), state: "unavailable", reason };
}

function ordered(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}

/** Pure and read-only: the same exposures always yield the same report, and no field of it feeds a
 *  route. Memory per series is three blocks, however long the stream. */
export function deriveModelDrift(exposures: readonly ModelExposure[], asOf: string | null): ModelDriftReport {
  const coverage = { rows: exposures.length, unorderedRows: 0, unattributedRows: 0,
    requestedUnrecorded: 0, servedUnrecorded: 0 };
  const timeline = new Map<string, ModelDriftReport["timeline"][number]>();
  const expose = (kind: "requested" | "served", model: string, row: ModelExposure, at: string): void => {
    const key = JSON.stringify([kind, model, row.fleet, row.harnessRevision]);
    const entry = timeline.get(key) ?? { kind, model, fleet: row.fleet, harnessRevision: row.harnessRevision,
      firstSeen: at, lastSeen: at, exposures: 0 };
    entry.exposures += 1;
    if (Date.parse(at) < Date.parse(entry.firstSeen)) entry.firstSeen = at;
    if (Date.parse(at) > Date.parse(entry.lastSeen)) entry.lastSeen = at;
    timeline.set(key, entry);
  };
  const streams = new Map<string, Stream>();
  const stream = (row: ModelExposure & { selectedModel: string }, metric: DriftMetric): Stream => {
    const key = JSON.stringify([row.selectedModel, row.taskClass, metric]);
    const found = streams.get(key) ?? { key, selectedModel: row.selectedModel, taskClass: row.taskClass, metric,
      reference: null, recent: null, partial: [], observed: 0, excluded: {} };
    streams.set(key, found);
    return found;
  };
  const exclude = (target: Stream, reason: string): void => { target.excluded[reason] = (target.excluded[reason] ?? 0) + 1; };
  const push = (target: Stream, point: Point): void => {
    target.partial.push(point);
    target.observed += 1;
    if (target.partial.length < DRIFT_BLOCK_SIZE) return;
    target.reference = target.recent;
    target.recent = target.partial;
    target.partial = [];
  };
  const rows = exposures.flatMap((row) => {
    if (!ordered(row.at)) { coverage.unorderedRows += 1; return []; }
    return [{ ...row, at: row.at }];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const row of exposures) {
    if (row.servedModel && ordered(row.servedAt)) expose("served", row.servedModel, row, row.servedAt);
    else coverage.servedUnrecorded += 1;
  }
  for (const row of rows) {
    if (row.requestedModel) expose("requested", row.requestedModel, row, row.at);
    else coverage.requestedUnrecorded += 1;
    const selectedModel = row.selectedModel;
    if (!selectedModel) { coverage.unattributedRows += 1; continue; }
    const attributed = { ...row, selectedModel };
    const completion = stream(attributed, "verified-completion");
    if (row.verified.state === "resolved") {
      push(completion, { at: row.at, value: row.verified.completed ? 1 : 0, served: row.servedModel });
    } else exclude(completion, row.verified.reason);
    const api = stream(attributed, "api-cost-usd");
    const notional = stream(attributed, "subscription-notional-cost-usd");
    if (row.cost.state === "observed") {
      push(row.cost.billingMode === "api" ? api : notional, { at: row.at, value: row.cost.usd, served: row.servedModel });
    } else for (const target of [api, notional]) exclude(target, row.cost.reason);
  }
  const judged = [...streams.values()].filter((entry) => entry.reference !== null);
  const z = judged.length > 0 ? upperNormalQuantile(DRIFT_FAMILY_ALPHA / (2 * judged.length)) : null;
  const series = [...streams.values()].map((entry): DriftObservation => {
    const base = { selectedModel: entry.selectedModel, taskClass: entry.taskClass, metric: entry.metric,
      observed: entry.observed, excluded: entry.excluded };
    if (entry.reference === null || entry.recent === null || z === null) {
      return { ...base, state: "insufficient", reason: "fewer-than-two-complete-blocks", window: null, difference: null };
    }
    const window = { reference: summarize(entry.reference), recent: summarize(entry.recent) };
    const bounds = difference(entry, entry.reference, entry.recent, z);
    const drift = bounds.lower > 0 || bounds.upper < 0;
    return { ...base, state: drift ? "drift" : "no-drift", reason: null, window,
      difference: { estimate: window.recent.estimate - window.reference.estimate, ...bounds,
        confidence: 1 - DRIFT_FAMILY_ALPHA / judged.length } };
  }).sort((a, b) => Number(b.state === "drift") - Number(a.state === "drift")
    || JSON.stringify([a.selectedModel, a.taskClass, a.metric]).localeCompare(JSON.stringify([b.selectedModel, b.taskClass, b.metric])));
  const entries = [...timeline.values()].sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen)
    || JSON.stringify([a.kind, a.model, a.fleet, a.harnessRevision]).localeCompare(JSON.stringify([b.kind, b.model, b.fleet, b.harnessRevision])));
  return {
    version: MODEL_DRIFT_VERSION, state: "observed", reason: null, asOf,
    claim: "descriptive-not-causal", routingInput: "never",
    method: { detector: "tumbling-two-block-comparison", blockSize: DRIFT_BLOCK_SIZE, familyAlpha: DRIFT_FAMILY_ALPHA,
      testsInFamily: judged.length, z, completionInterval: "newcombe-hybrid-wilson", costInterval: "welch-normal" },
    timeline: entries.slice(0, MAX_TIMELINE_ENTRIES),
    timelineTruncated: Math.max(0, entries.length - MAX_TIMELINE_ENTRIES),
    series: series.slice(0, MAX_DRIFT_SERIES),
    seriesTruncated: Math.max(0, series.length - MAX_DRIFT_SERIES),
    coverage,
  };
}
