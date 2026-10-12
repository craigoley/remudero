/**
 * lib/loop-stall-profiler.ts — W1-T7746: PROFILE AN UNATTRIBUTED LOOP STALL WHILE IT IS HAPPENING.
 *
 * MEASURED 2026-10-10, core daemon, 07:50-09:57Z: 10 `daemon.loop_lag` stalls totalling about 5,990 s.
 * About 53 min of that had no sync spawn to blame. A CPU spin looks the same from outside, and a sampler
 * on the blocked loop records nothing until the block clears ({@link reportLoopLag}'s own doc comment).
 * The 2026-10-08 TS scanner spin (#10176) was found only by a hand-run CPU profile.
 *
 * THE WATCHDOG lives in a worker thread, so it keeps running while the main loop does not. The main loop
 * bumps a shared heartbeat counter each turn. When the counter has been still past the bound, the worker
 * opens `inspector.Session.connectToMainThread()` and starts V8's sampling profiler. The inspector reaches
 * a busy main thread through an interrupt, so the profile samples the stall itself. Profiling stops when
 * the heartbeat moves again. At most one profile runs at a time.
 *
 * THE BOUND IS DERIVED, NOT PICKED ({@link loopStallBoundMs}): the daemon's own interval plus a quantile of
 * the lags it has observed in this process, so ordinary lag is not profiled. Until the daemon reports its
 * first tick there is no interval, so no bound, and the watchdog is not started.
 *
 * MEMORY STAYS BOUNDED: a stall that never ends is profiled in chunks one bound long, and only the newest
 * two are kept. No profile is written to disk; the ledger row carries the top self-time frames only.
 *
 * IT CANNOT TAKE DOWN THE LOOP IT WATCHES: any inspector or watchdog failure writes
 * `daemon.loop_stall_profile_failed` with its reason and disables the watchdog for the rest of the boot.
 *
 * A V8 LIMIT, STATED RATHER THAN HIDDEN: one long-running optimized frame that was ALREADY running when the
 * profile started can have its samples credited to its caller. A spin that keeps calling functions is
 * named correctly. That is the scanner shape #10176 had.
 */

import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";

export type StallLog = (step: string, extra?: Record<string, unknown>) => void;

/** One tick's lateness as the daemon measured it: the input the bound is a quantile of. */
export interface LoopLagReading {
  lagMs: number;
  intervalMs: number;
}

/** The share of observed lags that counts as ordinary. A stall must outlast this quantile of them. */
export const LOOP_STALL_LAG_QUANTILE = 0.9;
/** How many recent lags the quantile is taken over. The oldest drops out first. */
export const LOOP_STALL_LAG_HISTORY = 128;
/** How many self-time frames a `daemon.loop_stall_profile` row names. */
export const LOOP_STALL_TOP_FRAMES = 5;
/** Heartbeats per daemon interval. The watchdog sees a still loop within a quarter interval of the bound. */
export const LOOP_STALL_HEARTBEATS_PER_INTERVAL = 4;
/** Samples one profile chunk aims at, so a long bound samples more coarsely and a chunk stays one size. */
export const LOOP_STALL_SAMPLES_PER_CHUNK = 10_000;
/** V8's default sampling interval. The profiler never samples finer than this. */
const MIN_SAMPLING_INTERVAL_US = 1000;
/** How many heartbeats the main thread remembers, to find the one that closed a profiled stall. */
const BEATS_KEPT = 64;

/** Slots of the shared heartbeat buffer. */
const BEAT = 0;
const BOUND = 1;
const PERIOD = 2;
const SAMPLING_US = 3;

/** THE BOUND: the daemon's interval plus the {@link LOOP_STALL_LAG_QUANTILE} quantile of the observed lags. */
export function loopStallBoundMs(intervalMs: number, lagsMs: readonly number[]): number {
  const sorted = lagsMs.map((lag) => Math.max(0, lag)).sort((a, b) => a - b);
  const rank = Math.ceil(LOOP_STALL_LAG_QUANTILE * sorted.length) - 1;
  const ordinaryLagMs = sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, rank))]!;
  return Math.round(intervalMs + ordinaryLagMs);
}

/** One frame of a stall profile row, ordered by self time. `line` is 1-based; 0 means no source line. */
export interface StallFrame {
  function: string;
  url: string;
  line: number;
  self_ms: number;
}

/** The parts of a V8 `Profiler.Profile` this reads. */
export interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** V8's bookkeeping nodes: none is code the loop was running. */
const NOT_A_FRAME: ReadonlySet<string> = new Set(["(root)", "(idle)", "(program)"]);

