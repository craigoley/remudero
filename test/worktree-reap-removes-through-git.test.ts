/**
 * test/worktree-reap-removes-through-git.test.ts — `reapStaleWorktrees` removes a LINKED
 * worktree through its OWN parent (`git worktree remove --force`), so the parent's
 * `.git/worktrees/<name>` admin record dies with the working tree instead of being stranded.
 *
 * THE DEFECT THIS PINS. The reaper removed every candidate with a bare `fs.rmSync`. Everything
 * under `worktreesDir(config)` is a linked worktree (`worktreeAdd` puts it there), whose admin
 * record lives in the PARENT clone — so `rm -rf` left the record behind, `git worktree list`
 * reported it `prunable`, and git went on refusing the branch to the next run that minted the
 * same name (`fatal: '<branch>' is already used by worktree at <path>`). CLAUDE.md records the
 * 2026-07-31 incident; `lib/clone-reaper.ts`'s header cites the same failure as its reason for
 * refusing any entry whose `.git` is not a DIRECTORY.
 *
 * WHY ITS OWN FILE, not an addition to test/prune-liveness.test.ts: that file pins WHICH
 * worktrees the reaper selects (liveness, branch, age); this one pins HOW it removes them, and
 * the two must be able to fail independently — a selection regression and a removal regression
 * are different defects with different owners.
 *
 * Every fixture below drives the REAL `reapStaleWorktrees` against a REAL git repo. Nothing here
 * mocks git: the whole claim is about what git's own admin records look like afterwards, which a
 * mock cannot witness.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { planWorktreeRemoval, reapStaleWorktrees } from "../src/lib/worker.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/** A real repo with a real linked worktree under a sibling `worktrees/` root — the exact shape
 *  `worktreesDir(config)` holds in production. `realpathSync` so paths match `git worktree list`
 *  output on macOS (/var → /private/var). */
function makeLinkedWorktree(dirName: string, branch: string): {
  dir: string;
  repoDir: string;
  worktreesRoot: string;
  wtPath: string;
  dirName: string;
  git: (...args: string[]) => string;
} {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-through-git-")));
  const repoDir = join(dir, "repo");
  const worktreesRoot = join(dir, "worktrees");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repoDir], { encoding: "utf8" });
  const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", env: GIT_ENV });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  git("add", "-A");
  git("commit", "-m", "seed");
  const wtPath = join(worktreesRoot, dirName);
  git("worktree", "add", "-b", branch, wtPath);
  return { dir, repoDir, worktreesRoot, wtPath, dirName, git };
}

/** How many entries `git worktree list --porcelain` reports as `prunable` in `repoDir`. */
function prunableCount(git: (...args: string[]) => string): number {
  return git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("prunable")).length;
}

// ── THE HEADLINE CLAIM ────────────────────────────────────────────────────────────────────

