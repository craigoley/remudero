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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { parse as parseYaml } from "yaml";

import { systemClock, type Clock } from "./clock.js";
import { configPath } from "./config.js";
import { FOOTPRINT_MAX_SAMPLES, FOOTPRINT_RETAIN_MS } from "./daemon-footprint.js";
import { sampleCgroupMemory } from "./daemon-memory-telemetry.js";
import { writeAtomic } from "./fs-race-safe.js";
import { CROSSING_WINDOW_MS, SWAP_STALL_HISTORY_MS, SWAP_STALL_MIN_SAMPLES, SWAP_STALL_WINDOW_MS } from "./host-memory-shadow.js";
import { loadRunChildMode, type RunChildMode } from "./policy.js";
import {
  bootRunChildModeTracker, readRunChildModeUnion, runChildModeEvidence, runChildModeFor, runChildModeWindow, type RunChildModeTracker,
} from "./run-child-mode.js";

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
  /** W1-T9106: the learned-ceiling file the launcher read. Production (no `env`): this instance's, from its config root. */
  heapCeiling?: HeapCeilingLocation;
}

export interface DaemonMemoryEntryResult {
  heap_growing_percent: number;
  /** The NODE_OPTIONS this process was started with, and what its children now inherit. */
  node_options_before?: string;
  node_options_children?: string;
  /** Operator ruling 2026-10-19: the malloc tuning the launch set (GLIBC_TUNABLES), so a boot row shows
   *  it took effect. Absent when the launch set none. The node flags are in node_options_before. */
  glibc_tunables?: string;
  /** The node flags a run child and an automated retro child start with: {@link childHeapPolicyArgs}. */
  child_node_args?: string[];
  /** W1-T9106: `learned` when this process started under the learned ceiling, else `inherited` with the reason. */
  ceiling_source?: "learned" | "inherited";
  ceiling_unapplied?: string;
  learned_ceiling_mib?: number;
}

/** The growth percent this process's run and retro children start with; set by {@link applyDaemonMemoryPolicy}. */
let childHeapGrowingPercent: number | undefined;

/**
 * The node flags that start a run child or an automated retro child under the daemon's growth percent. NODE_OPTIONS
 * refuses `--heap-growing-percent`, so before this a child grew at V8's default factor: OBSERVED 2026-10-19, a run child
 * peaked at 915 MB and an automated retro child at 1.58 GB, then held 565 MB and 687 MB in swap while idle. The flag
 * goes on the child's own command line. Empty in a process that never applied the policy.
 */
export function childHeapPolicyArgs(): string[] {
  return childHeapGrowingPercent === undefined ? [] : [heapGrowingFlag(childHeapGrowingPercent)];
}

/**
 * W1-T10290: record the growth percent this process's children start with, WITHOUT setting it on this process.
 * Serve's own heap keeps V8's default; its read-model oracle children start under the policy's percent. The record is
 * a module variable, so it reaches only this isolate: a caller hands {@link childHeapPolicyArgs} to a worker thread in
 * that thread's data.
 */
