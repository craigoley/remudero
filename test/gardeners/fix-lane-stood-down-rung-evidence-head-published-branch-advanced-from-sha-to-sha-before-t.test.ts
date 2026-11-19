import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { defectEventsOf } from "#src/lib/fix-lane-gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

const taskId = "W1-T11010";
const branch = `run-${taskId}-1794600000000`;
const prUrl = "https://github.com/o/fixture/pull/11010";
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
const staleFailure = "old head: tests failed before the branch advanced";
const freshFailure = "published head: a different test failed";

test("W1-T11010: fix-lane-stood-down-rung-evidence-head-published-branch-advanced-from-sha-to-sha-before-t clears without a person", async (t) => {
  const origin = gitRepo({ bare: true, scope: t });
  const checkout = gitRepo({ branch, scope: t });
  checkout.addRemote("origin", origin.dir);
  const priorHead = checkout.git("rev-parse", "HEAD");
  checkout.git("push", "--quiet", "origin", branch);
  checkout.git("commit", "--quiet", "--allow-empty", "-m", "advance the published branch");
  const publishedHead = checkout.git("rev-parse", "HEAD");
  checkout.git("push", "--quiet", "origin", branch);

  const review = {
    state: "failure" as const, criteria: [], testTheater: false, summary: "sweep-reconstructed: required checks red",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: priorHead,
    reviewerOutcome: "sweep-reconstructed-ci-log",
  };
  const evidenceReads: Array<[string, string | undefined]> = [];
  const rows: LedgerRecord[] = [];
  const ts = new Date().toISOString();
  let repairedHead = "";
  const requiredChecks = { requiredContexts: ["ci"] };
  const outcome = await runFixRung({
    ...requiredChecks,
    taskId, runId: `fixture-${taskId}`, task: { id: taskId, title: "repair the published head" },
    prUrl, branch, worktreePath: checkout.dir, initialSessionId: "implement-session", mount,
    settingsFile: join(checkout.dir, "settings.json"), config: { root: checkout.dir, claudeBin: "/bin/true" },
    budgetUsd: 5, strikeCap: 1, initialReview: review,
    ciFailures: [{ name: "ci", logTail: staleFailure }],
    reviewBase: { owner: "o", repo: "fixture", headCheckoutDir: checkout.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    deps: {
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      readCiRollup: async () => [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }],
      fetchCiFailures: async (url, sha) => {
        evidenceReads.push([url, sha]);
        assert.equal(sha, publishedHead);
        return [{ name: "ci", logTail: freshFailure }];
      },
      spawn: async ({ prompt }) => {
        assert.equal(checkout.git("rev-parse", "HEAD"), publishedHead);
        assert.ok(String(prompt).includes(freshFailure));
        assert.ok(!String(prompt).includes(staleFailure));
        checkout.git("commit", "--quiet", "--allow-empty", "-m", "repair the fresh CI failure");
        repairedHead = checkout.git("rev-parse", "HEAD");
        return {
          sessionId: "fix-session", costUsd: 0, numTurns: 1, text: "FIX_OUTCOME: FIXED", blocks: [], stderr: "", subtype: "success",
          isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: mount.model, effort: mount.effort,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
          qualitySuspect: false,
        };
      },
      harnessCommitForShellLessWorker: () => 1,
      worktreeHasUncommittedChanges: () => false,
      push: (_cwd, target, head) => {
        assert.equal(target, branch);
        assert.equal(head, repairedHead);
        checkout.git("push", "--quiet", "origin", branch);
      },
      waitForCiGreen: async () => ({ state: "green", sha: repairedHead }),
      runReview: async () => ({ ...review, state: "success", headSha: repairedHead }),
      fetchPrBody: async () => `## Summary\n\nFixture.\n\nRemudero-Task: ${taskId}\n`,
      issues: { create: () => assert.fail("unexpected operator issue"), listOpen: () => [], comment: () => {} },
      ledgerPath: join(checkout.dir, "ledger.ndjson"),
      ledgerLines: () => rows,
      log: (step, fields) => { rows.push({ ...fields, step, ts, pr_number: 11010 }); },
      say: () => {},
      account: (result) => result,
    },
  });

  assert.deepEqual(defectEventsOf(rows, Date.parse(ts)).filter(({ key }) => key.startsWith("stood-down:rung.evidence_head:")), []);
  const adopted = rows.filter(({ step }) => step === "fix.evidence_head_adopted");
  assert.deepEqual(adopted.map((row) => [row.head_sha, row.current_head_sha]), [[priorHead, publishedHead]]);
  assert.deepEqual(evidenceReads, [[prUrl, publishedHead]]);
  assert.equal(outcome.outcome, "fixed", outcome.reason);
  assert.notEqual(repairedHead, publishedHead);
  assert.equal(origin.git("rev-parse", `refs/heads/${branch}`), repairedHead);
});
