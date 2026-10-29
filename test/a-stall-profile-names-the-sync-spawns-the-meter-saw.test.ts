import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { foldStallChunk, startLoopStallProfiler } from "#src/lib/loop-stall-profiler.js";
import { startReadPlaneTelemetry, type LagIntervalReading } from "#src/lib/read-plane.js";

function watchdog() {
  const worker = Object.assign(new EventEmitter(), { unref() {}, terminate: async () => 0 });
  const spawn = () => worker as unknown as Worker;
  const profile = (beat: number) => worker.emit("message", {
    kind: "profile", beat, silent_ms: 45_000, unprofiled_ms: 35_000,
    fold: foldStallChunk(undefined, { nodes: [], startTime: 0, endTime: 5_000_000 }, []),
  });
  return { spawn, profile };
}

const empty: LagIntervalReading = { top: undefined, sync_spawn_ms: 0 };
const closing: LagIntervalReading = {
  sync_spawn_ms: 30_000,
  top: { via: "spawnSync", command: "git", first_arg: "fetch", duration_ms: 28_000,
    caller: "refreshPlan", leaf: "hostWorktreeGit" },
  by_caller: [
    { caller: "refreshPlan", leaf: "hostWorktreeGit", total_ms: 28_000, calls: 2 },
    { caller: "anonymous", caller_chain: ["anonymous", "drain"], total_ms: 1500, calls: 1 },
  ],
  unnamed_ms: 500,
};

test("W1-T9712: a stall row carries the meter by-caller spawn time of its closing beat", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = watchdog();
  const rows: Record<string, unknown>[] = [];
  let calls = 0;
  const read = () => [empty, closing, empty][calls++] ?? empty;
  const options = { spawn: fake.spawn, takeSyncSpawn: read, takeSyncSpawnMs: () => read().sync_spawn_ms };
  const profiler = startLoopStallProfiler(options);
  try {
    profiler.observe({ lagMs: 0, intervalMs: 40 }, (step, extra) => rows.push({ step, ...extra }));
    for (let i = 0; i < 3; i++) t.mock.timers.tick(10);
    assert.equal(calls, 3);
    fake.profile(1);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.step, "daemon.loop_stall_profile");
    assert.equal(row.sync_spawn_ms, 30_000);
    assert.deepEqual(row.sync_spawn_top, closing.top);
    assert.deepEqual(row.sync_spawn_by_caller, closing.by_caller);
    assert.equal(row.sync_spawn_unnamed_ms, 500);
    assert.equal(row.profiled_ms, 5000);
    assert.equal(row.unprofiled_ms, 35_000);
    assert.deepEqual(row.sync_spawn_callers, []);
    assert.equal(row.bound_ms, 40);
    assert.equal(row.unattributed_ms, Math.max(0, Number(row.lag_ms) - 30_000));
  } finally {
    profiler.stop();
  }
});

test("W1-T9712: a stall with no sync spawn writes no by-caller fields", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = watchdog();
  const rows: Record<string, unknown>[] = [];
  let readings = 0;
  const options = { spawn: fake.spawn, takeSyncSpawn: () => { readings++; return empty; } };
  const profiler = startLoopStallProfiler(options);
  try {
    profiler.observe({ lagMs: 0, intervalMs: 40 }, (_step, extra) => rows.push(extra!));
    t.mock.timers.tick(10);
    fake.profile(0);
    assert.equal(readings, 1, "the heartbeat consumes the full empty meter reading");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sync_spawn_ms, 0);
    for (const field of ["sync_spawn_top", "sync_spawn_by_caller", "sync_spawn_unnamed_ms"]) {
      assert.equal(Object.hasOwn(rows[0]!, field), false);
    }
  } finally {
    profiler.stop();
  }
});

test("W1-T9712: read-plane forwards the real meter reading to the stall row", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = watchdog();
  const rows: Record<string, unknown>[] = [];
  let now = 0;
  const telemetry = startReadPlaneTelemetry({
    clock: clockFromMillisFn(() => { now += 30_000; return now; }),
    stallProfiler: { spawn: fake.spawn },
  });
  try {
    telemetry.sample.observeLoopLag({ lagMs: 0, intervalMs: 40 }, (_step, extra) => rows.push(extra!));
    t.mock.timers.tick(10);
    childProcess.execFileSync(process.execPath, ["-e", ""]);
    const expected = telemetry.sample.takeLagInterval("independent-consumer");
    t.mock.timers.tick(10);
    fake.profile(1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sync_spawn_ms, 30_000);
    assert.ok(expected.top?.caller);
    assert.ok(expected.by_caller?.length);
    assert.deepEqual(rows[0]!.sync_spawn_top, expected.top);
    assert.deepEqual(rows[0]!.sync_spawn_by_caller, expected.by_caller);
    assert.equal(rows[0]!.sync_spawn_unnamed_ms, expected.unnamed_ms);
  } finally {
    telemetry.stop();
  }
});

test("W1-T9712: a missing reading or numeric-only meter emits totals without caller fields", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const meter of [{}, { takeSyncSpawnMs: () => 1234 }]) {
    const fake = watchdog();
    const rows: Record<string, unknown>[] = [];
    const profiler = startLoopStallProfiler({ spawn: fake.spawn, ...meter });
    try {
      profiler.observe({ lagMs: 0, intervalMs: 40 }, (_step, extra) => rows.push(extra!));
      t.mock.timers.tick(10);
      fake.profile(0);
      fake.profile(100);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.sync_spawn_ms, meter.takeSyncSpawnMs?.() ?? 0);
      assert.equal(rows[1]!.sync_spawn_ms, 0);
      for (const row of rows) {
        for (const field of ["sync_spawn_top", "sync_spawn_by_caller", "sync_spawn_unnamed_ms"]) {
          assert.equal(Object.hasOwn(row, field), false);
        }
      }
    } finally {
      profiler.stop();
    }
  }
});
