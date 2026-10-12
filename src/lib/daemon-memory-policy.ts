/**
 * lib/daemon-memory-policy.ts — keep the daemon's heap proportional to its live set, keep its heap
 * ceiling out of its children, and judge memory pressure by what the container is charged.
 *
 * WHY: under the container's `--max-old-space-size=8192`, V8's growth factor let garbage reach about
 * four times the daemon's 0.6-0.9 GB live set before a major GC (core host census, 2026-10-10).
 *
 *  1. {@link applyDaemonMemoryPolicy}, first thing at daemon entry, sets `--heap-growing-percent`
 *     (NODE_OPTIONS refuses it; `v8.setFlagsFromString` accepts it at runtime) and removes
 *     `--max-old-space-size` from the NODE_OPTIONS children inherit. The daemon keeps its own
 *     ceiling. A child that needs a budget passes it on its own command line, which wins anyway.
 *  2. {@link createDaemonMemoryGovernor} reads RSS plus swap as a share of the container's
 *     memory.high (else memory.max) each tick. Above `tightenShare` it lowers the growth factor in
 *     proportion and restores it when the share falls. It asks for a restart only when the share
 *     stays at `restartShare` with the tightest factor already in force; the loop takes that through
 *     its tick-boundary drain (daemon.ts), never as a kill.
 *
 * TRAP: unknown is not pressure. No cgroup budget (a dev Mac, an unlimited container) reads no
 * share, and the loop falls back to its fraction of V8's own limit.
 *
 * FALSIFIER: test/the-daemon-heap-stays-proportional-to-its-live-set.test.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { parse as parseYaml } from "yaml";

import { FOOTPRINT_MAX_SAMPLES, FOOTPRINT_RETAIN_MS } from "./daemon-footprint.js";

/** `plan/policy.yaml`'s optional `daemonMemory:` section, resolved. */
export interface DaemonMemoryPolicy {
  /** V8 grows the old generation to (1 + this/100) times what survived the last major GC. */
  heapGrowingPercent: number;
  /** RSS+swap as a share of the container's budget above which the growth factor tightens. */
  tightenShare: number;
  /** The share at which, with the tightest factor already in force, the daemon drains and restarts. */
  restartShare: number;
}

/** What an absent section (or an absent field within a present one) resolves to. 50 measured a 45%
 *  lower peak heap for about 14% less synthetic throughput (2026-10-10, local). */
export const DEFAULT_DAEMON_MEMORY_POLICY: DaemonMemoryPolicy = {
  heapGrowingPercent: 50,
  tightenShare: 0.3,
  restartShare: 0.5,
};

/** The tightest growth factor the governor applies: a collection at every 10% of growth. */
export const TIGHTEST_HEAP_GROWING_PERCENT = 10;

const ROW_BOUNDS: Record<keyof DaemonMemoryPolicy, { min: number; max: number }> = {
  heapGrowingPercent: { min: TIGHTEST_HEAP_GROWING_PERCENT, max: 300 },
  tightenShare: { min: 0.05, max: 0.95 },
  restartShare: { min: 0.1, max: 1 },
};

