/**
 * W1-T9812 — THE PRE-EXIT PASS RUNS BESIDE THE RESTART DRAIN.
 *
 * 2026-10-15 20:08, core instance: a latched exit spent 3.6 min in its pre-exit pass before its drain waited on
 * anything. A 7-day study to 2026-11-11 found a median of 18.0 min from the restart decision to the exit, most of it
 * one full pass that ran before the drain.
 *
 * Each fixture runs one build lane through a latch with a fake clock. The latch is at 1 unit, the lane settles at
 * 5 units, and the time limit of the drain is 10 units from the latch, so its deadline is at 11 units.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush, setTimeout as realSleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import { runDaemon, type DaemonDeps, type ReviewAdmissionGate } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import {
  currentReviewSignal, detachSweepAction, detachedSweepActionCount, drainDetachedSweepActions, drainInFlightReviews, inFlightReviewCount,
  trackInFlightReview,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

type RunResult = Awaited<ReturnType<DaemonDeps["runOne"]>>;

const minute = 60_000;
/** A short unit for the fixtures that let a time limit run out in real time: 10 units are 400 ms. */
const SHORT = 40;
const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** `sweep.review_started` → `review.posted` pairs, each `lengthMs` long. */
function reviewHistory(lengthMs: number, unit: number, pairs = 3): string[] {
  const end = Date.now() - unit;
  return Array.from({ length: pairs }, (_, i) => [
    JSON.stringify({ ts: new Date(end - lengthMs - i).toISOString(), step: "sweep.review_started", pr_number: 900 + i }),
    JSON.stringify({ ts: new Date(end - i).toISOString(), step: "review.posted", pr_url: `https://github.com/acme/remudero/pull/${900 + i}` }),
  ]).flat();
}

interface Row { step: string; extra: Record<string, unknown> }
interface Options {
  unit?: number;
  /** The lengths of past reviews, in units. Absent: no review history. */
  reviewUnits?: number;
  /** Runs inside full pass `n` (1 is the pass at boot). The pass settles when this returns. */
  onSweep?: (n: number, gate: ReviewAdmissionGate | undefined) => Promise<void> | void;
  /** No dispatch latch: the daemon has no task and exits at the top of a tick. */
  idle?: boolean;
}

/** A tracked review. It posts its verdict when `finish()` is called, unless the drain told it to stop. */
function review(pr: number, posted: number[], stopped: number[]) {
  const gate = deferred<void>();
  let signal: AbortSignal | undefined;
  void trackInFlightReview(async () => {
    signal = currentReviewSignal();
    await gate.promise;
    if (signal?.aborted) { stopped.push(pr); return; }
    posted.push(pr);
  }, { taskId: `W1-T${pr}`, prNumber: pr });
  return { finish: () => gate.resolve(), toldToStop: () => signal?.aborted === true };
}

