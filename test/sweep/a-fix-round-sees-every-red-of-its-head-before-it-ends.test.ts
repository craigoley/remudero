import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { Config } from "#src/lib/config.js";
import { earlyFixRoundCheckReader, earlyRedEvidenceRollup, type CiFailure } from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

const taskId = "W1-T13379";
const earlyCheck = "rule-checks";
const shardCheck = "coverage-shard (5/12)";
const report = "FIX_OUTCOME: NEEDS_DESIGN which store owns retries?";
const environmentReport = "FIX_OUTCOME: NEEDS_DESIGN Not a design blocker: the sandbox failed to start, so no command ran";
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;

function worker(text: string): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 1, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: mount.model, effort: mount.effort,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false, provider: "claude",
  };
}

async function round(t: TestContext, pending: boolean,
  options: { reports?: string[]; unreadable?: boolean; land?: boolean; catalog?: "ops" } = {}) {
  const repo = gitRepo({ kind: "fix-round-early-checks" });
  t.after(() => repo.cleanup());
  const headSha = repo.git("rev-parse", "HEAD");
  let pushedHead: string | undefined;
  const reads: string[] = [];
  const prompts: string[] = [];
  const issues: string[] = [];
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const shard = pending ? { name: shardCheck, status: "IN_PROGRESS" } : { name: shardCheck, conclusion: "SUCCESS" };
  const rollup = [{ name: earlyCheck, conclusion: "FAILURE" }, shard];
  const failures: CiFailure[] = earlyRedEvidenceRollup(rollup, [earlyCheck]).map(({ name }) => ({ name, logTail: "early failure" }));
  const earlyEvidence = earlyFixRoundCheckReader(
    { checksState: "red", pendingRequiredChecks: pending ? ["coverage-ratchet"] : [] }, { ciFailures: failures },
    async (sha) => {
      assert.ok(prompts.length > 0, "the recheck runs after dispatch");
      reads.push(sha);
      if (options.unreadable) throw new Error("checks unavailable");
      return [{ name: earlyCheck, conclusion: "FAILURE" }, { name: shardCheck, conclusion: "FAILURE" }];
    },
    (checks) => checks.map(({ name }) => ({ name: name!, logTail: name === shardCheck ? "late coverage test failed" : "early failure" })),
  );
  const initialReview = {
    state: "failure" as const, headSha, criteria: [], testTheater: false, summary: "required checks red",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, reviewerOutcome: "sweep-reconstructed-ci-log",
  };
  const task = { id: taskId, title: "repair checks", catalog: options.catalog };
  const outcome = await runFixRung({
    taskId, runId: "early-red-round", task,
    prUrl: "https://github.com/acme/remudero/pull/1", branch: `run-${taskId}-1`, worktreePath: repo.dir,
    mount, settingsFile: join(repo.dir, "settings.json"), config: { root: repo.dir } as Config,
    budgetUsd: 5, strikeCap: 2, initialSessionId: "initial", initialReview, ciFailures: failures, ...earlyEvidence,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    deps: {
      spawn: async (args) => {
        prompts.push(String(args.prompt));
        if (options.land) repo.git("commit", "--allow-empty", "-m", "fix observed checks");
        return worker((options.reports ?? [report])[prompts.length - 1]!);
      },
      waitForCiGreen: async () => ({ state: "green", sha: pushedHead ?? assert.fail("CI expects the pushed head") }),
      runReview: async () => ({ ...initialReview, state: "success", headSha: pushedHead ?? assert.fail("review expects the pushed head") }),
      fetchPrBody: async () => "## Summary\n\nFix the failing checks.",
      readHeadShaForProvenance: () => pushedHead ?? assert.fail("provenance expects the pushed head"),
      push: (_worktree, _branch, sha) => {
        assert.ok(options.land && sha);
        pushedHead = sha;
      },
      issues: {
        create: (_title, body) => { issues.push(body); return "https://github.com/acme/remudero/issues/2"; },
        listOpen: () => [], comment: () => {},
      },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ step, ...extra }); }, say: () => {}, account: (result) => result,
    },
  });
  return { headSha, outcome, prompts, reads, rows, issues };
}

