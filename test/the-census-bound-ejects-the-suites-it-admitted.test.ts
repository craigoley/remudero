// test/the-census-bound-ejects-the-suites-it-admitted.test.ts — W1-T2545.
//
// THE DEFECT, MEASURED ON MAIN RATHER THAN ARGUED. `rmd preflight --fast` at origin/main
// 05dcb050, clean tree: `negative-reachability-census: BOUND EXCEEDED — took 2509ms`, own result
// "would have PASSed", whole gate FAIL. The gate a worker is told to run before its FIRST push
// was red for a reason no change caused. Two of the four census entries were over the 2000ms
// ceiling in the same container (960 / 1128 / 2344 / 2615ms), and on GitHub runners the same
// entry measured 2268ms and 2250ms while main's own `ci` passed — so the distribution STRADDLED
// the ceiling and which side a run landed on was decided by runner speed.
//
// WHY A BIGGER CONSTANT WOULD NOT HAVE BEEN A FIX. A census entry qualifies for this gate BECAUSE
// it walks the tracked `src/` population and asserts over every file in it, so its cost is a
// monotonic function of a corpus that only grows. Any fixed ceiling is a date at which the entry
// gets ejected — and ejection is silent where it matters, because `runPreflightFast` refuses the
// step, so the fast gate stops running a suite CI still enforces. That is the blindness W1-T2478
// existed to close, reintroduced by its own control.
//
// THE SHAPE OF THE FIX. A wall-clock number conflates how much work a suite does with how fast
// the machine is, and only the first is a property of the repo. The refusal is now measured
// against the SAME RUN's cheapest census entry: a slow machine slows every entry together, so the
// ratio is stable, while a suite doing several times the work of its siblings stands out on any
// machine. The soft bound survives as a REPORT, which is the warning an absolute ceiling could
// only ever deliver by failing the gate.
//
// EVERY TEST BELOW DRIVES `runPreflightFast` ITSELF through its own injectable seams (`spawn`,
// `now`, `steps`), never a re-implementation of its arithmetic — the falsifier for a wiring
// change has to run the wiring.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FAST_GATE_CENSUS_BOUND_MS,
  FAST_GATE_CENSUS_REFERENCE_FLOOR_MS,
  FAST_GATE_CENSUS_RUNAWAY_MULTIPLE,
  censusRunawayThresholdMs,
  runPreflightFast,
} from "../src/lib/ci-parity.js";

const PKG = JSON.stringify({ scripts: { "census:a": "x", "census:b": "x", "census:c": "x", plain: "x" } });

/** A `now` that returns each step's start and end in turn, so a fixture can dictate an elapsed
 *  time per step with no real slow spawn. */
function scriptedClock(elapsedPerStep: readonly number[]): () => number {
  let t = 0;
  let i = 0;
  return () => {
    // Called twice per timed step: once before the spawn, once after.
    const isStart = i % 2 === 0;
    i += 1;
    if (!isStart) return t; // the END read: the clock was already advanced by this step own cost
    const startedAt = t;
    t += elapsedPerStep[(i - 1) / 2] ?? 0;
    return startedAt;
  };
}

const okSpawn = () => ({ status: 0, stdout: "", stderr: "" });
const failSpawn = () => ({ status: 1, stdout: "", stderr: "the gate itself failed" });

function census(job: string, script: string) {
  return { job, script, reason: "census fixture", boundMs: FAST_GATE_CENSUS_BOUND_MS };
}

test("W1-T2545 criterion 1: a census entry over the soft bound that PASSES is reported and still counted as run, never refused", () => {
  // Exactly main's own situation: one entry well over 2000ms, its own command exiting zero.
  const r = runPreflightFast("/repo", {
    packageJsonText: PKG,
    spawn: okSpawn,
    now: scriptedClock([900, 2509]),
    steps: [census("a-census", "census:a"), census("b-census", "census:b")],
  });
  const over = r.steps.find((s) => s.name === "b-census")!;
  assert.equal(over.ok, true, "an entry that merely grew must not fail the gate");
  assert.match(over.detail, /COST 2509ms/, "its measured cost is reported, so growth is visible");
  assert.match(over.detail, /reported, not refused/);
  assert.doesNotMatch(over.detail, /BOUND EXCEEDED/, "the absolute-ceiling refusal is gone");
  assert.equal(r.ok, true, "and the gate as a whole passes — which it did not before this change");
});

