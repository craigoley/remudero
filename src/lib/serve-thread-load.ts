/**
 * W1-T11816: serve's cores, attributed. OBSERVED 2026-11-08 on the Azure host: serve burned about 2.1 cores
 * (three worker threads near 37% each, main at 30%, and V8's GC threads at 60% of a core) while its
 * `serve.memory` row named only heaps. Once a minute this appends one `serve.thread_load` row: each
 * thread by its `serve.memory` holder name with the CPU it used and its event-loop utilization over the
 * window, the process's gc share of that window, and the heap it was under.
 *
 * It only reads. No response, thread, limit or schedule changes: one unref'd interval, one gc observer,
 * one baseline per live thread (pruned as threads end) and two gc scalars.
 *
 * W1-T13441: `threads` lists only the workers THIS thread spawned. OBSERVED 2026-11-17: a WorkerThread spawned
 * deeper (a worker's worker) burned ~0.54 cores and no row named it. `os_threads` reads every OS thread of the
 * process from /proc/self/task, nested workers, libuv's pool and V8's own threads included, grouped by the name
 * the thread carries (thread-names.ts gives every worker one), so no thread's CPU is outside the row.
 */
import type { EventLoopUtilization } from "node:perf_hooks";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { readdirSync, readFileSync } from "node:fs";
import { systemClock, type Clock } from "./clock.js";
import { WORKER_HEAP_PREFIX, type TrackedWorker } from "./worker-heaps.js";

export const SERVE_THREAD_LOAD_STEP = "serve.thread_load";
export const SERVE_THREAD_LOAD_FAILED_STEP = "serve.thread_load_failed";
export const SERVE_THREAD_LOAD_SAMPLE_MS = 60_000;
/** BACKSTOP: a thread whose CPU read has not answered by now is listed with an error, so a read never stalls the row. */
export const THREAD_CPU_READ_TIMEOUT_MS = 5_000;
export const MAIN_THREAD_NAME = "main";

/** The slice of a `node:worker_threads` Worker the load read needs; `cpuUsage` is absent on a runtime without it. */
export interface LoadThread {
  threadId: number;
  cpuUsage?: () => Promise<NodeJS.CpuUsage>;
  performance?: { eventLoopUtilization(a?: EventLoopUtilization, b?: EventLoopUtilization): EventLoopUtilization };
}

/** One thread's line. `cpu_ms`/`cpu_share` are absent when the runtime has no per-thread CPU; `error` names a failed read. */
export interface ThreadLoadReading {
  name: string;
  thread: string;
  cpu_ms?: number;
  cpu_share?: number;
  elu?: number;
  /** The thread was first seen this window: its figures run from its own start, not the window's. */
  since_thread_start?: true;
  error?: string;
}

/** Every OS thread sharing one name (comm), summed over the window; `tids` is how many were seen in it. */
export interface OsThreadLoad {
  name: string;
  tids: number;
  cpu_ms: number;
  cpu_share: number;
}

/** One OS thread's name and its total CPU so far, in ms. */
export interface OsThreadCpu { name: string; cpu_ms: number }

export interface ServeThreadLoadRow {
  window_ms: number;
  threads: ThreadLoadReading[];
  /** Every OS thread of the process by name, hottest first; absent where /proc cannot be read (`os_threads_error`). */
  os_threads?: OsThreadLoad[];
  os_threads_error?: string;
  gc_ms: number;
  gc_count: number;
  gc_share: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  heap_limit_bytes: number;
}

export interface ServeThreadLoadOptions {
  /** The threads `serve.memory` sizes: `workerThreads().live` (worker-heaps.ts). */
  workers: () => readonly TrackedWorker[];
  log: (step: string, extra: Record<string, unknown>) => void;
  clock?: Clock;
  intervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** This thread's CPU; returns undefined on a runtime without per-thread CPU. Default `process.threadCpuUsage`. */
  mainCpu?: () => NodeJS.CpuUsage | undefined;
  mainElu?: (a?: EventLoopUtilization, b?: EventLoopUtilization) => EventLoopUtilization;
  /** Subscribes `add` to each gc pause (ms); returns the unsubscribe. Default: a `gc` PerformanceObserver. */
  observeGc?: (add: (durationMs: number) => void) => () => void;
  usage?: () => NodeJS.MemoryUsage;
  heapLimit?: () => number;
  cpuTimeoutMs?: number;
  /** Every OS thread of this process by tid. Default: /proc/self/task. Throws where there is no such file system. */
  osThreads?: () => ReadonlyMap<string, OsThreadCpu>;
}

