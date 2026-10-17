import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { boundedGardenPassSpawn, childGardenPassSpawn, GARDEN_PASS_STEP, startGardenOffLoop, type GardenPassOutcome, type GardenPassSpawn } from "#src/lib/garden-registry.js";
import type { GardenerRuntimeEvent } from "#src/lib/gardener-runtime.js";
import type { HostMemoryBudgetPolicy } from "#src/lib/host-memory-shadow.js";
import { GARDENER_ORIGIN_ENV } from "#src/lib/worker-containment.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function observation() {
  const events: GardenerRuntimeEvent[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const terminal = deferred<void>();
  return { events, rows, terminal,
    observe(event: GardenerRuntimeEvent) {
      events.push(event);
      if (["completed", "failed", "cancelled", "idle"].includes(event.phase)) terminal.resolve();
    },
    log(step: string, fields?: Record<string, unknown>) { rows.push({ step, ...fields }); },
  };
}

// Private child probes use a local policy port, not the host's admission store, credentials or services.
const fixturePolicy: HostMemoryBudgetPolicy = { mode: "off", hostReserveMib: 0, containerReserveMib: 0,
  swapInPagesPerSecMax: 0, psiSomeAvg10Max: 0, psiFullAvg10Max: 0, serveColdStartReserveMib: 0,
  uncertaintyMarginMib: 0, daemonGrowthUnmeasuredMib: 0, daemonGrowthMinSamples: 0, staleReadingMs: 0 };

