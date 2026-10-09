import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import {
  DEFAULT_SWEEP_POLICY, detachSweepAction, drainDetachedSweepActions,
  drainInFlightReviews, inFlightReviewCount, runSweepLightPass,
  type OpenPrView, type SweepDeps,
} from "./helpers/sweep-test.js";

const NOW = Date.now();
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
async function eventually(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(message);
}
function pr(n: number): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: `head-${n}`, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(NOW - 60_000 * n).toISOString(),
    createdAt: new Date(NOW - 60_000 * (5 - n)).toISOString(),
  };
}
function deps(postReview: NonNullable<SweepDeps["postReview"]>, rows: Record<string, unknown>[] = []): SweepDeps {
  return {
    ledgerPath: "/unused", runId: "W1-T5491", now: () => NOW,
    readLedger: () => [], appendLine: (_path, row) => { rows.push(row); },
    readActiveWorkerCount: () => 0,
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, postReview,
  };
}

test("W1-T5491: a freed review lane is refilled before the slowest review posts", async () => {
  const holds = Array.from({ length: 4 }, gate);
  const started: number[] = [];
  const finished: number[] = [];
  const rows: Record<string, unknown>[] = [];
  let active = 0;
  let peak = 0;
  const sweepDeps = deps(async (p) => {
    started.push(p.prNumber);
    peak = Math.max(peak, ++active);
    await holds[p.prNumber - 1]!.promise;
    active--;
    finished.push(p.prNumber);
  }, rows);
  const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 3 };
  let returned = false;
  const first = runSweepLightPass([pr(1), pr(2), pr(3), pr(4)], sweepDeps, policy)
    .then(() => { returned = true; });
  try {
    await eventually(() => started.length === 3, "three reviews did not start");
    await settle();
    assert.equal(returned, true, "the light pass must return while its reviews are still running");
    assert.equal(rows.filter((r) => r.step === "sweep.disposed").length, 4);
    await runSweepLightPass([pr(1), pr(2), pr(3), pr(4)], sweepDeps, policy);
    assert.equal(started.length, 3, "a full lane cannot admit a fourth or repeat reserved heads");
    const early = started[0]!;
    holds[early - 1]!.resolve();
    await eventually(() => finished.includes(early), "early review did not finish");
    await settle();
    await runSweepLightPass([pr(4)], sweepDeps, policy);
    assert.ok(started.includes(4), "the freed reservation must admit the fourth review");
    assert.equal(finished.length, 1, "the fourth starts before either slow review posts");
    assert.equal(peak, 3, "overlapping passes never exceed the review width");
    assert.equal(inFlightReviewCount(), 3);
  } finally {
    holds.forEach((h) => h.resolve());
    await first;
    await drainInFlightReviews({ boundMs: 1000 });
  }
});

for (const exit of ["stop", "freshness"] as const) {
  test("W1-T5491: a stop drains detached reviews before exiting" + ` (${exit})`, async () => {
    const held = gate();
    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    let returned = false;
    let passes = 0;
    let admittingPassReturned = false;
    const sweepDeps = deps(async () => { await held.promise; });
    const daemon = runDaemon({ tasks: [], byId: new Map() }, {
      refreshMerged: () => () => true,
      runOne: async () => { throw new Error("no task should dispatch"); },
      sleep: settle,
      checkStop: () => exit === "stop" && passes > 0 ? "STOP" : undefined,
      checkFreshness: () => exit === "freshness"
        ? { stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40) }
        : { stale: false },
      sweep: async () => {
        if (passes++ === 0) {
          await runSweepLightPass([pr(1)], sweepDeps);
          admittingPassReturned = true;
        }
      },
      log: (step, fields = {}) => rows.push({ step, fields }),
    }, { pollIntervalMs: 1, sweepWallClockBoundMs: 1000 })
      .then((result) => { returned = true; return result; });
    try {
      await eventually(() => inFlightReviewCount() === 1, "detached review was not tracked");
      await eventually(() => rows.some((r) => r.step === (exit === "stop"
        ? "daemon.stop" : "daemon.freshness_drain.started")), "the daemon did not reach its exit drain");
      await settle();
      assert.equal(admittingPassReturned, true, "the admitting pass must have returned before the drain");
      assert.equal(returned, false, "the daemon returned over an unfinished review");
      assert.equal(rows.some((r) => r.step === "daemon.summary"), false);
    } finally {
      held.resolve();
    }
    const result = await daemon;
    assert.equal(result.stopReason, exit === "stop" ? "stopped" : "stale");
    assert.equal(inFlightReviewCount(), 0);
  });
}

