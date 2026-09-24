/**
 * A freshness restart must not kill a review already running.
 *
 * Measured 2026-09-24 on the core daemon: run review-PR6993-1790260688015 posted its PENDING status,
 * materialized its reviewer, then wrote nothing more — the process exited for freshness 4 minutes in.
 * The exit's drain waited only for detached fix/retro actions; a review started by a light pass sat in
 * neither registry, so nothing waited for it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon, type DaemonFreshness, type LightPassScope } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import {
  DEFAULT_SWEEP_POLICY,
  drainInFlightReviews,
  inFlightReviewCount,
  runSweep,
  trackInFlightReview,
  type OpenPrView,
} from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(message);
}

function gate() {
  let release!: () => void;
  let settled = false;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      settled = true;
      resolve();
    };
  });
  return { promise, release, settled: () => settled };
}

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}review-drain-plan-`));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(file);
}

interface Row { step: string; extra: Record<string, unknown> }

/** One stale exit whose first full pass leaves `review` running and detaches nothing. */
function staleExitWithRunningReview(review: Promise<void>, sweepWallClockBoundMs?: number) {
  assert.equal(inFlightReviewCount(), 0, "precondition: no review leaked from another test");
  const rows: Row[] = [];
  const reviewOnlyPasses: LightPassScope[] = [];
  let sweeps = 0;
  const drainOpen = () =>
    rows.some((r) => r.step === "daemon.freshness_drain.started") &&
    !rows.some((r) => r.step === "daemon.freshness_drain.completed");
  const daemon = runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => () => true,
      runOne: async (id): Promise<RunResult> => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
      sleep: settle,
      log: (step, extra = {}) => rows.push({ step, extra }),
      checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA }),
      sweep: async () => {
        sweeps += 1;
        if (sweeps === 1) void trackInFlightReview(review);
      },
      // Every wait inside the drain resolves as a GitHub wake, so a drain clock, were one running, owes a pass at once.
      sleepUntilSweepWake: async () => {
        await settle();
        return drainOpen() ? "wake" : "timeout";
      },
      sweepLight: async (scope?: LightPassScope) => {
        if (scope?.reviewOnly) reviewOnlyPasses.push(scope);
      },
    },
    sweepWallClockBoundMs === undefined ? {} : { sweepWallClockBoundMs },
  );
  return { daemon, rows, reviewOnlyPasses };
}

const stepIndex = (rows: readonly Row[], step: string) => rows.findIndex((r) => r.step === step);

test("a freshness exit waits for a review already in flight", async () => {
  const review = gate();
  const run = staleExitWithRunningReview(review.promise);
  try {
    await waitFor(() => stepIndex(run.rows, "daemon.freshness_drain.started") >= 0, "the exit never began a drain for the running review");
    let returned = false;
    void run.daemon.then(() => { returned = true; });
    for (let i = 0; i < 200; i++) await settle();
    assert.equal(returned, false, "the stale exit returned while a review was still judging");
    assert.equal(stepIndex(run.rows, "daemon_selfrestart_for_freshness"), -1, "the restart was ledgered over an unfinished review");
  } finally {
    review.release();
  }
  const summary = await run.daemon;

  assert.equal(summary.stopReason, "stale");
  const started = run.rows[stepIndex(run.rows, "daemon.freshness_drain.started")]!;
  assert.equal(started.extra.in_flight_reviews, 1);
  assert.equal(started.extra.detached_sweep_actions, 0);
  const completedAt = stepIndex(run.rows, "daemon.freshness_drain.completed");
  assert.equal(run.rows[completedAt]!.extra.abandoned_in_flight_reviews, 0);
  assert.ok(completedAt < stepIndex(run.rows, "daemon_selfrestart_for_freshness"));
  assert.equal(inFlightReviewCount(), 0);
});

test("a drain for reviews alone admits no new review pass", async () => {
  const review = gate();
  const run = staleExitWithRunningReview(review.promise);
  await waitFor(() => stepIndex(run.rows, "daemon.freshness_drain.started") >= 0, "the exit never began a drain");
  for (let i = 0; i < 50; i++) await settle();
  review.release();
  await run.daemon;

  assert.deepEqual(run.reviewOnlyPasses, [], "no review-only clock ran beside a drain with no detached action");
  const completed = run.rows.find((r) => r.step === "daemon.freshness_drain.completed");
  assert.equal(completed?.extra.review_passes, 0);
});

test("a review still running at the drain bound is reported and the restart proceeds", async () => {
  const review = gate();
  const run = staleExitWithRunningReview(review.promise, 20);
  try {
    const summary = await run.daemon;
    assert.equal(summary.stopReason, "stale");
    assert.equal(review.settled(), false, "control: the review really was still running");
    const completed = run.rows.find((r) => r.step === "daemon.freshness_drain.completed");
    assert.equal(completed?.extra.in_flight_reviews, 1);
    assert.equal(completed?.extra.abandoned_in_flight_reviews, 1);
    assert.ok(stepIndex(run.rows, "daemon_selfrestart_for_freshness") >= 0);
  } finally {
    review.release();
    await drainInFlightReviews({ boundMs: 1000 });
  }
});

test("a review admitted after the drain began does not extend it", async () => {
  const first = gate();
  const late = gate();
  void trackInFlightReview(first.promise);
  const drained = drainInFlightReviews({ boundMs: 60_000 });
  void trackInFlightReview(late.promise);
  first.release();
  try {
    assert.equal(await drained, 0);
    assert.equal(late.settled(), false);
    assert.equal(inFlightReviewCount(), 1, "the late review is still tracked for a later drain");
  } finally {
    late.release();
    await drainInFlightReviews({ boundMs: 1000 });
  }
  assert.equal(await drainInFlightReviews({ boundMs: 0 }), 0, "an empty registry drains at once");
});

test("a tracked review that throws still leaves the registry", async () => {
  await assert.rejects(trackInFlightReview(Promise.reject(new Error("reviewer crashed"))), /reviewer crashed/);
  await settle();
  assert.equal(inFlightReviewCount(), 0);
});

function greenUnreviewedPr(): OpenPrView {
  return {
    prNumber: 6993,
    prUrl: "https://github.com/acme/remudero/pull/6993",
    taskId: "W1-T6993",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-24T14:30:00.000Z",
    headSha: "c".repeat(40),
    headRefName: "run-W1-T6993-1",
    autoMergeArmed: false,
  };
}

test("the sweep counts a post-review attempt as an in-flight review until it settles", async () => {
  const review = gate();
  let posted = 0;
  const sweep = runSweep(
    [greenUnreviewedPr()],
    {
      arm: () => {},
      close: () => {},
      dispatchFix: () => {},
      escalate: () => {},
      postReview: async () => {
        posted += 1;
        await review.promise;
      },
      ledgerPath: "/dev/null/review-drain.ndjson",
      runId: "review-drain-test",
      readLedger: () => [],
      appendLine: () => {},
      now: () => Date.parse("2026-09-24T14:40:00.000Z"),
      readLiveState: (pr) => ({ ok: true, state: "OPEN", headSha: pr.headSha }),
    },
    DEFAULT_SWEEP_POLICY,
  );
  try {
    await waitFor(() => posted === 1, "the sweep never started the review");
    assert.equal(inFlightReviewCount(), 1, "a running review is visible to the freshness drain");
  } finally {
    review.release();
  }
  await sweep;
  assert.equal(inFlightReviewCount(), 0);
});
