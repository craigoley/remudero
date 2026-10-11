import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { harnessCommitForShellLessWorker, runFixRung } from "./helpers/run-task-test.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };

function worker(text: string): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false,
  };
}

function failedReview(): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  const criterion: CriterionVerdict = { claim: "the fix lands", proof: "unit test: the fix lands", met: false, reason: "blocked", proof_exec: "not_executable" };
  return { state: "failure", criteria: [criterion], testTheater: false, summary: "blocked", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure" };
}

function rung(answer: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t7748-"));
  const lines: Array<{ step: string } & Record<string, unknown>> = [];
  const spawns: SpawnWorkerArgs[] = [];
  let commits = 0;
  const issues: IssueGateway = { create: () => "https://github.com/acme/remudero/issues/1", listOpen: (): OpenIssue[] => [], comment: () => {} };
  const run = {
    taskId: "W1-T7748X", runId: "W1-T7748X-run",
    task: { id: "W1-T7748X", title: "the fix lands", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/7748", branch: "run-W1-T7748X-1",
    worktreePath: process.cwd(), initialSessionId: "initial-session", mount: MOUNT,
    settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: failedReview(),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
    deps: {
      spawn: async (args: SpawnWorkerArgs) => {
        spawns.push(args);
        return worker(spawns.length === 1 ? "REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(ci): repair it" : answer);
      },
      waitForCiGreen: async () => "green" as const,
      runReview: async () => failedReview(),
      fetchPrBody: async () => "REPORT",
      push: () => {},
      issues,
      ledgerPath: join(root, "ledger.ndjson"),
      log: (step: string, extra?: Record<string, unknown>) => lines.push({ step, ...(extra ?? {}) }),
      say: () => {},
      account: (result: WorkerResult) => result,
      worktreeHasUncommittedChanges: () => false,
      harnessCommitForShellLessWorker: (input: Parameters<typeof harnessCommitForShellLessWorker>[0]) =>
        harnessCommitForShellLessWorker(input, {
          commit: () => (++commits === 1
            ? { committed: false, undeclared: [], reason: "the worker changed nothing" }
            : { committed: true, sha: "new-head", undeclared: [] }),
          ahead: () => 1,
        }),
    },
  };
  return { run, lines, spawns };
}

test("W1-T7748: fix-lane-commit-refused-the-worker-changed-nothing clears without a person", async () => {
  const resumed = rung("FIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(ci): repair it");
  await runFixRung(resumed.run);
  assert.equal(resumed.spawns.length, 2, "one fix round, then ONE resume");
  assert.equal(resumed.spawns[1]!.resumeSessionId, "fix-session");
  assert.match(resumed.spawns[1]!.prompt, /NO change against the branch head/);
  assert.ok(resumed.lines.some((l) => l.step === "fix.changed_nothing_requested"));
  assert.equal(resumed.lines.some((l) => l.step === "fix.commit_refused"), false, "the resumed edit lands the round");
});
