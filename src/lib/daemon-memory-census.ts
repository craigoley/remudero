/**
 * lib/daemon-memory-census.ts — W1-T9647: THE DAEMON NAMES WHAT HOLDS ITS HEAP, AND ITS CENSUS FILES THE TOP HOLDERS.
 * After the slack reclaimer's full collection the daemon held 867 MiB p50 of live heap (2026-10-15, n=282) and
 * W1-T9105's memo_sizes named 7 MiB of it; serve's `serve.memory` holders (W1-T5175/W1-T5355) are the model.
 *
 * LIVE: {@link startDaemonMemoryCensus} writes `daemon.memory` on its own unref'd timer: every V8 heap space, heap and
 * code statistics, /proc/self/status lines, and each holder with its `basis` — "accounted" (kept as it grew), "census"
 * (entries × {@link DAEMON_MEMORY_CALIBRATION}'s measured figure) or "walked" (sliced so no turn spends more than
 * {@link DAEMON_MEMORY_TURN_BUDGET_MS}). `unattributed_live_bytes` is the reclaimer's last live set less the holders.
 * INVARIANT: no heap snapshot, no forced collection, no inspector session in the live process.
 *
 * OFFLINE: {@link measureHeapHolders} / {@link rankHeapCensus}, driven by scripts/daemon-heap-census.mts in a private
 * --expose-gc process, measure what each holder RETAINS (build, settle, drop, settle) and rank them.
 *
 * THE RULE (census feeds filing): every holder at or above {@link censusFilingThreshold} gets a `proposed_task` and is
 * filed as its own task naming its daemon.memory holder; its saving is that holder's bytes p50 one generation before
 * vs after the fix's `boot_head_sha`; a shrinking `unattributed_live_bytes` is the census's coverage; a calibration
 * that drifts past its own spread is re-run, not trusted.
 *
 * FALSIFIER: test/the-daemon-names-what-holds-its-heap.test.ts.
 */

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { getHeapCodeStatistics, getHeapSpaceStatistics, getHeapStatistics } from "node:v8";
import { systemClock, type Clock } from "./clock.js";
import type { LedgerMemoHolderReading } from "./ledger-union.js";
import type { HolderReading } from "./serve-memory.js";
import { installSourceMapCount, sourceMapsParsed, type SourceMapsParsedReading } from "./source-map-count.js";

export const DAEMON_MEMORY_STEP = "daemon.memory";
export const DAEMON_MEMORY_SAMPLE_FAILED_STEP = "daemon.memory_sample_failed";
/** OPERATOR DECISION (proposed 180 s, serve's SERVE_MEMORY_SAMPLE_MS): how often the row is written. */
export const DAEMON_MEMORY_SAMPLE_MS = 180_000;
/** BACKSTOP, OPERATOR DECISION (proposed 6 KiB; daemon.alive rows already run 2-27 KB): the row's serialized size.
 *  Past it the smallest holders are folded into `holders_omitted`, never dropped unseen. */
export const DAEMON_MEMORY_ROW_MAX_BYTES = 6 * 1024;
/** OPERATOR DECISION (proposed 10 ms): the synchronous sizing work one turn may do before the sampler yields. */
export const DAEMON_MEMORY_TURN_BUDGET_MS = 10;
/** BACKSTOP, OPERATOR DECISION (proposed 2 M nodes): nodes one walked holder visits per sample; past it the holder's
 *  bytes are a lower bound and the reading says `truncated`. */
export const DAEMON_MEMORY_WALK_NODE_MAX = 2_000_000;
/** OPERATOR DECISION (proposed 5%): a holder retaining this share of the measured live set is filed... */
export const CENSUS_FILING_SHARE = 0.05;
/** OPERATOR DECISION (proposed 50 MiB): ...or this many bytes, whichever is lower. */
export const CENSUS_FILING_BYTES = 50 * 1024 * 1024;

const MIB = 1024 * 1024;

// ── calibration ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One per-entry figure the offline census measured. `spread` is the census's own relative spread across runs. */
export interface CensusCalibration {
  per_entry_bytes: number;
  entries: number;
  spread?: number;
  census_sha: string;
  census_date: string;
}

/** Written by `scripts/daemon-heap-census.mts --write-calibration`; edit only through it. */
// census-calibration:begin
export const DAEMON_MEMORY_CALIBRATION: Readonly<Record<string, CensusCalibration>> = {
  "source-maps.module": {
    per_entry_bytes: 240549,
    entries: 587,
    census_sha: "27d1f36d8d59",
    census_date: "2026-10-15"
  },
  "plan.task": {
    per_entry_bytes: 9915,
    entries: 4112,
    census_sha: "27d1f36d8d59",
    census_date: "2026-10-15"
  },
  "board.closed-pr": {
    per_entry_bytes: 3201,
    entries: 12000,
    census_sha: "27d1f36d8d59",
    census_date: "2026-10-15"
  }
};
// census-calibration:end

/** How a holder's bytes were found. */
export type DaemonHolderBasis = "accounted" | "census" | "walked";

/** What a sized holder reports of itself. */
export interface DaemonHolderSize {
  entries: number;
  bytes: number;
  basis: "accounted" | "census";
  calibration?: string;
  parts?: Record<string, number>;
}

