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
 *
 * W1-T8235: the unit is a LANE SLOT, not "zero builds". MEASURED 2026-10-10/11: the hourly rows added up to
 * about 33 idle minutes on a day that lost hundreds, because (a) one busy lane hid its empty siblings, (b) the
 * daemon sampled once per dispatching tick and then awaited its lanes, so a lane freed and held from refill
 * inside that wait was never seen, and (c) an operator pause and a recycle drain shared one `pause` cause.
 * A sample now carries the lane `capacity`, idle slots are `capacity - busyLanes` (bounded by dispatchable
 * work), and every slot-minute is charged to the hold that emptied it. The legacy `idle_minutes` /
 * `minutes_by_cause` figures keep their meaning (wall minutes with zero builds) for display.
 */

/** Every reason an idle lane minute can be charged to. Exactly one per minute. */
export const IDLE_LANE_CAUSES = [
  "wip_limit",
  "pause",
  "value_refusal",
  "claim_race",
  "capacity_headroom",
  "selection_empty",
  "unknown",
  // W1-T8235: the holds that were all `pause` / `unknown` before. `wip_limit` and `capacity_headroom` stay as the
  // governor kinds the display already sums; `governor` is any other governor refusal.
  "operator_pause",
  "recycle_drain",
  "freshness_drain",
  "phase_bound",
  "boot_gate",
  "governor",
  "restart",
] as const;

export type IdleLaneCause = (typeof IDLE_LANE_CAUSES)[number];

/** The PAUSE flag's own record of a hold, so a detector can name who emptied the lanes. Unrecorded fields are null. */
export interface IdleLaneHold {
  reason: string;
  pid: number | null;
  session_id: string | null;
  actor: string | null;
}

/** What the lanes looked like after a sample; the triple (cause, idle slots, hold) is what a transition row tracks. */
export interface IdleLaneState {
  cause: IdleLaneCause | null;
  idle_slots: number;
  capacity: number;
  dispatchable: number;
  in_flight: number;
  hold: IdleLaneHold | null;
}

/** The `lane.idle_changed` row payload. */
export type IdleLaneChangeRow = IdleLaneState;

/** The state observed at one moment. */
export interface IdleLaneSample {
  /** Epoch milliseconds of the observation. */
  atMs: number;
  /** Task builds running at this moment (implement lanes in flight, not a tick's admitted count). */
  busyLanes: number;
  /** Tasks that could fill an idle lane at this moment. Zero means an empty lane is simply an empty queue. */
  dispatchable: number;
  /** W1-T8235: lanes the daemon would fill right now. Absent, the sample is legacy: one slot, idle only at zero builds. */
  capacity?: number;
  /** W1-T8235: who holds the lanes empty, as recorded on the PAUSE flag. */
  hold?: IdleLaneHold;
  /** The named cause the daemon observed this tick, when it observed one. */
  cause?: IdleLaneCause;
  /** True when candidate selection ran this tick and returned nothing — the `selection_empty` cause. */
  selectionRan?: boolean;
}

export interface IdleLaneAccount {
  /** Start of the current summary window. */
  windowStartMs: number;
  /** The previous sample's timestamp; the next interval starts here. */
  lastAtMs: number | undefined;
  /** What the previous sample says held over the interval that follows it: a cause, or null when not idle. */
  holding: IdleLaneCause | null;
  /** Milliseconds charged to each cause in the current window (wall time with zero builds — the display figure). */
  idleMsByCause: Record<IdleLaneCause, number>;
  /** W1-T8235: idle slots the previous sample says held over the interval that follows it. */
  holdingSlots: number;
  /** W1-T8235: builds running at the previous sample; zero marks the interval as wall-idle for the display figure. */
  holdingBusy: number;
  /** W1-T8235: slot-milliseconds charged to each cause in the current window. */
  slotMsByCause: Record<IdleLaneCause, number>;
  /** W1-T8235: the latest recorded hold per cause. */
  holds: Partial<Record<IdleLaneCause, IdleLaneHold>>;
  /** W1-T8235: the state after the latest sample; null before any sample or when no slot was idle. */
  state: IdleLaneState | null;
  /** W1-T8235: the largest lane capacity seen in the window. */
  capacity: number;
}

