import { SHARE_ENV, Worker } from "node:worker_threads";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { clockFromMillisFn, systemClock, type Clock } from "./clock.js";
import { rawCallSites } from "./raw-call-sites.js";
import { startLoopStallProfiler, type LoopLagReading, type LoopStallProfiler, type LoopStallProfilerOptions,
  type StallLog } from "./loop-stall-profiler.js";

export const READ_PLANE_KIND = "remudero-tick-reads";

/** A synchronous child-process call long enough to name when it froze the loop (W1-T5718). */
export interface SyncSpawnEntry {
  via: string;
  command: string;
  first_arg?: string;
  duration_ms: number;
  /** The first frame outside the shared spawn leaves: the code that reached the leaf (W1-T7745). */
  caller?: string;
  /** The shared leaf the spawn went through (`hostWorktreeGit`, `ghExecFile`…), when one was on the stack. */
  leaf?: string;
  /** True when no frame outside the leaves was on the stack, so `caller` is the leaf itself. */
  caller_is_leaf?: true;
  /** W1-T9577: for an anonymous `caller`, the named functions that reached it (`callerChain`), so it is named. */
  caller_chain?: string[];
}

/** W1-T9577: one caller's share of a window — EVERY sync spawn it made, whatever each one's length. */
export interface SyncSpawnCallerTotal {
  caller?: string;
  caller_chain?: string[];
  leaf?: string;
  caller_is_leaf?: true;
  total_ms: number;
  calls: number;
}

/** What one `daemon.loop_lag` row reads about its own interval: the longest spawn and the total sync-spawn time. */
export interface LagIntervalReading {
  top: SyncSpawnEntry | undefined;
  sync_spawn_ms: number;
  /** W1-T9577: present once the interval spawned — its callers by total, and the time none of them holds. */
  by_caller?: SyncSpawnCallerTotal[];
  unnamed_ms?: number;
  /** W1-T9754: present once the interval made an ASYNC spawn — the time those held the loop inside the spawn
   *  call itself (the fork), and their callers by that total. An idle interval reads as before. */
  async_spawn_sync_ms?: number;
  async_by_caller?: SyncSpawnCallerTotal[];
}

export interface ReadPlaneSample {
  loop_delay_max_ms: number;
  loop_delay_p99_ms: number;
  sync_spawn_ms: number;
  sync_spawn_top: SyncSpawnEntry[];
  sync_spawn_by_caller: SyncSpawnCallerTotal[];
  sync_spawn_unnamed_ms: number;
  /** W1-T9754: the synchronous share of the window's async spawns, and its callers by total. */
  async_spawn_sync_ms: number;
  async_spawn_sync_by_caller: SyncSpawnCallerTotal[];
}

/** The sampler is handed to the daemon unbound. Calling it closes the `daemon.alive` window. `takeLagInterval`
 *  reads and closes a SEPARATE window, one per `consumer` key, so each `daemon.loop_lag` row names only the
 *  spawns made since that consumer's previous reading and `daemon.alive` keeps its own reset (W1-T7745).
 *  `observeLoopLag` hands each tick's lag to the loop-stall profiler, whose bound it moves (W1-T7746). */
export type ReadPlaneSampler = (() => ReadPlaneSample) & { takeLagInterval(consumer?: string): LagIntervalReading;
  observeLoopLag(reading: LoopLagReading, log: StallLog): void };

/** The lag-window consumer the loop-stall profiler's heartbeat reads, one heartbeat at a time (W1-T7746). */
const STALL_PROFILE_CONSUMER = "loop_stall_profile";

/** The shared spawn leaves: frames that only forward a spawn for someone else, so none is the caller. Declared
 *  once here: a module path, or plan.ts's named default runner (`loadPlanAtRef`'s `runGit` arrow). */
