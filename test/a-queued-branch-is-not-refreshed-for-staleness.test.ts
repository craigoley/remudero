import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  selectUpdateBranchTarget,
  type ArmedStalledPr,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "./helpers/sweep-test.js";

// Every age below is read against this frozen NOW, never the wall clock.
const NOW = Date.parse("2026-10-05T12:00:00Z");
const POLICY: SweepPolicy = {
  ...DEFAULT_SWEEP_POLICY,
  reviewWaitingBranchRefreshEnabled: true,
  reviewWaitingBranchRefreshThreshold: 10,
};

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 5903,
    prUrl: "https://github.com/craigoley/remudero/pull/5903",
    taskId: "W1-T5903",
    reviewState: "pending",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    // expiring-fixture: exempt -- aged against the frozen NOW above, never Date.now()
    lastActivityAt: "2026-10-05T11:00:00Z",
    headSha: "head5903",
    autoMergeArmed: false,
    mergeState: "clean",
    ...over,
  };
}

function harness(over: Partial<SweepDeps>) {
  const rows: Array<Record<string, unknown>> = [];
  const updated: ArmedStalledPr[] = [];
  const queueReads: string[] = [];
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: "/tmp/rmd-w1-t5903-ledger.ndjson",
    runId: "SWEEP-W1-T5903",
    now: () => NOW,
    readLedger: () => [],
    appendLine: (_path, line) => {
      rows.push(line as Record<string, unknown>);
    },
    updateBranch: (candidate) => {
      updated.push(candidate);
      return "updated";
    },
    ...over,
  };
  return { deps, rows, updated, queueReads };
}

const skipRows = (rows: Array<Record<string, unknown>>) =>
  rows.filter((r) => r.step === "sweep.update_branch.skipped_queue");

test("a review-waiting PR 11 commits behind is not refreshed when the base requires a merge queue", async () => {
  const behind = pr({ prNumber: 5910, prUrl: "https://github.com/craigoley/remudero/pull/5910", headSha: "behind-head" });
  const behindMainByPr = new Map([[5910, 11]]);

  // WITH A QUEUE: not selected, one skipped_queue row names the PR and its head.
  assert.equal(
    selectUpdateBranchTarget([behind], NOW, new Set(), new Map(), new Set(), behindMainByPr, POLICY, new Set([5910])),
    undefined,
  );
  const queued = harness({ behindMainByPr, mergeQueue: () => true });
  await runSweep([behind], queued.deps, POLICY);
  assert.deepEqual(queued.updated, [], "the queue validates the merged result: no refresh");
  const skips = skipRows(queued.rows);
  assert.equal(skips.length, 1);
  assert.equal(skips[0]?.pr_number, 5910);
  assert.equal(skips[0]?.head_sha, "behind-head");
  assert.equal(skips[0]?.behind_by, 11);

  // ONE ROW PER PR AND HEAD: a later pass on the same head, with the row already in the ledger,
  // writes no second row.
  const again = harness({
    behindMainByPr,
    mergeQueue: () => true,
    readLedger: () => [{ step: "sweep.update_branch.skipped_queue", pr_number: 5910, head_sha: "behind-head" }],
  });
  await runSweep([behind], again.deps, POLICY);
  assert.deepEqual(skipRows(again.rows), []);
  assert.deepEqual(again.updated, []);

  // A NEW HEAD earns its own row.
  const newHead = harness({
    behindMainByPr,
    mergeQueue: () => true,
    readLedger: () => [{ step: "sweep.update_branch.skipped_queue", pr_number: 5910, head_sha: "older-head" }],
  });
  await runSweep([{ ...behind, headSha: "newer-head" }], newHead.deps, POLICY);
  assert.equal(skipRows(newHead.rows).length, 1);

  // A QUEUE READ THAT THROWS reads as no queue.
  const broken = harness({
    behindMainByPr,
    mergeQueue: () => {
      throw new Error("HTTP 502");
    },
  });
  await runSweep([behind], broken.deps, POLICY);
  assert.deepEqual(broken.updated.map((c) => c.prNumber), [5910]);
  assert.deepEqual(skipRows(broken.rows), []);

  // WITHOUT A QUEUE: the behind-main refresh selects it as before.
  const none = harness({ behindMainByPr, mergeQueue: () => false });
  await runSweep([behind], none.deps, POLICY);
  assert.deepEqual(none.updated.map((c) => c.prNumber), [5910]);
  assert.equal(none.updated[0]?.updateReason, "distance");
  assert.deepEqual(skipRows(none.rows), []);
  const unwired = harness({ behindMainByPr });
  await runSweep([behind], unwired.deps, POLICY);
  assert.deepEqual(unwired.updated.map((c) => c.prNumber), [5910]);
});

test("an armed-but-stalled PR is still refreshed under a merge queue", async () => {
  const stalled = pr({
    prNumber: 5911,
    prUrl: "https://github.com/craigoley/remudero/pull/5911",
    headSha: "stalled-head",
    autoMergeArmed: true,
    mergeState: "behind",
  });
  assert.equal(
    selectUpdateBranchTarget([stalled], NOW, new Set(), new Map(), new Set(), new Map(), POLICY, new Set([5911]))?.prNumber,
    5911,
  );
  const h = harness({ mergeQueue: () => true });
  await runSweep([stalled], h.deps, POLICY);
  assert.deepEqual(h.updated.map((c) => c.prNumber), [5911]);
  assert.equal(h.updated[0]?.updateReason, "armed-stalled");
});

test("a stale-gate red PR is still refreshed under a merge queue", async () => {
  const red = pr({
    prNumber: 5912,
    prUrl: "https://github.com/craigoley/remudero/pull/5912",
    headSha: "red-head",
    checksState: "red",
  });
  const staleGateWorkflowsByPr = new Map<number, readonly string[]>([[5912, ["lint-plan"]]]);
  const picked = selectUpdateBranchTarget(
    [red], NOW, new Set(), staleGateWorkflowsByPr, new Set(), new Map(), POLICY, new Set([5912]),
  );
  assert.equal(picked?.prNumber, 5912);
  assert.equal(picked?.updateReason, "stale-gate");
});
