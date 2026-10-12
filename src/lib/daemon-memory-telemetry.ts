/**
 * lib/daemon-memory-telemetry.ts — W1-T6782: the daemon heartbeat says what its memory is.
 *
 * OBSERVED 2026-10-09: the core daemon's main process held 4-5 GB (rss + swap) minutes after
 * boot, worker children pushed the container into memory.max thousands of times, and nothing on
 * the ledger could tell a fixed baseline from retained state, uncollected garbage or a worker
 * peak. V8 numbers were written only on the heap-pressure exit row. serve has this telemetry
 * (serve-memory.ts, W1-T5355); the daemon did not.
 *
 * {@link sampleDaemonMemory} returns FLAT fields that `startInFlightTicker` (daemon.ts) spreads
 * into the EXISTING `daemon.alive` row through the `readMemoryTelemetry` dep. No new timer, row or
 * step: the cadence is the ticker's pollIntervalMs.
 *
 * PASSIVE AND PAYLOAD-FREE. It reads `process.memoryUsage()`, V8's heap limit through the daemon's
 * existing `v8HeapStatistics` seam, one line of /proc/self/status and four small cgroup v2 files.
 * It never dumps the heap, opens a debugger session, forces a collection or changes a heap limit,
 * and nothing reads these fields to decide anything.
 *
 * UNKNOWN IS NEVER ZERO. A file that cannot be read or parsed leaves its fields ABSENT and names
 * itself in `mem_cgroup` / `mem_proc` as `unreadable:<reason>`. A sampler that throws outright is
 * caught by the heartbeat itself (`mem_telemetry: "error:<message>"`), never by a zero here.
 *
 * W1-T7092: the daemon's worker threads are V8 isolates of their own that `process.memoryUsage()`
 * does not count. {@link workerHeapReadings} reports every live thread in worker-heaps.ts's registry
 * by creation site, role, thread id and daemon generation, with the same heap figures as the main
 * isolate and an explicit state and age, so what no isolate accounts for is a qualified,
 * UNATTRIBUTED residual rather than a guess. rss and swap stay separate fields. The heartbeat never
 * waits on it: a request round starts AFTER a row is written and later rows carry the answers.
 *
 * FALSIFIERS: test/the-daemon-heartbeat-says-what-its-memory-is.test.ts,
 * test/the-daemon-heartbeat-names-its-worker-thread-heaps.test.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { systemClock } from "./clock.js";
import { WORKER_HEAP_TIMEOUT_MS, type TrackedWorker, type WorkerThread } from "./worker-heaps.js";

/** The heartbeat fields. Every `_bytes` field is an integer byte count. */
export interface DaemonMemoryFields {
  // process
  rss_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
  heap_size_limit_bytes: number;
  /** /proc/self/status VmSwap: THIS process's pages in swap. */
  vm_swap_bytes?: number;
  /** Present only when /proc/self/status could not be read or carried no VmSwap line. */
  mem_proc?: string;
  // cgroup v2 — the container's numbers, not this process's
  /** memory.current: everything charged to the container — every process's anon and page cache
   *  plus kernel memory, not this process alone. */
  cg_memory_current_bytes?: number;
  /** memory.swap.current: the container's pages in swap. */
  cg_swap_current_bytes?: number;
  /** memory.max: the container's hard limit; null when the file reads `max` (unlimited). */
  cg_memory_max_bytes?: number | null;
  /** memory.stat `anon`: anonymous memory (heaps, stacks) charged to the container. */
  cg_anon_bytes?: number;
  /** memory.stat `file`: page cache charged to the container. */
  cg_file_bytes?: number;
  /** memory.events `high`, cumulative since the cgroup was created: times usage exceeded
   *  memory.high and the container was throttled into reclaim. */
  cg_events_high?: number;
  /** memory.events `max`, cumulative: times usage was about to exceed memory.max and reclaim ran. */
  cg_events_max?: number;
  /** memory.events `oom`, cumulative: times an allocation was about to fail at the limit. */
  cg_events_oom?: number;
  /** memory.events `oom_kill`, cumulative: processes the OOM killer killed in the container. */
  cg_events_oom_kill?: number;
  /** Present only when some cgroup file could not be read or parsed: `unreadable:<reason>`. */
  mem_cgroup?: string;
  // workload
  active_workers: number;
  in_flight_reviews: number;
  // identity
  uptime_s: number;
  /** The source tree sha this daemon process loaded at boot, abbreviated to {@link BOOT_SHA_CHARS} hex —
   *  a prefix of daemon.boot's full `boot_head_sha`, so it names the generation without a join. Absent
   *  when the sha could not be read. */
  boot_head_sha?: string;
  /** This sampler's own wall time, microseconds: the overhead is measured, not asserted. */
  telemetry_sample_us: number;
}

