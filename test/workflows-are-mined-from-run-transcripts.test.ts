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

test("repeated Edit calls collapse to their first normalized step in each run", () => {
  const edit = signed("Edit:src/lib/review.ts");
  const otherEdit = signed("Edit:src/lib/retro.ts");
  const typecheck = signed("Bash:npm run typecheck");
  const { runs, records } = transcripts([
    ...run("P1", "W1-T4700", 1, [edit, otherEdit, typecheck, edit]),
    ...run("P2", "W1-T4701", 2, [otherEdit, edit, typecheck, otherEdit]),
  ]);
  assert.deepEqual(mineRecurringProcedures(runs, records).map((p) => [p.steps, p.medianSpannedCalls]), [
    [["Edit:src/lib/*.ts", "Bash:npm run typecheck"], 3],
  ]);
});

test("an unknown run has no steps even when another run has qualifying tool rows", () => {
  const steps = [signed("Edit:src/lib/review.ts"), signed("Bash:npm run typecheck")];
  const { runs, records } = transcripts(run("P1", "W1-T4700", 1, steps));
  const opts = { minRuns: 1, minTaskIds: 1 };
  assert.deepEqual(mineRecurringProcedures(runs, records, opts).map((p) => p.runIds), [["P1"]]);
  const unknown = { ...runs[0]!, runId: "NOPE" };
  assert.deepEqual(mineRecurringProcedures([unknown], records, opts), []);
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

test("gap pruning keeps the three closed procedures in 650 runs with two long command orders", () => {
  const shared = Array.from({ length: 23 }, (_, i) => `Bash:npm run s${i}`);
  const firstOrder = ["Bash:git add", ...shared, "Bash:git commit"];
  const secondOrder = ["Bash:git worktree", ...shared, "Bash:git push"];
  const runs = Array.from({ length: 650 }, (_, r) => ({ runId: `R${r}`, taskId: `W1-T${r}`, type: "implement", verdict: "merged" }));
  const records = runs.flatMap(({ runId }, i) => (i < 350 ? firstOrder : secondOrder)
    .map((tool_signature) => ({ run_id: runId, step: "worker.activity", event_kind: "tool-executing", tool_name: "Bash", tool_signature })));
  const found = mineRecurringProcedures(runs, records);
  assert.deepEqual(found.map((p) => [p.steps, p.recurrence]), [
    [shared, 650], [firstOrder, 350], [secondOrder, 300],
  ]);
});
