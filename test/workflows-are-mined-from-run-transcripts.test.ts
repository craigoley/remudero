import assert from "node:assert/strict";
import { test } from "node:test";
import { gatherRuns, parseLedger } from "#src/lib/retro.js";
import { renderSkillDraft, type ProceduralCandidateLike } from "#src/lib/skill-workshop.js";
import { mineRecurringProcedures } from "#src/lib/workflow-mining.js";

// W1-T4668 mined the steps every clean run took and no repaired run did; on the live ledger that returned nothing
// (W1-T13857). The recurring miner reads the same `worker.activity` rows through the real retro parse, and keeps
// what runs of two or more tasks repeat, repaired or not.
function row(ts: string, runId: string, taskId: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ ts, run_id: runId, task_id: taskId, ...extra });
}

function run(runId: string, taskId: string, day: number, tools: Array<{ name: string; signature?: string }>, fixed = false): string[] {
  const ts = (s: number) => `2026-05-0${day}T00:00:0${s}.000Z`;
  return [
    row(ts(0), runId, taskId, { step: "run.start", type: "implement" }),
    ...tools.map((t, i) => row(ts(i + 1), runId, taskId, {
      step: "worker.activity", event_kind: "tool-executing", tool_name: t.name, ...(t.signature ? { tool_signature: t.signature } : {}),
    })),
    ...(fixed ? [row(ts(7), runId, taskId, { step: "fix.dispatch", strike: 1, strike_cap: 3, unmet_count: 1, round: "fresh" })] : []),
    row(ts(8), runId, taskId, { step: "verdict", verdict: "merged", cost_usd: 1.0 }),
  ];
}

function transcripts(lines: string[]) {
  const records = parseLedger(lines.join("\n"));
  return { runs: gatherRuns(records), records };
}

const signed = (signature: string) => ({ name: signature.slice(0, signature.indexOf(":")), signature });

test("a row with no tool_signature falls back to its bare tool name, and the renderer drafts no bare tool name", () => {
  const { runs, records } = transcripts([
    ...run("P1", "W1-T4700", 1, [{ name: "Read" }, { name: "Bash" }, { name: "Edit" }]),
    ...run("P2", "W1-T4701", 2, [{ name: "Grep" }, { name: "Bash" }, { name: "Edit" }]),
  ]);
  assert.deepEqual(mineRecurringProcedures(runs, records).map((p) => p.steps), [["Bash", "Edit"]]);
  const candidate: ProceduralCandidateLike = {
    shapeKey: "implement:fully_executed_proof", taskType: "implement", signals: ["fully_executed_proof"],
    runIds: ["P1", "P2"], taskIds: ["W1-T4700", "W1-T4701"], supportingRuns: 2,
  };
  assert.equal(renderSkillDraft(candidate, { runs, records }), undefined);
});

test("a repaired run that repeats the sequence counts toward its recurrence", () => {
  const steps = [signed("Bash:npm run comment-load-signal"), signed("Read:src/lib/retro.ts"), signed("Bash:npm run typecheck")];
  const { runs, records } = transcripts([
    ...run("P1", "W1-T4700", 1, steps),
    ...run("P2", "W1-T4701", 2, steps, true),
    ...run("P3", "W1-T4702", 3, steps, true),
  ]);
  const [procedure, ...rest] = mineRecurringProcedures(runs, records);
  assert.equal(rest.length, 0);
  assert.deepEqual(procedure!.steps, ["Bash:npm run comment-load-signal", "Bash:npm run typecheck"]);
  assert.deepEqual(procedure!.runIds, ["P1", "P2", "P3"]);
  assert.equal(procedure!.medianSpannedCalls, 3);
});

test("a sequence held by one run is below the run floor and mines nothing", () => {
  const steps = [signed("Bash:npm run typecheck"), signed("Bash:git commit")];
  const { runs, records } = transcripts([
    ...run("S1", "W1-T4720", 1, steps),
    ...run("S2", "W1-T4721", 2, [signed("Bash:git commit"), signed("Bash:npm run typecheck")]),
  ]);
  assert.deepEqual(mineRecurringProcedures(runs, records), []);
  assert.equal(mineRecurringProcedures(runs, records, { minRuns: 1, minTaskIds: 1 }).length, 2);
});

test("growth stops at its branch bound when many runs share most of one long order, and keeps the most-recurring", () => {
  // 120 runs each keep a seeded 80% of 30 shared commands: millions of closed sequences recur in two runs.
  let seed = 11;
  const keep = (): boolean => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 < 0.8;
  const shared = Array.from({ length: 30 }, (_, i) => `Bash:npm run s${i}`);
  const runs = Array.from({ length: 120 }, (_, r) => ({ runId: `R${r}`, taskId: `W1-T${r}`, type: "implement", verdict: "merged" }));
  const records = runs.flatMap(({ runId }) => shared
    .filter(() => keep())
    .map((tool_signature) => ({ run_id: runId, step: "worker.activity", event_kind: "tool-executing", tool_name: "Bash", tool_signature })));
  const found = mineRecurringProcedures(runs, records);
  assert.ok(found.length > 10_000 && found.length <= 20_000, `${found.length} procedures: the bound stopped growth`);
  assert.ok(found.every((p) => p.recurrence >= 2 && p.taskIds.length >= 2));
  assert.ok(found[0]!.recurrence >= Math.max(...found.map((p) => p.recurrence)) / 2, "the most-recurring sequences are grown first");
});
