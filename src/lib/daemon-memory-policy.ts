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

import { systemClock, type Clock } from "./clock.js";
import { FOOTPRINT_MAX_SAMPLES, FOOTPRINT_RETAIN_MS } from "./daemon-footprint.js";
import { writeAtomic } from "./fs-race-safe.js";

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

/** W1-T9596: restart only for growth beyond the charge an over-line boot already held. */
export const BOOT_BASELINE_RESTART_MARGIN = 1.25;
/** Below this heap share, tighter GC cannot materially reduce the held daemon's charge. */
export const FUTILE_RESTART_HEAP_SHARE = 0.4;

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

export type MemoryPressureTier = "clear" | "tighten" | "restart" | "hold";

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
  /** Observation only: expose the actual first reading, including an unknown budget, not a later warm guess. */
  initialReading?: boolean;
  baseline?: Readonly<DaemonMemoryReading & { charged_bytes: number; share?: number; boot_over_line: boolean }>;
  /** True when the tier or the applied growth percent changed on this step. */
  changed: boolean;
  previousTier: MemoryPressureTier;
  /** Present only when a futile-restart hold begins, ends, or its remedy/budget changes. */
  futileRestart?: {
    held: boolean;
    baseline_bytes: number;
    charged_bytes: number;
    line_bytes?: number;
    share?: number;
    restart_share: number;
    k: number;
    budget_bytes?: number;
    budget_source?: DaemonMemoryReading["budget_source"];
    heap_share: number;
  };
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
  heapUsed?: () => number;
}

