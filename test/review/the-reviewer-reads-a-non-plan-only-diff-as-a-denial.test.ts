import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyContradictsDiff } from "#src/lib/review.js";

const CODE_DIFF = ["src/lib/review.ts"];
const SHORTHANDS = ["plan-only", "data-only"];

test("W1-T13264 criterion 1: a non- prefix denies a scope shorthand", () => {
  for (const shorthand of SHORTHANDS) {
    for (const body of [
      `The previous suite ran on a non-${shorthand} diff.`,
      `A NON-${shorthand.toUpperCase()} change.`,
      `Non-${shorthand}: source changed.`,
      `This PR is non-${shorthand}.`,
    ]) {
      assert.deepEqual(bodyContradictsDiff(body, CODE_DIFF), [], body);
    }
  }
});

test("W1-T13264 criterion 2: affirmative scope shorthands still contradict a code diff", () => {
  for (const shorthand of SHORTHANDS) {
    for (const body of [
      `${shorthand}: no source touched.`,
      `This PR is ${shorthand}.`,
      `A ${shorthand} change.`,
      `-${shorthand} change`,
      `The previous suite ran on a non-${shorthand} diff. This PR is ${shorthand}.`,
    ]) {
      assert.deepEqual(bodyContradictsDiff(body, CODE_DIFF), [{ claim: shorthand, files: CODE_DIFF }], body);
    }
  }
});
