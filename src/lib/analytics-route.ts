/**
 * lib/analytics-route.ts — `GET /v1/analytics`: the per-instance aggregate answering the
 * operator's four analytics questions the ledger could not answer before W1-T477 (see
 * plan/tasks.d/W1-T477-analytics-collect-then-serve.yaml for the full rationale):
 *
 *   1. How often is each command called?      — `cli.invoked` rows (run-task.ts's `main()`)
 *   2. What worker types are generated?        — the `lane` field now on every lane log-closure
 *   3. Wall-clock per task run?                 — `run.start` → `verdict` joins, already ledgered
 *   4. Wall-clock per worker call?               — `worker_duration_ms` (worker.ts's WorkerResult)
 *
 * THE READER DISCIPLINE (design note iii): this module reads through
 * {@link ledgerRotationEntries}'s union — every rotation on disk PLUS the live file — never the
 * live file alone. `readLedgerLines` (status.ts) stays single-file BY DESIGN at dozens of other
 * decision sites; this route is deliberately NOT one of them, because a single-file read here
 * would undercount by the same 3.1x this task's rationale measured elsewhere (ledger-grep.ts's
 * own module doc). Unlike `resolveLedgerUnion` (ledger-grep.ts), a state dir with ZERO rotations
 * is not a refusal here: `resolveLedgerUnion`'s zero-archive verdict exists so `rmd ledger-grep`
 * can distinguish "no matches" from "no archives were even read" for an AUDIT. A freshly
 * provisioned instance legitimately has zero rotations (rotation triggers at
 * `LEDGER_ROTATION_CEILING_BYTES`, MASTER-PLAN §9) and still has a real, readable live file — this
 * route reports what it can read, honestly, rather than erroring on the common early-instance
 * case (design note iv: "N=1 today").
 *
 * DEDUPE IS ON THE FULL RAW LINE, never a derived key like `ts+task_id` — that key collapsed
 * genuinely distinct SIMULTANEOUS rows sharing a pseudo task id (e.g. two different `DAEMON`
 * steps stamped the same millisecond), which is the "collapsed-deferral hazard" this task's
 * rationale names. A rotation union naturally re-observes the same physical line more than once
 * (a line written to the live file before a rotation, then archived) — full-line dedupe collapses
 * THAT case correctly (one event, one row) while leaving two DIFFERENT rows that merely share a
 * timestamp uncollapsed.
 *
 * UNMEASURED-BEFORE, NEVER ZERO (design note ii). `cli.invoked` and `worker_duration_ms` are
 * BRAND NEW signals this task adds — every line ledgered before it exists carries neither. A
 * corpus with no `cli.invoked` row at all renders `invocationsUnmeasuredBefore`, not an empty
 * `{}`: an empty object reads as "zero calls, ever", which the operator's own brief opens with as
 * the false-refutation shape to avoid (two fleets, one coincident total of 30). The worker
 * count/cost breakdown (question 2) and the task-duration join (question 3) both predate this
 * task and are NOT marked unmeasured — they render real numbers, with an honest "unknown"/
 * "no_terminal" bucket for the rows that were always going to be incomplete (a governor merge
 * with no verdict row, a retro/triage run with no run.start at all — see this module's own
 * derivation functions).
 *
 * CROSS-INSTANCE (design note iv): N=1 — this route answers ONLY this host's own ledger. No row
 * leaves the host; nothing here ships raw lines outward (that is W1-T425's redaction lane, out of
 * scope). A hosted portfolio polls each cell's own `/v1/analytics` through the relay
 * (`runRelayClient`, W1-T431, already forwards the whole console REST+SSE surface outbound-only)
 * once W1-T433's second cell exists — this shard deliberately does not build that consumer.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isQueueDispatchRunStart, MAX_RETAINED_LINES_PER_STEP } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import {
  buildAnalyticsTimeSeries,
  createHistoricalSeriesAccumulator,
  type HistoricalSeriesAccumulator,
  type LedgerTimeSeries,
} from "./analytics-timeseries.js";
import {
  buildAnalyticsBreakdowns,
  createAnalyticsBreakdownAccumulator,
  type AnalyticsBreakdownAccumulator,
  type AnalyticsBreakdownDimension,
  type AnalyticsDrilldownRow,
} from "./analytics-breakdowns.js";
import type { Route } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { fingerprintLedgerLine, ledgerRotationEntries, openLedgerUnion } from "./ledger-union.js";
import { systemClock, type Clock } from "./clock.js";
import { cacheHitRatio, type CacheHitTokens } from "./digest.js";
import { adaptOperatorAgentCapacityRows, type OperatorAgentCapacityLedgerRow, type OperatorAgentCapacitySignal } from "./operator-agent-capacity.js";
import { adaptOperatorDecisionRows, type OperatorDecisionLedgerRow, type OperatorAgentDecisionSignal } from "./operator-agent-decisions.js";
import { adaptOperatorAgentProofRows, type OperatorAgentProofLedgerRow, type OperatorAgentProofSignal } from "./operator-agent-proof.js";
import { adaptVerdictCalibrationReport, type OperatorAgentTaskOutcomeSignal } from "./operator-agent-outcomes.js";
import {
  selectOperatorAgentMemoryRow,
  type OperatorAgentMemoryLedgerRow,
  type OperatorAgentMemorySnapshot,
} from "./operator-agent.js";
import { verdictCalibrationReport } from "./verdict-calibration.js";
import { adaptLiveAnalyticsMetrics, emptyLiveAnalyticsMetrics, type LiveAnalyticsMetrics } from "./analytics-live-metrics.js";

/** One (lane, model) bucket of question 2 — worker counts and cost by lane/model. */
export interface WorkerLaneModelBucket {
  lane: string;
  model: string;
  count: number;
  totalCostUsd: number;
}

/** One run's wall-clock (question 3) — a `run.start`→`verdict` join for one `run_id`. */
export interface TaskDurationEntry {
  runId: string;
  taskId: string;
  durationMs: number;
}

/** One lane's worker-call duration distribution (question 4), once `worker_duration_ms` exists. */
export interface WorkerDurationLaneBucket {
  lane: string;
  count: number;
  totalDurationMs: number;
  avgDurationMs: number;
}

/**
 * One bounded model-routing aggregate. `assignments` records the pre-execution policy decision;
 * terminal counters and measurements stay zero until a durable worker result joins that decision.
 * This deliberately never exposes prompts, account labels, raw capacity responses, or ledger
 * excerpts through the analytics route.
 */
export interface RoutingTelemetryBucket {
  provider: string;
  assignedModel: string;
  taskType: string;
  routingRule: string;
  assignments: number;
  terminalResults: number;
  successes: number;
  failures: number;
  totalTokens: number;
  totalDurationMs: number;
  totalCostUsd: number;
  fallbackReasons: Array<{ reason: string; count: number }>;
}

/** One UTC-day point for the operator's token-per-terminal-result efficiency trend. */
export interface RoutingTelemetryDay {
  day: string;
  terminalResults: number;
  totalTokens: number;
  totalCostUsd: number;
}

/**
 * The routing-v1 aggregate consumes the assignment/terminal evidence that already exists in the
 * ledger. It intentionally distinguishes an assignment with no terminal receipt from a completed
 * call, because treating the former as a failed or zero-cost call would manufacture evidence.
 */
export interface RoutingTelemetrySnapshot {
  version: "routing-v1";
  /** No retained assignment event means the dashboard has no routing sample; it is not a zero. */
  evidenceState: "observed" | "not-collected-in-retained-ledger";
  assignmentsObserved: number;
  terminalResultsObserved: number;
  terminalResultsWithoutAssignment: number;
  assignmentsWithoutTerminalResult: number;
  buckets: RoutingTelemetryBucket[];
  daily: RoutingTelemetryDay[];
}

/** W1-T4024 — cash-lane dollars over one named trailing window. */
export interface CashSpendWindow {
  name: "7d" | "30d";
  days: number;
  fromDay: string;
  toDay: string;
  usd: number;
  rows: number;
  /** FALSE when the window starts before the oldest retained day, or covers a day restored from a
   *  checkpoint that predates cash collection. A compacting ledger must never read as a falling spend. */
  complete: boolean;
  reason?: string;
}

export interface CashSpendSnapshot {
  state: "observed" | "not-collected";
  unit: "usd";
  asOf: string | null;
  coverage: string;
  windows: CashSpendWindow[];
  reason?: string;
}

const CASH_SPEND_WINDOWS: ReadonlyArray<{ name: CashSpendWindow["name"]; days: number }> = [
  { name: "7d", days: 7 },
  { name: "30d", days: 30 },
];

const CASH_SPEND_COVERAGE =
  "implement workers only: fix-rung workers record no provider, so their cash spend cannot be attributed";

export function notCollectedCashSpend(reason: string): CashSpendSnapshot {
  return { state: "not-collected", unit: "usd", asOf: null, coverage: CASH_SPEND_COVERAGE, windows: [], reason };
}

/** Sum cash-lane dollars over each named window ending on `nowIso`'s UTC day. PURE. */
function cashSpend(history: CheckpointHistoryState, nowIso: string): CashSpendSnapshot {
  const end = Date.parse(nowIso);
  if (!Number.isFinite(end)) return notCollectedCashSpend("no as-of instant to anchor a window");
  const observed = [...history.days.entries()].filter(([, bucket]) => bucket.observed).map(([day]) => day).sort();
  const oldest = observed[0];
  const toDay = utcDayFromTimestamp(end);
  const windows = CASH_SPEND_WINDOWS.map(({ name, days }): CashSpendWindow => {
    const fromDay = utcDayFromTimestamp(end - (days - 1) * CHECKPOINT_DAY_MS);
    let usd = 0;
    let rows = 0;
    let uncollected = 0;
    for (const [day, bucket] of history.days) {
      if (day < fromDay || day > toDay) continue;
      usd += bucket.cashUsd ?? 0;
      rows += bucket.cashRows ?? 0;
      if (bucket.observed && bucket.cashCollected !== true) uncollected += 1;
    }
    const startsBeforeHistory = oldest === undefined || fromDay < oldest;
    const reason = oldest === undefined
      ? "no ledger history is retained"
      : startsBeforeHistory
        ? `window starts ${fromDay}, before the oldest retained day ${oldest}`
        : uncollected > 0
          ? `${uncollected} day(s) in the window were restored from a checkpoint that predates cash collection`
          : undefined;
    return {
      name,
      days,
      fromDay,
      toDay,
      usd: Math.round(usd * 1e6) / 1e6,
      rows,
      complete: !startsBeforeHistory && uncollected === 0,
      ...(reason ? { reason } : {}),
    };
  });
  return { state: "observed", unit: "usd", asOf: nowIso, coverage: CASH_SPEND_COVERAGE, windows };
}

/** W1-T4024 — THE SECOND, SMALL, VERSIONED PROJECTION THE CONSOLE FETCHES BESIDE console-v1.
 *
 *  WHY NOT GROW console-v1. Measured on the live snapshot 2026-09-22, console-v1 is already 100,489
 *  bytes — 77% of the console's 128 KB response cap — almost all of it the operator-agent block,
 *  whose four detail arrays sit at their 100-item cap. Adding the series and provider blocks
 *  (~14 KB) would leave ~13 KB of margin under a limit that, when crossed, makes the console refuse
 *  the WHOLE response and blank the entire analytics page. A separate projection keeps both small,
 *  leaves console-v1 (and W1-T3884's contract) byte-identical, and isolates failure: operator-agent
 *  growth can no longer blank headroom, nor the reverse. Same path, so no route or relay change. */
