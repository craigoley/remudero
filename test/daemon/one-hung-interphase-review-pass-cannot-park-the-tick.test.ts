import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { assertWallClockBound } from "#test/helpers/wall-clock-bound.js";
import {
  INTERPHASE_REVIEW_CLOCK_STOP_BOUND_MS as BOUND_MS,
  runDaemon,
  startInterphaseReviewClock,
  type DaemonDeps,
} from "#src/lib/daemon.js";

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePass, rejectPass) => { resolve = resolvePass; reject = rejectPass; });
  return { promise, resolve, reject };
}

function fixture(t: TestContext, scope?: "pause" | "drain") {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let nowMs = 10_000;
  let waiter: ((result: "wake" | "timeout") => void) | undefined;
  const passes: Array<ReturnType<typeof deferred>> = [];
  const rows: Array<Record<string, unknown>> = [];
  const clock = startInterphaseReviewClock({
    now: () => new Date(nowMs),
    refreshMerged: () => () => false,
    runOne: async () => { throw new Error("the clock cannot dispatch"); },
    sleep: async () => { throw new Error("the clock uses its wake seam"); },
    sleepUntilSweepWake: () => new Promise((resolve) => { waiter = resolve; }),
    sweepLight: () => {
      const pass = deferred();
      passes.push(pass);
      return pass.promise;
    },
  } satisfies DaemonDeps, 60_000, (step, extra) => rows.push({ step, ...extra }), scope);
  const wake = (result: "wake" | "timeout") => {
    assert.ok(waiter, "the clock must have a pending wait");
    const resolve = waiter;
    waiter = undefined;
    resolve(result);
  };
  t.after(async () => {
    passes.forEach((pass) => pass.resolve());
    const stopped = clock.stop();
    if (waiter) wake("timeout");
    await stopped;
  });
  return {
    clock, passes, rows, wake,
    startPass: async () => { wake("wake"); await settle(); },
    advance: async (ms: number) => { nowMs += ms; t.mock.timers.tick(ms); await settle(); },
    timeouts: () => rows.filter((row) => row.step === "daemon.review_clock.stop_bound_exceeded"),
  };
}

test("one hung interphase review pass cannot park the tick after the stop bound", async (t) => {
  const f = fixture(t);
  await f.startPass();
  await f.advance(7_000);
  let continued = false;
  const beganAtMs = Date.now();
  const stopped = f.clock.stop().then((result) => { continued = true; return result; });
  f.wake("timeout");
  await settle();
  await f.advance(BOUND_MS - 1);
  assert.equal(continued, false, "the active pass gets the full grace period");
  await f.advance(1);
  assert.equal(continued, true, "the caller continues while the pass is still unresolved");
  assert.deepEqual(await stopped, { eventWakeSeen: true, passes: 1, held: 0 });
  assertWallClockBound(Date.now() - beganAtMs, 1_500, "review clock stop must stay wall-clock bounded");
  assert.deepEqual(f.timeouts(), [{
    step: "daemon.review_clock.stop_bound_exceeded", phase: "interphase", bound_ms: BOUND_MS,
    active_passes: [{ pass: 1, trigger: "github-event", review_only: false,
      started_at_ms: 10_000, elapsed_ms: 7_000 + BOUND_MS }],
  }]);
  assert.equal(f.passes.length, 1, "stopping prevents further admission");
  f.passes[0]!.resolve();
  await settle();
  assert.ok(f.rows.some((row) => row.step === "daemon.review_clock.wake_consumed"),
    "a pass left running still completes its original work");
});

test("stopping names each remaining pass and its own elapsed duration", async (t) => {
  const f = fixture(t, "drain");
  await f.startPass();
  await f.advance(200);
  await f.startPass();
  const stopped = f.clock.stop();
  f.wake("timeout");
  await settle();
  await f.advance(BOUND_MS);
  assert.deepEqual(f.timeouts(), [{
    step: "daemon.review_clock.stop_bound_exceeded", phase: "freshness_drain", during_drain: true,
    bound_ms: BOUND_MS,
    active_passes: [
      { pass: 1, trigger: "github-event", review_only: true, started_at_ms: 10_000, elapsed_ms: BOUND_MS + 200 },
      { pass: 2, trigger: "github-event", review_only: true, started_at_ms: 10_200, elapsed_ms: BOUND_MS },
    ],
  }]);
  assert.equal((await stopped).passes, 2);
});