test("W1-T5491: the dispatch ticker refills a freed review lane and STOP drains reviews", async () => {
  // The subject is the REFILL, not the shipped width: three lanes and four PRs, pinned here so a
  // plan/policy.yaml width change moves no assertion below.
  const threeLanes = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 3, reviewLaneMin: 1, reviewLaneMax: 3 };
  const work = gate();
  const holds = Array.from({ length: 4 }, gate);
  const started: number[] = [];
  const finished: number[] = [];
  let stopping = false;
  let stopObserved = false;
  let active = 0;
  let peak = 0;
  const sweepDeps = deps(async (p) => {
    started.push(p.prNumber);
    peak = Math.max(peak, ++active);
    await holds[p.prNumber - 1]!.promise;
    active--;
    finished.push(p.prNumber);
  });
  const plan = loadPlanFromYaml("- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n", "ticker-test");
  const daemon = runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (taskId) => {
      await work.promise;
      return { taskId, runId: "run-a", merged: true, costUsd: 0, verdict: "merged" };
    },
    sleep: settle,
    checkStop: () => stopping ? "STOP" : undefined,
    sweepLight: async () => {
      await runSweepLightPass([1, 2, 3, 4].filter((n) => !finished.includes(n)).map(pr), sweepDeps, threeLanes);
    },
    log: (step) => { if (step === "daemon.stop") stopObserved = true; },
  }, { pollIntervalMs: 1, sweepWallClockBoundMs: 1000 });
  try {
    await eventually(() => started.length === 3, "the ticker did not admit three reviews");
    holds[0]!.resolve();
    await eventually(() => started.includes(4), "the ticker waited for the slowest review");
    assert.deepEqual(finished, [1]);
    assert.equal(peak, 3);
    stopping = true;
    work.resolve();
    await eventually(() => stopObserved, "the daemon did not observe STOP");
    await settle();
    assert.deepEqual(started, [1, 2, 3, 4], "STOP admits no additional review");
  } finally {
    stopping = true;
    work.resolve();
    holds.forEach((h) => h.resolve());
  }
  assert.equal((await daemon).stopReason, "stopped");
  assert.equal(inFlightReviewCount(), 0);
});

test("W1-T5491: a rejected detached review releases its lane and preserves throw evidence", async () => {
  const held = gate();
  const rows: Record<string, unknown>[] = [];
  const started: number[] = [];
  const sweepDeps = deps(async (p) => {
    started.push(p.prNumber);
    if (p.prNumber === 1) {
      await held.promise;
      throw new Error("reviewer failed");
    }
  }, rows);
  const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1 };
  await runSweepLightPass([pr(1)], sweepDeps, policy);
  try {
    await runSweepLightPass([pr(2)], sweepDeps, policy);
    assert.deepEqual(started, [1]);
    held.resolve();
    await drainInFlightReviews({ boundMs: 1000 });
    await runSweepLightPass([pr(2)], sweepDeps, policy);
    assert.deepEqual(started, [1, 2]);
    assert.equal(rows.find((r) => r.step === "sweep.action_failed")?.error, "reviewer failed");
    assert.match(String(rows.find((r) => r.step === "review.post_refused")?.reason), /reviewer failed/);
  } finally {
    held.resolve();
    await drainInFlightReviews({ boundMs: 1000 });
  }
});

test("W1-T5491: freshness also drains reviews admitted beside a detached action", async () => {
  const fix = gate();
  const review = gate();
  let started = false;
  let returned = false;
  const sweepDeps = deps(async () => { started = true; await review.promise; });
  detachSweepAction(fix.promise, { actionKind: "fix-dispatch", taskId: "A" });
  const daemon = runDaemon({ tasks: [], byId: new Map() }, {
    refreshMerged: () => () => true,
    runOne: async () => { throw new Error("no dispatch expected"); },
    sleep: settle,
    sleepUntilSweepWake: async () => { await settle(); return "wake"; },
    checkFreshness: () => ({ stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40) }),
    sweepLight: async () => { await runSweepLightPass([pr(1)], sweepDeps); },
  }, { pollIntervalMs: 1, sweepWallClockBoundMs: 1000 })
    .then((result) => { returned = true; return result; });
  try {
    await eventually(() => started, "the drain's review-only clock did not start a review");
    fix.resolve();
    await settle();
    await settle();
    assert.equal(returned, false, "freshness must wait for the review admitted during the drain");
  } finally {
    fix.resolve();
    review.resolve();
    await drainDetachedSweepActions({ boundMs: 1000 });
  }
  assert.equal((await daemon).stopReason, "stale");
  assert.equal(inFlightReviewCount(), 0);
});

