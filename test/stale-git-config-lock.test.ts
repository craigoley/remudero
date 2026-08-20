import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
import {
  DEFAULT_CONFIG_LOCK_GRACE_MS,
  configLockPath,
  isConfigLockStale,
  pruneStaleRuns,
  reclaimStaleConfigLock,
  worktreeAdd,
} from "../src/lib/worker.js";

// W1-T1036: a zero-byte `.git/config.lock` left by a killed process fails every
// subsequent `git worktree add` outright (`worktreeAdd` writes `branch.<name>.remote`/
// `.merge` into `.git/config`), and the EXISTING widowed-lock pass (reapStaleWorktrees)
// cannot see it -- it enumerates the worktrees DIRECTORY and asks "is the directory this
// lock is named after gone", but a config lock lives in `.git/` and is paired with no
// directory at all. These tests exercise the new reclaimer against a REAL git repo and a
// REAL zero-byte, mode-444 lock file synthesised the way the plan shard's design (vi)
// says the live artifact must be (it no longer exists on disk to fixture from).

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A real local repo with a self-pointing `origin` remote, so `worktreeAdd`'s `git fetch
 *  origin` succeeds without a network — same convention as the sibling worktreeAdd suites
 *  (e.g. test/worktree-base-recorded.test.ts's `seedClone`). */
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

/** Synthesise the artifact design (vi) describes: zero bytes, mode 444, no holder, and
 *  older than the reclaim grace so the age rung (design (i).1) is satisfied for real
 *  rather than by stubbing the clock. */
function writeStaleConfigLock(repoDir: string, ageMs = DEFAULT_CONFIG_LOCK_GRACE_MS + 10_000): string {
  const p = configLockPath(repoDir);
  writeFileSync(p, "");
  chmodSync(p, 0o444);
  const old = new Date(Date.now() - ageMs);
  utimesSync(p, old, old);
  return p;
}

test("W1-T1036: a stale config lock is reclaimed before the worktree add", () => {
  const root = tmp("rmd-config-lock-reclaim-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);
    const lockPath = writeStaleConfigLock(clone);

    // Baseline: unreclaimed, the exact incident from rationale (1) reproduces for real.
    // worktreeAdd runs git with stdio:"inherit", so the "could not lock config file"
    // text goes straight to this process's own stderr rather than into the thrown
    // Error's message — asserting it throws at all is the honest, available signal.
    assert.throws(
      () => worktreeAdd(clone, join(root, "wt-baseline"), "run-baseline-probe", "origin/main"),
      "precondition: the lock really does fail worktreeAdd, matching the reported incident",
    );

    const summary = pruneStaleRuns(clone, join(root, "worktrees"), {
      configLock: { probeLiveGitProcess: () => ({ ran: true, alive: false }) },
    });
    assert.equal(summary.configLock, lockPath, "pruneStaleRuns ledgers the reclaimed path");
    assert.ok(!existsSync(lockPath), "the lock is gone after the prune rung runs");

    // The operation the lock would otherwise fail — proves the reclaim happened in time
    // for the worktree add that follows it at every real call site (design (v)).
    const wt = join(root, "wt");
    worktreeAdd(clone, wt, "run-reclaim-probe", "origin/main");
    assert.ok(existsSync(join(wt, "seed.txt")), "worktreeAdd now succeeds against the same repo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1036: a live git process keeps the config lock", () => {
  const root = tmp("rmd-config-lock-live-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);
    const lockPath = writeStaleConfigLock(clone);

    const summary = pruneStaleRuns(clone, join(root, "worktrees"), {
      configLock: { probeLiveGitProcess: () => ({ ran: true, alive: true }) },
    });
    assert.equal(summary.configLock, null, "a live git process means nothing was reclaimed");
    assert.ok(existsSync(lockPath), "the lock survives — clearing a live lock races two writers");

    // Still blocks worktreeAdd, exactly as it did before the prune rung ran — the guard
    // did not merely skip a ledger entry, it genuinely left the artifact in place.
    assert.throws(
      () => worktreeAdd(clone, join(root, "wt"), "run-live-probe", "origin/main"),
      "the lock is still held, so worktreeAdd must still fail exactly as it did before",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1036: an unrunnable probe keeps the config lock", () => {
  const root = tmp("rmd-config-lock-unrunnable-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);
    const lockPath = writeStaleConfigLock(clone);

    // ran: false is design (i).3's "the probe ran" rung failing — an ENOENT/unrunnable
    // pgrep (rationale (5)'s measured failure mode), never evidence of staleness.
    const summary = pruneStaleRuns(clone, join(root, "worktrees"), {
      configLock: { probeLiveGitProcess: () => ({ ran: false, alive: false }) },
    });
    assert.equal(summary.configLock, null, "an unrunnable probe authorises nothing");
    assert.ok(existsSync(lockPath), "the lock is kept, not reclaimed, on a failed read");

    // Same guarantee at the predicate level, in isolation from pruneStaleRuns' plumbing.
    assert.equal(
      isConfigLockStale(lockPath, { probeLiveGitProcess: () => ({ ran: false, alive: false }) }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1036: the reclaim is ledgered before the unlink", () => {
  const root = tmp("rmd-config-lock-ledger-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);
    const lockPath = writeStaleConfigLock(clone);

    let ledgeredWhileFilePresent = false;
    let ledgeredMessage = "";
    const reclaimed = reclaimStaleConfigLock(clone, {
      probeLiveGitProcess: () => ({ ran: true, alive: false }),
      ledger: (message: string) => {
        ledgeredMessage = message;
        // Captured synchronously, INSIDE the ledger call — if the unlink had already run,
        // this would already read false and the ordering claim would be false.
        ledgeredWhileFilePresent = existsSync(lockPath);
      },
    });

    assert.ok(reclaimed);
    assert.ok(ledgeredWhileFilePresent, "the ledger call must observe the file still present");
    assert.ok(
      ledgeredMessage.includes(lockPath),
      "the ledger row must name the path, not just announce an unspecified reclaim",
    );
    assert.ok(!existsSync(lockPath), "and the file must actually be gone once reclaim returns");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1036: a mode 444 lock is unlinked rather than overwritten", () => {
  const root = tmp("rmd-config-lock-readonly-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);
    const lockPath = writeStaleConfigLock(clone);

    // Pin the premise design (iii) is written against: an "open for write and truncate"
    // reclaimer fails on this exact artifact.
    assert.throws(() => writeFileSync(lockPath, "x"), /EACCES/);

    const reclaimed = reclaimStaleConfigLock(clone, {
      probeLiveGitProcess: () => ({ ran: true, alive: false }),
    });
    assert.ok(reclaimed, "unlink succeeds under the directory's own permission");
    assert.ok(!existsSync(lockPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