export const SYNC_SPAWN_LEAF_FRAMES: readonly RegExp[] = [
  /[/\\]worktree-git\.[cm]?[jt]s/,
  /[/\\]github-transport\.[cm]?[jt]s/,
  /\bat (?:runGit|loadPlanAtRef) \(.*[/\\]plan\.[cm]?[jt]s/,
];

export const SYNC_SPAWN_RECORD_MIN_MS = 2000;
export const SYNC_SPAWN_TOP_N = 3;
const ARG_MAX_CHARS = 80;

function frameName(line: string): string {
  const named = /^\s*at (?:async )?(?:new )?([^\s(]+) \(/.exec(line);
  return (named?.[1] ?? line.trim()).slice(0, 200);
}

/** W1-T9577: the one frame field the chain reads that the stack text cannot give — the function's OWN name. The
 *  text prints a nameless function by its call (`Object.value` for git-push's `next.value()`); this prints "". */
type CallSite = { functionName: string; scriptName: string };

function siteModule(path: string): string {
  return (path.split(/[/\\]/).pop() ?? "").replace(/\.[cm]?[jt]s$/, "");
}

/** W1-T9577: an anonymous caller (by its text site), then the named functions outward, deduplicated. A closure
 *  defined where it runs ends at the first named one. One driven from another module (escalate.ts's gateway
 *  through git-push's `runStepsSync`) runs on back through its own module to the first named function beyond
 *  it: the call site. `node:` and builtin frames only forward the call, so neither is ever the name. */
function callerChain(callerLine: string, sites: readonly CallSite[]): string[] | undefined {
  const caller = sites[0];
  if (caller === undefined || caller.functionName !== "") return undefined;
  const home = caller.scriptName;
  // Reason: the text and the call sites are two captures; a caller in another module means they disagree.
  if (siteModule(/\(?([^\s()]+):\d+:\d+\)?\s*$/.exec(callerLine)?.[1] ?? "") !== siteModule(home)) return undefined;
  const lastHome = sites.findLastIndex((site) => site.scriptName === home);
  const chain = [`<anonymous>@${/([^/\\\s(]+:\d+):\d+\)?\s*$/.exec(callerLine)?.[1] ?? "?"}`];
  let left = false;
  for (const [index, site] of sites.entries()) {
    if (index === 0 || site.scriptName === "" || site.scriptName.startsWith("node:")) continue;
    const atHome = site.scriptName === home;
    left ||= !atHome;
    if (site.functionName === "") continue;
    if (chain[chain.length - 1] !== site.functionName) chain.push(site.functionName.slice(0, 120));
    if (atHome ? !left : index > lastHome) break;
  }
  return chain;
}


/** W1-T9720: one call site in the source-mapped formatter's shape (`Object.fn (/abs/path.ts:L:C)`, `<anonymous>`
 *  for a nameless function) at the position node RUNS, not the TypeScript line: reading a mapped line would parse
 *  the map. A site with no file (native, `Promise.all`) keeps V8's own text. */
function siteText(site: NodeJS.CallSite): string {
  const file = site.getFileName();
  if (!file) return String(site);
  const type = site.getTypeName();
  const name = `${type !== null && type !== "global" ? `${type}.` : ""}${site.getFunctionName() ?? "<anonymous>"}`;
  const path = file.startsWith("file:") ? fileURLToPath(file) : file;
  return `${site.isAsync() ? "async " : ""}${site.isConstructor() ? "new " : ""}${name} `
    + `(${path}:${site.getLineNumber()}:${site.getColumnNumber()})`;
}

/** The first frame outside read-plane, `node:` and the shared leaves; `leaf` is the OUTERMOST leaf frame, the one
 *  the caller called. With no frame outside the leaves the caller is that leaf and `callerIsLeaf` says so. */
export function callerFrame(): { caller?: string; leaf?: string; callerIsLeaf?: true; chain?: string[] } {
  const raw = rawCallSites();
  const sites = raw.map((site) => ({ functionName: site.getFunctionName() ?? "", scriptName: site.getFileName() ?? "" }));
  let leafLine: string | undefined;
  const lines = raw.map((site) => `    at ${siteText(site)}`); // W1-T9577: index-aligned with `sites`: one capture
  for (const [index, line] of lines.entries()) {
    if (/read-plane\.[cm]?[jt]s/.test(line) || /node:/.test(line)) continue;
    if (SYNC_SPAWN_LEAF_FRAMES.some((leaf) => leaf.test(line))) { leafLine = line; continue; }
    const chain = callerChain(line, sites.slice(index));
    return { caller: line.trim().slice(0, 200), ...(leafLine === undefined ? {} : { leaf: frameName(leafLine) }),
      ...(chain === undefined ? {} : { chain }) };
  }
  return leafLine === undefined ? {}
    : { caller: leafLine.trim().slice(0, 200), leaf: frameName(leafLine), callerIsLeaf: true };
}

/** W1-T9577: a window's spawn time by caller, in a map bounded by the distinct callers that spawned in it. */
type CallerTotals = Map<string, SyncSpawnCallerTotal>;

/** Longest total first, until the named share reaches what the window holds in whole milliseconds; the cut is the
 *  window's own total, so no count or minimum drops a caller. Each share is the step of the ROUNDED running sum, so
 *  the shares never outgrow the rounded window, and what no caller holds is `unnamed_ms`. */
function namedShare(totals: CallerTotals, windowMs: number): { by_caller: SyncSpawnCallerTotal[]; unnamed_ms: number } {
  const whole = Math.round(windowMs);
  const by_caller: SyncSpawnCallerTotal[] = [];
  let running = 0;
  let named = 0;
  for (const total of [...totals.values()].sort((a, b) => b.total_ms - a.total_ms)) {
    running += total.total_ms;
    const ms = Math.min(whole, Math.round(running)) - named;
    if (ms <= 0) break;
    by_caller.push({ ...total, total_ms: ms });
    named += ms;
  }
  return { by_caller, unnamed_ms: whole - named };
}

export function startReadPlaneTelemetry(options: { clock?: Clock; stallProfiler?: LoopStallProfilerOptions } = {}): {
  sample: ReadPlaneSampler;
  stallProfiler: LoopStallProfiler;
  stop(): void;
} {
  const now = (options.clock ?? clockFromMillisFn(() => performance.now())).now;
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let syncMs = 0;
  let depth = 0;
  let top: SyncSpawnEntry[] = [];
  let callers: CallerTotals = new Map();
  // One window per lag consumer: what was spawned since its last reading, or since the sampler started for
  // a consumer's first. `sinceStart` is that first reading's window; it is in the set until a consumer claims it.
  type LagWindow = { ms: number; top: SyncSpawnEntry[]; callers: CallerTotals; asyncMs: number; asyncCallers: CallerTotals };
  const freshWindow = (): LagWindow => ({ ms: 0, top: [], callers: new Map(), asyncMs: 0, asyncCallers: new Map() });
  const lagWindows = new Map<string, LagWindow>();
  const sinceStart = freshWindow();
  let asyncMs = 0;
  let asyncCallers: CallerTotals = new Map();
  const names = ["execFileSync", "execSync", "spawnSync"] as const;
  const originals = names.map((name) => childProcess[name]);
  const tally = (totals: CallerTotals, who: Omit<SyncSpawnCallerTotal, "total_ms" | "calls">, key: string,
    durationMs: number): void => {
    const total = totals.get(key) ?? { ...who, total_ms: 0, calls: 0 };
    total.total_ms += durationMs;
    total.calls++;
    totals.set(key, total);
  };
  const whoCalled = (): { who: Omit<SyncSpawnCallerTotal, "total_ms" | "calls">; key: string } => {
    const { caller, leaf, callerIsLeaf, chain } = callerFrame();
    const who: Omit<SyncSpawnCallerTotal, "total_ms" | "calls"> = { caller };
    if (chain !== undefined) who.caller_chain = chain;
    if (leaf !== undefined) who.leaf = leaf;
    if (callerIsLeaf) who.caller_is_leaf = true;
    return { who, key: JSON.stringify([caller, chain, leaf]) };
  };
  const record = (via: string, args: unknown[], durationMs: number): void => {
    try {
      const head = String(args[0] ?? "");
      // execSync's argument is a whole shell line that can carry tokens or bodies: keep only its first word.
      const command = (via === "execSync" ? head.trim().split(/\s+/)[0] ?? "" : head).slice(0, ARG_MAX_CHARS);
      const rest = args[1];
      const first = via === "execSync" || !Array.isArray(rest) || rest.length === 0 ? undefined
        : String(rest[0]).slice(0, ARG_MAX_CHARS);
      const { who, key } = whoCalled();
      if (who.caller !== undefined) {
        for (const totals of [callers, sinceStart.callers, ...[...lagWindows.values()].map((w) => w.callers)]) {
          tally(totals, who, key, durationMs);
        }
      }
      if (durationMs < SYNC_SPAWN_RECORD_MIN_MS) return;
      const entry: SyncSpawnEntry = { via, command, duration_ms: Math.round(durationMs), ...who };
      if (first !== undefined) entry.first_arg = first;
      const keep = (list: SyncSpawnEntry[]): SyncSpawnEntry[] =>
        [...list, entry].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, SYNC_SPAWN_TOP_N);
      top = keep(top);
      for (const window of [sinceStart, ...lagWindows.values()]) window.top = keep(window.top);
    } catch {
      // Reason: attribution is best effort and must never take down the call it observes.
    }
  };
  names.forEach((name, index) => {
    const original = originals[index] as (...args: unknown[]) => unknown;
    const wrapper = (...args: unknown[]): unknown => {
      const began = now();
      depth++;
      try { return original.apply(childProcess, args); }
      finally {
        if (--depth === 0) {
          const took = now() - began;
          syncMs += took;
          for (const window of [sinceStart, ...lagWindows.values()]) window.ms += took;
          record(name, args, took); // W1-T9577: every spawn reaches the caller totals; `record` gates the top list.
        }
      }
    };
    Object.assign(childProcess, { [name]: wrapper });
  });
  syncBuiltinESMExports();
  // W1-T9754: every async spawn (spawn, execFile, exec, fork, and a `promisify(execFile)` captured before this
  // ran) reaches ChildProcess.prototype.spawn, whose call is the fork on this thread. The sync calls never do.
  const prototype = childProcess.ChildProcess.prototype as unknown as { spawn: (...args: unknown[]) => unknown };
  const originalAsyncSpawn = prototype.spawn;
  prototype.spawn = function meteredSpawn(this: unknown, ...args: unknown[]): unknown {
    const began = now();
    try { return originalAsyncSpawn.apply(this, args); }
    finally {
      const took = now() - began;
      asyncMs += took;
      try {
        const { who, key } = whoCalled();
        for (const window of [sinceStart, ...lagWindows.values()]) window.asyncMs += took;
        if (who.caller !== undefined) {
          for (const totals of [asyncCallers, sinceStart.asyncCallers, ...[...lagWindows.values()].map((w) => w.asyncCallers)]) {
            tally(totals, who, key, took);
          }
        }
      } catch (error) {
        void error; // Reason: attribution is best effort and must never take down the spawn it observes.
      }
    }
  };
  let stopped = false;
  const sample = Object.assign((): ReadPlaneSample => {
    const share = namedShare(callers, syncMs);
    const out: ReadPlaneSample = { loop_delay_max_ms: histogram.max / 1e6,
      loop_delay_p99_ms: histogram.count ? histogram.percentile(99) / 1e6 : 0, sync_spawn_ms: syncMs,
      sync_spawn_top: top, sync_spawn_by_caller: share.by_caller, sync_spawn_unnamed_ms: share.unnamed_ms,
      async_spawn_sync_ms: Math.round(asyncMs), async_spawn_sync_by_caller: namedShare(asyncCallers, asyncMs).by_caller };
    histogram.reset();
    syncMs = 0;
    top = [];
    callers = new Map();
    asyncMs = 0;
    asyncCallers = new Map();
    return out;
  }, {
    takeLagInterval: (consumer = ""): LagIntervalReading => {
      const window = lagWindows.get(consumer) ?? sinceStart;
      lagWindows.set(consumer, freshWindow());
      const reading: LagIntervalReading = { top: window.top[0], sync_spawn_ms: Math.round(window.ms),
        ...(window.asyncMs > 0 ? { async_spawn_sync_ms: Math.round(window.asyncMs),
          async_by_caller: namedShare(window.asyncCallers, window.asyncMs).by_caller } : {}) };
      return window.ms > 0 ? { ...reading, ...namedShare(window.callers, window.ms) } : reading;
    },
    observeLoopLag: (reading: LoopLagReading, log: StallLog): void => stallProfiler.observe(reading, log),
  });
  // W1-T7746: idle until the daemon reports its first tick, which gives it the interval its bound is made of.
  const stallProfiler = startLoopStallProfiler({
    takeSyncSpawnMs: () => sample.takeLagInterval(STALL_PROFILE_CONSUMER).sync_spawn_ms, ...options.stallProfiler });
  return {
    sample,
    stallProfiler,
    stop() {
      if (stopped) return;
      stopped = true;
      stallProfiler.stop();
      histogram.disable();
      names.forEach((name, index) => Object.assign(childProcess, { [name]: originals[index] }));
      prototype.spawn = originalAsyncSpawn;
      syncBuiltinESMExports();
    },
  };
}

export function freezeReadGeneration<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !Object.isFrozen(value) && !seen.has(value)) {
    seen.add(value);
    if (value instanceof Map || value instanceof Set) {
      for (const child of value.values()) freezeReadGeneration(child, seen);
      const refuse = () => { throw new TypeError("immutable read generation"); };
      for (const method of value instanceof Map ? ["set", "delete", "clear"] : ["add", "delete", "clear"]) {
        Object.defineProperty(value, method, { value: refuse });
      }
    }
    Object.freeze(value);
    for (const child of Object.values(value)) freezeReadGeneration(child, seen);
  }
  return value;
}

