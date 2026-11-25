import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkRunLedgerLogger } from "#src/run-task.js";
import { endedBeforeWorkerAssignment } from "#src/lib/non-worker-verdict.js";
import { createHistoricalSeriesAccumulator } from "#src/lib/analytics-timeseries.js";

const DAY = "2026-11-06";
const NOW = `${DAY}T23:00:00.000Z`;

const ASSIGNMENT = {
  id: "assignment-1", requested: { model: "m-requested", effort: "high" },
  selected: { provider: "codex", model: "m-selected", effort: "high" },
};

/** One run's rows as its ledger would hold them, each stamped a minute after the last. */
function runRows(runId: string, startMinute: number, drive: (log: (step: string, extra?: Record<string, unknown>) => void) => void) {
  const rows: Array<Record<string, unknown>> = [];
  let minute = startMinute;
  const log = benchmarkRunLedgerLogger((step, fields) => {
    const ts = new Date(Date.parse(`${DAY}T00:00:00.000Z`) + minute++ * 60_000).toISOString();
    rows.push({ ts, run_id: runId, task_id: "T-FIXTURE", step, ...fields });
  });
  drive(log);
  return rows;
}

const verdictOf = (rows: Array<Record<string, unknown>>) => rows.find((row) => row.step === "verdict")!;

function seriesValue(rows: Iterable<Record<string, unknown>>, id: string) {
  const accumulator = createHistoricalSeriesAccumulator();
  for (const row of rows) accumulator.add(row);
  const point = accumulator.build(NOW).find((series) => series.id === id)!.points.at(-1)!;
  return { value: point.value, apart: accumulator.runsBeforeWorkerAssignment() };
}

test("W1-T12154 criterion 1: the verdict row of a run that wrote no worker.assignment row records that no worker was assigned and names the last stage the run reached", () => {
  const phased = verdictOf(runRows("run-phased", 0, (log) => {
    log("run.start", {});
    log("run.phase", { waiting_on: "recon" });
    log("verdict", { verdict: "no_pr", reason: "worker_never_started" });
  }));
  assert.equal(phased.worker_assigned, false);
  assert.equal(phased.last_stage, "recon");
  assert.equal(endedBeforeWorkerAssignment(phased), true);

  const staged = verdictOf(runRows("run-staged", 10, (log) => {
    log("run.start", {});
    log("run.phase", { waiting_on: "recon" });
    log("preflight.refused", { stage: "worktree.node_modules" });
    log("verdict", { verdict: "failed", stage: "run.error" });
  }));
  assert.equal(staged.worker_assigned, false);
  assert.equal(staged.last_stage, "worktree.node_modules", "the newest row's stage wins over an earlier phase");

  const bare = verdictOf(runRows("run-bare", 20, (log) => {
    log("run.start", {});
    log("verdict", { verdict: "no_pr" });
  }));
  assert.equal(bare.last_stage, "run.start", "a row with no phase or stage names its own step");

  const silent = verdictOf(runRows("run-silent", 30, (log) => log("verdict", { verdict: "no_pr" })));
  assert.equal(silent.last_stage, "none");
});

test("W1-T12154 criterion 3: the time series leaves a run with no worker out of completed runs and durations, and counts it apart", () => {
  const unassigned = runRows("run-unassigned", 0, (log) => {
    log("run.start", {});
    log("run.phase", { waiting_on: "recon" });
    log("verdict", { verdict: "no_pr" });
  });
  // A row written before W1-T12154 carries no field; an infrastructure refusal verdict still counts apart.
  const older = [
    { ts: `${DAY}T01:00:00.000Z`, run_id: "run-older", step: "run.start" },
    { ts: `${DAY}T01:05:00.000Z`, run_id: "run-older", step: "verdict", verdict: "blocked_transient" },
  ];
  const rows = [...unassigned, ...older];
  assert.equal(seriesValue(rows, "runs.completed").value, 0);
  const duration = seriesValue(rows, "duration.p50.ms");
  assert.equal(duration.value, null, "no duration is measured for a run no worker ran");
  assert.deepEqual(duration.apart, { [DAY]: 2 });

  // An older failed verdict that is no infrastructure refusal is not guessed to be one.
  const olderFailure = [
    { ts: `${DAY}T02:00:00.000Z`, run_id: "run-older-failure", step: "run.start" },
    { ts: `${DAY}T02:05:00.000Z`, run_id: "run-older-failure", step: "verdict", verdict: "failed", stage: "implement" },
  ];
  assert.equal(endedBeforeWorkerAssignment(olderFailure[1]!), false);
  assert.equal(seriesValue(olderFailure, "runs.completed").value, 1);
  assert.deepEqual(seriesValue(olderFailure, "runs.completed").apart, {});
});

test("W1-T12154 criterion 4: a run that assigned a worker is counted exactly as before", () => {
  const assigned = runRows("run-assigned", 0, (log) => {
    log("run.start", {});
    log("run.phase", { waiting_on: "implement" });
    log("worker.assignment", { worker_assignment: ASSIGNMENT });
    log("verdict", { verdict: "pr_opened", selection_assignment_id: ASSIGNMENT.id });
  });
  const verdict = verdictOf(assigned);
  assert.equal("worker_assigned" in verdict, false, "a run with an assignment gains no new field");
  assert.equal("last_stage" in verdict, false);
  assert.equal(endedBeforeWorkerAssignment(verdict), false);
  assert.equal(seriesValue(assigned, "runs.completed").value, 1);
  assert.equal(seriesValue(assigned, "duration.p50.ms").value, 3 * 60_000);
  assert.deepEqual(seriesValue(assigned, "runs.completed").apart, {});

  // Its own assignment row keeps a run counted, even with a verdict the older-row fallback would set apart.
  const refusedAfterAssignment = [
    { ts: `${DAY}T03:00:00.000Z`, run_id: "run-late-refusal", step: "run.start" },
    { ts: `${DAY}T03:01:00.000Z`, run_id: "run-late-refusal", step: "worker.assignment" },
    { ts: `${DAY}T03:04:00.000Z`, run_id: "run-late-refusal", step: "verdict", verdict: "blocked_transient" },
  ];
  assert.equal(seriesValue(refusedAfterAssignment, "runs.completed").value, 1);
  assert.equal(seriesValue(refusedAfterAssignment, "duration.p50.ms").value, 4 * 60_000);
  assert.deepEqual(seriesValue(refusedAfterAssignment, "runs.completed").apart, {});
});
