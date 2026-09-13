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
const proofPreflightPath = join(approvedSkillsDir, "proof-preflight", "SKILL.md");

test("W1-T3442: proof-preflight is selected, rendered, and bounded while human macros stay excluded", () => {
  const approved = loadInjectableSkills(approvedSkillsDir);
  const skill = approved.find((s) => s.name === "proof-preflight");
  assert.ok(skill, "proof-preflight must be present in the actual approved skill tree");
  assert.deepEqual(skill.appliesTo, ["implement"]);

  const implementSelection = selectSkillsForTask(approved, "implement", DEFAULT_KNOWLEDGE_BUDGET_CHARS);
  assert.ok(
    implementSelection.some((s) => s.name === "proof-preflight"),
    "proof-preflight must fit the existing knowledge budget for implement tasks",
  );
  assert.equal(
    selectSkillsForTask(approved, "diagnose", DEFAULT_KNOWLEDGE_BUDGET_CHARS)
      .some((s) => s.name === "proof-preflight"),
    false,
    "proof-preflight must not select for a different task class",
  );

  const rendered = renderSkillsPart(implementSelection);
  assert.match(rendered, /^## skill: proof-preflight$/m);
  assert.equal(
    rendered.includes(skill.body),
    true,
    "the worker receives the complete proof-preflight procedure body",
  );

  for (const required of [
    "Read the task record's acceptance proofs before editing.",
    "Run the exact reachable proof before editing when that is safe.",
    "State the task's declared file scope before editing.",
    "Implement only the declared scope.",
    "Rerun the exact proof after editing.",
    "Run the test-tier check after editing.",
    "Report every proof as OBSERVED or NOT OBSERVED.",
    "Do not generate a script.",
    "Do not download a script.",
    "Do not execute a script.",
    "Do not self-approve.",
    "Do not deploy.",
    "Do not expand scope.",
  ]) {
    assert.equal(
      rendered.includes(required),
      true,
      `rendered proof-preflight skill is missing: ${required}`,
    );
  }

  const source = readFileSync(proofPreflightPath, "utf8");
  assert.doesNotMatch(source, /^disable-model-invocation:/m);
  assert.equal(approved.some((s) => s.name === "tddr"), false);
  assert.equal(approved.some((s) => s.name === "grfp"), false);
});
