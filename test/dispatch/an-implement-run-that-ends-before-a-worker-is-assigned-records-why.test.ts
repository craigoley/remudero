/**
 * W1-T12154 — an implement run that ends before a worker is assigned records why.
 *
 * MEASURED 2026-11-10: 600 of 1,030 implement runs in the core ledger ended with no worker assignment, and no row
 * said why. The run logger now writes `worker_assigned: false` and the last stage the run reached on such a run's
 * verdict, and the analytics time series counts the run apart from completed runs and durations.
 *
 * The stamp is `unassignedRunStage` in src/lib/non-worker-verdict.ts, which run-task.ts `benchmarkRunLedgerLogger`
 * feeds every row and asks at its verdict; test/run-task-benchmark-run-wiring.test.ts proves that wiring through the
 * real logger, so this suite does not add another direct importer of src/run-task.ts (the affected-reach ratchet).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAnalyticsTimeSeries } from "#src/lib/analytics-timeseries.js";
import { endedBeforeWorkerAssignment, unassignedRunStage } from "#src/lib/non-worker-verdict.js";

type Row = Record<string, unknown>;

/** A run's rows, stamped with one run id and an advancing clock; each verdict carries the stamp the logger adds. */
function runLogger(runId: string, startMs: number): { log: (step: string, extra?: Row) => void; rows: Row[] } {
  const rows: Row[] = [];
  const reached = unassignedRunStage();
  let at = startMs;
  const log = (step: string, extra: Row = {}): void => {
    const fields = step === "verdict" ? { ...extra, ...reached.verdictFields(extra) } : extra;
    rows.push({ ts: new Date(at).toISOString(), run_id: runId, task_id: "W1-T1", step, ...fields });
    at += 60_000;
    reached.observe(step, extra);
  };
  return { log, rows };
}

const ASSIGNMENT = {
  id: "assignment-1",
  requested: { provider: "anthropic", model: "claude-opus-5-5" },
  selected: { provider: "anthropic", model: "claude-opus-5-5" },
};

const NOW = "2026-11-10T12:00:00.000Z";
const DAY_START = Date.parse("2026-11-10T01:00:00.000Z");

function runsCompletedPoint(rows: Row[]): Row {
  const series = buildAnalyticsTimeSeries(rows, NOW);
  const point = series.find((s) => s.id === "runs.completed")?.points.find((p) => p.t.startsWith("2026-11-10"));
  assert.ok(point, "the window holds the run's day");
  return point as Row;
}

function durationPoint(rows: Row[]): Row {
  const series = buildAnalyticsTimeSeries(rows, NOW);
  const point = series.find((s) => s.id === "duration.p50.ms")?.points.find((p) => p.t.startsWith("2026-11-10"));
  assert.ok(point);
  return point as Row;
}

function verdictOf(rows: Row[]): Row {
  const verdict = rows.find((row) => row.step === "verdict");
  assert.ok(verdict, "the run wrote its verdict");
  return verdict;
}

test("W1-T12154 criterion 1: an implement run with no worker.assignment row records that no worker was assigned and its last stage", () => {
  const { log, rows } = runLogger("W1-T1-1", DAY_START);
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("worktree.created", { path: "/tmp/w" });
  log("verdict", { verdict: "failed", stage: "run.error", reason: "boom" });
  const verdict = verdictOf(rows);
  assert.equal(verdict.worker_assigned, false);
  assert.equal(verdict.last_stage, "recon");
  assert.equal(verdict.verdict, "failed", "the verdict's own fields are kept");
  assert.equal(endedBeforeWorkerAssignment(verdict), true);
});

test("W1-T12154 criterion 1: a verdict naming its own stage records that stage as the last one reached", () => {
  const { log, rows } = runLogger("W1-T1-2", DAY_START);
  log("run.start", { type: "implement" });
  log("verdict", { verdict: "failed", stage: "managed_checkout.refresh", reason: "lock held" });
  assert.equal(verdictOf(rows).worker_assigned, false);
  assert.equal(verdictOf(rows).last_stage, "managed_checkout.refresh");
});

