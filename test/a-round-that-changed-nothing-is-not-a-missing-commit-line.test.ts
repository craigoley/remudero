/**
 * A worker round that changed nothing is reported as changed nothing, not as a missing commit line.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  harnessCommitForShellLessWorker, noPrVerdict, resumeForMissingCommitLine, runFixRung,
  WORKER_CHANGED_NOTHING_REASON,
} from "#test/helpers/run-task-test.js";
import { refusalReasonKey } from "#src/lib/ci-friction-gardener.js";
import { shouldSelfHealNothingChanged } from "#src/lib/fix-rung-classify.js";
import { fixRoundTally } from "#src/lib/sweep.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import type { Mount } from "#src/lib/mounts.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const CHANGED_NOTHING = "the worker changed nothing";
const MISSING_LINE = "no anchored COMMIT_MESSAGE line in the report";
const NO_LINE_REPORT = "REPORT\nI looked at the task and stopped.";
const TASK = "W1-T0001X";
const HEAD = "head-a";

type Row = { step: string } & Record<string, unknown>;

/** One subprocess mock per test: a second mock would restore to the first, not to the original. */
const mocked = new WeakSet<TestContext>();

function helperRound(worktreePath: string, extra: Partial<Parameters<typeof harnessCommitForShellLessWorker>[0]> = {},
  commits: string[] = []) {
  const rows: Row[] = [];
  const refusals: Array<{ reason: string; undeclared: readonly string[] }> = [];
  const count = harnessCommitForShellLessWorker({
    harnessOwnsGit: true, commitCount: 0, report: NO_LINE_REPORT, worktreePath, declaredPaths: ["src"],
    log: (step, fields) => rows.push({ step, ...(fields ?? {}) }), say: () => {},
    onRefusal: (reason, undeclared = []) => refusals.push({ reason, undeclared }),
    ...extra,
  }, {
    commit: (_cwd, _paths, message) => {
      commits.push(message);
      return { committed: false, undeclared: [], reason: CHANGED_NOTHING };
    },
    ahead: () => 1,
  });
  return { count, rows, refusals, commits };
}

const writer = (text: string, provider: WorkerResult["provider"]): WorkerResult => ({
  provider, sessionId: "writer-session", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "",
  subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
  model: "codex", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  modelUsage: {}, compactionEvents: [], qualitySuspect: false,
});

async function fixRound(t: TestContext, options: { report: string; edits: boolean; provider?: WorkerResult["provider"]; answer?: string }) {
  if (!mocked.has(t)) {
    mocked.add(t);
    t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
      if (args.includes("rev-parse")) return HEAD;
      if (args.includes("--show-scope")) return "";
      throw new Error("test: subprocess reads unavailable");
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  }
  const root = mkdtempSync(join(tmpdir(), "rmd-changed-nothing-fix-"));
  const prompts: SpawnWorkerArgs[] = [];
  const rows: Row[] = [];
  const messages: string[] = [];
  const said: string[] = [];
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "repair the check", proof: "unit test: repair the check", met: false,
      reason: "still failing", proof_exec: "not_executable" }],
    testTheater: false, summary: "still failing", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: HEAD, reviewerOutcome: "failure",
  };
  const outcome = await runFixRung({
    taskId: TASK, runId: `${TASK}-fix`, task: { id: TASK, title: "repair the check", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/1", branch: `run-${TASK}-1`,
    worktreePath: process.cwd(), initialSessionId: "writer-session", mount,
    settingsFile: join(root, "settings.json"), config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review,
    ciFailures: [{ name: "ci-gate", logTail: "the check failed" }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async (args) => {
        prompts.push(args);
        return writer(prompts.length > 1 && options.answer !== undefined ? options.answer : options.report,
          "provider" in options ? options.provider : "codex");
      },
      waitForCiGreen: async () => "green", runReview: async () => ({ ...review, state: "success", summary: "fixed" }),
      fetchPrBody: async () => "REPORT", push: () => {},
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} } as IssueGateway,
      ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => [],
      log: (step, extra) => rows.push({ step, task_id: TASK, ...(extra ?? {}) }),
      readHeadShaForProvenance: () => HEAD,
      say: (msg) => said.push(msg), account: (result) => result, commitsAhead: () => 0,
      worktreeHasUncommittedChanges: () => options.edits,
      harnessCommitForShellLessWorker: (input) => harnessCommitForShellLessWorker(input, {
        commit: (_cwd, _paths, message) => {
          messages.push(message);
          return { committed: true, sha: "new-head", undeclared: [] };
        },
        ahead: () => 1,
      }),
    },
  });
  return { outcome, rows, prompts, messages, said };
}

