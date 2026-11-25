// W1-T14878: a cycle's settle stage named only its total. On 2026-11-25 one cycle settled for 906 s and the next for 25+
// minutes, with no freshness decision in either, and no row said which part of the settle held it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

interface Row { step: string; data: Record<string, unknown> }

/** Two one-task iterations; recording a merged task's result in the ledger takes 13 s of the settle. */
async function twoIterations(): Promise<Row[]> {
  const plan = mergePlanBlobs([{ label: "fixture", text: [1, 2].map((n) =>
    `- id: PUBLIC-T${n}\n  title: public fixture\n  repo: remudero\n  type: implement\n`).join("") }]);
  let nowMs = Date.parse("2026-11-25T20:45:53Z");
  const merged = new Set<string>();
  const rows: Row[] = [];
  let settling = false;
  const deps: DaemonDeps = {
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => { nowMs += 11_000; merged.add(id); settling = true; return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" }; },
    targetRepo: "remudero",
    sleep: async () => {},
    now: () => new Date(nowMs),
    log: (step, data = {}) => {
      rows.push({ step, data });
      if (settling && step === "dispatch.settled_set") { settling = false; nowMs += 13_000; }
    },
  };
  await runDaemon(plan, deps, { max: 2, laneCount: 1 });
  return rows;
}

test("W1-T14878 every cycle names how long each part of its settle took", async () => {
  const rows = await twoIterations();
  const timed = rows.find((row) => row.step === "daemon.cycle_phases");
  assert.ok(timed, "an iteration's timing row is written");
  const parts = timed.data.settle_parts as Record<string, number> | undefined;
  assert.ok(parts, "the row names the settle's parts");
  for (const part of ["abandon_pending", "stop_ticker", "lifetime_pressure", "classify", "claim_stall", "interphase_stop"]) {
    assert.equal(typeof parts[part], "number", `${part} is named`);
  }
  assert.equal(Object.values(parts).reduce((sum, ms) => sum + ms, 0), 13_000, "the parts hold the settle's 13 s");
});

test("W1-T14878 a cycle's settle parts add up to its settle stage", async () => {
  const rows = await twoIterations();
  const timed = rows.find((row) => row.step === "daemon.cycle_phases");
  assert.ok(timed, "an iteration's timing row is written");
  const parts = (timed.data.settle_parts ?? {}) as Record<string, number>;
  assert.equal(timed.data.settle_ms, 13_000, "the settle stage is still timed as one stage");
  assert.equal(Object.values(parts).reduce((sum, ms) => sum + ms, 0), timed.data.settle_ms, "no part of the settle is unnamed");
  assert.deepEqual((timed.data.stages as string[]).slice(-2), ["lanes", "settle"], "the stage list is unchanged");
});
