/**
 * W1-T5918. A proven-dead registered fix owner whose `git status` is dirty but whose working tree
 * equals HEAD (an interrupted merge's unmerged index, or staged-only content) made
 * `preserveTrackedDirtyFixOwner` throw "dirty owner has no HEAD-relative tracked diff", so the
 * sweep declined the PR's repair on every pass (#9362/#9379). The interrupted merge now has its
 * residue recorded, is reset, removed and reclaimed in the same pass; staged-only content with no
 * operation marker is refused by name. Every fixture is a REAL git repository built with porcelain
 * commands and a repo-local identity.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildSweepEffects,
  captureRegisteredFixOwnerSnapshot,
  decideRegisteredFixOwnerRecovery,
  preserveOrDiscardFixOwnerResidue,
  preserveTrackedDirtyFixOwner,
  registeredFixWorktreeOwner,
  removeAbandonedFixWorktreeOwner,
  resetTrackedDirtyFixOwner,
  type BuildSweepEffectsDeps,
  type RegisteredFixOwnerSnapshot,
} from "../src/run-task.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { ghShim } from "./helpers/gh-shim.js";
import type { FixOwnerResidue, OpenPrView } from "../src/lib/sweep.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { WorkerResult } from "../src/lib/worker.js";

const TASK = "W1-T500";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function sha(repo: string, ref: string): string {
  return git(repo, "rev-parse", ref).trim();
}

function status(repo: string): string {
  return git(repo, "status", "--porcelain=v1");
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

/** A bare upstream, a clone at `<root>/repos/<repo>` (the sweep's repoDir), and a pushed run
 *  branch checked out in a managed `sweep-<task>-<epoch>` owner worktree. */
function fixture(epoch: string, extraFiles: string[] = []): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t5918-"));
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

/** Shape (1): a conflicting `merge --no-commit`, then every path restored to HEAD. */
function interruptMerge(f: Fixture): void {
  assert.throws(() => git(f.ownerPath, "merge", "--no-commit", "--no-ff", "other"));
  git(f.ownerPath, "checkout", "--ours", "--", "seed.txt");
  git(f.ownerPath, "checkout", "HEAD", "--", "clean.txt");
}

/** Shape (2): staged content whose working copy was restored to HEAD. */
function stageOnly(f: Fixture, files: string[]): void {
  for (const file of files) write(f.ownerPath, file, "staged\n");
  git(f.ownerPath, "add", "--", ...files);
  for (const file of files) write(f.ownerPath, file, "base\n");
}

function mergeHeadPath(ownerPath: string): string {
  return resolve(ownerPath, git(ownerPath, "rev-parse", "--git-path", "MERGE_HEAD").trim());
}

