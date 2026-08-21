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
  DUPLICATE_SLUG_SHINGLE_K,
  learningDuplicateViolation,
  lintTask,
  planShardSlugCorpus,
  shardSlugFromPath,
  type LintOpts,
} from "../src/lib/task-linter.js";
import { duplicateCorpusOpts, openPlanShardSlugs, shardSlugIndex } from "../src/run-task.js";
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

// ── W1-T1076: the filing-time duplicate corpus, wired and scoring the SLUG ──────────────────
//
// W1-T420 shipped `duplicateTitleViolations` and nothing ever assigned `opts.openTaskTitles`, so
// it returned `[]` on every real lint pass. Wiring it alone would still have caught nothing: the
// house TITLE style is long, shouty, deliberately distinctive prose, and two independent
// descriptions of one mechanism share almost no shingle. The FILENAME SLUG is the opposite.
// Every score asserted below was re-derived on the real predicate against the shards on main.

/** Pair A, filed 2m34s apart on 2026-08-20 by two lanes that could not see each other. Slug
 *  scores 0.200 at k=2 — EXACTLY the cutoff, the smallest margin this check ever catches on —
 *  and 0.111 at k=3, which is why k=3 is not the width used. */
const PAIR_A_SLUG_1 = "self-path-grep-only-read-at-implement-time";
const PAIR_A_SLUG_2 = "self-path-grep-cannot-discriminate-on-an-implementing-diff";
/** The same two shards' real titles, verbatim from main — the fixture criterion 4 needs, because
 *  the point being proved is that adding THESE to the slug makes the score WORSE. */
const PAIR_A_TITLE_1 =
  "A `grep:` PROOF AT A SHARD'S OWN PATH IS ONLY EVER READ AT IMPLEMENT TIME, WHERE THE SHARD IS UNTOUCHED AND THE PROOF IS PROVABLY `executed_stale` \u2014 32 of 414 shards carry 103 such criteria, `proof-scope` ALREADY WARNS ON 97 OF THEM, and its own first-listed remedy (`add the path to files:`) SILENCES the warn without changing the proof; two shards have taken it and both are now `type: implement` tasks scoped to nothing but their own YAML";
const PAIR_A_TITLE_2 =
  "A self-path `grep:` proof discriminates on the FILING PR and CANNOT on the IMPLEMENTING one \u2014 one proof field is read by two reviews with opposite discrimination requirements, and 29 shards carry 96 criteria that will go stale the moment their code is built";
/** Pair B, filed 1m56s apart the same evening. Their shard filenames are BYTE-IDENTICAL apart
 *  from the id, so the slug scores 1.000 at every k. */
const PAIR_B_SLUG = "diff-coverage-is-a-correct-gate-that-runs-too-late";

const shardTask = (id: string) => task({ id, title: `some title for ${id}`, files: ["src/lib/example.ts"] });

test("W1-T1076: an open plan PR carrying a near-duplicate draws a warn", () => {
  const opts: LintOpts = {
    openTaskTitles: [{ id: "W1-T1071", text: PAIR_A_SLUG_2 }],
    duplicateSlug: PAIR_A_SLUG_1,
    duplicateShingleK: DUPLICATE_SLUG_SHINGLE_K,
  };
  const violations = duplicateTitleViolations(shardTask("W1-T1070"), opts);
  assert.equal(violations.length, 1, "the open PR's shard is in the corpus and scores at or above cutoff");
  assert.equal(violations[0].check, "duplicate-title");
  assert.match(violations[0].message, /possible duplicate of W1-T1071/);
  // THE REMEDY MUST BE SAFE TO FOLLOW: `proofScopeViolations` warned on 97 criteria for
  // seventeen days and its remedy text made two shards undeliverable. This one names the
  // sibling, offers two additive answers, and forbids resolving by removing evidence.
  assert.match(violations[0].message, /CITE W1-T1071/);
  assert.match(violations[0].message, /SAY WHY IT DIFFERS/);
  assert.match(violations[0].message, /never for less work/);
  // PAIRED POSITIVE CONTROL: the SAME candidate against a corpus that carries an unrelated
  // slug draws nothing, so the warn above is the corpus entry's doing and not an always-on yes.
  assert.deepEqual(
    duplicateTitleViolations(shardTask("W1-T1070"), { ...opts, openTaskTitles: [{ id: "W1-T999", text: "regenerate-the-cli-reference-docs" }] }),
    [],
  );
});

