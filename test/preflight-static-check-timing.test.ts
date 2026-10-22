import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createStaticCheckTiming } from "#src/lib/preflight-step-timing.js";
import { clockFromMillisFn, type Clock } from "#src/lib/clock.js";
import { buildPreflightSummary, runPreflightFast } from "#src/lib/ci-parity.js";
import type { PreflightSpawn } from "#src/lib/commit-message.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const clean = () => ({ status: 0, stdout: "", stderr: "" });
const packageJsonText = JSON.stringify({ name: "remudero", scripts: { first: "fixture", second: "fixture", third: "fixture" } });
const step = (job: string) => ({ job, script: job, reason: "timing control only" });
function ticks(values: number[]) {
  let calls = 0;
  return { now: () => { const index = calls++; assert(index < values.length, "unexpected clock read"); return values[index]; }, calls: () => calls };
}

test("static timing real default preserves successful and nonzero Node child output and status", () => {
  const timer = createStaticCheckTiming();
  const pass = timer.wrap("initial")(process.execPath, ["-e", "console.log('positive-control')"]);
  const fail = timer.wrap("remeasure")(process.execPath, ["-e", "console.error('negative-control');process.exit(7)"]);
  assert.equal(pass.status, 0); assert.match(pass.stdout, /positive-control/);
  assert.equal(fail.status, 7); assert.match(fail.stderr, /negative-control/);
  const snapshot = timer.snapshot();
  assert.deepEqual(snapshot.attempts.map(x => x.status), [0, 7]);
  assert(snapshot.attempts.every(x => x.outcome === "returned" && x.durationMs !== null && x.durationMs >= 0));
  assert.equal(snapshot.trainingEligible, false);
});

test("static timing real default records ENOENT without turning it into success", t => {
  const fixture = ownedFixtureDir(t, "static-timing-missing");
  const timer = createStaticCheckTiming();
  const result = timer.wrap("initial")(join(fixture.dir, "never-created-binary"), []);
  assert.equal(result.status, null); assert.match(result.error ?? "", /ENOENT/);
  const row = timer.snapshot().attempts[0];
  assert.equal(row.status, null); assert.equal(row.spawnError, true); assert.equal(row.outcome, "returned");
});

test("static timing forwards the original args options and result object without changes", () => {
  const args = ["literal"], opts = { cwd: "/fixture-only", input: "payload" }, result = { status: 9, stdout: "out", stderr: "err" };
  const clock = ticks([10, 14.2]);
  const spawn: PreflightSpawn = (file, a, o) => { assert.equal(file, "fixture"); assert.equal(a, args); assert.equal(o, opts); return result; };
  const timer = createStaticCheckTiming(spawn, clockFromMillisFn(clock.now));
  assert.equal(timer.wrap("reference", "requester")("fixture", args, opts), result);
  assert.equal(timer.snapshot().durationMs, 5);
  assert.equal(timer.snapshot().attempts[0].requestedBy, "requester");
  assert.equal(clock.calls(), 2);
});

test("static timing records a thrown seam and rethrows the identical Error or primitive", () => {
  for (const thrown of [new Error("spawn refused"), "primitive refusal", undefined]) {
    const clock = ticks([0, 3]);
    const timer = createStaticCheckTiming(() => { throw thrown; }, clockFromMillisFn(clock.now));
    let caught = false;
    try { timer.wrap("initial")("fixture", []); } catch (value) { caught = true; assert.equal(value, thrown); }
    assert.equal(caught, true);
    assert.deepEqual(timer.snapshot().attempts.map(x => [x.outcome, x.status, x.durationMs]), [["threw", null, 3]]);
  }
});

test("static timing catches each clock read failure without changing the command result", () => {
  for (const failAt of [0, 1]) {
    let reads = 0, commands = 0;
    const now = () => { if (reads++ === failAt) throw new Error("clock unavailable"); return 10; };
    const result = clean(), timer = createStaticCheckTiming(() => { commands++; return result; }, clockFromMillisFn(now));
    assert.equal(timer.wrap("initial")("fixture", []), result);
    assert.equal(commands, 1); assert.equal(reads, 2);
    assert.equal(timer.snapshot().attempts[0].durationMs, null);
    assert.equal(timer.snapshot().durationMs, null);
  }
});

