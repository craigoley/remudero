/**
 * W1-T4041 — the daemon reports a tick that came back late, and names the phase.
 *
 * On 2026-09-22 the liveness heartbeat, the inter-phase review clock and the sweep went silent
 * TOGETHER for 34 minutes while the process stayed alive. All three are timer-driven on one event
 * loop, so every lane that could have reported the outage was frozen by it. These tests pin the
 * reading, its phase attribution, its silence on a punctual tick, and that a throwing logger costs
 * the reading rather than the tick.
 *
 * The threshold is DERIVED — one whole missed interval — so the boundary case is asserted
 * explicitly: a tick exactly one interval late reports nothing, which is what makes the `>` in
 * `reportLoopLag` load-bearing rather than incidental.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { reportLoopLag } from "../src/lib/daemon.js";

type Row = { step: string; extra: Record<string, unknown> };

/** Collect what the sampler would have written, with no daemon and no timers. */
function collect(): { rows: Row[]; log: (step: string, extra?: Record<string, unknown>) => void } {
  const rows: Row[] = [];
  return { rows, log: (step, extra = {}) => rows.push({ step, extra: extra ?? {} }) };
}

test("W1-T4041: a tick delayed past its interval reports the lag", () => {
  const { rows, log } = collect();
  // Due at 1000 on a 60s interval, observed 21.5 minutes late — the measured outage.
  reportLoopLag({ phase: "interphase", dueAtMs: 1000, observedAtMs: 1000 + 1_290_000, intervalMs: 60_000 }, log);
  assert.equal(rows.length, 1, "a tick that missed whole intervals must be reported");
  assert.equal(rows[0].step, "daemon.loop_lag");
  assert.equal(rows[0].extra.lag_ms, 1_290_000);
  assert.equal(rows[0].extra.missed_ticks, 21, "21 whole 60s ticks fit in the overrun");
});

test("W1-T4041: the lag row names the phase that was in force", () => {
  const { rows, log } = collect();
  reportLoopLag({ phase: "dispatch", dueAtMs: 0, observedAtMs: 500_000, intervalMs: 60_000 }, log);
  assert.equal(rows[0].extra.phase, "dispatch", "without the phase the row cannot attribute the freeze");
  assert.equal(rows[0].extra.interval_ms, 60_000, "the interval rides along so lag is readable without it");
});

test("W1-T4041: an on-time tick reports nothing", () => {
  const { rows, log } = collect();
  // Punctual, and early.
  reportLoopLag({ phase: "sweep", dueAtMs: 1000, observedAtMs: 1000, intervalMs: 60_000 }, log);
  reportLoopLag({ phase: "sweep", dueAtMs: 1000, observedAtMs: 900, intervalMs: 60_000 }, log);
  // THE BOUNDARY: exactly one interval late is NOT yet a missed tick. This is what makes the
  // derived threshold a `>` rather than a `>=`; without it the signal fires on ordinary jitter.
  reportLoopLag({ phase: "sweep", dueAtMs: 1000, observedAtMs: 1000 + 60_000, intervalMs: 60_000 }, log);
  assert.deepEqual(rows, [], "a punctual, early or exactly-one-interval-late tick must stay silent");
});

test("W1-T4041: a sampler failure never takes the daemon loop down", () => {
  const throwing = () => {
    throw new Error("ledger unavailable");
  };
  assert.doesNotThrow(
    () => reportLoopLag({ phase: "interphase", dueAtMs: 0, observedAtMs: 500_000, intervalMs: 60_000 }, throwing),
    "observability must never be able to take down the loop it observes",
  );
});
