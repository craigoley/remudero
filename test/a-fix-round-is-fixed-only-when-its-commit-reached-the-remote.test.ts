/**
 * W1-T9618 — a fix round is FIXED only when its commit reached the remote.
 *
 * OBSERVED 2026-10-15 on #11918: round 1 committed 70b73ea83, its push died on "could not read Username",
 * and fix.done still said FIXED / success with no pushed head. The strike burned, the progress judge read a
 * FIXED round, and the routing learner credited the arm. These tests drive the real runFixRung.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FixRoundPushError, harnessCommitForShellLessWorker, pushFixRound, runFixRung } from "#test/helpers/run-task-test.js";
import { buildFixProgressInput } from "#src/lib/fix-progress-judge.js";
import { fixArmEvidence } from "#src/lib/fix-routing-learner.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { fixLedgerRowsForHead, fixRoundTally } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { Config } from "#src/lib/config.js";
import type { Mount } from "#src/lib/mounts.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const TASK = "W1-T9618X";
const BRANCH = "run-W1-T9618X-1";
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
const USERNAME = "fatal: could not read Username for 'https://github.com/craigoley/remudero.git': No such device or address";
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

/** One fix round whose worker reports FIXED and whose (fake) harness commit is `committed`. */
async function round(opts: {
  worktree: string; dispatchedHead: string; committed: string | (() => string);
  push: (wt: string, branch: string, sha?: string, prior?: string) => unknown;
  readRemoteBranchHead?: (wt: string, branch: string) => Promise<string | undefined>;
}) {
  const rows: Row[] = [];
  let ciWaits = 0;
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9618-`));
  const outcome = await runFixRung({
    taskId: TASK, runId: "DAEMON-9618", task: { id: TASK, title: "the fix lands", files: ["src/fix.ts"] },
    prUrl: "https://github.com/craigoley/remudero/pull/11918", branch: BRANCH, worktreePath: opts.worktree,
    initialSessionId: "initial-session", mount: MOUNT, settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review(opts.dispatchedHead),
    reviewBase: { owner: "craigoley", repo: "remudero", headCheckoutDir: opts.worktree, reviewerMount: MOUNT },
    deps: {
      spawn: async () => worker("REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(ci): repair the red"),
      waitForCiGreen: async () => { ciWaits++; return "green" as const; },
      runReview: async () => review(opts.dispatchedHead),
      fetchPrBody: async () => "REPORT",
      push: opts.push,
      ...(opts.readRemoteBranchHead ? { readRemoteBranchHead: opts.readRemoteBranchHead } : {}),
      issues: { create: () => "https://github.com/craigoley/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ ts: new Date().toISOString(), task_id: TASK, step, ...extra }); },
      say: () => {}, account: (result) => result,
      worktreeHasUncommittedChanges: () => true,
      harnessCommitForShellLessWorker: (input) => harnessCommitForShellLessWorker(input,
        { commit: () => ({ committed: true, sha: typeof opts.committed === "string" ? opts.committed : opts.committed(), undeclared: [] }), ahead: () => 1 }),
    },
  });
  const done = rows.filter((r) => r.step === "fix.done");
  return { outcome, rows, done, ciWaits };
}

const PRIOR = "f1f3f1654f1f3f1654f1f3f1654f1f3f1654f1f3";
const ROUND = "70b73ea8370b73ea8370b73ea8370b73ea8370b7";

async function usernameRound() {
  const repo = gitRepo({ kind: "w1-t9618-username" });
  return round({ worktree: repo.dir, dispatchedHead: PRIOR, committed: ROUND,
    push: () => { throw new FixRoundPushError("git-push-failed", undefined, USERNAME); } });
}

test("W1-T9618: a round whose push failed records the failure on its done row and is never FIXED", async () => {
  const run = await usernameRound();
  assert.equal(run.done.length, 1, JSON.stringify(run.rows.map((r) => r.step)));
  const done = run.done[0]!;
  assert.equal(done.subtype, "push_failed");
  assert.equal(done.worker_subtype, "success", "the worker's own subtype is kept beside it");
  assert.equal(done.fix_outcome, "NOT_LANDED");
  assert.equal(done.worker_fix_outcome, "FIXED", "the worker's claim is kept beside it");
  assert.equal(done.push_outcome, "failed");
  assert.equal(done.push_failure_cause, "git-push-failed");
  assert.match(String(done.push_failure_reason), /could not read Username/);
  assert.equal(done.pushed_head_sha, undefined);
  assert.equal(run.ciWaits, 0, "no CI wait for a head that never landed");
  assert.equal(run.outcome.outcome, "stood_down");

  // A push that throws something other than FixRoundPushError still leaves a not-landed done row before it propagates.
  const repo = gitRepo({ kind: "w1-t9618-throw" });
  await assert.rejects(round({ worktree: repo.dir, dispatchedHead: PRIOR, committed: ROUND,
    push: () => { throw new Error("spawn git ENOENT"); } }).then((r) => r), /ENOENT/);
});

test("W1-T9618: a push that returned but left the remote on another head is not landed", async () => {
  const repo = gitRepo({ kind: "w1-t9618-stale" });
  const run = await round({ worktree: repo.dir, dispatchedHead: PRIOR, committed: ROUND, push: () => {},
    readRemoteBranchHead: async () => PRIOR });
  const done = run.done[0]!;
  assert.equal(done.push_outcome, "not_on_remote");
  assert.equal(done.fix_outcome, "NOT_LANDED");
  assert.equal(done.subtype, "push_failed");
  assert.equal(done.remote_head_sha, PRIOR, "the head the remote still holds is named");
  assert.match(String(done.push_failure_reason), new RegExp(`holds ${PRIOR}`));
  assert.equal(done.pushed_head_sha, undefined);
  assert.equal(run.ciWaits, 0, "the rung never waits on CI for the old head");
  assert.match(String(run.outcome.reason), /fix round push did not land \(not_on_remote\)/);

  // An unreadable remote is not evidence the commit landed either.
  const unread = await round({ worktree: gitRepo({ kind: "w1-t9618-unread" }).dir, dispatchedHead: PRIOR, committed: ROUND,
    push: () => {}, readRemoteBranchHead: async () => { throw new Error(USERNAME); } });
  assert.equal(unread.done[0]!.push_outcome, "remote_unreadable");
  assert.equal(unread.done[0]!.fix_outcome, "NOT_LANDED");
  // The control: the remote holds the round's commit, so the round landed and is FIXED.
  const landed = await round({ worktree: gitRepo({ kind: "w1-t9618-landed" }).dir, dispatchedHead: PRIOR, committed: ROUND,
    push: () => {}, readRemoteBranchHead: async () => ROUND });
  assert.equal(landed.done[0]!.push_outcome, "landed");
  assert.equal(landed.done[0]!.fix_outcome, "FIXED");
  assert.equal(landed.done[0]!.pushed_head_sha, ROUND);
  assert.equal(landed.ciWaits, 1);
});

test("W1-T9618: a round that did not land refunds its strike and the judge reads it as a no-op", async () => {
  const run = await usernameRound();
  const refund = run.rows.filter((r) => r.step === "fix.strike_refunded");
  assert.equal(refund.length, 1, JSON.stringify(run.rows.map((r) => r.step)));
  assert.equal(refund[0]!.reason, "push-not-landed");
  assert.equal(refund[0]!.push_outcome, "failed");
  const dispatch = run.rows.find((r) => r.step === "fix.dispatch")!;
  assert.equal(refund[0]!.strike, dispatch.strike);
  assert.equal(refund[0]!.head_sha, dispatch.head_sha);
  assert.equal(fixLedgerRowsForHead(run.rows, TASK, PRIOR).some((r) => r.step === "fix.dispatch"), false, "the refund drops the strike");
  assert.equal(fixRoundTally(run.rows, TASK, PRIOR).strikes, 0);
  assert.equal(run.outcome.strikes, 0, "the rung reports no strike spent");

  const input = buildFixProgressInput({ taskId: TASK, headSha: PRIOR, currentRed: ["review:the fix lands"], ledger: run.rows });
  assert.equal(input.signals.pushFailedRounds, 1);
  assert.equal(input.signals.noOpRounds, 1);
  assert.equal(input.signals.reviewerOnlyFailurePersists, 0);
  // A landed round carries no pushFailedRounds key, so an earlier escalation's input key is unchanged.
  const landed = buildFixProgressInput({ taskId: TASK, headSha: PRIOR, currentRed: [], ledger: [
    { step: "fix.dispatch", task_id: TASK, round_id: "r1", head_sha: PRIOR, strike: 1 },
    { step: "fix.done", task_id: TASK, round_id: "r1", head_sha: PRIOR, pushed_head_sha: ROUND, subtype: "success", fix_outcome: "FIXED" }] });
  assert.equal("pushFailedRounds" in landed.signals, false);
});

test("W1-T9618: the routing learner excludes a round that never reached the remote", async () => {
  const run = await usernameRound();
  const row = { provider: "claude", selected_model: "sonnet", ...run.done[0]! };
  const evidence = fixArmEvidence([row], Date.now());
  assert.equal(evidence.arms.length, 0, "a credential outage is not credited to the arm");
  assert.equal(evidence.pushFailedExcluded, 1);
  // The control: the same row before W1-T9618 (FIXED, success, nothing pushed) was scored accepted.
  const legacy = fixArmEvidence([{ ...row, subtype: "success", fix_outcome: "FIXED" }], Date.now());
  assert.equal(legacy.arms.length, 1);
  assert.equal(legacy.pushFailedExcluded, 0);
});

test("W1-T9618: the default remote read sees a landed round in a real remote", async () => {
  const origin = gitRepo({ bare: true, kind: "w1-t9618-origin" });
  const lane = gitRepo({ cloneFrom: origin.dir, kind: "w1-t9618-lane" });
  const hooks = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9618-hooks-`));
  const savedHooks = process.env.RMD_HARNESS_HOOKS_DIR;
  process.env.RMD_HARNESS_HOOKS_DIR = hooks;
  try {
    writeFileSync(join(lane.dir, "README.md"), "seed\n");
    lane.git("add", "README.md");
    lane.git("commit", "-q", "-m", "seed");
    lane.git("push", "-q", "origin", "HEAD:refs/heads/main");
    // The lane is checked out on the run branch, as a fix worktree is: the un-leased push sends `HEAD` to it.
    lane.git("checkout", "-q", "-b", BRANCH);
    lane.git("push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
    const prior = lane.git("rev-parse", "HEAD");
    // The round's commit is made while the worker runs, as the harness does, after the rung read its head.
    let committed = "";
    const commitTheFix = () => {
      writeFileSync(join(lane.dir, "fix.ts"), "export const fixed = true;\n");
      lane.git("add", "fix.ts");
      lane.git("commit", "-q", "-m", "fix: repair the red");
      return (committed = lane.git("rev-parse", "HEAD"));
    };
    // The production push, with no reader injected: what reaches the remote is read back from the remote.
    const run = await withLiveWritesAllowed(() => round({ worktree: lane.dir, dispatchedHead: prior, committed: commitTheFix,
      push: (wt, branch, sha) => pushFixRound(wt, branch, sha) }));
    assert.equal(origin.git("rev-parse", `refs/heads/${BRANCH}`), committed, "the commit is on the remote");
    const done = run.done[0]!;
    assert.equal(done.push_outcome, "landed", JSON.stringify(done));
    assert.equal(done.remote_head_sha, committed);
    assert.equal(done.pushed_head_sha, committed);
    assert.equal(done.fix_outcome, "FIXED");
    assert.equal(run.rows.some((r) => r.step === "fix.strike_refunded"), false);
    assert.equal(run.ciWaits, 1);
    // A test double that never contacted a remote is recorded as unverified, never judged against one.
    const stub = await round({ worktree: lane.dir, dispatchedHead: prior, committed, push: () => {} });
    assert.equal(stub.done[0]!.push_outcome, "unverified");
    assert.equal(stub.done[0]!.fix_outcome, "FIXED");
  } finally {
    if (savedHooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR; else process.env.RMD_HARNESS_HOOKS_DIR = savedHooks;
    origin.cleanup();
    lane.cleanup();
  }
});
