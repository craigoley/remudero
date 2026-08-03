import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import {
  applyVerdictStability,
  auditMergedTaskClaims,
  judgeCriterion,
  judgeReview,
  reviewLedgerLegibilityFields,
  type PriorReviewVerdict,
  type ProofExecutor,
  type ReviewVerdict,
} from "../src/lib/review.js";

// ── W1-T305 ──────────────────────────────────────────────────────────────────
//
// MEASURED 2026-08-03 over `review.posted` in state/ledger.ndjson unioned with all 664
// rotations, deduped by head_sha: of 821 distinct CODE review heads, 418 (50.9%) executed
// ZERO proofs, and 322 of those posted `state: success` anyway — the vast majority certified
// by the keyword-coverage floor alone, which this codebase's own comments already call "a
// claim, never evidence". Every one of the 1,157 proof markers inside those 418 zero-executed
// heads landed as the SAME `not_executable` marker, indistinguishable from the outside whether
// the proof was ordinary prose (expected), a malformed dialect body (an authoring error), or a
// paraphrase that legitimately named no test. A separate 52 heads executed SOME but not ALL of
// their proofs and posted identically to a fully-certified pass.
//
// These three acceptance criteria make that silence loud, without tightening the floor itself
// (design (3) — that is an explicit, separate, ratified decision, out of scope here):
//   1. a proof that fails to PARSE as a dialect (an authoring error) is reported distinctly from
//      one that parses but resolves to no candidate.
//   2. the verdict AND the ledger row both carry the unexecutable count and the offending proof
//      text.
//   3. a partially-executed proof set reads differently, on the posted verdict, than a fully-
//      executed one.

const FAKE_HEAD = "/fake/head/checkout";

// ── Acceptance 1: a proof that fails to parse as a dialect is an AUTHORING ERROR, ──
// distinct from a proof that parses but resolves to no candidate, and distinct from
// ordinary prose that never claimed to be mechanical at all.

test("judgeCriterion: a grep: proof with NO `in <path>` clause is a DIALECT-PARSE-ERROR (authoring error), not the same bucket as free prose", () => {
  const criterion = { claim: "TODOs are gone", proof: "grep: TODO" }; // dialect label, but no target
  const v = judgeCriterion(criterion, new Set(["todos", "gone"]), undefined, { cwd: FAKE_HEAD });
  assert.equal(v.proof_exec, "not_executable");
  assert.equal(v.proof_skip, "dialect-parse-error");
  assert.match(v.reason, /authoring error/i);
  assert.match(v.reason, /dialect prefix/i);
});

test("judgeCriterion: a unit test:/grep: proof refused for PATH TRAVERSAL is ALSO a dialect-parse-error (an authoring error), never no-dialect", () => {
  const criterion = { claim: "traversal is refused", proof: "grep: secret in ../../etc/passwd" };
  const v = judgeCriterion(criterion, new Set(["traversal", "refused"]), undefined, { cwd: FAKE_HEAD });
  assert.equal(v.proof_exec, "not_executable");
  assert.equal(v.proof_skip, "dialect-parse-error");
  assert.notEqual(v.proof_skip, "no-dialect");
});

test("judgeCriterion: ordinary PROSE (no dialect label at all) stays no-dialect and is NEVER called an authoring error", () => {
  const criterion = { claim: "the widget is frobnicated", proof: "the widget frobnicates on load" };
  const v = judgeCriterion(criterion, new Set(["widget", "frobnicates", "load"]), undefined, { cwd: FAKE_HEAD });
  assert.equal(v.proof_exec, "not_executable");
  assert.equal(v.proof_skip, "no-dialect");
  assert.doesNotMatch(v.reason, /authoring error/i);
});

test("judgeCriterion: a proof that PARSES (unit test:) and resolves to zero candidates is prose-no-match — a THIRD, distinct bucket from both dialect-parse-error and no-dialect", () => {
  const criterion = {
    claim: "the widget renders densely",
    proof: "unit test: the widget renders densely, that is, above the fold",
  };
  const exec: ProofExecutor = () => "no-match";
  const v = judgeCriterion(criterion, new Set(["widget", "renders", "densely", "above", "fold"]), undefined, {
    cwd: FAKE_HEAD,
    exec,
  });
  assert.equal(v.proof_skip, "prose-no-match");
  assert.notEqual(v.proof_skip, "dialect-parse-error");
  assert.notEqual(v.proof_skip, "no-dialect");
});

test("a demonstration: proof is deliberately unexecutable BY DESIGN (W1-T277) and must never be reported as a dialect-parse-error authoring mistake", () => {
  const criterion = { claim: "an operator ran the demo", proof: "demonstration: click the button and observe the toast" };
  const v = judgeCriterion(criterion, new Set(["operator", "ran", "demo"]), undefined, { cwd: FAKE_HEAD });
  assert.equal(v.proof_exec, "not_executable");
  assert.equal(v.proof_skip, "no-dialect");
  assert.doesNotMatch(v.reason, /authoring error/i);
});

