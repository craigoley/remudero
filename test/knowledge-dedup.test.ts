import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bestNearDuplicate,
  DEFAULT_DUPLICATE_CUTOFF,
  jaccardSimilarity,
  normalizeTokens,
  shingle,
  type DuplicateCorpusEntry,
} from "../src/lib/knowledge-dedup.js";
import {
  duplicateTitleViolations,
  learningDuplicateViolation,
  lintTask,
  type LintOpts,
} from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// ── W1-T420: duplicate-closure at knowledge intake ───────────────────────────
//
// Deterministic token-shingle/Jaccard similarity, not embeddings — offline, reproducible, and
// its documented miss shape (paraphrase evades it) is exercised below rather than left to be
// discovered. BLOCKING for learnings intake, ADVISORY (warn-only) for task-title intake.

/** A minimal, otherwise-clean Task fixture — mirrors the rest of the linter's own test suite
 *  (see test/lint-proof-scope.test.ts's identical helper). */
function task(over: Partial<Task> & { id: string; title: string }): Task {
  return {
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
    ...over,
  };
}

// ── bestNearDuplicate: the pure module itself ────────────────────────────────

test("bestNearDuplicate: an empty corpus yields no match", () => {
  assert.equal(bestNearDuplicate({ id: "a", text: "anything at all" }, []), undefined);
});

test("FALSIFIER: a corpus of one entry never matches itself", () => {
  const entry: DuplicateCorpusEntry = { id: "solo", text: "the exact same text, word for word" };
  const match = bestNearDuplicate(entry, [entry]);
  assert.equal(match, undefined, "the only corpus entry IS the candidate — excluded by id, not scored");
});

test("bestNearDuplicate: identical text under a DIFFERENT id scores 1.0", () => {
  const a: DuplicateCorpusEntry = { id: "a", text: "the same fact stated the same way every time" };
  const b: DuplicateCorpusEntry = { id: "b", text: "the same fact stated the same way every time" };
  const match = bestNearDuplicate(a, [b]);
  assert.equal(match?.id, "b");
  assert.equal(match?.score, 1);
});

test("bestNearDuplicate: picks the BEST match among several corpus entries", () => {
  const candidate: DuplicateCorpusEntry = { id: "cand", text: "the daemon splits scheduler logic from live commissioning" };
  const corpus: DuplicateCorpusEntry[] = [
    { id: "unrelated", text: "prompt caches key on exact prefix bytes, assemble stable first" },
    { id: "close", text: "the daemon splits its scheduler logic from live commissioning work" },
    { id: "distant", text: "documentation is a gated artifact enforced by CI byte equality" },
  ];
  const match = bestNearDuplicate(candidate, corpus);
  assert.equal(match?.id, "close", "the near-identical entry beats the unrelated ones");
});

test("normalizeTokens: lowercases, splits camelCase, strips punctuation/stopwords/numbers", () => {
  const tokens = normalizeTokens("The maxTurns budget for W1-T420 is over the limit!");
  assert.ok(!tokens.includes("the"), "stopword dropped");
  assert.ok(!tokens.includes("420"), "bare number dropped");
  assert.ok(tokens.includes("max"), "camelCase split: maxTurns -> max");
  assert.ok(tokens.includes("turns"), "camelCase split: maxTurns -> turns");
});

test("shingle: a token list shorter than k collapses to ONE shingle, not the empty set", () => {
  const s = shingle(["alpha", "beta"], 3);
  assert.equal(s.size, 1);
  assert.ok(s.has("alpha beta"));
});

test("shingle: an empty token list yields the empty set", () => {
  assert.equal(shingle([], 3).size, 0);
});

test("jaccardSimilarity: two empty sets score 0, not a vacuous 1", () => {
  assert.equal(jaccardSimilarity(new Set(), new Set()), 0);
});

// ── ACCEPTANCE (design falsifier): a fixture pair that is the SAME LESSON REWORDED scores
//    above cutoff — verbatim-and-near re-learning is exactly what this check exists to catch.

