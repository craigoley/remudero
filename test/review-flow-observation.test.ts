import assert from "node:assert/strict";
import { test } from "node:test";
import { observeReviewFlow } from "../src/lib/review-flow-observation.js";

const asOf = "2026-10-05T12:00:00Z", start = "2026-10-04T12:00:00Z";
const event = (step: string, minute: number, over: Record<string, unknown> = {}) => ({ step,
  ts: `2026-10-05T10:${String(minute).padStart(2, "0")}:00Z`, pr_url: "https://github.com/a/b/pull/1",
  head_sha: "a".repeat(40), review_input_digest: "d".repeat(64), ...over });
const eligible = (minute = 0, over = {}) => event("sweep.review_eligible", minute, over);

test("review observations separate delivered failures semantic skips and missing source stages", () => {
  const report = observeReviewFlow([eligible(), event("sweep.review_admitted", 1), event("sweep.post_review.attempt", 2),
    event("review.posted", 3, { state: "failure", reviewer_outcome: "not_attempted" }),
    eligible(4, { pr_url: "https://github.com/a/b/pull/2" })], asOf, start);
  assert.equal(report.counts.delivered, 1);
  assert.equal(report.cohorts[0]!.deliveryState, "failure");
  assert.equal(report.semantic.notAttempted, 1);
  assert.deepEqual(report.completedOnly, { n: 1, medianMs: 180000, p95Ms: 180000 });
  assert.equal(report.counts.unresolvedSourceGap, 1);
  assert.deepEqual(report.cohorts[1]!.missingStages, ["admitted", "attempted", "posted"]);
  assert.equal(report.sourceComplete, false);
  assert.equal(report.retention, "uncertified");
});

test("review supersession follows a different exact input rather than repeated eligibility", () => {
  const newer = { review_input_digest: "e".repeat(64) };
  const rows = [eligible(), eligible(1), eligible(2, newer), eligible(3, newer),
    event("review.posted", 4, { ...newer, state: "success", reviewer_outcome: "success" })];
  assert.deepEqual(observeReviewFlow(rows, asOf, start).counts,
    { delivered: 1, superseded: 1, deliveredAfterSupersession: 0, unresolvedSourceGap: 0 });
  const late = observeReviewFlow([...rows, event("review.posted", 5, { state: "success" })], asOf, start);
  assert.equal(late.counts.deliveredAfterSupersession, 1);
  assert.equal(late.semantic.succeeded, 1);
  assert.equal(late.completedOnly.n, 1, "superseded inputs cannot inflate completed latency statistics");
});

test("review observations retain diagnostics and censor inputs born before the window", () => {
  const row = eligible();
  const report = observeReviewFlow([row, row, { step: "unrelated" }, { ...row, head_sha: undefined },
    { ...row, ts: "bad" }, { ...row, ts: "2026-10-06T10:00:00Z" },
    event("review.posted", 1, { state: "pending" }), event("review.posted", 1, { state: "success", pr_url: "orphan" }),
    { ...eligible(), ts: "2026-10-01T10:00:00Z", pr_url: "older" }], asOf, start);
  assert.deepEqual(report.diagnostics, { duplicates: 1, missingIdentity: 1, invalidTimestamp: 2, nonterminalPosts: 1, orphanInputs: 1 });
  assert.equal(report.cohorts.length, 1);
  assert.equal(report.completedOnly.p95Ms, null);
});

test("review observation uses terminal delivery without inventing semantic success or missing-stage timings", () => {
  const rows = [eligible(), event("review.posted", 2, { state: "success" }),
    eligible(3, { pr_url: "second" }), event("review.posted", 4, { pr_url: "second", state: "failure", reviewer_outcome: "error_exit_1" })];
  const report = observeReviewFlow(rows, asOf, start);
  assert.equal(report.semantic.unknown, 1);
  assert.equal(report.semantic.failed, 1);
  assert.equal(report.cohorts[0]!.attemptToPostMs, null);
  assert.deepEqual(report.cohorts[0]!.missingStages, ["admitted", "attempted"]);
});

test("review observation bounds detail without losing cohort counts and rejects invalid windows", () => {
  const report = observeReviewFlow(Array.from({ length: 205 }, (_, n) => eligible(0, { pr_url: `p${n}` })), asOf, start);
  assert.equal(report.counts.unresolvedSourceGap, 205);
  assert.equal(report.cohorts.length, 200);
  assert.equal(report.omittedCohorts, 5);
  assert.throws(() => observeReviewFlow([], "bad", start), /invalid bounded/);
  assert.throws(() => observeReviewFlow([], asOf, "2026-10-06T12:00:00Z"), /invalid bounded/);
  assert.throws(() => observeReviewFlow(Array(100001).fill({}), asOf, start), /invalid bounded/);
});
