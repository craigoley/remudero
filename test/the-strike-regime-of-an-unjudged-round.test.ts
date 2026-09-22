/**
 * W1-T4033 — the regime a fix strike is tagged with, when the round had no criteria to judge.
 *
 * The defect was `[].some(p) === false`: a ci-log round is dispatched BECAUSE CI is red, the
 * reviewer only runs once CI is green, so `review.criteria` is empty and the round was tagged
 * `keyword_only` — the tag `priorStrikesFor` amnesties under the `executed` regime. Measured on
 * the live ledger 2026-09-22: 200 of 200 `fix.dispatch` rows read `keyword_only` and 153
 * dispatches printed `strike 1/2`, i.e. `priorStrikes` read zero every time.
 *
 * The last test is the load-bearing one: it drives the SAME ledger twice, once with the tag this
 * fix produces and once with the tag it replaces, and asserts the two disagree. Without that
 * control a green assertion here would prove only that `priorStrikesFor` counts rows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { priorStrikesFor, strikeRegimeForDispatch } from "../src/run-task.js";

const HEAD = "0f476be47c0de1a2b3c4d5e6f708192a3b4c5d6e";

/** One `fix.dispatch` row as `runFixRung` writes it, with the regime left to the caller. */
function dispatchRow(strike: number, regime: string): Record<string, unknown> {
  return { task_id: "W1-T4033FIX", step: "fix.dispatch", strike, strike_cap: 2, mode: "ci-log", verdict_regime: regime, head_sha: HEAD };
}

test("W1-T4033: a fix round with no review criteria is not tagged keyword only", () => {
  // A ci-log / merge-conflict round: no reviewer verdict exists yet, so there are no criteria.
  assert.equal(strikeRegimeForDispatch([]), "executed");
});

test("W1-T4033: a round whose every proof is unexecutable stays keyword only", () => {
  // W1-T199's amnesty case, untouched: a JUDGED round whose proofs could not run.
  assert.equal(
    strikeRegimeForDispatch([{ proof_exec: "not_executable" }, { proof_exec: "not_executable" }]),
    "keyword_only",
  );
});

test("W1-T4033: a round with one executed proof is still tagged executed", () => {
  assert.equal(
    strikeRegimeForDispatch([{ proof_exec: "not_executable" }, { proof_exec: "executed_pass" }]),
    "executed",
  );
});

test("W1-T4033: a ci-log strike counts toward the cap under the executed regime", () => {
  // Two ci-log strikes on one head, tagged the way this fix tags them.
  const fixed = [dispatchRow(1, strikeRegimeForDispatch([])), dispatchRow(2, strikeRegimeForDispatch([]))];
  assert.equal(
    priorStrikesFor(fixed, "W1-T4033FIX", "executed", HEAD),
    2,
    "both ci-log strikes count, so the cap of 2 binds and the loop terminates",
  );

  // THE CONTROL: the identical ledger carrying the tag this fix replaces. If these two agreed,
  // the assertion above would be measuring nothing.
  const before = [dispatchRow(1, "keyword_only"), dispatchRow(2, "keyword_only")];
  assert.equal(
    priorStrikesFor(before, "W1-T4033FIX", "executed", HEAD),
    0,
    "the pre-fix tag is amnestied to zero — this is the defect, and it must still reproduce",
  );
});
