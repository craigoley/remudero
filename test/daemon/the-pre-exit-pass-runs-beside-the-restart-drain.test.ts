import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { runDaemon, type DaemonDeps, type ReviewAdmissionGate } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
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

async function fixture(t: TestContext, background = false, unlatched = false) {
  assert.equal(inFlightReviewCount(), 0);
  const dir = mkdtempSync(join(tmpdir(), "rmd-t9812-"));
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
  const material = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40),
    staleSinceMs: epoch - 7_200_000,
    changes: [{ sha: "b".repeat(40), subject: "fix: refresh worker", files: ["src/lib/worker.ts"] }] };
  const daemon = runDaemon(loadPlan(path), {
    now: () => new Date(nowMs),
    refreshMerged: () => () => exiting,
    checkFreshness: () => stale ? material : { stale: false },
    checkStop: () => undefined,
    runOne: () => { running = true; return lane.promise; },
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
    sweepRetriggerIntervalMs: background ? 20 : 1_000_000 });
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
    daemon, row, at, review, latch, finished: () => finished, calls: () => calls,
    admit: async (work?: () => void) => { onAdmit = work; admit.resolve(); await pump(); },
    settlePass: async () => { pass.resolve(); await pump(); t.mock.timers.tick(0); await pump(); },
    exit: async () => {
      at(40); exiting = true; stale = true;
      lane.resolve({ taskId: "A", runId: "fixture", merged: true, verdict: "merged", costUsd: 0 });
      await wake(); assert.equal(calls, 2, "the exit runs or awaits its pass");
    },
    fix: () => {
      const held = deferred<void>(); cleanups.push(() => held.resolve());
      detachSweepAction(held.promise, { actionKind: "fix-dispatch", taskId: "FIX", phase: "worker" });
      return held;
    },
  };
}

test("W1-T9812: the restart drain starts before the pre-exit pass settles", async (t) => {
  for (const background of [false, true]) {
    await t.test(background ? "background pass" : "fresh pass", async (t) => {
      const h = await fixture(t, background), review = h.review("LATCHED");
      await h.latch(); await h.exit();
      h.at(110); t.mock.timers.tick(70); await pump();
      assert.equal(review.aborted(), true, "the real review drain reaches the latch deadline while the pass runs");
      assert.equal(h.finished(), false);
      await h.admit(); await h.settlePass();
      assert.equal((await h.daemon).stopReason, "stale");
    });
  }
});

test("W1-T9812: the restart still waits for the pre-exit pass to settle", async (t) => {
  const h = await fixture(t, true), review = h.review("LATCHED");
  await h.latch(); await h.exit();
  h.at(50); review.resolve(); await pump();
  assert.equal(h.finished(), false);
  assert.equal(h.row("daemon_selfrestart_for_freshness"), undefined);
  h.at(80); await h.admit(); await h.settlePass();
  assert.equal((await h.daemon).stopReason, "stale");
  assert.equal(h.row("daemon_selfrestart_for_freshness")?.pre_exit_pass, "awaited_in_flight");
  const completed = h.row("daemon.freshness_drain.completed");
  assert.equal(completed?.pre_exit_pass, "awaited_in_flight");
  assert.equal(completed?.pass_overlap_ms, 40);
});

test("W1-T9812: what the pre-exit pass admits keeps the latch bound", async (t) => {
  for (const kind of ["review", "fix"] as const) {
    await t.test(kind, async (t) => {
      const h = await fixture(t);
      await h.latch(); await h.exit();
      let review: ReturnType<typeof h.review> | undefined;
      h.at(70);
      await h.admit(() => { if (kind === "review") review = h.review("AFTER"); else h.fix(); });
      h.at(90); await h.settlePass();
      assert.equal(h.finished(), false, "work admitted after the initial empty drain is still awaited");
      h.at(109); t.mock.timers.tick(19); await pump();
      assert.equal(h.finished(), false, "the remaining latch time is available to admitted work");
      h.at(110); t.mock.timers.tick(1); await pump();
      assert.equal(h.finished(), true, "admitted work gets no fresh bound after the pass");
      assert.equal((await h.daemon).stopReason, "stale");
      const completed = h.row("daemon.freshness_drain.completed");
      assert.equal(completed?.pre_exit_pass, "ran");
      assert.equal(completed?.pass_overlap_ms, 50);
      assert.equal(completed?.exit_bound_ms, 70);
      assert.equal(completed?.[kind === "review" ? "abandoned_in_flight_reviews" : "abandoned_detached_sweep_actions"], 1);
      if (review) assert.equal(review.aborted(), true);
    });
  }
});

test("an exit with no dispatch latch keeps the pass before the drain", async (t) => {
  const h = await fixture(t, false, true), review = h.review("UNLATCHED");
  await h.exit();
  t.mock.timers.tick(boundMs / 2); await pump();
  assert.equal(review.aborted(), false, "the unlatched exit has not started its drain");
  assert.equal(h.row("daemon.freshness_drain.started"), undefined);
  h.at(80); review.resolve(); await h.admit(); await h.settlePass();
  assert.equal((await h.daemon).stopReason, "stale");
  assert.equal(h.row("daemon_selfrestart_for_freshness")?.pre_exit_pass, "ran");
});