export const CONSOLE_SIGNALS_PROJECTION_VERSION = "console-signals-v1";

export interface ConsoleSignalsProjection {
  version: typeof CONSOLE_SIGNALS_PROJECTION_VERSION;
  asOf: string | null;
  /** The same bounded series the full snapshot serves — the trend cards' only source. */
  timeSeries: LedgerTimeSeries[];
  /** Live, merged at request time exactly as the full snapshot merges it. */
  queue: LiveAnalyticsMetrics["queue"];
  provider: LiveAnalyticsMetrics["provider"];
  spend: { cash: CashSpendSnapshot };
}

export function buildConsoleSignalsProjection(base: AnalyticsSnapshot, live: LiveAnalyticsMetrics): ConsoleSignalsProjection {
  return {
    version: CONSOLE_SIGNALS_PROJECTION_VERSION,
    asOf: base.asOf,
    timeSeries: base.timeSeries,
    queue: live.queue,
    provider: live.provider,
    spend: base.spend ?? { cash: notCollectedCashSpend("snapshot predates cash collection; awaiting first refresh") },
  };
}

/** `GET /v1/analytics`'s body — the four questions, one field group each. */
export interface AnalyticsSnapshot {
  /** `null` until this process has completed its first ledger-union refresh. */
  asOf: string | null;
  /** Carried in the payload so the N=1/no-redaction scope note travels with the data — see this
   *  module's header, design note iv. */
  measures: string;
  /** Question 1: invocation counts per verb, from `cli.invoked` rows. */
  invocationsByVerb: Record<string, number>;
  /** Present iff no `cli.invoked` row exists anywhere in the corpus — this signal predates
   *  collection (W1-T477); an empty `invocationsByVerb` here would misread as "zero calls". */
  invocationsUnmeasuredBefore?: string;
  /** Question 2: worker counts and cost, grouped by lane (`"unknown"` for a pre-W1-T477 row that
   *  carries no `lane` field) and model. */
  workersByLaneModel: WorkerLaneModelBucket[];
  /** Question 3: per-run wall-clock, `run.start`→`verdict` joins that resolved. */
  taskDurationsMs: TaskDurationEntry[];
  /** Question 3's explicit no-terminal bucket — a `run.start` with no matching `verdict` line
   *  (a gate-side merge, a run that never reached a terminal) is COUNTED here, never dropped. */
  noTerminalTaskCount: number;
  /** Question 4: worker-call duration, grouped by lane. */
  workerDurationsByLane: WorkerDurationLaneBucket[];
  /** Present iff no line anywhere carries `worker_duration_ms` — see
   *  {@link invocationsUnmeasuredBefore}'s doc for the same discipline applied here. */
  workerDurationsUnmeasuredBefore?: string;
  /** W1-T3623: the console-v1 catalog projection, folded from the same accumulator pass as the
   *  four questions above — see {@link ConsoleV1Projection}'s doc for the contract-gap this
   *  closes. */
  consoleV1: ConsoleV1Projection;
  /** Bounded routing policy/receipt attribution for the operator console. */
  routingTelemetry: RoutingTelemetrySnapshot;
  /** Current process-owned queue/provider signals; historical trends remain explicitly uncollected. */
  queue: LiveAnalyticsMetrics["queue"];
  provider: LiveAnalyticsMetrics["provider"];
  /** Five bounded ledger-backed series; queue and provider trends remain live-only. */
  timeSeries: LedgerTimeSeries[];
  /** W1-T4024 — money, in dollars, never mixed with subscription utilisation. */
  spend: { cash: CashSpendSnapshot };
  /** Outcome and work-category dimensions built from terminal run evidence. */
  dimensions: AnalyticsBreakdownDimension[];
  /** Flat rows for console drilldown views, derived from the same bounded dimensions. */
  drilldowns: AnalyticsDrilldownRow[];
  /**
   * Process-owned durable operator-agent memory. This property is deliberately non-enumerable so
   * it remains available to serve-owned routes without becoming a second public analytics wire
   * contract or leaking ledger-backed agent history through GET /v1/analytics.
   */
  operatorAgentMemory: OperatorAgentMemorySnapshot;
}

/** A console-v1 metric's provenance, carried explicitly because the console renders it and
 *  cannot infer it from the number alone (W1-T3623 acceptance iii): `"observed"` is a direct
 *  ledger count/measurement, `"provider_reported"` is copied off the SDK result envelope
 *  untouched (worker.ts's `TokenUsage` doc), `"modeled"` is this projection's own arithmetic
 *  over observed/provider-reported inputs (a ratio or a summed cost). */
export type ConsoleV1MeasurementClass = "observed" | "provider_reported" | "modeled";

/** The projection version BOTH sides must agree names the same metric set — see
 *  {@link resolveConsoleV1Projection}. A bump here is a breaking-shape change. */
export const CONSOLE_V1_PROJECTION_VERSION = "console-v1";

/** THE CONSOLE-V1 CATALOG (W1-T3623): the exact metric keys the operator console's analytics
 *  page asks `/v1/analytics` for — `runs.completed`, `tokens.total`, `cache.reuse`,
 *  `cost.modeled.usd`, `duration.p50.ms`, `queue.pending`. Before this task the daemon answered
 *  with a disjoint set (`invocationsByVerb`, `workersByLaneModel`, …) under the SAME version
 *  string; this array is the one place both this module and its test import the catalog from, so
 *  the two can never drift apart silently again. */
export const CONSOLE_V1_METRIC_KEYS = [
  "runs.completed",
  "tokens.total",
  "cache.reuse",
  "cost.modeled.usd",
  "duration.p50.ms",
  "queue.pending",
] as const;

export type ConsoleV1MetricKey = (typeof CONSOLE_V1_METRIC_KEYS)[number];

/** One console-v1 metric. `value` is `null` — NEVER `0` — when this instance genuinely has
 *  nothing to report, mirroring this module's own UNMEASURED-BEFORE discipline (see the module
 *  header); `notCollectedReason` is present iff `value` is `null`. */
export interface ConsoleV1Metric {
  key: ConsoleV1MetricKey;
  class: ConsoleV1MeasurementClass;
  value: number | null;
  notCollectedReason?: string;
}

/** The operator-agent evidence families carried beside the existing console-v1 metric catalog. */
export interface OperatorAgentProjection {
  version: "operator-agent-v1";
  proof: OperatorAgentProofSignal;
  outcomes: OperatorAgentTaskOutcomeSignal;
  decisions: OperatorAgentDecisionSignal;
  capacity: OperatorAgentCapacitySignal;
}

/** `GET /v1/analytics`'s console-v1 projection — the catalog the console's own analytics page
 *  reads. `version` travels WITH the payload (design note, W1-T3623 acceptance iv) so a caller
 *  naming a version this instance does not emit can be REFUSED by {@link
 *  resolveConsoleV1Projection} instead of silently rendered an empty dashboard, which is exactly
 *  how both sides drifted apart the first time: a version string incremented independently on
 *  each side is not a contract. */
export interface ConsoleV1Projection {
  version: string;
  asOf: string | null;
  metrics: ConsoleV1Metric[];
  operatorAgent: OperatorAgentProjection;
}

export interface OperatorAgentProjectionInputs {
  proofRows?: readonly OperatorAgentProofLedgerRow[];
  decisionRows?: readonly OperatorDecisionLedgerRow[];
  capacityRows?: readonly OperatorAgentCapacityLedgerRow[];
  outcomes?: OperatorAgentTaskOutcomeSignal;
}

function emptyOperatorAgentProjection(): OperatorAgentProjection {
  return {
    version: "operator-agent-v1",
    proof: adaptOperatorAgentProofRows([]),
    outcomes: adaptVerdictCalibrationReport(verdictCalibrationReport([], "")),
    decisions: adaptOperatorDecisionRows([]),
    capacity: adaptOperatorAgentCapacityRows([]),
  };
}

/** Compose independently measured signals without allowing a missing producer to become zero. */
export function buildOperatorAgentProjection(inputs: OperatorAgentProjectionInputs = {}): OperatorAgentProjection {
  return {
    version: "operator-agent-v1",
    proof: adaptOperatorAgentProofRows(inputs.proofRows ?? []),
    outcomes: inputs.outcomes ?? adaptVerdictCalibrationReport(verdictCalibrationReport([], "")),
    decisions: adaptOperatorDecisionRows(inputs.decisionRows ?? []),
    capacity: adaptOperatorAgentCapacityRows(inputs.capacityRows ?? []),
  };
}

/** Carried in the payload rather than hardcoded client-side — mirrors account-usage.ts's
 *  `USAGE_SCOPE_NOTE` convention. */
export const ANALYTICS_SCOPE_NOTE =
  "this instance only — no ledger rows leave the host (W1-T425 redaction reservations untouched)";

/** The date W1-T477 landed — the constant the two `*UnmeasuredBefore` fields render, since an
 *  UNMEASURED-BEFORE marker without a date is just a word. */
export const ANALYTICS_COLLECTION_STARTED_AT = "2026-08-14";

/** Refresh cost posture: a scan reaching the safety ceiling occupies at most 12% of one core
 * when the next scan is not armed until this delay AFTER settlement. */
export const ANALYTICS_REFRESH_INTERVAL_MS = 15 * 60_000;

/** BACKSTOP: a reduction may not consume a long-lived serve process beyond this point. */
export const ANALYTICS_REFRESH_TIMEOUT_MS = 120_000;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Every raw number {@link buildConsoleV1Metrics} needs — every field here is already computed by
 *  this module's own accumulator pass EXCEPT `queuePending`, which is `/v1/status`'s own live
 *  `counts.queued` and genuinely outside a ledger-union read (this route reads PAST events, not
 *  current daemon state). `queuePending` stays optional so a future task can thread it in as a
 *  dep without reshaping this function; `undefined` here renders NOT COLLECTED, never a
 *  fabricated `0` — see this module's header for why that distinction is load-bearing. */
export interface ConsoleV1ProjectionInputs {
  runsCompleted: number;
  tokensTotal: number;
  cacheReuseTokens: CacheHitTokens;
  costModeledUsd: number;
  taskDurationsMs: readonly number[];
  queuePending?: number;
  operatorAgent?: OperatorAgentProjection;
}

/** Nearest-rank p50 (`sorted[floor((n-1)/2)]`) — `undefined`, never `0`, on an empty sample: a
 *  percentile of zero observations has no value, not a zero one. */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * THE CONSOLE-V1 CATALOG, EMITTED (W1-T3623): folds {@link ConsoleV1ProjectionInputs} into every
 * key {@link CONSOLE_V1_METRIC_KEYS} names, each carrying its {@link ConsoleV1MeasurementClass}.
 * `cache.reuse` reuses digest.ts's OWN {@link cacheHitRatio} — the sole cache-hit arithmetic in
 * this codebase (W1-T929) — rather than re-deriving a second opinion of the same ratio, and
 * inherits its `undefined`-on-zero-denominator discipline verbatim (NOT COLLECTED, never a
 * fabricated 0% hit rate).
 */
