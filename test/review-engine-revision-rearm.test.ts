import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import {
  REVIEW_ENGINE_REVISION,
  claimReviewDecision,
  parseAcceptanceBlock,
  reviewDecisionDigest,
  reviewInputDigest,
  type ReviewVerdict,
} from "../src/lib/review.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView } from "../src/lib/sweep.js";
import { reviewAttemptsForInput } from "../src/run-task.js";
import { writeMutantModule } from "./helpers/mutant-module.js";

const PR_4042 = "https://github.com/craigoley/remudero/pull/4042";
const TASK_4042 = "W1-T2857";
const HEAD_4042 = "eb44a4cab4e78a85c2fbb8e893b4225ab589cd4b";
const OLD_INPUT_DIGEST_4042 = "v1:b22335c7bb6f0e240d71dde42fe50d6323181e89f424fcfb4fe7a9e7f9061d25";
const OLD_DECISION_DIGEST_4042 = "v1:8dfa3c12ab6c35942fa0669bf9b983bc88862a23b7d3b76b579d8dc64efc12a7";
const PR_BODY_4042 = [
  "Adds a reusable host-side verifier for the provider bind mounts that make a recycled container operational, rather than treating image identity as sufficient. The verifier compares only explicit source/destination/read-write expectations and emits one bounded JSON verdict; drift output never includes credential or config source paths or contents.",
  "",
  "The recycle derives expectations from the same pre-launch mount decisions, runs the verifier after the existing image-digest proof, and prints OK only when both contracts pass. Optional Codex/config directories that were absent remain intentional omissions. A failed postcondition leaves the newly started container running for diagnosis and performs no stop, removal, retry, or rollback.",
  "",
  "Validation: all 32 focused and existing recycle regressions pass on the Azure Linux host from a throwaway clone; the standalone verifier's three portable tests pass on macOS; typecheck and Bash syntax checks pass; the integration mutation proves that deleting the verifier lets a selected missing Codex mount falsely report success; `rmd preflight --fast` passes 16/16 after rebasing onto current `origin/main`.",
  "",
  "Acceptance:",
  "- a replacement with the pulled image but a missing expected Codex or provider-config mount fails the postcondition instead of printing the recycle OK verdict | unit test: test/container-runtime-contract.test.ts",
  "- the actual state and Claude mounts plus each optional mount selected before launch must match the exact host source, container destination and read-write mode | unit test: test/container-runtime-contract.test.ts",
  "- an optional Codex/config source absent before launch is omitted intentionally, is not created, and does not make the unchanged Claude-only launch fail | regression test: test/container-runtime-contract.test.ts",
  "- the standalone verifier returns bounded machine-readable healthy, drift and unreadable verdicts without exposing config contents, credentials, environment values or a full inspect payload | unit test: test/container-runtime-contract.test.ts",
  "- a failed runtime postcondition leaves the new container running and performs no stop, remove, retry or rollback action | unit test: test/container-runtime-contract.test.ts",
  "- image-digest verification, pause/drain sequencing, App authentication, reclaim and the existing Claude-only fallback remain unchanged | regression test: test/container-runtime-contract.test.ts",
  "- deleting the runtime-contract call lets a pulled-image container with missing expected provider mounts report success again | mutation test: test/container-runtime-contract.test.ts",
  "",
  "Remudero-Task: W1-T2857",
  "",
].join("\n");