/** Everything the sampler reads, injectable so a test drives fixture files (Rule 18). */
export interface DaemonMemorySources {
  /** The daemon's existing V8 seam (`v8HeapStatistics` in daemon.ts). */
  heapStatistics: () => { heap_size_limit: number };
  workload: () => { active_workers: number; in_flight_reviews: number };
  bootHeadSha: string | undefined;
  memoryUsage?: () => NodeJS.MemoryUsage;
  readFile?: (path: string) => string;
  cgroupRoot?: string;
  procStatusPath?: string;
  uptimeSeconds?: () => number;
  nowNs?: () => bigint;
}

const REASON_MAX_CHARS = 80;
/** Enough hex to name a generation unambiguously while keeping the row inside its byte budget. */
export const BOOT_SHA_CHARS = 12;

function errorCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code ?? String((e as Error)?.message ?? e).slice(0, REASON_MAX_CHARS);
}

/** A non-negative integer, or undefined for anything else — never a zero standing in for "unknown". */
function parseCount(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/.test(text.trim())) return undefined;
  const n = Number(text.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

/** `name value` lines (memory.stat, memory.events) → the requested keys that parsed. */
function keyed(text: string, keys: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (!keys.includes(key)) continue;
    const n = parseCount(value);
    if (n !== undefined) out.set(key, n);
  }
  return out;
}

type CgroupFields = Pick<DaemonMemoryFields,
  "cg_memory_current_bytes" | "cg_swap_current_bytes" | "cg_memory_max_bytes" | "cg_anon_bytes" | "cg_file_bytes" |
  "cg_events_high" | "cg_events_max" | "cg_events_oom" | "cg_events_oom_kill" | "mem_cgroup">;

/** The cgroup v2 half. Each file stands alone: a readable file yields its fields, an unreadable or
 *  unparseable one yields none and is named in `mem_cgroup`. */
export function sampleCgroupMemory(read: (path: string) => string, root: string): CgroupFields {
  const out: CgroupFields = {};
  const failed: string[] = [];
  const readOne = (file: string): string | undefined => {
    try {
      return read(join(root, file));
    } catch (e) {
      // Reason: the failure is carried in `failed` and surfaces as `mem_cgroup`, so this file's
      // fields stay absent rather than reading as zero.
      failed.push(`${file}:${errorCode(e)}`);
      return undefined;
    }
  };
  const single = (file: string, assign: (n: number) => void): void => {
    const text = readOne(file);
    if (text === undefined) return;
    const n = parseCount(text);
    if (n === undefined) failed.push(`${file}:unparseable`);
    else assign(n);
  };
  single("memory.current", (n) => (out.cg_memory_current_bytes = n));
  single("memory.swap.current", (n) => (out.cg_swap_current_bytes = n));
  const max = readOne("memory.max");
  if (max !== undefined) {
    if (max.trim() === "max") out.cg_memory_max_bytes = null;
    else {
      const n = parseCount(max);
      if (n === undefined) failed.push("memory.max:unparseable");
      else out.cg_memory_max_bytes = n;
    }
  }
  const stat = readOne("memory.stat");
  if (stat !== undefined) {
    const got = keyed(stat, ["anon", "file"]);
    if (got.has("anon")) out.cg_anon_bytes = got.get("anon");
    if (got.has("file")) out.cg_file_bytes = got.get("file");
    if (got.size < 2) failed.push("memory.stat:unparseable");
  }
  const events = readOne("memory.events");
  if (events !== undefined) {
    const got = keyed(events, ["high", "max", "oom", "oom_kill"]);
    if (got.has("high")) out.cg_events_high = got.get("high");
    if (got.has("max")) out.cg_events_max = got.get("max");
    if (got.has("oom")) out.cg_events_oom = got.get("oom");
    if (got.has("oom_kill")) out.cg_events_oom_kill = got.get("oom_kill");
    if (got.size < 4) failed.push("memory.events:unparseable");
  }
  if (failed.length > 0) out.mem_cgroup = `unreadable:${failed.join(",")}`.slice(0, REASON_MAX_CHARS * 2);
  return out;
}

