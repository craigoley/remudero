import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { runDaemon, type DaemonDeps } from "../../src/lib/daemon.js";
import { loadPlan } from "../../src/lib/plan.js";
import * as sweep from "../../src/lib/sweep.js";

type Row = { step: string; extra: Record<string, any> };
type Result = Awaited<ReturnType<DaemonDeps["runOne"]>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 2000; i++) { if (predicate()) return; await flush(); }
  assert.fail("the expected daemon phase was never observed");
}
function plan(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-drain-inventory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n");
  return loadPlan(file);
}
function latched(t: TestContext, passMs = 0) {
  assert.equal(sweep.inFlightReviewCount(), 0);
  assert.equal(sweep.detachedSweepActionCount(), 0);
  const source = plan(t), start = Date.now();
  let now = start, stale = false, exiting = false;
  t.mock.method(Date, "now", () => now);
  const lane = deferred<Result>(), sleeps: Array<ReturnType<typeof deferred<void>>> = [], rows: Row[] = [];
  const material = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40), staleSinceMs: start - 7_200_000,
    changes: [{ sha: "b".repeat(40), subject: "fix: update worker", files: ["src/lib/worker.ts"] }] };
  const daemon = runDaemon(source, {
    now: () => new Date(now), refreshMerged: () => () => exiting,
    checkFreshness: () => stale ? material : { stale: false },
    log: (step, extra = {}) => rows.push({ step, extra }), runOne: () => lane.promise,
    sleep: () => { const s = deferred<void>(); sleeps.push(s); return s.promise; },
    sleepUntilSweepWake: async () => {
      if (exiting) { await flush(); return "wake"; }
      const s = deferred<void>(); sleeps.push(s); await s.promise; return "timeout";
    },
    sweepLight: async () => {},
    ...(passMs > 0 ? { sweep: async () => { if (exiting) now += passMs; } } : {}),
  } as DaemonDeps, { freshnessMinLifetimeMs: 0, max: 1, laneCount: 1, sweepWallClockBoundMs: 1000 });
  const row = (step: string) => rows.find(r => r.step === step)?.extra;
  return {
    start, rows, daemon, row, at: (ms: number) => { now = start + ms; },
    async latch(ms: number) {
      now = start + ms; stale = true;
      for (let n = 0; n < 2; n++) {
        for (const s of sleeps.splice(0)) s.resolve();
        for (let i = 0; i < 50; i++) await flush();
      }
      assert.ok(rows.some(r => r.step === "daemon.freshness_decision" && r.extra.action === "restart"));
    },
    async settle(ms: number) {
      now = start + ms; exiting = true;
      lane.resolve({ taskId: "A", runId: "A-run", verdict: "merged", merged: true, costUsd: 0 });
      for (const s of sleeps.splice(0)) s.resolve();
      for (let i = 0; i < 20; i++) await flush();
    },
    async finish() {
      exiting = true; stale = true;
      lane.resolve({ taskId: "A", runId: "A-run", verdict: "merged", merged: true, costUsd: 0 });
      for (const s of sleeps.splice(0)) s.resolve();
      await daemon;
      await sweep.drainDetachedSweepActions();
      await sweep.drainInFlightReviews({ boundMs: 1000 });
    },
  };
}
function reviewed(work: Promise<void>, taskId: string, prNumber: number, admittedAtMs: number) {
  return Reflect.apply(sweep.trackInFlightReview, undefined, [work, { taskId, prNumber, admittedAtMs }]) as Promise<void>;
}

