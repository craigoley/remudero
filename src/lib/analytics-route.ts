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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isQueueDispatchRunStart } from "./ledger.js";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Route } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { ledgerRotationEntries, type LedgerGrepFsDeps } from "./ledger-grep.js";
import { NEVER_ROTATE_FILENAME } from "./log-rotation.js";

const realAnalyticsFs: LedgerGrepFsDeps = {
  readdirSync: (dir) => readdirSync(dir),
  existsSync: (path) => existsSync(path),
  readFileSync: (path) => readFileSync(path),
  gunzipSync: (buf) => gunzipSync(buf),
};

/**
 * Read every ledger line across the rotation union (every `ledger.*` rotation ON DISK, in the
 * SAME form {@link ledgerRotationEntries} classifies them, PLUS the live file) under `stateDir`,
 * deduplicated on the full raw line text — see this module's header for why that key and not
 * `ts+task_id`. `fsDeps` mirrors `ledger-grep.ts`'s own injectable surface (reused, not
 * redeclared) so a test drives this against a synthetic state root.
 *
 * Best-effort per file: a rotation that exists and cannot be opened (corrupt `.gz`, unreadable)
 * is silently skipped rather than failing the whole read — this is a live console aggregate, not
 * an audit tool; `rmd ledger-grep` already owns the loud "coverage" verdict for that case.
 */
export function readAnalyticsLedgerLines(
  stateDir: string,
  fsDeps: LedgerGrepFsDeps = realAnalyticsFs,
): Array<Record<string, unknown>> {
  let names: string[];
  try {
    names = fsDeps.readdirSync(stateDir);
  } catch {
    names = [];
  }
  const rotations = ledgerRotationEntries(names, stateDir);

  const seen = new Set<string>();
  const parsed: Array<Record<string, unknown>> = [];
  const ingest = (text: string): void => {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || seen.has(line)) continue;
      seen.add(line);
      try {
        parsed.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Torn/unparseable line — dropped, the same discipline `readLedgerLines` (status.ts)
        // already applies to a torn trailing write.
      }
    }
  };

  for (const entry of rotations) {
    try {
      const buf = fsDeps.readFileSync(entry.path);
      ingest((entry.form === "gzip" ? fsDeps.gunzipSync(buf) : buf).toString("utf8"));
    } catch {
      // Unreadable rotation — best-effort, see this function's own doc.
    }
  }

  const livePath = join(stateDir, NEVER_ROTATE_FILENAME);
  if (fsDeps.existsSync(livePath)) {
    try {
      ingest(fsDeps.readFileSync(livePath).toString("utf8"));
    } catch {
      // Best-effort — the live file is the smaller, secondary half of the union.
    }
  }

  return parsed;
}

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

/** Question 1: group `cli.invoked` rows by `verb`. */
function deriveInvocationCounts(lines: ReadonlyArray<Record<string, unknown>>): {
  counts: Record<string, number>;
  measured: boolean;
} {
  const counts: Record<string, number> = {};
  let measured = false;
  for (const l of lines) {
    if (l.step !== "cli.invoked") continue;
    measured = true;
    const verb = str(l.verb) ?? "(unknown)";
    counts[verb] = (counts[verb] ?? 0) + 1;
  }
  return { counts, measured };
}

/**
 * Question 2: every worker-telemetry row (one that carries a `model` field — only
 * `workerLedgerFields`, worker.ts, ever spreads that key onto a ledger line) grouped by its
 * `lane` (added by W1-T477; `"unknown"` for a row ledgered before that field existed) and
 * `model`, summing `total_cost_usd` — the field name the writer actually uses, never `cost_usd`
 * (one of the rationale's named field-name traps).
 */
function deriveWorkersByLaneModel(lines: ReadonlyArray<Record<string, unknown>>): WorkerLaneModelBucket[] {
  const byKey = new Map<string, WorkerLaneModelBucket>();
  for (const l of lines) {
    const model = str(l.model);
    if (model === undefined) continue;
    const lane = str(l.lane) ?? "unknown";
    const key = `${lane}\0${model}`;
    const bucket = byKey.get(key) ?? { lane, model, count: 0, totalCostUsd: 0 };
    bucket.count += 1;
    bucket.totalCostUsd += num(l.total_cost_usd) ?? 0;
    byKey.set(key, bucket);
  }
  return [...byKey.values()];
}

/**
 * Question 3: for every `run_id` that has a `run.start` line (the runTask lane only — retro/
 * triage/plan/etc. self-ledger their OWN `*.start` step under a DIFFERENT name and are correctly
 * excluded from this join, not silently miscounted), the wall-clock from its EARLIEST `run.start`
 * to its LATEST `verdict` line. A `run_id` with a `run.start` but no `verdict` line at all — a
 * gate-side merge, a run that never reached a terminal (the rationale's named hazards) — is
 * counted in `noTerminalCount`, never dropped.
 */