/** entries × the census's per-entry figure for `key`, or undefined when the census has not measured it. */
export function censusEstimate(
  key: string,
  entries: number,
  table: Readonly<Record<string, CensusCalibration>> = DAEMON_MEMORY_CALIBRATION,
): DaemonHolderSize | undefined {
  const row = table[key];
  if (!row) return undefined;
  return { entries, bytes: Math.round(entries * row.per_entry_bytes), basis: "census", calibration: `${key}@${row.census_sha.slice(0, 12)}/${row.census_date}` };
}

// ── holders ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One named thing the daemon keeps in memory. `size` answers cheaply (accounted, or census); a holder that can only be
 * walked gives `walk` (its roots), and a `size` that returns undefined falls back to `walk`.
 */
export interface DaemonMemoryHolder {
  name: string;
  kind: string;
  size?: () => DaemonHolderSize | undefined;
  walk?: () => { entries: number; roots: readonly unknown[] };
}

/** One holder's line on the row. `error` names a holder that could not size itself; it is never dropped. */
export interface DaemonHolderReading extends Pick<HolderReading, "name" | "entries" | "bytes" | "error"> {
  kind: string;
  basis: DaemonHolderBasis;
  sample_us: number;
  calibration?: string;
  parts?: Record<string, number>;
  truncated?: true;
}

/** The daemon's holders, keyed by name (re-adding a name replaces it), plus sources that name several at once. */
export function createDaemonMemoryRegistry(): {
  add(holder: DaemonMemoryHolder): void;
  addSource(name: string, source: () => readonly DaemonMemoryHolder[]): void;
  holders(): DaemonMemoryHolder[];
} {
  const holders = new Map<string, DaemonMemoryHolder>();
  const sources = new Map<string, () => readonly DaemonMemoryHolder[]>();
  return {
    add: (holder) => void holders.set(holder.name, holder),
    addSource: (name, source) => void sources.set(name, source),
    holders: () => {
      const all = [...holders.values()];
      for (const [name, source] of sources) {
        try {
          all.push(...source());
        } catch (error) {
          all.push({ name, kind: "source", size: () => { throw error; } });
        }
      }
      return all;
    },
  };
}

/** A holder that kept its own size as it grew: a {@link import("./ledger-union.js").createSizedMemo} or alike. */
export function accountedHolder(name: string, kind: string, size: () => { entries: number; approx_bytes: number }): DaemonMemoryHolder {
  return { name, kind, size: () => {
    const read = size();
    return { entries: read.entries, bytes: read.approx_bytes, basis: "accounted" };
  } };
}

/** Every ledger memo the isolate built (ledger-union.ts's book), one holder per kind and name. */
export function ledgerMemoBookHolders(read: () => readonly LedgerMemoHolderReading[]): DaemonMemoryHolder[] {
  return read().map((memo) => ({
    name: `${memo.kind}:${memo.name}`,
    kind: memo.kind,
    size: () => ({ entries: memo.entries, bytes: memo.approx_bytes, basis: "accounted", ...(memo.instances > 1 ? { parts: { instances: memo.instances } } : {}) }),
  }));
}

/** A holder sized by its entry count and the census's per-entry figure, walked until the census has measured it. */
export function censusHolder(name: string, kind: string, calibrationKey: string, entries: () => number, roots: () => readonly unknown[],
  table: Readonly<Record<string, CensusCalibration>> = DAEMON_MEMORY_CALIBRATION): DaemonMemoryHolder {
  return {
    name, kind,
    size: () => censusEstimate(calibrationKey, entries(), table),
    walk: () => ({ entries: entries(), roots: roots() }),
  };
}

/**
 * THE SOURCE-MAP CACHE. tsx turns source maps on, and every formatted stack (read-plane.ts callerFrame on each sync
 * spawn, worker-heaps.ts spawnSite) parses and KEEPS the map of each module on it, for the life of the isolate.
 * OBSERVED offline by the W1-T9091 builder at a5d569886: all 587 maps add +134.5 MiB of heap. No public API sizes
 * Node's cache, and asking it (module.findSourceMap) would parse the very maps being counted. W1-T9822: the stack
 * formatter counts them instead (source-map-count.ts), so the holder is the maps PARSED x the census's per-map bytes
 * (`parts.formatted_frames`, a lower bound: see that file), and the census's UPPER BOUND (every map of the daemon's
 * module graph, `parts.upper_bound`) only when there is no count. Zero once source maps are off.
 */
export function sourceMapCacheHolder(enabled: () => boolean = () => process.sourceMapsEnabled,
  table: Readonly<Record<string, CensusCalibration>> = DAEMON_MEMORY_CALIBRATION,
  parsed: () => SourceMapsParsedReading = sourceMapsParsed): DaemonMemoryHolder {
  return {
    name: "source-map-cache",
    kind: "source-maps",
    size: (): DaemonHolderSize => {
      if (!enabled()) return { entries: 0, bytes: 0, basis: "census", parts: { source_maps_enabled: 0 } };
      const count = parsed().parsed;
      const estimate = censusEstimate("source-maps.module", count ?? table["source-maps.module"]?.entries ?? 0, table);
      if (!estimate) return { entries: 0, bytes: 0, basis: "census", parts: { uncalibrated: 1 } };
      return { ...estimate, parts: count === undefined ? { upper_bound: 1 } : { formatted_frames: 1 } };
    },
  };
}