test("W1-T10057: a drain row names each review and detached action it waited on", async t => {
  const h = latched(t), review = deferred<void>(), fix = deferred<void>();
  h.at(5);
  void reviewed(review.promise, "R1", 101, h.start + 5);
  sweep.detachSweepAction(fix.promise, { actionKind: "fix-dispatch", taskId: "FIX1", phase: "worker", startedAtMs: h.start + 5 });
  try {
    await h.latch(10);
    const started = h.row("daemon.freshness_drain.started");
    assert.equal(started?.waited_on?.length, 2, "the start names both items, not just their counts");
    const r = started.waited_on.find((x: any) => x.what === "review");
    assert.equal(r.task_id, "R1"); assert.equal(r.pr, 101); assert.equal(r.admitted, "before_latch");
    assert.equal(r.admitted_at_ms, h.start + 5);
    h.at(25); review.resolve(); fix.resolve(); await flush();
    await h.settle(30);
    await until(() => !!h.row("daemon.freshness_drain.completed"));
    const completed = h.row("daemon.freshness_drain.completed")!;
    assert.equal(completed.waited_on.length, 2);
    for (const item of completed.waited_on) {
      assert.equal(item.settled_after_ms, 15, "settlement is timed when it happens, not at drain completion");
      assert.notEqual(item.abandoned, true);
      assert.ok(!("settled" in item), "an internal promise must never enter a ledger payload");
    }
    assert.equal(completed.waited_on.find((x: any) => x.what === "detached").kind, "fix-dispatch");
    assert.equal((await h.daemon).stopReason, "stale");
  } finally { review.resolve(); fix.resolve(); await h.finish(); }
});

test("W1-T10057: an item abandoned at the bound is named as abandoned, with its kind", async t => {
  const h = latched(t), review = deferred<void>(), fix = deferred<void>();
  void reviewed(review.promise, "R2", 102, h.start);
  sweep.detachSweepAction(fix.promise, { actionKind: "fix-dispatch", taskId: "FIX2", phase: "worker", startedAtMs: h.start });
  try {
    await h.latch(10); await h.settle(1200);
    await until(() => !!h.row("daemon.freshness_drain.completed"));
    const completed = h.row("daemon.freshness_drain.completed")!;
    assert.equal(completed.exit_bound_ms, 0, "the original latch bound is unchanged");
    assert.equal(completed.waited_on?.length, 2);
    for (const item of completed.waited_on) {
      assert.equal(item.abandoned, true); assert.equal(item.settled_after_ms, undefined);
    }
    assert.equal(completed.waited_on.find((x: any) => x.task_id === "FIX2").kind, "fix-dispatch");
  } finally { review.resolve(); fix.resolve(); await h.finish(); }
});

test("W1-T10057: the exit row splits the restart into its phases", async t => {
  const h = latched(t, 7);
  try {
    await h.latch(10); await h.settle(30);
    assert.equal((await h.daemon).stopReason, "stale");
    const phases = h.row("daemon.freshness_exit")?.phases_ms;
    assert.ok(phases, "the real exit row must carry measured phase lengths");
    assert.equal(phases.decision_to_latch, 0);
    assert.equal(phases.holdouts, 20);
    assert.equal(phases.pre_exit_pass, 7);
    assert.equal(phases.drain, 0);
    assert.equal(phases.total, 27);
  } finally { await h.finish(); }
});

test("restart inventory preserves anonymous callers and does not consume their work", async () => {
  const held = deferred<void>(); void sweep.trackInFlightReview(held.promise);
  try {
    const inventory = Reflect.get(sweep, "restartDrainInventory");
    assert.equal(typeof inventory, "function");
    const items = inventory();
    assert.equal(items.length, 1); assert.equal(items[0].what, "review");
    assert.equal(items[0].task_id, undefined); assert.equal(items[0].pr, undefined);
    assert.equal(typeof items[0].admitted_at_ms, "number");
    assert.equal(sweep.inFlightReviewCount(), 1, "observation leaves registry ownership intact");
  } finally { held.resolve(); await sweep.drainInFlightReviews({ boundMs: 1000 }); }
});

test("an unlatched memory exit omits unmeasured latch and pass phases", async t => {
  const rows: Row[] = [], start = Date.now();
  const result = await runDaemon(plan(t), {
    now: () => new Date(start), refreshMerged: () => () => false,
    runOne: async () => { assert.fail("memory pressure must exit before dispatch"); },
    sleep: async () => {}, log: (step, extra = {}) => rows.push({ step, extra }),
    heapStatistics: () => ({ used_heap_size: 90, heap_size_limit: 100 }),
  }, { max: 1 });
  assert.equal(result.stopReason, "heap_pressure");
  const phases = rows.find(r => r.step === "daemon.memory_exit")?.extra.phases_ms;
  assert.ok(phases, "the post-drain memory exit has a complete observation");
  assert.equal(phases.total, 0); assert.equal(phases.drain, 0);
  for (const key of ["decision_to_latch", "holdouts", "pre_exit_pass"]) assert.ok(!(key in phases), key);
});
