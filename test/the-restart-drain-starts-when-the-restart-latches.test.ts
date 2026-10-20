/**
 * W1-T8172 — THE RESTART DRAIN STARTS WHEN THE RESTART LATCHES.
 *
 * 2026-10-15: the dispatch latch came at 18:29:00, but the freshness drain began only at 18:59:45, after the last
 * lane settled. It ran 1,217,693 ms against a 559,000 ms bound, its clock admitted reviews for #12109, #12110,
 * #12111 and #12115 at 19:17, and it then abandoned 4. Each fixture here drives one dispatch lane through a latch
 * with a fake daemon clock, and holds a review or a detached fix open so the drain's state is controlled.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import * as daemonModule from "../src/lib/daemon.js";
import { runDaemon, type DaemonDeps, type LightPassScope } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { detachSweepAction, detachedSweepActionCount, drainDetachedSweepActions, inFlightReviewCount, trackInFlightReview } from "../src/lib/sweep.js";

type RunResult = Awaited<ReturnType<DaemonDeps["runOne"]>>;

const minute = 60_000;
const BOUND_MS = 10 * minute;
const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** `sweep.review_started` → `review.posted` pairs, each `lengthMs` long. */
function reviewHistory(lengthMs: number, pairs = 3): string[] {
  const end = Date.now() - minute;
  return Array.from({ length: pairs }, (_, i) => [
    JSON.stringify({ ts: new Date(end - lengthMs - i).toISOString(), step: "sweep.review_started", pr_number: 900 + i }),
    JSON.stringify({ ts: new Date(end - i).toISOString(), step: "review.posted", pr_url: `https://github.com/acme/remudero/pull/${900 + i}` }),
  ]).flat();
}

interface Row { step: string; extra: Record<string, unknown> }

/** One lane (task A) runs; a dispatch tick at `latch()` latches the restart; `settle()` ends the lane, and the
 *  daemon exits for freshness. `drainClock` flips the wake seam to an immediate wake once the lane has settled. */