test("W1-T1076: the duplicate corpus is built from the shard slug", () => {
  const corpus = planShardSlugCorpus([
    "plan/tasks.d/W1-T1071-self-path-grep-cannot-discriminate-on-an-implementing-diff.yaml",
    "src/lib/review.ts",
    "plan/feedback/fb-123.yaml",
    "README.md",
  ]);
  assert.deepEqual(corpus, [{ id: "W1-T1071", text: PAIR_A_SLUG_2 }], "shard paths only, and the text is the SLUG");
  // The slug is what a shard path yields; anything else yields nothing at all.
  assert.deepEqual(shardSlugFromPath("plan/tasks.d/W1-T1074-diff-coverage-is-a-correct-gate-that-runs-too-late.yaml"), {
    id: "W1-T1074",
    text: PAIR_B_SLUG,
  });
  assert.equal(shardSlugFromPath("src/run-task.ts"), undefined);
  assert.equal(shardSlugFromPath("plan/tasks.yaml"), undefined);
  // PAIRED POSITIVE CONTROL on the dedupe: two paths for one id collapse to one entry.
  assert.equal(
    planShardSlugCorpus([
      "plan/tasks.d/W1-T1074-diff-coverage-is-a-correct-gate-that-runs-too-late.yaml",
      "plan/tasks.d/W1-T1074-diff-coverage-is-a-correct-gate-that-runs-too-late.yaml",
    ]).length,
    1,
  );
});

test("W1-T1076: both measured duplicate pairs are caught", () => {
  const at = (candidate: string, id: string, corpusText: string, k: number) =>
    bestNearDuplicate({ id: "CANDIDATE", text: candidate }, [{ id, text: corpusText }], { k });

  const aAtK2 = at(PAIR_A_SLUG_1, "W1-T1071", PAIR_A_SLUG_2, DUPLICATE_SLUG_SHINGLE_K)!;
  const bAtK2 = at(PAIR_B_SLUG, "W1-T1075", PAIR_B_SLUG, DUPLICATE_SLUG_SHINGLE_K)!;
  assert.ok(aAtK2.score >= DEFAULT_DUPLICATE_CUTOFF, `pair A must reach cutoff at k=2, got ${aAtK2.score}`);
  assert.ok(bAtK2.score >= DEFAULT_DUPLICATE_CUTOFF, `pair B must reach cutoff at k=2, got ${bAtK2.score}`);

  // WHY k IS 2 AND NOT THE MODULE DEFAULT: at k=3 pair A drops BELOW cutoff and is missed.
  // This assertion is the whole justification for `DUPLICATE_SLUG_SHINGLE_K` existing.
  const aAtDefaultK = at(PAIR_A_SLUG_1, "W1-T1071", PAIR_A_SLUG_2, 3)!;
  assert.ok(aAtDefaultK.score < DEFAULT_DUPLICATE_CUTOFF, `pair A is MISSED at k=3, got ${aAtDefaultK.score}`);

  // And the check itself, driven end to end, catches both.
  for (const [candidateId, candidateSlug, siblingId, siblingSlug] of [
    ["W1-T1070", PAIR_A_SLUG_1, "W1-T1071", PAIR_A_SLUG_2],
    ["W1-T1074", PAIR_B_SLUG, "W1-T1075", PAIR_B_SLUG],
  ] as const) {
    const violations = duplicateTitleViolations(shardTask(candidateId), {
      openTaskTitles: [{ id: siblingId, text: siblingSlug }],
      duplicateSlug: candidateSlug,
      duplicateShingleK: DUPLICATE_SLUG_SHINGLE_K,
    });
    assert.equal(violations.length, 1, `${candidateId} must be caught against ${siblingId}`);
  }
});