type PlanLike = { tasks?: readonly unknown[] };

/**
 * PLAN COPIES. A parsed plan is 25-60 MB (INFERRED); the daemon holds one at boot, one per reload, one per lane's sync
 * and one in the published tick read, and a PlanBlobCache reload shares task objects with the plan before it. So the
 * holder counts DISTINCT plan objects (the refs it is given now, plus every plan it was shown that is still alive) and
 * sizes DISTINCT task objects among them: a shared task is counted once, a structured clone's tasks are not shared.
 */
export function createPlanCopyBook(opts: { refs: () => readonly unknown[]; table?: Readonly<Record<string, CensusCalibration>> }): {
  observe(plan: unknown): void;
  holder(): DaemonMemoryHolder;
} {
  let tracked: Array<WeakRef<object>> = [];
  const alive = (): { plans: object[]; pinned: number } => {
    const plans = new Set<object>();
    for (const ref of opts.refs()) if (typeof ref === "object" && ref !== null) plans.add(ref);
    const pinned = plans.size;
    tracked = tracked.filter((ref) => {
      const plan = ref.deref();
      if (plan !== undefined) plans.add(plan);
      return plan !== undefined;
    });
    return { plans: [...plans], pinned };
  };
  const distinctTasks = (plans: readonly object[]): Set<unknown> => {
    const tasks = new Set<unknown>();
    for (const plan of plans) for (const task of (plan as PlanLike).tasks ?? []) tasks.add(task);
    return tasks;
  };
  return {
    observe: (plan) => {
      if (typeof plan !== "object" || plan === null) return;
      if (tracked.some((ref) => ref.deref() === plan)) return;
      tracked.push(new WeakRef(plan));
    },
    holder: () => ({
      name: "plan-copies",
      kind: "plan-copies",
      size: () => {
        const { plans, pinned } = alive();
        const tasks = distinctTasks(plans).size;
        const estimate = censusEstimate("plan.task", tasks, opts.table);
        return estimate && { ...estimate, entries: plans.length, parts: { pinned, tracked: plans.length - pinned, distinct_tasks: tasks } };
      },
      walk: () => {
        const { plans } = alive();
        return { entries: plans.length, roots: plans };
      },
    }),
  };
}

/** Where the daemon's holders live; each is optional, and a missing one is simply not on the row. */
export interface DaemonHolderSources {
  planCopies?: { holder(): DaemonMemoryHolder };
  /** Memos that keep their own size (W1-T9105's), by name. */
  sizedMemos?: Readonly<Record<string, () => { entries: number; approx_bytes: number }>>;
  /** Every board snapshot cache built, whose closed-PR and issue rows (with bodies) stay in memory. */
  boardSnapshots?: () => Iterable<{ rows?: () => { closed?: ReadonlyMap<number, unknown>; issues?: ReadonlyMap<number, unknown> } }>;
  /** The published tick read's facts; its plan is counted with the plan copies, never here. */
  tickRead?: () => Record<string, unknown> | undefined;
  /** ledger-union.ts's memo book. */
  ledgerMemos?: () => readonly LedgerMemoHolderReading[];
  /** Whether this isolate source-maps its stacks (the source-map cache holder). Given, the source-map count is
   *  installed (W1-T9822) so the holder can size the maps parsed. */
  sourceMapsEnabled?: () => boolean;
  /** The source-map count's install and read; default the process's own (source-map-count.ts). */
  sourceMapCount?: { install: () => void; read: () => SourceMapsParsedReading };
  table?: Readonly<Record<string, CensusCalibration>>;
}

/** The daemon's holder list, read fresh at every sample. */
export function daemonHolderSource(sources: DaemonHolderSources): () => DaemonMemoryHolder[] {
  const registry = createDaemonMemoryRegistry();
  if (sources.planCopies) registry.add(sources.planCopies.holder());
  for (const [name, size] of Object.entries(sources.sizedMemos ?? {})) registry.add(accountedHolder(`memo:${name}`, "sized-memo", size));
  const boardSnapshots = sources.boardSnapshots;
  if (boardSnapshots) {
    const maps = (channel: "closed" | "issues"): ReadonlyMap<number, unknown>[] =>
      [...boardSnapshots()].map((cache) => cache.rows?.()[channel]).filter((rows): rows is ReadonlyMap<number, unknown> => rows !== undefined);
    const entries = (channel: "closed" | "issues"): number => maps(channel).reduce((sum, rows) => sum + rows.size, 0);
    registry.add(censusHolder("board-snapshot.closed", "board-rows", "board.closed-pr", () => entries("closed"), () => maps("closed"), sources.table));
    registry.add(censusHolder("board-snapshot.issues", "board-rows", "board.issue", () => entries("issues"), () => maps("issues"), sources.table));
  }
  const tickRead = sources.tickRead;
  if (tickRead) {
    registry.add({ name: "tick-read", kind: "tick-read", walk: () => {
      const facts = tickRead();
      if (facts === undefined) return { entries: 0, roots: [] };
      const roots = Object.entries(facts).filter(([field]) => field !== "plan").map(([, value]) => value);
      return { entries: 1, roots };
    } });
  }
  const ledgerMemos = sources.ledgerMemos;
  if (ledgerMemos) registry.addSource("ledger-memos", () => ledgerMemoBookHolders(ledgerMemos));
  if (sources.sourceMapsEnabled) {
    const count = sources.sourceMapCount ?? { install: installSourceMapCount, read: sourceMapsParsed };
    count.install();
    registry.add(sourceMapCacheHolder(sources.sourceMapsEnabled, sources.table, count.read));
  }
  return () => registry.holders();
}

