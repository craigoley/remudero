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
import { dirname } from "node:path";
import type { Route } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { openLedgerUnion } from "./ledger-union.js";
import { systemClock, type Clock } from "./clock.js";

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

/** `GET /v1/analytics`'s body — the four questions, one field group each. */
export interface AnalyticsSnapshot {
  asOf: string;
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
}

/** Carried in the payload rather than hardcoded client-side — mirrors account-usage.ts's
 *  `USAGE_SCOPE_NOTE` convention. */
export const ANALYTICS_SCOPE_NOTE =
  "this instance only — no ledger rows leave the host (W1-T425 redaction reservations untouched)";

/** The date W1-T477 landed — the constant the two `*UnmeasuredBefore` fields render, since an
 *  UNMEASURED-BEFORE marker without a date is just a word. */
export const ANALYTICS_COLLECTION_STARTED_AT = "2026-08-14";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

interface AnalyticsAccumulator {
  invocationsByVerb: Record<string, number>;
  invocationsMeasured: boolean;
  workersByKey: Map<string, WorkerLaneModelBucket>;
  startsByRun: Map<string, { ts: number; taskId: string }>;
  verdictsByRun: Map<string, number>;
  workerDurationsByLane: Map<string, { count: number; totalMs: number }>;
  workerDurationsMeasured: boolean;
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
  };
}

/** Fold one logical ledger event into all four analytics questions in one pass. */
function accumulateAnalyticsLine(acc: AnalyticsAccumulator, line: Record<string, unknown>): void {
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

  const out: AnalyticsSnapshot = {
    asOf: nowIso,
    measures: ANALYTICS_SCOPE_NOTE,
    invocationsByVerb: acc.invocationsByVerb,
    workersByLaneModel: [...acc.workersByKey.values()],
    taskDurationsMs,
    noTerminalTaskCount,
    workerDurationsByLane: [...acc.workerDurationsByLane.entries()].map(([lane, value]) => ({
      lane,
      count: value.count,
      totalDurationMs: value.totalMs,
      avgDurationMs: value.totalMs / value.count,
    })),
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
): Promise<AnalyticsSnapshot> {
  const accumulator = analyticsAccumulator();
  for await (const line of lines) accumulateAnalyticsLine(accumulator, line);
  return snapshotFromAccumulator(accumulator, clock.iso());
}

/**
 * Stream archive∪live into the aggregate the endpoint actually returns. Exact line replays are
 * held only for the same per-step window `rotateLedger` can carry into a later rotation; the
 * million-row corpus itself is never retained. Corrupt files remain best-effort through
 * `openLedgerUnion`, matching the former reader.
 */
export async function deriveAnalyticsSnapshotFromLedger(stateDir: string, clock: Clock): Promise<AnalyticsSnapshot> {
  return deriveAnalyticsSnapshotFromStream(
    openLedgerUnion(stateDir, { dedupeWindowPerStep: MAX_RETAINED_LINES_PER_STEP }),
    clock,
  );
}

/** {@link buildAnalyticsRoute}'s dependencies — every edge injectable, mirroring
 *  `account-usage.ts`'s `AccountUsageDeps` shape. */
export interface AnalyticsRouteDeps {
  /** `<root>/state/ledger.ndjson` — the SAME ledger every other console reader tails; this
   *  route derives its own state dir from `dirname(ledgerPath)`. */
  ledgerPath: string;
  /** Injectable aggregate reader; defaults to the bounded streaming union fold. */
  readSnapshot?: (stateDir: string, clock: Clock) => AnalyticsSnapshot | Promise<AnalyticsSnapshot>;
  clock?: Clock;
}

/**
 * `GET /v1/analytics` — read-scoped (the console's four operator questions are not a secret; see
 * this module's header for the scope rationale), computed FRESH PER REQUEST, no cache.
 */
export function buildAnalyticsRoute(deps: AnalyticsRouteDeps): Route {
  return {
    method: "GET",
    path: "/v1/analytics",
    scope: "read",
    handler: async (_req, res) => {
      const readSnapshot = deps.readSnapshot ?? deriveAnalyticsSnapshotFromLedger;
      const clock = deps.clock ?? systemClock;
      const stateDir = dirname(deps.ledgerPath);
      sendJson(res, 200, await readSnapshot(stateDir, clock));
    },
  };
}
