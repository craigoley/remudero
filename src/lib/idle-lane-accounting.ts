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
  "pause",
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
}

export interface IdleLaneAccount {
  /** Start of the current summary window. */
  windowStartMs: number;
  /** The previous sample's timestamp; the next interval starts here. */
  lastAtMs: number | undefined;
  /** What the previous sample says held over the interval that follows it: a cause, or null when not idle. */
  holding: IdleLaneCause | null;
  /** Milliseconds charged to each cause in the current window. */
  idleMsByCause: Record<IdleLaneCause, number>;
}

export interface IdleLaneSummaryRow {
  window_start_ms: number;
  window_end_ms: number;
  idle_minutes: number;
  minutes_by_cause: Record<IdleLaneCause, number>;
  /** The cause holding the most minutes, or null when the window had no idle minute at all. */
  largest_cause: IdleLaneCause | null;
}

const MS_PER_MINUTE = 60_000;

function zeroed(): Record<IdleLaneCause, number> {
  return Object.fromEntries(IDLE_LANE_CAUSES.map((c) => [c, 0])) as Record<IdleLaneCause, number>;
}

export function newIdleLaneAccount(startMs: number): IdleLaneAccount {
  return { windowStartMs: startMs, lastAtMs: undefined, holding: null, idleMsByCause: zeroed() };
}

/**
 * The single cause a sample names, or null when the lane is not idle-with-work. A named cause wins; an
 * unnamed one becomes `selection_empty` only when selection actually ran and found nothing; every other
 * unexplained idle sample is `unknown`.
 */
export function idleLaneCauseOf(sample: IdleLaneSample): IdleLaneCause | null {
  if (sample.busyLanes > 0) return null;
  if (sample.dispatchable <= 0) return null;
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
  if (account.lastAtMs !== undefined && account.holding !== null && sample.atMs > account.lastAtMs) {
    idleMsByCause[account.holding] += sample.atMs - account.lastAtMs;
  }
  return {
    windowStartMs: account.windowStartMs,
    lastAtMs: account.lastAtMs === undefined ? sample.atMs : Math.max(account.lastAtMs, sample.atMs),
    holding: idleLaneCauseOf(sample),
    idleMsByCause,
  };
}

/** The row the daemon writes as `lane.idle_summary`: whole-window minutes per cause, largest cause named. */
export function summarizeIdleLaneAccount(account: IdleLaneAccount, endMs: number): IdleLaneSummaryRow {
  const minutes = zeroed();
  let total = 0;
  let largest: IdleLaneCause | null = null;
  for (const cause of IDLE_LANE_CAUSES) {
    const m = Math.round((account.idleMsByCause[cause] / MS_PER_MINUTE) * 100) / 100;
    minutes[cause] = m;
    total += m;
    if (m > 0 && (largest === null || m > minutes[largest])) largest = cause;
  }
  return {
    window_start_ms: account.windowStartMs,
    window_end_ms: endMs,
    idle_minutes: Math.round(total * 100) / 100,
    minutes_by_cause: minutes,
    largest_cause: largest,
  };
}

/** Start a fresh window at `atMs`, keeping the interval in progress so no minute is lost across the seam. */
export function rollIdleLaneWindow(account: IdleLaneAccount, atMs: number): IdleLaneAccount {
  return { windowStartMs: atMs, lastAtMs: account.lastAtMs, holding: account.holding, idleMsByCause: zeroed() };
}

/** One summary row per hour. */
export const IDLE_LANE_SUMMARY_WINDOW_MS = 60 * MS_PER_MINUTE;

/**
 * The cause a ledger step implies for the tick that wrote it, or undefined when the step says nothing about
 * why a lane is empty. The daemon observes its own log stream rather than threading a flag through every
 * decline, so a hold written by any layer (including one the daemon does not own) is still charged.
 */
export function idleLaneCauseForStep(step: string): IdleLaneCause | undefined {
  switch (step) {
    case "dispatch.wip_deferred":
    case "daemon.queue_governor":
      return "wip_limit";
    case "daemon.pause":
      return "pause";
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