/** The top self-time frames over a stall's profile chunks. A sample lasts until the next one, or the chunk's end. */
export function topSelfFrames(profiles: readonly CpuProfile[], n = LOOP_STALL_TOP_FRAMES): StallFrame[] {
  const frames = new Map<string, StallFrame>();
  for (const profile of profiles) {
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    let at = profile.startTime;
    for (let i = 0; i < samples.length; i++) {
      at += deltas[i] ?? 0;
      const next = i + 1 < samples.length ? at + (deltas[i + 1] ?? 0) : profile.endTime;
      const node = byId.get(samples[i]!);
      if (!node || NOT_A_FRAME.has(node.callFrame.functionName)) continue;
      const { functionName, url, lineNumber } = node.callFrame;
      const key = `${functionName}\u0000${url}\u0000${lineNumber}`;
      const frame = frames.get(key) ?? { function: functionName || "(anonymous)", url,
        line: lineNumber < 0 ? 0 : lineNumber + 1, self_ms: 0 };
      frame.self_ms += Math.max(0, next - at) / 1000;
      frames.set(key, frame);
    }
  }
  return [...frames.values()]
    .map((frame) => ({ ...frame, self_ms: Math.round(frame.self_ms) }))
    .sort((a, b) => b.self_ms - a.self_ms)
    .slice(0, n);
}

/** THE WATCHDOG, run as a CommonJS worker from this string so it needs no loader in either the tsx or the
 *  built daemon. Its timer starts first and keeps the worker alive while an inspector reply waits on the
 *  main thread: a worker with nothing but a pending inspector reply exits with code 0. */
export const LOOP_STALL_WATCHDOG_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const inspector = require("node:inspector");
const shared = new Int32Array(workerData.shared);
let session;
let timer;
let attached = false;
let busy = false;
let stall;
let lastBeat = Atomics.load(shared, ${BEAT});
let lastChangeAt = performance.now();
const fail = (error) => {
  clearTimeout(timer);
  timer = undefined;
  parentPort.postMessage({ kind: "failed", reason: String((error && error.message) || error).slice(0, 200) });
};
const post = (method, params) => new Promise((resolve, reject) =>
  session.post(method, params || {}, (error, result) => (error ? reject(error) : resolve(result))));
