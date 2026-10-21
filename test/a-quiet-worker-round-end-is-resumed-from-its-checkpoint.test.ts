import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { handoffReceiptsToCarry, pendingWorkerBoundaryHandoffs, runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";

const TASK = "W1-T8133";
const BRANCH = `run-${TASK}-1791807256528`;
const HEAD = "a".repeat(40);
const checkpoint = { branch: BRANCH, headSha: HEAD };
const lines = (rows: Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row));
const quiet = (extra: Record<string, unknown> = {}) => ({
  task_id: TASK, run_id: "quiet-round", step: "verdict", verdict: "handed_off",
  reason: "quiet_worker_round_ended", branch: BRANCH, head_sha: HEAD, ...extra,
});

test("W1-T8133: a quiet round end verdict is a resumable receipt", () => {
  const row = quiet();
  assert.deepEqual(pendingWorkerBoundaryHandoffs(lines([row])).get(TASK), checkpoint);
  assert.equal(row.reason, "quiet_worker_round_ended");
  assert.deepEqual(handoffReceiptsToCarry(lines([row])), [[TASK, checkpoint]],
    "a verdict-only quiet receipt must survive verdict retention");
  assert.deepEqual(handoffReceiptsToCarry(lines([row, {
    task_id: TASK, step: "run.freshness_handoff", branch: BRANCH, head_sha: HEAD, carried: true,
  }])), [], "an already carried receipt needs no duplicate");

  for (const invalid of [
    { branch: "main" }, { branch: "run-W1-T99-123" }, { branch: `run-${TASK}-bad` },
    { branch: null }, { head_sha: "abc" }, { head_sha: null }, { head_sha: "g".repeat(40) },
    { pr_url: "https://github.com/example/repo/pull/1" }, { verdict: "failed" }, { reason: "another_handoff" },
  ]) {
    assert.equal(pendingWorkerBoundaryHandoffs(lines([quiet(invalid)])).size, 0, JSON.stringify(invalid));
  }
});

test("W1-T8133: a quiet round end replaces an earlier receipt instead of erasing it", () => {
  for (const earlier of [
    { step: "verdict", verdict: "handed_off", reason: "freshness_yield" },
    { step: "run.freshness_handoff", waiting_on: "worker_round" },
  ]) {
    const prior = { task_id: TASK, branch: `run-${TASK}-1`, head_sha: "b".repeat(40), ...earlier };
    assert.deepEqual(pendingWorkerBoundaryHandoffs(lines([prior])).get(TASK),
      { branch: prior.branch, headSha: prior.head_sha }, "control: the older receipt is pending");
    const history = lines([prior, quiet()]);
    assert.deepEqual(pendingWorkerBoundaryHandoffs(history).get(TASK), checkpoint);
    assert.deepEqual(handoffReceiptsToCarry(history), [[TASK, checkpoint]]);
  }
});

test("W1-T8133: a later verdict still consumes a quiet receipt", () => {
  assert.deepEqual(pendingWorkerBoundaryHandoffs(lines([quiet()])).get(TASK), checkpoint);
  for (const verdict of ["merged", "failed", "no_pr"]) {
    const history = lines([quiet(), { task_id: TASK, step: "verdict", verdict }]);
    assert.equal(pendingWorkerBoundaryHandoffs(history).has(TASK), false, verdict);
    assert.deepEqual(handoffReceiptsToCarry(history), []);
  }
  assert.deepEqual(pendingWorkerBoundaryHandoffs(lines([
    quiet(), { task_id: "W1-T99", step: "verdict", verdict: "merged" },
  ])).get(TASK), checkpoint, "another task's verdict cannot consume the quiet receipt");
});

test("W1-T8133: a mid-session quiet handoff is resumable on the next tick", async () => {
  const plan = loadPlanFromYaml(`- id: ${TASK}
  title: quiet checkpoint fixture
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
  files: [src/quiet-fixture.ts]
`, "fixture");
  const ledger: Record<string, unknown>[] = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let branches = "";
  let started = 0;
  let checks = 0;
  let merged = false;
  let resumed: { branch: string; headSha: string } | undefined;
  await runDaemon(plan, {
    refreshMerged: () => () => merged,
    readLedgerLines: () => lines(ledger),
    readPushedRunBranches: () => branches,
    checkStop: () => started >= 2 || ++checks > 60 ? "fixture done" : undefined,
    log: (step, extra) => {
      rows.push({ step, extra });
      ledger.push({ ts: new Date().toISOString(), step, ...extra });
    },
    runOne: async () => {
      started++;
      if (started === 1) {
        branches = `${HEAD}\trefs/heads/${BRANCH}\n`;
        ledger.push({ ts: new Date().toISOString(), ...quiet() });
        return { taskId: TASK, runId: "quiet-round", merged: false, verdict: "handed_off", costUsd: 0 } as RunResult;
      }
      resumed = pendingWorkerBoundaryHandoffs(lines(ledger)).get(TASK);
      merged = true;
      return { taskId: TASK, runId: "resumed-round", merged: true, verdict: "merged", costUsd: 0 } as RunResult;
    },
    sleep: async () => { await flush(); },
  } as DaemonDeps, { laneCount: 1, max: 60 });
  assert.equal(started, 2, "the same daemon dispatches the checkpoint on its next pass");
  assert.deepEqual(resumed, checkpoint);
  assert.deepEqual(rows.filter(({ step, extra }) =>
    step === "dispatch.skipped" && extra?.reason === "run-branch-already-pushed"), []);
  assert.equal(rows.find(({ step, extra }) =>
    step === "daemon.iteration" && extra?.resumes_handoff === BRANCH)?.extra?.task, TASK);
});
