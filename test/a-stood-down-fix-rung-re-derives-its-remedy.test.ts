// test/a-stood-down-fix-rung-re-derives-its-remedy.test.ts
//
// LIVE 2026-10-09: a fix rung that STANDS DOWN (pre-strike, no commit) wrote `fix.stood_down` and
// nothing else. `fixRungStalledWithoutNewHead` never read that step, so when the task's last
// dispatch had ended cleanly (an earlier head's successful push) the stand-down left `stalled`
// false and every later sweep deduped the head with "fix already dispatched for this head —
// awaiting its outcome". Nothing would ever arrive. The 2026-10-09 ledger window holds 130
// stand-downs; the two largest reasons ("the fix has no surface to stage", "blocked_ci dispatch with
// zero enumerable failing check(s)") are pre-strike and carry no follow-up row of their own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixRungStalledWithoutNewHead } from "../src/lib/sweep.js";

const TASK = "W1-T5808";
const OLD_HEAD = "3ddaee544d2f1f0d9a3c6b1e7f1a2b3c4d5e6f70";
const NEW_HEAD = "80aa617193a03c2fdc244b6e4f1e328e650cc4d0";

/** The task's previous round ended cleanly: it pushed a new head. */
function cleanEarlierRound(): Array<Record<string, unknown>> {
  return [
    { task_id: TASK, step: "fix.dispatch", mode: "ci-log", head_sha: OLD_HEAD, strike: 1 },
    { task_id: TASK, step: "fix.done", head_sha: OLD_HEAD, subtype: "success", pushed_head_sha: NEW_HEAD },
  ];
}

test("a rung that stands down without a commit no longer dedups its head", () => {
  assert.equal(fixRungStalledWithoutNewHead(cleanEarlierRound(), TASK), false, "control: a clean push is not stalled");
  const lines = [...cleanEarlierRound(), {
    task_id: TASK, step: "fix.stood_down", site: "rung.empty_ci_failures", strike: 2,
    reason: "blocked_ci dispatch with zero enumerable failing check(s) — the checks-red rollup and the ci-log evidence miner disagree",
  }];
  assert.equal(fixRungStalledWithoutNewHead(lines, TASK), true);
});

test("an empty-commit-surface stand-down ends the rung too", () => {
  const lines = [...cleanEarlierRound(), {
    task_id: TASK, step: "fix.stood_down", site: "rung.empty_commit_surface", strike: 2,
    reason: "the fix has no surface to stage — declare task files or restore the PR diff before dispatch",
  }];
  assert.equal(fixRungStalledWithoutNewHead(lines, TASK), true);
});

test("a hand-off to the sweep is still a live wait, not a stall", () => {
  const lines = [...cleanEarlierRound(), {
    task_id: TASK, step: "fix.stood_down", site: "rung.ci_handoff", strike: 2, outcome: "handed_off", owner: "sweep",
  }];
  assert.equal(fixRungStalledWithoutNewHead(lines, TASK), false);
});

test("a fresh dispatch after the stand-down is the live rung again", () => {
  const lines = [...cleanEarlierRound(),
    { task_id: TASK, step: "fix.stood_down", site: "rung.strike", strike: 2, reason: "recycle_yield" },
    { task_id: TASK, step: "fix.dispatch", mode: "ci-log", head_sha: NEW_HEAD, strike: 2 }];
  assert.equal(fixRungStalledWithoutNewHead(lines, TASK), false);
});
