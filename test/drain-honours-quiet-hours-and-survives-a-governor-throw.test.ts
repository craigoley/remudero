/**
 * W1-T5529 — DRAIN HONOURS QUIET HOURS AND SURVIVES A GOVERNOR THROW.
 *
 * (a) `DrainDeps` had no `checkQuietHours`, so W1-T5482's `quiet_hours_deferred` was unreachable from
 * any typed drain caller: `checkDispatchGovernors` reads it, and only the daemon could supply it. The
 * deps object below is a TYPED `DrainDeps` literal, never a cast, so the field must exist on the type.
 *
 * (b) Both drain loops read `checkCostGovernor` and `checkQueueGovernor` at pass level with no guard,
 * so a throwing reader rejected `runDrain`. A throw now ends the pass with that gate's deferral and
 * the error in `stopDetail`, logged — it fails CLOSED, never into "admitted".
 *
 * Every pass offers REAL runnable tasks, so a loop that admitted past the gate would dispatch one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDrain, type DrainDeps, type DrainSummary } from "../src/lib/drain.js";

type Row = { step: string; extra: Record<string, unknown> };

/** Two runnable tasks with DISJOINT `files:`, so a two-lane pass reaches its admission loop. */
async function drain(
  over: Pick<DrainDeps, "checkQuietHours" | "checkCostGovernor" | "checkQueueGovernor">,
  laneCount: number,
): Promise<{ summary: DrainSummary; ran: string[]; rows: Row[] }> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-drain-quiet-throw-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/a.ts]\n" +
      "- id: B\n  title: b\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/b.ts]\n",
  );
  const ran: string[] = [];
  const rows: Row[] = [];
  const deps: DrainDeps = {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      ran.push(id);
      return { taskId: id, runId: `R-${id}`, merged: true, costUsd: 0, verdict: "merged" };
    },
    log: (step, extra = {}) => rows.push({ step, extra }),
    ...over,
  };
  try {
    const plan: Plan = loadPlan(f);
    const summary = await runDrain(plan, deps, { laneCount, max: 2 });
    return { summary, ran, rows };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LOOPS = [
  { name: "single-lane runDrain", laneCount: 1 },
  { name: "multi-lane runDrainLanes", laneCount: 2 },
] as const;

test("W1-T5529: a multi-lane pass whose typed quiet-hours dep holds every lane ends quiet_hours_deferred", async () => {
  const { summary, ran, rows } = await drain({ checkQuietHours: () => ({ deferred: true, detail: "22:00-06:00 UTC" }) }, 2);
  assert.deepEqual(ran, [], "no lane is admitted inside quiet hours");
  assert.equal(summary.stopReason, "quiet_hours_deferred");
  assert.match(summary.stopDetail ?? "", /quiet hours hold: 22:00-06:00 UTC/);
  assert.equal(rows.filter((r) => r.step === "dispatch.lane_governed").length, 1);
});

for (const loop of LOOPS) {
  test(`W1-T5529: a throwing pass-level COST governor in the ${loop.name} loop fails closed, logged`, async () => {
    const { summary, ran, rows } = await drain(
      {
        checkCostGovernor: () => {
          throw new Error("cost ledger: EIO");
        },
      },
      loop.laneCount,
    );
    assert.deepEqual(ran, [], "an unreadable cost reading never admits");
    assert.equal(summary.stopReason, "cost_governor_deferred");
    assert.match(summary.stopDetail ?? "", /cost governor reading unreadable \(cost ledger: EIO\)/);
    const unreadable = rows.filter((r) => r.step === "drain.cost_governor.unreadable");
    assert.deepEqual(unreadable.map((r) => r.extra.error), ["cost ledger: EIO"]);
    assert.equal(rows.filter((r) => r.step === "drain.cost_governor").length, 0);
  });

  test(`W1-T5529: a throwing pass-level QUEUE governor in the ${loop.name} loop fails closed, logged`, async () => {
    const { summary, ran, rows } = await drain(
      {
        checkQueueGovernor: () => {
          throw new Error("gh pr list: 502");
        },
      },
      loop.laneCount,
    );
    assert.deepEqual(ran, [], "an unreadable queue reading never admits");
    assert.equal(summary.stopReason, "queue_governor_deferred");
    assert.match(summary.stopDetail ?? "", /queue governor reading unreadable \(gh pr list: 502\)/);
    const unreadable = rows.filter((r) => r.step === "drain.queue_governor.unreadable");
    assert.deepEqual(unreadable.map((r) => r.extra.error), ["gh pr list: 502"]);
    assert.equal(rows.filter((r) => r.step === "drain.queue_governor").length, 0);
  });

  test(`W1-T5529: a non-Error throw from either pass-level governor in the ${loop.name} loop is still recorded`, async () => {
    const cost = await drain(
      {
        checkCostGovernor: () => {
          throw "cost gone";
        },
      },
      loop.laneCount,
    );
    assert.equal(cost.summary.stopReason, "cost_governor_deferred");
    assert.deepEqual(cost.rows.filter((r) => r.step === "drain.cost_governor.unreadable").map((r) => r.extra.error), ["cost gone"]);
    const queue = await drain(
      {
        checkQueueGovernor: () => {
          throw "queue gone";
        },
      },
      loop.laneCount,
    );
    assert.equal(queue.summary.stopReason, "queue_governor_deferred");
    assert.deepEqual(queue.rows.filter((r) => r.step === "drain.queue_governor.unreadable").map((r) => r.extra.error), ["queue gone"]);
    assert.deepEqual([...cost.ran, ...queue.ran], []);
  });
}

test("W1-T5529: with every governor admitting, both loops still dispatch — the guards hold only on a throw", async () => {
  for (const loop of LOOPS) {
    const { ran } = await drain({ checkCostGovernor: () => undefined, checkQueueGovernor: () => undefined, checkQuietHours: () => undefined }, loop.laneCount);
    assert.ok(ran.length > 0, `${loop.name} dispatched nothing with every gate admitting`);
  }
});