export interface ReadGeneration<T> {
  generation: number;
  source: "worker" | "inline";
  /** When the read that produced `facts` began, from the plane's injected clock (W1-T5762). */
  publishedAtMs: number;
  /** W1-T9704: when that read's facts arrived. A served generation is aged from here, so a slow read is not born stale. */
  settledAtMs?: number;
  facts: T;
}

/** BACKSTOP: the oldest tick-read generation any consumer is served — five 60 s poll intervals.
 * A tick's own consumers read it within that tick; one older was published by a tick whose pass
 * was skipped, and the 10-04 22:08Z one reached a consumer at 23:35Z (W1-T5761, W1-T5762). */
export const TICK_READ_MAX_AGE_MS = 5 * 60_000;

export interface TickReadAgeBound {
  consumer: string;
  clock?: Clock;
  maxAgeMs?: number;
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

const staleRefusals = new WeakMap<NonNullable<TickReadAgeBound["log"]>, Map<string, number>>();

/** The published generation while it is no older than the bound. An older one answers undefined
 * with one `tick_read.stale_refused` row per consumer and generation, leaving its own read. */
export function freshReadGeneration<T>(published: ReadGeneration<T> | undefined, bound: TickReadAgeBound):
  ReadGeneration<T> | undefined {
  if (!published) return undefined;
  const maxAgeMs = bound.maxAgeMs ?? TICK_READ_MAX_AGE_MS;
  const ageMs = (bound.clock ?? systemClock).now() - (published.settledAtMs ?? published.publishedAtMs);
  if (ageMs <= maxAgeMs) return published;
  if (bound.log) {
    let latest = staleRefusals.get(bound.log);
    if (!latest) staleRefusals.set(bound.log, latest = new Map());
    if (latest.get(bound.consumer) !== published.generation) {
      latest.set(bound.consumer, published.generation);
      bound.log("tick_read.stale_refused", { consumer: bound.consumer, generation: published.generation,
        age_ms: ageMs, max_age_ms: maxAgeMs,
        ...(published.settledAtMs === undefined ? {} : { read_ms: published.settledAtMs - published.publishedAtMs }) });
    }
  }
  return undefined;
}

/** W1-T9763: what a revisioned read posts: the request, with its plan replaced by that plan's revision. */
export type RevisionedRequest<I, R> = Omit<I, "plan"> & { planRevision: R };

/**
 * W1-T9763 — A TICK READ NEVER POSTS ITS PLAN. {@link startReadPlane} structured-clones every request and posts it,
 * and the worker's answer is cloned back: with the plan in both, one read carried two whole copies (a clone is
 * 37.7 MiB at 4,112 tasks, W1-T9647's census), and the answer's copy stayed published until the next tick. A plan that
 * `revisionOf` names is posted as its revision, and the answer gets the caller's own instance back. Any other plan is
 * posted as before.
 */
export function revisionedRead<P extends object, R, I extends { plan: P }, T extends { plan?: P }>(
  read: (input: I | RevisionedRequest<I, R>) => Promise<ReadGeneration<T>>,
  revisionOf: (plan: P) => R | undefined,
): (input: I) => Promise<ReadGeneration<T>> {
  return async (input) => {
    const planRevision = revisionOf(input.plan);
    if (planRevision === undefined) return read(input);
    const { plan, ...rest } = input;
    const answered = await read({ ...rest, planRevision });
    return Object.freeze({ ...answered, facts: Object.freeze({ ...answered.facts, plan }) });
  };
}

/** The worker's half of {@link revisionedRead}: a revision resolves to this side's own plan, and the answer never
 *  carries a plan back. A request that carries its plan is produced as it always was. */
export function revisionedProducer<P, R, I extends { plan: P }, O extends { plan?: P }>(
  produce: (input: I) => O | Promise<O>,
  resolve: (revision: R) => P | Promise<P>,
): (input: I | RevisionedRequest<I, R>) => Promise<O> {
  return async (input) => {
    if (!("planRevision" in input)) return produce(input);
    const { planRevision, ...rest } = input;
    const answer = { ...await produce({ ...rest, plan: await resolve(planRevision) } as unknown as I) };
    delete answer.plan;
    return answer;
  };
}

/** A published generation answers ONE consumer pass. The daemon publishes one only at the top of
 * a tick, and a dispatch phase can hold the loop for an hour while the full sweep is retriggered;
 * reusing it there disposed merged PRs and dead heads (DAEMON-1791151532775, 2026-10-04). A later
 * pass reads its own generation, unpublished, and so does the first pass once the published one is
 * past {@link TICK_READ_MAX_AGE_MS}. Unpublished, or no plane to read: undefined, which leaves the
 * consumer on its own live read. */
export function onePassPerGeneration<I, T>(
  current: () => ReadGeneration<T> | undefined,
  read: ((input: I) => Promise<ReadGeneration<T>>) | undefined,
  input: () => I,
  bound: Omit<TickReadAgeBound, "consumer"> = {},
): () => Promise<T | undefined> {
  let consumed: number | undefined;
  return async () => {
    const published = current();
    if (published && published.generation !== consumed) {
      consumed = published.generation;
      if (freshReadGeneration(published, { consumer: "full_sweep", ...bound })) return published.facts;
    }
    if (!published || !read) return undefined;
    return (await read(input())).facts;
  };
}

export function startReadPlane<I, O>(options: {
  workerUrl: URL;
  workerInput: unknown;
  inline: (input: I) => O | Promise<O>;
  log: (step: string, extra?: Record<string, unknown>) => void;
  spawn?: () => Worker;
  clock?: Clock;
}): { read(input: I): Promise<ReadGeneration<O>>; stop(): Promise<void> } {
  const now = (options.clock ?? systemClock).now;
  let thread: Worker | undefined;
  let stopped = false;
  let generation = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const pending = new Map<number, { resolve: (facts: O) => void; reject: (error: Error) => void }>();
  const fail = (held: Worker, error: Error): void => {
    if (thread !== held) return;
    thread = undefined;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    void held.terminate();
  };
  const start = (): Worker => {
    if (thread) return thread;
    if (stopped) throw new Error("read plane stopped");
    const workerData = { kind: READ_PLANE_KIND, input: options.workerInput, entry: options.workerUrl.href };
    // tsx's main-thread loader does not install itself in a worker's module loader (W1-T4075).
    // SHARE_ENV: the daemon's hourly GH_TOKEN refresh must reach the worker's reads.
    const held = options.spawn?.() ?? (options.workerUrl.pathname.endsWith(".ts")
      ? new Worker(`const { workerData } = require('node:worker_threads'); import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}).then(({ register }) => { register(); return import(workerData.entry); });`, { eval: true, workerData, env: SHARE_ENV })
      : new Worker(options.workerUrl, { workerData, env: SHARE_ENV }));
    thread = held;
    held.on("message", (reply: { generation: number; facts?: O; error?: string; kind?: string; step?: string; extra?: Record<string, unknown> }) => {
      if (thread !== held) return;
      if (reply.kind === "log" && reply.step) { options.log(reply.step, reply.extra); return; }
      const request = pending.get(reply.generation);
      if (!request || thread !== held) return;
      pending.delete(reply.generation);
      if (reply.error !== undefined) request.reject(new Error(reply.error));
      else request.resolve(reply.facts as O);
    });
    held.once("error", (error) => fail(held, error));
    held.once("exit", (code) => fail(held, new Error(`read plane exited: ${code}`)));
    return held;
  };
  return {
    read(input) {
      const id = ++generation;
      const captured = structuredClone(input);
      const run = async (): Promise<ReadGeneration<O>> => {
        if (stopped) throw new Error("read plane stopped");
        let publishedAtMs = now();
        try {
          const held = start();
          const facts = await new Promise<O>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            held.postMessage({ generation: id, input: captured });
          });
          return freezeReadGeneration({ generation: id, source: "worker", publishedAtMs, settledAtMs: now(), facts });
        } catch (error) {
          pending.delete(id);
          if (stopped) throw error;
          options.log("read_plane.inline", { generation: id, reason: String(error) });
          publishedAtMs = now();
          const facts = await options.inline(captured);
          return freezeReadGeneration({ generation: id, source: "inline", publishedAtMs, settledAtMs: now(), facts });
        }
      };
      const result = tail.then(run);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    async stop() {
      stopped = true;
      const held = thread;
      if (held) {
        fail(held, new Error("read plane stopped"));
        await held.terminate();
      }
    },
  };
}
