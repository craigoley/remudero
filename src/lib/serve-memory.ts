/**
 * lib/serve-memory.ts — W1-T5175: serve names what holds its memory, and relieves it itself.
 *
 * OBSERVED 2026-10-01: the kernel killed serve's node at 16:09:17Z (memcg, anon-rss 5.0 GB of the
 * 5 GiB container limit); serve then sat at 3.8-4.2 GiB minutes after each start, and no ledger row
 * said which cache, projector or view body held it. During shadow serve pays twice — the legacy
 * route caches AND the read model's view bodies — until Phase 4 retires the legacy caches.
 *
 * NO NEW BOUND, NO NEW REFUSAL. Two things only:
 *   1. {@link sampleServeMemory}: a `serve.memory` row every {@link SERVE_MEMORY_SAMPLE_MS} — rss,
 *      heapUsed, external, arrayBuffers, the container's own limit and free bytes, and every named
 *      {@link MemoryHolder}'s entry count and approximate bytes.
 *   2. {@link relieveServeMemory}: a tiered, self-healing answer to the container's OWN headroom
 *      (read from the cgroup as a fraction of its limit, never a fixed byte count). Below
 *      {@link LEGACY_RELIEF_HEADROOM} it drops the legacy route caches of views the read model already
 *      serves or shadows (they rebuild on the next read); below {@link REFRESHABLE_RELIEF_HEADROOM} it
 *      also sheds the single largest refreshable holder (it rebuilds on its own cadence). Each drop
 *      ledgers `serve.memory_relieved` with the holder and its bytes. Nothing refuses a request.
 * A relief repeated on consecutive samples escalates ONCE through the incident path's own
 * `incident.event` shape ({@link invariantFindingLedgerLine}), re-armed only when headroom recovers.
 *
 * FALSIFIER: test/serve-names-and-relieves-its-memory-pressure.test.ts.
 */

import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { normalizedReadUrl } from "./console-snapshot-cache.js";
import type { ConsoleSnapshotStore } from "./console-snapshot-store.js";
import { FEEDBACK_VIEW_NAME } from "./feedback-view.js";
import { INBOX_VIEW_NAME } from "./inbox-view.js";
import { invariantFindingLedgerLine } from "./incident-invariants.js";
import type { LedgerLine } from "./ledger.js";
import { NOW_VIEW_NAME } from "./now-view.js";
import { cgroupFreeMemory } from "./serve-supervisor.js";
import type { RouteHandler } from "./service.js";
import type { EffectiveViewMode } from "./views.js";

export const SERVE_MEMORY_STEP = "serve.memory";
export const SERVE_MEMORY_RELIEVED_STEP = "serve.memory_relieved";
export const SERVE_MEMORY_SAMPLE_FAILED_STEP = "serve.memory_sample_failed";
export const SERVE_MEMORY_ESCALATION_FAILED_STEP = "serve.memory_escalation_failed";
/** The `incident.event` name a repeated relief files under. */
export const SERVE_MEMORY_RELIEF_RULE_ID = "serve-memory-relief";
/** "Every few minutes": often enough to see a climb to the limit, rare enough that sizing every holder costs nothing. */
export const SERVE_MEMORY_SAMPLE_MS = 3 * 60_000;
/** Fractions of the container's own limit, so the same line holds at 2 GiB or 8 GiB. */
export const LEGACY_RELIEF_HEADROOM = 0.25;
export const REFRESHABLE_RELIEF_HEADROOM = 0.1;
/** Relieved on this many consecutive samples is "repeated", and escalates once. */
export const SERVE_MEMORY_ESCALATE_AFTER = 2;
/** Nodes one {@link approxBytes} walk visits before it stops: the estimate is a lower bound past it. */
export const APPROX_BYTES_NODE_BUDGET = 200_000;
/** Distinct reads one route cache's size book keeps, above `console-snapshot-cache.ts`'s 16 entries per route. */
const SIZE_BOOK_LIMIT = 64;

/** The read-model view each legacy cached read path is replaced by (docs/views.md). A path with no
 *  row is replaced by no view, so its cache is measured but never dropped by tier 1. */
export const LEGACY_CACHE_VIEWS: Readonly<Record<string, string>> = {
  "/v1/status": NOW_VIEW_NAME,
  "/v1/recent": NOW_VIEW_NAME,
  "/v1/inbox": INBOX_VIEW_NAME,
  "/v1/feedback": FEEDBACK_VIEW_NAME,
  "/v1/repos": "repositories",
  "/v1/repos/summary": "repositories",
};

