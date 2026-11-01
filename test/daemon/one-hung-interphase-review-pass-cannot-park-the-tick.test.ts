import assert from "node:assert/strict";
import { test } from "node:test";
import { startInterphaseReviewClock, type DaemonDeps } from "#src/lib/daemon.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function clockHarness(pass: Promise<void>, waitGate: Promise<void>, onPassStart: () => void) {
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let waits = 0;
  const clock = startInterphaseReviewClock({
    now: () => new Date(),
    sleepUntilSweepWake: async () => {
      if (waits++ === 0) return "wake";
      await waitGate;
      return "timeout";
    },
    sweepLight: async () => { onPassStart(); await pass; },
  } as unknown as DaemonDeps, 60_000, (step, extra) => events.push({ step, extra }));
  return { clock, events, waiting: () => waits >= 2 };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("review clock did not enter its next wait");
}

test("W1-T11071: stop bounds a hung review pass and names its age", async () => {
  const pass = deferred<void>();
  const runnerWait = deferred<void>();
  const started = deferred<void>();
  const harness = clockHarness(pass.promise, runnerWait.promise, () => started.resolve());
  await started.promise;
  await until(harness.waiting);

  const began = Date.now();
  const stopping = harness.clock.stop();
  runnerWait.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    stopping.then(() => "stopped" as const),
    new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 1_500); }),
  ]);
  clearTimeout(timer);
  const elapsedMs = Date.now() - began;
  if (outcome === "timeout") {
    pass.resolve();
    await stopping;
  }
  assert.equal(outcome, "stopped", "stop must return within the one-second bound");
  assert.ok(elapsedMs < 1_500, `stop took ${elapsedMs}ms beyond its one-second bound`);
  const stopped = await stopping;
  assert.deepEqual(stopped, { eventWakeSeen: true, passes: 1, held: 0 });
  const abandoned = harness.events.filter((row) => row.step === "daemon.review_clock.pass_left_running");
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0]?.extra?.pass_number, 1);
  assert.equal(abandoned[0]?.extra?.bound_ms, 1_000);
  assert.equal(abandoned[0]?.extra?.reason, "review pass exceeded the stop bound");
  assert.ok(Number(abandoned[0]?.extra?.elapsed_ms) >= 900);
  pass.resolve();
});

test("W1-T11071: stop still awaits a pass that settles inside the bound", async () => {
  const pass = deferred<void>();
  const runnerWait = deferred<void>();
  const started = deferred<void>();
  const harness = clockHarness(pass.promise, runnerWait.promise, () => started.resolve());
  await started.promise;
  await until(harness.waiting);

  const stopping = harness.clock.stop();
  runnerWait.resolve();
  setTimeout(() => pass.resolve(), 10);
  const stopped = await stopping;

  assert.deepEqual(stopped, { eventWakeSeen: true, passes: 1, held: 0 });
  assert.equal(harness.events.some((row) => row.step === "daemon.review_clock.pass_left_running"), false);
});