// ── the sliced walk ──────────────────────────────────────────────────────────────────────────────────────────────

/** The sampler's on-loop meter: every synchronous slice between two yields, and the longest of them. */
interface SliceMeter {
  monotonicMs: () => number;
  yieldTurn: () => Promise<void>;
  budgetMs: number;
  sliceStart: number;
  onLoopMs: number;
  maxSliceMs: number;
  slices: number;
}

function newMeter(monotonicMs: () => number, yieldTurn: () => Promise<void>, budgetMs: number): SliceMeter {
  return { monotonicMs, yieldTurn, budgetMs, sliceStart: monotonicMs(), onLoopMs: 0, maxSliceMs: 0, slices: 0 };
}

/** On-loop time so far, including the slice still running. */
function spentMs(meter: SliceMeter): number {
  return meter.onLoopMs + (meter.monotonicMs() - meter.sliceStart);
}

async function yieldSlice(meter: SliceMeter): Promise<void> {
  const slice = meter.monotonicMs() - meter.sliceStart;
  meter.onLoopMs += slice;
  meter.maxSliceMs = Math.max(meter.maxSliceMs, slice);
  meter.slices += 1;
  await meter.yieldTurn();
  meter.sliceStart = meter.monotonicMs();
}

/**
 * An approximate retained size, serve's `approxBytes` accounting (string characters, 8 bytes a primitive or slot, a
 * typed array's byteLength, 16 bytes of header per container; shared references once; accessors never invoked), but
 * SLICED: it yields whenever the running slice reaches the meter's budget, so a large holder costs many short turns,
 * never one long one. Past `nodeMax` nodes it stops: the figure is a lower bound and `truncated` says so.
 */
async function walkBytes(roots: readonly unknown[], meter: SliceMeter, nodeMax: number): Promise<{ bytes: number; truncated: boolean }> {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [...roots];
  let bytes = 0;
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= nodeMax) return { bytes, truncated: true };
    if (meter.monotonicMs() - meter.sliceStart >= meter.budgetMs) await yieldSlice(meter);
    const next = stack.pop();
    visited += 1;
    if (typeof next === "string") {
      bytes += next.length;
      continue;
    }
    if (typeof next !== "object" || next === null) {
      bytes += 8;
      continue;
    }
    if (seen.has(next)) continue;
    seen.add(next);
    if (ArrayBuffer.isView(next)) {
      bytes += next.byteLength;
      continue;
    }
    if (next instanceof Map) {
      bytes += 16 + 16 * next.size;
      next.forEach((value, key) => stack.push(key, value));
      continue;
    }
    if (next instanceof Set) {
      bytes += 16 + 16 * next.size;
      next.forEach((value) => stack.push(value));
      continue;
    }
    if (Array.isArray(next)) {
      bytes += 16 + 8 * next.length;
      for (const item of next) stack.push(item);
      continue;
    }
    const names = Object.getOwnPropertyNames(next);
    bytes += 16 + 8 * names.length;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(next, name);
      if (descriptor && "value" in descriptor) stack.push(descriptor.value);
      bytes += name.length;
    }
  }
  return { bytes, truncated: false };
}

// ── the row ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The reclaimer's last measured live set: heap used right after its full collection, and when. */
export interface LiveSetReading {
  bytes: number;
  atMs: number;
}

/** The live set a `daemon.slack_reclaim` record measured, or undefined for a paced or unavailable one. */
export function liveSetFromReclaim(record: { outcome: string; heap_used_after_bytes?: number }, clock: Clock = systemClock): LiveSetReading | undefined {
  return record.outcome === "reclaimed" && record.heap_used_after_bytes !== undefined ? { bytes: record.heap_used_after_bytes, atMs: clock.now() } : undefined;
}

/** Keeps the newest live set a reclaim measured: `keep` passes each `daemon.slack_reclaim` record through unchanged. */
export function createLiveSetKeeper(clock: Clock = systemClock): { keep<R extends { outcome: string; heap_used_after_bytes?: number }>(record: R): R; read(): LiveSetReading | undefined } {
  let latest: LiveSetReading | undefined;
  return {
    keep: (record) => {
      latest = liveSetFromReclaim(record, clock) ?? latest;
      return record;
    },
    read: () => latest,
  };
}

/** A plan sync whose every resolved plan is shown to the plan-copy book (each lane's `synced.plan`). */
export function observedPlanSync<A extends unknown[], S extends { plan: unknown }>(sync: (...args: A) => Promise<S>, observe: (plan: unknown) => void): (...args: A) => Promise<S> {
  return (...args) => sync(...args).then((synced) => {
    observe(synced.plan);
    return synced;
  });
}

