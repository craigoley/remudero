import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pruneStaleRuns, runLockPath, writeRunLock } from "../src/lib/worker.js";

// pruneStaleRuns needs a real git repo + worktree to exercise `git worktree list`.
// Build one: repoDir with a run-* worktree under worktreesRoot, then assert the
// liveness guard skips a live-pid worktree and reaps a dead/absent-lock one.
function makeRepoWithRunWorktree(): {
  dir: string;
  repoDir: string;
  worktreesRoot: string;
  wtPath: string;
  branch: string;
} {
  // realpath so paths match `git worktree list` output (macOS /var → /private/var).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-prune-")));
  const repoDir = join(dir, "repo");
  const worktreesRoot = join(dir, "worktrees");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  execFileSync("git", ["init", "-b", "main", repoDir], { encoding: "utf8" });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  git("add", "-A");
  git("commit", "-m", "seed");
  const branch = "run-W1-T7-1784075267898";
  const wtPath = join(worktreesRoot, branch);
  git("worktree", "add", "-b", branch, wtPath);
  return { dir, repoDir, worktreesRoot, wtPath, branch };
}

test("pruneStaleRuns: SKIPS a worktree whose run.lock names a LIVE pid (the case that lost a 65-turn implement)", () => {
  const t = makeRepoWithRunWorktree();
  try {
    // The run wrote its lock naming a live pid (this test process is alive).
    writeRunLock(t.wtPath, { pid: process.pid, run_id: "W1-T7-1784075267898", startedAt: "2026-07-15T00:27:47Z" });
    assert.ok(existsSync(runLockPath(t.wtPath)), "run.lock written");

    const summary = pruneStaleRuns(t.repoDir, t.worktreesRoot); // default isPidAlive: process.pid is alive
    assert.ok(existsSync(t.wtPath), "a LIVE-pid worktree must NOT be force-removed");
    assert.ok(summary.skipped.includes(t.wtPath), "skipped names the protected worktree");
    assert.ok(!summary.worktrees.includes(t.wtPath), "the live worktree is not in the reaped list");
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("pruneStaleRuns: REAPS a worktree whose run.lock is ABSENT (genuinely stale debris)", () => {
  const t = makeRepoWithRunWorktree();
  try {
    // No run.lock at all — the crashed-run debris case the prune was built for.
    const summary = pruneStaleRuns(t.repoDir, t.worktreesRoot);
    assert.ok(!existsSync(t.wtPath), "a lockless worktree is reaped");
    assert.ok(summary.worktrees.includes(t.wtPath));
    assert.ok(!summary.skipped.includes(t.wtPath));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("pruneStaleRuns: REAPS a worktree whose run.lock pid is DEAD", () => {
  const t = makeRepoWithRunWorktree();
  try {
    writeRunLock(t.wtPath, { pid: 999999, run_id: "W1-T7-1784075267898", startedAt: "2026-07-15T00:27:47Z" });
    const summary = pruneStaleRuns(t.repoDir, t.worktreesRoot, { isPidAlive: (p) => p !== 999999 });
    assert.ok(!existsSync(t.wtPath), "a dead-pid worktree is reaped");
    assert.ok(summary.worktrees.includes(t.wtPath));
    // and its orphaned run.lock sibling is cleaned up on reap
    assert.ok(!existsSync(runLockPath(t.wtPath)), "the dead run.lock sibling is removed on reap");
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

// ── AGE THRESHOLD: protect the create-before-lock race (worktree made, run.lock not yet written) ──

test("pruneStaleRuns: PROTECTS a FRESH lockless worktree within the grace window (the create-before-lock race)", () => {
  const t = makeRepoWithRunWorktree();
  try {
    // No run.lock yet — but the worktree is younger than graceMs (now() before its mtime).
    const summary = pruneStaleRuns(t.repoDir, t.worktreesRoot, { graceMs: 120_000, now: () => 0 });
    assert.ok(existsSync(t.wtPath), "a just-created lockless worktree is NOT reaped inside the grace window");
    assert.ok(summary.skipped.includes(t.wtPath));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("pruneStaleRuns: REAPS a lockless worktree once it is OLDER than the grace window", () => {
  const t = makeRepoWithRunWorktree();
  try {
    // Far-future clock ⇒ the lockless worktree is well past graceMs ⇒ genuine debris.
    const summary = pruneStaleRuns(t.repoDir, t.worktreesRoot, { graceMs: 1_000, now: () => 4_000_000_000_000 });
    assert.ok(!existsSync(t.wtPath), "an aged lockless worktree is reaped");
    assert.ok(summary.worktrees.includes(t.wtPath));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
