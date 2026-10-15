/**
 * lib/lane-governor.ts — W1-T9097: THE BUILD LANE COUNT AS THE MEMORY GOVERNOR'S OUTPUT (ADR 0007, decision C).
 *
 * `sweep.dispatchLanes` is a fixed 3 (max 4) that only a plan PR and a restart can change, while ADR 0007 makes each
 * lane cost a whole Node process more. MEASURED (core daemon.alive, 2026-10-11 22:56Z to 10-13 11:45Z, 1,955 rows):
 * container memory.current p50 5,155 MiB, p90 6,569, max 8,379 against memory.high 8,379. This module answers "how
 * many build lanes fit now?" from the same projection the shadow budget (host-memory-shadow.ts) already makes.
 *
 * {@link laneTarget} is PURE: the largest n >= 1 whose projection stays under every readable arm's onset, where a
 * projection is the arm's base (everything already in flight: the daemon's growth, every live tree's learned tail)
 * plus n run trees at the learned class tail of the next build.
 *   - It shrinks AT ONCE: a lower fit is taken this tick, and a pressed container (its own pressure now, or a crossing
 *     of memory.high since the previous tick) drops at least one lane below the previous target.
 *   - It grows by AT MOST ONE lane per tick, and only on a tick with no pressure flag since the previous one. The first
 *     tick has no previous one, so it starts from the fixed count and never grows on it.
 *   - Its upper bound is the adaptive WIP bound and the CPU-derived count. No fixed lane number bounds it.
 *   - Every arm unread: nothing can be shown to fit, so it holds the previous target (the fixed count at boot).
 *
 * The daemon reads it once per dispatch tick and ledgers {@link LANE_TARGET_STEP}. In `shadow` that row is all it
 * does. In `enforce` the target sizes new-lane admission only: a running lane is never stopped by a lower target.
 */

/** The ledger step a dispatch tick writes for each target it computes. */
export const LANE_TARGET_STEP = "dispatch.lane_target";

export const LANE_GOVERNOR_MODES = ["shadow", "enforce"] as const;
export type LaneGovernorMode = (typeof LANE_GOVERNOR_MODES)[number];

/** One memory arm, in MiB: the projection is `baseMib + n * perLaneMib`, judged against `onsetMib`. */
export interface LaneArm {
  arm: "container" | "host";
  baseMib: number;
  /** The learned class tail of one more run tree (a run child plus its worker plus its tests). */
  perLaneMib: number;
  onsetMib: number;
}

/** What the composition root reads each tick. An arm it could not read is named in `unreadArms`, never zeroed. */
export interface LaneGovernorReading {
  arms: LaneArm[];
  unreadArms?: string[];
  /** The container's own pressure now (`containerPressed`/`containerSighted`), and its memory.events `high`
   *  crossings since the previous tick (null: unmeasured). */
  pressure: { pressed: boolean; crossingsSincePrevious: number | null };
  /** The CPU-derived lane count (os.availableParallelism()). */
  cpuLanes: number;
}

export interface LaneTargetInputs {
  reading: LaneGovernorReading | { unread: string };
  /** The previous tick's target; absent on the first tick. */
  previousTarget?: number;
  /** `sweep.dispatchLanes`: the boot-time seed and the ledgered comparison, never a bound. */
  fixedLanes: number;
  /** The adaptive WIP bound (the queue governor's admitted `wipLimit`); absent: unbounded by WIP. */
  wipBound?: number;
  /** A refill's re-read: it may shrink the target, never grow it (growth is one lane per tick). */
  holdGrowth?: boolean;
}

export type LaneTargetBinding =
  | "container" | "host" | "wip" | "cpu" | "pressure" | "growth-step" | "held" | "unread";

export interface LaneTargetDecision {
  target: number;
  fixed: number;
  binding: LaneTargetBinding;
  /** The tightest arm's projection at `target` lanes, and its onset; null when no arm was read. */
  projectionMib: number | null;
  onsetMib: number | null;
  pressed: boolean;
  previous: number | null;
  unread: string[];
}

const positive = (n: number | undefined): number | undefined =>
  n === undefined || !Number.isFinite(n) ? undefined : Math.max(1, Math.floor(n));

