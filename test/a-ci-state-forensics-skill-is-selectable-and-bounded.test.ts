import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "../src/lib/learnings.js";
import {
  loadInjectableSkills,
  renderSkillsPart,
  selectSkillsForTask,
} from "../src/lib/skill-workshop.js";

const approvedSkillsDir = join(process.cwd(), ".claude", "skills");
const skillPath = join(approvedSkillsDir, "ci-state-forensics", "SKILL.md");

test("ci-state-forensics is selected for implement work and stays out of other task classes", () => {
  const approved = loadInjectableSkills(approvedSkillsDir);
  const skill = approved.find((candidate) => candidate.name === "ci-state-forensics");
  assert.ok(skill, "ci-state-forensics must be present in the approved skill tree");
  assert.deepEqual(skill.appliesTo, ["implement"]);

  const implementSelection = selectSkillsForTask(approved, "implement", DEFAULT_KNOWLEDGE_BUDGET_CHARS);
  assert.ok(
    implementSelection.some((candidate) => candidate.name === "ci-state-forensics"),
    "ci-state-forensics must fit the existing knowledge budget",
  );
  assert.equal(
    selectSkillsForTask(approved, "diagnose", DEFAULT_KNOWLEDGE_BUDGET_CHARS)
      .some((candidate) => candidate.name === "ci-state-forensics"),
    false,
    "ci-state-forensics must not widen the read-only diagnose lane",
  );

  const rendered = renderSkillsPart(implementSelection);
  for (const required of [
    "mergeable",
    "mergeStateStatus",
    "every required check must be terminal and successful",
    "Do not push a fresh commit only to clear a stale red aggregate",
    "Do not merge, enable auto-merge, deploy, or change branch protection.",
    "OBSERVED, INFERRED, and NOT OBSERVED",
  ]) {
    assert.equal(rendered.includes(required), true, `rendered skill is missing: ${required}`);
  }

  assert.equal(readFileSync(skillPath, "utf8").includes("license: Apache-2.0"), true);
  assert.equal(approved.some((candidate) => candidate.name === "tddr"), false);
  assert.equal(approved.some((candidate) => candidate.name === "grfp"), false);
});
