/**
 * Deterministic near-duplicate detection for knowledge intake (W1-T420).
 *
 * STACK OVERFLOW'S DUPLICATE CLOSURE — "possible duplicate of <canonical>", close with a
 * pointer, reopenable by argument — is the mechanism that kept ten million questions usable.
 * This repo's inversion is stronger: the corpus's only reader is the injection engine, so a
 * duplicate learning costs double context-tax against the knowledge budget AND splits whatever
 * citation signal collects against a fact across two ids. Recurrence evidence is this repo's
 * own: the diff-coverage lesson was earned three times (#768/#773/#777), the wiring-not-proved
 * shape accumulated nine task titles after Standing rule 14 already stated it (W1-T365's
 * census), and the bound-fires-healthy class was named and then re-instanced twice (W1-T312
 * lineage). Each repeat means the knowledge existed and intake did not consult it.
 *
 * WHY DETERMINISTIC AND NOT SEMANTIC: an embedding check is a model call inside a lint path —
 * nondeterministic, priced, and unfalsifiable at review. Token-shingle overlap (normalized
 * words, k-shingles, Jaccard) is offline, reproducible, and its miss shape is known and stated
 * here rather than discovered later: PARAPHRASE EVADES IT. Two facts/titles that say the same
 * thing in different words can legitimately score below cutoff. This module catches
 * verbatim-and-near re-statement, not semantic equivalence — that is the tradeoff for staying
 * deterministic and free, and it is a deliberate, documented miss, not an oversight.
 *
 * PURE OVER ITS INPUTS (the task-linter purity contract, the same seam discipline as
 * `moduleExists` in src/lib/task-linter.ts): this module never reads disk, never imports
 * `node:fs`, and never reaches into any other src/lib module for state. Every consumer supplies
 * its own corpus — the learnings-intake consumer passes the active learnings shard entries, the
 * task-title consumer passes other open tasks' titles — so the SAME algorithm serves both
 * without this module ever knowing which corpus it is looking at.
 *
 * `bestNearDuplicate` is the one load-bearing export: callers grep for its name to prove it is
 * actually wired into a consumer (see src/lib/task-linter.ts's `duplicateTitleViolations` and
 * `learningDuplicateViolation`), so its name and signature are the stable contract here.
 *
 * MERGE-OR-KEEP (W1-T4683): a near-duplicate score above cutoff is not, by itself, license to
 * treat two facts as the same fact. Hindsight's consolidation prefers updating an existing
 * belief with new evidence over minting a sibling, and feeds a proof count into ranking as a
 * bounded multiplier (`proof_norm = 0.5 + ln(n)/10`) rather than gating on a hard cutoff. This
 * module's own miss shape cuts the other way too: two SHORT facts that differ only in a changed
 * number, a flipped negation, or a swapped proper name can still shingle-overlap heavily (most
 * of their tokens are identical), and merging those would silently corrupt the surviving fact —
 * worse than the duplicate this check exists to catch. `mergeOrKeep` runs the same similarity
 * pass as `bestNearDuplicate` and then a second, cheap check (`apartReason`) that keeps a
 * candidate separate when the two texts disagree on a number, a negation, or a capitalized name,
 * even above cutoff. Only a match that clears BOTH is a `merge` decision; `mergeEvidence` then
 * appends the new evidence and raises the proof count, and `proofPseudoCountWeight` turns that
 * count into the bounded Beta-pseudo-count multiplier ranking consumes. This module still never
 * reads disk and never mints ids: callers decide what "the fact" and "the evidence" mean for
 * their own corpus, same as `bestNearDuplicate` today.
 */

/** One entry in a corpus to compare a candidate against — an id (excluded from its own
 *  matches, see {@link bestNearDuplicate}) and the text to shingle/compare. */
export interface DuplicateCorpusEntry {
  id: string;
  text: string;
}

/** The best-scoring corpus entry for a candidate, and its Jaccard score in [0, 1]. */
export interface DuplicateMatch {
  id: string;
  score: number;
}

export interface BestNearDuplicateOpts {
  /** Shingle width, in normalized tokens. Default {@link DEFAULT_SHINGLE_K}. */
  k?: number;
}

