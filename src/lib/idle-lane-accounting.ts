/**
 * W1-T4837: account for every minute a build lane sat empty while a dispatchable task existed, by cause.
 *
 * MEASURED 2026-09-30 over 24 h: 734 of 1,440 minutes had zero task builds running while 225 tasks were
 * queued, and the visible holds (wip deferrals, pauses, value refusals) did not add up to it. Nothing said
 * why a lane was empty, so throughput work had no evidence to be chosen on.
 *
 * The unit is a SAMPLE: the daemon states, at a moment, how many lanes are building, how many tasks could be
 * dispatched, and (when it knows) why nothing was started. The interval since the previous sample is charged
 * to that previous sample's verdict — the state that held over the interval, not the state observed at its
 * end. Every idle minute lands in exactly ONE cause. `unknown` is a cause in its own right: a minute the
 * daemon cannot explain is reported as unexplained and never folded into a named cause, because folding it
 * would hide the very gap this accounting exists to expose.
 *
 * Pure and clock-free: the caller supplies timestamps, so the whole ledger is reproducible from its samples.
 */

/** Every reason an idle lane minute can be charged to. Exactly one per minute. */
export const IDLE_LANE_CAUSES = [
  "wip_limit",
  // `pause` is a PAUSE whose nature the step did not say (no detail). W1-T8235 names the natures it hid.
  "pause",
  "operator_pause",
  "recycle_drain",
  "freshness_drain",
  "phase_bound",
  "boot_gate",
  "governor",
  "restart",
  "value_refusal",
  "claim_race",
  "capacity_headroom",
  "selection_empty",
  "unknown",
] as const;

export type IdleLaneCause = (typeof IDLE_LANE_CAUSES)[number];

/** The state the daemon observed at one moment. */
export interface IdleLaneSample {
  /** Epoch milliseconds of the observation. */
  atMs: number;
  /** Task builds running at this moment. Anything above zero means the lane is not idle. */
  busyLanes: number;
  /** Tasks that could have been dispatched at this moment. Zero means an empty lane is simply an empty queue. */
  dispatchable: number;
  /** The named cause the daemon observed this tick, when it observed one. */
  cause?: IdleLaneCause;
  /** True when candidate selection ran this tick and returned nothing — the `selection_empty` cause. */
  selectionRan?: boolean;
  /**
   * W1-T8235: the lanes the daemon would fill right now. When given, the idle SLOTS are `capacity - busyLanes`, so
   * an empty lane beside a busy one is idle. Absent, the sample keeps its W1-T4837 meaning: any busy lane means
   * the fleet is not idle.
   */
  capacity?: number;
  /** W1-T8235: the hold behind a pause-type cause — reason, setter pid, session id and actor, as recorded. */
  hold?: IdleLaneHold;
}

/** W1-T8235: who set the hold that emptied a slot, as the PAUSE flag recorded it. Every field is optional. */
export interface IdleLaneHold {
  reason?: string;
  pid?: string | number;
  session_id?: string;
  actor?: string;
}

/** W1-T8235: the state one sample describes — what `lane.idle_changed` records on a transition. */
export interface IdleLaneState {
  /** The cause holding the empty slots, or null when no slot is idle-with-work. */
  cause: IdleLaneCause | null;
  idleSlots: number;
  capacity: number | null;
  dispatchable: number;
  hold: IdleLaneHold | null;
}

export const NOT_IDLE_LANE_STATE: IdleLaneState = { cause: null, idleSlots: 0, capacity: null, dispatchable: 0, hold: null };

