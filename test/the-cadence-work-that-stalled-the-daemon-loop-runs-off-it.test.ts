// test/the-cadence-work-that-stalled-the-daemon-loop-runs-off-it.test.ts — W1-T5481.
//
// THE WORK, NAMED: the board-review rung's open-PR read. `checkBoardReview` (run-task.ts,
// `buildBoardReviewDaemonHooks`) → `defaultBoardReviewItems` → `fetchOpenPrsRest(owner, repo, ghJson)`:
// one list call plus two rollup calls per open PR, every one a synchronous `gh` spawn, on EVERY tick.
//
// MEASURED 2026-10-03 (live ledger + rotations, read-only, 16:00Z-19:17Z, 19 cadence phases): the
// stretch from `ci_learning_cadence.skipped` to the `board_review.*` row — nothing but that check —
// took 29.7-98.0 s on every tick, against 0.3-6.0 s for `sweepFeedbackLanding` on 18 of 19 ticks.
// With 22 open PRs that is 45 synchronous `gh` calls; the one fired tick paid it twice (55 s + 50 s).
//
// These tests pin that the read now happens through an ASYNC reader the daemon awaits before the
// check, so a timer scheduled before it fires while it is still in progress, and that the
// synchronous read is never reached once the board was prefetched.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as runTask from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { OpenPrRest } from "../src/lib/open-prs-rest.js";
import type { Plan } from "../src/lib/plan.js";
import type { Policy } from "../src/lib/policy.js";
import type { BoardItem } from "../src/lib/board-review.js";

const NOW = new Date("2026-10-03T17:00:00Z");
const POLICY = { values: { boardReview: { enabled: true, minIntervalMinutes: 120, maxPerDay: 6 } } } as unknown as Policy;
const PLAN: Plan = { tasks: [], byId: new Map() };
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Hooks = ReturnType<typeof runTask.buildBoardReviewDaemonHooks> & { prefetchBoardReview?: () => Promise<void> };

/** Three open PRs as the REST list returns them: #8869 opened 15 h ago (the age arm), #8876 with a
 *  failing check run, and #8880 whose rollup read fails. */
const ROWS = [
  { number: 8869, html_url: "https://github.com/o/r/pull/8869", updated_at: "2026-10-03T16:00:00Z", created_at: "2026-10-03T02:00:00Z", head: { ref: "run-a", sha: "a".repeat(40) } },
  { number: 8876, html_url: "https://github.com/o/r/pull/8876", updated_at: "2026-10-03T16:00:00Z", created_at: "2026-10-03T15:00:00Z", head: { ref: "run-b", sha: "b".repeat(40) } },
  { number: 8880, html_url: "https://github.com/o/r/pull/8880", updated_at: "2026-10-03T16:00:00Z", created_at: "2026-10-03T16:00:00Z", head: { ref: "run-c", sha: "c".repeat(40) } },
];

/** An async `gh api` reader over {@link ROWS}: each answer lands a few ms later, as a real spawn does. */
function slowReader(reads: string[]) {
  return async (args: string[]): Promise<unknown> => {
    const path = args[1]!;
    reads.push(path);
    await tick(3);
    if (path.endsWith("/pulls?state=open&per_page=100")) return ROWS;
    if (path.includes("c".repeat(40)) && path.endsWith("/status")) throw new Error("HTTP 502 on the rollup read");
    if (path.endsWith("/check-runs?per_page=100")) {
      return { check_runs: path.includes("b".repeat(40)) ? [{ name: "ci", status: "completed", conclusion: "failure" }] : [] };
    }
    return { statuses: [] };
  };
}

function rootDir(): string {
  const d = mkdtempSync(join(tmpdir(), "rmd-w1t5481-offloop-"));
  mkdirSync(join(d, "state"), { recursive: true });
  return d;
}

function hooksFor(root: string, extra: Partial<Parameters<typeof runTask.buildBoardReviewDaemonHooks>[0]>, seen: { items?: readonly BoardItem[]; syncReads: number }): Hooks {
  return runTask.buildBoardReviewDaemonHooks({
    config: { root } as unknown as Config,
    policy: POLICY,
    now: () => NOW,
    plan: () => PLAN,
    projection: () => new Map(),
    reconcile: (opts) => {
      seen.items = opts.items;
      return { retiredProposalIds: [], retired: [] };
    },
    ...extra,
    itemsIo: {
      resolveOwnerRepo: () => ({ owner: "o", repo: "r" }),
      now: () => NOW,
      // The synchronous read the loop used to pay. Counted, so a test can say it was never reached.
      fetchOpenPrs: (): OpenPrRest[] => {
        seen.syncReads++;
        return [];
      },
      ...extra.itemsIo,
    },
  }) as Hooks;
}