/** Default k-shingle width — 3 normalized tokens. Small enough that short task titles and
 *  one-line learning facts still produce a comparable shingle set (see {@link shingle} for
 *  the short-text fallback), large enough that generic 1-2 word overlaps ("the daemon",
 *  "task linter") don't dominate the score. */
export const DEFAULT_SHINGLE_K = 3;

/**
 * MEASURED, not asserted (design point (ii)): the pairwise-best-match score distribution over
 * the current active learnings corpus and the current open task titles, at this default k=3.
 * Full numbers are in this PR's body; the shape that matters for the cutoff is:
 *
 *   - learnings (35 active entries, all five shards): every one of the 35 best-match scores is
 *     UNDER 0.06; the ceiling (highest score any entry gets against the rest of the live
 *     corpus) is 0.053.
 *   - open task titles (427 open tasks at filing): every best-match score is under 0.10; the
 *     ceiling is 0.091 (`W1-T48` vs `W1-T49`, a legitimate sibling pair).
 *   - a genuinely reworded near-duplicate (same fact, several words swapped, same structure —
 *     the falsifier's "same lesson reworded" shape) scores 0.28-0.36 in both corpora.
 *   - a light paraphrase (same idea, different wording and structure) scores ~0.14 — BELOW this
 *     cutoff, and stays below by design: this is the documented miss shape (paraphrase evades
 *     shingle overlap), not a bug to chase by lowering the cutoff into the live ceiling.
 *
 * 0.2 sits comfortably above BOTH observed ceilings (3.8x the learnings ceiling, 2.2x the
 * task-title ceiling — zero false positives against either live population today) while
 * staying well below the near-duplicate signal (0.28-0.36) that the falsifier requires this
 * check to catch. Both consumers in src/lib/task-linter.ts default to this constant; either may
 * override via `opts` without a code change here.
 */
export const DEFAULT_DUPLICATE_CUTOFF = 0.2;

/** Generic words that carry no distinguishing signal for near-duplicate comparison — excluded
 *  before shingling so two facts sharing only function words never score as similar. Small and
 *  local to this module (not imported from src/lib/review.ts's own stopword list) — this module
 *  imports nothing else in src/lib, by design (see the module comment above). */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "but",
  "by",
  "can",
  "do",
  "does",
  "each",
  "every",
  "for",
  "from",
  "had",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "not",
  "of",
  "on",
  "or",
  "over",
  "per",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

/**
 * Normalize free text into comparable tokens: split camelCase/PascalCase BEFORE lowercasing
 * (mirrors review.ts's own tokenizer rationale — `maxTurns` must reduce the same way as
 * `max_turns` or `max-turns`), lowercase, split on any non-alphanumeric run, drop stopwords,
 * drop bare numbers (task ids like `W1-T420` reduce to `w1`/`t420` and would otherwise inflate
 * overlap between two entries that merely both cite a task id), and drop empties.
 */
export function normalizeTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => !/^\d+$/.test(t));
}

/**
 * k-shingles (contiguous windows of `k` normalized tokens, space-joined) of `tokens`. A text
 * shorter than `k` tokens still needs a non-empty, comparable representation — reducing it to
 * the empty set would make it match NOTHING (silently defeating the falsifier: a fixture pair
 * that is the same short lesson reworded must still be comparable), so a token list shorter
 * than `k` collapses to ONE shingle: the whole normalized text. An empty token list (all
 * stopwords/numbers, or empty text) yields the empty set — nothing to compare.
 */
export function shingle(tokens: readonly string[], k: number = DEFAULT_SHINGLE_K): Set<string> {
  if (tokens.length === 0) return new Set();
  if (tokens.length < k) return new Set([tokens.join(" ")]);
  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - k; i++) out.add(tokens.slice(i, i + k).join(" "));
  return out;
}

