/**
 * lib/worker-heaps.ts — W1-T5355, W1-T5480: the heap of every worker thread a thread spawns, named
 * by its spawn site, for serve's `serve.memory` row (serve-memory.ts re-exports all of it).
 *
 * A LEAF: it imports nothing from src, so the read-model worker, which answers for the threads IT
 * spawns ({@link answerThreadHeaps}), can import it without a cycle through serve's own modules.
 *
 * W1-T9403: each part carries its USED heap (`used_bytes`) beside its committed heap (`bytes`), and a
 * thread whose parent knows what it holds (a views lane's board projections) carries `holds`.
 *
 * FALSIFIERS: test/serve-memory-names-where-rss-lives.test.ts,
 * test/serve-memory-sizes-the-threads-the-read-model-worker-spawns.test.ts,
 * test/serve-memory-names-what-the-heavy-view-lane-holds.test.ts.
 */

import diagnosticsChannel from "node:diagnostics_channel";
import { basename } from "node:path";
import type { Worker } from "node:worker_threads";

/** What a thread's parent says the thread holds, by holder (`board:<instance>`): entries and bytes kept. */
export type ThreadHolds = Record<string, { entries: number; bytes: number }>;

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
/** `<module>:<function>` of the first frame outside node and this module: the call that spawned the thread. */
export function spawnSite(stack: string | undefined): string {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const frame = /^\s*at (?:(.+?) \()?(.+?):\d+:\d+\)?$/.exec(line);
    const module = frame ? basename(frame[2]).replace(/\.[cm]?[jt]s$/, "") : "";
    // A source-mapped frame and import.meta.url can disagree on path and extension; the module name cannot.
    if (!frame || frame[2].startsWith("node:") || module === SELF_MODULE) continue;
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
    const site: { stack?: string } = {};
    Error.captureStackTrace(site);
    const id = thread.threadId; // an exited Worker reads threadId -1, so the key is taken now
    live.set(id, { kind: spawnSite(site.stack), thread });
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

async function threadHeap(thread: WorkerThread, timeoutMs: number): Promise<ThreadHeap> {
  const unsized = (why: string): string => `thread ${thread.threadId} unsized: ${why}`;
  if (typeof thread.getHeapStatistics !== "function") return { error: unsized("this runtime has no worker.getHeapStatistics()") };
  try {
    const read = async (): Promise<ThreadHeap> => {
      const heap = await thread.getHeapStatistics();
      const bytes = heap.total_heap_size + heap.external_memory;
      // A runtime that does not report the used heap leaves it unknown: absent, never NaN or zero.
      return Number.isFinite(heap.used_heap_size) ? { bytes, used_bytes: heap.used_heap_size + heap.external_memory } : { bytes };
    };
    return await within(read, timeoutMs, { error: unsized(`no heap statistics within ${timeoutMs}ms`) });
  } catch (e) {
    return { error: unsized(String((e as Error)?.message ?? e)) };
  }
}

/** Each thread that answers for the threads it spawned, keyed by its Worker: dropped with it. */
const nestedHeapReaders = new WeakMap<WorkerThread, (timeoutMs: number) => Promise<WorkerHeapReading[]>>();

/**
 * Serve's side of a thread that spawns threads of its own: {@link readWorkerHeaps} posts it a
 * {@link THREAD_HEAPS_REQUEST} beside its own heap read. Returns the thread's message filter: true
 * for an answer, which it settles. An unanswered request waits for its answer or the Worker's end.
 */
export function askNestedThreadHeaps(thread: WorkerThread & Pick<Worker, "postMessage">): (msg: unknown) => boolean {
  const waiting = new Map<number, (readings: WorkerHeapReading[]) => void>();
  let asked = 0;
  nestedHeapReaders.set(thread, (timeoutMs) => new Promise((resolve) => {
    asked += 1;
    waiting.set(asked, resolve);
    thread.postMessage({ type: THREAD_HEAPS_REQUEST, id: asked, timeoutMs });
  }));
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
  holds?: (threadId: number) => ThreadHolds | undefined,
): boolean {
  const request = msg as { type?: unknown; id?: number; timeoutMs?: number } | undefined;
  if (request?.type !== THREAD_HEAPS_REQUEST) return false;
  const timeoutMs = Math.floor((request.timeoutMs ?? WORKER_HEAP_TIMEOUT_MS) / 2);
  void readWorkerHeaps(book.live(), timeoutMs, holds).then((readings) => port.postMessage({ type: THREAD_HEAPS_ANSWER, id: request.id, readings }));
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
  return within(() => ask(timeoutMs), timeoutMs, [unanswered]);
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
  holds?: (threadId: number) => ThreadHolds | undefined,
): Promise<WorkerHeapReading[]> {
  const [heaps, nested] = await Promise.all([
    Promise.all(workers.map(async ({ kind, thread }) => ({ kind, threadId: thread.threadId, ...(await threadHeap(thread, timeoutMs)) }))),
    Promise.all(workers.map((worker) => nestedHeaps(worker, timeoutMs))),
  ]);
  const own = heaps.map((heap): WorkerHeapReading => {
    const bytes = "bytes" in heap ? heap.bytes : 0;
    const used = "used_bytes" in heap && heap.used_bytes !== undefined ? { used_bytes: heap.used_bytes } : {};
    const held = holds?.(heap.threadId);
    return {
      name: `${WORKER_HEAP_PREFIX}${heap.kind}`, kind: "worker-heap", entries: 1, bytes, ...used,
      parts: { [`thread-${heap.threadId}`]: { entries: 1, bytes, ...used, ...(held ? { holds: held } : {}) } }, ...("error" in heap ? { error: heap.error } : {}),
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
