/**
 * lib/worker-heaps.ts — W1-T5355, W1-T5480: the heap of every worker thread a thread spawns, named
 * by its spawn site, for serve's `serve.memory` row (serve-memory.ts re-exports all of it).
 *
 * A LEAF apart from the Clock port, so the read-model worker, which answers for the threads IT
 * spawns ({@link answerThreadHeaps}), can import it without a cycle through serve's own modules.
 *
 * W1-T9403: each part carries its USED heap (`used_bytes`) beside its committed heap (`bytes`), and a
 * thread whose parent knows what it holds (a views lane's board projections) carries `holds`.
 *
 * FALSIFIERS: test/serve-memory-names-where-rss-lives.test.ts,
 * test/serve-memory-sizes-the-threads-the-read-model-worker-spawns.test.ts,
 * test/serve-memory-names-what-the-heavy-view-lane-holds.test.ts; a bundle-started worker's threads (#11859):
 * test/serve-starts-its-workers-from-current-worker-bundles.test.ts.
 */

import diagnosticsChannel from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import { systemClock, type Clock } from "./clock.js";
import { rawCallSites } from "./raw-call-sites.js";

/** What a thread's parent says the thread holds, by holder (`board:<instance>`): entries and bytes kept. */
export type ThreadHolds = Record<string, { entries: number; bytes?: number; unsized?: string; unit?: string; bytes_basis?: string }>;

/** An attribution is a different observation from the later heap sample. */
export interface ThreadHoldsSnapshot { holds: ThreadHolds; observedAt?: number }
type ThreadHoldsReader = (threadId: number) => ThreadHolds | ThreadHoldsSnapshot | undefined;

/** Keeps counters only, never the measured value. Payload estimates are not exclusive V8 retained sizes. */
export function createViewHoldBook() {
  const holds: ThreadHolds = {};
  return {
    account(name: string, value: unknown, entries: number, unit = "entries"): void {
      try {
        const text = JSON.stringify(value, (_key, item: unknown) => item instanceof Map ? [...item] : item instanceof Set ? [...item] : item);
        if (text === undefined) throw new Error("payload has no JSON representation");
        holds[name] = { entries, bytes: Buffer.byteLength(text), unit, bytes_basis: "serialized-payload-estimate-not-exclusive-v8" };
      } catch {
        const reason = "retained payload cannot be serialized safely";
        holds[name] = { entries, unsized: reason, unit };
      }
    },
    known(name: string, entries: number, bytes: number, unit = "rows"): void {
      holds[name] = !Number.isFinite(bytes) || bytes < 0 || entries > 0 && bytes === 0
        ? { entries, unsized: "non-empty retained state has no valid accounted payload size", unit }
        : { entries, bytes, unit, bytes_basis: "insertion-accounted-payload-not-exclusive-v8" };
    },
    unsized(name: string, entries: number, reason: string, unit = "entries"): void {
      holds[name] = { entries, unsized: reason, unit };
    },
    forget(name: string): void { delete holds[name]; },
    read: (): ThreadHolds => ({ ...holds }),
  };
}

/**
 * One thread of a reading. `bytes` is its committed heap plus external memory; `used_bytes` its used heap
 * plus external memory, absent (never zero) when the thread could not be read; `holds` what its parent
 * says it holds, absent when nothing was reported.
 */
export interface WorkerHeapPart {
  entries: number;
  bytes: number;
  used_bytes?: number;
  holds?: ThreadHolds;
  holds_age_ms?: number;
  holds_age_reason?: string;
  /** Arithmetic residual of used heap and named payload estimates, NOT an exclusive heap census. */
  unattributed_used_bytes?: number;
  unattributed_used_reason?: string;
  unattributed_used_basis?: string;
}

/** One `worker-heap:<kind>` line in the `serve.memory` row, with a part per thread; `error` names a thread left unsized. */
export interface WorkerHeapReading {
  name: string;
  kind: "worker-heap";
  entries: number;
  bytes: number;
  /** The parts' `used_bytes`, summed like `bytes`; absent when no part was read. */
  used_bytes?: number;
  parts?: Record<string, WorkerHeapPart>;
  error?: string;
}

/** Node's own channel: published synchronously inside `new Worker(...)`, on the spawning thread. */
export const WORKER_THREADS_CHANNEL = "worker_threads";
export const WORKER_HEAP_PREFIX = "worker-heap:";
/** BACKSTOP: a thread that has not answered its heap read by now is named unsized, so a busy thread never stalls the sample. */
export const WORKER_HEAP_TIMEOUT_MS = 5_000;

/** What a parent posts to a thread it spawned, and that thread's answer: the heaps of ITS threads. */
export const THREAD_HEAPS_REQUEST = "thread-heaps?";
export const THREAD_HEAPS_ANSWER = "thread-heaps";
export interface ThreadHeapsAnswer {
  type: typeof THREAD_HEAPS_ANSWER;
  id: number;
  readings: WorkerHeapReading[];
}

