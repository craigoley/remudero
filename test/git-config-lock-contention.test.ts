import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFixRungWorktree } from "../src/run-task.js";
import {
  DEFAULT_CONFIG_LOCK_GRACE_MS,
  configLockPath,
  isConfigLockStale,
  pruneStaleRuns,
  worktreeAdd,
} from "../src/lib/worker.js";

// W1-T1129: `git checkout -B <branch> origin/<branch>` (the fix rung, src/run-task.ts) and
// `git worktree add -b <branch> ... origin/<base>` (the dispatch worker, src/lib/worker.ts)
// both write `branch.<name>.remote`/`.merge` into the repo's ONE shared `.git/config` as a
// side effect of starting from a remote-tracking ref — a write nothing in `src/` ever reads
// (rationale (5)) and that races every other concurrent worktree/checkout for the same
// `.git/config.lock` (rationale (1)/(3)/(4)). These tests exercise the REAL git commands each
// call site now runs (`createFixRungWorktree`/`worktreeAdd`) against a real local repo — same
// convention as the sibling suite, test/stale-git-config-lock.test.ts.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A real local repo with a self-pointing `origin` remote, so `fetch origin` succeeds without
 *  a network — same convention as test/stale-git-config-lock.test.ts's `seedClone`. */
function seedClone(clone: string): void {
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["-C", clone, "init", "--quiet", "--initial-branch", "main"]);
  execFileSync("git", ["-C", clone, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", clone, "config", "user.name", "probe"]);
  writeFileSync(join(clone, "seed.txt"), "x\n");
  execFileSync("git", ["-C", clone, "add", "-A"]);
  execFileSync("git", ["-C", clone, "commit", "--no-verify", "--quiet", "-m", "chore: seed"]);
  execFileSync("git", ["-C", clone, "remote", "add", "origin", clone]);
  execFileSync("git", ["-C", clone, "fetch", "origin", "--quiet"]);
}

/** Push a real branch named `branch` (off the clone's current HEAD) to its own `origin`
 *  remote (itself), so `createFixRungWorktree`/`worktreeAdd`'s `origin/<branch>` start point
 *  resolves — matching how the fix rung only ever runs against a PR's real, already-pushed
 *  head branch. */
function pushNewBranch(clone: string, branch: string): void {
  execFileSync("git", ["-C", clone, "branch", branch]);
  execFileSync("git", ["-C", clone, "push", "--quiet", "origin", branch]);
}

function writeStaleConfigLock(repoDir: string, ageMs = DEFAULT_CONFIG_LOCK_GRACE_MS + 10_000): string {
  const p = configLockPath(repoDir);
  // NO `chmod` HERE, DELIBERATELY. An earlier draft wrote the lock read-only (0o444), which is a
  // uid-dependent host-capability fixture — `test/host-capability-fixtures.test.ts` refuses an
  // undeclared one, and it was right to: nothing here needs it. `isConfigLockStale` judges on age
  // plus the live-git probe, and the reclaim `unlink`s the file, which depends on the DIRECTORY's
  // mode and not the file's. Both assertions below pass identically without it.
  writeFileSync(p, "");
  const old = new Date(Date.now() - ageMs);
  utimesSync(p, old, old);
  return p;
}

test("W1-T1129 (criterion 1): createFixRungWorktree (the fix rung's worktree+branch call) writes no upstream-tracking config", () => {
  const root = tmp("rmd-fix-rung-no-track-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);
    pushNewBranch(clone, "run-probe-branch");
    const worktreePath = join(root, "wt");
    createFixRungWorktree(clone, worktreePath, "run-probe-branch");

    // `git config --get` on an unset key exits non-zero — assert.throws IS the assertion
    // that no branch.run-probe-branch.remote entry was ever written.
    assert.throws(
      () =>
        execFileSync("git", ["-C", worktreePath, "config", "--get", "branch.run-probe-branch.remote"], {
          stdio: "pipe",
        }),
      "branch.run-probe-branch.remote must be unset — that config write is exactly what this task removes",
    );
    assert.throws(
      () =>
        execFileSync("git", ["-C", worktreePath, "config", "--get", "branch.run-probe-branch.merge"], {
          stdio: "pipe",
        }),
      "branch.run-probe-branch.merge must be unset — the paired half of the same tracking write",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1129 (criterion 1, direct): neither branch.<name>.remote nor .merge is present after createFixRungWorktree", () => {
  const root = tmp("rmd-fix-rung-no-track-direct-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);
    pushNewBranch(clone, "run-probe-branch-2");
    const worktreePath = join(root, "wt");
    createFixRungWorktree(clone, worktreePath, "run-probe-branch-2");

    const configText = execFileSync("git", ["-C", worktreePath, "config", "--list"], { encoding: "utf8" });
    assert.ok(
      !configText.includes("branch.run-probe-branch-2.remote"),
      "no branch.<name>.remote entry — the tracking write this task removes",
    );
    assert.ok(
      !configText.includes("branch.run-probe-branch-2.merge"),
      "no branch.<name>.merge entry — the tracking write this task removes",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1129 (criterion 2): the run branch still lands at the same commit origin/<branch> is at", () => {
  const root = tmp("rmd-fix-rung-same-commit-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);
    // Give the branch its own real content so it is distinguishable from main.
    execFileSync("git", ["-C", clone, "checkout", "-q", "-b", "fix-target"]);
    writeFileSync(join(clone, "fix.txt"), "fix content\n", "utf8");
    execFileSync("git", ["-C", clone, "add", "-A"]);
    execFileSync("git", ["-C", clone, "commit", "--no-verify", "--quiet", "-m", "fix commit"]);
    execFileSync("git", ["-C", clone, "checkout", "-q", "main"]);
    const expectedSha = execFileSync("git", ["-C", clone, "rev-parse", "fix-target"], { encoding: "utf8" }).trim();

    const worktreePath = join(root, "wt");
    createFixRungWorktree(clone, worktreePath, "fix-target");

    const actualSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(actualSha, expectedSha, "--no-track changes only the tracking config, never the checked-out commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1129 (criterion 3): the run branch is a NAMED local branch, still pushable — --no-track is not --detach", () => {
  const root = tmp("rmd-fix-rung-pushable-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);
    pushNewBranch(clone, "run-pushable-probe");
    const worktreePath = join(root, "wt");
    createFixRungWorktree(clone, worktreePath, "run-pushable-probe");

    // A detached HEAD has no symbolic ref to resolve; a named branch does — proves this is
    // a real local branch, not the review lane's detached shape (rationale (7): the fix rung
    // pushes, so --detach is not available to it).
    const symbolicRef = execFileSync("git", ["-C", worktreePath, "symbolic-ref", "-q", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.equal(symbolicRef, "refs/heads/run-pushable-probe");

    // And `git push origin HEAD` — the exact refspec gitPushRunBranch uses — succeeds.
    writeFileSync(join(worktreePath, "pushed.txt"), "y\n", "utf8");
    execFileSync("git", ["-C", worktreePath, "add", "-A"]);
    execFileSync("git", ["-C", worktreePath, "commit", "--no-verify", "--quiet", "-m", "pushable probe"]);
    execFileSync("git", ["-C", worktreePath, "push", "--quiet", "origin", "HEAD"], { stdio: "pipe" });

    const pushedSha = execFileSync("git", ["-C", clone, "rev-parse", "run-pushable-probe"], {
      encoding: "utf8",
    }).trim();
    const worktreeSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(pushedSha, worktreeSha, "the push landed the branch at the worktree's own commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1129 (criterion 4): the dispatch worker's worktreeAdd also stops writing tracking config", () => {
  const root = tmp("rmd-worktreeadd-no-track-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);
    const worktreePath = join(root, "wt");
    worktreeAdd(clone, worktreePath, "run-worker-probe", "origin/main");

    const configText = execFileSync("git", ["-C", worktreePath, "config", "--list"], { encoding: "utf8" });
    assert.ok(
      !configText.includes("branch.run-worker-probe.remote"),
      "worktreeAdd's own worktree add -b no longer writes branch.<name>.remote",
    );
    assert.ok(
      !configText.includes("branch.run-worker-probe.merge"),
      "worktreeAdd's own worktree add -b no longer writes branch.<name>.merge",
    );
    // Still lands at the base commit — --no-track changes only the tracking config.
    assert.equal(
      execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      execFileSync("git", ["-C", clone, "rev-parse", "main"], { encoding: "utf8" }).trim(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1129 (criterion 5): a genuinely stale config lock is still reclaimed on the existing three-rung predicate, untouched by this task", () => {
  const root = tmp("rmd-stale-lock-still-reclaimed-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);
    const lockPath = writeStaleConfigLock(clone);

    // W1-T1036's own predicate (age + probe-ran + no-live-process) is not loosened or
    // re-argued by this task — it must still authorise reclaiming a genuinely dead lock.
    assert.equal(
      isConfigLockStale(lockPath, { probeLiveGitProcess: () => ({ ran: true, alive: false }) }),
      true,
      "the age+probe-ran+no-live-process predicate still reads stale exactly as W1-T1036 shipped it",
    );

    const summary = pruneStaleRuns(clone, join(root, "worktrees"), {
      configLock: { probeLiveGitProcess: () => ({ ran: true, alive: false }) },
    });
    assert.equal(summary.configLock, lockPath, "pruneStaleRuns still reclaims a genuinely stale lock");
    assert.ok(!existsSync(lockPath), "the lock is gone after the prune rung runs");

    // And the operation the lock would otherwise fail — now via the --no-track call site —
    // succeeds against the same repo, proving the reclaimer and the contention fix compose.
    const wt = join(root, "wt");
    worktreeAdd(clone, wt, "run-reclaim-then-notrack-probe", "origin/main");
    assert.ok(existsSync(join(wt, "seed.txt")), "worktreeAdd succeeds once the stale lock is cleared");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1129 (criterion 5, live lock unaffected): a LIVE git process still keeps the config lock — this task does not loosen reclamation", () => {
  const root = tmp("rmd-live-lock-still-kept-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);
    const lockPath = writeStaleConfigLock(clone);

    const summary = pruneStaleRuns(clone, join(root, "worktrees"), {
      configLock: { probeLiveGitProcess: () => ({ ran: true, alive: true }) },
    });
    assert.equal(summary.configLock, null, "a live git process still means nothing was reclaimed");
    assert.ok(existsSync(lockPath), "the lock still survives — untouched by W1-T1129's --no-track change");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
