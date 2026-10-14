import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewerUnmetPrevention } from "../src/lib/prompt-render.js";

test("W1-T6166: check:reviewer-unmet is prevented, not retried", () => {
  const empty = reviewerUnmetPrevention({ review: { unmetCriteria: [], summary: "  " } });
  assert.equal(empty.dispatch, false);
  assert.match((empty as { reason: string }).reason, /evidence is empty/);
  assert.equal(reviewerUnmetPrevention({}).dispatch, false);
  assert.equal(reviewerUnmetPrevention({ review: { unmetCriteria: [], summary: "needs work" } }).dispatch, true);
  assert.equal(reviewerUnmetPrevention({ ciFailures: [] }).dispatch, true);
});
