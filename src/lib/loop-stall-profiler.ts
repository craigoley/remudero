/**
 * lib/loop-stall-profiler.ts — W1-T7746: profile an unattributed loop stall WHILE it is happening.
 * Why: W1-T7746 records the 2026-10-10 stalls with no sync spawn to blame.
 *
 * A sampler on the blocked loop records nothing until the block clears ({@link reportLoopLag}). So the
 * watchdog runs in a worker thread. The main loop bumps a shared heartbeat counter each turn. When it has
 * been still past the bound, the worker opens `inspector.Session.connectToMainThread()` and starts V8's
 * sampling profiler. The inspector reaches a busy main thread through an interrupt, so the profile samples
 * the stall itself. It stops when the heartbeat moves again; at most one profile runs at a time.
 *
 * THE BOUND IS DERIVED, NOT PICKED ({@link loopStallBoundMs}): the daemon's interval plus a quantile of the
 * lags it has observed in this process. Before the daemon's first tick there is no bound and no watchdog.
 * MEMORY STAYS BOUNDED: a stall that never ends is profiled in chunks one bound long. W1-T9361: each chunk is
 * FOLDED into a per-frame aggregate before it is released ({@link foldStallChunk}), so the row attributes the whole
 * profiled stall and the aggregate grows with the distinct frames the stall ran, never with its length. No
 * profile is written to disk. The row says how much of the lag it profiled (`profiled_ms`, `unprofiled_ms`), names
 * each top self frame's nearest script CALLER from the profile's node tree, and ranks the callers themselves.
 * IT CANNOT TAKE DOWN THE LOOP IT WATCHES: any inspector or watchdog failure writes
 * `daemon.loop_stall_profile_failed` with its reason and disables the watchdog for the boot.
 * W1-T10074: serve runs the same profiler under its own step names ({@link LoopStallProfilerOptions.steps}).
 *
 * A V8 LIMIT: a frame on-stack-replaced BEFORE the profile began has its samples credited to its caller.
 * A spin that keeps calling functions is named correctly, which is the shape of a scanner spin.
 */

import { SHARE_ENV, Worker } from "node:worker_threads";
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

/** Where a frame is: `line` is 1-based; 0 means no source line. */
export interface StallFrameRef {
  function: string;
  url: string;
  line: number;
}

/** One frame of a stall profile row, ordered by self time. */
export interface StallFrame extends StallFrameRef {
  self_ms: number;
  /** W1-T9361: the nearest script frame below it on the stack (see {@link LOOP_STALL_FORWARDING_FRAMES}), so a
   *  native leaf such as `readFileUtf8` or `spawn` names the code that called it. Absent when none was. */
  caller?: StallFrameRef;
  /** W1-T9361: the outermost `node:` builtin between the frame and its caller — the API the caller entered
   *  (`spawnSync`, `execFileSync`, `readFileSync`, `execFile`), so a sync child is told from an async one. */
  via?: string;
}

/** W1-T9361: a script frame's total time — its own and everything it called — in the profiled stall. */
export interface StallInclusiveFrame extends StallFrameRef {
  total_ms: number;
}

/** W1-T9361: a caller's share of the profiled stall. */
export interface StallCaller extends StallFrameRef {
  self_ms: number;
}

/** The parts of a V8 `Profiler.Profile` this reads. */
export interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** W1-T9361: script frames that only FORWARD a call for someone else, so none is a stall's caller: the frame that
 *  called them is. read-plane.ts's sync-spawn meter wraps every `execFileSync`/`execSync`/`spawnSync`, so without
 *  its entry every sync child would name read-plane's `wrapper`; the rest are read-plane's SYNC_SPAWN_LEAF_FRAMES
 *  (the shared spawn and transport leaves), copied because read-plane imports this module (scripts/cycle-ratchet).
 *  A test holds the copy to the original. Matched against `at <function> (<url>:<line>)`, a stack line's shape. */
