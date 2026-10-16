import assert from "node:assert/strict";
import { test } from "node:test";
import { proposePromptEvolutionPromotion, type PromptEvolutionPromotionInput } from "../src/lib/experiment-promotion.js";
import { proposePromptCandidates, validateFixTranscript, type FixRungOutcome, type FixTranscript, type PromptCandidate } from "../src/lib/prompt-evolution.js";

// W1-T9640 — the fix lane's arms are refused at very different rates (62% of codex/gpt-6.1-sol rounds against 22% of
// claude-sonnet-5 rounds, src/lib/fix-routing-learner.ts). A lesson reflected from one arm's refusals must never be
// promoted onto another arm, so transcripts carry their worker model and a promotion is proposed for one model only.

const BASE_PROMPT = "You are the fix-rung worker. Read the failing proof and repair only what it names.";
const SEED = "fix-rung-prompt-v1";
const CODEX = "codex/gpt-6.1-sol";
const SONNET = "claude-sonnet-5";
const REASON_A = "diff touched a file outside the declared scope";
const REASON_B = "acceptance proof was never re-run before commit";

function rows(model: string, reason: string, prefix: string): FixTranscript[] {
  return Array.from({ length: 12 }, (_, i): FixTranscript => ({
    taskId: `${prefix}-${i}`,
    taskShape: "fix",
    model,
    commitRefusedReason: reason,
    excerpt: `round ${i} refused: ${reason}`,
  }));
}

const CORPUS: FixTranscript[] = [...rows(CODEX, REASON_A, "codex"), ...rows(SONNET, REASON_B, "sonnet")];

function input(model: string, runFixRung: PromptEvolutionPromotionInput["runFixRung"]): PromptEvolutionPromotionInput {
  return {
    basePrompt: BASE_PROMPT,
    transcripts: CORPUS,
    seed: SEED,
    model,
    baseline: "fix-rung-prompt-v0",
    scope: { repo: "owner/repo", policyScope: "fix-rung-prompt", taskType: "fix" },
    comparisonPopulation: "owner/repo fix-rung tasks on main",
    denominatorFloor: 10,
    observationWindow: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-08T00:00:00.000Z" },
    guardMetrics: [{ metricName: "commit_refused_rate", unit: "ratio", direction: "max", abortThreshold: 0.5 }],
    maxExposure: 0.1,
    owner: "prompt-evolution",
    expiresAt: "2026-10-22T00:00:00.000Z",
    createdAt: "2026-10-15T00:00:00.000Z",
    rollback: { plan: "Revert to fix-rung-prompt-v0.", reason: "Rollback if commit_refused_rate regresses." },
    runFixRung,
  };
}

/** The lessons reflection draws from one arm's rows alone: every candidate rationale except the base's. */
function lessonsOf(transcripts: readonly FixTranscript[]): string[] {
  return proposePromptCandidates(BASE_PROMPT, transcripts, SEED).filter((c) => c.parentIds.length > 0).map((c) => c.rationale);
}

test("W1-T9640: a prompt candidate learned from one worker model is never promoted onto another", () => {
  const codexLessons = lessonsOf(rows(CODEX, REASON_A, "codex"));
  const sonnetLessons = lessonsOf(rows(SONNET, REASON_B, "sonnet"));
  assert.ok(codexLessons.length > 0 && sonnetLessons.length > 0, "control: each arm alone reflects at least one lesson");
  assert.notDeepEqual(codexLessons, sonnetLessons, "control: the two arms teach different lessons");

  for (const [model, own, other] of [[SONNET, sonnetLessons, codexLessons], [CODEX, codexLessons, sonnetLessons]] as const) {
    const scoredModels = new Set<string>();
    // Any reflected candidate beats the unchanged base, so a promotion is always proposed and its lesson is visible.
    const runFixRung = (candidate: PromptCandidate, t: FixTranscript): FixRungOutcome => {
      scoredModels.add(t.model);
      return candidate.parentIds.length > 0 ? "pass" : "fail";
    };
    const outcome = proposePromptEvolutionPromotion(input(model, runFixRung));
    assert.ok(outcome.promotion, `a promotion is proposed for ${model}: ${outcome.reason ?? ""}`);
    assert.equal(outcome.promotion.scope.model, model, "the promotion is scoped to the model that taught it");
    assert.ok(own.includes(outcome.winner?.rationale ?? ""), `the ${model} winner carries a ${model} lesson`);
    for (const candidate of outcome.candidates) {
      assert.ok(!other.includes(candidate.rationale), `a ${model} candidate carries another model's lesson: ${candidate.rationale}`);
    }
    assert.deepEqual([...scoredModels], [model], `only ${model} rounds were scored`);
  }
});

test("W1-T9640: a fix transcript with no worker model is refused", () => {
  const base = { taskId: "t-1", taskShape: "fix", excerpt: "refused round" };
  assert.equal(validateFixTranscript(base), null, "a transcript with no model is refused");
  assert.equal(validateFixTranscript({ ...base, model: "" }), null, "an empty model is refused");
  assert.equal(validateFixTranscript({ ...base, model: "m".repeat(81) }), null, "an over-long model is refused");
  assert.equal(validateFixTranscript({ ...base, model: ` ${SONNET} ` })?.model, SONNET, "a valid model is kept, trimmed");

  const noModel = proposePromptEvolutionPromotion({ ...input(SONNET, () => "pass"), model: "" });
  assert.equal(noModel.promotion, null, "a promotion is never proposed for no model");
  assert.equal(noModel.reason, "no-model");
});
