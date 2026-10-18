import assert from "node:assert/strict";
import { test } from "node:test";
import { readLedgerLines } from "../src/lib/status.js";
import { runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// #12390 (2026-10-17): the sweep handed the conflict round to the fix lane at 00:55:58Z, the worker started at
// 01:25:54Z after memory admission, and the 30-minute backstop opened needs-human #12490 at 01:28:49Z, while the
// round was merging. The round's `fix.dispatch` row is written when the round ENDS, so none existed yet.
const now = Date.UTC(2026, 9, 17, 1, 28, 9);
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const pr: OpenPrView = {
  prNumber: 12390, prUrl: "https://github.com/craigoley/remudero/pull/12390", taskId: "W1-T9722",
  headSha: "f74145eb", headRefName: "run-W1-T9722-1", reviewState: "success", checksState: "green",
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: ago(5), autoMergeArmed: false, mergeState: "dirty",
};
const RUN_ID = "test-in-flight";

function fixture(extra: Record<string, unknown>[]) {
  const stage = { blocker: "conflict", blocker_since: ago(33) };
  const ledger = writeLedger([
    // An earlier head's finished round: the task has dispatched before, so the rung is not "never dispatched".
    { ts: ago(600), run_id: "old", task_id: pr.taskId, step: "fix.dispatch", pr_number: pr.prNumber, head_sha: "older" },
    { ts: ago(33), run_id: "old", task_id: pr.taskId, step: "sweep.disposed", pr_number: pr.prNumber,
      head_sha: pr.headSha, disposition: "conflicted", acted: false, ...stage },
    ...extra,
  ]);
  const escalations: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: RUN_ID, now: () => now,
    arm: () => "hold-refused", close: () => {}, dispatchFix: () => {}, postReview: () => {},
    escalate: (_pr, reason) => { escalations.push(reason); },
  };
  const rows = (step: string) => readLedgerLines(ledger.path).filter(row => row.step === step);
  return { ledger, deps, escalations, rows, stage };
}

test("W1-T9971: a conflict round still in flight keeps the stalled-stage backstop quiet", async () => {
  const f = fixture([]);
  // The earlier pass handed this head to the fix lane; the round has written no `fix.*` row since.
  f.ledger.append([{ ts: ago(32), run_id: RUN_ID, task_id: pr.taskId, step: "sweep.disposed", pr_number: pr.prNumber,
    head_sha: pr.headSha, disposition: "conflicted", acted: true, ...f.stage }]);
  await runSweep([pr], f.deps);
  assert.equal(f.rows("pr.stuck").length, 0);
  assert.equal(f.rows("sweep.disposed").some(row => row.stage_stuck === true), false);
});

test("W1-T9971: a conflict stage with no dispatched round still escalates", async () => {
  const f = fixture([]);
  await runSweep([pr], f.deps);
  assert.equal(f.rows("pr.stuck").length, 1);
  assert.equal(f.rows("pr.stuck")[0].blocker, "conflict");
});
