/**
 * W1-T9779 — THE PROGRESS WATCHDOG NEVER RECYCLES A DAEMON WHOSE FULL PASS IS STILL IN FLIGHT INSIDE ITS OWN
 * LEARNED BOUND.
 *
 * OBSERVED 2026-10-16: DAEMON-1792125203347 logged `daemon.sweep.started` at 06:10:59Z (bound_ms 8,706,363) and its
 * full pass's `sweep.pass` at 06:15:10Z. Two reviews and a fix then waited 32-42 min for memory admission, so no
 * progress row came until 06:51Z. At 06:45:28Z the watchdog read STALLED action=recycle, and the recycle replaced a
 * daemon whose pass settled at 07:00:42Z. These tests replay those rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROGRESS_WATCHDOG_READ_STEPS,
  decideProgressWatchdog,
  openPrCountReadingFromRows,
} from "../src/lib/progress-watchdog.js";

type Row = Record<string, unknown>;
const at = (iso: string): number => Date.parse(iso);
const RUN = "DAEMON-1792125203347";
const NOW = at("2026-10-16T06:45:28.000Z");

/** The 2026-10-16 rows the verb reads, up to the 06:45:28Z tick. */
function incidentRows(extra: { started?: Row; pulseAt?: string } = {}): Row[] {
  return [
    { ts: "2026-10-16T04:33:57.000Z", step: "daemon.paths", run_id: RUN },
    { ts: "2026-10-16T04:33:58.000Z", step: "daemon.boot", run_id: RUN },
    { ts: "2026-10-16T05:28:09.000Z", step: "daemon.sweep.started", run_id: RUN, bound_ms: 8_706_363 },
    { ts: "2026-10-16T05:32:39.000Z", step: "sweep.pass", run_id: RUN, enumerated: 6, surface: "full" },
    { ts: "2026-10-16T05:33:30.000Z", step: "daemon.sweep.settled", run_id: RUN, elapsed_ms: 320_480, abandoned: false },
    { ts: "2026-10-16T05:42:13.000Z", step: "review.posted", run_id: "review-PR12269-1792128370924" },
    extra.started ?? { ts: "2026-10-16T06:10:59.607Z", step: "daemon.sweep.started", run_id: RUN, bound_ms: 8_706_363 },
    { ts: "2026-10-16T06:12:54.227Z", step: "sweep.pass", run_id: RUN, enumerated: 1, surface: "light" },
    { ts: "2026-10-16T06:15:10.000Z", step: "sweep.pass", run_id: RUN, enumerated: 7, surface: "full" },
    { ts: extra.pulseAt ?? "2026-10-16T06:44:44.000Z", step: "daemon.pulse", run_id: RUN },
  ];
}

function decide(rows: Row[], nowMs: number = NOW) {
  const count = openPrCountReadingFromRows(rows);
  return decideProgressWatchdog({ rows, nowMs, openPrCount: count.count, openPrCountSource: count.source, revivalLog: "" });
}

test("W1-T9779: a full pass in flight inside its own learned bound is not recycled", () => {
  const verdict = decide(incidentRows());
  assert.notEqual(verdict.action, "recycle", verdict.reason);
  assert.deepEqual([verdict.state, verdict.action], ["IN_PASS", "capture-diagnostics"], verdict.reason);
  assert.equal(Math.floor((verdict.progressAgeMs ?? 0) / 60_000), 30, "the progress age is still reported as it is");
  assert.match(verdict.reason, /full pass started 34 min ago is in flight inside its own learned bound \(145 min\)/);
});

test("W1-T9779: a pass past its own learned bound is still recycled", () => {
  const started = { ts: "2026-10-16T06:10:59.607Z", step: "daemon.sweep.started", run_id: RUN, bound_ms: 20 * 60_000 };
  const verdict = decide(incidentRows({ started }));
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"], verdict.reason);
});

test("W1-T9779: an in-flight pass whose daemon stopped pulsing is still recycled", () => {
  const verdict = decide(incidentRows({ pulseAt: "2026-10-16T06:20:00.000Z" }));
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"], verdict.reason);
});

test("W1-T9779: a settled or abandoned pass is not in flight", () => {
  for (const step of ["daemon.sweep.settled", "daemon.sweep.abandoned"]) {
    const rows = [...incidentRows(), { ts: "2026-10-16T06:20:00.000Z", step, run_id: RUN }];
    const verdict = decide(rows);
    assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"], `${step}: ${verdict.reason}`);
  }
});

test("W1-T9779: a pass from an earlier generation is not in flight", () => {
  const next = "DAEMON-1792131100000";
  const rows: Row[] = [
    { ts: "2026-10-16T06:10:59.607Z", step: "daemon.sweep.started", run_id: RUN, bound_ms: 8_706_363 },
    { ts: "2026-10-16T06:11:40.000Z", step: "daemon.paths", run_id: next },
    { ts: "2026-10-16T06:12:00.000Z", step: "daemon.boot", run_id: next },
    { ts: "2026-10-16T06:15:10.000Z", step: "sweep.pass", run_id: next, enumerated: 7, surface: "full" },
    { ts: "2026-10-16T06:44:44.000Z", step: "daemon.pulse", run_id: next },
    { ts: "2026-10-16T06:44:50.000Z", step: "daemon.pulse", run_id: RUN },
  ];
  const verdict = decide(rows);
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"], verdict.reason);
});

test("W1-T9779: a started row with no bound is never in flight", () => {
  const started = { ts: "2026-10-16T06:10:59.607Z", step: "daemon.sweep.started", run_id: RUN };
  const verdict = decide(incidentRows({ started }));
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"], verdict.reason);
});

test("W1-T9779: below the recycle bound an in-flight pass changes nothing", () => {
  const verdict = decide(incidentRows(), at("2026-10-16T06:35:28.000Z"));
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "capture-diagnostics"], verdict.reason);
  const fresh = decide(incidentRows(), at("2026-10-16T06:20:00.000Z"));
  assert.deepEqual([fresh.state, fresh.action], ["PROGRESSING", "none"], fresh.reason);
});

test("W1-T9779: the verb reads the pass marker and the pulse", () => {
  for (const step of ["daemon.sweep.started", "daemon.sweep.settled", "daemon.sweep.abandoned", "daemon.pulse"]) {
    assert.ok(PROGRESS_WATCHDOG_READ_STEPS.includes(step), `${step} is read`);
  }
});
