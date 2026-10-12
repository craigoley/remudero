// W1-T7746: an unattributed loop stall is profiled WHILE it happens. A watchdog worker profiles the blocked
// main thread past a bound derived from the daemon's own interval and lag history, and the ledger row names
// the stall's top self-time frames beside the interval's sync-spawn time.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import v8 from "node:v8";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { reportTickLag } from "../src/lib/daemon.js";
import { loopStallBoundMs, startLoopStallProfiler, topSelfFrames, type CpuProfile } from "../src/lib/loop-stall-profiler.js";
import { startReadPlaneTelemetry } from "../src/lib/read-plane.js";

type Row = { step: string } & Record<string, unknown>;
type Frame = { function: string; url: string; line: number; self_ms: number };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(10);
  }
}

/** The busy function under test: the CPU a spin burns, entered over and over as a scanner's inner step is. */
function busyLoopPastTheBound(): number {
  let x = 0;
  for (let i = 0; i < 2e5; i++) x += (i * 31) % 7;
  return x;
}

/** Hold the main thread for `ms` with the busy function; nothing else on the loop runs until it returns.
 *  Array.from drives the calls in batches, so no frame of the test runs a loop long enough to be replaced on the
 *  stack: V8 credits a frame on-stack-replaced BEFORE the profile began to its caller (loop-stall-profiler.ts). */
function stallTheLoop(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) Array.from({ length: 50 }, busyLoopPastTheBound);
}

const INTERVAL_MS = 250;

/** A profile enables V8's Profiler domain, and that session's disconnect resets precise coverage for the whole
 *  process. Write what this process has measured first, so a coverage run keeps it (a no-op outside one). */
function stopProfiled(telemetry: ReturnType<typeof startReadPlaneTelemetry>): void {
  v8.takeCoverage();
  telemetry.stop();
}

test("W1-T7746: the profile bound follows the interval and the observed lag history", () => {
  const quiet = Array.from({ length: 100 }, () => 5);
  const noisy = Array.from({ length: 100 }, (_, i) => i * 100);
  assert.equal(loopStallBoundMs(1000, quiet), 1005);
  assert.equal(loopStallBoundMs(1000, noisy), 1000 + 8900);
  assert.equal(loopStallBoundMs(2000, quiet), 2005);
  assert.equal(loopStallBoundMs(1000, []), 1000);

  // The live profiler: no bound before the daemon reports a tick, then one that moves with what it reports.
  const quietProfiler = startLoopStallProfiler();
  const noisyProfiler = startLoopStallProfiler();
  const log = () => {};
  try {
    assert.equal(quietProfiler.boundMs(), undefined);
    for (const lagMs of quiet) quietProfiler.observe({ lagMs, intervalMs: 1000 }, log);
    for (const lagMs of noisy) noisyProfiler.observe({ lagMs, intervalMs: 1000 }, log);
    assert.equal(quietProfiler.boundMs(), 1005);
    assert.equal(noisyProfiler.boundMs(), 9900);
    quietProfiler.observe({ lagMs: 5, intervalMs: 3000 }, log);
    assert.equal(quietProfiler.boundMs(), 3005);
  } finally {
    quietProfiler.stop();
    noisyProfiler.stop();
  }
});

test("W1-T7746: an inspector failure writes loop_stall_profile_failed and the loop keeps running", async () => {
  const rows: Row[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); };
  const telemetry = startReadPlaneTelemetry({ stallProfiler: {
    spawn: (source, workerData) => new Worker(
      `process.getBuiltinModule("node:inspector").Session.prototype.connectToMainThread = () => { throw new Error("inspector unavailable"); };\n${source}`,
      { eval: true, workerData }),
  } });
  let fired = 0;
  const timer = setInterval(() => { fired++; }, 5);
  try {
    telemetry.sample.observeLoopLag({ lagMs: 1, intervalMs: INTERVAL_MS }, log);
    assert.equal(await telemetry.stallProfiler.ready(), false);
    const failed = rows.filter((r) => r.step === "daemon.loop_stall_profile_failed");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0]!.reason), /inspector unavailable/);
    const before = fired;
    await sleep(60);
    assert.ok(fired > before, "the loop's own timer keeps firing after the failure");
    // Disabled for the boot: a later tick starts no watchdog, and a stall past the bound writes no profile.
    telemetry.sample.observeLoopLag({ lagMs: 1, intervalMs: INTERVAL_MS }, log);
    stallTheLoop(300);
    await sleep(100);
    assert.equal(rows.filter((r) => r.step === "daemon.loop_stall_profile").length, 0);
    assert.equal(rows.filter((r) => r.step === "daemon.loop_stall_profile_failed").length, 1);
  } finally {
    clearInterval(timer);
    telemetry.stop();
  }
});

