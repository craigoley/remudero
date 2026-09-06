// W1-T2930: `parseReviewerVerdictClauses` (W1-T2263) reads a trailing reason off a FAIL line and
// `judgeCriterion` threads it into the criterion's recorded row — a reader and a channel, both
// working. The CONTRACT the reviewer actually receives never asked anyone to write into it: it
// specified a FIXED parenthetical ("(proof missing, unpasted, or non-responsive)") and the words
// "nothing else on the line", which forbid adding a reason. So the capture group was dead by
// construction.
//
// MEASURED on the live ledger 2026-09-05, before this change: 42 rows carrying
// "reviewer judged the proof non-responsive (semantic downgrade)", ZERO carrying a clause after it,
// across 11 distinct tasks. Every one cost an operator a manual re-judge on evidence that was never
// written down.
//
// These tests pin the WRITER half. The reader half is already covered by
// test/downgrade-names-the-remedy.test.ts and is deliberately not re-asserted here.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { judgeCriterion, parseReviewerVerdictClauses, reviewerVerdictContract } from "../src/lib/review.js";

const CRITERION: AcceptanceCriterion = { claim: "the widget renders", proof: "widget renders densely above the fold" };
const TOKENS = new Set(["widget", "renders", "densely", "above", "fold"]); // full coverage ⇒ floor MET

test("W1-T2930: the contract asks for a reason rather than a fixed category", () => {
  const contract = reviewerVerdictContract(3);

  // THE REGRESSION THIS PINS: the old contract handed the reviewer a canned parenthetical, so the
  // most it could ever emit was the category the token already carries.
  assert.doesNotMatch(
    contract,
    /\(proof missing, unpasted, or non-responsive\)/,
    "the fixed category must not be dictated back to the reviewer as the thing to emit",
  );
  // ...and forbade anything else on the line, which is what made the capture group unreachable.
  assert.doesNotMatch(
    contract,
    /in this form and nothing else on the line/,
    "the contract must no longer forbid the trailing reason its own parser reads",
  );

  // It must now ASK for this criterion's own reason, and say where that text ends up — a reviewer
  // told only "add a reason" writes a category; one told an operator will read it writes evidence.
  assert.match(contract, /REVIEW_VERDICT <n>: FAIL\s+<why THIS proof did not substantiate THIS claim>/);
  assert.match(contract, /recorded verbatim/, "the contract must say the text is recorded, not advisory chatter");
  assert.match(contract, /ONLY thing an author or operator ever sees/, "and that it is the sole channel");

  // The lane's own invariants must survive the rewording, or this trades one silent failure for another.
  assert.match(contract, /only DOWNGRADE a criterion to failure, never rescue an unpasted proof/);
  assert.match(contract, /PASS lines are never annotated/, "a PASS line must still never gain a clause");
});

test("W1-T2930: a written reason reaches the recorded row", () => {
  // The shape the rewritten contract now asks for: a bare trailing reason, no parentheses required.
  const transcript = [
    "REVIEW_VERDICT 1: FAIL   ran the named test; it passes but asserts only that the file parses",
    "REVIEW_VERDICT 2: PASS",
  ].join("\n");

  const clauses = parseReviewerVerdictClauses(transcript, 2);
  assert.equal(clauses[1], undefined, "a PASS line is never annotated");
  assert.ok(clauses[0] && clauses[0].includes("asserts only that the file parses"), "the reason is recovered");

  // signature: (criterion, reportTokens, semantic, execCtx, reportSubstituted, semanticClause)
  const row = judgeCriterion(CRITERION, TOKENS, false, undefined, undefined, clauses[0]);
  assert.equal(row.met, false, "the downgrade still forces failure");
  assert.match(
    row.reason,
    /asserts only that the file parses/,
    "the reviewer's own words must reach the row an operator reads — this is the whole task",
  );

  // FALSIFIER: the same downgrade with no clause must NOT accidentally contain that text, or the
  // assertion above would pass on any string and prove nothing.
  const bare = judgeCriterion(CRITERION, TOKENS, false);
  assert.doesNotMatch(bare.reason, /asserts only that the file parses/);
});

test("W1-T2930: a clauseless FAIL still downgrades", () => {
  // THE SAFETY PROPERTY. The semantic lane is advisory and downgrade-only: "a reviewer that emits
  // nothing parseable simply leaves the floor untouched — never a stall, never a deadlock." Making
  // the clause MANDATORY for the downgrade to apply would convert a silent block into a silent PASS,
  // which is strictly worse than the defect this task fixes.
  const noClause = judgeCriterion(CRITERION, TOKENS, false);
  assert.equal(noClause.met, false, "a FAIL with no reason must still downgrade");
  assert.match(noClause.reason, /semantic downgrade/, "and must still name the downgrade");

  const emptyClause = judgeCriterion(CRITERION, TOKENS, false, undefined, undefined, "");
  assert.equal(emptyClause.met, false, "an empty clause is not a rescue either");

  // And a transcript the reviewer never produced still defers to the floor rather than failing closed.
  assert.deepEqual(parseReviewerVerdictClauses("", 2), [undefined, undefined]);
});
