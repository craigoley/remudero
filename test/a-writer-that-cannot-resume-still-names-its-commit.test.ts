import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  COMMIT_LINE_RESUME_PROMPT,
  commitLineResume,
  harnessCommitForShellLessWorker,
  missingCommitLinePrompt,
  resumeForMissingCommitLine,
  runFixRung,
} from "../src/run-task.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import { gitRepo } from "./helpers/git-repo.js";

const missingLine = "no anchored COMMIT_MESSAGE line in the report";

function fixture(kind: string) {
  const repo = gitRepo({ kind });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src/a.ts"), "export const a = 1;\n");
  repo.git("add", "src/a.ts");
  repo.git("commit", "-m", "seed source");
  writeFileSync(join(repo.dir, "src/a.ts"), "export const a = 2;\n");
  writeFileSync(join(repo.dir, "src/new.ts"), "export const n = 1;\n");
  return repo;
}

test("W1-T4467: a writer that cannot resume is asked with the diff and its own report", async () => {
  const repo = fixture("w1-t4467-prompt");
  try {
    writeFileSync(join(repo.dir, ".worker-overlay"), "not part of the task\n");
    const report = "REPORT\nI changed the exported value and added a new file.";
    const context = { provider: "codex" as const, title: "repair the exported value", report, declaredPaths: ["src"] };
    const prompts: string[] = [];
    const reply = {
      provider: "codex", sessionId: "new-session", costUsd: 0, numTurns: 1,
      text: "COMMIT_MESSAGE: fix(src): repair the exported value", blocks: [], stderr: "",
      subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
      model: "codex", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    } as WorkerResult;
    const resume = commitLineResume(async (args) => { prompts.push(args.prompt); return reply; }, (r) => r, {
      cwd: repo.dir, permissionMode: "bypassPermissions", settingsFile: "settings.json",
      resumeSessionId: "old-session", tools: ["Read", "Write"],
    }, context);
    await resume();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /Task: repair the exported value/);
    assert.match(prompts[0]!, /git diff --stat \(HEAD\):[\s\S]*src\/a\.ts/);
    assert.match(prompts[0]!, /Untracked files:[\s\S]*src\/new\.ts/);
    assert.doesNotMatch(prompts[0]!, /worker-overlay/);
    assert.match(prompts[0]!, /Tail of your previous report:[\s\S]*I changed the exported value/);
    assert.match(prompts[0]!, /Reply with ONLY a REPORT/);
    assert.equal(missingCommitLinePrompt({ ...context, worktreePath: repo.dir, tools: ["Read"] }), COMMIT_LINE_RESUME_PROMPT);
    assert.equal(missingCommitLinePrompt({ ...context, provider: "claude", worktreePath: repo.dir, tools: ["Read", "Write"] }), COMMIT_LINE_RESUME_PROMPT);
  } finally {
    repo.cleanup();
  }
});

test("W1-T4467: a still-missing line commits under a subject derived from the task record", async () => {
  const repo = fixture("w1-t4467-derived");
  try {
    const before = repo.git("rev-parse", "HEAD");
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const recovery = await resumeForMissingCommitLine({
      commitCount: 0, refusalReason: missingLine, report: "REPORT\nThe source edit is saved.",
      task: { id: "W1-T4467", type: "implement", title: "REPAIR THE EXPORTED VALUE — follow-up detail" },
      worktreePath: repo.dir, declaredPaths: ["src/a.ts", "src/new.ts"],
      log: (step, extra) => rows.push({ step, extra }), say: () => {},
      resume: async () => ({ text: "REPORT\nStill no anchored commit line." }),
    }, { ahead: () => 1 });
    assert.equal(recovery.commitCount, 1);
    assert.equal(recovery.refusalReason, undefined);
    assert.notEqual(repo.git("rev-parse", "HEAD"), before);
    assert.equal(repo.git("log", "-1", "--format=%s"), "feat(src): repair the exported value");
    assert.match(repo.git("log", "-1", "--format=%b"), /Harness-derived subject: no COMMIT_MESSAGE after one re-ask; W1-T4467 title and src\/a\.ts/);
    assert.equal(rows.find((row) => row.step === "implement.harness_commit")?.extra?.subject_source, "harness-derived");
    assert.deepEqual(repo.git("show", "--name-only", "--format=", "HEAD").split("\n"), ["src/a.ts", "src/new.ts"]);

    const sources: unknown[] = [];
    harnessCommitForShellLessWorker({
      harnessOwnsGit: true, commitCount: 0, report: "REPORT\nCOMMIT_MESSAGE: feat(src): worker authored",
      worktreePath: repo.dir, declaredPaths: ["src/a.ts"], log: (_step, extra) => sources.push(extra?.subject_source), say: () => {},
    }, { commit: () => ({ committed: true, sha: "a", undeclared: [] }), ahead: () => 1 });
    assert.deepEqual(sources, ["worker-authored"]);
  } finally {
    repo.cleanup();
  }
});

test("W1-T4467: a fix round derives its subject from the first failing check and PR", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4467-fix-"));
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
    text: "REPORT\nI repaired the check but omitted the commit line.", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "codex", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  });
  await runFixRung({
    taskId: "W1-T4467", runId: "W1-T4467-fix", task: { id: "W1-T4467", title: "repair the check", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/4467", branch: "run-W1-T4467-1",
    worktreePath: process.cwd(), initialSessionId: "writer-session", mount,
    settingsFile: join(root, "settings.json"), config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review,
    ciFailures: [{ name: "ci-gate", logTail: "the check failed" }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async (args) => { prompts.push(args); return worker(); },
      waitForCiGreen: async () => "green", runReview: async () => review,
      fetchPrBody: async () => "REPORT", push: () => {},
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} } as IssueGateway,
      ledgerPath: join(root, "ledger.ndjson"), log: (step, extra) => rows.push({ step, ...(extra ?? {}) }),
      say: () => {}, account: (result) => result, commitsAhead: () => 0,
      worktreeHasUncommittedChanges: () => true,
      harnessCommitForShellLessWorker: (input) => harnessCommitForShellLessWorker(input, {
        commit: (_cwd, _paths, message) => { messages.push(message); return { committed: true, sha: "new-head", undeclared: [] }; },
        ahead: () => 1,
      }),
    },
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!.prompt, /Task: repair the check/);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^fix: repair ci-gate on #4467\n\nHarness-derived subject:/);
  assert.equal(rows.find((row) => row.step === "implement.harness_commit")?.subject_source, "harness-derived");
});

test("W1-T4467: the ledger distinguishes a re-asked worker subject", async () => {
  const repo = fixture("w1-t4467-reasked");
  try {
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const recovery = await resumeForMissingCommitLine({
      commitCount: 0, refusalReason: missingLine, report: "REPORT\nSaved the edit.",
      worktreePath: repo.dir, declaredPaths: ["src"],
      log: (step, extra) => rows.push({ step, extra }), say: () => {},
      resume: async () => ({ text: "REPORT\nCOMMIT_MESSAGE: fix(src): repair the edit" }),
    }, { ahead: () => 1 });
    assert.equal(recovery.commitCount, 1);
    assert.equal(rows.find((row) => row.step === "implement.harness_commit")?.extra?.subject_source, "re-asked");
  } finally {
    repo.cleanup();
  }
});
