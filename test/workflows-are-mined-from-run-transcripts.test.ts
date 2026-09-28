import assert from "node:assert/strict";
import { test } from "node:test";
import { gatherRuns, parseLedger } from "../src/lib/retro.js";
import { renderSkillDraft, type ProceduralCandidateLike } from "../src/lib/skill-workshop.js";
import { mineTranscriptWorkflows, renderTranscriptWorkflowSteps, toolStepsForRun } from "../src/lib/workflow-mining.js";

// W1-T4668 — THE RETRO MINES PROCEDURES FROM LEDGER SIGNALS ONLY. `mineProceduralCandidates`
// (retro.ts, W1-T87) groups merged runs by a fixed signal table, so every staged skill's
// Procedure restates the outcome ("resolve on the first attempt") rather than what a successful
// worker actually DID. This module compares the tool-call sequence of first-attempt-success runs
// against runs that needed a `fix.dispatch` repair, for the same task shape, and extracts the
// steps every clean run took that no repaired run ever needed.
//
// IMPLEMENT shape: P1 and P2 are first-attempt successes (merged, zero fix.dispatch) that both
// read the test THEN grep an existing pattern THEN edit; P3 needed a fix.dispatch and its
// transcript jumped straight to editing, never reading or grepping first — Read and Grep are the
// steps that distinguish a clean pass from a repaired one.
//
// DIAGNOSE shape: D1 and D2 are first-attempt successes with the SAME tool sequence as D3, the
// one repaired run — nothing distinguishes success from repair, so this shape mines NOTHING.
const TRANSCRIPT_LEDGER = [
  `{"ts":"2026-05-01T00:00:00.000Z","run_id":"P1","task_id":"W1-T4700","step":"run.start","type":"implement"}`,
  `{"ts":"2026-05-01T00:00:01.000Z","run_id":"P1","task_id":"W1-T4700","step":"worker.activity","event_kind":"tool-executing","tool_name":"Read"}`,
  `{"ts":"2026-05-01T00:00:02.000Z","run_id":"P1","task_id":"W1-T4700","step":"worker.activity","event_kind":"tool-executing","tool_name":"Grep"}`,
  `{"ts":"2026-05-01T00:00:03.000Z","run_id":"P1","task_id":"W1-T4700","step":"worker.activity","event_kind":"tool-executing","tool_name":"Edit"}`,
  `{"ts":"2026-05-01T00:00:04.000Z","run_id":"P1","task_id":"W1-T4700","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/700"}`,
  `{"ts":"2026-05-02T00:00:00.000Z","run_id":"P2","task_id":"W1-T4701","step":"run.start","type":"implement"}`,
  `{"ts":"2026-05-02T00:00:01.000Z","run_id":"P2","task_id":"W1-T4701","step":"worker.activity","event_kind":"tool-executing","tool_name":"Read"}`,
  `{"ts":"2026-05-02T00:00:02.000Z","run_id":"P2","task_id":"W1-T4701","step":"worker.activity","event_kind":"tool-executing","tool_name":"Grep"}`,
  `{"ts":"2026-05-02T00:00:03.000Z","run_id":"P2","task_id":"W1-T4701","step":"worker.activity","event_kind":"tool-executing","tool_name":"Edit"}`,
  `{"ts":"2026-05-02T00:00:04.000Z","run_id":"P2","task_id":"W1-T4701","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/701"}`,
  `{"ts":"2026-05-03T00:00:00.000Z","run_id":"P3","task_id":"W1-T4702","step":"run.start","type":"implement"}`,
  `{"ts":"2026-05-03T00:00:01.000Z","run_id":"P3","task_id":"W1-T4702","step":"worker.activity","event_kind":"tool-executing","tool_name":"Edit"}`,
  `{"ts":"2026-05-03T00:00:02.000Z","run_id":"P3","task_id":"W1-T4702","step":"fix.dispatch","strike":1,"strike_cap":3,"unmet_count":1,"round":"fresh"}`,
  `{"ts":"2026-05-03T00:00:03.000Z","run_id":"P3","task_id":"W1-T4702","step":"worker.activity","event_kind":"tool-executing","tool_name":"Edit"}`,
  `{"ts":"2026-05-03T00:00:04.000Z","run_id":"P3","task_id":"W1-T4702","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/702"}`,
  `{"ts":"2026-05-04T00:00:00.000Z","run_id":"D1","task_id":"W1-T4710","step":"run.start","type":"diagnose"}`,
  `{"ts":"2026-05-04T00:00:01.000Z","run_id":"D1","task_id":"W1-T4710","step":"worker.activity","event_kind":"tool-executing","tool_name":"Read"}`,
  `{"ts":"2026-05-04T00:00:02.000Z","run_id":"D1","task_id":"W1-T4710","step":"worker.activity","event_kind":"tool-executing","tool_name":"Edit"}`,
  `{"ts":"2026-05-04T00:00:03.000Z","run_id":"D1","task_id":"W1-T4710","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/710"}`,
  `{"ts":"2026-05-05T00:00:00.000Z","run_id":"D2","task_id":"W1-T4711","step":"run.start","type":"diagnose"}`,
  `{"ts":"2026-05-05T00:00:01.000Z","run_id":"D2","task_id":"W1-T4711","step":"worker.activity","event_kind":"tool-executing","tool_name":"Read"}`,
  `{"ts":"2026-05-05T00:00:02.000Z","run_id":"D2","task_id":"W1-T4711","step":"worker.activity","event_kind":"tool-executing","tool_name":"Edit"}`,
  `{"ts":"2026-05-05T00:00:03.000Z","run_id":"D2","task_id":"W1-T4711","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/711"}`,
  `{"ts":"2026-05-06T00:00:00.000Z","run_id":"D3","task_id":"W1-T4712","step":"run.start","type":"diagnose"}`,
  `{"ts":"2026-05-06T00:00:01.000Z","run_id":"D3","task_id":"W1-T4712","step":"worker.activity","event_kind":"tool-executing","tool_name":"Read"}`,
  `{"ts":"2026-05-06T00:00:02.000Z","run_id":"D3","task_id":"W1-T4712","step":"fix.dispatch","strike":1,"strike_cap":3,"unmet_count":1,"round":"fresh"}`,
  `{"ts":"2026-05-06T00:00:03.000Z","run_id":"D3","task_id":"W1-T4712","step":"worker.activity","event_kind":"tool-executing","tool_name":"Edit"}`,
  `{"ts":"2026-05-06T00:00:04.000Z","run_id":"D3","task_id":"W1-T4712","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/712"}`,
].join("\n");