/** Every seam the sample reads; each defaults to the real process. */
export interface DaemonMemorySampleIo {
  heapStatistics?: () => ReturnType<typeof getHeapStatistics>;
  heapSpaces?: () => ReturnType<typeof getHeapSpaceStatistics>;
  heapCode?: () => ReturnType<typeof getHeapCodeStatistics>;
  memoryUsage?: () => NodeJS.MemoryUsage;
  /** /proc/self/status's text. */
  procStatus?: () => string;
  sourceMapsEnabled?: () => boolean;
  /** W1-T9822: the distinct source maps the stack formatter has parsed (source-map-count.ts). */
  sourceMapsParsed?: () => SourceMapsParsedReading;
  uptimeSeconds?: () => number;
  /** Monotonic milliseconds, for slices and costs. */
  monotonicMs?: () => number;
  yieldTurn?: () => Promise<void>;
  clock?: Clock;
  turnBudgetMs?: number;
  walkNodeMax?: number;
  rowMaxBytes?: number;
}

/** What the row says about its own generation and timing. */
export interface DaemonMemorySampleContext {
  liveSet?: () => LiveSetReading | undefined;
  bootHeadSha?: string;
  /** How late the timer fired this sample, ms. */
  lateMs?: number;
}

const PROC_FIELDS: ReadonlyArray<[string, string]> = [
  ["VmRSS", "vm_rss_bytes"], ["VmSwap", "vm_swap_bytes"], ["VmHWM", "vm_hwm_bytes"], ["RssAnon", "rss_anon_bytes"], ["RssFile", "rss_file_bytes"],
];

/** The process lines of /proc/self/status in bytes. An unreadable file or a missing line is NAMED in `mem_proc`,
 *  never written as zero. */
export function readProcMemory(procStatus: () => string): Record<string, number | string> {
  let text: string;
  try {
    text = procStatus();
  } catch (error) {
    return { mem_proc: `unreadable:${(error as NodeJS.ErrnoException).code ?? (error as Error).name}` };
  }
  const fields: Record<string, number | string> = {};
  const missing: string[] = [];
  for (const [line, field] of PROC_FIELDS) {
    const kb = new RegExp(`^${line}:\\s+(\\d+)\\s+kB`, "m").exec(text)?.[1];
    if (kb === undefined) missing.push(line);
    else fields[field] = Number(kb) * 1024;
  }
  if (missing.length > 0) fields.mem_proc = `missing:${missing.join(",")}`;
  return fields;
}

const defaultYieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const defaultProcStatus = (): string => readFileSync("/proc/self/status", "utf8");

/** Size one holder, never throwing: a holder that throws is named with its error. */
async function readHolder(holder: DaemonMemoryHolder, meter: SliceMeter, nodeMax: number): Promise<DaemonHolderReading> {
  const started = spentMs(meter);
  const named = { name: holder.name, kind: holder.kind };
  const cost = (): number => Math.round((spentMs(meter) - started) * 1000);
  try {
    const sized = holder.size?.();
    if (sized !== undefined) {
      return { ...named, entries: sized.entries, bytes: sized.bytes, basis: sized.basis,
        ...(sized.calibration ? { calibration: sized.calibration } : {}), ...(sized.parts ? { parts: sized.parts } : {}), sample_us: cost() };
    }
    if (!holder.walk) return { ...named, entries: 0, bytes: 0, basis: "accounted", error: "no size and no walk", sample_us: cost() };
    const { entries, roots } = holder.walk();
    const walked = await walkBytes(roots, meter, nodeMax);
    return { ...named, entries, bytes: walked.bytes, basis: "walked", ...(walked.truncated ? { truncated: true as const } : {}), sample_us: cost() };
  } catch (error) {
    return { ...named, entries: 0, bytes: 0, basis: holder.size ? "accounted" : "walked", error: String((error as Error)?.message ?? error).slice(0, 200), sample_us: cost() };
  }
}

/** Keep the largest holders that fit the row's byte cap; the rest are summed in `holders_omitted`. */
export function capHolders(row: Record<string, unknown>, readings: readonly DaemonHolderReading[], maxBytes: number): Record<string, unknown> {
  const sorted = [...readings].sort((a, b) => b.bytes - a.bytes);
  const omittedFrame = JSON.stringify({ holders_omitted: { count: sorted.length, bytes: sorted.reduce((sum, r) => sum + r.bytes, 0) } }).length;
  let used = JSON.stringify({ ...row, holders: [] }).length + omittedFrame;
  const kept: DaemonHolderReading[] = [];
  let omittedCount = 0;
  let omittedBytes = 0;
  for (const reading of sorted) {
    const cost = JSON.stringify(reading).length + 1;
    if (used + cost <= maxBytes) {
      kept.push(reading);
      used += cost;
    } else {
      omittedCount += 1;
      omittedBytes += reading.bytes;
    }
  }
  return { ...row, holders: kept, ...(omittedCount > 0 ? { holders_omitted: { count: omittedCount, bytes: omittedBytes } } : {}) };
}

