// test/a-deferred-requeue-survives-a-no-commit-rerun.test.ts — W1-T8041.
//
// PR #10829, 2026-10-11: ci-shard (7/8)|(8/8) requeues were deferred (already_running) at 13:11Z; the
// next full pass took the W1-T6353 no-commit rerun, which answered "unavailable", spent its one-shot
// receipt and broke out before the deferred retry. These tests replay that ledger shape.
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SWEEP_POLICY, runSweep,
  type OpenPrView, type RollupCheckEntry, type SweepDeps,
} from "#test/helpers/sweep-test.js";

type Row = Record<string, unknown>;
const HEAD = "3c92df1a4f10".padEnd(40, "0");
const NOW = Date.parse("2026-10-11T13:47:29Z");
const TASK = "W1-T7899";
const PR = 10829;
const SHARDS = ["ci-shard (7/8)", "ci-shard (8/8)"];

const identity = { task_id: TASK, head_sha: HEAD, round_id: "r1", strike: 1 };
const noCommitRound = (): Row[] => [
  { ...identity, step: "fix.dispatch", mode: "ci-log", verdict_regime: "executed" },
  { ...identity, step: "fix.done", subtype: "success" },
];
const deferrals = (): Row[] => SHARDS.flatMap((name, i) => [
  { step: "sweep.check_requeued", task_id: TASK, pr_number: PR, head_sha: HEAD, check_name: name, job_id: `70${i}` },
  { step: "sweep.check_requeue.deferred", task_id: TASK, pr_number: PR, head_sha: HEAD, check_name: name,
    job_id: `70${i}`, refusal: "already_running", outcome: "deferred" },
]);

/** The red shards' rollup; `inFlight` keeps a sibling job of the same run running. */
const rollup = (conclusion: string, inFlight: boolean): RollupCheckEntry[] => [
  ...SHARDS.map((name, i): RollupCheckEntry => ({ name, status: "COMPLETED", conclusion, startedAt: "2026-10-11T13:00:00Z",
    detailsUrl: `https://github.com/craigoley/remudero/actions/runs/900/job/80${i}` })),
  { name: "ci-shard (1/8)", status: inFlight ? "IN_PROGRESS" : "COMPLETED", ...(inFlight ? {} : { conclusion: "SUCCESS" }),
    startedAt: "2026-10-11T13:00:01Z", detailsUrl: "https://github.com/craigoley/remudero/actions/runs/900/job/333" },
];

function fixture(seed: Row[], kind: "failure" | "cancelled") {
  const ledger: Row[] = [{ step: "sweep.disposed", task_id: TASK, pr_number: PR, head_sha: HEAD,
    disposition: "blocked-fixable", acted: true }, ...seed];
  const requeued: string[] = [];
  const reruns: number[] = [];
  const dispatched: number[] = [];
  let inFlight = true;
  const pr = (): OpenPrView => ({
    prNumber: PR, prUrl: `https://github.com/craigoley/remudero/pull/${PR}`, taskId: TASK,
    headSha: HEAD, headRefName: "run-W1-T7899-1", reviewState: "none", checksState: "red",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date(NOW).toISOString(), autoMergeArmed: false,
    redRequiredChecks: SHARDS,
    ciFailures: SHARDS.map((name, i) => ({ name, logTail: "AssertionError", conclusion: kind === "cancelled" ? "CANCELLED" : "FAILURE", jobId: `80${i}` })),
    ...(kind === "cancelled" ? { cancelledRequiredChecks: SHARDS.map((name, i) => ({ name, jobId: `80${i}` })) } : {}),
  });
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, dispatchFix: (view) => { dispatched.push(view.priorStrikes); },
    escalate: () => {}, escalateCancelledCheck: () => {},
    rerunFailedChecks: async () => { reruns.push(1); return { outcome: "unavailable", runIds: [], reason: "no completed failed workflow run at this head" }; },
    requeueCheck: (_pr, check) => { requeued.push(String(check.jobId)); return true; },
    readLiveState: () => ({ ok: true, state: "OPEN", headSha: HEAD }),
    readCiGateRollup: () => rollup(kind === "cancelled" ? "CANCELLED" : "FAILURE", inFlight),
    ledgerPath: "/dev/null/w1-t8041", runId: "test", now: () => NOW,
    readLedger: () => ledger, appendLine: (_path, line) => { ledger.push(line); },
  };
  return {
    ledger, requeued, reruns, dispatched,
    finish: () => { inFlight = false; },
    pass: async () => {
      await runSweep([pr()], deps, DEFAULT_SWEEP_POLICY);
      return ledger.filter((row) => row.step === "sweep.disposed").at(-1)!;
    },
  };
}

test("W1-T8041: a deferred requeue is retried before the no-commit rerun once its run completes", async () => {
  const f = fixture([...deferrals(), ...noCommitRound()], "failure");
  const held = await f.pass();
  assert.deepEqual(f.requeued, [], "its run is still in flight, so nothing is POSTed");
  assert.deepEqual(f.reruns, [], "a pending deferral keeps the no-commit rerun's one-shot unspent");
  assert.notEqual(held.no_commit_rerun_attempted, true);
  f.finish();
  await f.pass();
  assert.deepEqual(f.requeued.sort(), ["800", "801"], "the deferred jobs are requeued at their current job ids");
  assert.deepEqual(f.reruns, [], "the retry ran ahead of the no-commit rerun");
  assert.deepEqual(f.dispatched, [], "no fix strike is spent on a requeued shard");
});

test("W1-T8041: an unavailable failed-job rerun falls through to the requeue arms", async () => {
  const f = fixture(noCommitRound(), "cancelled");
  f.finish();
  const disposed = await f.pass();
  assert.deepEqual(f.reruns, [1], "the no-commit rerun is still tried once");
  assert.equal(disposed.no_commit_rerun_attempted, true, "its one-shot receipt is kept");
  assert.equal(disposed.no_commit_rerun_outcome, "unavailable");
  assert.deepEqual(f.requeued.sort(), ["800", "801"], "the cancelled shards are requeued in the same pass");
  assert.deepEqual(f.dispatched, []);
});

test("W1-T8041: an unavailable rerun with no requeue arm to take the pass still stands down", async () => {
  const f = fixture(noCommitRound(), "failure");
  f.finish();
  const disposed = await f.pass();
  assert.deepEqual(f.reruns, [1]);
  assert.deepEqual(f.requeued, []);
  assert.deepEqual(f.dispatched, []);
  assert.match(String(disposed.stand_down_reason), /failed-job rerun unavailable/);
});
