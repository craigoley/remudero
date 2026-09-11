import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { parseRuleHeadlines, renderHeadlineOnlyIndex } from "../src/lib/learnings.js";
import { policyPath, validatePolicy } from "../src/lib/policy.js";
import { buildRuleHeadlinesPart } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");

function rawPolicy(): Record<string, unknown> {
  return parseYaml(readFileSync(policyPath(REPO_ROOT), "utf8")) as Record<string, unknown>;
}

function expectedIndexLines(markdown: string): string[] {
  return renderHeadlineOnlyIndex(parseRuleHeadlines(markdown))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `    ${line.replace(/^- /, "")}`);
}

test("W1-T3134 (1): absent workerRuleHeadlines row lifts false and renders no headline part", () => {
  const raw = rawPolicy();
  assert.equal("workerRuleHeadlines" in raw, false, "the real plan/policy.yaml must still ship the row absent");

  const policy = validatePolicy(raw);
  assert.deepEqual(policy.values.workerRuleHeadlines, { enabled: false });
  assert.equal(buildRuleHeadlinesPart(policy.values.workerRuleHeadlines.enabled, CLAUDE_MD), "");
});

test("W1-T3134 (2): enabling the same real CLAUDE.md carries every rule headline", () => {
  const markdown = readFileSync(CLAUDE_MD, "utf8");
  const rules = parseRuleHeadlines(markdown);
  assert.equal(rules.length, 56, "the real CLAUDE.md corpus must still carry all 56 rule bullets");

  const part = buildRuleHeadlinesPart(true, CLAUDE_MD);
  assert.notEqual(part, "", "the enabled arm must differ from the absent-row dark arm");

  const expectedLines = expectedIndexLines(markdown);
  assert.equal(
    part.split("\n").filter((line) => line.startsWith("    **")).length,
    rules.length,
    "the enabled arm must render one headline opening per parsed rule",
  );
  assert.match(part, /CLAUDE\.md's rule headlines/);
  assert.match(part, /doctrine\/ in your own worktree/);
  assert.ok(part.includes(expectedLines.join("\n")), "the enabled arm must carry the full headline index in order");
  assert.equal(part.includes("→ doctrine/"), false, "the worker part names where bodies live without inlining every body pointer");
});
