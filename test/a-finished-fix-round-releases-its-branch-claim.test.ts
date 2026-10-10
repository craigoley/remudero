/**
 * W1-T5955. #9450 (W1-T5538): the sweep's fix round took its branch claim at 02:45:43, wrote
 * fix.done at 03:12:52, then sat in `waitForCiGreen` until fix.ci_not_green at 03:46:21. The
 * claim lived until `runFixRung` returned (~03:47), so every repair from 03:31 on was declined
 * registered_worktree_owner / live_branch_claim. The holder was the daemon's pid and run id,
 * which outlive every round, so nothing could tell a finished round from a live one.
 *
 * A round now ends at its fix.done: the claim is released there, named on that row, re-taken
 * before the worktree is reused, and a claim whose round wrote its end row reads clear.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSweepEffects,
  captureRegisteredFixOwnerSnapshot,
  fixBranchClaimKey,
  harnessCommitForShellLessWorker,
  readRegisteredFixOwnerClaim,
  registeredFixWorktreeOwner,
  removeAbandonedFixWorktreeOwner,
  runFixRung,
  type BuildSweepEffectsDeps,
} from "./helpers/run-task-test.js";
import {
  DEFAULT_SWEEP_POLICY,
  acquireFixRoundClaim,
  fixRoundBranchClaim,
  fixRoundClaimEnded,
  fixRoundClaimId,
  reclaimFixRoundBranch,
  type OpenPrView,
} from "../src/lib/sweep.js";
import { InflightLockError, acquireInflightLock, inflightLockPath, readInflightLock } from "../src/lib/inflight-lock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { commitInsideFixture } from "./helpers/fixture-commit.js";
import { ghShim } from "./helpers/gh-shim.js";

const TASK = "W1-T500";
const PR = 9450;
const tmp = (kind: string): string => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5955-${kind}-`));
const holderOf = (dir: string, key: string): string | undefined => readInflightLock(dir, key)?.run_id;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function liveLock(dir: string, key: string, runId: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    inflightLockPath(dir, key),
    JSON.stringify({ pid: process.pid, run_id: runId, host: hostname(), startedAt: new Date().toISOString() }),
  );
}

function endRow(ledgerPath: string, step: string, claimRunId: string): void {
  writeFileSync(ledgerPath, `${JSON.stringify({ ts: new Date().toISOString(), step, branch_claim_run_id: claimRunId })}\n`, { flag: "a" });
}

// ── the claim reader and its seams ───────────────────────────────────────────────────────

test("a claim whose round wrote its end row reads clear, though the daemon pid holding it is alive", () => {
  const root = tmp("reader");
  const key = "fix-branch--acme--repo--run-W1-T500-1";
  const ledger = join(root, "ledger.ndjson");
  const ended = (id: string) => fixRoundClaimEnded(ledger, id);
  try {
    liveLock(root, key, "DAEMON-1:fix-claim:9450:1");
    assert.equal(readRegisteredFixOwnerClaim(root, key, ended), "occupied", "no end row: the round is live");
    assert.equal(readRegisteredFixOwnerClaim(root, key), "occupied", "no round reader: the pid alone decides, as before");
    endRow(ledger, "fix.done", "DAEMON-1:fix-claim:9450:1");
    assert.equal(readRegisteredFixOwnerClaim(root, key, ended), "clear");
    assert.equal(readRegisteredFixOwnerClaim(root, key), "occupied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixRoundClaimEnded reads only an end row naming exactly that claim", () => {
  const root = tmp("ended");
  const ledger = join(root, "ledger.ndjson");
  try {
    assert.equal(fixRoundClaimEnded(ledger, "R:fix-claim:1:1"), false, "no ledger yet");
    writeFileSync(ledger, "{torn\n");
    endRow(ledger, "fix.dispatch", "R:fix-claim:1:1");
    endRow(ledger, "fix.done", "R:fix-claim:1:10");
    assert.equal(fixRoundClaimEnded(ledger, "R:fix-claim:1:1"), false, "a dispatch row, or a longer id, is not this round's end");
    endRow(ledger, "sweep.fix.error", "R:fix-claim:1:1");
    assert.equal(fixRoundClaimEnded(ledger, "R:fix-claim:1:1"), false, "a thrown round is released by its finally, not read back");
    endRow(ledger, "fix.done", "R:fix-claim:1:1");
    assert.equal(fixRoundClaimEnded(ledger, "R:fix-claim:1:1"), true);
    assert.equal(fixRoundClaimEnded(ledger, "R:fix-claim:1:10"), true);
    assert.equal(fixRoundClaimId("DAEMON-7", 9450, 123), "DAEMON-7:fix-claim:9450:123");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquireFixRoundClaim clears an ended round's claim and refuses a live one", () => {
  const root = tmp("acquire");
  const key = "fix-branch--acme--repo--run-W1-T500-2";
  try {
    liveLock(root, key, "OLD");
    assert.throws(() => acquireFixRoundClaim(root, key, "NEW", () => false), InflightLockError);
    assert.equal(holderOf(root, key), "OLD");
    const taken = acquireFixRoundClaim(root, key, "NEW", (id) => id === "OLD");
    assert.equal(taken.endedRunId, "OLD");
    assert.equal(holderOf(root, key), "NEW");
    taken.handle.release();
    const fresh = acquireFixRoundClaim(root, key, "FRESH", () => true);
    assert.equal(fresh.endedRunId, undefined, "nothing was held, so nothing was cleared");
    fresh.handle.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reclaimFixRoundBranch stands down by name on every arm and rethrows a lock error it cannot name", () => {
  const root = tmp("retake");
  const key = "fix-branch--acme--repo--run-W1-T500-3";
  const base = { inflightDir: root, claimKey: key, claimRunId: "R2", roundEnded: () => false };
  try {
    assert.match(
      String(reclaimFixRoundBranch({ ...base, ownsWorktree: () => { throw new Error("registry gone"); } })),
      /this round's worktree is unreadable: registry gone/,
    );
    assert.equal(reclaimFixRoundBranch({ ...base, ownsWorktree: () => false }), "a later round reclaimed this round's worktree");
    liveLock(root, key, "SUCCESSOR");
    assert.equal(reclaimFixRoundBranch({ ...base, ownsWorktree: () => true }), "branch claim held by SUCCESSOR");
    rmSync(inflightLockPath(root, key));
    const handle = reclaimFixRoundBranch({ ...base, ownsWorktree: () => true });
    assert.equal(typeof handle, "object");
    assert.equal(holderOf(root, key), "R2");
    if (typeof handle === "object") handle.release();
    const notADir = join(root, "file");
    writeFileSync(notADir, "");
    assert.throws(() => reclaimFixRoundBranch({ ...base, inflightDir: notADir, ownsWorktree: () => true }), /EEXIST|ENOTDIR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixRoundBranchClaim releases each claim it holds exactly once and re-takes only when released", () => {
  const root = tmp("hold");
  const key = "fix-branch--acme--repo--run-W1-T500-4";
  let retakes = 0;
  try {
    const hold = fixRoundBranchClaim(acquireInflightLock(root, key, { run_id: "R1" }), () => {
      retakes += 1;
      return retakes === 1 ? acquireInflightLock(root, key, { run_id: "R2" }) : "refused";
    });
    assert.equal(hold.reacquire(), undefined);
    assert.equal(retakes, 0, "a held claim is not re-taken");
    assert.equal(hold.id(), "R1");
    hold.release();
    assert.equal(hold.id(), undefined);
    assert.equal(existsSync(inflightLockPath(root, key)), false);
    const other = acquireInflightLock(root, key, { run_id: "OTHER" });
    hold.release();
    assert.equal(holderOf(root, key), "OTHER", "a second release never removes another round's claim");
    other.release();
    assert.equal(hold.reacquire(), undefined);
    assert.equal(hold.id(), "R2");
    assert.equal(hold.last().info.run_id, "R2");
    hold.release();
    assert.equal(hold.reacquire(), "refused");
    assert.equal(hold.last().info.run_id, "R2", "a refused re-take keeps the last claim for the record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── runFixRung: the round ends at its fix.done ───────────────────────────────────────────

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };

function worker(text: string): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

function failedReview(): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  const criterion: CriterionVerdict = { claim: "the claim is released", proof: "unit test: released", met: false, reason: "still blocked", proof_exec: "not_executable" };
  return { state: "failure", criteria: [criterion], testTheater: false, summary: "blocked", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure" };
}

function issues(): IssueGateway {
  return { create: () => "https://github.com/acme/remudero/issues/1", listOpen: (): OpenIssue[] => [], comment: () => {} };
}

function rung(root: string, claim: ReturnType<typeof fixRoundBranchClaim>, waitForCiGreen: () => Promise<"green" | "red">) {
  const lines: Array<{ step: string } & Record<string, unknown>> = [];
  let commits = 0;
  const run = {
    taskId: "W1-T5955X", runId: "DAEMON-5955", task: { id: "W1-T5955X", title: "release", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/9450", branch: "run-W1-T5955X-1", worktreePath: process.cwd(),
    initialSessionId: "initial-session", mount: MOUNT, settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config, budgetUsd: 10, strikeCap: 2,
    initialReview: failedReview(),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
    deps: {
      spawn: async (_args: SpawnWorkerArgs) => worker("REPORT\nfixed\nCOMMIT_MESSAGE: fix(ci): repair the check"),
      waitForCiGreen,
      fetchCiFailures: async () => [{ name: "ci", logTail: "still red" }] as never,
      runReview: async () => failedReview(),
      fetchPrBody: async () => "REPORT",
      push: () => {},
      issues: issues(),
      ledgerPath: join(root, "ledger.ndjson"),
      log: (step: string, extra?: Record<string, unknown>) => lines.push({ step, ...(extra ?? {}) }),
      say: () => {},
      account: (result: WorkerResult) => result,
      worktreeHasUncommittedChanges: () => true,
      harnessCommitForShellLessWorker: (input: Parameters<typeof harnessCommitForShellLessWorker>[0]) =>
        harnessCommitForShellLessWorker(input, { commit: () => ({ committed: true, sha: `new-head-${++commits}`, undeclared: [] }), ahead: () => 1 }),
      branchClaim: claim,
    },
  };
  return { run, lines };
}

test("a pushed round releases its claim at fix.done, so the next round claims the branch during the CI wait", async () => {
  const root = tmp("rung-yield");
  const key = fixBranchClaimKey("acme", "remudero", "run-W1-T5955X-1");
  const dir = join(root, "inflight");
  let successor: ReturnType<typeof acquireInflightLock> | undefined;
  try {
    const claim = fixRoundBranchClaim(acquireInflightLock(dir, key, { run_id: "R1" }), () =>
      reclaimFixRoundBranch({ inflightDir: dir, claimKey: key, claimRunId: "R2", roundEnded: () => false, ownsWorktree: () => true }));
    const { run, lines } = rung(root, claim, async () => {
      assert.equal(existsSync(inflightLockPath(dir, key)), false, "the CI wait holds no claim");
      successor = acquireInflightLock(dir, key, { run_id: "SUCCESSOR" });
      return "red";
    });
    const outcome = await runFixRung(run as never);
    const done = lines.filter((l) => l.step === "fix.done");
    assert.equal(done.length, 1);
    assert.equal(done[0].branch_claim_run_id, "R1", "fix.done names the claim it ends");
    assert.equal(lines.filter((l) => l.step === "fix.dispatch").length, 1, "no second strike on a branch another round holds");
    const stood = lines.filter((l) => l.step === "fix.stood_down");
    assert.deepEqual(stood.map((l) => [l.site, l.reason]), [["rung.branch_claim", "branch claim held by SUCCESSOR"]]);
    assert.equal(outcome.outcome, "stood_down");
    assert.equal(holderOf(dir, key), "SUCCESSOR", "the successor's claim is untouched");
  } finally {
    successor?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a round re-takes its claim for the next strike, and each fix.done names and releases its own", async () => {
  const root = tmp("rung-retake");
  const key = fixBranchClaimKey("acme", "remudero", "run-W1-T5955X-1");
  const dir = join(root, "inflight");
  let n = 1;
  let waits = 0;
  try {
    const claim = fixRoundBranchClaim(acquireInflightLock(dir, key, { run_id: "R1" }), () =>
      reclaimFixRoundBranch({ inflightDir: dir, claimKey: key, claimRunId: `R${++n}`, roundEnded: () => false, ownsWorktree: () => true }));
    const { run, lines } = rung(root, claim, async () => {
      assert.equal(existsSync(inflightLockPath(dir, key)), false, `wait ${++waits} holds no claim`);
      return waits === 1 ? "red" : "green";
    });
    await runFixRung(run as never);
    assert.equal(waits, 2);
    assert.deepEqual(lines.filter((l) => l.step === "fix.done").map((l) => l.branch_claim_run_id), ["R1", "R2"]);
    assert.equal(lines.filter((l) => l.step === "fix.dispatch").length, 2);
    assert.equal(holderOf(dir, key), "R3", "the review after the last wait runs under a re-taken claim");
    claim.release();
    claim.release();
    assert.equal(existsSync(inflightLockPath(dir, key)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the sweep's dispatchFix, driven for real ─────────────────────────────────────────────

interface Fixture { root: string; repoDir: string; branch: string; inflightDir: string; key: string; ledger: string }

function fixture(epoch: string, ownerEpoch?: string): Fixture {
  const root = tmp("sweep");
  const upstream = join(root, "upstream.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch", "main", upstream);
  const repoDir = join(root, "repos", "scratch-fbcs-repo");
  mkdirSync(join(root, "repos"), { recursive: true });
  git(root, "clone", "--quiet", upstream, repoDir);
  git(repoDir, "config", "user.email", "probe@example.invalid");
  git(repoDir, "config", "user.name", "probe");
  git(repoDir, "checkout", "--quiet", "-b", "main");
  writeFileSync(join(repoDir, "seed.txt"), "base\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "--no-verify", "--quiet", "-m", "chore: seed");
  git(repoDir, "push", "--quiet", "origin", "main");
  const branch = `run-${TASK}-${epoch}`;
  git(repoDir, "checkout", "--quiet", "-b", branch);
  writeFileSync(join(repoDir, "seed.txt"), "ours\n");
  git(repoDir, "commit", "--no-verify", "--quiet", "-am", "chore: ours");
  git(repoDir, "push", "--quiet", "origin", branch);
  git(repoDir, "checkout", "--quiet", "main");
  mkdirSync(join(root, "worktrees"), { recursive: true });
  if (ownerEpoch) git(repoDir, "worktree", "add", "--quiet", join(root, "worktrees", `sweep-${TASK}-${ownerEpoch}`), branch);
  const inflightDir = join(root, "state", "inflight");
  return { root, repoDir, branch, inflightDir, key: fixBranchClaimKey("acme", "scratch-fbcs-repo", branch), ledger: join(root, "ledger.ndjson") };
}

const PLAN: Plan = (() => {
  const tasks = [{ id: TASK, title: TASK, risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" } as unknown as Task];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
})();

const WORKER = worker("REPORT\nprobe\n");
type Log = { step: string; extra?: Record<string, unknown> };

/** The real owner capture over the real worktree. Only the remote sha (the stub reports a fake one)
 *  and the process census are pinned; the claim is read by the production reader. */
