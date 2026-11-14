/**
 * W1-T12537. From 2026-11-11 21:45Z to 2026-11-13 21:45Z, 30 sweep fix rounds made a fixed commit and then stood down
 * with "a later round reclaimed this round's worktree". Each loss came seconds after another run's start-up prune named
 * the live `sweep-<task>-<ms>` worktree as removed: `pruneStaleRuns` force-removes a `run-*` worktree with no live run
 * lock once it is older than the grace, and only the run lane wrote that lock.
 *
 * The round is the real `dispatchFix`, over a real bare origin. Inside its fix worker the test commits, ages the
 * worktree past the grace, and runs the daemon lane's real start-up prune (`createDaemonLaneWorktree`). The push is a
 * real `git push` of the round's head.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { DEFAULT_SWEEP_POLICY, type OpenPrView } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { DEFAULT_PRUNE_GRACE_MS, readRunLock, runLockPath, writeRunLock, type RunLockRead, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { commitInsideFixture } from "#test/helpers/fixture-commit.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { originWithClone } from "#test/helpers/git-repo.js";
import {
  buildSweepEffects,
  captureRegisteredFixOwnerSnapshot,
  createDaemonLaneWorktree,
  registeredFixWorktreeOwner,
  removeAbandonedFixWorktreeOwner,
  type BuildSweepEffectsDeps,
} from "#test/helpers/run-task-test.js";

const TASK = "W1-T12537";
const PR = 18537;
const REPO = "scratch-t12537-repo";
const SWEEP_RUN_ID = "SWEEP-W1T12537";
type Row = { step: string } & Record<string, unknown>;

interface Fixture { root: string; repoDir: string; origin: string; branch: string; worktreesRoot: string; ledger: string }

function fixture(epoch: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t12537-`));
  mkdirSync(join(root, "repos"), { recursive: true });
  const repoDir = join(root, "repos", REPO);
  const { origin, clone } = originWithClone(repoDir, { seed: { "seed.txt": "base\n" } });
  const branch = `run-${TASK}-${epoch}`;
  clone.git("checkout", "--quiet", "-b", branch);
  clone.git("commit", "--quiet", "--allow-empty", "-m", "chore: ours");
  clone.git("push", "--quiet", "origin", branch);
  clone.git("checkout", "--quiet", "main");
  const worktreesRoot = join(root, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  return { root, repoDir, origin: origin.dir, branch, worktreesRoot, ledger: join(root, "ledger.ndjson") };
}

function cleanup(f: Fixture): void {
  rmSync(f.root, { recursive: true, force: true });
  rmSync(f.origin, { recursive: true, force: true });
}

const PLAN: Plan = (() => {
  const tasks = [{ id: TASK, title: TASK, risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" } as unknown as Task];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
})();

function worker(text: string): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Age a worktree past the prune's grace, the state of every round that waits on CI longer than 120 s. */
function agePastGrace(path: string): void {
  const past = (Date.now() - DEFAULT_PRUNE_GRACE_MS - 60_000) / 1000;
  utimesSync(path, past, past);
}

/** The production registered-owner reader, with only the remote sha and the process census pinned. */
function recovery(f: Fixture): NonNullable<BuildSweepEffectsDeps["registeredOwnerRecovery"]> {
  return {
    capture: (args: Parameters<typeof captureRegisteredFixOwnerSnapshot>[0]) => {
      const remote = git(f.repoDir, "rev-parse", `origin/${f.branch}`);
      return captureRegisteredFixOwnerSnapshot(
        { ...args, expectedRemoteSha: remote, observedRemoteSha: remote },
        { processCensus: () => ({ state: "clear", scanned: 1 }) },
      );
    },
    remove: (repoDir: string, ownerPath: string) => removeAbandonedFixWorktreeOwner(repoDir, ownerPath),
  };
}

