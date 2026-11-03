import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveFixMode, renderFixPrompt, sameHeadReviewUnmet, type FixEvidence } from "#src/lib/prompt-render.js";

const PR = "https://github.com/craigoley/remudero/pull/16240";
const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);
const FINDING = "attributable inbox-draft calls hit `continue` before any truncated-reply fire is counted (field-trials-flow.ts:855)";

function posted(head: string, state: "failure" | "success", criteria: unknown[]): Record<string, unknown> {
  return { step: "review.posted", pr_url: PR, head_sha: head, state, decision_verdict: { criteria } };
}

const criteria = [
  { claim: "every guardrail fire is counted per model", proof: "unit test: counts fires", met: true, reason: "ok", proof_exec: "executed_pass" },
  { claim: "inbox drafts count their truncation fires", proof: "unit test: drafts", met: false, reason: `matched 4/4 proof keywords — NOTE: reviewer judged the proof non-responsive (semantic downgrade): ${FINDING}`, proof_exec: "executed_pass" },
];

test("test/worker/a-ci-log-fix-round-carries-the-same-head-review-findings.test.ts", () => {
  const rows = [posted(OLDER, "failure", [{ ...criteria[1], claim: "an older head's claim" }]), posted(HEAD, "failure", criteria)];
  const unmet = sameHeadReviewUnmet(rows, PR, HEAD);
  assert.deepEqual(unmet.map((c) => [c.criterionIndex, c.claim]), [[2, "inbox drafts count their truncation fires"]],
    "only the same-head review's unmet criteria, at their own criterion index");
  assert.ok(unmet[0]!.reason.includes(FINDING), "the reviewer's finding rides along");
  assert.deepEqual(sameHeadReviewUnmet([posted(OLDER, "failure", criteria)], PR, HEAD), [], "a review at another head is not carried");
  assert.deepEqual(sameHeadReviewUnmet([...rows, posted(HEAD, "success", criteria)], PR, HEAD), [], "the newest same-head review decides");
  assert.deepEqual(sameHeadReviewUnmet(rows, "https://github.com/craigoley/remudero/pull/1", HEAD), [], "another PR's review is not carried");
  const hidden = sameHeadReviewUnmet(rows, PR, HEAD, [{ claim: "a", proof: "b" }, { claim: "c", proof: "d", holdout: true }]);
  assert.deepEqual(hidden, [], "a holdout criterion stays worker-hidden");
});

function ciLog(review?: FixEvidence["review"]): FixEvidence {
  return { ciFailures: [{ name: "coverage-shard (2/8)", logTail: "not ok 4 - a stale source makes the view stale", conclusion: "FAILURE" }], ...(review ? { review } : {}) };
}

const render = (evidence: FixEvidence) => renderFixPrompt({ task: { id: "W1-T10877", title: "guardrail fires", files: ["src/lib/field-trials-flow.ts"] }, round: 1, branch: "run-W1-T10877-1", evidence });

test("W1-T11211 criterion 2: the ci-log prompt names same-head review findings as current, and is unchanged without one", () => {
  const unmet = sameHeadReviewUnmet([posted(HEAD, "failure", criteria)], PR, HEAD);
  const review: FixEvidence["review"] = { unmetCriteria: unmet, summary: "1 criterion unmet",
    findings: [{ criterionIndex: 2, path: "src/lib/field-trials-flow.ts", line: 855, mechanism: "the draft branch continues first", remedy: "count before continue" }] };
  assert.equal(deriveFixMode(ciLog(review)), "ci-log", "the CI red is still this round's target");
  const withReview = render(ciLog(review));
  assert.ok(withReview.includes("A review at this exact head also judged these criteria unmet — current, not stale:"));
  assert.ok(withReview.includes(FINDING), "the reviewer's finding reaches the worker");
  assert.ok(withReview.includes("src/lib/field-trials-flow.ts:855"), "its verified finding rides in its envelope");
  assert.ok(!withReview.includes("may simply be STALE"), "a same-head review is never called stale");
  assert.ok(withReview.indexOf("coverage-shard (2/8)") < withReview.indexOf(FINDING), "the CI failures come first");

  const plain = render(ciLog());
  assert.ok(plain.includes("may simply be STALE"), "with no same-head review the stale caution stays");
  assert.ok(!plain.includes("current, not stale"));
  const unbound = (prompt: string) => prompt.replace(/boundary="[^"]+"/g, 'boundary=""');
  assert.equal(unbound(plain), unbound(render(ciLog({ unmetCriteria: [], summary: "" }))), "an empty review renders exactly as none");
});
