/**
 * W1-T8141 — A PENDING RECYCLE ENDS A FIX WORKER'S ROUND AND KEEPS ITS WORK.
 *
 * On 2026-11-13 a container recycle wrote its PAUSE at 11:10:46Z and waited for work in flight. The fix round for
 * PR 18281 held its fix-branch claim until 12:03:47Z, and the recycle refused at 12:05:19Z. An implement round yields
 * to a pending recycle; a fix round had no such yield.
 *
 * These tests drive the production `runFixRung` with a real git checkout and its bare origin, and a real PAUSE file
 * in the config root. Only the worker spawn is a fake: it edits the checkout and then runs until it is stopped. The
 * recycle watch, the recovery ref, the reset and the ledger rows are the production code.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runFixRung } from "#test/helpers/run-task-test.js";
import { originWithClone, type GitRepo } from "#test/helpers/git-repo.js";
import { fixRoundTally, readPreservedOwnerPatch } from "#src/lib/sweep.js";
import { pauseFilePath, requestPause } from "#src/lib/fleet-control.js";
import { DEFAULT_POLL_INTERVAL_MS } from "#src/lib/poll-interval.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import type { Mount } from "#src/lib/mounts.js";
import type { ReviewVerdict } from "#src/lib/review.js";

const TASK = "W1-T8141X";
const BRANCH = "run-W1-T8141X-1";
const PR_NUMBER = 18281;
const PR_URL = `https://github.com/acme/remudero/pull/${PR_NUMBER}`;
/** The reason deploy/recycle-container.sh writes; `recyclePauseDetail` reads only this one as a recycle. */
const RECYCLE_REASON = "container recycle (deploy/recycle-container.sh)";

type Row = { step: string; task_id: string } & Record<string, unknown>;

interface Checkout {
  root: string;
  origin: GitRepo;
  clone: GitRepo;
  headSha: string;
}

/** A PR branch on a bare origin, checked out in the fix round's worktree, and a config root for the PAUSE file. */
function checkout(t: TestContext): Checkout {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t8141-root-`));
  const cloneDir = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t8141-wt-`)), "wt");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { origin, clone } = originWithClone(cloneDir, { scope: t, seed: { "src/a.ts": "a\n", "src/b.ts": "b\n" } });
  t.after(() => clone.cleanup());
  clone.git("checkout", "--quiet", "-b", BRANCH);
  clone.git("push", "--quiet", "origin", BRANCH);
  return { root, origin, clone, headSha: clone.git("rev-parse", "HEAD") };
}

/** gh and every other command stay unavailable, as in the W1-T5999 suite; git runs for real on the checkout. */
function onlyGitRuns(t: TestContext): void {
  const original = childProcess.execFileSync;
  t.mock.method(childProcess, "execFileSync", ((command: string, ...rest: unknown[]) => {
    if (command === "git") return (original as (...a: unknown[]) => unknown)(command, ...rest);
    throw new Error("test: only git runs");
  }) as typeof childProcess.execFileSync);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

function workerResult(runId: string, costUsd = 0): WorkerResult {
  return {
    provider: "codex", sessionId: `${runId}-session`, costUsd, numTurns: 1,
    text: "still working on the repair", blocks: [], stderr: "",
    subtype: "error_exit_null", isError: true, exit: { kind: "signal", signal: "SIGTERM" },
    apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

/** One fix round. `worker` runs as the spawn; it gets the spawn's args and the checkout. */
async function fixRound(t: TestContext, co: Checkout, runId: string,
  worker: (args: SpawnWorkerArgs) => Promise<WorkerResult>, extra: { priorPartialWork?: ReturnType<typeof readPreservedOwnerPatch> } = {}) {
  const rows: Row[] = [];
  let pushes = 0;
  const mount: Mount = { model: "sonnet", effort: "high", maxTurns: 20, contextBudget: 120000 };
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "repair the check", proof: "unit test: repair the check", met: false,
      reason: "still failing", proof_exec: "not_executable" }],
    testTheater: false, summary: "still failing", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: co.headSha, reviewerOutcome: "failure",
  };
  const outcome = await runFixRung({
    taskId: TASK, runId, task: { id: TASK, title: "repair the check", files: ["src/a.ts", "src/b.ts", "src/c.ts"] },
    prUrl: PR_URL, branch: BRANCH, worktreePath: co.clone.dir, initialSessionId: "writer-session", mount,
    settingsFile: join(co.root, "settings.json"), config: { root: co.root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    ciFailures: [{ name: "unit (1/1)", logTail: "test/a.test.ts failed" }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: co.clone.dir, reviewerMount: mount },
    ...(extra.priorPartialWork ? { priorPartialWork: extra.priorPartialWork } : {}),
    deps: {
      spawn: worker,
      waitForCiGreen: async () => "green", runReview: async () => review,
      fetchPrBody: async () => "REPORT", push: () => { pushes++; },
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} } as IssueGateway,
      ledgerPath: join(co.root, "ledger.ndjson"), log: (step, fields) => rows.push({ step, task_id: TASK, ...(fields ?? {}) }),
      readHeadShaForProvenance: () => co.headSha,
      say: () => {}, account: (result) => result,
    },
  });
  return { outcome, rows, pushes: () => pushes };
}

