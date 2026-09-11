import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { describeWorkerSkillReachability } from "../src/lib/skill-workshop.js";
import { WORKER_SETTING_SOURCES } from "../src/lib/worker.js";

const skillsDir = fileURLToPath(new URL("../.claude/skills/", import.meta.url));

function repoOwnedSkillNames(): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

test("a repo-owned skill exists and is unreachable at spawnWorker's exported settingSources", () => {
  const skills = repoOwnedSkillNames();
  assert.ok(skills.length > 0, "the repository must ship at least one .claude/skills/<name>/SKILL.md");

  const result = describeWorkerSkillReachability(WORKER_SETTING_SOURCES);
  assert.equal(result.reachable, false);
  assert.match(result.reason, /excludes 'project'/);
});

test("the same reachability predicate reports reachable when project settings are loaded", () => {
  const result = describeWorkerSkillReachability(["project"]);
  assert.equal(result.reachable, true);
  assert.match(result.reason, /discoverable/);
});
