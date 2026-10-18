import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import {
  BOOT_BASELINE_RESTART_MARGIN,
  FUTILE_RESTART_HEAP_SHARE,
  createDaemonMemoryGovernor,
  type DaemonMemoryPolicy,
  type DaemonMemoryReading,
} from "#src/lib/daemon-memory-policy.js";
import { loadPlan } from "#src/lib/plan.js";
import { withTempDir } from "#src/lib/tmp.js";

const BUDGET = 1536 * 1048576;
const POLICY: DaemonMemoryPolicy = { heapGrowingPercent: 50, tightenShare: 0.3, restartShare: 0.5 };

function reading(share: number): DaemonMemoryReading {
  return { rss_bytes: share * BUDGET - 100, swap_bytes: 100, budget_bytes: BUDGET, budget_source: "memory.high" };
}

test("W1-T9596: an idle boot already over its restart share holds instead of restarting", () => {
  assert.equal(BOOT_BASELINE_RESTART_MARGIN, 1.25);
  for (const boot of [0.5, 0.54]) {
    let current = reading(boot);
    const governor = createDaemonMemoryGovernor({
      read: () => current, heapUsed: () => 0.3 * BUDGET, setFlags: () => {},
    });
    for (let i = 0; i < 100; i++) {
      current = reading(i === 0 ? boot : boot * BOOT_BASELINE_RESTART_MARGIN);
      const step = governor.step();
      assert.equal(step.tier, "hold");
      if (i === 0) assert.equal(step.futileRestart?.baseline_bytes, boot * BUDGET);
      else assert.equal(step.futileRestart, undefined, "ordinary reading changes do not repeat the reason");
    }
  }
});

test("W1-T9596: growth past the boot baseline still restarts as before", () => {
  for (const [boot, growth] of [[0.35, 0.7], [0.49, 0.51], [0.54, 0.7]]) {
    let current = reading(boot);
    const flags: string[] = [];
    const governor = createDaemonMemoryGovernor({
      read: () => current, heapUsed: () => 0.1 * BUDGET, setFlags: (flag) => flags.push(flag),
    });
    const first = governor.step();
    assert.equal(first.tier, boot >= POLICY.restartShare ? "hold" : "tighten");
    current = reading(growth);
    assert.equal(governor.step().tier, "tighten");
    assert.equal(flags.at(-1), "--heap-growing-percent=10");
    assert.equal(governor.step().tier, "restart");
  }
});

async function loop(shares: number[], extra: Partial<DaemonDeps> = {}) {
  return withTempDir("futile-memory", async (dir) => {
    const path = join(dir, "tasks.yaml");
    writeFileSync(path, "[]\n");
    const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let reads = 0;
    const summary = await runDaemon(loadPlan(path), {
      refreshMerged: () => () => false,
      runOne: async () => { throw new Error("an empty plan dispatches nothing"); },
      checkStop: () => reads >= shares.length ? "test done" : undefined,
      sleep: async () => {},
      heapStatistics: () => ({ used_heap_size: 0.1 * BUDGET, heap_size_limit: BUDGET }),
      memoryGovernor: createDaemonMemoryGovernor({
        read: () => reading(shares[reads++]), heapUsed: () => 0.1 * BUDGET, setFlags: () => {},
      }),
      log: (step, extra = {}) => rows.push({ step, extra }),
      ...extra,
    }, { pollIntervalMs: 1 });
    return { summary, rows };
  });
}

test("W1-T9596: the daemon loop ledgers a futile restart once and keeps running", async () => {
  const { summary, rows } = await loop(Array.from({ length: 30 }, (_, i) => 0.54 + (i % 2) * 0.01));
  assert.equal(summary.stopReason, "stopped");
  assert.equal(rows.some((row) => row.step === "daemon.heap_pressure_exit"), false);
  const futile = rows.filter((row) => row.step === "daemon.memory_restart_futile");
  assert.equal(futile.length, 1);
  assert.deepEqual(futile[0].extra, {
    held: true, baseline_bytes: 0.54 * BUDGET, charged_bytes: 0.54 * BUDGET,
    line_bytes: POLICY.restartShare * BUDGET, share: 0.54, restart_share: POLICY.restartShare,
    k: BOOT_BASELINE_RESTART_MARGIN, budget_bytes: BUDGET, budget_source: "memory.high",
    heap_share: (0.1 * BUDGET) / (0.54 * BUDGET),
  });
});

