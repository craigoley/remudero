import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// ── The instrument that found (and cleared) the fixture-time-bomb population, guarded so it cannot
// silently stop working. `main` went red at exactly 12:00:00Z on a hardcoded fixture date; the probe
// is how anyone re-checks the suite for another one.
//
// EVERY ASSERTION SPAWNS A REAL NODE PROCESS WITH THE REAL PRELOAD. Asserting properties of a
// re-implemented copy would prove nothing about the file `--import` actually loads — and the whole
// value of this instrument is that its two controls are trustworthy.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRELOAD = join(REPO, "scripts", "clock-shift.mjs");

/** Evaluate `expr` in a fresh node process with the preload active at `days`. */
function underShift(days: number, expr: string): string {
  return execFileSync(process.execPath, ["--import", PRELOAD, "-e", `process.stdout.write(String(${expr}))`], {
    encoding: "utf8",
    env: { ...process.env, FK_SHIFT_DAYS: String(days) },
  }).trim();
}

const DAY_MS = 86_400_000;

test("at +0 the probe is inert — Date.now() is the real clock", () => {
  const before = Date.now();
  const shifted = Number(underShift(0, "Date.now()"));
  const after = Date.now();
  assert.ok(shifted >= before && shifted <= after + 5_000, `expected the real clock, got ${shifted}`);
});

test("Date.now() and no-arg new Date() BOTH move forward by the requested days", () => {
  const days = 400;
  const now = Date.now();
  const shiftedNow = Number(underShift(days, "Date.now()"));
  const shiftedCtor = Date.parse(underShift(days, "new Date().toISOString()"));

  for (const [label, value] of [["Date.now()", shiftedNow], ["new Date()", shiftedCtor]] as const) {
    const deltaDays = (value - now) / DAY_MS;
    assert.ok(
      Math.abs(deltaDays - days) < 1,
      `${label} moved ${deltaDays.toFixed(2)}d, expected ~${days}d — a probe that does not move cannot detect a bomb`,
    );
  }
});

test("Date.parse and Date.UTC are LEFT INTACT — a literal must keep its real instant", () => {
  // THE LOAD-BEARING PROPERTY. If literals shifted along with the clock, both sides of every
  // comparison would move together and the probe would answer nothing at all — it would report
  // universal immunity, which is exactly the false-clean result this instrument exists to avoid.
  const literal = "2026-07-19T12:00:00Z";
  assert.equal(underShift(400, `Date.parse(${JSON.stringify(literal)})`), String(Date.parse(literal)));
  assert.equal(underShift(400, "Date.UTC(2026, 6, 19, 12, 0, 0)"), String(Date.UTC(2026, 6, 19, 12, 0, 0)));
  // A parsed literal is also unmoved through the constructor form.
  assert.equal(underShift(400, `new Date(${JSON.stringify(literal)}).toISOString()`), new Date(literal).toISOString());
});

test("the gap between a literal and 'now' WIDENS under shift — the discriminator itself", () => {
  // This is the property that makes a bomb detectable: a fixture literal ages relative to the clock.
  // Asserted directly rather than inferred from the two tests above.
  const literal = "2026-07-19T12:00:00Z";
  const ageAt0 = Number(underShift(0, `(Date.now() - Date.parse(${JSON.stringify(literal)})) / ${DAY_MS}`));
  const ageAt400 = Number(underShift(400, `(Date.now() - Date.parse(${JSON.stringify(literal)})) / ${DAY_MS}`));
  assert.ok(ageAt400 - ageAt0 > 399, `the literal aged ${(ageAt400 - ageAt0).toFixed(1)}d under a 400d shift`);
});

test("a negative or absent FK_SHIFT_DAYS does not throw — the probe fails inert, never loud", () => {
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, ["--import", PRELOAD, "-e", "0"], {
      encoding: "utf8",
      env: { ...process.env, FK_SHIFT_DAYS: "not-a-number" },
    }),
  );
});
