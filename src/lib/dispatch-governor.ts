/**
 * lib/dispatch-governor.ts — W1-T342's PER-DISPATCH GOVERNOR GATE, in the one home both callers can
 * reach.
 *
 * WHY ITS OWN MODULE. `runDaemon` (daemon.ts) and `runDrainLanes` (drain.ts) must call the SAME
 * predicate — this function's own doc says so in as many words: "W1-T343's loop must call THIS
 * function again per lane it admits, never hoist a single call above the loop." Two copies of one
 * rule is a defect this repo has paid for twice, so a second implementation in drain.ts was never an
 * option. Neither of the two obvious homes works:
 *
 *   - daemon.ts (where it was born): daemon.ts already imports `nextRunnable` FROM drain.ts, so
 *     drain.ts importing back would close an import CYCLE.
 *   - sweep.ts (where `CostGovernorResult`/`QueueGovernorResult` live): it runs
 *     `loadDefaultPolicy()` — a `readFileSync` — at MODULE LOAD, and daemon.ts's header states it
 *     "never touches the filesystem" and holds sweep.js at `import type` only for exactly that
 *     reason. A value import would have quietly broken that purity.
 *
 * So: a new module with TYPE-ONLY dependencies, no filesystem, no cycle, imported as a value by both.
 *
 * THE GOVERNOR RESULT TYPES stay in sweep.ts and are imported here type-only — this module owns the
 * DECISION, never the shapes.
 */
import { fixedClock, type Clock } from "./clock.js";
import type { CostGovernorResult, MemoryGovernorResult, QueueGovernorResult } from "./sweep.js";
import type { HeavyBuildHold } from "./heavy-build-reservation.js";
import type { Task } from "./plan.js";

export type NewBuildReservationVerdict =
  | { kind: "held"; hold: HeavyBuildHold; reason: string }
  | { kind: "unavailable"; reason: string };

