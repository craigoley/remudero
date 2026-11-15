/**
 * W1-T12146 — a review records the verdict the reviewer gave for each criterion BEFORE any proof ran, beside the final
 * verdict, and counts the overturns in both directions. The reviewer's verdict is its `REVIEW_VERDICT <n>: PASS|FAIL`
 * line ({@link parseReviewerVerdicts}): PASS is met, FAIL is unmet, and a missing line is `none`. Proof execution is the
 * production `judgeReview` path with an injected executor, so the proof's outcome is the only thing each case varies.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import {
  judgeReview, parseReviewerVerdicts, type ProofExecutor, type ReviewEvidence, type ReviewVerdict,
} from "#src/lib/review.js";

const DIFF = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
/** A proof whose path names `pass` executes and passes; every other proof executes and fails. */
const exec: ProofExecutor = (proof) => (proof.args.some((arg) => arg.includes("pass")) ? "pass" : "fail");
const criterion = (n: number, outcome: "pass" | "fail"): AcceptanceCriterion =>
  ({ claim: `claim ${n} holds`, proof: `grep: marker${n} in src/${outcome}${n}.ts` });

function judge(criteria: AcceptanceCriterion[], extra: Partial<ReviewEvidence> = {}): ReviewVerdict {
  return judgeReview(criteria, { diff: DIFF, report: "claim holds", headCheckoutDir: "/head", execProof: exec, ...extra });
}

test("W1-T12146 criterion 1: each criterion in a review.posted row records the reviewer's pre-proof verdict beside met", (t) => {
  // The reviewer said met on a proof that fails, and unmet (with a reason) on a proof that passes: the final verdict
  // comes out the other way round each time, and the pre-proof field still says what the reviewer said.
  const transcript = "REVIEW_VERDICT 1: PASS\nREVIEW_VERDICT 2: FAIL — the test asserts nothing\n";
  const verdict = judge([criterion(1, "fail"), criterion(2, "pass")], {
    semantic: parseReviewerVerdicts(transcript, 2), semanticClauses: [undefined, "the test asserts nothing"],
  });
  assert.deepEqual(verdict.criteria.map((c) => c.proof_exec), ["executed_fail", "executed_pass"]);
  assert.deepEqual(verdict.criteria.map((c) => c.met), [false, false]);
  assert.deepEqual(verdict.criteria.map((c) => c.preProofVerdict), ["met", "unmet"]);

  // The field rides `decision_verdict` on the review.posted row: written and read back through the ledger.
  const dir = makeTempDir("t12146-row");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  appendLedger(ledgerPath, { run_id: "r", task_id: "W1-T12146", step: "review.posted", decision_verdict: verdict });
  const row = readLedgerLines(ledgerPath).findLast((line) => line.step === "review.posted");
  const stored = row?.decision_verdict as ReviewVerdict | undefined;
  assert.deepEqual(stored?.criteria.map((c) => [c.preProofVerdict, c.met]), [["met", false], ["unmet", false]]);
  assert.equal(stored?.overturnedToUnmet, 1);
  assert.equal(stored?.overturnedToMet, 1);
});

test("W1-T12146 criterion 2: the row counts overturns to unmet and to met separately", () => {
  const verdict = judge(
    [criterion(1, "fail"), criterion(2, "fail"), criterion(3, "pass"), criterion(4, "pass"), criterion(5, "pass")],
    { semantic: [true, true, false, false, true], semanticClauses: [undefined, undefined, "x", "y", undefined] },
  );
  // met + fail, met + fail: two to unmet. unmet + pass, unmet + pass: two to met. met + pass agrees: no overturn.
  assert.equal(verdict.overturnedToUnmet, 2);
  assert.equal(verdict.overturnedToMet, 2);

  const oneWay = judge([criterion(1, "fail"), criterion(2, "pass")], { semantic: [true, true] });
  assert.equal(oneWay.overturnedToUnmet, 1);
  assert.equal(oneWay.overturnedToMet, 0);

  // Agreement in both directions, and a proof that never executed, overturn nothing — and still count as 0, not absent.
  const agreed = judge([criterion(1, "pass"), criterion(2, "fail")], { semantic: [true, false] });
  assert.equal(agreed.overturnedToUnmet, 0);
  assert.equal(agreed.overturnedToMet, 0);
  const prose = judge([{ claim: "claim holds", proof: "the claim holds" }], { semantic: [false] });
  assert.equal(prose.criteria[0].proof_exec, "not_executable");
  assert.equal(prose.criteria[0].preProofVerdict, "unmet");
  assert.equal(prose.overturnedToMet, 0);
});