function latchedLane(t: TestContext, opts: Options = {}) {
  assert.equal(inFlightReviewCount(), 0, "precondition: no review leaked from another test");
  assert.equal(detachedSweepActionCount(), 0, "precondition: no detached action leaked from another test");
  const unit = opts.unit ?? minute;
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9812-`));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, opts.idle ? "[]\n"
    : "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n");
  let start = Date.now();
  let nowMs = start;
  t.mock.method(Date, "now", () => nowMs);
  const history = opts.reviewUnits === undefined ? [] : reviewHistory(opts.reviewUnits * unit, unit);
  const rows: Row[] = [];
  const sweeps: Array<{ n: number; at: number; settled: boolean }> = [];
  const lane = deferred<RunResult>();
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  let stale = false;
  let exiting = false;
  let laneStarted = false;
  let merged = false;
  let finished = false;
  const material = { stale: true as const, oldSha: OLD_SHA, newSha: NEW_SHA, staleSinceMs: start - 120 * minute,
    changes: [{ sha: NEW_SHA, subject: "fix: update worker", files: ["src/lib/worker.ts"] }] };
  const age = () => (nowMs - start) / unit;
  const daemon = runDaemon(loadPlan(planPath), {
    now: () => new Date(nowMs),
    readLedgerLines: () => history,
    refreshMerged: () => () => merged,
    checkFreshness: () => stale ? material : { stale: false },
    log: (step, extra = {}) => rows.push({ step, extra }),
    runOne: () => { laneStarted = true; return lane.promise; },
    sleep: () => { const sleep = deferred<void>(); sleeps.push(sleep); return sleep.promise; },
    sleepUntilSweepWake: async () => {
      if (exiting) { await flush(); return "wake"; }
      const sleep = deferred<void>();
      sleeps.push(sleep);
      await sleep.promise;
      return "timeout";
    },
    sweepLight: async () => {},
    sweep: async (gate?: ReviewAdmissionGate) => {
      const pass = { n: sweeps.length + 1, at: age(), settled: false };
      sweeps.push(pass);
      await opts.onSweep?.(pass.n, gate);
      pass.settled = true;
    },
  } as DaemonDeps, { freshnessMinLifetimeMs: 0, laneCount: 1, max: 1, sweepWallClockBoundMs: 10 * unit, sweepRetriggerIntervalMs: 10_000 * unit });
  void daemon.then(() => { finished = true; });
  const at = (units: number) => { nowMs = start + units * unit; };
  const tick = async (rounds = 2) => {
    for (let round = 0; round < rounds; round++) {
      for (const sleep of sleeps.splice(0)) sleep.resolve();
      for (let i = 0; i < 50; i++) await flush();
    }
  };
  return {
    daemon, rows, sweeps, at, tick, unit, age,
    finished: () => finished,
    step: (step: string) => rows.filter((row) => row.step === step).map((row) => row.extra),
    /** Moves the clock without moving the fixture's zero: the pass at boot uses it to look long. */
    shift: (units: number) => { nowMs += units * unit; start += units * unit; },
    booted: async () => {
      for (let wait = 0; wait < 20 && !(opts.idle ? sweeps.length > 0 : laneStarted); wait++) await tick(1);
      assert.ok(opts.idle ? sweeps.length > 0 : laneStarted, "the daemon did not reach its first tick");
    },
    latch: async (units: number) => {
      at(units);
      stale = true;
      await tick();
    },
    /** The lane settles, so the daemon leaves its dispatch phase and starts its exit. */
    settleLane: async (units: number) => {
      at(units);
      exiting = true;
      merged = true;
      lane.resolve({ taskId: "A", runId: "A-run", merged: true, verdict: "merged", costUsd: 0 });
      for (const sleep of sleeps.splice(0)) sleep.resolve();
      for (let i = 0; i < 100; i++) await flush();
    },
    cleanup: async () => {
      exiting = true;
      merged = true;
      lane.resolve({ taskId: "A", runId: "A-run", merged: true, verdict: "merged", costUsd: 0 });
      for (const sleep of sleeps) sleep.resolve();
      await daemon;
      await drainDetachedSweepActions();
      await drainInFlightReviews({ boundMs: 1000 });
      rmSync(dir, { recursive: true, force: true });
      t.mock.restoreAll();
    },
  };
}

/** Waits in real time, for the fixtures whose time limit is a real timer. */
async function within(ms: number, predicate: () => boolean, message: string): Promise<void> {
  for (let waited = 0; waited < ms; waited += 5) {
    if (predicate()) return;
    await realSleep(5);
  }
  assert.ok(predicate(), message);
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

test("W1-T9812: the restart drain starts before the pre-exit pass settles", async (t) => {
  // The pass that the exit starts (pass 2) stays open. The pass at boot looks 1,000 units long, so the learned limit of
  // a pass is far longer than this test.
  const pass = deferred<void>();
  const posted: number[] = [];
  const stopped: number[] = [];
  const h = latchedLane(t, { unit: SHORT, onSweep: (n) => n === 1 ? h.shift(1000) : pass.promise });
  await h.booted();
  // One review is in flight at the latch and does not finish. The drain has until 11 units for it.
  const held = review(41, posted, stopped);
  try {
    await h.latch(1);
    await h.settleLane(5);
    assert.equal(h.sweeps.length, 2, "the exit started its pass");
    h.at(11);
    await within(3000, held.toldToStop, "the drain did not give up on the review while the pass was still running");
    assert.equal(h.sweeps[1]!.settled, false, "the pass is still running");
    assert.equal(h.finished(), false);
    assert.equal(h.step("daemon_selfrestart_for_freshness").length, 0);
    h.at(20);
    pass.resolve();
    assert.equal((await h.daemon).stopReason, "stale");
    const completed = h.step("daemon.freshness_drain.completed");
    assert.equal(completed.length, 1, "one drain for the exit");
    assert.equal(completed[0]!.pre_exit_pass, "ran");
    assert.equal(completed[0]!.exit_bound_ms, 6 * h.unit, "the drain kept the 6 units that the latch left it");
    assert.equal(completed[0]!.exit_wait_ms, 6 * h.unit, "the wait for the pass is not counted as drain time");
    assert.equal(completed[0]!.pass_overlap_ms, 6 * h.unit, "the drain ran beside the pass from 5 units to 11 units");
    assert.equal(completed[0]!.abandoned_in_flight_reviews, 1);
    assert.equal(h.step("daemon_selfrestart_for_freshness")[0]!.pre_exit_pass, "ran");
    held.finish();
    await waitFor(() => stopped.length === 1, "the review that the drain gave up on did not stop");
    assert.equal(posted.length, 0, "a review that the drain gave up on posts no verdict");
  } finally {
    pass.resolve();
    held.finish();
    await h.cleanup();
  }
  // A pass that was already running at the exit is awaited in the same way. A review admitted after the latch is in
  // flight at the exit: the drain writes its start row while that pass is still running.
  const background = deferred<void>();
  const b = latchedLane(t, { onSweep: (n) => n === 1 ? background.promise : undefined });
  await b.booted();
  try {
    await b.latch(1);
    b.at(3);
    const late = review(42, posted, stopped);
    await b.settleLane(5);
    assert.equal(b.sweeps.length, 1, "the exit starts no second pass");
    assert.equal(b.sweeps[0]!.settled, false);
    const [started] = b.step("daemon.freshness_drain.started");
    assert.equal(started?.started_at, "exit", "the drain started while the pass was still running");
    assert.equal(started?.in_flight_reviews, 1);
    b.at(6);
    late.finish();
    await waitFor(() => posted.includes(42), "the review did not post");
    b.at(9);
    background.resolve();
    assert.equal((await b.daemon).stopReason, "stale");
    const [completed] = b.step("daemon.freshness_drain.completed");
    assert.equal(completed?.pre_exit_pass, "awaited_in_flight");
    assert.equal(completed?.pass_overlap_ms, minute, "the drain waited 1 min, all of it beside the pass");
    assert.equal(completed?.exit_wait_ms, minute);
    assert.equal(completed?.abandoned_in_flight_reviews, 0);
    assert.deepEqual(posted, [42], "the review that finished in the drain posted one verdict");
  } finally {
    background.resolve();
    await b.cleanup();
  }
});

test("W1-T9812: the restart still waits for the pre-exit pass to settle", async (t) => {
  const pass = deferred<void>();
  const posted: number[] = [];
  const h = latchedLane(t, { onSweep: (n) => n === 2 ? pass.promise : undefined });
  await h.booted();
  const inFlight = review(43, posted, []);
  try {
    await h.latch(1);
    await h.settleLane(5);
    assert.equal(h.sweeps.length, 2, "the exit started its pass");
    // The review finishes at 6 min. The drain has nothing more to wait on, and the pass still runs.
    h.at(6);
    inFlight.finish();
    await waitFor(() => posted.length === 1, "the review did not post");
    for (let i = 0; i < 200; i++) await flush();
    assert.equal(h.finished(), false, "the daemon cannot exit while its pre-exit pass is running");
    assert.equal(h.step("daemon_selfrestart_for_freshness").length, 0);
    assert.equal(h.step("daemon.freshness_exit").length, 0);
    h.at(9);
    pass.resolve();
    assert.equal((await h.daemon).stopReason, "stale");
    assert.equal(h.sweeps[1]!.settled, true);
    assert.equal(h.step("daemon_selfrestart_for_freshness")[0]!.pre_exit_pass, "ran");
    const [completed] = h.step("daemon.freshness_drain.completed");
    assert.equal(completed?.exit_wait_ms, minute);
    assert.equal(completed?.pass_overlap_ms, minute);
    const phases = h.step("daemon.freshness_exit")[0]!.phases_ms as Record<string, number>;
    assert.equal(phases.pre_exit_pass, 4 * minute, "the pass ran from 5 min to 9 min");
    assert.equal(phases.drain, minute, "the drain waited from 5 min to 6 min");
    assert.deepEqual(posted, [43], "one verdict");
  } finally {
    pass.resolve();
    inFlight.finish();
    await h.cleanup();
  }
});

test("W1-T9812: what the pre-exit pass admits keeps the latch bound", async (t) => {
  // A review takes 3 units. Nothing is in flight at the latch or at the exit. At 5 units the pass of the exit asks the
  // latch, is admitted (6 units are left) and starts a review that does not finish. The pass settles at 8 units.
  const posted: number[] = [];
  const stopped: number[] = [];
  const reviews: Array<ReturnType<typeof review>> = [];
  const admitted: boolean[] = [];
  const pass = deferred<void>();
  const h = latchedLane(t, { unit: SHORT, reviewUnits: 3, onSweep: async (n, gate) => {
    if (n === 1) return h.shift(1000);
    admitted.push(gate?.() ?? true);
    if (admitted.at(-1)) reviews.push(review(44, posted, stopped));
    await pass.promise;
  } });
  await h.booted();
  try {
    await h.latch(1);
    await h.settleLane(5);
    assert.deepEqual(admitted, [true], "the latch admitted the review of the pass");
    h.at(8);
    pass.resolve();
    for (let i = 0; i < 50; i++) await flush();
    h.at(11);
    assert.equal((await h.daemon).stopReason, "stale");
    const [completed] = h.step("daemon.freshness_drain.completed");
    assert.equal(completed?.exit_bound_ms, 3 * h.unit, "the 3 units left before the deadline of the latch, not a new 10 units");
    assert.equal(completed?.abandoned_in_flight_reviews, 1);
    assert.equal(completed?.pre_exit_pass, "ran");
    assert.equal(completed?.pass_overlap_ms, 0, "nothing was in flight while the pass ran");
    assert.equal(reviews[0]!.toldToStop(), true);
    reviews[0]!.finish();
    await waitFor(() => stopped.length === 1, "the review did not stop");
    assert.equal(posted.length, 0);
  } finally {
    pass.resolve();
    for (const r of reviews) r.finish();
    await h.cleanup();
  }
  // The same with a review in flight at the latch, which finishes at 6 units. The drain waits for the review of the
  // pass only until its own deadline at 11 units.
  const second = deferred<void>();
  const late: Array<ReturnType<typeof review>> = [];
  const b = latchedLane(t, { unit: SHORT, reviewUnits: 3, onSweep: async (n, gate) => {
    if (n === 1) return b.shift(1000);
    if (gate?.() ?? true) late.push(review(46, posted, stopped));
    await second.promise;
  } });
  await b.booted();
  const early = review(45, posted, stopped);
  try {
    await b.latch(1);
    await b.settleLane(5);
    b.at(6);
    early.finish();
    await waitFor(() => posted.includes(45), "the review from before the latch did not post");
    b.at(8);
    second.resolve();
    for (let i = 0; i < 50; i++) await flush();
    b.at(11);
    assert.equal((await b.daemon).stopReason, "stale");
    const completed = b.step("daemon.freshness_drain.completed");
    assert.equal(completed.length, 1, "one drain row for the exit");
    assert.equal(completed[0]!.exit_bound_ms, 6 * b.unit);
    assert.equal(completed[0]!.exit_wait_ms, 4 * b.unit, "1 unit for the first review and 3 units for the review of the pass");
    assert.equal(completed[0]!.abandoned_in_flight_reviews, 1);
    const waited = completed[0]!.waited_on as Array<Record<string, unknown>>;
    assert.deepEqual(waited.filter((item) => item.abandoned === true).map((item) => item.pr), [46]);
    late[0]!.finish();
    await waitFor(() => stopped.includes(46), "the review of the pass did not stop");
    assert.deepEqual(posted, [45], "one verdict for the review that finished, none for the review that was stopped");
  } finally {
    second.resolve();
    early.finish();
    for (const r of late) r.finish();
    await b.cleanup();
  }
});

test("W1-T9812: the exit keeps its time limits, and a fix that the drain gives up on is abandoned once", async (t) => {
  // The pass of the exit never settles. Its limit is the learned limit of a pass, 10 units here.
  const never = deferred<void>();
  const fix = deferred<void>();
  const posted: number[] = [];
  const stopped: number[] = [];
  const late: Array<ReturnType<typeof review>> = [];
  const h = latchedLane(t, { unit: SHORT, reviewUnits: 3, onSweep: async (n) => {
    if (n === 1) return;
    while (h.age() < 11) await realSleep(2);
    // After the deadline the pass starts one more review, whatever the latch answers. It cannot move the exit.
    late.push(review(48, posted, stopped));
    await never.promise;
  } });
  await h.booted();
  // A fix worker from before the latch does not finish.
  detachSweepAction(fix.promise, { actionKind: "fix-dispatch", taskId: "W1-T9812-FIX" });
  try {
    await h.latch(1);
    await h.settleLane(5);
    h.at(11);
    await within(3000, () => h.step("daemon.detached_action_abandoned").length === 1, "the drain did not give up on the fix at its deadline");
    h.at(15);
    await within(5000, h.finished, "the exit did not happen when the pass reached its limit");
    assert.equal((await h.daemon).stopReason, "stale");
    assert.equal(h.step("daemon.sweep.abandoned").length, 1, "the pass reached its learned limit, as before");
    assert.equal(late.length, 1, "the pass started a review after the deadline");
    assert.equal(late[0]!.toldToStop(), true, "the drain had no time left for it");
    const abandoned = h.step("daemon.detached_action_abandoned");
    assert.equal(abandoned.length, 1, "one row for the fix, also after the second wait");
    assert.equal(abandoned[0]!.task_id, "W1-T9812-FIX");
    assert.equal(abandoned[0]!.held_by, "live-worker", "the worker keeps its key for the next boot, as before");
    const [completed] = h.step("daemon.freshness_drain.completed");
    assert.equal(completed?.abandoned_detached_sweep_actions, 1);
    assert.equal(completed?.abandoned_in_flight_reviews, 1);
    assert.equal(completed?.remaining_detached_sweep_actions, 1);
    assert.equal(completed?.exit_bound_ms, 6 * h.unit);
  } finally {
    never.resolve();
    fix.resolve();
    for (const r of late) r.finish();
    await h.cleanup();
    assert.equal(posted.length, 0, "the review that the drain gave up on posted no verdict");
  }
});

test("W1-T9812: an exit with no dispatch latch keeps the pass before the drain", async (t) => {
  // No task: the daemon reads stale at the top of its second tick and exits there. A review is in flight.
  const pass = deferred<void>();
  const posted: number[] = [];
  const h = latchedLane(t, { idle: true, onSweep: (n) => n === 2 ? pass.promise : undefined });
  await h.booted();
  const inFlight = review(47, posted, []);
  try {
    await h.latch(1);
    await waitFor(() => h.sweeps.length === 2, "the exit did not start its pass");
    for (let i = 0; i < 100; i++) await flush();
    assert.equal(h.step("daemon.freshness_drain.started").length, 0, "the drain waits for the pass");
    pass.resolve();
    await waitFor(() => h.step("daemon.freshness_drain.started").length === 1, "the drain did not start after the pass");
    inFlight.finish();
    assert.equal((await h.daemon).stopReason, "stale");
    const [completed] = h.step("daemon.freshness_drain.completed");
    assert.equal(completed?.started_at, "exit");
    assert.equal("pre_exit_pass" in completed!, false, "the row of an exit with no latch is unchanged");
    assert.equal("pass_overlap_ms" in completed!, false);
    assert.equal(h.step("daemon_selfrestart_for_freshness")[0]!.pre_exit_pass, "ran");
    assert.deepEqual(posted, [47]);
  } finally {
    pass.resolve();
    inFlight.finish();
    await h.cleanup();
  }
});
