import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runFixRung } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";

async function fixRound(t: TestContext, options: {
  files?: string[]; inherited?: string[]; unreadableDiff?: boolean; harnessCommits?: boolean;
}) {
  t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
    if (args.includes("rev-parse")) return "head-a";
    throw new Error("fixture: subprocess read unavailable");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t5377-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const calls = { spawn: 0, push: 0, account: 0, review: 0, ci: 0, commit: 0 };
  let stagedSurface: readonly string[] | undefined;
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "repair the check", proof: "unit test: repair the check",
      met: false, reason: "still failing", proof_exec: "not_executable" }],
    testTheater: false, summary: "still failing", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure",
  };
  const result: WorkerResult = {
    sessionId: "writer-session", costUsd: 1, numTurns: 1,
    text: "REPORT\nCOMMIT_MESSAGE: fix(src): repair the check", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
  const outcome = await runFixRung({
    taskId: "W1-T5377", runId: "W1-T5377-fixture",
    task: { id: "W1-T5377", title: "repair the check", files: options.files },
    prUrl: "https://github.com/acme/remudero/pull/5377", branch: "run-W1-T5377-1",
    worktreePath: root, initialSessionId: "", mount, settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: options.harnessCommits ?? true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    escalationJudge: async () => { throw new Error("must not escalate"); },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async () => { calls.spawn++; return result; },
      push: () => { calls.push++; },
      waitForCiGreen: async () => { calls.ci++; return "green"; },
      runReview: async () => { calls.review++; return { ...review, state: "success" }; },
      fetchPrBody: async () => "REPORT\nRemudero-Task: W1-T5377",
      fetchPrDiffFiles: options.inherited === undefined && !options.unreadableDiff ? undefined : async () => {
        if (options.unreadableDiff) throw new Error("PR diff unreadable");
        return options.inherited!;
      },
      issues: { create: () => { throw new Error("must not file an issue"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), log: (step, extra) => rows.push({ step, ...(extra ?? {}) }),
      say: () => {}, account: (worker) => { calls.account++; return worker; },
      readHeadShaForProvenance: () => "head-a", commitsAhead: () => 0,
      worktreeHasUncommittedChanges: () => false,
      harnessCommitForShellLessWorker: (input) => {
        calls.commit++;
        stagedSurface = input.declaredPaths;
        return 1;
      },
    },
  });
  return { outcome, rows, calls, stagedSurface };
}

test("W1-T5377: fix_refusal:the-task-declares-no-files-so-there-is-no-surface-to-stage is prevented, not retried", async (t) => {
  for (const options of [{ files: [], inherited: [] }, {}, { unreadableDiff: true }]) {
    await t.test(JSON.stringify(options), async (t) => {
      const { outcome, rows, calls } = await fixRound(t, options);
      assert.equal(outcome.outcome, "stood_down");
      assert.equal(outcome.strikes, 0);
      assert.equal(outcome.retriggers, 0);
      assert.match(outcome.standDownReason ?? "", /no surface to stage/);
      assert.deepEqual(calls, { spawn: 0, push: 0, account: 0, review: 0, ci: 0, commit: 0 });
      assert.equal(rows.some((row) => row.step === "fix.dispatch" || row.step === "fix.commit_refused"), false);
      assert.equal(rows.find((row) => row.step === "fix.stood_down")?.site, "rung.empty_commit_surface");
    });
  }
});

for (const options of [{ files: ["src/run-task.ts"], inherited: [] }, { files: [], inherited: ["docs/repair.md"] }]) {
  test(`a fix with an authorized surface still dispatches: ${JSON.stringify(options)}`, async (t) => {
    const { outcome, calls, stagedSurface } = await fixRound(t, options);
    assert.equal(outcome.outcome, "fixed");
    assert.equal(calls.spawn, 1);
    assert.equal(calls.push, 1);
    assert.deepEqual(stagedSurface, [...options.files, ...options.inherited]);
  });
}

test("a worker that owns git retains its dispatch with no declared paths", async (t) => {
  const { outcome, calls } = await fixRound(t, { harnessCommits: false });
  assert.equal(outcome.outcome, "fixed");
  assert.equal(calls.spawn, 1);
});
