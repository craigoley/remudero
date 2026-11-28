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
import { fixedClock, systemClock } from "./clock.js";

import {
  defaultShadowMemoryPorts,
  evaluateShadowMemory,
  gatherShadowInputs,
  type ContainerLift,
  type HostMemoryBudgetPolicy,
  type ShadowMemoryPorts,
} from "./host-memory-shadow.js";
import { loadLaneGovernorMode, type LaneGovernorMode } from "./policy.js";
import { publishStaticWorkProjection, STATIC_WORK_PROJECTION_STALE_MS } from "./test-slot.js";

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
  /** W1-T14903 — the kernel MemAvailable that projection was cut from, in the same sample. Absent or null: unread. */
  hostMeasuredAvailableMib?: number | null;
  hostReserveMib: number;
  /** One more run tree at the learned class tail (p90 peak) of the next build. */
  perLaneMib: number;
  /** One more run tree at the class's learned TYPICAL peak (the median), at most {@link perLaneMib}. Absent: every new
   *  lane is charged the whole {@link perLaneMib}, as before. Present: the shadow budget's own rule applies to the new
   *  lanes — each claims its typical growth, and only ONE tail above it competes with the tail already reserved. */
  perLaneTypicalMib?: number;
  /** The tail the container base already reserves (the shadow budget's containerTailMib); a new lane's tail competes
   *  with it for the one allowance. Absent: none is credited. */
  containerTailMib?: number;
  /** The tail the host base already reserves (the shadow budget's hostTailMib). Absent: none is credited. */
  hostTailMib?: number;
  /** The container's own PSI or swap-in past the thresholds now. */
  containerPressed: boolean;
  /** memory.events `high`, cumulative; absent with the reason when unread. */
  highEvents?: number;
  highEventsUnread?: string;
  /** What {@link containerBaseMib} is made of, so a `container` binding can be explained from its row alone. */
  containerParts?: ContainerProjectionParts;
}

/** The container base, split: working set (memory.current less inactive_file) + the in-flight trees' claim + this
 *  daemon's typical growth (the remainder). `currentMib` and `reclaimableMib` are what the working set was cut from. */