export function buildConsoleV1Metrics(inputs: ConsoleV1ProjectionInputs): ConsoleV1Metric[] {
  const cacheReuse = cacheHitRatio(inputs.cacheReuseTokens);
  const durationP50 = median(inputs.taskDurationsMs);
  return [
    { key: "runs.completed", class: "observed", value: inputs.runsCompleted },
    { key: "tokens.total", class: "provider_reported", value: inputs.tokensTotal },
    cacheReuse === undefined
      ? {
          key: "cache.reuse",
          class: "modeled",
          value: null,
          notCollectedReason: "no worker call in this corpus carries a usable token envelope yet",
        }
      : { key: "cache.reuse", class: "modeled", value: cacheReuse },
    { key: "cost.modeled.usd", class: "modeled", value: inputs.costModeledUsd },
    durationP50 === undefined
      ? {
          key: "duration.p50.ms",
          class: "observed",
          value: null,
          notCollectedReason: "no run.start/verdict pair has resolved yet",
        }
      : { key: "duration.p50.ms", class: "observed", value: durationP50 },
    inputs.queuePending === undefined
      ? {
          key: "queue.pending",
          class: "observed",
          value: null,
          notCollectedReason: "queue depth is /v1/status's own live counter, not read by this projection",
        }
      : { key: "queue.pending", class: "observed", value: inputs.queuePending },
  ];
}

/** Wraps {@link buildConsoleV1Metrics} with the version/asOf envelope the console's catalog
 *  expects on the wire. */
export function buildConsoleV1Projection(asOf: string | null, inputs: ConsoleV1ProjectionInputs): ConsoleV1Projection {
  return {
    version: CONSOLE_V1_PROJECTION_VERSION,
    asOf,
    metrics: buildConsoleV1Metrics(inputs),
    operatorAgent: inputs.operatorAgent ?? emptyOperatorAgentProjection(),
  };
}

export type ConsoleV1ProjectionResolution =
  | { ok: true; projection: ConsoleV1Projection }
  | { ok: false; error: "unsupported_projection_version"; requestedVersion: string; supportedVersion: string };

/**
 * VERSION REFUSAL (W1-T3623 acceptance iv): a caller naming a projection version this instance
 * does not emit is REFUSED — never silently handed today's shape under that caller's version
 * string. That silent mismatch is exactly the failure this task exists to close: two sides each
 * called their own disjoint shape "console-v1" and neither found out. `requestedVersion`
 * undefined (no opinion from the caller) resolves to THIS instance's own version, never a
 * refusal.
 */
export function resolveConsoleV1Projection(
  snapshot: Pick<AnalyticsSnapshot, "consoleV1">,
  requestedVersion?: string,
): ConsoleV1ProjectionResolution {
  const version = requestedVersion ?? CONSOLE_V1_PROJECTION_VERSION;
  if (version !== CONSOLE_V1_PROJECTION_VERSION) {
    return {
      ok: false,
      error: "unsupported_projection_version",
      requestedVersion: version,
      supportedVersion: CONSOLE_V1_PROJECTION_VERSION,
    };
  }
  return { ok: true, projection: snapshot.consoleV1 };
}

interface AnalyticsAccumulator {
  invocationsByVerb: Record<string, number>;
  invocationsMeasured: boolean;
  workersByKey: Map<string, WorkerLaneModelBucket>;
  startsByRun: Map<string, { ts: number; taskId: string }>;
  verdictsByRun: Map<string, number>;
  workerDurationsByLane: Map<string, { count: number; totalMs: number }>;
  workerDurationsMeasured: boolean;
  /** W1-T3623: token totals off every worker/brain-plane line's `tokens` envelope
   *  (worker.ts's `workerLedgerFields`) — the SAME lines already discriminated by `model !==
   *  undefined` above, so this adds no new pass over the corpus. */
  tokensTotal: CacheHitTokens & { output: number };
  routingTelemetry: RoutingTelemetryAccumulator;
  /** Sanitized rows retained only for the four operator-agent evidence adapters. */
  operatorAgentRows: {
    proof: OperatorAgentProofLedgerRow[];
    decisions: OperatorDecisionLedgerRow[];
    capacity: OperatorAgentCapacityLedgerRow[];
    memory: OperatorAgentMemoryLedgerRow[];
  };
  historicalSeries: HistoricalSeriesAccumulator;
  breakdowns: AnalyticsBreakdownAccumulator;
  checkpointHistory: CheckpointHistoryState;
  checkpointBreakdowns: CheckpointBreakdownState;
  checkpointHydrated: boolean;
}

type CheckpointHistoryBucket = {
  observed: boolean;
  completedRuns: number;
  tokensTotal: number;
  cacheRead: number;
  inputTokens: number;
  cacheCreation: number;
  costUsd: number;
  durationsMs: number[];
  /** W1-T4024 — cash-lane money folded into this day. Optional because checkpoints written before
   *  W1-T4024 restore buckets without it; see `cashCollected`. */
  cashUsd?: number;
  cashRows?: number;
  /** TRUE only on a bucket this version CREATED. A bucket restored from an older checkpoint lacks it,
   *  so a window touching that day reports itself incomplete instead of silently undercounting. */
  cashCollected?: boolean;
};

type CheckpointHistoryState = {
  days: Map<string, CheckpointHistoryBucket>;
  starts: Map<string, number>;
};

type CheckpointBreakdownState = {
  starts: Set<string>;
  terminals: Map<string, { verdict?: string; success?: boolean }>;
  startsWithoutRunId: number;
  terminalsWithoutRunId: number;
  workCategories: Map<string, number>;
};

const CHECKPOINT_VERSION = 1 as const;
const CHECKPOINT_FILENAME = ".analytics-console-v1.checkpoint.json";
const CHECKPOINT_HISTORY_BUCKETS = 30;
const CHECKPOINT_DAY_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_SUCCESS_VERDICTS = new Set(["merged", "already_satisfied"]);

type AnalyticsCheckpointSource = {
  archives: Array<{ name: string; size: number; mtimeMs: number }>;
  live: { size: number; mtimeMs: number } | null;
  lastArchive: string | null;
  liveOffset: number;
};

type AnalyticsCheckpointState = {
  invocationsByVerb: Record<string, number>;
  invocationsMeasured: boolean;
  workersByLaneModel: WorkerLaneModelBucket[];
  startsByRun: Array<[string, { ts: number; taskId: string }]>;
  verdictsByRun: Array<[string, number]>;
  workerDurationsByLane: Array<[string, { count: number; totalMs: number }]>;
  workerDurationsMeasured: boolean;
  tokensTotal: CacheHitTokens & { output: number };
  routingTelemetry: {
    taskTypesByRun: Array<[string, string]>;
    assignmentsById: Array<[string, RoutingAssignment]>;
    terminalsByAssignmentId: Array<[string, RoutingTerminalReceipt]>;
    pendingTerminalsByAssignmentId: Array<[string, RoutingTerminalReceipt]>;
    buckets: Array<Omit<RoutingTelemetryBucketState, "fallbackReasons"> & { fallbackReasons: Array<[string, number]> }>;
    days: RoutingTelemetryDay[];
  };
  operatorAgentRows: Omit<AnalyticsAccumulator["operatorAgentRows"], "memory"> & {
    /** Optional for checkpoints written before W1-T4001. */
    memory?: OperatorAgentMemoryLedgerRow[];
  };
  history: {
    days: Array<[string, CheckpointHistoryBucket]>;
    starts: Array<[string, number]>;
  };
  breakdowns: {
    starts: string[];
    terminals: Array<[string, { verdict?: string; success?: boolean }]>;
    startsWithoutRunId: number;
    terminalsWithoutRunId: number;
    workCategories: Array<[string, number]>;
  };
};

export interface AnalyticsCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  source: AnalyticsCheckpointSource;
  tail: Array<{ step: string; fingerprint: string }>;
  state: AnalyticsCheckpointState;
  snapshot: AnalyticsSnapshot;
}

type RoutingAssignment = {
  id: string;
  provider: string;
  model: string;
  taskType: string;
  routingRule: string;
  preferenceBypassed: boolean;
};

/** The minimum terminal receipt needed for aggregation. Raw terminal ledger rows can carry
 * stderr excerpts, so the streaming accumulator never retains them while waiting for a join. */
type RoutingTerminalReceipt = {
  success?: boolean;
  tokens: number;
  durationMs: number;
  costUsd: number;
  servedModel?: string;
  capabilityFallback: boolean;
  day?: string;
};

type RoutingTelemetryBucketState = Omit<RoutingTelemetryBucket, "fallbackReasons"> & {
  fallbackReasons: Map<string, number>;
};

interface RoutingTelemetryAccumulator {
  taskTypesByRun: Map<string, string>;
  assignmentsById: Map<string, RoutingAssignment>;
  terminalsByAssignmentId: Map<string, RoutingTerminalReceipt>;
  pendingTerminalsByAssignmentId: Map<string, RoutingTerminalReceipt>;
  bucketsByKey: Map<string, RoutingTelemetryBucketState>;
  daysByDay: Map<string, RoutingTelemetryDay>;
}

function routingTelemetryAccumulator(): RoutingTelemetryAccumulator {
  return {
    taskTypesByRun: new Map(),
    assignmentsById: new Map(),
    terminalsByAssignmentId: new Map(),
    pendingTerminalsByAssignmentId: new Map(),
    bucketsByKey: new Map(),
    daysByDay: new Map(),
  };
}

function analyticsAccumulator(): AnalyticsAccumulator {
  return {
    invocationsByVerb: {},
    invocationsMeasured: false,
    workersByKey: new Map(),
    startsByRun: new Map(),
    verdictsByRun: new Map(),
    workerDurationsByLane: new Map(),
    workerDurationsMeasured: false,
    tokensTotal: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    routingTelemetry: routingTelemetryAccumulator(),
    operatorAgentRows: { proof: [], decisions: [], capacity: [], memory: [] },
    historicalSeries: createHistoricalSeriesAccumulator(),
    breakdowns: createAnalyticsBreakdownAccumulator(),
    checkpointHistory: { days: new Map(), starts: new Map() },
    checkpointBreakdowns: { starts: new Set(), terminals: new Map(), startsWithoutRunId: 0, terminalsWithoutRunId: 0, workCategories: new Map() },
    checkpointHydrated: false,
  };
}

function checkpointDay(value: unknown): string | undefined {
  const raw = str(value);
  const parsed = raw === undefined ? NaN : Date.parse(raw);
  return Number.isFinite(parsed) ? utcDayFromTimestamp(parsed) : undefined;
}

function utcDayFromTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function checkpointHistoryBucket(state: CheckpointHistoryState, day: string): CheckpointHistoryBucket {
  const existing = state.days.get(day);
  if (existing) return existing;
  const created: CheckpointHistoryBucket = {
    observed: false,
    completedRuns: 0,
    tokensTotal: 0,
    cacheRead: 0,
    inputTokens: 0,
    cacheCreation: 0,
    costUsd: 0,
    durationsMs: [],
    cashUsd: 0,
    cashRows: 0,
    cashCollected: true,
  };
  state.days.set(day, created);
  return created;
}

function checkpointTokenCounts(line: Record<string, unknown>): { total: number; input: number; cacheRead: number; cacheCreation: number } {
  const raw = line.tokens;
  if (!raw || typeof raw !== "object") return { total: 0, input: 0, cacheRead: 0, cacheCreation: 0 };
  const tokens = raw as Record<string, unknown>;
  const input = num(tokens.input) ?? 0;
  const output = num(tokens.output) ?? 0;
  const cacheRead = num(tokens.cacheRead) ?? 0;
  const cacheCreation = num(tokens.cacheCreation) ?? 0;
  return { total: input + output + cacheRead + cacheCreation, input, cacheRead, cacheCreation };
}

