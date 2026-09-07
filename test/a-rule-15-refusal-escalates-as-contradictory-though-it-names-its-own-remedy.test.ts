// W1-T3029 — a Standing rule 15 refusal is FULLY DIAGNOSED (failSummary states the PR shape to
// change), yet it reaches the sweep with an empty unmet set and lands on the arm whose text asserts
// the verdict was contradictory. These tests drive the REAL disposition table through
// `deriveDisposition`, never the rule object, so they assert the escalation an operator actually
// reads rather than the table's contents.

import assert from "node:assert/strict";
import test from "node:test";

import { deriveDisposition, namesRule15Refusal } from "../src/lib/sweep.js";
import { failSummary } from "../src/lib/review.js";

/** The rule-15 summary taken FROM ITS PRODUCER, not retyped. If `failSummary`'s literal is reworded,
 *  these tests move with it — and the one test that pins the coupling (below) is the one that fails. */
const RULE_15_SUMMARY = failSummary([], false, false, true);

/** A review-failing PR with an EMPTY unmet set and a RESOLVED trailer — the exact shape all three
 *  causes share. Only `reviewSummary` and `criteriaRecoverable` vary between the arms below. */
function reviewFailingPr(over: Record<string, unknown> = {}) {
  return {
    prNumber: 4413,
    prUrl: "https://github.com/craigoley/remudero/pull/4413",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    headSha: "760c7d9b07f4358ef89534d84b42d3fc7bbd5ca9",
    autoMergeArmed: false,
    isDependabot: false,
    criteriaRecoverable: true,
    headRefName: "run-W1-T3024-1788788858000",
    ...over,
  } as never;
}

test("W1-T3029: the producer's rule-15 literal is what this task keys on", () => {
  // PRIMARY CONTROL for the text coupling design (ii) accepts. Not a restatement of the constant:
  // it proves the marker matches the string the REVIEWER emits, so a reword in review.ts reddens
  // here rather than silently reverting the escalation to the generic wording in production.
  assert.match(RULE_15_SUMMARY, /Standing rule 15/);
  assert.match(RULE_15_SUMMARY, /plan-only PR/, "the remedy half must still be in the emitted summary");
  assert.ok(namesRule15Refusal(reviewFailingPr({ reviewSummary: RULE_15_SUMMARY })));
});

test("W1-T3029 criterion 1: a rule-15 refusal escalates naming rule 15 and the PR-shape remedy", () => {
  const d = deriveDisposition(reviewFailingPr({ reviewSummary: RULE_15_SUMMARY }));
  assert.match(d.reason, /Standing rule 15/);
  assert.match(d.reason, /derived repair: file the shard in its own plan-only PR/);
  assert.doesNotMatch(d.reason, /contradictory/, "the property the verdict does not have");
});

test("W1-T3029 criterion 2: the disposition is unmoved, so no fix strike is dispatched", () => {
  // THE SAFETY PROPERTY. Rule 15's remedy is a PR split; routing it to blocked-fixable would spend
  // strikes that cannot succeed. Asserted on the disposition AND on the absence of a gate failure.
  const pr = reviewFailingPr({ reviewSummary: RULE_15_SUMMARY });
  const d = deriveDisposition(pr);
  assert.equal(d.disposition, "blocked-ambiguous");
  assert.equal((pr as { actionableGateFailures?: unknown[] }).actionableGateFailures, undefined);
});

test("W1-T3029 criterion 3 (falsifier): a plain empty-unmet failure keeps the contradictory wording BYTE-IDENTICAL", () => {
  const d = deriveDisposition(reviewFailingPr({ reviewSummary: "remudero-review: FAIL — something else entirely" }));
  assert.equal(d.reason, "review failing with no actionable unmet criteria (contradictory) — escalating");
  assert.equal(d.disposition, "blocked-ambiguous");
});

test("W1-T3029 criterion 3 (falsifier): and so does one carrying no summary at all", () => {
  const d = deriveDisposition(reviewFailingPr({ reviewSummary: undefined }));
  assert.equal(d.reason, "review failing with no actionable unmet criteria (contradictory) — escalating");
});

test("W1-T3029 criterion 4 (falsifier): the W1-T440 unrecoverable arm still WINS over a rule-15 summary", () => {
  // Design (v): the earlier arm is tested first on purpose. A PR with no trailer is unrecoverable
  // whatever else is true, so this row must not be captured by the new cause.
  const d = deriveDisposition(
    reviewFailingPr({ criteriaRecoverable: false, reviewSummary: RULE_15_SUMMARY, headRefName: "run-W1-T2480-1788150533485" }),
  );
  assert.match(d.reason, /criteria unrecoverable/);
  assert.match(d.reason, /derived repair: add `Remudero-Task: W1-T2480`/, "W1-T440's repair survives intact");
  assert.doesNotMatch(d.reason, /Standing rule 15/);
});

test("W1-T3029 (falsifier): a rule-15 summary does NOT capture a PR with real unmet criteria", () => {
  // The blocked-fixable row above must still claim a PR that has something to fix — the new cause
  // lives on the terminal arm and can only ever be reached when that row declined.
  const d = deriveDisposition(
    reviewFailingPr({
      reviewSummary: RULE_15_SUMMARY,
      unmetCriteria: [{ claim: "c", proof: "p", met: false, reason: "r", holdout: false }],
    }),
  );
  assert.equal(d.disposition, "blocked-fixable");
  assert.match(d.reason, /1 unmet criterion/);
});

test("W1-T3029 (falsifier): a SUCCEEDING review carrying the same text is untouched", () => {
  // The marker is a string match, so the one way it could over-reach is by reading a summary on a
  // PR that is not review-failing at all.
  const d = deriveDisposition(reviewFailingPr({ reviewState: "success", reviewSummary: RULE_15_SUMMARY }));
  assert.notEqual(d.disposition, "blocked-ambiguous");
  assert.doesNotMatch(d.reason, /Standing rule 15/);
});

test("W1-T3029 (falsifier): the predicate is total over an absent summary", () => {
  assert.equal(namesRule15Refusal(reviewFailingPr({ reviewSummary: undefined })), false);
  assert.equal(namesRule15Refusal(reviewFailingPr({ reviewSummary: "" })), false);
});
