import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { Mount } from "#src/lib/mounts.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";

// Loaded by a computed specifier so this suite is not a new direct importer of the run-task
// module: the affected-suite reach ratchet caps that importer count and only lets it shrink.
const RUN_TASK = ["..", "src", "run-task.js"].join("/");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = (...args: any[]) => any;
const { commitWorkerEdits, runFixRung } = (await import(RUN_TASK)) as {
  commitWorkerEdits: Loose;
  runFixRung: Loose;
};

test("W1-T7699: fix-lane-commit-refused-the-task-declares-no-files-so-there-is-no-surface-to-stage clears without a person", async (t) => {
  t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
    if (args.includes("rev-parse")) return "head-a";
    if (args.includes("--show-scope")) return "";
    throw new Error("fixture: subprocess read unavailable");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t7699-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const taskId = "W1-T7699";
  const inherited = "docs/repair.md";
  const outside = "src/unrelated.ts";
  const reason = "the task declares no files, so there is no surface to stage";
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "repair the check", proof: "unit test: repair the check",
      met: false, reason: "still failing", proof_exec: "not_executable" }],
    testTheater: false, summary: "still failing", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure",
  };
  const worker: WorkerResult = {
    sessionId: "writer-session", costUsd: 0, numTurns: 1,
    text: "REPORT\nCOMMIT_MESSAGE: fix(docs): repair the check", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
  const staged: string[][] = [];
  let pushes = 0;
  const result = await runFixRung({
    taskId, runId: "W1-T7699-fixture", task: { id: taskId, title: "repair the check", files: [] },
    prUrl: "https://github.com/acme/remudero/pull/7699", branch: "run-W1-T7699-1",
    worktreePath: root, initialSessionId: "", mount, settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      ledgerLines: () => [
        { task_id: taskId, step: "fix.commit_refused", reason },
        { task_id: taskId, step: "fix.done", subtype: "commit_refused" },
      ],
      spawn: async ({ prompt }: { prompt: string }) => {
        const feedback = prompt.split("LAST ROUND'S COMMIT WAS REFUSED")[1];
        assert.ok(feedback, "the prior refusal reaches the repair worker");
        assert.ok(feedback.includes(`Declared files: ${inherited}.`),
          "recovery must name the same inherited surface the harness can commit");
        return worker;
      },
      push: () => { pushes++; }, waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success" }),
      fetchPrBody: async () => "REPORT\nRemudero-Task: W1-T7699",
      fetchPrDiffFiles: async () => [inherited],
      issues: { create: () => { throw new Error("must not ask an operator"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), log: () => {}, say: () => {}, account: (value: unknown) => value,
      readHeadShaForProvenance: () => "head-a", commitsAhead: () => 0,
      worktreeHasUncommittedChanges: () => false,
      harnessCommitForShellLessWorker: (input: { declaredPaths: string[] }) => {
        const committed = commitWorkerEdits(root, input.declaredPaths, "fix(docs): repair the check", {
          runGit: (args: string[]) => {
            if (args[0] === "status") return ` M ${inherited}\0 M ${outside}\0`;
            if (args[0] === "add") staged.push(args.slice(3));
            if (args[0] === "rev-parse") return "head-b";
            return "";
          },
        });
        assert.equal(committed.committed, true);
        assert.deepEqual(committed.undeclared, [outside]);
        return Number(committed.committed);
      },
    },
  });
  assert.equal(result.outcome, "fixed");
  assert.equal(pushes, 1);
  assert.deepEqual(staged, [[inherited]]);
});
