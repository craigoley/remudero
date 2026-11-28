/**
 * W1-T12154 — an implement run that ends before a worker is assigned records why.
 *
 * MEASURED 2026-11-10: 600 of 1,030 implement runs in the core ledger ended with no worker assignment, and no row
 * said why. The run's ledger writer (run-task.ts `benchmarkRunLedgerLogger`) now stamps such a verdict with
 * `worker_assigned: false` and the last stage the run reached; `endedBeforeWorkerAssignment` is the one shared test
 * for such a run, and the analytics time series counts it apart from completed runs and durations.
 */
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { scanAnalyticsLedger, type AnalyticsCheckpoint, type AnalyticsSnapshotReadResult } from "#src/lib/analytics-route.js";
import { buildAnalyticsTimeSeries } from "#src/lib/analytics-timeseries.js";
import { fixedClock } from "#src/lib/clock.js";
import { bootSweepDispatchClaimsAsync, dispatchClaimRef } from "#src/lib/dispatch-claim.js";
import { appendLedger } from "#src/lib/ledger.js";
import { endedBeforeWorkerAssignment } from "#src/lib/non-worker-verdict.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { benchmarkRunLedgerLogger } from "#test/helpers/run-task-test.js";
import {
  TASK, RUN_ID, DEAD_PID, LOCAL, MINT_ISO, FIXED_HOST_PROBE, anchorMessage, fakeReserver, instance, orphanVerdicts,
} from "#test/helpers/restart-orphan.js";

type Row = Record<string, unknown>;

const ASSIGNMENT = {
  id: "assignment-1",
  requested: { provider: "anthropic", model: "claude-opus-5-5" },
  selected: { provider: "anthropic", model: "claude-opus-5-5" },
};

const NOW = "2026-11-10T12:00:00.000Z";
const DAY_START = Date.parse("2026-11-10T01:00:00.000Z");

/** One run's rows through the real logger, each stamped with the run id and a clock a minute apart. */
function runLog(runId: string, startMs = DAY_START): { log: (step: string, extra?: Row) => void; rows: Row[] } {
  const rows: Row[] = [];
  let at = startMs;
  const log = benchmarkRunLedgerLogger((step, fields) => {
    rows.push({ ts: new Date(at).toISOString(), run_id: runId, task_id: "W1-T1", step, ...fields });
    at += 60_000;
  });
  return { log, rows };
}

/** A run that assigned a worker and ended `failed` ten minutes after its start. */
function assignedRun(runId: string, startMs = DAY_START): Row[] {
  const { log, rows } = runLog(runId, startMs);
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("worker.assignment", { worker_assignment: ASSIGNMENT });
  log("verdict", { verdict: "failed", stage: "run.error", reason: "boom" });
  return rows;
}

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
  assert.equal(verdict.worker_assigned, false, "the boot sweep's own row records that no worker was assigned");
  assert.equal(verdict.last_stage, "dispatch.claim", "with no phase, the last row the run wrote is its last stage");
  assert.equal(verdict.last_step, "dispatch.claim");
  assert.equal(endedBeforeWorkerAssignment(verdict), true, "the row alone answers, with the run's rows unseen");
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
  for (const field of ["worker_assigned", "last_stage", "last_step"]) assert.equal(field in verdict, false, `no ${field}`);
  assert.equal(endedBeforeWorkerAssignment(verdict), false);
  assert.equal(endedBeforeWorkerAssignment(verdict, true), false);
  const completed = pointOf(node.rows(), "runs.completed", String(verdict.ts));
  assert.equal(completed.value, 1);
  assert.equal(completed.note, undefined);
});

/** The orphan's own rows: its start, its claim and the phase it reached, then (optionally) the worker it assigned. */
function orphanRows(assigned: boolean): Row[] {
  return [
    { ts: "1999-12-31T23:59:59.000Z", run_id: RUN_ID, task_id: TASK, step: "run.start", host: LOCAL },
    { ts: "2000-01-01T00:00:00.500Z", run_id: RUN_ID, task_id: TASK, step: "dispatch.claim", host: LOCAL, actor: "run_child",
      ref: dispatchClaimRef(TASK), outcome: "created" },
    { ts: "2000-01-01T00:00:01.000Z", run_id: RUN_ID, task_id: TASK, step: "run.phase", waiting_on: "recon" },
    ...(assigned ? [{ ts: "2000-01-01T00:00:02.000Z", run_id: RUN_ID, task_id: TASK, step: "worker.assignment", worker_assignment: ASSIGNMENT }] : []),
  ];
}

