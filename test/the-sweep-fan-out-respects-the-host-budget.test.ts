/**
 * W1-T2931 — the host worker budget used to bind only review admission. A light sweep still
 * reconciles every open PR concurrently, but fixable/conflicted dispositions must share that same
 * ceiling and must yield capacity to the already-selected review queue.
 *
 * No network, real worker, or wall clock: worker occupancy uses the production process counter and
 * every sweep effect is injected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SWEEP_POLICY,
  drainDetachedSweepActions,
  runSweepLightPass,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";
import { activeWorkerCount, withWorkerOccupancy } from "../src/lib/worker.js";

const NOW = Date.parse("2026-09-05T20:00:00Z");

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-t2931-")), "ledger.ndjson");
}

function fixablePr(prNumber: number): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/o/r/pull/${prNumber}`,
    taskId: `W1-F${prNumber}`,
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [
      {
        claim: "the change needs one repair",
        proof: "unit test: repair",
        met: false,
        reason: "the proof failed",
        proof_exec: "executed_fail",
      },
    ],
    reviewSummary: "one criterion unmet",
    priorStrikes: 0,
    lastActivityAt: "2026-09-05T19:00:00Z",
    headSha: `fix-${prNumber}`,
    autoMergeArmed: false,
  };
}

function reviewablePr(prNumber: number): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/o/r/pull/${prNumber}`,
    taskId: `W1-R${prNumber}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-05T18:00:00Z",
    headSha: `review-${prNumber}`,
    autoMergeArmed: false,
  };
}

function policy(hostWorkerBudget: number, reviewLanes = 3): SweepPolicy {
  return {
    ...DEFAULT_SWEEP_POLICY,
    reviewLanes,
    reviewCapacity: {
      ...DEFAULT_SWEEP_POLICY.reviewCapacity,
      hostWorkerBudget,
    },
  };
}

function deps(path: string, fixed: number[], reviewed: number[]): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: (pr) => {
      fixed.push(pr.prNumber);
    },
    postReview: (pr) => {
      reviewed.push(pr.prNumber);
    },
    escalate: () => {},
    ledgerPath: path,
    runId: "SWEEP-W1-T2931",
    now: () => NOW,
  };
}

async function occupyWorkerSlots(count: number): Promise<{ release: () => void; settled: Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settled = Promise.all(Array.from({ length: count }, () => withWorkerOccupancy(() => gate))).then(() => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(activeWorkerCount(), count, "the fixture holds the production worker occupancy counter");
  return { release, settled };
}

test("W1-T2931: the sweep stops fanning out at the host budget", async () => {
  const occupied = await occupyWorkerSlots(2);
  const fixed: number[] = [];
  try {
    await runSweepLightPass(
      [fixablePr(1), fixablePr(2), fixablePr(3), fixablePr(4)],
      deps(ledgerPath(), fixed, []),
      policy(4),
    );
    assert.deepEqual(fixed.sort((a, b) => a - b), [1, 2], "two occupied slots leave exactly two fix admissions");
  } finally {
    occupied.release();
    await occupied.settled;
    await drainDetachedSweepActions();
  }
});

test("W1-T2931: a board larger than the budget spans passes", async () => {
  const path = ledgerPath();
  const fixed: number[] = [];
  let release!: () => void;
  const fixesStillRunning = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sweepDeps = {
    ...deps(path, fixed, []),
    dispatchFix: (pr: OpenPrView) => {
      fixed.push(pr.prNumber);
      return fixesStillRunning;
    },
  };
  const board = [fixablePr(11), fixablePr(12), fixablePr(13), fixablePr(14), fixablePr(15)];

  try {
    await runSweepLightPass(board, sweepDeps, policy(2));
    assert.deepEqual(fixed, [11, 12], "the first pass admits only the budget");

    await runSweepLightPass(board, { ...sweepDeps, runId: "SWEEP-W1-T2931-2" }, policy(2));
    assert.deepEqual(fixed, [11, 12, 13, 14], "the next pass advances to work not already dispatched");

    await runSweepLightPass(board, { ...sweepDeps, runId: "SWEEP-W1-T2931-3" }, policy(2));
    assert.deepEqual(fixed, [11, 12, 13, 14, 15], "the final pass drains the remainder without a burst");
  } finally {
    release();
    await drainDetachedSweepActions();
  }
});

test("W1-T2931: review width survives a bounded fan-out", async () => {
  const fixed: number[] = [];
  const reviewed: number[] = [];
  const board = [
    reviewablePr(21),
    reviewablePr(22),
    reviewablePr(23),
    fixablePr(31),
    fixablePr(32),
    fixablePr(33),
  ];

  await runSweepLightPass(board, deps(ledgerPath(), fixed, reviewed), policy(4, 3));
  await drainDetachedSweepActions();

  assert.deepEqual(reviewed.sort((a, b) => a - b), [21, 22, 23], "all three review lanes keep their selected width");
  assert.deepEqual(fixed, [31], "fix dispatch receives only the one slot left after review reservation");
});
