import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY, registerChildWork, runSweep, settleChildWork, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

test("the code time_to_merge stage recovers", async () => {
  const now = Date.parse("2026-11-24T20:02:00Z");
  const taskId = "W1-T14710";
  const pr: OpenPrView = {
    prNumber: 20731, prUrl: "https://github.com/craigoley/remudero/pull/20731",
    taskId, headSha: "77afb99a4", isPlanFiling: false, autoMergeArmed: false,
    lastActivityAt: new Date(now - 9 * 60_000).toISOString(),
    reviewState: "pending", checksState: "green", mergeState: "clean",
    changedFiles: ["src/lib/daemon.ts"], unmetCriteria: [], priorStrikes: 0,
  };
  const updates: string[] = [];
  const reviewRunId = "review-concurrent-distance-refresh";
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: "/tmp/rmd-concurrent-distance-refresh-fixture/ledger.ndjson",
    runId: "concurrent-distance-refresh", now: () => now,
    readLedger: () => [], appendLine: () => {},
    behindMainByPr: new Map([[pr.prNumber, 12]]),
    baseChangedFilesByPr: new Map([[pr.prNumber, { files: pr.changedFiles!, truncated: false }]]),
    readBranchProtectionStrict: () => false,
    refreshCiRunForHead: () => {
      registerChildWork({
        runId: reviewRunId, kind: "review", taskId, prNumber: pr.prNumber,
        headSha: pr.headSha, reviewKey: `${taskId}@${pr.headSha}`,
      });
      return false;
    },
    updateBranch: (candidate) => { updates.push(candidate.headSha); return "updated"; },
  };
  const policy = { ...DEFAULT_SWEEP_POLICY, reviewWaitingBranchRefreshEnabled: true, reviewWaitingBranchRefreshThreshold: 10 };
  try {
    await runSweep([pr], deps, policy);
    assert.deepEqual(updates, [], "a review that starts after selection keeps its head and avoids another CI cycle");
  } finally {
    settleChildWork(reviewRunId);
  }
  await runSweep([pr], { ...deps, refreshCiRunForHead: () => false }, policy);
  assert.deepEqual(updates, [pr.headSha], "a settled claim releases the refresh slot");
});