/** /proc/self/status VmSwap in bytes, or the reason it is unknown. */
function sampleProcSwap(read: (path: string) => string, path: string): Pick<DaemonMemoryFields, "vm_swap_bytes" | "mem_proc"> {
  let status: string;
  try {
    status = read(path);
  } catch (e) {
    return { mem_proc: `unreadable:${errorCode(e)}` };
  }
  const kb = /^VmSwap:\s+(\d+)\s+kB/m.exec(status)?.[1];
  return kb === undefined ? { mem_proc: "unreadable:no-vmswap" } : { vm_swap_bytes: Number(kb) * 1024 };
}

/** One passive memory sample for the `daemon.alive` heartbeat. */
export function sampleDaemonMemory(sources: DaemonMemorySources): DaemonMemoryFields {
  const nowNs = sources.nowNs ?? (() => process.hrtime.bigint());
  const startNs = nowNs();
  const read = sources.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const usage = (sources.memoryUsage ?? (() => process.memoryUsage()))();
  const workload = sources.workload();
  const fields: Omit<DaemonMemoryFields, "telemetry_sample_us"> = {
    rss_bytes: usage.rss,
    heap_used_bytes: usage.heapUsed,
    heap_total_bytes: usage.heapTotal,
    external_bytes: usage.external,
    array_buffers_bytes: usage.arrayBuffers,
    heap_size_limit_bytes: sources.heapStatistics().heap_size_limit,
    ...sampleProcSwap(read, sources.procStatusPath ?? "/proc/self/status"),
    ...sampleCgroupMemory(read, sources.cgroupRoot ?? "/sys/fs/cgroup"),
    active_workers: workload.active_workers,
    in_flight_reviews: workload.in_flight_reviews,
    uptime_s: Math.round((sources.uptimeSeconds ?? (() => process.uptime()))()),
    ...(sources.bootHeadSha ? { boot_head_sha: sources.bootHeadSha.slice(0, BOOT_SHA_CHARS) } : {}),
  };
  return { ...fields, telemetry_sample_us: Number((nowNs() - startNs) / 1000n) };
}

/** The six figures every isolate reports the same way, from V8's own `getHeapStatistics()`. `total_heap_bytes`
 *  is the COMMITTED heap and `physical_heap_bytes` the part V8 counts as backed by memory; neither says whether a
 *  page is resident or swapped, so none of them is a share of `rss_bytes`. */
export interface IsolateHeap {
  used_heap_bytes: number;
  total_heap_bytes: number;
  physical_heap_bytes: number;
  external_bytes: number;
  malloced_bytes: number;
  heap_limit_bytes: number;
}

/** What `getHeapStatistics()` returns, on the main thread and from a Worker alike. */
export interface HeapStatistics {
  used_heap_size: number;
  total_heap_size: number;
  total_physical_size: number;
  external_memory: number;
  malloced_memory: number;
  heap_size_limit: number;
}

/** A thread's state on the row; none of them is ever a zero reading.
 *  - `fresh`: it answered the most recent request round;
 *  - `stale`: its newest answer is from an earlier round (its figures carry their age);
 *  - `pending`: its first request is still inside the timeout;
 *  - `unanswered`: its one request has waited longer than the timeout (`outstanding_ms`);
 *  - `exited`: it exited since the last row (reported once, then dropped). */
export type ThreadHeapState = "fresh" | "stale" | "pending" | "unanswered" | "exited";

export interface WorkerHeapEntry extends Partial<IsolateHeap> {
  /** `<module>:<function>` of the frame that called `new Worker` (worker-heaps.ts `spawnSite`). */
  site: string;
  /** {@link threadRole}: a fixed map of the daemon's known spawn sites, or `unmapped`. */
  role: string;
  thread_id: number;
  state: ThreadHeapState;
  /** Age of the figures carried, when any reading exists. */
  age_ms?: number;
  /** How long the thread's ONE unresolved request has waited. */
  outstanding_ms?: number;
  /** Why the newest request failed, when it did. */
  error?: string;
  exit_code?: number;
  exited_ago_ms?: number;
}

/** The `daemon.alive` fields the worker-thread read adds. */
export interface WorkerHeapFields {
  worker_heaps?: {
    /** The daemon generation the threads belong to: its `run_id`. Thread ids are unique within it. */
    generation?: string;
    main?: IsolateHeap & { role: "main"; thread_id: 0 };
    threads: WorkerHeapEntry[];
    /** Answers that arrived after their thread exited, dropped rather than attributed. */
    late_dropped?: number;
  };
  /** APPROXIMATE, possibly negative: rss_bytes - the physical heap of every reported isolate - external_bytes.
   *  Heap sizes are committed pages whose residency is unknown, so this is not a partition of rss; it is what
   *  no isolate's heap accounts for, and it is never called native memory. */
  unattributed_bytes_approx?: number;
  /** Why `unattributed_bytes_approx` is absent: a thread not `fresh`, or a missing input. */
  unattributed_omitted?: string;
  /** `pending:first-read` before any request round, or `error:<reason>` when the thread list could not be read. */
  mem_worker_heaps?: string;
}