export function recordChildHeapGrowingPercent(policy: Pick<DaemonMemoryPolicy, "heapGrowingPercent">): string[] {
  childHeapGrowingPercent = policy.heapGrowingPercent;
  return childHeapPolicyArgs();
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
  recordChildHeapGrowingPercent(policy);
  // An injected env is not this process's own launch, so it names no ceiling source unless a file is injected with it.
  const location = io.heapCeiling ?? (io.env === undefined ? defaultHeapCeilingLocation() : undefined);
  return {
    ...(location === undefined ? {} : heapCeilingSource(before, location)),
    heap_growing_percent: Math.round(policy.heapGrowingPercent),
    child_node_args: childHeapPolicyArgs(),
    ...(before !== undefined ? { node_options_before: before } : {}),
    ...(after !== undefined ? { node_options_children: after } : {}),
    ...(env.GLIBC_TUNABLES !== undefined ? { glibc_tunables: env.GLIBC_TUNABLES } : {}),
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
  step(readingIsUsable?: (reading: DaemonMemoryReading) => boolean): MemoryGovernorStep;
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
    step(readingIsUsable) {
      const reading = read();
      if (readingIsUsable && !readingIsUsable(reading)) throw new Error("post-reclaim charge or unchanged budget is unreadable; retain the restart");
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
  /** W1-T9106: what the learned-ceiling file now says, when this shadow writes one. */
  learned_ceiling_mode?: HeapCeilingMode;
  learned_ceiling_reason?: string;
  learned_ceiling_mib?: number;
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

// ── W1-T9106: the learned ceiling, applied at boot (ADR 0007 decision C, offset 2) ────────────────────────────────────
// MEASURED 2026-10-13: every boot's daemon.memory_policy row shows `--max-old-space-size=8192` and a heap_size_limit of
// 8.79 GB against a live heap p50 of 910 MiB, so V8 keeps garbage up to RSS p90 2,539 MiB. A tighter ceiling risks a
// heap-limit exit, which costs only a boot once build runs are adopted children. So the shadow writes its proposal to
// `<state>/daemon-heap-ceiling.json`, and bin/rmd starts the next daemon under it when the file is applied and current.

/** The learned-ceiling file, beside the samples it was learned from. bin/rmd reads it before it starts a daemon. */
export const LEARNED_HEAP_FILE = "daemon-heap-ceiling.json";
/** PRIMARY CONTROL, mirrored: the share of V8's limit at which the daemon leaves with a `v8_limit` heap-pressure exit,
 *  daemon.ts's HEAP_PRESSURE_RESTART_FRACTION (that module imports this one, so the value is repeated, not imported). */
export const HEAP_LIMIT_EXIT_FRACTION = 0.75;
/** BACKSTOP: a raise after a heap-limit exit adds at least this to the live set at exit when the samples show less
 *  spread (a flat series would otherwise raise by nothing). */
export const HEAP_LIMIT_RAISE_MIN_BYTES = 64 * 1024 * 1024;
/** BACKSTOP: a file is current for this long after it was written. The daemon rewrites it at every boot and hourly, so
 *  this fires only once that has stopped. */
export const HEAP_CEILING_CURRENT_MS = 24 * 60 * 60_000;
/** BACKSTOP: the launcher never applies a ceiling below this; a smaller value is read as damaged. */
export const LEARNED_CEILING_MIN_MIB = 256;
const MIB = 1024 * 1024;

/** `applied`: the launcher starts the daemon under it. `shadow`: report-only, as W1-T8883. */
export type HeapCeilingMode = "applied" | "shadow";

/** Whether a learned ceiling may be applied, and why. */
export interface HeapCeilingGate {
  applies: boolean;
  reason: string;
}

/** A boot that ended at its heap limit: a `v8_limit` heap-pressure exit seen live, or a heap out-of-memory exit read
 *  at the next boot from the previous boot's last sample (the process died before it could say so). */
export interface HeapLimitExit {
  basis: "v8_limit" | "heap_oom";
  at: number;
  used_bytes: number;
  heap_size_limit_bytes: number;
}

/** The file's contents. */
export interface LearnedHeapCeiling {
  version: 1;
  /** The state directory it was written for: a copy found under another instance is not current there. */
  state_dir: string;
  mode: HeapCeilingMode;
  mode_reason: string;
  written_at: number;
  valid_until: number;
  /** The learning window opened here; the ceiling is not lowered before `learned_since + window_ms`. */
  learned_since: number;
  window_ms: number;
  ceiling_bytes?: number;
  ceiling_mib?: number;
  /** `restartShare` of the container's memory budget: the ceiling never exceeds it. */
  cap_bytes?: number;
  capped?: true;
  basis: {
    samples: number; after_gc_samples: number; boots_sampled: number;
    live_p999_bytes?: number; live_max_bytes?: number; live_spread_bytes?: number;
    proposed_ceiling_bytes?: number; proposed_unlearned?: string;
  };
  raised_by?: HeapLimitExit & { raised_to_bytes: number };
}

export interface HeapCeilingLocation {
  stateDir: string;
  read?: (path: string) => string;
  /** The clock the file's currency is judged against. Default: the system clock. */
  clock?: Clock;
}

export function heapCeilingPath(stateDir: string): string {
  return join(stateDir, LEARNED_HEAP_FILE);
}

/** This instance's state directory as bin/rmd finds it: `<config root>/state`, the root defaulting as loadConfig's. */
export function defaultHeapCeilingLocation(read: (path: string) => string = (path) => readFileSync(path, "utf8")): HeapCeilingLocation {
  let root: unknown;
  try {
    root = (JSON.parse(read(configPath())) as { root?: unknown } | null)?.root;
  } catch (error) {
    void error; // No config yet: loadConfig's own default root, exactly as bin/rmd falls back.
  }
  return { stateDir: join(typeof root === "string" && root !== "" ? root : join(homedir(), "Remudero"), "state") };
}

/** The live set's spread: the median change between successive post-collection readings (else all readings). */
export function liveSpreadOf(samples: readonly HeapSample[]): number | undefined {
  const collected = samples.filter((s) => s.after_gc);
  return successiveSpread((collected.length > 1 ? collected : samples).map((s) => s.used_bytes));
}

/** The file, or why it cannot be read. Only a record carrying the fields the learner needs is a prior. */
export function parseLearnedHeapCeiling(text: string): LearnedHeapCeiling | { unread: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    void error; // A torn or foreign file: named, never read as a ceiling.
    return { unread: "unparseable" };
  }
  const r = parsed as Partial<LearnedHeapCeiling> | null;
  if (r === null || typeof r !== "object" || r.version !== 1) return { unread: "not a version 1 record" };
  const numeric = [r.written_at, r.valid_until, r.learned_since].every((n) => typeof n === "number" && Number.isFinite(n));
  if (!numeric || typeof r.state_dir !== "string" || (r.mode !== "applied" && r.mode !== "shadow")) return { unread: "missing fields" };
  if (r.ceiling_bytes !== undefined && !(typeof r.ceiling_bytes === "number" && r.ceiling_bytes > 0)) return { unread: "bad ceiling_bytes" };
  return r as LearnedHeapCeiling;
}

export interface NextHeapCeilingInput {
  stateDir: string;
  nowMs: number;
  proposal: HeapCeilingProposal;
  spreadBytes?: number;
  /** The container's memory budget (memory.high, else memory.max); absent, nothing bounds the ceiling. */
  budgetBytes?: number;
  restartShare: number;
  gate: HeapCeilingGate;
  prior?: LearnedHeapCeiling;
  exit?: HeapLimitExit;
}

/** Pure: the next file. Inside the prior's window the ceiling is never lowered; a heap-limit exit raises it to hold
 *  the live set at exit plus its spread below the exit fraction; it never exceeds `restartShare` of the budget. It is
 *  `applied` only when the gate allows, a budget bounds it, and a capped raise still clears the limit that exited. */
export function nextLearnedHeapCeiling(i: NextHeapCeilingInput): LearnedHeapCeiling {
  const { prior, proposal, nowMs } = i;
  const inWindow = prior?.ceiling_bytes !== undefined && prior.learned_since <= nowMs && nowMs - prior.learned_since < HEAP_SAMPLE_RETAIN_MS;
  let ceiling = proposal.proposed_ceiling_bytes;
  if (inWindow) ceiling = Math.max(ceiling ?? 0, prior.ceiling_bytes as number);
  let raised = inWindow ? prior.raised_by : undefined;
  if (i.exit !== undefined) {
    const to = Math.ceil((i.exit.used_bytes + Math.max(i.spreadBytes ?? 0, HEAP_LIMIT_RAISE_MIN_BYTES)) / HEAP_LIMIT_EXIT_FRACTION);
    ceiling = Math.max(ceiling ?? 0, to);
    raised = { ...i.exit, raised_to_bytes: to };
  }
  const cap = i.budgetBytes === undefined ? undefined : Math.floor(i.restartShare * i.budgetBytes);
  const capped = ceiling !== undefined && cap !== undefined && ceiling > cap;
  if (capped) ceiling = cap;
  const mib = ceiling === undefined ? undefined : Math.floor(ceiling / MIB);
  const unapplied = !i.gate.applies ? i.gate.reason
    : mib === undefined ? `no ceiling learned yet: ${proposal.proposed_unlearned ?? "no proposal"}`
    : cap === undefined ? "no memory budget to bound the ceiling by restartShare"
    : mib < LEARNED_CEILING_MIN_MIB ? `below the ${LEARNED_CEILING_MIN_MIB} MiB floor`
    : capped && i.exit !== undefined && (ceiling as number) <= i.exit.heap_size_limit_bytes ? "a raise capped by restartShare would repeat the exit"
    : undefined;
  return {
    version: 1, state_dir: i.stateDir, mode: unapplied === undefined ? "applied" : "shadow", mode_reason: unapplied ?? i.gate.reason,
    written_at: nowMs, valid_until: nowMs + HEAP_CEILING_CURRENT_MS,
    learned_since: inWindow ? prior.learned_since : nowMs, window_ms: HEAP_SAMPLE_RETAIN_MS,
    ...(ceiling === undefined ? {} : { ceiling_bytes: ceiling, ceiling_mib: mib }),
    ...(cap === undefined ? {} : { cap_bytes: cap }), ...(capped ? { capped: true as const } : {}),
    basis: {
      samples: proposal.live_samples, after_gc_samples: proposal.after_gc_samples, boots_sampled: proposal.boots_sampled,
      live_p999_bytes: proposal.live_p999_bytes, live_max_bytes: proposal.live_max_bytes, live_spread_bytes: i.spreadBytes,
      proposed_ceiling_bytes: proposal.proposed_ceiling_bytes, proposed_unlearned: proposal.proposed_unlearned,
    },
    ...(raised === undefined ? {} : { raised_by: raised }),
  };
}

/** The heap out-of-memory exit a boot cannot ledger: the previous boot, under an applied ceiling, last sampled its heap
 *  at the exit fraction of it, and no raise has yet been taken from that sample. */
export function priorBootAtLimit(samples: readonly HeapSample[], prior: LearnedHeapCeiling | undefined, pid: number): HeapLimitExit | undefined {
  if (prior?.mode !== "applied" || prior.ceiling_bytes === undefined) return undefined;
  const last = samples.filter((s) => s.pid !== pid).at(-1);
  if (last === undefined || last.used_bytes < HEAP_LIMIT_EXIT_FRACTION * prior.ceiling_bytes || (prior.raised_by?.at ?? -Infinity) >= last.at) return undefined;
  return { basis: "heap_oom", at: last.at, used_bytes: last.used_bytes, heap_size_limit_bytes: prior.ceiling_bytes };
}

/** The ceiling applies only while run children are on with adoption live: a heap-limit exit then costs one boot and
 *  no run. `on` adopts at every boot; `auto` applies only once its own evidence decides `on`. Anything else (or an
 *  unreadable policy or evidence) runs builds in-process, where an exit would cost the run, so it stays report-only. */
export function runChildrenAdoptedGate(
  stateDir: string, readMode: () => RunChildMode = loadRunChildMode, readUnion: typeof readRunChildModeUnion = readRunChildModeUnion,
  /** The tracker this process's boot folds (W1-T11341): its evidence is the union the boot already read, kept live, so
   *  the gate need not read the whole ledger union again (W1-T14756: that read held the first heap proposal ~110 s). */
  tracker: Pick<RunChildModeTracker, "evidence"> | undefined = bootRunChildModeTracker(stateDir),
): HeapCeilingGate {
  try {
    const mode = readMode();
    if (mode === "on") return { applies: true, reason: "sweep.runChild.mode on: runs are adopted children" };
    if (mode !== "auto") return { applies: false, reason: `sweep.runChild.mode ${mode}: runs are in-process` };
    let evidence = tracker?.evidence();
    if (evidence === undefined) {
      const union = readUnion(stateDir);
      if (union.unread.length > 0) return { applies: false, reason: `auto's evidence is unreadable (${union.unread.join(", ")})` };
      evidence = runChildModeEvidence(runChildModeWindow(union.rows));
    }
    const decided = runChildModeFor("auto", evidence).mode;
    return decided === "on"
      ? { applies: true, reason: "sweep.runChild.mode auto decided on: runs are adopted children" }
      : { applies: false, reason: `sweep.runChild.mode auto decided ${decided}: runs are in-process` };
  } catch (error) {
    return { applies: false, reason: `run-child mode unreadable: ${errnoOrReason(error)}` };
  }
}


/** What the launcher does with the file: the learned ceiling in place of every inherited `--max-old-space-size`, or the
 *  inherited value and why. bin/rmd runs this same rule in plain node before it starts a daemon (no tsx at launch). */
export function launchHeapCeiling(
  text: string | undefined, nodeOptions: string | undefined, stateDir: string, nowMs: number,
): { ceiling_source: "learned"; ceiling_mib: number; node_options: string } | { ceiling_source: "inherited"; reason: string } {
  if (text === undefined) return { ceiling_source: "inherited", reason: "absent" };
  let r: Partial<LearnedHeapCeiling> | null;
  try {
    r = JSON.parse(text) as Partial<LearnedHeapCeiling> | null;
  } catch (error) {
    void error; // A torn file keeps the inherited ceiling, and says so.
    return { ceiling_source: "inherited", reason: "unreadable" };
  }
  const mib = r?.ceiling_mib;
  const why = r === null || typeof r !== "object" || r.version !== 1 ? "unreadable"
    : r.state_dir !== stateDir ? "written for another instance"
    : !(nowMs < (r.valid_until as number)) ? "stale"
    : r.mode !== "applied" ? `shadow: ${String(r.mode_reason)}`
    : !Number.isInteger(mib) || (mib as number) < LEARNED_CEILING_MIN_MIB ? "unreadable ceiling_mib"
    : undefined;
  if (why !== undefined) return { ceiling_source: "inherited", reason: why };
  const kept = withoutHeapCeiling(nodeOptions);
  return { ceiling_source: "learned", ceiling_mib: mib as number, node_options: `${kept === undefined ? "" : `${kept} `}--max-old-space-size=${mib}` };
}

/** The last `--max-old-space-size` NODE_OPTIONS sets, in MiB. */
function heapCeilingMibOf(nodeOptions: string | undefined): number | undefined {
  const words = (nodeOptions ?? "").split(/\s+/).filter(Boolean);
  let mib: number | undefined;
  for (let i = 0; i < words.length; i++) {
    const m = HEAP_CEILING_FLAG.exec(words[i]);
    if (m) mib = Number(m[1] === undefined ? words[i + 1] : m[1].slice(1));
  }
  return mib;
}

/** The daemon.memory_policy row's `ceiling_source`: the launcher's own rule over the same file, and whether this
 *  process's NODE_OPTIONS carries its answer (a daemon started without bin/rmd inherits even when the file applies). */
export function heapCeilingSource(nodeOptions: string | undefined, location: HeapCeilingLocation): Pick<DaemonMemoryEntryResult, "ceiling_source" | "ceiling_unapplied" | "learned_ceiling_mib"> {
  let text: string | undefined;
  try {
    text = (location.read ?? ((path: string) => readFileSync(path, "utf8")))(heapCeilingPath(location.stateDir));
  } catch (error) {
    // No file is `absent` (the launcher's own reading); any other failure is named.
    const code = errnoOrReason(error);
    if (code !== "ENOENT") return { ceiling_source: "inherited", ceiling_unapplied: `unreadable: ${code}` };
  }
  const launch = launchHeapCeiling(text, nodeOptions, location.stateDir, (location.clock ?? systemClock).now());
  if (launch.ceiling_source === "inherited") return { ceiling_source: "inherited", ceiling_unapplied: launch.reason };
  if (heapCeilingMibOf(nodeOptions) !== launch.ceiling_mib) {
    return { ceiling_source: "inherited", ceiling_unapplied: "the launcher did not apply it", learned_ceiling_mib: launch.ceiling_mib };
  }
  return { ceiling_source: "learned", learned_ceiling_mib: launch.ceiling_mib };
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
  /** W1-T9106: the learned-ceiling file's store. Default: the real one, unless `io` is injected (then none is written). */
  ceilingIo?: HeapSampleIo;
  /** Whether the learned ceiling may apply. Default: {@link runChildrenAdoptedGate}, read once per shadow. */
  ceilingGate?: () => HeapCeilingGate;
  /** The container's memory budget. Default: {@link readDaemonMemory}'s. */
  budgetBytes?: () => number | undefined;
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
  const ceilingIo = opts.ceilingIo ?? (opts.io === undefined ? realHeapSampleIo : undefined);
  const ceilingStateDir = dirname(opts.path);
  let gate: HeapCeilingGate | undefined;
  let priorBootRead = false;
  let raisedThisBoot = false;
  // W1-T9106: every proposal also rewrites the learned-ceiling file the next launch reads. Never in the path: a failure
  // is reported to `onPersistError` and the file keeps what it said.
  const writeCeiling = (proposal: HeapCeilingProposal, exit?: HeapLimitExit): LearnedHeapCeiling | undefined => {
    if (ceilingIo === undefined) return undefined;
    try {
      let prior: LearnedHeapCeiling | undefined;
      try {
        const read = parseLearnedHeapCeiling(ceilingIo.readFile(heapCeilingPath(ceilingStateDir)));
        prior = "unread" in read ? undefined : read;
      } catch (error) {
        void error; // No file yet (a first learned ceiling) or an unreadable one: learned afresh, never a crash.
      }
      gate ??= (opts.ceilingGate ?? (() => runChildrenAdoptedGate(ceilingStateDir)))();
      if (!priorBootRead) exit ??= priorBootAtLimit(held, prior, pid);
      priorBootRead = true;
      const record = nextLearnedHeapCeiling({
        stateDir: ceilingStateDir, nowMs: clock.now(), proposal, spreadBytes: liveSpreadOf(held),
        budgetBytes: (opts.budgetBytes ?? (() => readDaemonMemory().budget_bytes))(), restartShare: policy.restartShare, gate, prior, exit,
      });
      ceilingIo.writeFile(heapCeilingPath(ceilingStateDir), `${JSON.stringify(record)}\n`);
      return record;
    } catch (error) {
      const reason = `heap ceiling: ${errnoOrReason(error)}`;
      opts.onPersistError?.(reason);
      return undefined;
    }
  };
  const propose = (): HeapCeilingProposal => {
    ceilingInForce = snapshot().heap_size_limit_bytes;
    const proposal = proposeHeapCeiling(held, policy.heapGrowingPercent, ceilingInForce);
    const learned = writeCeiling(proposal);
    return learned === undefined ? proposal : {
      ...proposal, learned_ceiling_mode: learned.mode, learned_ceiling_reason: learned.mode_reason,
      ...(learned.ceiling_mib === undefined ? {} : { learned_ceiling_mib: learned.ceiling_mib }),
    };
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
      // The `v8_limit` heap-pressure exit leaves at this tick's boundary: raise the next boot's ceiling before it goes.
      const limit = now.heap_size_limit_bytes;
      if (!raisedThisBoot && ceilingIo !== undefined && limit > 0 && now.heap_used_bytes >= HEAP_LIMIT_EXIT_FRACTION * limit) {
        raisedThisBoot = true;
        writeCeiling(proposeHeapCeiling(held, policy.heapGrowingPercent, limit),
          { basis: "v8_limit", at, used_bytes: now.heap_used_bytes, heap_size_limit_bytes: limit });
      }
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
  const completeReading = (read: DaemonMemoryReading): boolean => Number.isFinite(read.rss_bytes) && read.rss_bytes > 0 &&
    typeof read.budget_bytes === "number" && Number.isFinite(read.budget_bytes) && read.budget_bytes > 0 &&
    read.budget_bytes === step.reading.budget_bytes && read.budget_source === step.reading.budget_source &&
    typeof read.swap_bytes === "number" && Number.isFinite(read.swap_bytes) && read.swap_bytes >= 0;
  try {
    if (reclaimer === undefined) reason = "no daemon slack reclaimer installed";
    else {
      const record = reclaimer.reclaim();
      outcome = record.outcome;
      reason = record.reason;
      if (record.outcome === "reclaimed") {
        recheck = "unavailable";
        const fresh = governor.step(completeReading);
        const complete = completeReading(fresh.reading) && Number.isFinite(fresh.share);
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

// ── W1-T15181 — a container held at memory.high while its loop misses ticks sheds its youngest disposable round ─────
//
// OBSERVED 2026-11-27 (core, three stalls): memory.high swung 15892-24852 MiB under the tuner, swap sat at its cap, and
// daemon.loop_lag reached 528 s and 1417 s while 8-14 fix and review children held the memory; each stall ended only when
// children finished. Nothing ended an ADMITTED child under memory pressure. This rung does, one child at a time:
// {@link decideContainerShed} is pure, the daemon's in-flight tick keeps its history and ends the child it names.
// INVARIANT only-disposable-rounds-are-shed: a review, or a detached fix-dispatch, run child; nothing else is a candidate.
// INVARIANT unknown-is-never-pressure: any unread input holds. No PSI percentage or MiB literal decides: the calm band is
// learned from this instance's own readings with W1-T10085's windows, minimum and noise rule (host-memory-shadow.ts).

/** One shed: its row, written once the child's end has resolved. */
export const MEMORY_SHED_STEP = "memory.shed";
/** A hold while the shed conditions are partly met: at most one per episode, naming what is missing. */
export const MEMORY_SHED_HELD_STEP = "memory.shed_held";

/** One in-flight tick's reading of the daemon's own cgroup and loop. An absent field is unread and named in `unread`. */
export interface ContainerShedReading {
  at_ms: number;
  /** memory.events `high`: how many times the cgroup was throttled at memory.high. */
  events_high?: number;
  /** memory.pressure `full avg60`. */
  psi_full_avg60?: number;
  memory_current_mib?: number;
  memory_high_mib?: number;
  /** Whole poll intervals the tick ending at this reading arrived late by (the daemon.loop_lag rule). */
  missed_ticks?: number;
  unread?: string[];
}

/** What ending a run child returned: run-child.ts `AbortRunChildOutcome`, structurally. */
export type ContainerShedEndOutcome =
  | { signalled: false; reason: string }
  | { signalled: true; ended: "terminal" | "lost"; killed?: boolean };

/** A sweep restart-drain inventory entry, structurally (sweep.ts `RestartDrainInventoryEntry`), so this module takes no
 *  edge to the sweep hub. Only an entry with a run id and an end can be shed. */
export interface ContainerShedEntry {
  what: string;
  kind: string;
  task_id?: string;
  pr?: number;
  admitted_at_ms: number;
  run_id?: string;
  settled: Promise<void>;
  end?: () => Promise<ContainerShedEndOutcome>;
}

/** The episode the rung is in: a shed waiting to settle and be judged, a suspension, and whether its held row is written. */
export interface ContainerShedEpisode {
  shed?: { run_id: string; at_ms: number; reading: ContainerShedReading; settled_at_ms?: number };
  suspended?: boolean;
  held_written?: boolean;
}

/** Earlier fully read readings (oldest first, the current one excluded) and the episode state. */
export interface ContainerShedHistory {
  readings: readonly ContainerShedReading[];
  episode: ContainerShedEpisode;
}

/** The highest PSI full avg60 this instance has read calm; `null` (unlearned) below the minimum, and the PSI condition
 *  is then dropped. */
export interface ContainerCalmBand {
  band: number | null;
  source: "learned" | "unlearned";
  samples: number;
  basis: string;
}

export interface ContainerShedDecision {
  action: "hold" | "shed" | "suspend";
  reason: string;
  /** shed: the youngest disposable child. */
  entry?: ContainerShedEntry;
  /** hold: the conditions not met. */
  missing: string[];
  unread?: string[];
  band: ContainerCalmBand;
  /** The episode after this decision: the caller keeps it for the next. */
  episode: ContainerShedEpisode;
  /** hold: the first partly met hold of this episode, so the caller writes its one memory.shed_held row. */
  write_held: boolean;
  /** Set on the first fresh reading after a shed settled. */
  shed_effect?: "effective" | "ineffective";
}

const MISSING_HIGH = "memory.events high did not rise since the previous reading";
const MISSING_TICKS = "missed ticks not seen in two readings an avg60 window apart";
const MISSING_PSI = "PSI full avg60 inside the calm band";
const MISSING_CANDIDATE = "no disposable candidate";

/** INVARIANT only-disposable-rounds-are-shed: a review or a detached fix-dispatch, hosted in a run child it can end. */
export function isDisposableShedEntry(entry: ContainerShedEntry): boolean {
  const kindOk = entry.what === "review" || (entry.what === "detached" && entry.kind === "fix-dispatch");
  return kindOk && entry.run_id !== undefined && entry.end !== undefined;
}

/** W1-T10085's noise: twice the standard error of a share `p` over `n` verdicts. */
function shareNoise(p: number, n: number): number {
  return 2 * Math.sqrt(p * (1 - p) / n);
}

/**
 * The calm band, learned as W1-T10085 learns its PSI bound: over readings in the last SWAP_STALL_HISTORY_MS whose
 * SWAP_STALL_WINDOW_MS has closed, a reading is HARMED when it, or a later reading within that window, missed a tick. With fewer
 * than SWAP_STALL_MIN_SAMPLES calm readings the band is unlearned. Otherwise, walking levels upward, a calm level joins
 * the band while the harmed share of every reading at or below it stays within twice its noise of zero.
 */
export function containerCalmBandOf(readings: readonly ContainerShedReading[], nowMs: number): ContainerCalmBand {
  const missedAt = readings.filter((r) => (r.missed_ticks ?? 0) >= 1).map((r) => r.at_ms);
  // The reading's own missed ticks count: a reading at a missed tick was never calm.
  const harmed = (r: ContainerShedReading): boolean => missedAt.some((at) => at >= r.at_ms && at <= r.at_ms + SWAP_STALL_WINDOW_MS);
  const closed = readings.filter((r) => r.psi_full_avg60 !== undefined &&
    nowMs - r.at_ms >= SWAP_STALL_WINDOW_MS && nowMs - r.at_ms <= SWAP_STALL_HISTORY_MS)
    .map((r) => ({ level: r.psi_full_avg60!, harmed: harmed(r) })).sort((x, y) => x.level - y.level);
  const calm = closed.filter((r) => !r.harmed).length;
  if (calm < SWAP_STALL_MIN_SAMPLES) {
    return { band: null, source: "unlearned", samples: calm, basis: `${calm} of ${SWAP_STALL_MIN_SAMPLES} calm readings with a closed window` };
  }
  let band: number | null = null;
  let n = 0;
  let hurt = 0;
  let calmLevel = false;
  let basis = "";
  for (let k = 0; k < closed.length; k++) {
    const r = closed[k]!;
    n += 1;
    if (r.harmed) hurt += 1;
    else calmLevel = true;
    if (k + 1 < closed.length && closed[k + 1]!.level === r.level) continue;
    if (!calmLevel) continue;
    calmLevel = false;
    const share = hurt / n;
    const noise = shareNoise(share, n);
    basis = `${hurt} of ${n} readings at full avg60 <= ${r.level} were followed by a missed tick (noise ${Math.round(noise * 100)}%)`;
    if (share <= noise) band = r.level;
  }
  if (band === null) return { band: null, source: "unlearned", samples: calm, basis: `no calm level within noise: ${basis}` };
  return { band, source: "learned", samples: calm, basis: `learned ${band}: ${basis}` };
}

/** A field's own noise: twice the standard deviation of its tick-to-tick change over the readings. Fewer than two
 *  changes read: zero, so any fall counts. */
function readingNoise(readings: readonly ContainerShedReading[], field: "psi_full_avg60" | "memory_current_mib"): number {
  const values = readings.map((r) => r[field]).filter((v): v is number => v !== undefined);
  const deltas = values.slice(1).map((v, i) => v - values[i]!);
  if (deltas.length < 2) return 0;
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  return 2 * Math.sqrt(deltas.reduce((a, d) => a + (d - mean) ** 2, 0) / (deltas.length - 1));
}

/**
 * W1-T15181 — pure: shed the youngest disposable child when, together, the container's memory.events high count rose
 * since the previous reading, the loop missed a tick in this reading and in one at least an avg60 window older, and PSI
 * full avg60 is above the learned calm band (dropped while unlearned). One at a time: after a shed, nothing more until
 * that child settled and a fresh reading is taken; a shed after which neither PSI nor memory.current fell by more than
 * its noise suspends shedding until a reading is back inside the band (unlearned: a clear reading). A clear reading
 * ends the episode. Every unread input holds.
 */
export function decideContainerShed(
  reading: ContainerShedReading,
  history: ContainerShedHistory,
  inventory: readonly ContainerShedEntry[] | { unread: string },
): ContainerShedDecision {
  const band = containerCalmBandOf(history.readings, reading.at_ms);
  let episode: ContainerShedEpisode = { ...history.episode };
  const hold = (reason: string, extra: Partial<ContainerShedDecision> = {}): ContainerShedDecision =>
    ({ action: "hold", reason, missing: [], band, episode, write_held: false, ...extra });
  const unread = [...(reading.unread ?? [])];
  const required = ["events_high", "psi_full_avg60", "memory_current_mib", "memory_high_mib", "missed_ticks"] as const;
  for (const field of required) if (reading[field] === undefined && (reading.unread ?? []).length === 0) unread.push(`${field} absent`);
  if (!Array.isArray(inventory)) unread.push(`the inventory: ${(inventory as { unread: string }).unread}`);
  if (unread.length > 0) return hold(`unread: ${unread.join("; ")}`, { unread });
  const entries = inventory as readonly ContainerShedEntry[];
  const prior = [...history.readings].reverse();
  const previous = prior.find((r) => r.events_high !== undefined);
  const highRose = previous !== undefined && reading.events_high! > previous.events_high!;
  const missedNow = reading.missed_ticks! >= 1;
  const earlier = prior.find((r) => r.at_ms <= reading.at_ms - CROSSING_WINDOW_MS);
  const missedTwice = missedNow && (earlier?.missed_ticks ?? 0) >= 1;
  const inBand = band.band !== null && reading.psi_full_avg60! <= band.band;
  const psiAbove = band.band === null || !inBand;
  const clear = !highRose && !missedNow && (band.band === null || inBand);
  let shedEffect: ContainerShedDecision["shed_effect"];
  if (episode.suspended) {
    if (!(band.band === null ? clear : inBand)) return hold("shedding suspended: the last shed was ineffective, and no reading is back inside the calm band yet");
    episode = { ...episode };
    delete episode.suspended;
  }
  if (episode.shed) {
    const shed = episode.shed;
    if (shed.settled_at_ms === undefined) return hold(`waiting for shed child ${shed.run_id} to settle`);
    if (reading.at_ms <= shed.settled_at_ms) return hold(`waiting for a fresh reading after shed child ${shed.run_id} settled`);
    const psiFell = shed.reading.psi_full_avg60! - reading.psi_full_avg60! > readingNoise(history.readings, "psi_full_avg60");
    const memFell = shed.reading.memory_current_mib! - reading.memory_current_mib! > readingNoise(history.readings, "memory_current_mib");
    episode = { ...(episode.held_written ? { held_written: true } : {}) };
    if (!psiFell && !memFell) {
      episode.suspended = true;
      return { action: "suspend", shed_effect: "ineffective", missing: [], band, episode, write_held: false,
        reason: `shed of ${shed.run_id} was ineffective: neither PSI full avg60 nor memory.current fell by more than its noise` };
    }
    shedEffect = "effective";
  }
  if (clear) return hold("clear: no high-count rise, no missed tick", { episode: {}, ...(shedEffect ? { shed_effect: shedEffect } : {}) });
  const missing: string[] = [];
  if (!highRose) missing.push(MISSING_HIGH);
  if (!missedTwice) missing.push(MISSING_TICKS);
  if (!psiAbove) missing.push(MISSING_PSI);
  const candidates = entries.filter(isDisposableShedEntry);
  if (missing.length === 0 && candidates.length === 0) missing.push(MISSING_CANDIDATE);
  if (missing.length > 0) {
    const writeHeld = !episode.held_written;
    episode = { ...episode, held_written: true };
    const why = missing.includes(MISSING_CANDIDATE)
      ? `no disposable candidate among ${entries.length} in-flight entries (a review or a detached fix-dispatch run child)`
      : `partly met: ${missing.join("; ")}`;
    return hold(why, { missing, write_held: writeHeld, ...(shedEffect ? { shed_effect: shedEffect } : {}) });
  }
  // The youngest: the latest admission; a tie goes to the later inventory entry.
  const entry = candidates.reduce((young, e) => (e.admitted_at_ms >= young.admitted_at_ms ? e : young));
  episode = { ...episode, shed: { run_id: entry.run_id!, at_ms: reading.at_ms, reading } };
  return { action: "shed", entry, missing: [], band, episode, write_held: false, ...(shedEffect ? { shed_effect: shedEffect } : {}),
    reason: `memory.high throttling (high ${previous!.events_high} -> ${reading.events_high}), ${reading.missed_ticks} missed tick(s) ` +
      `after ${earlier!.missed_ticks} an avg60 window earlier, PSI full avg60 ${reading.psi_full_avg60} ` +
      (band.band === null ? `(calm band unlearned: ${band.basis})` : `above the calm band ${band.band}`) };
}

export interface ContainerShedReadIo {
  readFile?: (path: string) => string;
  cgroupRoot?: string;
  platform?: string;
}

/** memory.pressure's `full avg60`, or the reason it is unread. host-memory-shadow.ts's readPsi parses the same line but
 *  is module-private; W1-T15181 names the scope amendment that would export it and remove this. */
function psiFullAvg60(read: (path: string) => string, path: string): number | string {
  let text: string;
  try {
    text = read(path);
  } catch (e) {
    return `memory.pressure (${(e as NodeJS.ErrnoException)?.code ?? String((e as Error)?.message ?? e).slice(0, 80)})`;
  }
  const m = /^full .*\bavg60=([0-9.]+)/m.exec(text);
  return m ? Number(m[1]) : "memory.pressure (no full avg60)";
}

/**
 * One reading of the daemon's own cgroup: memory.current and memory.events `high` through sampleCgroupMemory
 * (daemon-memory-telemetry.ts), memory.high as {@link readDaemonMemory} reads it, and memory.pressure full avg60. Off
 * Linux nothing is read and the reading is unread. `missedTicks` is the in-flight tick's own lateness.
 */
export function readContainerShedReading(atMs: number, missedTicks: number | undefined, io: ContainerShedReadIo = {}): ContainerShedReading {
  const platform = io.platform ?? process.platform;
  if (platform !== "linux") return { at_ms: atMs, unread: [`cgroup reads skipped off Linux (${platform})`] };
  const read = io.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const root = io.cgroupRoot ?? "/sys/fs/cgroup";
  const reading: ContainerShedReading = { at_ms: atMs };
  const unread: string[] = [];
  const cg = sampleCgroupMemory(read, root);
  if (cg.cg_memory_current_bytes === undefined) unread.push(`memory.current (${cg.mem_cgroup ?? "absent"})`);
  else reading.memory_current_mib = Math.round(cg.cg_memory_current_bytes / MIB_BYTES);
  if (cg.cg_events_high === undefined) unread.push(`memory.events (${cg.mem_cgroup ?? "no high line"})`);
  else reading.events_high = cg.cg_events_high;
  const high = finiteBytes(read, join(root, "memory.high"));
  if (high === undefined) unread.push("memory.high (unreadable, or max)");
  else reading.memory_high_mib = Math.round(high / MIB_BYTES);
  const psi = psiFullAvg60(read, join(root, "memory.pressure"));
  if (typeof psi === "string") unread.push(psi);
  else reading.psi_full_avg60 = psi;
  if (missedTicks === undefined || !Number.isFinite(missedTicks) || missedTicks < 0) unread.push("loop-lag reading");
  else reading.missed_ticks = missedTicks;
  if (unread.length > 0) reading.unread = unread;
  return reading;
}