/**
 * An approximate retained size: string characters, 8 bytes a primitive or slot, a typed array's
 * byteLength, 16 bytes of header per container. Shared references count once; accessors are never
 * invoked. A walk past `budget` nodes stops and returns what it counted — a lower bound, never a throw.
 */
export function approxBytes(value: unknown, budget: number = APPROX_BYTES_NODE_BUDGET): number {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [value];
  let bytes = 0;
  let visited = 0;
  const push = (next: unknown): void => {
    if (stack.length < budget) stack.push(next);
  };
  while (stack.length > 0 && visited < budget) {
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
    if (next instanceof Map || next instanceof Set) {
      bytes += 16 + 16 * next.size;
      for (const entry of next instanceof Map ? next.entries() : next.values()) push(entry);
      continue;
    }
    const names = Object.getOwnPropertyNames(next);
    bytes += 16 + 8 * names.length;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(next, name);
      if (descriptor && "value" in descriptor) push(descriptor.value);
      if (!Array.isArray(next)) bytes += name.length;
    }
  }
  return bytes;
}

/** What one holder reports of itself. `parts` breaks a grouped holder down (view bodies by view and generation). */
export interface MemoryHolderSize {
  entries: number;
  bytes: number;
  parts?: Record<string, { entries: number; bytes: number }>;
}

/**
 * One named thing serve keeps in memory. `legacy-cache` holders carry the `view` that replaces them
 * and a `drop`; `refreshable` holders carry a `drop` their own refresh undoes; `view-bodies` and
 * `measured` holders are sized only.
 */
export interface MemoryHolder {
  name: string;
  kind: "legacy-cache" | "refreshable" | "view-bodies" | "measured";
  view?: string;
  size(): MemoryHolderSize;
  drop?(): void;
}

/** Every holder serve registered, keyed by name: re-registering a name replaces it, so the book never grows past what serve holds. */
export function createServeMemoryRegistry(): { add(holder: MemoryHolder): void; holders(): readonly MemoryHolder[] } {
  const holders = new Map<string, MemoryHolder>();
  return {
    add: (holder) => void holders.set(holder.name, holder),
    holders: () => [...holders.values()],
  };
}

export type ServeMemoryRegistry = ReturnType<typeof createServeMemoryRegistry>;

/** A process-owned value (a snapshot, a refresh result). With `drop` it is refreshable: dropping it is undone by its own refresh. */
export function snapshotHolder(name: string, current: () => unknown, drop?: () => void): MemoryHolder {
  return {
    name,
    kind: drop ? "refreshable" : "measured",
    size: () => {
      const value = current();
      return value === undefined || value === null ? { entries: 0, bytes: 0 } : { entries: 1, bytes: approxBytes(value) };
    },
    ...(drop ? { drop } : {}),
  };
}

/** The read model's view bodies, broken down by `<view>@g<generation>` so a generation left behind is visible. */
export function viewBodiesHolder(bodies: () => ReadonlyMap<string, { view: string; generation: number; body: unknown }>): MemoryHolder {
  return {
    name: "view-bodies",
    kind: "view-bodies",
    size: () => {
      const parts: Record<string, { entries: number; bytes: number }> = {};
      let entries = 0;
      let bytes = 0;
      for (const entry of bodies().values()) {
        const part = (parts[`${entry.view}@g${entry.generation}`] ??= { entries: 0, bytes: 0 });
        const size = approxBytes(entry.body);
        part.entries += 1;
        part.bytes += size;
        entries += 1;
        bytes += size;
      }
      return { entries, bytes, parts };
    },
  };
}

/** The same store with its restore emptied: a cache rebuilt after a drop must not reload from disk what the drop just shed. */
export function withoutRestore(store: ConsoleSnapshotStore | undefined): ConsoleSnapshotStore | undefined {
  if (!store) return undefined;
  return { restore: async () => [], save: (path, key, cached) => store.save(path, key, cached) };
}

/**
 * A legacy route cache serve can size and drop. `make(afterDrop)` builds the cache's handler; the
 * wrapper books the body each read answers with (one entry per normalized query, bounded), and
 * `drop` swaps in a fresh cache so the old one's entries are collected and the next read rebuilds.
 */