test("ACCEPTANCE 1 (end to end): auditMergedTaskClaims now reports a MALFORMED dialect proof from a merged task as a FINDING (an authoring error), never silently folded into the 'uncheckable' bucket alongside real prose", () => {
  const tasks = [
    {
      id: "T-malformed",
      acceptance: [{ claim: "TODOs are gone", proof: "grep: TODO" }], // dialect label, no `in <path>` — refused
    },
    {
      id: "T-prose",
      acceptance: [{ claim: "the widget is frobnicated", proof: "the widget frobnicates on load" }], // true prose
    },
  ];
  const exec: ProofExecutor = () => {
    throw new Error("neither a malformed dialect proof nor a prose proof should ever reach the executor");
  };
  const report = auditMergedTaskClaims(tasks, "/tmp/does-not-matter", exec);

  // The malformed dialect proof is now a FINDING (broken, distinct from prose) —
  // pre-W1-T305 this was misreported identically to the prose criterion below.
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].taskId, "T-malformed");
  assert.match(report.findings[0].reason, /authoring error/i);

  // The true prose criterion is still, correctly, uncheckable — never a finding.
  assert.equal(report.uncheckable.length, 1);
  assert.equal(report.uncheckable[0].taskId, "T-prose");
});

// ── Acceptance 2: the verdict AND the ledger row both carry the unexecutable count ──
// and the offending proof text.

test("ACCEPTANCE 2: judgeReview's verdict carries the unexecutable COUNT and the exact OFFENDING PROOF TEXT", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "a", proof: "grep: TODO" }, // dialect-parse-error
    { claim: "b", proof: "the widget frobnicates on load" }, // no-dialect
    { claim: "c", proof: "grep: alpha in src/lib/a.ts" }, // executes cleanly
  ];
  const alwaysPass: ProofExecutor = () => "pass";
  const v = judgeReview(criteria, {
    diff: "",
    report: "REPORT — a: TODO. b: the widget frobnicates on load. c: alpha. Done.",
    headCheckoutDir: FAKE_HEAD,
    execProof: alwaysPass,
  });
  assert.equal(v.unexecutableCount, 2, "exactly the two not_executable criteria are counted");
  assert.deepEqual(
    v.unexecutableProofs,
    ["grep: TODO", "the widget frobnicates on load"],
    "the offending proof TEXT is carried verbatim, in criteria order",
  );
});

test("ACCEPTANCE 2: the review.posted ledger row (reviewLedgerLegibilityFields) carries the SAME count and proof text the verdict does — never a hand-copied, driftable projection", () => {
  const criteria: AcceptanceCriterion[] = [{ claim: "a", proof: "grep: TODO" }];
  const v = judgeReview(criteria, { diff: "", report: "unrelated", headCheckoutDir: FAKE_HEAD });
  const ledgerFields = reviewLedgerLegibilityFields(v);
  assert.equal(ledgerFields.unexecutable_count, v.unexecutableCount);
  assert.deepEqual(ledgerFields.unexecutable_proofs, v.unexecutableProofs);
  assert.deepEqual(ledgerFields.unexecutable_proofs, ["grep: TODO"]);
});

test("ACCEPTANCE 2: a HEALTHY, fully-executed review carries unexecutable_count 0 and an empty proofs array — never absent (0/[] is the byte-identical baseline for every green review)", () => {
  const criteria: AcceptanceCriterion[] = [{ claim: "a", proof: "grep: alpha in src/lib/a.ts" }];
  const v = judgeReview(criteria, {
    diff: "",
    report: "unrelated",
    headCheckoutDir: FAKE_HEAD,
    execProof: () => "pass",
  });
  assert.equal(v.unexecutableCount, 0);
  assert.deepEqual(v.unexecutableProofs, []);
  const ledgerFields = reviewLedgerLegibilityFields(v);
  assert.equal(ledgerFields.unexecutable_count, 0);
  assert.deepEqual(ledgerFields.unexecutable_proofs, []);
});

test("ACCEPTANCE 2: a HOLDOUT criterion's unexecutable proof counts toward unexecutableCount (an aggregate number, never secret) but its TEXT never appears in unexecutableProofs — holdout content stays worker-invisible (W1-T166), exactly like unmet_criteria/reasons already do", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "visible one", proof: "the visible claim is prose and never executes" },
    { claim: "secret one", proof: "the holdout claim is ALSO prose and never executes", holdout: true },
  ];
  const v = judgeReview(criteria, { diff: "", report: "unrelated", headCheckoutDir: FAKE_HEAD });
  assert.equal(v.unexecutableCount, 2, "both criteria (visible + holdout) are counted");
  assert.deepEqual(
    v.unexecutableProofs,
    ["the visible claim is prose and never executes"],
    "only the VISIBLE criterion's proof text is exposed",
  );
});

