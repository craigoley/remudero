/**
 * test/a-review-worktree-stranded-by-a-kill-is-swept-later.test.ts — pins
 * `sweepStrandedReviewWorktrees` (src/lib/review-worktree-reclaim.ts, W1-T3378), the sweep that
 * reclaims a `review-PR*` worktree the in-process `finally` never ran for (a SIGKILL, not a normal
 * exit).
 *
 * NOTHING HERE MOCKS GIT for the eligibility gate itself: every fixture below is a REAL bare
 * "origin" repo plus a REAL clone with a REAL linked worktree (`git worktree add --detach`),
 * exactly the shape `materializeReviewWorktree` creates. The claim under test is about what git's
 * own `ls-remote`/`rev-parse` report, which a mock cannot witness. Only the clock is injected
 * (`now`), so "later" is provable without a real 30-minute wait.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import { worktreesDir } from "../src/lib/worker.js";
import {
  DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS,
  sweepStrandedReviewWorktrees,
} from "../src/lib/review-worktree-reclaim.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/** A bare "origin" + a real clone ("repoDir") registered against it, and an empty `worktrees/`
 *  sibling — the exact universe `worktreesDir(config)` + `materializeReviewWorktree`'s `repoDir`
 *  form in production. `realpathSync` so paths match `git worktree list`/`.git` pointer output on
 *  macOS (/var → /private/var). */
function reviewWorktreeUniverse(): { config: Config; repoDir: string; originDir: string; worktreesRoot: string; universe: string } {
  const universe = realpathSync(mkdtempSync(join(tmpdir(), "rmd-review-wt-sweep-")));
  const originDir = join(universe, "origin.git");
  const repoDir = join(universe, "repo");
  const worktreesRoot = join(universe, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", originDir], { encoding: "utf8" });
  execFileSync("git", ["clone", "--quiet", originDir, repoDir], { encoding: "utf8", env: GIT_ENV });
  const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", env: GIT_ENV });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");
  git("push", "--quiet", "origin", "main");
  const config: Config = { claudeBin: "/bin/true", root: universe };
  return { config, repoDir, originDir, worktreesRoot, universe };
}

/** Cut a REAL detached linked worktree at `sha`, named exactly as `materializeReviewWorktree`
 *  mints it, and advertise `sha` as PR `prNumber`'s current head on the bare origin — the
 *  "eligible" shape: nothing local diverges from what origin reports for this PR. */