void test("W1-T5481: the board-review open-PR read (checkBoardReview → defaultBoardReviewItems → fetchOpenPrsRest) runs off the loop: a timer scheduled before it fires while it is still in progress", async () => {
  const root = rootDir();
  try {
    const reads: string[] = [];
    const seen = { syncReads: 0 } as { items?: readonly BoardItem[]; syncReads: number };
    const hooks = hooksFor(root, { readJson: slowReader(reads) }, seen);
    assert.equal(typeof hooks.prefetchBoardReview, "function", "the hooks expose the off-loop read the daemon awaits");

    let readsWhenTimerFired: number | undefined;
    const timer = setTimeout(() => (readsWhenTimerFired = reads.length), 0);
    try {
      await hooks.prefetchBoardReview!();
    } finally {
      clearTimeout(timer);
    }
    const total = 1 + 2 * ROWS.length;
    assert.equal(reads.length, total, "one list call plus two rollup calls per open PR, as fetchOpenPrsRest makes");
    assert.ok(readsWhenTimerFired !== undefined, "the timer fired before the read finished");
    assert.ok(readsWhenTimerFired < total, `the timer fired after ${readsWhenTimerFired} of ${total} reads — while the read was in progress`);

    const decision = hooks.checkBoardReview();
    assert.equal(seen.syncReads, 0, "the check took the prefetched board and never ran the synchronous read");
    assert.deepEqual(seen.items?.map((i) => [i.id, i.redCheckCount]), [["#8869", 0], ["#8876", 1], ["#8880", 0]]);
    assert.equal(decision.fire, true, decision.reason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("W1-T5481: a fired run reads its own board off the loop too, after recording the fire", async () => {
  const root = rootDir();
  try {
    const reads: string[] = [];
    const seen = { syncReads: 0 } as { items?: readonly BoardItem[]; syncReads: number };
    const hooks = hooksFor(root, { readJson: slowReader(reads) }, seen);
    const report = await hooks.runBoardReview();
    assert.equal(reads.length, 1 + 2 * ROWS.length, "the run's items read went through the async reader");
    assert.equal(seen.syncReads, 0);
    assert.equal(report.itemsConsidered, ROWS.length);
    assert.equal(report.redCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("W1-T5481: a failed prefetch reaches the check as the outage it was, never as a synchronous re-read", async () => {
  const root = rootDir();
  try {
    const seen = { syncReads: 0 } as { items?: readonly BoardItem[]; syncReads: number };
    const hooks = hooksFor(root, { readJson: async () => Promise.reject(new Error("gh: HTTP 503")) }, seen);
    await hooks.prefetchBoardReview!();
    const decision = hooks.checkBoardReview();
    assert.equal(seen.syncReads, 0, "the carried error is rethrown, not answered by a blocking read");
    assert.deepEqual(seen.items, [], "defaultBoardReviewItems' outage arm: no items, therefore no fire");
    assert.equal(decision.fire, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("W1-T5481: the prefetched board is taken once; an unprefetched check still reads synchronously, as before", async () => {
  const root = rootDir();
  try {
    const reads: string[] = [];
    const seen = { syncReads: 0 } as { items?: readonly BoardItem[]; syncReads: number };
    const hooks = hooksFor(root, { readJson: slowReader(reads) }, seen);
    await hooks.prefetchBoardReview!();
    hooks.checkBoardReview();
    hooks.checkBoardReview();
    assert.equal(seen.syncReads, 1, "the second check had no prefetched board left and took the synchronous read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("W1-T5481: a test that pins its own board and names no reader gets no prefetch, so it never reaches the network", async () => {
  const root = rootDir();
  try {
    const seen = { syncReads: 0 } as { items?: readonly BoardItem[]; syncReads: number };
    const hooks = hooksFor(root, {}, seen);
    await hooks.prefetchBoardReview!();
    hooks.checkBoardReview();
    assert.equal(seen.syncReads, 1, "the pinned synchronous seam answered, exactly as before W1-T5481");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
