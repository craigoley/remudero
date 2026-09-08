import assert from "node:assert/strict";
import { test } from "node:test";

import { foreignHeadIsStuck } from "../src/run-task.js";

/**
 * W1-T3168 — THE NON-FLEET-HEAD ESCALATION FIRED ON A HEALTHY PR.
 *
 * MEASURED 2026-09-08: issues #4623 and #4624 asked the operator to discard PRs #4619 and #4621
 * minutes after they opened, both healthy; #4621 then merged on its own. The producer gated on head
 * OWNERSHIP (`terminalUncreditableHeads`) and never read whether the PR was stuck, while the
 * escalation's own consequence line asserted "The PR remains red".
 *
 * The predicate reads the rollup `OpenPrView` already carries, so it costs no extra GitHub read.
 */

const pr = (checksState: string, reviewState: string) =>
  ({ checksState, reviewState }) as Parameters<typeof foreignHeadIsStuck>[0];

// ── the measured shape: healthy, and must NOT escalate ────────────────────────────────────────

test("W1-T3168: a green PR with a passing review is NOT stuck — the #4619/#4621 shape", () => {
  assert.equal(foreignHeadIsStuck(pr("green", "success")), false);
});

test("W1-T3168: a PR whose checks are still RUNNING is not stuck — its author is presumably still working", () => {
  assert.equal(foreignHeadIsStuck(pr("pending", "pending")), false);
  assert.equal(foreignHeadIsStuck(pr("pending", "none")), false);
});

test("W1-T3168: green checks with no review yet is not stuck — an absent verdict is not a failing one", () => {
  assert.equal(foreignHeadIsStuck(pr("green", "none")), false);
});

// ── genuinely stuck: must STILL escalate, unchanged ───────────────────────────────────────────

test("W1-T3168: RED required checks are stuck, whatever the review says", () => {
  for (const review of ["success", "failure", "pending", "none"]) {
    assert.equal(foreignHeadIsStuck(pr("red", review)), true, `red + review=${review}`);
  }
});

test("W1-T3168: a FAILING review is stuck even while checks are green — the blocked_review shape", () => {
  assert.equal(foreignHeadIsStuck(pr("green", "failure")), true);
  assert.equal(foreignHeadIsStuck(pr("pending", "failure")), true);
});

// ── indeterminate: fail OPEN, the costly-direction rule ───────────────────────────────────────

test("W1-T3168: an UNREADABLE rollup escalates — 'none' is the absence of evidence, never evidence of health", () => {
  assert.equal(foreignHeadIsStuck(pr("none", "none")), true);
  assert.equal(foreignHeadIsStuck(pr("none", "success")), true);
});

// ── the discrimination the falsifier demands ──────────────────────────────────────────────────

test("W1-T3168 FALSIFIER: the predicate DISCRIMINATES — the same fixture set does not answer alike", () => {
  const healthy = [pr("green", "success"), pr("pending", "pending"), pr("green", "none")];
  const stuck = [pr("red", "success"), pr("green", "failure"), pr("none", "none")];
  assert.ok(healthy.every((p) => foreignHeadIsStuck(p) === false), "every healthy fixture reads not-stuck");
  assert.ok(stuck.every((p) => foreignHeadIsStuck(p) === true), "every stuck fixture reads stuck");
  // A predicate that answered alike in both directions would pass one of the two asserts above and
  // fail the other; a constant would fail exactly one. Both holding is the discrimination.
});
