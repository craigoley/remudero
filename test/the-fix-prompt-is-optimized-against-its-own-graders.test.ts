import assert from "node:assert/strict";
import { test } from "node:test";
import {
  paretoFront,
  proposePromptCandidates,
  reflectOnTranscripts,
  scoreCandidatesOnHeldOut,
  splitHeldOut,
  validateFixTranscript,
  type FixTranscript,
  type FixRungOutcome,
} from "../src/lib/prompt-evolution.js";
import {
  EXPERIMENT_PROMOTION_VERSION,
  proposePromptEvolutionPromotion,
  type PromptEvolutionPromotionInput,
} from "../src/lib/experiment-promotion.js";

const BASE_PROMPT = "You are the fix-rung worker. Read the failing proof and repair only what it names.";

function transcript(overrides: Partial<FixTranscript> & { taskId: string }): FixTranscript {
  return {
    taskShape: "fix",
    commitRefusedReason: "diff touched a file outside the declared scope",
    excerpt: "the diff edited src/lib/unrelated.ts, which is not in files:",
    ...overrides,
  };
}

// A corpus large enough, and spread across enough distinct taskIds, that a seeded 50/50 hash split
// reliably lands transcripts on both sides for every test below.
function recordedCorpus(): FixTranscript[] {
  const scopeFailures = Array.from({ length: 10 }, (_, i) =>
    transcript({
      taskId: `scope-${i}`,
      taskShape: "fix",
      commitRefusedReason: "diff touched a file outside the declared scope",
      excerpt: "the diff edited a file outside the task's declared files: list",
    }),
  );
  const missingProofFailures = Array.from({ length: 10 }, (_, i) =>
    transcript({
      taskId: `proof-${i}`,
      taskShape: "implement",
      commitRefusedReason: "acceptance proof was never re-run before commit",
      excerpt: "the worker committed without re-running the grep proof named in acceptance",
    }),
  );
  return [...scopeFailures, ...missingProofFailures];
}

test("W1-T4665: candidates are proposed from recorded fix transcripts and scored on a held-out half", () => {
  const corpus = recordedCorpus();
  const seed = "fix-rung-prompt-v1";

  // The split is deterministic and disjoint.
  const { train, heldOut } = splitHeldOut(corpus, seed);
  assert.ok(train.length > 0, "expected a non-empty train half");
  assert.ok(heldOut.length > 0, "expected a non-empty held-out half");
  assert.equal(train.length + heldOut.length, corpus.length);
  const trainIds = new Set(train.map((t) => t.taskId));
  for (const item of heldOut) assert.ok(!trainIds.has(item.taskId), `${item.taskId} appeared on both sides of the split`);

  // Reflection groups transcripts by their recorded commit_refused reason, in natural language —
  // never a random mutation — and candidates are proposed from that reflection.
  const reflections = reflectOnTranscripts(train);
  assert.ok(reflections.length > 0, "expected at least one reflected failure signature");
  for (const reflection of reflections) {
    assert.ok(reflection.lesson.includes(reflection.reason), "the lesson must name the failure signature it reflects on");
  }

  const candidates = proposePromptCandidates(BASE_PROMPT, corpus, seed);
  assert.ok(candidates.length > 1, "expected more than just the unmodified base candidate");
  const base = candidates.find((c) => c.parentIds.length === 0);
  assert.ok(base, "expected the unmodified base prompt to remain a candidate");
  assert.equal(base?.promptText, BASE_PROMPT);
  for (const candidate of candidates) {
    if (candidate.parentIds.length === 0) continue;
    assert.ok(candidate.promptText.startsWith(BASE_PROMPT), "a mutated candidate must still carry the base prompt");
    assert.ok(candidate.rationale.length > 0, "every mutated candidate must carry its reflection rationale");
  }

  // Scoring reads the HELD-OUT half only: a candidate that resolves every held-out scope-failure
  // case (by task shape) scores 1.0 on that shape, while an unrelated candidate does not.
  const scopeCandidate = candidates.find((c) => c.taskShapes.includes("fix"));
  assert.ok(scopeCandidate, "expected a candidate reflecting on the fix-shape failures");
  const scoredHeldOutIds = new Set(splitHeldOut(corpus, seed).heldOut.map((t) => t.taskId));

  const runFixRung = (candidate: { id: string }, t: FixTranscript): FixRungOutcome => {
    // Simulates re-running the fix rung in a sealed side worktree: the candidate that reflected on
    // this failure's exact shape resolves it; every other candidate does not.
    assert.ok(scoredHeldOutIds.has(t.taskId), "scoring must only ever be called on held-out transcripts");
    if (candidate.id === scopeCandidate!.id && t.taskShape === "fix") return "pass";
    return "fail";
  };

  const scores = scoreCandidatesOnHeldOut(candidates, corpus, seed, runFixRung);
  const scopeScore = scores.find((s) => s.candidateId === scopeCandidate!.id);
  assert.ok(scopeScore, "expected a score for the fix-shape candidate");
  const fixShapeScore = scopeScore?.byShape.fix;
  assert.ok(fixShapeScore && fixShapeScore.passRate === 1, "the reflecting candidate should resolve every held-out fix-shape case");

  // Pareto selection keeps the shape-specialised winner rather than erasing it behind an average.
  const front = paretoFront(scores);
  assert.ok(
    front.some((s) => s.candidateId === scopeCandidate!.id),
    "the candidate that dominates on the fix shape must survive the Pareto front",
  );

  // A malformed recorded transcript is refused, not silently coerced.
  assert.equal(validateFixTranscript({ taskId: "x" }), null);
  assert.equal(validateFixTranscript("not-an-object"), null);

  // The optional fields are refused individually too, not only when a required field is missing --
  // an out-of-bounds commitRefusedReason or reviewerVerdict is never silently accepted.
  assert.equal(
    validateFixTranscript({ taskId: "y", taskShape: "fix", excerpt: "ok", commitRefusedReason: "" }),
    null,
    "an empty commitRefusedReason must be refused",
  );
  assert.equal(
    validateFixTranscript({ taskId: "z", taskShape: "fix", excerpt: "ok", reviewerVerdict: "v".repeat(400) }),
    null,
    "an over-long reviewerVerdict must be refused",
  );
  // A transcript may carry a reviewerVerdict instead of (or alongside) a commitRefusedReason.
  const withVerdict = validateFixTranscript({
    taskId: "verdict-only",
    taskShape: "fix",
    excerpt: "ok",
    reviewerVerdict: "changes requested: scope violation",
  });
  assert.equal(withVerdict?.reviewerVerdict, "changes requested: scope violation");

  // A duplicate taskId and a malformed entry mixed into the raw corpus are both dropped, not
  // counted on either side of the split.
  const withDuplicatesAndJunk = [
    ...corpus,
    { taskId: "scope-0", taskShape: "fix", excerpt: "duplicate of an already-seen taskId" },
    "not-an-object",
    { taskId: "bad" },
  ];
  const deduped = splitHeldOut(withDuplicatesAndJunk, seed);
  assert.equal(
    deduped.train.length + deduped.heldOut.length,
    corpus.length,
    "a duplicate taskId and malformed entries must never inflate the split",
  );

  // An invalid basePrompt or seed proposes nothing at all, rather than a partial candidate list.
  assert.deepEqual(proposePromptCandidates("", corpus, seed), []);
  assert.deepEqual(proposePromptCandidates(BASE_PROMPT, corpus, ""), []);
});

