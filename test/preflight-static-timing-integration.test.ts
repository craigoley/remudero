// @census-reads: none — only the base-existing fast runner and disposable fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runPreflightFast } from "#src/lib/ci-parity.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const packageJsonText = JSON.stringify({ scripts: { first: "fixture", second: "fixture", third: "fixture" } });
const step = (job: string) => ({ job, script: job, reason: "diagnostic integration control" });

// Deliberately import no newly added helper: these proofs must reach assertions at base.
test("static timing integration attaches a non-training observation without changing the command", t => {
  const fixture = ownedFixtureDir(t, "static-timing-integration-pass");
  const values = [10, 12.2]; let reads = 0, calls = 0;
  const result = runPreflightFast(fixture.dir, {
    packageJsonText, steps: [step("first")], timingNow: () => values[reads++],
    now: () => { throw new Error("non-census command must not use pricing clock"); },
    spawn: (file, args, opts) => {
      calls++; assert.equal(file, "npm"); assert.deepEqual(args, ["run", "--silent", "first"]);
      assert.equal(opts?.cwd, fixture.dir);
      return { status: 0, stdout: "original-output", stderr: "" };
    },
  });
  assert.equal(calls, 1); assert.equal(result.ok, true); assert.equal(result.steps[0].ok, true);
  const timing = result.steps[0].staticTiming;
  assert.ok(timing, "the existing fast runner must attach its own observed diagnostic");
  assert.equal(reads, 2); assert.equal(timing.durationMs, 3);
  assert.equal(timing.scope, "direct-synchronous-spawn-wall"); assert.equal(timing.trainingEligible, false);
  assert.deepEqual(timing.attempts.map(row => [row.phase, row.status, row.outcome]), [["initial", 0, "returned"]]);
});

test("static timing integration retains failed and thrown commands and executes later checks", t => {
  const fixture = ownedFixtureDir(t, "static-timing-integration-fail"), calls: string[] = [];
  const values = [0, 1, 1, 4, 4, 9]; let reads = 0;
  const result = runPreflightFast(fixture.dir, {
    packageJsonText, steps: [step("first"), step("second"), step("third")], timingNow: () => values[reads++],
    spawn: (_file, args) => {
      const job = args.at(-1)!; calls.push(job);
      if (job === "first") return { status: 7, stdout: "", stderr: "original failure" };
      if (job === "second") throw new Error("original toolchain refusal");
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(calls, ["first", "second", "third"]);
  assert.deepEqual(result.steps.map(row => row.ok), [false, false, true]); assert.equal(result.ok, false);
  assert.match(result.steps[0].detail, /original failure/); assert.match(result.steps[1].detail, /original toolchain refusal/);
  assert.deepEqual(result.steps.map(row => row.staticTiming?.durationMs), [1, 3, 5]);
  assert.deepEqual(result.steps.map(row => row.staticTiming?.attempts[0].outcome), ["returned", "threw", "returned"]);
});

test("static timing integration represents unavailable clocks as unknown without failing a clean check", t => {
  const fixture = ownedFixtureDir(t, "static-timing-integration-clock"); let calls = 0, reads = 0;
  const result = runPreflightFast(fixture.dir, {
    packageJsonText, steps: [step("first")], timingNow: () => { reads++; throw new Error("diagnostic clock unavailable"); },
    spawn: () => { calls++; return { status: 0, stdout: "", stderr: "" }; },
  });
  assert.equal(calls, 1); assert.equal(result.ok, true); assert.equal(result.steps[0].ok, true);
  const timing = result.steps[0].staticTiming;
  assert.ok(timing, "an unavailable clock must remain an explicit diagnostic observation");
  assert.equal(reads, 2); assert.equal(timing.durationMs, null); assert.equal(timing.trainingEligible, false);
  assert.deepEqual(timing.attempts.map(row => [row.durationMs, row.outcome, row.status]), [[null, "returned", 0]]);
});