/** W1-T9822: the row's source maps. `source_maps_enabled` stays for its readers (the W1-T9647 census test and
 *  scripts/daemon-heap-census.mts); `source_maps.parsed` is the formatter's count, absent when `parsed_basis` names
 *  why there is none (not-installed, detached, failed). */
function sourceMapFields(enabled: boolean, reading: SourceMapsParsedReading): Record<string, unknown> {
  const parsed = reading.parsed === undefined ? {} : { parsed: reading.parsed };
  return { source_maps_enabled: enabled, source_maps: { enabled, ...parsed, parsed_basis: reading.basis } };
}

/**
 * One `daemon.memory` row: process, heap spaces, heap and code statistics, source maps, and every holder, sized with
 * a yield between holders and inside any walk. Never a heap snapshot, a forced collection or an inspector session.
 */
export async function sampleDaemonMemoryCensus(
  holders: readonly DaemonMemoryHolder[],
  context: DaemonMemorySampleContext = {},
  io: DaemonMemorySampleIo = {},
): Promise<Record<string, unknown>> {
  const monotonicMs = io.monotonicMs ?? (() => performance.now());
  const meter = newMeter(monotonicMs, io.yieldTurn ?? defaultYieldTurn, io.turnBudgetMs ?? DAEMON_MEMORY_TURN_BUDGET_MS);
  const wallStart = monotonicMs();
  const clock = io.clock ?? systemClock;
  const usage = (io.memoryUsage ?? process.memoryUsage)();
  const heap = (io.heapStatistics ?? getHeapStatistics)();
  const code = (io.heapCode ?? getHeapCodeStatistics)();
  const heapSpaces: Record<string, { used: number; size: number; physical: number }> = {};
  for (const space of (io.heapSpaces ?? getHeapSpaceStatistics)()) {
    heapSpaces[space.space_name] = { used: space.space_used_size, size: space.space_size, physical: space.physical_space_size };
  }
  const head: Record<string, unknown> = {
    rss_bytes: usage.rss,
    external_bytes: usage.external,
    array_buffers_bytes: usage.arrayBuffers,
    ...readProcMemory(io.procStatus ?? defaultProcStatus),
    heap: {
      used_bytes: heap.used_heap_size,
      total_bytes: heap.total_heap_size,
      physical_bytes: heap.total_physical_size,
      limit_bytes: heap.heap_size_limit,
      external_memory_bytes: heap.external_memory,
      malloced_bytes: heap.malloced_memory,
      native_contexts: heap.number_of_native_contexts,
      detached_contexts: heap.number_of_detached_contexts,
      global_handles_used_bytes: heap.used_global_handles_size,
    },
    code: {
      bytecode_and_metadata_bytes: code.bytecode_and_metadata_size,
      code_and_metadata_bytes: code.code_and_metadata_size,
      external_script_source_bytes: code.external_script_source_size,
    },
    heap_spaces: heapSpaces,
    ...sourceMapFields((io.sourceMapsEnabled ?? (() => process.sourceMapsEnabled))(), io.sourceMapsParsed ? io.sourceMapsParsed() : sourceMapsParsed()),
    ...(context.bootHeadSha ? { boot_head_sha: context.bootHeadSha.slice(0, 12) } : {}),
    uptime_s: Math.round((io.uptimeSeconds ?? process.uptime)()),
  };
  const readings: DaemonHolderReading[] = [];
  for (const holder of holders) {
    await yieldSlice(meter);
    readings.push(await readHolder(holder, meter, io.walkNodeMax ?? DAEMON_MEMORY_WALK_NODE_MAX));
  }
  const attributed = readings.reduce((sum, reading) => sum + reading.bytes, 0);
  const live = context.liveSet?.();
  const liveFields = live === undefined
    ? { unattributed_reason: "no slack_reclaim live set measured in this process yet" }
    : { live_after_gc_bytes: live.bytes, live_after_gc_age_ms: Math.max(0, clock.now() - live.atMs), unattributed_live_bytes: live.bytes - attributed };
  meter.onLoopMs += monotonicMs() - meter.sliceStart;
  meter.maxSliceMs = Math.max(meter.maxSliceMs, monotonicMs() - meter.sliceStart);
  meter.sliceStart = monotonicMs();
  const tail = {
    attributed_bytes: attributed,
    ...liveFields,
    sample_us: Math.round(meter.onLoopMs * 1000),
    max_slice_us: Math.round(meter.maxSliceMs * 1000),
    turns: meter.slices + 1,
    wall_ms: Math.round(monotonicMs() - wallStart),
    ...(context.lateMs !== undefined ? { late_ms: Math.round(context.lateMs) } : {}),
  };
  return capHolders({ ...head, ...tail }, readings, io.rowMaxBytes ?? DAEMON_MEMORY_ROW_MAX_BYTES);
}

/** What {@link startDaemonMemoryCensus} needs. */
export interface DaemonMemoryCensusOptions extends DaemonMemorySampleContext {
  holders: () => readonly DaemonMemoryHolder[];
  log: (step: string, extra: Record<string, unknown>) => void;
  intervalMs?: number;
  io?: DaemonMemorySampleIo;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown };
  clearTimer?: (timer: { unref?: () => unknown }) => void;
}