/** A worker that leaves one staged edit, one unstaged edit and one new file, then runs until it is stopped. */
function editingWorker(co: Checkout, seen: { signal?: AbortSignal; started?: () => void }, opts: { commit?: boolean } = {}) {
  return async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    seen.signal = args.signal;
    if (opts.commit) {
      writeFileSync(join(co.clone.dir, "src/d.ts"), "d committed\n");
      co.clone.git("add", "src/d.ts");
      co.clone.git("commit", "--quiet", "-m", "wip: part of the fix");
    }
    writeFileSync(join(co.clone.dir, "src/a.ts"), "a staged\n");
    co.clone.git("add", "src/a.ts");
    writeFileSync(join(co.clone.dir, "src/b.ts"), "b unstaged\n");
    writeFileSync(join(co.clone.dir, "src/c.ts"), "c new\n");
    seen.started?.();
    // Unstopped, it ends on its own after a while (real time), as a worker without a yield would.
    return new Promise<WorkerResult>((resolve, reject) => {
      const ownEnd = setTimeout(() => resolve(workerResult("DAEMON-1")), 10_000);
      args.signal?.addEventListener("abort", () => {
        clearTimeout(ownEnd);
        reject(Object.assign(new Error("worker aborted"), { name: "AbortError" }));
      }, { once: true });
    });
  };
}