export interface IdleLaneSummaryRow {
  window_start_ms: number;
  window_end_ms: number;
  idle_minutes: number;
  minutes_by_cause: Record<IdleLaneCause, number>;
  /** The cause holding the most minutes, or null when the window had no idle minute at all. */
  largest_cause: IdleLaneCause | null;
  /** W1-T8235: lanes the daemon would fill (0 when only legacy samples were seen). */
  capacity: number;
  /** W1-T8235: idle lane-slot minutes by cause. */
  slot_minutes_by_cause: Record<IdleLaneCause, number>;
  /** W1-T8235: for each cause that charged slot-minutes and has a recorded hold, who set it. */
  holds: Partial<Record<IdleLaneCause, IdleLaneHold>>;
}

const MS_PER_MINUTE = 60_000;

function zeroed(): Record<IdleLaneCause, number> {
  return Object.fromEntries(IDLE_LANE_CAUSES.map((c) => [c, 0])) as Record<IdleLaneCause, number>;
}

export function newIdleLaneAccount(startMs: number): IdleLaneAccount {
  return {
    windowStartMs: startMs,
    lastAtMs: undefined,
    holding: null,
    idleMsByCause: zeroed(),
    holdingSlots: 0,
    holdingBusy: 0,
    slotMsByCause: zeroed(),
    holds: {},
    state: null,
    capacity: 0,
  };
}

/**
 * Lane slots empty at a sample: the lanes the daemon would fill (`capacity`) less those building, bounded by the
 * work that could fill them. A busy lane never hides an empty one. A legacy sample (no capacity) is one slot,
 * idle only at zero builds.
 */
export function idleSlotsOf(sample: IdleLaneSample): number {
  if (sample.dispatchable <= 0) return 0;
  const busy = Math.max(0, sample.busyLanes);
  if (sample.capacity === undefined) return busy > 0 ? 0 : 1;
  return Math.max(0, Math.min(sample.capacity - busy, sample.dispatchable));
}

/**
 * The single cause a sample names, or null when no lane slot is idle-with-work. A named cause wins; an
 * unnamed one becomes `selection_empty` only when selection actually ran and found nothing; every other
 * unexplained idle sample is `unknown`.
 */
export function idleLaneCauseOf(sample: IdleLaneSample): IdleLaneCause | null {
  if (idleSlotsOf(sample) <= 0) return null;
  if (sample.cause !== undefined) return sample.cause;
  return sample.selectionRan === true ? "selection_empty" : "unknown";
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
    const dt = sample.atMs - account.lastAtMs;
    slotMsByCause[account.holding] += dt * account.holdingSlots;
    if (account.holdingBusy === 0) idleMsByCause[account.holding] += dt;
  }
  const cause = idleLaneCauseOf(sample);
  const holds = { ...account.holds };
  if (cause !== null && sample.hold !== undefined) holds[cause] = sample.hold;
  return {
    windowStartMs: account.windowStartMs,
    lastAtMs: account.lastAtMs === undefined ? sample.atMs : Math.max(account.lastAtMs, sample.atMs),
    holding: cause,
    idleMsByCause,
    holdingSlots: idleSlotsOf(sample),
    holdingBusy: Math.max(0, sample.busyLanes),
    slotMsByCause,
    holds,
    state: cause === null ? null : {
      cause,
      idle_slots: idleSlotsOf(sample),
      capacity: sample.capacity ?? 1,
      dispatchable: sample.dispatchable,
      in_flight: Math.max(0, sample.busyLanes),
      hold: sample.hold ?? null,
    },
    capacity: Math.max(account.capacity, sample.capacity ?? 0),
  };
}

/**
 * The `lane.idle_changed` row a sample earns, or null. Written when the (cause, idle slots, hold) triple changes
 * and never otherwise, so a detector can measure any window exactly without hourly granularity.
 */
export function idleLaneChange(before: IdleLaneAccount, after: IdleLaneAccount): IdleLaneChangeRow | null {
  const key = (st: IdleLaneState | null): string => (st === null ? "" : JSON.stringify([st.cause, st.idle_slots, st.hold]));
  if (key(before.state) === key(after.state)) return null;
  return after.state ?? { cause: null, idle_slots: 0, capacity: after.capacity, dispatchable: 0, in_flight: 0, hold: null };
}

/**
 * RESTART IS CHARGED. Between the previous process's last sign of life and this boot no daemon existed to
 * sample anything; that gap is charged to `restart` at the previous sample's busy count. The interval from
 * boot to the first sample keeps charging the same slots, to `restart` (or `boot_gate` while the gate is up).
 */
