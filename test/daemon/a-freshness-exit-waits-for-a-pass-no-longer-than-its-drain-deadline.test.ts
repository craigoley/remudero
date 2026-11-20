// W1-T13888: a freshness exit waits for an in-flight pass no longer than its drain deadline.
// On 2026-11-20 a requested restart waited 2,350,250 ms for a full pass stuck in its prelude.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { runDaemon, type DaemonDeps, type ReviewAdmissionGate } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import {
  currentReviewSignal, trackInFlightReview, drainInFlightReviews, inFlightReviewCount,
  detachSweepAction, drainDetachedSweepActions,
} from "#src/lib/sweep.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function pump() { for (let i = 0; i < 30; i++) await flush(); }

type Row = { step: string; extra: Record<string, unknown> };
type Result = Awaited<ReturnType<DaemonDeps["runOne"]>>;
const boundMs = 100;
/** Below `boundMs`, the fixture's full-pass bound, so only the drain deadline can end the wait. */
const limitMs = 50;

async function fixture(t: TestContext, background = false, unlatched = false, childMode = false) {
  assert.equal(inFlightReviewCount(), 0);
  const dir = mkdtempSync(join(tmpdir(), "rmd-t13888-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, unlatched ? "[]\n" :
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n");
  const epoch = Date.now();
  let nowMs = epoch;
  t.mock.method(Date, "now", () => nowMs);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lane = deferred<Result>(), pass = deferred<void>(), admit = deferred<void>();
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  const rows: Row[] = [];
  const cleanups: Array<() => void> = [];
  let calls = 0, running = false, stale = false, exiting = false, finished = false;
  let onAdmit: (() => void) | undefined;
  let enterChild: (() => void) | undefined;
  const material = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40),
    staleSinceMs: epoch - 7_200_000,
    changes: [{ sha: "b".repeat(40), subject: "fix: refresh worker", files: ["src/lib/worker.ts"] }] };
  const daemon = runDaemon(loadPlan(path), {
    ...hostIndependentDaemonDeps(),
    now: () => new Date(nowMs),
    refreshMerged: () => () => exiting,
    checkFreshness: () => stale ? material : { stale: false },
    checkStop: () => undefined,
    runOne: (_id, options) => {
      running = true;
      enterChild = () => options?.onChildPending?.({ runId: "fixture", abort: async () => undefined as never });
      return lane.promise;
    },
    log: (step, extra = {}) => rows.push({ step, extra }),
    sleep: () => { const wait = deferred<void>(); sleeps.push(wait); return wait.promise; },
    sweep: async (gate?: ReviewAdmissionGate) => {
      calls++;
      if (calls === 1) {
        if (unlatched) throw new Error("fixture boot pass failed");
        return;
      }
      await admit.promise;
      if (onAdmit) { assert.equal(gate?.(), true, "the pass uses the latch admission predicate"); onAdmit(); }
      await pass.promise;
    },
  }, { freshnessMinLifetimeMs: 0, laneCount: 1, max: 1, sweepWallClockBoundMs: boundMs,
    sweepRetriggerIntervalMs: background ? 20 : 1_000_000, freshnessMaxDrainWaitMs: limitMs });
  void daemon.then(() => { finished = true; });
  const wake = async () => { for (const wait of sleeps.splice(0)) wait.resolve(); await pump(); };
  const at = (ms: number) => { nowMs = epoch + ms; };
  const row = (step: string) => rows.find((r) => r.step === step)?.extra;
  const review = (taskId: string) => {
    const held = deferred<void>();
    let signal: AbortSignal | undefined;
    void trackInFlightReview(async () => { signal = currentReviewSignal(); await held.promise; }, { taskId });
    cleanups.push(() => held.resolve());
    return { resolve: () => held.resolve(), aborted: () => signal?.aborted };
  };
  t.after(async () => {
    for (const cleanup of cleanups) cleanup();
    admit.resolve(); pass.resolve(); exiting = true; stale = true;
    lane.resolve({ taskId: "A", runId: "fixture", merged: true, verdict: "merged", costUsd: 0 });
    await wake();
    t.mock.timers.tick(1_000_000);
    await daemon;
    await drainInFlightReviews({ boundMs: 0 });
    await drainDetachedSweepActions({ boundMs: 0 });
    t.mock.restoreAll(); t.mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  });
  await pump();
  if (!unlatched) assert.equal(running, true, "the daemon entered dispatch");
  const latch = async () => {
    at(10); stale = true;
    await wake(); await wake();
    assert.ok(rows.some((r) => r.step === "daemon.freshness_decision" && r.extra.action === "restart"));
    if (background) { at(30); await wake(); assert.equal(calls, 2); }
  };
  return {
    daemon, row, at, review, latch, wake, finished: () => finished, calls: () => calls,
    enterChild: () => { assert.ok(enterChild); enterChild(); },
    admit: async (work?: () => void) => { onAdmit = work; admit.resolve(); await pump(); },
    settlePass: async () => { pass.resolve(); await pump(); t.mock.timers.tick(0); await pump(); },
    exit: async (passes = 2) => {
      at(40); exiting = true; stale = true;
      if (!childMode) lane.resolve({ taskId: "A", runId: "fixture", merged: true, verdict: "merged", costUsd: 0 });
      await wake(); assert.equal(calls, passes, "the exit awaits a running pass and starts none (W1-T12237)");
    },
    fix: () => {
      const held = deferred<void>(); cleanups.push(() => held.resolve());
      detachSweepAction(held.promise, { actionKind: "fix-dispatch", taskId: "FIX", phase: "worker" });
      return held;
    },
  };
}