function captureCheckpointLine(acc: AnalyticsAccumulator, line: Record<string, unknown>): void {
  const day = checkpointDay(line.ts);
  if (day !== undefined) checkpointHistoryBucket(acc.checkpointHistory, day).observed = true;
  const step = str(line.step);
  const runId = str(line.run_id);
  const timestamp = Date.parse(str(line.ts) ?? "");
  if (step === "run.start" && runId && Number.isFinite(timestamp)) {
    const prior = acc.checkpointHistory.starts.get(runId);
    if (prior === undefined || timestamp < prior) acc.checkpointHistory.starts.set(runId, timestamp);
  }
  if (step === "verdict" && runId && Number.isFinite(timestamp)) {
    const started = acc.checkpointHistory.starts.get(runId);
    if (started !== undefined && day !== undefined) {
      const bucket = checkpointHistoryBucket(acc.checkpointHistory, day);
      bucket.completedRuns += 1;
      bucket.durationsMs.push(Math.max(0, timestamp - started));
    }
  }
  if (day !== undefined && str(line.model) !== undefined) {
    const bucket = checkpointHistoryBucket(acc.checkpointHistory, day);
    const tokens = checkpointTokenCounts(line);
    bucket.tokensTotal += tokens.total;
    bucket.inputTokens += tokens.input;
    bucket.cacheRead += tokens.cacheRead;
    bucket.cacheCreation += tokens.cacheCreation;
    bucket.costUsd += num(line.total_cost_usd) ?? 0;
  }

  // W1-T4024 — cash-lane money comes from WORKER rows that name their provider, never from
  // `verdict` or `cost.anomaly`. Measured 2026-09-22: 168 `cost.anomaly` rows restate worker costs,
  // and 38 of 68 `verdict` rows exactly restate their run's worker total (the rest are unexplained).
  // Neither carries `provider`, so selecting on it excludes both by construction. `routingTelemetry`
  // is NOT the source: its terminals are joined from `verdict` rows alone (66 of 602 assignments).
  if (day !== undefined && step === "implement.done" && str(line.provider) === "cash") {
    const bucket = checkpointHistoryBucket(acc.checkpointHistory, day);
    bucket.cashUsd = (bucket.cashUsd ?? 0) + (num(line.total_cost_usd) ?? 0);
    bucket.cashRows = (bucket.cashRows ?? 0) + 1;
  }

  const breakdowns = acc.checkpointBreakdowns;
  if (step === "run.start") {
    const category = str(line.type);
    const key = category && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(category) ? category : "unknown";
    breakdowns.workCategories.set(key, (breakdowns.workCategories.get(key) ?? 0) + 1);
    if (runId) breakdowns.starts.add(runId);
    else breakdowns.startsWithoutRunId += 1;
  } else if (step === "verdict") {
    const terminal = {
      ...(str(line.verdict) ? { verdict: str(line.verdict) } : {}),
      ...(typeof line.success === "boolean" ? { success: line.success } : {}),
    };
    if (runId) breakdowns.terminals.set(runId, terminal);
    else breakdowns.terminalsWithoutRunId += 1;
  }
}

function checkpointMedian(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function checkpointTimeSeries(state: CheckpointHistoryState, nowIso: string): LedgerTimeSeries[] {
  const definitions = [
    ["runs.completed", "Completed runs", "sum"],
    ["tokens.total", "Total tokens", "sum"],
    ["cache.reuse", "Cache reuse", "ratio"],
    ["cost.modeled.usd", "Modeled cost (USD)", "sum"],
    ["duration.p50.ms", "Run duration p50 (ms)", "p50"],
  ] as const;
  const end = Date.parse(`${checkpointDay(nowIso) ?? "1970-01-01"}T00:00:00.000Z`);
  const days = Array.from({ length: CHECKPOINT_HISTORY_BUCKETS }, (_, index) =>
    utcDayFromTimestamp(end - (CHECKPOINT_HISTORY_BUCKETS - index - 1) * CHECKPOINT_DAY_MS),
  );
  const pointFor = (day: string, id: string) => {
    const bucket = state.days.get(day);
    if (bucket === undefined || !bucket.observed) return { t: `${day}T00:00:00.000Z`, value: null, gap: true, note: "missing" };
    if (id === "runs.completed") return { t: `${day}T00:00:00.000Z`, value: bucket.completedRuns, gap: false };
    if (id === "tokens.total") return { t: `${day}T00:00:00.000Z`, value: bucket.tokensTotal, gap: false };
    if (id === "cost.modeled.usd") return { t: `${day}T00:00:00.000Z`, value: bucket.costUsd, gap: false };
    if (id === "cache.reuse") {
      const denominator = bucket.cacheRead + bucket.inputTokens + bucket.cacheCreation;
      return denominator > 0
        ? { t: `${day}T00:00:00.000Z`, value: bucket.cacheRead / denominator, gap: false }
        : { t: `${day}T00:00:00.000Z`, value: null, gap: true, note: "not-collected" };
    }
    const duration = checkpointMedian(bucket.durationsMs);
    return duration === undefined
      ? { t: `${day}T00:00:00.000Z`, value: null, gap: true, note: "not-collected" }
      : { t: `${day}T00:00:00.000Z`, value: duration, gap: false };
  };
  const window = `${days[0]}/${days.at(-1)}`;
  return definitions.map(([id, name, aggregation]) => {
    const points = days.map((day) => pointFor(day, id));
    return {
      id,
      name,
      window,
      bucketWidth: "1d",
      aggregation,
      coverage: points.some((point) => point.value !== null && point.value !== undefined) ? "observed" : "not-collected",
      points,
    };
  });
}

function checkpointBreakdowns(
  state: CheckpointBreakdownState,
  outcomes: OperatorAgentTaskOutcomeSignal | undefined,
): { dimensions: AnalyticsBreakdownDimension[]; drilldowns: AnalyticsDrilldownRow[] } {
  const counts = new Map<string, number>();
  const add = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const runId of state.starts) {
    const terminal = state.terminals.get(runId);
    if (!terminal) add("missing-terminal-receipt");
    else if (CHECKPOINT_SUCCESS_VERDICTS.has(terminal.verdict ?? "") && terminal.success !== false) add("success");
    else if (!terminal.verdict) add("unknown");
    else add("failure");
  }
  for (let index = 0; index < state.startsWithoutRunId; index += 1) add("missing-terminal-receipt");
  for (let index = 0; index < state.terminalsWithoutRunId; index += 1) add("unknown");
  for (const [runId, terminal] of state.terminals) {
    if (state.starts.has(runId)) continue;
    if (terminal.verdict) add(CHECKPOINT_SUCCESS_VERDICTS.has(terminal.verdict) && terminal.success !== false ? "success" : "failure");
    else add("unknown");
  }
  const outcomeDenominator = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const outcomeBuckets = ["success", "failure", "missing-terminal-receipt", "unknown"]
    .filter((key) => (counts.get(key) ?? 0) > 0)
    .map((key) => ({ key, label: key, count: counts.get(key)!, denominator: outcomeDenominator }));
  if (outcomes?.status === "measured") {
    const denominator = outcomes.armsClassified;
    for (const [key, count] of [
      ["reverted", outcomes.classes.reduce((sum, item) => sum + item.revertedCount, 0)],
      ["follow-up-fix", outcomes.classes.reduce((sum, item) => sum + item.followupFixedCount, 0)],
    ] as const) {
      if (count > 0) outcomeBuckets.push({ key, label: key, count, denominator });
    }
  }
  const categories = [...state.workCategories.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const bounded = categories.slice(0, 20);
  const overflow = categories.slice(20).reduce((sum, [, count]) => sum + count, 0);
  if (overflow > 0) bounded.push(["other", overflow]);
  const workDenominator = [...state.workCategories.values()].reduce((sum, value) => sum + value, 0);
  const categoryBuckets = bounded
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, label: key, count, denominator: workDenominator }));
  const dimensions: AnalyticsBreakdownDimension[] = [
    { key: "outcome", label: "Outcome", state: outcomeDenominator > 0 ? "observed" : "empty", denominator: outcomeDenominator, buckets: outcomeBuckets },
    { key: "work-category", label: "Work category", state: workDenominator > 0 ? "observed" : "empty", denominator: workDenominator, buckets: categoryBuckets },
  ];
  return {
    dimensions,
    drilldowns: dimensions.flatMap((dimension) => dimension.buckets.slice(0, 40).map((bucket) => ({ ...bucket, dimension: dimension.key }))),
  };
}

const OPERATOR_AGENT_DECISION_STEPS = new Set([
  "panel.manual_approved",
  "panel.proposal_accepted",
  "panel.proposal_rejected",
  "panel.proposal_declined",
  "automerge.hold_engaged",
  "automerge.hold_released",
  "automerge.armed",
  "automerge.clean_status_direct_merge",
  "automerge.direct_merge_failed",
  "automerge.direct_merge_preflight_head_unavailable",
  "automerge.direct_merge_preflight_refused",
  "automerge.direct_merge_update_failed",
  "automerge.direct_merge_updated",
  "automerge.rate_limited_rest_merge",
  "automerge.rate_limited_rest_merge_conflict",
  "automerge.rate_limited_rest_merge_refused",
  "automerge.rate_limited_rest_merge_retry",
]);

const OPERATOR_AGENT_CAPACITY_FIELDS = [
  "repo",
  "repository",
  "configured_capacity",
  "configured_pool_size",
  "worker_pool_size",
  "wip_limit",
  "admitted_lanes",
  "lane_budget",
  "active_workers",
  "queued_work",
  "queue_pending",
  "window_start",
  "measurement_start",
  "window_end",
  "measurement_end",
] as const;

const OPERATOR_AGENT_CAPACITY_OBSERVATION_FIELDS = OPERATOR_AGENT_CAPACITY_FIELDS.filter(
  (field) => field !== "repo" && field !== "repository",
);

/** Retain only the bounded fields the operator-agent adapters need; prompts and ledger excerpts
 * never enter the analytics snapshot's response path. */
type SelectedOperatorAgentRow =
  | { family: "memory"; row: OperatorAgentMemoryLedgerRow }
  | { family: "proof"; row: OperatorAgentProofLedgerRow }
  | { family: "decisions"; row: OperatorDecisionLedgerRow }
  | { family: "capacity"; row: OperatorAgentCapacityLedgerRow };

function operatorAgentRow(line: Record<string, unknown>): SelectedOperatorAgentRow | undefined {
  const memory = selectOperatorAgentMemoryRow(line);
  if (memory) return { family: "memory", row: memory };
  const step = str(line.step);
  if (step === "review.posted") {
    return { family: "proof", row: { step, task_id: line.task_id, proof_exec: line.proof_exec } };
  }
  if (step && OPERATOR_AGENT_DECISION_STEPS.has(step)) {
    return {
      family: "decisions",
      row: {
        step,
        task_id: line.task_id,
        task_class: line.task_class,
        task_type: line.task_type,
        class: line.class,
        origin: line.origin,
        actor: line.actor,
        by: line.by,
      },
    };
  }
  if (OPERATOR_AGENT_CAPACITY_OBSERVATION_FIELDS.some((field) => field in line)) {
    return {
      family: "capacity",
      row: Object.fromEntries(OPERATOR_AGENT_CAPACITY_FIELDS.map((field) => [field, line[field]])),
    };
  }
  return undefined;
}