test("static timing invalid clocks remain unknown while a measured zero remains explicit", () => {
  for (const values of [[NaN, 1], [1, Infinity], [4, 3], [0, Number.MAX_VALUE]]) {
    const clock = ticks(values), timer = createStaticCheckTiming(clean, clockFromMillisFn(clock.now));
    timer.wrap("initial")("fixture", []); assert.equal(timer.snapshot().durationMs, null);
  }
  const clock = ticks([0, 0]), timer = createStaticCheckTiming(clean, clockFromMillisFn(clock.now));
  timer.wrap("initial")("fixture", []);
  assert.equal(timer.snapshot().durationMs, 0); assert.equal(timer.snapshot().attempts.length, 1);
  assert.equal(timer.snapshot().trainingEligible, false);
});

test("static timing empty and detached snapshots cannot invent or mutate observations", () => {
  const timer = createStaticCheckTiming(clean, clockFromMillisFn(ticks([0, 3, 3, 7]).now));
  assert.equal(timer.snapshot().durationMs, null); assert.deepEqual(timer.snapshot().attempts, []);
  timer.wrap("initial")("fixture", []); const first = timer.snapshot();
  first.attempts[0].durationMs = 999; first.attempts.length = 0;
  timer.wrap("reference", "slow")("fixture", []);
  assert.deepEqual(timer.snapshot().attempts.map(x => x.durationMs), [3, 4]);
  assert.equal(timer.snapshot().durationMs, 7);
  const huge = createStaticCheckTiming(clean, clockFromMillisFn(ticks([0, Number.MAX_SAFE_INTEGER, 0, 1]).now));
  huge.wrap("initial")("fixture", []); huge.wrap("reference")("fixture", []);
  assert.deepEqual(huge.snapshot().attempts.map(x => x.durationMs), [Number.MAX_SAFE_INTEGER, 1]);
  assert.equal(huge.snapshot().durationMs, null, "overflow is unknown, never a rounded total");
});

test("static timing reads the shared Clock port without date or ISO projections", () => {
  let reads = 0;
  const clock: Clock = {
    now: () => [7, 10][reads++],
    date: () => { throw new Error("diagnostics must not request epoch projection"); },
    iso: () => { throw new Error("diagnostics must not request ISO projection"); },
  };
  const timer = createStaticCheckTiming(clean, clock);
  timer.wrap("initial")("fixture", []);
  assert.equal(reads, 2);
  assert.equal(timer.snapshot().durationMs, 3);
  assert.equal(timer.snapshot().trainingEligible, false);
});

test("fast static timing missing and skipped commands are absent not zero cost passes", t => {
  const fixture = ownedFixtureDir(t, "static-timing-skips");
  const result = runPreflightFast(fixture.dir, {
    packageJsonText: JSON.stringify({ name: "remudero", scripts: {} }),
    spawn: () => { assert.fail("no command may run"); },
    steps: [{ ...step("missing") }, { ...step("skipped"), skipWhenAbsent: "no-directory" }],
  });
  assert.deepEqual(result.steps.map(x => x.ok), [false, true]);
  assert.match(result.steps[0].detail, /SCRIPT MISSING/); assert.match(result.steps[1].detail, /SKIPPED/);
  for (const row of result.steps) {
    assert.ok(row.staticTiming); assert.equal(row.staticTiming.durationMs, null);
    assert.deepEqual(row.staticTiming.attempts, []); assert.equal(row.staticTiming.trainingEligible, false);
  }
});

