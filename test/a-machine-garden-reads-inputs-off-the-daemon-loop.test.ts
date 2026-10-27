import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import * as machine from "#src/lib/machine-filing-judge.js";
import * as registry from "#src/lib/garden-registry.js";

function api() { assert.equal(typeof machine.machineJudgeInputsAsync, "function"); assert.equal(typeof registry.gardenPacingDueAsync, "function"); }

test("daemon input reads: a pending due decision admits one child only after it resolves and none after stop", async (t) => {
  let resolve!: (value: boolean) => void;
  let calls = 0, probes = 0;
  const pending = new Promise<boolean>((r) => { resolve = r; });
  let garden: ReturnType<typeof registry.startGardenOffLoop>;
  garden = registry.startGardenOffLoop("plan", 5, { due: () => (probes++, pending),
    spawnPass: async () => { calls++; garden.stop(); return 0; }, log: () => {} });
  t.after(() => garden.stop());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(probes, 1, "one pending probe owns the garden tick");
  assert.equal(calls, 0, "a Promise is not a due verdict");
  resolve(true);
  await new Promise((r) => setImmediate(r));
  garden.stop();
  assert.equal(calls, 1);
  let late!: (value: boolean) => void;
  const stopped = registry.startGardenOffLoop("plan", 60_000, { due: () => new Promise<boolean>((r) => { late = r; }), spawnPass: async () => (calls++, 0), log: () => {} });
  stopped.stop();
  late(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, "stopping while a probe is pending prevents its late spawn");
});

test("daemon input reads: a rejected due Promise logs the failure and retains the pass fallback", async (t) => {
  let calls = 0;
  const steps: string[] = [];
  const garden = registry.startGardenOffLoop("plan", 60_000, { due: () => Promise.reject(new Error("unreadable inputs")), spawnPass: async () => (calls++, 0), log: (step) => { steps.push(step); } });
  t.after(() => garden.stop());
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  assert.ok(steps.includes(registry.GARDEN_DUE_FAILED_STEP));
});

test("daemon input reads: async false due decisions preserve idle reporting without spawning", async (t) => {
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const clock = fixedClock(now);
  for (const name of ["flow-remedy", "plan"] as const) {
    let probes = 0, children = 0, idles = 0;
    const garden = registry.startGardenOffLoop(name, 5, { clock,
      due: async () => (probes++, false), spawnPass: async () => (children++, 0), log: () => {},
      observe: (event) => { if (event.phase === "idle") idles++; },
    });
    t.after(() => garden.stop());
    await new Promise((resolve) => setTimeout(resolve, 75));
    garden.stop();
    assert.ok(probes > 1, "an idle due probe can be checked again");
    assert.equal(children, 0, "an async false decision never starts a child");
    assert.equal(idles, name === "flow-remedy" ? 1 : probes, "low-yield reporting remains once per bucket");
  }
});

test("daemon input reads: async pacing preserves the same machine and low-yield due decisions", async (t) => {
  api();
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-async-pacing-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const start = Date.now();
  for (const name of ["machine-judge", "host-resource", "flow-remedy"] as const) {
    registry.recordGardenPacing(stateDir, name, false, { clock: fixedClock(start), inputs: "same" });
    for (const elapsed of [0, 60_000, 3_600_000]) {
      const clock = fixedClock(start + elapsed);
      for (const value of [undefined, "same", "changed"]) {
        const sync = registry.gardenPacingDue(stateDir, name, { clock, ...(value === undefined ? {} : { inputs: () => value }) });
        const actual = await registry.gardenPacingDueAsync(stateDir, name, { clock, ...(value === undefined ? {} : { inputs: async () => value }) });
        assert.equal(actual, sync, `${name}, elapsed ${elapsed}, inputs ${value}`);
      }
    }
  }
  let probes = 0;
  const pass = Object.assign(async () => {}, { due: async () => (probes++, false) });
  const held = registry.lowYieldGardenPass(stateDir, "flow-remedy", pass, { clock: fixedClock(start), inputs: () => "changed" });
  assert.equal(await held.due(), false);
  assert.equal(probes, 0, "the pacing hold precedes the nested async probe");
  const due = registry.lowYieldGardenPass(stateDir, "flow-remedy", pass, { clock: fixedClock(start + 3_600_000), inputs: () => "changed" });
  assert.equal(await due.due(), false, "a due wrapper forwards the async false decision");
  assert.equal(probes, 1);
});
