import { SHARE_ENV, Worker } from "node:worker_threads";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { clockFromMillisFn, systemClock, type Clock } from "./clock.js";

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
}

/** What one `daemon.loop_lag` row reads about its own interval: the longest spawn and the total sync-spawn time. */
export interface LagIntervalReading {
  top: SyncSpawnEntry | undefined;
  sync_spawn_ms: number;
}

export interface ReadPlaneSample {
  loop_delay_max_ms: number;
  loop_delay_p99_ms: number;
  sync_spawn_ms: number;
  sync_spawn_top: SyncSpawnEntry[];
}

/** The sampler is handed to the daemon unbound. Calling it closes the `daemon.alive` window. `takeLagInterval`
 *  reads and closes a SEPARATE window, one per `consumer` key, so each `daemon.loop_lag` row names only the
 *  spawns made since that consumer's previous reading and `daemon.alive` keeps its own reset (W1-T7745). */
export type ReadPlaneSampler = (() => ReadPlaneSample) & { takeLagInterval(consumer?: string): LagIntervalReading };

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

/** The first frame outside read-plane, `node:` and the shared leaves; `leaf` is the OUTERMOST leaf frame, the one
 *  the caller called. With no frame outside the leaves the caller is that leaf and `callerIsLeaf` says so. */
export function callerFrame(): { caller?: string; leaf?: string; callerIsLeaf?: true } {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  let stack: string;
  try { stack = new Error().stack ?? ""; } finally { Error.stackTraceLimit = limit; }
  let leafLine: string | undefined;
  for (const line of stack.split("\n").slice(1)) {
    if (/read-plane\.[cm]?[jt]s/.test(line) || /node:/.test(line)) continue;
    if (SYNC_SPAWN_LEAF_FRAMES.some((leaf) => leaf.test(line))) { leafLine = line; continue; }
    return { caller: line.trim().slice(0, 200), ...(leafLine === undefined ? {} : { leaf: frameName(leafLine) }) };
  }
  return leafLine === undefined ? {}
    : { caller: leafLine.trim().slice(0, 200), leaf: frameName(leafLine), callerIsLeaf: true };
}

export function startReadPlaneTelemetry(options: { clock?: Clock } = {}): {
  sample: ReadPlaneSampler;
  stop(): void;
} {
  const now = (options.clock ?? clockFromMillisFn(() => performance.now())).now;
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let syncMs = 0;
  let depth = 0;
  let top: SyncSpawnEntry[] = [];
  // One window per lag consumer: what was spawned since its last reading, or since the sampler started for
  // a consumer's first. `sinceStart` is that first reading's window; it is in the set until a consumer claims it.
  const lagWindows = new Map<string, { ms: number; top: SyncSpawnEntry[] }>();
  const sinceStart = { ms: 0, top: [] as SyncSpawnEntry[] };
  const names = ["execFileSync", "execSync", "spawnSync"] as const;
  const originals = names.map((name) => childProcess[name]);
  const record = (via: string, args: unknown[], durationMs: number): void => {
    try {
      const head = String(args[0] ?? "");
      // execSync's argument is a whole shell line that can carry tokens or bodies: keep only its first word.
      const command = (via === "execSync" ? head.trim().split(/\s+/)[0] ?? "" : head).slice(0, ARG_MAX_CHARS);
      const rest = args[1];
      const first = via === "execSync" || !Array.isArray(rest) || rest.length === 0 ? undefined
        : String(rest[0]).slice(0, ARG_MAX_CHARS);
      const { caller, leaf, callerIsLeaf } = callerFrame();
      const entry: SyncSpawnEntry = { via, command, duration_ms: Math.round(durationMs), caller };
      if (leaf !== undefined) entry.leaf = leaf;
      if (callerIsLeaf) entry.caller_is_leaf = true;
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
          if (took >= SYNC_SPAWN_RECORD_MIN_MS) record(name, args, took);
        }
      }
    };
    Object.assign(childProcess, { [name]: wrapper });
  });
  syncBuiltinESMExports();
  let stopped = false;
  const sample = Object.assign((): ReadPlaneSample => {
    const out: ReadPlaneSample = { loop_delay_max_ms: histogram.max / 1e6,
      loop_delay_p99_ms: histogram.count ? histogram.percentile(99) / 1e6 : 0, sync_spawn_ms: syncMs,
      sync_spawn_top: top };
    histogram.reset();
    syncMs = 0;
    top = [];
    return out;
  }, {
    takeLagInterval: (consumer = ""): LagIntervalReading => {
      const window = lagWindows.get(consumer) ?? sinceStart;
      lagWindows.set(consumer, { ms: 0, top: [] });
      return { top: window.top[0], sync_spawn_ms: Math.round(window.ms) };
    },
  });
  return {
    sample,
    stop() {
      if (stopped) return;
      stopped = true;
      histogram.disable();
      names.forEach((name, index) => Object.assign(childProcess, { [name]: originals[index] }));
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
  const ageMs = (bound.clock ?? systemClock).now() - published.publishedAtMs;
  if (ageMs <= maxAgeMs) return published;
  if (bound.log) {
    let latest = staleRefusals.get(bound.log);
    if (!latest) staleRefusals.set(bound.log, latest = new Map());
    if (latest.get(bound.consumer) !== published.generation) {
      latest.set(bound.consumer, published.generation);
      bound.log("tick_read.stale_refused", { consumer: bound.consumer, generation: published.generation,
        age_ms: ageMs, max_age_ms: maxAgeMs });
    }
  }
  return undefined;
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
          return freezeReadGeneration({ generation: id, source: "worker", publishedAtMs, facts });
        } catch (error) {
          pending.delete(id);
          if (stopped) throw error;
          options.log("read_plane.inline", { generation: id, reason: String(error) });
          publishedAtMs = now();
          return freezeReadGeneration({ generation: id, source: "inline", publishedAtMs, facts: await options.inline(captured) });
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
