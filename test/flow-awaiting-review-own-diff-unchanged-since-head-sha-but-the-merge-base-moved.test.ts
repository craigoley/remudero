/**
 * W1-T9510 — the `awaiting-review:own diff unchanged since head <sha> but the merge base moved`
 * blocker (the green-checks `discriminate-only` row) clears without a person: with main's delta
 * unable to reach what the review judged, the sweep reuses the verdict and posts it itself.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runSweep, type OpenPrView, type ReviewDispatchMode, type SweepDeps } from "#src/lib/sweep.js";
import { readLedgerLines } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const JUDGED_HEAD = "3189f4c3189f4c3189f4c3189f4c3189f4c3189f";

function greenPr(): OpenPrView {
  return {
    prNumber: 11710,
    prUrl: "https://github.com/craigoley/remudero/pull/11710",
    taskId: "W1-T9510F",
    headRefName: "run-W1-T9510F-1792386199596",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-19T11:00:00Z",
    headSha: "beadbeadbeadbeadbeadbeadbeadbeadbeadbead",
    autoMergeArmed: false,
    reviewOrphanedByPush: true,
    priorReviewAttemptsForInput: 0,
    reviewedOwnDiffDigest: "own:same",
    currentOwnDiffDigest: "own:same",
    reviewedContractDigest: "contract:same",
    currentContractDigest: "contract:same",
    reviewedMergeBaseSha: "oldbase",
    currentMergeBaseSha: "newbase",
    reviewedHeadSha: JUDGED_HEAD,
  } as OpenPrView;
}

test("W1-T9510: flow-awaiting-review-own-diff-unchanged-since-head-sha-but-the-merge-base-moved clears without a person", async (t) => {
  const modes: Array<ReviewDispatchMode | undefined> = [];
  const ledgerPath = writeLedger([], { scope: t }).path;
  const deps: SweepDeps = {
    arm: () => assert.fail("a review disposition never arms"),
    close: () => assert.fail("a review disposition never closes"),
    dispatchFix: () => assert.fail("a review disposition never dispatches a fix"),
    escalate: () => assert.fail("an unchanged own diff never escalates to a person"),
    postReview: async (_pr, mode) => {
      modes.push(mode);
    },
    readReviewReuseReach: async () => ({
      mainChangedFiles: ["docs/unrelated.md"],
      prFiles: ["src/lib/feature.ts"],
      proofTargetPaths: [],
      proofTestFiles: [],
      closure: new Map(),
    }),
    ledgerPath,
    runId: "W1-T9510",
    now: () => NOW,
  };
  await runSweep([greenPr()], deps);
  assert.deepEqual(modes, [{ kind: "reuse", judgedHeadSha: JUDGED_HEAD }],
    "main cannot reach the review, so the sweep reuses the verdict from the judged head");
  const rows = readLedgerLines(ledgerPath);
  const reach = rows.find((line) => line.step === "sweep.review_reuse_reach");
  assert.equal(reach?.requested_review_mode, "discriminate-only");
  assert.equal(reach?.effective_review_mode, "reuse");
  assert.deepEqual(reach?.counted_paths, []);
  assert.equal(reach?.reach_complete, true);
  const disposed = rows.find((line) => line.step === "sweep.disposed");
  assert.equal(disposed?.disposition, "review-reused");
});
