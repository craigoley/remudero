/**
 * W1-T6003. W1-T5955 ended a fix round's branch claim at its fix.done so the CI wait holds none, but
 * runFixRung's rerun-once (FLAKE) path waited on CI BEFORE its fix.done, so a flake verification held
 * the claim through the whole wait and every other round on that branch was declined live_branch_claim.
 * The flake path now releases once its requeues are posted; fix.done still follows the wait, carries
 * the verdict, and names the claim it ended.
 */
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixBranchClaimKey, runFixRung } from "./helpers/run-task-test.js";
import { gitRepo } from "./helpers/git-repo.js";
import { fixRoundBranchClaim, reclaimFixRoundBranch } from "../src/lib/sweep.js";
import { acquireInflightLock, inflightLockPath, readInflightLock } from "../src/lib/inflight-lock.js";
import type { WorkerResult } from "../src/lib/worker.js";

const TASK = "W1-T6003X", HEAD = "f1a6e00";
type Row = Record<string, unknown>;

async function flakeRound(onWait: (dir: string, key: string) => void) {
  const repo = gitRepo({ kind: "flake-claim" });
  const dir = join(repo.dir, "inflight");
  const key = fixBranchClaimKey("o", "r", "run-W1-T6003X-1");
  const claim = fixRoundBranchClaim(acquireInflightLock(dir, key, { run_id: "R1" }), () =>
    reclaimFixRoundBranch({ inflightDir: dir, claimKey: key, claimRunId: "R2", roundEnded: () => false, ownsWorktree: () => true }));
  const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
  const review = { state: "failure", criteria: [], testTheater: false, summary: "red",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: HEAD, reviewerOutcome: "failure" } as Parameters<typeof runFixRung>[0]["initialReview"];
  const rows: Row[] = [];
  let waits = 0, requeues = 0;
  const result = await runFixRung({ taskId: TASK, runId: "flake-claim",
    task: { id: TASK, title: "verify a flake", files: ["src/fix.ts"] },
    prUrl: "https://github.com/o/r/pull/10600", branch: "run-W1-T6003X-1", worktreePath: repo.dir,
    initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as never,
    budgetUsd: 1, strikeCap: 2, initialReview: review,
    ciFailures: [{ name: "ci", logTail: "not ok 1 - timing", jobId: "321" }],
    progressDecision: { verdict: "continue", reason: "first flake claim" },
    reviewBase: { owner: "o", repo: "r", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      fixProgressJudge: async () => ({ verdict: "continue", reason: "first flake claim" }),
      spawn: async () => ({
        sessionId: "flake-worker", costUsd: 0, numTurns: 1,
        text: "REPORT\nFIX_OUTCOME: FLAKE", blocks: [], stderr: "", subtype: "success",
        isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
        model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {}, compactionEvents: [], qualitySuspect: false, provider: "claude",
      } as WorkerResult),
      waitForCiGreen: async () => { waits++; onWait(dir, key); return "green"; },
      runReview: async () => review, fetchPrBody: async () => "REPORT", push: () => {},
      issues: { create: () => "https://github.com/o/r/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ step, task_id: TASK, ...extra }); },
      say: () => {}, account: (r) => r, requeueCheck: () => { requeues++; return true; },
      branchClaim: claim,
    },
  });
  return { repo, dir, key, rows, result, waits, requeues };
}

test("a flake rerun releases its branch claim before waiting on CI, so a sweep pass during that wait can claim the branch", async () => {
  let held: string | undefined = "not observed";
  let successor: ReturnType<typeof acquireInflightLock> | undefined;
  const f = await flakeRound((dir, key) => {
    held = readInflightLock(dir, key)?.run_id;
    successor = acquireInflightLock(dir, key, { run_id: "SWEEP-PASS" });
  });
  try {
    assert.equal(f.requeues, 1, "the flake path requeued the red check");
    assert.equal(f.waits, 1, "and waited on CI");
    assert.equal(held, undefined, "the CI wait holds no branch claim");
    assert.equal(readInflightLock(f.dir, f.key)?.run_id, "SWEEP-PASS", "the sweep pass's claim is untouched by fix.done");
    const done = f.rows.filter((r) => r.step === "fix.done");
    assert.equal(done.length, 1);
    assert.equal(done[0].flake_claim, "confirmed", "fix.done still follows the wait and carries its verdict");
    assert.equal(done[0].branch_claim_run_id, "R1", "fix.done names the claim the round ended");
    assert.equal(f.result.outcome, "stood_down");
    assert.equal(f.result.reason, "flake-confirmed");
    successor?.release();
    assert.equal(existsSync(inflightLockPath(f.dir, f.key)), false);
  } finally {
    successor?.release();
    rmSync(f.repo.dir, { recursive: true, force: true });
  }
});
