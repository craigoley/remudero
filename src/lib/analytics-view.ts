/**
 * `GET /v1/views/analytics` — every instance's analytics merged in core, one read (W1-T5055, arch Phase 4
 * P4-T16, design D10). The console read core's `/v1/analytics` once per instance for console-v1 and again for
 * signals, then merged the metrics itself (`aggregateOverview`).
 *
 * Analytics is NOT re-derived from facts. The slow lane runs the existing refresh per instance, off serve's
 * event loop, and commits its output as `source_snapshot` rows (read-model-db.ts): `console-v1`, `signals` and
 * `usage-v1`, each with the refresh's own as-of. This view merges every instance's `console-v1` row, so after a
 * restart it answers from the rows before any refresh runs. A failed refresh keeps the last committed row and
 * marks its source stale with the failure, never a fresh zero.
 *
 * THE MERGE never averages: a sum is summed, `cache.reuse` is the ratio of the summed token terms, and
 * `duration.p50.ms` is the nearest-rank median of every instance's runs together. An instance with no snapshot
 * yet is left out, named in `coverage.missing`, and its source reads unavailable, so a partial overview is
 * never presented as the whole fleet's.
 *
 * {@link analyticsLegacyView} is the same merge over serve's in-process analytics caches: the shadow
 * comparator's legacy side, so the read-model body earns readiness against what serve computes today.
 */
import {
  ANALYTICS_REFRESH_INTERVAL_MS,
  ANALYTICS_REFRESH_TIMEOUT_MS,
  CONSOLE_SIGNALS_PROJECTION_VERSION,
  CONSOLE_V1_METRIC_KEYS,
  notCollectedCashSpend,
  type AnalyticsSnapshot,
  type ConsoleV1Metric,
  type ConsoleV1MetricKey,
  type ConsoleV1Projection,
} from "./analytics-route.js";
import { systemClock, type Clock } from "./clock.js";
import { cacheHitRatio, type CacheHitTokens } from "./digest.js";
import { readSourceSnapshotBody, sourceSnapshotStates, type ReadModelDb } from "./read-model-db.js";
import type { ViewDefinition, ViewSource } from "./views.js";

export const ANALYTICS_VIEW_NAME = "analytics";
export const ANALYTICS_VIEW_VERSION = 1;

/** The source snapshots one analytics refresh commits per instance. */
export const ANALYTICS_SOURCE_CONSOLE_V1 = "console-v1";
export const ANALYTICS_SOURCE_SIGNALS = "signals";
export const ANALYTICS_SOURCE_USAGE = "usage-v1";
export const ANALYTICS_SOURCE_NAMES: readonly string[] = [ANALYTICS_SOURCE_CONSOLE_V1, ANALYTICS_SOURCE_SIGNALS, ANALYTICS_SOURCE_USAGE];

/** A snapshot older than two refresh cycles plus a timed-out scan has missed a refresh (the nav badge's bound). */
export const ANALYTICS_STALE_AFTER_MS = 2 * ANALYTICS_REFRESH_INTERVAL_MS + ANALYTICS_REFRESH_TIMEOUT_MS;

/** What one instance's `console-v1` row holds: the projection, and the terms a cross-instance merge needs. */
export interface AnalyticsConsoleSource {
  projection: ConsoleV1Projection;
  /** `cache.reuse`'s token terms; absent from a snapshot restored from a checkpoint written before they were carried. */
  cacheReuseTokens?: CacheHitTokens;
  /** Every resolved run's wall-clock, so the merged p50 is the union's. */
  taskDurationsMs: number[];
}

/** The `console-v1` row of one snapshot. */
export function analyticsConsoleSource(snapshot: AnalyticsSnapshot): AnalyticsConsoleSource {
  return {
    projection: snapshot.consoleV1,
    ...(snapshot.cacheReuseTokens ? { cacheReuseTokens: { ...snapshot.cacheReuseTokens } } : {}),
    taskDurationsMs: snapshot.taskDurationsMs.map((entry) => entry.durationMs),
  };
}

/**
 * Every source snapshot one completed refresh commits. `signals` is the ledger-derived half of the
 * console-signals projection: the live queue and provider readings are serve's, so they are left out rather
 * than written as zeros. `usage-v1` is the usage projection as the refresh built it, or null when it built none.
 */
export function analyticsSourceBodies(snapshot: AnalyticsSnapshot): Array<{ name: string; body: unknown }> {
  return [
    { name: ANALYTICS_SOURCE_CONSOLE_V1, body: analyticsConsoleSource(snapshot) },
    { name: ANALYTICS_SOURCE_SIGNALS, body: {
      version: CONSOLE_SIGNALS_PROJECTION_VERSION,
      timeSeries: snapshot.timeSeries,
      spend: snapshot.spend ?? { cash: notCollectedCashSpend("snapshot predates cash collection; awaiting first refresh") },
      routingTelemetry: snapshot.routingTelemetry,
    } },
    { name: ANALYTICS_SOURCE_USAGE, body: snapshot.usage ?? null },
  ];
}

