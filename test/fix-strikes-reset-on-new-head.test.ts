import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveStrikeHistory, priorStrikesFor, runFixRung } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";

const TASK = "W1-T2788-FIXTURE";
const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function review(state: "success" | "failure", headSha: string): ReviewVerdict & {
  headSha: string;
  reviewerOutcome: string;
} {
  return {
    state,
    criteria: state === "success"
      ? [{ claim: "the fix works", met: true, proof: "unit test", reason: "passed", proof_exec: "executed_pass" }]
      : [{ claim: "the fix works", met: false, proof: "unit test", reason: "failed", proof_exec: "executed_fail" }],
    testTheater: false,
    summary: state,
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

function workerResult(): WorkerResult {
  return {
    sessionId: "fix-session",
    costUsd: 0,
    numTurns: 1,
    text: "implemented the fix",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "test-model",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

test("W1-T2788: both worker dispatch and its review retain the pre-push input head", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const outcome = await runFixRung({
    taskId: TASK,
    runId: `${TASK}-1`,
    task: { id: TASK, title: "Reset strikes by PR head" },
    prUrl: "https://github.com/acme/remudero/pull/2788",
    branch: `run-${TASK}-1`,
    worktreePath: process.cwd(),
    initialSessionId: "author-session",
    mount: { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 20_000 },
    settingsFile: "/tmp/rmd-fix-strikes-settings.json",
    config: {} as Config,
    budgetUsd: 1,
    strikeCap: 1,
    initialReview: review("failure", HEAD_A),
    reviewBase: {
      owner: "acme",
      repo: "remudero",
      headCheckoutDir: process.cwd(),
      reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 20_000 },
    },
    deps: {
      spawn: async () => workerResult(),
      waitForCiGreen: async () => "green",
      runReview: async () => review("success", HEAD_B),
      push: () => {},
      issues: { create: () => "https://github.com/acme/remudero/issues/2788" },
      ledgerPath: "/tmp/rmd-fix-strikes-reset-on-new-head-ledger.ndjson",
      log: (step, extra) => lines.push({ task_id: TASK, step, ...(extra ?? {}) }),
      say: () => {},
      account: (result) => result,
    },
  });

  assert.equal(outcome.outcome, "fixed");
  assert.equal(lines.find((line) => line.step === "fix.dispatch")?.head_sha, HEAD_A);
  assert.equal(lines.find((line) => line.step === "fix.review")?.head_sha, HEAD_A);
});

test("W1-T2788: tagged fix attempts count only against the exact head they targeted", () => {
  const lines = [
    { task_id: TASK, step: "fix.dispatch", strike: 1, verdict_regime: "executed", head_sha: HEAD_A },
    { task_id: TASK, step: "fix.dispatch", strike: 2, verdict_regime: "executed", head_sha: HEAD_A },
  ];

  assert.equal(priorStrikesFor(lines, TASK, "executed", HEAD_A), 2, "the unchanged head remains exhausted");
  assert.equal(priorStrikesFor(lines, TASK, "executed", HEAD_B), 0, "a changed head re-earns its bounded allowance");
});

test("W1-T2788: legacy rows reset only behind a trustworthy current-head observation", () => {
  const withoutBoundary = [
    { task_id: TASK, step: "fix.dispatch", strike: 1, verdict_regime: "executed" },
    { task_id: TASK, step: "fix.dispatch", strike: 2, verdict_regime: "executed" },
  ];
  assert.equal(
    priorStrikesFor(withoutBoundary, TASK, "executed", HEAD_B),
    2,
    "without a current-head boundary, legacy history fails closed",
  );

  const withBoundary = [
    ...withoutBoundary,
    { task_id: TASK, step: "sweep.disposed", head_sha: HEAD_B, disposition: "blocked-fixable" },
    { task_id: TASK, step: "fix.dispatch", strike: 1, verdict_regime: "executed" },
  ];
  assert.equal(
    priorStrikesFor(withBoundary, TASK, "executed", HEAD_B),
    1,
    "only legacy attempts after the latest observation of the current head count",
  );
});

test("W1-T2788: strike history follows the same current-head generation as the cap", () => {
  const lines = [
    { task_id: TASK, step: "fix.dispatch", strike: 1, round: "resume", unmet_count: 3, head_sha: HEAD_A },
    { task_id: TASK, step: "fix.review", strike: 1, state: "failure" },
    { task_id: TASK, step: "fix.dispatch", strike: 1, round: "resume", unmet_count: 1, head_sha: HEAD_B },
    { task_id: TASK, step: "fix.review", strike: 1, state: "success" },
  ];

  assert.deepEqual(deriveStrikeHistory(lines, TASK, HEAD_B), [
    { strike: 1, round: "resume", unmetCount: 1, ciGreen: true, reviewState: "success" },
  ]);
  assert.equal(
    priorStrikesFor(lines, TASK, "keyword_only", HEAD_B),
    1,
    "the view count and clarification history select the same generation",
  );
});

test("W1-T2788: a legacy current-head boundary also scopes clarification history", () => {
  const lines = [
    { task_id: TASK, step: "fix.dispatch", strike: 9, round: "fresh", unmet_count: 4 },
    { task_id: TASK, step: "fix.review", strike: 9, state: "failure" },
    { task_id: TASK, step: "sweep.disposed", head_sha: HEAD_B, disposition: "blocked-fixable" },
    { task_id: TASK, step: "fix.dispatch", strike: 1, round: "resume", unmet_count: 2 },
    { task_id: TASK, step: "fix.review", strike: 1, state: "success" },
  ];

  assert.deepEqual(deriveStrikeHistory(lines, TASK, HEAD_B), [
    { strike: 1, round: "resume", unmetCount: 2, ciGreen: true, reviewState: "success" },
  ]);
});
