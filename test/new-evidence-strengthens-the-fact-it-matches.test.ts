import assert from "node:assert/strict";
import { test } from "node:test";
import {
  apartReason,
  bestNearDuplicate,
  DEFAULT_DUPLICATE_CUTOFF,
  mergeEvidence,
  mergeOrKeep,
  proofPseudoCountWeight,
  type DuplicateCorpusEntry,
  type EvidenceBearingEntry,
} from "../src/lib/knowledge-dedup.js";

// ── W1-T4683: new evidence strengthens the fact it matches ──────────────────────────────────
//
// The gap this closes: a near-duplicate score above cutoff used to mean only "block or exempt"
// (see task-linter.ts's `learningDuplicateViolation`). For RETRO INTAKE specifically, a near-
// duplicate candidate is often not a duplicate at all — it's the SAME fact observed again, and
// throwing it away (or minting a sibling learning) loses the new evidence. `mergeOrKeep` runs
// the similarity pass and then a second check that keeps a changed number, a flipped negation,
// or a swapped proper name apart even when the shingle score alone would call it a match.

const EXISTING_FACT =
  "the daemon retries a failed job three times before giving up and paging the on-call operator";
/** Same fact, independently observed and worded — no changed number, negation, or name. */
const NEW_OBSERVATION_OF_SAME_FACT =
  "the daemon retries a failed job three times before it gives up and pages the on-call operator";

test("W1-T4683: matching evidence strengthens the existing fact instead of minting a duplicate", () => {
  const activeCorpus: DuplicateCorpusEntry[] = [{ id: "retry-then-page", text: EXISTING_FACT }];

  // Similarity pass alone would already flag this — confirm it clears cutoff before asserting
  // the merge-or-keep decision, so a later regression in `bestNearDuplicate` fails loudly here
  // too rather than only in this file's decision assertion.
  const raw = bestNearDuplicate({ id: "candidate", text: NEW_OBSERVATION_OF_SAME_FACT }, activeCorpus);
  assert.ok(raw && raw.score >= DEFAULT_DUPLICATE_CUTOFF, "the two observations score as near-duplicates");

  const decision = mergeOrKeep({ id: "candidate", text: NEW_OBSERVATION_OF_SAME_FACT }, activeCorpus);
  assert.equal(decision.action, "merge", "a genuine re-observation is a MERGE, not a new fact");
  assert.equal(decision.action === "merge" ? decision.id : undefined, "retry-then-page");

  // The merge itself: evidence is APPENDED (never replaces the fact text) and the proof count
  // rises — the existing entry starts with no recorded evidence and an implicit proof count of
  // one (the original fact itself is the first proof).
  const existing: EvidenceBearingEntry = { id: "retry-then-page", text: EXISTING_FACT };
  const merged = mergeEvidence(existing, "PR #4212 observed the same retry-then-page behavior again on 2026-09-15.");
  assert.equal(merged.id, "retry-then-page", "the surviving id is the EXISTING fact's, not a new one");
  assert.equal(merged.text, EXISTING_FACT, "the fact's text is untouched by a merge");
  assert.deepEqual(merged.evidence, ["PR #4212 observed the same retry-then-page behavior again on 2026-09-15."]);
  assert.equal(merged.proofCount, 2, "one prior implicit proof plus this merge");

  // A SECOND independent observation strengthens it further — evidence accumulates, the proof
  // count keeps rising, and no duplicate id was ever minted across either merge.
  const mergedAgain = mergeEvidence(merged, "Ledger row 2026-09-22T03:11Z: third retry then page, same shape.");
  assert.equal(mergedAgain.evidence.length, 2, "evidence accumulates rather than being overwritten");
  assert.equal(mergedAgain.proofCount, 3);

  // The proof count is a BETA PSEUDO-COUNT that RAISES ranking weight, not a cutoff: strictly
  // increasing, bounded, and a fresh single-proof fact never loses relative to a merged one.
  const weight1 = proofPseudoCountWeight(1);
  const weight2 = proofPseudoCountWeight(merged.proofCount);
  const weight3 = proofPseudoCountWeight(mergedAgain.proofCount);
  assert.ok(weight2 > weight1, "one merge already raises the ranking weight above the unmerged baseline");
  assert.ok(weight3 > weight2, "each further merge raises it again");
  assert.ok(weight3 <= 1, "the weight stays bounded — many merges cannot dominate ranking outright");
});

// ── FALSIFIER: an UNRELATED candidate never gets a merge decision at all ───────────────────────

test("mergeOrKeep: an unrelated candidate keeps for lack of a match, not a merge", () => {
  const activeCorpus: DuplicateCorpusEntry[] = [{ id: "retry-then-page", text: EXISTING_FACT }];
  const decision = mergeOrKeep(
    { id: "candidate", text: "docs are a gated artifact enforced by CI byte equality" },
    activeCorpus,
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.action === "keep" ? decision.reason : undefined, "no-match");
});

