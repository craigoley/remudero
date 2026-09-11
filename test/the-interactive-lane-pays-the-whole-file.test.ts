import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseRuleHeadlines,
  renderHeadlineOnlyIndex,
  resolveDoctrineForReader,
} from "../src/lib/learnings.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");
const BASELINE = join(REPO_ROOT, "scripts", "claude-md-budget-baseline.json");

interface ClaudeBudgetBaseline {
  capBytes: number;
}

function readClaude(): string {
  return readFileSync(CLAUDE_MD, "utf8");
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

test("W1-T3136: the interactive lane's paid CLAUDE.md cost is pinned to the live ratchet", () => {
  const source = readClaude();
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as ClaudeBudgetBaseline;
  const rules = parseRuleHeadlines(source);
  const sourceBytes = byteLength(source);

  assert.equal(rules.length, 56, "the interactive index must still parse the real rule corpus");
  assert.ok(sourceBytes <= baseline.capBytes, `CLAUDE.md is ${sourceBytes} bytes against cap ${baseline.capBytes}`);
  assert.ok(sourceBytes > baseline.capBytes * 0.8, `CLAUDE.md is ${sourceBytes}; this test is no longer measuring pressure`);
  assert.ok(
    source.split("\n").length < 200,
    "the paid interactive file should stay under the documented maintainability target",
  );
});

test("W1-T3136: the headline-only index is measured against the resolved corpus, not assumed smaller", () => {
  const source = readClaude();
  const rules = parseRuleHeadlines(source);
  const headlineBytes = byteLength(renderHeadlineOnlyIndex(rules));
  const resolvedBytes = byteLength(resolveDoctrineForReader(readClaude));

  assert.ok(resolvedBytes > headlineBytes * 5, `resolved corpus ${resolvedBytes} must dwarf headline index ${headlineBytes}`);
  assert.ok(
    headlineBytes / resolvedBytes < 0.2,
    `headline index fraction ${(headlineBytes / resolvedBytes).toFixed(3)} is too close to the full corpus`,
  );
});

test("W1-T3136 falsifier: a bodyless corpus does not get to prove the split saved anything", () => {
  const bodylessCorpus = [
    "## Section",
    "",
    ...Array.from({ length: 20 }, (_, i) => `- **RULE ${i}: ${"HEADLINE ".repeat(8)}**`),
    "",
  ].join("\n");
  const bodylessRules = parseRuleHeadlines(bodylessCorpus);
  const bodylessIndexBytes = byteLength(renderHeadlineOnlyIndex(bodylessRules));
  const bodylessSourceBytes = byteLength(bodylessCorpus);

  assert.ok(
    bodylessIndexBytes / bodylessSourceBytes > 0.98,
    "a corpus with no bodies keeps the headline index near the full file, so the real threshold bites",
  );
});
