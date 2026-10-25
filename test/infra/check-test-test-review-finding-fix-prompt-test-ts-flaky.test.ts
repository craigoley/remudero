import assert from "node:assert/strict";
import { test } from "node:test";
import { promptFrom } from "#test/helpers/review-finding-fix-prompt.js";

test("W1-T10306: check:test:test/review-finding-fix-prompt.test.ts:flaky is prevented, not retried", async () => {
  const head = "a".repeat(40);
  const finding = {
    step: "review.finding", task_id: "W1-T5019", pr_url: "https://github.com/acme/remudero/pull/1",
    head_sha: head, finding_id: "b".repeat(64), criterion_index: 3,
    category: "wiring", severity: "medium", capture_state: "verified",
    mechanism: "producer never reaches consumer", remedy: "connect the producer",
    anchor: { path: "src/changed.ts", line: 17, kind: "changed", status: "verified", evidenceDigest: "c".repeat(64) },
  };
  for (const sweep of [false, true]) {
    const prompt = await promptFrom([finding], sweep);
    assert.ok(prompt.includes("wire producer"));
    assert.ok(prompt.includes("keep all unmet"));
    assert.ok(prompt.includes("connect the producer"));
    const stale = await promptFrom([{ ...finding, head_sha: "e".repeat(40) }], sweep);
    assert.ok(stale.includes("wire producer"));
    assert.ok(!stale.includes("connect the producer"));
  }
});