/**
 * The daemon's own sampler: one `daemon.memory` row every {@link DAEMON_MEMORY_SAMPLE_MS} on its own unref'd timer,
 * the next scheduled only after this one is written, so two samples never overlap. A failed sample writes
 * `daemon.memory_sample_failed` and the next tick runs again. Returns the stop.
 */
export function startDaemonMemoryCensus(opts: DaemonMemoryCensusOptions): () => void {
  const intervalMs = opts.intervalMs ?? DAEMON_MEMORY_SAMPLE_MS;
  const monotonicMs = opts.io?.monotonicMs ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((timer: { unref?: () => unknown }) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let stopped = false;
  let timer: { unref?: () => unknown } | undefined;
  const schedule = (): void => {
    if (stopped) return;
    const due = monotonicMs() + intervalMs;
    timer = setTimer(() => void tick(due), intervalMs);
    timer.unref?.();
  };
  const tick = async (due: number): Promise<void> => {
    try {
      const row = await sampleDaemonMemoryCensus(opts.holders(), { ...opts, lateMs: Math.max(0, monotonicMs() - due) }, opts.io);
      if (!stopped) opts.log(DAEMON_MEMORY_STEP, row);
    } catch (error) {
      opts.log(DAEMON_MEMORY_SAMPLE_FAILED_STEP, { reason: String((error as Error)?.message ?? error).slice(0, 200) });
    }
    schedule();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimer(timer);
  };
}

// ── the offline census ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * One holder the offline census builds at production scale. `build` returns the holder's value and entry count;
 * `drop` releases anything the build left reachable outside the returned value (a module cache), so dropping the
 * value really frees it. `holder` is the `daemon.memory` holder name a fix's acceptance reads.
 */
export interface CensusHolderSpec {
  name: string;
  holder: string;
  calibrationKey?: string;
  files: readonly string[];
  build?: () => Promise<{ value: unknown; entries: number }> | { value: unknown; entries: number };
  drop?: () => void;
  /** A holder that cannot be dropped in-process (a module graph, Node's source-map cache) is measured in a process of
   *  its own: it reports its entries, what it retains and what it grew, and `build`/`drop` are not used. */
  measure?: () => Promise<{ entries: number; retained_bytes: number; grown_bytes: number }>;
}

/** The census process's collector (`globalThis.gc` under --expose-gc) and heap reader, injected. */
export interface CensusMeasureIo {
  collect: () => void | Promise<void>;
  heapUsed: () => number;
  log?: (line: string) => void;
}

export interface CensusMeasurement {
  name: string;
  holder: string;
  calibrationKey?: string;
  files: readonly string[];
  entries: number;
  /** Heap with the holder built, less heap once it is dropped: what the holder alone keeps alive. */
  retained_bytes: number;
  /** Heap with the holder built, less heap before it was built. */
  grown_bytes: number;
  error?: string;
}

/** A macrotask first: V8 keeps every object a WeakRef was made for alive until the current job ends (a ledger memo
 *  enters ledger-union.ts's weak book as it is built), so a collection inside the same job could not free it. */
async function settle(io: CensusMeasureIo): Promise<number> {
  for (let round = 0; round < 2; round++) {
    await new Promise((resolve) => setImmediate(resolve));
    await io.collect();
  }
  return io.heapUsed();
}

/** Build one holder and read the heap while it is held. Its own call frame: once it returns, nothing of the built
 *  value outlives it (a long-lived async frame can keep a stale reference in a register across awaits). */
async function holdOne(build: NonNullable<CensusHolderSpec["build"]>, io: CensusMeasureIo): Promise<{ entries: number; withHolder: number; before: number }> {
  const before = await settle(io);
  const built = await build();
  const withHolder = await settle(io);
  // `built` is read AFTER the settled reading, so it is live (and held) across that await.
  return { entries: built.entries, withHolder, before };
}

/**
 * Build each holder, read the settled heap, DROP it, read the settled heap again: the difference is what the holder
 * retains. Holders are measured one at a time, each dropped before the next is built.
 */
export async function measureHeapHolders(specs: readonly CensusHolderSpec[], io: CensusMeasureIo): Promise<CensusMeasurement[]> {
  const measured: CensusMeasurement[] = [];
  for (const spec of specs) {
    const base = { name: spec.name, holder: spec.holder, files: spec.files, ...(spec.calibrationKey ? { calibrationKey: spec.calibrationKey } : {}) };
    try {
      if (spec.measure) {
        measured.push({ ...base, ...await spec.measure() });
        continue;
      }
      if (!spec.build) throw new Error("a census holder needs build or measure");
      const held = await holdOne(spec.build, io);
      spec.drop?.();
      const after = await settle(io);
      const { entries, withHolder, before } = held;
      measured.push({ ...base, entries, retained_bytes: Math.max(0, withHolder - after), grown_bytes: withHolder - before });
      io.log?.(`${spec.name}: entries=${entries} retained=${Math.round((withHolder - after) / MIB)} MiB`);
    } catch (error) {
      spec.drop?.();
      const reason = String((error as Error)?.message ?? error).slice(0, 300);
      io.log?.(`${spec.name}: error ${reason}`);
      measured.push({ ...base, entries: 0, retained_bytes: 0, grown_bytes: 0, error: reason });
    }
  }
  return measured;
}

/** The lower of {@link CENSUS_FILING_SHARE} of the live set and {@link CENSUS_FILING_BYTES}. */
export function censusFilingThreshold(liveSetBytes: number, share: number = CENSUS_FILING_SHARE, bytes: number = CENSUS_FILING_BYTES): number {
  return Math.min(share * liveSetBytes, bytes);
}

/** A task stub for a holder at or above the filing threshold; the coordinator files it. */
export interface ProposedHolderTask {
  subject: string;
  evidence: string[];
  files: readonly string[];
  holder: string;
  acceptance: string;
}

export interface RankedHolder extends CensusMeasurement {
  rank: number;
  share: number;
  per_entry_bytes: number;
  proposed_task?: ProposedHolderTask;
}

export interface HeapCensusRanking {
  census_sha: string;
  census_date: string;
  live_set_bytes: number;
  threshold_bytes: number;
  measured_bytes: number;
  holders: RankedHolder[];
}

/** Rank the measurements by retained bytes and propose a task for each holder at or above the filing threshold. */
export function rankHeapCensus(measurements: readonly CensusMeasurement[], opts: {
  liveSetBytes: number; censusSha: string; censusDate: string; share?: number; filingBytes?: number; corpus?: string;
}): HeapCensusRanking {
  const threshold = censusFilingThreshold(opts.liveSetBytes, opts.share, opts.filingBytes);
  const sorted = [...measurements].sort((a, b) => b.retained_bytes - a.retained_bytes);
  const holders = sorted.map((measurement, index): RankedHolder => {
    const share = opts.liveSetBytes > 0 ? measurement.retained_bytes / opts.liveSetBytes : 0;
    const perEntry = measurement.entries > 0 ? Math.round(measurement.retained_bytes / measurement.entries) : 0;
    const ranked: RankedHolder = { ...measurement, rank: index + 1, share, per_entry_bytes: perEntry };
    if (measurement.error === undefined && measurement.retained_bytes >= threshold && measurement.retained_bytes > 0) {
      ranked.proposed_task = {
        subject: `the daemon's ${measurement.holder} holder retains ${Math.round(measurement.retained_bytes / MIB)} MiB ` +
          `(${(share * 100).toFixed(1)}% of its measured live set); shrink it and show the saving on daemon.memory`,
        evidence: [
          `OBSERVED offline census ${opts.censusSha.slice(0, 12)} ${opts.censusDate}${opts.corpus ? ` (${opts.corpus})` : ""}: ${measurement.name} ` +
            `retains ${measurement.retained_bytes} bytes over ${measurement.entries} entries (${perEntry} bytes/entry), rank ${index + 1}`,
          `filing threshold ${Math.round(threshold)} bytes = min(${opts.share ?? CENSUS_FILING_SHARE} x live set ${opts.liveSetBytes}, ${opts.filingBytes ?? CENSUS_FILING_BYTES})`,
        ],
        files: measurement.files,
        holder: measurement.holder,
        acceptance: `daemon.memory holder "${measurement.holder}" bytes p50 over one generation after the fix's boot_head_sha ` +
          `falls below the generation before it`,
      };
    }
    return ranked;
  });
  return {
    census_sha: opts.censusSha, census_date: opts.censusDate, live_set_bytes: opts.liveSetBytes, threshold_bytes: Math.round(threshold),
    measured_bytes: sorted.reduce((sum, m) => sum + m.retained_bytes, 0), holders,
  };
}

/** The ranking as a markdown table: holder, entries, retained bytes, share of the live set, bytes per entry. */
export function renderHeapCensus(ranking: HeapCensusRanking): string {
  const mib = (bytes: number): string => (bytes / MIB).toFixed(1);
  const lines = [
    `census ${ranking.census_sha.slice(0, 12)} ${ranking.census_date}; live set ${mib(ranking.live_set_bytes)} MiB; filing threshold ${mib(ranking.threshold_bytes)} MiB`,
    "",
    "| rank | holder (daemon.memory name) | measured as | entries | retained MiB | share of live set | bytes/entry | files |",
    "|---:|---|---|---:|---:|---:|---:|:---:|",
  ];
  for (const row of ranking.holders) {
    lines.push(`| ${row.rank} | ${row.holder} | ${row.name}${row.error ? ` (error: ${row.error})` : ""} | ${row.entries} | ${mib(row.retained_bytes)} | ` +
      `${(row.share * 100).toFixed(1)}% | ${row.per_entry_bytes} | ${row.proposed_task ? "**file**" : ""} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** The per-entry figures a ranking measured, keyed for {@link DAEMON_MEMORY_CALIBRATION}. */
export function calibrationFrom(ranking: HeapCensusRanking): Record<string, CensusCalibration> {
  const table: Record<string, CensusCalibration> = {};
  for (const row of ranking.holders) {
    if (!row.calibrationKey || row.error !== undefined || row.entries === 0) continue;
    table[row.calibrationKey] = { per_entry_bytes: row.per_entry_bytes, entries: row.entries, census_sha: ranking.census_sha.slice(0, 12), census_date: ranking.census_date };
  }
  return table;
}