test("W1-T14489 criterion 1: an implement round with no edits and no commit line is refused as changed nothing", (t) => {
  const repo = gitRepo({ scope: t, kind: "changed-nothing" });
  for (const extra of [{}, { leftEdits: () => false }]) {
    const { count, rows, refusals, commits } = helperRound(repo.dir, extra);
    assert.equal(count, 0);
    const refused = rows.filter((row) => row.step === "implement.harness_commit_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.reason, CHANGED_NOTHING);
    assert.equal(refused[0]!.report_tail, NO_LINE_REPORT);
    assert.deepEqual(refusals, [{ reason: CHANGED_NOTHING, undeclared: [] }]);
    assert.equal(commits.length, 0);
  }
  assert.equal(WORKER_CHANGED_NOTHING_REASON, CHANGED_NOTHING);
});

test("W1-T14489 criterion 2: a fix round with no edits and no commit line is refused as changed nothing, with no re-ask", async (t) => {
  for (const report of [NO_LINE_REPORT, "REPORT\nFIX_OUTCOME: NEEDS_SCOPE test/a.test.ts,test/b.test.ts"]) {
    for (const provider of ["codex", undefined] as const) {
      const { rows, messages } = await fixRound(t, { report, edits: false, provider });
      const refused = rows.filter((row) => row.step === "fix.commit_refused");
      assert.ok(refused.length >= 1, `${report}: the round is refused`);
      for (const row of refused) assert.equal(row.reason, CHANGED_NOTHING, report);
      assert.equal(rows.some((row) => row.step === "fix.commit_line_requested"), false, report);
      assert.equal(rows.some((row) => row.step === "implement.harness_commit"), false, report);
      assert.equal(messages.length, 0, report);
    }
  }
});

test("W1-T14489 criterion 3: a round that left edits is still refused for its missing commit line", async (t) => {
  const repo = gitRepo({ scope: t, kind: "left-edits" });
  repo.git("config", "user.email", "fixture@remudero.invalid");
  repo.git("config", "user.name", "remudero test fixture");
  repo.git("config", "commit.gpgsign", "false");
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "a.ts"), "export const a = 1;\n");
  for (const extra of [{}, { leftEdits: () => true }, { leftEdits: () => { throw new Error("unreadable worktree"); } }]) {
    const { rows, refusals } = helperRound(repo.dir, extra);
    assert.equal(rows.find((row) => row.step === "implement.harness_commit_refused")?.reason, MISSING_LINE);
    assert.deepEqual(refusals.map((refusal) => refusal.reason), [MISSING_LINE]);
  }
  const unreadable = helperRound(join(repo.dir, "does-not-exist"));
  assert.deepEqual(unreadable.refusals.map((refusal) => refusal.reason), [MISSING_LINE], "an unreadable worktree fails closed");

  let read = false;
  const derived = helperRound(repo.dir, {
    derivedCommit: { subject: "fix: repair the check", reason: "task title" }, leftEdits: () => { read = true; return false; },
  });
  assert.equal(read, false, "a round with a derived subject is judged by the commit step, not the edit read");
  assert.equal(derived.commits.length, 1);

  const resumeRows: Row[] = [];
  const recovery = await resumeForMissingCommitLine({
    commitCount: 0, refusalReason: helperRound(repo.dir).refusals[0]!.reason, report: NO_LINE_REPORT,
    worktreePath: repo.dir, declaredPaths: ["src"], log: (step, fields) => resumeRows.push({ step, ...(fields ?? {}) }), say: () => {},
    resume: async () => ({ text: "REPORT\nCOMMIT_MESSAGE: feat(a): add a", sessionId: "s-resumed", numTurns: 1, subtype: "success" }),
  }, { ahead: () => 1 });
  assert.equal(recovery.resumed, true);
  assert.equal(resumeRows.some((row) => row.step === "implement.commit_line_requested"), true);

  const legacy = await fixRound(t, { report: NO_LINE_REPORT, edits: true, provider: undefined,
    answer: "REPORT\nCOMMIT_MESSAGE: fix(src): repair the check as asked" });
  assert.equal(legacy.rows.find((row) => row.step === "implement.harness_commit_refused")?.reason, MISSING_LINE);
  assert.equal(legacy.rows.filter((row) => row.step === "fix.commit_line_requested").length, 1);
  assert.deepEqual(legacy.messages, ["fix(src): repair the check as asked"]);

  const fixed = await fixRound(t, { report: "REPORT\nFIX_OUTCOME: FIXED", edits: true });
  assert.equal(fixed.messages.length, 1);
  assert.match(fixed.messages[0]!, /^fix: repair ci-gate on #1\n\nHarness-derived subject:/);
});

test("W1-T14489 criterion 4: consumers read the changed-nothing reason", async (t) => {
  assert.equal(noPrVerdict(writer(NO_LINE_REPORT, "codex"), 0, "implement", 0, "harness_commit_refused").ledger.terminal_class,
    "harness_commit_refused");
  assert.equal(refusalReasonKey(WORKER_CHANGED_NOTHING_REASON), "the-worker-changed-nothing");
  assert.equal(shouldSelfHealNothingChanged(undefined, WORKER_CHANGED_NOTHING_REASON, 1), true);
  assert.equal(shouldSelfHealNothingChanged("FLAKE", WORKER_CHANGED_NOTHING_REASON, 1), true);
  assert.equal(shouldSelfHealNothingChanged("NEEDS_SCOPE", WORKER_CHANGED_NOTHING_REASON, 1), false);

  const unstated = await fixRound(t, { report: NO_LINE_REPORT, edits: false });
  assert.equal(unstated.said.some((line) => line.includes("re-reading the PR once")), true, "the unstated round is re-read once");
  const tally = fixRoundTally(unstated.rows, TASK, HEAD, "executed");
  assert.ok(tally.noCommitRounds.length >= 1, "the ci-log no-edit round counts as a no-commit round");

  const scoped = await fixRound(t, { report: "REPORT\nFIX_OUTCOME: NEEDS_SCOPE test/a.test.ts", edits: false });
  assert.equal(scoped.said.some((line) => line.includes("re-reading the PR once")), false, "a NEEDS_SCOPE round stands down");
  assert.equal(scoped.outcome.outcome, "stood_down");
});
