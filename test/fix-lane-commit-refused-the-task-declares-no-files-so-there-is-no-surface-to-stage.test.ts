import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { commitWorkerEdits, runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";

async function repair(t: TestContext, changed: string[], conflicts: string[] = ["src/conflict.ts"]) {
  t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
    if (args.includes("rev-parse")) return "head-a";
    throw new Error("fixture: unexpected subprocess");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t7699-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const gitCalls: string[][] = [];
  let pushes = 0;
  let spawns = 0;
  let surface: readonly string[] = [];
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "resolve the conflict", proof: "unit test: resolve the conflict",
      met: false, reason: "merge conflict", proof_exec: "not_executable" }],
    testTheater: false, summary: "merge conflict", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure",
  };
  const worker: WorkerResult = {
    sessionId: "writer", costUsd: 1, numTurns: 1,
    text: "REPORT\nCOMMIT_MESSAGE: fix(src): resolve the conflict", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
  const outcome = await runFixRung({
    taskId: "W1-T7699", runId: "W1-T7699-fixture",
    task: { id: "W1-T7699", title: "resolve the conflict", files: [] },
    prUrl: "https://github.com/acme/remudero/pull/7699", branch: "run-W1-T7699-1",
    worktreePath: root, initialSessionId: "", mount, settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review,
    mergeConflict: { files: conflicts.map((path) => ({ path, oursDeleted: 0, theirsDeleted: 0 })), oursLog: "", theirsLog: "" },
    escalationJudge: async () => { throw new Error("must not request an operator"); },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async () => { spawns++; return worker; },
      push: () => { pushes++; },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success" }),
      fetchPrBody: async () => "REPORT\nRemudero-Task: W1-T7699",
      fetchPrDiffFiles: async () => [],
      startShellLessMergeConflictMerge: () => ({ started: true }),
      issues: { create: () => { throw new Error("must not file an issue"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), log: (step, extra) => rows.push({ step, ...(extra ?? {}) }),
      say: () => {}, account: (result) => result,
      readHeadShaForProvenance: () => "head-a", commitsAhead: () => 0,
      worktreeHasUncommittedChanges: () => false,
      harnessCommitForShellLessWorker: (input) => {
        surface = input.declaredPaths;
        const result = commitWorkerEdits(root, surface, "fix(src): resolve the conflict", {
          runGit: (args) => {
            gitCalls.push(args);
            if (args[0] === "status") return changed.map((path) => ` M ${path}\0`).join("");
            if (args[0] === "rev-parse") return "head-b";
            return "";
          },
        });
        if (!result.committed) input.onRefusal?.(result.reason!, result.undeclared);
        return Number(result.committed);
      },
    },
  });
  return { outcome, rows, gitCalls, pushes, spawns, surface };
}

test("W1-T7699: fix-lane-commit-refused-the-task-declares-no-files-so-there-is-no-surface-to-stage clears without a person", async (t) => {
  const result = await repair(t, ["src/conflict.ts", "src/unrelated.ts"]);
  assert.equal(result.outcome.outcome, "fixed");
  assert.equal(result.spawns, 1);
  assert.equal(result.pushes, 1);
  assert.deepEqual(result.surface, ["src/conflict.ts"]);
  assert.deepEqual(result.gitCalls.find((args) => args[0] === "add"), ["add", "-A", "--", "src/conflict.ts"]);
  assert.equal(result.rows.some((row) => row.step === "fix.commit_refused"), false);
});

test("a conflict round with no named paths still stops before dispatch", async (t) => {
  const result = await repair(t, ["src/unrelated.ts"], []);
  assert.equal(result.outcome.outcome, "stood_down");
  assert.equal(result.spawns, 0);
  assert.equal(result.pushes, 0);
  assert.deepEqual(result.gitCalls, []);
});
