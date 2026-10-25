import assert from "node:assert/strict";
import { test } from "node:test";
import { fitDependabotTitle, overHeaderLimit } from "#src/lib/dep-review.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("W1-T10403: hand_fix:src/lib/dep-review.ts is prevented, not retried", () => {
  // A short title already fits: no retitle round is spent.
  assert.deepEqual(fitDependabotTitle("build(deps): bump foo from 1.0.0 to 1.0.1", ""), { kind: "fits" });

  // An over-long clause-laden title is fitted by the lane itself, without a hand fix.
  const long = `build(deps): bump foo from 1.0.0 to 1.0.1 across 12 directories in the ${"x".repeat(80)} group`;
  assert.equal(overHeaderLimit(long), true);
  const fitted = fitDependabotTitle(long, "");
  assert.deepEqual(fitted, {
    kind: "fitted",
    title: "build(deps): bump foo from 1.0.0 to 1.0.1",
  });

  // A full-SHA action title whose body does not retain both pins is refused, never abbreviated.
  const action = `build(deps): bump ${"o".repeat(40)}/${"r".repeat(40)} from ${SHA_A} to ${SHA_B}`;
  assert.equal(overHeaderLimit(action), true);
  assert.deepEqual(fitDependabotTitle(action, ""), {
    kind: "unfittable",
    reason: "the body does not retain the action and both full SHA pins",
  });
});
