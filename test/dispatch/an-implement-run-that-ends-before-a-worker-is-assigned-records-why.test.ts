/**
 * W1-T12154 — AN IMPLEMENT RUN THAT ENDS BEFORE A WORKER IS ASSIGNED RECORDS WHY.
 *
 * MEASURED 2026-11-10 in the core instance's ledger: 600 of 1,030 implement runs ended with no `worker.assignment`
 * row, and no row said why. They sat in every count of runs. The run's own logger now names, on that verdict row,
 * that no worker was assigned and the last stage the run reached; the analytics time series counts such a run
 * apart from its completed runs and their durations.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { benchmarkRunLedgerLogger, runTask } from "#src/run-task.js";
import { createHistoricalSeriesAccumulator } from "#src/lib/analytics-timeseries.js";
import { endedBeforeWorkerAssignment } from "#src/lib/non-worker-verdict.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { Config } from "#src/lib/config.js";
import type { GitHub } from "#src/lib/status.js";
import type { spawnWorker } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type Row = Record<string, unknown>;

const ASSIGNMENT = {
  id: "w1-t12154-assignment", requested: { model: "m-requested", effort: "high" },
  selected: { provider: "codex", model: "m-selected", effort: "medium" },
};

function loggedRows(): { rows: Row[]; log: (step: string, extra?: Row) => void } {
  const rows: Row[] = [];
  const log = benchmarkRunLedgerLogger((step, fields) => rows.push({ step, ...fields }));
  return { rows, log };
}

function seriesValue(series: ReturnType<ReturnType<typeof createHistoricalSeriesAccumulator>["build"]>, id: string, day: string) {
  return series.find((s) => s.id === id)?.points.find((p) => p.t === `${day}T00:00:00.000Z`);
}

test("W1-T12154 criterion 1: a verdict row with no worker.assignment says so and names the last stage reached", () => {
  const { rows, log } = loggedRows();
  log("run.start", { task_class: "src" });
  log("run.phase", { waiting_on: "recon" });
  log("run.phase", { waiting_on: "implement" });
  log("verdict", { verdict: "no_pr", reason: "worker never started" });
  const verdict = rows.find((row) => row.step === "verdict")!;
  assert.equal(verdict.worker_assigned, false);
  assert.equal(verdict.last_stage, "implement");
  assert.equal(endedBeforeWorkerAssignment(verdict), "implement");

  // A thrown run's verdict names its own stage, which outranks the last phase.
  const thrown = loggedRows();
  thrown.log("run.start", {});
  thrown.log("run.phase", { waiting_on: "recon" });
  thrown.log("verdict", { verdict: "failed", stage: "run.error" });
  assert.equal(thrown.rows.at(-1)!.worker_assigned, false);
  assert.equal(thrown.rows.at(-1)!.last_stage, "run.error");

  // With no phase and no stage, the last row the run wrote is the stage it reached.
  const early = loggedRows();
  early.log("run.start", {});
  early.log("lint.blocked", { reason: "ill-formed" });
  early.log("verdict", { verdict: "blocked_illformed" });
  assert.equal(early.rows.at(-1)!.last_stage, "lint.blocked");
});

test("W1-T12154 criterion 1: a real run refused at its containment preflight writes the record on its verdict row", async () => {
  const root = makeTempDir("w1-t12154-run");
  const bare = gitRepo({ bare: true, kind: "w1-t12154-origin" });
  const seed = gitRepo({ kind: "w1-t12154-seed" });
  try {
    seed.addRemote("origin", bare.dir);
    seed.git("push", "--quiet", "origin", "main");
    mkdirSync(join(root, "repos"), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare.dir, join(root, "repos", "remudero")]);
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, `- id: T-W1-T12154
  title: containment refusal fixture
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: fixture
  files: [src/lib/daemon.ts]
  status: queued
`);
    let spawned = 0;
    const spawn = (async () => { spawned++; throw new Error("a containment refusal must never spawn"); }) as typeof spawnWorker;
    const result = await withLiveWritesAllowed(() => runTask("T-W1-T12154", {
      skipGitSync: true, planPath,
      config: { claudeBin: "/bin/true", root, installRoot: process.cwd() } as Config,
      github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined } as GitHub,
      spawn,
      containmentExec: async () => ({ transcript: "wrote outside", outsideWriteCreated: true, insideWriteCreated: true, costUsd: 0 }),
    }));
    assert.equal(result.verdict, "blocked_containment");
    assert.equal(spawned, 0);
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row);
    assert.equal(rows.some((row) => row.step === "worker.assignment"), false);
    const verdict = rows.find((row) => row.step === "verdict");
    assert.ok(verdict, "the run wrote a verdict row");
    assert.equal(verdict.worker_assigned, false);
    assert.equal(typeof verdict.last_stage, "string");
    assert.notEqual(verdict.last_stage, "none", "the run reached a named stage before its verdict");
  } finally {
    rmSync(root, { recursive: true, force: true });
    seed.cleanup();
    bare.cleanup();
  }
});

test("W1-T12154 criterion 3: the time series counts a run with no worker apart from completed runs and durations", () => {
  const day = "2026-11-06";
  const acc = createHistoricalSeriesAccumulator();
  // A run whose verdict says no worker was assigned.
  acc.add({ ts: `${day}T10:00:00.000Z`, step: "run.start", run_id: "R-NONE" });
  acc.add({ ts: `${day}T10:05:00.000Z`, step: "verdict", run_id: "R-NONE", verdict: "no_pr", worker_assigned: false, last_stage: "recon" });
  // An OLDER row with no field: an infrastructure refusal falls back to the shared test.
  acc.add({ ts: `${day}T11:00:00.000Z`, step: "run.start", run_id: "R-OLD" });
  acc.add({ ts: `${day}T11:01:00.000Z`, step: "verdict", run_id: "R-OLD", verdict: "blocked_transient" });
  assert.deepEqual(acc.runCounts(), [{ day, completedRuns: 0, endedBeforeWorkerRuns: 2 }]);
  const series = acc.build(`${day}T23:00:00.000Z`);
  assert.equal(seriesValue(series, "runs.completed", day)?.value, 0);
  assert.equal(seriesValue(series, "duration.p50.ms", day)?.gap, true, "no duration was taken from a run with no worker");
});

test("W1-T12154 criterion 4: a run that assigned a worker carries no new field and is counted exactly as before", () => {
  const { rows, log } = loggedRows();
  log("run.start", { task_class: "src" });
  log("run.phase", { waiting_on: "recon" });
  log("worker.assignment", { worker_assignment: ASSIGNMENT });
  log("verdict", { verdict: "no_pr", selection_assignment_id: ASSIGNMENT.id });
  const verdict = rows.find((row) => row.step === "verdict")!;
  assert.equal("worker_assigned" in verdict, false);
  assert.equal("last_stage" in verdict, false);
  assert.equal(endedBeforeWorkerAssignment(verdict), undefined);

  const day = "2026-11-06";
  const acc = createHistoricalSeriesAccumulator();
  acc.add({ ts: `${day}T10:00:00.000Z`, step: "run.start", run_id: "R-WORKER" });
  acc.add({ ts: `${day}T10:05:00.000Z`, ...verdict, run_id: "R-WORKER" });
  assert.deepEqual(acc.runCounts(), [{ day, completedRuns: 1, endedBeforeWorkerRuns: 0 }]);
  const series = acc.build(`${day}T23:00:00.000Z`);
  assert.equal(seriesValue(series, "runs.completed", day)?.value, 1);
  assert.equal(seriesValue(series, "duration.p50.ms", day)?.value, 5 * 60_000);
});