test("W1-T12154 criterion 1: with no phase or stage written, the last stage is the last step the run wrote", () => {
  const { log, rows } = runLogger("W1-T1-3", DAY_START);
  log("run.start", { type: "implement" });
  log("preflight.started", {});
  log("verdict", { verdict: "blocked_toolchain" });
  assert.equal(verdictOf(rows).worker_assigned, false);
  assert.equal(verdictOf(rows).last_stage, "preflight.started");
});

test("W1-T12154 criterion 3: a run that ended before a worker was assigned is counted apart, not as a completed run or a duration", () => {
  const { log, rows } = runLogger("W1-T1-4", DAY_START);
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("verdict", { verdict: "failed", stage: "run.error", reason: "boom" });
  const point = runsCompletedPoint(rows);
  assert.equal(point.value, 0, "the run is not a completed run");
  assert.equal(point.endedBeforeWorkerAssignment, 1, "the run is counted apart");
  assert.equal(durationPoint(rows).gap, true, "the run adds no duration");
});

test("W1-T12154 criterion 3: an older verdict without the field falls back to its infrastructure refusal", () => {
  const rows: Row[] = [
    { ts: "2026-11-10T01:00:00.000Z", run_id: "W1-T1-5", step: "run.start", type: "implement" },
    { ts: "2026-11-10T01:05:00.000Z", run_id: "W1-T1-5", step: "verdict", verdict: "blocked_isolation" },
  ];
  const point = runsCompletedPoint(rows);
  assert.equal(point.value, 0);
  assert.equal(point.endedBeforeWorkerAssignment, 1);
  assert.equal(endedBeforeWorkerAssignment(rows[1]!), true);
});

test("W1-T12154 criterion 4: an implement run that assigned a worker writes no field and is counted as a completed run", () => {
  const { log, rows } = runLogger("W1-T1-6", DAY_START);
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("worker.assignment", { worker_assignment: ASSIGNMENT });
  log("verdict", { verdict: "failed", stage: "run.error", reason: "boom" });
  const verdict = verdictOf(rows);
  assert.equal(Object.hasOwn(verdict, "worker_assigned"), false);
  assert.equal(Object.hasOwn(verdict, "last_stage"), false);
  const point = runsCompletedPoint(rows);
  assert.equal(point.value, 1);
  assert.equal(Object.hasOwn(point, "endedBeforeWorkerAssignment"), false);
  assert.equal(durationPoint(rows).value, 3 * 60_000, "the run's duration is counted as before");
});

test("W1-T12154 criterion 4: an older infrastructure-refused verdict of a run whose assignment was seen is counted as before", () => {
  const rows: Row[] = [
    { ts: "2026-11-10T01:00:00.000Z", run_id: "W1-T1-7", step: "run.start", type: "implement" },
    { ts: "2026-11-10T01:01:00.000Z", run_id: "W1-T1-7", step: "worker.assignment", worker_assignment: ASSIGNMENT },
    { ts: "2026-11-10T01:05:00.000Z", run_id: "W1-T1-7", step: "verdict", verdict: "blocked_transient", stage: "implement" },
  ];
  const point = runsCompletedPoint(rows);
  assert.equal(point.value, 1);
  assert.equal(Object.hasOwn(point, "endedBeforeWorkerAssignment"), false);
  assert.equal(endedBeforeWorkerAssignment(rows[2]!, true), false);
});

test("W1-T12154 criterion 4: a run that is not an implement run writes no field", () => {
  const { log, rows } = runLogger("W1-T1-8", DAY_START);
  log("run.start", { type: "research" });
  log("verdict", { verdict: "failed", stage: "run.error", reason: "boom" });
  assert.equal(Object.hasOwn(verdictOf(rows), "worker_assigned"), false);
  assert.equal(runsCompletedPoint(rows).value, 1);
});
