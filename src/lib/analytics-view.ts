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
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { cacheHitRatio, type CacheHitTokens } from "./digest.js";
import { readSourceSnapshotBody, sourceSnapshotStates, type ReadModelDb } from "./read-model-db.js";
import type { ViewDefinition, ViewSource } from "./views.js";
import { foldGardenerSpend, GARDENER_SPEND_MAX_BYTES, type GardenerSpend, type GardenerSpendSource } from "./gardener-spend.js";

export const ANALYTICS_VIEW_NAME = "analytics";
export const ANALYTICS_VIEW_VERSION = 1;
export const ANALYTICS_DETAILS_VERSION = "analytics-details-v1";
/** BACKSTOP: optional detail payloads stay below the console's existing 2 MiB view-response ceiling. */
export const ANALYTICS_DETAILS_MAX_BYTES = 256 * 1024;
/** BACKSTOP: leave 512 KiB for metric, source and coverage metadata in a multi-repository response. */
export const ANALYTICS_DETAILS_TOTAL_BYTES = 1536 * 1024;

export const HOST_MODEL_APPROVALS_VERSION = "host-model-approvals-v1";
/** BACKSTOP: a malformed loaded configuration cannot expand the cached response without limit. */
export const HOST_MODEL_APPROVALS_MAX_ROWS = 100;
/** BACKSTOP: reserve the rest of the existing Analytics transport budget for repository measurements. */
export const HOST_MODEL_APPROVALS_MAX_BYTES = 64 * 1024;
type ApprovalRecord = { model: string; approvedBy: string; approvedAt: string; expiresAt?: string };
export type HostModelApprovalConfig = { capturedAt: string | null; approvals: unknown; reason?: "invalid_source" | "over_budget" };
export type HostModelApprovalEvidence = {
  version: typeof HOST_MODEL_APPROVALS_VERSION;
  scope: "serving-host";
  sourceKind: "loaded-config";
  capturedAt: string | null;
} & ({ state: "reported"; approvals: ApprovalRecord[] }
  | { state: "unavailable"; reason: "invalid_source" | "over_budget" | "clock_skew" });

function approvalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1 ||
    Number(match[3]) > fixedClock(Date.UTC(Number(match[1]), Number(match[2]), 0)).date().getUTCDate() ||
    Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 || !Number.isFinite(Date.parse(value))) return null;
  return fixedClock(Date.parse(value)).iso();
}

/** Only these loaded configuration fields may cross into the worker. No file read or permission change. */
export function captureHostModelApprovals(input: HostModelApprovalConfig): HostModelApprovalConfig {
  const capturedAt = approvalTimestamp(input.capturedAt);
  const refused = (reason: "invalid_source" | "over_budget"): HostModelApprovalConfig => ({ capturedAt, approvals: null, reason });
  if (input.reason === "over_budget" || input.reason === "invalid_source") return refused(input.reason);
  if (!capturedAt || !Array.isArray(input.approvals)) return refused("invalid_source");
  if (input.approvals.length > HOST_MODEL_APPROVALS_MAX_ROWS) return refused("over_budget");
  const approvals: ApprovalRecord[] = [];
  const identities = new Set<string>();
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
  try {
    for (const value of input.approvals) {
      if (!object(value) || !text(value.model) || !text(value.approvedBy)) return refused("invalid_source");
      const approvedAt = approvalTimestamp(value.approvedAt);
      const expiresAt = value.expiresAt === undefined ? undefined : approvalTimestamp(value.expiresAt);
      if (!approvedAt || Date.parse(approvedAt) > Date.parse(capturedAt) || expiresAt === null) return refused("invalid_source");
      const record = { model: value.model.trim(), approvedBy: value.approvedBy.trim(), approvedAt, ...(expiresAt ? { expiresAt } : {}) };
      const identity = JSON.stringify([record.model.toLowerCase(), record.approvedBy, approvedAt]);
      if (identities.has(identity)) return refused("invalid_source");
      identities.add(identity);
      approvals.push(record);
    }
    return Buffer.byteLength(JSON.stringify({ version: HOST_MODEL_APPROVALS_VERSION, scope: "serving-host",
      sourceKind: "loaded-config", capturedAt, state: "reported", approvals })) > HOST_MODEL_APPROVALS_MAX_BYTES
      ? refused("over_budget") : { capturedAt, approvals };
  } catch {
    const reason = "invalid_source" as const;
    return refused(reason);
  }
}

function hostModelApprovalEvidence(input: HostModelApprovalConfig, now: number): HostModelApprovalEvidence {
  const captured = captureHostModelApprovals(input);
  const base = { version: HOST_MODEL_APPROVALS_VERSION, scope: "serving-host" as const, sourceKind: "loaded-config" as const,
    capturedAt: captured.capturedAt } as const;
  if (captured.reason) return { ...base, state: "unavailable", reason: captured.reason };
  if (!Number.isFinite(now) || Date.parse(captured.capturedAt!) > now) return { ...base, state: "unavailable", reason: "clock_skew" };
  return { ...base, state: "reported", approvals: captured.approvals as ApprovalRecord[] };
}