const ORIGINAL_FACT =
  "Context is a precious, FINITE resource: find the smallest set of high-signal tokens that " +
  "maximize the desired outcome — do not dump everything known into the prompt.";
const REWORDED_FACT =
  "Context is a precious, LIMITED resource: find the smallest set of high-signal tokens that " +
  "maximizes the desired outcome — don't dump everything known into the prompt.";
/** A HEAVY paraphrase of the same idea — the documented miss shape (paraphrase evades a
 *  shingle-overlap check). Locked here so the miss is a known, tested behavior, not a
 *  surprise discovered later. */
const HEAVY_PARAPHRASE_FACT =
  "Since the model's context window is limited, prompts should include only the most useful " +
  "information needed to achieve the goal, rather than everything available.";

test("a near-verbatim reworded fact scores ABOVE the default cutoff", () => {
  const match = bestNearDuplicate({ id: "new", text: REWORDED_FACT }, [{ id: "orig", text: ORIGINAL_FACT }]);
  assert.ok(match && match.score >= DEFAULT_DUPLICATE_CUTOFF, `expected >= ${DEFAULT_DUPLICATE_CUTOFF}, got ${match?.score}`);
});

test("DOCUMENTED MISS: a heavy paraphrase of the same fact scores below cutoff", () => {
  const match = bestNearDuplicate({ id: "new", text: HEAVY_PARAPHRASE_FACT }, [{ id: "orig", text: ORIGINAL_FACT }]);
  assert.ok(!match || match.score < DEFAULT_DUPLICATE_CUTOFF, "paraphrase evades shingle overlap — the stated miss shape");
});

// ── ACCEPTANCE 1 & (falsifier): learnings intake — BLOCKING, with the answerable exemption ──

test("ACCEPTANCE 1: a near-duplicate active learning is refused with a pointer naming the existing id and the measured score", () => {
  const activeCorpus: DuplicateCorpusEntry[] = [{ id: "context-economy", text: ORIGINAL_FACT }];
  const v = learningDuplicateViolation({ id: "context-economy-again", text: REWORDED_FACT }, activeCorpus);
  assert.ok(v, "expected a BLOCKING violation");
  assert.equal(v?.check, "duplicate-learning");
  assert.equal(v?.severity, "block");
  assert.match(v!.message, /possible duplicate of context-economy/);
  assert.match(v!.message, /\d\.\d\d/, "the measured score is named in the message");
});

test("ACCEPTANCE 1 (falsifier): a stated distinction naming the matched id clears the block", () => {
  const activeCorpus: DuplicateCorpusEntry[] = [{ id: "context-economy", text: ORIGINAL_FACT }];
  const v = learningDuplicateViolation({ id: "context-economy-again", text: REWORDED_FACT }, activeCorpus, {
    distinction: { existingId: "context-economy", statement: "this one is scoped to retro compaction, not live prompting" },
  });
  assert.equal(v, undefined, "an answerable distinction clears the refusal");
});

test("a distinction naming the WRONG id does NOT clear the block", () => {
  const activeCorpus: DuplicateCorpusEntry[] = [{ id: "context-economy", text: ORIGINAL_FACT }];
  const v = learningDuplicateViolation({ id: "context-economy-again", text: REWORDED_FACT }, activeCorpus, {
    distinction: { existingId: "some-other-id", statement: "unrelated" },
  });
  assert.ok(v, "a distinction that doesn't name the actual match is not an exemption");
});

test("an unrelated new fact against the active corpus is not blocked", () => {
  const activeCorpus: DuplicateCorpusEntry[] = [{ id: "context-economy", text: ORIGINAL_FACT }];
  const v = learningDuplicateViolation(
    { id: "new-fact", text: "Docs are a gated artifact: generated docs drift unless CI enforces byte equality." },
    activeCorpus,
  );
  assert.equal(v, undefined);
});

// ── ACCEPTANCE 3: task-title intake — ADVISORY, never blocking ──────────────────────────────

