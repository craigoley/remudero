// test/a-retro-drafts-skills-from-transcripts.test.ts — W1-T4668 taught renderSkillDraft to mine
// step-by-step workflows from worker transcripts, but the retro's only production call
// (buildGather) passed no transcripts, so every staged draft still read "Resolve the task on the
// first attempt" (skill-draft:88d9945f and 8aa4458e, 2026-09-29). This drives the real gather.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGather } from "../src/lib/retro.js";

function run(runId: string, taskId: string, day: number, tools: string[], fixed: boolean): string[] {
  const ts = (s: number) => `2026-05-0${day}T00:00:0${s}.000Z`;
  return [
    JSON.stringify({ ts: ts(0), run_id: runId, task_id: taskId, step: "run.start", type: "implement" }),
    ...tools.map((tool, i) =>
      JSON.stringify({ ts: ts(i + 1), run_id: runId, task_id: taskId, step: "worker.activity", event_kind: "tool-executing", tool_name: tool }),
    ),
    ...(fixed ? [JSON.stringify({ ts: ts(7), run_id: runId, task_id: taskId, step: "fix.dispatch" })] : []),
    JSON.stringify({ ts: ts(8), run_id: runId, task_id: taskId, step: "verdict", verdict: "merged" }),
  ];
}

test("the retro's skill drafts carry the workflow mined from successful transcripts", () => {
  const ledgerNdjson = [
    ...run("P1", "W1-T4800", 1, ["Read", "Grep", "Edit"], false),
    ...run("P2", "W1-T4801", 2, ["Read", "Grep", "Edit"], false),
    ...run("P3", "W1-T4802", 3, ["Read", "Grep", "Edit"], false),
    ...run("D1", "W1-T4810", 4, ["Edit"], true),
    ...run("D2", "W1-T4811", 5, ["Edit"], true),
    ...run("D3", "W1-T4812", 6, ["Edit"], true),
  ].join("\n");
  const gather = buildGather({ ledgerNdjson, learningsMd: "" });
  const draft = gather.skillDrafts.find((d) => /clean-single-strike/.test(d.name));
  assert.ok(draft, "the three clean single-strike runs stage a draft");
  assert.match(draft!.markdown, /Call `Grep`/, "the distinguishing step from the successful transcripts is in the Procedure");
  assert.match(draft!.markdown, /\[src: transcript#P1\]/);
});