/** The main-process figures the residual needs: this tick's {@link sampleDaemonMemory}. */
export type ResidualInputs = Partial<Pick<DaemonMemoryFields, "rss_bytes" | "external_bytes">>;

/** The daemon's known worker-thread spawn sites, by module (origin/main e3988577e). Anything else is `unmapped`. */
export const DAEMON_THREAD_ROLES: Readonly<Record<string, string>> = {
  "read-plane": "read-plane",
  "ledger-union": "ledger-digest-codec",
  "secret-boundary": "git-credential-socket",
  status: "board-prewarm",
  "worker-provider": "codex-probe",
};

/** The role for a `<module>:<function>` spawn site: the fixed map, never a guess. */
export function threadRole(site: string): string {
  const module = site.split(":")[0];
  return Object.hasOwn(DAEMON_THREAD_ROLES, module) ? DAEMON_THREAD_ROLES[module] : "unmapped";
}

export function isolateHeap(s: HeapStatistics): IsolateHeap {
  return {
    used_heap_bytes: s.used_heap_size,
    total_heap_bytes: s.total_heap_size,
    physical_heap_bytes: s.total_physical_size,
    external_bytes: s.external_memory,
    malloced_bytes: s.malloced_memory,
    heap_limit_bytes: s.heap_size_limit,
  };
}

export interface WorkerHeapSources {
  /** The registry's live threads: `workerThreads().live` (worker-heaps.ts). */
  live: () => readonly TrackedWorker[];
  /** The main isolate's statistics: `getHeapStatistics` from node:v8. */
  mainHeap: () => HeapStatistics;
  /** The daemon's `run_id`. */
  generation?: string;
  /** How long a request may wait before its thread reads `unanswered`. It never cancels the request. */
  timeoutMs?: number;
  nowMs?: () => number;
}

/** One worker generation: a thread id, which Node never reuses within a process. */
interface ThreadBook {
  site: string;
  role: string;
  threadId: number;
  thread: WorkerThread;
  /** The ONE unresolved request. While it is set no other request is issued, whatever its age. */
  outstanding?: { sinceMs: number };
  last?: { atMs: number; round: number; heap: IsolateHeap };
  failure?: string;
  exited?: { atMs: number; code?: number };
}

const reasonOf = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, REASON_MAX_CHARS);

/**
 * The daemon's worker-thread heap book. `refresh()` starts a request round and returns at once, never awaiting
 * one; `fields()` reports what the rounds have answered so far.
 *
 * AT MOST ONE UNRESOLVED REQUEST PER WORKER GENERATION. A thread blocked in synchronous native code (measured:
 * one inside `execFileSync`) cannot answer `getHeapStatistics()` until it returns, and a timeout settles nothing
 * on the thread's side. So the timeout only RELABELS a waiting thread `unanswered`: it neither cancels the request
 * nor permits another, and the thread is asked again only after its request settles. An answer that arrives after
 * its thread exited is dropped and counted, never attributed to the thread that replaced it.
 */
