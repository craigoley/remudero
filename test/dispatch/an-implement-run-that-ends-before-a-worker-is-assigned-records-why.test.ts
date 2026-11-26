/**
 * W1-T12154 — an implement run that ends before a worker is assigned records why.
 *
 * MEASURED 2026-11-10: 600 of 1,030 implement runs in the core ledger ended with no worker assignment, and no row
 * said why. A run's ledger writer (`recordUnassignedRunVerdict`, which run-task.ts `benchmarkRunLedgerLogger`
 * writes through) now stamps such a run's verdict with `worker_assigned: false` and the last stage it reached, and
 * the analytics time series counts the run apart from completed runs and durations.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAnalyticsTimeSeries } from "#src/lib/analytics-timeseries.js";
import { endedBeforeWorkerAssignment, recordUnassignedRunVerdict } from "#src/lib/non-worker-verdict.js";

type Row = Record<string, unknown>;

/** One run's rows through the stamping writer, each stamped with the run id and a clock that advances a minute. */
function runLog(runId: string, startMs: number): { log: (step: string, extra?: Row) => void; rows: Row[] } {
  const rows: Row[] = [];
  let at = startMs;
  const write = recordUnassignedRunVerdict((step, fields) => {
    rows.push({ ts: new Date(at).toISOString(), run_id: runId, task_id: "W1-T1", step, ...fields });
    at += 60_000;
  });
  return { log: (step, extra = {}) => write(step, extra), rows };
}

const ASSIGNMENT = {
  id: "assignment-1",
  requested: { provider: "anthropic", model: "claude-opus-5-5" },
  selected: { provider: "anthropic", model: "claude-opus-5-5" },
};

const NOW = "2026-11-10T12:00:00.000Z";
const DAY_START = Date.parse("2026-11-10T01:00:00.000Z");

function pointOf(rows: Row[], id: string): Row {
  const point = buildAnalyticsTimeSeries(rows, NOW).find((s) => s.id === id)?.points.find((p) => p.t.startsWith("2026-11-10"));
  assert.ok(point, `the ${id} window holds the run's day`);
  return point as Row;
}

function verdictOf(rows: Row[]): Row {
  const verdict = rows.find((row) => row.step === "verdict");
  assert.ok(verdict, "the run wrote its verdict");
  return verdict;
}

test("W1-T12154 criterion 1: a run that wrote no worker.assignment row records no worker was assigned and its last phase", () => {
  const { log, rows } = runLog("W1-T1-1", DAY_START);
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("worktree.created", { path: "/tmp/w" });
  log("verdict", { verdict: "failed", stage: "run.error", reason: "boom" });
  const verdict = verdictOf(rows);
  assert.equal(verdict.worker_assigned, false);
  assert.equal(verdict.last_stage, "recon", "the generic run.error stage yields to the last phase the run reached");
  assert.equal(verdict.last_step, "worktree.created");
  assert.equal(verdict.verdict, "failed", "the verdict's own fields are kept");
  assert.equal(verdict.stage, "run.error");
  assert.equal(endedBeforeWorkerAssignment(verdict), true);
});

test("W1-T12154 criterion 1: a verdict naming its own stage records that stage as the last one reached", () => {
  const { log, rows } = runLog("W1-T1-2", DAY_START);
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("verdict", { verdict: "failed", stage: "managed_checkout.refresh", reason: "lock held" });
  assert.equal(verdictOf(rows).worker_assigned, false);
  assert.equal(verdictOf(rows).last_stage, "managed_checkout.refresh");
  assert.equal(verdictOf(rows).last_step, "run.phase");
});

test("W1-T12154 criterion 1: a row's stage after the last phase is the last stage reached", () => {
  const { log, rows } = runLog("W1-T1-3", DAY_START);
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("preflight.refused", { stage: "preflight.isolation" });
  log("run.phase", { waiting_on: "" });
  log("verdict", { verdict: "blocked_isolation" });
  assert.equal(verdictOf(rows).last_stage, "preflight.isolation", "an empty phase names nothing and keeps the stage before it");
});

test("W1-T12154 criterion 1: with no phase or stage written, the last stage is the last step the run wrote", () => {
  const { log, rows } = runLog("W1-T1-4", DAY_START);
  log("run.start", { type: "implement" });
  log("preflight.started", {});
  log("verdict", { verdict: "blocked_toolchain" });
  assert.equal(verdictOf(rows).worker_assigned, false);
  assert.equal(verdictOf(rows).last_stage, "preflight.started");
});

test("W1-T12154 criterion 1: a worker.assignment write that threw is no assignment, so the verdict is still stamped", () => {
  const rows: Row[] = [];
  const write = recordUnassignedRunVerdict((step, fields) => {
    if (step === "worker.assignment") throw new Error("ENOSPC");
    rows.push({ step, ...fields });
  });
  write("run.start", { type: "implement" });
  assert.throws(() => write("worker.assignment", { worker_assignment: ASSIGNMENT }), /ENOSPC/);
  write("verdict", { verdict: "failed", stage: "run.error" });
  assert.equal(verdictOf(rows).worker_assigned, false);
  assert.equal(verdictOf(rows).last_stage, "run.start", "the throwing row was never written, so it is not the last step");
});

