import assert from "node:assert/strict";
import { test } from "node:test";
import { readLedgerLines } from "#src/lib/status.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

// 48 h ledger research (2026-11-11 to 2026-11-13): one fix round anywhere in a stage silenced the stage-stall
// backstop for the rest of the stage. 42 stalled episodes lasted more than 1 hour, and 13 never got a fix round.
const now = Date.UTC(2026, 10, 13, 12, 0, 0);
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const PAUSE = "fleet PAUSE hold: PAUSE requested: container recycle";
const RUN_ID = "test-re-arm";
const conflictPr: OpenPrView = {
  prNumber: 18100, prUrl: "https://github.com/craigoley/remudero/pull/18100", taskId: "W1-T12000",
  headSha: "a1b2c3d4", headRefName: "run-W1-T12000-1", reviewState: "success", checksState: "green",
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: ago(5), autoMergeArmed: false, mergeState: "dirty",
};
const redPr: OpenPrView = {
  prNumber: 18101, prUrl: "https://github.com/craigoley/remudero/pull/18101", taskId: "W1-T12001",
  headSha: "e5f6a7b8", headRefName: "run-W1-T12001-1", reviewState: "pending", checksState: "red",
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: ago(5), autoMergeArmed: false,
  ciFailures: [{ name: "ci", logTail: "not ok 1 - test/x.test.ts" }],
};

type Blocker = "conflict" | "own-red";
const disposition = (blocker: Blocker) => blocker === "conflict" ? "conflicted" : "blocked-fixable";

/** One stage, `stageMin` minutes old; un-acted passes every 5 minutes, held by a PAUSE when `held` names a window. */
function fixture(pr: OpenPrView, blocker: Blocker, stageMin: number, extra: Record<string, unknown>[],
  opts: { heldSinceMin?: number } = {}) {
  const stage = { blocker, blocker_since: ago(stageMin) };
  const passes: Record<string, unknown>[] = [];
  for (let m = stageMin; m >= 1; m -= 5) {
    const held = opts.heldSinceMin !== undefined && m <= opts.heldSinceMin;
    passes.push({ ts: ago(m), run_id: "old", task_id: pr.taskId, step: "sweep.disposed", pr_number: pr.prNumber,
      head_sha: pr.headSha, disposition: disposition(blocker), acted: false, ...stage,
      ...(held ? { stand_down_reason: PAUSE } : {}) });
  }
  const ledger = writeLedger([...passes, ...extra]);
  const escalations: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: RUN_ID, now: () => now,
    arm: () => "hold-refused", close: () => {}, dispatchFix: () => {}, postReview: () => {},
    ...(opts.heldSinceMin === undefined ? { actionable: () => false } : { workerAdmissionHold: () => PAUSE }),
    escalate: (_pr, reason) => { escalations.push(reason); },
  };
  const stuck = () => readLedgerLines(ledger.path).filter(row => row.step === "pr.stuck");
  return { ledger, deps, escalations, stuck, stage };
}

const dispatchRow = (pr: OpenPrView, minutesAgo: number) => ({ ts: ago(minutesAgo), run_id: "fix", task_id: pr.taskId,
  step: "fix.dispatch", pr_number: pr.prNumber, head_sha: pr.headSha });

test("W1-T12542 criterion 1: a conflict stage whose last round ended past its bound is reported", async () => {
  const f = fixture(conflictPr, "conflict", 90, [dispatchRow(conflictPr, 80), dispatchRow(conflictPr, 60)]);
  await runSweep([conflictPr], f.deps);
  const rows = f.stuck();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].blocker, "conflict");
  assert.equal(rows[0].last_fix_round_ended_at, ago(60));
  assert.equal(f.escalations.length, 1);
  assert.match(f.escalations[0], new RegExp(`the last fix round ended at ${ago(60).replace(/\./g, "\\.")}`));
});

test("W1-T12542 criterion 1: an own-red stage whose last pushed fix ended past its bound is reported", async () => {
  const pushed = { ts: ago(70), run_id: "fix", task_id: redPr.taskId, step: "fix.done", pr_number: redPr.prNumber,
    head_sha: "0ld0ld00", pushed_head_sha: redPr.headSha };
  const f = fixture(redPr, "own-red", 120, [pushed]);
  await runSweep([redPr], f.deps);
  const rows = f.stuck();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].blocker, "own-red");
  assert.equal(rows[0].last_fix_round_ended_at, ago(70));
});

test("W1-T12542 criterion 2: a round that ended within the bound, or one in flight, keeps the stage silent", async () => {
  const recent = fixture(conflictPr, "conflict", 90, [dispatchRow(conflictPr, 60), dispatchRow(conflictPr, 20)]);
  await runSweep([conflictPr], recent.deps);
  assert.equal(recent.stuck().length, 0);
  assert.deepEqual(recent.escalations, []);

  // The last round ended an hour ago, but a later pass handed this head to the fix lane and its rung has not ended.
  const inFlight = fixture(conflictPr, "conflict", 90, [dispatchRow(conflictPr, 60)]);
  inFlight.ledger.append([{ ts: ago(10), run_id: RUN_ID, task_id: conflictPr.taskId, step: "sweep.disposed",
    pr_number: conflictPr.prNumber, head_sha: conflictPr.headSha, disposition: "conflicted", acted: true,
    ...inFlight.stage }]);
  await runSweep([conflictPr], inFlight.deps);
  assert.equal(inFlight.stuck().length, 0);
  assert.deepEqual(inFlight.escalations, []);
});

test("W1-T12542 criterion 3: time the fleet held the stage since the last round does not count as quiet time", async () => {
  // The round ended 60 minutes ago; a PAUSE held every pass of the last 50 minutes, so the owner had 10 free minutes.
  const held = fixture(conflictPr, "conflict", 120, [dispatchRow(conflictPr, 60)], { heldSinceMin: 50 });
  await runSweep([conflictPr], held.deps);
  assert.equal(held.stuck().length, 0);
  assert.equal(held.escalations.filter(reason => reason.startsWith("PR stage stalled")).length, 0);

  // The same stage with the PAUSE only before the round ended: its 60 quiet minutes pass the 30-minute bound.
  const before = fixture(conflictPr, "conflict", 120, [dispatchRow(conflictPr, 60)], { heldSinceMin: undefined });
  await runSweep([conflictPr], before.deps);
  assert.equal(before.stuck().length, 1);
});

test("W1-T12542 criterion 4: a re-armed stage reports once per PR, head and blocker in the renotify window", async () => {
  const f = fixture(conflictPr, "conflict", 90, [dispatchRow(conflictPr, 60)]);
  await runSweep([conflictPr], f.deps);
  await runSweep([conflictPr], f.deps);
  assert.equal(f.stuck().length, 1);
  assert.equal(f.escalations.length, 1);

  // A flapped blocker restarts blocker_since; the report already filed at this head and blocker still stands.
  const flapped = fixture(conflictPr, "conflict", 90, [dispatchRow(conflictPr, 60), { ts: ago(200), run_id: "old",
    task_id: conflictPr.taskId, step: "pr.stuck", pr_number: conflictPr.prNumber, head_sha: conflictPr.headSha,
    blocker: "conflict", blocker_since: ago(240), diagnosis: "unknown signature" }]);
  await runSweep([conflictPr], flapped.deps);
  assert.equal(flapped.stuck().length, 1);
  assert.deepEqual(flapped.escalations, []);
});
