import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixRungTaskFor } from "../src/lib/sweep.js";
import { commitWorkerEdits, runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Plan } from "../src/lib/plan.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";

const remedy = "scripts/comment-load-baseline.json";

async function fixRound(t: TestContext, options: {
  changedPaths: string[]; edits: string[]; branch?: string; unreadableAt?: number; failingGate?: boolean;
}) {
  t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
    if (args.includes("rev-parse")) return "head-a";
    throw new Error("fixture: subprocess read unavailable");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4074-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan: Plan = { tasks: [], byId: new Map() };
  const { task, synthetic } = fixRungTaskFor(plan, { prNumber: 4074 }, undefined, options.branch, options.changedPaths);
  assert.equal(synthetic, true);
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const calls = { spawn: 0, commit: 0, push: 0, account: 0, ci: 0, review: 0 };
  const gitCalls: string[][] = [];
  let declaredPaths: readonly string[] = [];
  let undeclared: readonly string[] = [];
  let diffReads = 0;
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "repair the check", proof: "unit test: repair the check",
      met: false, reason: "still failing", proof_exec: "not_executable" }],
    testTheater: false, summary: "still failing", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure",
  };
  const worker: WorkerResult = {
    sessionId: "writer-session", costUsd: 1, numTurns: 1,
    text: "REPORT\nCOMMIT_MESSAGE: fix(src): repair the check", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
  const outcome = await runFixRung({
    taskId: task.id, runId: "W1-T4074-fixture", task,
    prUrl: "https://github.com/acme/remudero/pull/4074", branch: options.branch ?? "fix-synthetic",
    worktreePath: root, initialSessionId: "", mount, settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    ciFailures: options.failingGate === false ? undefined : [{ name: "comment-load-ratchet", logTail: "baseline needs updating" }],
    escalationJudge: async () => { throw new Error("must not escalate"); },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async () => { calls.spawn++; return worker; },
      push: () => { calls.push++; },
      waitForCiGreen: async () => { calls.ci++; return "green"; },
      runReview: async () => { calls.review++; return { ...review, state: "success" }; },
      fetchPrBody: async () => "REPORT",
      fetchPrDiffFiles: async () => {
        if (++diffReads === options.unreadableAt) throw new Error("PR diff unavailable");
        return options.changedPaths;
      },
      fetchCiFailures: async () => options.failingGate === false ? [] : [{ name: "comment-load-ratchet", logTail: "baseline needs updating" }],
      issues: { create: () => { throw new Error("must not file an issue"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), log: (step, extra) => rows.push({ step, ...(extra ?? {}) }),
      say: () => {}, account: (result) => { calls.account++; return result; },
      readHeadShaForProvenance: () => "head-a", commitsAhead: () => 0,
      worktreeHasUncommittedChanges: () => false,
      harnessCommitForShellLessWorker: (input) => {
        declaredPaths = input.declaredPaths;
        const committed = commitWorkerEdits(root, declaredPaths, "fix(src): repair the check", {
          runGit: (args) => {
            gitCalls.push(args);
            if (args[0] === "status") return options.edits.map((path) => ` M ${path}\0`).join("");
            if (args[0] === "rev-parse") return "head-b";
            return "";
          },
        });
        undeclared = committed.undeclared;
        if (!committed.committed) input.onRefusal?.(committed.reason!, committed.undeclared);
        calls.commit += Number(committed.committed);
        return Number(committed.committed);
      },
    },
  });
  return { task, outcome, calls, rows, declaredPaths, undeclared, gitCalls };
}

test("W1-T4074: a PR-N fix commits a change to a file the PR already touches", async (t) => {
  const result = await fixRound(t, { changedPaths: ["src/lib/repair.ts"], edits: ["src/lib/repair.ts", remedy] });
  assert.equal(result.task.id, "PR-4074");
  assert.equal(result.outcome.outcome, "fixed");
  assert.equal(result.calls.commit, 1);
  assert.equal(result.calls.push, 1);
  assert.deepEqual([...new Set(result.declaredPaths)].sort(), [remedy, "src/lib/repair.ts"]);
  assert.deepEqual(result.gitCalls.find((args) => args[0] === "add"), ["add", "-A", "--", "src/lib/repair.ts", remedy]);
});

test("W1-T4074: a file outside the PR diff and remedies stays undeclared", async (t) => {
  const result = await fixRound(t, { changedPaths: ["src/lib/repair.ts"], edits: ["src/lib/outside.ts"] });
  assert.deepEqual(result.undeclared, ["src/lib/outside.ts"]);
  assert.equal(result.calls.commit, 0);
  assert.equal(result.calls.push, 0);
  assert.equal(result.outcome.outcome, "stood_down");
  assert.equal(result.gitCalls.some((args) => args[0] === "add" || args[0] === "commit"), false);
});

test("W1-T4074: a retro PR fix declares the retro lane files", async (t) => {
  for (const branch of ["run-RETRO-1", "run-PLAN-repair-1", "run-TRIAGE-repair-1"]) {
    await t.test(branch, async (t) => {
      const result = await fixRound(t, { branch, changedPaths: ["MASTER-PLAN.md"], edits: ["MASTER-PLAN.md"], failingGate: false });
      assert.deepEqual([...new Set(result.declaredPaths)], ["MASTER-PLAN.md"]);
      assert.equal(result.outcome.outcome, "fixed");
      assert.equal(result.calls.commit, 1);
    });
  }
});

test("W1-T4074: an unreadable PR diff stands the round down", async (t) => {
  for (const unreadableAt of [1, 2]) {
    await t.test(`diff read ${unreadableAt}`, async (t) => {
      const result = await fixRound(t, { changedPaths: ["src/lib/repair.ts"], edits: ["src/lib/repair.ts"], unreadableAt });
      assert.equal(result.outcome.outcome, "stood_down");
      assert.equal(result.outcome.strikes, 0);
      assert.match(result.outcome.standDownReason ?? "", /PR diff.*unavailable/);
      assert.deepEqual(result.calls, { spawn: 0, commit: 0, push: 0, account: 0, ci: 0, review: 0 });
      assert.equal(result.rows.some((row) => row.step === "fix.dispatch"), false);
    });
  }
});
