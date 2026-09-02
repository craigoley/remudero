import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import {
  claimReviewDecision,
  lastReviewDecisionTerminal,
  postReviewStatusGuarded,
  reviewDecisionDigest,
  type ReviewEvaluatorProvenance,
  type ReviewState,
  type ReviewVerdict,
} from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";

const PR = "https://github.com/o/r/pull/7";
const TASK = "W1-T2722";
const HEAD = "abcdef1234567890";
const provenance = (sessionId: string): ReviewEvaluatorProvenance => ({
  provider: "codex",
  requestedModel: "gpt-5.6-sol",
  servedModel: "gpt-5.6-sol-2026-08-31",
  effort: "high",
  sessionId,
});
const verdict = (state: ReviewState): ReviewVerdict => ({
  state,
  criteria: [],
  testTheater: false,
  summary: state,
  floorDegraded: false,
  capped: false,
  keywordOnly: false,
  planOnly: false,
});
const digestInput = {
  headSha: HEAD,
  diff: "diff --git a/a.ts b/a.ts\n+export const a = 1;\n",
  report: "Implemented and validated.",
  body: "PR body",
  acceptance: [{ claim: "works", proof: "unit test: test/a.test.ts" }],
  declaredFiles: ["src/a.ts", "test/a.test.ts"],
};

test("W1-T2722: the decision digest covers every material input and excludes operational/model-sample churn", () => {
  const base = reviewDecisionDigest(digestInput);
  const changes = [
    { ...digestInput, headSha: "different" },
    { ...digestInput, diff: digestInput.diff + "+const baseMoved = true;\n" },
    { ...digestInput, report: "different report bytes" },
    { ...digestInput, body: "edited body" },
    { ...digestInput, acceptance: [{ claim: "changed criterion", proof: "unit test: test/a.test.ts" }] },
    { ...digestInput, declaredFiles: [...digestInput.declaredFiles, "src/b.ts"] },
    { ...digestInput, policyRevision: "review-policy-v2" },
  ];
  for (const changed of changes) assert.notEqual(reviewDecisionDigest(changed), base);
  assert.equal(
    reviewDecisionDigest({ ...digestInput, comments: ["new"], labels: ["queue"], scheduledAt: "later", semanticSample: "random" } as never),
    base,
  );
});

