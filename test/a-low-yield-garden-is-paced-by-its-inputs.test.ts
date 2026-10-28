import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import * as registry from "#src/lib/garden-registry.js";
import * as host from "#src/lib/host-resource-gardener.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const MINUTE = 60_000;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("W1-T8877: a low-yield garden is paced by its inputs", (t) => {
  const fixture = gitRepo({ kind: "low-yield-pacing" });
  t.after(() => fixture.cleanup());
  let now = 0;
  const clock = clockFromMillisFn(() => now);
  for (const name of ["host-resource", "flow-remedy"] as const) {
    registry.recordGardenPacing(fixture.dir, name, true, { clock, inputs: "first" });
    now = 5 * MINUTE;
    assert.equal(registry.gardenPacingDue(fixture.dir, name, { clock, inputs: () => "changed" }), false,
      "changed inputs cannot bypass the thirty-minute floor");
    now = 30 * MINUTE;
    assert.equal(registry.gardenPacingDue(fixture.dir, name, { clock, inputs: () => "first" }), false,
      "unchanged inputs do not spawn another heavy child at the floor");
    assert.equal(registry.gardenPacingDue(fixture.dir, name, { clock, inputs: () => "changed" }), true);
    now = 0;
  }
  now = 60 * MINUTE;
  assert.equal(registry.gardenPacingDue(fixture.dir, "host-resource", { clock, inputs: () => "first" }), true,
    "an hourly host pass refreshes remote beats even when local refs have not changed");
  assert.equal(registry.gardenPacingDue(fixture.dir, "flow-remedy", { clock, inputs: () => "first" }), false);
  assert.equal(host.HOST_RESOURCE_MIN_INTERVAL_MS, 30 * MINUTE);
  assert.equal(registry.gardenSchedule("flow-remedy").minIntervalMs, 30 * MINUTE);
});

test("a low-yield pass records the inputs it began with, survives recreation, and retries a thrown pass", async (t) => {
  const fixture = gitRepo({ kind: "low-yield-record" });
  t.after(() => fixture.cleanup());
  let now = 0, inputs = "first", calls = 0;
  const clock = clockFromMillisFn(() => now);
  const pass = registry.lowYieldGardenPass(fixture.dir, "host-resource", async () => { calls++; inputs = "during-pass"; }, { clock, inputs: () => inputs });
  assert.equal(pass.due(), true);
  await pass();
  assert.equal(registry.readGardenPacing(fixture.dir, "host-resource")?.inputs, "first");
  now = 30 * MINUTE;
  const recreated = registry.lowYieldGardenPass(fixture.dir, "host-resource", () => { calls++; }, { clock, inputs: () => inputs });
  assert.equal(recreated.due(), true, "a change during the previous pass is not swallowed");
  await recreated();
  assert.equal(calls, 2);
  assert.equal(recreated.due(), false);
  now += 30 * MINUTE;
  inputs = "next";
  const failed = registry.lowYieldGardenPass(fixture.dir, "host-resource", () => { throw new Error("failed pass"); }, { clock, inputs: () => inputs });
  await assert.rejects(failed(), /failed pass/);
  assert.equal(failed.due(), true, "failed work must not be recorded as a completed input");
});

test("a host-resource input stamp reads real loose, packed and worktree heartbeat refs plus new samples", (t) => {
  const fixture = gitRepo({ kind: "host-inputs" });
  t.after(() => fixture.cleanup());
  const state = join(fixture.dir, "state");
  mkdirSync(state);
  const before = host.hostResourceInputStamp(fixture.dir, state);
  fixture.git("update-ref", "refs/remotes/origin/heartbeat-azure", "HEAD");
  const loose = host.hostResourceInputStamp(fixture.dir, state);
  assert.notEqual(loose, before);
  fixture.git("pack-refs", "--all", "--prune");
  assert.equal(host.hostResourceInputStamp(fixture.dir, state), loose, "packing is not an input change");
  const linked = fixture.addWorktree(join(fixture.dir, "linked"), "probe");
  assert.equal(host.hostResourceInputStamp(linked.dir, state), loose, "worktrees read their common refs");
  writeFileSync(host.samplesPath(state), "sample-one\n");
  const sample = host.hostResourceInputStamp(fixture.dir, state);
  assert.notEqual(sample, loose);
  appendFileSync(host.samplesPath(state), "sample-two\n");
  assert.notEqual(host.hostResourceInputStamp(fixture.dir, state), sample);
});

test("unreadable heartbeat input cannot certify that a host is unchanged", (t) => {
  const fixture = gitRepo({ kind: "host-input-refusal" });
  t.after(() => fixture.cleanup());
  writeFileSync(join(fixture.dir, ".git", "packed-refs"), "not-a-sha refs/remotes/origin/heartbeat-azure\n");
  assert.throws(() => host.hostResourceInputStamp(fixture.dir, fixture.dir), /heartbeat/);
  renameSync(join(fixture.dir, ".git"), join(fixture.dir, "saved-git"));
  assert.throws(() => host.hostResourceInputStamp(fixture.dir, fixture.dir), /git directory/);
});

test("low-yield idle lifecycle rows are hourly while other gardens retain their existing polling", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0;
  const clock = clockFromMillisFn(() => now);
  const rows: Array<{ name: string; phase: string }> = [];
  const gardens = ["host-resource", "flow-remedy", "plan"] as const;
  const running = gardens.map(name => registry.startGardenOffLoop(name, MINUTE, {
    clock, log: () => {}, due: () => false, spawnPass: async () => { throw new Error("unchanged inputs must not spawn"); },
    observe: row => rows.push({ name: row.name, phase: row.phase }),
  }));
  t.after(() => running.forEach(g => g.stop()));
  for (let minute = 1; minute <= 120; minute++) { now += MINUTE; t.mock.timers.tick(MINUTE); await settle(); }
  for (const name of ["host-resource", "flow-remedy"]) assert.equal(rows.filter(r => r.name === name && r.phase === "idle").length, 3);
  assert.equal(rows.filter(r => r.name === "plan" && r.phase === "idle").length, 121);
});

test("two unchanged hours start only the initial and hourly host passes, not twenty-four redundant children", async (t) => {
  const fixture = gitRepo({ kind: "low-yield-child-count" });
  t.after(() => fixture.cleanup());
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0, calls = 0;
  const clock = clockFromMillisFn(() => now);
  const pass = registry.lowYieldGardenPass(fixture.dir, "host-resource", () => { calls++; }, { clock, inputs: () => "same" });
  const garden = registry.startGardenOffLoop("host-resource", MINUTE, {
    clock, log: () => {}, due: pass.due, spawnPass: async () => { await pass(); return 0; },
  });
  t.after(() => garden.stop());
  await settle();
  for (let minute = 1; minute <= 120; minute++) { now += MINUTE; t.mock.timers.tick(MINUTE); await settle(); }
  assert.equal(calls, 3, "initial, sixty-minute and hundred-twenty-minute refreshes only");
});

test("a long successful pass does not postpone the hourly fallback until an hour after completion", async (t) => {
  const fixture = gitRepo({ kind: "low-yield-start-clock" });
  t.after(() => fixture.cleanup());
  let now = 0;
  const clock = clockFromMillisFn(() => now);
  const pass = registry.lowYieldGardenPass(fixture.dir, "host-resource", () => { now += 55 * MINUTE; }, { clock, inputs: () => "same" });
  await pass();
  now = 60 * MINUTE;
  assert.equal(pass.due(), true, "the hourly cadence is measured from when the pass began");
});
