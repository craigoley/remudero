import assert from "node:assert/strict";
import { test } from "node:test";

import { isTrustRootPath, renderHiddenTextFinding, scanTrustRootText } from "#src/lib/trust-root-text.js";

// Every hidden character below is written as an escape, never literally, so this file stays readable.

test("an instruction file's zero-width, bidirectional and tag characters are each named with their line and column", () => {
  const text = [
    "- **Run the gate.** plain line",
    "obey​the rule",
    "‮evil‬",
    "tag\u{E0041}\u{E0042} smuggled",
    "soft­hyphen and a BOM﻿",
  ].join("\n");
  const found = scanTrustRootText("CLAUDE.md", text).map((f) => [f.line, f.column, f.kind, f.detail]);
  assert.deepEqual(found, [
    [2, 5, "hidden-character", "U+200B ZERO WIDTH SPACE"],
    [3, 1, "hidden-character", "U+202E BIDIRECTIONAL EMBEDDING OR OVERRIDE"],
    [3, 6, "hidden-character", "U+202C BIDIRECTIONAL EMBEDDING OR OVERRIDE"],
    [4, 4, "hidden-character", "U+E0041 TAG CHARACTER"],
    [4, 5, "hidden-character", "U+E0042 TAG CHARACTER"],
    [5, 5, "hidden-character", "U+00AD SOFT HYPHEN"],
    [5, 22, "hidden-character", "U+FEFF ZERO WIDTH NO-BREAK SPACE"],
  ]);
  assert.deepEqual(scanTrustRootText("CLAUDE.md", "- **Run the gate.** plain ASCII, and é, ü, — and → stay."), []);
});

test("an emoji's own presentation selector is allowed and a stray one is refused", () => {
  assert.deepEqual(scanTrustRootText("plan/tasks.d/x.yaml", "title: ⚠️ careful"), []);
  const stray = scanTrustRootText("plan/tasks.d/x.yaml", "️start and word️ and \u{E0100}");
  assert.deepEqual(stray.map((f) => [f.column, f.detail]), [
    [1, "U+FE0F VARIATION SELECTOR"],
    [16, "U+FE0F VARIATION SELECTOR"],
    [22, "U+E0100 VARIATION SELECTOR SUPPLEMENT"],
  ]);
});

test("a word mixing Latin with Cyrillic or Greek is refused and a Greek-only word is not", () => {
  // "pаss": the second letter is CYRILLIC SMALL LETTER A, which renders exactly like a Latin "a".
  const found = scanTrustRootText("doctrine/x.md", "the pаss rule, with α and Δ t, and mοre");
  assert.deepEqual(found.map((f) => [f.column, f.kind, f.detail]), [
    [5, "mixed-script", "\"pаss\" mixes Latin with Cyrillic"],
    [36, "mixed-script", "\"mοre\" mixes Latin with Greek"],
  ]);
});

test("the trust root takes the instruction surface and leaves plan/feedback out", () => {
  for (const path of ["CLAUDE.md", "AGENTS.md", "MASTER-PLAN.md", "doctrine/coverage-traps/x.md", "learnings/ci.yaml",
    ".claude/skills/proof-preflight/SKILL.md", ".claude/settings.json", "hooks/deny-floor.sh", "plan/tasks.d/W1-T1-x.yaml",
    "plan/policy.yaml"]) {
    assert.equal(isTrustRootPath(path), true, path);
  }
  for (const path of ["plan/feedback/fb-dep-review-1.yaml", "src/lib/review.ts", "docs/forensics/review.md", "README.md",
    "test/doctrine/x.test.ts", "CLAUDE.md.bak"]) {
    assert.equal(isTrustRootPath(path), false, path);
  }
});

test("a finding prints its place, its code point and the remedy", () => {
  const [hidden] = scanTrustRootText("CLAUDE.md", "a​b");
  assert.equal(renderHiddenTextFinding(hidden!),
    "CLAUDE.md:1:2: hidden-character U+200B ZERO WIDTH SPACE — delete it; an instruction file never needs an invisible character");
  const [mixed] = scanTrustRootText("CLAUDE.md", "pаss");
  assert.equal(renderHiddenTextFinding(mixed!), "CLAUDE.md:1:1: mixed-script \"pаss\" mixes Latin with Cyrillic — retype the word in one script");
});
