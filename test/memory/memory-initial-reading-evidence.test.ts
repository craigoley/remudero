// The measured Console exits need their actual baseline, not an inferred cold-start reading.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createDaemonMemoryGovernor, type DaemonMemoryReading } from "#src/lib/daemon-memory-policy.js";
import { runDaemon } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { withTempDir } from "#src/lib/tmp.js";

const BUDGET = 2048 * 1048576;
const reading = (share: number): DaemonMemoryReading => ({
  rss_bytes: share * BUDGET, swap_bytes: 0, budget_bytes: BUDGET, budget_source: "memory.high",
});

test("memory decisions retain the actual first baseline without changing cold-to-warm restart behavior", () => {
  let current = reading(0.25);
  const flags: string[] = [];
  const governor = createDaemonMemoryGovernor({ read: () => current, setFlags: f => flags.push(f) });
  const first = governor.step();
  assert.equal(first.changed, false, "a first clear reading remains an unchanged decision");
  assert.equal(first.initialReading, true);
  assert.deepEqual(first.baseline, { ...reading(0.25), charged_bytes: 0.25 * BUDGET, share: 0.25, boot_over_line: false });
  current = reading(0.52);
  const second = governor.step();
  const third = governor.step();
  assert.deepEqual([first.tier, second.tier, third.tier], ["clear", "tighten", "restart"]);
  assert.equal(second.initialReading, false);
  assert.deepEqual(third.baseline, first.baseline, "later readings never replace the decision's baseline");
  assert.deepEqual(flags, ["--heap-growing-percent=10"]);
});

test("an unreadable initial memory budget stays unknown in a later restart's baseline", () => {
  let current: DaemonMemoryReading = { rss_bytes: 0.52 * BUDGET };
  const governor = createDaemonMemoryGovernor({ read: () => current, setFlags: () => {} });
  const first = governor.step();
  current = reading(0.52);
  assert.equal(governor.step().tier, "tighten");
  const restart = governor.step();
  assert.equal(restart.tier, "restart");
  assert.deepEqual(restart.baseline, first.baseline);
  assert.equal(restart.baseline?.budget_bytes, undefined);
  assert.equal(restart.baseline?.share, undefined);
  assert.equal(restart.baseline?.boot_over_line, false, "unknown is not a measured over-line boot");
});

test("the daemon logs its unchanged first memory reading and the same baseline on restart", async () => {
  await withTempDir("memory-baseline-evidence", async dir => {
    const path = join(dir, "tasks.yaml");
    writeFileSync(path, "[]\n");
    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const readings = [reading(0.25), reading(0.52), reading(0.52)];
    let i = 0;
    const summary = await runDaemon(loadPlan(path), {
      refreshMerged: () => () => false,
      runOne: async () => { throw new Error("an empty plan dispatches nothing"); },
      checkStop: () => i >= readings.length ? "fixture exhausted" : undefined,
      sleep: async () => {},
      heapStatistics: () => ({ used_heap_size: 0.1 * BUDGET, heap_size_limit: BUDGET }),
      memoryGovernor: createDaemonMemoryGovernor({ read: () => readings[i++], setFlags: () => {} }),
      log: (step, fields = {}) => rows.push({ step, fields }),
    }, { pollIntervalMs: 1 });
    assert.equal(summary.stopReason, "heap_pressure");
    const pressure = rows.filter(row => row.step === "daemon.memory_pressure");
    assert.deepEqual(pressure.map(row => row.fields.tier), ["clear", "tighten", "restart"]);
    assert.equal(pressure[0].fields.initial_reading, true);
    const baseline = pressure[0].fields.baseline;
    assert.deepEqual(baseline, { ...reading(0.25), charged_bytes: 0.25 * BUDGET, share: 0.25, boot_over_line: false });
    const exit = rows.find(row => row.step === "daemon.heap_pressure_exit");
    assert.equal(exit?.fields.basis, "cgroup_share");
    assert.deepEqual(exit?.fields.baseline, baseline);
  });
});
