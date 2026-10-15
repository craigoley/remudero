import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { idleLaneCauseForRefillReason, idleLaneCauseForStep } from "../src/lib/idle-lane-accounting.js";
import { loadPlan } from "../src/lib/plan.js";
import type { QueueGovernorResult } from "../src/lib/sweep.js";
import type { RunResult } from "../src/run-task.js";

const MINUTE = 60_000;
const memoryHeld: QueueGovernorResult = {
  deferred: true, observedOpenCount: 6, wipLimit: 12, measuredBound: 0, tier: "draining",
  trailingMergedCount: 8, trailingOpenedCount: 6, headroomFraction: 0.2,
  pressure: {
    tier: "host-short", binding: "host", availableMib: 3477, floorMib: 3072, hostAvailableMib: 3477,
    reclaim: {
      outcome: "paced", pool: "host", rss_before_bytes: 5000, heap_used_before_bytes: 1000,
      host_before_mib: 3477, reason: "no movement since the last reclaim",
      ceiling: {
        shadow: true, ceiling_in_force_bytes: 10000, live_samples: 0, growth_percent: 30,
        live_outgrew_prior_ceiling_count: 0, heap_over_ceiling_count: 0,
      },
    },
  },
};
const wipHeld: QueueGovernorResult = {
  deferred: true, observedOpenCount: 12, wipLimit: 12, tier: "growing",
};
type Row = { step: string; fields: Record<string, unknown> };