/** The largest n >= 1 an arm fits: unbounded when one more tree costs nothing. */
function armFit(arm: LaneArm): number {
  if (!(arm.perLaneMib > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor((arm.onsetMib - arm.baseMib) / arm.perLaneMib));
}

/** Decide this tick's build lane target. Pure: no clock, no fs. */
export function laneTarget(inputs: LaneTargetInputs): LaneTargetDecision {
  const fixed = positive(inputs.fixedLanes) ?? 1;
  const previous = positive(inputs.previousTarget);
  const start = previous ?? fixed;
  const reading = inputs.reading;
  if ("unread" in reading) {
    return { target: start, fixed, binding: "unread", projectionMib: null, onsetMib: null, pressed: false,
      previous: previous ?? null, unread: [reading.unread] };
  }
  const unread = [...(reading.unreadArms ?? [])];
  const pressed = reading.pressure.pressed || (reading.pressure.crossingsSincePrevious ?? 0) > 0;
  // The ceiling and what sets it: each readable arm's fit, then the WIP bound, then the CPU count.
  let ceiling = Number.POSITIVE_INFINITY;
  let ceilingBinding: LaneTargetBinding = "held";
  let tightest: LaneArm | undefined;
  for (const arm of reading.arms) {
    const fit = armFit(arm);
    if (tightest === undefined || fit < armFit(tightest)) tightest = arm;
    if (fit < ceiling) { ceiling = fit; ceilingBinding = arm.arm; }
  }
  const memoryRead = reading.arms.length > 0;
  for (const [bound, name] of [[positive(inputs.wipBound), "wip"], [positive(reading.cpuLanes), "cpu"]] as const) {
    if (bound !== undefined && bound < ceiling) { ceiling = bound; ceilingBinding = name; }
  }
  let target: number;
  let binding: LaneTargetBinding;
  if (pressed) {
    // A pressed container is a measurement, not a prediction: give up a lane now whatever the projection reads.
    const relief = Math.max(1, start - 1);
    target = Math.min(relief, ceiling);
    binding = ceiling < relief ? ceilingBinding : "pressure";
  } else if (ceiling < start) {
    target = ceiling;
    binding = ceilingBinding;
  } else if (!memoryRead) {
    // Nothing shows another lane fits: hold, never grow blind.
    target = start;
    binding = "unread";
  } else if (previous !== undefined && ceiling > start && inputs.holdGrowth !== true) {
    target = start + 1;
    binding = "growth-step";
  } else {
    target = start;
    binding = ceiling === start ? ceilingBinding : "held";
  }
  return {
    target,
    fixed,
    binding,
    projectionMib: tightest ? tightest.baseMib + target * tightest.perLaneMib : null,
    onsetMib: tightest ? tightest.onsetMib : null,
    pressed,
    previous: previous ?? null,
    unread,
  };
}

/** Take the composition root's reading; a throw is carried as an unread reading naming it, never a fit. */
export function readLaneGovernor(read: () => LaneGovernorReading): LaneGovernorReading | { unread: string } {
  try {
    return read();
  } catch (error) {
    return { unread: `lane governor read failed: ${String((error as Error)?.message ?? error)}` };
  }
}

/** The `dispatch.lane_target` row: the target beside the fixed count it would replace. */
export function laneTargetRow(decision: LaneTargetDecision, mode: LaneGovernorMode): Record<string, unknown> {
  return {
    target: decision.target,
    fixed: decision.fixed,
    binding: decision.binding,
    projection_mib: decision.projectionMib,
    onset_mib: decision.onsetMib,
    pressed: decision.pressed,
    previous: decision.previous,
    mode,
    ...(decision.unread.length > 0 ? { unread: decision.unread } : {}),
  };
}

/** The shadow verdict's numbers this module reads (host-memory-shadow.ts `ShadowVerdict.numbers`). */
export interface ShadowLaneNumbers {
  containerProjectedMib: number | null;
  containerOnsetMib: number | null;
  memAvailableMib: number | null;
  projectedAvailableMib: number | null;
  hostReserveMib: number;
  containerPressed: boolean;
  containerSighted: boolean;
}

/**
 * The two arms from a shadow verdict evaluated for a start that claims NOTHING (estimate 0), so its projection is the
 * base: the container's working set plus every in-flight tree's claim plus the daemon's typical growth, judged against
 * the lift-gated onset (W1-T8472); and the host's committed claims against MemAvailable less its reserve.
 */
export function laneArmsFromShadow(
  numbers: ShadowLaneNumbers,
  perLaneMib: number,
): Pick<LaneGovernorReading, "arms" | "unreadArms"> & { pressed: boolean } {
  const arms: LaneArm[] = [];
  const unread: string[] = [];
  if (numbers.containerProjectedMib !== null && numbers.containerOnsetMib !== null) {
    arms.push({ arm: "container", baseMib: numbers.containerProjectedMib, perLaneMib, onsetMib: numbers.containerOnsetMib });
  } else unread.push("container: no projection or onset");
  if (numbers.memAvailableMib !== null && numbers.projectedAvailableMib !== null) {
    arms.push({ arm: "host", baseMib: numbers.memAvailableMib - numbers.projectedAvailableMib, perLaneMib,
      onsetMib: numbers.memAvailableMib - numbers.hostReserveMib });
  } else unread.push("host: MemAvailable unread");
  return { arms, unreadArms: unread, pressed: numbers.containerPressed || numbers.containerSighted };
}