function snapshotOf(
  f: Fixture,
  census: { claim?: "clear" | "occupied"; process?: "clear" | "occupied" } = {},
): RegisteredFixOwnerSnapshot {
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

test("W1-T5918: an interrupted merge reads as residue, not a throw, and resets clean for removal", () => {
  const f = fixture("1791000000001");
  try {
    interruptMerge(f);
    assert.match(status(f.ownerPath), /^UU seed\.txt$/m);
    const snapshot = snapshotOf(f);
    assert.equal(snapshot.treeState, "tracked_dirty");
    assert.deepEqual(decideRegisteredFixOwnerRecovery(snapshot), { kind: "preserve-tracked-dirty" });
    const localSha = snapshot.localSha!;
    assert.equal(git(f.ownerPath, "diff", "--binary", localSha), "", "the working tree equals HEAD");
    assert.throws(
      () => preserveTrackedDirtyFixOwner(f.repoDir, f.ownerPath, f.branch, localSha),
      /dirty owner has no HEAD-relative tracked diff/,
      "the W1-T3822 preserve alone still cannot hold this shape -- the #9362/#9379 decline",
    );

    const residue = preserveOrDiscardFixOwnerResidue(f.repoDir, f.ownerPath, f.branch, localSha) as FixOwnerResidue;
    assert.equal(typeof residue, "object");
    assert.equal(residue.markerKind, "MERGE_HEAD");
    assert.equal(residue.markerSha, sha(f.repoDir, "other"));
    assert.deepEqual(residue.unmergedPaths, ["seed.txt"]);
    assert.equal(residue.unmergedMore, 0);
    assert.deepEqual(residue.stagedPaths, []);
    assert.equal(residue.refusal, undefined);
    assert.match(residue.status, /UU seed\.txt/);
    assert.equal(
      git(f.repoDir, "for-each-ref", "refs/rmd-recovery/"),
      "",
      "nothing HEAD-relative exists, so no recovery ref is minted",
    );

    resetTrackedDirtyFixOwner(f.ownerPath, localSha);
    assert.equal(status(f.ownerPath), "");
    assert.equal(existsSync(mergeHeadPath(f.ownerPath)), false, "the reset clears MERGE_HEAD");
    removeAbandonedFixWorktreeOwner(f.repoDir, f.ownerPath);
    assert.equal(registeredFixWorktreeOwner(f.repoDir, `refs/heads/${f.branch}`), undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T5918: staged-only content without an operation marker is refused by name and left untouched", () => {
  const files = Array.from({ length: 23 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`);
  const f = fixture("1791000000002", files);
  try {
    stageOnly(f, files);
    assert.match(status(f.ownerPath), /^MM f00\.txt$/m);
    const snapshot = snapshotOf(f);
    assert.deepEqual(decideRegisteredFixOwnerRecovery(snapshot), { kind: "preserve-tracked-dirty" });
    const before = status(f.ownerPath);
    const residue = preserveOrDiscardFixOwnerResidue(f.repoDir, f.ownerPath, f.branch, snapshot.localSha!) as FixOwnerResidue;
    assert.equal(residue.refusal, "owner_dirty_staged_only_refused");
    assert.equal(residue.markerKind, null);
    assert.equal(residue.markerSha, null);
    assert.deepEqual(residue.unmergedPaths, []);
    assert.equal(residue.stagedPaths.length, 20, "the path list is bounded");
    assert.equal(residue.stagedMore, 3, "and the remainder is counted");
    assert.equal(residue.stagedPaths[0], "f00.txt");
    assert.equal(status(f.ownerPath), before, "a refusal mutates nothing");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T5918: a dirty owner WITH a HEAD-relative diff still takes the preserve path", () => {
  const f = fixture("1791000000003");
  try {
    write(f.ownerPath, "seed.txt", "real work\n");
    const snapshot = snapshotOf(f);
    const preserved = preserveOrDiscardFixOwnerResidue(f.repoDir, f.ownerPath, f.branch, snapshot.localSha!);
    assert.equal(typeof preserved, "string");
    assert.match(String(preserved), /^refs\/rmd-recovery\/fix-dirty\//);
    assert.equal(git(f.repoDir, "show", `${String(preserved)}:seed.txt`), "real work\n");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T5918: an unreadable or malformed operation marker throws rather than reading as absent", () => {
  const f = fixture("1791000000004");
  try {
    stageOnly(f, ["clean.txt"]);
    const localSha = sha(f.ownerPath, "HEAD");
    writeFileSync(mergeHeadPath(f.ownerPath), "not-a-sha\n");
    assert.throws(
      () => preserveOrDiscardFixOwnerResidue(f.repoDir, f.ownerPath, f.branch, localSha),
      /dirty owner MERGE_HEAD is malformed/,
    );
    rmSync(mergeHeadPath(f.ownerPath));
    mkdirSync(mergeHeadPath(f.ownerPath));
    assert.throws(() => preserveOrDiscardFixOwnerResidue(f.repoDir, f.ownerPath, f.branch, localSha), /EISDIR/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── the sweep's dispatchFix, driven for real ─────────────────────────────────────────────

const PLAN: Plan = (() => {
  const tasks = [
    { id: TASK, title: TASK, risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" } as unknown as Task,
  ];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
})();

const WORKER = {
  sessionId: "W1-T5918-PROBE",
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
    { kind: "w1t5918" },
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
      runId: "SWEEP-W1T5918",
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

/** The production owner-recovery seams over a real owner. Only the capture is wrapped: the stub
 *  `gh` reports a fake head sha, and the claim and process censuses are pinned. */
function realRecovery(
  f: Fixture,
  order: string[],
  census: { claim?: "clear" | "occupied"; process?: "clear" | "occupied" } = {},
  resetImpl?: () => void,
): NonNullable<BuildSweepEffectsDeps["registeredOwnerRecovery"]> {
  return {
    capture: () => snapshotOf(f, census),
    preserveTrackedDirty: (repoDir: string, ownerPath: string, branch: string, localSha: string) => {
      order.push("preserve");
      return preserveOrDiscardFixOwnerResidue(repoDir, ownerPath, branch, localSha);
    },
    resetTrackedDirty: (_repoDir: string, ownerPath: string, _branch: string, localSha: string) => {
      order.push("reset");
      if (resetImpl) return resetImpl();
      resetTrackedDirtyFixOwner(ownerPath, localSha);
    },
    remove: (repoDir: string, ownerPath: string) => {
      order.push("remove");
      removeAbandonedFixWorktreeOwner(repoDir, ownerPath);
    },
  };
}

const steps = (logs: Log[], step: string): Log[] => logs.filter((entry) => entry.step === step);

test("W1-T5918: a dead owner dirty only through an interrupted merge is recorded, reset, removed and repaired in one pass", async () => {
  const f = fixture("1791000000005");
  try {
    interruptMerge(f);
    const localSha = sha(f.ownerPath, "HEAD");
    const order: string[] = [];
    const { logs, threw } = await drive(f, realRecovery(f, order));
    assert.equal(threw, undefined);
    assert.deepEqual(
      steps(logs, "sweep.fix.checkout_claim_declined"),
      [],
      "no decline -- and never owner_dirty_recovery_preserve_failed",
    );
    const discarded = steps(logs, "sweep.fix.checkout_owner_residue_discarded");
    assert.equal(discarded.length, 1);
    assert.deepEqual(
      {
        ...discarded[0].extra,
        status_excerpt: undefined,
      },
      {
        pr_number: 9362,
        task_id: TASK,
        branch: f.branch,
        worktree_path: realpathOf(f.ownerPath),
        local_sha_prefix: localSha.slice(0, 12),
        marker_kind: "MERGE_HEAD",
        marker_sha: sha(f.repoDir, "other"),
        unmerged_paths: ["seed.txt"],
        unmerged_more: 0,
        staged_paths: [],
        staged_more: 0,
        status_excerpt: undefined,
      },
    );
    assert.match(String(discarded[0].extra?.status_excerpt), /UU seed\.txt/);
    assert.deepEqual(order, ["preserve", "reset", "remove"]);
    const stepOrder = logs.map((entry) => entry.step);
    assert.ok(
      stepOrder.indexOf("sweep.fix.checkout_owner_residue_discarded") < stepOrder.indexOf("sweep.fix.checkout_owner_reclaimed"),
    );
    const reclaimed = steps(logs, "sweep.fix.checkout_owner_reclaimed");
    assert.equal(reclaimed.length, 1);
    assert.equal((reclaimed[0].extra?.proof as Record<string, unknown>).residue_discarded, true);
    assert.equal(steps(logs, "sweep.fix.checkout_owner_dirty_preserved").length, 0);
    assert.equal(steps(logs, "fix.dispatch").length, 1, "the same pass dispatches exactly one repair worker");
    assert.equal(git(f.repoDir, "for-each-ref", "refs/rmd-recovery/fix-dirty/"), "");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

function realpathOf(p: string): string {
  return execFileSync("realpath", [p], { encoding: "utf8" }).trim();
}

test("W1-T5918: staged-only content, an untracked path, a live claim or an occupied process census keeps the owner and dispatches nothing", async () => {
  const cases: Array<{
    name: string;
    epoch: string;
    dirty: (f: Fixture) => void;
    census?: { claim?: "clear" | "occupied"; process?: "clear" | "occupied" };
    reason: string;
    preserved: boolean;
  }> = [
    { name: "staged-only", epoch: "1791000000006", dirty: (f) => stageOnly(f, ["clean.txt"]), reason: "owner_dirty_staged_only_refused", preserved: true },
    {
      name: "untracked",
      epoch: "1791000000007",
      dirty: (f) => {
        interruptMerge(f);
        write(f.ownerPath, "stray.txt", "untracked\n");
      },
      reason: "dirty_worktree",
      preserved: false,
    },
    { name: "live claim", epoch: "1791000000008", dirty: interruptMerge, census: { claim: "occupied" }, reason: "live_branch_claim", preserved: false },
    { name: "occupied cwd", epoch: "1791000000009", dirty: interruptMerge, census: { process: "occupied" }, reason: "process_cwd_owner", preserved: false },
  ];
  for (const c of cases) {
    const f = fixture(c.epoch);
    try {
      c.dirty(f);
      const before = status(f.ownerPath);
      const order: string[] = [];
      const { logs, threw } = await drive(f, realRecovery(f, order, c.census));
      assert.equal(threw, undefined, c.name);
      const declined = steps(logs, "sweep.fix.checkout_claim_declined");
      assert.equal(declined.length, 1, c.name);
      assert.equal(declined[0].extra?.owner_recovery_reason, c.reason, c.name);
      assert.deepEqual(order, c.preserved ? ["preserve"] : [], `${c.name}: no reset, no removal`);
      assert.equal(steps(logs, "sweep.fix.checkout_owner_residue_discarded").length, 0, c.name);
      assert.equal(steps(logs, "fix.dispatch").length, 0, c.name);
      assert.equal(status(f.ownerPath), before, `${c.name}: the owner is untouched`);
      assert.equal(registeredFixWorktreeOwner(f.repoDir, `refs/heads/${f.branch}`), realpathOf(f.ownerPath), c.name);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("W1-T5918: a failed residue reset is declined by name and never removes the owner", async () => {
  const f = fixture("1791000000010");
  try {
    interruptMerge(f);
    const order: string[] = [];
    const { logs, threw } = await drive(
      f,
      realRecovery(f, order, {}, () => {
        throw new Error("reset refused");
      }),
    );
    assert.equal(threw, undefined);
    assert.deepEqual(order, ["preserve", "reset"]);
    const declined = steps(logs, "sweep.fix.checkout_claim_declined");
    assert.equal(declined.length, 1);
    assert.equal(declined[0].extra?.owner_recovery_reason, "owner_residue_reset_failed");
    assert.equal(declined[0].extra?.recovery_ref, undefined);
    assert.match(String(declined[0].extra?.error), /reset refused/);
    assert.equal(steps(logs, "sweep.fix.checkout_owner_residue_discarded").length, 1, "the receipt precedes the mutation");
    assert.equal(steps(logs, "sweep.fix.checkout_owner_reclaimed").length, 0);
    assert.equal(steps(logs, "fix.dispatch").length, 0);
    assert.match(status(f.ownerPath), /^UU seed\.txt$/m);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