/** Pure decision over an injected, fresh reading. UNKNOWN holds only NEW implement admissions. */
export function checkNewBuildReservation(
  deps: Pick<DispatchGovernorDeps, "checkHeavyNewBuild">,
  task: Pick<Task, "type">,
): NewBuildReservationVerdict | undefined {
  if (task.type !== "implement") return undefined;
  try {
    const hold = deps.checkHeavyNewBuild?.();
    return hold ? { kind: "held", hold, reason: hold.detail } : undefined;
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The actual start decision's evidence, shared by both consumers; never a cached tick verdict. */
export function newBuildReservationPayload(verdict: NewBuildReservationVerdict): Record<string, unknown> {
  return {
    scope: "NEW-implement-only",
    source: "heavy_ready",
    state: verdict.kind,
    reason: verdict.reason,
    ...(verdict.kind === "held" ? {
      request_id: verdict.hold.requestId,
      ready_at_ms: verdict.hold.readyAtMs,
      expires_at_ms: verdict.hold.expiresAtMs,
    } : {}),
  };
}

/** An epoch-ms instant as ISO-8601, via the Clock port (clock.ts, pure) rather than a bare Date site. */
const isoAt = (ms: number): string => fixedClock(ms).iso();



/**
 * W1-T342 — THE PER-DISPATCH GOVERNOR GATE (design (i)/(ii)/(iv)).
 *
 * `checkCostGovernor`/`checkQueueGovernor` used to be consulted exactly ONCE, at the top of the
 * tick, and that single reading silently stood in for every dispatch-shaped action the REST of
 * the tick could still take — the retro trigger, the idle branch's auto-triage rung, and (once
 * W1-T343 wires a per-lane loop over `nextRunnable`'s pick) every lane in a multi-lane batch. A
 * ceiling that trips BETWEEN two dispatches in that batch would never be seen: the second lane
 * spends against a reading taken before the first lane's own (still in-flight, not yet ledgered)
 * cost could possibly show up in it.
 *
 * THE FIX: every dispatch-shaped action gets its OWN, freshly-taken reading. `runDaemon` below
 * still calls this once at the top of the tick (gating retro/auto-triage/kicks/`nextRunnable`
 * exactly as the single call used to) AND calls it again immediately before the actual dispatch
 * (`runOne`) — see that second call site's own comment. At N=1 (today; W1-T343's lane loop is
 * explicitly out of THIS task's scope) nothing async runs between the two calls in a dispatching
 * tick, so the second call always agrees with the first — a provable no-op change in observable
 * behaviour until lanes exist. It becomes load-bearing the moment a batch can hold more than one
 * lane: W1-T343's loop must call THIS function again per lane it admits, never hoist a single
 * call above the loop the way the tick-top call alone would.
 *
 * FAIL-CLOSED ON AN UNREADABLE OBSERVATION (design (iv)): `deps.checkCostGovernor`/
 * `deps.checkQueueGovernor` are pure, non-throwing predicates in sweep.ts's OWN contract, but the
 * real wiring (`costGovernorGateFor`/`queueGovernorGateFor`, run-task.ts) reads a ledger file /
 * live PR count on every call — so a LATER dispatch in a batch can hit a transient read failure
 * the first dispatch didn't. Unlike every OTHER per-tick consultation in `runDaemon` (`reloadPlan`,
 * `reloadDailyCostCeilingUsd`, `sweep`, `checkAutoTriage`, `checkRetroTrigger` all already catch
 * and degrade), these two calls were previously bare: a throw propagated straight out of
 * `runDaemon` — a full-process crash, never a deferral. The safe answer to "the reading could not
 * be taken" is the SAME as a confirmed-over-ceiling reading — admit no further dispatch this
 * batch (`kind: "unreadable"`) — never a silent fall-through to "admitted" because the check
 * errored.
 *
 * `deps.checkMemoryGovernor` (W1-T1038) DOES NOT FOLLOW THAT RULE, DELIBERATELY. Cost and queue
 * failing closed is correct for THEIR OWN reasons (an unbounded spend, an unbounded queue, are
 * both genuinely worse than one held-back dispatch) — but three-lane dispatch has been 100% of
 * draws since 2026-08-14 (51 sets, admitted mean 3.00, one failure in six days), so a memory
 * probe failure that refused would convert a once-in-six-days event into a 100% outage every
 * time `/proc/meminfo` hiccups. So: a throw from `checkMemoryGovernor` never becomes
 * `{kind: "unreadable"}` (that arm's own `source` type is `"cost" | "queue"`; `"memory"` is not a
 * member, so routing it there would not even type-check). A TRANSIENT failure falls straight
 * through to the NEXT check, exactly as if the memory dep had returned `undefined` (admitted).
 * UNREADABLE PERMITS — FOR AS LONG AS IT IS TRANSIENT (W1-T7720): a failure that outlives the
 * sustained bound {@link createMemoryReadTracker} derives from this fleet's own recovery times
 * holds NEW dispatch (`memory_unreadable`) and escalates once per streak. THE READING COMES FROM `/proc/meminfo`, NEVER A CGROUP LIMIT —
 * see `checkMemoryGovernor`'s own doc (sweep.ts) for why a cgroup read would authorise every
 * dispatch silently on this fleet's unlimited containers.
 *
 * `deps.checkQuietHours` follows the memory arm's fail-open direction for the same "preference
 * flag, not safety ceiling" reason: a corrupt or unreadable quiet-hours marker must not silently
 * halt every future daemon dispatch. A confirmed hold defers only NEW dispatch; the daemon's sweep
 * path never consults this predicate.
 */
export function checkDispatchGovernors(
  deps: DispatchGovernorDeps,
  dailyCostCeilingUsd: number | undefined,
): DispatchGovernorVerdict | undefined {
  let costGoverned: CostGovernorResult | undefined;
  try {
    costGoverned = deps.checkCostGovernor?.(dailyCostCeilingUsd);
  } catch (e) {
    return { kind: "unreadable", source: "cost", error: e instanceof Error ? e.message : String(e) };
  }
  if (costGoverned) return { kind: "cost", result: costGoverned };

  let queueGoverned: QueueGovernorResult | undefined;
  try {
    queueGoverned = deps.checkQueueGovernor?.();
  } catch (e) {
    return { kind: "unreadable", source: "queue", error: e instanceof Error ? e.message : String(e) };
  }
  if (queueGoverned) return { kind: "queue", result: queueGoverned };

  // W1-T1038 — RE-CONSULTED EVERY CALL, exactly like cost/queue above: this function holds no
  // cache of its own, so a caller that invokes it once per lane (design (ii)) gets a fresh memory
  // reading per lane, never one reading admitting a whole batch.
  // W1-T7720: an UNREADABLE reading is tiered by how long it lasts — see {@link consultMemoryReads}.
  const memoryRead = consultMemoryReads(deps);
  if (memoryRead.governed) return { kind: "memory", result: memoryRead.governed };
  if (memoryRead.hold) return { kind: "memory_unreadable", hold: memoryRead.hold };

  let quietHours: QuietHoursHoldResult | undefined;
  try {
    quietHours = deps.checkQuietHours?.();
  } catch (_err) {
    // Deliberate fail-open: an unreadable preference marker is equivalent to absent.
    quietHours = undefined;
  }
  if (quietHours) return { kind: "quiet_hours", result: quietHours };

  return undefined;
}


// ── TYPE-ONLY DECLARATIONS, DELIBERATELY SANDWICHED BETWEEN THE TWO FUNCTIONS ────────────────
//
// NOT at the file head or tail, on purpose. `--experimental-test-coverage` stamps `DA:<line>,0`
// across a NEW file's leading AND trailing source-line records (a source-map preamble/epilogue
// artifact), so type declarations parked at either end read to diff-coverage as uncovered CODE and
// block the gate — measured on this exact file: DA:1,0 through DA:14,0 with every one of those lines
// being a comment, an import or an interface member. Bracketed by executed statements they get no
// such record. Same remedy `lib/open-prs-rest.ts` already applies to its own `GhApiFetcher`.

/**
 * What a caller must supply. `DaemonDeps.checkCostGovernor` takes an optional ceiling;
 * `DrainDeps.checkCostGovernor` takes none. A zero-parameter function IS assignable to a
 * one-optional-parameter type, so both satisfy this structurally and neither call site needs a shim.
 */
export interface DispatchGovernorDeps {
  /** NEW implement admission only; checkDispatchGovernors never consults this reservation. */
  checkHeavyNewBuild?: () => HeavyBuildHold | undefined;
  checkCostGovernor?: (dailyCostCeilingUsd?: number) => CostGovernorResult | undefined;
  checkQueueGovernor?: () => QueueGovernorResult | undefined;
  /** W1-T1038 — see this module's own FAIL-OPEN note (above `checkDispatchGovernors`) for why a
   *  throw from this one dep is handled differently from the two above it. */
  checkMemoryGovernor?: () => MemoryGovernorResult | undefined;
  /** W1-T7720 — the streak tracker both unreadable memory sources report to. Absent ⇒ today's
   *  untiered fail-open (a throw is discarded). */
  memoryReadTracker?: MemoryReadTracker;
  /** W1-T7720 — the host memory RESERVATION STORE read: the failure reason when the store cannot
   *  be read (never an empty reading), `undefined` when it can. Consulted only with a tracker. */
  readMemoryStoreFailure?: () => string | undefined;
  /** A dispatch-only quiet-hours hold. Throws fail open inside `checkDispatchGovernors`. */
  checkQuietHours?: () => QuietHoursHoldResult | undefined;
}

/** W1-T342: discriminates which governor (if either) is deferring THIS dispatch, and why. */
export type DispatchGovernorVerdict =
  | { kind: "cost"; result: CostGovernorResult }
  | { kind: "queue"; result: QueueGovernorResult }
  | { kind: "memory"; result: MemoryGovernorResult }
  | { kind: "quiet_hours"; result: QuietHoursHoldResult }
  | { kind: "memory_unreadable"; hold: MemoryReadHold }
  | { kind: "unreadable"; source: "cost" | "queue"; error: string };

export interface QuietHoursHoldResult {
  deferred: true;
  detail?: string;
}

/**
 * The ledger FIELDS a deferral verdict renders to — a pure projection of {@link
 * DispatchGovernorVerdict}, kept beside the type so a second caller cannot invent different names
 * for the same fact.
 *
 * The STEP name stays the caller's: `runDaemon` logs `daemon.cost_governor` and `runDrainLanes` logs
 * `dispatch.lane_governed`, because a per-tick deferral and a mid-batch lane refusal are genuinely
 * different events. Only the payload is shared. `runDaemon`'s own `logDispatchGovernorDefer` closure
 * already emits exactly these names and is deliberately left untouched — consolidating it is a
 * separate change, not this one's concern.
 */
export function governorDeferPayload(verdict: DispatchGovernorVerdict): Record<string, unknown> {
  if (verdict.kind === "cost") {
    return {
      observed_day_cost_usd: verdict.result.observedDayCostUsd,
      daily_cost_ceiling_usd: verdict.result.ceilingUsd,
    };
  }
  if (verdict.kind === "queue") {
    return { observed_open_count: verdict.result.observedOpenCount, wip_limit: verdict.result.wipLimit };
  }
  if (verdict.kind === "memory") {
    return { observed_available_mib: verdict.result.observedAvailableMib, memory_floor_mib: verdict.result.floorMib };
  }
  if (verdict.kind === "memory_unreadable") {
    return {
      source: verdict.hold.source,
      error: verdict.hold.error,
      streak_started_at: isoAt(verdict.hold.streakStartedAtMs),
      streak_age_ms: verdict.hold.ageMs,
      sustained_bound_ms: verdict.hold.boundMs,
      sustained_bound_basis: verdict.hold.basis,
      note: "memory reading unreadable past the sustained bound — new dispatch held",
    };
  }
  if (verdict.kind === "quiet_hours") {
    return {
      quiet_hours: true,
      ...(verdict.result.detail ? { detail: verdict.result.detail } : {}),
    };
  }
  return {
    source: verdict.source,
    error: verdict.error,
    note: "governor observation unreadable — failing closed, admitting no further lane this batch",
  };
}

// ── W1-T7720: AN UNREADABLE MEMORY READING IS TIERED BY HOW LONG IT LASTS ─────────────────────
//
// Two sources can fail to read: the host memory PROBE (`checkMemoryGovernor`, /proc/meminfo) and the
// host memory RESERVATION STORE (`readMemoryLedger`). Either way the answer depends on how long the
// failure lasts: a TRANSIENT one keeps dispatching and leaves a ledger row; a SUSTAINED one holds NEW
// dispatch and raises ONE escalation per streak. The line between them is DERIVED, never a cap.

/** Which unreadable reading a streak belongs to. */
export type MemoryReadSource = "probe" | "store";

/** A sustained streak: what holds dispatch, for how long, against which bound, and why that bound. */
export interface MemoryReadHold {
  source: MemoryReadSource;
  error: string;
  streakStartedAtMs: number;
  ageMs: number;
  boundMs: number;
  /** `history n=<k>` or `fallback: tick cadence` — where {@link MemoryReadHold.boundMs} came from. */
  basis: string;
}

/**
 * Where a tracker's OUTPUT goes (rows, the escalation, sink failures) and where its recovery HISTORY
 * comes from. Time is NOT here: the tracker reads it through the shared {@link Clock} port, its own
 * first parameter, so a test freezes it with the same fake clock every other module takes.
 */
export interface MemoryReadSinks {
  /** Durations (ms) of this source's past recovered streaks — the `memory_read.recovered` ledger rows. */
  recoveredDurationsMs: (source: MemoryReadSource) => readonly number[];
  /** Appends a `memory_read.*` ledger row. */
  writeRow: (step: string, fields: Record<string, unknown>) => void;
  /** Raises the one escalation of a sustained streak. */
  escalate: (hold: MemoryReadHold) => void;
  /** Told when a sink (ledger, history, escalation) failed — the governor itself never throws. */
  onSinkError?: (label: string, error: unknown) => void;
}

export interface MemoryReadTracker {
  /** Note one consultation (once per consult, so the gaps between calls are the tick cadence). */
  observe(): void;
  /** A good read: clears the source's streak, writing `memory_read.recovered` if one was open. */
  readable(source: MemoryReadSource): void;
  /** A failed read: opens/extends the streak. Returns a hold only once the streak is SUSTAINED. */
  unreadable(source: MemoryReadSource, error: string): MemoryReadHold | undefined;
}

/** Recovered streaks needed before a percentile of them is a usable estimate; fewer ⇒ fallback. */
export const MIN_RECOVERIES_FOR_PERCENTILE = 3;
/** The percentile of past recovery durations the bound is anchored to. */
export const RECOVERY_PERCENTILE = 0.9;
/** Margin over that percentile: a streak must outlast what has recovered before, with room to spare. */
export const RECOVERY_MARGIN = 1.5;
/** Fallback with too little history: this many observed tick intervals. */
export const FALLBACK_TICK_MULTIPLE = 3;
/** Bound on remembered consultation instants. */
const OBSERVATION_WINDOW = 64;

function nearestRank(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/**
 * The tick cadence, observed from the gaps between consultations. A tick consults once at its top and
 * once per lane, so the gaps cluster near zero (per-lane) and at the tick interval (between ticks):
 * the UPPER quartile of the positive gaps is the between-tick gap. `undefined` before two gaps exist.
 */
export function observedTickCadenceMs(instantsMs: readonly number[]): number | undefined {
  const gaps: number[] = [];
  for (let i = 1; i < instantsMs.length; i++) {
    const gap = instantsMs[i]! - instantsMs[i - 1]!;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length < 2) return undefined;
  gaps.sort((a, b) => a - b);
  return nearestRank(gaps, 0.75);
}

/**
 * THE SUSTAINED BOUND, derived. With enough recovered streaks it is a high percentile of their
 * durations times a margin (floored at one tick, since a streak is only judged once per tick); with too
 * little history it is a small multiple of the observed tick cadence. `boundMs` is `undefined` when
 * neither exists yet — nothing is sustained until the fleet has been observed.
 */
export function deriveSustainedBound(
  recoveredMs: readonly number[],
  tickCadenceMs: number | undefined,
): { boundMs: number | undefined; basis: string } {
  if (recoveredMs.length >= MIN_RECOVERIES_FOR_PERCENTILE) {
    const sorted = [...recoveredMs].sort((a, b) => a - b);
    const anchored = nearestRank(sorted, RECOVERY_PERCENTILE) * RECOVERY_MARGIN;
    return { boundMs: Math.max(anchored, tickCadenceMs ?? 0), basis: `history n=${recoveredMs.length}` };
  }
  return {
    boundMs: tickCadenceMs === undefined ? undefined : tickCadenceMs * FALLBACK_TICK_MULTIPLE,
    basis: "fallback: tick cadence",
  };
}

interface OpenStreak {
  startedAtMs: number;
  escalated: boolean;
}

/** One tracker per process and call site; both sources share it, each with its own streak. */
export function createMemoryReadTracker(clock: Clock, sinks: MemoryReadSinks): MemoryReadTracker {
  const streaks = new Map<MemoryReadSource, OpenStreak>();
  const instants: number[] = [];
  const sink = <T>(label: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      // The governor must never throw out of a dispatch decision because a ledger, history or
      // escalation sink failed; the failure is handed to onSinkError rather than erased.
      sinks.onSinkError?.(label, e);
      return undefined;
    }
  };
  return {
    observe() {
      const at = clock.now();
      if (instants[instants.length - 1] === at) return;
      instants.push(at);
      if (instants.length > OBSERVATION_WINDOW) instants.shift();
    },
    readable(source) {
      const open = streaks.get(source);
      if (!open) return;
      streaks.delete(source);
      const durationMs = Math.max(0, clock.now() - open.startedAtMs);
      sink("row", () =>
        sinks.writeRow("memory_read.recovered", {
          source,
          duration_ms: durationMs,
          streak_started_at: isoAt(open.startedAtMs),
          held: open.escalated,
        }),
      );
    },
    unreadable(source, error) {
      const nowMs = clock.now();
      let open = streaks.get(source);
      if (!open) {
        const started: OpenStreak = { startedAtMs: nowMs, escalated: false };
        open = started;
        streaks.set(source, started);
        sink("row", () =>
          sinks.writeRow("memory_read.unreadable", {
            source,
            error,
            streak_started_at: isoAt(started.startedAtMs),
          }),
        );
      }
      const history = sink("history", () => sinks.recoveredDurationsMs(source)) ?? [];
      const { boundMs, basis } = deriveSustainedBound(history, observedTickCadenceMs(instants));
      const ageMs = nowMs - open.startedAtMs;
      if (boundMs === undefined || !(ageMs > boundMs)) return undefined;
      const hold: MemoryReadHold = { source, error, streakStartedAtMs: open.startedAtMs, ageMs, boundMs, basis };
      if (!open.escalated) {
        // Marked BEFORE the call, so a delivery failure never re-fires on the next tick: one per streak.
        open.escalated = true;
        const delivered =
          sink("escalate", () => {
            sinks.escalate(hold);
            return true;
          }) === true;
        sink("row", () =>
          sinks.writeRow("memory_read.sustained", {
            source,
            error,
            streak_started_at: isoAt(hold.streakStartedAtMs),
            streak_age_ms: ageMs,
            sustained_bound_ms: boundMs,
            sustained_bound_basis: basis,
            escalated: delivered,
          }),
        );
      }
      return hold;
    },
  };
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * THE ONE MEMORY CONSULTATION both the daemon (`checkDispatchGovernors`) and the drain's pass-level
 * block make: the probe, then the reservation store, each reported to `deps.memoryReadTracker`.
 * `governed` is a confirmed floor deferral; `hold` is a SUSTAINED unreadable streak; a transient
 * failure yields neither (fail open) and only `probeError` for a caller that logs it.
 */
export function consultMemoryReads(deps: DispatchGovernorDeps): {
  governed?: MemoryGovernorResult;
  hold?: MemoryReadHold;
  probeError?: string;
} {
  const tracker = deps.memoryReadTracker;
  tracker?.observe();
  const out: { governed?: MemoryGovernorResult; hold?: MemoryReadHold; probeError?: string } = {};
  try {
    out.governed = deps.checkMemoryGovernor?.();
    if (deps.checkMemoryGovernor) tracker?.readable("probe");
  } catch (e) {
    // FAIL OPEN while transient (W1-T1038 design (ii)): the error is carried in `probeError` and,
    // with a tracker, ledgered as a streak; never `{kind: "unreadable"}` (the fail-CLOSED arm).
    out.probeError = errorMessage(e);
    out.hold = tracker?.unreadable("probe", out.probeError);
  }
  if (tracker && deps.readMemoryStoreFailure) {
    let failure: string | undefined;
    try {
      failure = deps.readMemoryStoreFailure();
    } catch (e) {
      // A throwing store read IS a failure, not an absence: its message becomes the streak's error.
      failure = errorMessage(e);
    }
    if (failure === undefined) tracker.readable("store");
    else {
      const storeHold = tracker.unreadable("store", failure);
      out.hold ??= storeHold;
    }
  }
  return out;
}