function legacyInputDigest(headSha: string, body: string): string {
  const encoded = JSON.stringify({ version: 1, headSha, body });
  return `v1:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

const oldFailure: ReviewVerdict = {
  state: "failure",
  criteria: parseAcceptanceBlock(PR_BODY_4042).map((criterion) => ({
    ...criterion,
    met: false,
    reason: "old engine semantic downgrade",
    proof_exec: "executed_pass",
  })),
  testTheater: false,
  summary: "old engine false failure",
  floorDegraded: false,
  capped: false,
  keywordOnly: false,
  planOnly: false,
};

test("W1-T2872: the exact PR #4042 old-engine row spends zero current-engine attempts and re-enters post-review", () => {
  assert.equal(legacyInputDigest(HEAD_4042, PR_BODY_4042), OLD_INPUT_DIGEST_4042, "the fixture is the observed exact body and head");
  const currentDigest = reviewInputDigest(HEAD_4042, PR_BODY_4042);
  const ledger = [{
    ts: "2026-09-05T05:40:57.234Z",
    step: "review.posted",
    task_id: TASK_4042,
    pr_url: PR_4042,
    head_sha: HEAD_4042,
    review_input_digest: OLD_INPUT_DIGEST_4042,
    review_decision_digest: OLD_DECISION_DIGEST_4042,
    decision_verdict: oldFailure,
  }];
  const attempts = reviewAttemptsForInput(ledger, TASK_4042, PR_4042, HEAD_4042, currentDigest);
  assert.deepEqual(attempts, { attempts: 0 });

  const view: OpenPrView = {
    prNumber: 4042,
    prUrl: PR_4042,
    taskId: TASK_4042,
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: oldFailure.criteria,
    criteriaRecoverable: true,
    priorStrikes: 1,
    lastActivityAt: "2026-09-05T05:40:57.234Z",
    headSha: HEAD_4042,
    autoMergeArmed: false,
    requiredContextsUnreadable: false,
    reviewPostRefused: false,
    reviewInputDigest: currentDigest,
    priorReviewAttemptsForInput: attempts.attempts,
  };
  const disposition = deriveDisposition(view, DEFAULT_SWEEP_POLICY, Date.parse("2026-09-05T08:00:00.000Z"));
  assert.equal(disposition.disposition, "post-review");
  assert.match(disposition.reason, /authoritative reviewer/);
});

test("W1-T2872: the current engine owns a new decision instead of replaying PR #4042's old terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-review-engine-rearm-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const currentDecision = reviewDecisionDigest({
    headSha: HEAD_4042,
    diff: "diff --git a/deploy/rmd-recycle.sh b/deploy/rmd-recycle.sh\n",
    report: "exact-head reviewer materialized",
    body: PR_BODY_4042,
    acceptance: parseAcceptanceBlock(PR_BODY_4042),
    declaredFiles: ["deploy/rmd-recycle.sh", "deploy/verify-runtime-contract.sh", "test/container-runtime-contract.test.ts"],
  });
  try {
    appendLedger(ledgerPath, {
      run_id: "review-PR4042-1788586678151",
      task_id: TASK_4042,
      step: "review.posted",
      pr_url: PR_4042,
      head_sha: HEAD_4042,
      review_decision_digest: OLD_DECISION_DIGEST_4042,
      decision_verdict: oldFailure,
      reviewer_outcome: "success",
    });
    const claim = await claimReviewDecision({ ledgerPath, taskId: TASK_4042, prUrl: PR_4042, digest: currentDecision });
    assert.equal(claim.kind, "owned", "the corrected reviewer must run; the old terminal is not replayable");
    if (claim.kind === "owned") claim.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2872: engine evolution changes both identities while operational churn changes neither", () => {
  const previousRevision = "review-engine-pre-exact-head-v1";
  const currentInput = reviewInputDigest(HEAD_4042, PR_BODY_4042, REVIEW_ENGINE_REVISION);
  assert.notEqual(currentInput, reviewInputDigest(HEAD_4042, PR_BODY_4042, previousRevision));
  assert.notEqual(currentInput, reviewInputDigest(`${HEAD_4042}a`, PR_BODY_4042, REVIEW_ENGINE_REVISION));
  assert.notEqual(currentInput, reviewInputDigest(HEAD_4042, `${PR_BODY_4042}edited`, REVIEW_ENGINE_REVISION));

  const material = {
    headSha: HEAD_4042,
    diff: "diff",
    report: "report",
    body: PR_BODY_4042,
    acceptance: parseAcceptanceBlock(PR_BODY_4042),
    declaredFiles: ["deploy/rmd-recycle.sh"],
  };
  const currentDecision = reviewDecisionDigest({ ...material, engineRevision: REVIEW_ENGINE_REVISION });
  assert.notEqual(currentDecision, reviewDecisionDigest({ ...material, engineRevision: previousRevision }));
  assert.equal(
    currentDecision,
    reviewDecisionDigest({
      ...material,
      engineRevision: REVIEW_ENGINE_REVISION,
      comments: ["new"],
      labels: ["queue"],
      scheduledAt: "later",
      provider: "claude",
      model: "opus",
      unrelatedMainSha: "changed",
    } as never),
    "comments, labels, scheduling, provider/model sampling and unrelated main movement are not decision inputs",
  );
});

test("W1-T2872 mutation: deleting the engine revision independently restores admission suppression and terminal replay", async () => {
  const source = readFileSync(fileURLToPath(new URL("../src/lib/review.ts", import.meta.url)), "utf8");
  const inputNeedle = "const encoded = JSON.stringify({ version: 2, engineRevision, headSha, body });";
  const decisionNeedle = "    engineRevision: input.engineRevision ?? REVIEW_ENGINE_REVISION,\n";
  assert.equal(source.split(inputNeedle).length - 1, 1, "the input-digest mutation target must be unique");
  assert.equal(source.split(decisionNeedle).length - 1, 1, "the decision-digest mutation target must be unique");

  const inputMutant = (await import(writeMutantModule(
    "review-input-revision-mutant.ts",
    source.replace(inputNeedle, "const encoded = JSON.stringify({ version: 2, headSha, body });"),
  ))) as typeof import("../src/lib/review.js");
  assert.equal(
    inputMutant.reviewInputDigest(HEAD_4042, PR_BODY_4042, REVIEW_ENGINE_REVISION),
    inputMutant.reviewInputDigest(HEAD_4042, PR_BODY_4042, "review-engine-pre-exact-head-v1"),
    "without the revision, an old-engine posting suppresses the current-engine admission again",
  );

  const decisionMutant = (await import(writeMutantModule(
    "review-decision-revision-mutant.ts",
    source.replace(decisionNeedle, ""),
  ))) as typeof import("../src/lib/review.js");
  const material = {
    headSha: HEAD_4042,
    diff: "diff",
    report: "report",
    body: PR_BODY_4042,
    acceptance: parseAcceptanceBlock(PR_BODY_4042),
  };
  assert.equal(
    decisionMutant.reviewDecisionDigest({ ...material, engineRevision: REVIEW_ENGINE_REVISION }),
    decisionMutant.reviewDecisionDigest({ ...material, engineRevision: "review-engine-pre-exact-head-v1" }),
    "without the revision, the old engine's terminal decision becomes replayable again",
  );
});
