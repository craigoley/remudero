// W1-T2263: a semantic downgrade used to OVERWRITE the floor's accumulated `reason` with a
// fixed eight-word constant ("reviewer judged the proof non-responsive (semantic downgrade)"),
// discarding everything the mechanical floor had already established about the criterion — the
// one branch where an author most needs to know what was weighed. This file proves the fix:
//
//   1. the downgrade arm now APPENDS to `reason` (the `${reason} — NOTE: …` idiom every other
//      branch in `judgeCriterion` already uses), so the floor's own text survives;
//   2. `parseReviewerVerdictClauses` (new — a companion to `parseReviewerVerdicts`, reading the
//      SAME widened regex over the SAME transcript, no second reviewer call) recovers a bounded
//      trailing clause off a FAIL line and threads it into that appended note;
//   3. nothing else about the seam moves: `parseReviewerVerdicts` itself is unaffected, a PASS
//      line never gains a clause, the semantic arm still never rescues an unsubstantiated proof,
//      an unparseable transcript still defers to the floor, and `applyVerdictStability`'s
//      suppression conjuncts (a first review of a head is never suppressed) are untouched.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import {
  applyVerdictStability,
  judgeCriterion,
  parseReviewerVerdictClauses,
  parseReviewerVerdicts,
  type PriorReviewVerdict,
} from "../src/lib/review.js";
import type { ReviewVerdict } from "../src/lib/review.js";

const CRITERION: AcceptanceCriterion = { claim: "the widget renders", proof: "widget renders densely above the fold" };
const REPORT_TOKENS = new Set(["widget", "renders", "densely", "above", "fold"]); // full keyword coverage ⇒ floor MET

// ── Acceptance 1: append, not overwrite; the surviving text still names the downgrade ──────────

test("acceptance 1 — a downgrade preserves the floor's accumulated reason rather than replacing it, and the surviving text still names the downgrade", () => {
  const floor = judgeCriterion(CRITERION, REPORT_TOKENS); // no semantic arg ⇒ the bare floor verdict
  assert.equal(floor.met, true, "sanity: the floor itself passes on full keyword coverage");

  const downgraded = judgeCriterion(CRITERION, REPORT_TOKENS, false); // semantic=false, no clause
  assert.equal(downgraded.met, false, "the downgrade still forces the criterion to fail");
  assert.match(downgraded.reason, /semantic downgrade/, "the reason still names the downgrade");
  assert.ok(
    downgraded.reason.startsWith(floor.reason),
    `the floor's own accumulated reason must SURVIVE at the front of the downgraded reason, not be replaced — ` +
      `got: ${JSON.stringify(downgraded.reason)}`,
  );
  assert.notEqual(
    downgraded.reason,
    "reviewer judged the proof non-responsive (semantic downgrade)",
    "the old defect: a bare eight-word constant that discards everything the floor established",
  );
});

// ── Acceptance 2: a bounded trailing clause on a FAIL line reaches the criterion's reason ───────

test("acceptance 2 — a reviewer line carrying a bounded trailing clause on a refusal has that clause reach the criterion's reason", () => {
  const transcript = "REVIEW_VERDICT 1: FAIL (proof pastes a grep; needs an executed unit test against the new path)";
  const clauses = parseReviewerVerdictClauses(transcript, 1);
  assert.equal(clauses[0], "proof pastes a grep; needs an executed unit test against the new path");

  const downgraded = judgeCriterion(CRITERION, REPORT_TOKENS, false, undefined, undefined, clauses[0]);
  assert.equal(downgraded.met, false);
  assert.match(downgraded.reason, /semantic downgrade/);
  assert.match(
    downgraded.reason,
    /needs an executed unit test against the new path/,
    "the reviewer's own bounded clause must reach the row that carries the judgement",
  );
});

// ── Acceptance 3: no trailing clause ⇒ parse result and criterion outcome exactly as today ──────

test("acceptance 3 — a reviewer line with no trailing clause leaves the parse result and the criterion outcome exactly as they are today", () => {
  const transcript = "REVIEW_VERDICT 1: FAIL";
  assert.deepEqual(parseReviewerVerdicts(transcript, 1), [false], "parseReviewerVerdicts is unaffected by the widening");
  const clauses = parseReviewerVerdictClauses(transcript, 1);
  assert.equal(clauses[0], undefined, "a bare FAIL with nothing after it carries no clause");

  const withoutClauseArg = judgeCriterion(CRITERION, REPORT_TOKENS, false);
  const withUndefinedClause = judgeCriterion(CRITERION, REPORT_TOKENS, false, undefined, undefined, clauses[0]);
  assert.equal(withoutClauseArg.met, false);
  assert.equal(withoutClauseArg.reason, withUndefinedClause.reason, "an absent clause must leave today's behaviour exactly as it is");
});

// ── Acceptance 4: a PASS line gains no clause and still defers to the deterministic floor ───────

test("acceptance 4 — an affirmative reviewer line gains no clause and still defers to the deterministic floor", () => {
  const transcript = "REVIEW_VERDICT 1: PASS (proof is responsive and substantiated)";
  assert.deepEqual(parseReviewerVerdicts(transcript, 1), [undefined], "PASS defers to the floor, never records a value");
  const clauses = parseReviewerVerdictClauses(transcript, 1);
  assert.equal(clauses[0], undefined, "a PASS line's trailing parenthetical is never captured as a clause");

  const passed = judgeCriterion(CRITERION, REPORT_TOKENS, true, undefined, undefined, clauses[0]);
  assert.equal(passed.met, true);
  assert.equal(passed.reason, judgeCriterion(CRITERION, REPORT_TOKENS).reason, "semantic=true changes nothing — the floor still decides");
});

