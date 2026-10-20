import assert from "node:assert/strict";
import { test } from "node:test";

import { isFailureShapedStep } from "#src/lib/scout-gardener.js";

test("W1-T9265: inbox.draft_escalated no longer recurs", () => {
  // The ladder's escalation rung is a designed transition, not a symptom: the scout must not file it.
  assert.equal(isFailureShapedStep("inbox.draft_escalated"), false);
  // Real failures of the same family stay visible.
  assert.equal(isFailureShapedStep("pr.escalated"), true);
  assert.equal(isFailureShapedStep("inbox.draft_failed"), true);
});
