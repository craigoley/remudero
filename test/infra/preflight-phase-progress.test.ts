import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { observeSynchronousPreflightPhase, reportPreflightPhase, type PreflightPhaseEvent } from "#src/lib/preflight-phase-progress.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

test("preflight phase observation preserves result identity and has a quiet unobserved path", () => {
  const result = {ok: false}, events: Readonly<PreflightPhaseEvent>[] = [];
  let calls = 0;
  assert.equal(observeSynchronousPreflightPhase("quiet", () => {calls++; return result;}), result);
  const values = [2, 4.2];
  assert.equal(observeSynchronousPreflightPhase("observed", () => {calls++; return result;}, e => events.push(e), clockFromMillisFn(() => values.shift()!)), result);
  assert.equal(calls, 2);
  assert.deepEqual(events.map(e => [e.event, e.durationMs]), [["started", null], ["returned", 3]]);
  assert(events.every(e => Object.isFrozen(e) && e.trainingEligible === false));
  assert.deepEqual(Object.keys(events[0]).sort(), ["durationMs", "event", "phase", "phaseId", "step", "trainingEligible"]);
});

test("preflight phase observation preserves thrown errors and primitive refusals", () => {
  for (const thrown of [new Error("original refusal"), "primitive refusal", undefined]) {
    const events: Readonly<PreflightPhaseEvent>[] = [];
    let caught = false;
    try { observeSynchronousPreflightPhase("throws", () => {throw thrown;}, e => events.push(e)); }
    catch (error) {caught = true; assert.equal(error, thrown);}
    assert(caught);
    assert.deepEqual(events.map(e => e.event), ["started", "threw"]);
  }
});

test("preflight phase observation isolates broken synchronous asynchronous and thenable sinks", async () => {
  const result = {};
  for (const report of [() => {throw new Error("sink failure");}, async () => {throw new Error("async sink failure");},
    () => Object.defineProperty({}, "then", {get() {throw new Error("thenable failure");}})]) {
    let calls = 0;
    assert.equal(observeSynchronousPreflightPhase("sink", () => {calls++; return result;}, report), result);
    assert.equal(calls, 1);
  }
  await delay(0);
});

test("preflight phase observation keeps missing reversed and overflowing timings unknown", () => {
  for (const values of [[NaN, 1], [0, Infinity], [4, 3], [0, Number.MAX_VALUE]]) {
    const events: Readonly<PreflightPhaseEvent>[] = [];
    observeSynchronousPreflightPhase("clock", () => 7, e => events.push(e), clockFromMillisFn(() => values.shift()!));
    assert.equal(events[1].durationMs, null);
  }
  for (const failAt of [0, 1]) {
    let reads = 0;
    const events: Readonly<PreflightPhaseEvent>[] = [];
    observeSynchronousPreflightPhase("clock-error", () => 7, e => events.push(e), clockFromMillisFn(() => {
      if (reads++ === failAt) throw new Error("clock unavailable"); return 1;
    }));
    assert.equal(events[1].durationMs, null);
  }
  const events: Readonly<PreflightPhaseEvent>[] = [];
  observeSynchronousPreflightPhase("zero", () => 7, e => events.push(e), clockFromMillisFn(() => 0));
  assert.equal(events[1].durationMs, 0);
});

test("preflight nested phases retain unique paired identities and execute once", () => {
  const events: Readonly<PreflightPhaseEvent>[] = [];
  let calls = 0;
  observeSynchronousPreflightPhase("outer", () => observeSynchronousPreflightPhase("inner", () => {calls++;}, e => events.push(e)), e => events.push(e));
  assert.equal(calls, 1);
  assert.deepEqual(events.map(e => [e.phase, e.event]), [["outer", "started"], ["inner", "started"], ["inner", "returned"], ["outer", "returned"]]);
  assert.equal(events[0].phaseId, events[3].phaseId);
  assert.equal(events[1].phaseId, events[2].phaseId);
  assert.notEqual(events[0].phaseId, events[1].phaseId);
});

test("preflight phase default clock and reporter run around an actual synchronous child", () => {
  const events: Readonly<PreflightPhaseEvent>[] = [];
  const result = observeSynchronousPreflightPhase("native-child", () => spawnSync(process.execPath, ["-e", "process.exit(7)"], {timeout: 5000}), e => events.push(e));
  assert.equal(result.status, 7);
  assert.equal(events[1].event, "returned", "returned is not a passing verdict");
  assert(events[1].durationMs !== null && events[1].durationMs >= 0);
  reportPreflightPhase(events[1]);
});

test("preflight default progress is visible while a release-gated native phase is still running", async t => {
  const fixture = ownedFixtureDir(t, "preflight-phase-visibility");
  const started = join(fixture.dir, "started"), release = join(fixture.dir, "release"), script = join(fixture.dir, "child.mjs");
  const moduleUrl = new URL("../../src/lib/preflight-phase-progress.ts", import.meta.url).href;
  writeFileSync(script, `import {writeFileSync, existsSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {observeSynchronousPreflightPhase, reportPreflightPhase} from ${JSON.stringify(moduleUrl)};
observeSynchronousPreflightPhase('native-visibility', () => {
  writeFileSync(${JSON.stringify(started)}, 'started');
  const deadline = performance.now() + 5000;
  while (!existsSync(${JSON.stringify(release)})) {
    if (performance.now() >= deadline) throw new Error('release not received');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}, reportPreflightPhase);
`);
  const child = spawn(process.execPath, ["--import", "tsx", script], {stdio: ["ignore", "pipe", "pipe"]});
  let stderr = "", closed = false;
  child.stdout.resume(); child.stderr.on("data", chunk => {stderr += String(chunk);});
  const ended = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => {closed = true; resolve(code);});
  });
  fixture.until(ended);
  try {
    const deadline = Date.now() + 8000;
    while (!(stderr.includes('"event":"started"') && existsSync(started)) && !closed && Date.now() < deadline) await delay(10);
    assert(stderr.includes('"event":"started"'), "start event must arrive before release, not after completion");
    assert(existsSync(started)); assert.equal(closed, false); assert.equal(child.exitCode, null);
    assert(!stderr.includes('"event":"returned"'));
    writeFileSync(release, "release");
    assert.equal(await ended, 0);
    assert(stderr.includes('"event":"returned"'));
  } finally {
    if (!closed) {writeFileSync(release, "release"); child.kill("SIGTERM"); await ended;}
  }
});