test("W1-T13379 criterion 1: a late shard is named when the early round ends without a repair", async (t) => {
  const result = await round(t, true);
  assert.equal(result.outcome.outcome, "needs_design");
  assert.deepEqual(result.reads, [result.headSha]);
  assert.ok(result.outcome.reason.includes(shardCheck));
  assert.ok(!result.prompts[0]!.includes(shardCheck));
  const done = result.rows.find(row => row.step === "fix.done");
  assert.deepEqual(done?.unaddressed_checks, [shardCheck]);
  assert.deepEqual(done?.early_ci_recheck, { dispatch_checks: [earlyCheck], new_red_checks: [shardCheck] });
});

test("an admitted follow-up worker on the same head receives the late shard log", async (t) => {
  const result = await round(t, true, { reports: [environmentReport, report] });
  assert.deepEqual(result.reads, [result.headSha]);
  assert.equal(result.prompts.length, 2);
  assert.ok(result.prompts[1]!.includes("late coverage test failed"));
});

test("a workflow-scope escalation names the late check still open", async (t) => {
  const result = await round(t, true, { reports: ["FIX_OUTCOME: NEEDS_SCOPE .github/workflows/ci.yml"] });
  assert.equal(result.outcome.outcome, "stood_down");
  assert.equal(result.issues.length, 1);
  assert.ok(result.issues[0]!.includes(`still unaddressed: ${shardCheck}`));
});

test("an ops scope escalation names the late check and keeps worker diagnostics host-side", async (t) => {
  const result = await round(t, true, { catalog: "ops",
    reports: ["FIX_OUTCOME: NEEDS_SCOPE .github/workflows/ci.yml\nInternal worker diagnosis"] });
  assert.equal(result.outcome.outcome, "stood_down");
  assert.ok(result.outcome.reason.includes(shardCheck));
  assert.equal(result.issues.length, 1);
  assert.ok(result.issues[0]!.includes(`still unaddressed: ${shardCheck}`));
  assert.ok(!result.issues[0]!.includes("Internal worker diagnosis"));
});

test("green CI at the round's own new head clears the outstanding check", async (t) => {
  const result = await round(t, true, { land: true, reports: ["FIX_OUTCOME: FIXED"] });
  assert.deepEqual(result.reads, [result.headSha]);
  assert.equal(result.outcome.outcome, "fixed");
  assert.notEqual(result.outcome.review.headSha, result.headSha);
  assert.equal(result.outcome.reason, "review passed");
});

test("W1-T13379 criterion 2: a concluded dispatch performs no extra check read", async (t) => {
  const result = await round(t, false);
  assert.equal(result.outcome.outcome, "needs_design");
  assert.deepEqual(result.reads, []);
  assert.ok(!result.outcome.reason.includes(shardCheck));
  assert.equal(result.rows.find(row => row.step === "fix.done")?.unaddressed_checks, undefined);
  const alerts = { ciFailures: [{ name: "CodeQL", logTail: "a scanning alert" }] };
  const read = () => assert.fail("concluded heads have no early check reader");
  assert.deepEqual(earlyFixRoundCheckReader({ checksState: "green", pendingRequiredChecks: [] }, alerts, read, read), {});
});

test("an unreadable early recheck is recorded without attributing a failure", async (t) => {
  const result = await round(t, true, { unreadable: true });
  assert.equal(result.outcome.outcome, "needs_design");
  assert.deepEqual(result.reads, [result.headSha]);
  const failed = result.rows.find(row => row.step === "fix.ci_failures_fetch_error" && row.site === "early_ci_recheck");
  assert.match(String(failed?.error), /checks unavailable/);
});