/** One merged console-v1 metric; `instances` is how many instances had a value for it. */
export interface AnalyticsMergedMetric extends ConsoleV1Metric {
  instances: number;
}

export interface AnalyticsViewData {
  /** Every counted instance's console-v1 metrics merged, in catalog order. */
  overview: AnalyticsMergedMetric[];
  /** How many instances the overview counts, of how many serve projects, and which have no snapshot yet. */
  coverage: { counted: number; of: number; missing: string[] };
  /** Each instance's own metrics; `reason` instead when it has no snapshot yet. */
  instances: Array<{ instanceId: string; metrics?: ConsoleV1Metric[]; reason?: string }>;
}

/** One instance's input to the merge: its last committed snapshot, and a refresh failure newer than it. */
export interface AnalyticsInstanceInput {
  instanceId: string;
  snapshot?: { asOf: string; console: AnalyticsConsoleSource };
  failure?: { error: string; atMs: number };
}

const METRIC_CLASS: Record<ConsoleV1MetricKey, ConsoleV1Metric["class"]> = {
  "runs.completed": "observed",
  "tokens.total": "provider_reported",
  "cache.reuse": "modeled",
  "cost.modeled.usd": "modeled",
  "duration.p50.ms": "observed",
  "queue.pending": "observed",
};

const NO_SNAPSHOT = "no instance has completed an analytics refresh yet";

/** Nearest-rank p50, as buildConsoleV1Metrics computes one instance's. */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function notCollected(key: ConsoleV1MetricKey, reason: string): AnalyticsMergedMetric {
  return { key, class: METRIC_CLASS[key], value: null, notCollectedReason: reason, instances: 0 };
}

function mergeMetric(key: ConsoleV1MetricKey, counted: readonly AnalyticsConsoleSource[]): AnalyticsMergedMetric {
  const own = counted.map((source) => source.projection.metrics.find((metric) => metric.key === key));
  const valued = own.filter((metric): metric is ConsoleV1Metric & { value: number } => metric?.value !== null && metric?.value !== undefined);
  const reason = own.find((metric) => metric?.notCollectedReason)?.notCollectedReason ?? NO_SNAPSHOT;
  if (key === "cache.reuse") {
    if (counted.some((source) => source.cacheReuseTokens === undefined)) {
      // A lone instance's own ratio is exact; across instances, one without its terms cannot be weighed.
      if (counted.length === 1 && own[0]) return { ...own[0], instances: valued.length };
      return notCollected(key, "an instance's snapshot carries no cache token terms; awaiting its next refresh");
    }
    const terms = counted.reduce((sum, source) => ({
      input: sum.input + source.cacheReuseTokens!.input,
      cacheRead: sum.cacheRead + source.cacheReuseTokens!.cacheRead,
      cacheCreation: sum.cacheCreation + source.cacheReuseTokens!.cacheCreation,
    }), { input: 0, cacheRead: 0, cacheCreation: 0 });
    const ratio = cacheHitRatio(terms);
    return ratio === undefined ? notCollected(key, reason) : { key, class: METRIC_CLASS[key], value: ratio, instances: valued.length };
  }
  if (key === "duration.p50.ms") {
    const p50 = median(counted.flatMap((source) => source.taskDurationsMs));
    return p50 === undefined ? notCollected(key, reason) : { key, class: METRIC_CLASS[key], value: p50, instances: valued.length };
  }
  if (valued.length === 0) return notCollected(key, reason);
  return { key, class: METRIC_CLASS[key], value: valued.reduce((sum, metric) => sum + metric.value, 0), instances: valued.length };
}

/** `analytics:<instance>`: unavailable before a first refresh, stale after a failed one or past its bound. */
export function analyticsSource(input: AnalyticsInstanceInput, nowMs: number): ViewSource {
  const base = { name: `analytics:${input.instanceId}`, kind: "analytics" as const, instance: input.instanceId, budgetMs: ANALYTICS_STALE_AFTER_MS };
  if (!input.snapshot) {
    return input.failure
      ? { ...base, asOf: null, state: "unavailable", phase: "failed", reason: `the analytics refresh failed: ${input.failure.error}` }
      : { ...base, asOf: null, state: "unavailable", phase: "warming", reason: "no analytics refresh has completed yet" };
  }
  const asOf = input.snapshot.asOf;
  const asOfMs = Date.parse(asOf);
  const lagMs = Math.max(0, nowMs - asOfMs);
  if (input.failure && input.failure.atMs >= asOfMs) {
    return { ...base, asOf, state: "stale", phase: "failed", lagMs, reason: `the last analytics refresh failed (${input.failure.error}); this is the snapshot it kept` };
  }
  if (lagMs > ANALYTICS_STALE_AFTER_MS) return { ...base, asOf, state: "stale", phase: "behind", lagMs, reason: `analytics ${Math.round(lagMs / 60_000)} min old` };
  return { ...base, asOf, state: "fresh", lagMs };
}

