import { test } from "node:test";
import assert from "node:assert/strict";
// The classifier's own module (run-task.ts only re-exports it), so this suite does not reach run-task.ts.
import { shouldRecheckAfterNothingChanged } from "#src/lib/fix-rung-classify.js";

test("W1-T7748: fix-lane-commit-refused-the-worker-changed-nothing clears without a person", () => {
  assert.equal(shouldRecheckAfterNothingChanged("FIXED", "the worker changed nothing", 1), true);
  // a repeat at the same head stands down, so the re-read cannot loop
  assert.equal(shouldRecheckAfterNothingChanged("FIXED", "the worker changed nothing", 2), false);
  assert.equal(shouldRecheckAfterNothingChanged(undefined, "the worker changed nothing", 1), false);
  assert.equal(shouldRecheckAfterNothingChanged("FIXED", "other reason", 1), false);
});