test("W1-T4665: no candidate reaches production except through experiment-promotion", () => {
  const corpus = recordedCorpus();
  const input: PromptEvolutionPromotionInput = {
    basePrompt: BASE_PROMPT,
    transcripts: corpus,
    seed: "fix-rung-prompt-v1",
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
  };

  const outcome = proposePromptEvolutionPromotion(input);
  assert.ok(outcome.winner, "expected a winning candidate to be proposed");
  assert.ok(outcome.promotion, "expected the winning candidate to be wrapped as a promotion record");
  assert.equal(outcome.promotion?.version, EXPERIMENT_PROMOTION_VERSION);
  // A proposed candidate always starts in `proposed` — never `shadow`, `canary`, or `promoted` —
  // so it must still be advanced through experiment-promotion's own guarded state machine.
  assert.equal(outcome.promotion?.state, "proposed");
  assert.equal(outcome.promotion?.candidate, outcome.winner?.id);
  assert.equal(outcome.promotion?.baseline, input.baseline);

  // Proposing from an empty corpus yields only the unmodified base candidate (id "base"). Naming
  // that same id as the baseline makes candidate === baseline, which validatePromotionRecord
  // refuses outright — so a candidate identical to its own baseline never smuggles a promotion
  // through unguarded; the guard is `validatePromotionRecord` itself, not a special case here.
  const emptyOutcome = proposePromptEvolutionPromotion({ ...input, transcripts: [], baseline: "base" });
  assert.equal(emptyOutcome.winner?.id, "base");
  assert.equal(emptyOutcome.promotion, null, "a candidate identical to its own baseline must never validate as a promotion");

  // An invalid basePrompt proposes no candidates at all, so there is no winner and therefore no
  // promotion to wrap -- never a promotion built from a partial or missing candidate.
  const noCandidateOutcome = proposePromptEvolutionPromotion({ ...input, basePrompt: "" });
  assert.equal(noCandidateOutcome.winner, undefined);
  assert.equal(noCandidateOutcome.promotion, null);
});
