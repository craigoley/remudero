/**
 * W1-T9516 — A DAEMON WHOSE LOOP HAS RESUMED IS NOT RECYCLED AS STALLED.
 *
 * OBSERVED 2026-10-14: pid 3182622 booted at 04:45:50Z, wrote its newest progress rows at 04:48:59Z / 04:49:08Z, and
 * its loop was then blocked for 45.7 min. At 05:35:46.293Z it wrote `daemon.loop_lag` lag_ms 2,742,587, the row its
 * loop writes when a block ENDS. At 05:35:56Z the watchdog read STALLED action=recycle (progress 46.8 min old) and the
 * recycle replaced a daemon that was posting reviews again. These tests replay those rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROGRESS_WATCHDOG_READ_STEPS,
  decideProgressWatchdog,
  openPrCountReadingFromRows,
} from "#src/lib/progress-watchdog.js";

type Row = Record<string, unknown>;
const at = (iso: string): number => Date.parse(iso);
const PID = 3_182_622;
const HOST = "remudero-core";
const RUN = "DAEMON-1792043150000";
const NOW = at("2026-10-14T05:35:56.000Z");
const RESUME = "2026-10-14T05:35:46.293Z";

/** The 2026-10-14 rows the verb reads, up to the 05:35:56Z tick. */
function incidentRows(extra: Row[] = [], loopLag: Row = { actor_pid: PID }): Row[] {
  return [
    { ts: "2026-10-14T04:45:49.000Z", step: "daemon.paths", run_id: RUN, actor_pid: PID, host: HOST },
    { ts: "2026-10-14T04:45:50.000Z", step: "daemon.boot", run_id: RUN, actor_pid: PID, host: HOST },
    { ts: "2026-10-14T04:47:40.000Z", step: "daemon.sweep.started", run_id: RUN, actor_pid: PID, host: HOST, bound_ms: 600_000 },
    { ts: "2026-10-14T04:48:59.000Z", step: "review.posted", run_id: "review-PR15001-1792043339000", actor_pid: 3_190_001, host: HOST },
    { ts: "2026-10-14T04:49:08.000Z", step: "sweep.pass", run_id: RUN, actor_pid: PID, host: HOST, enumerated: 11, surface: "full" },
    { ts: RESUME, step: "daemon.loop_lag", run_id: RUN, host: HOST, phase: "pulse", lag_ms: 2_742_587, missed_ticks: 45,
      last_step_before_block: "github.wake.check_settled", ...loopLag },
    ...extra,
  ];
}

function decide(rows: Row[], nowMs: number = NOW) {
  const count = openPrCountReadingFromRows(rows);
  return decideProgressWatchdog({ rows, nowMs, openPrCount: count.count, openPrCountSource: count.source, revivalLog: "" });
}

test("W1-T9516: a loop that resumed after its block is recovering, not stalled", () => {
  assert.ok(PROGRESS_WATCHDOG_READ_STEPS.includes("daemon.loop_lag"), "the verb reads the resume row");
  const verdict = decide(incidentRows());
  assert.deepEqual([verdict.state, verdict.action], ["RECOVERING", "none"], verdict.reason);
  assert.equal(verdict.loopResumedMs, at(RESUME));
  assert.equal(Math.floor((verdict.progressAgeMs ?? 0) / 60_000), 46, "the progress age is still reported as it is");
  assert.match(verdict.reason, /newest progress row is 46 min old/);
  assert.match(verdict.reason, /resumed at 2026-10-14T05:35:46\.293Z/);
  assert.match(verdict.reason, /lag_ms 2742587/);
});

test("W1-T9516: a resumed loop that makes no progress is still recycled", () => {
  // A healthy loop's small lag row in the second silence must not reopen the allowance.
  const smallLag: Row = { ts: "2026-10-14T06:04:00.000Z", step: "daemon.loop_lag", run_id: RUN, actor_pid: PID, host: HOST,
    phase: "pulse", lag_ms: 90_000, missed_ticks: 1 };
  const rows = incidentRows([smallLag]);
  const within = decide(rows, at("2026-10-14T05:52:00.000Z"));
  assert.deepEqual([within.state, within.action], ["STALLED", "capture-diagnostics"], within.reason);
  const verdict = decide(rows, at("2026-10-14T06:06:00.000Z"));
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"], verdict.reason);
  assert.equal(verdict.loopResumedMs, at(RESUME), "the small lag row is not a resume");
});

test("W1-T9516: a previous generation's loop_lag is not a resume", () => {
  const previousBoot: Row = { ts: "2026-10-14T03:10:00.000Z", step: "daemon.boot", run_id: "DAEMON-old", actor_pid: 2_900_001, host: HOST };
  const verdict = decide([previousBoot, ...incidentRows([], { actor_pid: 2_900_001, run_id: "DAEMON-old" })]);
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"], verdict.reason);
  assert.equal(verdict.loopResumedMs, null);
  const otherHost = decide(incidentRows([], { host: "remudero-serve" }));
  assert.deepEqual([otherHost.state, otherHost.action], ["STALLED", "recycle"], "the same pid on another host is another process");
});