test("W1-T5491: an unexpected review failure releases its reservation and reports the error", async () => {
  const logs: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const started: number[] = [];
  const sweepDeps = deps((p) => {
    started.push(p.prNumber);
    if (p.prNumber === 1) throw new Error("reviewer failed");
  });
  sweepDeps.appendLine = (_path, row) => {
    if (row.step === "sweep.action_failed") throw new Error("ledger failed");
  };
  sweepDeps.log = (step, fields = {}) => {
    logs.push({ step, fields });
  };
  const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1 };
  await runSweepLightPass([pr(1)], sweepDeps, policy);
  assert.equal(logs.find((r) => r.step === "sweep.post_review.failed")?.fields.error, "Error: ledger failed");
  sweepDeps.log = () => {};
  await runSweepLightPass([pr(2)], sweepDeps, policy);
  assert.deepEqual(started, [1, 2], "the failed run must return its admission to the next pass");
});

test("W1-T5491: STOP waits for the admitting sweep and reports a review beyond the drain bound", async () => {
  const review = gate();
  const background = gate();
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let stopping = false;
  let returned = false;
  const sweepDeps = deps(async () => { await review.promise; });
  const daemon = runDaemon({ tasks: [], byId: new Map() }, {
    refreshMerged: () => () => true,
    runOne: async () => { throw new Error("no dispatch expected"); },
    sleep: settle,
    checkStop: () => stopping ? "STOP" : undefined,
    sweep: async () => {
      await runSweepLightPass([pr(1)], sweepDeps);
      await background.promise;
    },
    log: (step, fields = {}) => rows.push({ step, fields }),
  }, { pollIntervalMs: 1, sweepWallClockBoundMs: 100 })
    .then((result) => { returned = true; return result; });
  try {
    await eventually(() => inFlightReviewCount() === 1, "the sweep did not start its review");
    stopping = true;
    await eventually(() => rows.some((r) => r.step === "daemon.stop"), "STOP was not observed");
    await settle();
    assert.equal(returned, false, "STOP must wait for the admitting sweep before taking its drain snapshot");
    background.resolve();
    assert.equal((await daemon).stopReason, "stopped");
    assert.equal(rows.find((r) => r.step === "daemon.stop_drain.completed")?.fields.abandoned_in_flight_reviews, 1);
    assert.equal(inFlightReviewCount(), 1, "a straggler remains tracked until it settles");
  } finally {
    stopping = true;
    background.resolve();
    review.resolve();
    await daemon;
    await drainInFlightReviews({ boundMs: 1000 });
  }
});

test("W1-T5491: STOP does not starve the clock of an already admitted detached retro", async () => {
  const retro = gate();
  let stopReads = 0;
  let passes = 0;
  const plan = loadPlanFromYaml("- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n", "retro-stop-test");
  try {
    const result = await runDaemon(plan, {
      refreshMerged: () => () => true,
      runOne: async () => { throw new Error("no dispatch expected"); },
      sleep: settle,
      checkStop: () => ++stopReads > 1 ? "STOP" : undefined,
      checkRetroTrigger: () => ({ fire: true, reason: "merges", mergesSinceMarker: 99, daysSinceMarker: 0 }),
      runRetroTrigger: async () => { await retro.promise; },
      sweepLight: () => { if (++passes === 3) retro.resolve(); },
    }, { pollIntervalMs: 1, sweepWallClockBoundMs: 1000 });
    assert.equal(result.stopReason, "stopped");
    assert.deepEqual(await drainDetachedSweepActions({ boundMs: 1000 }), []);
    assert.ok(passes >= 3, "the detached retro's clock must keep running until its work settles");
  } finally {
    retro.resolve();
    await drainDetachedSweepActions({ boundMs: 1000 });
  }
});