/** The stateful half: reads, decides, applies a changed growth percent, and remembers what is in force. */
export function createDaemonMemoryGovernor(opts: DaemonMemoryGovernorOptions): DaemonMemoryGovernor {
  const policy = opts.policy ?? DEFAULT_DAEMON_MEMORY_POLICY;
  const setFlags = opts.setFlags ?? setFlagsFromString;
  const read = opts.read ?? (() => readDaemonMemory());
  const heapUsed = opts.heapUsed ?? (() => getHeapStatistics().used_heap_size);
  let inForce = Math.round(policy.heapGrowingPercent);
  let tier: MemoryPressureTier = "clear";
  let baseline: number | undefined;
  let baselineReading: MemoryGovernorStep["baseline"];
  let bootOverLine = false;
  let heldBudget: number | undefined;
  let heldSource: DaemonMemoryReading["budget_source"];
  return {
    step() {
      const reading = read();
      const decision = decideMemoryPressure(reading, policy, inForce);
      const charged = reading.rss_bytes + (reading.swap_bytes ?? 0);
      const initialReading = baseline === undefined;
      if (baseline === undefined) {
        baseline = charged;
        bootOverLine = decision.share !== undefined && decision.share >= policy.restartShare;
        baselineReading = { ...reading, charged_bytes: charged, share: decision.share, boot_over_line: bootOverLine };
      }
      const held = bootOverLine && decision.share !== undefined && decision.share >= policy.restartShare &&
        charged <= BOOT_BASELINE_RESTART_MARGIN * baseline;
      const heapShare = held || tier === "hold" ? heapUsed() / charged : 0;
      if (held) {
        decision.tier = "hold";
        decision.heapGrowingPercent = heapShare < FUTILE_RESTART_HEAP_SHARE
          ? Math.round(policy.heapGrowingPercent) : TIGHTEST_HEAP_GROWING_PERCENT;
        delete decision.detail;
      }
      const previousTier = tier;
      const changed = decision.tier !== tier || decision.heapGrowingPercent !== inForce;
      const futileChanged = (held || tier === "hold") && (changed ||
        reading.budget_bytes !== heldBudget || reading.budget_source !== heldSource);
      const futileRestart: MemoryGovernorStep["futileRestart"] = futileChanged ? {
        held, baseline_bytes: baseline, charged_bytes: charged,
        line_bytes: reading.budget_bytes === undefined ? undefined : policy.restartShare * reading.budget_bytes,
        share: decision.share, restart_share: policy.restartShare, k: BOOT_BASELINE_RESTART_MARGIN,
        budget_bytes: reading.budget_bytes, budget_source: reading.budget_source, heap_share: heapShare,
      } : undefined;
      if (decision.heapGrowingPercent !== inForce) setFlags(heapGrowingFlag(decision.heapGrowingPercent));
      inForce = decision.heapGrowingPercent;
      tier = decision.tier;
      heldBudget = held ? reading.budget_bytes : undefined;
      heldSource = held ? reading.budget_source : undefined;
      return { ...decision, reading, changed, previousTier, initialReading, baseline: baselineReading,
        ...(futileRestart ? { futileRestart } : {}) };
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
// W1-T9358: before a host-short hold too (2026-10-14 00:19-00:31Z, three host-short holds with no reclaim), pacing on
// the host's MemAvailable, since the daemon's freed pages are the host's.
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

/** W1-T9358: the pool whose shortfall asked for a reclaim, and whose figure its pacing compares: the container's
 *  working set (W1-T8401), or the host's MemAvailable before a host-short hold. */
export type SlackReclaimPool = "container" | "host";

/** What one reclaim did, or why it did not run. Rides the hold row and its own `daemon.slack_reclaim` row. */
export interface SlackReclaimRecord {
  outcome: "reclaimed" | "paced" | "unavailable";
  /** W1-T9358: the pool whose figure this reclaim was handed (the `container_*` or the `host_*` fields below). */
  pool: SlackReclaimPool;
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
  /** W1-T9358, a host reclaim: the host MemAvailable's variance between the readings this reclaimer saw (absent when
   *  unlearned), the reading before the reclaim, and the caller's fresh one after a collection. */
  host_noise_bytes?: number;
  host_before_mib?: number;
  host_after_mib?: number;
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
  /** Reclaim once, unless the last reclaim freed nothing measurable and nothing has moved since. `figureMib` is the
   *  short pool's figure: the container working set, or (pool "host", W1-T9358) the host's MemAvailable. After a
   *  collection `reread` takes the caller's fresh reading and returns the same figure, so the row carries both sides. */
  reclaim(figureMib?: number, reread?: () => number | undefined, pool?: SlackReclaimPool): SlackReclaimRecord;
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
  clock?: Clock;
  log?: (record: SlackReclaimRecord) => void;
}

const MIB_BYTES = 1048576;

export function createDaemonSlackReclaimer(opts: DaemonSlackReclaimerOptions = {}): DaemonSlackReclaimer {
  const policy = opts.policy ?? DEFAULT_DAEMON_MEMORY_POLICY;
  const collect = opts.collect ?? fullCollection;
  const snapshot = opts.snapshot ?? (() => readSlackSnapshot());
  const setFlags = opts.setFlags ?? setFlagsFromString;
  const inForcePercent = opts.inForcePercent ?? (() => Math.round(policy.heapGrowingPercent));
  const clock = opts.clock ?? systemClock;
  const now = () => clock.now();
  const lives: LiveSetSample[] = [];
  // Each pool's figures, kept apart: a container working set and a host MemAvailable are not one series.
  const seenBy: Record<SlackReclaimPool, Array<{ at: number; mib: number }>> = { container: [], host: [] };
  let futile: { liveBytes: number; pool: SlackReclaimPool; figureMib?: number } | undefined;
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
    reclaim(figureMib, reread, pool = "container") {
      const at = now();
      const seen = seenBy[pool];
      if (figureMib !== undefined) {
        seen.push({ at, mib: figureMib });
        while (seen.length > 0 && at - seen[0].at > FOOTPRINT_RETAIN_MS) seen.shift();
        if (seen.length > FOOTPRINT_MAX_SAMPLES) seen.shift();
      }
      const before = snapshot();
      ceilingInForce = before.heap_size_limit_bytes;
      const noise = successiveSpread(opts.footprintBytes?.() ?? []);
      const figureSpreadMib = successiveSpread(seen.slice(0, -1).map((s) => s.mib));
      const figureNoise = figureSpreadMib === undefined ? undefined : Math.round(figureSpreadMib * MIB_BYTES);
      const head = {
        pool,
        rss_before_bytes: before.rss_bytes,
        ...(before.swap_bytes !== undefined ? { swap_before_bytes: before.swap_bytes } : {}),
        heap_used_before_bytes: before.heap_used_bytes,
        ...(noise !== undefined ? { noise_bytes: Math.round(noise) } : {}),
        ...(figureNoise === undefined ? {} : pool === "host" ? { host_noise_bytes: figureNoise } : { container_noise_bytes: figureNoise }),
        ...(figureMib === undefined ? {} : pool === "host" ? { host_before_mib: figureMib } : { container_before_mib: figureMib }),
      };
      if (futile !== undefined) {
        const liveMoved = Math.abs(before.heap_used_bytes - futile.liveBytes);
        // A figure from the other pool is not comparable: then the heap alone says whether anything moved.
        const figureMoved = figureMib === undefined || futile.figureMib === undefined || futile.pool !== pool ? undefined
          : Math.abs(figureMib - futile.figureMib) * MIB_BYTES;
        // The pool's move counts only once its own variance is learned: unlearned, jitter and a move look alike.
        const moved = liveMoved > (noise ?? 0) || (figureMoved !== undefined && figureNoise !== undefined && figureMoved > figureNoise);
        if (!moved) {
          return done({
            outcome: "paced", ...head, ceiling: ceiling(),
            reason: `the last reclaim freed nothing above the noise; since then the heap moved ${Math.round(liveMoved / MIB_BYTES)} MiB` +
              (figureMoved === undefined ? "" : ` and the ${pool === "host" ? "host's MemAvailable" : "container"} ${Math.round(figureMoved / MIB_BYTES)} MiB`) +
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
      // W1-T8883: the live set after a forced collection is the shadow's best sample; it survives the next boot.
      installedShadow?.observe({ used_bytes: after.heap_used_bytes, size_bytes: after.heap_physical_bytes, after_gc: true });
      futile = measurable ? undefined : { liveBytes: after.heap_used_bytes, pool, ...(figureMib !== undefined ? { figureMib } : {}) };
      const figureAfter = reread?.();
      return done({
        outcome: "reclaimed", ...head,
        rss_after_bytes: after.rss_bytes,
        ...(after.swap_bytes !== undefined ? { swap_after_bytes: after.swap_bytes } : {}),
        ...(figureAfter === undefined ? {} : pool === "host" ? { host_after_mib: figureAfter } : { container_after_mib: figureAfter }),
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

/** W1-T8883: the heap-ceiling shadow's persisted live-heap samples, so the proposal learns across boots.
 *
 *  OBSERVED 2026-10-12 (48 h, 2,366 `daemon.alive` rows): the main heap used at most 2.19 GB under an 8 GiB ceiling,
 *  forced full collections freed a median 530 MiB, and `daemon.heap_ceiling_shadow` was written at boot only, with
 *  `live_samples` 0 in 13 of 13 rows, because the reclaimer's in-memory live sets die with the daemon, which
 *  reboots about hourly. These samples are kept in the state directory over a rolling 7 days.
 *
 *  REPORT ONLY. Nothing here applies a ceiling; the operator applies a proposal by an explicit config change. */
export const HEAP_SAMPLE_FILE = "daemon-heap-samples.json";
/** The rolling window the proposal is learned over. */
export const HEAP_SAMPLE_RETAIN_MS = 7 * 24 * 60 * 60_000;
/** One heartbeat sample at most this often: a heartbeat can come every few seconds, and a week of them is not wanted. */
export const HEAP_SAMPLE_MIN_GAP_MS = 60_000;
/** The file is rewritten at most this often (a restart loses at most this much; the daemon restarts about hourly). */
export const HEAP_SAMPLE_PERSIST_GAP_MS = 5 * 60_000;
/** A proposal row at most this often from a running daemon. */
export const HEAP_PROPOSAL_EVERY_MS = 60 * 60_000;
/** BACKSTOP on samples kept: a minute-spaced week (10,080) plus the ~10-minute collections, with room. */
export const HEAP_SAMPLE_MAX = 12_000;
/** The proposal is never below this multiple of the largest live set observed. */
export const HEAP_PROPOSAL_FLOOR_MULTIPLE = 2;
/** The quantile of the post-collection live set the proposal is taken at. */
export const HEAP_PROPOSAL_QUANTILE = 0.999;

/** One reading of the heap: what was in use, and the heap's size. `after_gc` marks a reading taken right after a
 *  forced full collection (the live set); the rest are heartbeat readings (an upper bound of it). */
export interface HeapSample {
  at: number;
  used_bytes: number;
  size_bytes: number;
  after_gc: boolean;
  pid: number;
}

export interface HeapSampleIo {
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
}

const realHeapSampleIo: HeapSampleIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, content) => void writeAtomic(path, content, { tmpTag: "heap-samples-tmp" }),
};

export function heapSamplePath(stateDir: string): string {
  return join(stateDir, HEAP_SAMPLE_FILE);
}

/** The persisted samples (oldest first), or why they cannot be read. A torn file is named, never read as empty. */
export function parseHeapSamples(text: string): HeapSample[] | { unread: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    void error; // A torn or foreign file: named, never read as an empty series.
    return { unread: "unparseable" };
  }
  const rows = (parsed as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(rows)) return { unread: "no samples array" };
  const out: HeapSample[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 5) continue;
    const [at, used, size, gc, pid] = row as unknown[];
    if (![at, used, size, pid].every((n) => typeof n === "number" && Number.isFinite(n)) || (gc !== 0 && gc !== 1)) continue;
    out.push({ at: at as number, used_bytes: used as number, size_bytes: size as number, after_gc: gc === 1, pid: pid as number });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The nearest-rank quantile of `values`. Undefined when there are none. */
export function quantileOf(values: readonly number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** The heap ceiling the daemon would want, learned over the persisted window. SHADOW: nothing applies it. */
export interface HeapCeilingProposal {
  shadow: true;
  report_only: true;
  ceiling_in_force_bytes: number;
  proposed_ceiling_bytes?: number;
  /** Why no ceiling is proposed yet. */
  proposed_unlearned?: string;
  live_samples: number;
  after_gc_samples: number;
  /** Distinct daemon processes the samples span: how many boots the proposal has learned across. */
  boots_sampled: number;
  window_ms: number;
  live_p999_bytes?: number;
  live_max_bytes?: number;
  headroom_factor: number;
  floor_bytes?: number;
}

/** Pure: p99.9 of the post-collection live set × the headroom V8 allows above it before collecting (1 + the growth
 *  percent), never below {@link HEAP_PROPOSAL_FLOOR_MULTIPLE}× the largest live set seen at any sample. With no
 *  collected sample the quantile is taken over the heartbeat readings, an upper bound of the live set. */
export function proposeHeapCeiling(
  samples: readonly HeapSample[], growthPercent: number, ceilingInForceBytes: number,
): HeapCeilingProposal {
  const headroom = 1 + growthPercent / 100;
  const base = {
    shadow: true as const, report_only: true as const, ceiling_in_force_bytes: ceilingInForceBytes,
    live_samples: samples.length, after_gc_samples: samples.filter((s) => s.after_gc).length,
    boots_sampled: new Set(samples.map((s) => s.pid)).size, window_ms: HEAP_SAMPLE_RETAIN_MS, headroom_factor: headroom,
  };
  if (samples.length === 0) return { ...base, proposed_unlearned: "no live heap sample yet" };
  const collected = samples.filter((s) => s.after_gc);
  const p999 = quantileOf((collected.length > 0 ? collected : samples).map((s) => s.used_bytes), HEAP_PROPOSAL_QUANTILE) as number;
  const max = Math.max(...samples.map((s) => s.used_bytes));
  const floor = HEAP_PROPOSAL_FLOOR_MULTIPLE * max;
  return {
    ...base, live_p999_bytes: p999, live_max_bytes: max, floor_bytes: floor,
    proposed_ceiling_bytes: Math.round(Math.max(p999 * headroom, floor)),
  };
}

export interface HeapShadow {
  readonly path: string;
  /** Add one reading; persist when due, and hand `onProposal` a proposal when one is due (hourly). */
  observe(reading: { used_bytes: number; size_bytes: number; after_gc: boolean }): void;
  /** Take a heartbeat reading of this process's heap (rate-limited). */
  sampleNow(): void;
  /** Write the file now. */
  flush(): { persisted: true } | { persisted: false; reason: string };
  samples(): readonly HeapSample[];
  propose(): HeapCeilingProposal;
  /** Why the file could not be loaded, if it could not (a first boot has none and is not an error). */
  readonly loadError?: string;
}

export interface HeapShadowOptions {
  path: string;
  policy?: DaemonMemoryPolicy;
  clock?: Clock;
  io?: HeapSampleIo;
  snapshot?: () => SlackSnapshot;
  pid?: number;
  /** Called with the reason when a persist fails: the samples stay in memory. */
  onPersistError?: (reason: string) => void;
  /** Called with a proposal at most once per {@link HEAP_PROPOSAL_EVERY_MS}, from the reading that finds it due. */
  onProposal?: (proposal: HeapCeilingProposal) => void;
}

function errnoOrReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : String((error as Error)?.message ?? error).slice(0, 120);
}

/** The shadow's store: loaded from `path` once (so a restart keeps the week), then held in memory. NEVER IN THE
 *  PATH: a failed load starts empty, a failed persist keeps the samples and is reported to `onPersistError`. */
export function createHeapShadow(opts: HeapShadowOptions): HeapShadow {
  const policy = opts.policy ?? DEFAULT_DAEMON_MEMORY_POLICY;
  const clock = opts.clock ?? systemClock;
  const io = opts.io ?? realHeapSampleIo;
  const snapshot = opts.snapshot ?? (() => readSlackSnapshot());
  const pid = opts.pid ?? process.pid;
  let held: HeapSample[] = [];
  let loadError: string | undefined;
  try {
    const loaded = parseHeapSamples(io.readFile(opts.path));
    if (Array.isArray(loaded)) held = loaded;
    else loadError = loaded.unread;
  } catch (error) {
    // No file yet (a first boot) is not an error; anything else is named on the store.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") loadError = errnoOrReason(error);
  }
  let ceilingInForce = 0;
  let lastHeartbeatAt = -Infinity;
  let lastPersistAt = -Infinity;
  let lastProposalAt = clock.now();
  let dirty = false;
  const propose = () => {
    ceilingInForce = snapshot().heap_size_limit_bytes;
    return proposeHeapCeiling(held, policy.heapGrowingPercent, ceilingInForce);
  };
  const flush = (): { persisted: true } | { persisted: false; reason: string } => {
    try {
      io.writeFile(opts.path, `${JSON.stringify({ samples: held.map((s) => [s.at, s.used_bytes, s.size_bytes, s.after_gc ? 1 : 0, s.pid]) })}\n`);
      lastPersistAt = clock.now();
      dirty = false;
      return { persisted: true };
    } catch (error) {
      const reason = errnoOrReason(error);
      opts.onPersistError?.(reason);
      lastPersistAt = clock.now(); // Retry on the normal cadence, not on every heartbeat.
      return { persisted: false, reason };
    }
  };
  const observe: HeapShadow["observe"] = (reading) => {
    const at = clock.now();
    held = [...held.filter((s) => at - s.at <= HEAP_SAMPLE_RETAIN_MS && s.at <= at),
      { at, used_bytes: reading.used_bytes, size_bytes: reading.size_bytes, after_gc: reading.after_gc, pid }]
      .slice(-HEAP_SAMPLE_MAX);
    dirty = true;
    if (at - lastPersistAt >= HEAP_SAMPLE_PERSIST_GAP_MS) flush();
    if (at - lastProposalAt >= HEAP_PROPOSAL_EVERY_MS) {
      lastProposalAt = at;
      opts.onProposal?.(propose());
    }
  };
  return {
    path: opts.path,
    ...(loadError === undefined ? {} : { loadError }),
    observe,
    sampleNow() {
      const at = clock.now();
      if (at - lastHeartbeatAt < HEAP_SAMPLE_MIN_GAP_MS) return;
      lastHeartbeatAt = at;
      const now = snapshot();
      observe({ used_bytes: now.heap_used_bytes, size_bytes: now.heap_physical_bytes, after_gc: false });
    },
    flush: () => (dirty ? flush() : { persisted: true }),
    samples: () => held,
    propose,
  };
}

let installedShadow: HeapShadow | undefined;

/** The daemon installs its shadow once; its heartbeat and its reclaims feed it. Elsewhere none is installed. */
export function installHeapShadow(shadow: HeapShadow | undefined): void {
  installedShadow = shadow;
}

export function installedHeapShadow(): HeapShadow | undefined {
  return installedShadow;
}

let installedReclaimer: DaemonSlackReclaimer | undefined;

/** The daemon installs its reclaimer once; the governors' readings in its process reclaim through it. Elsewhere (a
 *  drain, a review child, a test) none is installed and a container-short or host-short reading holds as before. */
export function installDaemonSlackReclaimer(reclaimer: DaemonSlackReclaimer | undefined): void {
  installedReclaimer = reclaimer;
}

export function installedDaemonSlackReclaimer(): DaemonSlackReclaimer | undefined {
  return installedReclaimer;
}

/** Reclaim once before an otherwise-required cgroup restart; only a complete fresh reading can avert it. */
export function reclaimBeforeMemoryRestart(
  step: MemoryGovernorStep,
  governor: DaemonMemoryGovernor,
  log: (step: string, fields: Record<string, unknown>) => void,
  reclaimer: DaemonSlackReclaimer | undefined = installedDaemonSlackReclaimer(),
): MemoryGovernorStep {
  if (step.tier !== "restart") return step;
  let next = step;
  let outcome = "unavailable";
  let recheck = "not-run";
  let reason: string | undefined;
  try {
    if (reclaimer === undefined) reason = "no daemon slack reclaimer installed";
    else {
      const record = reclaimer.reclaim();
      outcome = record.outcome;
      reason = record.reason;
      if (record.outcome === "reclaimed") {
        recheck = "unavailable";
        const fresh = governor.step();
        const read = fresh.reading;
        const complete = Number.isFinite(read.rss_bytes) && read.rss_bytes > 0 &&
          typeof read.budget_bytes === "number" && read.budget_bytes > 0 &&
          Number.isFinite(fresh.share) && read.budget_bytes === step.reading.budget_bytes &&
          read.budget_source === step.reading.budget_source &&
          typeof read.swap_bytes === "number" && Number.isFinite(read.swap_bytes) && read.swap_bytes >= 0;
        recheck = complete ? "measured" : "unavailable";
        if (complete) next = { ...fresh, previousTier: step.previousTier, changed: step.changed || fresh.changed };
        else reason = "post-reclaim charge or unchanged budget is unreadable; retain the restart";
      }
    }
  } catch (error) {
    log("daemon.memory_restart_reclaim", {
      outcome: "unavailable", recheck, reason: String((error as Error)?.message ?? error).slice(0, 200),
      prior_share: step.share, share: step.share,
      budget_bytes: step.reading.budget_bytes, budget_source: step.reading.budget_source, relieved: false,
    });
    return step;
  }
  log("daemon.memory_restart_reclaim", {
    outcome, recheck, reason, prior_share: step.share, share: next.share,
    budget_bytes: step.reading.budget_bytes, budget_source: step.reading.budget_source,
    relieved: next.tier !== "restart",
  });
  return next;
}

/** The reclaim's fields on a hold row (`dispatch_deferred_wip`, `dispatch_memory_observed`, `sweep.fix_capacity`). */
export function reclaimLedgerFields(record: SlackReclaimRecord | undefined): Record<string, unknown> {
  if (record === undefined) return {};
  return {
    reclaim_outcome: record.outcome,
    reclaim_pool: record.pool,
    reclaim_rss_before_bytes: record.rss_before_bytes,
    reclaim_rss_after_bytes: record.rss_after_bytes,
    reclaim_container_before_mib: record.container_before_mib,
    reclaim_container_after_mib: record.container_after_mib,
    reclaim_host_before_mib: record.host_before_mib,
    reclaim_host_after_mib: record.host_after_mib,
    reclaim_freed_bytes: record.freed_bytes,
    reclaim_freed_outside_heaps_bytes: record.freed_outside_heaps_bytes,
    reclaim_measurable: record.measurable,
    reclaim_reason: record.reason,
  };
}
