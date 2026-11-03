import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import {
  clauseCutLength, judgeCriterion, parseReviewerVerdictClauses, REVIEWER_CLAUSE_MAX_CHARS, reviewerVerdictContract,
} from "#src/lib/review.js";

const CRITERION: AcceptanceCriterion = { claim: "the widget renders", proof: "widget renders densely above the fold" };
const REPORT_TOKENS = new Set(["widget", "renders", "densely", "above", "fold"]);

// A real downgrade shape from the 2026-11-03 ledger, 297 characters: the old 160-character bound cut it at "Th…".
const FINDING = "Recomputed appendix totals successfully, but the reported per-head p90 of 61 minutes conflicts with " +
  "approximately 66.6–69 minutes from its 64 admitted heads. The width table also omits 68 of 727 observable passes, " +
  "so the distribution the claim names is not the one the report shows.";

const judged = (clause: string | undefined) => judgeCriterion(CRITERION, REPORT_TOKENS, false, undefined, undefined, clause);

test("a reviewer's FAIL clause within the budget reaches the criterion's reason whole", () => {
  assert.ok(FINDING.length > 160 && FINDING.length <= REVIEWER_CLAUSE_MAX_CHARS, `fixture is ${FINDING.length} chars`);
  const [clause] = parseReviewerVerdictClauses(`REVIEW_VERDICT 1: FAIL (${FINDING})`, 1);
  assert.equal(clause, FINDING, "a clause that fits arrives verbatim");
  const verdict = judged(clause);
  assert.equal(verdict.met, false, "the downgrade still binds");
  assert.ok(verdict.reason.endsWith(FINDING), "the reason the fix prompt and progress judge read carries the whole finding");
  assert.ok(!verdict.reason.includes("…"), "no ellipsis on a clause that fit");
  assert.equal(verdict.clauseChars, undefined, "a whole clause records no cut");
  const bare = parseReviewerVerdictClauses(`REVIEW_VERDICT 1: FAIL ${FINDING}`, 1)[0];
  assert.equal(bare, FINDING, "freeform trailing prose, without the parenthetical, also arrives whole");
});

test("W1-T11209 criterion 2: an over-budget clause is cut at a sentence end inside the budget, marked with its full length, and recorded on the row", () => {
  const sentences = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} names one more missing check in detail.`).join(" ");
  assert.ok(sentences.length > REVIEWER_CLAUSE_MAX_CHARS);
  const [cut] = parseReviewerVerdictClauses(`REVIEW_VERDICT 1: FAIL (${sentences})`, 1);
  assert.ok(cut !== undefined);
  const kept = cut!.replace(/ \[…clause cut at \d+ of \d+ chars\]$/, "");
  assert.ok(kept.endsWith("detail."), `cut at a sentence end, not mid-sentence: ${kept.slice(-30)}`);
  assert.ok(kept.length <= REVIEWER_CLAUSE_MAX_CHARS);
  assert.match(cut!, new RegExp(` \\[…clause cut at ${kept.length} of ${sentences.length} chars\\]$`));
  assert.equal(clauseCutLength(cut), sentences.length);
  assert.equal(judged(cut).clauseChars, sentences.length, "the row records the clause's full length when it was cut");

  const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
  const [wordCut] = parseReviewerVerdictClauses(`REVIEW_VERDICT 1: FAIL (${words})`, 1);
  const wordKept = wordCut!.replace(/ \[…clause cut at \d+ of \d+ chars\]$/, "");
  assert.match(wordKept, /word\d+$/, "with no sentence end, it cuts at a word boundary");
  assert.ok(words.startsWith(`${wordKept} `), "never mid-word: the kept text is a whole-word prefix");

  const runaway = "x".repeat(5000);
  const [hard] = parseReviewerVerdictClauses(`REVIEW_VERDICT 1: FAIL (${runaway})`, 1);
  assert.ok(hard!.length < 5000 && clauseCutLength(hard) === 5000, "a runaway line is still bounded and says how long it was");
  assert.equal(clauseCutLength("plain clause"), undefined);
});

test("W1-T11209 criterion 3: the reviewer contract names the clause budget the parse cuts at", () => {
  const contract = reviewerVerdictContract(2);
  assert.ok(contract.includes(`at most ${REVIEWER_CLAUSE_MAX_CHARS} characters`), "the budget is told, from the same constant");
  assert.ok(contract.includes("recorded verbatim"), "the verbatim promise the parse now keeps is still made");
});
