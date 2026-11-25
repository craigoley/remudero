/**
 * W1-T14750 — a fix round re-reads the PR's open state before it pushes.
 *
 * OBSERVED 2026-11-24: a sweep fix worker committed for a PR that closed 35 seconds later. The rung re-read the PR's
 * live state before the round (W1-T177) but not between the worker's commit and the push, so a PR that merged or
 * closed while the worker ran still got the push, the round comment and the CI spend. These tests drive the real
 * runFixRung with a live-state reader whose PR closes while the worker runs.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { harnessCommitForShellLessWorker, runFixRung } from "#test/helpers/run-task-test.js";
import type { FixRoundCommentInput } from "#src/lib/fix-round-comment.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { Config } from "#src/lib/config.js";
import type { Mount } from "#src/lib/mounts.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const TASK = "W1-T14750X";
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
const PRIOR = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const ROUND = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
type Row = Record<string, unknown> & { step: string };

function worker(text: string): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false, provider: "claude",
  } as WorkerResult;
}

function review(headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return { state: "failure", headSha, reviewerOutcome: "failure", testTheater: false, summary: "blocked",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    criteria: [{ claim: "the fix lands", proof: "unit test: the fix lands", met: false, reason: "still blocked", proof_exec: "not_executable" }] };
}

/** One real fix round whose worker reports FIXED. `closeDuringWorker` closes (or merges) the PR while it runs. */
async function round(closeDuringWorker: "CLOSED" | "MERGED" | undefined) {
  const rows: Row[] = [];
  const pushes: string[] = [];
  const comments: FixRoundCommentInput[] = [];
  let state: "OPEN" | "CLOSED" | "MERGED" = "OPEN";
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14750-`));
  const worktree = gitRepo({ kind: "w1-t14750-round" }).dir;
  const outcome = await runFixRung({
    taskId: TASK, runId: "DAEMON-14750", task: { id: TASK, title: "the fix lands", files: ["src/fix.ts"] },
    prUrl: "https://github.com/craigoley/remudero/pull/14750", branch: "run-W1-T14750X-1", worktreePath: worktree,
    initialSessionId: "initial-session", mount: MOUNT, settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review(PRIOR),
    reviewBase: { owner: "craigoley", repo: "remudero", headCheckoutDir: worktree, reviewerMount: MOUNT },
    deps: {
      spawn: async () => {
        if (closeDuringWorker) state = closeDuringWorker;
        return worker("REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(ci): repair the red");
      },
      readLiveState: async () => ({ ok: true as const, state }),
      waitForCiGreen: async () => "green" as const,
      runReview: async () => review(PRIOR),
      fetchPrBody: async () => "REPORT",
      push: (_wt: string, _branch: string, sha?: string) => { pushes.push(String(sha)); },
      readRemoteBranchHead: async () => (pushes.length > 0 ? ROUND : PRIOR),
      upsertFixRoundComment: async (input: FixRoundCommentInput) => { comments.push(input); return { action: "created" as const, commentId: 1 }; },
      issues: { create: () => "https://github.com/craigoley/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ ts: new Date().toISOString(), task_id: TASK, step, ...extra }); },
      say: () => {}, account: (result) => result,
      worktreeHasUncommittedChanges: () => true,
      harnessCommitForShellLessWorker: (input) => harnessCommitForShellLessWorker(input,
        { commit: () => ({ committed: true, sha: ROUND, undeclared: [] }), ahead: () => 1 }),
    },
  });
  return { outcome, rows, pushes, comments, steps: (step: string) => rows.filter((r) => r.step === step) };
}

test("W1-T14750: a fix round whose PR closed before its push pushes nothing", async () => {
  for (const terminal of ["CLOSED", "MERGED"] as const) {
    const run = await round(terminal);
    assert.deepEqual(run.pushes, [], `${terminal}: nothing is pushed to a PR that went terminal while the worker ran`);
    assert.deepEqual(run.comments, [], `${terminal}: no round comment is written`);
    const stood = run.steps("fix.stood_down").filter((r) => r.site === "rung.strike.pre_push");
    assert.equal(stood.length, 1, `${terminal}: ${JSON.stringify(run.rows.map((r) => [r.step, r.site]))}`);
    assert.equal(stood[0]!.head_sha, ROUND, "the stand-down names the head the round would have pushed");
    assert.equal(run.outcome.outcome, "stood_down");
    assert.equal(run.steps("fix.done")[0]?.push_outcome, "refused", "the round never landed, so it spends no strike");
  }

  // The contrast: a PR still open at the push gets its push and its round comment.
  const open = await round(undefined);
  assert.deepEqual(open.pushes, [ROUND]);
  assert.equal(open.comments.length, 1);
  assert.equal(open.steps("fix.stood_down").filter((r) => r.site === "rung.strike.pre_push").length, 0);
  assert.equal(open.steps("fix.done")[0]?.push_outcome, "landed");
});