/** The view's body over every instance's input: the overview merged from those with a snapshot. */
export function mergeAnalytics(inputs: readonly AnalyticsInstanceInput[], nowMs: number): { data: AnalyticsViewData; sources: ViewSource[] } {
  const counted = inputs.flatMap((input) => (input.snapshot ? [input.snapshot.console] : []));
  return {
    data: {
      overview: CONSOLE_V1_METRIC_KEYS.map((key) => mergeMetric(key, counted)),
      coverage: { counted: counted.length, of: inputs.length, missing: inputs.filter((input) => !input.snapshot).map((input) => input.instanceId) },
      instances: inputs.map((input) => (input.snapshot
        ? { instanceId: input.instanceId, metrics: input.snapshot.console.projection.metrics }
        : { instanceId: input.instanceId, reason: input.failure ? `the analytics refresh failed: ${input.failure.error}` : "no analytics refresh has completed yet" })),
    },
    sources: inputs.map((input) => analyticsSource(input, nowMs)),
  };
}

/** Per data path, the source the shadow pairs it with: each instance's entry with its own, the merged parts with the first's. */
function pairedSources(instanceIds: readonly string[]): Record<string, string> {
  const first = instanceIds[0];
  return {
    ...(first === undefined ? {} : { overview: `analytics:${first}`, coverage: `analytics:${first}` }),
    ...Object.fromEntries(instanceIds.map((id) => [`instances[instanceId=${id}]`, `analytics:${id}`])),
  };
}

/** One instance serve's analytics cache covers. */
export interface AnalyticsScope {
  instanceId: string;
  analytics: () => AnalyticsSnapshot;
}

/** The merge over serve's own analytics caches: the shadow's legacy side, and the answer while the view is off. */
export function analyticsLegacyView(opts: { scopes: () => readonly AnalyticsScope[]; clock?: Clock }): ViewDefinition<AnalyticsViewData> {
  return {
    name: ANALYTICS_VIEW_NAME,
    version: ANALYTICS_VIEW_VERSION,
    get shadowSources() {
      return pairedSources(opts.scopes().map((scope) => scope.instanceId));
    },
    compute: () => mergeAnalytics(opts.scopes().map((scope) => {
      const snapshot = scope.analytics();
      return snapshot.asOf === null
        ? { instanceId: scope.instanceId }
        : { instanceId: scope.instanceId, snapshot: { asOf: snapshot.asOf, console: analyticsConsoleSource(snapshot) } };
    }), (opts.clock ?? systemClock).now()),
  };
}

/**
 * `analytics` materialized by the read-model worker from the home store's `source_snapshot` rows, one body for
 * every instance the worker projects. A row's body is parsed again only when its as-of moved.
 */
export function createAnalyticsView(): {
  name: string;
  version: number;
  snapshotSourced: true;
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: { instance: string }; db?: ReadModelDb }> }): Array<{ key: string; data: AnalyticsViewData; sources: ViewSource[] }>;
} {
  const parsed = new WeakMap<ReadModelDb, Map<string, { asOf: string; console: AnalyticsConsoleSource }>>();
  return {
    name: ANALYTICS_VIEW_NAME,
    version: ANALYTICS_VIEW_VERSION,
    snapshotSourced: true,
    materialize: ({ now, instances }) => {
      const db = instances[0]?.db;
      if (db === undefined) return [];
      const states = sourceSnapshotStates(db, ANALYTICS_SOURCE_CONSOLE_V1);
      let held = parsed.get(db);
      if (!held) parsed.set(db, (held = new Map()));
      const inputs = instances.map(({ state }): AnalyticsInstanceInput => {
        const row = states.find((candidate) => candidate.instance === state.instance);
        if (row?.asOf && held.get(state.instance)?.asOf !== row.asOf) {
          held.set(state.instance, { asOf: row.asOf, console: readSourceSnapshotBody(db, state.instance, ANALYTICS_SOURCE_CONSOLE_V1) as AnalyticsConsoleSource });
        }
        const snapshot = row?.asOf ? held.get(state.instance) : undefined;
        return {
          instanceId: state.instance,
          ...(snapshot ? { snapshot } : {}),
          ...(row?.error ? { failure: { error: row.error, atMs: Number(row.errorMs) } } : {}),
        };
      });
      return [{ key: "", ...mergeAnalytics(inputs, now) }];
    },
  };
}