function routingBucketFor(
  acc: RoutingTelemetryAccumulator,
  assignment: RoutingAssignment,
): RoutingTelemetryBucketState {
  const key = [assignment.provider, assignment.model, assignment.taskType, assignment.routingRule].join("\0");
  const existing = acc.bucketsByKey.get(key);
  if (existing) return existing;
  const created: RoutingTelemetryBucketState = {
    provider: assignment.provider,
    assignedModel: assignment.model,
    taskType: assignment.taskType,
    routingRule: assignment.routingRule,
    assignments: 0,
    terminalResults: 0,
    successes: 0,
    failures: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    totalCostUsd: 0,
    fallbackReasons: new Map(),
  };
  acc.bucketsByKey.set(key, created);
  return created;
}

function tokensOnLine(line: Record<string, unknown>): number {
  const tokens = line.tokens;
  if (!tokens || typeof tokens !== "object") return 0;
  const value = tokens as Record<string, unknown>;
  return (num(value.input) ?? 0) + (num(value.output) ?? 0) + (num(value.cacheRead) ?? 0) + (num(value.cacheCreation) ?? 0);
}

function boundedRoutingRule(assignment: Record<string, unknown>): string {
  const routing = assignment.routing;
  if (!routing || typeof routing !== "object") return "unreported";
  const value = routing as Record<string, unknown>;
  const mode = str(value.mode) ?? "unreported";
  const selectionPath = str(value.selectionPath);
  return selectionPath ? `${mode}:${selectionPath}` : mode;
}

function routingAssignmentFromLine(acc: RoutingTelemetryAccumulator, line: Record<string, unknown>): RoutingAssignment | undefined {
  if (line.step !== "worker.assignment" || !line.worker_assignment || typeof line.worker_assignment !== "object") return undefined;
  const raw = line.worker_assignment as Record<string, unknown>;
  const selected = raw.selected;
  if (!selected || typeof selected !== "object") return undefined;
  const selection = selected as Record<string, unknown>;
  const id = str(raw.id);
  const provider = str(selection.provider);
  const model = str(selection.model);
  if (!id || !provider || !model) return undefined;
  const runId = str(line.run_id);
  const routing = raw.routing;
  const preferenceBypassed = Boolean(
    routing && typeof routing === "object" && (routing as Record<string, unknown>).preferenceBypass,
  );
  return {
    id,
    provider,
    model,
    taskType: (runId && acc.taskTypesByRun.get(runId)) ?? "unknown",
    routingRule: boundedRoutingRule(raw),
    preferenceBypassed,
  };
}

function routingTerminalReceipt(line: Record<string, unknown>): RoutingTerminalReceipt {
  const ts = str(line.ts);
  return {
    ...(typeof line.success === "boolean" ? { success: line.success } : {}),
    tokens: tokensOnLine(line),
    durationMs: num(line.worker_duration_ms) ?? 0,
    costUsd: num(line.total_cost_usd) ?? 0,
    ...(str(line.served_model) ? { servedModel: str(line.served_model) } : {}),
    capabilityFallback: Boolean(line.codex_capability_fallback && typeof line.codex_capability_fallback === "object"),
    ...(ts && Number.isFinite(Date.parse(ts)) ? { day: utcDayFromTimestamp(Date.parse(ts)) } : {}),
  };
}

function terminalFallbackReasons(assignment: RoutingAssignment, terminal: RoutingTerminalReceipt): string[] {
  const reasons: string[] = [];
  if (assignment.preferenceBypassed) reasons.push("provider-preference-bypass");
  if (terminal.capabilityFallback) reasons.push("capability-table-unavailable");
  const served = terminal.servedModel;
  if (served && served !== assignment.model) reasons.push("provider-served-different-model");
  return reasons;
}

function applyRoutingTerminal(
  acc: RoutingTelemetryAccumulator,
  assignment: RoutingAssignment,
  terminal: RoutingTerminalReceipt,
): void {
  const bucket = routingBucketFor(acc, assignment);
  bucket.terminalResults += 1;
  if (terminal.success === true) bucket.successes += 1;
  else if (terminal.success === false) bucket.failures += 1;
  bucket.totalTokens += terminal.tokens;
  bucket.totalDurationMs += terminal.durationMs;
  bucket.totalCostUsd += terminal.costUsd;
  for (const reason of terminalFallbackReasons(assignment, terminal)) {
    bucket.fallbackReasons.set(reason, (bucket.fallbackReasons.get(reason) ?? 0) + 1);
  }
  if (terminal.day) {
    const current = acc.daysByDay.get(terminal.day) ?? { day: terminal.day, terminalResults: 0, totalTokens: 0, totalCostUsd: 0 };
    current.terminalResults += 1;
    current.totalTokens += terminal.tokens;
    current.totalCostUsd += terminal.costUsd;
    acc.daysByDay.set(terminal.day, current);
  }
}

function accumulateRoutingTelemetryLine(acc: RoutingTelemetryAccumulator, line: Record<string, unknown>): void {
  if (line.step === "run.start") {
    const runId = str(line.run_id);
    const taskType = str(line.type);
    if (runId && taskType) acc.taskTypesByRun.set(runId, taskType);
  }

  const assignment = routingAssignmentFromLine(acc, line);
  if (assignment) {
    if (acc.assignmentsById.has(assignment.id)) return;
    acc.assignmentsById.set(assignment.id, assignment);
    routingBucketFor(acc, assignment).assignments += 1;
    const pending = acc.pendingTerminalsByAssignmentId.get(assignment.id);
    if (pending) {
      acc.pendingTerminalsByAssignmentId.delete(assignment.id);
      acc.terminalsByAssignmentId.set(assignment.id, pending);
      applyRoutingTerminal(acc, assignment, pending);
    }
    return;
  }

  // `workerLedgerFields` appears on intermediate worker rows such as `implement.done` as
  // well as on the run's final `verdict`. The assignment is a pre-execution policy fact, but
  // only the verdict names the terminal outcome. Treating the first intermediate row as the
  // receipt would turn a completed call into an `unreported` failure and discard its final
  // token/duration/cost envelope.
  if (line.step !== "verdict") return;
  const assignmentId = str(line.selection_assignment_id);
  if (!assignmentId || acc.terminalsByAssignmentId.has(assignmentId) || acc.pendingTerminalsByAssignmentId.has(assignmentId)) return;
  const terminal = routingTerminalReceipt(line);
  const selected = acc.assignmentsById.get(assignmentId);
  if (selected) {
    acc.terminalsByAssignmentId.set(assignmentId, terminal);
    applyRoutingTerminal(acc, selected, terminal);
  } else {
    acc.pendingTerminalsByAssignmentId.set(assignmentId, terminal);
  }
}