export interface IdleLaneAccount {
  /** Start of the current summary window. */
  windowStartMs: number;
  /** The previous sample's timestamp; the next interval starts here. */
  lastAtMs: number | undefined;
  /** What the previous sample says held over the interval that follows it: a cause, or null when not idle. */
  holding: IdleLaneCause | null;
  /** Milliseconds charged to each cause in the current window: wall time with at least one idle slot. */
  idleMsByCause: Record<IdleLaneCause, number>;
  /** W1-T8235: idle slots that held over the interval after the previous sample (0 when `holding` is null). */
  holdingSlots: number;
  /** W1-T8235: slot-milliseconds per cause in the current window — wall time times the idle slots. */
  slotMsByCause: Record<IdleLaneCause, number>;
  /** W1-T8235: the state the previous sample described. */
  state: IdleLaneState;
  /** W1-T8235: the last hold seen for each cause in the current window. */
  holds: Partial<Record<IdleLaneCause, IdleLaneHold>>;
  /** W1-T8235: the largest capacity any sample in the current window reported. */
  capacity: number | null;
}

export interface IdleLaneSummaryRow {
  window_start_ms: number;
  window_end_ms: number;
  idle_minutes: number;
  minutes_by_cause: Record<IdleLaneCause, number>;
  /** The cause holding the most minutes, or null when the window had no idle minute at all. */
  largest_cause: IdleLaneCause | null;
  /** W1-T8235: the lanes the daemon would fill (the window's largest reported), or null when none was reported. */
  capacity: number | null;
  /** W1-T8235: idle lane-SLOT minutes per cause: a minute with two empty slots counts twice. */
  slot_minutes_by_cause: Record<IdleLaneCause, number>;
  /** W1-T8235: for each cause that carried a hold, the hold as recorded, so a detector can name it. */
  holds: Partial<Record<IdleLaneCause, IdleLaneHold>>;
}

const MS_PER_MINUTE = 60_000;

function zeroed(): Record<IdleLaneCause, number> {
  return Object.fromEntries(IDLE_LANE_CAUSES.map((c) => [c, 0])) as Record<IdleLaneCause, number>;
}

export function newIdleLaneAccount(startMs: number): IdleLaneAccount {
  return {
    windowStartMs: startMs, lastAtMs: undefined, holding: null, idleMsByCause: zeroed(), holdingSlots: 0,
    slotMsByCause: zeroed(), state: NOT_IDLE_LANE_STATE, holds: {}, capacity: null,
  };
}

/** Lanes empty right now: `capacity - busyLanes` when the sample states a capacity, else one slot iff nothing is busy. */
export function idleSlotsOf(sample: IdleLaneSample): number {
  if (sample.capacity === undefined) return sample.busyLanes > 0 ? 0 : 1;
  return Math.max(0, Math.floor(sample.capacity) - Math.max(0, sample.busyLanes));
}

/**
 * The single cause a sample names, or null when no lane is idle-with-work. A named cause wins; an
 * unnamed one becomes `selection_empty` only when selection actually ran and found nothing; every other
 * unexplained idle sample is `unknown`. A busy lane never hides an empty one (W1-T8235).
 */
export function idleLaneCauseOf(sample: IdleLaneSample): IdleLaneCause | null {
  if (idleSlotsOf(sample) <= 0) return null;
  if (sample.dispatchable <= 0) return null;
  if (sample.cause !== undefined) return sample.cause;
  return sample.selectionRan === true ? "selection_empty" : "unknown";
}

/** The state a sample describes: its cause, its idle slots and the hold behind it. */
export function idleLaneStateOf(sample: IdleLaneSample): IdleLaneState {
  const cause = idleLaneCauseOf(sample);
  return {
    cause,
    idleSlots: cause === null ? 0 : idleSlotsOf(sample),
    capacity: sample.capacity ?? null,
    dispatchable: sample.dispatchable,
    hold: cause === null ? null : sample.hold ?? null,
  };
}

/** W1-T8235: a transition is a change of the (cause, idle slots, hold) triple; capacity and queue depth alone are not one. */
export function idleLaneStateChanged(prev: IdleLaneState, next: IdleLaneState): boolean {
  return prev.cause !== next.cause || prev.idleSlots !== next.idleSlots ||
    JSON.stringify(prev.hold ?? null) !== JSON.stringify(next.hold ?? null);
}

