/**
 * #10555 — the reviewer's proof run failed a unit test on the PR head that passed for the author and
 * for every fix worker. The executor read the run's output only to classify it and then dropped it,
 * so the `review.posted` row and each review-failed fix prompt carried nothing but the reason text
 * "proof executed and FAILED". The fix worker could not see what the reviewer saw, reported FIXED on
 * an unchanged run, and the reviewer failed it again.
 *
 * These tests pin the chain: the executor records a bounded excerpt of a failed run, the verdict
 * carries it into the ledger, the ledger read hands it to the fix prompt, the prompt names the
 * reviewer's sandbox (or says plainly that no output was recorded), and the progress judge sees a
 * FIXED round followed by the same reviewer output as a reviewer-only failure.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildOpenPrViews } from "./helpers/run-task-test.js";
// Namespace imports, so each test (not the file's load) fails on a tree without these exports.
import * as progressJudge from "../src/lib/fix-progress-judge.js";
import { renderFixPrompt } from "../src/lib/prompt-render.js";
import {
  execWhitelistedProof,
  judgeReview,
  judgeReviewAsync,
  parseWhitelistedProof,
  reviewInputDigest,
  type CriterionVerdict,
  type ProofSpawner,
} from "../src/lib/review.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROOF = "unit test: test/a-reviewer-only-proof-failure-reaches-the-fix-worker.test.ts";
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const a = 1;\n";

function failedSpawner(stdout: string, stderr = ""): ProofSpawner {
  return () => {
    throw Object.assign(new Error("Command failed"), { status: 1, signal: null, stdout, stderr });
  };
}

const REVIEWER_TAP =
  "TAP version 13\nnot ok 1 - writes the scratch file\n  ---\n  error: 'EACCES: permission denied, open /tmp/x'\n  ...\n1..1\n# fail 1\n";

test("a failed proof's output is recorded on the review verdict: command, exit status and output tail", () => {
  const w = parseWhitelistedProof(PROOF);
  assert.ok(w, "the fixture proof must parse");
  const outcome = execWhitelistedProof(w!, REPO_ROOT, 60_000, failedSpawner(REVIEWER_TAP, "warning from stderr"), {
    preflightBrowsers: () => {},
  });
  assert.equal(outcome, "fail");
  assert.match(w!.failureOutput ?? "", /^\$ .*a-reviewer-only-proof-failure-reaches-the-fix-worker\.test\.ts/);
  assert.match(w!.failureOutput ?? "", /\nexit 1\n/);
  assert.match(w!.failureOutput ?? "", /not ok 1 - writes the scratch file/);
  assert.match(w!.failureOutput ?? "", /EACCES: permission denied/);
  assert.match(w!.failureOutput ?? "", /warning from stderr/);

  const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  execWhitelistedProof(w!, REPO_ROOT, 60_000, failedSpawner(`${many}\nnot ok 1 - last\n# fail 1\n`), { preflightBrowsers: () => {} });
  const tail = (w!.failureOutput ?? "").split("\n").slice(2);
  assert.equal(tail.length, 40, "the excerpt keeps the last ~40 lines only");
  assert.equal(tail.at(-1), "# fail 1");
  assert.ok(!tail.includes("line 0"));
});

test("the failed proof's output rides the CriterionVerdict on both the sync and async review paths", async () => {
  const criteria = [{ claim: "the scratch file is written", proof: PROOF }];
  const execProof = (w: Parameters<typeof execWhitelistedProof>[0], cwd: string) =>
    execWhitelistedProof(w, cwd, 60_000, failedSpawner(REVIEWER_TAP), { preflightBrowsers: () => {} });
  const evidence = { diff: DIFF, report: "the scratch file is written", headCheckoutDir: REPO_ROOT, execProof };
  for (const verdict of [judgeReview(criteria, evidence), await judgeReviewAsync(criteria, evidence)]) {
    const [criterion] = verdict.criteria;
    assert.equal(criterion?.proof_exec, "executed_fail");
    assert.match(criterion?.proofFailureOutput ?? "", /EACCES: permission denied/);
  }
});

function unmetCriterion(extra: Partial<CriterionVerdict> = {}): CriterionVerdict {
  return {
    claim: "the scratch file is written",
    proof: PROOF,
    met: false,
    reason: "proof executed and FAILED on the PR head (test: x) — overrides any keyword coverage",
    proof_exec: "executed_fail",
    ...extra,
  };
}

function reviewerUnmetPrompt(criterion: CriterionVerdict): string {
  return renderFixPrompt({
    task: { id: "unfiled", title: "hand PR" },
    round: 1,
    branch: "run-unfiled-1",
    evidence: { review: { unmetCriteria: [criterion], summary: "1 unmet" } },
  });
}

test("a review-failed fix round's prompt carries the reviewer's recorded proof output and sandbox", () => {
  const output = `$ node --test x\nexit 1\n${REVIEWER_TAP}`;
  const prompt = reviewerUnmetPrompt(unmetCriterion({ proofFailureOutput: output }));
  assert.match(prompt, /MODE: reviewer-unmet/);
  assert.match(prompt, /This failed in the reviewer's sandbox; reproduce under those conditions \(sandbox: bwrap/);
  assert.match(prompt, /EACCES: permission denied/);
  assert.match(prompt, /not ok 1 - writes the scratch file/);
});

test("a review-failed fix round's prompt says so when no reviewer proof output was recorded", () => {
  const prompt = reviewerUnmetPrompt(unmetCriterion());
  assert.match(prompt, /reviewer proof output: none was recorded for this failure/);
  assert.doesNotMatch(reviewerUnmetPrompt(unmetCriterion({ proof_exec: "not_executable" })), /reviewer proof output/);
});

test("the sweep's ledger read hands the recorded reviewer output to the fix dispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-reviewer-output-"));
  const head = "c".repeat(40);
  const body = "Remudero-Task: W1-T10555-FIXTURE";
  const prUrl = "https://github.com/craigoley/remudero/pull/10555";
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, `${JSON.stringify({
      step: "review.posted", task_id: "W1-T10555-FIXTURE", pr_url: prUrl, head_sha: head,
      review_input_digest: reviewInputDigest(head, body), state: "failure",
      unmet_criteria: ["the scratch file is written"], reasons: ["proof executed and FAILED"],
      decision_verdict: { state: "failure", criteria: [unmetCriterion({ proofFailureOutput: "exit 1\nEACCES" })] },
    })}\n`);
    const [view] = buildOpenPrViews("craigoley", "remudero", ledgerPath, {
      fetch: (args: string[]): unknown => {
        const path = args.at(-1) ?? "";
        if (/state=open/.test(path)) {
          return [{ number: 10555, html_url: prUrl, head: { ref: "run-W1-T10555-FIXTURE-1", sha: head },
            updated_at: "2026-10-10T05:00:00.000Z", body, auto_merge: null, state: "open" }];
        }
        if (/check-runs/.test(path)) return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
        if (/commits\/.+\/status/.test(path)) return { statuses: [{ context: "remudero-review", state: "failure" }] };
        if (/\/pulls\/10555$/.test(path)) return { mergeable: true, mergeable_state: "clean" };
        return [];
      },
      requiredContexts: () => ["ci-gate"],
      readCiGateRequired: () => ["ci-gate"],
      fetchCiFailureEvidence: () => [],
    });
    assert.ok(view, "the fake REST gateway produced the target PR");
    assert.equal(view.unmetCriteria[0]?.proofFailureOutput, "exit 1\nEACCES");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the progress judge sees a FIXED round followed by the same reviewer output as a reviewer-only failure", () => {
  const output = "$ node --test x\nexit 1\nnot ok 1 - writes the scratch file\n# duration_ms 812.4";
  const rerun = output.replace("812.4", "655.1");
  const dispatch = {
    step: "fix.dispatch", task_id: "unfiled", repair_pr_url: "https://github.com/o/r/pull/10555", round_id: "r1",
    head_sha: "a".repeat(40), unmet_claims: ["the scratch file is written"],
    reviewer_proof_failures: progressJudge.reviewerProofFailures([unmetCriterion({ proofFailureOutput: output })]),
  };
  const done = { step: "fix.done", task_id: "unfiled", repair_pr_url: dispatch.repair_pr_url, round_id: "r1",
    fix_outcome: "FIXED", pushed_head_sha: "b".repeat(40) };
  const review = (text: string) => ({ step: "review.posted", task_id: "unfiled", pr_url: dispatch.repair_pr_url,
    state: "failure", decision_verdict: { criteria: [unmetCriterion({ proofFailureOutput: text })] } });

  const persisted = progressJudge.buildFixProgressInput({ taskId: "unfiled", prNumber: 10555, headSha: "b".repeat(40),
    currentRed: ["review:the scratch file is written"], ledger: [dispatch, done, review(rerun)] });
  assert.equal(progressJudge.reviewerFailureDigest(output), progressJudge.reviewerFailureDigest(rerun), "timings alone do not make a new failure");
  assert.equal(persisted.signals.reviewerOnlyFailurePersists, 1);
  assert.match(persisted.persistentReviewerFailures?.[0]?.excerpt ?? "", /not ok 1 - writes the scratch file/);

  const moved = progressJudge.buildFixProgressInput({ taskId: "unfiled", prNumber: 10555, headSha: "b".repeat(40),
    currentRed: ["review:the scratch file is written"], ledger: [dispatch, done, review("exit 1\nnot ok 1 - a different assertion")] });
  assert.equal(moved.signals.reviewerOnlyFailurePersists, 0);
  assert.equal(moved.persistentReviewerFailures, undefined);
});