/** The slice of a `node:worker_threads` Worker a heap read needs. */
export type WorkerThread = Pick<Worker, "threadId" | "getHeapStatistics" | "once">;
/** A live thread, and where it was spawned: `<module>:<function>` of the frame that called `new Worker`. */
export interface TrackedWorker {
  kind: string;
  thread: WorkerThread;
}

const SELF_MODULE = "worker-heaps";
/** W1-T9370: startWorker constructs serve's workers, so a frame of its module is never the site that asked for one. */
const SPAWN_HELPER_MODULE = "child-entry-argv";
const moduleName = (path: string): string => basename(path).replace(/\.[cm]?[jt]s$/, "");
/**
 * The line esbuild heads each module's code with in a bundle (`// src/lib/read-model-worker.ts`). W1-T8777's worker
 * bundles carry no source map, and every frame inside one names the bundle's file, so the header is what says whose
 * code a bundle line is.
 */
const BUNDLE_MODULE_HEADER = /^\/\/ (\S+\.[cm]?[jt]sx?)$/;
/** Each file's module headers as `[line, module]`, ascending, read once per file; `null` for a file that holds none. */
const bundleHeaders = new Map<string, Array<[number, string]> | null>();
/** The source module a JS file's 1-based `line` lies in when the file is a bundle; undefined when it is not one. */
function bundledModule(file: string, line: number): string | undefined {
  if (!/\.[cm]?js$/.test(file)) return undefined;
  let headers = bundleHeaders.get(file);
  if (headers === undefined) {
    const found: Array<[number, string]> = [];
    try {
      readFileSync(file.startsWith("file:") ? fileURLToPath(file) : file, "utf8").split("\n").forEach((text, at) => {
        const source = BUNDLE_MODULE_HEADER.exec(text)?.[1];
        if (source) found.push([at + 1, moduleName(source)]);
      });
    } catch {
      // A file that cannot be read is no bundle this thread can see into: its frame keeps the file's own name.
    }
    headers = found.length > 0 ? found : null;
    bundleHeaders.set(file, headers);
  }
  return headers?.findLast(([start]) => start <= line)?.[1];
}

/**
 * `<module>:<function>` of the first frame outside node, this module and the spawn helper: the call that spawned the
 * thread. Raw runtime frames use the unmapped module/function; a bundle's existing module header
 * still names the module its runtime line belongs to. The public string/undefined parser is unchanged.
 */
export function spawnSite(stack: string | undefined): string {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const frame = /^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line);
    const module = frame ? bundledModule(frame[2], Number(frame[3])) ?? moduleName(frame[2]) : "";
    // A source-mapped frame and import.meta.url can disagree on path and extension; the module name cannot.
    if (!frame || frame[2].startsWith("node:") || module === SELF_MODULE || module === SPAWN_HELPER_MODULE) continue;
    return `${module}:${frame[1] ?? "<module>"}`;
  }
  return "unknown";
}

/**
 * Every worker thread THIS thread spawns from now on, from Node's `worker_threads` channel. A thread
 * spawned inside another thread publishes on that thread's channel: it is sized only when its parent
 * answers for it ({@link askNestedThreadHeaps}).
 */
export function trackWorkerThreads(channel = diagnosticsChannel.channel(WORKER_THREADS_CHANNEL)): { live(): TrackedWorker[]; stop(): void } {
  const live = new Map<number, TrackedWorker>();
  const onSpawn = (message: unknown): void => {
    const thread = (message as { worker?: WorkerThread }).worker;
    if (!thread) return;
    // Preserve the ambient worker-frame budget: only the shared helper adds a frame. Invalid
    // nonnumeric limits previously captured no stack, so they still produce the literal unknown.
    const limit = Error.stackTraceLimit;
    const sites = rawCallSites(typeof limit === "number" ? limit + 1 : 0);
    const id = thread.threadId; // an exited Worker reads threadId -1, so the key is taken now
    // String(CallSite) uses V8's raw clause, not Node's mapped Error formatter. Retain only the
    // primitive kind, never CallSite objects (which can reference functions and receivers).
    live.set(id, { kind: spawnSite(`Error\n${sites.map(site => `    at ${String(site)}`).join("\n")}`), thread });
    thread.once("exit", () => void live.delete(id));
  };
  channel.subscribe(onSpawn);
  return { live: () => [...live.values()], stop: () => void channel.unsubscribe(onSpawn) };
}

let processWorkerThreads: ReturnType<typeof trackWorkerThreads> | undefined;
/** The one book for this thread, subscribed on first call: serve calls it before it spawns anything. */
export function workerThreads(): ReturnType<typeof trackWorkerThreads> {
  return (processWorkerThreads ??= trackWorkerThreads());
}