/** Jaccard similarity of two shingle sets: |intersection| / |union|. Two empty sets (both
 *  texts reduced to nothing but stopwords/numbers) score 0 — there is no signal to call a
 *  match, not a vacuous 1. */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * The best-scoring near-duplicate of `candidate` in `corpus`, by normalized k-shingle Jaccard
 * similarity — or `undefined` when `corpus` is empty or holds nothing but `candidate` itself.
 *
 * NEVER MATCHES ITSELF: any corpus entry whose `id` equals `candidate.id` is skipped before
 * scoring, unconditionally — a corpus of one entry (the candidate's own, already-landed copy)
 * must never report a self-match, and this guarantee lives here rather than in each caller so
 * neither consumer can forget it (design falsifier: "a corpus of one entry never matches
 * itself").
 *
 * PURE: reads only its arguments, performs no I/O, and returns the same result for the same
 * inputs every time — both consumers (src/lib/task-linter.ts's learnings-intake and
 * task-title-intake checks) pass their own corpus in; this function never fetches one.
 */
export function bestNearDuplicate(
  candidate: DuplicateCorpusEntry,
  corpus: readonly DuplicateCorpusEntry[],
  opts: BestNearDuplicateOpts = {},
): DuplicateMatch | undefined {
  const k = opts.k ?? DEFAULT_SHINGLE_K;
  const candidateShingles = shingle(normalizeTokens(candidate.text), k);
  let best: DuplicateMatch | undefined;
  for (const entry of corpus) {
    if (entry.id === candidate.id) continue; // never matches itself
    const score = jaccardSimilarity(candidateShingles, shingle(normalizeTokens(entry.text), k));
    if (!best || score > best.score) best = { id: entry.id, score };
  }
  return best;
}

// ── W1-T4683: merge-or-keep — a near-duplicate score is not, by itself, "the same fact" ────────

/** Digit runs (integers or decimals), extracted BEFORE `normalizeTokens` strips bare numbers —
 *  a fact whose only difference from its near-duplicate is "3 retries" vs "5 retries" must not
 *  be merged just because `normalizeTokens` would otherwise reduce both to the same tokens. */
function numberSet(text: string): Set<string> {
  return new Set(text.match(/\d+(?:\.\d+)?/g) ?? []);
}

/** Common negation markers — small and local (this module imports nothing else in src/lib, see
 *  the module comment above), not exhaustive. A fact and its "same words, negated" twin ("the
 *  daemon retries" vs "the daemon never retries") must stay apart even though negation words are
 *  themselves stopword-length and barely move a shingle score. */
const NEGATIONS = new Set([
  "not",
  "no",
  "never",
  "none",
  "cannot",
  "can't",
  "cant",
  "won't",
  "wont",
  "don't",
  "dont",
  "doesn't",
  "doesnt",
  "didn't",
  "didnt",
  "isn't",
  "isnt",
  "aren't",
  "arent",
  "wasn't",
  "wasnt",
  "weren't",
  "werent",
  "without",
  "neither",
  "nor",
]);

function negationSet(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  return new Set(words.filter((w) => NEGATIONS.has(w)));
}

/** Capitalized, non-sentence-initial words — a cheap, deterministic proxy for proper names
 *  (people, modules, task ids' prose form) without a part-of-speech tagger. Sentence-initial
 *  capitals are excluded so "The daemon..." vs "That daemon..." doesn't register as a name
 *  difference; a capitalized word anywhere else in the text is treated as a name token. */
function nameSet(text: string): Set<string> {
  const names = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.match(/[A-Za-z][A-Za-z0-9'-]*/g) ?? [];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (/^[A-Z]/.test(w) && w.toLowerCase() !== w) names.add(w.toLowerCase());
    }
  }
  return names;
}

function setsDiffer(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return true;
  for (const x of a) if (!b.has(x)) return true;
  return false;
}

/** Why two texts that score above cutoff must still be kept apart, or `undefined` when nothing
 *  holds them apart (a genuine near-duplicate — merge candidate). Checked in a fixed order so
 *  the reported reason is deterministic when more than one applies. */
export type ApartReason = "changed-number" | "negation-changed" | "name-changed";

export function apartReason(a: string, b: string): ApartReason | undefined {
  if (setsDiffer(numberSet(a), numberSet(b))) return "changed-number";
  if (setsDiffer(negationSet(a), negationSet(b))) return "negation-changed";
  if (setsDiffer(nameSet(a), nameSet(b))) return "name-changed";
  return undefined;
}

export interface MergeOrKeepOpts extends BestNearDuplicateOpts {
  /** Similarity floor to even consider a merge. Default {@link DEFAULT_DUPLICATE_CUTOFF}. */
  cutoff?: number;
}

/** A `merge` decision names the matched corpus entry and the score that earned it; a `keep`
 *  decision names why — `"no-match"` when nothing scored at or above cutoff, or one of
 *  {@link ApartReason} when a match scored high enough but a changed number, negation, or name
 *  keeps the two facts apart regardless of shingle overlap. */
export type MergeDecision =
  | { action: "merge"; id: string; score: number }
  | { action: "keep"; reason: "no-match" | ApartReason; id?: string; score?: number };

/**
 * The full W1-T4683 intake decision: run {@link bestNearDuplicate} against `corpus`, then — only
 * for a match at or above cutoff — run {@link apartReason} against the matched entry's text.
 * Merging is the exception, not the default: a candidate matches nothing, or an apart reason
 * fires, in every case except a genuine near-duplicate that also agrees on its numbers,
 * negations, and names.
 */
export function mergeOrKeep(
  candidate: DuplicateCorpusEntry,
  corpus: readonly DuplicateCorpusEntry[],
  opts: MergeOrKeepOpts = {},
): MergeDecision {
  const cutoff = opts.cutoff ?? DEFAULT_DUPLICATE_CUTOFF;
  const match = bestNearDuplicate(candidate, corpus, opts);
  if (!match || match.score < cutoff) return { action: "keep", reason: "no-match" };
  const matchedEntry = corpus.find((e) => e.id === match.id);
  const reason = matchedEntry ? apartReason(candidate.text, matchedEntry.text) : undefined;
  if (reason) return { action: "keep", reason, id: match.id, score: match.score };
  return { action: "merge", id: match.id, score: match.score };
}

/** A corpus entry that can carry evidence and a proof count, for {@link mergeEvidence}. Both
 *  fields are optional so a fresh fact (no prior evidence, no prior proof count) merges cleanly:
 *  its first merge yields evidence `[newEvidence]` and proof count 2 — the original fact counts
 *  as proof 1, the merged evidence as proof 2. Kept local to this module rather than importing
 *  `LearningEntry` from src/lib/learnings.ts (the purity contract, see the module comment). */
export interface EvidenceBearingEntry extends DuplicateCorpusEntry {
  evidence?: readonly string[];
  proofCount?: number;
}

/** The result of merging `newEvidence` into `existing`: the same id/text, evidence with
 *  `newEvidence` appended, and the proof count incremented by one. Pure — returns a new object,
 *  never mutates `existing`. */
export interface MergeResult {
  id: string;
  text: string;
  evidence: string[];
  proofCount: number;
}

export function mergeEvidence(existing: EvidenceBearingEntry, newEvidence: string): MergeResult {
  return {
    id: existing.id,
    text: existing.text,
    evidence: [...(existing.evidence ?? []), newEvidence],
    proofCount: (existing.proofCount ?? 1) + 1,
  };
}

/**
 * A proof count as a bounded Beta-pseudo-count ranking multiplier — NOT a cutoff (design point
 * (ii)): a fact merged many times should rank higher, but with diminishing returns, and it must
 * never be excluded from ranking for scoring low, the way {@link DEFAULT_DUPLICATE_CUTOFF} gates
 * intake. Mirrors Hindsight's consolidation `proof_norm = 0.5 + ln(n)/10` (see the module
 * comment's design rationale): a fact merged once (n=1) contributes its baseline weight (0.5,
 * `ln(1) = 0`), and each further merge nudges the weight up by a shrinking amount. Clamped to
 * [0, 1] so it composes with this module's other [0, 1]-bounded scores (`jaccardSimilarity`)
 * without a caller needing to know its shape.
 */
export function proofPseudoCountWeight(proofCount: number): number {
  const n = Math.max(1, proofCount);
  return Math.min(1, Math.max(0, 0.5 + Math.log(n) / 10));
}
