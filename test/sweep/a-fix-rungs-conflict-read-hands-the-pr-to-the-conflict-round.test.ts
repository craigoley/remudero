import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFLICT_REPAIR_HANDOFF_REASON, lastKnownMergeStateFromLedger, runSweep,
  type FixDispatchEvidence, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

// The rung and the sweep each wait on the other. A fix rung dispatched for a red PR reads GitHub's `mergeable:
// CONFLICTING`, stands down at rung.strike "for the sweep's own conflicted disposition", and the sweep, which still reads
// the head clean or unread, holds that stand-down as refused-escalate because the head and contract it read have not
// changed. Main moving is never one of those inputs. #15638 (W1-T9795, head 35fa075) reached that at 00:20:25Z on
// 2026-11-03; 13 refused-escalates on 6 PRs read this hand-off after #14515 (2026-10-26) exempted only a conflicted pass.
const HEAD = "35fa0751dd0f3fd661607d5c61461dc569611d64";
const TASK = "W1-T9795";
const PR = 15638;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR}`;
const RUN = "DAEMON-1793659761825";
const NOW = Date.parse("2026-11-03T00:20:25.258Z");
const MAIN_AT_HOLD = "ab391187757c4a93110a7d8438953c7e61740b4d";
const MAIN_LATER = "c0a6f1c742370f8374247a65c7ef60f6598b8439";
const FILES = [{ path: "src/run-task.ts", ours_deleted: 4, theirs_deleted: 22 }];

type Row = { step: string } & Record<string, unknown>;
const dirtyRead: Row = { step: "sweep.disposed", pr_number: PR, head_sha: HEAD, task_id: TASK, run_id: RUN,
  disposition: "conflicted", acted: false, merge_state: "dirty", conflict_files: FILES, conflict_evidence_source: "compare",
  ts: "2026-11-02T23:20:00.000Z" };
const seed: Row = { step: "sweep.disposed", pr_number: PR, head_sha: HEAD, task_id: TASK, run_id: RUN,
  disposition: "blocked-fixable", acted: true, merge_state: "clean", ts: "2026-11-02T23:59:23.156Z" };
const dispatch: Row = { step: "fix.dispatch", task_id: TASK, head_sha: HEAD, run_id: RUN, mode: "ci-log",
  ts: "2026-11-02T23:59:30.000Z" };
const standDown = (over: Record<string, unknown> = {}): Row => ({ step: "fix.stood_down", task_id: TASK, run_id: RUN,
  read_head_sha: HEAD, read_contract_revision: "contract-A", site: "rung.strike", strike: 1,
  reason: CONFLICT_REPAIR_HANDOFF_REASON, ts: "2026-11-03T00:02:16.000Z", ...over });

const view = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: PR, prUrl: PR_URL, taskId: TASK, headRefName: "run-W1-T9795-1793321601764", headSha: HEAD,
  checksState: "red", reviewState: "pending", unmetCriteria: [],
  ciFailures: [{ name: "test-shard (3/8)", logTail: "not ok 1 - registry shell qualification" }], priorStrikes: 1, autoMergeArmed: false, lastActivityAt: "2026-11-02T23:59:23.156Z",
  body: `Registry shell.\n\nRemudero-Task: ${TASK}\n`, ...over,
});

function fixture(rows: Row[], mainTip: () => string) {
  const state = { dispatched: [] as FixDispatchEvidence[], escalated: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/unused/rung-conflict-handoff-ledger", runId: RUN, now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row as Row); },
    readMainTip: mainTip, readTaskContractRevision: () => "contract-A",
    fixProgressJudge: async () => ({ verdict: "continue", reason: "one unmet criterion" }),
    arm: () => {}, close: () => {},
    escalate: () => { state.escalated++; },
    dispatchFix: (_pr, evidence) => {
      state.dispatched.push(evidence);
      rows.push({ ...dispatch, mode: evidence.mergeConflict ? "merge-conflict" : "ci-log", ts: new Date(NOW).toISOString() });
    },
    claimFixAdmission: () => ({ admitted: true }),
  };
  return { deps, state };
}

test("W1-T11173: the rung's conflict read is the newest mergeability its head has", () => {
  const known = lastKnownMergeStateFromLedger([dirtyRead, seed, dispatch, standDown()], PR, HEAD);
  assert.equal(known?.state, "dirty", "the rung read CONFLICTING after the sweep's last clean");
  assert.equal(known?.observedAt, "2026-11-03T00:02:16.000Z");
  assert.deepEqual(known?.conflictFiles, [{ path: "src/run-task.ts", oursDeleted: 4, theirsDeleted: 22 }],
    "the head's last recorded conflict files ride along");
  const laterClean = { ...seed, acted: false, ts: "2026-11-03T00:10:00.000Z" };
  assert.equal(lastKnownMergeStateFromLedger([dirtyRead, seed, dispatch, standDown(), laterClean], PR, HEAD)?.state, "clean",
    "a later sweep observation still supersedes it");
  assert.equal(lastKnownMergeStateFromLedger([seed, standDown({ reason: "a different stand-down" })], PR, HEAD)?.state, "clean");
  assert.equal(lastKnownMergeStateFromLedger([seed, standDown({ site: "rung.needs_design" })], PR, HEAD)?.state, "clean");
  assert.equal(lastKnownMergeStateFromLedger([seed, standDown({ read_head_sha: "0".repeat(40) })], PR, HEAD)?.state, "clean");
});

test("W1-T11173: an unread pass after the rung's conflict read dispatches the conflict round, not a refused-escalate", async () => {
  const rows = [dirtyRead, seed, dispatch, standDown()];
  const f = fixture(rows, () => MAIN_AT_HOLD);
  const summary = await runSweep([view({ mergeState: undefined, mergeable: undefined, mergeableState: undefined })], f.deps);
  assert.equal(summary.actions[0]!.disposition, "conflicted");
  assert.equal(f.state.escalated, 0);
  assert.equal(f.state.dispatched.length, 1);
  assert.deepEqual(f.state.dispatched[0]!.mergeConflict?.files, [{ path: "src/run-task.ts", oursDeleted: 4, theirsDeleted: 22 }]);
});

test("W1-T11173: a held conflict hand-off is released once main has moved past the main it was held under", async () => {
  const rows = [seed, dispatch, standDown()];
  let main = MAIN_AT_HOLD;
  const f = fixture(rows, () => main);
  const pr = view({ mergeState: "clean", mergeable: true, mergeableState: "clean" });
  const first = await runSweep([pr], f.deps);
  assert.equal(first.actions[0]!.disposition, "refused-escalate", "GitHub reads clean and nothing has moved yet: held");
  const held = rows.findLast(r => r.step === "sweep.disposed" && r.stand_down_hold === true)!;
  assert.equal(held.stand_down_main_sha, MAIN_AT_HOLD, "the hold names the main it was held under");
  assert.equal(held.stand_down_at, "2026-11-03T00:02:16.000Z");
  await runSweep([pr], f.deps);
  assert.equal(f.state.dispatched.length, 0, "the same main: still held");

  main = MAIN_LATER;
  const released = await runSweep([pr], f.deps);
  assert.equal(released.actions[0]!.disposition, "blocked-fixable", "main moved: the rung re-reads mergeability");
  assert.equal(f.state.dispatched.length, 1);
  assert.match(String(rows.findLast(r => r.step === "sweep.disposed")?.reason), /main is now c0a6f1c/);
});
