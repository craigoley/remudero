/**
 * W1-T12154 — an implement run that ends before a worker is assigned records why.
 *
 * MEASURED 2026-11-10: 600 of 1,030 implement runs in the core ledger ended with no worker assignment, and no row
 * said why. The run's ledger writer (run-task.ts `benchmarkRunLedgerLogger`) now stamps such a verdict with
 * `worker_assigned: false` and the last stage the run reached; `endedBeforeWorkerAssignment` is the one shared test
 * for such a run, and the analytics time series counts it apart from completed runs and durations.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAnalyticsTimeSeries } from "#src/lib/analytics-timeseries.js";
import { dispatchClaimRef } from "#src/lib/dispatch-claim.js";
import { endedBeforeWorkerAssignment } from "#src/lib/non-worker-verdict.js";
import { assignedRun, benchmarkRunLedgerLogger, runLog } from "#test/dispatch/implement-run-fixtures.js";
import {
  TASK, RUN_ID, DEAD_PID, LOCAL, MINT_ISO, anchorMessage, fakeReserver, instance, orphanVerdicts,
} from "#test/helpers/restart-orphan.js";

type Row = Record<string, unknown>;

const ASSIGNMENT = {
  id: "assignment-1",
  requested: { provider: "anthropic", model: "claude-opus-5-5" },
  selected: { provider: "anthropic", model: "claude-opus-5-5" },
};

const NOW = "2026-11-10T12:00:00.000Z";
const DAY_START = Date.parse("2026-11-10T01:00:00.000Z");

function verdictOf(rows: Row[]): Row {
  const verdict = rows.find((row) => row.step === "verdict");
  assert.ok(verdict, "the run wrote its verdict");
  return verdict;
}

function pointOf(rows: Row[], id: string, nowIso = NOW): Row {
  const day = nowIso.slice(0, 10);
  const point = buildAnalyticsTimeSeries(rows, nowIso).find((s) => s.id === id)?.points.find((p) => p.t.startsWith(day));
  assert.ok(point, `the ${id} window holds ${day}`);
  return point as Row;
}

test("W1-T12154 criterion 1: a run that wrote no worker.assignment row records no worker was assigned and its last stage", () => {
  const { log, rows } = runLog("W1-T1-1");
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("worktree.created", { path: "/tmp/w" });
  log("verdict", { verdict: "failed", stage: "run.error", reason: "boom" });
  const verdict = verdictOf(rows);
  assert.equal(verdict.worker_assigned, false);
  assert.equal(verdict.last_stage, "recon", "the generic thrown run.error stage yields to the last phase reached");
  assert.equal(verdict.last_step, "worktree.created");
  assert.equal(verdict.verdict, "failed", "the verdict's own fields are kept");
  assert.equal(verdict.stage, "run.error");
  assert.equal(endedBeforeWorkerAssignment(verdict), true);
});

test("W1-T12154 criterion 1: a verdict that names its own stage records that stage as the last one reached", () => {
  const { log, rows } = runLog("W1-T1-2");
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("verdict", { verdict: "failed", stage: "managed_checkout.refresh", reason: "lock held" });
  const verdict = verdictOf(rows);
  assert.equal(verdict.worker_assigned, false);
  assert.equal(verdict.last_stage, "managed_checkout.refresh");
  assert.equal(verdict.last_step, "run.phase");
});

test("W1-T12154 criterion 1: with no phase and no stage the last step written is the last stage reached", () => {
  const { log, rows } = runLog("W1-T1-3");
  log("run.start", { type: "implement" });
  log("verdict", { verdict: "blocked_transient", reason: "inflight" });
  assert.equal(verdictOf(rows).last_stage, "run.start");
  const lone = runLog("W1-T1-4");
  lone.log("verdict", { verdict: "task_already_merged" });
  assert.equal(verdictOf(lone.rows).worker_assigned, false);
  assert.equal(verdictOf(lone.rows).last_stage, "none", "a verdict with nothing before it says so");
  assert.equal(verdictOf(lone.rows).last_step, "none");
});

test("W1-T12154 criterion 1: a row whose write throws is not a stage the run reached", () => {
  const rows: Row[] = [];
  const log = benchmarkRunLedgerLogger((step, fields) => {
    if (step === "run.phase") throw new Error("ledger full");
    rows.push({ step, ...fields });
  });
  log("run.start", { type: "implement" });
  assert.throws(() => log("run.phase", { waiting_on: "recon" }), /ledger full/);
  log("verdict", { verdict: "failed", stage: "run.error" });
  assert.equal(verdictOf(rows).last_stage, "run.start");
});

test("W1-T12154 criterion 2: a run found orphaned with no assignment is read as ended before a worker was assigned", (t) => {
  // The real boot sweep ends a run its daemon restarted under; this run wrote its start and its claim, no worker.
  const runRows: Row[] = [
    { ts: "1999-12-31T23:59:59.000Z", run_id: RUN_ID, task_id: TASK, step: "run.start", host: LOCAL },
    { ts: "2000-01-01T00:00:00.500Z", run_id: RUN_ID, task_id: TASK, step: "dispatch.claim", host: LOCAL, actor: "run_child",
      ref: dispatchClaimRef(TASK), outcome: "created" },
  ];
  const node = instance(t, runRows);
  node.boot(fakeReserver({ [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO) }));
  const [verdict] = orphanVerdicts(node.rows());
  assert.ok(verdict, "the boot sweep ended the orphaned run");
  assert.equal(verdict.verdict, "handed_off");
  assert.equal(endedBeforeWorkerAssignment(verdict, false), true, "the run's rows hold no worker.assignment");
  assert.equal(endedBeforeWorkerAssignment(verdict), false, "with the run's rows unseen the orphan is not presumed");
  // The same record the analytics series keeps for a stamped run: counted apart, never completed.
  const nowIso = String(verdict.ts);
  const completed = pointOf(node.rows(), "runs.completed", nowIso);
  assert.equal(completed.value, 0);
  assert.match(String(completed.note), /^1 ended before a worker was assigned/);
  assert.equal(pointOf(node.rows(), "duration.p50.ms", nowIso).gap, true);
});

test("W1-T12154 criterion 2: an orphaned run that had assigned a worker is not read as unassigned", (t) => {
  const runRows: Row[] = [
    { ts: "1999-12-31T23:59:59.000Z", run_id: RUN_ID, task_id: TASK, step: "run.start", host: LOCAL },
    { ts: "2000-01-01T00:00:00.500Z", run_id: RUN_ID, task_id: TASK, step: "dispatch.claim", host: LOCAL, actor: "run_child",
      ref: dispatchClaimRef(TASK), outcome: "created" },
    { ts: "2000-01-01T00:00:01.000Z", run_id: RUN_ID, task_id: TASK, step: "worker.assignment", worker_assignment: ASSIGNMENT },
  ];
  const node = instance(t, runRows);
  node.boot(fakeReserver({ [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO) }));
  const [verdict] = orphanVerdicts(node.rows());
  assert.ok(verdict, "the boot sweep ended the orphaned run");
  assert.equal(endedBeforeWorkerAssignment(verdict, true), false);
  const completed = pointOf(node.rows(), "runs.completed", String(verdict.ts));
  assert.equal(completed.value, 1);
  assert.equal(completed.note, undefined);
});

test("W1-T12154 criterion 3: a run with no worker is left out of completed runs and durations, and counted apart", () => {
  const unassigned = runLog("W1-T1-5", DAY_START + 3_600_000);
  unassigned.log("run.start", { type: "implement" });
  unassigned.log("run.phase", { waiting_on: "recon" });
  unassigned.log("verdict", { verdict: "failed", stage: "run.error", reason: "boom" });
  // An older verdict written before the stamp: an infrastructure refusal falls back to the same answer.
  const legacy: Row[] = [
    { ts: "2026-11-10T05:00:00.000Z", run_id: "W1-T1-6", task_id: "W1-T1", step: "run.start" },
    { ts: "2026-11-10T09:00:00.000Z", run_id: "W1-T1-6", task_id: "W1-T1", step: "verdict", verdict: "blocked_containment" },
  ];
  const rows = [...assignedRun("W1-T1-7"), ...unassigned.rows, ...legacy];
  const completed = pointOf(rows, "runs.completed");
  assert.equal(completed.value, 1, "only the run that assigned a worker completed");
  assert.equal(completed.note, "2 ended before a worker was assigned; not counted as completed");
  assert.equal(pointOf(rows, "duration.p50.ms").value, 3 * 60_000, "the median is the assigned run's alone");
});

test("W1-T12154 criterion 4: a run that assigned a worker is stamped with nothing and counted exactly as before", () => {
  const rows = assignedRun("W1-T1-8");
  const verdict = verdictOf(rows);
  for (const field of ["worker_assigned", "last_stage", "last_step"]) assert.equal(field in verdict, false, `no ${field}`);
  assert.equal(endedBeforeWorkerAssignment(verdict), false);
  const completed = pointOf(rows, "runs.completed");
  assert.equal(completed.value, 1);
  assert.equal(completed.note, undefined);
  assert.equal(pointOf(rows, "duration.p50.ms").value, 3 * 60_000);
  // A verdict naming its own assignment (its receipt written by another logger) is a run that assigned a worker.
  const named = runLog("W1-T1-9");
  named.log("run.start", { type: "implement" });
  named.log("verdict", { verdict: "failed", selection_assignment_id: "assignment-2" });
  assert.equal("worker_assigned" in verdictOf(named.rows), false);
  // The reader's own sight of the assignment overrides even a stamped row.
  assert.equal(endedBeforeWorkerAssignment({ verdict: "failed", worker_assigned: false }, true), false);
});
