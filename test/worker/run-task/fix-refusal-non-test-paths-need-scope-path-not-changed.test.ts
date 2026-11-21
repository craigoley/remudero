import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

test("W1-T10585: fix_refusal:non-test-paths-need-scope-path-not-changed is prevented, not retried", async (t) => {
  const taskId = "W1-T10585";
  const branch = `run-${taskId}-1`;
  const prUrl = "https://github.com/acme/remudero/pull/7";
  const repo = gitRepo({ scope: t });
  const declared = "src/declared.ts";
  const untouched = "src/earlier-pr-edit.ts";
  const touched = "src/round-edit.ts";
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, declared), "export const declared = 1;\n");
  writeFileSync(join(repo.dir, untouched), "export const earlier = 1;\n");
  writeFileSync(join(repo.dir, touched), "export const current = 1;\n");
  repo.git("add", "src");
  repo.git("commit", "-qm", "seed scope paths");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("switch", "-qc", branch);
  writeFileSync(join(repo.dir, untouched), "export const earlier = 2;\n");
  repo.git("commit", "-qam", "edit a path before the fix round");
  const headSha = repo.git("rev-parse", "HEAD");

  const mount = { model: "sonnet", effort: "medium" as const, maxTurns: 20, contextBudget: 120000 };
  const review = {
    state: "failure" as const,
    criteria: [{ claim: "repair source", proof: "unit test: repair source", met: false, reason: "red",
      proof_exec: "not_executable" as const }],
    summary: "red", testTheater: false, floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha, reviewerOutcome: "failure",
  };
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const opened: string[] = [];
  let spawns = 0;
  const result = await runFixRung({
    taskId, runId: `${taskId}-test`, task: { id: taskId, title: "repair source", files: [declared] },
    prUrl, branch, worktreePath: repo.dir, initialSessionId: "initial", mount,
    settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir } as Parameters<typeof runFixRung>[0]["config"],
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    deps: {
      spawn: async () => {
        spawns++;
        writeFileSync(join(repo.dir, touched), "export const current = 2;\n");
        repo.git("commit", "-qam", "edit a path in the fix round");
        assert.equal(repo.git("status", "--porcelain"), "");
        return {
          sessionId: "fix-session", costUsd: 0, numTurns: 1,
          text: `FIX_OUTCOME: NEEDS_SCOPE ${untouched},${touched}`,
          blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
          permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
          tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false,
        };
      },
      scopeAmendmentWritePorts: {
        repoDir: repo.dir,
        findShard: () => ({
          path: `plan/tasks.d/${taskId}-fixture.yaml`,
          text: `- id: ${taskId}\n  files: [${declared}]\n  acceptance:\n    - claim: unchanged\n      proof: 'unit test: unchanged'\n`,
        }),
        worktreeAdd: () => {}, worktreeRemove: () => {}, writeFile: () => {}, gitAdd: () => {},
        gitCommit: () => "amendment-sha", gitPush: () => {}, probeExisting: () => undefined,
        createPr: ({ head }) => {
          opened.push(head);
          return { prUrl: "https://github.com/acme/remudero/pull/99", prNumber: 99 };
        },
        worktreePathFor: () => "/amendment", lookupIdentity: () => undefined, recordIdentity: () => {},
        updateBranch: () => assert.fail("scope amendment has not merged"),
      },
      fetchPrDiffFiles: async () => [untouched],
      fetchPrBody: async () => `Remudero-Task: ${taskId}`,
      readHeadShaForProvenance: () => repo.git("rev-parse", "HEAD"),
      waitForCiGreen: async () => assert.fail("no fix commit should be pushed"),
      runReview: async () => assert.fail("scope amendment must merge before re-review"),
      push: () => assert.fail("the worker's fix commit still needs scope"),
      issues: {
        listOpen: () => [],
        create: () => assert.fail("the scope amendment needs no escalation"),
        comment: () => assert.fail("the scope amendment needs no escalation"),
      },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ step, ...extra }); },
      say: () => {}, account: (workerResult) => workerResult,
    },
  });

  const asks = rows.filter(({ step }) => step === "fix.scope_amendment");
  assert.deepEqual(asks.map(({ outcome, paths, dropped_paths, retry }) => ({ outcome, paths, dropped_paths, retry })), [
    { outcome: "created", paths: [touched], dropped_paths: [untouched], retry: undefined },
  ]);
  assert.deepEqual(rows.filter(({ step }) => step === "fix.commit_refused"), []);
  assert.deepEqual(opened, [`scope-amendment/${taskId}-7`]);
  assert.equal(result.reason, "awaiting scope amendment merge");
  assert.equal(result.strikes, 0);
  assert.equal(spawns, 1);
});
