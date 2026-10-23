import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { lastReviewDecisionTerminal, reviewContractDigest, reviewDecisionDigest, reviewInputDigest } from "#src/lib/review.js";
import { requiredSemanticDecisionDigest } from "#src/lib/required-semantic-review.js";
import { shadowJudgeSampled } from "#src/lib/shadow-judge.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { runReview } from "#test/helpers/run-task-test.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const explanation = "the change exceeds the operator-approved identity backstop";
async function fixture(t: TestContext, text: string, prior?: "same" | "old-engine" | "old-body" | "old-contract" | "unreadable" | "unreadable-input") {
  const repo = gitRepo({ scope: t, kind: "review-explanation" });
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src/marker.ts"), "export const READY = true;\n");
  repo.git("add", "src/marker.ts"); repo.git("commit", "-qm", "fixture source");
  const headSha = repo.git("rev-parse", "HEAD");
  const prUrl = "https://github.com/acme/remudero/pull/1";
  const acceptance = [{ claim: "the marker is present", proof: "grep: READY in src/marker.ts" }];
  const task = { id: "W1-T1", files: ["src/marker.ts"], acceptance, risk: "low" as const, budget_usd: 0.5 };
  const diff = "diff --git a/src/marker.ts b/src/marker.ts\n--- /dev/null\n+++ b/src/marker.ts\n@@ -0,0 +1 @@\n+export const READY = true;\n";
  let report = "";
  for (let n = 0; n < 1000; n++) {
    const candidate = `the marker is present (${n})`;
    const digest = reviewDecisionDigest({ headSha, diff, report: candidate, body: candidate, acceptance,
      declaredFiles: task.files });
    if (!shadowJudgeSampled(`review:${prUrl}:${headSha}:${requiredSemanticDecisionDigest(digest, true)}`)) { report = candidate; break; }
  }
  assert.ok(report, "a real sampled-key control excludes the independent shadow call");
  const ledgerPath = join(repo.dir, ".git", "ledger.ndjson");
  if (prior) {
    const engineRevision = prior === "old-engine" ? "promised-followups-snapshot-v3" : undefined;
    appendLedger(ledgerPath, { run_id: "prior", task_id: task.id, step: "review.posted", state: "success",
      pr_url: prUrl, head_sha: headSha, capped: false, plan_only: false,
      ...(prior === "unreadable-input" ? {} : { review_input_digest: reviewInputDigest(headSha,
        prior === "old-body" ? `${report} prior body` : report, engineRevision) }),
      ...(prior === "unreadable" ? {} : { review_contract_digest: reviewContractDigest({ taskId: task.id,
        acceptance, declaredFiles: task.files, risk: task.risk, budgetUsd: task.budget_usd, engineRevision,
        ...(prior === "old-contract" ? { amendment: "prior task instruction" } : {}) }) }) });
  }
  const shim = ghShim([{ when: "pulls/1", stdout: JSON.stringify({ number: 1, state: "open", body: report,
    head: { ref: "fixture", sha: headSha }, html_url: prUrl }) }, { when: "pr diff", stdout: diff }, { when: "api", stdout: "{}" }]);
  const previousPath = process.env.PATH;
  const rows: { step: string; fields: Record<string, unknown> }[] = [];
  let arms = 0;
  try {
    process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
    const verdict = await runReview({ owner: "acme", repo: "remudero", prUrl, task, report,
      settingsFile: join(repo.dir, "settings.json"), config: { root: repo.dir, claudeBin: "/unused" } as never,
      requireSemanticReview: true, headCheckoutDir: repo.dir, ledgerPath, runId: "review-explanation",
      log: (step, fields = {}) => { rows.push({ step, fields }); appendLedger(ledgerPath, { run_id: "review-explanation", task_id: task.id, step, ...fields }); },
      say: () => {}, account: result => result,
      reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120000 }, budgetUsd: 0.5,
      reviewerSpawnWorker: async () => ({ sessionId: "explanation-fixture", text, blocks: [], stderr: "", subtype: "success",
        exit: { kind: "exit", code: 0 }, isError: false, apiError: false, costUsd: 0, numTurns: 1,
        permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "high", provider: "claude",
        tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false } as WorkerResult),
      readReviewReuseFacts: () => undefined, disarm: () => "not-armed", arm: () => { arms++; return "ledger-refused"; },
    });
    return { verdict, rows, arms };
  } finally { process.env.PATH = previousPath; rmSync(shim.dir, { recursive: true, force: true }); }
}

