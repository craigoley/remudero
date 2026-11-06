import assert from "node:assert/strict";
import { test } from "node:test";
import * as review from "#src/lib/review.js";
import * as reviewCommand from "#src/cli/commands/review.js";
import { rmSync } from "node:fs";
import { ghShim } from "#test/helpers/gh-shim.js";

const SHA = "90be1a69eaea5510184cf6eec69f7c72afd13c39";
const computed = {
  state: "success", summary: "PASS", criteria: [{ claim: "claim", proof: "unit test: proof", met: true,
    floorMet: true, reason: "proof passed", proof_exec: "executed_pass" }],
  testTheater: false, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
};

test("W1-T11443 criterion 2: a same-head failure without a reproduction keeps today's PASS behavior", () => {
  assert.equal(typeof review.reproducedReviewFailuresFromHistory, "function");
  assert.equal(typeof review.applyReviewStatusHistoryGuard, "function");
  const failures = review.reproducedReviewFailuresFromHistory(
    [{ context: "remudero-review", state: "failure" }],
    [{ commit_id: SHA, state: "COMMENTED", body: "remudero-review=failure: unable to inspect" }], SHA);
  const result = review.applyReviewStatusHistoryGuard(computed as never, SHA,
    { kind: "readable", failures }, "REVIEW_VERDICT 1: PASS");
  assert.equal(result.kind, "post");
  assert.equal(result.verdict.state, "success");
});

test("W1-T11443 criterion 2: unreadable status history withholds SUCCESS and names the pending reason", () => {
  const result = review.applyReviewStatusHistoryGuard(computed as never, SHA,
    { kind: "unreadable", reason: "GitHub remudero-review status history unreadable: offline" }, "REVIEW_VERDICT 1: PASS");
  assert.equal(result.kind, "pending");
  assert.equal(result.verdict.state, "success");
  assert.match(result.reason, /status history unreadable: offline/);
});

test("W1-T11443 criterion 2: a failed GitHub history read returns an explicit unreadable reason", async () => {
  const result = await reviewCommand.readReviewStatusHistory(
    "craigoley", "remudero", "https://github.com/craigoley/remudero/pull/16523", SHA,
    async () => { throw new Error("offline"); });
  assert.equal(result.kind, "unreadable");
  assert.match(result.reason, /GitHub remudero-review status history unreadable: offline/);
});

test("W1-T11443 criterion 2: the default reader shells to a contained gh and refuses malformed history", async () => {
  const oldPath = process.env.PATH;
  const shim = ghShim([{ when: "/statuses?", stdout: "[[]]" }], { kind: "review-history-default" });
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    const readable = await reviewCommand.readReviewStatusHistory("acme", "remudero", "https://github.com/acme/remudero/pull/1", SHA);
    assert.deepEqual(readable, { kind: "readable", failures: [] });
    assert.ok(shim.calls().some(call => call.includes(`/commits/${SHA}/statuses?per_page=100`)));
    shim.addRoute({ when: "/statuses?", stdout: "{}" });
    const malformed = await reviewCommand.readReviewStatusHistory("acme", "remudero", "https://github.com/acme/remudero/pull/1", SHA);
    assert.equal(malformed.kind, "unreadable");
    const invalidPr = await reviewCommand.readReviewStatusHistory("acme", "remudero", "invalid", SHA);
    assert.equal(invalidPr.kind, "unreadable");
    assert.match(invalidPr.kind === "unreadable" ? invalidPr.reason : "", /PR number/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
});