export const LOOP_STALL_FORWARDING_FRAMES: readonly RegExp[] = [
  /[/\\]read-plane\.[cm]?[jt]s/,
  /[/\\]worktree-git\.[cm]?[jt]s/,
  /[/\\]github-transport\.[cm]?[jt]s/,
  /\bat (?:runGit|loadPlanAtRef) \(.*[/\\]plan\.[cm]?[jt]s/,
];

/** W1-T9361: one entry of a {@link StallFold}, `us` long. */
export interface StallFoldEntry {
  frame: StallFrameRef;
  caller?: StallFrameRef;
  via?: string;
  us: number;
}

/** W1-T9361: what a stall's folded chunks attribute. Every map is keyed by frame (and caller), so its size follows
 *  the distinct frames the stall ran, never how long it ran. Microseconds, as V8 reports them. */
export interface StallFold {
  chunks: number;
  profiledUs: number;
  /** Self time by leaf frame, the builtin it ran under and its caller. */
  self: Map<string, StallFoldEntry>;
  /** Total time by script frame: every non-forwarding script frame on a sample's stack, once per sample. */
  inclusive: Map<string, StallFoldEntry>;
  /** Each sample credited to the INNERMOST non-forwarding script frame on its stack (the leaf itself when it is
   *  one), so a function's builtin and native work counts as its own: who held the loop. */
  callers: Map<string, StallFoldEntry>;
  /** The samples under a `node:child_process` sync API, by that innermost script frame. */
  syncSpawn: Map<string, StallFoldEntry>;
  syncSpawnUs: number;
}

/**
 * W1-T9361: FOLD one profile chunk into a stall's aggregate (a new one when `fold` is undefined) and return it, so
 * the chunk itself can be released. A sample lasts until the next one, or the chunk's end. V8's bookkeeping nodes
 * ((root), (idle), (program)) are not code the loop was running. The caller of a frame is found by walking the
 * chunk's node tree (each node's `children`) towards the root: `node:` builtins and url-less natives are passed
 * (the outermost builtin is the `via`), and so are frames matching `forwarding`.
 *
 * TRAP: the watchdog worker runs THIS function from its source text (`${foldStallChunk}` in
 * {@link LOOP_STALL_WATCHDOG_SOURCE}), so it may reference nothing outside itself, and it declares no named inner
 * function: the tsx and bundle transforms keep names with a module-level `__name` helper the worker lacks.
 */
export function foldStallChunk(fold: StallFold | undefined, profile: CpuProfile,
  forwarding: readonly RegExp[]): StallFold {
  const into: StallFold = fold ?? { chunks: 0, profiledUs: 0, self: new Map(), inclusive: new Map(),
    callers: new Map(), syncSpawn: new Map(), syncSpawnUs: 0 };
  const bookkeeping = ["(root)", "(idle)", "(program)"];
  const syncApis = ["execFileSync", "execSync", "spawnSync"];
  const byId = new Map<number, CpuProfile["nodes"][number]>();
  const parentOf = new Map<number, number>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parentOf.set(child, node.id);
  }
  type Ref = { key: string; frame: StallFrameRef };
  type Attribution = { selfKey: string; leaf: StallFrameRef; caller?: StallFrameRef; via?: string;
    innermost?: Ref; scripts: Ref[]; syncChild: boolean };
  const attributed = new Map<number, Attribution>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let at = profile.startTime;
  for (let i = 0; i < samples.length; i++) {
    at += deltas[i] ?? 0;
    const next = i + 1 < samples.length ? at + (deltas[i + 1] ?? 0) : profile.endTime;
    const node = byId.get(samples[i]!);
    if (!node || bookkeeping.includes(node.callFrame.functionName)) continue;
    let seen = attributed.get(node.id);
    if (seen === undefined) {
      // One walk per sampled node, from the leaf towards the root; every later sample of the node reuses it.
      let caller: Ref | undefined;
      let innermost: Ref | undefined;
      let via: string | undefined;
      let syncChild = false;
      const scripts: Ref[] = [];
      for (let id: number | undefined = node.id, depth = 0; id !== undefined; id = parentOf.get(id), depth++) {
        const { functionName, url, lineNumber } = byId.get(id)!.callFrame;
        if (bookkeeping.includes(functionName)) continue;
        if (url.startsWith("node:")) {
          if (caller === undefined && depth > 0) {
            via = functionName;
            syncChild ||= url === "node:child_process" && syncApis.includes(functionName);
          }
          continue;
        }
        const line = lineNumber < 0 ? 0 : lineNumber + 1;
        const frame = { function: functionName || "(anonymous)", url, line };
        if (url === "" || forwarding.some((pattern) => pattern.test(`at ${frame.function} (${url}:${line})`))) continue;
        const ref = { key: `${functionName}\u0000${url}\u0000${lineNumber}`, frame };
        innermost ??= ref;
        if (depth > 0) caller ??= ref;
        if (!scripts.some((script) => script.key === ref.key)) scripts.push(ref);
      }
      const { functionName, url, lineNumber } = node.callFrame;
      const leaf = { function: functionName || "(anonymous)", url, line: lineNumber < 0 ? 0 : lineNumber + 1 };
      seen = { selfKey: `${functionName}\u0000${url}\u0000${lineNumber}\u0001${via ?? ""}\u0001${caller?.key ?? ""}`,
        leaf, caller: caller?.frame, via, innermost, scripts, syncChild };
      attributed.set(node.id, seen);
    }
    const us = Math.max(0, next - at);
    let self = into.self.get(seen.selfKey);
    if (self === undefined) {
      self = { frame: seen.leaf, us: 0 };
      if (seen.caller !== undefined) self.caller = seen.caller;
      if (seen.via !== undefined) self.via = seen.via;
      into.self.set(seen.selfKey, self);
    }
    self.us += us;
    for (const script of seen.scripts) {
      const total = into.inclusive.get(script.key) ?? { frame: script.frame, us: 0 };
      total.us += us;
      into.inclusive.set(script.key, total);
    }
    if (seen.innermost !== undefined) {
      const credited = into.callers.get(seen.innermost.key) ?? { frame: seen.innermost.frame, us: 0 };
      credited.us += us;
      into.callers.set(seen.innermost.key, credited);
    }
    if (seen.syncChild) {
      into.syncSpawnUs += us;
      if (seen.innermost !== undefined) {
        const spawned = into.syncSpawn.get(seen.innermost.key) ?? { frame: seen.innermost.frame, us: 0 };
        spawned.us += us;
        into.syncSpawn.set(seen.innermost.key, spawned);
      }
    }
  }
  into.chunks++;
  into.profiledUs += Math.max(0, profile.endTime - profile.startTime);
  return into;
}

