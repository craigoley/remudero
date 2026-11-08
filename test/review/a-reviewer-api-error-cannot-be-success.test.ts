import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runReview } from "#test/helpers/run-task-test.js";
import { classifyReviewerHealthRow } from "#src/lib/reviewer-health.js";
import { reviewDecisionDigest } from "#src/lib/review.js";
import { requiredSemanticDecisionDigest } from "#src/lib/required-semantic-review.js";
import { shadowJudgeSampled } from "#src/lib/shadow-judge.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";

type Envelope = Pick<WorkerResult, "subtype" | "isError" | "apiError"> & Partial<Pick<WorkerResult, "exit" | "text">>;
async function evaluate(t: TestContext, envelope: Envelope) {
  const repo = gitRepo({ scope: t, kind: "reviewer-terminal-error" });
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
    const candidate = `terminal-error control (${n})`;
    const digest = reviewDecisionDigest({ headSha, diff, report: candidate, body: candidate, acceptance, declaredFiles: task.files });
    if (!shadowJudgeSampled(`review:${prUrl}:${headSha}:${requiredSemanticDecisionDigest(digest, true)}`)) { report = candidate; break; }
  }
  assert.ok(report, "exclude the independent shadow call with its actual sampled key");
  const shim = ghShim([{ when: "pulls/1", stdout: JSON.stringify({ number: 1, state: "open", body: report,
    head: { ref: "fixture", sha: headSha }, html_url: prUrl }) }, { when: "pr diff", stdout: diff },
    { when: "/statuses?", stdout: "[[]]" }, { when: "api", stdout: "{}" }]);
  const rows: { step: string; fields: Record<string, unknown> }[] = [];
  const previousPath = process.env.PATH;
  let spawns = 0, arms = 0;
  try {
    process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
    const verdict = await runReview({ owner: "acme", repo: "remudero", prUrl, task, report,
      settingsFile: join(repo.dir, "settings.json"), config: { root: repo.dir, claudeBin: "/unused" } as never,
      requireSemanticReview: true, headCheckoutDir: repo.dir, ledgerPath: join(repo.dir, ".git", "ledger.ndjson"),
      runId: "reviewer-terminal-error", log: (step, fields = {}) => rows.push({ step, fields }),
      say: () => {}, account: result => result,
      reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120000 }, budgetUsd: 0.5,
      reviewerSpawnWorker: async () => {
        spawns++;
        return { sessionId: "contained-terminal-error", text: envelope.text ?? "", blocks: [],
          stderr: envelope.apiError ? "OAuth session expired and could not be refreshed" : "",
          exit: { kind: "exit", code: 0 }, costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [],
          model: "sonnet", effort: "high", provider: "claude", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false, ...envelope } as WorkerResult;
      },
      readReviewReuseFacts: () => undefined, disarm: () => "not-armed",
      arm: () => { arms++; return "ledger-refused"; },
    });
    return { verdict, rows, spawns, arms };
  } finally {
    process.env.PATH = previousPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

for (const text of ["", "REVIEW_VERDICT 1: PASS"]) {
  test(`W1-T11727 criterion 1: a reviewer API error cannot become a successful semantic review (${text ? "complete-looking verdict" : "recorded empty result"})`, async t => {
    const result = await evaluate(t, { subtype: "success", isError: true, apiError: true, text });
    assert.equal(result.spawns, 1);
    assert.equal(result.verdict.reviewerOutcome, "api_error");
    assert.equal(result.verdict.verdictWithheld, "required-semantic-api_error");
    assert.equal(result.arms, 0);
    assert.equal(result.rows.some(r => r.step === "review.posted"), false);
    const row = result.rows.find(r => r.step === "review.semantic_incomplete");
    assert.ok(row, "the actual consumer emitted its withheld result");
    const health = classifyReviewerHealthRow({ ...row.fields, step: row.step,
      host: "contained-fixture", ts: new Date().toISOString() });
    assert.ok(health?.kind === "outcome");
    assert.equal(health.cls, "withheld-failure", "provider failure must not join the code-regression population");
    assert.equal(health.reason, "required-semantic-api_error");
  });
}

test("W1-T11727 criterion 2: the API-error flag alone cannot inherit a success subtype", async t => {
  const result = await evaluate(t, { subtype: "success", isError: false, apiError: true, text: "REVIEW_VERDICT 1: PASS" });
  assert.equal(result.verdict.reviewerOutcome, "api_error");
  assert.equal(result.verdict.verdictWithheld, "required-semantic-api_error");
  assert.equal(result.arms, 0);
});

test("W1-T11727 criterion 2: an isError-only terminal cannot inherit a success subtype", async t => {
  const result = await evaluate(t, { subtype: "success", isError: true, apiError: false, text: "REVIEW_VERDICT 1: PASS" });
  assert.equal(result.verdict.reviewerOutcome, "worker_error");
  assert.equal(result.verdict.verdictWithheld, "required-semantic-worker_error");
  assert.equal(result.arms, 0);
});

test("W1-T11727 criterion 2: a genuine successful evaluation retains its successful outcome", async t => {
  const result = await evaluate(t, { subtype: "success", isError: false, apiError: false, text: "REVIEW_VERDICT 1: PASS" });
  assert.equal(result.verdict.reviewerOutcome, "success");
  assert.equal(result.verdict.verdictWithheld, undefined);
  assert.equal(result.verdict.state, "success");
  assert.equal(result.spawns, 1);
});

test("W1-T11727 criterion 2: a specific failure subtype retains its existing reason", async t => {
  const result = await evaluate(t, { subtype: "error_max_turns", isError: true, apiError: true });
  assert.equal(result.verdict.reviewerOutcome, "error_max_turns");
  assert.equal(result.verdict.verdictWithheld, "required-semantic-error_max_turns");
});

test("W1-T11727 criterion 2: repeated signal termination keeps its rerun and outcome precedence", async t => {
  const result = await evaluate(t, { subtype: "success", isError: true, apiError: true,
    exit: { kind: "signal", signal: "SIGTERM" } });
  assert.equal(result.spawns, 2);
  assert.equal(result.verdict.reviewerOutcome, "signal_terminated");
  assert.equal(result.verdict.verdictWithheld, "required-semantic-signal_terminated");
  assert.equal(result.arms, 0);
});

test("W1-T11727 criterion 2: a genuine UNABLE evaluation keeps cannot-evaluate semantics", async t => {
  const result = await evaluate(t, { subtype: "success", isError: false, apiError: false,
    text: "REVIEW_VERDICT 1: UNABLE could not inspect the fixture" });
  assert.equal(result.verdict.reviewerOutcome, "success");
  assert.equal(result.verdict.verdictWithheld, undefined);
  assert.equal(result.verdict.cannotEvaluate, true);
  assert.equal(result.verdict.state, "pending");
  assert.equal(result.arms, 0);
});