// ── Acceptance 5: the semantic arm still cannot RAISE a criterion the floor did not substantiate ─

test("acceptance 5 — the semantic arm remains unable to raise a criterion the floor did not substantiate", () => {
  const unmetTokens = new Set(["unrelated", "tokens"]); // floor fails: no keyword coverage
  const floor = judgeCriterion(CRITERION, unmetTokens);
  assert.equal(floor.met, false, "sanity: the floor itself fails");

  const semanticTrue = judgeCriterion(CRITERION, unmetTokens, true);
  assert.equal(semanticTrue.met, false, "semantic:true must never rescue an unsubstantiated proof");

  const semanticTrueWithClause = judgeCriterion(CRITERION, unmetTokens, true, undefined, undefined, "this would answer the claim");
  assert.equal(semanticTrueWithClause.met, false, "a clause cannot rescue a proof either — the arm stays downgrade-only");
  assert.equal(
    semanticTrueWithClause.reason,
    floor.reason,
    "a clause is consulted ONLY inside the (semantic === false && met) branch — it must be inert here",
  );
});

// ── Acceptance 6: an unparseable reviewer output still yields defer-to-floor for every criterion ─

test("acceptance 6 — an unparseable reviewer output still yields a defer-to-floor result for every criterion", () => {
  const garbage = "The reviewer got confused and wrote a paragraph of prose with no machine-readable lines at all.";
  const semantic = parseReviewerVerdicts(garbage, 3);
  assert.deepEqual(semantic, [undefined, undefined, undefined]);
  const clauses = parseReviewerVerdictClauses(garbage, 3);
  assert.deepEqual(clauses, [undefined, undefined, undefined]);

  const verdicts = [0, 1, 2].map((i) => judgeCriterion(CRITERION, REPORT_TOKENS, semantic[i], undefined, undefined, clauses[i]));
  for (const v of verdicts) {
    assert.equal(v.met, true, "an unparseable reviewer output must never itself force a failure — the floor stands alone");
  }
});

// ── Acceptance 7: applyVerdictStability's suppression conjuncts are unchanged; first review never suppressed ─

test("acceptance 7 — the suppression condition keeps every one of its conjuncts, so a first review of a head is never suppressed", () => {
  const computed: ReviewVerdict = {
    state: "failure",
    criteria: [{ claim: CRITERION.claim, proof: CRITERION.proof, met: false, reason: "x — NOTE: reviewer judged the proof non-responsive (semantic downgrade)", proof_exec: "not_executable", floorMet: true }],
    testTheater: false,
    summary: "remudero-review: FAIL",
    floorDegraded: false,
    floorState: "success",
    capped: false,
    keywordOnly: false,
    planOnly: false,
  };
  const headSha = "abc1234def";

  // No prior at all — a FIRST review of a head. Must never be suppressed.
  const noPrior = applyVerdictStability(computed, headSha, undefined);
  assert.equal(noPrior.suppressed, false, "a first review of a head has no prior to contradict, so it is fully binding");
  assert.equal(noPrior.verdict.state, "failure");

  const fullyMatchingPrior: PriorReviewVerdict = { headSha, state: "success", capped: false, planOnly: false };
  const suppressed = applyVerdictStability(computed, headSha, fullyMatchingPrior);
  assert.equal(suppressed.suppressed, true, "sanity: all five conjuncts satisfied DOES suppress");

  // Each conjunct, broken one at a time, must un-suppress.
  assert.equal(applyVerdictStability(computed, "different-sha", fullyMatchingPrior).suppressed, false, "headSha must match");
  assert.equal(
    applyVerdictStability(computed, headSha, { ...fullyMatchingPrior, state: "failure" }).suppressed,
    false,
    "prior.state must be success",
  );
  assert.equal(
    applyVerdictStability({ ...computed, state: "success" }, headSha, fullyMatchingPrior).suppressed,
    false,
    "computed.state must be failure",
  );
  assert.equal(
    applyVerdictStability({ ...computed, floorState: "failure" }, headSha, fullyMatchingPrior).suppressed,
    false,
    "floorState must be success",
  );
});

// ── Acceptance 8: an overlong or multi-line clause is bounded, never carried whole ──────────────

test("acceptance 8 — an overlong or multi-line clause is bounded before it reaches the reason rather than carried whole", () => {
  const longClause = "x".repeat(500);
  const overlong = parseReviewerVerdictClauses(`REVIEW_VERDICT 1: FAIL (${longClause})`, 1)[0];
  assert.ok(overlong !== undefined && overlong.length < 500, "an overlong clause must be bounded, not carried whole");
  assert.ok(overlong!.length <= 165, `bounded clause unexpectedly long: ${overlong!.length} chars`);

  const overlongReason = judgeCriterion(CRITERION, REPORT_TOKENS, false, undefined, undefined, overlong).reason;
  assert.ok(!overlongReason.includes(longClause), "the raw 500-char clause must never reach the reason whole");

  // A "multi-line clause" attempt: text after a literal newline is a DIFFERENT line, so it can
  // never be captured as part of this criterion's clause at all — bounded by construction.
  const multiline = "REVIEW_VERDICT 1: FAIL (short reason)\nThis paragraph should never be attached to the clause above.";
  const fromMultiline = parseReviewerVerdictClauses(multiline, 1)[0];
  assert.equal(fromMultiline, "short reason");
  assert.ok(
    !fromMultiline!.includes("should never be attached"),
    "a clause can never span past its own line",
  );
});