const run = (step) => { busy = true; step().then(() => { busy = false; }, fail); };
const begin = async (beat, now) => {
  stall = { beat, startedAt: lastChangeAt, chunkAt: now, previous: undefined };
  await post("Profiler.setSamplingInterval", { interval: Atomics.load(shared, ${SAMPLING_US}) });
  await post("Profiler.start");
};
const rotate = async () => {
  const { profile } = await post("Profiler.stop");
  stall.previous = profile;
  stall.chunkAt = performance.now();
  await post("Profiler.start");
};
const finish = async () => {
  const { profile } = await post("Profiler.stop");
  const done = stall;
  stall = undefined;
  parentPort.postMessage({ kind: "profile", beat: done.beat, silent_ms: Math.round(performance.now() - done.startedAt),
    profiles: done.previous ? [done.previous, profile] : [profile] });
};
const tick = () => {
  timer = setTimeout(tick, Math.max(1, Atomics.load(shared, ${PERIOD})));
  if (!attached || busy) return;
  const now = performance.now();
  const beat = Atomics.load(shared, ${BEAT});
  if (beat !== lastBeat) {
    lastBeat = beat;
    lastChangeAt = now;
    if (stall) run(finish);
    return;
  }
  const bound = Atomics.load(shared, ${BOUND});
  if (!stall && bound > 0 && now - lastChangeAt > bound) run(() => begin(beat, now));
  else if (stall && now - stall.chunkAt >= bound) run(rotate);
};
tick();
try {
  session = new inspector.Session();
  session.connectToMainThread();
  post("Profiler.enable").then(() => {
    attached = true;
    lastChangeAt = performance.now();
    parentPort.postMessage({ kind: "ready" });
  }, fail);
} catch (error) {
  fail(error);
}
`;

export interface LoopStallProfilerOptions {
  /** The synchronous spawn time since the previous call: one heartbeat's share of W1-T7745's window. */
  takeSyncSpawnMs?: () => number;
  /** Seam: start the watchdog from its source. Defaults to an eval worker that does not hold the process open. */
  spawn?: (source: string, workerData: { shared: SharedArrayBuffer }) => Worker;
}

export interface LoopStallProfiler {
  /** Record one tick's lag. The first reading starts the watchdog; each one moves the bound. */
  observe(reading: LoopLagReading, log: StallLog): void;
  /** The bound in force, or undefined before the daemon has reported an interval. */
  boundMs(): number | undefined;
  /** True once the watchdog's inspector session is attached; false if it failed or was stopped first. */
  ready(): Promise<boolean>;
  stop(): void;
}

interface ProfileMessage { kind: "profile"; beat: number; silent_ms: number; profiles: CpuProfile[] }
type WatchdogMessage = { kind: "ready" } | { kind: "failed"; reason: string } | ProfileMessage;

export function startLoopStallProfiler(options: LoopStallProfilerOptions = {}): LoopStallProfiler {
  const shared = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
  const lags: number[] = [];
  const beats = new Map<number, { lagMs: number; syncSpawnMs: number }>();
  let intervalMs: number | undefined;
  let sink: StallLog | undefined;
  let worker: Worker | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let lastBeatAtMs = 0;
  let off = false;
  let resolveReady: (attached: boolean) => void = () => {};
  const readiness = new Promise<boolean>((resolve) => { resolveReady = resolve; });
  const halt = (): void => {
    off = true;
    resolveReady(false);
    clearTimeout(heartbeat);
    const held = worker;
    worker = undefined;
    void held?.terminate();
  };
  const disable = (reason: string): void => {
    if (off) return;
    halt();
    try {
      sink?.("daemon.loop_stall_profile_failed", { reason: reason.slice(0, 200) });
    } catch (error) {
      // Reason: the row is the only record of this failure; a throwing logger loses it, never the loop.
      void error;
    }
  };
  const period = (): number => Atomics.load(shared, PERIOD);
  const beat = (): void => {
    try {
      const nowMs = performance.now();
      const count = Atomics.add(shared, BEAT, 1) + 1;
      const syncSpawnMs = options.takeSyncSpawnMs?.() ?? 0;
      beats.set(count, { lagMs: Math.max(0, nowMs - lastBeatAtMs - period()), syncSpawnMs });
      beats.delete(count - BEATS_KEPT);
      lastBeatAtMs = nowMs;
      heartbeat = setTimeout(beat, period());
      heartbeat.unref();
    } catch (error) {
      disable(`heartbeat: ${String((error as Error)?.message ?? error)}`);
    }
  };
  const record = (message: ProfileMessage): void => {
    const closing = beats.get(message.beat + 1);
    const lagMs = Math.round(closing?.lagMs ?? message.silent_ms);
    const syncSpawnMs = Math.round(closing?.syncSpawnMs ?? 0);
    sink?.("daemon.loop_stall_profile", {
      lag_ms: lagMs,
      sync_spawn_ms: syncSpawnMs,
      unattributed_ms: Math.max(0, lagMs - syncSpawnMs),
      bound_ms: Atomics.load(shared, BOUND),
      top_frames: topSelfFrames(message.profiles),
    });
  };
  const start = (): void => {
    lastBeatAtMs = performance.now();
    heartbeat = setTimeout(beat, period());
    heartbeat.unref();
    const held = options.spawn?.(LOOP_STALL_WATCHDOG_SOURCE, { shared: shared.buffer as SharedArrayBuffer })
      ?? new Worker(LOOP_STALL_WATCHDOG_SOURCE, { eval: true, workerData: { shared: shared.buffer } });
    worker = held;
    held.unref();
    held.on("message", (message: WatchdogMessage) => {
      if (worker !== held) return;
      try {
        if (message.kind === "ready") resolveReady(true);
        else if (message.kind === "failed") disable(message.reason);
        else record(message);
      } catch (error) {
        disable(`profile row: ${String((error as Error)?.message ?? error)}`);
      }
    });
    held.on("error", (error: Error) => { if (worker === held) disable(`watchdog error: ${error.message}`); });
    held.on("exit", (code: number) => { if (worker === held) disable(`watchdog exited: ${code}`); });
  };
  return {
    observe(reading, log) {
      if (off) return;
      sink = log;
      lags.push(reading.lagMs);
      if (lags.length > LOOP_STALL_LAG_HISTORY) lags.shift();
      // The daemon's own interval: the longest of its tick cadences, since every one of them reports here.
      intervalMs = Math.max(intervalMs ?? 0, reading.intervalMs);
      const bound = loopStallBoundMs(intervalMs, lags);
      Atomics.store(shared, BOUND, bound);
      Atomics.store(shared, PERIOD, Math.max(1, Math.round(intervalMs / LOOP_STALL_HEARTBEATS_PER_INTERVAL)));
      Atomics.store(shared, SAMPLING_US,
        Math.max(MIN_SAMPLING_INTERVAL_US, Math.round((bound * 1000) / LOOP_STALL_SAMPLES_PER_CHUNK)));
      if (worker === undefined) {
        try {
          start();
        } catch (error) {
          disable(`watchdog start: ${String((error as Error)?.message ?? error)}`);
        }
      }
    },
    boundMs: () => (intervalMs === undefined ? undefined : Atomics.load(shared, BOUND)),
    ready: () => readiness,
    stop: halt,
  };
}
