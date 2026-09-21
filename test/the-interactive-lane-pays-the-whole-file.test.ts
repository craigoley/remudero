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

  // A FLOOR, NOT A FREEZE — see the same control in
  // `test/the-doctrine-index-points-at-every-body.test.ts`. This line proves the byte figures below
  // were measured over the REAL corpus rather than a stub; an equality additionally refuses every
  // rule added after it was written, which is not what this suite is pinning — the cap and the
  // pressure floor beneath it are. The genuine freeze is that suite's
  // `test/fixtures/doctrine-pre-migration-W1-T3323.json`, which reddens by name on a DELETION.
  assert.ok(rules.length >= 56, `the interactive index must still parse the real rule corpus; got ${rules.length}`);
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