test("fast static timing records pass fail throw and later checks without changing outcomes", t => {
  const fixture = ownedFixtureDir(t, "static-timing-outcomes"), calls: string[] = [];
  const result = runPreflightFast(fixture.dir, {
    packageJsonText, steps: [step("first"), step("second"), step("third")],
    now: () => { throw new Error("non-census must not read pricing clock"); },
    timingNow: ticks([0, 1, 1, 4, 4, 9]).now,
    spawn: (_file, args) => {
      const name = args.at(-1)!; calls.push(name);
      if (name === "first") return { status: 7, stdout: "", stderr: "original failure" };
      if (name === "second") throw new Error("toolchain refused");
      return clean();
    },
  });
  assert.deepEqual(calls, ["first", "second", "third"]);
  assert.deepEqual(result.steps.map(x => x.ok), [false, false, true]); assert.equal(result.ok, false);
  assert.match(result.steps[0].detail, /original failure/); assert.match(result.steps[1].detail, /toolchain unavailable: toolchain refused/);
  assert.deepEqual(result.steps.map(x => x.staticTiming?.durationMs), [1, 3, 5]);
  assert.deepEqual(result.steps.map(x => x.staticTiming?.attempts[0].outcome), ["returned", "threw", "returned"]);
});

test("fast static timing covers both custom runners while retaining UNMEASURED exit two", t => {
  const fixture = ownedFixtureDir(t, "static-timing-runners"), calls: string[][] = [];
  const result = runPreflightFast(fixture.dir, {
    packageJsonText,
    steps: [{ ...step("rules"), runner: "rule-checks" }, { ...step("census"), runner: "census-precheck" }],
    timingNow: ticks([0, 2, 2, 5]).now,
    spawn: (_file, args) => { calls.push(args); return { status: args.includes("scripts/census-precheck.mjs") ? 2 : 0, stdout: "", stderr: "" }; },
  });
  assert.deepEqual(calls, [["--import", "tsx", "scripts/list-rule-suites.mjs", "--run"], ["scripts/census-precheck.mjs", "--base", "origin/main"]]);
  assert.equal(result.ok, true); assert.match(result.steps[1].detail, /UNMEASURED/);
  assert.equal(result.steps[1].staticTiming?.attempts[0].status, 2);
  assert.deepEqual(result.steps.map(x => x.staticTiming?.durationMs), [2, 3]);
});

test("fast static timing retains initial remeasure and reference without extra legacy clock reads", t => {
  const fixture = ownedFixtureDir(t, "static-timing-remeasure"), calls: string[] = [];
  const clock = ticks([0, 1000, 1000, 2000, 2000, 32000, 32000, 62000, 62000, 63000]);
  let diagnostic = 0;
  const result = runPreflightFast(fixture.dir, {
    packageJsonText, steps: [step("first"), step("second"), step("third")].map(x => ({ ...x, boundMs: 2000 })),
    now: clock.now, timingNow: () => diagnostic++,
    spawn: (_file, args) => { calls.push(args.at(-1)!); return clean(); },
  });
  assert.equal(clock.calls(), 10); assert.deepEqual(calls, ["first", "second", "third", "third", "second"]);
  assert.equal(result.ok, false); assert.match(result.steps[2].detail, /RUNAWAY/);
  assert.deepEqual(result.steps.map(x => x.staticTiming?.attempts.map(a => a.phase)), [["initial"], ["initial", "reference"], ["initial", "remeasure"]]);
  assert.equal(result.steps[1].staticTiming?.attempts[1].requestedBy, "third");
  assert.deepEqual(result.steps.map(x => x.staticTiming?.durationMs), [1, 2, 2]);
});

test("fast static timing retains the first attempt when a census remeasure throws", t => {
  const fixture = ownedFixtureDir(t, "static-timing-remeasure-error");
  const clock = ticks([0, 1000, 1000, 2000, 2000, 32000, 32000]); let slowCalls = 0;
  const result = runPreflightFast(fixture.dir, {
    packageJsonText, steps: [step("first"), step("second"), step("third")].map(x => ({ ...x, boundMs: 2000 })),
    now: clock.now,
    spawn: (_file, args) => { if (args.at(-1) === "third" && slowCalls++ > 0) throw new Error("second attempt refused"); return clean(); },
  });
  assert.equal(result.ok, false); assert.match(result.steps[2].detail, /second attempt refused/);
  assert.deepEqual(result.steps[2].staticTiming?.attempts.map(a => a.outcome), ["returned", "threw"]);
  assert.equal(result.steps[1].staticTiming?.attempts.length, 1); assert.equal(clock.calls(), 7);
});

