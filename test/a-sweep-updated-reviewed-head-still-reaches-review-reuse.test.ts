import { strict as assert } from "node:assert";
import { test } from "node:test";
import { reviewOrphansFor } from "../src/run-task.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView } from "../src/lib/sweep.js";

/**
 * W1-T5713 — `reviewOrphansFor` used to skip every head the sweep itself superseded, so after a
 * merge-from-main `orphanedByPush` stayed false, the reuse rows never matched, and the PR fell to
 * a full review under "review never posted". Every fixture here DERIVES the orphan field from the
 * real `reviewOrphansFor` and feeds the real `deriveDisposition`; nothing hand-sets it.
 */

const TASK = "W1-T5713";
const CURRENT = "cafe1234cafe1234cafe1234cafe1234cafe1234";
const SWEPT = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const FOREIGN = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
const NOW = Date.parse("2026-10-06T12:00:00.000Z");

function line(step: string, headSha: string, ts?: string): Record<string, unknown> {
  return ts === undefined ? { step, task_id: TASK, head_sha: headSha } : { step, task_id: TASK, head_sha: headSha, ts };
}

function view(facts: ReturnType<typeof reviewOrphansFor>, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9999,
    prUrl: "https://github.com/craigoley/remudero/pull/9999",
    taskId: TASK,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: "2026-10-06T11:55:00.000Z",
    headSha: CURRENT,
    autoMergeArmed: false,
    isDependabot: false,
    reviewOrphanedByPush: facts.orphanedByPush,
    priorReviewAttemptsForInput: 0,
    // Unchanged own diff and contract, moved merge base: the merge-from-main shape.
    reviewedOwnDiffDigest: "own-diff:same",
    currentOwnDiffDigest: "own-diff:same",
    reviewedContractDigest: "contract:same",
    currentContractDigest: "contract:same",
    reviewedMergeBaseSha: "base-old",
    currentMergeBaseSha: "base-new",
    reviewedHeadSha: SWEPT,
    ...over,
  } as OpenPrView;
}

test("unit test: test/a-sweep-updated-reviewed-head-still-reaches-review-reuse.test.ts", () => {
  // (1) a sweep-updated reviewed head is an orphan the reuse rows can see, with no strike spent.
  const sweepLedger = [
    line("review.posted", SWEPT, "2026-10-06T11:00:00.000Z"),
    line("sweep.update_branch.attempted", SWEPT),
    line("sweep.update_branch.updated", SWEPT),
  ];
  const facts = reviewOrphansFor(sweepLedger, TASK, CURRENT);
  assert.deepEqual(facts, { orphanedByPush: true, priorOrphans: 0 }, "orphan is visible, no strike and no clock");
  assert.equal("lastAttemptAt" in facts, false, "a sweep-superseded head sets no orphan clock");

  const swept = deriveDisposition(view(facts), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(swept.disposition, "discriminate-only", "unchanged own diff + contract: discrimination alone, not post-review");

  // (2) an identical merge base reuses the verdict outright.
  const reused = deriveDisposition(view(facts, { currentMergeBaseSha: "base-old" }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(reused.disposition, "review-reused");

  // (3) a changed own diff still earns a full review — reuse is gated on the digests, not on the orphan.
  const changed = deriveDisposition(view(facts, { currentOwnDiffDigest: "own-diff:different" }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(changed.disposition, "post-review");

  // (4) a foreign push is still counted, and its clock still reads.
  const foreign = reviewOrphansFor(
    [...sweepLedger, line("review.posted", FOREIGN, "2026-10-06T11:30:00.000Z")],
    TASK,
    CURRENT,
  );
  assert.equal(foreign.orphanedByPush, true);
  assert.equal(foreign.priorOrphans, 1, "only the foreign head is counted beside the sweep-superseded one");
  assert.equal(foreign.lastAttemptAt, "2026-10-06T11:30:00.000Z", "the clock is the foreign head's, not the sweep head's");

  // (5) a failed update minted no replacement head, so it is still a counted orphan.
  const failed = reviewOrphansFor(
    [line("review.posted", SWEPT), line("sweep.update_branch.conflict", SWEPT)],
    TASK,
    CURRENT,
  );
  assert.equal(failed.priorOrphans, 1);

  // (6) a sweep update with no review ever posted on that head is not an orphan.
  assert.deepEqual(reviewOrphansFor([line("sweep.update_branch.updated", SWEPT)], TASK, CURRENT), {
    orphanedByPush: false,
    priorOrphans: 0,
  });
});
