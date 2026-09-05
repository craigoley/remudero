import assert from "node:assert/strict";
import { test } from "node:test";

import { bodyContradictsDiff } from "../src/lib/review.js";

/**
 * test/a-verdict-state-named-in-prose-is-read-as-a-scope-claim.test.ts — W1-T2679.
 *
 * MEASURED ON #3569: CI was green across 36 checks and the review posted
 * `FAIL — body contradicts its own diff: claimed "plan-only"`. The body never claimed it. The
 * phrase appeared three times, each the NAME OF A VERDICT STATE the PR's own logic switches on.
 * Two were followed by a comma and harmless; the third sat as `(capped+override, capped+plan-only):`
 * — a closing bracket then a colon, which is exactly the label shape W1-T395 ruled a claim.
 *
 * The fix narrows the LABEL arm alone: a shorthand that is a sibling inside a still-open bracket
 * containing a comma is a list member, not a label. Every other arm is untouched, and the two
 * halves below are what make that checkable — the false positive must stop firing AND a real
 * `plan-only:` claim over a src-touching diff must still fail. Without the second, this change is
 * indistinguishable from deleting the arm.
 */

const SRC_DIFF = ["src/lib/review.ts", "test/a-verdict-state-named-in-prose-is-read-as-a-scope-claim.test.ts"];
const fires = (body: string, files: readonly string[] = SRC_DIFF): boolean =>
  bodyContradictsDiff(body, [...files]).length > 0;

test("W1-T2679: a state name inside a parenthesised enumeration is not read as a scope claim", () => {
  assert.equal(fires("The two capped shapes (capped+override, capped+plan-only): both arm."), false);
  assert.equal(fires("States [capped+override, capped+data-only]: neither arms."), false);
  // Three or more siblings, and the shorthand in a non-final position.
  assert.equal(fires("Bands (capped+plan-only, capped+override, uncapped): are calibrated apart."), false);
});

test("W1-T2679: a genuine plan-only label over a src-touching diff still FAILS, so the arm is not deleted", () => {
  assert.equal(fires("plan-only: no source touched."), true);
  assert.equal(fires("**Plan-only**: one file added."), true);
  // W1-T395's own fixture: a bracket with NO comma is still a label span, not an enumeration.
  assert.equal(fires("(Plan-only): no source touched."), true);
  assert.equal(fires("(Data-only): no code."), true);
});

test("W1-T2679: the copular and attributive arms are unchanged, so only the label arm's shape moves", () => {
  // Copular — unchanged, and reached without any bracket at all.
  assert.equal(fires("This PR is plan-only."), true);
  assert.equal(fires("The diff is data-only."), true);
  // Attributive — unchanged.
  assert.equal(fires("plan-only change."), true);
  // Still silent, as before: the concept named without predicating it of this diff.
  assert.equal(fires("A merged PR is plan-only when its whole file list sits under the plan directory."), false);
  assert.equal(fires("proof: unit test: test/trailer-credit-plan-only.test.ts"), false);
  // A copular claim inside an enumeration's brackets is NOT reached by the label arm, so the
  // narrowing must not silence it — this is the arm-isolation control.
  assert.equal(fires("Two states (a, b) and this diff is plan-only."), true);
});

test("W1-T2679: the observed #3569 body yields zero contradictions while its diff is unchanged", () => {
  const observed = [
    "## Calibration",
    "",
    "The verdict states this PR moves are the two capped shapes",
    "(capped+override, capped+plan-only): each is graded by its own band, and the",
    "override arm is the one that changes here. A capped+plan-only verdict is",
    "recorded, never inferred.",
  ].join("\n");
  assert.deepEqual(bodyContradictsDiff(observed, [...SRC_DIFF]), []);
  // The control that makes that zero a measurement: the SAME body with the enumeration's comma
  // removed is a label again, and fails. So the comma is what the fix keys on, not the words.
  assert.ok(fires(observed.replace("(capped+override, capped+plan-only):", "(capped+plan-only):")));
});

test("W1-T2679: data-only gets the identical treatment, since it is the same shape one line down", () => {
  assert.equal(fires("The pair (capped+override, capped+data-only): are graded apart."), false);
  assert.equal(fires("data-only: no code."), true);
  // Both shorthands enumerated together stay silent.
  assert.equal(fires("States (capped+plan-only, capped+data-only): are distinct."), false);
});

test("W1-T2679: a bracket the shorthand is NOT inside does not exempt it", () => {
  // The bracket closes BEFORE the shorthand, so nothing is open at the shorthand's position and
  // the label arm must still fire. This is what stops the guard becoming a blanket exemption for
  // any line that happens to contain a comma and a bracket.
  assert.equal(fires("Given the bands (a, b), plan-only: no source touched."), true);
  // A comma outside the open bracket does not make an enumeration either.
  assert.equal(fires("First, second (plan-only): no source touched."), true);
});