export function chargeRestartGap(
  account: IdleLaneAccount,
  prev: { atMs: number; inFlight: number; capacity: number; dispatchable: number },
  bootMs: number,
  gateUp: boolean,
): IdleLaneAccount {
  const slots = idleSlotsOf({ atMs: prev.atMs, busyLanes: prev.inFlight, dispatchable: prev.dispatchable, capacity: prev.capacity });
  const slotMsByCause = { ...account.slotMsByCause };
  if (slots > 0 && bootMs > prev.atMs) slotMsByCause.restart += (bootMs - prev.atMs) * slots;
  return {
    ...account,
    lastAtMs: bootMs,
    holding: slots > 0 ? (gateUp ? "boot_gate" : "restart") : null,
    holdingSlots: slots,
    holdingBusy: 0,
    slotMsByCause,
    capacity: Math.max(account.capacity, prev.capacity),
  };
}

/** The row the daemon writes as `lane.idle_summary`: whole-window minutes per cause, largest cause named. */
export function summarizeIdleLaneAccount(account: IdleLaneAccount, endMs: number): IdleLaneSummaryRow {
  const minutes = zeroed();
  const slotMinutes = zeroed();
  const holds: Partial<Record<IdleLaneCause, IdleLaneHold>> = {};
  let total = 0;
  let largest: IdleLaneCause | null = null;
  for (const cause of IDLE_LANE_CAUSES) {
    const m = Math.round((account.idleMsByCause[cause] / MS_PER_MINUTE) * 100) / 100;
    minutes[cause] = m;
    slotMinutes[cause] = Math.round((account.slotMsByCause[cause] / MS_PER_MINUTE) * 100) / 100;
    const hold = account.holds[cause];
    if (slotMinutes[cause] > 0 && hold !== undefined) holds[cause] = hold;
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
    holds,
  };
}

/** Start a fresh window at `atMs`, keeping the interval in progress so no minute is lost across the seam. */
export function rollIdleLaneWindow(account: IdleLaneAccount, atMs: number): IdleLaneAccount {
  return { ...account, windowStartMs: atMs, idleMsByCause: zeroed(), slotMsByCause: zeroed(), holds: {} };
}

/** One summary row per hour. */
export const IDLE_LANE_SUMMARY_WINDOW_MS = 60 * MS_PER_MINUTE;

/**
 * Which hold a PAUSE detail (or a refill-held `fleet PAUSE hold: …` reason) names. A recycle's own PAUSE is a
 * drain; the supervised serve restoration is the fleet restarting itself; any other reason is an operator's.
 */
export function idleLaneCauseForPauseDetail(detail: string): IdleLaneCause {
  if (/container recycle/i.test(detail)) return "recycle_drain";
  if (/supervised serve restoration/i.test(detail)) return "restart";
  return "operator_pause";
}

/** The cause a `dispatch.lane_refill_held` reason names, or undefined when it names none the account knows. */
export function idleLaneCauseForRefillReason(reason: string): IdleLaneCause | undefined {
  if (/^stale code/.test(reason)) return "freshness_drain";
  if (/^phase bound/.test(reason)) return "phase_bound";
  const pause = /^fleet PAUSE hold: ([\s\S]*)$/.exec(reason) ?? /^pause: ([\s\S]*)$/.exec(reason);
  if (pause) return idleLaneCauseForPauseDetail(pause[1]!);
  if (/^pause\b/.test(reason)) return "pause";
  if (/^governor: queue/.test(reason)) return "wip_limit";
  if (/^governor: cost/.test(reason)) return "capacity_headroom";
  if (/^governor:/.test(reason)) return "governor";
  if (/^no disjoint runnable task/.test(reason)) return "selection_empty";
  return undefined;
}

/**
 * The cause a ledger step implies for the tick that wrote it, or undefined when the step says nothing about
 * why a lane is empty. The daemon observes its own log stream rather than threading a flag through every
 * decline, so a hold written by any layer (including one the daemon does not own) is still charged.
 * `fields` lets the step's own text (a PAUSE detail, a refill-held reason) pick the specific hold.
 */
export function idleLaneCauseForStep(step: string, fields?: Record<string, unknown>): IdleLaneCause | undefined {
  const text = (k: string): string | undefined => (typeof fields?.[k] === "string" ? (fields[k] as string) : undefined);
  switch (step) {
    case "dispatch.wip_deferred":
    case "daemon.queue_governor":
      return "wip_limit";
    case "daemon.pause": {
      const detail = text("detail");
      return detail === undefined ? "pause" : idleLaneCauseForPauseDetail(detail);
    }
    case "daemon.admission_held":
    case "dispatch.lane_refill_held": {
      const reason = text("reason");
      return reason === undefined ? undefined : idleLaneCauseForRefillReason(reason);
    }
    case "dispatch.lane_parked":
      return "phase_bound";
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
