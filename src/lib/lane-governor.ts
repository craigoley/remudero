/**
 * lib/lane-governor.ts — W1-T9097 (ADR 0007 decision C, "Parallelism adapts"): THE BUILD LANE COUNT FOLLOWS THE
 * MEMORY GOVERNOR, NOT A FIXED NUMBER. `sweep.dispatchLanes` is a fixed 3 that only a plan PR and a restart can change,
 * while ADR 0007 makes each lane cost a whole Node process more. Operator 2026-10-13: "Reduce parallelism if we need
 * to"; standing rule: no hard fixed thresholds.
 *
 * {@link laneTarget} is the largest lane count n >= 1 whose projection stays under the onset the shadow budget judges
 * against (memory.high, through W1-T8472's lift-gated container basis), with the host arm likewise. The projection is
 * the shadow budget's own (host-memory-shadow.ts): the container's working set, the daemon's measured growth, every
 * in-flight tree's learned remaining claim, plus one more run tree at the learned class tail of the next build per new
 * lane. Under container pressure (its own PSI or swap-in past the thresholds, or memory.events `high` rising since the
 * previous reading) it shrinks at once; with none it grows by at most one lane per reading. Its only upper bounds are
 * the adaptive WIP bound and the CPU count: no fixed lane number.
 *
 * `sweep.laneGovernor.mode` (plan/policy.yaml) is `shadow` (shipped) or `enforce`. The daemon ledgers
 * `dispatch.lane_target` once per reading in both; only `enforce` lets it cap NEW admissions (a tick's dispatch set
 * and each lane refill). A running lane is never stopped by a lower target.
 */
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";

import {
  defaultShadowMemoryPorts,
  evaluateShadowMemory,
  gatherShadowInputs,
  type ContainerLift,
  type HostMemoryBudgetPolicy,
  type ShadowMemoryPorts,
} from "./host-memory-shadow.js";
import { loadLaneGovernorMode, type LaneGovernorMode } from "./policy.js";

export const LANE_TARGET_STEP = "dispatch.lane_target";

/** One reading of what the lane count is judged against. Every figure is MiB. */
export interface LaneMemoryReading {
  /** The container's projected working set before any new lane: working set, every in-flight tree's claim and the
   *  daemon's typical growth. Null when the container is unread or unbounded. */
  containerBaseMib: number | null;
  /** The level that projection is judged against (memory.high), or null. */
  containerOnsetMib: number | null;
  /** Whether a projection over the onset counts (W1-T8472): false once the container's own history shows its flags do
   *  not predict its pressure beyond sampling noise. Pressure itself always counts. */
  containerArmCounts: boolean;
  containerBasis: string;
  /** Projected MemAvailable after every in-flight claim and margin, before a new lane. Null when unread. */
  hostBaseAvailableMib: number | null;
  hostReserveMib: number;
  /** One more run tree at the learned class tail (p90 peak) of the next build. */
  perLaneMib: number;
  /** The container's own PSI or swap-in past the thresholds now. */
  containerPressed: boolean;
  /** memory.events `high`, cumulative; absent with the reason when unread. */
  highEvents?: number;
  highEventsUnread?: string;
}

/** What one reading carries to the next. */
export interface LaneTargetPrevious {
  target: number;
  highEvents?: number;
}

export interface LaneTargetInputs {
  previous?: LaneTargetPrevious;
  /** Build lanes running now; their trees' claims are already inside the reading's base. */
  inFlight: number;
  memory: LaneMemoryReading | { unread: string };
  /** The adaptive WIP bound (adaptive-wip.ts) when one was read. */
  wipBound?: number;
  cpuCount: number;
  /** What the CPU arm has learned (W1-T11129); absent or unlearned keeps the cap at {@link cpuCount}. */
  cpu?: LaneCpuReading;
}

/** W1-T11129 — the CPU arm's learned figures, in CPUs (CPU-seconds per second). Null is "not learned yet". */
export interface LaneCpuReading {
  /** CPU the host's non-lane work uses while no lane runs (daemon, serve, the box itself). */
  baselineCpus: number | null;
  /** CPU one lane of the class being admitted uses, as a running median over lanes that ran. */
  perLaneCpus: number | null;
}

/**
 * The CPU arm's lane bound: the host's CPUs less the measured non-lane baseline, over what one lane of the class has
 * been measured to use. Null while either figure is unread or unlearned, so the caller keeps today's cap at the CPU
 * count. No constant: both figures come from the cgroup counter.
 */