test("W1-T1076: the check scores the slug and not the joined text", () => {
  const k = DUPLICATE_SLUG_SHINGLE_K;
  const slugOnly = bestNearDuplicate({ id: "a", text: PAIR_A_SLUG_1 }, [{ id: "b", text: PAIR_A_SLUG_2 }], { k })!;
  const joined = bestNearDuplicate(
    { id: "a", text: `${PAIR_A_SLUG_1} ${PAIR_A_TITLE_1}` },
    [{ id: "b", text: `${PAIR_A_SLUG_2} ${PAIR_A_TITLE_2}` }],
    { k },
  )!;
  // COUNTER-INTUITIVE AND MEASURED: adding the title makes it WORSE, because the long title
  // floods the shingle set and dilutes the short topical slug's signal.
  assert.ok(joined.score < slugOnly.score, `joined ${joined.score} must be worse than slug ${slugOnly.score}`);
  assert.ok(joined.score < DEFAULT_DUPLICATE_CUTOFF, "and the join drops pair A below cutoff entirely");

  // The check follows the slug, not the join: same corpus, same k, and it warns.
  assert.equal(
    duplicateTitleViolations(shardTask("W1-T1070"), {
      openTaskTitles: [{ id: "W1-T1071", text: PAIR_A_SLUG_2 }],
      duplicateSlug: PAIR_A_SLUG_1,
      duplicateShingleK: k,
    }).length,
    1,
  );
  // PAIRED POSITIVE CONTROL: had it scored the join, this identical call would draw nothing.
  assert.deepEqual(
    duplicateTitleViolations(shardTask("W1-T1070"), {
      openTaskTitles: [{ id: "W1-T1071", text: `${PAIR_A_SLUG_2} ${PAIR_A_TITLE_2}` }],
      duplicateSlug: `${PAIR_A_SLUG_1} ${PAIR_A_TITLE_1}`,
      duplicateShingleK: k,
    }),
    [],
  );
});

test("W1-T1076: an absent corpus leaves the check silent", () => {
  const candidate = shardTask("W1-T1070");
  const slugOpts = { duplicateSlug: PAIR_A_SLUG_1, duplicateShingleK: DUPLICATE_SLUG_SHINGLE_K };
  // No corpus at all, and an EMPTY corpus — a failed GitHub read produces the latter.
  assert.deepEqual(duplicateTitleViolations(candidate, slugOpts), []);
  assert.deepEqual(duplicateTitleViolations(candidate, { ...slugOpts, openTaskTitles: [] }), []);
  assert.equal(lintTask(candidate, slugOpts).ok, true, "and the lint still passes");

  // EVERY FAILURE PATH THROUGH THE READER YIELDS AN EMPTY CORPUS, NEVER A FABRICATED MATCH.
  assert.deepEqual(openPlanShardSlugs({}), [], "a gateway implementing neither optional method");
  assert.deepEqual(
    openPlanShardSlugs({ listOpenHeadBranches: () => null, changedFiles: () => [] }),
    [],
    "null means the read FAILED (W1-T119) — not an empty result to score against",
  );
  assert.deepEqual(
    openPlanShardSlugs({ listOpenHeadBranches: () => [], changedFiles: () => [] }),
    [],
    "and a genuinely empty open-PR list",
  );
  assert.deepEqual(
    openPlanShardSlugs({
      listOpenHeadBranches: () => [{ number: 1, url: "u1", state: "OPEN" }],
      changedFiles: () => undefined,
    }),
    [],
    "a PR whose file list is unavailable contributes nothing",
  );
  // PAIRED POSITIVE CONTROL: the same reader shape, with a readable PR, DOES produce a corpus —
  // so every empty above is a real absence and not a reader that can never return anything.
  assert.deepEqual(
    openPlanShardSlugs({
      listOpenHeadBranches: () => [
        { number: 1, url: "u1", state: "OPEN" },
        { number: 2, url: "u2", state: "OPEN" },
      ],
      changedFiles: (url: string) =>
        url === "u1" ? undefined : ["plan/tasks.d/W1-T1075-diff-coverage-is-a-correct-gate-that-runs-too-late.yaml"],
    }),
    [{ id: "W1-T1075", text: PAIR_B_SLUG }],
  );
  // The candidate side degrades the same way: an unreadable shard directory is an empty index.
  assert.equal(shardSlugIndex("/nonexistent-dir-for-w1-t1076").size, 0);
  const index = shardSlugIndex("ignored", () => [
    "W1-T1074-diff-coverage-is-a-correct-gate-that-runs-too-late.yaml",
    "not-a-shard.txt",
  ]);
  assert.equal(index.get("W1-T1074"), PAIR_B_SLUG);
  assert.equal(index.size, 1);
});

