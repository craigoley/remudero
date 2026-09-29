// test/an-outcome-only-skill-is-retired.test.ts — the one skill-workshop draft ever approved (#7090)
// said only "Resolve the task on the first attempt". It was injected into 399 implement prompts
// (2026-09-15..29) and self-reported used 8 times in 114 runs. Among runs it was injected into,
// the merged share of implement runs was 36% before and 37% after. Retired by operator direction on
// 2026-09-29; see DECISIONS.md.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "../src/lib/learnings.js";
import { loadInjectableSkills, selectSkillsForTask } from "../src/lib/skill-workshop.js";

const approvedSkillsDir = join(process.cwd(), ".claude", "skills");

test("the retired outcome-only skill is no longer in the approved tree or any implement prompt", () => {
  const approved = loadInjectableSkills(approvedSkillsDir);
  assert.ok(approved.length > 0, "the loader still reads the approved tree, so an empty answer is not vacuous");
  assert.equal(approved.some((s) => s.name === "implement-clean-single-strike-8aa4458e"), false);
  const selected = selectSkillsForTask(approved, "implement", DEFAULT_KNOWLEDGE_BUDGET_CHARS).map((s) => s.name);
  assert.equal(selected.includes("implement-clean-single-strike-8aa4458e"), false);
  assert.ok(selected.includes("proof-preflight"), "the skills workers do use are still selected");
});