test("W1-T13888 criterion 1: a latched exit stops waiting for the pass at the drain deadline", async (t) => {
  const h = await fixture(t, true), review = h.review("LATCHED");
  await h.latch(); await h.exit();
  h.at(45); review.resolve(); await pump();
  h.at(59); t.mock.timers.tick(19); await pump();
  assert.equal(h.finished(), false, "the pass still has time before latch + limit");
  h.at(60); t.mock.timers.tick(1); await pump(); t.mock.timers.tick(0); await pump();
  assert.equal(h.finished(), true, "the exit goes without the pass at latch + limit");
  assert.equal((await h.daemon).stopReason, "stale");
  const abandoned = h.row("daemon.freshness_pre_exit_pass_abandoned");
  assert.equal(abandoned?.pre_exit_pass, "awaited_in_flight");
  assert.equal(abandoned?.max_drain_wait_ms, limitMs);
  assert.equal(h.row("daemon.sweep.abandoned"), undefined, "the full-pass bound did not end the wait");
  const phases = h.row("daemon.freshness_exit")?.phases_ms as Record<string, unknown> | undefined;
  assert.equal(phases?.pre_exit_pass, 20, "the abandoned pass is recorded once, at the limit");
  assert.equal(h.row("daemon.freshness_drain.completed")?.pass_overlap_ms, 20, "and the drain reports its overlap to the limit");
});

test("W1-T13888 criterion 2: an unlatched exit stops waiting for the pass at the drain deadline", async (t) => {
  const h = await fixture(t, true, true);
  h.at(30); await h.wake();
  assert.equal(h.calls(), 2, "a background pass is running before the exit");
  await h.exit(2);
  h.at(89); t.mock.timers.tick(49); await pump();
  assert.equal(h.finished(), false, "the pass still has time before exit + limit");
  h.at(90); t.mock.timers.tick(1); await pump(); t.mock.timers.tick(0); await pump();
  assert.equal(h.finished(), true, "the exit goes without the pass at exit + limit");
  assert.equal((await h.daemon).stopReason, "stale");
  assert.equal(h.row("daemon.freshness_pre_exit_pass_abandoned")?.pre_exit_pass, "awaited_in_flight");
  assert.equal(h.row("daemon.sweep.abandoned"), undefined, "the full-pass bound did not end the wait");
});

test("W1-T13888 invariant: a pass that settles inside the limit is waited for and nothing is abandoned", async (t) => {
  const h = await fixture(t, true), review = h.review("LATCHED");
  await h.latch(); await h.exit();
  h.at(45); review.resolve(); await pump();
  h.at(55); await h.admit(); await h.settlePass();
  assert.equal((await h.daemon).stopReason, "stale");
  assert.equal(h.row("daemon.freshness_pre_exit_pass_abandoned"), undefined);
  assert.equal(h.row("daemon.freshness_drain.completed")?.pass_overlap_ms, 15);
});
