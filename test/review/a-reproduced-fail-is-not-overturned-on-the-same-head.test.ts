import assert from "node:assert/strict";
import { test } from "node:test";
import * as review from "#src/lib/review.js";
import * as reviewCommand from "#src/cli/commands/review.js";

const SHA = "90be1a69eaea5510184cf6eec69f7c72afd13c39";
const failureBody = `**remudero-review=failure**\n\n1. laneTarget's CPU bound is measured\n   - proof executed and PASSED on the PR head — NOTE: reviewer judged the proof non-responsive: an in-memory runDaemon replay adopting a review child in shadow mode throws ReferenceError at daemon.ts:4218. The proof omits review-child adoption.`;
const history = [
  { context: "remudero-review", state: "failure", created_at: "2026-11-05T22:11:12Z" },
  { context: "remudero-review", state: "success", created_at: "2026-11-05T22:33:28Z" },
];
const reviews = [{ commit_id: SHA, state: "COMMENTED", body: failureBody }];
const computed = {
  state: "success", summary: "PASS", criteria: [{ claim: "laneTarget's CPU bound is measured", proof: "unit test: laneTarget", met: true,
    floorMet: true, reason: "proof passed", proof_exec: "executed_pass" }],
  testTheater: false, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
};

test("W1-T11443 criterion 1: a same-head reproduced failure remains sticky after another machine posts PASS", () => {
  assert.equal(typeof review.reproducedReviewFailuresFromHistory, "function");
  assert.equal(typeof review.applyReviewStatusHistoryGuard, "function");
  assert.equal(typeof reviewCommand.readReviewStatusHistory, "function");
  const failures = review.reproducedReviewFailuresFromHistory(history, reviews, SHA);
  assert.equal(failures.length, 1);
  assert.match(failures[0].finding, /throws ReferenceError at daemon\.ts:4218/);
  const blocked = review.applyReviewStatusHistoryGuard(computed as never, SHA,
    { kind: "readable", failures }, "REVIEW_VERDICT 1: PASS");
  assert.equal(blocked.kind, "post");
  assert.equal(blocked.verdict.state, "failure");
  assert.match(blocked.verdict.summary, /ReferenceError at daemon\.ts:4218/);

  const addressed = `REVIEW_ADDRESSED_FAILURE 1: ${failures[0].id}\nREVIEW_VERDICT 1: PASS (re-ran the shadow adoption replay; no ReferenceError)`;
  const cleared = review.applyReviewStatusHistoryGuard(computed as never, SHA,
    { kind: "readable", failures }, addressed, [], failures.map((finding) => finding.id));
  assert.equal(cleared.kind, "post");
  assert.equal(cleared.verdict.state, "success");
});

test("W1-T11443 criterion 1: the shared reader queries status history and joins same-head PR review findings", async () => {
  const requests: string[][] = [];
  const result = await reviewCommand.readReviewStatusHistory("craigoley", "remudero", "https://github.com/craigoley/remudero/pull/16523", SHA,
    async (args) => {
      requests.push(args);
      return args.at(-1)?.includes("/statuses?") ? [history] : [reviews];
    });
  assert.equal(result.kind, "readable");
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].finding, /ReferenceError at daemon\.ts:4218/);
  assert.equal(requests[0].at(-1), `repos/craigoley/remudero/commits/${SHA}/statuses?per_page=100`);
  assert.equal(requests[1].at(-1), "repos/craigoley/remudero/pulls/16523/reviews?per_page=100");
});

test("W1-T11443 criterion 1: an addressed marker needs a resolution clause on the affected criterion", () => {
  const failures = review.reproducedReviewFailuresFromHistory(history, reviews, SHA);
  const result = review.applyReviewStatusHistoryGuard(computed as never, SHA, { kind: "readable", failures },
    `REVIEW_ADDRESSED_FAILURE 1: ${failures[0].id}\nREVIEW_VERDICT 1: PASS`, [], [failures[0].id]);
  assert.equal(result.verdict.state, "failure", "a bare PASS never explains the reproduction");
});

test("W1-T11443 criterion 1: another criterion cannot acknowledge the affected finding", () => {
  const failures = review.reproducedReviewFailuresFromHistory(history, reviews, SHA);
  const twoCriteria = { ...computed, criteria: [computed.criteria[0], computed.criteria[0]] };
  const result = review.applyReviewStatusHistoryGuard(twoCriteria as never, SHA, { kind: "readable", failures },
    `REVIEW_ADDRESSED_FAILURE 2: ${failures[0].id}\nREVIEW_VERDICT 2: PASS (re-ran the reproduction)`, [], [failures[0].id]);
  assert.equal(result.verdict.state, "failure");
});

test("W1-T11443 criterion 1: a finding discovered after the prompt cannot be acknowledged blindly", () => {
  const failures = review.reproducedReviewFailuresFromHistory(history, reviews, SHA);
  const result = review.applyReviewStatusHistoryGuard(computed as never, SHA, { kind: "readable", failures },
    `REVIEW_ADDRESSED_FAILURE 1: ${failures[0].id}\nREVIEW_VERDICT 1: PASS (re-ran the reproduction)`, [], []);
  assert.equal(result.verdict.state, "failure");
});

test("W1-T11443 criterion 1: compressed unmet numbering maps back to the affected acceptance claim", () => {
  const failures = review.reproducedReviewFailuresFromHistory(history, reviews, SHA);
  const twoCriteria = { ...computed, criteria: [{ ...computed.criteria[0], claim: "an unrelated first criterion" }, computed.criteria[0]] };
  const blocked = review.applyReviewStatusHistoryGuard(twoCriteria as never, SHA, { kind: "readable", failures });
  assert.equal(blocked.verdict.criteria[1].met, false, "the finding concerns acceptance criterion 2 despite being the first unmet item");
  assert.equal(blocked.verdict.criteria[0].met, true);
  const cleared = review.applyReviewStatusHistoryGuard(twoCriteria as never, SHA, { kind: "readable", failures },
    `REVIEW_ADDRESSED_FAILURE 2: ${failures[0].id}\nREVIEW_VERDICT 2: PASS (re-ran the shadow adoption reproduction)`, [], [failures[0].id]);
  assert.equal(cleared.verdict.state, "success");
});