function transcripts() {
  const records = parseLedger(TRANSCRIPT_LEDGER);
  return { runs: gatherRuns(records), records };
}

// ── toolStepsForRun: the ordered, deduplicated per-run trace the mining above reduces ─────────

test("toolStepsForRun: the ordered, de-duplicated tool_name trace off worker.activity rows for one run", () => {
  const { records } = transcripts();
  assert.deepEqual(toolStepsForRun(records, "P1"), ["Read", "Grep", "Edit"]);
  assert.deepEqual(toolStepsForRun(records, "P3"), ["Edit"]); // repeated Edit collapses to one
  assert.deepEqual(toolStepsForRun(records, "NOPE"), []); // an unknown run_id is empty, never a throw
});

// ── (1) W1-T4668: a staged procedure lists steps taken from successful transcripts ─────────────

test("W1-T4668: a staged procedure lists steps taken from successful transcripts", () => {
  const { runs, records } = transcripts();
  const workflows = mineTranscriptWorkflows(runs, records);
  const implementWorkflow = workflows.find((w) => w.taskType === "implement");
  assert.ok(implementWorkflow, "the implement shape must mine a workflow");
  assert.deepEqual(implementWorkflow!.steps, ["Read", "Grep", "Edit"]);
  // P3's repaired transcript never read or grepped first — those are what distinguish success.
  assert.deepEqual(implementWorkflow!.distinguishingSteps, ["Read", "Grep"]);
  assert.deepEqual(implementWorkflow!.runIds, ["P1", "P2"]);
  assert.deepEqual(implementWorkflow!.taskIds, ["W1-T4700", "W1-T4701"]);
  assert.equal(implementWorkflow!.supportingRuns, 2);

  const rendered = renderTranscriptWorkflowSteps(implementWorkflow!);
  assert.ok(rendered.some((line) => line.includes("`Read`")));
  assert.ok(rendered.some((line) => line.includes("`Grep`")));
  assert.ok(!rendered.some((line) => line.includes("`Edit`"))); // Edit is common but NOT distinguishing

  // Staged as the skill draft's own Procedure section (design clause ii), citing the runs it came
  // from — a draft handed the SAME transcript corpus names the mined steps and their evidence.
  const candidate: ProceduralCandidateLike = {
    shapeKey: "implement:clean_single_strike",
    taskType: "implement",
    signals: ["clean_single_strike"],
    runIds: ["P1", "P2"],
    taskIds: ["W1-T4700", "W1-T4701"],
    supportingRuns: 2,
  };
  const draft = renderSkillDraft(candidate, { runs, records });
  assert.ok(draft, "a two-run candidate must still render a draft");
  assert.match(draft!.markdown, /Call `Read`/);
  assert.match(draft!.markdown, /Call `Grep`/);
  assert.match(draft!.markdown, /\[src: transcript#P1\]/);
  assert.match(draft!.markdown, /\[src: transcript#P2\]/);
});

// ── (2) W1-T4668: a shape with no distinguishing step stages nothing ───────────────────────────

test("W1-T4668: a shape with no distinguishing step stages nothing", () => {
  const { runs, records } = transcripts();
  const workflows = mineTranscriptWorkflows(runs, records);
  // D1/D2 (success) and D3 (repaired) all took the identical Read-then-Edit trace — nothing
  // separates a clean pass from the repaired one, so the diagnose shape mines NOTHING.
  assert.ok(!workflows.some((w) => w.taskType === "diagnose"));

  // A draft for that same shape, handed the same corpus, gets no workflow steps appended either —
  // its Procedure section is exactly what the signal-only path already rendered.
  const candidate: ProceduralCandidateLike = {
    shapeKey: "diagnose:clean_single_strike",
    taskType: "diagnose",
    signals: ["clean_single_strike"],
    runIds: ["D1", "D2"],
    taskIds: ["W1-T4710", "W1-T4711"],
    supportingRuns: 2,
  };
  const withoutTranscripts = renderSkillDraft(candidate);
  const withTranscripts = renderSkillDraft(candidate, { runs, records });
  assert.equal(withTranscripts!.markdown, withoutTranscripts!.markdown);
});

// ── mineTranscriptWorkflows floors: below-threshold and no-repair-to-compare-against ───────────

test("mineTranscriptWorkflows: a shape below the success threshold mines NOTHING, even with a repaired run to compare against", () => {
  const records = parseLedger(
    [
      `{"ts":"2026-05-10T00:00:00.000Z","run_id":"S1","task_id":"W1-T4720","step":"run.start","type":"recon"}`,
      `{"ts":"2026-05-10T00:00:01.000Z","run_id":"S1","task_id":"W1-T4720","step":"worker.activity","event_kind":"tool-executing","tool_name":"Read"}`,
      `{"ts":"2026-05-10T00:00:02.000Z","run_id":"S1","task_id":"W1-T4720","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/720"}`,
      `{"ts":"2026-05-11T00:00:00.000Z","run_id":"R1","task_id":"W1-T4721","step":"run.start","type":"recon"}`,
      `{"ts":"2026-05-11T00:00:01.000Z","run_id":"R1","task_id":"W1-T4721","step":"fix.dispatch","strike":1,"strike_cap":3,"unmet_count":1,"round":"fresh"}`,
      `{"ts":"2026-05-11T00:00:02.000Z","run_id":"R1","task_id":"W1-T4721","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/721"}`,
    ].join("\n"),
  );
  assert.deepEqual(mineTranscriptWorkflows(gatherRuns(records), records), []);
});

test("mineTranscriptWorkflows: two clean successes with NO repaired run of the same shape mine NOTHING — nothing to distinguish success FROM", () => {
  const { records } = transcripts();
  // P1/P2 (implement) have no repaired counterpart if the fix.dispatch line for P3 is dropped —
  // simulate that by mining a corpus that only ever saw first-attempt successes.
  const cleanOnly = parseLedger(TRANSCRIPT_LEDGER).filter((r) => r.task_id !== "W1-T4702");
  const runs = gatherRuns(cleanOnly);
  const workflows = mineTranscriptWorkflows(runs, cleanOnly, { threshold: 2 });
  assert.ok(!workflows.some((w) => w.taskType === "implement"));
});
