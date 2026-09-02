import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { runFixRung, type ReviewRunResult } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

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

  // The runFixRung half of this test asserted, by `indexOf` position, that the conflict divert
  // appeared before the `outcome: "fixed"` return. Source position is not reachability: it would
  // read identically whether the divert were reachable or dead, and inverting one condition into a
  // guard clause breaks it while making the behaviour stricter. The obligation is proven by
  // driving the real function instead — see the conflict-hold test below and its falsifier.
});

test("W1-T2722: a conflicting computed success is held at failure and the fix rung escalates once without resolving or arming", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-decision-fix-rung-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const worktreePath = fileURLToPath(new URL("..", import.meta.url));
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const opened: Array<{ title: string; body: string }> = [];
  let spawnCalls = 0;
  let reviewCalls = 0;
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 100, contextBudget: 120000 };
  const issues: IssueGateway = {
    create(title, body) {
      opened.push({ title, body });
      return "https://github.com/o/r/issues/2722";
    },
  };
  const worker: WorkerResult = {
    sessionId: "fix-session",
    costUsd: 0,
    numTurns: 1,
    text: "computed success after the fix",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
  const initialReview: ReviewRunResult = {
    ...verdict("failure"),
    criteria: [{ claim: "production is wired", proof: "unit test", met: false, reason: "missing", proof_exec: "executed_fail" }],
    headSha: "prior-head",
    reviewerOutcome: "reviewer_completed",
  };
  // All deterministic criteria passed, which is the computed-success shape. runReview has already
  // converted the contradictory terminal into the effective failure returned to its caller.
  const conflictReview: ReviewRunResult = {
    ...verdict("failure"),
    criteria: [{ claim: "production is wired", proof: "unit test", met: true, floorMet: true, reason: "passed", proof_exec: "executed_pass" }],
    summary: "conflicting success held at failure",
    headSha: "fixed-head",
    reviewerOutcome: "reviewer_completed",
    reviewDecisionDigest: "v1:conflicting-decision",
    decisionDisposition: "conflict",
    evaluatorProvenance: provenance("conflicting-session"),
  };

  try {
    const outcome = await runFixRung({
      taskId: TASK,
      runId: `${TASK}-run`,
      task: { id: TASK, title: "content-address review decisions" },
      prUrl: PR,
      branch: `run-${TASK}-1`,
      worktreePath,
      initialSessionId: "implement-session",
      mount,
      settingsFile: join(dir, "settings.json"),
      config: {} as Config,
      budgetUsd: 10,
      strikeCap: 2,
      initialReview,
      reviewBase: { owner: "o", repo: "r", headCheckoutDir: worktreePath, reviewerMount: mount },
      deps: {
        spawn: async () => {
          spawnCalls++;
          return worker;
        },
        waitForCiGreen: async () => "green",
        runReview: async () => {
          reviewCalls++;
          return conflictReview;
        },
        push: () => {},
        issues,
        ledgerPath,
        log: (step, extra) => events.push({ step, extra }),
        say: () => {},
        account: (result) => result,
      },
    });

    assert.equal(outcome.outcome, "escalated");
    assert.equal(outcome.reason, "review_decision_conflict");
    assert.equal(outcome.review.state, "failure", "the effective result cannot become success");
    assert.equal(outcome.strikes, 1);
    assert.equal(spawnCalls, 1);
    assert.equal(reviewCalls, 1);
    assert.equal(opened.length, 1, "the conflict escalates exactly once");
    assert.match(opened[0].body, /v1:conflicting-decision/);
    assert.match(opened[0].body, /gpt-5\.6-sol-2026-08-31/);
    assert.equal(events.filter((event) => event.step === "review.decision_conflict_escalated").length, 1);
    assert.equal(events.filter((event) => event.step === "fix.resolved").length, 0);
    assert.equal(events.filter((event) => event.step === "automerge.armed").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2722: terminal reader ignores a different digest", () => {
  const terminal = lastReviewDecisionTerminal([
    { step: "review.posted", task_id: TASK, pr_url: PR, review_decision_digest: "other", decision_verdict: verdict("success") },
  ], TASK, PR, reviewDecisionDigest(digestInput));
  assert.equal(terminal, undefined);
});

test("W1-T2722 (FALSIFIER): the SAME fixture without the conflict disposition never takes the conflict path", async () => {
  // The conflict-hold test above proves the conflict path fires. It cannot, on its own, show that
  // the DISPOSITION is what fires it — every assertion there would also pass on a rung that
  // escalated unconditionally. This varies that one field and nothing else.
  const dir = mkdtempSync(join(tmpdir(), "rmd-decision-fix-rung-control-"));
  const worktreePath = fileURLToPath(new URL("..", import.meta.url));
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const opened: Array<{ title: string; body: string }> = [];
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 100, contextBudget: 120000 };
  const issues: IssueGateway = {
    create(title, body) {
      opened.push({ title, body });
      return "https://github.com/o/r/issues/2722";
    },
  };
  const worker: WorkerResult = {
    sessionId: "fix-session", costUsd: 0, numTurns: 1, text: "", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
  const initialReview: ReviewRunResult = {
    ...verdict("failure"),
    criteria: [{ claim: "production is wired", proof: "unit test", met: false, reason: "missing", proof_exec: "executed_fail" }],
    headSha: "prior-head",
    reviewerOutcome: "reviewer_completed",
  };
  // IDENTICAL to the conflict fixture above except `decisionDisposition`.
  const computedReview: ReviewRunResult = {
    ...verdict("failure"),
    criteria: [{ claim: "production is wired", proof: "unit test", met: true, floorMet: true, reason: "passed", proof_exec: "executed_pass" }],
    summary: "no conflict — an ordinary recomputed verdict",
    headSha: "fixed-head",
    reviewerOutcome: "reviewer_completed",
    reviewDecisionDigest: "v1:conflicting-decision",
    decisionDisposition: "computed",
    evaluatorProvenance: provenance("conflicting-session"),
  };

  try {
    const outcome = await runFixRung({
      taskId: TASK,
      runId: `${TASK}-run`,
      task: { id: TASK, title: "content-address review decisions" },
      prUrl: PR,
      branch: `run-${TASK}-1`,
      worktreePath,
      initialSessionId: "implement-session",
      mount,
      settingsFile: join(dir, "settings.json"),
      config: {} as Config,
      budgetUsd: 10,
      strikeCap: 2,
      initialReview,
      reviewBase: { owner: "o", repo: "r", headCheckoutDir: worktreePath, reviewerMount: mount },
      deps: {
        spawn: async () => worker,
        waitForCiGreen: async () => "green",
        runReview: async () => computedReview,
        push: () => {},
        issues,
        ledgerPath: join(dir, "ledger.ndjson"),
        log: (step, extra) => events.push({ step, extra }),
        say: () => {},
        account: (result) => result,
      },
    });

    assert.notEqual(outcome.reason, "review_decision_conflict", "only the conflict disposition may take the conflict path");
    assert.equal(events.filter((event) => event.step === "review.decision_conflict_escalated").length, 0);
    assert.equal(opened.filter((issue) => /conflicting terminal review verdicts/.test(issue.body)).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