test("W1-T1076: the duplicate violation never blocks a filing", () => {
  const candidate = shardTask("W1-T1074");
  const opts: LintOpts = {
    openTaskTitles: [{ id: "W1-T1075", text: PAIR_B_SLUG }],
    duplicateSlug: PAIR_B_SLUG,
    duplicateShingleK: DUPLICATE_SLUG_SHINGLE_K,
  };
  const violations = duplicateTitleViolations(candidate, opts);
  assert.equal(violations.length, 1, "the strongest possible match — byte-identical slugs, score 1.00");
  assert.equal(violations[0].severity, "warn", "and it is STILL a warn");
  const result = lintTask(candidate, opts);
  assert.ok(result.violations.some((v) => v.check === "duplicate-title"));
  assert.equal(result.ok, true, "lintTask stays ok — a filing is never refused by this check");
  assert.equal(
    result.violations.filter((v) => v.check === "duplicate-title" && v.severity === "block").length,
    0,
    "no arrangement of inputs makes this check blocking",
  );
});

test("W1-T1076: the whole-plan pass supplies no duplicate corpus", () => {
  const corpus = [{ id: "W1-T1075", text: PAIR_B_SLUG }];
  const slugs = new Map([["W1-T1074", PAIR_B_SLUG]]);
  // UNSCOPED — the whole-plan pass. No corpus, no slug, no k: nothing that could have required
  // a network read, which is the property this criterion exists to hold.
  assert.deepEqual(duplicateCorpusOpts(false, "W1-T1074", corpus, slugs), {});
  assert.deepEqual(duplicateTitleViolations(shardTask("W1-T1074"), duplicateCorpusOpts(false, "W1-T1074", corpus, slugs)), []);
  // PAIRED POSITIVE CONTROL: the SCOPED arm over the SAME inputs supplies all three and warns,
  // so the empty above is the scope decision and not an inert helper.
  const scoped = duplicateCorpusOpts(true, "W1-T1074", corpus, slugs);
  assert.deepEqual(scoped, {
    openTaskTitles: corpus,
    duplicateSlug: PAIR_B_SLUG,
    duplicateShingleK: DUPLICATE_SLUG_SHINGLE_K,
  });
  assert.equal(duplicateTitleViolations(shardTask("W1-T1074"), scoped).length, 1);
  // A task with no local shard of its own supplies no slug and falls back to its title.
  assert.equal(duplicateCorpusOpts(true, "W1-T-ABSENT", corpus, slugs).duplicateSlug, undefined);
  assert.equal(duplicateCorpusOpts(true, "W1-T1074", corpus, undefined).duplicateSlug, undefined);
});

test("W1-T1076: two unrelated shards draw no duplicate warn", () => {
  const violations = duplicateTitleViolations(shardTask("W1-T1070"), {
    openTaskTitles: [
      { id: "W1-T900", text: "regenerate-the-cli-reference-docs-from-the-command-registry" },
      { id: "W1-T901", text: "daemon-crash-recovery-flaky-timeout" },
    ],
    duplicateSlug: PAIR_A_SLUG_1,
    duplicateShingleK: DUPLICATE_SLUG_SHINGLE_K,
  });
  assert.deepEqual(violations, [], "unrelated subjects score below cutoff and stay silent");
  // PAIRED POSITIVE CONTROL: adding ONE genuinely near-duplicate slug to that same corpus, at
  // the same k, does warn — so the silence above is the scores and not a broken corpus.
  assert.equal(
    duplicateTitleViolations(shardTask("W1-T1070"), {
      openTaskTitles: [
        { id: "W1-T900", text: "regenerate-the-cli-reference-docs-from-the-command-registry" },
        { id: "W1-T1071", text: PAIR_A_SLUG_2 },
      ],
      duplicateSlug: PAIR_A_SLUG_1,
      duplicateShingleK: DUPLICATE_SLUG_SHINGLE_K,
    }).length,
    1,
  );
});
