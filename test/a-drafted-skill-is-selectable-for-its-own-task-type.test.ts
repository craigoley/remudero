import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadInjectableSkills,
  renderSkillDraft,
  selectSkillsForTask,
  type ProceduralCandidateLike,
} from "../src/lib/skill-workshop.js";

function candidate(taskType: string): ProceduralCandidateLike {
  return {
    shapeKey: `${taskType}:fully_executed_proof`,
    taskType,
    signals: ["fully_executed_proof"], // W1-T4270: a clean_single_strike-only candidate drafts nothing
    runIds: ["RUN-1", "RUN-2"],
    taskIds: ["W1-T1", "W1-T2"],
    supportingRuns: 2,
  };
}

const MINED = {
  runs: ["RUN-1", "RUN-2"].map((runId, i) => ({ runId, taskId: `W1-T${i + 1}`, type: "implement", verdict: "merged" })),
  records: ["RUN-1", "RUN-2"].flatMap((runId) => ["Bash:npm run typecheck", "Edit:src/lib/plan.ts"].map((tool_signature) =>
    ({ run_id: runId, step: "worker.activity", event_kind: "tool-executing", tool_name: tool_signature.split(":")[0], tool_signature }))),
};

function loadDraft(markdown: string, name: string) {
  return loadInjectableSkills("approved-tree", () => [name], () => markdown);
}

test("a drafted skill round-trips through the approved-tree loader and selects for its own task type", () => {
  const draft = renderSkillDraft(candidate("implement"), MINED);
  assert.ok(draft);
  assert.match(draft.markdown, /^applies-to: implement$/m);

  const loaded = loadDraft(draft.markdown, draft.name);
  assert.deepEqual(loaded.map((skill) => skill.appliesTo), [["implement"]]);
  assert.deepEqual(selectSkillsForTask(loaded, "implement", 10_000).map((skill) => skill.name), [draft.name]);
  assert.deepEqual(selectSkillsForTask(loaded, "diagnose", 10_000), []);
});

test("an unrecognised candidate task type stays unselectable instead of defaulting to implement", () => {
  const draft = renderSkillDraft(candidate("novel-task-type"), MINED);
  assert.ok(draft);
  assert.doesNotMatch(draft.markdown, /^applies-to:/m);
  assert.deepEqual(loadDraft(draft.markdown, draft.name), []);
});
