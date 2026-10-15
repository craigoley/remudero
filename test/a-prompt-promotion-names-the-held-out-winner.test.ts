import assert from "node:assert/strict";
import { test } from "node:test";
import { proposePromptEvolutionPromotion, type PromptEvolutionPromotionInput } from "../src/lib/experiment-promotion.js";
import { splitHeldOut, type FixRungOutcome, type FixTranscript } from "../src/lib/prompt-evolution.js";

const BASE_PROMPT = "You are the fix-rung worker. Read the failing proof and repair only what it names.";
const SEED = "fix-rung-prompt-v1";

function corpus(): FixTranscript[] {
  const scope = Array.from({ length: 10 }, (_, i): FixTranscript => ({
    taskId: `scope-${i}`,
    taskShape: "fix",
    commitRefusedReason: "diff touched a file outside the declared scope",
    excerpt: "the diff edited a file outside the task's declared files: list",
  }));
  const proof = Array.from({ length: 10 }, (_, i): FixTranscript => ({
    taskId: `proof-${i}`,
    taskShape: "implement",
    commitRefusedReason: "acceptance proof was never re-run before commit",
    excerpt: "the worker committed without re-running the grep proof named in acceptance",
  }));
  return [...scope, ...proof];
}

function input(overrides: Partial<PromptEvolutionPromotionInput> = {}): PromptEvolutionPromotionInput {
  return {
    basePrompt: BASE_PROMPT,
    transcripts: corpus(),
    seed: SEED,
    baseline: "fix-rung-prompt-v0",
    scope: { repo: "owner/repo", policyScope: "fix-rung-prompt", taskType: "fix" },
    comparisonPopulation: "owner/repo fix-rung tasks on main",
    denominatorFloor: 10,
    observationWindow: { start: "2026-09-18T10:00:00.000Z", end: "2026-09-25T10:00:00.000Z" },
    guardMetrics: [{ metricName: "commit_refused_rate", unit: "ratio", direction: "max", abortThreshold: 0.5 }],
    maxExposure: 0.1,
    owner: "prompt-evolution",
    expiresAt: "2026-10-02T10:00:00.000Z",
    createdAt: "2026-09-28T10:00:00.000Z",
    rollback: { plan: "Revert to fix-rung-prompt-v0.", reason: "Rollback if commit_refused_rate regresses." },
    ...overrides,
  };
}

test("W1-T9639: a prompt promotion names the held-out winner, never the unscored base", () => {
  const heldOutIds = new Set(splitHeldOut(corpus(), SEED).heldOut.map((t) => t.taskId));
  const probe = proposePromptEvolutionPromotion(input({ runFixRung: () => "fail" }));
  const reflected = probe.candidates.filter((c) => c.parentIds.length > 0);
  assert.ok(reflected.length >= 2, "expected at least two reflected candidates");
  const [better, weaker] = reflected;

  // `better` passes every held-out case, `weaker` passes only the fix shape, the base passes nothing.
  const runFixRung = (candidate: { id: string }, t: FixTranscript): FixRungOutcome => {
    assert.ok(heldOutIds.has(t.taskId), "scoring must only ever see held-out transcripts");
    if (candidate.id === better!.id) return "pass";
    if (candidate.id === weaker!.id && t.taskShape === "fix") return "pass";
    return "fail";
  };
  const outcome = proposePromptEvolutionPromotion(input({ runFixRung }));

  assert.equal(outcome.winner?.id, better!.id);
  assert.notEqual(outcome.winner?.id, "base");
  assert.equal(outcome.promotion?.candidate, better!.id);
  assert.equal(outcome.promotion?.state, "proposed");
  assert.equal(outcome.reason, undefined);
  assert.equal(outcome.scores.length, outcome.candidates.length);
  const baseScore = outcome.scores.find((s) => s.candidateId === "base");
  const winnerScore = outcome.scores.find((s) => s.candidateId === better!.id);
  assert.ok(baseScore && winnerScore && winnerScore.overall.passRate > baseScore.overall.passRate);
});

test("W1-T9639: an unscored or base-winning evolution proposes no promotion", () => {
  // No runFixRung: nothing was scored, so nothing is proposed.
  const unscored = proposePromptEvolutionPromotion(input());
  assert.equal(unscored.promotion, null);
  assert.equal(unscored.winner, undefined);
  assert.equal(unscored.reason, "unscored");
  assert.deepEqual(unscored.scores, []);
  assert.ok(unscored.candidates.length > 1, "candidates are still proposed, just not promoted");

  // Nothing beats the base (all tie): the base is the baseline, never promoted.
  const tie = proposePromptEvolutionPromotion(input({ runFixRung: () => "pass" }));
  assert.equal(tie.promotion, null);
  assert.equal(tie.winner, undefined);
  assert.equal(tie.reason, "base-not-beaten");

  // The base beats every reflected candidate.
  const baseWins = proposePromptEvolutionPromotion(
    input({ runFixRung: (candidate) => (candidate.parentIds.length === 0 ? "pass" : "fail") }),
  );
  assert.equal(baseWins.promotion, null);
  assert.equal(baseWins.reason, "base-not-beaten");

  // No held-out case to score the base on.
  const empty = proposePromptEvolutionPromotion(input({ transcripts: [], runFixRung: () => "pass" }));
  assert.equal(empty.promotion, null);
  assert.equal(empty.reason, "no-held-out-cases");

  // No candidates at all (invalid base prompt).
  const none = proposePromptEvolutionPromotion(input({ basePrompt: "", runFixRung: () => "pass" }));
  assert.equal(none.promotion, null);
  assert.equal(none.reason, "no-candidates");

  // A winner whose record fails validation is surfaced, not silently dropped.
  const invalid = proposePromptEvolutionPromotion(
    input({ denominatorFloor: 0, runFixRung: (candidate) => (candidate.parentIds.length === 0 ? "fail" : "pass") }),
  );
  assert.equal(invalid.promotion, null);
  assert.ok(invalid.winner);
  assert.equal(invalid.reason, "invalid-promotion");
});
