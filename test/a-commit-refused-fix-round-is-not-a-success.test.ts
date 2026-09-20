import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung } from "../src/run-task.js";
import { fixDispatchBudget, fixRungStalledWithoutNewHead } from "../src/lib/sweep.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };

function worker(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "fix-session",
    costUsd: 1,
    numTurns: 2,
    text: "REPORT\nno anchored commit line",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function failedReview(): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  const criterion: CriterionVerdict = {
    claim: "the fix lands",
    proof: "unit test: the fix lands",
    met: false,
    reason: "still blocked",
    proof_exec: "not_executable",
  };
  return {
    state: "failure",
    criteria: [criterion],
    testTheater: false,
    summary: "blocked",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha: "head-a",
    reviewerOutcome: "failure",
  };
}

function issues(): IssueGateway {
  return {
    create: () => "https://github.com/acme/remudero/issues/1",
    listOpen: (): OpenIssue[] => [],
    comment: () => {},
  };
}

function refusedHarness(reason: string) {
  return (input: Parameters<NonNullable<Parameters<typeof runFixRung>[0]["deps"]["harnessCommitForShellLessWorker"]>>[0]) => {
    input.log("implement.harness_commit_refused", { reason });
    input.onRefusal?.(reason);
    return input.commitCount;
  };
}

function baseOpts(log: (step: string, extra?: Record<string, unknown>) => void, push: () => void) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t3868-"));
  return {
    taskId: "W1-T3868X",
    runId: "W1-T3868X-run",
    task: { id: "W1-T3868X", title: "refused fix", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/3868",
    branch: "run-W1-T3868X-1",
    worktreePath: process.cwd(),
    initialSessionId: "initial-session",
    mount: MOUNT,
    settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10,
    strikeCap: 2,
    initialReview: failedReview(),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
    deps: {
      spawn: async (_args: SpawnWorkerArgs) => worker(),
      waitForCiGreen: async () => "green" as const,
      runReview: async () => failedReview(),
      fetchPrBody: async () => "REPORT",
      push,
      issues: issues(),
      ledgerPath: join(root, "ledger.ndjson"),
      log,
      say: () => {},
      account: (result: WorkerResult) => result,
      harnessCommitForShellLessWorker: refusedHarness("no anchored COMMIT_MESSAGE line in the report"),
    },
  };
}

test("W1-T3868: a refused harness commit is recorded as non-success", async () => {
  const lines: Array<{ step: string } & Record<string, unknown>> = [];
  let pushes = 0;
  const outcome = await runFixRung({
    ...baseOpts((step, extra) => lines.push({ step, ...(extra ?? {}) }), () => pushes++),
  });

  const done = lines.find((line) => line.step === "fix.done");
  assert.equal(done?.subtype, "commit_refused");
  assert.equal(done?.worker_subtype, "success");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(pushes, 0, "a refusal must not push an unchanged head");
});

test("W1-T3868: an unchanged head is re-dispatched after commit refusal", () => {
  const lines = [
    { task_id: "W1-T3868X", step: "fix.dispatch", head_sha: "head-a" },
    { task_id: "W1-T3868X", step: "fix.commit_refused", head_sha: "head-a" },
  ];
  assert.equal(fixRungStalledWithoutNewHead(lines, "W1-T3868X"), true);
  assert.equal(true && !fixRungStalledWithoutNewHead(lines.slice(0, 1), "W1-T3868X"), true, "a committed/in-flight head remains deduplicated");
});

test("W1-T3868: a committed head remains deduplicated", async () => {
  const lines: Array<{ step: string } & Record<string, unknown>> = [];
  let pushes = 0;
  const opts = baseOpts((step, extra) => lines.push({ step, ...(extra ?? {}) }), () => pushes++);
  opts.deps.harnessCommitForShellLessWorker = (input) => {
    input.log("implement.harness_commit", { sha: "new-head" });
    return 1;
  };
  opts.deps.runReview = async () => ({ ...failedReview(), state: "success", summary: "fixed" });

  const outcome = await runFixRung(opts);
  assert.equal(outcome.outcome, "fixed");
  assert.equal(pushes, 1, "a valid harness commit keeps the existing push path");
  assert.equal(lines.some((line) => line.step === "fix.commit_refused"), false);
  assert.equal(fixRungStalledWithoutNewHead(lines.map((line) => ({ task_id: "W1-T3868X", ...line })), "W1-T3868X"), false);
});

test("W1-T3868: repeated refusals exhaust the strike cap", () => {
  assert.equal(fixDispatchBudget(0, 2), 2);
  assert.equal(fixDispatchBudget(1, 2), 1);
  assert.equal(fixDispatchBudget(2, 2), null);
});

test("W1-T3868: refusal evidence keeps its transcript and ledger reason", async () => {
  const lines: Array<{ step: string } & Record<string, unknown>> = [];
  const outcome = await runFixRung({
    ...baseOpts((step, extra) => lines.push({ step, ...(extra ?? {}) }), () => {}),
  });

  const refusal = lines.find((line) => line.step === "fix.commit_refused");
  assert.equal(refusal?.reason, "no anchored COMMIT_MESSAGE line in the report");
  assert.ok(lines.some((line) => line.step === "transcript.archived"), "the refused round still archives its transcript");
  const archive = lines.find((line) => line.step === "transcript.archived");
  assert.equal(typeof archive?.path, "string");
  assert.equal(existsSync(String(archive?.path)), true);
  assert.equal(outcome.reason, "harness commit refused");
});