test("an explained semantic failure reaches the real binding verdict after a mechanical proof passes", async t => {
  const r = await fixture(t, `REVIEW_VERDICT 1: FAIL — ${explanation}`);
  assert.equal(r.verdict.floorState, "success");
  assert.equal(r.verdict.criteria[0]?.proof_exec, "executed_pass");
  assert.equal(r.verdict.state, "failure");
  assert.ok(r.verdict.criteria[0]?.reason.includes(explanation));
  assert.equal(r.arms, 0);
});

test("an older review engine cannot suppress a newly explained failure on the same head", async t => {
  const r = await fixture(t, `REVIEW_VERDICT 1: FAIL — ${explanation}`, "old-engine");
  assert.equal(r.verdict.state, "failure");
  assert.equal(r.arms, 0);
  assert.equal(r.rows.some(row => row.step === "review.downgrade_suppressed"), false);
});

test("an unreadable prior review contract cannot certify unchanged review input", async t => {
  const r = await fixture(t, `REVIEW_VERDICT 1: FAIL — ${explanation}`, "unreadable");
  assert.equal(r.verdict.state, "failure");
  assert.equal(r.arms, 0);
});

test("the existing stability rule still suppresses semantic noise on the same known contract", async t => {
  const r = await fixture(t, `REVIEW_VERDICT 1: FAIL — ${explanation}`, "same");
  assert.equal(r.verdict.state, "success");
  assert.equal(r.rows.some(row => row.step === "review.downgrade_suppressed"), true);
});

test("a bare semantic failure retains the existing mechanical-proof rule", async t => {
  const r = await fixture(t, "REVIEW_VERDICT 1: FAIL");
  assert.equal(r.verdict.state, "success");
  assert.ok(r.verdict.criteria[0]?.reason.includes("FAIL line named no reason"));
});

test("a semantic pass does not add a failure clause", async t => {
  const r = await fixture(t, "REVIEW_VERDICT 1: PASS");
  assert.equal(r.verdict.state, "success");
  assert.equal(r.verdict.criteria[0]?.reason.includes(explanation), false);
});


test("a changed body cannot borrow the prior body's semantic-stability protection", async t => {
  const r = await fixture(t, `REVIEW_VERDICT 1: FAIL — ${explanation}`, "old-body");
  assert.equal(r.verdict.state, "failure");
  assert.equal(r.arms, 0);
});

test("a changed task contract cannot borrow the prior contract's semantic-stability protection", async t => {
  const r = await fixture(t, `REVIEW_VERDICT 1: FAIL — ${explanation}`, "old-contract");
  assert.equal(r.verdict.state, "failure");
  assert.equal(r.arms, 0);
});

test("an unreadable prior input identity cannot certify an unchanged body", async t => {
  const r = await fixture(t, `REVIEW_VERDICT 1: FAIL — ${explanation}`, "unreadable-input");
  assert.equal(r.verdict.state, "failure");
  assert.equal(r.arms, 0);
});

test("the explanation-wiring engine cannot replay a cached pass from the unwired engine", () => {
  const head = "a".repeat(40);
  const body = "the same authored review body";
  const input = { headSha: head, body, report: body, diff: "the same diff", acceptance: [], declaredFiles: [] };
  const oldDecision = requiredSemanticDecisionDigest(reviewDecisionDigest({ ...input, engineRevision: "promised-followups-snapshot-v3" }), true);
  const currentDecision = requiredSemanticDecisionDigest(reviewDecisionDigest(input), true);
  const rows = [{ task_id: "W1-T1", step: "review.posted", context: "remudero-review", state: "success",
    head_sha: head, pr_url: "https://github.com/acme/remudero/pull/1", review_decision_digest: oldDecision,
    decision_verdict: { state: "success", criteria: [] } }];
  assert.ok(lastReviewDecisionTerminal(rows, "W1-T1", rows[0]!.pr_url, oldDecision), "positive control: the existing cache consumer sees the old pass");
  assert.equal(lastReviewDecisionTerminal(rows, "W1-T1", rows[0]!.pr_url, currentDecision), undefined);
});