test("W1-T2722: one decision has one atomic owner; a completed terminal is replayed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-decision-claim-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const digest = reviewDecisionDigest(digestInput);
  try {
    const owner = await claimReviewDecision({ ledgerPath, taskId: TASK, prUrl: PR, digest });
    assert.equal(owner.kind, "owned");
    const loser = await claimReviewDecision({ ledgerPath, taskId: TASK, prUrl: PR, digest });
    assert.deepEqual(loser, { kind: "in_flight" });
    if (owner.kind === "owned") owner.release();

    appendLedger(ledgerPath, {
      run_id: "review-1", task_id: TASK, step: "review.posted", pr_url: PR, head_sha: HEAD,
      state: "failure", review_decision_digest: digest, decision_verdict: verdict("failure"),
      reviewer_outcome: "reviewer_completed", evaluator_provenance: provenance("session-a"),
    });
    const replay = await claimReviewDecision({ ledgerPath, taskId: TASK, prUrl: PR, digest });
    assert.equal(replay.kind, "replay");
    if (replay.kind === "replay") {
      assert.equal(replay.terminal.state, "failure");
      assert.equal(replay.terminal.evaluatorProvenance.sessionId, "session-a");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function conflictCase(priorState: ReviewState, attemptedState: ReviewState): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-decision-conflict-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const digest = reviewDecisionDigest(digestInput);
  const posted: string[] = [];
  try {
    appendLedger(ledgerPath, {
      run_id: "review-prior", task_id: TASK, step: "review.posted", pr_url: PR, head_sha: HEAD,
      state: priorState, review_decision_digest: digest, decision_verdict: verdict(priorState),
      reviewer_outcome: "reviewer_completed", evaluator_provenance: provenance("session-prior"),
    });
    const result = await postReviewStatusGuarded({
      owner: "o", repo: "r", sha: HEAD, state: attemptedState, taskId: TASK, evidence: "executed",
      ledgerPath, runId: "review-attempt", prUrl: PR, reviewDecisionDigest: digest,
      evaluatorProvenance: provenance("session-attempt"), fetchLifecycle: () => ({ merged: false, closed: false }),
      post: ({ state }) => void posted.push(state),
    });
    assert.equal(result.posted, true);
    assert.equal(result.conflict, true);
    assert.equal(result.effectiveState, "failure");
    assert.deepEqual(posted, ["failure"], "the conflict hold is posted; neither evaluator wins");
    const conflict = readLedgerLines(ledgerPath).find((line) => line.step === "review.verdict_conflict");
    assert.equal(conflict?.prior_state, priorState);
    assert.equal(conflict?.attempted_state, attemptedState);
    assert.equal((conflict?.prior_evaluator as Record<string, unknown>)?.sessionId, "session-prior");
    assert.equal((conflict?.attempted_evaluator as Record<string, unknown>)?.sessionId, "session-attempt");
    const serialized = JSON.stringify(conflict);
    for (const forbidden of ["credential", "prompt", "transcript", "auth.json"]) assert.doesNotMatch(serialized, new RegExp(forbidden, "i"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T2722: failure then success on one decision becomes a conflict hold", () => conflictCase("failure", "success"));
test("W1-T2722: success then failure on one decision becomes a conflict hold", () => conflictCase("success", "failure"));

test("W1-T2722: a failed conflict-hold post is not reported as posted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-decision-conflict-post-failed-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const digest = reviewDecisionDigest(digestInput);
  try {
    appendLedger(ledgerPath, {
      run_id: "prior", task_id: TASK, step: "review.posted", pr_url: PR,
      review_decision_digest: digest, decision_verdict: verdict("success"),
    });
    const result = await postReviewStatusGuarded({
      owner: "o", repo: "r", sha: HEAD, state: "failure", taskId: TASK, evidence: "executed",
      ledgerPath, runId: "attempt", prUrl: PR, reviewDecisionDigest: digest,
      fetchLifecycle: () => ({ merged: false, closed: false }), post: () => { throw new Error("offline"); },
    });
    assert.equal(result.posted, false);
    assert.equal(result.conflict, true);
    assert.ok(readLedgerLines(ledgerPath).some((line) => line.step === "review.post_failed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2722: a changed decision digest is posted normally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-decision-changed-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const oldDigest = reviewDecisionDigest(digestInput);
  const newDigest = reviewDecisionDigest({ ...digestInput, body: "corrected body" });
  const posted: string[] = [];
  try {
    appendLedger(ledgerPath, {
      run_id: "old", task_id: TASK, step: "review.posted", pr_url: PR, head_sha: HEAD,
      state: "failure", review_decision_digest: oldDigest, decision_verdict: verdict("failure"),
      reviewer_outcome: "reviewer_completed", evaluator_provenance: provenance("old-session"),
    });
    const result = await postReviewStatusGuarded({
      owner: "o", repo: "r", sha: HEAD, state: "success", taskId: TASK, evidence: "executed",
      ledgerPath, runId: "new", prUrl: PR, reviewDecisionDigest: newDigest,
      evaluatorProvenance: provenance("new-session"), fetchLifecycle: () => ({ merged: false, closed: false }),
      post: ({ state }) => void posted.push(state),
    });
    assert.deepEqual(result, { posted: true });
    assert.deepEqual(posted, ["success"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2722: production claims before spawn, replays before post/comment, and handles conflicts before fixed", () => {
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const reviewStart = source.indexOf("async function runReview(");
  const reviewEnd = source.indexOf("// ── THE blocked_review FIX RUNG", reviewStart);
  const reviewBody = source.slice(reviewStart, reviewEnd);
  const claimAt = reviewBody.indexOf("claimReviewDecision({");
  const replayAt = reviewBody.indexOf('decisionClaim.kind === "replay"');
  assert.ok(claimAt >= 0 && claimAt < reviewBody.indexOf("spawnWorker({"));
  assert.ok(replayAt > claimAt && replayAt < reviewBody.indexOf("postReviewStatusGuarded({"));
  assert.ok(replayAt < reviewBody.indexOf("postReviewCommentGuarded(prUrl"));
  assert.match(reviewBody, /review_decision_digest: decisionDigest/);
  assert.match(reviewBody, /decision_verdict: verdict/);

  const fixStart = source.indexOf("export async function runFixRung(");
  const fixBody = source.slice(fixStart, source.indexOf("export function", fixStart + 30));
  const conflictAt = fixBody.indexOf('review.decisionDisposition === "conflict"');
  assert.ok(conflictAt >= 0 && conflictAt < fixBody.indexOf('if (review.state === "success")'));
  assert.match(fixBody.slice(conflictAt), /outcome: "escalated"/);
  assert.doesNotMatch(fixBody.slice(conflictAt, fixBody.indexOf('if (review.state === "success")')), /outcome: "fixed"/);
});

test("W1-T2722: terminal reader ignores a different digest", () => {
  const terminal = lastReviewDecisionTerminal([
    { step: "review.posted", task_id: TASK, pr_url: PR, review_decision_digest: "other", decision_verdict: verdict("success") },
  ], TASK, PR, reviewDecisionDigest(digestInput));
  assert.equal(terminal, undefined);
});