export function droppableRouteCache(
  name: string,
  view: string | undefined,
  make: (afterDrop: boolean) => RouteHandler,
): { handler: RouteHandler; holder: MemoryHolder } {
  let inner = make(false);
  const sizes = new Map<string, number>();
  const book = (key: string, chunk: unknown): void => {
    const bytes = typeof chunk === "string" ? chunk.length : Buffer.isBuffer(chunk) ? chunk.byteLength : 0;
    if (bytes === 0) return;
    sizes.delete(key);
    sizes.set(key, bytes);
    if (sizes.size > SIZE_BOOK_LIMIT) sizes.delete(sizes.keys().next().value!);
  };
  const handler: RouteHandler = async (req, res, ctx) => {
    const key = normalizedReadUrl(req.url ?? "/");
    const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      book(key, chunk);
      return end(chunk, ...rest);
    }) as ServerResponse["end"];
    await inner(req, res, ctx);
  };
  const holder: MemoryHolder = {
    name,
    kind: "legacy-cache",
    ...(view ? { view } : {}),
    size: () => ({ entries: sizes.size, bytes: [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0) }),
    drop: () => {
      inner = make(true);
      sizes.clear();
    },
  };
  return { handler, holder };
}

/** The container's own memory limit and the bytes it can still give, from cgroup v2. */
export interface CgroupHeadroom {
  limitBytes: number;
  freeBytes: number;
  /** freeBytes / limitBytes: the share of the container still free. */
  fraction: number;
}

/** Undefined when there is no cgroup v2 limit to read (macOS, a host process, `memory.max` = `max`): then nothing is relieved. */
export function readCgroupHeadroom(
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  root = "/sys/fs/cgroup",
): CgroupHeadroom | undefined {
  let limitBytes: number;
  try {
    limitBytes = Number(read(join(root, "memory.max")).trim());
  } catch {
    return undefined; // no cgroup v2 here: headroom is unmeasurable, so the relief tiers stay idle and the sample says null
  }
  const freeBytes = cgroupFreeMemory(read, root);
  if (!Number.isFinite(limitBytes) || limitBytes <= 0 || freeBytes === undefined) return undefined;
  return { limitBytes, freeBytes, fraction: Math.max(0, freeBytes) / limitBytes };
}

/** One holder's line in the `serve.memory` row; `error` names a holder that could not size itself. */
export interface HolderReading extends MemoryHolderSize {
  name: string;
  kind: MemoryHolder["kind"];
  view?: string;
  error?: string;
}

/** The `serve.memory` row's fields. A null limit/free/headroom means the cgroup was unreadable. */
export interface ServeMemorySample {
  rss_bytes: number;
  heap_used_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
  limit_bytes: number | null;
  free_bytes: number | null;
  headroom: number | null;
  holders: HolderReading[];
}

/** Sample this process's memory and every holder's size. A holder that throws is named with its error, never dropped from the row. */
export function sampleServeMemory(
  holders: readonly MemoryHolder[],
  opts: { usage?: () => NodeJS.MemoryUsage; headroom?: () => CgroupHeadroom | undefined } = {},
): ServeMemorySample {
  const usage = (opts.usage ?? process.memoryUsage)();
  const headroom = (opts.headroom ?? readCgroupHeadroom)();
  return {
    rss_bytes: usage.rss,
    heap_used_bytes: usage.heapUsed,
    external_bytes: usage.external,
    array_buffers_bytes: usage.arrayBuffers,
    limit_bytes: headroom?.limitBytes ?? null,
    free_bytes: headroom?.freeBytes ?? null,
    headroom: headroom?.fraction ?? null,
    holders: holders.map((holder) => {
      const named = { name: holder.name, kind: holder.kind, ...(holder.view ? { view: holder.view } : {}) };
      try {
        return { ...named, ...holder.size() };
      } catch (e) {
        return { ...named, entries: 0, bytes: 0, error: String((e as Error)?.message ?? e) };
      }
    }),
  };
}

/** One `serve.memory_relieved` row: which holder, why (tier and headroom), and what it held. */
export interface MemoryRelief {
  holder: string;
  kind: MemoryHolder["kind"];
  view?: string;
  mode?: EffectiveViewMode;
  tier: 1 | 2;
  entries: number;
  bytes: number;
  headroom: number;
  error?: string;
}

function dropped(holder: MemoryHolder, reading: HolderReading, tier: 1 | 2, headroom: number, mode?: EffectiveViewMode): MemoryRelief {
  const relief: MemoryRelief = {
    holder: holder.name, kind: holder.kind, ...(holder.view ? { view: holder.view } : {}), ...(mode ? { mode } : {}),
    tier, entries: reading.entries, bytes: reading.bytes, headroom,
  };
  try {
    holder.drop?.();
  } catch (e) {
    // Recorded on the relief row itself: a drop that failed is ledgered as failed, never counted as freed.
    relief.error = String((e as Error)?.message ?? e);
  }
  return relief;
}

/**
 * The tiered relief over one sample. Tier 1 (headroom under {@link LEGACY_RELIEF_HEADROOM}): every
 * non-empty legacy cache whose view the read model serves or shadows. Tier 2 (under
 * {@link REFRESHABLE_RELIEF_HEADROOM}): the single largest non-empty refreshable holder. A switched-off
 * view's cache is the one it still answers from, so it is never dropped.
 */