/** The daemon's own boot (daemon.ts): the awaited sweep, writing through the daemon's plain ledger log. */
async function daemonBootSweep(t: TestContext, seed: Row[]): Promise<Row[]> {
  const stateDir = makeTempDir("unassigned-orphan");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledger = join(stateDir, "ledger.ndjson");
  writeFileSync(ledger, seed.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const lockIso = new Date().toISOString();
  await bootSweepDispatchClaimsAsync(fakeReserver({ [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO) }), {
    hostProbe: FIXED_HOST_PROBE,
    lockHeldSinceMs: Date.parse(lockIso),
    lockHeldSinceIso: lockIso,
    stateDir,
    log: (step, fields) => appendLedger(ledger, { run_id: "DAEMON-1", task_id: "DAEMON", step, lane: "daemon", ...fields }),
  });
  return readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

test("W1-T12154 criterion 2: the daemon's boot sweep writes the same record on an unassigned orphan's verdict row", async (t) => {
  const rows = await daemonBootSweep(t, orphanRows(false));
  const [verdict] = orphanVerdicts(rows);
  assert.ok(verdict, "the daemon's boot sweep ended the orphaned run");
  assert.equal(verdict.run_id, RUN_ID, "the verdict is the orphan's own, not the daemon's");
  assert.equal(verdict.worker_assigned, false);
  assert.equal(verdict.last_stage, "recon", "the last phase the run reached, as a run's own verdict names it");
  assert.equal(verdict.last_step, "run.phase");
  assert.equal(endedBeforeWorkerAssignment(verdict), true, "the row alone answers, as a stamped run verdict does");
  // The sync sweep writes the same record.
  const node = instance(t, orphanRows(false));
  node.boot(fakeReserver({ [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO) }));
  const [synced] = orphanVerdicts(node.rows());
  assert.deepEqual([synced?.worker_assigned, synced?.last_stage, synced?.last_step], [false, "recon", "run.phase"]);
});

test("W1-T12154 criterion 2: the daemon's boot sweep stamps nothing on an orphan that had assigned a worker", async (t) => {
  const [verdict] = orphanVerdicts(await daemonBootSweep(t, orphanRows(true)));
  assert.ok(verdict, "the daemon's boot sweep ended the orphaned run");
  for (const field of ["worker_assigned", "last_stage", "last_step"]) assert.equal(field in verdict, false, `no ${field}`);
  assert.equal(endedBeforeWorkerAssignment(verdict), false);
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

const SCAN_CLOCK = fixedClock(Date.parse(NOW));

function ledgerDir(t: TestContext, rows: Row[]): { dir: string; append: (more: Row[]) => void } {
  const dir = makeTempDir("unassigned-analytics");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = join(dir, "ledger.ndjson");
  writeFileSync(ledger, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return { dir, append: (more) => appendFileSync(ledger, more.map((row) => `${JSON.stringify(row)}\n`).join("")) };
}

async function scan(dir: string, prior?: AnalyticsCheckpoint): Promise<AnalyticsSnapshotReadResult> {
  const result = await scanAnalyticsLedger(dir, SCAN_CLOCK, undefined, prior);
  assert.ok("checkpoint" in result, "the scan finished");
  return result as AnalyticsSnapshotReadResult;
}

function seriesPoint(result: AnalyticsSnapshotReadResult, id: string): Row {
  const point = result.snapshot.timeSeries.find((s) => s.id === id)?.points.find((p) => p.t.startsWith(NOW.slice(0, 10)));
  assert.ok(point, `the ${id} window holds ${NOW.slice(0, 10)}`);
  return point as Row;
}

/** A run that wrote no worker.assignment, through the real run logger. */
function unassignedRun(runId: string, startMs: number): Row[] {
  const { log, rows } = runLog(runId, startMs);
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("verdict", { verdict: "failed", stage: "run.error", reason: "boom" });
  return rows;
}

test("W1-T12154 criterion 3: a checkpoint-resumed analytics scan leaves such a run out of completed runs and durations", async (t) => {
  const corpus = ledgerDir(t, [...assignedRun("W1-T1-10"), ...unassignedRun("W1-T1-11", DAY_START + 3_600_000)]);
  const full = await scan(corpus.dir);
  assert.equal(full.scan?.mode, "full");
  const resumed = await scan(corpus.dir, JSON.parse(JSON.stringify(full.checkpoint)) as AnalyticsCheckpoint);
  assert.equal(resumed.scan?.mode, "resume", "the second scan resumed from the first one's checkpoint");
  for (const result of [full, resumed]) {
    const completed = seriesPoint(result, "runs.completed");
    assert.equal(completed.value, 1, `${result.scan?.mode}: only the run that assigned a worker completed`);
    assert.equal(completed.note, "1 ended before a worker was assigned; not counted as completed");
    assert.equal(seriesPoint(result, "duration.p50.ms").value, 3 * 60_000, `${result.scan?.mode}: the assigned run's alone`);
  }
  // A second unassigned run lands after the checkpoint: the resumed scan counts it apart too.
  corpus.append(unassignedRun("W1-T1-12", DAY_START + 7_200_000));
  const later = await scan(corpus.dir, JSON.parse(JSON.stringify(resumed.checkpoint)) as AnalyticsCheckpoint);
  assert.equal(later.scan?.mode, "resume");
  assert.equal(seriesPoint(later, "runs.completed").value, 1);
  assert.equal(seriesPoint(later, "runs.completed").note, "2 ended before a worker was assigned; not counted as completed");
  assert.equal(seriesPoint(later, "duration.p50.ms").value, 3 * 60_000);
});

test("W1-T12154 criterion 3: a resumed scan folds an unstamped orphan verdict exactly as one full pass does", async (t) => {
  // Two runs reach the checkpoint without verdicts; only one had assigned a worker. Both are ended after it by an
  // older boot sweep's unstamped orphan verdict, so the answer rests on what the run's own rows held.
  const start = (runId: string): Row => ({ ts: "2026-11-10T02:00:00.000Z", run_id: runId, task_id: "W1-T1", step: "run.start" });
  const orphan = (runId: string): Row => ({ ts: "2026-11-10T03:00:00.000Z", run_id: runId, task_id: "W1-T1", step: "verdict",
    verdict: "handed_off", reason: "orphaned-by-restart", surface: "boot-sweep" });
  const corpus = ledgerDir(t, [start("W1-T1-13"), start("W1-T1-14"),
    { ts: "2026-11-10T02:01:00.000Z", run_id: "W1-T1-14", task_id: "W1-T1", step: "worker.assignment", worker_assignment: ASSIGNMENT }]);
  const checkpoint = (await scan(corpus.dir)).checkpoint;
  corpus.append([orphan("W1-T1-13"), orphan("W1-T1-14")]);
  const resumed = await scan(corpus.dir, JSON.parse(JSON.stringify(checkpoint)) as AnalyticsCheckpoint);
  assert.equal(resumed.scan?.mode, "resume");
  const onePass = await scan(corpus.dir);
  assert.equal(onePass.scan?.mode, "full");
  const onePassCompleted = seriesPoint(onePass, "runs.completed");
  assert.equal(onePassCompleted.value, 1, "positive control: one pass counts only the assigned orphan as completed");
  assert.equal(onePassCompleted.note, "1 ended before a worker was assigned; not counted as completed");
  for (const id of ["runs.completed", "duration.p50.ms"]) assert.deepEqual(seriesPoint(resumed, id), seriesPoint(onePass, id), id);
});

test("W1-T12154 criterion 3: a checkpoint written before the assigned runs were kept does not presume an orphan unassigned", async (t) => {
  const corpus = ledgerDir(t, [{ ts: "2026-11-10T02:00:00.000Z", run_id: "W1-T1-15", task_id: "W1-T1", step: "run.start" },
    { ts: "2026-11-10T02:01:00.000Z", run_id: "W1-T1-15", task_id: "W1-T1", step: "worker.assignment", worker_assignment: ASSIGNMENT }]);
  const checkpoint = JSON.parse(JSON.stringify((await scan(corpus.dir)).checkpoint)) as AnalyticsCheckpoint;
  assert.deepEqual(checkpoint.state.history.assigned, ["W1-T1-15"], "positive control: this version keeps the assigned runs");
  delete checkpoint.state.history.assigned;
  corpus.append([{ ts: "2026-11-10T03:00:00.000Z", run_id: "W1-T1-15", task_id: "W1-T1", step: "verdict",
    verdict: "handed_off", reason: "orphaned-by-restart", surface: "boot-sweep" }]);
  const resumed = await scan(corpus.dir, checkpoint);
  assert.equal(resumed.scan?.mode, "resume");
  const completed = seriesPoint(resumed, "runs.completed");
  assert.equal(completed.value, 1, "the run's assignment sits before the older checkpoint, unseen: it is not presumed absent");
  assert.equal(completed.note, undefined);
  // A stamped verdict needs no sight of the run's rows: it answers alone on the same older checkpoint.
  const stamped = ledgerDir(t, [{ ts: "2026-11-10T02:00:00.000Z", run_id: "W1-T1-16", task_id: "W1-T1", step: "run.start" }]);
  const older = JSON.parse(JSON.stringify((await scan(stamped.dir)).checkpoint)) as AnalyticsCheckpoint;
  delete older.state.history.assigned;
  stamped.append([{ ts: "2026-11-10T03:00:00.000Z", run_id: "W1-T1-16", task_id: "W1-T1", step: "verdict",
    verdict: "handed_off", reason: "orphaned-by-restart", worker_assigned: false, last_stage: "recon", last_step: "run.phase" }]);
  const after = await scan(stamped.dir, older);
  assert.equal(seriesPoint(after, "runs.completed").value, 0);
  assert.equal(seriesPoint(after, "runs.completed").note, "1 ended before a worker was assigned; not counted as completed");
});