/** W1-T9361: what a `daemon.loop_stall_profile` row names from a stall's fold. */
export interface StallSummary {
  /** The summed span of every folded chunk: how much of the stall the row attributes. */
  profiled_ms: number;
  chunks: number;
  top_frames: StallFrame[];
  top_inclusive: StallInclusiveFrame[];
  /** The callers that held the loop longest, each sample credited to its innermost script frame. Keyed by
   *  function, url and line, so a later pass can rank who blocks the loop across rows. */
  top_callers: StallCaller[];
  /** The profiled time under a `node:child_process` sync API, beside the meter's `sync_spawn_ms`. */
  sync_spawn_profiled_ms: number;
  sync_spawn_callers: StallCaller[];
}

const toMs = (us: number): number => Math.round(us / 1000);

/** The `n` longest entries, longest first. A tie keeps the fold's order: the deeper frame first. */
function longest(entries: Map<string, StallFoldEntry>, n: number): StallFoldEntry[] {
  return [...entries.values()].sort((a, b) => b.us - a.us).slice(0, n);
}

export function summarizeStallFold(fold: StallFold, n = LOOP_STALL_TOP_FRAMES): StallSummary {
  return {
    profiled_ms: toMs(fold.profiledUs),
    chunks: fold.chunks,
    top_frames: longest(fold.self, n).map(({ frame, caller, via, us }) => ({ ...frame, self_ms: toMs(us),
      ...(caller === undefined ? {} : { caller }), ...(via === undefined ? {} : { via }) })),
    top_inclusive: longest(fold.inclusive, n).map(({ frame, us }) => ({ ...frame, total_ms: toMs(us) })),
    top_callers: longest(fold.callers, n).map(({ frame, us }) => ({ ...frame, self_ms: toMs(us) })),
    sync_spawn_profiled_ms: toMs(fold.syncSpawnUs),
    sync_spawn_callers: longest(fold.syncSpawn, n).map(({ frame, us }) => ({ ...frame, self_ms: toMs(us) })),
  };
}

