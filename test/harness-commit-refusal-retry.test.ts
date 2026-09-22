import assert from "node:assert/strict";
import { test } from "node:test";

import { runDaemon } from "../src/lib/daemon.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { latestIndependentFailureBlock } from "../src/lib/status.js";
import type { Plan, Task } from "../src/lib/plan.js";
import {
  harnessCommitForShellLessWorker,
  noPrVerdict,
  type RunResult,
} from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";

const TASK_ID = "W1-T3978-FIXTURE";

function task(): Task {
  return {
    id: TASK_ID,
    title: "recover a shell-less harness refusal",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "high",
    verify: "auto",
    status: "queued",
    attempts: 0,
  };
}

function plan(): Plan {
  const value = task();
  return { tasks: [value], byId: new Map([[TASK_ID, value]]) };
}

function worker(): WorkerResult {
  return {
    sessionId: "session",
    costUsd: 1,
    numTurns: 2,
    text: "REPORT\ncompleted the declared edits",
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
  };
}

function refusedResult(runId: string): RunResult {
  return {
    taskId: TASK_ID,
    runId,
    merged: false,
    costUsd: 1,
    verdict: "no_pr",
    harnessCommitRefused: true,
    harnessCommitRefusalReason: "no anchored COMMIT_MESSAGE line in the report",
  } as RunResult;
}

test("the producer-owned helper refusal becomes a distinct terminal classification", () => {
  let refusal: string | undefined;
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const count = harnessCommitForShellLessWorker(
    {
      harnessOwnsGit: true,
      commitCount: 0,
      report: "REPORT\ncompleted the declared edits",
      worktreePath: "/worktree",
      declaredPaths: ["src/run-task.ts"],
      log: (step, extra) => lines.push({ step, extra }),
      say: () => {},
      onRefusal: (reason) => { refusal = reason; },
    },
    { commit: () => ({ committed: false, undeclared: [], reason: "unused" }) },
  );

  assert.equal(count, 0);
  assert.equal(refusal, "no anchored COMMIT_MESSAGE line in the report");
  assert.equal(lines.at(-1)?.step, "implement.harness_commit_refused");

  const terminal = noPrVerdict(worker(), 1, "implement", 0, "harness_commit_refused");
  assert.equal(terminal.ledger.terminal_class, "harness_commit_refused");
});

test("ordinary no_pr remains blocked, while the exact refusal is eligible only before its marker is spent", () => {
  assert.equal(
    latestIndependentFailureBlock([
      { task_id: TASK_ID, step: "dispatch.blocked_independent", verdict: "no_pr", run_id: "ordinary" },
    ], TASK_ID),
    true,
  );

  const firstRun = "first-run";
  const refusal = [
    { task_id: TASK_ID, step: "verdict", verdict: "no_pr", terminal_class: "harness_commit_refused", run_id: firstRun },
    { task_id: TASK_ID, step: "dispatch.blocked_independent", verdict: "no_pr", terminal_class: "harness_commit_refused", run_id: firstRun },
  ];
  assert.equal(latestIndependentFailureBlock(refusal, TASK_ID), true, "the first refusal starts blocked");

  const marker = {
    task_id: TASK_ID,
    step: "dispatch.harness_commit_retry",
    original_run_id: firstRun,
    original_verdict: "no_pr",
    original_refusal: "harness_commit_refused",
    harness_commit_refused: true,
  };
  assert.equal(latestIndependentFailureBlock([...refusal, marker], TASK_ID), false, "the marker buys one re-offer");

  const secondRun = "second-run";
  assert.equal(
    latestIndependentFailureBlock(
      [...refusal, marker, { task_id: TASK_ID, step: "run.start", run_id: secondRun },
        { task_id: TASK_ID, step: "verdict", verdict: "no_pr", terminal_class: "harness_commit_refused", run_id: secondRun },
        { task_id: TASK_ID, step: "dispatch.blocked_independent", verdict: "no_pr", terminal_class: "harness_commit_refused", run_id: secondRun }],
      TASK_ID,
    ),
    true,
    "a second matching refusal cannot spend another retry",
  );
});

test("the daemon emits one durable retry marker and re-offers the refused task once", async () => {
  const lines: Array<Record<string, unknown>> = [];
  let dispatches = 0;
  const merged = new Set<string>();
  const summary = await runDaemon(
    plan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      isIndependentFailureBlocked: (id) => latestIndependentFailureBlock(lines, id),
      runOne: async (): Promise<RunResult> => {
        dispatches++;
        if (dispatches === 1) return refusedResult("first-run");
        merged.add(TASK_ID);
        return { taskId: TASK_ID, runId: "second-run", merged: true, costUsd: 1, verdict: "merged" };
      },
      log: (step, extra = {}) => lines.push({ step, ...extra }),
      sleep: async () => {},
    },
    { max: 2 },
  );

  assert.equal(dispatches, 2);
  assert.equal(summary.stopReason, "max_reached");
  assert.equal(lines.filter((line) => line.step === "dispatch.harness_commit_retry").length, 1);
  assert.equal(lines.filter((line) => line.step === "dispatch.blocked_independent").length, 1);
  assert.equal(lines.find((line) => line.step === "dispatch.harness_commit_retry")?.original_run_id, "first-run");
});

test("the refusal and retry marker are retained decision evidence", () => {
  assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has("implement.harness_commit_refused"), true);
  assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has("dispatch.harness_commit_retry"), true);
});
