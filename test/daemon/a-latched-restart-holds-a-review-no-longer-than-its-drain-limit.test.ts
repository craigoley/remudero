/**
 * W1-T12160 — A LATCHED RESTART HOLDS A REVIEW NO LONGER THAN THE TIME LIMIT OF ITS DRAIN.
 *
 * 2026-11-10, core instance: from 12:37Z to 12:58Z no light pass admitted a review of a green pull request. The
 * drain deadline is the latch time plus the drain's time limit, about 9 minutes. After the deadline the time left
 * was negative, so the latch refused every review for as long as the process lived.
 *
 * Each fixture runs build lanes through a latch with a fake clock. The latch is at 1 unit and the time limit of the
 * drain is 10 units, so the deadline is at 11 units.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import { runDaemon, type DaemonDeps, type LightPassScope, type ReviewAdmissionGate } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import {
  currentReviewSignal, detachSweepAction, detachedSweepActionCount, drainDetachedSweepActions, drainInFlightReviews, inFlightReviewCount, trackInFlightReview,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

type RunResult = Awaited<ReturnType<DaemonDeps["runOne"]>>;

const minute = 60_000;
const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** `fix.dispatch` → `fix.done` rounds, each `lengthMs` from the start of the round. */
function fixHistory(lengthMs: number, unit: number, rounds = 3): string[] {
  const end = Date.now() - unit;
  return Array.from({ length: rounds }, (_, i) => [
    JSON.stringify({ ts: new Date(end - unit - i).toISOString(), step: "fix.dispatch", round_id: `r${i}`, elapsed_ms: lengthMs - unit }),
    JSON.stringify({ ts: new Date(end - i).toISOString(), step: "fix.done", round_id: `r${i}` }),
  ]).flat();
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
interface LightPass { latched: boolean; at: number; fix: boolean; review: boolean; plan: boolean; refill: boolean }
interface FullPass { latched: boolean; at: number; hold: string | undefined; review: boolean }
interface Options {
  /** The length of one clock unit in ms. The default is one minute. */
  unit?: number;
  tasks?: readonly string[];
  lanes?: number;
  fullSweep?: boolean;
  /** Called by the fake light pass each time the latch admits a review. */
  onReviewAdmitted?: () => void;
}

/** The build lanes run; `latch()` makes the tree stale, so the dispatch tick latches the restart. The fake light
 *  pass asks the latch for a fix, a review, a plan review and a build refill. The fake full pass asks through its gate. */
function latchedLanes(t: TestContext, ledger: (unit: number) => readonly string[], opts: Options = {}) {
  assert.equal(inFlightReviewCount(), 0, "precondition: no review leaked from another test");
  assert.equal(detachedSweepActionCount(), 0, "precondition: no detached action leaked from another test");
  const unit = opts.unit ?? minute;
  const tasks = opts.tasks ?? ["A"];
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12160-`));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, tasks.map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const start = Date.now();
  let nowMs = start;
  t.mock.method(Date, "now", () => nowMs);
  const history = ledger(unit);
  const rows: Row[] = [];
  const light: LightPass[] = [];
  const full: FullPass[] = [];
  const lanes = new Map(tasks.map((id) => [id, deferred<RunResult>()]));
  const started: string[] = [];
  const merged = new Set<string>();
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  let stale = false;
  let exiting = false;
  const material = { stale: true as const, oldSha: OLD_SHA, newSha: NEW_SHA, staleSinceMs: start - 120 * minute,
    changes: [{ sha: NEW_SHA, subject: "fix: update worker", files: ["src/lib/worker.ts"] }] };
  const age = () => (nowMs - start) / unit;
  const daemon = runDaemon(loadPlan(planPath), {
    now: () => new Date(nowMs),
    readLedgerLines: () => history,
    refreshMerged: () => (id) => merged.has(id),
    checkFreshness: () => stale ? material : { stale: false },
    log: (step, extra = {}) => rows.push({ step, extra }),
    runOne: (id) => { started.push(id); return lanes.get(id)!.promise; },
    sleep: () => { const sleep = deferred<void>(); sleeps.push(sleep); return sleep.promise; },
    sleepUntilSweepWake: async () => {
      if (exiting) { await flush(); return "wake"; }
      const sleep = deferred<void>();
      sleeps.push(sleep);
      await sleep.promise;
      return "timeout";
    },
    sweepLight: async (scope?: LightPassScope) => {
      const review = scope?.admit?.("review", "light") !== false;
      light.push({ latched: stale, at: age(), review,
        fix: !scope?.reviewOnly && scope?.admit?.("fix-dispatch", "light") !== false,
        plan: scope?.admit?.("plan-review", "light") !== false,
        // A probe: the latch writes no row for it. The candidate is one unit long.
        refill: scope?.admit?.("dispatch-refill", undefined, unit) !== false });
      if (review && stale) opts.onReviewAdmitted?.();
    },
    ...(opts.fullSweep ? {
      sweep: async (gate?: ReviewAdmissionGate) => {
        full.push({ latched: stale, at: age(), hold: gate?.workerAdmissionHold?.(), review: gate?.() ?? true });
      },
    } : {}),
  } as DaemonDeps, { freshnessMinLifetimeMs: 0, laneCount: opts.lanes ?? 1, max: tasks.length, sweepWallClockBoundMs: 10 * unit,
    sweepRetriggerIntervalMs: unit });
  const at = (units: number) => { nowMs = start + units * unit; };
  const tick = async (rounds = 2) => {
    for (let wait = 0; wait < 20 && started.length === 0; wait++) {
      for (const sleep of sleeps.splice(0)) sleep.resolve();
      for (let i = 0; i < 50; i++) await flush();
    }
    assert.ok(started.length > 0, "no lane started");
    for (let round = 0; round < rounds; round++) {
      for (const sleep of sleeps.splice(0)) sleep.resolve();
      for (let i = 0; i < 50; i++) await flush();
    }
  };
  const settle = (id: string) => {
    merged.add(id);
    lanes.get(id)!.resolve({ taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 });
  };
  return {
    daemon, rows, light, full, at, tick, settle, started, unit,
    step: (step: string) => rows.filter((row) => row.step === step).map((row) => row.extra),
    lightAt: (units: number) => light.filter((pass) => pass.latched && pass.at === units),
    latch: async (units: number) => {
      at(units);
      stale = true;
      await tick();
    },
    /** The last lanes settle, so the daemon leaves its dispatch phase and exits for freshness. */
    exit: () => {
      exiting = true;
      for (const id of tasks) settle(id);
      for (const sleep of sleeps.splice(0)) sleep.resolve();
    },
    cleanup: async () => {
      exiting = true;
      for (const id of tasks) settle(id);
      for (const sleep of sleeps) sleep.resolve();
      await daemon;
      await drainDetachedSweepActions();
      await drainInFlightReviews({ boundMs: 1000 });
      rmSync(dir, { recursive: true, force: true });
      t.mock.restoreAll();
    },
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

test("W1-T12160 criterion 1: the latch admits a review that is shorter than the time left before the deadline", async (t) => {
  // A review takes 5 min. At the latch 10 min are left.
  const h = latchedLanes(t, (unit) => reviewHistory(5 * unit, unit));
  try {
    await h.latch(1);
    const passes = h.lightAt(1);
    assert.ok(passes.length >= 1, "the ticker ran its light pass after the latch");
    assert.ok(passes.every((pass) => pass.review && pass.plan), JSON.stringify(passes));
    assert.equal(h.step("daemon.admission_held").length, 0);
    assert.equal(h.step("daemon.restart_hold_ended").length, 0, "before the deadline no hold has ended");
  } finally {
    await h.cleanup();
  }
});

test("W1-T12160 criterion 2: the latch holds a review that is longer than the time left before the deadline", async (t) => {
  const h = latchedLanes(t, (unit) => reviewHistory(5 * unit, unit));
  try {
    await h.latch(1);
    // At 7 min, 4 min are left: a 5-min review does not fit.
    h.at(7);
    await h.tick();
    const late = h.lightAt(7);
    assert.ok(late.length >= 1 && late.every((pass) => !pass.review && !pass.plan), JSON.stringify(h.light));
    const hold = h.step("daemon.admission_held").find((row) => row.kind === "review");
    assert.equal(hold?.reason, "restart latched");
    assert.equal(hold?.time_left_ms, 4 * minute);
    assert.equal(hold?.measured_length_ms, 5 * minute);
    // At the deadline itself no time is left, and the deadline has not passed: the hold stays.
    h.at(11);
    await h.tick();
    const atDeadline = h.lightAt(11);
    assert.ok(atDeadline.length >= 1 && atDeadline.every((pass) => !pass.review && !pass.plan), JSON.stringify(h.light));
    assert.equal(h.step("daemon.restart_hold_ended").length, 0, "the hold ends only after the deadline");
  } finally {
    await h.cleanup();
  }
});

test("W1-T12160 criterion 3: after the deadline the latch admits a review again and one row records that the hold ended", async (t) => {
  const h = latchedLanes(t, (unit) => reviewHistory(5 * unit, unit));
  // One review is in flight from before the latch. The exit still waits for it.
  const review = deferred<void>();
  void trackInFlightReview(review.promise, { taskId: "W1-T1", prNumber: 41 });
  try {
    await h.latch(1);
    h.at(7);
    await h.tick();
    assert.ok(h.lightAt(7).every((pass) => !pass.review), "before the deadline the review is held");
    // The lane still runs at 12 min, 1 min after the deadline.
    h.at(12);
    await h.tick();
    const after = h.lightAt(12);
    assert.ok(after.length >= 1 && after.every((pass) => pass.review && pass.plan), JSON.stringify(h.light));
    const heldBefore = h.step("daemon.admission_held").filter((row) => row.kind === "review" || row.kind === "plan-review").length;
    h.at(15);
    await h.tick();
    assert.ok(h.lightAt(15).length >= 1 && h.lightAt(15).every((pass) => pass.review && pass.plan), JSON.stringify(h.light));
    assert.equal(h.step("daemon.admission_held").filter((row) => row.kind === "review" || row.kind === "plan-review").length, heldBefore,
      "after the deadline no review is held");
    const ended = h.step("daemon.restart_hold_ended");
    assert.equal(ended.length, 1, "one row for the latch, not one row for each admission");
    assert.equal(ended[0]!.since_latch_ms, 11 * minute, "the latch was at 1 min and the first admission after the deadline at 12 min");
    assert.equal(ended[0]!.past_deadline_ms, minute);
    assert.equal(ended[0]!.kind, "review");
    assert.equal(ended[0]!.surface, "light");
    assert.deepEqual(ended[0]!.waits_for, [{ what: "review", kind: "review", phase: "review" }]);
  } finally {
    review.resolve();
    await h.cleanup();
  }
});

test("W1-T12160 criterion 4: a fix and a build refill stay held after the deadline", async (t) => {
  // A fix takes 3 min and a review 5 min. Both fit at the latch.
  const h = latchedLanes(t, (unit) => [...fixHistory(3 * unit, unit), ...reviewHistory(5 * unit, unit)],
    { tasks: ["A", "B", "C"], lanes: 2, fullSweep: true });
  try {
    await h.tick();
    await h.latch(1);
    assert.deepEqual(h.started, ["A", "B"]);
    assert.ok(h.lightAt(1).length >= 1 && h.lightAt(1).every((pass) => pass.fix && pass.refill), JSON.stringify(h.light));
    h.at(12);
    await h.tick();
    const after = h.lightAt(12);
    assert.ok(after.length >= 1, "the ticker ran its light pass after the deadline");
    assert.ok(after.every((pass) => pass.review), "a review is admitted again");
    assert.ok(after.every((pass) => !pass.fix), "a fix stays held");
    assert.ok(after.every((pass) => !pass.refill), "the latch still refuses a build refill");
    const hold = h.step("daemon.admission_held").find((row) => row.kind === "fix-dispatch" && row.surface === "light");
    assert.equal(hold?.reason, "restart latched");
    assert.equal(hold?.time_left_ms, 0);
    // The full pass that the ticker starts after the deadline holds its fix lane and admits its review.
    const fullAfter = h.full.filter((pass) => pass.latched && pass.at === 12);
    assert.ok(fullAfter.length >= 1, "a full pass ran after the deadline");
    for (const pass of fullAfter) {
      assert.match(String(pass.hold), /restart latched/);
      assert.equal(pass.review, true);
    }
    // A build lane that frees after the deadline takes no new build.
    h.settle("A");
    await h.tick();
    assert.deepEqual(h.started, ["A", "B"], "task C did not start");
    const refill = h.step("dispatch.lane_refill_held").find((row) => row.finished_task === "A");
    assert.match(String(refill?.reason), /stale code/);
  } finally {
    await h.cleanup();
  }
});

test("W1-T12160: a review admitted after the deadline does not move the exit, and no verdict is lost or posted twice", async (t) => {
  // One unit is 40 ms, so the time limit of the drain (10 units) is 400 ms of real time.
  const posted: number[] = [];
  const aborted: number[] = [];
  const gates = [deferred<void>(), deferred<void>()];
  let admitted = 0;
  const h = latchedLanes(t, (unit) => reviewHistory(5 * unit, unit), {
    unit: 40,
    // The fake light pass starts a real tracked review for the first two admissions after the latch.
    onReviewAdmitted: () => {
      if (h.light.at(-1)!.at < 12 || admitted >= gates.length) return;
      const pr = 51 + admitted;
      const gate = gates[admitted++]!;
      void trackInFlightReview(async () => {
        const signal = currentReviewSignal();
        await gate.promise;
        // A review that the drain gave up on posts nothing: the next boot reviews the pull request again.
        if (signal?.aborted) { aborted.push(pr); return; }
        posted.push(pr);
      }, { taskId: `W1-T${pr}`, prNumber: pr });
    },
  });
  try {
    await h.latch(1);
    h.at(12);
    await h.tick();
    assert.equal(admitted, 2, "after the deadline the latch admitted two reviews");
    assert.equal(h.step("daemon.restart_hold_ended").length, 1);
    // The first review finishes before the exit and posts its verdict.
    gates[0]!.resolve();
    await waitFor(() => posted.length === 1, "the first review did not post");
    // The last lane settles at 14 units. The second review is still in flight.
    h.at(14);
    h.exit();
    const summary = await h.daemon;
    assert.equal(summary.stopReason, "stale", "the daemon exited for freshness");
    const completed = h.step("daemon.freshness_drain.completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.exit_bound_ms, 10 * h.unit, "the exit waits one time limit, as for any review admitted after the latch");
    assert.equal(completed[0]!.in_flight_reviews_at_exit, 1);
    assert.equal(completed[0]!.abandoned_in_flight_reviews, 1, "the drain gave up on the review at its time limit");
    assert.equal(completed[0]!.admitted_after_latch, 1);
    assert.equal(completed[0]!.abandoned_admitted_after_latch, 1);
    const waited = completed[0]!.waited_on as Array<Record<string, unknown>>;
    assert.deepEqual(waited.filter((item) => item.abandoned === true).map((item) => item.pr), [52]);
    assert.equal(admitted, 2, "the exit admitted no more reviews");
    // The review that the drain gave up on is told to stop. It posts nothing in this process.
    gates[1]!.resolve();
    await waitFor(() => aborted.length === 1, "the review that the drain gave up on was not stopped");
    assert.deepEqual(posted, [51], "one verdict for the review that finished, none for the review that was stopped");
    assert.deepEqual(aborted, [52]);
  } finally {
    for (const gate of gates) gate.resolve();
    await h.cleanup();
  }
});

test("W1-T12160 criterion 5: once the drain of the exit has begun, the latch holds a review past the deadline", async (t) => {
  // One unit is 40 ms. A fix worker starts at 12 units, after the latch, and does not finish. The lane settles at
  // 14 units, so the drain of the exit waits for the fix until 24 units and runs its review clock beside it.
  const fix = deferred<void>();
  const h = latchedLanes(t, (unit) => reviewHistory(5 * unit, unit), { unit: 40 });
  try {
    await h.latch(1);
    h.at(12);
    await h.tick();
    assert.ok(h.lightAt(12).length >= 1 && h.lightAt(12).every((pass) => pass.review), "before the exit the latch admits a review again");
    assert.equal(h.step("daemon.restart_hold_ended").length, 1);
    detachSweepAction(fix.promise, { actionKind: "fix-dispatch", taskId: "W1-T12160-FIX" });
    h.at(14);
    h.exit();
    await waitFor(() => h.lightAt(14).length >= 1, "the review clock of the drain did not run a pass");
    assert.ok(h.lightAt(14).every((pass) => pass.review), "with 10 units left the drain admits a 5-unit review");
    // The clock moves past the deadline of the drain while the drain still waits. A review admitted now gets no time.
    h.at(30);
    assert.equal((await h.daemon).stopReason, "stale");
    assert.equal(h.lightAt(30).length, 0, "past its deadline the drain admitted no review");
    const [completed] = h.step("daemon.freshness_drain.completed");
    assert.ok(Number(completed?.review_passes_held) >= 1, "the review clock asked the latch, and the latch held the review");
    assert.equal(completed?.exit_bound_ms, 10 * h.unit, "the exit kept its time limit");
    assert.equal(h.step("daemon.restart_hold_ended").length, 1, "the hold ended once, before the exit");
  } finally {
    fix.resolve();
    await h.cleanup();
  }
});