/** `read`'s value, or `late` once `timeoutMs` passes first. The timer is unref'd: a pending read never holds serve open. */
async function within<T>(read: () => Promise<T>, timeoutMs: number, late: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([read(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

type ThreadHeap = { bytes: number; used_bytes?: number } | { error: string };

/** A caller's deadline never cancels a native heap request. Keep one until it actually settles. */
interface ThreadHeapRequest { exited: boolean; pending?: Promise<ThreadHeap> }
const threadHeapRequests = new WeakMap<WorkerThread, ThreadHeapRequest>();

async function threadHeap(thread: WorkerThread, timeoutMs: number): Promise<ThreadHeap> {
  const id = thread.threadId;
  const unsized = (why: string): string => `thread ${id} unsized: ${why}`;
  if (typeof thread.getHeapStatistics !== "function") return { error: unsized("this runtime has no worker.getHeapStatistics()") };
  try {
    if (id < 0) return { error: unsized("worker exited") };
    let request = threadHeapRequests.get(thread);
    if (!request) {
      const created: ThreadHeapRequest = { exited: false };
      thread.once("exit", () => { created.exited = true; });
      threadHeapRequests.set(thread, created);
      request = created;
    }
    if (request.exited) return { error: unsized("worker exited") };
    // Later samples report unknown at once: even attaching another timeout race would retain another waiter.
    if (request.pending) return { error: unsized("heap statistics request still pending") };
    const read = async (): Promise<ThreadHeap> => {
      const heap = await thread.getHeapStatistics();
      if (request.exited) return { error: unsized("worker exited") };
      const bytes = heap.total_heap_size + heap.external_memory;
      // A runtime that does not report the used heap leaves it unknown: absent, never NaN or zero.
      return Number.isFinite(heap.used_heap_size) ? { bytes, used_bytes: heap.used_heap_size + heap.external_memory } : { bytes };
    };
    request.pending = read().finally(() => { request.pending = undefined; });
    return await within(() => request.pending!, timeoutMs, { error: unsized(`no heap statistics within ${timeoutMs}ms`) });
  } catch (e) {
    return { error: unsized(String((e as Error)?.message ?? e)) };
  }
}

/** Each thread that answers for the threads it spawned, keyed by its Worker: dropped with it. */
const nestedHeapReaders = new WeakMap<WorkerThread, (timeoutMs: number, unanswered: WorkerHeapReading[]) => Promise<WorkerHeapReading[]>>();

/**
 * Serve's side of a thread that spawns threads of its own: {@link readWorkerHeaps} posts it a
 * {@link THREAD_HEAPS_REQUEST} beside its own heap read. Returns the thread's message filter: true
 * for an answer, which it settles. Every request releases its resolver on answer, timeout or post failure.
 */
export function askNestedThreadHeaps(thread: WorkerThread & Pick<Worker, "postMessage">): (msg: unknown) => boolean {
  const waiting = new Map<number, (readings: WorkerHeapReading[]) => void>();
  let asked = 0;
  nestedHeapReaders.set(thread, async (timeoutMs, unanswered) => {
    const id = ++asked;
    try {
      return await within(() => new Promise<WorkerHeapReading[]>((resolve) => {
        waiting.set(id, resolve);
        thread.postMessage({ type: THREAD_HEAPS_REQUEST, id, timeoutMs });
      }), timeoutMs, unanswered);
    } finally {
      waiting.delete(id);
    }
  });
  return (msg) => {
    const answer = msg as Partial<ThreadHeapsAnswer> | undefined;
    if (answer?.type !== THREAD_HEAPS_ANSWER || answer.id === undefined) return false;
    waiting.get(answer.id)?.(answer.readings ?? []);
    waiting.delete(answer.id);
    return true;
  };
}

/**
 * The spawned side: answers a {@link THREAD_HEAPS_REQUEST} with `book`'s heaps, read in half the
 * asker's budget so a stuck grandchild is named by this answer, not lost to the asker's timeout.
 * `holds` names what a thread it spawned holds (W1-T9403). True when `msg` was one.
 */
export function answerThreadHeaps(
  port: { postMessage(value: unknown): void },
  msg: unknown,
  book: Pick<ReturnType<typeof trackWorkerThreads>, "live"> = workerThreads(),
  holds?: ThreadHoldsReader,
  clock: Clock = systemClock,
): boolean {
  const request = msg as { type?: unknown; id?: number; timeoutMs?: number } | undefined;
  if (request?.type !== THREAD_HEAPS_REQUEST) return false;
  const timeoutMs = Math.floor((request.timeoutMs ?? WORKER_HEAP_TIMEOUT_MS) / 2);
  void readWorkerHeaps(book.live(), timeoutMs, holds, clock).then((readings) => port.postMessage({ type: THREAD_HEAPS_ANSWER, id: request.id, readings }));
  return true;
}

/** What `thread` says of the threads it spawned; one that does not answer in time is named unsized, never read as none. */
async function nestedHeaps({ kind, thread }: TrackedWorker, timeoutMs: number): Promise<WorkerHeapReading[]> {
  const ask = nestedHeapReaders.get(thread);
  if (!ask) return [];
  const unanswered: WorkerHeapReading = {
    name: `${WORKER_HEAP_PREFIX}inside:${kind}`, kind: "worker-heap", entries: 0, bytes: 0,
    error: `thread ${thread.threadId}'s own threads unsized: no answer within ${timeoutMs}ms`,
  };
  return ask(timeoutMs, [unanswered]);
}

/**
 * Each live thread's committed heap plus its external memory (`bytes`), and its used heap plus its
 * external memory (`used_bytes`), grouped as one `worker-heap:<kind>` reading per spawn site with a
 * part per thread. A thread that cannot be read is named in `error`, counts 0 bytes and has no
 * `used_bytes`, so its heap stays in `unattributed_bytes` rather than vanishing. `holds` names what a
 * thread holds, on its part. The threads a tracked thread spawned join under their own spawn site, as
 * that thread answered for them.
 */
export async function readWorkerHeaps(
  workers: readonly TrackedWorker[],
  timeoutMs = WORKER_HEAP_TIMEOUT_MS,
  holds?: ThreadHoldsReader,
  clock: Clock = systemClock,
): Promise<WorkerHeapReading[]> {
  const [heaps, nested] = await Promise.all([
    Promise.all(workers.map(async ({ kind, thread }) => ({ kind, threadId: thread.threadId, ...(await threadHeap(thread, timeoutMs)) }))),
    Promise.all(workers.map((worker) => nestedHeaps(worker, timeoutMs))),
  ]);
  const own = heaps.map((heap): WorkerHeapReading => {
    const bytes = "bytes" in heap ? heap.bytes : 0;
    const used = "used_bytes" in heap && heap.used_bytes !== undefined ? { used_bytes: heap.used_bytes } : {};
    const observation = holds?.(heap.threadId);
    const snapshot = observation && Object.hasOwn(observation, "holds") && Object.hasOwn(observation, "observedAt")
      && ((observation as ThreadHoldsSnapshot).observedAt === undefined || typeof (observation as ThreadHoldsSnapshot).observedAt === "number")
      ? observation as ThreadHoldsSnapshot : undefined;
    const held = snapshot?.holds ?? observation as ThreadHolds | undefined;
    const attribution: Partial<WorkerHeapPart> = {};
    if (held) {
      attribution.holds = held;
      const age = snapshot?.observedAt === undefined ? undefined : clock.now() - snapshot.observedAt;
      if (age !== undefined && Number.isFinite(age) && age >= 0) attribution.holds_age_ms = age;
      else attribution.holds_age_reason = "holder report time unavailable or ahead of sample clock";
      if ("used_bytes" in heap && heap.used_bytes !== undefined) {
        const named = Object.values(held).reduce((sum, hold) => sum + (typeof hold.bytes === "number" && Number.isFinite(hold.bytes) && hold.bytes >= 0 ? hold.bytes : 0), 0);
        attribution.unattributed_used_bytes = heap.used_bytes - named;
        attribution.unattributed_used_basis = "used-heap-less-named-payload-estimates-not-exclusive-v8";
        if (Object.values(held).some(hold => hold.bytes === undefined)) attribution.unattributed_used_reason = "partial attribution: named unsized holders remain; payload estimates may overlap";
      } else attribution.unattributed_used_reason = "used heap unavailable; residual not measured";
    }
    return {
      name: `${WORKER_HEAP_PREFIX}${heap.kind}`, kind: "worker-heap", entries: 1, bytes, ...used,
      parts: { [`thread-${heap.threadId}`]: { entries: 1, bytes, ...used, ...attribution } }, ...("error" in heap ? { error: heap.error } : {}),
    };
  });
  const readings = new Map<string, WorkerHeapReading & { parts: Record<string, WorkerHeapPart> }>();
  for (const part of [...own, ...nested.flat()]) {
    const reading = readings.get(part.name) ?? { name: part.name, kind: "worker-heap" as const, entries: 0, bytes: 0, parts: {} };
    reading.entries += part.entries;
    reading.bytes += part.bytes;
    if (part.used_bytes !== undefined) reading.used_bytes = (reading.used_bytes ?? 0) + part.used_bytes;
    Object.assign(reading.parts, part.parts);
    if (part.error) reading.error = reading.error ? `${reading.error}; ${part.error}` : part.error;
    readings.set(part.name, reading);
  }
  return [...readings.values()];
}