/** Run a round under a recycle PAUSE: the watch's next poll sees it. */
async function yieldedRound(t: TestContext, opts: { commit?: boolean } = {}) {
  onlyGitRuns(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const co = checkout(t);
  requestPause(co.root, RECYCLE_REASON);
  const seen: { signal?: AbortSignal; started?: () => void } = {};
  const started = new Promise<void>((resolve) => { seen.started = resolve; });
  const round = fixRound(t, co, "DAEMON-1", editingWorker(co, seen, opts));
  await started;
  t.mock.timers.tick(DEFAULT_POLL_INTERVAL_MS);
  const result = await round;
  return { co, seen, ...result };
}

test("W1-T8141: a pending recycle ends a fix round and preserves its work", async (t) => {
  const { co, seen, rows, outcome } = await yieldedRound(t);
  assert.equal(seen.signal?.aborted, true, "the recycle stopped the worker");
  const yielded = rows.find((row) => row.step === "fix.round_yielded");
  assert.ok(yielded, "the round writes fix.round_yielded");
  assert.equal(yielded.trigger, "recycle");
  assert.equal(yielded.pr_number, PR_NUMBER);
  assert.equal(yielded.head_sha, co.headSha);
  const ref = String(yielded.recovery_ref);
  assert.ok(ref.startsWith(`refs/rmd-recovery/fix-dirty/${BRANCH}/${co.headSha}/`), ref);
  assert.deepEqual([...(yielded.paths as string[])].sort(), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.equal(co.clone.git("show", `${ref}:src/a.ts`), "a staged", "the staged edit is kept");
  assert.equal(co.clone.git("show", `${ref}:src/b.ts`), "b unstaged", "the unstaged edit is kept");
  assert.equal(co.clone.git("show", `${ref}:src/c.ts`), "c new", "the new file is kept");
  assert.equal(co.clone.git("rev-parse", `${ref}^`), co.headSha, "the ref's parent is the round's start head");
  assert.equal(co.clone.git("status", "--porcelain"), "", "the worktree is reset once the ref holds the work");
  assert.equal(co.clone.git("rev-parse", "HEAD"), co.headSha);
  const done = rows.filter((row) => row.step === "fix.done");
  assert.equal(done.length, 1);
  assert.equal(done[0]!.subtype, "round_yielded");
  assert.equal(done[0]!.recovery_ref, ref);
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.retainWorktree, undefined, "the work is in the ref, so the sweep may remove the worktree");
});

test("W1-T8141: a yielded fix round pushes nothing and costs no strike", async (t) => {
  // This worker also committed part of its fix on the PR branch before the recycle.
  const { co, rows, outcome, pushes } = await yieldedRound(t, { commit: true });
  assert.equal(pushes(), 0, "the round never reaches the push");
  assert.equal(co.origin.git("rev-parse", BRANCH), co.headSha, "the PR head on the origin did not move");
  assert.equal(co.clone.git("rev-parse", "HEAD"), co.headSha, "the worker's local commit is not left on the branch");
  const ref = String(rows.find((row) => row.step === "fix.round_yielded")?.recovery_ref);
  assert.equal(co.clone.git("show", `${ref}:src/d.ts`), "d committed", "the worker's commit is kept in the ref");
  assert.equal(rows.some((row) => row.step === "fix.dispatch"), false, "no fix.dispatch row, so no strike is counted");
  assert.equal(rows.some((row) => row.step === "fix.commit_refused"), false, "a yield is not a refusal");
  assert.equal(outcome.strikes, 0);
  const tally = fixRoundTally(rows, TASK, co.headSha, "executed");
  assert.equal(tally.strikes, 0);
  assert.deepEqual(tally.refusals, []);
});

test("W1-T8141: the next fix round is offered the preserved patch", async (t) => {
  const { co, rows } = await yieldedRound(t);
  const ref = String(rows.find((row) => row.step === "fix.round_yielded")?.recovery_ref);
  // The sweep's own reader (W1-T6434), on the rows this round wrote.
  const offered = readPreservedOwnerPatch({ repoDir: co.clone.dir, prNumber: PR_NUMBER, headSha: co.headSha, ledgerLines: rows });
  assert.ok(offered, "the sweep finds the preserved patch for this PR and head");
  assert.equal(offered.recoveryRef, ref);
  assert.match(offered.excerpt, /a staged/);
  assert.match(offered.excerpt, /b unstaged/);
  // The next round, after the recycle, shows it to its worker.
  rmSync(pauseFilePath(co.root), { force: true });
  let prompt = "";
  await fixRound(t, co, "DAEMON-2", async (args) => {
    prompt = args.prompt;
    return workerResult("DAEMON-2");
  }, { priorPartialWork: offered });
  assert.match(prompt, new RegExp(`RECOVERY REF: ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("W1-T8141: an operator pause does not end a fix round", async (t) => {
  onlyGitRuns(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const co = checkout(t);
  requestPause(co.root, "operator hold for host maintenance");
  let markStarted!: () => void;
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const round = fixRound(t, co, "DAEMON-1", async (args) => {
    signal = args.signal;
    markStarted();
    await new Promise<void>((done) => { finish = done; });
    return workerResult("DAEMON-1");
  });
  await started;
  t.mock.timers.tick(DEFAULT_POLL_INTERVAL_MS * 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal?.aborted, false, "the worker still runs under an operator PAUSE");
  finish();
  const { rows } = await round;
  assert.equal(rows.some((row) => row.step === "fix.round_yielded"), false);
  assert.equal(rows.find((row) => row.step === "fix.done")?.subtype, "signal_terminated", "the worker's own end closes the round");
});