function snapshotRoutingTelemetry(acc: RoutingTelemetryAccumulator): RoutingTelemetrySnapshot {
  return {
    version: "routing-v1",
    evidenceState: acc.assignmentsById.size > 0 ? "observed" : "not-collected-in-retained-ledger",
    assignmentsObserved: acc.assignmentsById.size,
    terminalResultsObserved: acc.terminalsByAssignmentId.size,
    terminalResultsWithoutAssignment: acc.pendingTerminalsByAssignmentId.size,
    assignmentsWithoutTerminalResult: acc.assignmentsById.size - acc.terminalsByAssignmentId.size,
    buckets: [...acc.bucketsByKey.values()]
      .map((bucket) => ({
        ...bucket,
        fallbackReasons: [...bucket.fallbackReasons.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
      }))
      .sort((left, right) => right.assignments - left.assignments || left.assignedModel.localeCompare(right.assignedModel)),
    daily: [...acc.daysByDay.values()].sort((left, right) => left.day.localeCompare(right.day)).slice(-30),
  };
}

/** Fold one logical ledger event into all four analytics questions in one pass. */
function accumulateAnalyticsLine(acc: AnalyticsAccumulator, line: Record<string, unknown>): void {
  acc.historicalSeries.add(line);
  acc.breakdowns.add(line);
  captureCheckpointLine(acc, line);
  const selectedOperatorAgentRow = operatorAgentRow(line);
  if (selectedOperatorAgentRow?.family === "memory") {
    acc.operatorAgentRows.memory.push(selectedOperatorAgentRow.row);
    if (acc.operatorAgentRows.memory.length > 2_000) {
      acc.operatorAgentRows.memory.splice(0, acc.operatorAgentRows.memory.length - 2_000);
    }
  } else if (selectedOperatorAgentRow?.family === "proof") acc.operatorAgentRows.proof.push(selectedOperatorAgentRow.row);
  else if (selectedOperatorAgentRow?.family === "decisions") acc.operatorAgentRows.decisions.push(selectedOperatorAgentRow.row);
  else if (selectedOperatorAgentRow?.family === "capacity") acc.operatorAgentRows.capacity.push(selectedOperatorAgentRow.row);

  // Assignment/terminal attribution is folded from this SAME union pass. It has its
  // own bounded, join-aware accumulator because an assignment is a policy fact and a terminal
  // row is an outcome fact; neither may be inferred from the other.
  accumulateRoutingTelemetryLine(acc.routingTelemetry, line);

  if (line.step === "cli.invoked") {
    acc.invocationsMeasured = true;
    const verb = str(line.verb) ?? "(unknown)";
    acc.invocationsByVerb[verb] = (acc.invocationsByVerb[verb] ?? 0) + 1;
  }

  const model = str(line.model);
  if (model !== undefined) {
    const lane = str(line.lane) ?? "unknown";
    const key = `${lane}\0${model}`;
    const bucket = acc.workersByKey.get(key) ?? { lane, model, count: 0, totalCostUsd: 0 };
    bucket.count += 1;
    bucket.totalCostUsd += num(line.total_cost_usd) ?? 0;
    acc.workersByKey.set(key, bucket);

    // W1-T3623: `tokens` rides the SAME line as `model`/`total_cost_usd` (workerLedgerFields
    // spreads all three together) — no new discriminator, just new fields read off it.
    const tokens = line.tokens as Record<string, unknown> | undefined;
    if (tokens && typeof tokens === "object") {
      acc.tokensTotal.input += num(tokens.input) ?? 0;
      acc.tokensTotal.output += num(tokens.output) ?? 0;
      acc.tokensTotal.cacheRead += num(tokens.cacheRead) ?? 0;
      acc.tokensTotal.cacheCreation += num(tokens.cacheCreation) ?? 0;
    }
  }

  // W1-T2383 rank 3: only queue-dispatch `run.start` rows participate in this join; lane-specific
  // `*.start` rows do not become false no-terminal runs.
  if (isQueueDispatchRunStart(line) || line.step === "verdict") {
    const runId = str(line.run_id);
    const ts = typeof line.ts === "string" ? Date.parse(line.ts) : NaN;
    if (runId !== undefined && Number.isFinite(ts)) {
      if (line.step === "run.start") {
        const existing = acc.startsByRun.get(runId);
        if (!existing || ts < existing.ts) acc.startsByRun.set(runId, { ts, taskId: str(line.task_id) ?? "" });
      } else {
        const existing = acc.verdictsByRun.get(runId);
        if (existing === undefined || ts > existing) acc.verdictsByRun.set(runId, ts);
      }
    }
  }

  const durationMs = num(line.worker_duration_ms);
  if (durationMs !== undefined) {
    acc.workerDurationsMeasured = true;
    const lane = str(line.lane) ?? "unknown";
    const bucket = acc.workerDurationsByLane.get(lane) ?? { count: 0, totalMs: 0 };
    bucket.count += 1;
    bucket.totalMs += durationMs;
    acc.workerDurationsByLane.set(lane, bucket);
  }
}

export interface AnalyticsDeriveOptions {
  /** Optional host-side git calibration; the ledger reader cannot infer post-merge outcomes. */
  operatorAgentOutcomes?: OperatorAgentTaskOutcomeSignal;
}

function snapshotFromAccumulator(
  acc: AnalyticsAccumulator,
  nowIso: string,
  options: AnalyticsDeriveOptions = {},
): AnalyticsSnapshot {
  const taskDurationsMs: TaskDurationEntry[] = [];
  let noTerminalTaskCount = 0;
  for (const [runId, start] of acc.startsByRun) {
    const verdictTs = acc.verdictsByRun.get(runId);
    if (verdictTs === undefined) {
      noTerminalTaskCount += 1;
      continue;
    }
    taskDurationsMs.push({ runId, taskId: start.taskId, durationMs: Math.max(0, verdictTs - start.ts) });
  }

  const workersByLaneModel = [...acc.workersByKey.values()];
  const costModeledUsd = workersByLaneModel.reduce((sum, bucket) => sum + bucket.totalCostUsd, 0);
  const tokensTotal =
    acc.tokensTotal.input + acc.tokensTotal.output + acc.tokensTotal.cacheRead + acc.tokensTotal.cacheCreation;

  const out: AnalyticsSnapshot = {
    asOf: nowIso,
    measures: ANALYTICS_SCOPE_NOTE,
    invocationsByVerb: acc.invocationsByVerb,
    workersByLaneModel,
    taskDurationsMs,
    noTerminalTaskCount,
    workerDurationsByLane: [...acc.workerDurationsByLane.entries()].map(([lane, value]) => ({
      lane,
      count: value.count,
      totalDurationMs: value.totalMs,
      avgDurationMs: value.totalMs / value.count,
    })),
    consoleV1: buildConsoleV1Projection(nowIso, {
      runsCompleted: taskDurationsMs.length,
      tokensTotal,
      cacheReuseTokens: acc.tokensTotal,
      costModeledUsd,
      taskDurationsMs: taskDurationsMs.map((entry) => entry.durationMs),
      operatorAgent: buildOperatorAgentProjection({
        proofRows: acc.operatorAgentRows.proof,
        decisionRows: acc.operatorAgentRows.decisions,
        capacityRows: acc.operatorAgentRows.capacity,
        outcomes: options.operatorAgentOutcomes,
      }),
    }),
    routingTelemetry: snapshotRoutingTelemetry(acc.routingTelemetry),
    ...emptyLiveAnalyticsMetrics(),
    timeSeries: acc.checkpointHydrated
      ? checkpointTimeSeries(acc.checkpointHistory, nowIso)
      : buildAnalyticsTimeSeries(acc.historicalSeries, nowIso),
    spend: { cash: cashSpend(acc.checkpointHistory, nowIso) },
    ...(acc.checkpointHydrated
      ? checkpointBreakdowns(acc.checkpointBreakdowns, options.operatorAgentOutcomes)
      : buildAnalyticsBreakdowns(acc.breakdowns, { operatorAgentOutcomes: options.operatorAgentOutcomes })),
    operatorAgentMemory: {
      state: "ready",
      asOf: nowIso,
      rows: acc.operatorAgentRows.memory.map((row) => ({ ...row })),
    },
  };
  Object.defineProperty(out, "operatorAgentMemory", {
    value: out.operatorAgentMemory,
    enumerable: false,
    writable: false,
  });
  if (!acc.invocationsMeasured) out.invocationsUnmeasuredBefore = ANALYTICS_COLLECTION_STARTED_AT;
  if (!acc.workerDurationsMeasured) out.workerDurationsUnmeasuredBefore = ANALYTICS_COLLECTION_STARTED_AT;
  return out;
}

/**
 * PURE aggregation — every input passed in, no filesystem/clock of its own (mirrors
 * account-usage.ts's `deriveAccountUsage`), so the whole thing is testable against a captured
 * line set. The real clock is supplied only at the route boundary below.
 */
export function deriveAnalyticsSnapshot(
  lines: ReadonlyArray<Record<string, unknown>>,
  nowIso: string,
  options: AnalyticsDeriveOptions = {},
): AnalyticsSnapshot {
  const accumulator = analyticsAccumulator();
  for (const line of lines) accumulateAnalyticsLine(accumulator, line);
  return snapshotFromAccumulator(accumulator, nowIso, options);
}

/** Fold an already-deduplicated stream without materialising its input. */
export async function deriveAnalyticsSnapshotFromStream(
  lines: AsyncIterable<Record<string, unknown>>,
  clock: Clock,
  signal?: AbortSignal,
  options: AnalyticsDeriveOptions = {},
): Promise<AnalyticsSnapshot> {
  const accumulator = analyticsAccumulator();
  for await (const line of lines) {
    signal?.throwIfAborted();
    accumulateAnalyticsLine(accumulator, line);
  }
  signal?.throwIfAborted();
  return snapshotFromAccumulator(accumulator, clock.iso(), options);
}

/**
 * Stream archive∪live into the aggregate the endpoint actually returns. Exact line replays are
 * held only for the same per-step window `rotateLedger` can carry into a later rotation; the
 * million-row corpus itself is never retained. Corrupt files remain best-effort through
 * `openLedgerUnion`, matching the former reader.
 */
export async function deriveAnalyticsSnapshotFromLedger(
  stateDir: string,
  clock: Clock,
  signal?: AbortSignal,
  options: AnalyticsDeriveOptions = {},
): Promise<AnalyticsSnapshot> {
  return deriveAnalyticsSnapshotFromStream(
    openLedgerUnion(stateDir, { dedupeWindowPerStep: MAX_RETAINED_LINES_PER_STEP, signal }),
    clock,
    signal,
    options,
  );
}

function checkpointPath(stateDir: string): string {
  return join(stateDir, CHECKPOINT_FILENAME);
}

function checkpointSource(stateDir: string): AnalyticsCheckpointSource | undefined {
  try {
    const rotations = ledgerRotationEntries(readdirSync(stateDir), stateDir);
    const archives = rotations.map((entry) => {
      const stat = statSync(entry.path);
      return { name: basename(entry.path), size: stat.size, mtimeMs: stat.mtimeMs };
    });
    const livePath = join(stateDir, LEDGER_FILENAME);
    const live = existsSync(livePath) ? statSync(livePath) : null;
    return { archives, live: live ? { size: live.size, mtimeMs: live.mtimeMs } : null, lastArchive: archives.at(-1)?.name ?? null, liveOffset: live?.size ?? 0 };
  } catch {
    // A missing or unreadable source manifest is an explicit non-resumable state; callers must
    // fall back to the full union rather than treating it as a healthy empty source.
    return undefined;
  }
}

function checkpointSourceCanResume(previous: AnalyticsCheckpointSource, current: AnalyticsCheckpointSource): boolean {
  if (current.archives.length < previous.archives.length) return false;
  if (current.live === null) return previous.live === null && current.archives.every((entry, index) => {
    const prior = previous.archives[index];
    return prior?.name === entry.name && prior.size === entry.size && prior.mtimeMs === entry.mtimeMs;
  });
  if (previous.live !== null && current.live.size < previous.liveOffset && current.archives.length <= previous.archives.length) return false;
  for (const prior of previous.archives) {
    const currentEntry = current.archives.find((entry) => entry.name === prior.name);
    if (!currentEntry || currentEntry.size !== prior.size || currentEntry.mtimeMs !== prior.mtimeMs) return false;
  }
  return true;
}

function serializeCheckpointState(acc: AnalyticsAccumulator): AnalyticsCheckpointState {
  return {
    invocationsByVerb: { ...acc.invocationsByVerb },
    invocationsMeasured: acc.invocationsMeasured,
    workersByLaneModel: [...acc.workersByKey.values()].map((bucket) => ({ ...bucket })),
    startsByRun: [...acc.startsByRun.entries()].map(([key, value]) => [key, { ...value }]),
    verdictsByRun: [...acc.verdictsByRun.entries()],
    workerDurationsByLane: [...acc.workerDurationsByLane.entries()].map(([key, value]) => [key, { ...value }]),
    workerDurationsMeasured: acc.workerDurationsMeasured,
    tokensTotal: { ...acc.tokensTotal },
    routingTelemetry: {
      taskTypesByRun: [...acc.routingTelemetry.taskTypesByRun.entries()],
      assignmentsById: [...acc.routingTelemetry.assignmentsById.entries()].map(([key, value]) => [key, { ...value }]),
      terminalsByAssignmentId: [...acc.routingTelemetry.terminalsByAssignmentId.entries()].map(([key, value]) => [key, { ...value }]),
      pendingTerminalsByAssignmentId: [...acc.routingTelemetry.pendingTerminalsByAssignmentId.entries()].map(([key, value]) => [key, { ...value }]),
      buckets: [...acc.routingTelemetry.bucketsByKey.values()].map((bucket) => ({
        ...bucket,
        fallbackReasons: [...bucket.fallbackReasons.entries()],
      })),
      days: [...acc.routingTelemetry.daysByDay.values()].map((day) => ({ ...day })),
    },
    operatorAgentRows: {
      proof: acc.operatorAgentRows.proof.map((row) => ({ ...row })),
      decisions: acc.operatorAgentRows.decisions.map((row) => ({ ...row })),
      capacity: acc.operatorAgentRows.capacity.map((row) => ({ ...row })),
      memory: acc.operatorAgentRows.memory.map((row) => ({ ...row })),
    },
    history: {
      days: [...acc.checkpointHistory.days.entries()].map(([day, bucket]) => [day, { ...bucket, durationsMs: [...bucket.durationsMs] }]),
      starts: [...acc.checkpointHistory.starts.entries()],
    },
    breakdowns: {
      starts: [...acc.checkpointBreakdowns.starts],
      terminals: [...acc.checkpointBreakdowns.terminals.entries()].map(([key, value]) => [key, { ...value }]),
      startsWithoutRunId: acc.checkpointBreakdowns.startsWithoutRunId,
      terminalsWithoutRunId: acc.checkpointBreakdowns.terminalsWithoutRunId,
      workCategories: [...acc.checkpointBreakdowns.workCategories.entries()],
    },
  };
}

function hydrateCheckpointState(state: AnalyticsCheckpointState): AnalyticsAccumulator {
  const acc = analyticsAccumulator();
  acc.invocationsByVerb = { ...state.invocationsByVerb };
  acc.invocationsMeasured = state.invocationsMeasured;
  for (const bucket of state.workersByLaneModel) acc.workersByKey.set(`${bucket.lane}\0${bucket.model}`, { ...bucket });
  for (const [key, value] of state.startsByRun) acc.startsByRun.set(key, { ...value });
  for (const [key, value] of state.verdictsByRun) acc.verdictsByRun.set(key, value);
  for (const [key, value] of state.workerDurationsByLane) acc.workerDurationsByLane.set(key, { ...value });
  acc.workerDurationsMeasured = state.workerDurationsMeasured;
  acc.tokensTotal = { ...state.tokensTotal };
  acc.routingTelemetry.taskTypesByRun = new Map(state.routingTelemetry.taskTypesByRun);
  acc.routingTelemetry.assignmentsById = new Map(state.routingTelemetry.assignmentsById.map(([key, value]) => [key, { ...value }]));
  acc.routingTelemetry.terminalsByAssignmentId = new Map(state.routingTelemetry.terminalsByAssignmentId.map(([key, value]) => [key, { ...value }]));
  acc.routingTelemetry.pendingTerminalsByAssignmentId = new Map(state.routingTelemetry.pendingTerminalsByAssignmentId.map(([key, value]) => [key, { ...value }]));
  for (const bucket of state.routingTelemetry.buckets) {
    acc.routingTelemetry.bucketsByKey.set(
      [bucket.provider, bucket.assignedModel, bucket.taskType, bucket.routingRule].join("\0"),
      { ...bucket, fallbackReasons: new Map(bucket.fallbackReasons) },
    );
  }
  acc.routingTelemetry.daysByDay = new Map(state.routingTelemetry.days.map((day) => [day.day, { ...day }]));
  acc.operatorAgentRows = {
    proof: state.operatorAgentRows.proof.map((row) => ({ ...row })),
    decisions: state.operatorAgentRows.decisions.map((row) => ({ ...row })),
    capacity: state.operatorAgentRows.capacity.map((row) => ({ ...row })),
    memory: (state.operatorAgentRows.memory ?? []).map((row) => ({ ...row })),
  };
  acc.checkpointHistory.days = new Map(state.history.days.map(([day, bucket]) => [day, { ...bucket, durationsMs: [...bucket.durationsMs] }]));
  acc.checkpointHistory.starts = new Map(state.history.starts);
  acc.checkpointBreakdowns.starts = new Set(state.breakdowns.starts);
  acc.checkpointBreakdowns.terminals = new Map(state.breakdowns.terminals.map(([key, value]) => [key, { ...value }]));
  acc.checkpointBreakdowns.startsWithoutRunId = state.breakdowns.startsWithoutRunId;
  acc.checkpointBreakdowns.terminalsWithoutRunId = state.breakdowns.terminalsWithoutRunId;
  acc.checkpointBreakdowns.workCategories = new Map(state.breakdowns.workCategories);
  acc.checkpointHydrated = true;
  return acc;
}

function validCheckpoint(value: unknown): value is AnalyticsCheckpoint {
  if (!value || typeof value !== "object") return false;
  const checkpoint = value as Partial<AnalyticsCheckpoint>;
  return checkpoint.version === CHECKPOINT_VERSION && checkpoint.source !== undefined && checkpoint.state !== undefined && checkpoint.snapshot !== undefined && Array.isArray(checkpoint.tail);
}

export function readAnalyticsCheckpoint(stateDir: string): AnalyticsCheckpoint | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(checkpointPath(stateDir), "utf8"));
    return validCheckpoint(parsed) ? parsed : undefined;
  } catch {
    // A missing or malformed checkpoint is intentionally indistinguishable from no prior cache;
    // the next refresh performs the full union and publishes fresh evidence when available.
    return undefined;
  }
}

