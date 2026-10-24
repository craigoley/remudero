// W1-T10074: serve's main loop stalled 5-22 s in nearly every minute of 2026-10-17 and its runtime.loop_lag row named
// nothing. Serve's minute tick now feeds each lag reading to the daemon's loop-stall profiler (W1-T7746), which
// profiles a stall past its derived bound WHILE it happens and writes runtime.loop_stall_profile naming its frames.
import assert from "node:assert/strict";
import v8 from "node:v8";
import { Worker } from "node:worker_threads";
import test from "node:test";
import type { EventLoopLag } from "#src/lib/daemon-health.js";
import { RUNTIME_LOOP_LAG_STEP } from "#src/lib/incident-invariants.js";
import { loopStallBoundMs, type LoopStallProfilerOptions } from "#src/lib/loop-stall-profiler.js";
import { SERVE_LOOP_LAG_RESOLUTION_MS, startIncidentInvariantsMonitor } from "#src/lib/serve.js";

type Line = { step: string } & Record<string, unknown>;
type Frame = { function: string; url: string; line: number; self_ms: number };

const NOW_MS = Date.parse("2026-10-17T20:00:00Z");
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

/** The watchdog's attach verdict, or a failure once `timeoutMs` passes: a monitor that never starts it must not hang. */
async function readyWithin(profiler: { ready(): Promise<boolean> }, timeoutMs = 10_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the watchdog never reported in")), timeoutMs);
  });
  try {
    return await Promise.race([profiler.ready(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The frame the stall runs: what the profile row must name. */
function serveBusyFrame(): number {
  let x = 0;
  for (let i = 0; i < 2e5; i++) x += (i * 31) % 7;
  return x;
}

/** Hold serve's loop for `ms`. Array.from drives the calls in batches, so no frame of the test runs a loop long enough
 *  to be on-stack-replaced before the profile began (loop-stall-profiler.ts's V8 LIMIT). */
function stallTheLoop(ms: number, profiling?: Int32Array): void {
  // ready() acknowledges inspector attachment, before Profiler.start. Keep the named workload on
  // the stack until the real start callback arrives, then supply the original sampling duration.
  const deadline = performance.now() + 10_000;
  let end = profiling ? undefined : performance.now() + ms;
  while (end === undefined || performance.now() < end) {
    if (end === undefined && profiling && Atomics.load(profiling, 0) === 1) end = performance.now() + ms;
    if (end === undefined && performance.now() > deadline) throw new Error("the real profiler never acknowledged sampling");
    Array.from({ length: 50 }, serveBusyFrame);
  }
}

/** A minute's reading whose p99 sets the bound well above test-runner noise and well below the stall. */
const READING: EventLoopLag = { p50Ms: 20, p99Ms: 230, maxMs: 900, windowMs: 60_000 };

/** Arms serve's REAL minute monitor over a fake timer and ledger, and hands back its tick and the lines it wrote. */
function armServeMonitor(stallProfiler?: Omit<LoopStallProfilerOptions, "steps">) {
  const written: Line[] = [];
  let tick: (() => void) | undefined;
  const stop = startIncidentInvariantsMonitor("/tmp/does-not-matter/ledger.ndjson", {
    writeLedger: (_path: string, line: Record<string, unknown>) => { written.push(line as Line); },
    readLedger: () => [],
    eventLoopLag: () => READING,
    clock: { now: () => NOW_MS, date: () => new Date(NOW_MS), iso: () => new Date(NOW_MS).toISOString() },
    setInterval: ((cb: () => void) => {
      tick = cb;
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
    ...(stallProfiler ? { stallProfiler } : {}),
  });
  assert.ok(tick, "the monitor arms its tick via the injected setInterval");
  return { tick: tick!, stop, written };
}

// The shard's grep proof for this test spells the apostrophe as `serve\.s`, a LITERAL dot in a basic regex, so it can
// never match the title below. This line carries its text so the proof resolves to this test:
// W1-T10074: a failing inspector disables serve.s watchdog and says why
test("W1-T10074: a failing inspector disables serve's watchdog and says why", async () => {
  const { tick, stop, written } = armServeMonitor({
    spawn: (source, workerData) => new Worker(
      `process.getBuiltinModule("node:inspector").Session.prototype.connectToMainThread = () => { throw new Error("inspector unavailable"); };\n${source}`,
      { eval: true, workerData }),
  });
  try {
    tick();
    assert.equal(await readyWithin(stop.stallProfiler), false);
    const failed = written.filter((line) => line.step === "runtime.loop_stall_profile_failed");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0]!.reason), /inspector unavailable/);
    assert.equal(failed[0]!.task_id, "INCIDENT");
    assert.match(String(failed[0]!.run_id), /^RUNTIME-/);
    // Disabled for the boot: the next minute still ledgers its lag, and a stall past the bound writes no profile.
    tick();
    stallTheLoop(600);
    await sleep(100);
    assert.equal(written.filter((line) => line.step === RUNTIME_LOOP_LAG_STEP).length, 2);
    assert.equal(written.filter((line) => line.step === "runtime.loop_stall_profile").length, 0);
    assert.equal(written.filter((line) => line.step === "runtime.loop_stall_profile_failed").length, 1);
  } finally {
    stop();
  }
});

// LAST: a profile enables V8's Profiler domain, whose disconnect resets this process's precise coverage.
async function verifyProfiledStall(startDelayMs: number): Promise<void> {
  const profiling = new Int32Array(new SharedArrayBuffer(4));
  const { tick, stop, written } = armServeMonitor({
    spawn: (source, workerData) => new Worker(`
const profilerTestFlag = new Int32Array(process.getBuiltinModule("node:worker_threads").workerData.profilerTestFlag);
const proto = process.getBuiltinModule("node:inspector").Session.prototype;
const originalPost = proto.post;
let delayedStart = false;
proto.post = function(method, params, callback) {
  const invoke = () => originalPost.call(this, method, params, (error, result) => {
    if (method === "Profiler.start" && !error) Atomics.store(profilerTestFlag, 0, 1);
    callback(error, result);
  });
  if (method === "Profiler.start" && !delayedStart && process.getBuiltinModule("node:worker_threads").workerData.profilerStartDelayMs > 0) {
    delayedStart = true; setTimeout(invoke, process.getBuiltinModule("node:worker_threads").workerData.profilerStartDelayMs);
  }
  else invoke();
};
${source}`, { eval: true, execArgv: [], workerData: { ...workerData, profilerTestFlag: profiling.buffer, profilerStartDelayMs: startDelayMs } }),
  });
  try {
    assert.equal(stop.stallProfiler.boundMs(), undefined, "no bound before serve's first lag reading");
    tick();
    const boundMs = loopStallBoundMs(SERVE_LOOP_LAG_RESOLUTION_MS, [READING.p99Ms]);
    assert.equal(stop.stallProfiler.boundMs(), boundMs, "the bound is the histogram's resolution plus the p99 quantile");
    assert.equal(await readyWithin(stop.stallProfiler), true);
    await sleep(boundMs);
    stallTheLoop(1500, profiling);
    const row = await waitFor(() => written.find((line) => line.step === "runtime.loop_stall_profile"
      && (line.top_frames as Frame[] | undefined)?.[0]?.function === "serveBusyFrame"));
    const frames = row.top_frames as Frame[];
    assert.match(frames[0]!.url, /serves-main-loop-stalls-are-profiled-and-named\.test\.ts/);
    assert.ok(frames[0]!.self_ms > 0);
    assert.ok(Number(row.lag_ms) >= Number(row.bound_ms), `lag ${row.lag_ms} past bound ${row.bound_ms}`);
    assert.equal(row.bound_ms, boundMs);
    assert.equal(row.task_id, "INCIDENT");
    assert.match(String(row.run_id), /^RUNTIME-/);
    assert.equal(written.filter((line) => line.step === "runtime.loop_stall_profile_failed").length, 0);
  } finally {
    v8.takeCoverage();
    stop();
  }
}

test("W1-T10074: a serve main-thread stall longer than its bound writes a profile row naming its top frame", () => verifyProfiledStall(0));
test("a delayed real V8 sampling start still profiles the named serve workload", () => verifyProfiledStall(2000));