test("W1-T12154 criterion 3: a run that ended before a worker was assigned is counted apart, not as a completed run or a duration", () => {
  const { log, rows } = runLog("W1-T1-5", DAY_START);
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("verdict", { verdict: "failed", stage: "run.error", reason: "boom" });
  const point = pointOf(rows, "runs.completed");
  assert.equal(point.value, 0, "the run is not a completed run");
  assert.equal(point.endedBeforeWorkerAssignment, 1, "the run is counted apart");
  assert.equal(pointOf(rows, "duration.p50.ms").gap, true, "the run adds no duration");
});

test("W1-T12154 criterion 3: an older verdict without the field falls back to its infrastructure refusal", () => {
  const rows: Row[] = [
    { ts: "2026-11-10T01:00:00.000Z", run_id: "W1-T1-6", step: "run.start", type: "implement" },
    { ts: "2026-11-10T01:05:00.000Z", run_id: "W1-T1-6", step: "verdict", verdict: "blocked_isolation" },
  ];
  const point = pointOf(rows, "runs.completed");
  assert.equal(point.value, 0);
  assert.equal(point.endedBeforeWorkerAssignment, 1);
  assert.equal(endedBeforeWorkerAssignment(rows[1]!), true);
});

test("W1-T12154 criterion 3: a restart-orphaned run's handed_off verdict with no assignment seen is counted apart", () => {
  const rows: Row[] = [
    { ts: "2026-11-10T01:00:00.000Z", run_id: "W1-T1-7", step: "run.start", type: "implement" },
    { ts: "2026-11-10T02:00:00.000Z", run_id: "W1-T1-7", task_id: "W1-T1", step: "verdict", verdict: "handed_off",
      reason: "orphaned-by-restart", surface: "boot-sweep" },
  ];
  const point = pointOf(rows, "runs.completed");
  assert.equal(point.value, 0);
  assert.equal(point.endedBeforeWorkerAssignment, 1);
  assert.equal(endedBeforeWorkerAssignment(rows[1]!), true);
  assert.equal(endedBeforeWorkerAssignment({ verdict: "handed_off", reason: "freshness_yield" }), false, "only the orphan reason");
});

test("W1-T12154 criterion 4: a run that assigned a worker writes no field and is counted as a completed run", () => {
  const { log, rows } = runLog("W1-T1-8", DAY_START);
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("worker.assignment", { worker_assignment: ASSIGNMENT });
  log("verdict", { verdict: "failed", stage: "run.error", reason: "boom" });
  const verdict = verdictOf(rows);
  for (const field of ["worker_assigned", "last_stage", "last_step"]) assert.equal(Object.hasOwn(verdict, field), false, field);
  const point = pointOf(rows, "runs.completed");
  assert.equal(point.value, 1);
  assert.equal(Object.hasOwn(point, "endedBeforeWorkerAssignment"), false);
  assert.equal(pointOf(rows, "duration.p50.ms").value, 3 * 60_000, "the run's duration is counted as before");
});

test("W1-T12154 criterion 4: an infrastructure-refused or orphaned verdict of a run whose assignment was seen is counted as before", () => {
  const rows: Row[] = [
    { ts: "2026-11-10T01:00:00.000Z", run_id: "W1-T1-9", step: "run.start", type: "implement" },
    { ts: "2026-11-10T01:01:00.000Z", run_id: "W1-T1-9", step: "worker.assignment", worker_assignment: ASSIGNMENT },
    { ts: "2026-11-10T01:05:00.000Z", run_id: "W1-T1-9", step: "verdict", verdict: "blocked_transient", stage: "implement" },
    { ts: "2026-11-10T03:00:00.000Z", run_id: "W1-T1-10", step: "run.start", type: "implement" },
    { ts: "2026-11-10T03:01:00.000Z", run_id: "W1-T1-10", step: "worker.assignment", worker_assignment: ASSIGNMENT },
    { ts: "2026-11-10T04:00:00.000Z", run_id: "W1-T1-10", step: "verdict", verdict: "handed_off", reason: "orphaned-by-restart" },
  ];
  const point = pointOf(rows, "runs.completed");
  assert.equal(point.value, 2);
  assert.equal(Object.hasOwn(point, "endedBeforeWorkerAssignment"), false);
  assert.equal(endedBeforeWorkerAssignment(rows[2]!, true), false);
  assert.equal(endedBeforeWorkerAssignment({ verdict: "failed", worker_assigned: false }, true), false, "a seen assignment wins over the stamp");
});

test("W1-T12154 criterion 4: a writer that never saw its run.start stamps nothing", () => {
  const rows: Row[] = [];
  const write = recordUnassignedRunVerdict((step, fields) => rows.push({ step, ...fields }));
  write("verdict", { verdict: "failed", stage: "run.error" });
  assert.equal(Object.hasOwn(verdictOf(rows), "worker_assigned"), false);
});

test("W1-T12154 criterion 4: a worker verdict without the field and with no infrastructure refusal is a completed run", () => {
  const rows: Row[] = [
    { ts: "2026-11-10T01:00:00.000Z", run_id: "W1-T1-11", step: "run.start", type: "implement" },
    { ts: "2026-11-10T01:30:00.000Z", run_id: "W1-T1-11", step: "verdict", verdict: "pr_opened" },
  ];
  assert.equal(pointOf(rows, "runs.completed").value, 1);
  assert.equal(pointOf(rows, "duration.p50.ms").value, 30 * 60_000);
  assert.equal(endedBeforeWorkerAssignment(rows[1]!), false);
});
