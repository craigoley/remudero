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

import { isQueueDispatchRunStart, MAX_RETAINED_LINES_PER_STEP } from "./ledger.js";
import type { Route } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { openLedgerUnion } from "./ledger-union.js";
import { systemClock, type Clock } from "./clock.js";
import { cacheHitRatio, type CacheHitTokens } from "./digest.js";

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
  return { version: CONSOLE_V1_PROJECTION_VERSION, asOf, metrics: buildConsoleV1Metrics(inputs) };
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
  };
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
    ...(ts && Number.isFinite(Date.parse(ts)) ? { day: new Date(ts).toISOString().slice(0, 10) } : {}),
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

function snapshotFromAccumulator(acc: AnalyticsAccumulator, nowIso: string): AnalyticsSnapshot {
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
    }),
    routingTelemetry: snapshotRoutingTelemetry(acc.routingTelemetry),
  };
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
): AnalyticsSnapshot {
  const accumulator = analyticsAccumulator();
  for (const line of lines) accumulateAnalyticsLine(accumulator, line);
  return snapshotFromAccumulator(accumulator, nowIso);
}

/** Fold an already-deduplicated stream without materialising its input. */
export async function deriveAnalyticsSnapshotFromStream(
  lines: AsyncIterable<Record<string, unknown>>,
  clock: Clock,
  signal?: AbortSignal,
): Promise<AnalyticsSnapshot> {
  const accumulator = analyticsAccumulator();
  for await (const line of lines) {
    signal?.throwIfAborted();
    accumulateAnalyticsLine(accumulator, line);
  }
  signal?.throwIfAborted();
  return snapshotFromAccumulator(accumulator, clock.iso());
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
): Promise<AnalyticsSnapshot> {
  return deriveAnalyticsSnapshotFromStream(
    openLedgerUnion(stateDir, { dedupeWindowPerStep: MAX_RETAINED_LINES_PER_STEP, signal }),
    clock,
    signal,
  );
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
) => AnalyticsSnapshot | Promise<AnalyticsSnapshot>;

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
  Object.freeze(value.invocationsByVerb);
  for (const bucket of value.workersByLaneModel) Object.freeze(bucket);
  Object.freeze(value.workersByLaneModel);
  for (const entry of value.taskDurationsMs) Object.freeze(entry);
  Object.freeze(value.taskDurationsMs);
  for (const bucket of value.workerDurationsByLane) Object.freeze(bucket);
  Object.freeze(value.workerDurationsByLane);
  for (const metric of value.consoleV1.metrics) Object.freeze(metric);
  Object.freeze(value.consoleV1.metrics);
  Object.freeze(value.consoleV1);
  for (const bucket of value.routingTelemetry.buckets) {
    for (const reason of bucket.fallbackReasons) Object.freeze(reason);
    Object.freeze(bucket.fallbackReasons);
    Object.freeze(bucket);
  }
  Object.freeze(value.routingTelemetry.buckets);
  for (const day of value.routingTelemetry.daily) Object.freeze(day);
  Object.freeze(value.routingTelemetry.daily);
  Object.freeze(value.routingTelemetry);
  return Object.freeze(value) as AnalyticsSnapshot;
}

/** Complete schema before any evidence has been read. `asOf: null` is the critical distinction:
 * stamping the clock here would claim the empty collections were observed at process start. */
export function coldAnalyticsSnapshot(): AnalyticsSnapshot {
  return freezeAnalyticsSnapshot({
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
  });
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
  const readSnapshot = deps.readSnapshot ?? deriveAnalyticsSnapshotFromLedger;
  const refreshIntervalMs = deps.refreshIntervalMs ?? ANALYTICS_REFRESH_INTERVAL_MS;
  const refreshTimeoutMs = deps.refreshTimeoutMs ?? ANALYTICS_REFRESH_TIMEOUT_MS;
  const schedule = deps.schedule ?? systemSchedule;
  const log = deps.log ?? (() => {});
  let value = coldAnalyticsSnapshot();
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
      .then(() => readSnapshot(deps.stateDir, clock, refreshController.signal))
      .then((next) => {
        refreshController.signal.throwIfAborted();
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
export function buildAnalyticsRoute(deps: { currentSnapshot: () => AnalyticsSnapshot }): Route {
  return {
    method: "GET",
    path: "/v1/analytics",
    scope: "read",
    handler: (req, res) => {
      // `?projectionVersion=` is OPTIONAL (design note, W1-T3623 acceptance iv): omitted, it
      // resolves to this instance's own version and the full snapshot is served exactly as
      // before. Named and unrecognised, the request is REFUSED (409) rather than answered with
      // today's shape under a version string the caller never asked for.
      const requestedVersion = new URL(req.url ?? "/", "http://local").searchParams.get("projectionVersion") ?? undefined;
      const snapshot = deps.currentSnapshot();
      const resolution = resolveConsoleV1Projection(snapshot, requestedVersion);
      if (!resolution.ok) {
        sendJson(res, 409, resolution);
        return;
      }
      sendJson(res, 200, snapshot);
    },
  };
}
