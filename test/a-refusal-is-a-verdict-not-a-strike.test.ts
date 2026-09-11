import assert from "node:assert/strict";
import { test } from "node:test";
import { REFUSAL_LINE_RE, decideAutoMergeArm, judgeReview, type CriterionVerdict } from "../src/lib/review.js";
import { deriveDisposition, type OpenPrView } from "../src/lib/sweep.js";

const CRITERIA = [
  {
    claim: "the impossible premise is handled honestly",
    proof: "grep: impossiblePremiseResolved in src/feature.ts",
  },
];

const FEATURE_DIFF = [
  "diff --git a/src/feature.ts b/src/feature.ts",
  "+++ b/src/feature.ts",
  "@@",
  "+export const changed = true;",
].join("\n");

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 3078,
    prUrl: "https://github.com/o/r/pull/3078",
    taskId: "W1-T3078",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-11T00:00:00Z",
    headSha: "abc1234",
    autoMergeArmed: false,
    ...over,
  };
}

function refusedCriterion(over: Partial<CriterionVerdict> = {}): CriterionVerdict {
  return {
    claim: CRITERIA[0].claim,
    proof: CRITERIA[0].proof,
    met: false,
    reason: "worker refused criterion (premise-rotted): upstream guarantee no longer exists",
    proof_exec: "refused",
    floorMet: false,
    refusal: {
      reasonClass: "premise-rotted",
      detail: "upstream guarantee no longer exists",
    },
    ...over,
  };
}

test("a report carrying a REFUSED block grades that criterion refused, fails the verdict, and cannot arm auto-merge", () => {
  assert.equal(REFUSAL_LINE_RE.test("1 premise-rotted: upstream guarantee no longer exists"), true);
  assert.equal(REFUSAL_LINE_RE.test("1 not-a-class: upstream guarantee no longer exists"), false);

  const verdict = judgeReview(CRITERIA, {
    diff: FEATURE_DIFF,
    report: "REFUSED: 1 premise-rotted: upstream guarantee no longer exists",
  });

  assert.equal(verdict.state, "failure");
  assert.equal(verdict.criteria[0].met, false);
  assert.equal(verdict.criteria[0].proof_exec, "refused");
  assert.equal(verdict.criteria[0].refusal?.reasonClass, "premise-rotted");
  assert.match(verdict.criteria[0].reason, /upstream guarantee no longer exists/);
  assert.equal(decideAutoMergeArm(verdict, false).arm, false);
});

test("a review whose only unmet criteria are refused routes to refused-escalate and not a fix strike", () => {
  const disposition = deriveDisposition(
    pr({
      unmetCriteria: [refusedCriterion()],
      priorStrikes: 0,
    }),
  );

  assert.equal(disposition.disposition, "refused-escalate");
  assert.match(disposition.reason, /premise-rotted/);
  assert.doesNotMatch(disposition.reason, /strike 1\//);
});

test("a report that refuses and contradicts its own diff is a body contradiction, not a clean refusal", () => {
  const verdict = judgeReview(CRITERIA, {
    diff: FEATURE_DIFF,
    report: [
      "This PR changes exactly 1 files: src/other.ts.",
      "REFUSED: 1 premise-rotted: upstream guarantee no longer exists",
    ].join("\n"),
  });

  assert.equal(verdict.state, "failure");
  assert.equal(verdict.criteria[0].proof_exec, "not_executable");
  assert.equal(verdict.criteria[0].refusal, undefined);
  assert.equal(verdict.changesetContradictions?.length, 1);
  assert.match(verdict.summary, /body contradicts its own diff/);
});
