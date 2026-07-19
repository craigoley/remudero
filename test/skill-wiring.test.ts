import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Same convention as test/mounts-wiring.test.ts: assert the CLI entrypoint
// actually calls into the lib (loadSkillRegistry/renderSkillList) rather than
// hand-rolling its own registry read or a hardcoded listing.
const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

test("`rmd skill` dispatches to skillCommand", () => {
  assert.match(runTaskSrc, /cmd === "skill"/, "main() must dispatch the 'skill' command");
  assert.match(runTaskSrc, /skillCommand\(rest\)/, "the 'skill' command must call skillCommand");
});

test("skillCommand's 'list' subcommand loads the SHIPPED registry via loadSkillRegistry(skillsDir(repoRoot)) — never a hardcoded list", () => {
  assert.match(runTaskSrc, /sub !== "list"/, "skillCommand must gate on the 'list' subcommand (fail loud on an unknown one)");
  assert.match(
    runTaskSrc,
    /loadSkillRegistry\(skillsDir\(repoRoot\)\)/,
    "skill list must resolve the registry from .remudero/skills/ via the lib loader",
  );
  assert.match(runTaskSrc, /renderSkillList\(/, "skill list must render via the lib's renderSkillList, not ad-hoc formatting");
});

test("skillCommand validates its args via unknownArgError BEFORE any read — fail loud, spawn/read nothing on bad input", () => {
  const skillCommandMatch = runTaskSrc.match(/async function skillCommand[\s\S]*?\n}\n/);
  assert.ok(skillCommandMatch, "skillCommand function body must be present");
  const body = skillCommandMatch![0];
  assert.match(body, /unknownArgError\(/, "skillCommand must validate rest args via unknownArgError");
});

test("USAGE documents `rmd skill list`", () => {
  assert.match(runTaskSrc, /rmd skill list/, "the USAGE banner must document the new command");
});

test("the skill lib is imported from ./lib/skill.js (config lives in .remudero/skills, loader lives in src/lib)", () => {
  assert.match(runTaskSrc, /from "\.\/lib\/skill\.js"/);
});