test("W1-T9596: a held daemon whose heap is a small share keeps its growth percent", () => {
  assert.equal(FUTILE_RESTART_HEAP_SHARE, 0.4);
  const flags: string[] = [];
  let heapShare = 0.5;
  const policy = { ...POLICY, heapGrowingPercent: 70 };
  const governor = createDaemonMemoryGovernor({
    policy, read: () => reading(0.54), heapUsed: () => heapShare * 0.54 * BUDGET,
    setFlags: (flag) => flags.push(flag),
  });
  assert.equal(governor.step().heapGrowingPercent, 10);
  heapShare = 0.25;
  for (let i = 0; i < 30; i++) {
    const step = governor.step();
    assert.equal(step.tier, "hold");
    assert.equal(step.heapGrowingPercent, 70);
    if (i === 0) assert.equal(step.futileRestart?.heap_share, 0.25);
  }
  assert.deepEqual(flags, ["--heap-growing-percent=10", "--heap-growing-percent=70"]);
});

test("a futile restart row records the end of a hold and its re-entry", async () => {
  const { summary, rows } = await loop([0.54, 0.55, 0.2, 0.2, 0.54, 0.55]);
  assert.equal(summary.stopReason, "stopped");
  const reasons = rows.filter((row) => row.step === "daemon.memory_restart_futile").map((row) => row.extra);
  assert.deepEqual(reasons.map((row) => row.held), [true, false, true]);
  assert.equal(reasons[1].charged_bytes, 0.2 * BUDGET);
  assert.ok(reasons.every((row) => row.baseline_bytes === 0.54 * BUDGET));
});

test("a V8-limit exit is never held by the boot baseline", async () => {
  const { summary, rows } = await loop([0.54, 0.54], {
    heapStatistics: () => ({ used_heap_size: 0.8 * BUDGET, heap_size_limit: BUDGET }),
  });
  assert.equal(summary.stopReason, "heap_pressure");
  assert.equal(rows.find((row) => row.step === "daemon.heap_pressure_exit")?.extra.basis, "v8_limit");
});

test("a hold records budget and GC treatment changes without repeating ordinary samples", () => {
  let current = reading(0.54);
  let heapShare = 0.2;
  const governor = createDaemonMemoryGovernor({
    read: () => current, heapUsed: () => heapShare * (current.rss_bytes + (current.swap_bytes ?? 0)),
    setFlags: () => {},
  });
  assert.equal(governor.step().futileRestart?.held, true);
  assert.equal(governor.step().futileRestart, undefined);
  current = { ...current, budget_bytes: 0.9 * BUDGET, budget_source: "memory.max" };
  const budgetChange = governor.step();
  assert.equal(budgetChange.futileRestart?.budget_source, "memory.max");
  assert.equal(budgetChange.futileRestart?.line_bytes, POLICY.restartShare * 0.9 * BUDGET);
  assert.equal(governor.step().futileRestart, undefined);
  heapShare = FUTILE_RESTART_HEAP_SHARE;
  const gcChange = governor.step();
  assert.equal(gcChange.heapGrowingPercent, 10, "the skip applies strictly below H");
  assert.equal(gcChange.futileRestart?.held, true);
  assert.equal(governor.step().futileRestart, undefined);
  current = { rss_bytes: current.rss_bytes, swap_bytes: current.swap_bytes };
  const unknown = governor.step();
  assert.equal(unknown.tier, "clear", "an unreadable budget is never pressure");
  assert.equal(unknown.futileRestart?.held, false);
  assert.equal(unknown.futileRestart?.line_bytes, undefined);
  assert.equal(governor.step().futileRestart, undefined);
});

test("the default heap reader measures this process while a small heap is held", () => {
  const flags: string[] = [];
  const governor = createDaemonMemoryGovernor({
    read: () => ({ rss_bytes: 1e12, budget_bytes: 1.5e12, budget_source: "memory.high" }),
    setFlags: (flag) => flags.push(flag),
  });
  const step = governor.step();
  assert.equal(step.tier, "hold");
  assert.equal(step.heapGrowingPercent, 50);
  assert.ok(step.futileRestart && step.futileRestart.heap_share > 0);
  assert.ok(step.futileRestart.heap_share < FUTILE_RESTART_HEAP_SHARE);
  assert.deepEqual(flags, []);
});
