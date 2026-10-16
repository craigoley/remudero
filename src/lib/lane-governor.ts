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
import { availableParallelism } from "node:os";
import { dirname } from "node:path";

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
  bounds.push([Math.floor(inputs.cpuCount), "cpu"]);
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
    highEventsUnread = error instanceof Error ? error.message : String(error);
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
}

/** The real ports over a daemon state directory (`<root>/state`, the ledger's directory). */
export function defaultLaneGovernorPorts(stateDir: string): LaneGovernorPorts {
  const root = dirname(stateDir);
  return { mode: () => loadLaneGovernorMode(), read: () => readLaneMemory(root), cpuCount: () => availableParallelism() };
}
