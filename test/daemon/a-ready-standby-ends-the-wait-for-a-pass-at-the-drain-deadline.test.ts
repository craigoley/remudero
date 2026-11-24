// TASKID: with a hand-over started, a ready standby ends the exit's wait for an in-flight pass at the latch's drain
// deadline, not at latch + maxDrainWaitMs (Craig's yes, 2026-11-24 17:43Z). On hand-over 4 (2026-11-24) the exit's
// drain bound was 558,831 ms, yet it waited 971,936 ms for the pass while the standby had long been ready.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import type { DaemonHandoff, HandoffAttempt, HandoffSlot } from "#src/lib/daemon-handoff.js";
import { runDaemon, type DaemonDeps, type ReviewAdmissionGate } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { trackInFlightReview, drainInFlightReviews, inFlightReviewCount, drainDetachedSweepActions } from "#src/lib/sweep.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function pump() { for (let i = 0; i < 30; i++) await flush(); }

type Row = { step: string; extra: Record<string, unknown> };
type Result = Awaited<ReturnType<DaemonDeps["runOne"]>>;
/** The full-pass bound: the latch's drain window ends at latch + this. */
const boundMs = 100;
/** Far past the window, so only a ready standby can end the wait at it. */
const limitMs = 1_000;

function standbyHandoff(ready: boolean): { handoff: DaemonHandoff; yielded: () => boolean } {
  let yielded = false;
  const attempt: HandoffAttempt = { runId: "standby-1", pid: 4242, slot: { dir: "/slots/b", sha: "b".repeat(40) } as HandoffSlot,
    ready: async () => ready, yieldTo: () => { yielded = true; }, abort: () => {} };
  return { handoff: { enabled: () => true, begin: async () => attempt }, yielded: () => yielded };
}

async function fixture(t: TestContext, handoff?: DaemonHandoff) {
  assert.equal(inFlightReviewCount(), 0);
  const dir = mkdtempSync(join(tmpdir(), "rmd-standby-pass-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n");
  const epoch = Date.now();
  let nowMs = epoch;
  t.mock.method(Date, "now", () => nowMs);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lane = deferred<Result>(), pass = deferred<void>(), review = deferred<void>();
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  const rows: Row[] = [];
  let calls = 0, stale = false, exiting = false, finished = false;
  const material = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40), staleSinceMs: epoch - 7_200_000,
    changes: [{ sha: "b".repeat(40), subject: "fix: refresh worker", files: ["src/lib/worker.ts"] }] };
  const daemon = runDaemon(loadPlan(path), {
    ...hostIndependentDaemonDeps(),
    now: () => new Date(nowMs),
    refreshMerged: () => () => exiting,
    checkFreshness: () => stale ? material : { stale: false },
    checkStop: () => undefined,
    runOne: () => lane.promise,
    log: (step, extra = {}) => rows.push({ step, extra }),
    sleep: () => { const wait = deferred<void>(); sleeps.push(wait); return wait.promise; },
    sweep: async (_gate?: ReviewAdmissionGate) => { calls++; if (calls > 1) await pass.promise; },
    ...(handoff ? { handoff } : {}),
  }, { freshnessMinLifetimeMs: 0, laneCount: 1, max: 1, sweepWallClockBoundMs: boundMs,
    sweepRetriggerIntervalMs: 20, freshnessMaxDrainWaitMs: limitMs });
  void daemon.then(() => { finished = true; });
  const wake = async () => { for (const wait of sleeps.splice(0)) wait.resolve(); await pump(); };
  const at = (ms: number) => { nowMs = epoch + ms; };
  t.after(async () => {
    review.resolve(); pass.resolve(); exiting = true; stale = true;
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
  void trackInFlightReview(async () => { await review.promise; }, { taskId: "LATCHED" });
  // The latch at 10 ms, a background pass from 30 ms, and the exit at 40 ms; the latched review settles at 45 ms.
  at(10); stale = true; await wake(); await wake();
  assert.ok(rows.some((r) => r.step === "daemon.freshness_decision" && r.extra.action === "restart"));
  at(30); await wake(); assert.equal(calls, 2, "a pass is in flight at the exit");
  at(40); exiting = true;
  lane.resolve({ taskId: "A", runId: "fixture", merged: true, verdict: "merged", costUsd: 0 });
  await wake(); assert.equal(calls, 2, "the exit awaits the running pass and starts none");
  at(45); review.resolve(); await pump();
  /** Moves both clocks; the mocked timer clock started at the exit (40 ms). */
  const advance = async (fromMs: number, toMs: number) => { at(toMs); t.mock.timers.tick(toMs - fromMs); await pump(); t.mock.timers.tick(0); await pump(); };
  return { daemon, finished: () => finished, advance, row: (step: string) => rows.find((r) => r.step === step)?.extra };
}

test("TASKID with a ready standby the exit stops waiting for an in-flight pass at the drain deadline", async (t) => {
  const standby = standbyHandoff(true);
  const h = await fixture(t, standby.handoff);
  await h.advance(40, 109);
  assert.equal(h.finished(), false, "the pass still has time before the drain deadline");
  await h.advance(109, 110);
  assert.equal(h.finished(), true, "a ready standby ends the wait at latch + the drain window, not latch + the limit");
  const summary = await h.daemon;
  assert.equal(summary.stopReason, "stale");
  assert.equal(summary.handedOff, true, "and the exit hands over to it");
  assert.equal(standby.yielded(), true);
  const abandoned = h.row("daemon.freshness_pre_exit_pass_abandoned");
  assert.equal(abandoned?.ended_by, "standby_ready", JSON.stringify(abandoned));
  assert.equal(abandoned?.pre_exit_pass, "awaited_in_flight");
});

test("TASKID without a ready standby the exit still waits for the pass past the drain deadline", async (t) => {
  for (const handoff of [standbyHandoff(false).handoff, undefined]) {
    await t.test(handoff ? "a standby that is not ready" : "no hand-over", async (tt) => {
      const h = await fixture(tt, handoff);
      await h.advance(40, 120);
      assert.equal(h.finished(), false, "the exit waits on, as on origin/main");
      assert.equal(h.row("daemon.freshness_pre_exit_pass_abandoned")?.ended_by, undefined);
    });
  }
});
