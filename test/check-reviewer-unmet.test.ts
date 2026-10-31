import { test } from "node:test";
import assert from "node:assert/strict";
import { renderImplementPrompt, renderImplementPromptWithParts, reviewerUnmetPrevention, reviewerUnmetRepeatPrevention } from "#src/lib/prompt-render.js";

test("W1-T6166: renderImplementPrompt is still renderImplementPromptWithParts' prompt", () => {
  const task = { id: "W1-T1", title: "t", files: [], acceptance: [] } as never;
  assert.equal(renderImplementPrompt(task, "recon", "run-1"), renderImplementPromptWithParts(task, "recon", "run-1").prompt);
});

test("W1-T6166: check:reviewer-unmet is prevented, not retried", () => {
  const empty = reviewerUnmetPrevention({ review: { unmetCriteria: [], summary: "  " } });
  assert.equal(empty.dispatch, false);
  assert.match((empty as { reason: string }).reason, /evidence is empty/);
  assert.equal(reviewerUnmetPrevention({}).dispatch, false);
  assert.equal(reviewerUnmetPrevention({ review: { unmetCriteria: [], summary: "needs work" } }).dispatch, true);
  assert.equal(reviewerUnmetPrevention({ ciFailures: [] }).dispatch, true);
});

test("W1-T10103: check:reviewer-unmet is prevented, not retried", () => {
  const u = (reason: string) => ({ review: { unmetCriteria: [{ criterionIndex: 0, reason }] as never, summary: "s" } });
  assert.equal(reviewerUnmetRepeatPrevention(u("a"), u("a")).dispatch, false);
  assert.equal(reviewerUnmetRepeatPrevention(u("a"), u("b")).dispatch, true);
  assert.equal(reviewerUnmetRepeatPrevention(u("a"), undefined).dispatch, true);
});