test("W1-T2545 criterion 2: the bound is derived from the run's own measurements, not from a written constant", () => {
  // The SAME absolute cost is judged differently depending on the population it ran beside — the
  // property a constant cannot have. 4000ms passes beside a 1500ms sibling (ratio 2.7) and is
  // refused beside a 500ms one (ratio 8, floored reference 1000 -> threshold 4000... so 4001).
  const withSlowSibling = runPreflightFast("/repo", {
    packageJsonText: PKG,
    spawn: okSpawn,
    now: scriptedClock([1500, 4000]),
    steps: [census("a-census", "census:a"), census("b-census", "census:b")],
  });
  assert.equal(withSlowSibling.steps.find((s) => s.name === "b-census")!.ok, true);

  const withFastSibling = runPreflightFast("/repo", {
    packageJsonText: PKG,
    spawn: okSpawn,
    now: scriptedClock([200, 4001]),
    steps: [census("a-census", "census:a"), census("b-census", "census:b")],
  });
  assert.equal(
    withFastSibling.steps.find((s) => s.name === "b-census")!.ok,
    false,
    "identical cost, different population, different verdict — that is what 'derived' means here",
  );

  // And the derivation itself is a named, callable function rather than inline arithmetic.
  assert.equal(censusRunawayThresholdMs([]), undefined, "no census entries: no population, no invented bound");
  assert.equal(
    censusRunawayThresholdMs([200, 4001]),
    FAST_GATE_CENSUS_REFERENCE_FLOOR_MS * FAST_GATE_CENSUS_RUNAWAY_MULTIPLE,
    "a cheap outlier is floored, so it cannot make the ratio harsh for its siblings",
  );
  assert.equal(censusRunawayThresholdMs([1500, 4000]), 1500 * FAST_GATE_CENSUS_RUNAWAY_MULTIPLE);
});

test("W1-T2545 criterion 3: an entry whose own command FAILS is still a hard failure, cheap or not", () => {
  const r = runPreflightFast("/repo", {
    packageJsonText: PKG,
    spawn: failSpawn,
    now: scriptedClock([100, 100]),
    steps: [census("a-census", "census:a"), census("b-census", "census:b")],
  });
  assert.equal(r.ok, false, "the cost relaxation must never turn a red gate green");
  for (const s of r.steps) {
    assert.equal(s.ok, false);
    assert.doesNotMatch(s.detail, /RUNAWAY|reported, not refused/, "a real failure is reported as itself, never restated as a cost verdict");
  }
});

test("W1-T2545 criterion 4: a genuinely runaway entry is still refused, so the bound keeps a population to separate", () => {
  const r = runPreflightFast("/repo", {
    packageJsonText: PKG,
    spawn: okSpawn,
    now: scriptedClock([1000, 1200, 60000]),
    steps: [census("a-census", "census:a"), census("b-census", "census:b"), census("c-census", "census:c")],
  });
  const runaway = r.steps.find((s) => s.name === "c-census")!;
  assert.equal(runaway.ok, false);
  assert.match(runaway.detail, /RUNAWAY/);
  assert.match(runaway.detail, /60000ms/, "the refusal names the measurement that produced it");
  assert.match(runaway.detail, /would have PASSed/, "and is explicit that the command itself was fine");
  assert.equal(r.ok, false);
  // Its siblings are untouched — a refusal is per-entry, not a whole-class ejection.
  assert.equal(r.steps.find((s) => s.name === "a-census")!.ok, true);
  assert.equal(r.steps.find((s) => s.name === "b-census")!.ok, true);
});

test("W1-T2545 criterion 5: the fast gate passes on a tree whose census entries all pass — the case that was failing on main", () => {
  // The four real measurements taken on origin/main 05dcb050, in one container.
  const r = runPreflightFast("/repo", {
    packageJsonText: PKG,
    spawn: okSpawn,
    now: scriptedClock([960, 1128, 2344, 2615]),
    steps: [
      census("no-shallowing-census", "census:a"),
      census("bound-kind-census", "census:b"),
      census("catch-erasure-census", "census:c"),
      { job: "negative-reachability-census", script: "plain", reason: "census fixture", boundMs: FAST_GATE_CENSUS_BOUND_MS },
    ],
  });
  assert.equal(r.ok, true, "these exact numbers failed the gate before this change");
  // Both entries over the soft bound still say so, so the growth that produced this task stays
  // visible rather than being silently absorbed.
  for (const name of ["catch-erasure-census", "negative-reachability-census"]) {
    assert.match(r.steps.find((s) => s.name === name)!.detail, /COST \d+ms, over the 2000ms soft bound/);
  }
  // And the two under it say nothing extra.
  for (const name of ["no-shallowing-census", "bound-kind-census"]) {
    assert.doesNotMatch(r.steps.find((s) => s.name === name)!.detail, /COST|RUNAWAY/);
  }
});

test("W1-T2545: a non-census entry is untouched — no timing, no cost report, no ratio", () => {
  const r = runPreflightFast("/repo", {
    packageJsonText: PKG,
    spawn: okSpawn,
    now: scriptedClock([]),
    steps: [{ job: "plain-gate", script: "plain", reason: "no boundMs" }],
  });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.steps[0].detail, /COST|RUNAWAY|soft bound/);
});
