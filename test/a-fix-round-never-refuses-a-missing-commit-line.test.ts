/**
 * test/a-fix-round-never-refuses-a-missing-commit-line.test.ts — W1-T8524.
 *
 * A fix round that left edits but wrote no COMMIT_MESSAGE line commits them under a subject the
 * harness derives: from the failing check, else the unmet claim, else the gate reason, else the
 * task title. A legacy writer is still re-asked once; a re-ask whose answer still lacks the line,
 * or that never returns, commits under the derived subject. Outcomes that commit nothing still
 * commit nothing.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { harnessCommitForShellLessWorker, runFixRung } from "#test/helpers/run-task-test.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import type { Mount } from "#src/lib/mounts.js";
import type { ReviewVerdict } from "#src/lib/review.js";

const TITLE = "keep the board current";

async function fixRound(t: TestContext, options: {
  report?: string; answer?: string; legacy?: boolean; ci?: boolean; unmet?: boolean; askHangs?: boolean;
} = {}) {
  t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
    if (args.includes("rev-parse")) return "head-a";
    if (args.includes("--show-scope")) return "";
    throw new Error("test: subprocess reads unavailable");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t8524-fix-"));
  const prompts: SpawnWorkerArgs[] = [];
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const messages: string[] = [];
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure",
    criteria: options.unmet === false ? [] : [{ claim: "repair the check", proof: "unit test: repair the check", met: false,
      reason: "still failing", proof_exec: "not_executable" }],
    testTheater: false, summary: "still failing", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure",
  };
  const worker = (text: string): WorkerResult => ({
    provider: options.legacy ? undefined : "codex", sessionId: "writer-session", costUsd: 0, numTurns: 1,
    text, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "codex", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  });
  const outcome = await runFixRung({
    taskId: "W1-T8524", runId: "W1-T8524-fix", task: { id: "W1-T8524", title: TITLE, files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/8524", branch: "run-W1-T8524-1",
    worktreePath: process.cwd(), initialSessionId: "writer-session", mount,
    settingsFile: join(root, "settings.json"), config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review,
    ciFailures: options.ci === false ? undefined : [{ name: "ci-gate", logTail: "the check failed" }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async (args) => {
        prompts.push(args);
        if (prompts.length > 1 && options.askHangs) return new Promise<WorkerResult>(() => {});
        return worker(prompts.length > 1 && options.answer !== undefined
          ? options.answer
          : options.report ?? "REPORT\nI repaired the check but omitted the commit line.");
      },
      ...(options.askHangs ? { spawnWallClockBoundMs: 50 } : {}),
      waitForCiGreen: async () => "green", runReview: async () => ({ ...review, state: "success", summary: "fixed" }),
      fetchPrBody: async () => "REPORT", push: () => {},
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} } as IssueGateway,
      ledgerPath: join(root, "ledger.ndjson"), log: (step, extra) => rows.push({ step, ...(extra ?? {}) }),
      readHeadShaForProvenance: () => "head-a",
      say: () => {}, account: (result) => result, commitsAhead: () => 0,
      worktreeHasUncommittedChanges: () => true,
      harnessCommitForShellLessWorker: (input) => harnessCommitForShellLessWorker(input, {
        commit: (_cwd, _paths, message) => {
          messages.push(message);
          return { committed: true, sha: "new-head", undeclared: [] };
        },
        ahead: () => 1,
      }),
    },
  });
  return { outcome, rows, prompts, messages };
}

function derivedRow(rows: Array<{ step: string } & Record<string, unknown>>) {
  assert.equal(rows.some((row) => row.step === "fix.commit_refused"), false);
  assert.equal(rows.some((row) => row.step === "implement.harness_commit_refused" && row.reason !== undefined &&
    String(row.reason).startsWith("no anchored COMMIT_MESSAGE line")), true, "the first attempt still finds the line missing");
  return rows.find((row) => row.step === "implement.harness_commit");
}

test("W1-T8524: a legacy writer still missing its commit line commits under a derived subject", async (t) => {
  const { outcome, prompts, messages, rows } = await fixRound(t, {
    legacy: true, answer: "REPORT\nThe commit line is still missing.",
  });
  assert.equal(prompts.length, 2, "the legacy writer is re-asked once");
  assert.equal(prompts[1]!.resumeSessionId, "writer-session");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^fix: repair ci-gate on #8524\n\nHarness-derived subject:/);
  assert.equal(derivedRow(rows)?.subject_source, "harness-derived");
});

test("W1-T8524: a round with no failing check derives its subject from the task title", async (t) => {
  const { outcome, prompts, messages, rows } = await fixRound(t, { ci: false, unmet: false });
  assert.equal(prompts.length, 1, "an identified writer needs no re-ask");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, new RegExp(`^fix: repair ${TITLE} on #8524\\n\\nHarness-derived subject:`));
  assert.equal(rows.find((row) => row.step === "implement.harness_commit")?.subject_source, "harness-derived");
  assert.equal(rows.some((row) => row.step === "fix.commit_refused"), false);
});

test("W1-T8524: a re-ask that cannot spawn still commits under the derived subject", async (t) => {
  const { outcome, prompts, messages, rows } = await fixRound(t, { legacy: true, askHangs: true });
  assert.equal(prompts.length, 2);
  assert.equal(rows.find((row) => row.step === "fix.commit_line_answered")?.outcome, "abandoned");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^fix: repair ci-gate on #8524\n\nHarness-derived subject:/);
  assert.equal(derivedRow(rows)?.subject_source, "harness-derived");
});

test("W1-T8524: a non-commit outcome without a commit line still commits nothing", async (t) => {
  for (const report of ["REPORT\nFIX_OUTCOME: NEEDS_SCOPE src/lib/elsewhere.ts", "REPORT\nFIX_OUTCOME: BASE_RED"]) {
    for (const legacy of [false, true]) {
      const { messages, rows, prompts } = await fixRound(t, { report, legacy });
      assert.deepEqual(messages, [], `${report} (legacy ${legacy}) commits nothing`);
      assert.equal(rows.some((row) => row.step === "implement.harness_commit"), false);
      assert.equal(rows.some((row) => row.step === "fix.commit_line_requested"), false);
      assert.equal(prompts.length, 1, "no commit-line re-ask is dispatched");
    }
  }
});