// ── Acceptance 3: a partially-executed proof set is distinguishable from a ──
// fully-executed one in the posted verdict.

const ALPHA_PROOF = "grep: alpha in src/lib/a.ts";
const BETA_PROSE_PROOF = "the widget frobnicates on load";
// Substantiates BOTH criteria's keyword floors (echoes alpha's own "grep"/"alpha" tokens and
// beta's proof verbatim) so `state` is "success" whether or not alpha's proof actually executes —
// the fixture below is reused across the executed and zero-executed contrast, and only the
// EXECUTION context should differ between them, never the keyword-floor outcome.
const PARTIAL_REPORT = `REPORT — grep alpha check confirmed. ${BETA_PROSE_PROOF} confirmed. Done.`;

function partialCriteria(): AcceptanceCriterion[] {
  return [
    { claim: "alpha", proof: ALPHA_PROOF },
    { claim: "beta", proof: BETA_PROSE_PROOF },
  ];
}

test("ACCEPTANCE 3: a review that executed SOME but not ALL of its proofs is flagged partiallyExecuted and its posted summary names the fraction — never rendered identically to a fully-observed PASS", () => {
  const v = judgeReview(partialCriteria(), {
    diff: "",
    report: PARTIAL_REPORT,
    headCheckoutDir: FAKE_HEAD,
    execProof: () => "pass", // only alpha's dialect proof can ever execute; beta is plain prose
  });
  assert.equal(v.state, "success");
  assert.equal(v.capped, false, "SOMETHING executed — this is not the zero-executed capped shape");
  assert.equal(v.partiallyExecuted, true);
  assert.equal(v.executedProofCount, 1);
  assert.equal(v.executableProofCount, 2);
  assert.match(v.summary, /PARTIAL: 1\/2/, "the posted verdict names the executed/executable fraction");
  assert.doesNotMatch(v.summary, /CAPPED/);
});

test("ACCEPTANCE 3 (contrast): a FULLY-executed review (every executable criterion ran) is NOT flagged partial, and its summary carries no PARTIAL tag", () => {
  // BOTH proofs are dialect-prefixed here (unlike partialCriteria()'s prose `beta`), so nothing
  // is left unexecuted.
  const bothExecutable: AcceptanceCriterion[] = [
    { claim: "alpha", proof: ALPHA_PROOF },
    { claim: "beta", proof: "grep: beta in src/lib/b.ts" },
  ];
  const fully = judgeReview(bothExecutable, {
    diff: "",
    report: "unrelated",
    headCheckoutDir: FAKE_HEAD,
    execProof: () => "pass",
  });
  assert.equal(fully.partiallyExecuted, false);
  assert.equal(fully.executedProofCount, 2);
  assert.equal(fully.executableProofCount, 2);
  assert.doesNotMatch(fully.summary, /PARTIAL/);
});

test("ACCEPTANCE 3 (contrast): a ZERO-executed review takes the CAPPED shape, not partiallyExecuted — the two must never be conflated", () => {
  const v = judgeReview(partialCriteria(), { diff: "", report: PARTIAL_REPORT }); // no headCheckoutDir at all
  assert.equal(v.capped, true);
  assert.equal(v.partiallyExecuted, false, "capped (zero executed) is a DIFFERENT class from partial (some executed)");
  assert.match(v.summary, /CAPPED/);
  assert.doesNotMatch(v.summary, /PARTIAL/);
});

test("ACCEPTANCE 3: the PARTIAL tag survives verdict-stability suppression — a re-review of an unchanged, floor-passing head keeps naming the same fraction, never silently reverting to an unqualified PASS", () => {
  const computed: ReviewVerdict = {
    state: "failure", // a semantic-only downgrade on an unchanged, floor-passing head
    criteria: [
      { claim: "alpha", proof: ALPHA_PROOF, met: true, reason: "proof executed and PASSED", proof_exec: "executed_pass", floorMet: true },
      {
        claim: "beta",
        proof: BETA_PROSE_PROOF,
        met: false,
        reason: "reviewer judged the proof non-responsive (semantic downgrade)",
        proof_exec: "not_executable",
        proof_skip: "no-dialect",
        floorMet: true,
      },
    ],
    testTheater: false,
    summary: "remudero-review: FAIL — beta unmet",
    floorDegraded: false,
    floorState: "success",
    capped: false,
    keywordOnly: false,
    planOnly: false,
    partiallyExecuted: true,
    executedProofCount: 1,
    executableProofCount: 2,
  };
  const prior: PriorReviewVerdict = { headSha: "abc1234", state: "success" };
  const result = applyVerdictStability(computed, "abc1234", prior);
  assert.equal(result.suppressed, true);
  assert.equal(result.verdict.state, "success");
  assert.match(result.verdict.summary, /PARTIAL: 1\/2/);
});