function deriveTaskDurations(lines: ReadonlyArray<Record<string, unknown>>): {
  durations: TaskDurationEntry[];
  noTerminalCount: number;
} {
  const starts = new Map<string, { ts: number; taskId: string }>();
  const verdicts = new Map<string, number>();
  for (const l of lines) {
    // W1-T2383 rank 3: a lane `run.start` has no verdict BY DESIGN (this task deliberately
    // adds no verdict row for triage/retro), so pairing it here would land every lane run in
    // `noTerminalCount` below. Queue dispatches only.
    if (!isQueueDispatchRunStart(l) && l.step !== "verdict") continue;
    const runId = str(l.run_id);
    const ts = typeof l.ts === "string" ? Date.parse(l.ts) : NaN;
    if (runId === undefined || !Number.isFinite(ts)) continue;
    if (l.step === "run.start") {
      const existing = starts.get(runId);
      if (!existing || ts < existing.ts) starts.set(runId, { ts, taskId: str(l.task_id) ?? "" });
    } else {
      const existing = verdicts.get(runId);
      if (existing === undefined || ts > existing) verdicts.set(runId, ts);
    }
  }
  const durations: TaskDurationEntry[] = [];
  let noTerminalCount = 0;
  for (const [runId, start] of starts) {
    const verdictTs = verdicts.get(runId);
    if (verdictTs === undefined) {
      noTerminalCount += 1;
      continue;
    }
    durations.push({ runId, taskId: start.taskId, durationMs: Math.max(0, verdictTs - start.ts) });
  }
  return { durations, noTerminalCount };
}

/** Question 4: every line carrying `worker_duration_ms` (W1-T477), grouped by `lane`. */
function deriveWorkerDurationsByLane(lines: ReadonlyArray<Record<string, unknown>>): {
  buckets: WorkerDurationLaneBucket[];
  measured: boolean;
} {
  const byLane = new Map<string, { count: number; totalMs: number }>();
  let measured = false;
  for (const l of lines) {
    const durationMs = num(l.worker_duration_ms);
    if (durationMs === undefined) continue;
    measured = true;
    const lane = str(l.lane) ?? "unknown";
    const cur = byLane.get(lane) ?? { count: 0, totalMs: 0 };
    cur.count += 1;
    cur.totalMs += durationMs;
    byLane.set(lane, cur);
  }
  const buckets = [...byLane.entries()].map(([lane, v]) => ({
    lane,
    count: v.count,
    totalDurationMs: v.totalMs,
    avgDurationMs: v.totalMs / v.count,
  }));
  return { buckets, measured };
}

/**
 * PURE aggregation — every input passed in, no filesystem/clock of its own (mirrors
 * account-usage.ts's `deriveAccountUsage`), so the whole thing is testable against a captured
 * line set. `nowIso` defaults to the real clock only at the route boundary below.
 */
export function deriveAnalyticsSnapshot(
  lines: ReadonlyArray<Record<string, unknown>>,
  nowIso: string,
): AnalyticsSnapshot {
  const invocations = deriveInvocationCounts(lines);
  const workers = deriveWorkersByLaneModel(lines);
  const { durations, noTerminalCount } = deriveTaskDurations(lines);
  const workerDurations = deriveWorkerDurationsByLane(lines);

  const out: AnalyticsSnapshot = {
    asOf: nowIso,
    measures: ANALYTICS_SCOPE_NOTE,
    invocationsByVerb: invocations.counts,
    workersByLaneModel: workers,
    taskDurationsMs: durations,
    noTerminalTaskCount: noTerminalCount,
    workerDurationsByLane: workerDurations.buckets,
  };
  if (!invocations.measured) out.invocationsUnmeasuredBefore = ANALYTICS_COLLECTION_STARTED_AT;
  if (!workerDurations.measured) out.workerDurationsUnmeasuredBefore = ANALYTICS_COLLECTION_STARTED_AT;
  return out;
}

/** {@link buildAnalyticsRoute}'s dependencies — every edge injectable, mirroring
 *  `account-usage.ts`'s `AccountUsageDeps` shape. */
export interface AnalyticsRouteDeps {
  /** `<root>/state/ledger.ndjson` — the SAME ledger every other console reader tails; this
   *  route derives its own state dir from `dirname(ledgerPath)`. */
  ledgerPath: string;
  /** Injectable — defaults to {@link readAnalyticsLedgerLines} against the real filesystem. */
  readLines?: (stateDir: string) => Array<Record<string, unknown>>;
  now?: () => string;
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
    handler: (_req, res) => {
      const readLines = deps.readLines ?? readAnalyticsLedgerLines;
      const now = deps.now ?? (() => new Date().toISOString());
      const stateDir = dirname(deps.ledgerPath);
      sendJson(res, 200, deriveAnalyticsSnapshot(readLines(stateDir), now()));
    },
  };
}
