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
import { setFlagsFromString } from "node:v8";
import { parse as parseYaml } from "yaml";

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
  };
}
