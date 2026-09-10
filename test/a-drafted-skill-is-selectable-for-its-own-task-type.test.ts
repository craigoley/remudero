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
    shapeKey: `${taskType}:clean_single_strike`,
    taskType,
    signals: ["clean_single_strike"],
    runIds: ["RUN-1", "RUN-2"],
    taskIds: ["W1-T1", "W1-T2"],
    supportingRuns: 2,
  };
}

function loadDraft(markdown: string, name: string) {
  return loadInjectableSkills("approved-tree", () => [name], () => markdown);
}

test("a drafted skill round-trips through the approved-tree loader and selects for its own task type", () => {
  const draft = renderSkillDraft(candidate("implement"));
  assert.ok(draft);
  assert.match(draft.markdown, /^applies-to: implement$/m);

  const loaded = loadDraft(draft.markdown, draft.name);
  assert.deepEqual(loaded.map((skill) => skill.appliesTo), [["implement"]]);
  assert.deepEqual(selectSkillsForTask(loaded, "implement", 10_000).map((skill) => skill.name), [draft.name]);
  assert.deepEqual(selectSkillsForTask(loaded, "diagnose", 10_000), []);
});

test("an unrecognised candidate task type stays unselectable instead of defaulting to implement", () => {
  const draft = renderSkillDraft(candidate("novel-task-type"));
  assert.ok(draft);
  assert.doesNotMatch(draft.markdown, /^applies-to:/m);
  assert.deepEqual(loadDraft(draft.markdown, draft.name), []);
});