export function cpuLaneBound(cpuCount: number, cpu: LaneCpuReading | undefined): number | null {
  if (cpu === undefined || cpu.baselineCpus === null || cpu.perLaneCpus === null) return null;
  if (!Number.isFinite(cpu.baselineCpus) || !Number.isFinite(cpu.perLaneCpus) || cpu.perLaneCpus <= 0) return null;
  return Math.floor(Math.max(0, cpuCount - Math.max(0, cpu.baselineCpus)) / cpu.perLaneCpus);
}

export type LaneBinding = "pressure" | "container" | "host" | "growth" | "unread" | "wip" | "cpu";

export interface LaneTarget {
  target: number;
  binding: LaneBinding;
  pressed: boolean;
  /** The container projection at the target, and the onset it is judged against; null when not read. */
  projectionMib: number | null;
  onsetMib: number | null;
  unread?: string;
  next: LaneTargetPrevious;
}

/** The lane target for one reading. Pure: no clock, no fs. */
export function laneTarget(inputs: LaneTargetInputs): LaneTarget {
  const inFlight = Math.max(0, Math.floor(inputs.inFlight));
  const prior = inputs.previous?.target;
  // In priority order: the first bound at the minimum names the binding.
  const bounds: Array<[number, LaneBinding]> = [];
  const memory = inputs.memory;
  let pressed = false;
  let projectionBase: number | null = null;
  let onsetMib: number | null = null;
  let perLaneMib = 0;
  let unread: string | undefined;
  let highEvents = inputs.previous?.highEvents;
  if ("unread" in memory) {
    // Nothing measured: hold where it was, never grow on an absent reading.
    unread = memory.unread;
    bounds.push([prior ?? Math.max(1, inFlight), "unread"]);
  } else {
    perLaneMib = Math.max(1, memory.perLaneMib);
    const fit = (roomMib: number): number => inFlight + Math.floor(roomMib / perLaneMib);
    const rising = memory.highEvents !== undefined && highEvents !== undefined && memory.highEvents > highEvents;
    pressed = memory.containerPressed || rising;
    if (memory.highEvents !== undefined) highEvents = memory.highEvents;
    if (pressed) bounds.push([(prior ?? inFlight) - 1, "pressure"]);
    if (memory.containerBaseMib !== null && memory.containerOnsetMib !== null) {
      projectionBase = memory.containerBaseMib;
      onsetMib = memory.containerOnsetMib;
      if (memory.containerArmCounts) bounds.push([fit(onsetMib - projectionBase), "container"]);
    }
    if (memory.hostBaseAvailableMib !== null) bounds.push([fit(memory.hostBaseAvailableMib - memory.hostReserveMib), "host"]);
    if (!pressed && prior !== undefined) bounds.push([prior + 1, "growth"]);
  }
  if (inputs.wipBound !== undefined && Number.isFinite(inputs.wipBound)) bounds.push([Math.floor(inputs.wipBound), "wip"]);
  bounds.push([cpuLaneBound(inputs.cpuCount, inputs.cpu) ?? Math.floor(inputs.cpuCount), "cpu"]);
  let [target, binding] = bounds[0]!;
  for (const [n, name] of bounds) if (n < target) [target, binding] = [n, name];
  target = Math.max(1, target);
  return {
    target,
    binding,
    pressed,
    projectionMib: projectionBase === null ? null : projectionBase + Math.max(0, target - inFlight) * perLaneMib,
    onsetMib,
    ...(unread !== undefined ? { unread } : {}),
    next: { target, ...(highEvents !== undefined ? { highEvents } : {}) },
  };
}

/** `usage_usec` from a cgroup v2 `cpu.stat`, or null when the line is absent. */
export function parseCpuUsageUsec(text: string): number | null {
  const raw = /^usage_usec (\d+)$/m.exec(text)?.[1];
  return raw === undefined ? null : Number(raw);
}

/** One running lane: a stable identity for as long as it runs, and its class (the run-child rows' WorkerClass). */
export interface RunningLane {
  id: string;
  cls: string;
}

/** One reading of the cgroup CPU counter and the lanes running at the instant it was taken. */
export interface LaneCpuSample {
  atMs: number;
  usageUsec: number;
  /** Every lane running at this instant, before any lane start or end the caller is about to apply. */
  lanes: readonly RunningLane[];
  /** The caller is about to start or end a lane: this sample closes the interval those lanes ran through. */
  closes?: boolean;
}