async function privateChild(t: TestContext, source = "") {
  const root = await mkdtemp(join(tmpdir(), "rmd-garden-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "pass.mjs");
  await writeFile(entry, source);
  const options = { execArgv: [], entry, cwd: root, root, reserve: () => undefined,
    admission: { policy: () => fixturePolicy }, log: () => {} };
  return { root, entry, options };
}

test("W1-T10033: a garden waiting for memory is queued until its child starts", async t => {
  const admission = deferred<void>(), finish = deferred<GardenPassOutcome>(), observed = observation();
  const spawnPass = boundedGardenPassSpawn(async (_name, _args, signal) => {
    await admission.promise;
    signal.admitted?.(); // Explicit successful-process simulation, not pool ownership.
    return finish.promise;
  }, 1);
  const garden = startGardenOffLoop("plan", 60_000, { spawnPass, ...observed });
  t.after(() => { garden.stop(); admission.resolve(); finish.resolve(0); });
  await setImmediate();
  assert.deepEqual(observed.events.map(e => e.phase), ["queued"]);
  assert.equal(observed.events[0]!.executionMs, null);
  admission.resolve(); await setImmediate();
  assert.deepEqual(observed.events.map(e => e.phase), ["queued", "running"]);
  finish.resolve(0); await observed.terminal.promise;
  assert.equal(observed.events.at(-1)!.phase, "completed");
});

test("W1-T10033: queue timing ends at the successful child spawn", async t => {
  let now = Date.now();
  const clock = clockFromMillisFn(() => now), admission = deferred<void>(), finish = deferred<GardenPassOutcome>(), observed = observation();
  let signalSeen: Parameters<GardenPassSpawn>[2] | undefined;
  const spawnPass = boundedGardenPassSpawn(async (_name, _args, signal) => {
    signalSeen = signal;
    await admission.promise;
    signal.admitted?.();
    return finish.promise;
  }, 1);
  const garden = startGardenOffLoop("plan", 60_000, { spawnPass, clock, ...observed });
  t.after(() => { garden.stop(); admission.resolve(); finish.resolve(0); });
  await setImmediate(); now += 300_000;
  admission.resolve(); await setImmediate(); now += 125;
  signalSeen!.admitted?.(); // Duplicate notifications cannot reset the execution clock.
  finish.resolve(0); await observed.terminal.promise;
  const pass = observed.rows.find(r => r.step === GARDEN_PASS_STEP)!;
  assert.equal(pass.queueMs, 300_000); assert.equal(pass.executionMs, 125); assert.equal(pass.ms, 300_125);
  assert.equal(observed.events.filter(e => e.phase === "running").length, 1);
  assert.ok(observed.events.every(e => e.passId === pass.passId));
  const beforeLate = observed.events.length;
  signalSeen!.admitted?.();
  assert.equal(observed.events.length, beforeLate, "a settled pass cannot become running again");
});

test("W1-T10033: the real default child reports one process start", { timeout: 10_000 }, async t => {
  const fixture = await privateChild(t,
    `import {writeFileSync} from 'node:fs';writeFileSync('origin.json',process.env[${JSON.stringify(GARDENER_ORIGIN_ENV)}]);`);
  const spawnPass = childGardenPassSpawn(fixture.options);
  let directStarts = 0;
  const directPass = "2fe548f4-ffae-4153-8f1d-3a8662d3f98c";
  assert.equal(await spawnPass("plan", [], { stopped: false, passId: directPass, admitted: () => { directStarts++; } }), 0);
  assert.equal(directStarts, 1, "the real child, without a pool, supplies the successful spawn notification");
  const observed = observation();
  const garden = startGardenOffLoop("plan", 60_000, { spawnPass: boundedGardenPassSpawn(spawnPass, 1), ...observed });
  t.after(() => garden.stop()); await observed.terminal.promise;
  assert.deepEqual(observed.events.map(e => e.phase), ["queued", "running", "completed"]);
  const parent = observed.events.at(-1)!;
  assert.ok(parent.passId && parent.passId !== directPass);
  assert.ok(observed.events.every(e => e.passId === parent.passId));
  assert.deepEqual(JSON.parse(await readFile(join(fixture.root, "origin.json"), "utf8")),
    { version: 1, name: "plan", passId: parent.passId });
  assert.equal(observed.rows.find(r => r.step === GARDEN_PASS_STEP)!.passId, parent.passId);
  assert.equal(parent.exit, 0); assert.notEqual(parent.executionMs, null);
});

test("W1-T10033: a pass that never spawns never claims execution", async t => {
  for (const outcome of [{ kind: "deferred", reason: "memory-budget-shortfall" }, null] as const) {
    const observed = observation();
    const garden = startGardenOffLoop("plan", 60_000, {
      spawnPass: boundedGardenPassSpawn(async () => outcome, 1), ...observed });
    t.after(() => garden.stop()); await observed.terminal.promise;
    assert.equal(observed.events.some(e => e.phase === "running"), false);
    assert.equal(observed.events.at(-1)!.executionMs, null);
    assert.equal(observed.rows.find(r => r.step === GARDEN_PASS_STEP)!.executionMs, null);
  }
  const finish = deferred<GardenPassOutcome>(), starts: string[] = [];
  const spawnPass = boundedGardenPassSpawn(async (name, _args, signal) => {
    starts.push(name); signal.admitted?.(); return finish.promise;
  }, 1);
  const first = observation(), second = observation();
  const plan = startGardenOffLoop("plan", 60_000, { spawnPass, ...first });
  const gate = startGardenOffLoop("gate", 60_000, { spawnPass, ...second });
  t.after(() => { plan.stop(); gate.stop(); finish.resolve(0); });
  await setImmediate();
  assert.deepEqual(first.events.map(e => e.phase), ["queued", "running"]);
  assert.deepEqual(second.events.map(e => e.phase), ["queued"], "a real pool wait remains queued");
  gate.stop(); finish.resolve(0); await first.terminal.promise; await second.terminal.promise;
  assert.deepEqual(starts, ["plan"], "a cancelled queued pass never reaches the inner process producer");
  assert.equal(second.events.at(-1)!.executionMs, null);
});

test("a real failed garden spawn has no start or execution while a nonzero child does", { timeout: 10_000 }, async t => {
  const fixture = await privateChild(t, "process.exitCode = 7;");
  const failed = observation();
  const garden = startGardenOffLoop("plan", 60_000, { ...failed,
    spawnPass: boundedGardenPassSpawn(childGardenPassSpawn({ ...fixture.options, execPath: join(fixture.root, "no-executable") }), 1) });
  t.after(() => garden.stop()); await failed.terminal.promise;
  assert.deepEqual(failed.events.map(e => e.phase), ["queued", "failed"]);
  assert.equal(failed.events.at(-1)!.reason, "spawn-failed");
  assert.equal(failed.events.at(-1)!.executionMs, null);
  const nonzero = observation();
  const actual = startGardenOffLoop("gate", 60_000, { ...nonzero,
    spawnPass: boundedGardenPassSpawn(childGardenPassSpawn(fixture.options), 1) });
  t.after(() => actual.stop()); await nonzero.terminal.promise;
  assert.deepEqual(nonzero.events.map(e => e.phase), ["queued", "running", "failed"]);
  assert.equal(nonzero.events.at(-1)!.exit, 7); assert.notEqual(nonzero.events.at(-1)!.executionMs, null);
});

test("process-boundary controls retain real child completion and true pool queueing", { timeout: 10_000 }, async t => {
  const fixture = await privateChild(t);
  assert.equal(await childGardenPassSpawn(fixture.options)("plan", [], { stopped: false }), 0);
  const release = deferred<GardenPassOutcome>(), started: string[] = [];
  const pooled = boundedGardenPassSpawn(async name => { started.push(name); return release.promise; }, 1);
  const first = pooled("plan", [], { stopped: false });
  const stopped = { stopped: false };
  const second = pooled("gate", [], stopped);
  await setImmediate(); assert.deepEqual(started, ["plan"]);
  stopped.stopped = true; release.resolve(0);
  assert.equal(await first, 0); assert.equal(await second, null);
  assert.deepEqual(started, ["plan"]);
});

test("a cancelled real pass releases admission without creating its child", { timeout: 10_000 }, async t => {
  const fixture = await privateChild(t, "import {writeFileSync} from 'node:fs';writeFileSync('started','yes');");
  const signal = { stopped: false, admitted: () => { starts++; } };
  let starts = 0, released = 0, bound = 0;
  const spawnPass = childGardenPassSpawn({ ...fixture.options, reserve: () => {
    // The stop arrives after admission has begun, before the actual spawn boundary.
    signal.stopped = true;
    return { id: "private-cancelled-reservation", published: true, workerClass: "garden", estimateMib: 1,
      estimateSource: { kind: "measured", samples: 1 }, bindRoot: () => { bound++; }, releaseOccupancy: () => { released++; } };
  } });
  assert.equal(await spawnPass("plan", [], signal), null);
  assert.equal(starts, 0); assert.equal(bound, 0); assert.equal(released, 1);
  await assert.rejects(access(join(fixture.root, "started")), { code: "ENOENT" });
});

test("an observer failure cannot break a real garden process or its completion", { timeout: 10_000 }, async t => {
  const fixture = await privateChild(t), observed = observation();
  const garden = startGardenOffLoop("plan", 60_000, {
    spawnPass: boundedGardenPassSpawn(childGardenPassSpawn(fixture.options), 1), log: observed.log,
    observe: event => { observed.observe(event); if (event.phase === "running") throw new Error("observer failed"); },
  });
  t.after(() => garden.stop()); await observed.terminal.promise;
  assert.equal(observed.events.at(-1)!.phase, "completed");
  assert.equal(observed.rows.filter(r => r.step === "garden.telemetry_failed").length, 1);
  assert.equal(observed.rows.find(r => r.step === GARDEN_PASS_STEP)!.exit, 0);
});