/** A W1-T369/T370-shaped sibling pair: distinct, legitimate work in the same arc that happens
 *  to read very similarly — the design's own example of a title pair that MUST warn, never
 *  block, even though it scores high. */
const SIBLING_TITLE_A = "the citation-loop worker records which learnings a task actually cited during its run";
const SIBLING_TITLE_B = "the citation-loop worker records which learnings a task actually cited during its retro";

test("ACCEPTANCE 3: a sibling task title above cutoff WARNS, and lintTask stays ok:true", () => {
  const candidate = task({ id: "W1-T900", title: SIBLING_TITLE_A, files: ["src/lib/example.ts"] });
  const opts: LintOpts = { openTaskTitles: [{ id: "W1-T901", text: SIBLING_TITLE_B }] };

  const direct = duplicateTitleViolations(candidate, opts);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].check, "duplicate-title");
  assert.equal(direct[0].severity, "warn");
  assert.match(direct[0].message, /possible duplicate of W1-T901/);

  const result = lintTask(candidate, opts);
  assert.ok(
    result.violations.some((v) => v.check === "duplicate-title"),
    "the warn is present in the aggregated result",
  );
  assert.equal(result.ok, true, "a WARN never flips lintTask's ok — advisory, never blocking");
});

test("a task title with no near-duplicate among open titles is silent", () => {
  const candidate = task({ id: "W1-T902", title: "regenerate the CLI reference docs from the command registry" });
  const opts: LintOpts = {
    openTaskTitles: [{ id: "W1-T903", text: "fix a flaky timeout in the daemon's crash-recovery test" }],
  };
  assert.deepEqual(duplicateTitleViolations(candidate, opts), []);
});

test("duplicateTitleViolations is silent absent opts.openTaskTitles — no corpus supplied, no opinion", () => {
  const candidate = task({ id: "W1-T904", title: SIBLING_TITLE_A });
  assert.deepEqual(duplicateTitleViolations(candidate, {}), []);
});

// ── ACCEPTANCE 2: purity — the module never reads disk, both consumers pass their own corpus ─

test("ACCEPTANCE 2: bestNearDuplicate is pure — identical inputs always yield identical output", () => {
  const candidate: DuplicateCorpusEntry = { id: "x", text: REWORDED_FACT };
  const corpus: DuplicateCorpusEntry[] = [{ id: "y", text: ORIGINAL_FACT }];
  const first = bestNearDuplicate(candidate, corpus);
  const second = bestNearDuplicate(candidate, corpus);
  assert.deepEqual(first, second, "no hidden state — same inputs, same result, every call");
});

test("ACCEPTANCE 2: both consumers score entirely off a FABRICATED corpus, never a disk read", () => {
  // These ids/texts exist nowhere in learnings/*.yaml or plan/tasks.yaml — if either consumer
  // secretly read the real corpus instead of the one passed in, this would be indistinguishable
  // from an empty result. It isn't: the fabricated corpus alone drives the match.
  const fabricatedActive: DuplicateCorpusEntry[] = [
    { id: "totally-made-up-entry", text: "a fabricated fact that exists only in this test file, nowhere on disk" },
  ];
  const learningViolation = learningDuplicateViolation(
    { id: "also-made-up", text: "a fabricated fact that exists only in this test file and not on disk" },
    fabricatedActive,
  );
  assert.ok(learningViolation, "the fabricated corpus alone is enough to produce a match");
  assert.match(learningViolation!.message, /totally-made-up-entry/);

  const fabricatedTitles: LintOpts = {
    openTaskTitles: [{ id: "W1-T-FAKE", text: "a completely fabricated task title used only in this test" }],
  };
  const titleViolations = duplicateTitleViolations(
    task({ id: "W1-T-FAKE-2", title: "a completely fabricated task title used only in this test file" }),
    fabricatedTitles,
  );
  assert.equal(titleViolations.length, 1);
  assert.match(titleViolations[0].message, /W1-T-FAKE\b/);
});