test("W1-T7746: a failing watchdog start, heartbeat, exit or logger disables the profiler, never the loop", async () => {
  const failedReason = async (options: Parameters<typeof startLoopStallProfiler>[0]) => {
    const rows: Row[] = [];
    const profiler = startLoopStallProfiler(options);
    try {
      profiler.observe({ lagMs: 1, intervalMs: INTERVAL_MS }, (step, extra) => rows.push({ step, ...extra }));
      const failed = await waitFor(() => rows.find((r) => r.step === "daemon.loop_stall_profile_failed"));
      return String(failed.reason);
    } finally {
      profiler.stop();
    }
  };
  assert.match(await failedReason({ spawn: () => { throw new Error("no threads"); } }), /^watchdog start: no threads/);
  assert.match(await failedReason({ takeSyncSpawnMs: () => { throw new Error("window gone"); } }), /^heartbeat: window gone/);
  assert.match(await failedReason({ spawn: (_source, workerData) => new Worker("process.exit(3)", { eval: true, workerData }) }),
    /^watchdog exited: 3/);
  assert.match(await failedReason({ spawn: (_source, workerData) => new Worker("throw new Error('boom')", { eval: true, workerData }) }),
    /^watchdog error: boom/);
  // A logger that throws loses the failure row, and nothing else: the call returns and the profiler is off.
  const unlogged = startLoopStallProfiler({ spawn: () => { throw new Error("no threads"); } });
  unlogged.observe({ lagMs: 1, intervalMs: INTERVAL_MS }, () => { throw new Error("ledger full"); });
  assert.equal(await unlogged.ready(), false);
  unlogged.stop();

});

test("W1-T7746: top self-time frames skip V8 bookkeeping nodes and order by self time", () => {
  const profile: CpuProfile = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 } },
      { id: 2, callFrame: { functionName: "scan", url: "file:///a.js", lineNumber: 9 } },
      { id: 3, callFrame: { functionName: "", url: "file:///b.js", lineNumber: 0 } },
      { id: 4, callFrame: { functionName: "(idle)", url: "", lineNumber: -1 } },
      { id: 5, callFrame: { functionName: "now", url: "", lineNumber: -1 } },
    ],
    startTime: 0,
    endTime: 10_000,
    samples: [2, 2, 3, 4, 2, 5, 99],
    timeDeltas: [0, 1000, 1000, 1000, 1000, 1000, 1000],
  };
  assert.deepEqual(topSelfFrames([profile, { ...profile, samples: undefined, timeDeltas: undefined }], 3), [
    { function: "scan", url: "file:///a.js", line: 10, self_ms: 3 },
    { function: "(anonymous)", url: "file:///b.js", line: 1, self_ms: 1 },
    { function: "now", url: "", line: 0, self_ms: 1 },
  ]);
});

test("W1-T7746: the daemon hands each tick's lag to the profiler and still reports the loop lag", () => {
  const rows: Row[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); };
  const observed: { lagMs: number; intervalMs: number }[] = [];
  const sample = { phase: "pulse", dueAtMs: 1000, observedAtMs: 3500, intervalMs: 1000 };
  const telemetry = Object.assign(() => ({ loop_delay_max_ms: 0, loop_delay_p99_ms: 0, sync_spawn_ms: 0 }),
    { observeLoopLag: (reading: { lagMs: number; intervalMs: number }) => { observed.push(reading); } });
  reportTickLag({ readLoopTelemetry: telemetry }, sample, log);
  assert.deepEqual(observed, [{ lagMs: 2500, intervalMs: 1000 }]);
  assert.equal(rows.find((r) => r.step === "daemon.loop_lag")?.lag_ms, 2500);

  rows.length = 0;
  const throwing = Object.assign(() => ({ loop_delay_max_ms: 0, loop_delay_p99_ms: 0, sync_spawn_ms: 0 }),
    { observeLoopLag: () => { throw new Error("profiler gone"); } });
  reportTickLag({ readLoopTelemetry: throwing }, sample, log);
  assert.match(String(rows.find((r) => r.step === "daemon.loop_stall_profile_failed")?.reason), /^observe: profiler gone/);
  assert.equal(rows.find((r) => r.step === "daemon.loop_lag")?.lag_ms, 2500);
});

