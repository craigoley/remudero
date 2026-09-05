import { AssertionError } from "node:assert";

// ── W1-T2811: the one seam a wall-clock-bounded assertion declares itself through ────────────
//
// A handful of assertions in this suite put a REAL elapsed measurement under an UPPER bound.
// That is the only assertion shape a slow or oversubscribed host can fail with no defect in the
// code under test, and until now the class was inexpressible: HOST_CAUSED_SUITE_REDS keys on
// cheap host FACTS (platform, bash version, node pin) and load is not one; HOST_PARITY_BASELINE
// observes a real run but confirms a failure by re-running its file ALONE, which is exactly the
// condition a load-caused failure does not reproduce under. So the observational mechanism
// degrades to SILENCE here rather than flapping.
//
// THE DECLARATION IS THE CALL SITE. Nothing is registered and nothing is listed: a member says so
// by calling this, and stops being one by not calling it. That matters because the alternative —
// a roster derived by grep — is a function of WHO GREPPED. Measured: two independent censuses
// aimed at this same class, on one tree, on one day, agreed on ONE file out of seven and nine.
// A call site has no such degree of freedom; two readers cannot disagree about it.
//
// DELIBERATELY NOT HERE: any skip, retry, tolerance or slack. Every member keeps asserting the
// exact bound it asserts today and a genuine regression still reds. Adding tolerance here would
// silently weaken every declared assertion at once, which is the opposite of the point.
//
// FALSIFIER: test/a-wall-clock-bound-declares-itself.test.ts.

/**
 * Assert `measured < bound`, exactly as a bare `assert.ok(measured < bound, message)` would, and
 * declare the assertion wall-clock dependent.
 *
 * `measured` and `bound` share whatever unit the call site uses — milliseconds at most members,
 * minutes at the worktree-reap sites — so neither is named here; `message` is the call site's own
 * and is what a reader sees first.
 *
 * The added text is the whole benefit on failure: a red at one of these is otherwise
 * indistinguishable from a real regression, and the reader has to already know this class exists
 * to interpret it.
 */
export function assertWallClockBound(measured: number, bound: number, message: string): void {
  if (measured < bound) return;
  throw new AssertionError({
    message:
      `${message}\n` +
      `  WALL-CLOCK DEPENDENT (W1-T2811): this bounds a real elapsed measurement, so a loaded or ` +
      `oversubscribed host can fail it with no defect in the code under test. Re-run it on an idle ` +
      `host before treating it as a regression — if it reproduces there, it is real.`,
    actual: measured,
    expected: `< ${bound}`,
    operator: "assertWallClockBound",
  });
}
