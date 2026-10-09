import assert from "node:assert/strict";
import { test } from "node:test";
import { hydrateReviewReuseFacts, ownDiffDigestFromCompareFiles } from "../src/lib/open-prs-rest.js";

// The sweep integration proofs live in a-run-unfiled-prs-review-verdict-is-its-own.test.ts.
const FILES = [{ filename: "src/example.ts", status: "modified", sha: "blob1" }];

test("unfiled review hydration preserves each failed PR's reason and continues to the next PR", () => {
  const asked: string[] = [];
  const failures: Array<{ prNumber: number; reason: string }> = [];
  const facts = hydrateReviewReuseFacts("o", "r", "main", [
    { number: 5714, headRefOid: "denied" },
    { number: 5715, headRefOid: "malformed" },
    { number: 5716, headRefOid: "good" },
    { number: 5717, headRefOid: "unasked" },
  ], (args) => {
    const path = args.at(-1)!;
    asked.push(path);
    if (path.endsWith("...denied")) throw new Error("compare denied for this head");
    if (path.endsWith("...malformed")) return { files: FILES };
    assert.ok(path.endsWith("...good"), "the capped PR must not be fetched");
    return { merge_base_commit: { sha: "base1" }, files: FILES };
  }, 3, (prNumber, reason) => failures.push({ prNumber, reason }));

  assert.deepEqual(asked, [
    "repos/o/r/compare/main...denied",
    "repos/o/r/compare/main...malformed",
    "repos/o/r/compare/main...good",
  ]);
  assert.deepEqual(failures, [
    { prNumber: 5714, reason: "compare denied for this head" },
    { prNumber: 5715, reason: "review-reuse compare carried no merge_base_commit.sha" },
  ]);
  assert.deepEqual([...facts], [[5716, {
    ownDiffDigest: ownDiffDigestFromCompareFiles(FILES), mergeBaseSha: "base1",
  }]]);
});

test("unreviewed PRs cost no hydration reads or failure callbacks", () => {
  const facts = hydrateReviewReuseFacts("o", "r", "main", [],
    () => assert.fail("no orphaned review means no compare"), undefined,
    () => assert.fail("an unattempted read is not a failure"));
  assert.deepEqual([...facts], []);
});
