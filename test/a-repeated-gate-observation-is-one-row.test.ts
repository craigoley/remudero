/**
 * W1-T4685 — A REPEATED GATE OBSERVATION IS ONE ROW.
 *
 * MEASURED: this Mac's ledger held 799 identical `daemon.pause` rows against 800 `daemon.tick`
 * rows — one appended EVERY tick the pause condition held, unchanged. `gate-observations.ts`
 * collapses a repeated `(lane, gate, condition)` observation onto one row carrying first seen,
 * last seen and a count, flushed only when the condition changes or a heartbeat elapses.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Clock } from "../src/lib/clock.js";
import { createGateObservationState, observeGate, snapshotGateObservations } from "../src/lib/gate-observations.js";

type LoggedLine = { step: string; extra?: Record<string, unknown> };

function recordingLog(): { log: (step: string, extra?: Record<string, unknown>) => void; lines: LoggedLine[] } {
  const lines: LoggedLine[] = [];
  return { log: (step, extra) => lines.push({ step, extra }), lines };
}

/** A `Clock` a test can advance by hand, rather than a real sleep. */
function manualClock(startMs: number): Clock & { advance: (byMs: number) => void } {
  let ms = startMs;
  return {
    now: () => ms,
    date: () => new Date(ms),
    iso: () => new Date(ms).toISOString(),
    advance: (byMs: number) => {
      ms += byMs;
    },
  };
}

test("W1-T4685: an unchanged gate observation increments one row instead of appending", () => {
  const state = createGateObservationState();
  const { log, lines } = recordingLog();
  const clock = manualClock(1_000);
  const condition = { detail: "quiet hours" };

  for (let i = 0; i < 5; i++) {
    observeGate(state, { lane: "daemon", gate: "pause", condition, heartbeatMs: 60_000, clock }, log);
  }

  assert.equal(lines.length, 1, "five identical observations flushed only once, not five times");
  assert.equal(lines[0].step, "gate.observed");
  const rows = snapshotGateObservations(state);
  assert.equal(rows.length, 1, "one tracked row, never one per observation");
  assert.equal(rows[0].count, 5, "the row's count tracks every observation, flushed or not");
  assert.equal(lines[0].extra?.count, 1, "the ONE flushed row reflects the count as of that flush");
});

test("W1-T4685: a changed condition flushes a new row", () => {
  const state = createGateObservationState();
  const { log, lines } = recordingLog();
  const clock = manualClock(1_000);

  observeGate(state, { lane: "daemon", gate: "pause", condition: { detail: "quiet hours" }, heartbeatMs: 60_000, clock }, log);
  observeGate(state, { lane: "daemon", gate: "pause", condition: { detail: "quiet hours" }, heartbeatMs: 60_000, clock }, log);
  observeGate(state, { lane: "daemon", gate: "pause", condition: { detail: "operator hold" }, heartbeatMs: 60_000, clock }, log);

  assert.equal(lines.length, 2, "the changed condition flushed immediately, beside the first row's own flush");
  assert.notEqual(
    lines[0].extra?.condition_hash,
    lines[1].extra?.condition_hash,
    "the two flushed rows carry different condition hashes",
  );
  const rows = snapshotGateObservations(state);
  assert.equal(rows.length, 2, "two distinct conditions, two tracked rows");
});

test("W1-T4685: an unchanged observation still flushes once a heartbeat elapses", () => {
  const state = createGateObservationState();
  const { log, lines } = recordingLog();
  const clock = manualClock(0);
  const condition = { detail: "quiet hours" };

  observeGate(state, { lane: "daemon", gate: "pause", condition, heartbeatMs: 1_000, clock }, log);
  clock.advance(500);
  observeGate(state, { lane: "daemon", gate: "pause", condition, heartbeatMs: 1_000, clock }, log);
  assert.equal(lines.length, 1, "the heartbeat has not elapsed yet — no second flush");

  clock.advance(600);
  const flushedOnHeartbeat = observeGate(state, { lane: "daemon", gate: "pause", condition, heartbeatMs: 1_000, clock }, log);
  assert.equal(flushedOnHeartbeat, true, "1100ms since the first flush — the heartbeat fires");
  assert.equal(lines.length, 2);
  assert.equal(lines[1].extra?.count, 3, "the heartbeat flush carries every observation since the last flush");
});

test("W1-T4685: condition key order does not defeat the collapse", () => {
  const state = createGateObservationState();
  const { log, lines } = recordingLog();
  const clock = manualClock(0);

  observeGate(state, { lane: "daemon", gate: "pause", condition: { detail: "x", tick: 1 }, heartbeatMs: 60_000, clock }, log);
  observeGate(state, { lane: "daemon", gate: "pause", condition: { tick: 1, detail: "x" }, heartbeatMs: 60_000, clock }, log);

  assert.equal(lines.length, 1, "the same condition, keyed in a different order, is still the same row");
  assert.equal(snapshotGateObservations(state)[0].count, 2);
});