/** What the CPU arm keeps between samples: the counter reading that opened the current interval, and rate histories. */
export interface LaneCpuLearnerState {
  /** The reading that opened the current interval, and the identities of the lanes running through it. */
  last?: { atMs: number; usageUsec: number; lanes: string };
  /** CPU use (CPUs) over intervals in which no lane ran. */
  idle: number[];
  /** CPU use per lane (CPUs), per class, from intervals in which lanes of that one class ran. */
  perClass: Record<string, number[]>;
}

/** A history this long is a running window, not a threshold: the oldest samples fall out. */
const CPU_HISTORY = 64;

export function initialLaneCpuLearner(): LaneCpuLearnerState {
  return { idle: [], perClass: {} };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function pushBounded(history: readonly number[], value: number): number[] {
  return [...history, value].slice(-CPU_HISTORY);
}

/** The set of running lanes as one comparable key: identities, order-free. */
function laneSetKey(lanes: readonly RunningLane[]): string {
  return JSON.stringify([...new Set(lanes.map((lane) => lane.id))].sort());
}

/**
 * Folds one `usage_usec` sample in. An interval runs from one lane start or end to the next, and its delta is CPUs
 * used by exactly the lanes that ran THROUGH it: the caller samples with `closes` right BEFORE it applies a lane start
 * or end, then {@link relabelLaneCpu} opens the next interval with the new lane set. A plain reading on the same lane
 * set extends the open interval (so a reading taken just after a transition never yields a millisecond-long rate); a
 * reading that finds a DIFFERENT lane set saw a start or end nobody sampled, so it re-opens the interval there and
 * teaches nothing. With no lane running the rate is the non-lane baseline; with lanes of one class it is that class's
 * per-lane figure after the baseline is taken off. Mixed classes, a counter that went backwards, or a baseline not yet
 * learned teaches nothing. Pure: the clock is the sample's own.
 */
export function learnLaneCpu(state: LaneCpuLearnerState, sample: LaneCpuSample): LaneCpuLearnerState {
  const last = state.last;
  const lanes = laneSetKey(sample.lanes);
  const next: LaneCpuLearnerState = { ...state, last: { atMs: sample.atMs, usageUsec: sample.usageUsec, lanes } };
  if (last === undefined || sample.usageUsec < last.usageUsec || last.lanes !== lanes) return next;
  if (sample.closes !== true) return state;
  if (sample.atMs <= last.atMs) return next;
  const cpus = (sample.usageUsec - last.usageUsec) / 1000 / (sample.atMs - last.atMs);
  if (sample.lanes.length === 0) return { ...next, idle: pushBounded(state.idle, cpus) };
  const classes = new Set(sample.lanes.map((lane) => lane.cls));
  const baseline = median(state.idle);
  if (classes.size !== 1 || baseline === null) return next;
  const cls = [...classes][0]!;
  const perLane = Math.max(0, cpus - baseline) / new Set(sample.lanes.map((lane) => lane.id)).size;
  return { ...next, perClass: { ...state.perClass, [cls]: pushBounded(state.perClass[cls] ?? [], perLane) } };
}

/**
 * A lane start or end the caller has just applied, at the instant of the sample taken right before it: the next
 * interval opens with the new lane set. Without a counter reading there is no open interval to relabel.
 */
export function relabelLaneCpu(state: LaneCpuLearnerState, lanes: readonly RunningLane[]): LaneCpuLearnerState {
  return state.last === undefined ? state : { ...state, last: { ...state.last, lanes: laneSetKey(lanes) } };
}

/** The learned figures for admitting a lane of class `laneClass`. */
export function laneCpuReading(state: LaneCpuLearnerState, laneClass: string): LaneCpuReading {
  return { baselineCpus: median(state.idle), perLaneCpus: median(state.perClass[laneClass] ?? []) };
}

/** The `dispatch.lane_target` row: the target beside the fixed number it would replace. */
export function laneTargetPayload(
  result: LaneTarget, context: { mode: LaneGovernorMode; fixed: number; inFlight: number },
): Record<string, unknown> {
  return {
    mode: context.mode,
    target: result.target,
    fixed: context.fixed,
    binding: result.binding,
    projection_mib: result.projectionMib === null ? null : Math.round(result.projectionMib),
    onset_mib: result.onsetMib === null ? null : Math.round(result.onsetMib),
    in_flight: context.inFlight,
    pressed: result.pressed,
    ...(result.unread !== undefined ? { unread: result.unread } : {}),
  };
}

/** Mirrors host-memory-shadow.ts's container relation (W1-T8472): an unlearned lift lets the projection alone count. */
function containerArmCounts(lift: ContainerLift | undefined): boolean {
  if (lift === undefined || "unlearned" in lift) return true;
  return lift.afterProjection - lift.afterAny > lift.noise;
}

/**
 * The real reading over the state root `root`: the shadow budget's snapshot for a zero-claim build start, so every
 * figure is the one its verdicts judge. It never trains that budget: the pressure store is not written and the host
 * swap-in sample (a module-level prior) is not taken, so the host arm carries the unmeasured-swap-in margin instead.
 */
export function readLaneMemory(root: string, overrides: Partial<ShadowMemoryPorts> = {}): LaneMemoryReading {
  const base = { ...defaultShadowMemoryPorts(), ...overrides };
  const ports: ShadowMemoryPorts = {
    ...base,
    writeFile: () => {},
    readFile: (path) => {
      if (path === "/proc/vmstat") throw new Error("host swap-in is sampled by the shadow budget's own verdicts");
      return base.readFile(path);
    },
  };
  // The class modes only decide whether gathering may refuse an unqualified enforce; this reading enforces nothing.
  const policy: HostMemoryBudgetPolicy = { ...ports.policy(), mode: "shadow", classModes: {} };
  const inputs = gatherShadowInputs({ workerClass: "implement", root, estimateMib: 0 }, ports, policy);
  const numbers = evaluateShadowMemory(inputs, policy).numbers;
  let highEvents: number | undefined;
  let highEventsUnread: string | undefined;
  try {
    const raw = /^high (\d+)$/m.exec(ports.readFile("/sys/fs/cgroup/memory.events"))?.[1];
    if (raw === undefined) highEventsUnread = "no high line in memory.events";
    else highEvents = Number(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    highEventsUnread = reason;
  }
  return {
    containerBaseMib: numbers.containerProjectedMib,
    containerOnsetMib: numbers.containerOnsetMib,
    containerArmCounts: containerArmCounts(inputs.containerLift),
    containerBasis: numbers.containerBasis,
    hostBaseAvailableMib: numbers.projectedAvailableMib,
    hostReserveMib: numbers.hostReserveMib,
    perLaneMib: ports.estimate("implement"),
    containerPressed: numbers.containerPressed || numbers.containerSighted,
    ...(highEvents !== undefined ? { highEvents } : {}),
    ...(highEventsUnread !== undefined ? { highEventsUnread } : {}),
  };
}

/** What the daemon consults: the mode, the reading and the CPU count. */
export interface LaneGovernorPorts {
  mode: () => LaneGovernorMode;
  read: () => LaneMemoryReading;
  cpuCount: () => number;
  /** W1-T11129 — the container's cgroup cpu.stat usage_usec, or null when unread (the learner then holds still). */
  cpuUsageUsec?: () => number | null;
}

/**
 * W1-T11129 — the lane classes the CPU arm learns apart, named as the run-child rows name them (host-memory-ledger.ts's
 * WorkerClass): a dispatch lane runs an implement build, an in-process review is a review. The dispatch target admits
 * implement lanes, so its bound reads that class's figure; an interval with reviews beside builds teaches neither.
 */
export const DISPATCH_LANE_CPU_CLASS = "implement";
export const REVIEW_LANE_CPU_CLASS = "review";

/** W1-T11129 — the container's own cgroup cpu.stat usage_usec (cgroup v2, read inside the container's namespace). */
export function readCgroupCpuUsageUsec(path = "/sys/fs/cgroup/cpu.stat", read: (path: string) => string = (p) => readFileSync(p, "utf8")): number | null {
  try { return parseCpuUsageUsec(read(path)); }
  catch {
    // Unread (no cgroup v2, or off Linux): null makes the learner hold still and the bound fall back to the CPU count.
    return null;
  }
}

let publishedCpuLaneBound: number | null = null;

/** W1-T11129 — the daemon publishes the learned CPU lane bound each reading; review capacity reads it as its hold. */
export function publishLaneCpuBound(bound: number | null): void {
  publishedCpuLaneBound = bound !== null && Number.isFinite(bound) ? bound : null;
}

/**
 * W1-T11129 — one CPU reading for the dispatch target: sample the container's cpu.stat through the ports with the lanes
 * running at this instant (identity and class), learn (`closes` when a lane start or end follows), and return the
 * implement class's reading laneTarget takes plus the bound it implies. An unread or throwing counter reads as unread
 * NOW, learned history or not: the figures are null, so the bound is null and the cap falls back to the CPU count
 * rather than to medians the counter can no longer confirm. The history is kept for when the counter returns, but the
 * open interval is dropped, so the first interval after the gap (whose lanes went unseen) teaches nothing.
 */
export function readLaneCpu(
  learner: LaneCpuLearnerState, ports: Pick<LaneGovernorPorts, "cpuCount" | "cpuUsageUsec">, nowMs: number, lanes: readonly RunningLane[],
  closes = false,
): { learner: LaneCpuLearnerState; cpu: LaneCpuReading; bound: number | null } {
  let usageUsec: number | null = null;
  try { usageUsec = ports.cpuUsageUsec?.() ?? null; }
  catch {
    // A throwing port is an unread counter, handled exactly as a null reading below.
    usageUsec = null;
  }
  if (usageUsec === null) {
    const kept: LaneCpuLearnerState = { ...learner };
    delete kept.last;
    return { learner: kept, cpu: { baselineCpus: null, perLaneCpus: null }, bound: null };
  }
  const next = learnLaneCpu(learner, { atMs: nowMs, usageUsec, lanes, closes });
  const cpu = laneCpuReading(next, DISPATCH_LANE_CPU_CLASS);
  return { learner: next, cpu, bound: cpuLaneBound(ports.cpuCount(), cpu) };
}

/** W1-T11129 — a container's cpu.weight over the sum of every running container's weights (its own included). */
export function cpuWeightShare(own: number, running: readonly number[]): number | undefined {
  if (!Number.isFinite(own) || own <= 0) return undefined;
  const total = running.filter((weight) => Number.isFinite(weight) && weight > 0).reduce((sum, weight) => sum + weight, 0);
  return total <= 0 ? undefined : Math.min(1, own / Math.max(total, own));
}

/** Where deploy/memory-high-tuner.sh records every fleet container's cpu.weight, in the instance's state dir. */
export const CPU_WEIGHTS_FILE = "cpu-weights.json";

/**
 * W1-T11129 — the daemon's cpu.weight share, from the host tuner's record (`<stateDir>/cpu-weights.json`): its own
 * weight (`self`) over every running fleet container's. Freshness is the tuner's own: the file carries its write time
 * and the one before, and a record older than two of those intervals is stale. Unread, stale, a first record with no
 * interval yet, or a malformed one: undefined, so review capacity keeps today's fixed line.
 */
export function readCpuWeightShare(stateDir: string, nowMs: number, read: (path: string) => string = (p) => readFileSync(p, "utf8")): number | undefined {
  let record: unknown;
  try { record = JSON.parse(read(join(stateDir, CPU_WEIGHTS_FILE))); }
  catch {
    // No record yet (the tuner has not run on this host, or off Linux): the share is unread.
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  const { self, weights, updated_at_s: at, previous_updated_at_s: before } = record as Record<string, unknown>;
  if (typeof self !== "string" || typeof weights !== "object" || weights === null) return undefined;
  if (typeof at !== "number" || typeof before !== "number" || !(at > before)) return undefined;
  if (nowMs / 1000 - at > 2 * (at - before)) return undefined;
  const values = Object.values(weights as Record<string, unknown>);
  if (!values.every((w) => typeof w === "number")) return undefined;
  const own = (weights as Record<string, unknown>)[self];
  return typeof own === "number" ? cpuWeightShare(own, values as number[]) : undefined;
}

/** The last published learned CPU lane bound, or undefined while unlearned or unread. */
export function publishedLaneCpuBound(): number | undefined {
  return publishedCpuLaneBound === null ? undefined : publishedCpuLaneBound;
}

/** The real ports over a daemon state directory (`<root>/state`, the ledger's directory). */
export function defaultLaneGovernorPorts(stateDir: string): LaneGovernorPorts {
  const root = dirname(stateDir);
  return {
    mode: () => loadLaneGovernorMode(), read: () => readLaneMemory(root), cpuCount: () => availableParallelism(),
    cpuUsageUsec: () => readCgroupCpuUsageUsec(),
  };
}