function recovery(f: Fixture): NonNullable<BuildSweepEffectsDeps["registeredOwnerRecovery"]> {
  return {
    capture: (args: Parameters<typeof captureRegisteredFixOwnerSnapshot>[0]) => {
      const remote = git(f.repoDir, "rev-parse", `origin/${f.branch}`).trim();
      return captureRegisteredFixOwnerSnapshot(
        { ...args, expectedRemoteSha: remote, observedRemoteSha: remote },
        { processCensus: () => ({ state: "clear", scanned: 1 }) },
      );
    },
    remove: (repoDir: string, ownerPath: string) => removeAbandonedFixWorktreeOwner(repoDir, ownerPath),
  };
}

async function withSweep(
  f: Fixture,
  spawnImpl: (args: SpawnWorkerArgs) => Promise<WorkerResult>,
  body: (dispatch: () => Promise<unknown>, logs: Log[]) => Promise<void>,
  extra: Partial<BuildSweepEffectsDeps> = {},
  onLog: (step: string) => void = () => {},
): Promise<void> {
  const shim = ghShim(
    [
      { when: "commits/cafe1234/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }) },
      { when: "commits/cafe1234/status", stdout: JSON.stringify({ state: "success", statuses: [] }) },
      { when: "headRefName", stdout: JSON.stringify({ headRefName: f.branch, headRefOid: "cafe1234", body: "" }) },
      { when: `pulls/${PR}`, stdout: JSON.stringify({ state: "open", merged: false, head: { sha: "cafe1234", ref: f.branch }, base: { sha: "deadbeef" } }) },
      { when: "", stdout: "{}" },
    ],
    { kind: "w1t5955" },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  const logs: Log[] = [];
  try {
    const effects = buildSweepEffects({
      resolveTaskContractAtHeadImpl: () => ({ criteria: [] }),
      owner: "acme",
      repo: "scratch-fbcs-repo",
      config: { root: f.root } as never,
      ledgerPath: f.ledger,
      runId: "SWEEP-W1T5955",
      plan: PLAN,
      log: (step, fields) => {
        onLog(step);
        logs.push({ step, extra: fields });
      },
      policy: DEFAULT_SWEEP_POLICY,
      spawnImpl: spawnImpl as never,
      registeredWorktreeOwnerImpl: (repoDir: string, branchRef: string) => registeredFixWorktreeOwner(repoDir, branchRef),
      registeredOwnerRecovery: recovery(f),
      ...extra,
    } as BuildSweepEffectsDeps);
    const pr = {
      prNumber: PR, prUrl: `https://github.com/acme/scratch-fbcs-repo/pull/${PR}`, headSha: "cafe1234", headRefName: f.branch,
      taskId: TASK, reviewState: "none", checksState: "red", unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(),
    } as unknown as OpenPrView;
    const evidence = { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "fixture failure" }] };
    await body(async () => effects.dispatchFix(pr as never, evidence as never), logs);
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

const steps = (logs: Log[], step: string): Log[] => logs.filter((entry) => entry.step === step);
const CLAIM_ID = new RegExp(`^SWEEP-W1T5955:fix-claim:${PR}:\\d+$`);

test("a finished round releases its claim and names it on fix.done, so the next round on that PR claims the branch", async () => {
  const f = fixture("1791000000101");
  try {
    await withSweep(f, async () => WORKER, async (dispatch, logs) => {
      await dispatch();
      const done = steps(logs, "fix.done");
      assert.equal(done.length, 1, JSON.stringify(logs.map((l) => l.step)));
      assert.match(String(done[0].extra?.branch_claim_run_id), CLAIM_ID);
      assert.equal(existsSync(inflightLockPath(f.inflightDir, f.key)), false);
      await dispatch();
      assert.deepEqual(steps(logs, "sweep.fix.checkout_claim_declined"), []);
      assert.equal(steps(logs, "fix.dispatch").length, 2, "the next round claimed the branch and dispatched");
      assert.notEqual(steps(logs, "fix.done")[1].extra?.branch_claim_run_id, done[0].extra?.branch_claim_run_id, "each round has its own claim");
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a detached round holds its claim while live, declines a concurrent repair, and releases when it settles", async () => {
  const f = fixture("1791000000102");
  let entered!: () => void;
  const inWorker = new Promise<void>((resolve) => (entered = resolve));
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  let calls = 0;
  try {
    await withSweep(f, async () => {
      if (++calls === 1) {
        entered();
        await gate;
      }
      return WORKER;
    }, async (dispatch, logs) => {
      const detached = dispatch();
      await inWorker;
      const holder = holderOf(f.inflightDir, f.key);
      assert.match(String(holder), CLAIM_ID);
      assert.equal(readRegisteredFixOwnerClaim(f.inflightDir, f.key, (id) => fixRoundClaimEnded(f.ledger, id)), "occupied", "a live round reads occupied");
      await dispatch();
      const declined = steps(logs, "sweep.fix.checkout_claim_declined");
      assert.equal(declined.length, 1);
      assert.equal(declined[0].extra?.owner_recovery_reason, "live_branch_claim");
      finish();
      await detached;
      assert.equal(existsSync(inflightLockPath(f.inflightDir, f.key)), false, "the detached round released on settling");
      assert.match(String(steps(logs, "fix.done")[0]?.extra?.branch_claim_run_id), CLAIM_ID);
      await dispatch();
      assert.equal(steps(logs, "sweep.fix.checkout_claim_declined").length, 1, "no further decline");
      assert.equal(steps(logs, "fix.dispatch").length, 2);
    });
  } finally {
    finish?.();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a thrown round releases its claim and its sweep.fix.error names it", async () => {
  const f = fixture("1791000000103");
  try {
    await withSweep(f, async () => {
      throw new Error("spawn exploded");
    }, async (dispatch, logs) => {
      await dispatch().catch((e: unknown) => assert.match(String(e), /spawn exploded/));
      const errors = steps(logs, "sweep.fix.error");
      assert.equal(errors.length, 1, JSON.stringify(logs.map((l) => l.step)));
      assert.match(String(errors[0].extra?.branch_claim_run_id), CLAIM_ID);
      assert.equal(existsSync(inflightLockPath(f.inflightDir, f.key)), false);
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("#9450: an ended round's leftover claim and worktree are reclaimed, and the repair dispatches", async () => {
  const ended = "DAEMON-1791254466681:fix-claim:9450:1791254743002";
  for (const roundEnded of [false, true]) {
    const f = fixture(roundEnded ? "1791000000104" : "1791000000105", "1791254743002");
    try {
      liveLock(f.inflightDir, f.key, ended);
      if (roundEnded) endRow(f.ledger, "fix.done", ended);
      await withSweep(f, async () => WORKER, async (dispatch, logs) => {
        await dispatch();
        if (!roundEnded) {
          const declined = steps(logs, "sweep.fix.checkout_claim_declined");
          assert.equal(declined[0]?.extra?.owner_recovery_reason, "live_branch_claim");
          assert.equal(steps(logs, "fix.dispatch").length, 0);
          assert.equal(holderOf(f.inflightDir, f.key), ended, "a live round's claim is kept");
          return;
        }
        assert.deepEqual(steps(logs, "sweep.fix.checkout_claim_declined"), []);
        assert.equal(steps(logs, "sweep.fix.checkout_owner_reclaimed").length, 1);
        const cleared = steps(logs, "sweep.fix.ended_round_claim_reclaimed");
        assert.deepEqual(cleared.map((l) => l.extra?.holder_run_id), [ended]);
        assert.equal(steps(logs, "fix.dispatch").length, 1);
        assert.equal(existsSync(inflightLockPath(f.inflightDir, f.key)), false);
        assert.match(readFileSync(f.ledger, "utf8"), /fix\.done/);
      });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("a real sweep round's push frees the claim for its CI wait, and the round re-takes it after", async () => {
  const f = fixture("1791000000106");
  const seen: Array<[string, string | undefined]> = [];
  try {
    await withSweep(f, async (args) => {
      commitInsideFixture(f.root, args.cwd, "fix.txt", "fix(ci): repair the check");
      return worker("REPORT\nfixed\nCOMMIT_MESSAGE: fix(ci): repair the check");
    }, async (dispatch, logs) => {
      await dispatch();
      const first = steps(logs, "fix.done")[0]?.extra?.branch_claim_run_id;
      assert.match(String(first), CLAIM_ID, JSON.stringify(logs.map((l) => l.step)));
      const wait = seen.find(([step]) => step === "ci-wait");
      assert.deepEqual(wait, ["ci-wait", undefined], "the CI wait holds no claim");
      const after = seen.find(([step]) => step === "fix.ci_not_green");
      assert.match(String(after?.[1]), CLAIM_ID, "the round re-took the branch after its wait");
      assert.notEqual(after?.[1], first, "under a fresh claim");
      assert.equal(existsSync(inflightLockPath(f.inflightDir, f.key)), false, "and released it when the round ended");
    }, {
      pushFixRoundImpl: async () => undefined,
      waitForCiGreenImpl: async () => {
        seen.push(["ci-wait", holderOf(f.inflightDir, f.key)]);
        return "red";
      },
    }, (step) => {
      if (step === "fix.ci_not_green") seen.push([step, holderOf(f.inflightDir, f.key)]);
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