function numberRow(field: keyof DaemonMemoryPolicy, raw: unknown): number {
  const path = `daemonMemory.${field}`;
  if (raw === undefined) return DEFAULT_DAEMON_MEMORY_POLICY[field];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`policy.yaml: '${path}' must be a mapping with 'value'/'origin'.`);
  }
  const { value } = raw as Record<string, unknown>;
  const { min, max } = ROW_BOUNDS[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`policy.yaml: '${path}.value' must be a number in [${min}, ${max}], got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** Parse an already-parsed `plan/policy.yaml` mapping's optional `daemonMemory:` section. Pure. Each field
 *  defaults on its own; a present but malformed field throws. */
export function parseDaemonMemoryPolicy(raw: unknown): DaemonMemoryPolicy {
  if (raw === undefined) return { ...DEFAULT_DAEMON_MEMORY_POLICY };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("policy.yaml: 'daemonMemory' must be a mapping.");
  }
  const section = raw as Record<string, unknown>;
  const policy = {
    heapGrowingPercent: numberRow("heapGrowingPercent", section.heapGrowingPercent),
    tightenShare: numberRow("tightenShare", section.tightenShare),
    restartShare: numberRow("restartShare", section.restartShare),
  };
  if (policy.tightenShare >= policy.restartShare) {
    throw new Error(`policy.yaml: 'daemonMemory.tightenShare' (${policy.tightenShare}) must be below restartShare (${policy.restartShare}).`);
  }
  return policy;
}

/** Read the section from disk. Never throws: a daemon must boot on a malformed row, so the defaults
 *  apply and the reason travels to the boot row. */
export function readDaemonMemoryPolicy(
  policyYamlPath: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): { policy: DaemonMemoryPolicy; error?: string } {
  try {
    const raw = parseYaml(read(policyYamlPath)) as unknown;
    const section = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).daemonMemory : undefined;
    return { policy: parseDaemonMemoryPolicy(section) };
  } catch (e) {
    return { policy: { ...DEFAULT_DAEMON_MEMORY_POLICY }, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/** The V8 flag for a growth percent. */
export function heapGrowingFlag(percent: number): string {
  return `--heap-growing-percent=${Math.round(percent)}`;
}

const HEAP_CEILING_FLAG = /^--max[-_]old[-_]space[-_]size(=.*)?$/;

/** NODE_OPTIONS with every `--max-old-space-size` removed (both `=N` and the two-word form), every other
 *  word kept in order. `undefined` when nothing remains. */
export function withoutHeapCeiling(nodeOptions: string | undefined): string | undefined {
  if (nodeOptions === undefined) return undefined;
  const words = nodeOptions.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = HEAP_CEILING_FLAG.exec(words[i]);
    if (!m) {
      kept.push(words[i]);
      continue;
    }
    if (m[1] === undefined && i + 1 < words.length && /^\d+$/.test(words[i + 1])) i++;
  }
  return kept.length > 0 ? kept.join(" ") : undefined;
}

export interface DaemonMemoryEntryIo {
  setFlags?: (flags: string) => void;
  /** The environment children inherit. Production: `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface DaemonMemoryEntryResult {
  heap_growing_percent: number;
  /** The NODE_OPTIONS this process was started with, and what its children now inherit. */
  node_options_before?: string;
  node_options_children?: string;
}

/** Daemon entry: set the growth factor and take the heap ceiling out of the inherited NODE_OPTIONS. This
 *  process's own ceiling is fixed at startup and is unchanged. */
export function applyDaemonMemoryPolicy(policy: DaemonMemoryPolicy, io: DaemonMemoryEntryIo = {}): DaemonMemoryEntryResult {
  (io.setFlags ?? setFlagsFromString)(heapGrowingFlag(policy.heapGrowingPercent));
  const env = io.env ?? process.env;
  const before = env.NODE_OPTIONS;
  const after = withoutHeapCeiling(before);
  if (after === undefined) delete env.NODE_OPTIONS;
  else env.NODE_OPTIONS = after;
  return {
    heap_growing_percent: Math.round(policy.heapGrowingPercent),
    ...(before !== undefined ? { node_options_before: before } : {}),
    ...(after !== undefined ? { node_options_children: after } : {}),
  };
}

/** One reading of what the daemon is charged and what the container allows. */
export interface DaemonMemoryReading {
  rss_bytes: number;
  /** /proc/self/status VmSwap; absent when unreadable, never a zero standing in for unknown. */
  swap_bytes?: number;
  /** memory.high, else memory.max, whichever is the smaller finite value; absent when neither is. */
  budget_bytes?: number;
  budget_source?: "memory.high" | "memory.max";
}

export interface DaemonMemoryReadingIo {
  rss?: () => number;
  readFile?: (path: string) => string;
  cgroupRoot?: string;
  procStatusPath?: string;
}

function finiteBytes(read: (path: string) => string, path: string): number | undefined {
  try {
    const text = read(path).trim();
    if (!/^\d+$/.test(text)) return undefined; // "max" is no budget
    const n = Number(text);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined; // Reason: an unreadable file is no budget, and no budget is no pressure.
  }
}

export function readDaemonMemory(io: DaemonMemoryReadingIo = {}): DaemonMemoryReading {
  const read = io.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const root = io.cgroupRoot ?? "/sys/fs/cgroup";
  const reading: DaemonMemoryReading = { rss_bytes: (io.rss ?? (() => process.memoryUsage.rss()))() };
  try {
    const kb = /^VmSwap:\s+(\d+)\s+kB/m.exec(read(io.procStatusPath ?? "/proc/self/status"))?.[1];
    if (kb !== undefined) reading.swap_bytes = Number(kb) * 1024;
  } catch {
    // Reason: swap stays absent; the share is then RSS alone, which can only understate pressure.
  }
  const high = finiteBytes(read, join(root, "memory.high"));
  const max = finiteBytes(read, join(root, "memory.max"));
  if (high !== undefined && (max === undefined || high <= max)) {
    reading.budget_bytes = high;
    reading.budget_source = "memory.high";
  } else if (max !== undefined) {
    reading.budget_bytes = max;
    reading.budget_source = "memory.max";
  }
  return reading;
}

export type MemoryPressureTier = "clear" | "tighten" | "restart";

export interface MemoryPressureDecision {
  tier: MemoryPressureTier;
  /** (rss + swap) / budget; absent when the budget is unknown. */
  share?: number;
  heapGrowingPercent: number;
  /** Operator-facing reason, present on the restart tier. */
  detail?: string;
}

/**
 * Pure: the tier for one reading, given the growth percent in force since the previous tick. Below
 * `tightenShare` the policy's own percent; between the shares a percent that falls linearly to
 * {@link TIGHTEST_HEAP_GROWING_PERCENT}; at or above `restartShare` the tightest percent first, and a
 * restart only once that percent was already in force and the share did not come down.
 */
export function decideMemoryPressure(
  reading: DaemonMemoryReading,
  policy: DaemonMemoryPolicy,
  inForcePercent: number,
): MemoryPressureDecision {
  const base = Math.round(policy.heapGrowingPercent);
  const budget = reading.budget_bytes;
  if (budget === undefined || !Number.isFinite(reading.rss_bytes)) return { tier: "clear", heapGrowingPercent: base };
  const charged = reading.rss_bytes + (reading.swap_bytes ?? 0);
  const share = charged / budget;
  if (share < policy.tightenShare) return { tier: "clear", share, heapGrowingPercent: base };
  if (share < policy.restartShare) {
    const along = (share - policy.tightenShare) / (policy.restartShare - policy.tightenShare);
    const percent = Math.round(base - (base - TIGHTEST_HEAP_GROWING_PERCENT) * along);
    return { tier: "tighten", share, heapGrowingPercent: Math.max(TIGHTEST_HEAP_GROWING_PERCENT, Math.min(base, percent)) };
  }
  if (inForcePercent > TIGHTEST_HEAP_GROWING_PERCENT) {
    return { tier: "tighten", share, heapGrowingPercent: TIGHTEST_HEAP_GROWING_PERCENT };
  }
  const mb = (n: number) => Math.round(n / 1048576);
  return {
    tier: "restart",
    share,
    heapGrowingPercent: TIGHTEST_HEAP_GROWING_PERCENT,
    detail:
      `daemon rss+swap ${mb(charged)} MB is ${Math.round(share * 100)}% of the container's ${reading.budget_source} ` +
      `${mb(budget)} MB with the tightest heap growth already in force — draining and restarting at a tick boundary`,
  };
}

export interface MemoryGovernorStep extends MemoryPressureDecision {
  reading: DaemonMemoryReading;
  /** True when the tier or the applied growth percent changed on this step. */
  changed: boolean;
  previousTier: MemoryPressureTier;
}

export interface DaemonMemoryGovernor {
  step(): MemoryGovernorStep;
  /** The growth percent last applied (W1-T8401: a reclaim restores it after its tightest-factor collection). */
  inForcePercent?(): number;
}

export interface DaemonMemoryGovernorOptions {
  policy?: DaemonMemoryPolicy;
  read?: () => DaemonMemoryReading;
  setFlags?: (flags: string) => void;
}

/** The stateful half: reads, decides, applies a changed growth percent, and remembers what is in force. */
export function createDaemonMemoryGovernor(opts: DaemonMemoryGovernorOptions): DaemonMemoryGovernor {
  const policy = opts.policy ?? DEFAULT_DAEMON_MEMORY_POLICY;
  const setFlags = opts.setFlags ?? setFlagsFromString;
  const read = opts.read ?? (() => readDaemonMemory());
  let inForce = Math.round(policy.heapGrowingPercent);
  let tier: MemoryPressureTier = "clear";
  return {
    step() {
      const reading = read();
      const decision = decideMemoryPressure(reading, policy, inForce);
      const previousTier = tier;
      const changed = decision.tier !== tier || decision.heapGrowingPercent !== inForce;
      if (decision.heapGrowingPercent !== inForce) setFlags(heapGrowingFlag(decision.heapGrowingPercent));
      inForce = decision.heapGrowingPercent;
      tier = decision.tier;
      return { ...decision, reading, changed, previousTier };
    },
    inForcePercent: () => inForce,
  };
}

// ── W1-T8401 — the daemon reclaims its own slack before container pressure holds dispatch ─────────
//
// OBSERVED 2026-10-11T22:59Z (core): `dispatch_deferred_wip` held refills container-short, 1588 MiB above a 1610 MiB
// container floor against a 2048 MiB implement worker, while the daemon held 2.79 GB RSS on a 0.81 GB main-heap live
// set. The governors read the daemon's footprint as a fixed cost. Before a container-short hold, the daemon now gives
// back what it can (one full collection under the tightest growth factor) and the governor decides on a fresh reading.
//
// MEASURED 2026-10-12 on core's daemon.alive rows (04:09-10:19Z, 468 rows): over the 113 heartbeat intervals in which
// V8's own collections shrank heap_total by 100 MB or more (32.1 GB in all), RSS fell 7.6 GB and RSS+swap 6.1 GB; the
// rest reappeared as `unattributed_bytes_approx`. An ordinary collection returns about a fifth of what it frees. So
// the reclaim asks for V8's `last-resort` flavor (compacts and releases pooled pages: on a synthetic 0.6 GB heap,
// RSS fell 232 MB against 41 MB for a plain major collection, macOS, Node 24.21). Each reclaim row splits what it
// returned into heap, external and outside-the-heaps bytes, so the live answer comes from the rows, not this estimate.

/** One reading of the daemon's own memory before or after a reclaim. */
export interface SlackSnapshot {
  rss_bytes: number;
  swap_bytes?: number;
  heap_used_bytes: number;
  heap_physical_bytes: number;
  external_bytes: number;
  heap_size_limit_bytes: number;
}

export function readSlackSnapshot(io: DaemonMemoryReadingIo = {}): SlackSnapshot {
  const reading = readDaemonMemory(io);
  const heap = getHeapStatistics();
  return {
    rss_bytes: reading.rss_bytes,
    ...(reading.swap_bytes !== undefined ? { swap_bytes: reading.swap_bytes } : {}),
    heap_used_bytes: heap.used_heap_size,
    heap_physical_bytes: heap.total_physical_size,
    external_bytes: process.memoryUsage().external,
    heap_size_limit_bytes: heap.heap_size_limit,
  };
}

type ExposedCollector = (options?: Record<string, string>) => void;
let exposedCollector: ExposedCollector | undefined;

/** A full, synchronous, compacting collection. The collector is exposed on first use: `--expose-gc` set at runtime
 *  binds `gc` in contexts created after it, so a fresh context hands it back. Throws when it cannot be exposed. */
export function fullCollection(): void {
  if (exposedCollector === undefined) {
    setFlagsFromString("--expose-gc");
    exposedCollector = runInNewContext("gc") as ExposedCollector;
  }
  exposedCollector({ type: "major", execution: "sync", flavor: "last-resort" });
}

/** The reading's own variance: the median absolute change between successive values. Undefined with fewer than two. */
export function successiveSpread(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined;
  const changes = values.slice(1).map((v, i) => Math.abs(v - values[i])).sort((a, b) => a - b);
  const mid = Math.floor(changes.length / 2);
  return changes.length % 2 === 1 ? changes[mid] : (changes[mid - 1] + changes[mid]) / 2;
}

/** One measured collection: the live set it left, and the heap the daemon held before it. */
export interface LiveSetSample {
  at: number;
  live_bytes: number;
  heap_before_bytes: number;
}

/** The heap ceiling the daemon would want, beside the one in force. SHADOW: nothing applies it. */
export interface DerivedHeapCeiling {
  shadow: true;
  ceiling_in_force_bytes: number;
  derived_ceiling_bytes?: number;
  /** Why no ceiling is derived yet. */
  derived_unlearned?: string;
  live_samples: number;
  live_peak_bytes?: number;
  live_spread_bytes?: number;
  growth_percent: number;
  /** Collections whose live set, grown by the growth factor, passed the ceiling derived from the samples before it. */
  live_outgrew_prior_ceiling_count: number;
  /** Collections whose heap before collecting already exceeded the derived ceiling (it would have collected sooner). */
  heap_over_ceiling_count: number;
}

function ceilingOf(samples: readonly LiveSetSample[], growthPercent: number): { ceiling: number; peak: number; spread: number } {
  const lives = samples.map((s) => s.live_bytes);
  const peak = Math.max(...lives);
  const spread = peak - Math.min(...lives);
  // The peak live set, room for it to range once more by its own observed range, and the growth V8 allows above the
  // live set before it collects. Every term is observed or configured; none is a fixed byte count.
  return { ceiling: Math.round((peak + spread) * (1 + growthPercent / 100)), peak, spread };
}

/** Pure: the derived ceiling over the post-collection live sets, beside the ceiling in force. */
export function deriveHeapCeiling(
  samples: readonly LiveSetSample[],
  growthPercent: number,
  ceilingInForceBytes: number,
): DerivedHeapCeiling {
  const base = {
    shadow: true as const, ceiling_in_force_bytes: ceilingInForceBytes, live_samples: samples.length,
    growth_percent: Math.round(growthPercent),
  };
  if (samples.length === 0) {
    return { ...base, derived_unlearned: "no measured collection yet", live_outgrew_prior_ceiling_count: 0, heap_over_ceiling_count: 0 };
  }
  const { ceiling, peak, spread } = ceilingOf(samples, growthPercent);
  let outgrew = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].live_bytes * (1 + growthPercent / 100) > ceilingOf(samples.slice(0, i), growthPercent).ceiling) outgrew++;
  }
  return {
    ...base,
    derived_ceiling_bytes: ceiling,
    live_peak_bytes: peak,
    live_spread_bytes: spread,
    live_outgrew_prior_ceiling_count: outgrew,
    heap_over_ceiling_count: samples.filter((s) => s.heap_before_bytes > ceiling).length,
  };
}