test("W1-T7746: an armed watchdog does not hold the daemon process open", () => {
  const module = new URL("../src/lib/read-plane.ts", import.meta.url).href;
  const script = `const { startReadPlaneTelemetry } = await import(${JSON.stringify(module)});
const telemetry = startReadPlaneTelemetry();
telemetry.sample.observeLoopLag({ lagMs: 1, intervalMs: 1000 }, (step, extra) => console.log(step, JSON.stringify(extra)));
const hold = setTimeout(() => {}, 20_000); // held only until the watchdog reports in
telemetry.stallProfiler.ready().then((attached) => {
  clearTimeout(hold);
  if (!attached) console.log("watchdog not attached");
  setTimeout(() => console.log("exiting"), 300);
});`;
  const out = childProcess.execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 30_000 });
  assert.equal(out.trim(), "exiting");
});

// THE PROFILING TESTS COME LAST. Each enables V8's Profiler domain, whose session resets this process's precise
// coverage when it disconnects (stopProfiled snapshots it first), so a test placed after one reads uncovered.

test("W1-T7746: a logger that throws on the profile row disables the watchdog, never the loop", async () => {
  // The row is lost and the watchdog disabled; the stall itself already ended, so the loop runs on.
  const thrown: string[] = [];
  const telemetry = startReadPlaneTelemetry();
  try {
    telemetry.sample.observeLoopLag({ lagMs: 1, intervalMs: INTERVAL_MS }, (step) => { thrown.push(step); throw new Error("ledger full"); });
    assert.equal(await telemetry.stallProfiler.ready(), true);
    await sleep(INTERVAL_MS);
    stallTheLoop(400);
    await waitFor(() => (thrown.includes("daemon.loop_stall_profile_failed") ? true : undefined));
    assert.deepEqual(thrown, ["daemon.loop_stall_profile", "daemon.loop_stall_profile_failed"]);
  } finally {
    stopProfiled(telemetry);
  }
});

test("W1-T7746: a main-thread busy loop past the bound is profiled and its function is the top frame in the ledger row", async () => {
  const rows: Row[] = [];
  const telemetry = startReadPlaneTelemetry();
  try {
    telemetry.sample.observeLoopLag({ lagMs: 1, intervalMs: INTERVAL_MS }, (step, extra) => rows.push({ step, ...extra }));
    assert.equal(await telemetry.stallProfiler.ready(), true);
    await sleep(INTERVAL_MS);
    stallTheLoop(1500);
    const row = await waitFor(() => rows.find((r) => r.step === "daemon.loop_stall_profile"));
    const frames = row.top_frames as Frame[];
    assert.equal(frames[0]?.function, "busyLoopPastTheBound");
    assert.match(frames[0]!.url, /an-unattributed-loop-stall-is-profiled-live\.test\.ts/);
    assert.ok(frames[0]!.self_ms > 0);
    assert.ok(Number(row.lag_ms) >= Number(row.bound_ms), `lag ${row.lag_ms} past bound ${row.bound_ms}`);
    assert.equal(rows.filter((r) => r.step === "daemon.loop_stall_profile_failed").length, 0);
  } finally {
    stopProfiled(telemetry);
  }
});

test("W1-T7746: the profile row carries sync_spawn_ms and the unattributed remainder", async () => {
  const rows: Row[] = [];
  const telemetry = startReadPlaneTelemetry();
  try {
    telemetry.sample.observeLoopLag({ lagMs: 1, intervalMs: INTERVAL_MS }, (step, extra) => rows.push({ step, ...extra }));
    assert.equal(await telemetry.stallProfiler.ready(), true);
    await sleep(INTERVAL_MS);
    childProcess.execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 400)"]);
    stallTheLoop(1500);
    const row = await waitFor(() => rows.find((r) => r.step === "daemon.loop_stall_profile"));
    const lagMs = Number(row.lag_ms);
    const syncSpawnMs = Number(row.sync_spawn_ms);
    assert.ok(syncSpawnMs >= 400, `sync_spawn_ms ${syncSpawnMs}`);
    assert.equal(row.unattributed_ms, lagMs - syncSpawnMs);
    assert.ok(Number(row.unattributed_ms) >= 300, `unattributed_ms ${row.unattributed_ms}`);
    assert.equal((row.top_frames as Frame[])[0]?.function, "busyLoopPastTheBound");
  } finally {
    stopProfiled(telemetry);
  }
});