test("W1-T12146 criterion 3: a criterion with no reviewer verdict records none, never met or unmet", () => {
  // No REVIEW_VERDICT line for criterion 2, an UNABLE line for criterion 3, and no reviewer at all on a second review.
  const transcript = "REVIEW_VERDICT 1: PASS\nREVIEW_VERDICT 3: UNABLE could not open the file\n";
  const semantic = parseReviewerVerdicts(transcript, 3);
  const verdict = judge([criterion(1, "pass"), criterion(2, "pass"), criterion(3, "fail")], {
    semantic, reviewerUnable: [undefined, undefined, "could not open the file"],
  });
  assert.deepEqual(verdict.criteria.map((c) => c.preProofVerdict), ["met", "none", "none"]);
  const unreviewed = judge([criterion(1, "pass"), criterion(2, "fail")]);
  assert.deepEqual(unreviewed.criteria.map((c) => c.preProofVerdict), ["none", "none"]);
  // A `none` is never counted as an overturn, whichever way its proof went.
  assert.equal(unreviewed.overturnedToUnmet, 0);
  assert.equal(unreviewed.overturnedToMet, 0);
  // The early returns record it too: an architect `satisfied_by` and a worker refusal ran no proof at all.
  const early = judge([{ ...criterion(1, "pass"), satisfied_by: "#1" }, criterion(2, "pass")], {
    semantic: [undefined, false], implementationReport: "REFUSED:\n2. [premise-rotted] the symbol is gone.\n",
  });
  assert.equal(early.criteria[1].refusal?.class, "premise-rotted");
  assert.deepEqual(early.criteria.map((c) => c.preProofVerdict), ["none", "unmet"]);
});

test("W1-T12146 criterion 4: the final verdict of every criterion and of the review is unchanged", () => {
  // The verdict table judgeCriterion produced before this change: reviewer verdict × proof outcome × FAIL reason.
  const cases: Array<{ semantic?: boolean; outcome: "pass" | "fail"; clause?: string; met: boolean }> = [
    { semantic: true, outcome: "pass", met: true },
    { semantic: true, outcome: "fail", met: false },
    { semantic: undefined, outcome: "pass", met: true },
    { semantic: undefined, outcome: "fail", met: false },
    { semantic: false, outcome: "pass", met: true }, // an unexplained FAIL cannot outweigh an observed executed_pass
    { semantic: false, outcome: "pass", clause: "asserts nothing", met: false },
    { semantic: false, outcome: "fail", met: false },
  ];
  for (const [i, c] of cases.entries()) {
    const verdict = judge([criterion(i, c.outcome)], { semantic: [c.semantic], semanticClauses: [c.clause] });
    const [judged] = verdict.criteria;
    assert.equal(judged.met, c.met, `case ${i}`);
    assert.equal(judged.floorMet, c.outcome === "pass", `case ${i}`);
    assert.equal(verdict.state, c.met ? "success" : "failure", `case ${i}`);
    // The record is beside the verdict, never feeding it: the same case with the field's input erased judges alike.
    assert.equal(judged.preProofVerdict, c.semantic === undefined ? "none" : c.semantic ? "met" : "unmet", `case ${i}`);
    const blind = judge([criterion(i, c.outcome)]);
    if (c.semantic !== false) assert.equal(blind.criteria[0].met, judged.met, `case ${i}`);
  }
  // The review's own rollup over a mixed set is the same failure it always was, naming the same unmet claim.
  const mixed = judge([criterion(1, "pass"), criterion(2, "fail")], { semantic: [true, true] });
  assert.equal(mixed.state, "failure");
  assert.equal(mixed.floorState, "failure");
  assert.deepEqual(mixed.criteria.map((c) => c.met), [true, false]);
  assert.match(mixed.summary, /claim 2 holds/);
});