test("reapStaleWorktrees: a reaped LINKED worktree leaves ZERO prunable admin records behind — the 2026-07-31 defect", () => {
  const t = makeLinkedWorktree("sweep-W1-T9001-linked", "run-W1-T9001-1784000000000");
  try {
    assert.equal(prunableCount(t.git), 0, "precondition: the fresh worktree is registered and not prunable");

    const summary = reapStaleWorktrees(t.worktreesRoot, {
      now: () => 4_000_000_000_000, // far past the age gate
      branchIsLiveUpstream: () => false, // branch confirmed merged-or-deleted upstream
    });

    assert.ok(!existsSync(t.wtPath), "the working tree is gone");
    assert.ok(summary.reaped.includes(t.dirName), "and the reaper says so");
    // THE ASSERTION THE OLD rmSync PATH FAILED: the record must die WITH the tree.
    assert.equal(prunableCount(t.git), 0, "no admin record is stranded as prunable");
    assert.ok(
      !existsSync(join(t.repoDir, ".git", "worktrees", t.dirName)),
      "the parent's .git/worktrees/<name> admin dir is gone from disk too",
    );
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: after reaping, the parent can re-check-out the SAME branch name — the operator-visible consequence of a stranded record", () => {
  const branch = "run-W1-T9002-1784000000000";
  const t = makeLinkedWorktree("sweep-W1-T9002-rename", branch);
  try {
    reapStaleWorktrees(t.worktreesRoot, { now: () => 4_000_000_000_000, branchIsLiveUpstream: () => false });
    assert.ok(!existsSync(t.wtPath));
    // With a stranded record this throws `fatal: '<branch>' is already used by worktree at …`,
    // which is how the defect actually reached a run: the next mint of the same name failed.
    // NO --force: --force overrides exactly the refusal this test exists to observe, so using
    // it here would let the test pass against the very defect it pins.
    const recut = join(t.worktreesRoot, "sweep-W1-T9002-recut");
    t.git("worktree", "add", recut, branch);
    assert.ok(existsSync(recut), "the branch is free again — nothing still claims it");
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: a DIRTY linked worktree is still removed (--force), matching the set the old rmSync path reaped", () => {
  const t = makeLinkedWorktree("sweep-W1-T9003-dirty", "run-W1-T9003-1784000000000");
  try {
    // Both shapes plain `git worktree remove` refuses on: a modified tracked file AND an
    // untracked one. A stale run worktree nearly always carries the latter (build output), so
    // omitting --force would keep almost everything and silently disable this reaper.
    writeFileSync(join(t.wtPath, "README.md"), "modified\n");
    writeFileSync(join(t.wtPath, "untracked.txt"), "junk\n");

    const summary = reapStaleWorktrees(t.worktreesRoot, {
      now: () => 4_000_000_000_000,
      branchIsLiveUpstream: () => false,
    });

    assert.ok(!existsSync(t.wtPath), "a dirty tree past every gate is still reaped, exactly as before");
    assert.ok(summary.reaped.includes(t.dirName));
    assert.equal(prunableCount(t.git), 0, "and it still strands no record");
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

// ── THE rmSync FALLBACK: an ORPHAN whose parent is gone ───────────────────────────────────

test("reapStaleWorktrees: an ORPHANED linked worktree (parent clone deleted) is still reclaimed, via the rmSync fallback", () => {
  const t = makeLinkedWorktree("sweep-W1-T9004-orphan", "run-W1-T9004-1784000000000");
  try {
    // Delete the PARENT, leaving the linked worktree pointing at a gitdir that no longer exists —
    // the shape 52 of the 54 directories measured in $HOME on 2026-09-04 had. `git worktree
    // remove` is impossible here (there is no repo to run it in), and no record can be stranded
    // because the repo holding records is itself gone, so rmSync is correct.
    rmSync(t.repoDir, { recursive: true, force: true });
    assert.ok(existsSync(join(t.wtPath, ".git")), "precondition: it is still a linked worktree by shape");

    const summary = reapStaleWorktrees(t.worktreesRoot, { now: () => 4_000_000_000_000 });

    assert.ok(!existsSync(t.wtPath), "an orphan is reclaimed rather than kept forever");
    assert.ok(summary.reaped.includes(t.dirName));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

// ── THE PRUNE-BEHIND-RMSYNC PATH: a present parent that does not register this entry ──────

test("reapStaleWorktrees: an rm-only entry whose parent IS a real repo prunes behind the rmSync", () => {
  // The FULL reaper pass, not planWorktreeRemoval in isolation: this is the only route that
  // exercises executeWorktreeRemoval's rm-only branch, which fs.rmSync()s the tree and then
  // shells `git worktree prune` in the carried parent — the idempotent "collects anything the
  // registration lookup missed" behind an rmSync that was already correct on its own.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-prune-behind-")));
  const repoDir = join(dir, "repo");
  const worktreesRoot = join(dir, "worktrees");
  try {
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(worktreesRoot, { recursive: true });
    execFileSync("git", ["init", "-b", "main", repoDir], { encoding: "utf8" });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", env: GIT_ENV });
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repoDir, "README.md"), "seed\n");
    git("add", "-A");
    git("commit", "-m", "seed");

    // A `.git` FILE pointing at a real, PRESENT parent — but this entry was never actually
    // registered there with `git worktree add`, so the parent's own `git worktree list` does not
    // know about it. The record is already gone, so rmSync is correct; the parent rides along so
    // the caller can prune behind it anyway.
    const name = "sweep-W1-T9007-unregistered";
    const entryPath = join(worktreesRoot, name);
    mkdirSync(entryPath, { recursive: true });
    writeFileSync(join(entryPath, ".git"), `gitdir: ${repoDir}/.git/worktrees/${name}\n`);

    const summary = reapStaleWorktrees(worktreesRoot, { now: () => 4_000_000_000_000, isPidAlive: () => false });

    assert.ok(!existsSync(entryPath), "the untracked working tree is removed");
    assert.ok(summary.reaped.includes(name), "and the reaper says so");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: a failed prune behind an rm-only removal is swallowed, never reported as removal-failed", () => {
  // The parent EXISTS (so the rm-only plan still carries it and still attempts the prune) but is
  // not a git repository at all, so `git worktree prune` there throws. That failure is
  // BEST-EFFORT: the tree is already gone by the time it runs, so it must never flip a
  // successful removal into `removal-failed` — the next pass, or pruneStaleRuns, collects
  // whatever record the failed prune could not.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-prune-fails-")));
  const repoDir = join(dir, "not-a-repo"); // exists on disk, but has no `.git` of its own
  const worktreesRoot = join(dir, "worktrees");
  try {
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(worktreesRoot, { recursive: true });

    const name = "sweep-W1-T9008-prune-fails";
    const entryPath = join(worktreesRoot, name);
    mkdirSync(entryPath, { recursive: true });
    writeFileSync(join(entryPath, ".git"), `gitdir: ${repoDir}/.git/worktrees/${name}\n`);

    const summary = reapStaleWorktrees(worktreesRoot, { now: () => 4_000_000_000_000, isPidAlive: () => false });

    assert.ok(!existsSync(entryPath), "the working tree is still removed by rmSync regardless of the prune outcome");
    assert.ok(
      summary.reaped.includes(name),
      "a prune failure against a non-repo parent never demotes this to removal-failed",
    );
    assert.ok(!summary.kept.includes(name));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── THE KEEP DIRECTION: an unknowable `.git` destroys nothing ─────────────────────────────

test("reapStaleWorktrees: an UNREADABLE `.git` KEEPS the directory — the ambiguous signal never destroys", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-git-unreadable-")));
  const entryPath = join(root, "run-W1-T9005-unreadable");
  try {
    mkdirSync(entryPath, { recursive: true });
    // A DANGLING SYMLINK at `.git`, not a chmod: `lstatSync` sees a symlink (not a directory, so
    // not the standalone-clone branch) while the `readFileSync` behind `resolveWorktreeRepoDir`
    // follows it and throws. That is genuinely unreadable AND uid-independent — `chmod 0o000`
    // denies nothing to root, so under a root-running CI it would silently stop testing the
    // branch it names (test/host-capability-fixtures.test.ts refuses that fixture for this reason).
    symlinkSync(join(root, "no-such-gitdir-target"), join(entryPath, ".git"));

    const summary = reapStaleWorktrees(root, { now: () => 4_000_000_000_000, isPidAlive: () => false });

    assert.ok(existsSync(entryPath), "a `.git` we cannot read is never grounds to destroy the tree");
    assert.ok(summary.kept.includes("run-W1-T9005-unreadable"));
    assert.deepEqual(
      summary.keptReasons,
      [{ name: "run-W1-T9005-unreadable", reason: "git-unreadable" }],
      "and the reason names WHY — NOT activity-unknown, which would be a keep for the wrong reason",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: an UNPARSEABLE `.git` (readable, but no gitdir: pointer) KEEPS the directory", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-git-unparseable-")));
  const entryPath = join(root, "run-W1-T9006-unparseable");
  try {
    mkdirSync(entryPath, { recursive: true });
    // A `.git` FILE that is not a worktree pointer at all. We cannot rule out that a record
    // exists for it somewhere, so it keeps — the same direction as the unreadable case.
    writeFileSync(join(entryPath, ".git"), "this is not a gitdir pointer\n");

    const summary = reapStaleWorktrees(root, { now: () => 4_000_000_000_000, isPidAlive: () => false });

    assert.ok(existsSync(entryPath), "an unparseable `.git` keeps, never destroys");
    assert.deepEqual(summary.keptReasons, [{ name: "run-W1-T9006-unparseable", reason: "git-unreadable" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── planWorktreeRemoval directly: the five cases, without a full reaper pass ───────────────

test("planWorktreeRemoval: a registered linked worktree plans `git-remove` against its OWN parent", () => {
  const plan = planWorktreeRemoval("/anywhere/wt", { repoDir: "/parent/repo", branch: "run-x" });
  assert.deepEqual(plan, { kind: "git-remove", repoDir: "/parent/repo" });
});

test("planWorktreeRemoval: an ABSENT `.git` plans `rm-only` with no parent — hole (1) debris strands nothing", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-plan-nogit-")));
  try {
    mkdirSync(join(root, "debris"));
    assert.deepEqual(planWorktreeRemoval(join(root, "debris"), null), { kind: "rm-only" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planWorktreeRemoval: a `.git` DIRECTORY (standalone clone) plans `rm-only` — it owns its own records", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-plan-standalone-")));
  try {
    mkdirSync(join(root, "clone", ".git"), { recursive: true });
    assert.deepEqual(planWorktreeRemoval(join(root, "clone"), null), { kind: "rm-only" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planWorktreeRemoval: a parsed pointer to an ABSENT parent plans `rm-only` with no prune target", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-plan-orphan-")));
  try {
    const entryPath = join(root, "orphan");
    mkdirSync(entryPath);
    writeFileSync(join(entryPath, ".git"), `gitdir: ${root}/gone-repo/.git/worktrees/orphan\n`);
    assert.deepEqual(planWorktreeRemoval(entryPath, null), { kind: "rm-only" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planWorktreeRemoval: a PRESENT parent that does not register this path plans `rm-only` CARRYING the parent, so the caller prunes behind it", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-plan-unregistered-")));
  try {
    const parent = join(root, "repo");
    mkdirSync(parent, { recursive: true });
    const entryPath = join(root, "unregistered");
    mkdirSync(entryPath);
    writeFileSync(join(entryPath, ".git"), `gitdir: ${parent}/.git/worktrees/unregistered\n`);
    // `registration` is null (the caller's `git worktree list` did not find it) yet the parent
    // directory exists — the record is already gone, so rmSync is correct AND a prune rides along.
    assert.deepEqual(planWorktreeRemoval(entryPath, null), { kind: "rm-only", repoDir: parent });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planWorktreeRemoval: a NON-ENOENT lstat error (EACCES) plans `keep` — only ENOENT means 'not a worktree'", () => {
  // Driven through the injected `fsImpl` rather than a real permission fixture: the distinction
  // this pins is errno-shaped, and `chmod 0o000` cannot produce EACCES for a root-running CI.
  const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  const plan = planWorktreeRemoval("/anywhere/wt", null, {
    lstatSync: (() => {
      throw eacces;
    }) as never,
    existsSync: (() => true) as never,
  });
  assert.deepEqual(plan, { kind: "keep" }, "an errno we cannot interpret keeps, never destroys");
});

test("planWorktreeRemoval: ENOENT is the ONLY lstat error that reaps — the mid-pass-vanish path depends on it", () => {
  const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  const plan = planWorktreeRemoval("/anywhere/wt", null, {
    lstatSync: (() => {
      throw enoent;
    }) as never,
    existsSync: (() => true) as never,
  });
  assert.deepEqual(plan, { kind: "rm-only" }, "an absent `.git` is hole (1) debris and strands nothing");
});