export function workerHeapReadings(sources: WorkerHeapSources): { refresh(): void; fields(main: ResidualInputs): WorkerHeapFields } {
  const timeoutMs = sources.timeoutMs ?? WORKER_HEAP_TIMEOUT_MS;
  const nowMs = sources.nowMs ?? (() => systemClock.now());
  const books = new Map<number, ThreadBook>();
  let round = 0;
  let lateDropped = 0;
  let listError: string | undefined;

  const markExited = (book: ThreadBook, code?: unknown): void => {
    book.exited ??= { atMs: nowMs(), ...(typeof code === "number" ? { code } : {}) };
  };
  const request = (book: ThreadBook, asked: number): void => {
    const sinceMs = nowMs();
    let answer: Promise<HeapStatistics>;
    try {
      answer = book.thread.getHeapStatistics() as Promise<HeapStatistics>;
    } catch (e) {
      book.failure = reasonOf(e); // Reason: carried on the thread's entry; no request is left outstanding.
      return;
    }
    book.outstanding = { sinceMs };
    void Promise.resolve(answer).then(
      (heap) => {
        if (book.exited) {
          lateDropped += 1;
          return;
        }
        book.last = { atMs: nowMs(), round: asked, heap: isolateHeap(heap) };
        book.failure = undefined;
      },
      (e) => {
        if (!book.exited) book.failure = reasonOf(e);
      },
    ).finally(() => {
      book.outstanding = undefined;
    });
  };

  return {
    refresh(): void {
      round += 1;
      let live: readonly TrackedWorker[];
      try {
        live = sources.live();
        listError = undefined;
      } catch (e) {
        listError = reasonOf(e); // Reason: carried as `mem_worker_heaps: error:<reason>` on the next row.
        return;
      }
      const seen = new Set<number>();
      for (const { kind, thread } of live) {
        const threadId = thread.threadId;
        if (!Number.isSafeInteger(threadId) || threadId < 0) continue; // an exited Worker reads -1
        seen.add(threadId);
        let book = books.get(threadId);
        if (book === undefined) {
          const created: ThreadBook = { site: kind, role: threadRole(kind), threadId, thread };
          books.set(threadId, created);
          try {
            thread.once("exit", (code: unknown) => markExited(created, code));
          } catch {
            // Reason: a thread with no exit event is still marked exited once the registry stops listing it.
          }
          book = created;
        }
        if (book.exited || book.outstanding) continue;
        request(book, round);
      }
      for (const book of books.values()) if (!seen.has(book.threadId)) markExited(book);
    },
    fields(main: ResidualInputs): WorkerHeapFields {
      if (listError !== undefined) return { mem_worker_heaps: `error:${listError}` };
      if (round === 0) return { mem_worker_heaps: "pending:first-read" };
      const now = nowMs();
      const threads: WorkerHeapEntry[] = [];
      for (const book of [...books.values()]) {
        const id = { site: book.site, role: book.role, thread_id: book.threadId };
        if (book.exited) {
          threads.push({ ...id, state: "exited", ...(book.exited.code !== undefined ? { exit_code: book.exited.code } : {}),
            exited_ago_ms: Math.max(0, now - book.exited.atMs) });
          books.delete(book.threadId);
          continue;
        }
        const waited = book.outstanding ? Math.max(0, now - book.outstanding.sinceMs) : undefined;
        const state: ThreadHeapState = waited !== undefined && waited >= timeoutMs ? "unanswered"
          : book.last?.round === round ? "fresh"
          : book.last ? "stale"
          : book.failure ? "unanswered"
          : "pending";
        threads.push({
          ...id,
          state,
          ...(book.last ? { ...book.last.heap, age_ms: Math.max(0, now - book.last.atMs) } : {}),
          ...(waited !== undefined ? { outstanding_ms: waited } : {}),
          ...(book.failure ? { error: book.failure } : {}),
        });
      }
      let mainHeap: IsolateHeap | undefined;
      let mainError: string | undefined;
      try {
        mainHeap = isolateHeap(sources.mainHeap());
      } catch (e) {
        mainError = reasonOf(e); // Reason: carried as `unattributed_omitted: main-heap-unread:<reason>`; the row omits `main`.
      }
      const out: WorkerHeapFields = {
        worker_heaps: {
          ...(sources.generation ? { generation: sources.generation } : {}),
          ...(mainHeap ? { main: { role: "main" as const, thread_id: 0 as const, ...mainHeap } } : {}),
          threads,
          ...(lateDropped > 0 ? { late_dropped: lateDropped } : {}),
        },
      };
      const notFresh = threads.filter((t) => t.state !== "fresh" && t.state !== "exited");
      if (mainHeap === undefined) return { ...out, unattributed_omitted: `main-heap-unread:${mainError}` };
      if (notFresh.length > 0) {
        return { ...out, unattributed_omitted: `threads-not-fresh:${notFresh.map((t) => `${t.thread_id}=${t.state}`).join(",")}`.slice(0, REASON_MAX_CHARS * 2) };
      }
      if (main.rss_bytes === undefined || main.external_bytes === undefined) {
        return { ...out, unattributed_omitted: "needs:rss_bytes,external_bytes" };
      }
      const physical = threads.reduce((sum, t) => sum + (t.state === "fresh" ? t.physical_heap_bytes ?? 0 : 0), mainHeap.physical_heap_bytes);
      return { ...out, unattributed_bytes_approx: main.rss_bytes - physical - main.external_bytes };
    },
  };
}
