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

test("a fix round dispatched under the daemon's run id is counted against the run it repaired", async () => {
  const { fixDispatchCountsAttributed } = await import("../src/lib/workflow-mining.js");
  const rows = [
    { ts: "2026-09-20T00:00:00.000Z", run_id: "W1-T4900-1", task_id: "W1-T4900", step: "run.start" },
    { ts: "2026-09-20T01:00:00.000Z", run_id: "DAEMON-7", task_id: "W1-T4900", step: "fix.dispatch" },
    { ts: "2026-09-21T00:00:00.000Z", run_id: "W1-T4900-2", task_id: "W1-T4900", step: "run.start" },
    { ts: "2026-09-21T01:00:00.000Z", run_id: "DAEMON-8", task_id: "W1-T4900", step: "fix.dispatch" },
    { ts: "2026-09-21T02:00:00.000Z", run_id: "DAEMON-9", task_id: "W1-T4900", step: "fix.dispatch" },
  ];
  const counts = fixDispatchCountsAttributed(rows);
  assert.equal(counts.get("W1-T4900-1"), 1);
  assert.equal(counts.get("W1-T4900-2"), 2, "each fix round goes to the latest run started before it");
  assert.equal(counts.get("DAEMON-8"), undefined, "never to the daemon's own run id");
});

test("a merged run the sweep had to repair is not a clean single strike", () => {
  const ledgerNdjson = [
    ...run("C1", "W1-T4820", 1, ["Read"], false),
    ...run("C2", "W1-T4821", 2, ["Read"], false),
    JSON.stringify({ ts: "2026-05-02T00:00:05.000Z", run_id: "DAEMON-1", task_id: "W1-T4821", step: "fix.dispatch" }),
  ].join("\n");
  const gather = buildGather({ ledgerNdjson, learningsMd: "" });
  const clean = gather.proceduralCandidates.find((c) => c.signals.includes("clean_single_strike"));
  assert.ok(!clean || !clean.runIds.includes("C2"), "C2 was repaired by a DAEMON-keyed fix round");
});
