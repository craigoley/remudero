/**
 * lib/liveness-pulse.ts — E32: a busy daemon must not read "silent" while its event loop is free.
 *
 * Every liveness reader (`deriveLastPoll`) takes the newest `daemon.*` row, but those rows come from
 * per-phase tickers and tick boundaries, so a phase with no ticker writes none for as long as it runs.
 * MEASURED 2026-10-02, 48 h of the core ledger deduplicated by row: 119 gaps over 5 min. In 93 the
 * same process kept writing its own work rows with no gap over 5 min (a free loop, falsely "silent");
 * 10 were loop stalls (`daemon.loop_lag` > 30 s past interval), 4 recycles, 12 unattributable.
 *
 * THE PULSE: one timer for the daemon's life. A timer fires only on a free loop, so a dead process or
 * a blocked loop still reads silent. It writes only after one poll interval with no other `daemon.*`
 * row. It is not progress: `quiet_ms` grows while no work row lands, so a wedged await stays visible.
 * Each tick also reports its own lateness as `daemon.loop_lag` (phase `pulse`), naming stalls in
 * phases that had no sampler — the 12 unattributable gaps.
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