function withHostModelApprovals(result: { data: AnalyticsViewData; sources: ViewSource[] }, input: HostModelApprovalConfig | undefined, now: number) {
  return input === undefined ? result : { ...result, data: { ...result.data, modelApprovals: hostModelApprovalEvidence(input, now) } };
}

/** Transported projections are opaque: consumers still validate their complete metric schemas. */
type AnalyticsStoredSignals = { version: typeof CONSOLE_SIGNALS_PROJECTION_VERSION; timeSeries: unknown[]; spend: Record<string, unknown>; routingTelemetry: Record<string, unknown> };
export type AnalyticsDetails =
  | { version: typeof ANALYTICS_DETAILS_VERSION; state: "reported"; asOf: string; payloadBytes: number; signals: AnalyticsStoredSignals; usage: Record<string, unknown> | null }
  | { version: typeof ANALYTICS_DETAILS_VERSION; state: "unavailable"; asOf: string | null; reason: string };

function unavailableDetails(asOf: string | null, reason: string): AnalyticsDetails {
  return { version: ANALYTICS_DETAILS_VERSION, state: "unavailable", asOf, reason };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Server-owned identity only; never infer a repository from an instance name or historical ledger row. */
function repositoryName(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 240 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : undefined;
}

/** Whitelist the public projections, not the raw snapshot (which also holds private agent memory). */
export function analyticsDetails(asOf: string, signals: unknown, usage: unknown): AnalyticsDetails {
  if (!object(signals) || signals.version !== CONSOLE_SIGNALS_PROJECTION_VERSION || !Array.isArray(signals.timeSeries) || !object(signals.spend) || !object(signals.routingTelemetry)) {
    return unavailableDetails(asOf, "stored analytics signals are missing or unsupported");
  }
  if (usage !== null && (!object(usage) || (usage.version !== "usage-v1" && usage.version !== "usage-v2") || usage.asOf !== asOf || !object(usage.coverage) || !Array.isArray(usage.subscriptions) || !object(usage.cash) || !object(usage.routing))) {
    return unavailableDetails(asOf, "stored analytics usage is missing, unsupported or from another snapshot");
  }
  const publicSignals: AnalyticsStoredSignals = { version: CONSOLE_SIGNALS_PROJECTION_VERSION, timeSeries: signals.timeSeries, spend: signals.spend, routingTelemetry: signals.routingTelemetry };
  const publicUsage = usage === null ? null : { version: usage.version, asOf: usage.asOf, coverage: usage.coverage, subscriptions: usage.subscriptions, cash: usage.cash, routing: usage.routing };
  const payloadBytes = Buffer.byteLength(JSON.stringify({ signals: publicSignals, usage: publicUsage }));
  return payloadBytes > ANALYTICS_DETAILS_MAX_BYTES
    ? unavailableDetails(asOf, "analytics details exceed the per-instance response budget")
    : { version: ANALYTICS_DETAILS_VERSION, state: "reported", asOf, payloadBytes, signals: publicSignals, usage: publicUsage };
}

/** The source snapshots one analytics refresh commits per instance. */
export const ANALYTICS_SOURCE_CONSOLE_V1 = "console-v1";
export const ANALYTICS_SOURCE_SIGNALS = "signals";
export const ANALYTICS_SOURCE_USAGE = "usage-v1";
export const ANALYTICS_SOURCE_NAMES: readonly string[] = [ANALYTICS_SOURCE_CONSOLE_V1, ANALYTICS_SOURCE_SIGNALS, ANALYTICS_SOURCE_USAGE];

/** A snapshot older than two refresh cycles plus a timed-out scan has missed a refresh (the nav badge's bound). */
export const ANALYTICS_STALE_AFTER_MS = 2 * ANALYTICS_REFRESH_INTERVAL_MS + ANALYTICS_REFRESH_TIMEOUT_MS;

/** What one instance's `console-v1` row holds: the projection, and the terms a cross-instance merge needs. */
export interface AnalyticsConsoleSource {
  gardenerSpendSource?: GardenerSpendSource;
  projection: ConsoleV1Projection;
  /** Registry/config-owned identity captured with this snapshot; older rows carry none. */
  repository?: string;
  /** `cache.reuse`'s token terms; absent from a snapshot restored from a checkpoint written before they were carried. */
  cacheReuseTokens?: CacheHitTokens;
  /** Every resolved run's wall-clock, so the merged p50 is the union's. */
  taskDurationsMs: number[];
}

/** The `console-v1` row of one snapshot. */
export function analyticsConsoleSource(snapshot: AnalyticsSnapshot, repository?: string): AnalyticsConsoleSource {
  return {
    projection: snapshot.consoleV1,
    ...(repositoryName(repository) ? { repository: repositoryName(repository) } : {}),
    ...(snapshot.cacheReuseTokens ? { cacheReuseTokens: { ...snapshot.cacheReuseTokens } } : {}),
    taskDurationsMs: snapshot.taskDurationsMs.map((entry) => entry.durationMs),
  };
}

/**
 * Every source snapshot one completed refresh commits. `signals` is the ledger-derived half of the
 * console-signals projection: the live queue and provider readings are serve's, so they are left out rather
 * than written as zeros. `usage-v1` is the usage projection as the refresh built it, or null when it built none.
 */
export function analyticsSourceBodies(snapshot: AnalyticsSnapshot, repository?: string): Array<{ name: string; body: unknown }> {
  return [
    { name: ANALYTICS_SOURCE_CONSOLE_V1, body: analyticsConsoleSource(snapshot, repository) },
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
  /** Loaded serving-host configuration, not per-repository authority or proof of worker adoption. */
  modelApprovals?: HostModelApprovalEvidence;
  /** Every counted instance's console-v1 metrics merged, in catalog order. */
  overview: AnalyticsMergedMetric[];
  /** How many instances the overview counts, of how many serve projects, and which have no snapshot yet. */
  coverage: { counted: number; of: number; missing: string[] };
  /** Each instance's own metrics; `reason` instead when it has no snapshot yet. */
  instances: Array<{ instanceId: string; repository?: string; gardenerSpend?: GardenerSpend; metrics?: ConsoleV1Metric[]; details?: AnalyticsDetails; reason?: string }>;
}

/** One instance's input to the merge: its last committed snapshot, and a refresh failure newer than it. */
export interface AnalyticsInstanceInput {
  instanceId: string;
  snapshot?: { asOf: string; console: AnalyticsConsoleSource; details?: AnalyticsDetails };
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
  let remainingBytes = ANALYTICS_DETAILS_TOTAL_BYTES;
  return {
    data: {
      overview: CONSOLE_V1_METRIC_KEYS.map((key) => mergeMetric(key, counted)),
      coverage: { counted: counted.length, of: inputs.length, missing: inputs.filter((input) => !input.snapshot).map((input) => input.instanceId) },
      instances: inputs.map((input) => {
        if (!input.snapshot) return { instanceId: input.instanceId, reason: input.failure ? `the analytics refresh failed: ${input.failure.error}` : "no analytics refresh has completed yet" };
        let details = input.snapshot.details;
        if (details?.state === "reported") {
          if (details.payloadBytes > remainingBytes) details = unavailableDetails(details.asOf, "analytics details exceed the fleet response budget");
          else remainingBytes -= details.payloadBytes;
        }
        const repository = repositoryName(input.snapshot.console.repository);
        return { instanceId: input.instanceId, ...(repository ? { repository } : {}), metrics: input.snapshot.console.projection.metrics, ...(details ? { details } : {}) };
      }),
    },
    sources: inputs.map((input) => analyticsSource(input, nowMs)),
  };
}

/**
 * Per data path, the sources the shadow pairs it with: each instance's entry with its own, the merged parts with
 * EVERY instance's, since one instance's later refresh moves the overview and the coverage as much as its entry.
 */
function pairedSources(instanceIds: readonly string[]): Record<string, string | string[]> {
  const all = instanceIds.map((id) => `analytics:${id}`);
  return {
    ...(all.length === 0 ? {} : { overview: all, coverage: all }),
    ...Object.fromEntries(instanceIds.map((id) => [`instances[instanceId=${id}]`, `analytics:${id}`])),
  };
}

/** One instance serve's analytics cache covers. */
export interface AnalyticsScope {
  instanceId: string;
  repository?: string;
  analytics: () => AnalyticsSnapshot;
}

/** The merge over serve's own analytics caches: the shadow's legacy side, and the answer while the view is off. */
export function analyticsLegacyView(opts: { scopes: () => readonly AnalyticsScope[]; clock?: Clock; modelApprovalConfig?: HostModelApprovalConfig }): ViewDefinition<AnalyticsViewData> {
  return {
    name: ANALYTICS_VIEW_NAME,
    version: ANALYTICS_VIEW_VERSION,
    get shadowSources() {
      return pairedSources(opts.scopes().map((scope) => scope.instanceId));
    },
    compute: () => {
      const now = (opts.clock ?? systemClock).now();
      return withHostModelApprovals(mergeAnalytics(opts.scopes().map((scope) => {
      const snapshot = scope.analytics();
      const bodies = analyticsSourceBodies(snapshot, scope.repository);
      return snapshot.asOf === null
        ? { instanceId: scope.instanceId }
        : { instanceId: scope.instanceId, snapshot: { asOf: snapshot.asOf, console: bodies[0]!.body as AnalyticsConsoleSource, details: analyticsDetails(snapshot.asOf, bodies[1]!.body, bodies[2]!.body) } };
      }), now), opts.modelApprovalConfig, now);
    },
  };
}

/**
 * `analytics` materialized by the read-model worker from the home store's `source_snapshot` rows, one body for
 * every instance the worker projects. A row's body is parsed again only when its as-of moved.
 */
export function createAnalyticsView(opts: { modelApprovalConfig?: HostModelApprovalConfig } = {}): {
  name: string;
  version: number;
  snapshotSourced: true;
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: { instance: string }; db?: ReadModelDb }> }): Array<{ key: string; data: AnalyticsViewData; sources: ViewSource[] }>;
} {
  const parsed = new WeakMap<ReadModelDb, Map<string, { asOf: string; console: AnalyticsConsoleSource; detailsKey?: string; details?: AnalyticsDetails }>>();
  return {
    name: ANALYTICS_VIEW_NAME,
    version: ANALYTICS_VIEW_VERSION,
    snapshotSourced: true,
    materialize: ({ now, instances }) => {
      const db = instances[0]?.db;
      if (db === undefined) return [];
      const states = sourceSnapshotStates(db, ANALYTICS_SOURCE_CONSOLE_V1);
      const signalStates = sourceSnapshotStates(db, ANALYTICS_SOURCE_SIGNALS);
      const usageStates = sourceSnapshotStates(db, ANALYTICS_SOURCE_USAGE);
      let held = parsed.get(db);
      if (!held) parsed.set(db, (held = new Map()));
      const inputs = instances.map(({ state }): AnalyticsInstanceInput => {
        const row = states.find((candidate) => candidate.instance === state.instance);
        if (row?.asOf && held.get(state.instance)?.asOf !== row.asOf) {
          held.set(state.instance, { asOf: row.asOf, console: readSourceSnapshotBody(db, state.instance, ANALYTICS_SOURCE_CONSOLE_V1) as AnalyticsConsoleSource });
        }
        const snapshot = row?.asOf ? held.get(state.instance) : undefined;
        const signals = signalStates.find((candidate) => candidate.instance === state.instance);
        const usage = usageStates.find((candidate) => candidate.instance === state.instance);
        const detailsKey = JSON.stringify([row?.asOf, signals?.asOf, usage?.asOf]);
        if (snapshot && snapshot.detailsKey !== detailsKey) {
          snapshot.detailsKey = detailsKey;
          if (signals?.asOf !== snapshot.asOf || usage?.asOf !== snapshot.asOf) {
            snapshot.details = unavailableDetails(snapshot.asOf, "analytics detail sources are missing or from another snapshot");
          } else {
            try {
              snapshot.details = analyticsDetails(snapshot.asOf, readSourceSnapshotBody(db, state.instance, ANALYTICS_SOURCE_SIGNALS), readSourceSnapshotBody(db, state.instance, ANALYTICS_SOURCE_USAGE));
            } catch {
              snapshot.details = { version: ANALYTICS_DETAILS_VERSION, state: "unavailable", asOf: snapshot.asOf, reason: "stored analytics details could not be read" };
            }
          }
        }
        const errors = [row, signals, usage].filter((candidate) => candidate?.error !== null && candidate?.error !== undefined);
        const failed = errors.sort((a, b) => Number(b!.errorMs) - Number(a!.errorMs))[0];
        return {
          instanceId: state.instance,
          ...(snapshot ? { snapshot } : {}),
          ...(failed?.error ? { failure: { error: failed.error, atMs: Number(failed.errorMs) } } : {}),
        };
      });
      const merged = mergeAnalytics(inputs, now);
      let spendBytes = 0;
      merged.data.instances = merged.data.instances.map((instance, index) => {
        const snapshot = inputs[index]?.snapshot;
        if (snapshot === undefined || snapshot.console.gardenerSpendSource === undefined) return instance;
        let gardenerSpend = foldGardenerSpend(snapshot.console.gardenerSpendSource, instance.repository, snapshot.asOf);
        if (spendBytes + Buffer.byteLength(JSON.stringify(gardenerSpend)) > GARDENER_SPEND_MAX_BYTES) {
          gardenerSpend = foldGardenerSpend({ reason: "over_budget" }, instance.repository, snapshot.asOf);
        }
        const bytes = Buffer.byteLength(JSON.stringify(gardenerSpend));
        if (spendBytes + bytes > GARDENER_SPEND_MAX_BYTES) return instance;
        spendBytes += bytes;
        return { ...instance, gardenerSpend };
      });
      return [{ key: "", ...withHostModelApprovals(merged, opts.modelApprovalConfig, now) }];
    },
  };
}
