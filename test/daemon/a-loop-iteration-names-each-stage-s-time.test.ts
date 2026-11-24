import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

interface Row { step: string; data: Record<string, unknown> }

async function twoIterations(): Promise<{ rows: Row[]; calls: string[] }> {
  const plan = mergePlanBlobs([{ label: "fixture", text: [1, 2].map((n) =>
    `- id: PUBLIC-T${n}\n  title: public fixture\n  repo: remudero\n  type: implement\n`).join("") }]);
  let nowMs = Date.parse("2026-11-24T22:23:04Z");
  const merged = new Set<string>();
  const rows: Row[] = [];
  const calls: string[] = [];
  const deps: DaemonDeps = {
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => { calls.push("refresh_merged"); nowMs += 7_000; return (id) => merged.has(id); },
    readUsage: async () => { calls.push("read_usage"); nowMs += 3_000; return undefined; },
    runOne: async (id) => { calls.push("lanes"); nowMs += 11_000; merged.add(id); return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" }; },
    targetRepo: "remudero",
    sleep: async () => {},
    now: () => new Date(nowMs),
    log: (step, data = {}) => { rows.push({ step, data }); },
  };
  await runDaemon(plan, deps, { max: 2, laneCount: 1 });
  return { rows, calls };
}

test("W1-T14768 a loop iteration's stage durations are written at the next tick", async () => {
  const { rows } = await twoIterations();
  const at = rows.findIndex((row) => row.step === "daemon.cycle_phases");
  assert.ok(at > 0, "an iteration's timing row is written");
  assert.equal(rows[at - 1]?.step, "daemon.tick", "the row follows the next tick");
  const timed = rows[at]!.data;
  assert.equal(timed.refresh_merged_ms, 7_000, "the merged read names its own 7 s");
  assert.equal(timed.read_usage_ms, 3_000, "the usage read names its own 3 s");
  assert.equal(timed.lanes_ms, 11_000, "the lanes name the run's 11 s");
  const stageSum = Object.entries(timed).filter(([key]) => key.endsWith("_ms") && key !== "total_ms")
    .reduce((sum, [, ms]) => sum + (ms as number), 0);
  assert.equal(timed.total_ms, stageSum, "the stages account for the whole iteration");
  assert.ok((timed.total_ms as number) >= 21_000);
});

test("W1-T14768 a timed iteration still runs its stages in the same order and names them so", async () => {
  const { rows, calls } = await twoIterations();
  assert.deepEqual(calls.slice(0, 3), ["refresh_merged", "read_usage", "lanes"], "the first iteration's stages run in order");
  const timed = rows.find((row) => row.step === "daemon.cycle_phases");
  assert.ok(timed, "the timing row is written");
  const stages = timed.data.stages as string[];
  assert.equal(stages[0], "tick_head");
  const position = (stage: string): number => stages.indexOf(stage);
  for (const stage of calls.slice(0, 3)) assert.ok(position(stage) >= 0, `${stage} is named`);
  assert.ok(position("refresh_merged") < position("read_usage") && position("read_usage") < position("lanes"),
    "the row names the stages in the order they ran");
  assert.deepEqual(stages.slice(-2), ["lanes", "settle"], "the iteration ends with its lanes settling");
});
