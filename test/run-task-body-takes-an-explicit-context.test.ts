import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTaskBody, type RunTaskContext } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { WorkerResult, spawnWorker } from "../src/lib/worker.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const offlineGithub: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const task: Task = {
  id: "T-RUN-BODY-CONTEXT",
  title: "run body context proof",
  repo: "remudero",
  depends_on: [],
  type: "implement",
  verify: "auto",
  risk: "high",
  status: "queued",
  attempts: 0,
  files: ["src/run-task.ts"],
  budget_usd: 1,
};

function unreachableSpawn(): typeof spawnWorker {
  return async (): Promise<WorkerResult> => {
    throw new Error("runTaskBody should stop at the injected containment rung before worker spawn");
  };
}

test("runTaskBody can drive the containment rung from an explicit minimal context", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-run-task-body-context-"));
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const said: string[] = [];
  const config: Config = { root, claudeBin: "claude" };

  try {
    const ctx: RunTaskContext = {
      config,
      fetchPrBodyFn: async () => {
        throw new Error("PR body fetch should be unreachable");
      },
      github: offlineGithub,
      isMerged: () => false,
      ledgerPath: join(root, "ledger.ndjson"),
      log: (step, extra = {}) => logs.push({ step, extra }),
      openTaskIds: new Set([task.id]),
      opts: {
        binaryPinDeps: {
          readDockerfile: () => "ARG CLAUDE_CODE_VERSION=1.2.3\n",
          runClaudeVersion: () => "1.2.3 (Claude Code)\n",
        },
        containmentExec: async () => ({
          transcript: "outside write created",
          outsideWriteCreated: true,
          insideWriteCreated: true,
          childEnvKeys: [],
        }),
      },
      owner: "owner",
      plan: { tasks: [task], byId: new Map([[task.id, task]]) },
      planPath: join(REPO_ROOT, "plan", "tasks.yaml"),
      recordDecisionFn: () => ({ landed: false, files: [] }),
      repoRoot: REPO_ROOT,
      runId: "T-RUN-BODY-CONTEXT-1",
      runReviewFn: async () => {
        throw new Error("review should be unreachable");
      },
      say: (message) => said.push(message),
      spawn: unreachableSpawn(),
      task,
      taskId: task.id,
      workerStateSensor: {
        observer: () => {},
        startPolling: () => () => {},
        setRunawayBound: () => {},
      },
    };

    const result = await runTaskBody(ctx);

    assert.deepEqual(result, {
      taskId: task.id,
      runId: "T-RUN-BODY-CONTEXT-1",
      merged: false,
      costUsd: 0,
      verdict: "blocked_containment",
    });
    assert.equal(logs.some((entry) => entry.step === "run.start"), true);
    assert.equal(logs.some((entry) => entry.step === "preflight.binary_pin"), true);
    assert.equal(
      logs.some((entry) => entry.step === "verdict" && entry.extra?.verdict === "blocked_containment"),
      true,
    );
    assert.equal(said.some((message) => message.includes("verdict: blocked_containment")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
