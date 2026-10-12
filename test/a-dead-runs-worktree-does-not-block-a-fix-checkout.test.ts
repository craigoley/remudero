/**
 * W1-T6355. A fix round's branch claim was declined as `registered_worktree_owner` whenever any
 * worktree held the branch with untracked paths, even after the run that owned it had ended (#10027,
 * W1-T6153). An owner whose claim is clear and whose process census is clear, with untracked paths and
 * NO tracked work, is now recorded into an immutable recovery ref, cleared, removed and reclaimed. A
 * live owner, or tracked work beside the untracked paths, still declines. Every fixture is a REAL git
 * repository built with porcelain commands and a repo-local identity.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSweepEffects,
  captureRegisteredFixOwnerSnapshot,
  decideRegisteredFixOwnerRecovery,
  preserveAndClearUntrackedFixOwner,
  preserveOrDiscardFixOwnerResidue,
  registeredFixWorktreeOwner,
  removeAbandonedFixWorktreeOwner,
  resetTrackedDirtyFixOwner,
  type BuildSweepEffectsDeps,
  type RegisteredFixOwnerSnapshot,
} from "../src/run-task.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { ghShim } from "./helpers/gh-shim.js";
import type { OpenPrView } from "../src/lib/sweep.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { WorkerResult } from "../src/lib/worker.js";

const TASK = "W1-T500";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function sha(repo: string, ref: string): string {
  return git(repo, "rev-parse", ref).trim();
}

function write(repo: string, file: string, body: string): void {
  writeFileSync(join(repo, file), body, "utf8");
}

function commitAll(repo: string, msg: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "--no-verify", "--quiet", "-m", msg);
}

interface Fixture {
  root: string;
  repoDir: string;
  worktreesRoot: string;
  ownerPath: string;
  branch: string;
}

function fixture(epoch: string, extraFiles: string[] = []): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t6355-"));
  const upstream = join(root, "upstream.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch", "main", upstream);
  const repoDir = join(root, "repos", "scratch-fbcs-repo");
  mkdirSync(join(root, "repos"), { recursive: true });
  git(root, "clone", "--quiet", upstream, repoDir);
  git(repoDir, "config", "user.email", "probe@example.invalid");
  git(repoDir, "config", "user.name", "probe");
  git(repoDir, "checkout", "--quiet", "-b", "main");
  write(repoDir, "seed.txt", "base\n");
  write(repoDir, "clean.txt", "base\n");
  for (const f of extraFiles) write(repoDir, f, "base\n");
  commitAll(repoDir, "chore: seed");
  git(repoDir, "push", "--quiet", "origin", "main");
  const branch = `run-${TASK}-${epoch}`;
  git(repoDir, "checkout", "--quiet", "-b", "other");
  write(repoDir, "seed.txt", "theirs\n");
  write(repoDir, "clean.txt", "theirs\n");
  commitAll(repoDir, "chore: theirs");
  git(repoDir, "checkout", "--quiet", "-b", branch, "main");
  write(repoDir, "seed.txt", "ours\n");
  commitAll(repoDir, "chore: ours");
  git(repoDir, "push", "--quiet", "origin", branch);
  git(repoDir, "checkout", "--quiet", "main");
  const worktreesRoot = join(root, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  const ownerPath = join(worktreesRoot, `sweep-${TASK}-${epoch}`);
  git(repoDir, "worktree", "add", "--quiet", ownerPath, branch);
  return { root, repoDir, worktreesRoot, ownerPath, branch };
}

const PLAN: Plan = (() => {
  const tasks = [
    { id: TASK, title: TASK, risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" } as unknown as Task,
  ];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
})();

const WORKER = {
  sessionId: "W1-T6355-PROBE",
  costUsd: 0,
  text: "REPORT\nresidue probe\n",
  blocks: [],
  stderr: "",
  subtype: "success",
  isError: false,
  apiError: false,
  verdict: "success",
  tokens: {},
  compactionEvents: [],
  childEnvKeys: [],
} as unknown as WorkerResult;

type Log = { step: string; extra?: Record<string, unknown> };

async function drive(
  f: Fixture,
  recovery: BuildSweepEffectsDeps["registeredOwnerRecovery"],
): Promise<{ logs: Log[]; threw: unknown }> {
  const pr = JSON.stringify({ state: "open", merged: false, head: { sha: "cafe1234", ref: f.branch }, base: { sha: "deadbeef" } });
  const shim = ghShim(
    [
      { when: "commits/cafe1234/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }) },
      { when: "commits/cafe1234/status", stdout: JSON.stringify({ state: "success", statuses: [] }) },
      { when: "headRefName", stdout: JSON.stringify({ headRefName: f.branch, headRefOid: "cafe1234", body: "" }) },
      { when: "pulls/9362", stdout: pr },
      { when: "", stdout: "{}" },
    ],
    { kind: "w1t6355" },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  const logs: Log[] = [];
  let threw: unknown;
  try {
    const effects = buildSweepEffects({
      resolveTaskContractAtHeadImpl: () => ({ criteria: [] }),
      owner: "acme",
      repo: "scratch-fbcs-repo",
      config: { root: f.root } as never,
      ledgerPath: join(f.root, "ledger.ndjson"),
      runId: "SWEEP-W1T6355",
      plan: PLAN,
      log: (step, extra) => void logs.push({ step, extra }),
      policy: DEFAULT_SWEEP_POLICY,
      spawnImpl: (async () => WORKER) as never,
      registeredWorktreeOwnerImpl: (repoDir: string, branchRef: string) => registeredFixWorktreeOwner(repoDir, branchRef),
      registeredOwnerRecovery: recovery,
    } as BuildSweepEffectsDeps);
    await effects.dispatchFix(
      {
        prNumber: 9362,
        prUrl: "https://github.com/acme/scratch-fbcs-repo/pull/9362",
        headSha: "cafe1234",
        headRefName: f.branch,
        taskId: TASK,
        reviewState: "none",
        checksState: "red",
        unmetCriteria: [],
        priorStrikes: 0,
        lastActivityAt: new Date().toISOString(),
      } as unknown as OpenPrView as never,
      { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "fixture failure" }] } as never,
    );
  } catch (e) {
    threw = e;
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
  return { logs, threw };
}


type Census = { claim?: "clear" | "occupied"; process?: "clear" | "occupied" };

function snapshotOf(f: Fixture, census: Census = {}): RegisteredFixOwnerSnapshot {
  const remoteSha = sha(f.repoDir, `origin/${f.branch}`);
  return captureRegisteredFixOwnerSnapshot(
    {
      repoDir: f.repoDir,
      worktreesRoot: f.worktreesRoot,
      ownerPath: f.ownerPath,
      taskId: TASK,
      branch: f.branch,
      expectedRemoteSha: remoteSha,
      observedRemoteSha: remoteSha,
      inflightDir: join(f.root, "inflight"),
      claimKey: "fixture",
    },
    {
      readClaim: () => census.claim ?? "clear",
      processCensus: () =>
        census.process === "occupied" ? { state: "occupied", scanned: 1, pid: 1 } : { state: "clear", scanned: 1 },
    },
  );
}

function recovery(f: Fixture, order: string[], census: Census = {}): NonNullable<BuildSweepEffectsDeps["registeredOwnerRecovery"]> {
  return {
    capture: () => snapshotOf(f, census),
    preserveTrackedDirty: (repoDir: string, ownerPath: string, branch: string, localSha: string) => {
      order.push("preserve-tracked");
      return preserveOrDiscardFixOwnerResidue(repoDir, ownerPath, branch, localSha);
    },
    preserveUntracked: (repoDir: string, ownerPath: string, branch: string, localSha: string) => {
      order.push("preserve-untracked");
      return preserveAndClearUntrackedFixOwner(repoDir, ownerPath, branch, localSha);
    },
    resetTrackedDirty: (_repoDir: string, ownerPath: string, _branch: string, localSha: string) => {
      order.push("reset");
      resetTrackedDirtyFixOwner(ownerPath, localSha);
    },
    remove: (repoDir: string, ownerPath: string) => {
      order.push("remove");
      removeAbandonedFixWorktreeOwner(repoDir, ownerPath);
    },
  };
}

const steps = (logs: Log[], step: string): Log[] => logs.filter((entry) => entry.step === step);

test("W1-T6355: an ended run worktree is reclaimed for the fix claim", async () => {
  const f = fixture("1791000000101");
  try {
    write(f.ownerPath, "stray.txt", "left behind by the ended run\n");
    mkdirSync(join(f.ownerPath, "nested"));
    write(join(f.ownerPath, "nested"), "deep.txt", "nested stray\n");
    const snapshot = snapshotOf(f);
    assert.equal(snapshot.treeState, "untracked_only");
    assert.deepEqual(decideRegisteredFixOwnerRecovery(snapshot), { kind: "preserve-untracked-dirty" });

    const order: string[] = [];
    const { logs, threw } = await drive(f, recovery(f, order));
    assert.equal(threw, undefined);
    assert.deepEqual(order, ["preserve-untracked", "remove"]);
    assert.equal(steps(logs, "sweep.fix.checkout_claim_declined").length, 0, "the claim is not declined");
    const released = steps(logs, "sweep.fix.checkout_owner_untracked_released");
    assert.equal(released.length, 1);
    const ref = String(released[0].extra?.recovery_ref);
    assert.match(ref, /^refs\/rmd-recovery\/fix-dirty\//);
    assert.equal(git(f.repoDir, "show", `${ref}:stray.txt`), "left behind by the ended run\n", "the untracked work is preserved");
    assert.equal(git(f.repoDir, "show", `${ref}:nested/deep.txt`), "nested stray\n");
    assert.equal(steps(logs, "sweep.fix.checkout_owner_reclaimed").length, 1);
    assert.equal(existsSync(f.ownerPath), false, "the ended run's worktree is released");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T6355: a live owner or tracked work still declines", async () => {
  const cases: Array<{ name: string; epoch: string; dirty: (f: Fixture) => void; census?: Census; reason: string }> = [
    {
      name: "live claim",
      epoch: "1791000000102",
      dirty: (f) => write(f.ownerPath, "stray.txt", "untracked\n"),
      census: { claim: "occupied" },
      reason: "live_branch_claim",
    },
    {
      name: "occupied cwd",
      epoch: "1791000000103",
      dirty: (f) => write(f.ownerPath, "stray.txt", "untracked\n"),
      census: { process: "occupied" },
      reason: "process_cwd_owner",
    },
    {
      name: "tracked change beside untracked",
      epoch: "1791000000104",
      dirty: (f) => {
        write(f.ownerPath, "seed.txt", "real work\n");
        write(f.ownerPath, "stray.txt", "untracked\n");
      },
      reason: "dirty_worktree",
    },
    {
      name: "staged change beside untracked",
      epoch: "1791000000105",
      dirty: (f) => {
        write(f.ownerPath, "clean.txt", "staged\n");
        git(f.ownerPath, "add", "--", "clean.txt");
        write(f.ownerPath, "clean.txt", "base\n");
        write(f.ownerPath, "stray.txt", "untracked\n");
      },
      reason: "dirty_worktree",
    },
  ];
  for (const c of cases) {
    const f = fixture(c.epoch);
    try {
      c.dirty(f);
      const before = git(f.ownerPath, "status", "--porcelain=v1", "--untracked-files=all");
      const order: string[] = [];
      const { logs, threw } = await drive(f, recovery(f, order, c.census));
      assert.equal(threw, undefined, c.name);
      const declined = steps(logs, "sweep.fix.checkout_claim_declined");
      assert.equal(declined.length, 1, c.name);
      assert.equal(declined[0].extra?.owner_recovery_reason, c.reason, c.name);
      assert.deepEqual(order, [], `${c.name}: nothing preserved, reset or removed`);
      assert.equal(steps(logs, "fix.dispatch").length, 0, c.name);
      assert.equal(git(f.ownerPath, "status", "--porcelain=v1", "--untracked-files=all"), before, `${c.name}: the owner is untouched`);
      assert.equal(readFileSync(join(f.ownerPath, "stray.txt"), "utf8"), "untracked\n", c.name);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("W1-T6355: untracked paths beside a head the PR has not contained stay a no-touch decline", () => {
  const f = fixture("1791000000106");
  try {
    write(f.ownerPath, "stray.txt", "untracked\n");
    const snapshot = snapshotOf(f);
    for (const historyState of ["ahead", "diverged"] as const) {
      assert.deepEqual(decideRegisteredFixOwnerRecovery({ ...snapshot, historyState }), { kind: "keep", reason: "dirty_worktree" });
    }
    assert.throws(
      () => {
        write(f.ownerPath, "seed.txt", "tracked\n");
        preserveAndClearUntrackedFixOwner(f.repoDir, f.ownerPath, f.branch, snapshot.localSha!);
      },
      /tracked work beside its untracked paths/,
    );
    assert.equal(readFileSync(join(f.ownerPath, "stray.txt"), "utf8"), "untracked\n");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
