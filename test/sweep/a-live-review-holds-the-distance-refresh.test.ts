/**
 * W1-T14741 — A LIVE REVIEW HOLDS THE DISTANCE REFRESH.
 *
 * OBSERVED 2026-11-24, PR 20731: a review took the claim at 19:53Z, the sweep refreshed the branch for distance at
 * 20:02Z, and the review's PASS at 20:24Z was refused because its input had changed. openPrsBehindMain now leaves a PR
 * alone while a run's claim on its review is live; an unclaimed pending, or a claim whose owner is proven dead, holds nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SWEEP_POLICY, openPrsBehindMain, type OpenPrView } from "#test/helpers/sweep-test.js";

const POLICY = { ...DEFAULT_SWEEP_POLICY, reviewWaitingBranchRefreshEnabled: true, reviewWaitingBranchRefreshThreshold: 10 };
const BEHIND = new Map([[20731, 12]]);
const BASE_FILES = new Map([[20731, { files: ["src/lib/daemon.ts"], truncated: false }]]);

function pr(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 20731,
    prUrl: "https://github.com/craigoley/remudero/pull/20731",
    taskId: "W1-T14710",
    headSha: "77afb99a4",
    lastActivityAt: "2026-11-24T19:53:01.000Z",
    reviewState: "pending",
    reviewPendingOwnerRunId: "review-PR20731-1795549945871",
    reviewPendingStatusRunId: "review-PR20731-1795549945871",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    autoMergeArmed: false,
    mergeState: "clean",
    changedFiles: ["src/lib/daemon.ts"],
    ...overrides,
  };
}

test("W1-T14741 a pr whose review is pending under a live owner is not refreshed for distance", () => {
  assert.deepEqual(openPrsBehindMain([pr()], BEHIND, POLICY, new Set(), BASE_FILES), []);
  assert.deepEqual(openPrsBehindMain([pr({ reviewPendingOwnerRunId: undefined })], BEHIND, POLICY, new Set(), BASE_FILES), [],
    "a status naming the run is a claim too");
  // Control: the same PR waiting for a review nobody has claimed is refreshed for the overlap, as before.
  const unclaimed = pr({ reviewPendingOwnerRunId: undefined, reviewPendingStatusRunId: undefined });
  assert.equal(openPrsBehindMain([unclaimed], BEHIND, POLICY, new Set(), BASE_FILES)[0]?.updateReason, "distance-overlap");
});

test("W1-T14741 a pending claim whose owner is proven dead does not hold the distance refresh", () => {
  for (const dead of [{ reviewPendingOwnerPidProven: true }, { reviewPendingOwnerDead: true }] as Partial<OpenPrView>[]) {
    const out = openPrsBehindMain([pr(dead)], BEHIND, POLICY, new Set(), BASE_FILES);
    assert.equal(out[0]?.updateReason, "distance-overlap", JSON.stringify(dead));
  }
});
