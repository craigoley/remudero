import assert from "node:assert/strict";
import { test } from "node:test";
import { ratchetContractLines } from "../src/lib/compaction.js";
import { renderFixPrompt, type FixEvidence } from "../src/run-task.js";

const TASK = { id: "W1-T3064", title: "Fix-rung ratchet contract fixture" };

const UNMET = {
  claim: "the fix-rung contract is delivered",
  proof: "unit test: test/a-fix-rung-carries-the-ratchet-contract-it-was-given.test.ts",
  met: false,
  reason: "executed assertion failed",
  proof_exec: "executed_fail",
} as const;

const MODES: ReadonlyArray<readonly [string, FixEvidence]> = [
  ["merge-conflict", { mergeConflict: { files: [], oursLog: "ours", theirsLog: "theirs" } }],
  ["ci-log", { ciFailures: [{ name: "unit", logTail: "failure" }] }],
  ["gate-fix", { actionableGateFailures: [{ reason: "repair the gate" }] }],
  ["proof-discrimination", { proofDiscrimination: { proofs: [{ claim: "claim", proof: "grep: proof", proofExec: "executed_stale" }] } }],
  ["body-coverage", { review: { unmetCriteria: [{ ...UNMET, reason: "matched 1/2 proof keywords", proof_exec: "not_executable" }], summary: "coverage gap" } }],
  ["reviewer-unmet", { review: { unmetCriteria: [UNMET], summary: "unmet criterion" } }],
];

test("W1-T3064: every fix mode renders the ratchet contract at the delivery seam", () => {
  const contract = ratchetContractLines().join("\n");

  for (const [mode, evidence] of MODES) {
    const prompt = renderFixPrompt({
      task: TASK,
      round: 1,
      branch: "run-W1-T3064-1",
      evidence,
    });

    assert.match(prompt, new RegExp(`MODE: ${mode}`), `fixture reaches ${mode}`);
    assert.ok(prompt.includes(contract), `${mode} carries the complete ratchet contract in rendered output`);
  }
});
