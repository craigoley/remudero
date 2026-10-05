// test/a-silent-daemon-loop-is-alarmed-from-outside-it.test.ts — W1-T5651: the daemon's own stall
// signals (daemon.loop_lag, daemon.pulse) are timers on the loop that stalled, so a silent daemon is
// alarmed by serve's incident monitor, a separate process. The pure evaluator is driven over
// synthetic ledger rows: serve writes one row a minute through the stall, the daemon none.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAEMON_LOOP_SILENT_RULE_ID,
  evaluateIncidentInvariants,
  RUNTIME_LOOP_LAG_STEP,
  type IncidentInvariantRow,
} from "../src/lib/incident-invariants.js";

const NOW_MS = Date.parse("2026-10-04T18:00:00.000Z");
const LONG_MS = 15 * 60_000;

function row(atMs: number, fields: Record<string, unknown>): IncidentInvariantRow {
  return { ts: new Date(atMs).toISOString(), run_id: "TEST", task_id: "TEST", ...fields };
}

/** Serve's own minute row, from `sinceMs` to `nowMs`: healthy lag, so no other rule is in play. */
function serveRowsEveryMinute(sinceMs: number, nowMs: number): IncidentInvariantRow[] {
  const rows: IncidentInvariantRow[] = [];
  for (let t = sinceMs + 60_000; t <= nowMs; t += 60_000) {
    rows.push(row(t, { step: RUNTIME_LOOP_LAG_STEP, p50Ms: 1, p99Ms: 5, maxMs: 9, windowMs: 60_000 }));
  }
  return rows;
}

const silentFindings = (rows: IncidentInvariantRow[]) =>
  evaluateIncidentInvariants(rows, NOW_MS).filter((f) => f.ruleId === DAEMON_LOOP_SILENT_RULE_ID);

test("a 15-minute window with serve rows and no daemon.* row yields a daemon-loop-silent finding, while a window with one daemon.pulse row, or an empty ledger, yields none", () => {
  // The stall: serve wrote every minute for 16 minutes, the daemon wrote nothing.
  const stalled = serveRowsEveryMinute(NOW_MS - LONG_MS - 60_000, NOW_MS);
  const found = silentFindings(stalled);
  assert.equal(found.length, 1, "serve rows with no daemon.* row must alarm");
  assert.equal(found[0]?.longMs, LONG_MS);
  assert.match(found[0]?.message ?? "", /15 row/, "the message names the window's row count");
  assert.match(found[0]?.message ?? "", /runtime\.loop_lag/, "the message names the newest non-daemon step");

  // One daemon.pulse row inside the long window, even long past the short one: the loop spoke.
  const pulsed = [...stalled, row(NOW_MS - 10 * 60_000, { step: "daemon.pulse" })];
  assert.deepEqual(silentFindings(pulsed), [], "one daemon.pulse in the window is not a silent daemon");

  // A daemon row in the last 75s alone clears the short confirmation window.
  const justSpoke = [...stalled, row(NOW_MS - 30_000, { step: "daemon.loop_lag", lag_ms: 2_700_000 })];
  assert.deepEqual(silentFindings(justSpoke), [], "a daemon row inside the short window clears it");

  // A cold or empty ledger holds no evidence: no rows, no alarm.
  assert.deepEqual(silentFindings([]), [], "an empty ledger yields no finding");
});