/** What one reclaim did, or why it did not run. Rides the hold row and its own `daemon.slack_reclaim` row. */
export interface SlackReclaimRecord {
  outcome: "reclaimed" | "paced" | "unavailable";
  rss_before_bytes: number;
  swap_before_bytes?: number;
  heap_used_before_bytes: number;
  /** The daemon's own rss+swap variance between heartbeats (its footprint samples); absent when unlearned. */
  noise_bytes?: number;
  /** The container working set's variance between the readings this reclaimer saw; absent when unlearned. */
  container_noise_bytes?: number;
  container_before_mib?: number;
  /** The caller's fresh reading after a collection. */
  container_after_mib?: number;
  rss_after_bytes?: number;
  swap_after_bytes?: number;
  /** The post-collection heap in use: the live set. */
  heap_used_after_bytes?: number;
  /** rss+swap before less after. */
  freed_bytes?: number;
  freed_heap_bytes?: number;
  freed_external_bytes?: number;
  /** freed_bytes less what the heaps and external memory returned: the part of the unattributed bytes it gave back. */
  freed_outside_heaps_bytes?: number;
  /** freed_bytes above the noise: worth repeating once the reading moves. */
  measurable?: boolean;
  collect_ms?: number;
  /** paced or unavailable: why no collection ran. */
  reason?: string;
  ceiling: DerivedHeapCeiling;
}