export interface ServeThreadLoad {
  stop(): void;
  /** How many per-thread baselines are held: one per live worker seen, never more. */
  baselines(): number;
}

interface Baseline { cpu?: NodeJS.CpuUsage; elu?: EventLoopUtilization }

const message = (e: unknown): string => String((e as Error)?.message ?? e);
const cpuMs = (now: NodeJS.CpuUsage, prev?: NodeJS.CpuUsage): number =>
  (now.user + now.system - (prev ? prev.user + prev.system : 0)) / 1000;
const share = (ms: number, windowMs: number): number => (windowMs > 0 ? ms / windowMs : 0);

function defaultMainCpu(): NodeJS.CpuUsage | undefined {
  return typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : undefined;
}

function defaultObserveGc(add: (durationMs: number) => void): () => void {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) add(entry.duration);
  });
  observer.observe({ entryTypes: ["gc"] });
  return () => observer.disconnect();
}

/** USER_HZ: /proc's tick, 100 on every Linux serve runs on (procCpuConsumers reads it the same way). */
const PROC_TICKS_PER_SECOND = 100;

/** Each thread of this process from /proc/self/task: its comm and its user+system CPU. A thread gone mid-read is skipped. */
export function procSelfThreads(proc = "/proc/self/task"): Map<string, OsThreadCpu> {
  const out = new Map<string, OsThreadCpu>();
  for (const tid of readdirSync(proc)) {
    let text: string;
    try {
      text = readFileSync(`${proc}/${tid}/stat`, "utf8");
    } catch (_err) {
      // Carried, not erased: a thread that ended between the listing and the read has no line left to give.
      continue;
    }
    const close = text.lastIndexOf(")");
    const rest = text.slice(close + 2).split(" ");
    const ticks = Number(rest[11]) + Number(rest[12]);
    if (close < 0 || !Number.isFinite(ticks)) continue;
    out.set(tid, { name: text.slice(text.indexOf("(") + 1, close), cpu_ms: (ticks * 1000) / PROC_TICKS_PER_SECOND });
  }
  return out;
}

/**
 * Each name's CPU over the window: per tid, now less its last reading. A tid first seen this window counts from its own
 * start; a tid that ended inside it is gone from /proc and its last part of the window is lost, never invented.
 */
function osThreadLoads(now: ReadonlyMap<string, OsThreadCpu>, prev: ReadonlyMap<string, OsThreadCpu>, windowMs: number): OsThreadLoad[] {
  const byName = new Map<string, OsThreadLoad>();
  for (const [tid, thread] of now) {
    const before = prev.get(tid);
    const ms = Math.max(0, thread.cpu_ms - (before && before.name === thread.name ? before.cpu_ms : 0));
    const load = byName.get(thread.name) ?? { name: thread.name, tids: 0, cpu_ms: 0, cpu_share: 0 };
    load.tids += 1;
    load.cpu_ms += ms;
    byName.set(thread.name, load);
  }
  for (const load of byName.values()) load.cpu_share = Number(share(load.cpu_ms, windowMs).toFixed(4));
  return [...byName.values()].sort((a, b) => b.cpu_ms - a.cpu_ms);
}