test("fast static timing survives durable summary serialization without changing its verdict", t => {
  const fixture = ownedFixtureDir(t, "static-timing-summary");
  const fast = runPreflightFast(fixture.dir, { packageJsonText, steps: [step("first")], spawn: () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "" }), timingNow: ticks([1, 6]).now });
  const summary = buildPreflightSummary({ steps: fast.steps, headSha: "a".repeat(40), finishedAt: "2026-10-17T00:00:00.000Z", durationMs: 8, args: [] });
  const saved = JSON.parse(JSON.stringify(summary));
  assert.equal(saved.ok, false); assert.equal(saved.failed, 1); assert.equal(saved.passed, 0);
  assert.ok(saved.steps[0].staticTiming);
  assert.equal(saved.steps[0].staticTiming.durationMs, 5);
  assert.equal(saved.steps[0].staticTiming.attempts[0].signal, "SIGTERM");
  assert.equal(saved.steps[0].staticTiming.trainingEligible, false);
});

test("static timing clock failures cannot replace the original spawn throw", () => {
  const original = new Error("original spawn failure"); let reads = 0;
  const timer = createStaticCheckTiming(
    () => { throw original; },
    clockFromMillisFn(() => { reads++; throw new Error("diagnostic clock failure"); }),
  );
  assert.throws(() => timer.wrap("initial")("fixture", []), error => error === original);
  assert.equal(reads, 2);
  const saved = timer.snapshot();
  assert.equal(saved.durationMs, null); assert.equal(saved.trainingEligible, false);
  assert.equal(saved.attempts.length, 1); assert.equal(saved.attempts[0].outcome, "threw");
  assert.equal(saved.attempts[0].status, null); assert.equal(saved.attempts[0].durationMs, null);
});

test("fast static timing real default runner preserves argv status and independent monotonic timing", t => {
  const fixture = ownedFixtureDir(t, "static-timing-real-runner");
  mkdirSync(join(fixture.dir, "scripts"));
  for (const status of [0, 7]) {
    writeFileSync(join(fixture.dir, "scripts", "census-precheck.mjs"), [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('observed-argv.json', JSON.stringify(process.argv.slice(2)));",
      "console.log('real-direct-runner-positive-control');",
      "process.exit(" + status + ");",
    ].join("\n") + "\n");
    // No injected spawn/timingNow: exercise both real production defaults in the
    // actual fast-runner path, but never a real repository census or npm install.
    const result = runPreflightFast(fixture.dir, {
      packageJsonText: JSON.stringify({ name: "remudero", scripts: {} }),
      steps: [{ job: "real-default", script: "unused", runner: "census-precheck", reason: "real default seam" }],
      now: () => { assert.fail("the custom runner must not consume the census-pricing clock"); },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.dir, "observed-argv.json"), "utf8")), ["--base", "origin/main"]);
    assert.equal(result.ok, status === 0); assert.equal(result.steps[0].ok, status === 0);
    const timing = result.steps[0].staticTiming;
    assert.ok(timing); assert.equal(timing.scope, "direct-synchronous-spawn-wall");
    assert.equal(timing.trainingEligible, false); assert.equal(timing.attempts.length, 1);
    assert.equal(timing.attempts[0].phase, "initial"); assert.equal(timing.attempts[0].outcome, "returned");
    assert.equal(timing.attempts[0].status, status); assert.equal(timing.attempts[0].signal, null);
    assert.equal(timing.attempts[0].spawnError, false);
    assert(timing.durationMs !== null && timing.durationMs >= 0);
    if (status !== 0) assert.match(result.steps[0].detail, /real-direct-runner-positive-control/);
  }
});