export function writeAnalyticsCheckpoint(stateDir: string, checkpoint: AnalyticsCheckpoint): void {
  const target = checkpointPath(stateDir);
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(temporary, JSON.stringify(checkpoint));
    renameSync(temporary, target);
  } catch {
    try { if (existsSync(temporary)) renameSync(temporary, `${temporary}.discarded`); } catch { /* best effort cleanup */ }
  }
}

function appendCheckpointTail(
  seed: readonly { step: string; fingerprint: string }[] | undefined,
  accepted: Array<{ step: string; fingerprint: string }>,
): Array<{ step: string; fingerprint: string }> {
  const byStep = new Map<string, string[]>();
  for (const row of [...(seed ?? []), ...accepted]) {
    const values = byStep.get(row.step) ?? [];
    if (!values.includes(row.fingerprint)) values.push(row.fingerprint);
    if (values.length > MAX_RETAINED_LINES_PER_STEP) values.splice(0, values.length - MAX_RETAINED_LINES_PER_STEP);
    byStep.set(row.step, values);
  }
  return [...byStep.entries()].flatMap(([step, values]) => values.map((fingerprint) => ({ step, fingerprint })));
}

export interface AnalyticsSnapshotReadResult {
  snapshot: AnalyticsSnapshot;
  checkpoint: AnalyticsCheckpoint;
}

export async function deriveAnalyticsSnapshotFromCheckpointedLedger(
  stateDir: string,
  clock: Clock,
  signal?: AbortSignal,
  priorCheckpoint?: AnalyticsCheckpoint,
  options: AnalyticsDeriveOptions = {},
): Promise<AnalyticsSnapshotReadResult> {
  const currentSource = checkpointSource(stateDir);
  const canResume = priorCheckpoint !== undefined && currentSource !== undefined && checkpointSourceCanResume(priorCheckpoint.source, currentSource);
  let acc: AnalyticsAccumulator;
  let resumeCheckpoint: AnalyticsCheckpoint | undefined;
  let resumeSource: AnalyticsCheckpointSource | undefined;
  if (canResume) {
    try {
      acc = hydrateCheckpointState(priorCheckpoint!.state);
      resumeCheckpoint = priorCheckpoint;
      resumeSource = currentSource;
    } catch {
      // JSON shape validation is intentionally shallow so future checkpoint fields can be added
      // without making older readers reject the file. A structurally corrupt state must still
      // fail closed into the existing full union scan rather than strand the cache or fabricate
      // an empty aggregate.
      acc = analyticsAccumulator();
    }
  } else {
    acc = analyticsAccumulator();
  }
  const liveOffset = resumeCheckpoint !== undefined && resumeSource !== undefined && resumeCheckpoint.source.live !== null && resumeSource.live !== null && resumeSource.live.size < resumeCheckpoint.source.liveOffset
    ? 0
    : resumeCheckpoint?.source.liveOffset ?? 0;
  const accepted: Array<{ step: string; fingerprint: string }> = [];
  const union = openLedgerUnion(stateDir, {
    dedupeWindowPerStep: MAX_RETAINED_LINES_PER_STEP,
    signal,
    ...(resumeCheckpoint !== undefined && resumeCheckpoint.source.lastArchive !== null ? { afterRotation: resumeCheckpoint.source.lastArchive } : {}),
    ...(resumeCheckpoint ? { liveStartOffset: liveOffset, dedupeSeed: resumeCheckpoint.tail } : {}),
    onAcceptedRecord: (row, raw) => {
      const step = str(row.step);
      if (step) accepted.push({ step, fingerprint: fingerprintLedgerLine(raw) });
    },
  });
  for await (const line of union) {
    signal?.throwIfAborted();
    accumulateAnalyticsLine(acc, line);
  }
  signal?.throwIfAborted();
  const snapshot = snapshotFromAccumulator(acc, clock.iso(), options);
  const source = checkpointSource(stateDir) ?? currentSource ?? { archives: [], live: null, lastArchive: null, liveOffset: 0 };
  const checkpoint: AnalyticsCheckpoint = {
    version: CHECKPOINT_VERSION,
    source,
    tail: appendCheckpointTail(resumeCheckpoint?.tail, accepted),
    state: serializeCheckpointState(acc),
    snapshot,
  };
  return { snapshot, checkpoint };
}

/** One unref'ed timeout owned by the analytics cache. A wrapper rather than Node's concrete
 * Timeout type keeps the scheduler deterministic in tests and gives cancellation one method. */
export interface AnalyticsTimer {
  unref(): void;
  cancel(): void;
}

export type AnalyticsSnapshotReader = (
  stateDir: string,
  clock: Clock,
  signal: AbortSignal,
  priorCheckpoint?: AnalyticsCheckpoint,
) => AnalyticsSnapshot | AnalyticsSnapshotReadResult | Promise<AnalyticsSnapshot | AnalyticsSnapshotReadResult>;

