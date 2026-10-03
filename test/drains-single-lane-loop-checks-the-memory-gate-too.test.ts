/**
 * W1-T5404 — DRAIN'S SINGLE-LANE LOOP CHECKS THE MEMORY GATE TOO.
 *
 * W1-T5347 wired `DrainDeps.checkMemoryGovernor` into both drain call sites, but only
 * `runDrainLanes` consulted it (through `checkDispatchGovernors`). `runDrain`'s single-lane loop
 * read the cost and queue gates directly and never the memory one, so a single-lane `rmd drain`
 * dispatched on a host below the floor the daemon and the multi-lane path hold on.
 *
 * Every pass here offers a REAL runnable task, so a loop that skips the memory gate dispatches it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDrain, type DrainDeps } from "../src/lib/drain.js";
import type { MemoryGovernorResult } from "../src/lib/sweep.js";

const BELOW_FLOOR: MemoryGovernorResult = { deferred: true, observedAvailableMib: 1000, floorMib: 3072 };

function withPlan(ids: string[], body: (plan: Plan) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-drain-memory-gate-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    ids.map((id) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`).join(""),
  );
  return body(loadPlan(f)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A drain harness: every `runOne` merges its task, and every `log` row is kept. */
function harness(checkMemoryGovernor?: DrainDeps["checkMemoryGovernor"]) {
  const merged = new Set<string>();
  const ran: string[] = [];
  const rows: { step: string; extra: Record<string, unknown> }[] = [];
  const deps: DrainDeps = {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id) => {
      ran.push(id);
      merged.add(id);
      return { taskId: id, runId: "R", merged: true, costUsd: 0, verdict: "merged" };
    },
    log: (step, extra = {}) => rows.push({ step, extra }),
    ...(checkMemoryGovernor ? { checkMemoryGovernor } : {}),
  };
  return { deps, ran, rows };
}

test("W1-T5404: a single-lane pass below the memory floor dispatches nothing and ends memory_governor_deferred", async () => {
  await withPlan(["A"], async (plan) => {
    const h = harness(() => BELOW_FLOOR);
    const summary = await runDrain(plan, h.deps);
    assert.equal(summary.stopReason, "memory_governor_deferred");
    assert.deepEqual(h.ran, [], "the runnable task must not reach runOne while the host is below the floor");
    assert.deepEqual(summary.attempted, []);
    assert.match(summary.stopDetail ?? "", /1000 MiB available below the 3072 MiB memory floor/);
    const held = h.rows.filter((r) => r.step === "drain.memory_governor");
    assert.deepEqual(held.map((r) => r.extra), [{ observed_available_mib: 1000, memory_floor_mib: 3072 }]);
  });
});

test("W1-T5404: the memory gate is re-read every pass — an admitting reading dispatches, a later below-floor one holds", async () => {
  await withPlan(["A", "B"], async (plan) => {
    const readings: (MemoryGovernorResult | undefined)[] = [undefined, BELOW_FLOOR];
    let reads = 0;
    const h = harness(() => readings[reads++]);
    const summary = await runDrain(plan, h.deps, { max: 5 });
    assert.equal(h.ran.length, 1, "the first pass admits one task, the second pass holds");
    assert.equal(summary.stopReason, "memory_governor_deferred");
    assert.equal(reads, 2, "one fresh memory reading per pass");
  });
});

test("W1-T5404: a memory gate that throws does not hold the pass — it fails open and is logged", async () => {
  await withPlan(["A"], async (plan) => {
    const h = harness(() => {
      throw new Error("/proc/meminfo: EIO");
    });
    const summary = await runDrain(plan, h.deps, { max: 1 });
    assert.deepEqual(h.ran, ["A"], "an unreadable memory reading admits — it never wedges dispatch");
    assert.notEqual(summary.stopReason, "memory_governor_deferred");
    const unreadable = h.rows.filter((r) => r.step === "drain.memory_governor.unreadable");
    assert.equal(unreadable.length, 1, "the failed read is ledgered, never a silent admit");
    assert.match(String(unreadable[0]!.extra.error), /EIO/);
    assert.equal(h.rows.filter((r) => r.step === "drain.memory_governor").length, 0);
  });
});

test("W1-T5404: a non-Error throw from the memory gate is still recorded and still admits", async () => {
  await withPlan(["A"], async (plan) => {
    const h = harness(() => {
      throw "meminfo gone";
    });
    await runDrain(plan, h.deps, { max: 1 });
    assert.deepEqual(h.ran, ["A"]);
    const unreadable = h.rows.filter((r) => r.step === "drain.memory_governor.unreadable");
    assert.deepEqual(unreadable.map((r) => r.extra.error), ["meminfo gone"]);
  });
});

test("W1-T5404: a pass with no memory dep wired runs as before", async () => {
  await withPlan(["A"], async (plan) => {
    const h = harness();
    const summary = await runDrain(plan, h.deps, { max: 1 });
    assert.deepEqual(h.ran, ["A"]);
    assert.equal(summary.stopReason, "max_reached");
    assert.equal(h.rows.filter((r) => r.step.startsWith("drain.memory_governor")).length, 0);
  });
});

test("W1-T5404: the cost and queue gates still answer first — a queue hold is reported as queue, not memory", async () => {
  await withPlan(["A"], async (plan) => {
    let memoryReads = 0;
    const h = harness(() => {
      memoryReads++;
      return BELOW_FLOOR;
    });
    const summary = await runDrain(plan, { ...h.deps, checkQueueGovernor: () => ({ deferred: true, observedOpenCount: 23, wipLimit: 20 }) });
    assert.equal(summary.stopReason, "queue_governor_deferred");
    assert.equal(memoryReads, 0, "the memory gate is consulted after the queue gate, as checkDispatchGovernors orders them");
    assert.deepEqual(h.ran, []);
  });
});
