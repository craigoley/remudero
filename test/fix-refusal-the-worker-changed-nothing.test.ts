import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSelfHealNothingChanged } from "#src/lib/fix-rung-classify.js";

const R = "the worker changed nothing";

test("W1-T5334: fix_refusal:the-worker-changed-nothing is prevented, not retried", () => {
  assert.equal(shouldSelfHealNothingChanged("FIXED", R, 1), true);
  assert.equal(shouldSelfHealNothingChanged(undefined, R, 1), true);
  assert.equal(shouldSelfHealNothingChanged("FLAKE", R, 1), true);
  assert.equal(shouldSelfHealNothingChanged("BASE_RED", R, 1), false);
  assert.equal(shouldSelfHealNothingChanged(undefined, R, 2), false);
  assert.equal(shouldSelfHealNothingChanged("FIXED", R, 2), false);
  assert.equal(shouldSelfHealNothingChanged("FLAKE", R, 2), false);
  assert.equal(shouldSelfHealNothingChanged("FIXED", "other reason", 1), false);
  assert.equal(shouldSelfHealNothingChanged(undefined, "other reason", 1), false);
});
