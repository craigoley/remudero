import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  judgeReview,
  parseReviewerUnable,
  parseReviewerVerdictClauses,
  parseReviewerVerdicts,
  postReviewStatusGuarded,
  reviewerVerdictContract,
} from "#src/lib/review.js";
import { classifyReviewOutcome, recordedReviewVerdictLines } from "#src/lib/review-outcome-class.js";
import { ghIssueGateway, tryEscalate } from "#src/lib/escalate.js";

// The four W1-T9716 criteria #16758's 17:13Z review judged; all four proofs executed and passed.
const criteria = [
  { claim: "an extended task bucket equals a fresh full read", proof: "unit test: an extended task bucket equals a fresh full read" },
  { claim: "a re-derived task reads only its new rows", proof: "unit test: a re-derived task reads only its new rows" },
  { claim: "the task cache evicts the least recently re-derived task", proof: "unit test: the task cache evicts the least recently re-derived task" },
  { claim: "now-view bodies are identical with the task cache on and off", proof: "unit test: now-view bodies are identical with the task cache on and off" },
];
const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const a = 1;\n";
const report = criteria.map((c) => c.claim).join("\n");

function judged(transcript: string) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-unable-review-"));
  try {
    return judgeReview(criteria, {
      diff, report, headCheckoutDir: dir,
      execProof: () => "pass",
      semantic: parseReviewerVerdicts(transcript, criteria.length),
      semanticClauses: parseReviewerVerdictClauses(transcript, criteria.length),
      reviewerUnable: parseReviewerUnable(transcript, criteria.length),
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const unableTranscript = criteria.map((_, i) =>
  `REVIEW_VERDICT ${i + 1}: UNABLE sandbox launcher failed before execution; could not inspect the named test`).join("\n");

test("an UNABLE verdict line is no verdict, and its reason is read only by parseReviewerUnable", () => {
  const text = "REVIEW_VERDICT 1: UNABLE sandbox launcher failed\nREVIEW_VERDICT 2: PASS\nREVIEW_VERDICT 3: FAIL asserts nothing\nREVIEW_VERDICT 4: UNABLE";
  assert.deepEqual(parseReviewerVerdicts(text, 4), [undefined, true, false, undefined]);
  assert.deepEqual(parseReviewerUnable(text, 4), ["sandbox launcher failed", undefined, undefined, ""]);
  assert.deepEqual(parseReviewerVerdictClauses(text, 4), [undefined, undefined, "asserts nothing", undefined]);
  assert.match(reviewerVerdictContract(4), /REVIEW_VERDICT <n>: UNABLE/);
  assert.match(reviewerVerdictContract(4), /USE UNABLE, NEVER FAIL, WHEN YOU COULD NOT LOOK/);
});

test("#16758 replay: a reviewer that could not inspect four executed-and-passed proofs is cannot-evaluate, never a FAILURE", () => {
  const verdict = judged(unableTranscript);
  assert.equal(verdict.state, "pending");
  assert.equal(verdict.cannotEvaluate, true);
  assert.match(verdict.summary, /^remudero-review: cannot-evaluate — reviewer unable: sandbox launcher failed/);
  for (const c of verdict.criteria) {
    assert.equal(c.proof_exec, "executed_pass");
    assert.equal(c.met, true, "an UNABLE criterion keeps its floor verdict");
    assert.equal(c.floorMet, true);
    assert.match(c.reviewerUnavailable ?? "", /sandbox launcher failed/);
    assert.doesNotMatch(c.reason, /semantic downgrade/);
  }
});

test("control: a reviewer that inspected and named a defect still downgrades and fails the review", () => {
  const verdict = judged(criteria.map((_, i) => `REVIEW_VERDICT ${i + 1}: FAIL the test asserts only that the file parses`).join("\n"));
  assert.equal(verdict.state, "failure");
  for (const c of verdict.criteria) {
    assert.equal(c.met, false);
    assert.equal(c.reviewerUnavailable, undefined);
    assert.match(c.reason, /semantic downgrade/);
  }
});

test("a real FAIL beside an UNABLE fails only the real one, and a witnessed FAIL outranks UNABLE on its own criterion", () => {
  const verdict = judged([
    "REVIEW_VERDICT 1: FAIL the test asserts only that the file parses",
    "REVIEW_VERDICT 2: UNABLE could not read the named test",
    "REVIEW_VERDICT 3: PASS",
    "REVIEW_VERDICT 4: UNABLE shell failed",
    "REVIEW_VERDICT 4: FAIL the bound is characters, not bytes",
  ].join("\n"));
  assert.deepEqual(verdict.criteria.map((c) => c.met), [false, true, true, false]);
  assert.deepEqual(verdict.criteria.map((c) => c.reviewerUnavailable !== undefined), [false, true, false, false]);
  assert.equal(verdict.state, "pending", "any reviewer-unavailable criterion makes the review cannot-evaluate");
});

test("W1-T11428 criterion 2: a required semantic review whose reviewer was UNABLE is posted as cannot-evaluate and escalated once, never withheld", async () => {
  const lines = recordedReviewVerdictLines(`noise\n${unableTranscript}\n`, criteria.length);
  assert.equal(lines.length, criteria.length, "every UNABLE line is recorded as a token");
  const decision = classifyReviewOutcome({
    stage: "semantic", plan_only: false, required_semantic: true, criteria_count: criteria.length,
    risk_present: true, budget_present: true, untasked: false, head_task_resolved: true, own_task_record_missing: false,
    reviewer_outcome: "success", verdict_lines: lines,
  });
  assert.equal(decision.class, "posted", `an UNABLE criterion is answered, so nothing is withheld (got ${decision.reason})`);

  const verdict = judged(unableTranscript);
  const dir = mkdtempSync(join(tmpdir(), "rmd-unable-escalate-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  try {
    const posted: string[] = [];
    const issueTitles: string[] = [];
    const opts = {
      owner: "craigoley", repo: "remudero", sha: "2".repeat(40), state: verdict.state, description: verdict.summary,
      taskId: "W1-T9716", prUrl: "https://github.com/craigoley/remudero/pull/16758", ledgerPath, runId: "review-unable",
      evidence: "no_evidence" as const, fetchLifecycle: () => ({ merged: false, closed: false }),
      post: (status: { state: string }) => { posted.push(status.state); },
      issues: { listOpen: () => [], create: (title: string) => { issueTitles.push(title); return "https://github.com/craigoley/remudero/issues/1"; } },
      cannotEvaluateEscalation: (e: Parameters<typeof tryEscalate>[0], issues: unknown) =>
        tryEscalate(e, { issues: (issues ?? ghIssueGateway("craigoley", "remudero")) as never, ledgerPath, runId: "review-unable" }),
    };
    assert.equal((await postReviewStatusGuarded(opts)).posted, true);
    assert.equal((await postReviewStatusGuarded(opts)).posted, true);
    assert.deepEqual(posted, ["pending", "pending"], "never a FAILURE status");
    assert.equal(issueTitles.length, 1, "the existing cannot-evaluate escalation fires once per head");
    const ledger = readFileSync(ledgerPath, "utf8");
    assert.equal(ledger.match(/"step":"review.cannot_evaluate_escalated"/g)?.length, 1);
    assert.match(ledger, /reviewer could not inspect the proofs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// #16956's 02:01Z review: judgeCriterion's satisfied_by and worker-refusal early returns dropped the UNABLE marker.
function judgedWith(list: Array<{ claim: string; proof: string; satisfied_by?: string }>, transcript: string, implementationReport?: string) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-unable-early-"));
  try {
    return judgeReview(list, {
      diff, report, headCheckoutDir: dir, execProof: () => "pass",
      semantic: parseReviewerVerdicts(transcript, list.length),
      semanticClauses: parseReviewerVerdictClauses(transcript, list.length),
      reviewerUnable: parseReviewerUnable(transcript, list.length),
      ...(implementationReport === undefined ? {} : { implementationReport }),
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("W1-T11428 criterion 1: an UNABLE line on a satisfied_by criterion is cannot-evaluate, not success", () => {
  const list = [{ ...criteria[0]!, satisfied_by: "#16000" }, criteria[1]!];
  const verdict = judgedWith(list, "REVIEW_VERDICT 1: UNABLE sandbox launcher failed\nREVIEW_VERDICT 2: PASS");
  assert.equal(verdict.cannotEvaluate, true);
  assert.equal(verdict.state, "pending");
  assert.match(verdict.criteria[0]!.reviewerUnavailable ?? "", /sandbox launcher failed/);
  assert.equal(verdict.criteria[0]!.met, true, "the prior merge still satisfies it");
});

test("W1-T11428 criterion 1: an UNABLE line on a worker-refused criterion is cannot-evaluate, not failure", () => {
  const verdict = judgedWith(criteria.slice(0, 2),
    "REVIEW_VERDICT 1: UNABLE shell failed before execution\nREVIEW_VERDICT 2: PASS",
    "REFUSED:\n1. [premise-rotted] the cache this criterion names was removed upstream\n");
  assert.ok(verdict.criteria[0]!.refusal, "the refusal path judged criterion 1");
  assert.equal(verdict.cannotEvaluate, true);
  assert.equal(verdict.state, "pending");
  assert.match(verdict.criteria[0]!.reviewerUnavailable ?? "", /shell failed/);
});
