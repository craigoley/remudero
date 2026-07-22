import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
// The DEFAULT export -- a plain, mutable object -- so `t.mock.method` can actually
// intercept the calls `writeRunLock`/`readRunLock` make: named bindings off `node:fs`
// are non-configurable and `mock.method`/`defineProperty` against them throws "Cannot
// redefine property" instead of installing a spy. See the identical import comment atop
// src/lib/status.ts and src/lib/worker.ts (worker.ts's run.lock path calls
// `fs.writeFileSync`/`fs.renameSync`/`fs.readFileSync` as live property lookups at call
// time for exactly this reason).
import fsDefault from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_PRUNE_GRACE_MS,
  pruneStaleRuns,
  readRunLock,
  runLockPath,
  writeRunLock,
} from "../src/lib/worker.js";

// ── W1-T208: WRITE-SIDE ATOMICITY + READ-SIDE HONESTY for the sibling run.lock ──────
//
// writeRunLock used to be a plain `writeFileSync(target, ...)` -- a truncate-then-fill a
// concurrent reader could observe mid-flight -- and readRunLock collapsed BOTH "no lock
// file" and "lock file present but unparseable" into the same `null`, so a torn read was
// indistinguishable from an idle worktree and pruneStaleRuns could `--force` remove a
// live run's worktree out from under it. The fix: writeRunLock stages to a sibling temp
// file and `renameSync`s it onto the target (rename(2) within one filesystem is atomic,
// so a reader sees the whole old file or the whole new one, never a partial), and
// readRunLock now returns a discriminated `{kind: "absent" | "corrupt" | "live"}` instead
// of a lossy `null`. The age/grace guard inside pruneStaleRuns -- which already covered
// the lockless case -- is extended to the corrupt case too, unchanged in duration.

/** pruneStaleRuns needs a real git repo + worktree to exercise `git worktree list`. */
function makeRepoWithRunWorktree(): {
  dir: string;
  repoDir: string;
  worktreesRoot: string;
  wtPath: string;
  branch: string;
} {
  // realpath so paths match `git worktree list` output (macOS /var → /private/var).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-run-lock-")));
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
  const branch = "run-W1-T208-1784075267898";
  const wtPath = join(worktreesRoot, branch);
  git("worktree", "add", "-b", branch, wtPath);
  return { dir, repoDir, worktreesRoot, wtPath, branch };
}

// ── Claim 1: a reader interleaved with a lock writer never observes a partial lock file ──