export interface DaemonSlackReclaimer {
  /** Reclaim once, unless the last reclaim freed nothing measurable and nothing has moved since. After a collection
   *  `reread` takes the caller's fresh reading and returns its container working set, so the row carries both sides. */
  reclaim(containerWorkingSetMib?: number, reread?: () => number | undefined): SlackReclaimRecord;
  derivedCeiling(): DerivedHeapCeiling;
}

export interface DaemonSlackReclaimerOptions {
  policy?: DaemonMemoryPolicy;
  collect?: () => void;
  snapshot?: () => SlackSnapshot;
  setFlags?: (flags: string) => void;
  /** The growth percent to restore after the tightest-factor collection: the memory governor's. */
  inForcePercent?: () => number;
  /** The daemon's rss+swap samples (daemon-footprint.ts), whose spread is the noise a reclaim must beat. */
  footprintBytes?: () => readonly number[];
  now?: () => number;
  log?: (record: SlackReclaimRecord) => void;
}

const MIB_BYTES = 1048576;

export function createDaemonSlackReclaimer(opts: DaemonSlackReclaimerOptions = {}): DaemonSlackReclaimer {
  const policy = opts.policy ?? DEFAULT_DAEMON_MEMORY_POLICY;
  const collect = opts.collect ?? fullCollection;
  const snapshot = opts.snapshot ?? (() => readSlackSnapshot());
  const setFlags = opts.setFlags ?? setFlagsFromString;
  const inForcePercent = opts.inForcePercent ?? (() => Math.round(policy.heapGrowingPercent));
  const now = opts.now ?? Date.now;
  const lives: LiveSetSample[] = [];
  const containerSeen: Array<{ at: number; mib: number }> = [];
  let futile: { liveBytes: number; containerMib?: number } | undefined;
  let ceilingInForce = 0;
  const ceiling = () => deriveHeapCeiling(lives, policy.heapGrowingPercent, ceilingInForce);
  const done = (record: SlackReclaimRecord): SlackReclaimRecord => {
    opts.log?.(record);
    return record;
  };
  return {
    derivedCeiling() {
      ceilingInForce = snapshot().heap_size_limit_bytes;
      return ceiling();
    },
    reclaim(containerMib, reread) {
      const at = now();
      if (containerMib !== undefined) {
        containerSeen.push({ at, mib: containerMib });
        while (containerSeen.length > 0 && at - containerSeen[0].at > FOOTPRINT_RETAIN_MS) containerSeen.shift();
        if (containerSeen.length > FOOTPRINT_MAX_SAMPLES) containerSeen.shift();
      }
      const before = snapshot();
      ceilingInForce = before.heap_size_limit_bytes;
      const noise = successiveSpread(opts.footprintBytes?.() ?? []);
      const containerSpreadMib = successiveSpread(containerSeen.slice(0, -1).map((s) => s.mib));
      const containerNoise = containerSpreadMib === undefined ? undefined : Math.round(containerSpreadMib * MIB_BYTES);
      const head = {
        rss_before_bytes: before.rss_bytes,
        ...(before.swap_bytes !== undefined ? { swap_before_bytes: before.swap_bytes } : {}),
        heap_used_before_bytes: before.heap_used_bytes,
        ...(noise !== undefined ? { noise_bytes: Math.round(noise) } : {}),
        ...(containerNoise !== undefined ? { container_noise_bytes: containerNoise } : {}),
        ...(containerMib !== undefined ? { container_before_mib: containerMib } : {}),
      };
      if (futile !== undefined) {
        const liveMoved = Math.abs(before.heap_used_bytes - futile.liveBytes);
        const containerMoved = containerMib === undefined || futile.containerMib === undefined ? undefined
          : Math.abs(containerMib - futile.containerMib) * MIB_BYTES;
        // The container's move counts only once its own variance is learned: unlearned, jitter and a move look alike.
        const moved = liveMoved > (noise ?? 0) || (containerMoved !== undefined && containerNoise !== undefined && containerMoved > containerNoise);
        if (!moved) {
          return done({
            outcome: "paced", ...head, ceiling: ceiling(),
            reason: `the last reclaim freed nothing above the noise; since then the heap moved ${Math.round(liveMoved / MIB_BYTES)} MiB` +
              (containerMoved === undefined ? "" : ` and the container ${Math.round(containerMoved / MIB_BYTES)} MiB`) +
              `, inside the noise (${noise === undefined ? "unlearned" : `${Math.round(noise / MIB_BYTES)} MiB`})`,
          });
        }
      }
      const started = now();
      try {
        setFlags(heapGrowingFlag(TIGHTEST_HEAP_GROWING_PERCENT));
        collect();
      } catch (error) {
        return done({ outcome: "unavailable", ...head, ceiling: ceiling(), reason: String((error as Error)?.message ?? error).slice(0, 200) });
      } finally {
        setFlags(heapGrowingFlag(inForcePercent()));
      }
      const collectMs = now() - started;
      const after = snapshot();
      const freed = before.rss_bytes + (before.swap_bytes ?? 0) - after.rss_bytes - (after.swap_bytes ?? 0);
      const freedHeap = before.heap_physical_bytes - after.heap_physical_bytes;
      const freedExternal = before.external_bytes - after.external_bytes;
      const measurable = freed > (noise ?? 0);
      lives.push({ at, live_bytes: after.heap_used_bytes, heap_before_bytes: before.heap_used_bytes });
      if (lives.length > FOOTPRINT_MAX_SAMPLES) lives.shift();
      futile = measurable ? undefined : { liveBytes: after.heap_used_bytes, ...(containerMib !== undefined ? { containerMib } : {}) };
      const containerAfter = reread?.();
      return done({
        outcome: "reclaimed", ...head,
        rss_after_bytes: after.rss_bytes,
        ...(after.swap_bytes !== undefined ? { swap_after_bytes: after.swap_bytes } : {}),
        ...(containerAfter !== undefined ? { container_after_mib: containerAfter } : {}),
        heap_used_after_bytes: after.heap_used_bytes,
        freed_bytes: freed,
        freed_heap_bytes: freedHeap,
        freed_external_bytes: freedExternal,
        freed_outside_heaps_bytes: freed - freedHeap - freedExternal,
        measurable,
        collect_ms: collectMs,
        ceiling: ceiling(),
      });
    },
  };
}