/**
 * Fold one sample into the account: charge the interval since the previous sample to what held over it, then
 * remember this sample's verdict for the next interval. Returns a new account; the input is not mutated.
 * A sample stamped before the previous one charges nothing (a clock step must never mint negative minutes).
 */
export function accountIdleLaneMinutes(account: IdleLaneAccount, sample: IdleLaneSample): IdleLaneAccount {
  const idleMsByCause = { ...account.idleMsByCause };
  const slotMsByCause = { ...account.slotMsByCause };
  if (account.lastAtMs !== undefined && account.holding !== null && sample.atMs > account.lastAtMs) {
    const ms = sample.atMs - account.lastAtMs;
    idleMsByCause[account.holding] += ms;
    slotMsByCause[account.holding] += ms * Math.max(1, account.holdingSlots);
  }
  const state = idleLaneStateOf(sample);
  const holds = { ...account.holds };
  if (state.cause !== null && state.hold !== null) holds[state.cause] = state.hold;
  return {
    windowStartMs: account.windowStartMs,
    lastAtMs: account.lastAtMs === undefined ? sample.atMs : Math.max(account.lastAtMs, sample.atMs),
    holding: state.cause,
    holdingSlots: state.idleSlots,
    idleMsByCause,
    slotMsByCause,
    state,
    holds,
    capacity: sample.capacity === undefined ? account.capacity : Math.max(account.capacity ?? 0, sample.capacity),
  };
}

/** What the previous process last recorded as its lane state (its newest `lane.idle_changed` row). */
export interface IdleLaneLastRecord {
  atMs: number;
  idleSlots: number;
  capacity: number | null;
  dispatchable: number;
}

/**
 * W1-T8235: the newest `lane.idle_changed` row in the ledger lines, or undefined. The row's own `at_ms` places it;
 * a row without one falls back to its `ts`. A row that cannot be placed in time is skipped, never guessed at.
 */
export function lastIdleLaneRecord(lines: readonly string[]): IdleLaneLastRecord | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes("lane.idle_changed")) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; }
    catch (reason) { void reason; continue; } // a torn line is not a record
    if (row.step !== "lane.idle_changed") continue;
    const atMs = typeof row.at_ms === "number" ? row.at_ms : typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(atMs) || typeof row.idle_slots !== "number") continue;
    return {
      atMs,
      idleSlots: row.idle_slots,
      capacity: typeof row.capacity === "number" ? row.capacity : null,
      dispatchable: typeof row.dispatchable === "number" ? row.dispatchable : 0,
    };
  }
  return undefined;
}

/**
 * W1-T8235: charge the gap across a daemon restart. The previous process's last idle record holds until this
 * process's first sample, and that interval is `restart` at the slots the record left empty. A record that left
 * no slot idle charges nothing. Call it on a fresh account before its first sample.
 */
export function chargeRestartGap(account: IdleLaneAccount, last: IdleLaneLastRecord | undefined): IdleLaneAccount {
  if (last === undefined || last.idleSlots <= 0 || last.dispatchable <= 0) return account;
  return { ...account, lastAtMs: last.atMs, holding: "restart", holdingSlots: last.idleSlots };
}

/** The row the daemon writes as `lane.idle_summary`: whole-window minutes per cause, largest cause named. */
export function summarizeIdleLaneAccount(account: IdleLaneAccount, endMs: number): IdleLaneSummaryRow {
  const minutes = zeroed();
  const slotMinutes = zeroed();
  let total = 0;
  let largest: IdleLaneCause | null = null;
  for (const cause of IDLE_LANE_CAUSES) {
    const m = Math.round((account.idleMsByCause[cause] / MS_PER_MINUTE) * 100) / 100;
    minutes[cause] = m;
    slotMinutes[cause] = Math.round((account.slotMsByCause[cause] / MS_PER_MINUTE) * 100) / 100;
    total += m;
    if (m > 0 && (largest === null || m > minutes[largest])) largest = cause;
  }
  return {
    window_start_ms: account.windowStartMs,
    window_end_ms: endMs,
    idle_minutes: Math.round(total * 100) / 100,
    minutes_by_cause: minutes,
    largest_cause: largest,
    capacity: account.capacity,
    slot_minutes_by_cause: slotMinutes,
    holds: Object.fromEntries(
      IDLE_LANE_CAUSES.filter((c) => minutes[c] > 0 && account.holds[c] !== undefined).map((c) => [c, account.holds[c]]),
    ),
  };
}

