import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";

function fixturePlan(): Plan {
  const root = mkdtempSync(join(tmpdir(), "rmd-t2852-plan-"));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, `
- id: W1-T2852-HOLD
  title: no dispatch in this clock fixture
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`);
  return loadPlan(path);
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function eventually(predicate: () => boolean, message: string, turns = 100): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(message);
}

class WakeClock {
  private pending = false;
  private waiter: ((result: "wake" | "timeout") => void) | undefined;

  readonly sleep: NonNullable<DaemonDeps["sleepUntilSweepWake"]> = () => {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve("wake");
    }
    assert.equal(this.waiter, undefined, "the review clock must own at most one interruptible wait");
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  };

  get waiting(): boolean {
    return this.waiter !== undefined;
  }

  wake(): void {
    const waiter = this.waiter;
    if (!waiter) {
      this.pending = true;
      return;
    }
    this.waiter = undefined;
    waiter("wake");
  }

  timeout(): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = undefined;
    waiter("timeout");
  }

  releaseAll(): void {
    this.pending = false;
    this.timeout();
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function baseDeps(clock: WakeClock, overrides: Partial<DaemonDeps> = {}): DaemonDeps {
  return {
    refreshMerged: () => () => false,
    runOne: async (taskId) => ({ taskId, runId: `${taskId}-run`, merged: true, costUsd: 0, verdict: "merged" }),
    sleep: async () => {},
    sleepUntilSweepWake: clock.sleep,
    ...overrides,
  };
}

test("a GitHub wake starts a restricted review pass while measurement is still unresolved", async () => {
  const clock = new WakeClock();
  const measurement = deferred<never>();
  let measurementStarted = false;
  let stopped = false;
  let lightPasses = 0;
  let daemon: Promise<unknown> | undefined;
  try {
    daemon = runDaemon(
      fixturePlan(),
      baseDeps(clock, {
        checkStop: () => (stopped ? "fixture complete" : undefined),
        checkMeasurementCadence: () => ({ fire: true, reason: "fixture" }),
        runMeasurementCadence: () => {
          measurementStarted = true;
          return measurement.promise;
        },
        sweepLight: async () => {
          lightPasses++;
        },
      }),
    );

    await eventually(() => measurementStarted && clock.waiting, "measurement started without an inter-phase review wait");
    clock.wake();
    await eventually(() => lightPasses === 1, "the event wake did not start the restricted pass");
    assert.equal(measurementStarted, true, "precondition: measurement remains the phase holding the main loop");
  } finally {
    stopped = true;
    measurement.resolve({} as never);
    await eventually(() => clock.waiting || daemon === undefined, "the clock did not return to its bounded wait after the pass");
    clock.timeout();
    await daemon;
    clock.releaseAll();
  }
});

test("the same review clock remains live while board review is unresolved", async () => {
  const clock = new WakeClock();
  const board = deferred<never>();
  let boardStarted = false;
  let stopped = false;
  let lightPasses = 0;
  let daemon: Promise<unknown> | undefined;
  try {
    daemon = runDaemon(
      fixturePlan(),
      baseDeps(clock, {
        checkStop: () => (stopped ? "fixture complete" : undefined),
        checkBoardReview: () => ({ fire: true, reason: "fixture" }),
        runBoardReview: () => {
          boardStarted = true;
          return board.promise;
        },
        sweepLight: async () => {
          lightPasses++;
        },
      }),
    );

    await eventually(() => boardStarted && clock.waiting, "board review started without an inter-phase review wait");
    clock.wake();
    await eventually(() => lightPasses === 1, "the board-review wake did not start the restricted pass");
  } finally {
    stopped = true;
    board.resolve({} as never);
    await eventually(() => clock.waiting || daemon === undefined, "the clock did not return to its bounded wait after board review");
    clock.timeout();
    await daemon;
    clock.releaseAll();
  }
});

test("wakes during an active pass coalesce to one non-overlapping follow-up", async () => {
  const clock = new WakeClock();
  const measurement = deferred<never>();
  const firstPass = deferred<void>();
  let measurementStarted = false;
  let stopped = false;
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let daemon: Promise<unknown> | undefined;
  try {
    daemon = runDaemon(
      fixturePlan(),
      baseDeps(clock, {
        checkStop: () => (stopped ? "fixture complete" : undefined),
        checkMeasurementCadence: () => ({ fire: true, reason: "fixture" }),
        runMeasurementCadence: () => {
          measurementStarted = true;
          return measurement.promise;
        },
        sweepLight: async () => {
          calls++;
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            if (calls === 1) await firstPass.promise;
          } finally {
            inFlight--;
          }
        },
      }),
    );

    await eventually(() => measurementStarted && clock.waiting, "the review clock never started waiting");
    clock.wake();
    await eventually(() => calls === 1 && inFlight === 1, "the first light pass did not start");
    clock.wake();
    clock.wake();
    firstPass.resolve();
    await eventually(() => calls === 2, "a wake during the first pass did not schedule one follow-up");
    await settle();
    assert.equal(calls, 2, "multiple wakes during one pass coalesce rather than creating a hot loop");
    assert.equal(maxInFlight, 1, "two restricted passes must never overlap");
  } finally {
    stopped = true;
    firstPass.resolve();
    measurement.resolve({} as never);
    await eventually(() => clock.waiting || daemon === undefined, "the clock did not reach its stoppable wait");
    clock.timeout();
    await daemon;
    clock.releaseAll();
  }
});

for (const control of ["STOP", "PAUSE"] as const) {
  test(`${control} prevents new inter-phase review admission while a pending wake survives`, async () => {
    const clock = new WakeClock();
    const measurement = deferred<never>();
    let measurementStarted = false;
    let held = true;
    let stopped = false;
    let lightPasses = 0;
    let daemon: Promise<unknown> | undefined;
    try {
      daemon = runDaemon(
        fixturePlan(),
        baseDeps(clock, {
          checkStop: () =>
            stopped ? "fixture complete" : control === "STOP" && held && measurementStarted ? "held" : undefined,
          checkPause: () => (control === "PAUSE" && held && measurementStarted ? "held" : undefined),
          checkMeasurementCadence: () => ({ fire: true, reason: "fixture" }),
          runMeasurementCadence: () => {
            measurementStarted = true;
            return measurement.promise;
          },
          sweepLight: async () => {
            lightPasses++;
          },
        }),
      );

      await eventually(() => measurementStarted && clock.waiting, "the held phase never started its review clock");
      clock.wake();
      await eventually(() => clock.waiting, "the held wake was not retained for a later clock tick");
      assert.equal(lightPasses, 0, `${control} must be rechecked immediately before review admission`);
      held = false;
      clock.timeout();
      await eventually(() => lightPasses === 1, `the pending ${control} wake was lost after the hold cleared`);
    } finally {
      held = false;
      stopped = true;
      measurement.resolve({} as never);
      await eventually(() => clock.waiting || daemon === undefined, "the clock did not reach its stoppable wait");
      clock.timeout();
      await daemon;
      clock.releaseAll();
    }
  });
}