export function relieveServeMemory(
  sample: ServeMemorySample,
  holders: readonly MemoryHolder[],
  modeOf: (view: string) => EffectiveViewMode | undefined,
): MemoryRelief[] {
  const headroom = sample.headroom;
  if (headroom === null || headroom >= LEGACY_RELIEF_HEADROOM) return [];
  const readings = new Map(sample.holders.map((reading) => [reading.name, reading]));
  const reliefs: MemoryRelief[] = [];
  for (const holder of holders) {
    const reading = readings.get(holder.name);
    if (holder.kind !== "legacy-cache" || holder.view === undefined || !reading || reading.bytes <= 0) continue;
    const mode = modeOf(holder.view);
    if (mode === "serve" || mode === "shadow") reliefs.push(dropped(holder, reading, 1, headroom, mode));
  }
  if (headroom < REFRESHABLE_RELIEF_HEADROOM) {
    const largest = holders
      .filter((holder) => holder.kind === "refreshable" && (readings.get(holder.name)?.bytes ?? 0) > 0)
      .sort((a, b) => readings.get(b.name)!.bytes - readings.get(a.name)!.bytes)[0];
    if (largest) reliefs.push(dropped(largest, readings.get(largest.name)!, 2, headroom));
  }
  return reliefs;
}

/** What {@link startServeMemoryMonitor} needs: the holders, how to sample them, and where rows go. */
export interface ServeMemoryMonitorOptions {
  holders: () => readonly MemoryHolder[];
  sample: (holders: readonly MemoryHolder[]) => ServeMemorySample;
  modeOf?: (view: string) => EffectiveViewMode | undefined;
  log?: (step: string, extra: Record<string, unknown>) => void;
  /** Appends the escalation's `incident.event` row to the ledger the incident path reads. */
  incident?: (line: LedgerLine) => void;
  escalateAfter?: number;
  clock?: Clock;
  intervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/**
 * Serve's own loop: sample, ledger, relieve, and escalate a repeated relief once. Each failure is
 * ledgered and swallowed so one bad sample never silences the next. Returns the stop.
 */
export function startServeMemoryMonitor(opts: ServeMemoryMonitorOptions): () => void {
  const log = opts.log ?? (() => {});
  const clock = opts.clock ?? systemClock;
  const intervalMs = opts.intervalMs ?? SERVE_MEMORY_SAMPLE_MS;
  const escalateAfter = opts.escalateAfter ?? SERVE_MEMORY_ESCALATE_AFTER;
  const setTimer = opts.setInterval ?? setInterval;
  const clearTimer = opts.clearInterval ?? clearInterval;
  let streak = 0;
  let escalated = false;

  const escalate = (sample: ServeMemorySample, reliefs: readonly MemoryRelief[]): void => {
    escalated = true;
    const message = `serve relieved memory on ${streak} consecutive samples; headroom=${Math.round((sample.headroom ?? 0) * 100)}% of ` +
      `${sample.limit_bytes} bytes, rss=${sample.rss_bytes}; last relief: ${reliefs.map((relief) => `${relief.holder} (${relief.bytes} bytes)`).join(", ")}`;
    try {
      opts.incident?.(invariantFindingLedgerLine({ ruleId: SERVE_MEMORY_RELIEF_RULE_ID, message, longMs: intervalMs * streak, shortMs: intervalMs }, clock.now()));
    } catch (e) {
      log(SERVE_MEMORY_ESCALATION_FAILED_STEP, { reason: String((e as Error)?.message ?? e) });
    }
  };

  const tick = (): void => {
    const holders = opts.holders();
    let sample: ServeMemorySample;
    try {
      sample = opts.sample(holders);
    } catch (e) {
      log(SERVE_MEMORY_SAMPLE_FAILED_STEP, { reason: String((e as Error)?.message ?? e) });
      return;
    }
    log(SERVE_MEMORY_STEP, { ...sample });
    const reliefs = relieveServeMemory(sample, holders, opts.modeOf ?? (() => undefined));
    for (const relief of reliefs) log(SERVE_MEMORY_RELIEVED_STEP, { ...relief });
    if (sample.headroom === null || sample.headroom >= LEGACY_RELIEF_HEADROOM) {
      streak = 0;
      escalated = false;
      return;
    }
    if (reliefs.length === 0) return;
    streak += 1;
    if (streak >= escalateAfter && !escalated) escalate(sample, reliefs);
  };

  const timer = setTimer(tick, intervalMs);
  timer.unref?.();
  return () => clearTimer(timer);
}
