import assert from "node:assert/strict";
import test from "node:test";

import { LEDGER_FUTURE_STAMP_TOLERANCE_MS } from "#src/lib/ledger.js";
import { decideProgressWatchdog } from "#src/lib/progress-watchdog.js";

const NOW = Date.parse("2026-11-04T16:00:00.000Z");
const MIN = 60_000;
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
type Row = Record<string, unknown>;

const sweepPass = (offsetMs: number): Row => ({ ts: at(offsetMs), step: "sweep.pass", run_id: "r-sweep", enumerated: 4 });
const decide = (rows: Row[]) => decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: 4, revivalLog: "" });

test("W1-T11324 criterion 1: a future-stamped progress row is read as absent, and the verdict counts it", () => {
  const real = sweepPass(-31 * MIN);
  const future: Row = { ts: at(365 * 24 * 60 * MIN), step: "review.posted", run_id: "r-shifted" };

  const without = decide([real]);
  const withFuture = decide([real, future]);

  assert.deepEqual([withFuture.state, withFuture.action], [without.state, without.action]);
  assert.deepEqual([withFuture.state, withFuture.action], ["STALLED", "recycle"]);
  assert.equal(withFuture.progressAgeMs, without.progressAgeMs);
  assert.equal(withFuture.futureStampedSkipped, 1);
});

test("W1-T11324 criterion 1: a row inside the tolerance still counts as progress", () => {
  const nearFuture = sweepPass(LEDGER_FUTURE_STAMP_TOLERANCE_MS - MIN);
  const verdict = decide([sweepPass(-31 * MIN), nearFuture]);
  assert.deepEqual([verdict.state, verdict.action], ["PROGRESSING", "none"]);
  assert.equal(verdict.futureStampedSkipped, 0);
});

test("W1-T11324 criterion 1: a future-stamped boot or loop resume cannot age a generation from the future", () => {
  const real = sweepPass(-31 * MIN);
  const futureBoot: Row = { ts: at(365 * 24 * 60 * MIN), step: "daemon.boot", run_id: "r-shifted", actor_pid: 7, host: "h" };
  const futureResume: Row = { ts: at(365 * 24 * 60 * MIN), step: "daemon.loop_lag", lag_ms: 90_000, actor_pid: 7, host: "h" };
  const verdict = decide([real, futureBoot, futureResume]);
  assert.equal(verdict.generationBootMs, null);
  assert.equal(verdict.loopResumedMs, null);
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"]);
  assert.equal(verdict.futureStampedSkipped, 2);
});

test("W1-T11324 criterion 1: a corpus with no future rows yields today's verdict and counts nothing", () => {
  const verdict = decide([sweepPass(-5 * MIN)]);
  assert.deepEqual([verdict.state, verdict.action], ["PROGRESSING", "none"]);
  assert.equal(Math.round((verdict.progressAgeMs ?? 0) / MIN), 5);
  assert.equal(verdict.futureStampedSkipped, 0);
});