/** The top self-time frames over a stall's profile chunks, each with its caller: {@link foldStallChunk} over every
 *  chunk, read by {@link summarizeStallFold}. */
export function topSelfFrames(profiles: readonly CpuProfile[], n = LOOP_STALL_TOP_FRAMES): StallFrame[] {
  let fold: StallFold | undefined;
  for (const profile of profiles) fold = foldStallChunk(fold, profile, LOOP_STALL_FORWARDING_FRAMES);
  return fold === undefined ? [] : summarizeStallFold(fold, n).top_frames;
}

/** THE WATCHDOG, run as an eval worker from this string so it needs no loader in either the tsx or the
 *  built daemon. It reads builtins through `process.getBuiltinModule`: an eval worker inherits
 *  `--input-type=module`, where `require` is undefined. Its timer starts first and keeps the worker alive
 *  while an inspector reply waits on the main thread: a worker with only a pending reply exits with code 0.
 *  TRAP: the Profiler domain is enabled only at the first stall. A session that ever enabled it resets V8's
 *  process-wide precise coverage to best-effort when it disconnects, so an eager enable would blank the
 *  coverage of every test process that starts a daemon with this telemetry.
 *  W1-T9361: each stopped chunk is folded ({@link foldStallChunk}, run here from its own source) as soon as the
 *  next one has started, and released; `unprofiled_ms` is the stall's time before the first chunk began. */
export const LOOP_STALL_WATCHDOG_SOURCE = `
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
const inspector = process.getBuiltinModule("node:inspector");
const shared = new Int32Array(workerData.shared);
let session;
let timer;
let attached = false;
let enabled = false;
let busy = false;
let stall;
let lastBeat = Atomics.load(shared, ${BEAT});
let lastChangeAt = performance.now();
const forwarding = [${LOOP_STALL_FORWARDING_FRAMES.join(", ")}];
${foldStallChunk}
const fail = (error) => {
  clearTimeout(timer);
  timer = undefined;
  parentPort.postMessage({ kind: "failed", reason: String((error && error.message) || error).slice(0, 200) });
};
const post = (method, params) => new Promise((resolve, reject) =>
  session.post(method, params || {}, (error, result) => (error ? reject(error) : resolve(result))));
const run = (step) => { busy = true; step().then(() => { busy = false; }, fail); };
const begin = async (beat, now) => {
  stall = { beat, startedAt: lastChangeAt, chunkAt: now, fold: undefined, unprofiledMs: 0 };
  if (!enabled) { await post("Profiler.enable"); enabled = true; }
  await post("Profiler.setSamplingInterval", { interval: Atomics.load(shared, ${SAMPLING_US}) });
  await post("Profiler.start");
  stall.unprofiledMs = performance.now() - stall.startedAt;
};
const rotate = async () => {
  // Both commands are sent BEFORE either reply is awaited: the main thread drains its inspector queue in order, so a
  // synchronous child that begins between a stop and a separate start cannot hold the restart (an inspector command
  // waits while the main thread is inside a native call) and leave the whole child wait unprofiled.
  const [{ profile }] = await Promise.all([post("Profiler.stop"), post("Profiler.start")]);
  stall.chunkAt = performance.now();
  stall.fold = foldStallChunk(stall.fold, profile, forwarding);
};
const finish = async () => {
  const { profile } = await post("Profiler.stop");
  const done = stall;
  stall = undefined;
  parentPort.postMessage({ kind: "profile", beat: done.beat, silent_ms: Math.round(performance.now() - done.startedAt),
    unprofiled_ms: Math.round(done.unprofiledMs), fold: foldStallChunk(done.fold, profile, forwarding) });
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
  attached = true;
  parentPort.postMessage({ kind: "ready" });
} catch (error) {
  // Reason: no session means no watchdog; fail() reports why, and the main thread disables it for the boot.
  fail(error);
}
`;