function latchedLane(t: TestContext, ledger: readonly string[] | ((exiting: boolean) => readonly string[]) = []) {
  assert.equal(inFlightReviewCount(), 0, "precondition: no review leaked from another test");
  assert.equal(detachedSweepActionCount(), 0, "precondition: no detached action leaked from another test");
  const dir = mkdtempSync(join(tmpdir(), "rmd-t8172-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n");
  const start = Date.now();
  let nowMs = start;
  t.mock.method(Date, "now", () => nowMs);
  const rows: Row[] = [];
  const passes: Array<{ scope: LightPassScope | undefined; exiting: boolean }> = [];
  const lane = deferred<RunResult>();
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  let stale = false;
  let exiting = false;
  let clockWaits = 0;
  const material = { stale: true as const, oldSha: OLD_SHA, newSha: NEW_SHA, staleSinceMs: start - 120 * minute,
    changes: [{ sha: NEW_SHA, subject: "fix: update worker", files: ["src/lib/worker.ts"] }] };
  const daemon = runDaemon(loadPlan(planPath), {
    now: () => new Date(nowMs),
    readLedgerLines: () => typeof ledger === "function" ? ledger(exiting) : ledger,
    refreshMerged: () => (id) => id === "A" && exiting,
    checkFreshness: () => stale ? material : { stale: false },
    log: (step, extra = {}) => rows.push({ step, extra }),
    runOne: () => lane.promise,
    sleep: () => { const sleep = deferred<void>(); sleeps.push(sleep); return sleep.promise; },
    sleepUntilSweepWake: async () => {
      if (exiting) { clockWaits++; await flush(); return "wake"; }
      const sleep = deferred<void>();
      sleeps.push(sleep);
      await sleep.promise;
      return "timeout";
    },
    sweepLight: async (scope?: LightPassScope) => { passes.push({ scope, exiting }); },
  } as DaemonDeps, { freshnessMinLifetimeMs: 0, laneCount: 1, max: 1, sweepWallClockBoundMs: BOUND_MS });
  const at = (ageMinutes: number) => { nowMs = start + ageMinutes * minute; };
  return {
    daemon, rows, passes, at,
    clockWaits: () => clockWaits,
    step: (step: string) => rows.filter((row) => row.step === step),
    latch: async (ageMinutes: number) => {
      at(ageMinutes);
      stale = true;
      // The ticker's own wait is the second one taken; two rounds reach its dispatch tick.
      for (let round = 0; round < 2; round++) {
        for (const sleep of sleeps.splice(0)) sleep.resolve();
        for (let i = 0; i < 50; i++) await flush();
      }
    },
    settle: async (ageMinutes: number) => {
      at(ageMinutes);
      exiting = true;
      rows.push({ step: "fixture.lane_settled", extra: {} });
      lane.resolve({ taskId: "A", runId: "A-run", merged: true, verdict: "merged", costUsd: 0 });
      for (let i = 0; i < 20; i++) await flush();
    },
    cleanup: async () => {
      exiting = true;
      lane.resolve({ taskId: "A", runId: "A-run", merged: true, verdict: "merged", costUsd: 0 });
      for (const sleep of sleeps) sleep.resolve();
      await daemon;
      await drainDetachedSweepActions();
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

test("W1-T8172: a review in flight at the latch drains during the lane wait", async (t) => {
  const h = latchedLane(t);
  const review = deferred<void>();
  void trackInFlightReview(review.promise);
  try {
    await h.latch(1);
    assert.ok(h.rows.some(({ step, extra }) => step === "daemon.freshness_decision" && extra.action === "restart"), "the restart latched");
    const [started] = h.step("daemon.freshness_drain.started");
    assert.equal(started?.extra.started_at, "latch", "the drain starts at the latch, before the lane settles");
    assert.equal(started?.extra.in_flight_reviews, 1);
    h.at(3);
    review.resolve();
    await flush();
    await h.settle(4);
    await waitFor(() => h.step("daemon.freshness_drain.completed").length === 1, "the exit's drain never completed");
    const completed = h.step("daemon.freshness_drain.completed")[0]!.extra;
    assert.equal(completed.started_at, "latch");
    assert.equal(completed.in_flight_reviews, 1, "the drain counts the review it took at the latch");
    assert.equal(completed.in_flight_reviews_at_exit, 0, "the review settled in the lane wait, so the exit waits on nothing");
    assert.equal(completed.abandoned_in_flight_reviews, 0);
    assert.equal(completed.exit_wait_ms, 0);
    assert.equal(completed.duration_ms, 3 * minute, "the drain ran from the latch at 1 min to the exit at 4 min");
    assert.equal(h.step("daemon.freshness_drain.started").length, 1, "the exit opens no second drain");
    assert.equal((await h.daemon).stopReason, "stale");
  } finally {
    review.resolve();
    await h.cleanup();
  }
});

test("W1-T8172: the drain bound runs from the latch", async (t) => {
  // A lane that settles inside the bound leaves the exit the bound's remainder: latched at 1, exits at 5, 6 min left.
  const inside = latchedLane(t);
  const short = deferred<void>();
  void trackInFlightReview(short.promise);
  try {
    await inside.latch(1);
    await inside.settle(5);
    short.resolve();
    await waitFor(() => inside.step("daemon.freshness_drain.completed").length === 1, "the drain never completed");
    assert.equal(inside.step("daemon.freshness_drain.completed")[0]!.extra.exit_bound_ms, BOUND_MS - 4 * minute);
  } finally {
    short.resolve();
    await inside.cleanup();
  }
  t.mock.restoreAll();
  // A lane that outlives the bound leaves the exit nothing: the review the latch saw is abandoned at once, not
  // waited on for a fresh bound from the exit.
  const outside = latchedLane(t);
  const held = deferred<void>();
  void trackInFlightReview(held.promise);
  try {
    await outside.latch(1);
    await outside.settle(12);
    await waitFor(() => outside.step("daemon.freshness_drain.completed").length === 1,
      "the exit waited on a review whose bound, counted from the latch, had already run out");
    const completed = outside.step("daemon.freshness_drain.completed")[0]!.extra;
    assert.equal(completed.exit_bound_ms, 0);
    assert.equal(completed.abandoned_in_flight_reviews, 1);
    assert.equal(completed.admitted_after_latch, 0);
    assert.equal(completed.duration_ms, 11 * minute);
  } finally {
    held.resolve();
    await outside.cleanup();
  }
});

/** A detached fix held from before the latch keeps the drain's clock running; the exit is at 5 min, so the drain's
 *  bound, counted from the latch at 1 min, leaves 6 min. */
async function drainClockRun(t: TestContext, ledger: Parameters<typeof latchedLane>[1]) {
  let releaseFix!: () => void;
  const fix = new Promise<void>((resolve) => { releaseFix = resolve; });
  const h = latchedLane(t, ledger);
  detachSweepAction(fix, { actionKind: "fix-dispatch", taskId: "W1-T8172-FIX" });
  try {
    await h.latch(1);
    await h.settle(5);
    await waitFor(() => h.clockWaits() >= 5, "the drain's clock never ticked");
    releaseFix();
    await waitFor(() => h.step("daemon.freshness_drain.completed").length === 1, "the drain never completed");
    return { completed: h.step("daemon.freshness_drain.completed")[0]!.extra, drainPasses: h.passes.filter((p) => p.exiting) };
  } finally {
    releaseFix();
    await h.cleanup();
    t.mock.restoreAll();
  }
}

test("W1-T8172: no review is admitted that the drain would abandon", async (t) => {
  const long = await drainClockRun(t, reviewHistory(8 * minute));
  assert.equal(long.completed.review_length_ms, 8 * minute);
  assert.equal(long.completed.exit_bound_ms, 6 * minute);
  assert.deepEqual(long.drainPasses, [], "an 8-min review cannot finish in the 6 min the drain has left");
  assert.equal(long.completed.review_passes, 0);
  assert.ok(Number(long.completed.review_passes_held) >= 1, JSON.stringify(long.completed));
  // The same drain admits a review it can finish.
  const short = await drainClockRun(t, reviewHistory(3 * minute));
  assert.equal(short.completed.review_length_ms, 3 * minute);
  assert.ok(short.drainPasses.length >= 1 && short.drainPasses.every((p) => p.scope?.reviewOnly === true));
  assert.equal(short.completed.review_passes_held, 0);
});

test("W1-T8172: with no review history the clock admits as today", async (t) => {
  const run = await drainClockRun(t, []);
  assert.equal(run.completed.review_length_source, "no_history");
  assert.equal(run.completed.review_length_ms, null);
  assert.ok(run.drainPasses.length >= 1, "with nothing measured, the drain's clock still runs its passes");
  assert.equal(run.completed.review_passes_held, 0);
  // A ledger the drain cannot read is no history either, named as such on the completion row.
  const unreadable = await drainClockRun(t, (exiting) => { if (exiting) throw new Error("EIO: ledger"); return []; });
  assert.equal(unreadable.completed.review_length_source, "unreadable");
  assert.ok(unreadable.drainPasses.length >= 1);
});

test("W1-T8172: the review length pairs each start with its own PR's post", () => {
  const ts = (min: number) => new Date(Date.UTC(2026, 9, 15, 19, min)).toISOString();
  assert.equal(daemonModule.medianReviewRunMs([
    JSON.stringify({ ts: ts(0), step: "sweep.review_started", pr_number: 1 }),
    JSON.stringify({ ts: ts(1), step: "sweep.review_started", pr_number: 2 }),
    "{torn",
    JSON.stringify({ ts: ts(3), step: "review.posted", pr_url: "https://github.com/acme/remudero/pull/2" }),
    JSON.stringify({ ts: ts(9), step: "review.posted", pr_url: "https://github.com/acme/remudero/pull/1" }),
    JSON.stringify({ ts: ts(10), step: "review.posted", pr_url: "https://github.com/acme/remudero/pull/3" }),
  ]), (2 * minute + 9 * minute) / 2);
  assert.equal(daemonModule.medianReviewRunMs([]), undefined);
});
