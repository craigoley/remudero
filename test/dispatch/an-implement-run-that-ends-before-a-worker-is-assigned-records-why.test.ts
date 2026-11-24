import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkRunLedgerLogger } from "#src/run-task.js";
import { endedBeforeWorkerAssignment } from "#src/lib/non-worker-verdict.js";
import { buildAnalyticsTimeSeries } from "#src/lib/analytics-timeseries.js";

type Row = { step: string; fields: Record<string, unknown> };

const ASSIGNMENT = {
  id: "assignment-1", requested: { model: "m-requested", effort: "high" },
  selected: { provider: "codex", model: "m-selected", effort: "medium" },
};

function verdictOf(rows: Row[]): Record<string, unknown> {
  const verdict = rows.find((row) => row.step === "verdict");
  assert.ok(verdict, "the logger wrote the verdict row");
  return verdict.fields;
}

const NOW = "2026-11-10T12:00:00.000Z";

function runsCompletedPoint(lines: Array<Record<string, unknown>>) {
  const series = buildAnalyticsTimeSeries(lines, NOW);
  const completed = series.find((s) => s.id === "runs.completed")!.points.find((p) => p.t === "2026-11-10T00:00:00.000Z")!;
  const duration = series.find((s) => s.id === "duration.p50.ms")!.points.find((p) => p.t === "2026-11-10T00:00:00.000Z")!;
  return { completed, duration };
}

test("W1-T12154 criterion 1: a verdict row with no worker.assignment before it records worker_assigned false and the last stage", () => {
  const rows: Row[] = [];
  const log = benchmarkRunLedgerLogger((step, fields) => rows.push({ step, fields }));
  log("run.start", {});
  log("run.phase", { waiting_on: "recon" });
  log("recon.done", {});
  log("run.phase", { waiting_on: "implement" });
  log("verdict", { verdict: "no_pr", reason: "worker never started" });
  const verdict = verdictOf(rows);
  assert.equal(verdict.worker_assigned, false);
  assert.equal(verdict.last_stage, "implement", "the last run.phase the run reached");

  const staged: Row[] = [];
  const stagedLog = benchmarkRunLedgerLogger((step, fields) => staged.push({ step, fields }));
  stagedLog("run.start", {});
  stagedLog("run.phase", { waiting_on: "recon" });
  stagedLog("verdict", { verdict: "failed", stage: "worktree.node_modules" });
  assert.deepEqual([verdictOf(staged).worker_assigned, verdictOf(staged).last_stage], [false, "worktree.node_modules"],
    "the verdict's own stage is where the run ended");

  const bare: Row[] = [];
  const bareLog = benchmarkRunLedgerLogger((step, fields) => bare.push({ step, fields }));
  bareLog("run.start", {});
  bareLog("verdict", { verdict: "blocked_transient" });
  assert.deepEqual([verdictOf(bare).worker_assigned, verdictOf(bare).last_stage], [false, "run.start"],
    "with no phase and no stage, the last row the run wrote");
});

test("W1-T12154 criterion 3: the time series counts a run that ended before a worker was assigned apart from completed runs and durations", () => {
  assert.equal(endedBeforeWorkerAssignment({ step: "verdict", verdict: "no_pr", worker_assigned: false }), true);
  assert.equal(endedBeforeWorkerAssignment({ step: "verdict", verdict: "blocked_transient" }), true,
    "an older row with no field falls back to the infrastructure refusals");
  assert.equal(endedBeforeWorkerAssignment({ step: "verdict", verdict: "failed", stage: "run.error" }), false);

  const { completed, duration } = runsCompletedPoint([
    { ts: "2026-11-10T01:00:00.000Z", step: "run.start", run_id: "unassigned" },
    { ts: "2026-11-10T01:00:05.000Z", step: "verdict", run_id: "unassigned", verdict: "no_pr", worker_assigned: false, last_stage: "recon" },
    { ts: "2026-11-10T02:00:00.000Z", step: "run.start", run_id: "older" },
    { ts: "2026-11-10T02:00:01.000Z", step: "verdict", run_id: "older", verdict: "blocked_transient" },
    { ts: "2026-11-10T03:00:00.000Z", step: "run.start", run_id: "worked" },
    { ts: "2026-11-10T03:00:01.000Z", step: "worker.assignment", run_id: "worked", worker_assignment: ASSIGNMENT },
    { ts: "2026-11-10T03:10:00.000Z", step: "verdict", run_id: "worked", verdict: "pr_opened" },
  ]);
  assert.equal(completed.value, 1, "only the run that assigned a worker is a completed run");
  assert.equal(completed.endedBeforeWorkerAssignment, 2, "the two runs that never assigned a worker are counted apart");
  assert.equal(duration.value, 600_000, "the 5 s and 1 s runs are not durations");
});

test("W1-T12154 criterion 4: a run that assigned a worker writes no new field and is counted exactly as before", () => {
  const rows: Row[] = [];
  const log = benchmarkRunLedgerLogger((step, fields) => rows.push({ step, fields }));
  log("run.start", {});
  log("run.phase", { waiting_on: "implement" });
  log("worker.assignment", { worker_assignment: ASSIGNMENT });
  log("verdict", { verdict: "blocked_transient", selection_assignment_id: ASSIGNMENT.id });
  const verdict = verdictOf(rows);
  assert.equal("worker_assigned" in verdict, false, "an assigned run's verdict carries no worker_assigned field");
  assert.equal("last_stage" in verdict, false, "nor a last_stage");

  assert.equal(endedBeforeWorkerAssignment({ step: "verdict", verdict: "blocked_transient" }, true), false,
    "an older infrastructure refusal after a seen assignment is not a run that ended before one");
  const { completed, duration } = runsCompletedPoint([
    { ts: "2026-11-10T03:00:00.000Z", step: "run.start", run_id: "worked" },
    { ts: "2026-11-10T03:00:01.000Z", step: "worker.assignment", run_id: "worked", worker_assignment: ASSIGNMENT },
    { ts: "2026-11-10T03:00:30.000Z", step: "verdict", run_id: "worked", verdict: "blocked_transient" },
  ]);
  assert.equal(completed.value, 1);
  assert.equal(duration.value, 30_000);
  assert.equal("endedBeforeWorkerAssignment" in completed, false, "no run counted apart, no field on the point");
});