let installedReclaimer: DaemonSlackReclaimer | undefined;

/** The daemon installs its reclaimer once; the governors' readings in its process reclaim through it. Elsewhere (a
 *  drain, a review child, a test) none is installed and a container-short reading holds as before. */
export function installDaemonSlackReclaimer(reclaimer: DaemonSlackReclaimer | undefined): void {
  installedReclaimer = reclaimer;
}

export function installedDaemonSlackReclaimer(): DaemonSlackReclaimer | undefined {
  return installedReclaimer;
}

/** The reclaim's fields on a hold row (`dispatch_deferred_wip`, `dispatch_memory_observed`, `sweep.fix_capacity`). */
export function reclaimLedgerFields(record: SlackReclaimRecord | undefined): Record<string, unknown> {
  if (record === undefined) return {};
  return {
    reclaim_outcome: record.outcome,
    reclaim_rss_before_bytes: record.rss_before_bytes,
    reclaim_rss_after_bytes: record.rss_after_bytes,
    reclaim_container_before_mib: record.container_before_mib,
    reclaim_container_after_mib: record.container_after_mib,
    reclaim_freed_bytes: record.freed_bytes,
    reclaim_freed_outside_heaps_bytes: record.freed_outside_heaps_bytes,
    reclaim_measurable: record.measurable,
    reclaim_reason: record.reason,
  };
}