async function readCpu(thread: LoadThread, timeoutMs: number): Promise<NodeJS.CpuUsage | undefined> {
  if (typeof thread.cpuUsage !== "function") return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cpu read did not answer within ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([thread.cpuUsage(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Start the minute sampler. Every failure is listed on the row or ledgered and swallowed; nothing is thrown at serve. */
export function startServeThreadLoad(opts: ServeThreadLoadOptions): ServeThreadLoad {
  const clock = opts.clock ?? systemClock;
  const intervalMs = opts.intervalMs ?? SERVE_THREAD_LOAD_SAMPLE_MS;
  const cpuTimeoutMs = opts.cpuTimeoutMs ?? THREAD_CPU_READ_TIMEOUT_MS;
  const mainCpu = opts.mainCpu ?? defaultMainCpu;
  const mainElu = opts.mainElu ?? performance.eventLoopUtilization.bind(performance);
  const usage = opts.usage ?? process.memoryUsage;
  const heapLimit = opts.heapLimit ?? (() => getHeapStatistics().heap_size_limit);
  const setTimer = opts.setInterval ?? setInterval;
  const clearTimer = opts.clearInterval ?? clearInterval;

  let gcMs = 0;
  let gcCount = 0;
  const stopGc = (opts.observeGc ?? defaultObserveGc)((durationMs) => {
    gcMs += durationMs;
    gcCount += 1;
  });
  const workerBaselines = new Map<LoadThread, Baseline>();
  const osThreads = opts.osThreads ?? (() => procSelfThreads());
  const readOs = (): { threads?: ReadonlyMap<string, OsThreadCpu>; error?: string } => {
    try {
      return { threads: osThreads() };
    } catch (e) {
      // Named on the row: a process whose threads cannot be listed is unread, never read as no threads.
      return { error: message(e) };
    }
  };
  let osBaseline = readOs().threads ?? new Map<string, OsThreadCpu>();
  let since = clock.now();
  let main: Baseline = { cpu: mainCpu(), elu: mainElu() };

  const readMain = (windowMs: number): ThreadLoadReading => {
    const reading: ThreadLoadReading = { name: MAIN_THREAD_NAME, thread: "thread-0" };
    try {
      const cpu = mainCpu();
      const elu = mainElu();
      if (cpu) {
        reading.cpu_ms = cpuMs(cpu, main.cpu);
        reading.cpu_share = share(reading.cpu_ms, windowMs);
      }
      reading.elu = mainElu(elu, main.elu).utilization;
      main = { cpu, elu };
    } catch (e) {
      // Recorded on main's own line: a counter that threw is named on the row, never read as zero load.
      reading.error = message(e);
    }
    return reading;
  };

  const readWorker = async ({ kind, thread }: TrackedWorker, windowMs: number): Promise<ThreadLoadReading> => {
    const load = thread as unknown as LoadThread;
    const reading: ThreadLoadReading = { name: `${WORKER_HEAP_PREFIX}${kind}`, thread: `thread-${load.threadId}` };
    const prev = workerBaselines.get(load);
    if (!prev) reading.since_thread_start = true;
    try {
      const cpu = await readCpu(load, cpuTimeoutMs);
      const elu = load.performance?.eventLoopUtilization();
      if (cpu) {
        reading.cpu_ms = cpuMs(cpu, prev?.cpu);
        reading.cpu_share = share(reading.cpu_ms, windowMs);
      }
      if (elu) reading.elu = prev?.elu ? load.performance!.eventLoopUtilization(elu, prev.elu).utilization : elu.utilization;
      workerBaselines.set(load, { cpu, elu });
    } catch (e) {
      // A thread that ended (ERR_WORKER_NOT_RUNNING) or whose read threw is listed with its error; the row still lands.
      reading.error = message(e);
    }
    return reading;
  };

  const sample = async (): Promise<ServeThreadLoadRow> => {
    const now = clock.now();
    const windowMs = now - since;
    since = now;
    const live = opts.workers();
    const mainReading = readMain(windowMs);
    const os = readOs();
    const osRow = os.threads ? { os_threads: osThreadLoads(os.threads, osBaseline, windowMs) } : { os_threads_error: os.error ?? "unread" };
    if (os.threads) osBaseline = os.threads;
    const gc = { gc_ms: gcMs, gc_count: gcCount };
    gcMs = 0;
    gcCount = 0;
    const workers = await Promise.all(live.map((worker) => readWorker(worker, windowMs)));
    const alive = new Set(live.map(({ thread }) => thread as unknown as LoadThread));
    for (const thread of workerBaselines.keys()) if (!alive.has(thread)) workerBaselines.delete(thread);
    const memory = usage();
    return {
      window_ms: windowMs,
      threads: [mainReading, ...workers],
      ...osRow,
      ...gc,
      gc_share: share(gc.gc_ms, windowMs),
      heap_used_bytes: memory.heapUsed,
      heap_total_bytes: memory.heapTotal,
      heap_limit_bytes: heapLimit(),
    };
  };

  const tick = (): void => {
    void sample()
      .then((row) => opts.log(SERVE_THREAD_LOAD_STEP, { ...row }))
      .catch((e) => opts.log(SERVE_THREAD_LOAD_FAILED_STEP, { reason: message(e) }));
  };

  const timer = setTimer(tick, intervalMs);
  timer.unref?.();
  return {
    stop: () => {
      clearTimer(timer);
      stopGc();
    },
    baselines: () => workerBaselines.size,
  };
}
