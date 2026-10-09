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
 * FALSIFIER: test/the-daemon-heartbeat-says-what-its-memory-is.test.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
