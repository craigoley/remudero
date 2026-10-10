// test/an-unobserved-fix-exit-ends-the-round-for-dedupe.test.ts
//
// LIVE 2026-10-09: #10555's fix round wrote `fix.done` with `worker_exit: "unobserved"` at 04:27 —
// the worker threw without naming a process end, so nothing was pushed and no `fix.review`,
// `fix.stood_down` or `fix.commit_refused` followed. `fixRungStalledWithoutNewHead` read none of
// that row, so the rung looked live and every later sweep deduped the head with "fix already
// dispatched for this head — awaiting its outcome". The outcome HAD arrived; it was the fix.done.
// An unobserved exit now ends the round as #10375 made a stand-down do, so the next pass
// re-derives its remedy and the W1-T7096 progress judge sees the round.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixRungStalledWithoutNewHead } from "../src/lib/sweep.js";

const TASK = "unfiled";
const HEAD = "5a1d9c0e7b3f2a4d6c8e0f1a2b3c4d5e6f708192";

function unobservedRound(): Array<Record<string, unknown>> {
  return [
    { task_id: TASK, step: "fix.dispatch", mode: "review", head_sha: HEAD, strike: 1, round_id: "r1" },
    { task_id: TASK, step: "fix.done", round_id: "r1", head_sha: HEAD, strike: 1, subtype: "error_during_execution",
      worker_exit: "unobserved", fix_outcome: "unstated" },
  ];
}

test("a fix round whose worker exit was unobserved no longer dedups its head", () => {
  const live = [{ task_id: TASK, step: "fix.dispatch", mode: "review", head_sha: HEAD, strike: 1, round_id: "r1" }];
  assert.equal(fixRungStalledWithoutNewHead(live, TASK), false, "control: a dispatch with no outcome yet is a live wait");
  assert.equal(fixRungStalledWithoutNewHead(unobservedRound(), TASK), true);
});

test("a fresh dispatch after the unobserved exit is the live rung again", () => {
  const lines = [...unobservedRound(),
    { task_id: TASK, step: "fix.dispatch", mode: "review", head_sha: HEAD, strike: 2, round_id: "r2" }];
  assert.equal(fixRungStalledWithoutNewHead(lines, TASK), false);
});

// The sibling: a worker that EXITED WITH AN ERROR CODE and pushed nothing leaves the same shape —
// a fix.done and no review, push or stand-down — so its head was deduped forever too.
function errorExitRound(over: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return [
    { task_id: TASK, step: "fix.dispatch", mode: "review", head_sha: HEAD, strike: 1, round_id: "r1" },
    { task_id: TASK, step: "fix.done", round_id: "r1", head_sha: HEAD, strike: 1, subtype: "error_during_execution",
      worker_exit: "exit", worker_exit_code: 1, fix_outcome: "unstated", ...over },
  ];
}

test("a fix round whose worker exited with an error code and pushed nothing no longer dedups its head", () => {
  assert.equal(fixRungStalledWithoutNewHead(errorExitRound(), TASK), true);
  assert.equal(fixRungStalledWithoutNewHead(errorExitRound({ pushed_head_sha: HEAD }), TASK), true,
    "a pushed head equal to the dispatched one moved nothing");
});

test("an error-coded exit that pushed a new head, or a clean exit code 0, is not read as an ended round", () => {
  const moved = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
  assert.equal(fixRungStalledWithoutNewHead(errorExitRound({ pushed_head_sha: moved }), TASK), false);
  assert.equal(fixRungStalledWithoutNewHead(errorExitRound({ worker_exit_code: 0, subtype: "success" }), TASK), false);
});
