import assert from "node:assert/strict";
import { test } from "node:test";
// The escaped dot keeps these synthetic measurements out of the literal import census
// of suites whose assertions depend on real elapsed time.
import { assertWallClockBound as assertExactBound, deriveWallClockBound } from "#test/helpers/wall-clock-bound\u002ejs";

test("W1-T13214 criterion 1: the calibration sets the bound in this process", (t) => {
  const ticks = [10, 35];
  t.mock.method(performance, "now", () => ticks.shift());
  let calls = 0;
  const result = deriveWallClockBound(() => { calls++; }, 2, 1_000);

  assert.equal(calls, 1);
  assert.deepEqual(result, { source: "calibrated", boundMs: 50, calibrationMs: 25 });
});

test("W1-T13214 criterion 1: an unavailable calibration uses the fixed fallback", () => {
  const reason = new Error("calibration input disappeared");
  const result = deriveWallClockBound(() => { throw reason; }, 2, 1_000);

  assert.deepEqual(result, { source: "fallback", boundMs: 1_000, calibrationMs: null, reason });
});

test("W1-T13214 criterion 4: the assertion takes three arguments and enforces the exact bound", () => {
  assert.equal(assertExactBound.length, 3);
  assert.equal(assertExactBound(1.249, 1.25, "under"), undefined);
  assert.throws(() => assertExactBound(1.25, 1.25, "equal"), { actual: 1.25, expected: "< 1.25" });
  assert.throws(() => assertExactBound(1.251, 1.25, "over"), { actual: 1.251, expected: "< 1.25" });
});