test(
  "W1-T208 claim 1: a reader interleaved with a lock writer never observes a partial lock " +
    "file -- FALSIFIER: reverting writeRunLock to a direct writeFileSync(target) makes this fail",
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "rmd-run-lock-atomic-"));
    const worktreePath = join(dir, "run-W1-TX-1784000000000");
    const lockPath = runLockPath(worktreePath);

    try {
      // Cycle 1: seed a known-good, complete lock file (CONTENT_1) with real fs calls.
      writeRunLock(worktreePath, { pid: process.pid, run_id: "W1-T208-cycle1", startedAt: "2026-07-22T00:00:00Z" });
      const content1 = fsDefault.readFileSync(lockPath, "utf8");
      assert.ok(content1.length > 0, "sanity: cycle 1 actually produced a non-empty lock file");
      JSON.parse(content1); // sanity: valid JSON

      // Cycle 2: intercept the real fs.writeFileSync/renameSync calls writeRunLock makes.
      // The probe fires on whichever write op is about to make `lockPath` itself visible
      // to a reader:
      //  - a DIRECT `writeFileSync(lockPath, ...)` (the pre-fix shape) -- truncate the
      //    real file first to reproduce the exact zero-length window a real truncating
      //    write exposes, THEN fire the probe, THEN fill it. This branch only fires if
      //    writeRunLock is reverted to write the target directly.
      //  - a `renameSync(tmp, lockPath)` (the fixed shape) -- fire the probe BEFORE the
      //    atomic swap, while lockPath still holds cycle 1's complete, untouched bytes.
      const realWriteFileSync = fsDefault.writeFileSync.bind(fsDefault);
      const realRenameSync = fsDefault.renameSync.bind(fsDefault);
      const realReadFileSync = fsDefault.readFileSync.bind(fsDefault);
      const realExistsSync = fsDefault.existsSync.bind(fsDefault);

      const observations: Array<{ label: string; content: string | undefined; read: unknown }> = [];
      let probeFired = false;
      let probeArmed = true; // guards against the nested reader's own read re-firing this

      function probe(label: string) {
        if (!probeArmed) return;
        probeArmed = false;
        probeFired = true;
        const content = realExistsSync(lockPath) ? realReadFileSync(lockPath, "utf8") : undefined;
        // The "concurrent reader": a genuinely separate call into the same exported
        // readRunLock, simulating pruneStaleRuns racing this write from another process.
        const read = readRunLock(worktreePath);
        observations.push({ label, content, read });
        probeArmed = true;
      }

      t.mock.method(fsDefault, "writeFileSync", (target: unknown, content: unknown, ...rest: unknown[]) => {
        if (target === lockPath) {
          // Reproduce a plain truncating writeFileSync's observable two-phase window.
          realWriteFileSync(lockPath, "");
          probe("direct writeFileSync(lockPath) -- pre-fix shape, post-truncate pre-fill");
          return realWriteFileSync(target as string, content as string, ...(rest as []));
        }
        return realWriteFileSync(target as string, content as string, ...(rest as []));
      });
      t.mock.method(fsDefault, "renameSync", (from: unknown, to: unknown) => {
        if (to === lockPath) {
          probe("renameSync(tmp, lockPath) -- pre-swap");
        }
        return realRenameSync(from as string, to as string);
      });

      writeRunLock(worktreePath, { pid: process.pid, run_id: "W1-T208-cycle2", startedAt: "2026-07-22T00:05:00Z" });

      assert.ok(probeFired, "sanity: the interleave probe must actually have fired at least once");

      for (const obs of observations) {
        assert.ok(obs.content !== undefined, `${obs.label}: lockPath must already exist by cycle 2`);
        assert.ok(obs.content!.length > 0, `${obs.label}: reader observed a ZERO-LENGTH lock file`);
        assert.doesNotThrow(() => JSON.parse(obs.content!), `${obs.label}: reader observed unparseable (torn) JSON`);
        assert.equal(obs.content, content1, `${obs.label}: reader observed something other than the complete, untouched cycle-1 lock`);
        assert.deepEqual(
          obs.read,
          { kind: "live", info: { pid: process.pid, run_id: "W1-T208-cycle1", startedAt: "2026-07-22T00:00:00Z" } },
          `${obs.label}: the interleaved readRunLock() call must resolve the complete cycle-1 lock, never a torn/corrupt one`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── Claim 2: an unparseable lock is reported DISTINCTLY from an absent lock ──────────

test("W1-T208 claim 2: an unparseable lock is reported DISTINCTLY from an absent lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-run-lock-corrupt-"));
  const worktreePath = join(dir, "run-W1-TX-1784000000001");
  try {
    // No lock file at all.
    const absent = readRunLock(worktreePath);
    assert.deepEqual(absent, { kind: "absent" }, "a missing lock file reads as 'absent'");

    // A lock file that is present but truncated mid-JSON -- the exact shape a torn write
    // (or this test's own corruption) leaves behind.
    writeFileSync(runLockPath(worktreePath), '{"pid": 4242, "run_id": "W1-T208-torn", "start');
    const torn = readRunLock(worktreePath);
    assert.equal(torn.kind, "corrupt", "an unparseable (torn) lock reads as 'corrupt', never 'absent'");
    assert.notDeepEqual(torn, absent, "'corrupt' and 'absent' must be distinct, non-equal results");

    // Valid JSON but the wrong shape (no numeric pid) is equally not a usable lock, and
    // must not silently masquerade as an idle (absent) worktree either.
    writeFileSync(runLockPath(worktreePath), JSON.stringify({ run_id: "no-pid-here" }));
    const malshaped = readRunLock(worktreePath);
    assert.equal(malshaped.kind, "corrupt", "a parseable-but-malformed lock (no numeric pid) also reads as 'corrupt'");

    // A genuinely valid, complete lock still reads as 'live', distinct from both.
    writeRunLock(worktreePath, { pid: process.pid, run_id: "W1-T208-ok", startedAt: "2026-07-22T00:00:00Z" });
    const live = readRunLock(worktreePath);
    assert.equal(live.kind, "live", "a well-formed lock reads as 'live'");
    assert.ok(existsSync(runLockPath(worktreePath)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Claim 3: the two-minute prune grace still applies unchanged after the fix ────────

test("W1-T208 claim 3: DEFAULT_PRUNE_GRACE_MS is still exactly two minutes", () => {
  assert.equal(DEFAULT_PRUNE_GRACE_MS, 120_000, "the two-minute prune grace must not silently drift");
});

test("W1-T208 claim 3: the prune grace protects a CORRUPT (torn-read-shaped) lock exactly like a lockless worktree", () => {
  const t = makeRepoWithRunWorktree();
  try {
    // Simulate what a reader could observe mid torn-write pre-fix: a lock file present
    // but unparseable. Written directly (bypassing writeRunLock) to reproduce that shape
    // without depending on a real race.
    writeFileSync(runLockPath(t.wtPath), '{"pid": 12345, "run_id": "W1-T208-crashed-mid-write", "star');
    assert.equal(readRunLock(t.wtPath).kind, "corrupt", "sanity: the fixture really is unparseable");

    const summary = pruneStaleRuns(t.repoDir, t.worktreesRoot, { graceMs: DEFAULT_PRUNE_GRACE_MS, now: () => 0 });
    assert.ok(existsSync(t.wtPath), "a corrupt lock within the grace window must NOT be reaped -- it may be a live run mid-write");
    assert.ok(summary.skipped.includes(t.wtPath));
    assert.ok(!summary.worktrees.includes(t.wtPath));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("W1-T208 claim 3: a corrupt lock OLDER than the grace window is still eventually reaped, matching lockless debris", () => {
  const t = makeRepoWithRunWorktree();
  try {
    writeFileSync(runLockPath(t.wtPath), "not json at all");
    assert.equal(readRunLock(t.wtPath).kind, "corrupt");

    // Far-future clock ⇒ the corrupt-lock worktree is well past graceMs ⇒ genuine debris,
    // exactly as the pre-existing lockless-debris case already behaved.
    const summary = pruneStaleRuns(t.repoDir, t.worktreesRoot, { graceMs: 1_000, now: () => 4_000_000_000_000 });
    assert.ok(!existsSync(t.wtPath), "an aged corrupt-lock worktree is still eventually reaped");
    assert.ok(summary.worktrees.includes(t.wtPath));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("W1-T208 claim 3: a DEFINITIVELY DEAD-pid lock still skips the grace period entirely (unchanged)", () => {
  const t = makeRepoWithRunWorktree();
  try {
    writeRunLock(t.wtPath, { pid: 999999, run_id: "W1-T208-dead", startedAt: "2026-07-22T00:00:00Z" });
    // Even with a generous grace window and a clock that would protect a fresh/corrupt
    // worktree, a lock naming a pid we can prove is dead is removed immediately -- that
    // pid cannot still be mid-write, so no grace is owed to it.
    const summary = pruneStaleRuns(t.repoDir, t.worktreesRoot, {
      graceMs: DEFAULT_PRUNE_GRACE_MS,
      now: () => 0,
      isPidAlive: (p) => p !== 999999,
    });
    assert.ok(!existsSync(t.wtPath), "a dead-pid worktree is reaped even inside what would otherwise be the grace window");
    assert.ok(summary.worktrees.includes(t.wtPath));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