/** The two rows a profiler writes: the stall's profile, and the failure that disabled it for the boot. */
export interface LoopStallSteps {
  profile: string;
  failed: string;
}

/** The daemon's rows, the default. */
export const DAEMON_LOOP_STALL_STEPS: LoopStallSteps = {
  profile: "daemon.loop_stall_profile",
  failed: "daemon.loop_stall_profile_failed",
};

export interface LoopStallProfilerOptions {
  /** W1-T10074: the step names its rows carry; absent, {@link DAEMON_LOOP_STALL_STEPS}. */
  steps?: LoopStallSteps;
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

interface ProfileMessage { kind: "profile"; beat: number; silent_ms: number; unprofiled_ms: number; fold: StallFold }
type WatchdogMessage = { kind: "ready" } | { kind: "failed"; reason: string } | ProfileMessage;

export function startLoopStallProfiler(options: LoopStallProfilerOptions = {}): LoopStallProfiler {
  const steps = options.steps ?? DAEMON_LOOP_STALL_STEPS;
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
      sink?.(steps.failed, { reason: reason.slice(0, 200) });
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
      // Reason: a timer callback must not throw into the daemon; disable() records it as the failure row.
      disable(`heartbeat: ${String((error as Error)?.message ?? error)}`);
    }
  };
  const record = (message: ProfileMessage): void => {
    const closing = beats.get(message.beat + 1);
    const lagMs = Math.round(closing?.lagMs ?? message.silent_ms);
    const syncSpawnMs = Math.round(closing?.syncSpawnMs ?? 0);
    sink?.(steps.profile, {
      lag_ms: lagMs,
      sync_spawn_ms: syncSpawnMs,
      unattributed_ms: Math.max(0, lagMs - syncSpawnMs),
      bound_ms: Atomics.load(shared, BOUND),
      unprofiled_ms: message.unprofiled_ms,
      ...summarizeStallFold(message.fold),
    });
  };
  const start = (): void => {
    lastBeatAtMs = performance.now();
    heartbeat = setTimeout(beat, period());
    heartbeat.unref();
    const held = options.spawn?.(LOOP_STALL_WATCHDOG_SOURCE, { shared: shared.buffer as SharedArrayBuffer })
      ?? new Worker(LOOP_STALL_WATCHDOG_SOURCE,
        { eval: true, execArgv: [], workerData: { shared: shared.buffer }, env: SHARE_ENV });
    worker = held;
    held.on("message", (message: WatchdogMessage) => {
      if (worker !== held) return;
      try {
        if (message.kind === "ready") resolveReady(true);
        else if (message.kind === "failed") disable(message.reason);
        else record(message);
      } catch (error) {
        // Reason: a row that cannot be written ends profiling for the boot; disable() records why.
        disable(`profile row: ${String((error as Error)?.message ?? error)}`);
      }
    });
    held.on("error", (error: Error) => { if (worker === held) disable(`watchdog error: ${error.message}`); });
    held.on("exit", (code: number) => { if (worker === held) disable(`watchdog exited: ${code}`); });
    // After the listeners: a 'message' listener attached after unref() refs the worker, and the daemon could not exit.
    held.unref();
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
          // Reason: a watchdog that cannot start must cost the profile, never the tick; disable() records why.
          disable(`watchdog start: ${String((error as Error)?.message ?? error)}`);
        }
      }
    },
    boundMs: () => (intervalMs === undefined ? undefined : Atomics.load(shared, BOUND)),
    ready: () => readiness,
    stop: halt,
  };
}
