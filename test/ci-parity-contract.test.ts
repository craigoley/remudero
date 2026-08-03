/**
 * test/ci-parity-contract.test.ts — W1-T295.
 *
 * THE GAP. `outputContractLines` went straight from "stage the changed file(s), commit, then
 * run `git push origin HEAD`" to opening the PR — nothing told a worker to verify its own
 * change against CI before that first push. CLAUDE.md's "Before you push" section records the
 * coverage ratchet alone blocking three consecutive PRs on their first push, each costing an
 * amend, a force-push and a CI round-trip — a report, not a contract line, and a report leaks
 * (LEARNINGS, PR 407). W1-T294 shipped the command (`rmd preflight --ci-parity`, mirroring
 * every CI job); this task is what makes a worker RUN it before the first push.
 *
 * ONE SHARED LITERAL, TWO PROMPTS (the #427/#428 shape): `ciParityContractLines()` lives
 * beside `commitMessageContractLines`/`bodyVsDiffContractLines` in lib/compaction.ts and must
 * be composed byte-identically into BOTH the implement contract (`outputContractLines`, which
 * also composes into `renderAnchorBlock`, so it survives compaction) and the fix rung's own
 * footer (`renderFixPrompt`, run-task.ts) — never restated as a second copy of the same text.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ciParityContractLines, outputContractLines, renderAnchorBlock } from "../src/lib/compaction.js";

// ── (1) the requirement is stated, and it is stated at turn 0 ────────────────

test("ciParityContractLines names the exact command a worker is expected to run", () => {
  const lines = ciParityContractLines();
  assert.ok(lines.length > 0);
  const text = lines.join("\n");
  assert.match(text, /rmd preflight --ci-parity/, "the literal command, not a paraphrase");
  assert.match(text, /CI job/i, "explains what the command mirrors");
});

test("ciParityContractLines says named failures are fixed BEFORE pushing, not after", () => {
  const text = ciParityContractLines().join("\n");
  // "fix ... before" / "do not push to find out" — the ordering claim itself, not just the verb.
  assert.match(text, /fix/i);
  assert.match(text, /before the first push|do not push/i);
});

test("the implement output contract carries the ci-parity requirement, at turn 0", () => {
  const contract = ciParityContractLines();
  const implement = outputContractLines("W1-T295").join("\n");
  assert.ok(implement.includes(contract.join("\n")), "the implement contract carries it verbatim, not paraphrased");
  // Ordered BEFORE the push step, so a worker following the contract in order cannot skip it.
  const parityIdx = implement.indexOf(contract[0]);
  const pushIdx = implement.indexOf("git push origin HEAD");
  assert.ok(parityIdx >= 0 && pushIdx >= 0);
  assert.ok(parityIdx < pushIdx, "the parity requirement must precede the push instruction");
});

// ── (2) the fix rung carries the BYTE-IDENTICAL requirement from the same source ─────────────

test("the fix rung's prompt carries the same shared literal, not a second copy of the rule", async () => {
  const contract = ciParityContractLines();
  const { renderFixPrompt } = await import("../src/run-task.js");
  const fix = renderFixPrompt({
    task: { id: "W1-T295", title: "t" },
    round: 2,
    branch: "run-W1-T295-1",
    evidence: {} as never,
  } as never);
  assert.ok(fix.includes(contract.join("\n")), "the fix rung carries the SAME literal as the implement contract");
});

// ── (3) it is part of the block re-injected verbatim after compaction ────────────────────────

test("the ci-parity requirement survives compaction via renderAnchorBlock", () => {
  const contract = ciParityContractLines();
  const anchor = renderAnchorBlock(
    {
      id: "W1-T295",
      title: "t",
      prompt: "do the thing",
      acceptance: [],
    } as never,
    "run-W1-T295-1",
  );
  assert.ok(anchor.includes(contract.join("\n")), "the anchor re-injected after compaction carries it verbatim");
});

// ── (4) both prompt renderers consume the shared function rather than restating its text ─────

test("outputContractLines and the fix rung compose ciParityContractLines() — not a paraphrase", async () => {
  const contract = ciParityContractLines();
  const implement = outputContractLines("W1-T1").join("\n");
  const { renderFixPrompt } = await import("../src/run-task.js");
  const fix = renderFixPrompt({
    task: { id: "W1-T1", title: "t" },
    round: 1,
    branch: "run-W1-T1-1",
    evidence: {} as never,
  } as never);
  for (const text of [implement, fix]) {
    assert.ok(text.includes(contract.join("\n")), "byte-identical composition, both prompts");
  }
});
