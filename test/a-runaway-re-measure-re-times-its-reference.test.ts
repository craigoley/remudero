// test/a-runaway-re-measure-re-times-its-reference.test.ts — W1-T5676.
//
// THE DEFECT, OBSERVED 2026-10-04. `runPreflightFast` re-measures a census entry that crossed its
// runaway bound, but compared that re-measure with pass one's median — a reference fixed at
// pass-one load while the re-measure ran at whatever load the host had THEN.
// negative-reachability-census re-measured 4897ms against ceil(4440 x 1.1) = 4884ms and was
// refused as RUNAWAY although its own command passed. The fix re-times the median-cost entry
// back to back with the crossing entry, so both figures of the ratio share one load.
//
// Every case drives `runPreflightFast` itself through its `spawn`/`now`/`steps` seams.

import assert from "node:assert/strict";
import { test } from "node:test";
import { FAST_GATE_CENSUS_BOUND_MS, runPreflightFast } from "../src/lib/ci-parity.js";

const PKG = JSON.stringify({ scripts: { "census:a": "x", "census:b": "x", "census:c": "x" } });

/** A `now` that hands each timed spawn its scripted elapsed time, in call order. */
function scriptedClock(elapsedPerTimedSpawn: readonly number[]): () => number {
  let t = 0;
  let reads = 0;
  return () => {
    const isStart = reads % 2 === 0;
    const spawnIndex = Math.floor(reads / 2);
    reads += 1;
    if (!isStart) return t;
    const startedAt = t;
    t += elapsedPerTimedSpawn[spawnIndex] ?? 0;
    return startedAt;
  };
}

function census(job: string, script: string) {
  return { job, script, reason: "census fixture", boundMs: FAST_GATE_CENSUS_BOUND_MS };
}

const STEPS = [census("a-census", "census:a"), census("b-census", "census:b"), census("c-census", "census:c")];

function run(elapsed: readonly number[]) {
  const calls: string[] = [];
  const result = runPreflightFast("/repo", {
    packageJsonText: PKG,
    spawn: (_file, args) => {
      calls.push(args[args.length - 1]!);
      return { status: 0, stdout: "", stderr: "" };
    },
    now: scriptedClock(elapsed),
    steps: STEPS,
  });
  return { result, calls, c: result.steps.find((s) => s.name === "c-census")! };
}

test("a 2x host slowdown during the re-measure passes when the reference is re-timed at the same load", () => {
  // Pass one: median 1050ms, bound 4200ms; c crosses at 4300ms. Then the host doubles in cost:
  // c re-measures at 8400ms and the median-cost entry b, re-timed beside it, at 2100ms.
  const { result, calls, c } = run([900, 1050, 4300, 8400, 2100]);
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /RE-MEASURED: 4300ms crossed the 4200ms runaway bound once; one re-run took 8400ms/);
  assert.match(c.detail, /b-census re-timed back to back at 2100ms/, "the pass names the re-timed reference");
  assert.match(c.detail, /within the 9240ms confirmation margin/, "4 x 2100ms x 1.1, not pass one's 4620ms");
  assert.deepEqual(calls, ["census:a", "census:b", "census:c", "census:c", "census:b"],
    "the crossing entry and then the median-cost entry are re-timed back to back; a is never re-run");
  assert.equal(result.ok, true);
});

test("a census costing 10x its re-timed reference is still refused as RUNAWAY, naming both figures", () => {
  const { result, c } = run([900, 1000, 4500, 10000, 1000]);
  assert.equal(c.ok, false);
  assert.match(c.detail, /RUNAWAY — npm run --silent census:c took 4500ms then 10000ms on one re-measure, the re-measure over 4400ms/);
  assert.match(c.detail, /b-census re-timed back to back at 1000ms/, "the refusal names the re-timed reference");
  assert.match(c.detail, /would have PASSed/);
  assert.equal(result.ok, false);
});

test("a re-timed reference under the floor is floored, so a fast reference cannot make the ratio harsh", () => {
  // The reference re-times at 300ms; floored at 1000ms the confirmation bound is 4400ms, so a
  // 4300ms re-measure passes where an unfloored 300ms reference (1320ms) would refuse it.
  const { c } = run([900, 1000, 4500, 4300, 300]);
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /within the 4400ms confirmation margin/);
});
