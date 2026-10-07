import test from "node:test";
import assert from "node:assert/strict";
import { deliveredVerdictDedupsPostReview } from "../src/lib/sweep.js";

test("W1-T6047: flow-awaiting-review-checks-green-remudero-review-owner-proven-dead clears without a person", () => {
  // A delivered verdict with the status still pending (owner dead) must NOT dedup the re-run.
  assert.equal(deliveredVerdictDedupsPostReview({ reviewState: "pending" }, true), false);
  // Delivered verdicts still dedup when GitHub does not contradict them.
  assert.equal(deliveredVerdictDedupsPostReview({ reviewState: "none" }, true), true);
  assert.equal(deliveredVerdictDedupsPostReview({ reviewState: "pending" }, false), false);
});
