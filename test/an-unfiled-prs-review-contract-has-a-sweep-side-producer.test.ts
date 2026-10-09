import assert from "node:assert/strict";
import { test } from "node:test";
import { hydrateReviewReuseFacts, ownDiffDigestFromCompareFiles } from "../src/lib/open-prs-rest.js";
import { DEFAULT_RISK } from "../src/lib/plan.js";
import * as review from "../src/lib/review.js";
import { parseAcceptanceBlock, reviewContractDigest } from "../src/lib/review.js";

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

test("an unfiled PR's body acceptance yields the contract digest its review recorded, in either review mode", () => {
  const body = "## Acceptance\n- the change works | grep: example in src/example.ts\n";
  const acceptance = parseAcceptanceBlock(body);
  const deterministic = reviewContractDigest({ taskId: "PR-5718", acceptance });
  const semantic = reviewContractDigest({ taskId: "PR-5718", acceptance, risk: DEFAULT_RISK, budgetUsd: 15 });
  // A namespace read, so a tree without the producer fails THIS test rather than the module load.
  const digest = (recordedDigest: string | undefined, unfiled = true, text = body) => review.bodyReviewContractDigest({
    reviewLedgerKey: "PR-5718", body: text, unfiled, recordedDigest, semanticRisk: DEFAULT_RISK, semanticBudgetUsd: 15,
  });
  assert.equal(digest(deterministic), deterministic);
  assert.equal(digest(semantic), semantic);
  assert.equal(digest(undefined), deterministic, "no recorded review keeps the deterministic contract");
  assert.equal(digest(semantic, false), deterministic, "a filed id never takes the untasked semantic defaults");
  assert.equal(digest(semantic, true, body.replace("change works", "change differs")) === semantic, false);
  assert.equal(digest(semantic, true, "## Summary\nno acceptance"), undefined);
});
