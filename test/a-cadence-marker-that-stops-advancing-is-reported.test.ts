/**
 * W1-T3236 — a cadence marker that stops advancing is reported, against its own rung's interval.
 *
 * `state/last-retro.json` sat frozen from 2026-09-03 to 2026-09-09 while the fleet completed 28-40
 * runs a day and merged normally. A day-by-day replay over that fortnight recovered 426 follow-up
 * candidates the rung should have published. Nothing said so; an operator asked why the board had
 * gone quiet.
 *
 * THE THREE CASES ARE THE POPULATION THIS MUST SEPARATE, and each one is a different mistake if it
 * collapses into another: a stale rung read as fresh is the six-day silence; a never-fired rung
 * read as stale sends someone hunting a regression in a rung with no history; and a slow rung read
 * against one global age is the bound-fires-on-a-healthy-condition defect this repo already
 * records, wearing the opposite face.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CADENCE_DEFAULT_INTERVAL_MINUTES,
  CADENCE_MARKERS,
  CADENCE_STALE_INTERVALS,
  cadenceMarkerRows,
  type CadenceMarkerDef,
} from "../src/lib/status-board.js";

const HOUR = 3_600_000;
const RETRO: CadenceMarkerDef = { name: "retro", file: "last-retro.json", policyKey: "retro" };

/** One row, for a marker of the given age judged against the given interval. */
function row(ageMs: number | undefined, intervalMinutes: number | undefined, def: CadenceMarkerDef = RETRO) {
  return cadenceMarkerRows([def], () => ageMs, () => intervalMinutes)[0]!;
}

test("W1-T3236: a marker older than its own rung's interval is reported stale", () => {
  // The measured incident: six days frozen against a six-hourly rung.
  const stale = row(144 * HOUR, 360);
  assert.equal(stale.state, "stale");
  assert.equal(stale.ageMs, 144 * HOUR);
  assert.equal(stale.intervalMinutes, 360, "the row must carry the interval it was judged against");
  assert.match(stale.consequence, /has not advanced in 144h/);
  assert.match(stale.consequence, /360-minute cadence/);
  // The consequence must say what an operator should conclude, not merely that a number is large.
  assert.match(stale.consequence, /firing and failing, or not firing/);

  // The boundary is inclusive on the fresh side: exactly N intervals is not yet stale.
  assert.equal(row(360 * 60_000 * CADENCE_STALE_INTERVALS, 360).state, "fresh");
  assert.equal(row(360 * 60_000 * CADENCE_STALE_INTERVALS + 1, 360).state, "stale");
});

test("W1-T3236: an absent marker is reported never-fired, not skipped", () => {
  const never = row(undefined, 360);
  assert.equal(never.state, "never");
  assert.equal(never.ageMs, undefined, "there is no age to report, and none may be invented");
  assert.match(never.consequence, /has never fired/);
  // It must NOT read as stale — a rung with no history is a different investigation.
  assert.notEqual(never.state, "stale");
  // And it must be PRESENT. STATIC_LATCHES' `if (!existsSync) continue` is right for a latch and
  // wrong here; a dead rung rendered as nothing at all is the failure this task exists to remove.
  assert.equal(cadenceMarkerRows([RETRO], () => undefined, () => 360).length, 1);
});

test("W1-T3236: a slow rung within its own interval is fresh while a fast one at the same age is stale", () => {
  const AGE = 20 * HOUR;
  // Same age, two rungs. One global threshold cannot produce both of these answers.
  const slow = row(AGE, 24 * 60, { name: "wipe-test", file: "last-wipe-test-cadence.json" });
  const fast = row(AGE, 60, RETRO);
  assert.equal(slow.state, "fresh", "a daily rung 20h after its last fire is healthy");
  assert.equal(fast.state, "stale", "an hourly rung 20h after its last fire has stopped");
  assert.notEqual(slow.state, fast.state, "the interval, not the age, is what decides");
});

test("W1-T3236: an undeclared interval falls back to a DAY, which can only under-report", () => {
  const fallback = row(30 * HOUR, undefined);
  assert.equal(fallback.intervalMinutes, CADENCE_DEFAULT_INTERVAL_MINUTES);
  assert.equal(CADENCE_DEFAULT_INTERVAL_MINUTES, 24 * 60);
  // 30h against a 3x24h budget is comfortably fresh — the conservative direction. A fallback that
  // fired early would train an operator to ignore the table.
  assert.equal(fallback.state, "fresh");
});

test("W1-T3236: every marker a periodic rung writes is in the table, and the retro is one of them", () => {
  const files = new Set(CADENCE_MARKERS.map((m) => m.file));
  for (const f of [
    "last-retro.json",
    "last-measurement-cadence.json",
    "last-digest-cadence.json",
    "last-board-review.json",
    "last-wipe-test-cadence.json",
    "last-ci-learning-cadence.json",
    "last-auto-triage.json",
    "last-feedback-docket.json",
    "last-seen.json",
  ]) {
    assert.ok(files.has(f), `${f} is written by a periodic rung and must be watched`);
  }
  // Every row is judged, not just the ones with a policy key — an undeclared interval is a
  // fallback, never an exclusion.
  const rows = cadenceMarkerRows(CADENCE_MARKERS, () => 1_000 * HOUR, () => undefined);
  assert.equal(rows.length, CADENCE_MARKERS.length);
  assert.ok(rows.every((r) => r.state === "stale"), "a 1000h-old marker is stale on every rung");
});
