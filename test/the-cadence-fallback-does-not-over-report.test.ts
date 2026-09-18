// @source-text-subject: lib/status-board.ts's cadence interval resolution and fallback invariant.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CADENCE_DEFAULT_INTERVAL_MINUTES,
  CADENCE_MARKERS,
  SEVEN_DAYS_MINUTES,
  cadenceDefsMisjudgedByFallback,
  cadenceMarkerRows,
  type CadenceMarkerDef,
} from "../src/lib/status-board.js";
import { feedbackDocketDue } from "../src/lib/feedback-docket.js";

// ── W1-T3757 — THE FALLBACK OVER-REPORTED FOR THE ONLY TWO ROWS THAT USED IT ─────────────────
//
// MEASURED 2026-09-18: both CADENCE rows reading stale were false alarms. `feedback-docket` is
// weekly by construction (`feedbackDocketDue` gates on SEVEN_DAYS_MS) and was judged against the
// 1440-minute fallback, so with three intervals of grace (72h) against a real 168h period it read
// stale for 96 of every 168 hours — 57% of the time — while behaving exactly as designed.

const HOUR_MS = 3_600_000;

test("the docket's declared interval is the period its own gate actually enforces", () => {
  const docket = CADENCE_MARKERS.find((d) => d.name === "feedback-docket");
  assert.ok(docket, "the docket row must still exist");
  assert.equal(docket.intervalMinutes, SEVEN_DAYS_MINUTES);

  // Pinned to BEHAVIOUR, not to a copied constant: `SEVEN_DAYS_MS` is module-private to
  // feedback-docket.ts, and a number re-typed here could drift from the gate without either side
  // noticing. Straddling the threshold proves the board's declared minutes ARE the gate's period.
  const now = new Date("2026-09-18T00:00:00.000Z");
  const declaredMs = SEVEN_DAYS_MINUTES * 60_000;
  const at = (agoMs: number) => ({ lastFireIso: new Date(now.getTime() - agoMs).toISOString() });
  assert.equal(feedbackDocketDue(at(declaredMs - 60_000), now), false, "a minute short of the declared interval must not be due");
  assert.equal(feedbackDocketDue(at(declaredMs + 60_000), now), true, "a minute past it must be due");
});

test("a docket 196h old reads fresh, where the fallback called it stale", () => {
  const docket = CADENCE_MARKERS.find((d) => d.name === "feedback-docket")!;
  // 196h is the exact age measured on the live board when it reported stale.
  const [row] = cadenceMarkerRows([docket], () => 196 * HOUR_MS, () => undefined);
  assert.equal(row!.state, "fresh");
  assert.equal(row!.intervalMinutes, SEVEN_DAYS_MINUTES);
});

test("a genuinely stopped weekly rung still reads stale — this widens no grace", () => {
  const docket = CADENCE_MARKERS.find((d) => d.name === "feedback-docket")!;
  // Past three of its OWN intervals (3 x 168h = 504h).
  const [row] = cadenceMarkerRows([docket], () => 600 * HOUR_MS, () => undefined);
  assert.equal(row!.state, "stale");
});

test("a rung slower than a day that declares no interval is reported as misjudged, by name", () => {
  const undeclared: CadenceMarkerDef = { name: "weekly-thing", file: "last-weekly-thing.json" };
  const misjudged = cadenceDefsMisjudgedByFallback([undeclared], () => SEVEN_DAYS_MINUTES);
  assert.deepEqual(misjudged, ["weekly-thing"]);
});

test("declaring the interval clears it, and a rung faster than a day never needed to", () => {
  const declared: CadenceMarkerDef = { name: "weekly-thing", file: "x.json", intervalMinutes: SEVEN_DAYS_MINUTES };
  assert.deepEqual(cadenceDefsMisjudgedByFallback([declared], () => SEVEN_DAYS_MINUTES), []);
  const hourly: CadenceMarkerDef = { name: "hourly-thing", file: "y.json" };
  assert.deepEqual(cadenceDefsMisjudgedByFallback([hourly], () => 60), []);
});

test("no shipped registry row is misjudged by the fallback today", () => {
  // The regression guard: adding a slower-than-daily rung without declaring its period reddens here.
  const realPeriods: Record<string, number> = { "feedback-docket": SEVEN_DAYS_MINUTES };
  const misjudged = cadenceDefsMisjudgedByFallback(CADENCE_MARKERS, (d) => realPeriods[d.name]);
  assert.deepEqual(misjudged, [], `these rows rely on the ${CADENCE_DEFAULT_INTERVAL_MINUTES}-minute fallback and should not`);
});

test("the fallback interval is unchanged — this repair is not a longer default", () => {
  // THE FORBIDDEN FIX, pinned. Lengthening the fallback would silence both stale rows by making
  // every FUTURE undeclared rung slower to report: a false alarm traded for a missed one, in a
  // section whose whole value is catching the rung that stopped.
  //
  // This assertion also exists because the criterion it answers cannot be proved by grepping the
  // constant — an unchanged line matches the merge base too, and `proof-discrimination` refused
  // exactly that (#5982). A control assertion needs a control of its own; this file is it.
  assert.equal(CADENCE_DEFAULT_INTERVAL_MINUTES, 24 * 60);
});
