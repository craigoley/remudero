/**
 * lib/liveness-pulse.ts — E32: a busy daemon must not read "silent" while its event loop is free.
 *
 * Every liveness reader (`deriveLastPoll`: the now view, doctor, the panel, the status board) takes
 * the newest `daemon.`-prefixed row. The rows that keep that prefix fresh come from per-phase tickers
 * (`daemon.alive` in retro, sweep and dispatch) and from tick boundaries, so a phase with no ticker
 * writes nothing under the prefix for as long as it runs.
 *
 * MEASURED 2026-10-02 over 48 h of the core ledger (233 rotations plus the live file, deduplicated by
 * row): 119 gaps over 5 min between `daemon.*` rows. In 93 of them the same daemon process kept writing
 * its own non-`daemon.*` rows (sweep, gardens, the machine judge) with no gap of its own over 5 min, so
 * its event loop was free and the "silent" reading was false. 10 were real loop stalls (a
 * `daemon.loop_lag` row over 30 s past its interval), 4 were recycles, and 12 had a 5 min hole in the
 * process's own rows with no lag sampler running in that phase, so nothing can say which they were.
 *
 * THE PULSE: one timer for the daemon's whole life, beside every phase. A timer only fires while the
 * event loop is free, so the pulse is evidence of exactly what a liveness reader should mean: the process
 * exists and its loop turns. A dead process or a blocked loop writes nothing, and still reads silent.
 * It writes only when no other `daemon.*` row has been written for one poll interval, so a daemon whose
 * phases already report pays nothing. The pulse is not a progress signal: `quiet_ms` says how long
 * the daemon has gone without a row of its own work, so a wedged await stays visible as a number that
 * keeps growing.
 *
 * Each pulse tick also reports its own lateness through the daemon's loop-lag rule, so a stall in a
 * phase with no ticker of its own is named rather than inferred from absence (the 12 unknown gaps).
 */

/** The pulse row. It keeps the `daemon.` prefix every liveness reader selects on. */
export const LIVENESS_PULSE_STEP = "daemon.pulse";

/** Rows that report on the loop rather than on work, so they never reset `quiet_ms`. */
const OBSERVABILITY_STEPS: ReadonlySet<string> = new Set([LIVENESS_PULSE_STEP, "daemon.loop_lag"]);

export type PulseLog = (step: string, extra?: Record<string, unknown>) => void;
export type PulseLagReport = (sample: { phase: string; dueAtMs: number; observedAtMs: number; intervalMs: number }) => void;

export interface LivenessPulseState {
  /** When the daemon last wrote a `daemon.*` row of its own work. */
  lastWorkRowAtMs: number;
  /** When the previous pulse tick ran, for the lateness report. */
  lastTickAtMs: number;
}

/** Record a row the daemon just wrote. Only `daemon.*` work rows move the clock. */
export function noteDaemonRow(state: LivenessPulseState, step: string, nowMs: number): void {
  if (step.startsWith("daemon.") && !OBSERVABILITY_STEPS.has(step)) state.lastWorkRowAtMs = nowMs;
}

/** One pulse tick: report this tick's lateness, then write a pulse if the prefix has been quiet a full interval. */
export function livenessPulseTick(
  state: LivenessPulseState,
  nowMs: number,
  intervalMs: number,
  log: PulseLog,
  reportLag: PulseLagReport,
): void {
  reportLag({ phase: "pulse", dueAtMs: state.lastTickAtMs + intervalMs, observedAtMs: nowMs, intervalMs });
  state.lastTickAtMs = nowMs;
  const quietMs = nowMs - state.lastWorkRowAtMs;
  if (quietMs < intervalMs) return;
  log(LIVENESS_PULSE_STEP, { poll_interval_ms: intervalMs, quiet_ms: Math.round(quietMs) });
}

/** Start the pulse. `note` must see every row the daemon's own logger writes; `stop` is idempotent. */
export function startLivenessPulse(
  intervalMs: number,
  now: () => number,
  log: PulseLog,
  reportLag: PulseLagReport,
): { note: (step: string) => void; stop: () => void } {
  const startedAtMs = now();
  const state: LivenessPulseState = { lastWorkRowAtMs: startedAtMs, lastTickAtMs: startedAtMs };
  const period = Math.max(1, intervalMs);
  const timer = setInterval(() => {
    try {
      livenessPulseTick(state, now(), period, log, reportLag);
    } catch {
      // Reason: a throwing logger must cost one pulse, never the daemon.
    }
  }, period);
  timer.unref?.();
  return {
    note: (step) => noteDaemonRow(state, step, now()),
    stop: () => clearInterval(timer),
  };
}
