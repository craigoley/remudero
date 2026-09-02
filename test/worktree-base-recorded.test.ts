import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  pruneStaleRuns,
  reapStaleWorktrees,
  readWorktreeBase,
  recordWorktreeBase,
  runLockPath,
  worktreeAdd,
  worktreeBasePath,
  worktreeRemove,
  writeRunLock,
} from "../src/lib/worker.js";

// W1-T405 acceptance (4): the base commit is recorded when the worktree is created, so a
// later refusal can be attributed without re-deriving it. `worktreeAdd` never asserted or
// recorded a base before this task -- these tests pin the sibling-file record (same
// convention as run.lock's liveness token, {@link worktreeBasePath}) both in isolation and
// as a real side effect of `worktreeAdd`, on both the healthy and the refused paths.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

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

test("recordWorktreeBase / readWorktreeBase round-trip via a SIBLING file, never inside the working tree", () => {
  const root = tmp("rmd-wt-record-");
  try {
    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });
    recordWorktreeBase(wt, "deadbeef");
    assert.equal(readWorktreeBase(wt), "deadbeef");
    assert.equal(worktreeBasePath(wt), `${wt}.base`, "outside the working tree, same convention as run.lock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readWorktreeBase returns null, never throws, when nothing was recorded", () => {
  assert.equal(readWorktreeBase(join(tmp("rmd-wt-record-absent-"), "no-such-worktree")), null);
});

test("worktreeAdd records the base it actually created, on the healthy path", () => {
  const root = tmp("rmd-wt-record-healthy-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    worktreeAdd(clone, wt, "run-record-probe", "origin/main");
    const actualHead = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(readWorktreeBase(wt), actualHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktreeRemove drops the sibling record with the worktree — a removed run leaves NO residue", () => {
  // The record's lifetime is its worktree's. The guard suite's approve-refusal test asserts
  // the worktrees dir is EMPTY after cleanup; a surviving `<name>.base` fails that contract
  // and would hand the reaper one orphaned file per pass.
  const root = tmp("rmd-wt-record-remove-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    worktreeAdd(clone, wt, "run-record-remove-probe", "origin/main");
    assert.ok(existsSync(worktreeBasePath(wt)), "precondition: the record exists after create");
    worktreeRemove(clone, wt);
    assert.ok(!existsSync(worktreeBasePath(wt)), "the sibling record must die with its worktree");
    assert.equal(readWorktreeBase(wt), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktreeRemove tolerates an already-absent record — a pre-W1-T405 worktree removes clean", () => {
  const root = tmp("rmd-wt-record-remove-absent-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    worktreeAdd(clone, wt, "run-record-remove-absent-probe", "origin/main");
    unlinkSync(worktreeBasePath(wt)); // simulate a worktree created before the record existed
    assert.doesNotThrow(() => worktreeRemove(clone, wt));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the base is recorded BEFORE a stale-base refusal, so the refusal can be attributed without re-deriving it", () => {
  const root = tmp("rmd-wt-record-stale-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    assert.throws(() =>
      worktreeAdd(clone, wt, "run-record-stale-probe", "origin/main", {
        readRemoteHead: () => "3333333333333333333333333333333333333333",
      }),
    );
    // worktreeAdd got far enough to create the worktree before refusing -- its sibling
    // .base file must already name the commit it was actually cut from, so an operator (or
    // a later dispatch) can attribute the refusal without shelling `git merge-base` again.
    const actualHead = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(readWorktreeBase(wt), actualHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T2628: pruneStaleRuns widowed the base record it never removed, and the
// widowed-sibling sweep only matched `.lock` -- these five tests pin the fix. ──────────────

test("pruneStaleRuns drops the sibling base record together with the worktree it prunes -- one of the three removal paths did not hold the contract until now", () => {
  const root = realpathSync(tmp("rmd-wt-record-prune-"));
  const clone = join(root, "clone");
  const worktreesRoot = join(root, "worktrees");
  const wt = join(worktreesRoot, "run-record-prune-probe");
  try {
    seedClone(clone);
    mkdirSync(worktreesRoot, { recursive: true });
    worktreeAdd(clone, wt, "run-record-prune-probe", "origin/main");
    assert.ok(existsSync(worktreeBasePath(wt)), "precondition: the record exists after create");
    // No run.lock written -- pruneStaleRuns treats this as genuinely stale debris (same
    // shape as prune-liveness.test.ts's "REAPS a worktree whose run.lock is ABSENT") and
    // force-removes it.
    const summary = pruneStaleRuns(clone, worktreesRoot);
    assert.ok(summary.worktrees.includes(wt), "precondition: the worktree really was pruned");
    assert.ok(!existsSync(wt), "the worktree itself is gone");
    assert.ok(
      !existsSync(worktreeBasePath(wt)),
      "the sibling base record dies with the worktree on the prune path too, not just worktreeRemove's",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees sweeps a widowed .base record whose owning worktree directory is already gone -- same pass and predicate as a widowed .lock, no age gate", () => {
  const root = realpathSync(tmp("rmd-wt-record-widow-"));
  try {
    const wt = join(root, "run-W1-T2628-widow-probe");
    // Deliberately never create the owning directory `wt` -- simulates a base record widowed
    // by some path other than pruneStaleRuns (a manual `rm -rf`, or a worktree removed before
    // this fix existed): the reap sweep must not depend on WHY the owner is gone.
    recordWorktreeBase(wt, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    assert.ok(existsSync(worktreeBasePath(wt)), "precondition: the widowed record exists");
    const summary = reapStaleWorktrees(root);
    assert.ok(!existsSync(worktreeBasePath(wt)), "the widowed base record is swept");
    assert.ok(summary.reapedLocks.includes("run-W1-T2628-widow-probe.base"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees does NOT touch a .base record whose owning worktree directory is still PRESENT -- the falsifier proving the sweep keys on widowhood, not on the suffix", () => {
  const root = realpathSync(tmp("rmd-wt-record-owned-"));
  try {
    const wt = join(root, "run-W1-T2628-owned-probe");
    mkdirSync(wt, { recursive: true });
    recordWorktreeBase(wt, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    // A live pid keeps the owning directory out of the main reap loop entirely, isolating
    // this assertion to the widowed-sibling pass alone -- the thing under test.
    writeRunLock(wt, { pid: process.pid, run_id: "W1-T2628-owned-probe", startedAt: "2026-08-01T00:00:00Z" });
    const summary = reapStaleWorktrees(root, { now: () => 4_000_000_000_000 });
    assert.ok(existsSync(wt), "precondition: the owning directory is untouched (live pid)");
    assert.ok(
      existsSync(worktreeBasePath(wt)),
      "the base record is untouched -- its owning directory is still present",
    );
    assert.equal(summary.reapedLocks.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees dry-run removes NEITHER a widowed .base NOR a widowed .lock -- the survey only surveys", () => {
  const root = realpathSync(tmp("rmd-wt-record-dryrun-"));
  try {
    const baseWt = join(root, "run-W1-T2628-dryrun-base-probe");
    const lockWt = join(root, "run-W1-T2628-dryrun-lock-probe");
    recordWorktreeBase(baseWt, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    writeRunLock(lockWt, { pid: 1, run_id: "W1-T2628-dryrun-lock-probe", startedAt: "2026-08-01T00:00:00Z" });
    const summary = reapStaleWorktrees(root, { dryRun: true });
    assert.ok(existsSync(worktreeBasePath(baseWt)), "dry-run leaves the widowed base record on disk");
    assert.ok(existsSync(runLockPath(lockWt)), "dry-run leaves the widowed lock on disk");
    assert.ok(
      summary.reapedLocks.includes("run-W1-T2628-dryrun-base-probe.base"),
      "the survey still REPORTS what it would reclaim",
    );
    assert.ok(summary.reapedLocks.includes("run-W1-T2628-dryrun-lock-probe.lock"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("REGRESSION: a widowed .lock alone (no .base sibling) is still swept exactly as before, and the main reap loop's own pre-existing directory cleanup still removes BOTH siblings", () => {
  const root = realpathSync(tmp("rmd-wt-record-regress-"));
  try {
    // (a) widowed .lock alone -- pre-existing behaviour, unaffected by widening the suffix test.
    const lockOnlyWt = join(root, "run-W1-T2628-lock-only-probe");
    writeRunLock(lockOnlyWt, { pid: 1, run_id: "W1-T2628-lock-only-probe", startedAt: "2026-08-01T00:00:00Z" });

    // (b) a real, still-present worktree-shaped directory with a dead-pid lock -- exercises the
    // PRE-EXISTING (W1-T406) removeWorktreeBase call inside the main reap loop's OWN
    // directory-removal branch, confirming this task's suffix widening left it untouched.
    const reapedDirWt = join(root, "run-W1-T2628-reaped-dir-probe");
    mkdirSync(reapedDirWt, { recursive: true });
    writeRunLock(reapedDirWt, { pid: 97514, run_id: "W1-T2628-reaped-dir-probe", startedAt: "2026-08-01T00:00:00Z" });
    recordWorktreeBase(reapedDirWt, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

    const summary = reapStaleWorktrees(root, { isPidAlive: () => false });

    assert.ok(!existsSync(runLockPath(lockOnlyWt)), "the widowed-lock-alone case is still swept");
    assert.ok(summary.reapedLocks.includes("run-W1-T2628-lock-only-probe.lock"));

    assert.ok(!existsSync(reapedDirWt), "the dead-pid directory is reaped");
    assert.ok(!existsSync(runLockPath(reapedDirWt)), "its lock sibling goes with it");
    assert.ok(
      !existsSync(worktreeBasePath(reapedDirWt)),
      "its base sibling goes with it too -- the pre-existing W1-T406 cleanup, unaffected by this task",
    );
    assert.ok(summary.reaped.includes("run-W1-T2628-reaped-dir-probe"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