export interface ContainerProjectionParts {
  currentMib: number;
  reclaimableMib: number;
  workingSetMib: number;
  claimMib: number;
  daemonTypicalMib: number;
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
  /** The lane pool's size (the fixed `sweep.dispatchLanes`). Present: the target never grows past it, so a later
   *  shed (pressure is the previous target less one) bites at once instead of first walking down from above the pool. */
  maxLanes?: number;
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

export type LaneBinding = "pressure" | "container" | "host" | "growth" | "unread" | "wip" | "cpu" | "fixed";

export interface LaneTarget {
  target: number;
  binding: LaneBinding;
  pressed: boolean;
  /** The container projection at the target, and the onset it is judged against; null when not read. */
  projectionMib: number | null;
  onsetMib: number | null;
  /** W1-T13658: the numbers the host bound was cut from, fit(hostBaseAvailableMib - hostReserveMib) over perLaneMib;
   *  each null when the memory reading is unread (and the base alone when MemAvailable is). */
  hostBaseAvailableMib: number | null;
  hostReserveMib: number | null;
  perLaneMib: number | null;
  /** The typical charge of each new lane; equal to perLaneMib when no typical was read. */
  perLaneTypicalMib: number | null;
  unread?: string;
  next: LaneTargetPrevious;
  /** The reading's container basis and base split; absent when unread. */
  containerBasis?: string;
  containerParts?: ContainerProjectionParts;
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
  let perLaneTypicalMib = 0;
  let containerExtraTail = 0;
  let unread: string | undefined;
  let highEvents = inputs.previous?.highEvents;
  if ("unread" in memory) {
    // Nothing measured: hold where it was, never grow on an absent reading.
    unread = memory.unread;
    bounds.push([prior ?? Math.max(1, inFlight), "unread"]);
  } else {
    perLaneMib = Math.max(1, memory.perLaneMib);
    // The shadow budget's rule (host-memory-shadow.ts): every tree's typical growth counts, and only ONE tail above it.
    // So k new lanes cost k x typical plus the part of one lane's tail the base has not already reserved.
    perLaneTypicalMib = Math.max(1, Math.min(perLaneMib, memory.perLaneTypicalMib ?? perLaneMib));
    const extraTail = (reservedTailMib: number | undefined): number =>
      Math.max(0, perLaneMib - perLaneTypicalMib - Math.max(0, reservedTailMib ?? 0));
    containerExtraTail = extraTail(memory.containerTailMib);
    // Over the onset already: shed a lane per typical lane's worth over, as before. Room under one typical lane plus
    // the unreserved tail: no new lane.
    const fit = (roomMib: number, extra: number): number => {
      if (roomMib < 0) return inFlight + Math.floor(roomMib / perLaneTypicalMib);
      if (roomMib < perLaneTypicalMib + extra) return inFlight;
      return inFlight + Math.floor((roomMib - extra) / perLaneTypicalMib);
    };
    const rising = memory.highEvents !== undefined && highEvents !== undefined && memory.highEvents > highEvents;
    pressed = memory.containerPressed || rising;
    if (memory.highEvents !== undefined) highEvents = memory.highEvents;
    if (pressed) bounds.push([(prior ?? inFlight) - 1, "pressure"]);
    if (memory.containerBaseMib !== null && memory.containerOnsetMib !== null) {
      projectionBase = memory.containerBaseMib;
      onsetMib = memory.containerOnsetMib;
      if (memory.containerArmCounts) bounds.push([fit(onsetMib - projectionBase, containerExtraTail), "container"]);
    }
    if (memory.hostBaseAvailableMib !== null) bounds.push([fit(memory.hostBaseAvailableMib - memory.hostReserveMib, extraTail(memory.hostTailMib)), "host"]);
    if (!pressed && prior !== undefined) bounds.push([prior + 1, "growth"]);
  }
  if (inputs.wipBound !== undefined && Number.isFinite(inputs.wipBound)) bounds.push([Math.floor(inputs.wipBound), "wip"]);
  bounds.push([cpuLaneBound(inputs.cpuCount, inputs.cpu) ?? Math.floor(inputs.cpuCount), "cpu"]);
  if (inputs.maxLanes !== undefined && Number.isFinite(inputs.maxLanes)) bounds.push([Math.max(1, Math.floor(inputs.maxLanes)), "fixed"]);
  let [target, binding] = bounds[0]!;
  for (const [n, name] of bounds) if (n < target) [target, binding] = [n, name];
  target = Math.max(1, target);
  const added = Math.max(0, target - inFlight);
  return {
    target,
    binding,
    pressed,
    projectionMib: projectionBase === null ? null
      : projectionBase + added * perLaneTypicalMib + (added > 0 ? containerExtraTail : 0),
    onsetMib,
    hostBaseAvailableMib: "unread" in memory ? null : memory.hostBaseAvailableMib,
    hostReserveMib: "unread" in memory ? null : memory.hostReserveMib,
    perLaneMib: "unread" in memory ? null : perLaneMib,
    perLaneTypicalMib: "unread" in memory ? null : perLaneTypicalMib,
    ...(unread !== undefined ? { unread } : {}),
    next: { target, ...(highEvents !== undefined ? { highEvents } : {}) },
    ...("unread" in memory ? {} : { containerBasis: memory.containerBasis }),
    ...("unread" in memory || memory.containerParts === undefined ? {} : { containerParts: memory.containerParts }),
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
    host_base_available_mib: result.hostBaseAvailableMib === null ? null : Math.round(result.hostBaseAvailableMib),
    host_reserve_mib: result.hostReserveMib === null ? null : Math.round(result.hostReserveMib),
    per_lane_mib: result.perLaneMib === null ? null : Math.round(result.perLaneMib),
    per_lane_typical_mib: result.perLaneTypicalMib === null ? null : Math.round(result.perLaneTypicalMib),
    in_flight: context.inFlight,
    pressed: result.pressed,
    ...(result.containerBasis !== undefined ? { container_basis: result.containerBasis } : {}),
    ...(result.containerParts !== undefined ? {
      container_current_mib: Math.round(result.containerParts.currentMib),
      container_reclaimable_mib: Math.round(result.containerParts.reclaimableMib),
      container_working_set_mib: Math.round(result.containerParts.workingSetMib),
      container_claim_mib: Math.round(result.containerParts.claimMib),
      container_daemon_typical_mib: Math.round(result.containerParts.daemonTypicalMib),
    } : {}),
    ...(result.unread !== undefined ? { unread: result.unread } : {}),
  };
}

/** The base split from the shadow numbers; undefined when the container was unread or unbounded (no projection). */
function containerPartsOf(numbers: ReturnType<typeof evaluateShadowMemory>["numbers"]): ContainerProjectionParts | undefined {
  const { containerProjectedMib: projected, containerWorkingSetMib: workingSet, containerCurrentMib: current } = numbers;
  if (projected === null || workingSet === null || current === null) return undefined;
  return {
    currentMib: current, reclaimableMib: current - workingSet, workingSetMib: workingSet,
    claimMib: numbers.containerClaimMib, daemonTypicalMib: projected - workingSet - numbers.containerClaimMib,
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
  const perLaneMib = ports.estimate("implement");
  // The class median the shadow budget splits a tree's claim at; unreadable, the whole estimate stays typical.
  let perLaneTypicalMib: number | undefined;
  try { perLaneTypicalMib = Math.min(perLaneMib, ports.typical("implement")); }
  catch (error) {
    void error; // An unreadable estimate store: no median, so every new lane is charged the whole estimate, as before.
  }
  let highEvents: number | undefined;
  let highEventsUnread: string | undefined;
  const containerParts = containerPartsOf(numbers);
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
    hostMeasuredAvailableMib: numbers.memAvailableMib,
    hostReserveMib: numbers.hostReserveMib,
    perLaneMib,
    ...(perLaneTypicalMib !== undefined ? { perLaneTypicalMib } : {}),
    containerTailMib: numbers.containerTailMib,
    hostTailMib: numbers.hostTailMib,
    containerPressed: numbers.containerPressed || numbers.containerSighted,
    ...(highEvents !== undefined ? { highEvents } : {}),
    ...(highEventsUnread !== undefined ? { highEventsUnread } : {}),
    ...(containerParts !== undefined ? { containerParts } : {}),
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
let publishedPerLaneCpus: Readonly<Record<string, number>> = {};

/** W1-T11129 — the daemon publishes each lane class's learned per-lane CPU with the bound, for audit. Unlearned is absent. */
export function publishLaneCpuClasses(learner: LaneCpuLearnerState): void {
  const perLane: Record<string, number> = {};
  for (const cls of Object.keys(learner.perClass)) {
    const figure = laneCpuReading(learner, cls).perLaneCpus;
    if (figure !== null) perLane[cls] = figure;
  }
  publishedPerLaneCpus = perLane;
}

/** The last published per-lane CPU of `laneClass`, or undefined while unlearned. */
export function publishedLaneCpuPerLane(laneClass: string): number | undefined {
  return publishedPerLaneCpus[laneClass];
}

/** W1-T14903 — the audit row each shared host memory snapshot writes once, from the review width pass that reads it:
 *  the snapshot, each lane's share and which lane yielded. Record-only (scripts/write-only-ledger-step-baseline.json). */
export const HOST_MEMORY_SHARED_STEP = "host_memory.shared";

/**
 * W1-T14903 — THE ONE HOST MEMORY SNAPSHOT BOTH LANES CUT FROM. The build lane's reading ({@link readLaneMemory}) is
 * MemAvailable projected after every in-flight worker's remaining claim, reviews and builds alike; the review width
 * read raw MemAvailable, so a full review lane could hold builds down while the review lane still saw room. Each
 * lane-target reading publishes its
 * snapshot here; review capacity takes the lower of it and its own reading, so neither lane spends memory the other
 * already counted, and neither width can rise (INVARIANT width-never-grows).
 */
export interface SharedHostMemory {
  atMs: number;
  /** Projected MemAvailable after every in-flight claim, MiB (the lane governor's host base). */
  availableMib: number;
  hostReserveMib: number;
  /** One more build at its learned typical peak, MiB. */
  perLaneTypicalMib: number;
  /** One more build at its learned tail (p90) peak, MiB. */
  perLaneMib: number;
  /** The tail the host base already reserves, MiB; a new build's tail competes with it (see {@link laneTarget}). */
  hostTailMib: number;
  /** The kernel MemAvailable the projection was cut from, in the same sample, MiB; recorded on the row only. Review
   *  capacity's legacy ceiling reads a CURRENT kernel sample instead: this one can be minutes old. Absent: unread. */
  measuredMib?: number;
}

let publishedSharedHostMemory: SharedHostMemory | null = null;

/** BACKSTOP: a snapshot older than this is not read as it stands. The primary control is the lane-target reading
 *  itself, re-taken every dispatch poll interval; a pass whose pin outlives this re-pins a fresh one (re-read through
 *  the governor's reader when none is fresh), and only with no reading at all does each lane keep its own. */
export const SHARED_HOST_MEMORY_STALE_MS = STATIC_WORK_PROJECTION_STALE_MS;

/** W1-T14903 — publish one lane memory reading as the shared snapshot; an unread or host-unread reading clears it. */
export function publishSharedHostMemory(reading: LaneMemoryReading | { unread: string }, atMs: number, dir?: string): void {
  if ("unread" in reading || reading.hostBaseAvailableMib === null || !Number.isFinite(reading.hostBaseAvailableMib)) {
    publishedSharedHostMemory = null;
    publishStaticWorkProjection(null, atMs, dir);
    return;
  }
  // W1-T15179: a static stage (a warm tsc) in this process is admitted against the same projection, not raw headroom.
  publishStaticWorkProjection(reading.hostBaseAvailableMib, atMs, dir);
  publishedSharedHostMemory = {
    atMs,
    availableMib: reading.hostBaseAvailableMib,
    hostReserveMib: reading.hostReserveMib,
    perLaneTypicalMib: Math.max(1, Math.min(reading.perLaneMib, reading.perLaneTypicalMib ?? reading.perLaneMib)),
    perLaneMib: Math.max(1, reading.perLaneMib),
    hostTailMib: Math.max(0, reading.hostTailMib ?? 0),
    ...(typeof reading.hostMeasuredAvailableMib === "number" && Number.isFinite(reading.hostMeasuredAvailableMib)
      ? { measuredMib: reading.hostMeasuredAvailableMib } : {}),
  };
}

/** The reader the build lane's governor takes its readings through, installed when its ports are built (before any
 *  read, so a PAUSE-booted daemon has it too); unset, nothing re-reads. */
let sharedHostMemoryReader: (() => LaneMemoryReading) | undefined;

/** W1-T14903 — the reader {@link refreshSharedHostMemory} re-reads through (the governor's own; tests pass a fake). */
export function setSharedHostMemoryReader(reader: (() => LaneMemoryReading) | undefined): void {
  sharedHostMemoryReader = reader;
}

/**
 * W1-T14903 — the fresh shared snapshot, re-read through the build lane's own reader when it has expired. The daemon's
 * dispatch loop publishes a snapshot each poll; while it is paused nothing does, so a review pass that found the
 * snapshot expired would otherwise fall back to its own reading and write no row. With no reader (no governor in this
 * process) nothing is re-read.
 */
export function refreshSharedHostMemory(nowMs: number, reader = sharedHostMemoryReader): SharedHostMemory | undefined {
  const fresh = sharedHostMemory(nowMs);
  if (fresh !== undefined || reader === undefined) return fresh;
  let reading: LaneMemoryReading | { unread: string };
  try { reading = reader(); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    reading = { unread: reason };
  }
  publishSharedHostMemory(reading, nowMs);
  return sharedHostMemory(nowMs);
}

type SharedRowLog = (step: string, extra?: Record<string, unknown>) => void;

/**
 * W1-T14903 — ONE SNAPSHOT PER PASS. A sweep pass pins the shared snapshot once, when it starts, and every consumer in
 * that pass (the review width, re-review admission, the audit row) reads the pinned snapshot, never the live one the
 * dispatch loop may re-publish while the pass awaits a read. The pass writes one {@link HOST_MEMORY_SHARED_STEP} row per
 * pinned snapshot: consumers record into it and its owner flushes it.
 *
 * A pin outlives its pass when a refill runs late (a lane freed minutes after the pass read): past the stale bound the
 * pin no longer describes the host, so the pass RE-PINS from the current shared snapshot (re-read through the build
 * lane's reader when that has expired too) and the late consumers form a new segment with its own row.
 */
export interface SharedHostMemoryPass {
  /** The pinned snapshot of the current segment; replaced only when it expires ({@link pinnedSharedHostMemory}). */
  snapshot: SharedHostMemory | undefined;
  /** When the current segment was pinned: with no snapshot, a re-read is attempted once this is past the bound. */
  pinnedAtMs: number;
  width?: { ownMib: number | null; readMib: number | null; width: number; ownWidth: number; yieldedWidth: boolean };
  heldPrs: Set<number>;
  /** The current segment's row has been written, unchanged since. */
  written: boolean;
  /** The serialized row last written for the current segment. */
  writtenRow?: string;
  /** Rows of earlier, re-pinned segments not yet written. */
  pendingRows: Record<string, unknown>[];
  /** The reader this pass re-reads an expired snapshot through. */
  reader?: () => LaneMemoryReading;
  /** The owner's sink, once it flushed: a segment re-pinned after that writes its own row through it. */
  log?: SharedRowLog;
  /** The current segment was re-pinned after the owner flushed (a late refill): it is written on its own. */
  late: boolean;
}

/** W1-T14903 — pin this pass's snapshot: the fresh shared one, re-read when expired. */
export function openSharedHostMemoryPass(nowMs: number, reader = sharedHostMemoryReader): SharedHostMemoryPass {
  return {
    snapshot: refreshSharedHostMemory(nowMs, reader), pinnedAtMs: nowMs, heldPrs: new Set(), written: false, pendingRows: [],
    ...(reader === undefined ? {} : { reader }), late: false,
  };
}

/**
 * W1-T14903 — the pass's pinned snapshot at `nowMs`. Within the stale bound it is the snapshot the pass started on.
 * Past it (a refill freed late in the pass's chain) the pass re-pins: the current shared snapshot, re-read through the
 * build lane's reader when that one has expired as well, so the late width and re-review yield read the same fresh
 * reading the build lane does, never fall back to the review lane's own memory alone.
 */
export function pinnedSharedHostMemory(pass: SharedHostMemoryPass, nowMs: number): SharedHostMemory | undefined {
  const pinnedAt = pass.snapshot?.atMs ?? pass.pinnedAtMs;
  if (nowMs - pinnedAt <= SHARED_HOST_MEMORY_STALE_MS) return pass.snapshot;
  repinSharedHostMemoryPass(pass, nowMs);
  return pass.snapshot;
}

function sharedPassRow(pass: SharedHostMemoryPass): Record<string, unknown> | undefined {
  if (pass.snapshot === undefined) return undefined;
  const width = pass.width;
  const held = [...pass.heldPrs].sort((a, b) => a - b);
  return {
    ...hostMemorySharedPayload(pass.snapshot, {
      ownMib: width?.ownMib ?? null, readMib: width?.readMib ?? null, width: width?.width ?? null,
      ...(width === undefined ? {} : { ownWidth: width.ownWidth }),
      yielded: held.length > 0 ? "re-review" : width?.yieldedWidth === true ? "review-width" : "none",
      ...(held.length > 0 ? { withheld: held.length } : {}),
    }),
    ...(held.length > 0 ? { withheld_prs: held } : {}),
  };
}

function repinSharedHostMemoryPass(pass: SharedHostMemoryPass, nowMs: number): void {
  const row = sharedPassRow(pass);
  // The expiring segment keeps its own row: unwritten, or a late segment that changed since its last write.
  if (row !== undefined && (pass.writtenRow === undefined || (pass.late && JSON.stringify(row) !== pass.writtenRow))) {
    pass.pendingRows.push(row);
  }
  pass.snapshot = refreshSharedHostMemory(nowMs, pass.reader ?? sharedHostMemoryReader);
  pass.pinnedAtMs = nowMs;
  delete pass.width;
  pass.heldPrs.clear();
  pass.written = false;
  delete pass.writtenRow;
  pass.late = pass.log !== undefined;
  if (pass.log !== undefined) writePendingSharedRows(pass, pass.log);
}

function writePendingSharedRows(pass: SharedHostMemoryPass, log: SharedRowLog): void {
  for (const row of pass.pendingRows.splice(0)) log(HOST_MEMORY_SHARED_STEP, row);
}

function writeCurrentSharedRow(pass: SharedHostMemoryPass, log: SharedRowLog): void {
  const row = sharedPassRow(pass);
  if (row === undefined) return;
  const key = JSON.stringify(row);
  if (pass.writtenRow === key) return;
  pass.writtenRow = key;
  pass.written = true;
  log(HOST_MEMORY_SHARED_STEP, row);
}

/** W1-T14903 — the owner writes the pass's rows: each re-pinned segment's, then the current one's, once; a segment
 *  with no snapshot writes none. After this, a segment re-pinned by a late refill writes through the same sink. */
export function flushSharedHostMemoryPass(pass: SharedHostMemoryPass, log: SharedRowLog | undefined): void {
  if (log === undefined) return;
  pass.log ??= log;
  writePendingSharedRows(pass, log);
  if (!pass.written) writeCurrentSharedRow(pass, log);
}

/** W1-T14903 — a consumer that reads the pass after its owner flushed (a late refill's sweep) writes the segment it
 *  re-pinned, as its own pass; the owner's segment is never re-written. Before the owner flushed: nothing. */
export function flushLateSharedHostMemoryPass(pass: SharedHostMemoryPass): void {
  if (pass.log === undefined) return;
  writePendingSharedRows(pass, pass.log);
  if (pass.late) writeCurrentSharedRow(pass, pass.log);
}

/** W1-T14903 — the shared snapshot unless it is older than the stale bound at `nowMs`. A snapshot taken after `nowMs`
 *  (the dispatch loop re-read it after a pass captured its clock) is the newest reading there is, so it is read. */
export function sharedHostMemory(nowMs: number): SharedHostMemory | undefined {
  const snapshot = publishedSharedHostMemory;
  if (snapshot === null || nowMs - snapshot.atMs > SHARED_HOST_MEMORY_STALE_MS) return undefined;
  return snapshot;
}

/** W1-T14903 — the room one more build needs on the host arm, by {@link laneTarget}'s own rule: its typical peak plus
 *  the part of its tail the host base has not already reserved. */
export function sharedBuildNeedMib(snapshot: SharedHostMemory): number {
  return snapshot.perLaneTypicalMib + Math.max(0, snapshot.perLaneMib - snapshot.perLaneTypicalMib - snapshot.hostTailMib);
}

/** W1-T14903 — short: the build lane's host arm would admit no new build on this snapshot (laneTarget's `fit` rule). */
export function sharedHostMemoryShort(snapshot: SharedHostMemory | undefined): boolean {
  if (snapshot === undefined) return false;
  return snapshot.availableMib - snapshot.hostReserveMib < sharedBuildNeedMib(snapshot);
}

/**
 * W1-T14903 — a re-review of an already-judged head yields to a build unless the snapshot holds room for BOTH: one
 * more build by the build lane's own rule and the review's own memory reserve. Below the build's need nothing starts
 * and the re-review waits, so freed memory reaches the build first; between the two, the build fits and the re-review
 * still waits, so the build is admitted before it. No snapshot: nothing yields.
 */
export function reReviewYieldsToBuild(snapshot: SharedHostMemory | undefined, reviewNeedMib: number): boolean {
  if (snapshot === undefined) return false;
  const need = sharedBuildNeedMib(snapshot) + (Number.isFinite(reviewNeedMib) ? Math.max(0, reviewNeedMib) : 0);
  return snapshot.availableMib - snapshot.hostReserveMib < need;
}

/** W1-T14903 — the {@link HOST_MEMORY_SHARED_STEP} row: the snapshot, each lane's share and which lane yielded. */
export function hostMemorySharedPayload(snapshot: SharedHostMemory, review: {
  ownMib: number | null; readMib: number | null; width: number | null; ownWidth?: number;
  yielded: "review-width" | "re-review" | "none";
  withheld?: number;
}): Record<string, unknown> {
  return {
    snapshot_at: fixedClock(snapshot.atMs).iso(),
    available_mib: Math.round(snapshot.availableMib),
    ...(snapshot.measuredMib === undefined ? {} : { measured_mib: Math.round(snapshot.measuredMib) }),
    host_reserve_mib: Math.round(snapshot.hostReserveMib),
    build_need_mib: Math.round(sharedBuildNeedMib(snapshot)),
    review_own_mib: review.ownMib === null ? null : Math.round(review.ownMib),
    review_read_mib: review.readMib === null ? null : Math.round(review.readMib),
    review_width: review.width,
    ...(review.ownWidth === undefined ? {} : { review_own_width: review.ownWidth }),
    short: sharedHostMemoryShort(snapshot),
    yielded: review.yielded,
    ...(review.withheld === undefined ? {} : { withheld_re_reviews: review.withheld }),
  };
}

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

/** The real ports over a daemon state directory (`<root>/state`, the ledger's directory). `memory` overrides the
 *  reading's host ports (a test's fixture files); absent, the host itself is read. */
export function defaultLaneGovernorPorts(stateDir: string, memory: Partial<ShadowMemoryPorts> = {}): LaneGovernorPorts {
  const root = dirname(stateDir);
  const reread = (): LaneMemoryReading => readLaneMemory(root, memory);
  // W1-T14903: installed when the ports are BUILT, not on the first read(): a daemon booted under PAUSE never takes a
  // dispatch reading, yet its review passes must still re-read the shared snapshot and write their rows through it.
  setSharedHostMemoryReader(reread);
  return {
    mode: () => loadLaneGovernorMode(),
    // W1-T14903: every reading is also the shared snapshot review capacity cuts its width from.
    read: () => {
      const reading = reread();
      publishSharedHostMemory(reading, systemClock.now());
      return reading;
    },
    cpuCount: () => availableParallelism(),
    cpuUsageUsec: () => readCgroupCpuUsageUsec(),
  };
}