function cutReviewWorktree(
  u: ReturnType<typeof reviewWorktreeUniverse>,
  prNumber: number,
  createdAtMs: number,
  sha: string,
): { name: string; path: string } {
  const name = `review-PR${prNumber}-${createdAtMs}`;
  const path = join(u.worktreesRoot, name);
  execFileSync("git", ["-C", u.repoDir, "worktree", "add", "--detach", path, sha], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", u.originDir, "update-ref", `refs/pull/${prNumber}/head`, sha], { encoding: "utf8" });
  return { name, path };
}

function headSha(repoDir: string): string {
  return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function collectLedger(): { log: (step: string, extra?: Record<string, unknown>) => void; rows: Array<{ step: string; extra?: Record<string, unknown> }> } {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { log: (step, extra) => rows.push({ step, extra }), rows };
}

// ── Criterion 1: a stranded worktree with no live owner is reclaimed LATER, not on the same tick ──

test("a review worktree stranded by a kill, past the grace window, with nothing unpushed, is reclaimed", () => {
  const u = reviewWorktreeUniverse();
  try {
    const sha = headSha(u.repoDir);
    const { name, path } = cutReviewWorktree(u, 4790, 1_000_000, sha);
    const { log, rows } = collectLedger();

    const summary = sweepStrandedReviewWorktrees(u.config, log, {
      now: () => 1_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1,
    });

    assert.deepEqual(summary.reclaimed, [name], "the stranded worktree is reclaimed");
    assert.equal(existsSync(path), false, "and actually gone from disk");
    assert.ok(
      rows.some((r) => r.step === "review_worktree.sweep.reclaimed" && r.extra?.name === name),
      "the reclaim is ledgered",
    );
  } finally {
    rmSync(u.universe, { recursive: true, force: true });
  }
});

test("the SAME tick that just created the worktree does not touch it — 'swept LATER', never immediately, protects a slow live review", () => {
  const u = reviewWorktreeUniverse();
  try {
    const sha = headSha(u.repoDir);
    const { name, path } = cutReviewWorktree(u, 4791, 2_000_000, sha);
    const { log } = collectLedger();

    // "now" is still inside the grace window — a live `rmd review` could plausibly still be running.
    const summary = sweepStrandedReviewWorktrees(u.config, log, { now: () => 2_000_000 + 1000 });

    assert.deepEqual(summary.reclaimed, [], "nothing reclaimed yet");
    assert.deepEqual(summary.kept, [{ name, path, reason: "too-young" }]);
    assert.ok(existsSync(path), "the worktree survives the same-tick sweep");
  } finally {
    rmSync(u.universe, { recursive: true, force: true });
  }
});

// ── Criterion 2: unpushed commits refuse; an unreadable remote refuses too ─────────────────────

test("a review worktree holding a commit absent from its remote is never eligible — the sweep never removes it", () => {
  const u = reviewWorktreeUniverse();
  try {
    const sha = headSha(u.repoDir);
    const { name, path } = cutReviewWorktree(u, 4792, 3_000_000, sha);
    // Simulate a human debugging inside the stranded worktree: a LOCAL commit git never shipped
    // anywhere. `refs/pull/4792/head` on origin still names the ORIGINAL sha.
    execFileSync("git", ["-C", path, "commit", "--allow-empty", "--quiet", "-m", "local debugging"], {
      encoding: "utf8",
      env: GIT_ENV,
    });
    const { log, rows } = collectLedger();

    const summary = sweepStrandedReviewWorktrees(u.config, log, {
      now: () => 3_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1,
    });

    assert.deepEqual(summary.reclaimed, [], "the guard refuses removal");
    assert.deepEqual(summary.kept, [{ name, path, reason: "unpushed-commits" }]);
    assert.ok(existsSync(path), "the worktree — and the unshipped commit inside it — survives");
    assert.ok(rows.some((r) => r.step === "review_worktree.sweep.kept" && r.extra?.reason === "unpushed-commits"));
  } finally {
    rmSync(u.universe, { recursive: true, force: true });
  }
});

test("FALSIFIER: delete the unpushed-commit guard and the same fixture goes red — removeWorktree fires on unshipped work", () => {
  const u = reviewWorktreeUniverse();
  try {
    const sha = headSha(u.repoDir);
    const { path } = cutReviewWorktree(u, 4793, 4_000_000, sha);
    execFileSync("git", ["-C", path, "commit", "--allow-empty", "--quiet", "-m", "local debugging"], {
      encoding: "utf8",
      env: GIT_ENV,
    });
    let removeCalled = false;
    const { log } = collectLedger();

    // The guard removed: readRemoteHeadSha reports whatever localHead is, so "no commit absent
    // from remote" is trivially (and wrongly) satisfied every time.
    sweepStrandedReviewWorktrees(u.config, log, {
      now: () => 4_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1,
      readRemoteHeadSha: (_repoDir, _prNumber) =>
        execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      removeWorktree: () => {
        removeCalled = true;
      },
    });

    assert.equal(removeCalled, true, "without the guard, the unshipped commit is destroyed — this is the bug it prevents");
  } finally {
    rmSync(u.universe, { recursive: true, force: true });
  }
});

test("a review worktree whose remote cannot be read is never eligible — an unanswerable question is never a yes", () => {
  const u = reviewWorktreeUniverse();
  try {
    const sha = headSha(u.repoDir);
    const { name, path } = cutReviewWorktree(u, 4794, 5_000_000, sha);
    // Point `origin` at a repo that no longer exists — every ls-remote against it fails.
    execFileSync("git", ["-C", u.repoDir, "remote", "set-url", "origin", join(u.universe, "no-such-remote.git")]);
    const { log } = collectLedger();

    const summary = sweepStrandedReviewWorktrees(u.config, log, {
      now: () => 5_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1,
    });

    assert.deepEqual(summary.reclaimed, []);
    assert.deepEqual(summary.kept, [{ name, path, reason: "remote-unreadable" }]);
    assert.ok(existsSync(path));
  } finally {
    rmSync(u.universe, { recursive: true, force: true });
  }
});

// ── Criterion 3: every outcome ledgers its own reason — a silent sweep is never mistaken for an idle one ──

test("every sweep outcome ledgers its own decision reason, whether reclaimed or kept", () => {
  const u = reviewWorktreeUniverse();
  try {
    const sha = headSha(u.repoDir);
    const reclaimable = cutReviewWorktree(u, 4795, 6_000_000, sha);
    const tooYoung = cutReviewWorktree(u, 4796, 60_000_000, sha); // far in the "future" relative to `now` below
    const { log, rows } = collectLedger();

    const summary = sweepStrandedReviewWorktrees(u.config, log, {
      now: () => 6_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1,
    });

    assert.deepEqual(summary.reclaimed, [reclaimable.name]);
    assert.deepEqual(summary.kept, [{ name: tooYoung.name, path: tooYoung.path, reason: "too-young" }]);
    // Both candidates produced a ledger row naming their own outcome — nothing is silent.
    assert.ok(rows.some((r) => r.step === "review_worktree.sweep.reclaimed" && r.extra?.name === reclaimable.name));
    assert.ok(
      rows.some(
        (r) => r.step === "review_worktree.sweep.kept" && r.extra?.name === tooYoung.name && r.extra?.reason === "too-young",
      ),
    );
  } finally {
    rmSync(u.universe, { recursive: true, force: true });
  }
});

// ── Criterion 4: coverage/ and rmd-* temp directories are never candidates at all ──────────────

test("the sweep leaves coverage and rmd-temp directories alone — closed to review worktrees by construction", () => {
  const u = reviewWorktreeUniverse();
  try {
    const sha = headSha(u.repoDir);
    const { name, path } = cutReviewWorktree(u, 4797, 7_000_000, sha);
    const coverageDir = join(u.worktreesRoot, "coverage");
    const rmdTempDir = join(u.worktreesRoot, "rmd-proof-base-abcdef");
    mkdirSync(coverageDir, { recursive: true });
    writeFileSync(join(coverageDir, "lcov.info"), "not a worktree\n");
    mkdirSync(rmdTempDir, { recursive: true });
    let removeCalledWith: string[] = [];
    const { log, rows } = collectLedger();

    const summary = sweepStrandedReviewWorktrees(u.config, log, {
      now: () => 7_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1,
      removeWorktree: (_repoDir, wt) => {
        removeCalledWith.push(wt);
        execFileSync("git", ["-C", u.repoDir, "worktree", "remove", "--force", wt]);
      },
    });

    assert.deepEqual(summary.reclaimed, [name], "only the review-PR* candidate is ever considered");
    assert.ok(existsSync(coverageDir), "coverage/ is untouched");
    assert.ok(existsSync(rmdTempDir), "the rmd-* temp dir is untouched");
    assert.deepEqual(removeCalledWith, [path], "removeWorktree is never called for coverage/ or rmd-*");
    assert.ok(
      !rows.some((r) => r.extra?.name === "coverage" || r.extra?.name === "rmd-proof-base-abcdef"),
      "neither non-candidate is even ledgered — they were never candidates",
    );
  } finally {
    rmSync(u.universe, { recursive: true, force: true });
  }
});
