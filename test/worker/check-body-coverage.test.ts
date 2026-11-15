import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveFixMode, renderFixPrompt } from "#src/lib/prompt-render.js";

// Recorded round shape (PR #13946): every unmet reason is a proof-keyword gap, none executed_fail.
const unmet = [{
  claim: "a Claude login that cannot reach the fleet store answers unavailable and creates nothing",
  proof: "unit test: W1-T10511: a Claude login that cannot reach the fleet store answers unavailable",
  met: false,
  reason: "matched 0/6 proof keywords in the report",
  proof_exec: "not_executable" as const,
  criterionIndex: 1,
}];

test("W1-T10661: a recorded body-coverage round is self-healed with a paste-ready Acceptance block", () => {
  const evidence = { review: { unmetCriteria: unmet, summary: "keyword gap" } };
  assert.equal(deriveFixMode(evidence), "body-coverage");
  const prompt = renderFixPrompt({ task: { id: "W1-T10511", title: "t" }, round: 1, branch: "run-W1-T10511-1", evidence });
  assert.match(prompt, /Paste-ready PR body Acceptance block/);
  assert.ok(prompt.includes(`- Criterion 1: ${unmet[0].claim} — proven by ${unmet[0].proof}`));
});
