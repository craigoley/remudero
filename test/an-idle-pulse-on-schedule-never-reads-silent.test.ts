/**
 * A quiet daemon's only `daemon.*` row is deploy/entrypoint.sh's idle pulse, written once per 300 s
 * sleep and then followed by its probe. The host's 24 h union on 2026-10-02 measured the pulse-to-pulse
 * gap at p50 302 s, p99 315-319 s, max 320 s (site 260 gaps, console 170), and pulse-to-next-row at
 * max 563 s across a wake's Node boot. A fixed 5 min silence bound therefore read every healthy idle
 * cycle silent. The bound now comes from the cadence the winning row's emitter declares.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { deriveLastPoll } from "../src/lib/daemon-health.js";
import { readLedgerAgeMs } from "../src/lib/doctor.js";
import { defaultProbeHost } from "../src/lib/now-view.js";
import { IDLE_STARVED_PULSE_MS, IDLE_STARVED_PULSE_STEP } from "../src/lib/poll-interval.js";

const NOW = Date.parse("2026-10-02T07:00:00.000Z");
const pulse = (ageS: number) => ({ ts: new Date(NOW - ageS * 1000).toISOString(), step: IDLE_STARVED_PULSE_STEP, run_id: "IDLE-abc", task_id: "DAEMON" });
const tick = (ageS: number) => ({ ts: new Date(NOW - ageS * 1000).toISOString(), step: "daemon.tick", poll_interval_ms: 60_000 });
const daemonOf = (rows: Array<Record<string, unknown>>) =>
  defaultProbeHost({ name: "site", ledgerDir: "/nonexistent-idle-pulse" }, false, fixedClock(NOW), { readLive: () => rows, diskFree: () => 1 }).health.daemon;

test("an idle pulse row carries the entrypoint pulse cadence", () => {
  assert.equal(deriveLastPoll([tick(400), pulse(10)]).pollIntervalMs, IDLE_STARVED_PULSE_MS);
  assert.equal(deriveLastPoll([pulse(400), tick(10)]).pollIntervalMs, 60_000, "a newer Node tick keeps its own declared cadence");
});

test("an idle pulse on schedule reads polling through its measured jitter", () => {
  for (const ageS of [301, 320, 395, 563]) {
    assert.deepEqual(daemonOf([pulse(ageS)]), { state: "polling" }, `a pulse ${ageS} s old is on schedule`);
  }
});

test("a daemon that missed its idle pulses still reads silent", () => {
  const at = new Date(NOW - 601_000).toISOString();
  assert.deepEqual(daemonOf([pulse(601)]), { state: "silent", at, reason: "no daemon.* row for over 10 min" });
});

test("a busy daemon tick with a one minute cadence keeps the five minute silence bound", () => {
  assert.deepEqual(daemonOf([tick(299)]), { state: "polling" });
  const at = new Date(NOW - 301_000).toISOString();
  assert.deepEqual(daemonOf([tick(301)]), { state: "silent", at, reason: "no daemon.* row for over 5 min" });
});

test("doctor reads an idle pulse against two pulse cadences rather than two minute ticks", () => {
  assert.equal(readLedgerAgeMs([pulse(320)], NOW).boundMs, 2 * IDLE_STARVED_PULSE_MS);
});
