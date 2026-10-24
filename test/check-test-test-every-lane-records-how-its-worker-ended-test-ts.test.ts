import assert from "node:assert/strict";
import { test } from "node:test";
import { preparePromisedReviewDecision, reviewDecisionDigest } from "#src/lib/review.js";
import { shadowJudgeSampled } from "#src/lib/shadow-judge.js";

test("W1-T9936: check:test:test/every-lane-records-how-its-worker-ended.test.ts is prevented, not retried", async () => {
  const headSha = "a".repeat(40);
  const prUrl = "https://github.com/acme/remudero/pull/1";
  const diff = "diff --git a/src/example.ts b/src/example.ts\n+export const fixed = true;\n";
  const input = {
    headSha, diff, report: "", body: "",
    acceptance: [{ claim: "the fixed source is present", proof: "grep: fixed in src/example.ts" }],
    declaredFiles: ["src/example.ts"],
  };
  const sampled = (digest: string) => shadowJudgeSampled(`review:${prUrl}:${headSha}:${digest}`);
  const decisions: { expected: string; actual: string; withoutNewline: string }[] = [];
  for (let i = 0; i < 100; i += 1) {
    const report = `the fixed source is present (${i})`;
    const decision = { ...input, report, body: report };
    const expected = reviewDecisionDigest(decision);
    if (sampled(expected)) continue;
    const prepared = await preparePromisedReviewDecision({
      input: { ...decision, diff: diff + "\n" },
      task: { id: "W1-T9936" }, ledgerPath: "/unused/ledger.ndjson", prUrl,
    });
    decisions.push({ expected, actual: prepared.decisionDigest,
      withoutNewline: reviewDecisionDigest({ ...decision, diff: diff.slice(0, -1) }) });
  }
  assert.ok(decisions.length > 0, "positive control: unsampled decisions were exercised");
  assert.equal(decisions.filter(({ actual }) => sampled(actual)).length, 0,
    "the gh shim's extra newline must not dispatch an unexpected shadow worker");
  for (const { expected, actual, withoutNewline } of decisions) {
    assert.equal(actual, expected, "the fixture and live decision must bind the same diff");
    assert.equal(withoutNewline, expected);
  }
  assert.notEqual(reviewDecisionDigest({ ...input, diff: diff.replace("true", "false") }),
    reviewDecisionDigest(input), "a changed source line remains material");
  assert.notEqual(reviewDecisionDigest({ ...input, diff: diff.replace("true;", "true; ") }),
    reviewDecisionDigest(input), "whitespace inside a diff line remains material");
});