export interface AnalyticsSnapshotCacheDeps {
  stateDir: string;
  readSnapshot?: AnalyticsSnapshotReader;
  clock?: Clock;
  refreshIntervalMs?: number;
  refreshTimeoutMs?: number;
  schedule?: (callback: () => void, delayMs: number) => AnalyticsTimer;
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

/** One process-owned analytics value and its lifecycle. `refresh` is public for deterministic
 * tests and diagnostics; HTTP handlers receive only `current`, so a request cannot start or join
 * work by construction. */
export interface AnalyticsSnapshotCache {
  current(): AnalyticsSnapshot;
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

function freezeAnalyticsSnapshot(value: AnalyticsSnapshot): AnalyticsSnapshot {
  if (!value.operatorAgentMemory) {
    Object.defineProperty(value, "operatorAgentMemory", {
      value: { state: value.asOf === null ? "cold" : "ready", asOf: value.asOf, rows: [] },
      enumerable: false,
      writable: false,
    });
  }
  Object.freeze(value.invocationsByVerb);
  for (const bucket of value.workersByLaneModel) Object.freeze(bucket);
  Object.freeze(value.workersByLaneModel);
  for (const entry of value.taskDurationsMs) Object.freeze(entry);
  Object.freeze(value.taskDurationsMs);
  for (const series of value.timeSeries) {
    for (const point of series.points) Object.freeze(point);
    Object.freeze(series.points);
    Object.freeze(series);
  }
  Object.freeze(value.timeSeries);
  for (const dimension of value.dimensions) {
    for (const bucket of dimension.buckets) Object.freeze(bucket);
    Object.freeze(dimension.buckets);
    Object.freeze(dimension);
  }
  Object.freeze(value.dimensions);
  for (const row of value.drilldowns) Object.freeze(row);
  Object.freeze(value.drilldowns);
  for (const bucket of value.workerDurationsByLane) Object.freeze(bucket);
  Object.freeze(value.workerDurationsByLane);
  for (const metric of value.consoleV1.metrics) Object.freeze(metric);
  Object.freeze(value.consoleV1.metrics);
  Object.freeze(value.consoleV1.operatorAgent.proof.unmeasurable);
  Object.freeze(value.consoleV1.operatorAgent.proof);
  for (const item of value.consoleV1.operatorAgent.outcomes.classes) {
    Object.freeze(item.taskIds);
    Object.freeze(item);
  }
  for (const item of value.consoleV1.operatorAgent.outcomes.unmeasurable) Object.freeze(item);
  Object.freeze(value.consoleV1.operatorAgent.outcomes.classes);
  Object.freeze(value.consoleV1.operatorAgent.outcomes.unmeasurable);
  Object.freeze(value.consoleV1.operatorAgent.outcomes.unmeasurableByCause);
  Object.freeze(value.consoleV1.operatorAgent.outcomes.policy);
  Object.freeze(value.consoleV1.operatorAgent.outcomes);
  for (const item of value.consoleV1.operatorAgent.decisions.explicitDecisions) Object.freeze(item);
  for (const item of value.consoleV1.operatorAgent.decisions.automaticMergeEvents) Object.freeze(item);
  for (const item of value.consoleV1.operatorAgent.decisions.classes) {
    Object.freeze(item.taskIds);
    Object.freeze(item.actorIds);
    Object.freeze(item);
  }
  for (const item of value.consoleV1.operatorAgent.decisions.unmeasurable) Object.freeze(item);
  Object.freeze(value.consoleV1.operatorAgent.decisions.explicitDecisions);
  Object.freeze(value.consoleV1.operatorAgent.decisions.automaticMergeEvents);
  Object.freeze(value.consoleV1.operatorAgent.decisions.classes);
  Object.freeze(value.consoleV1.operatorAgent.decisions.unmeasurable);
  for (const item of value.consoleV1.operatorAgent.capacity.measurements) Object.freeze(item);
  for (const item of value.consoleV1.operatorAgent.capacity.unavailable) Object.freeze(item.missing);
  for (const item of value.consoleV1.operatorAgent.capacity.unavailable) Object.freeze(item);
  Object.freeze(value.consoleV1.operatorAgent.capacity.measurements);
  Object.freeze(value.consoleV1.operatorAgent.capacity.unavailable);
  Object.freeze(value.consoleV1.operatorAgent.capacity);
  Object.freeze(value.consoleV1.operatorAgent);
  Object.freeze(value.consoleV1);
  Object.freeze(value.queue.pending);
  Object.freeze(value.queue.trend);
  Object.freeze(value.queue);
  Object.freeze(value.provider.allowance.remaining);
  Object.freeze(value.provider.allowance.trend);
  Object.freeze(value.provider.allowance);
  // Guarded: a snapshot restored from a checkpoint written before W1-T4024 carries neither field.
  if (value.provider.accounts) {
    for (const account of value.provider.accounts.accounts) {
      for (const window of account.windows) Object.freeze(window);
      Object.freeze(account.windows);
      Object.freeze(account);
    }
    Object.freeze(value.provider.accounts.accounts);
    Object.freeze(value.provider.accounts);
  }
  Object.freeze(value.provider);
  if (value.spend?.cash) {
    for (const window of value.spend.cash.windows) Object.freeze(window);
    Object.freeze(value.spend.cash.windows);
    Object.freeze(value.spend.cash);
    Object.freeze(value.spend);
  }
  for (const bucket of value.routingTelemetry.buckets) {
    for (const reason of bucket.fallbackReasons) Object.freeze(reason);
    Object.freeze(bucket.fallbackReasons);
    Object.freeze(bucket);
  }
  Object.freeze(value.routingTelemetry.buckets);
  for (const day of value.routingTelemetry.daily) Object.freeze(day);
  Object.freeze(value.routingTelemetry.daily);
  Object.freeze(value.routingTelemetry);
  for (const row of value.operatorAgentMemory.rows) Object.freeze(row);
  Object.freeze(value.operatorAgentMemory.rows);
  Object.freeze(value.operatorAgentMemory);
  return Object.freeze(value) as AnalyticsSnapshot;
}

/** Complete schema before any evidence has been read. `asOf: null` is the critical distinction:
 * stamping the clock here would claim the empty collections were observed at process start. */
export function coldAnalyticsSnapshot(): AnalyticsSnapshot {
  const breakdowns = buildAnalyticsBreakdowns([], { sourceState: "not-collected" });
  const snapshot: AnalyticsSnapshot = {
    asOf: null,
    measures: ANALYTICS_SCOPE_NOTE,
    invocationsByVerb: {},
    invocationsUnmeasuredBefore: ANALYTICS_COLLECTION_STARTED_AT,
    workersByLaneModel: [],
    taskDurationsMs: [],
    noTerminalTaskCount: 0,
    workerDurationsByLane: [],
    workerDurationsUnmeasuredBefore: ANALYTICS_COLLECTION_STARTED_AT,
    consoleV1: buildConsoleV1Projection(null, {
      runsCompleted: 0,
      tokensTotal: 0,
      cacheReuseTokens: { input: 0, cacheRead: 0, cacheCreation: 0 },
      costModeledUsd: 0,
      taskDurationsMs: [],
    }),
    routingTelemetry: {
      version: "routing-v1",
      evidenceState: "not-collected-in-retained-ledger",
      assignmentsObserved: 0,
      terminalResultsObserved: 0,
      terminalResultsWithoutAssignment: 0,
      assignmentsWithoutTerminalResult: 0,
      buckets: [],
      daily: [],
    },
    ...emptyLiveAnalyticsMetrics(),
    timeSeries: buildAnalyticsTimeSeries([], null),
    spend: { cash: notCollectedCashSpend("no ledger-union refresh has completed yet") },
    dimensions: breakdowns.dimensions,
    drilldowns: breakdowns.drilldowns,
    operatorAgentMemory: { state: "cold", asOf: null, rows: [] },
  };
  // Keep the pre-existing cold-cache object enumerable shape stable for callers that compare
  // the retained cache value directly; buildAnalyticsRoute materializes these fields on the
  // wire, and property access remains available to process-owned consumers.
  Object.defineProperties(snapshot, {
    dimensions: { value: snapshot.dimensions, enumerable: false, writable: false },
    drilldowns: { value: snapshot.drilldowns, enumerable: false, writable: false },
    operatorAgentMemory: { value: snapshot.operatorAgentMemory, enumerable: false, writable: false },
  });
  return freezeAnalyticsSnapshot(snapshot);
}

function systemSchedule(callback: () => void, delayMs: number): AnalyticsTimer {
  const handle = setTimeout(callback, delayMs);
  return {
    unref: () => handle.unref(),
    cancel: () => clearTimeout(handle),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build the specialised analytics cache. Exactly one timer exists at a time: the safety timer
 * while reading, then the refresh-delay timer after settlement. This is deliberately not a
 * generic route cache; its AbortController and evidence semantics are analytics-specific. */
export function createAnalyticsSnapshotCache(deps: AnalyticsSnapshotCacheDeps): AnalyticsSnapshotCache {
  const clock = deps.clock ?? systemClock;
  const readSnapshot: AnalyticsSnapshotReader = deps.readSnapshot ?? ((stateDir, refreshClock, signal, priorCheckpoint) =>
    deriveAnalyticsSnapshotFromCheckpointedLedger(stateDir, refreshClock, signal, priorCheckpoint));
  const refreshIntervalMs = deps.refreshIntervalMs ?? ANALYTICS_REFRESH_INTERVAL_MS;
  const refreshTimeoutMs = deps.refreshTimeoutMs ?? ANALYTICS_REFRESH_TIMEOUT_MS;
  const schedule = deps.schedule ?? systemSchedule;
  const log = deps.log ?? (() => {});
  let checkpoint = readAnalyticsCheckpoint(deps.stateDir);
  let value = checkpoint === undefined ? coldAnalyticsSnapshot() : freezeAnalyticsSnapshot(checkpoint.snapshot);
  let timer: AnalyticsTimer | undefined;
  let controller: AbortController | undefined;
  let inFlight: Promise<void> | undefined;
  let started = false;
  let stopped = false;

  const cancelTimer = (): void => {
    timer?.cancel();
    timer = undefined;
  };

  const arm = (callback: () => void, delayMs: number): AnalyticsTimer => {
    const handle = schedule(callback, delayMs);
    handle.unref();
    return handle;
  };

  const scheduleNext = (): void => {
    if (!started || stopped) return;
    let handle: AnalyticsTimer;
    handle = arm(() => {
      if (timer === handle) timer = undefined;
      void refresh();
    }, refreshIntervalMs);
    timer = handle;
  };

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve();
    cancelTimer();
    const refreshController = new AbortController();
    controller = refreshController;
    const beganAt = clock.now();
    let timedOut = false;
    log("serve.analytics_refresh.started", { retained_as_of: value.asOf, timeout_ms: refreshTimeoutMs });

    const safetyTimer = arm(() => {
      timedOut = true;
      const durationMs = Math.max(0, clock.now() - beganAt);
      log("serve.analytics_refresh.timeout", {
        duration_ms: durationMs,
        timeout_ms: refreshTimeoutMs,
        retained_as_of: value.asOf,
      });
      refreshController.abort(new Error(`analytics refresh exceeded ${refreshTimeoutMs}ms`));
    }, refreshTimeoutMs);
    timer = safetyTimer;

    let operation!: Promise<void>;
    operation = Promise.resolve()
      .then(() => readSnapshot(deps.stateDir, clock, refreshController.signal, checkpoint))
      .then((result) => {
        refreshController.signal.throwIfAborted();
        const next = "snapshot" in result ? result.snapshot : result;
        if ("snapshot" in result) {
          checkpoint = result.checkpoint;
          const hasRetainedEvidence = result.checkpoint.source.archives.length > 0 ||
            (result.checkpoint.source.live?.size ?? 0) > 0;
          if (hasRetainedEvidence) writeAnalyticsCheckpoint(deps.stateDir, result.checkpoint);
        }
        value = freezeAnalyticsSnapshot(next);
        log("serve.analytics_refresh.completed", {
          duration_ms: Math.max(0, clock.now() - beganAt),
          as_of: value.asOf,
        });
      })
      .catch((error: unknown) => {
        // Timeout has its own terminal row above. A lifecycle stop is expected cleanup. Every
        // other failure is explicit and retains the prior snapshot.
        if (!timedOut && !(stopped && refreshController.signal.aborted)) {
          log("serve.analytics_refresh.failed", {
            duration_ms: Math.max(0, clock.now() - beganAt),
            retained_as_of: value.asOf,
            error: errorText(error),
          });
        }
      })
      .finally(() => {
        if (timer === safetyTimer) {
          safetyTimer.cancel();
          timer = undefined;
        }
        if (controller === refreshController) controller = undefined;
        if (inFlight === operation) inFlight = undefined;
        scheduleNext();
      });
    inFlight = operation;
    return operation;
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    started = false;
    cancelTimer();
    controller?.abort(new Error("analytics refresh stopped with serve lifecycle"));
  };

  return {
    current: () => value,
    refresh,
    start: () => {
      if (started || stopped) return;
      started = true;
      void refresh();
    },
    stop,
  };
}

/**
 * `GET /v1/analytics` — read-scoped and synchronously served from process-owned state. It cannot
 * start, join or await a union scan because its inline input exposes only the current value.
 */
export function buildAnalyticsRoute(deps: {
  currentSnapshot: () => AnalyticsSnapshot;
  currentLiveMetrics?: () => LiveAnalyticsMetrics;
}): Route {
  return {
    method: "GET",
    path: "/v1/analytics",
    scope: "read",
    handler: (req, res) => {
      // `?projectionVersion=` is OPTIONAL (design note, W1-T3623 acceptance iv): omitted, it
      // resolves to this instance's own version and the full snapshot is served exactly as
      // before. The hosted console historically called the same field `?projection=`, so accept
      // that spelling as an alias while keeping projectionVersion authoritative when both exist.
      // Named and unrecognised versions are REFUSED (409) rather than answered with today's shape
      // under a version string the caller never asked for.
      const params = new URL(req.url ?? "/", "http://local").searchParams;
      const requestedVersion = params.get("projectionVersion") ?? params.get("projection") ?? undefined;
      const base = deps.currentSnapshot();
      // The analytics cache owns historical refreshes. Live metrics are a separate, already
      // captured process-owned value, so this handler never starts a refresh or provider read.
      const live = deps.currentLiveMetrics?.() ?? adaptLiveAnalyticsMetrics();
      // W1-T4024: a snapshot restored from a pre-W1-T4024 checkpoint has no `spend` until the first
      // refresh; say so explicitly rather than let the field vanish from the payload.
      if (requestedVersion === CONSOLE_SIGNALS_PROJECTION_VERSION) {
        sendJson(res, 200, buildConsoleSignalsProjection(base, live));
        return;
      }
      const spend = base.spend ?? { cash: notCollectedCashSpend("snapshot predates cash collection; awaiting first refresh") };
      const snapshot = { ...base, ...live, spend, dimensions: base.dimensions, drilldowns: base.drilldowns } as AnalyticsSnapshot;
      const resolution = resolveConsoleV1Projection(snapshot, requestedVersion);
      if (!resolution.ok) {
        sendJson(res, 409, resolution);
        return;
      }
      sendJson(res, 200, requestedVersion === undefined ? snapshot : resolution.projection);
    },
  };
}
