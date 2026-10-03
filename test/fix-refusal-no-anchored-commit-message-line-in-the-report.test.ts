import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { harnessCommitForShellLessWorker, runFixRung } from "../src/run-task.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { ReviewVerdict } from "../src/lib/review.js";

async function fixRound(t: TestContext, options: {
  report?: string; edits?: boolean; ahead?: number; refusal?: string; ci?: boolean;
} = {}) {
  t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
    if (args.includes("rev-parse")) return "head-a";
    if (args.includes("diff") || args.includes("ls-files")) return "";
    throw new Error("test: subprocess reads unavailable");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t5325-fix-"));
  const prompts: SpawnWorkerArgs[] = [];
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const messages: string[] = [];
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "repair the check", proof: "unit test: repair the check", met: false,
      reason: "still failing", proof_exec: "not_executable" }],
    testTheater: false, summary: "still failing", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure",
  };
  const worker = (): WorkerResult => ({
    provider: "codex", sessionId: "writer-session", costUsd: 0, numTurns: 1,
    text: options.report ?? "REPORT\nI repaired the check but omitted the commit line.", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "codex", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  });
  const outcome = await runFixRung({
    taskId: "W1-T5325", runId: "W1-T5325-fix", task: { id: "W1-T5325", title: "repair the check", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/5325", branch: "run-W1-T5325-1",
    worktreePath: process.cwd(), initialSessionId: "writer-session", mount,
    settingsFile: join(root, "settings.json"), config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review,
    ciFailures: options.ci === false ? undefined : [{ name: "ci-gate", logTail: "the check failed" }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async (args) => { prompts.push(args); return worker(); },
      waitForCiGreen: async () => "green", runReview: async () => ({ ...review, state: "success", summary: "fixed" }),
      fetchPrBody: async () => "REPORT", push: () => {},
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} } as IssueGateway,
      ledgerPath: join(root, "ledger.ndjson"), log: (step, extra) => rows.push({ step, ...(extra ?? {}) }),
      readHeadShaForProvenance: () => "head-a",
      say: () => {}, account: (result) => result, commitsAhead: () => options.ahead ?? 0,
      worktreeHasUncommittedChanges: () => options.edits ?? true,
      harnessCommitForShellLessWorker: (input) => harnessCommitForShellLessWorker(input, {
        commit: (_cwd, paths, message) => {
          assert.deepEqual(paths.slice(0, 1), ["src/run-task.ts"]);
          messages.push(message);
          return options.refusal
            ? { committed: false, reason: options.refusal, undeclared: ["outside.ts"] }
            : { committed: true, sha: "new-head", undeclared: [] };
        },
        ahead: () => 1,
      }),
    },
  });
  return { outcome, rows, prompts, messages };
}

test("W1-T5325: fix_refusal:no-anchored-commit-message-line-in-the-report is prevented, not retried", async (t) => {
  const { outcome, rows, prompts, messages } = await fixRound(t);
  assert.equal(outcome.outcome, "fixed");
  assert.equal(rows.some((row) => row.step === "fix.commit_line_requested"), false);
  assert.equal(rows.some((row) => row.step === "implement.harness_commit_refused"), false);
  assert.equal(prompts.length, 1, "the failing check supplies a subject without another dispatch");
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^fix: repair ci-gate on #5325\n\nHarness-derived subject:/);
  assert.equal(rows.find((row) => row.step === "implement.harness_commit")?.subject_source, "harness-derived");
});


test("a worker-authored fix subject takes precedence", async (t) => {
  const { messages, rows, prompts } = await fixRound(t, { report: "REPORT\nCOMMIT_MESSAGE: fix(src): preserve this subject" });
  assert.equal(messages[0], "fix(src): preserve this subject");
  assert.equal(prompts.length, 1);
  assert.equal(rows.find((row) => row.step === "implement.harness_commit")?.subject_source, "worker-authored");
});

test("a derived fix subject preserves scope refusals without re-asking", async (t) => {
  const { outcome, rows, prompts } = await fixRound(t, { refusal: "changed paths outside declared surface" });
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(prompts.length, 1);
  assert.equal(rows.find((row) => row.step === "fix.commit_refused")?.reason, "changed paths outside declared surface");
});

test("an existing fix commit is left intact", async (t) => {
  const { messages, prompts, outcome } = await fixRound(t, { ahead: 1 });
  assert.equal(messages.length, 0);
  assert.equal(prompts.length, 1);
  assert.equal(outcome.outcome, "fixed");
});

test("a fix with no edits does not dispatch a commit-line request", async (t) => {
  const { outcome, prompts, messages } = await fixRound(t, { edits: false });
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(prompts.length, 1);
  assert.equal(messages.length, 0);
});

test("a review fix derives its subject from the unmet claim", async (t) => {
  const { messages, prompts, outcome } = await fixRound(t, { ci: false });
  assert.equal(outcome.outcome, "fixed");
  assert.equal(prompts.length, 1);
  assert.match(messages[0]!, /^fix: repair repair the check on #5325/);
});