test("a pass that settles within the stop bound is awaited without a timeout row", async (t) => {
  const f = fixture(t);
  await f.startPass();
  await f.startPass();
  let continued = false;
  const stopped = f.clock.stop().then(() => { continued = true; });
  f.wake("timeout");
  await settle();
  f.passes[0]!.resolve();
  await f.advance(BOUND_MS - 1);
  assert.equal(continued, false, "the second admitted pass must also settle");
  f.passes[1]!.resolve();
  await settle();
  assert.equal(continued, true);
  await stopped;
  await f.advance(BOUND_MS);
  assert.deepEqual(f.timeouts(), []);
});

test("only the still-running pass is named and a late rejection is handled", async (t) => {
  const f = fixture(t, "pause");
  await f.startPass();
  await f.startPass();
  const stopped = f.clock.stop();
  f.wake("timeout");
  await settle();
  f.passes[0]!.resolve();
  await settle();
  await f.advance(BOUND_MS);
  assert.deepEqual(f.timeouts(), [{
    step: "daemon.review_clock.stop_bound_exceeded", phase: "pause", during_pause: true,
    bound_ms: BOUND_MS,
    active_passes: [{ pass: 2, trigger: "github-event", review_only: true,
      started_at_ms: 10_000, elapsed_ms: BOUND_MS }],
  }]);
  await stopped;
  f.passes[1]!.reject(new Error("late read failure"));
  await settle();
  assert.ok(f.rows.some((row) => row.step === "daemon.sweep_light.failed" && row.error === "late read failure"));
});

test("an empty review clock stops promptly without a timeout row", async (t) => {
  const f = fixture(t);
  const stopped = f.clock.stop();
  f.wake("timeout");
  assert.deepEqual(await stopped, { eventWakeSeen: false, passes: 0, held: 0 });
  await f.advance(BOUND_MS);
  assert.deepEqual(f.timeouts(), []);
});

test("the daemon writes its next tick while an interphase pass remains hung", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pass = deferred();
  const cadence = deferred();
  const rows: Array<Record<string, unknown>> = [];
  let waiter: ((result: "wake" | "timeout") => void) | undefined;
  let passStarted = false;
  let stopRequested = false;
  const daemon = runDaemon({ tasks: [], byId: new Map() }, {
    refreshMerged: () => () => false,
    runOne: async () => { throw new Error("an empty plan cannot dispatch"); },
    sleep: async () => {},
    sleepUntilSweepWake: () => new Promise((resolve) => { waiter = resolve; }),
    sweepLight: () => { passStarted = true; return pass.promise; },
    sweepOrphans: async () => { await cadence.promise; return { killed: [], leftAlone: [] }; },
    checkStop: () => stopRequested ? "test complete" : undefined,
    log: (step, extra) => {
      rows.push({ step, ...extra });
      if (step === "daemon.tick" && rows.filter((row) => row.step === step).length === 2) stopRequested = true;
    },
  }, { headroomEnabled: false, pollIntervalMs: 60_000 });
  t.after(async () => {
    stopRequested = true;
    pass.resolve();
    cadence.resolve();
    waiter?.("timeout");
    await daemon;
  });
  await settle();
  assert.ok(waiter, "the interphase clock starts beside the cadence");
  waiter("wake");
  await settle();
  assert.equal(passStarted, true);
  cadence.resolve();
  await settle();
  waiter("timeout");
  await settle();
  assert.equal(rows.filter((row) => row.step === "daemon.tick").length, 1);
  t.mock.timers.tick(BOUND_MS);
  await settle();
  assert.equal(rows.filter((row) => row.step === "daemon.tick").length, 2,
    "the real daemon must advance without resolving the hung review pass");
  const timedOutAt = rows.findIndex((row) => row.step === "daemon.review_clock.stop_bound_exceeded");
  assert.ok(timedOutAt >= 0);
  assert.ok(rows.findIndex((row, index) => index > timedOutAt && row.step === "daemon.tick") > timedOutAt);
});