function fixturePlan(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-memory-hold-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, ["A", "B", "C"].map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`,
  ).join(""));
  return loadPlan(path);
}

async function heldTicks(t: TestContext, verdict: QueueGovernorResult): Promise<Row[]> {
  const rows: Row[] = [];
  let reads = 0;
  let sleeps = 0;
  let nowMs = Date.parse("2026-10-14T00:19:14.840Z");
  await runDaemon(fixturePlan(t), {
    refreshMerged: () => () => false,
    // Admit the tick's selection, then hold the actual dispatch with the incident verdict.
    checkQueueGovernor: () => ++reads % 2 === 0 ? verdict : undefined,
    runOne: async (id) => { assert.fail(`held task ${id} must not start`); },
    now: () => new Date(nowMs),
    sleep: async () => { sleeps++; nowMs += MINUTE; },
    checkStop: () => sleeps >= 2 ? "fixture complete" : undefined,
    log: (step, fields) => rows.push({ step, fields: fields ?? {} }),
  } as DaemonDeps, { laneCount: 3 });
  return rows;
}

test("W1-T9359: a memory-held governor row names memory and its numbers", async (t) => {
  const rows = await heldTicks(t, memoryHeld);
  const row = rows.find(({ step }) => step === "daemon.queue_governor")!.fields;
  assert.equal(row.held_by, "memory");
  assert.equal(row.measured_bound, 0);
  assert.equal(row.pressure_tier, "host-short");
  assert.equal(row.pressure_binding, "host");
  assert.equal(row.pressure_available_mib, 3477);
  assert.equal(row.pressure_floor_mib, 3072);
  assert.equal(row.pressure_host_available_mib, 3477);
  assert.equal(row.reclaim_outcome, "paced");
  assert.equal(row.reclaim_pool, "host");
  assert.equal(row.reclaim_host_before_mib, 3477);
  assert.equal(row.reclaim_reason, "no movement since the last reclaim");
  assert.equal(row.observed_open_count, 6);
  assert.equal(row.wip_limit, 12);
  assert.equal(row.tier, "draining");
  assert.equal(row.trailing_merged_count, 8);
  assert.equal(row.trailing_opened_count, 6);
});

test("W1-T9359: a memory hold is charged to memory and a WIP hold to wip_limit", async (t) => {
  for (const [verdict, cause] of [[memoryHeld, "memory"], [wipHeld, "wip_limit"]] as const) {
    const rows = await heldTicks(t, verdict);
    const governor = rows.find(({ step }) => step === "daemon.queue_governor")!.fields;
    assert.equal(governor.held_by, cause === "memory" ? "memory" : "wip");
    assert.equal(idleLaneCauseForStep("daemon.queue_governor", governor), cause);
    const idle = rows.find(({ step }) => step === "lane.idle_changed")!.fields;
    assert.equal(idle.cause, cause);
    assert.equal(idle.idle_slots, 3);
    if (cause === "memory") {
      const reason = (idle.hold as { reason: string }).reason;
      for (const text of ["host-short", "(host)", "3477 MiB available", "floor 3072"]) assert.ok(reason.includes(text), reason);
    } else assert.equal(idle.hold, null);
    const summary = rows.find(({ step }) => step === "lane.idle_summary")!.fields;
    assert.ok((summary.slot_minutes_by_cause as Record<string, number>)[cause]! >= 3);
    assert.equal((summary.slot_minutes_by_cause as Record<string, number>)[cause === "memory" ? "wip_limit" : "memory"], 0);
    assert.equal(summary.largest_cause, cause);
    if (cause === "memory") {
      assert.deepEqual((summary.holds as Record<string, unknown>).memory, idle.hold);
    }
  }
  // A pressure reading alone, or zero without a reading, does not establish a memory hold.
  for (const verdict of [{ ...memoryHeld, measuredBound: 2 }, { ...wipHeld, measuredBound: 0 }]) {
    const rows = await heldTicks(t, verdict);
    assert.equal(rows.find(({ step }) => step === "daemon.queue_governor")!.fields.held_by, "wip");
  }
});

test("W1-T9359: a memory-held refill names memory", async (t) => {
  const rows: Row[] = [];
  const started: string[] = [];
  let hold = false;
  let stopped = false;
  let startBoth!: () => void;
  const bothStarted = new Promise<void>((resolve) => { startBoth = resolve; });
  const releases = new Map<string, (result: RunResult) => void>();
  const result = (id: string) => ({ taskId: id, merged: true, verdict: "merged", costUsd: 0 }) as RunResult;
  const run = runDaemon(fixturePlan(t), {
    refreshMerged: () => () => false,
    checkQueueGovernor: () => hold ? memoryHeld : undefined,
    checkStop: () => stopped ? "fixture complete" : undefined,
    now: () => new Date("2026-10-14T00:19:14.840Z"),
    sleep: async () => {},
    log: (step, fields) => {
      rows.push({ step, fields: fields ?? {} });
      if (step === "dispatch.lane_refill_held") stopped = true;
    },
    runOne: (id) => new Promise<RunResult>((resolve) => {
      started.push(id);
      releases.set(id, resolve);
      if (started.length === 2) startBoth();
    }),
  } as DaemonDeps, { laneCount: 2, max: 3 });
  try {
    await bothStarted;
    hold = true;
    releases.get("B")!(result("B"));
    await drainMicrotasks();
    const parked = rows.find(({ step }) => step === "dispatch.lane_parked")!.fields;
    assert.match(String(parked.reason), /^governor: memory host-short/);
    assert.equal(idleLaneCauseForRefillReason(parked.reason), "memory");
    const idle = rows.find(({ step }) => step === "lane.idle_changed")!.fields;
    assert.equal(idle.cause, "memory");
    assert.match((idle.hold as { reason: string }).reason, /\(host\): 3477 MiB available, floor 3072/);
    releases.get("A")!(result("A"));
    await drainMicrotasks();
    const held = rows.find(({ step }) => step === "dispatch.lane_refill_held")!.fields;
    assert.match(String(held.reason), /^governor: memory host-short/);
    assert.equal(idleLaneCauseForStep("dispatch.lane_refill_held", held), "memory");
    assert.deepEqual(started, ["A", "B"]);
    assert.equal(idleLaneCauseForRefillReason("governor: queue"), "wip_limit");
    assert.equal(idleLaneCauseForRefillReason("governor: memory_unreadable"), "governor");
  } finally {
    stopped = true;
    for (const [id, release] of releases) release(result(id));
    await run;
  }
});
