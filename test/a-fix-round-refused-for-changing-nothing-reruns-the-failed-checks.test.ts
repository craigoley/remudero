// test/a-fix-round-refused-for-changing-nothing-reruns-the-failed-checks.test.ts
//
// LIVE 2026-10-09: #10234 at head f417641 had a red coverage shard. Its fix round at 12:35Z ended
// `fix.commit_refused` "the worker changed nothing": a worker that read the red and found nothing to
// change. W1-T6353 reruns the failed jobs once for a ci-log round that pushed nothing, but only when the
// round ended `fix.done success`; the refused twin of the same signal earned no rerun, so the sweep kept
// "retrying the fix round" with refusals that are never strikes, and the shard was never re-run.
import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import {
  buildSweepEffects, DEFAULT_SWEEP_POLICY, fixRoundTally, runSweep,
  type OpenPrView, type SweepDeps,
} from "./helpers/sweep-test.js";

type Row = Record<string, unknown>;
const HEAD = "a".repeat(40);
const NOW = Date.parse("2026-10-08T08:00:00Z");
const TASK = "W1-T6353";

function round(id: string, head = HEAD): Row[] {
  const identity = { task_id: TASK, head_sha: head, round_id: id, strike: 1 };
  return [
    { ...identity, step: "fix.dispatch", mode: "ci-log", verdict_regime: "executed" },
    { ...identity, step: "fix.done", subtype: "success" },
  ];
}

function fixture(rows: Row[] = round("first")) {
  const ledger: Row[] = [{ step: "sweep.disposed", task_id: TASK, pr_number: 10012,
    head_sha: HEAD, disposition: "blocked-fixable", acted: true }, ...rows];
  const writes: string[][] = [];
  const reads: string[][] = [];
  const dispatched: number[] = [];
  const escalated: string[] = [];
  let liveHead = HEAD;
  let runState = "failure";
  let writeError: string | undefined;
  let readError: string | undefined;
  const effects = buildSweepEffects({
    owner: "acme", repo: "remudero", config: { root: "/tmp/noop-refusal" } as Config,
    ledgerPath: "/dev/null/noop-refusal", runId: "test", log: () => {},
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    issuesImpl: { create: () => "unused" }, registeredWorktreeOwnerImpl: () => undefined,
    readJsonImpl: async (args) => {
      reads.push(args);
      if (readError) throw new Error(readError);
      if (args[1] === "repos/acme/remudero/pulls/10012") {
        return { state: "open", head: { sha: liveHead } };
      }
      assert.match(args[1]!, /actions\/runs\?head_sha=/);
      return { total_count: 4, workflow_runs: [
        { id: 41, head_sha: liveHead, status: "completed", conclusion: runState },
        { id: 42, head_sha: liveHead, status: "completed", conclusion: "success" },
        { id: 43, head_sha: "old-head", status: "completed", conclusion: "failure" },
        { id: 44, head_sha: liveHead, status: "in_progress", conclusion: null },
      ] };
    },
    ghRunImpl: (_file, args) => {
      writes.push([...args]);
      if (writeError) throw new Error(writeError);
    },
  });
  const pr = (): OpenPrView => ({
    prNumber: 10012, prUrl: "https://github.com/acme/remudero/pull/10012", taskId: TASK,
    headSha: liveHead, headRefName: "run-W1-T6353-1", reviewState: "none", checksState: "red",
    unmetCriteria: [], priorStrikes: fixRoundTally(ledger, TASK, liveHead).strikes,
    ciFailures: [{ name: "test-slow-shard (2/2)", logTail: "AssertionError: elapsed bound", conclusion: "FAILURE" }],
    lastActivityAt: new Date(NOW).toISOString(), autoMergeArmed: false,
  });
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, dispatchFix: (view) => { dispatched.push(view.priorStrikes); },
    escalate: (_view, reason) => { escalated.push(reason); },
    rerunFailedChecks: effects.rerunFailedChecks,
    readLiveState: () => ({ ok: true, state: "OPEN", headSha: liveHead }),
    ledgerPath: "/dev/null/noop-refusal", runId: "test", now: () => NOW,
    readLedger: () => ledger, appendLine: (_path, line) => { ledger.push(line); },
  };
  return {
    ledger, writes, reads, dispatched, escalated, effects, pr, deps,
    pass: () => runSweep([pr()], deps, DEFAULT_SWEEP_POLICY),
    moveHead: (head: string) => { liveHead = head; },
    setRunState: (state: string) => { runState = state; },
    failWrite: (reason: string) => { writeError = reason; },
    failRead: (reason: string) => { readError = reason; },
  };
}


function refusedRound(id: string, reason: string): Row[] {
  const identity = { task_id: TASK, head_sha: HEAD, round_id: id, strike: 1 };
  return [
    { ...identity, step: "fix.dispatch", mode: "ci-log", verdict_regime: "executed" },
    { ...identity, step: "fix.commit_refused", reason },
    { ...identity, step: "fix.done", subtype: "commit_refused" },
  ];
}

test("a ci-log round refused because the worker changed nothing reruns the failed checks once", async () => {
  const f = fixture(refusedRound("nothing", "the worker changed nothing"));
  assert.deepEqual(fixRoundTally(f.ledger, TASK, HEAD).noCommitRounds, ["nothing"]);
  await f.pass();
  assert.deepEqual(f.writes, [["api", "-X", "POST", "repos/acme/remudero/actions/runs/41/rerun-failed-jobs"]]);
  assert.deepEqual(f.dispatched, []);
  assert.equal(f.ledger.findLast((row) => row.no_commit_rerun_outcome === "rerun")?.no_commit_rerun_round_id, "nothing");
  await f.pass();
  assert.equal(f.writes.length, 1, "the head's one rerun is spent");
});

test("a round refused for another reason earns no rerun", async () => {
  const f = fixture(refusedRound("scope", "non-test paths need scope"));
  await f.pass();
  assert.deepEqual(f.writes, []);
});