// ── ACCEPTANCE 2: a changed number keeps the two facts apart ───────────────────────────────────
//
// `normalizeTokens` drops bare numbers by design (a task id like `W1-T420` must not inflate
// overlap between two entries that merely both cite a task id) — which means `bestNearDuplicate`
// alone is BLIND to a changed count. Two facts differing ONLY in "3 attempts" vs "5 attempts"
// still score as a near-duplicate on shingles; `apartReason`/`mergeOrKeep` catch the raw digits
// BEFORE normalization strips them, so a changed number is never silently merged away.

const RETRY_BUDGET_THREE =
  "the retry budget caps a failed job at 3 attempts before paging the on-call operator";
const RETRY_BUDGET_FIVE =
  "the retry budget caps a failed job at 5 attempts before paging the on-call operator";

test("W1-T4683: a changed number keeps the two facts apart", () => {
  const activeCorpus: DuplicateCorpusEntry[] = [{ id: "retry-budget", text: RETRY_BUDGET_THREE }];

  // The shingle pass alone cannot see the difference — bare numbers are normalized away, so
  // this pair scores as a strong near-duplicate on similarity alone.
  const raw = bestNearDuplicate({ id: "candidate", text: RETRY_BUDGET_FIVE }, activeCorpus);
  assert.ok(raw && raw.score >= DEFAULT_DUPLICATE_CUTOFF, "digit-blind similarity alone would call this a match");

  assert.equal(apartReason(RETRY_BUDGET_FIVE, RETRY_BUDGET_THREE), "changed-number");

  const decision = mergeOrKeep({ id: "candidate", text: RETRY_BUDGET_FIVE }, activeCorpus);
  assert.equal(decision.action, "keep", "a changed number must NEVER be merged into the existing fact");
  assert.equal(decision.action === "keep" ? decision.reason : undefined, "changed-number");

  // PAIRED POSITIVE CONTROL: the identical number, worded differently, IS a merge — so the keep
  // above is the changed digit's doing, not a permanently-broken merge path for this pair shape.
  const sameNumberReworded =
    "the retry budget caps a failed job at 3 attempts before it pages the on-call operator";
  assert.equal(apartReason(sameNumberReworded, RETRY_BUDGET_THREE), undefined);
  const controlDecision = mergeOrKeep({ id: "candidate", text: sameNumberReworded }, activeCorpus);
  assert.equal(controlDecision.action, "merge");
});

// ── a flipped negation keeps two facts apart ────────────────────────────────────────────────────

test("apartReason: a flipped negation keeps two facts apart", () => {
  const safe = "the fallback cache is safe to read during a partial outage";
  const unsafe = "the fallback cache is not safe to read during a partial outage";
  assert.equal(apartReason(unsafe, safe), "negation-changed");
  const decision = mergeOrKeep({ id: "candidate", text: unsafe }, [{ id: "cache-safety", text: safe }]);
  assert.equal(decision.action, "keep");
  assert.equal(decision.action === "keep" ? decision.reason : undefined, "negation-changed");
});

// ── a swapped proper name keeps two facts apart ─────────────────────────────────────────────────

test("apartReason: a swapped proper name keeps two facts apart", () => {
  const craig =
    "the deploy was approved and signed off by Craig before it paged the on-call rotation and closed out the release";
  const priya =
    "the deploy was approved and signed off by Priya before it paged the on-call rotation and closed out the release";
  assert.equal(apartReason(priya, craig), "name-changed");
  const decision = mergeOrKeep({ id: "candidate", text: priya }, [{ id: "deploy-approval", text: craig }]);
  assert.equal(decision.action, "keep");
  assert.equal(decision.action === "keep" ? decision.reason : undefined, "name-changed");
});

// ── mergeEvidence: pure, never mutates its input ────────────────────────────────────────────────

test("mergeEvidence: pure — the existing entry is never mutated", () => {
  const existing: EvidenceBearingEntry = { id: "e", text: "some fact", evidence: ["first proof"], proofCount: 2 };
  const before = JSON.parse(JSON.stringify(existing));
  mergeEvidence(existing, "second proof");
  assert.deepEqual(existing, before, "the caller's entry object is untouched");
});

test("proofPseudoCountWeight: a bounded, non-decreasing multiplier, never a cutoff", () => {
  assert.equal(proofPseudoCountWeight(1), 0.5, "one proof (no merges yet) is the baseline weight");
  assert.ok(proofPseudoCountWeight(0) === proofPseudoCountWeight(1), "a proof count below 1 floors to the baseline");
  assert.ok(proofPseudoCountWeight(10) > proofPseudoCountWeight(2), "more proofs never rank lower");
  assert.ok(proofPseudoCountWeight(1_000_000) <= 1, "bounded — cannot exceed the top of the scale");
});