/** Start a fresh window at `atMs`, keeping the interval in progress so no minute is lost across the seam. */
export function rollIdleLaneWindow(account: IdleLaneAccount, atMs: number): IdleLaneAccount {
  const open = account.holding === null ? undefined : account.holds[account.holding];
  return {
    windowStartMs: atMs, lastAtMs: account.lastAtMs, holding: account.holding, holdingSlots: account.holdingSlots,
    idleMsByCause: zeroed(), slotMsByCause: zeroed(), state: account.state,
    holds: account.holding !== null && open !== undefined ? { [account.holding]: open } : {},
    capacity: account.capacity,
  };
}

/** One summary row per hour. */
export const IDLE_LANE_SUMMARY_WINDOW_MS = 60 * MS_PER_MINUTE;

/**
 * The cause a ledger step implies for the tick that wrote it, or undefined when the step says nothing about
 * why a lane is empty. The daemon observes its own log stream rather than threading a flag through every
 * decline, so a hold written by any layer (including one the daemon does not own) is still charged.
 */
export function idleLaneCauseForStep(
  step: string,
  fields?: { state?: unknown; detail?: unknown; reason?: unknown },
): IdleLaneCause | undefined {
  switch (step) {
    case "dispatch.new_build_held":
      // A verified reservation is capacity set aside for a heavy run. An unreadable
      // reservation is UNKNOWN, not evidence of either capacity or an empty selection.
      return fields?.state === "held" ? "capacity_headroom" : "unknown";
    case "dispatch.wip_deferred":
    case "daemon.queue_governor":
      return "wip_limit";
    case "daemon.pause":
      return pauseCauseOf(fields?.detail);
    case "dispatch.lane_refill_held":
    case "dispatch.lane_parked":
      return idleLaneCauseForRefillReason(fields?.reason);
    case "daemon.boot_gate.deferred":
      return "boot_gate";
    case "dispatch.value.refused":
      return "value_refusal";
    case "daemon.admission_stood_down":
      return "claim_race";
    case "daemon.cost_governor":
      return "capacity_headroom";
    default:
      return /headroom/.test(step) ? "capacity_headroom" : undefined;
  }
}

/** A PAUSE detail naming the container recycle is the fleet's own drain; any other detail is an operator's hold; none is `pause`. */
function pauseCauseOf(detail: unknown): IdleLaneCause {
  if (typeof detail !== "string" || detail.length === 0) return "pause";
  if (/container recycle/.test(detail)) return "recycle_drain";
  return /supervised serve restoration/.test(detail) ? "restart" : "operator_pause";
}

/**
 * W1-T8235: the cause a `dispatch.lane_refill_held` / `dispatch.lane_parked` reason implies — the reason strings the
 * daemon already writes. A reason it does not know names nothing (undefined), so the tick's earlier hold stands.
 */
export function idleLaneCauseForRefillReason(reason: unknown): IdleLaneCause | undefined {
  if (typeof reason !== "string") return undefined;
  if (/^stale code/.test(reason)) return "freshness_drain";
  if (/^phase bound/.test(reason)) return "phase_bound";
  if (/container recycle/.test(reason)) return "recycle_drain";
  if (/supervised serve restoration/.test(reason)) return "restart";
  if (/^pause/.test(reason) || /fleet PAUSE hold/.test(reason)) return "operator_pause";
  if (/^no disjoint runnable task/.test(reason)) return "selection_empty";
  if (/^governor: queue/.test(reason) || /^lane budget/.test(reason)) return "wip_limit";
  if (/^governor: cost/.test(reason)) return "capacity_headroom";
  if (/^governor/.test(reason)) return "governor";
  return undefined;
}
