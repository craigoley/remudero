import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, runSweepLightPass,
  type OpenPrView, type ReviewDispatchMode, type SweepDeps,
} from "#test/helpers/sweep-test.js";

const now = Date.now();

const first: OpenPrView = {
  prNumber: 16041, prUrl: "https://github.com/acme/example/pull/16041", taskId: "W1-T13128",
  headSha: "a".repeat(40), checksState: "green", reviewState: "none", autoMergeArmed: false,
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date(now).toISOString(),
};
const pushed: OpenPrView = { ...first, headSha: "b".repeat(40), reviewOrphanedByPush: true };

async function runRefill(current: OpenPrView) {
  const reviews: Array<{ head: string; mode: ReviewDispatchMode | undefined }> = [];
  const rows: Array<Record<string, unknown>> = [];
  let live = first;
  let reads = 0;
  const deps: SweepDeps = {
    ledgerPath: "/unused", runId: "orphaned-review", now: () => now,
    readLedger: () => rows.slice(),
    appendLine: (_path, row) => { rows.push(row); },
    readActiveWorkerCount: () => 0,
    readOpenPrsForRefill: async () => { reads++; return [live]; },
    readLiveHeadSha: async () => live.headSha,
    arm: () => assert.fail("unexpected arm"), close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"), escalate: () => assert.fail("unexpected escalation"),
    postReview: (pr, mode) => {
      reviews.push({ head: pr.headSha, mode });
      if (pr.headSha === first.headSha) live = current;
    },
  };
  await runSweepLightPass([first], deps, { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1 });
  // The pass detaches its refill. Drain after the refill and its completed review have released their slots.
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(await drainInFlightReviews({ boundMs: 1000 }), 0);
  assert.ok(reads > 0, "a freed lane read the replacement view");
  return { reviews, rows };
}

test("W1-T13128: flow-awaiting-review-checks-green-review-orphaned-by-a-push-reviewed-on-an-earlier-he clears without a person", async () => {
  const { reviews, rows } = await runRefill(pushed);
  assert.deepEqual(reviews, [first, pushed].map(({ headSha }) => ({ head: headSha, mode: { kind: "full-review" } })));
  assert.deepEqual(rows.filter(row => row.step === "sweep.review_refilled").map(row => row.head_sha), [pushed.headSha]);
});

test("W1-T13128: flow-awaiting-review-checks-green-review-orphaned-by-a-push-reviewed-on-an-earlier-he leaves other blockers held", async t => {
  const cases = [
    ["red checks", { ...pushed, checksState: "red" }],
    ["pending CI", { ...pushed, checksState: "pending", checksPendingSince: new Date(now - 120_000).toISOString() }],
    ["fresh pending review", { ...pushed, reviewState: "pending", reviewPendingSince: first.lastActivityAt }],
    ["a draft with a verdict", { ...pushed, isDraft: true, reviewState: "success" }],
    ["unreadable required checks", { ...pushed, requiredContextsUnreadable: true }],
    ["a refused review post", { ...pushed, reviewPostRefused: true }],
    ["the orphan attempt cap", { ...pushed, priorReviewAttemptsForInput: DEFAULT_SWEEP_POLICY.reviewOrphanCap }],
    ["a replacement without an orphaned review", { ...pushed, reviewOrphanedByPush: false }],
    ["the same head", { ...pushed, headSha: first.headSha }],
  ] as const satisfies readonly (readonly [string, OpenPrView])[];
  for (const [name, current] of cases) {
    await t.test(name, async () => {
      const { reviews, rows } = await runRefill(current);
      assert.deepEqual(reviews.map(review => review.head), [first.headSha]);
      assert.equal(rows.some(row => row.step === "sweep.review_refilled"), false);
    });
  }
});