/** One real sweep fix round on the fixture's PR. */
async function dispatchRound(
  f: Fixture,
  spawnImpl: (args: SpawnWorkerArgs) => Promise<WorkerResult>,
  extra: Partial<BuildSweepEffectsDeps> = {},
): Promise<{ rows: Row[]; error?: unknown }> {
  const shim = ghShim(
    [
      { when: "commits/cafe1234/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }) },
      { when: "commits/cafe1234/status", stdout: JSON.stringify({ state: "success", statuses: [] }) },
      { when: "headRefName", stdout: JSON.stringify({ headRefName: f.branch, headRefOid: "cafe1234", body: "" }) },
      { when: `pulls/${PR}`, stdout: JSON.stringify({ state: "open", merged: false, head: { sha: "cafe1234", ref: f.branch }, base: { sha: "deadbeef" } }) },
      { when: "", stdout: "{}" },
    ],
    { kind: "w1t12537" },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  const rows: Row[] = [];
  try {
    const effects = buildSweepEffects({
      resolveTaskContractAtHeadImpl: () => ({ criteria: [] }),
      owner: "acme",
      repo: REPO,
      config: { root: f.root } as never,
      ledgerPath: f.ledger,
      runId: SWEEP_RUN_ID,
      plan: PLAN,
      log: (step, fields) => void rows.push({ step, ...(fields ?? {}) }),
      policy: DEFAULT_SWEEP_POLICY,
      spawnImpl: spawnImpl as never,
      registeredWorktreeOwnerImpl: (repoDir: string, branchRef: string) => registeredFixWorktreeOwner(repoDir, branchRef),
      registeredOwnerRecovery: recovery(f),
      waitForCiGreenImpl: async () => "red",
      ...extra,
    } as BuildSweepEffectsDeps);
    const pr = {
      prNumber: PR, prUrl: `https://github.com/acme/${REPO}/pull/${PR}`, headSha: "cafe1234", headRefName: f.branch,
      taskId: TASK, reviewState: "none", checksState: "red", unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(),
    } as unknown as OpenPrView;
    const evidence = { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "fixture failure" }] };
    try {
      await effects.dispatchFix(pr as never, evidence as never);
      return { rows };
    } catch (error) {
      return { rows, error };
    }
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

const RECLAIMED = "a later round reclaimed this round's worktree";

/** What the pruned round saw, once, for criteria 1, 2 and 5. */
interface PrunedRound {
  f: Fixture;
  rows: Row[];
  error?: unknown;
  worktree?: string;
  lockInWorker?: RunLockRead;
  otherRows: Row[];
  survivedPrune?: boolean;
  pushedFrom?: string;
  pushedHead?: string;
  lockAfter?: boolean;
}

let pruned: Promise<PrunedRound> | undefined;
function prunedRound(): Promise<PrunedRound> {
  pruned ??= (async () => {
    const f = fixture("1794600000001");
    const seen: PrunedRound = { f, rows: [], otherRows: [] };
    let calls = 0;
    const out = await dispatchRound(f, async (args) => {
      calls += 1;
      commitInsideFixture(f.root, args.cwd, `fix-${calls}.txt`, "fix(ci): repair the check");
      if (calls === 1) {
        seen.worktree = args.cwd;
        seen.lockInWorker = readRunLock(args.cwd!);
        agePastGrace(args.cwd!);
        // Another run starts: the daemon lane's own prune, at the default grace, before its add.
        await createDaemonLaneWorktree(f.repoDir, f.worktreesRoot, "DAEMON-W1T12537", (step, extra) =>
          void seen.otherRows.push({ step, ...(extra ?? {}) }));
        seen.survivedPrune = existsSync(join(args.cwd!, ".git"));
      }
      return worker("REPORT\nfixed\nCOMMIT_MESSAGE: fix(ci): repair the check");
    }, {
      pushFixRoundImpl: async (wt: string, branch: string) => {
        seen.pushedFrom ??= wt;
        seen.pushedHead = git(wt, "rev-parse", "HEAD");
        git(wt, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
        return undefined;
      },
    });
    seen.rows = out.rows;
    seen.error = out.error;
    seen.lockAfter = seen.worktree ? existsSync(runLockPath(seen.worktree)) : undefined;
    return seen;
  })();
  return pruned;
}

test.after(async () => {
  if (pruned) cleanup((await pruned).f);
});

const steps = (rows: Row[], step: string): Row[] => rows.filter((row) => row.step === step);
const real = (p: string): string => (existsSync(p) ? realpathSync(p) : p);

test("W1-T12537 criterion 1: a fix round's run lock is on disk beside its worktree and names this live process while the worker runs", async () => {
  const seen = await prunedRound();
  assert.equal(seen.error, undefined, String(seen.error));
  assert.ok(seen.worktree, JSON.stringify(seen.rows.map((r) => r.step)));
  assert.match(seen.worktree!, new RegExp(`/worktrees/sweep-${TASK}-\\d+$`));
  const lock = seen.lockInWorker!;
  assert.equal(lock.kind, "live", "the lock parsed");
  if (lock.kind !== "live") return;
  assert.equal(lock.info.pid, process.pid, "it names the process that runs the round");
  assert.equal(lock.info.run_id, SWEEP_RUN_ID);
  assert.ok(Number.isFinite(Date.parse(lock.info.startedAt)), "startedAt is a timestamp");
});

test("W1-T12537 criterion 2: another run's start-up prune keeps the round's worktree, names it in skipped, and the push lands", async () => {
  const seen = await prunedRound();
  const prune = steps(seen.otherRows, "worktree.prune");
  assert.equal(prune.length, 1, JSON.stringify(seen.otherRows));
  const skipped = (prune[0]!.skipped as string[]).map(real);
  const removed = (prune[0]!.worktrees as string[]).map(real);
  assert.ok(skipped.includes(real(seen.worktree!)), `the prune row names the kept worktree: ${JSON.stringify(prune[0])}`);
  assert.equal(removed.includes(real(seen.worktree!)), false);
  assert.equal(seen.survivedPrune, true, "the worktree is still there after the prune");
  assert.equal(seen.pushedFrom, seen.worktree, "the round pushed from its own worktree");
  assert.equal(git(seen.f.origin, "rev-parse", `refs/heads/${seen.f.branch}`), seen.pushedHead, "the PR branch holds the round's commit");
  assert.ok(steps(seen.rows, "fix.done").length >= 1, JSON.stringify(seen.rows.map((r) => r.step)));
  const lost = steps(seen.rows, "fix.stood_down").filter((r) => r.reason === RECLAIMED);
  assert.deepEqual(lost.map((r) => r.reason), [], "no stand-down for a reclaimed worktree");
});

test("W1-T12537 criterion 3: the run lock is removed on every exit path of the round", async () => {
  const seen = await prunedRound();
  assert.equal(seen.lockAfter, false, "a finished round leaves no lock");

  const thrown = fixture("1794600000003");
  try {
    let lockInWorker: RunLockRead | undefined;
    let lockFile = "";
    const out = await dispatchRound(thrown, async (args) => {
      lockFile = runLockPath(args.cwd!);
      lockInWorker = readRunLock(args.cwd!);
      throw new Error("spawn exploded");
    });
    assert.equal(steps(out.rows, "sweep.fix.error").length, 1, JSON.stringify(out.rows.map((r) => r.step)));
    assert.equal(lockInWorker?.kind, "live", "the lock was held while the worker ran");
    assert.equal(existsSync(lockFile), false, "a thrown round leaves no lock");
  } finally {
    cleanup(thrown);
  }

  const refused = fixture("1794600000004");
  try {
    let lockAtAdd: RunLockRead | undefined;
    let lockFile = "";
    const out = await dispatchRound(refused, async () => worker("REPORT\nunused\n"), {
      createFixRungWorktreeImpl: async (_repoDir: string, worktreePath: string) => {
        lockFile = runLockPath(worktreePath);
        lockAtAdd = readRunLock(worktreePath);
        throw new Error("worktree add failed");
      },
    });
    assert.match(String(out.error), /worktree add failed/);
    assert.equal(lockAtAdd?.kind, "live", "the lock was written before the add");
    assert.equal(existsSync(lockFile), false, "a round whose checkout failed leaves no lock");
  } finally {
    cleanup(refused);
  }
});

test("W1-T12537 criterion 4: a fix worktree whose run lock names a dead pid is still removed by the start-up prune, with its lock", async () => {
  const f = fixture("1794600000005");
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const deadPath = join(f.worktreesRoot, `sweep-${TASK}-1`);
    const livePath = join(f.worktreesRoot, `sweep-${TASK}-2`);
    git(f.repoDir, "worktree", "add", "--quiet", deadPath, f.branch);
    git(f.repoDir, "worktree", "add", "--quiet", "-b", `run-${TASK}-live`, livePath, "origin/main");
    writeRunLock(deadPath, { pid: dead, run_id: "DEAD-ROUND", startedAt: new Date().toISOString() });
    writeRunLock(livePath, { pid: process.pid, run_id: "LIVE-ROUND", startedAt: new Date().toISOString() });
    agePastGrace(deadPath);
    agePastGrace(livePath);
    const rows: Row[] = [];
    await createDaemonLaneWorktree(f.repoDir, f.worktreesRoot, "DAEMON-W1T12537-4", (step, extra) => void rows.push({ step, ...(extra ?? {}) }));
    const prune = steps(rows, "worktree.prune")[0]!;
    assert.ok((prune.worktrees as string[]).map(real).includes(real(deadPath)), JSON.stringify(prune));
    assert.equal(existsSync(join(deadPath, ".git")), false, "the dead owner's worktree is reclaimed");
    assert.equal(existsSync(runLockPath(deadPath)), false, "and its lock with it");
    assert.ok((prune.skipped as string[]).map(real).includes(real(livePath)), "a live owner's worktree is kept");
    assert.equal(existsSync(join(livePath, ".git")), true);
  } finally {
    cleanup(f);
  }
});

test("W1-T12537 criterion 5: the run lock sits outside the fix worktree, so the pushed commit carries no lock file", async () => {
  const seen = await prunedRound();
  const rel = relative(seen.worktree!, runLockPath(seen.worktree!));
  assert.ok(rel.startsWith(".."), `the lock is a sibling, not inside the worktree: ${rel}`);
  const files = git(seen.f.origin, "ls-tree", "-r", "--name-only", seen.pushedHead!).split("\n");
  assert.deepEqual(files.filter((name) => name.endsWith(".lock")), [], `pushed tree: ${files.join(", ")}`);
});
