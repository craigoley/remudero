/**
 * test/a-review-worktree-stranded-by-a-kill-is-swept-later.test.ts — pins
 * `sweepStrandedReviewWorktrees` (src/lib/review-worktree-reclaim.ts, W1-T3378), the sweep that
 * reclaims a `review-PR*` worktree the in-process `finally` never ran for (a SIGKILL, not a normal
 * exit).
 *
 * NOTHING HERE MOCKS GIT for the eligibility gate itself: every fixture below is a REAL bare
 * "origin" repo plus a REAL clone with a REAL linked worktree (`git worktree add --detach`),
 * exactly the shape `materializeReviewWorktree` creates. The claim under test is about what git's
 * own `ls-remote`/`rev-parse` report, which a mock cannot witness. Only the shared Clock port is
 * injected, so "later" is provable without a real 30-minute wait.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import { fixedClock } from "../src/lib/clock.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { reviewWorktreeHoldState, newestActivityMs, reapStaleWorktrees, reapStaleWorktreesAsync, runWorktreeReapRung, worktreesDir } from "../src/lib/worker.js";
import { daemonCommand, materializeReviewWorktree, withMaterializedWorktree } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";
import {
  DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS,
  holdReviewWorktree,
  releaseReviewWorktree,
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
function reviewFixture(): {
  config: Config;
  repoDir: string;
  originDir: string;
  worktreesRoot: string;
  universe: string;
  cleanup: () => void;
} {
  const universe = realpathSync(mkdtempSync(join(tmpdir(), "rmd-review-wt-sweep-")));
  const worktreesRoot = join(universe, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  const origin = gitRepo({ bare: true, kind: "review-wt-origin" });
  const seed = gitRepo({ kind: "review-wt-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const repo = gitRepo({ cloneFrom: origin.dir, kind: "review-wt-clone" });
  repo.git("config", "user.email", "t@t");
  repo.git("config", "user.name", "t");
  const config: Config = { claudeBin: "/bin/true", root: universe };
  return {
    config,
    repoDir: repo.dir,
    originDir: origin.dir,
    worktreesRoot,
    universe,
    cleanup: () => {
      repo.cleanup();
      seed.cleanup();
      origin.cleanup();
      rmSync(universe, { recursive: true, force: true });
    },
  };
}

/** Cut a REAL detached linked worktree at `sha`, named exactly as `materializeReviewWorktree`
 *  mints it, and advertise `sha` as PR `prNumber`'s current head on the bare origin — the
 *  "eligible" shape: nothing local diverges from what origin reports for this PR. */
function cutLinkedTree(
  u: ReturnType<typeof reviewFixture>,
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

function collector(): { log: (step: string, extra?: Record<string, unknown>) => void; rows: Array<{ step: string; extra?: Record<string, unknown> }> } {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { log: (step, extra) => rows.push({ step, extra }), rows };
}

// ── Criterion 1: a stranded worktree with no live owner is reclaimed LATER, not on the same tick ──

test("a stranded review worktree is swept by a later tick — past the grace window, with nothing unpushed, it is reclaimed", () => {
  const u = reviewFixture();
  try {
    const sha = headSha(u.repoDir);
    const { name, path } = cutLinkedTree(u, 4790, 1_000_000, sha);
    const { log, rows } = collector();

    const summary = sweepStrandedReviewWorktrees(u.config, log, {
      clock: fixedClock(1_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1),
    });

    assert.deepEqual(summary.reclaimed, [name], "the stranded worktree is reclaimed");
    assert.equal(existsSync(path), false, "and actually gone from disk");
    assert.ok(
      rows.some((r) => r.step === "review_worktree.sweep.reclaimed" && r.extra?.name === name),
      "the reclaim is ledgered",
    );
  } finally {
    u.cleanup();
  }
});

test("the SAME tick that just created the worktree does not touch it — 'swept LATER', never immediately, protects a slow live review", () => {
  const u = reviewFixture();
  try {
    const sha = headSha(u.repoDir);
    const { name, path } = cutLinkedTree(u, 4791, 2_000_000, sha);
    const { log } = collector();

    // The clock is still inside the grace window — a live `rmd review` could plausibly still be running.
    const summary = sweepStrandedReviewWorktrees(u.config, log, { clock: fixedClock(2_000_000 + 1000) });

    assert.deepEqual(summary.reclaimed, [], "nothing reclaimed yet");
    assert.deepEqual(summary.kept, [{ name, path, reason: "too-young" }]);
    assert.ok(existsSync(path), "the worktree survives the same-tick sweep");
  } finally {
    u.cleanup();
  }
});

// ── Criterion 2: unpushed commits refuse; an unreadable remote refuses too ─────────────────────

test("a review worktree with unpushed commits is never eligible — holding a commit absent from its remote, the sweep never removes it", () => {
  const u = reviewFixture();
  try {
    const sha = headSha(u.repoDir);
    const { name, path } = cutLinkedTree(u, 4792, 3_000_000, sha);
    // Simulate a human debugging inside the stranded worktree: a LOCAL commit git never shipped
    // anywhere. `refs/pull/4792/head` on origin still names the ORIGINAL sha.
    execFileSync("git", ["-C", path, "commit", "--allow-empty", "--quiet", "-m", "local debugging"], {
      encoding: "utf8",
      env: GIT_ENV,
    });
    const { log, rows } = collector();

    const summary = sweepStrandedReviewWorktrees(u.config, log, {
      clock: fixedClock(3_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1),
    });

    assert.deepEqual(summary.reclaimed, [], "the guard refuses removal");
    assert.deepEqual(summary.kept, [{ name, path, reason: "unpushed-commits" }]);
    assert.ok(existsSync(path), "the worktree — and the unshipped commit inside it — survives");
    assert.ok(rows.some((r) => r.step === "review_worktree.sweep.kept" && r.extra?.reason === "unpushed-commits"));
  } finally {
    u.cleanup();
  }
});

test("FALSIFIER: delete the unpushed-commit guard and the same fixture goes red — removeWorktree fires on unshipped work", () => {
  const u = reviewFixture();
  try {
    const sha = headSha(u.repoDir);
    const { path } = cutLinkedTree(u, 4793, 4_000_000, sha);
    execFileSync("git", ["-C", path, "commit", "--allow-empty", "--quiet", "-m", "local debugging"], {
      encoding: "utf8",
      env: GIT_ENV,
    });
    let removeCalled = false;
    const { log } = collector();

    // The guard removed: readRemoteHeadSha reports whatever localHead is, so "no commit absent
    // from remote" is trivially (and wrongly) satisfied every time.
    sweepStrandedReviewWorktrees(u.config, log, {
      clock: fixedClock(4_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1),
      readRemoteHeadSha: (_repoDir, _prNumber) =>
        execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      removeWorktree: () => {
        removeCalled = true;
      },
    });

    assert.equal(removeCalled, true, "without the guard, the unshipped commit is destroyed — this is the bug it prevents");
  } finally {
    u.cleanup();
  }
});

test("a review worktree whose remote cannot be read is never eligible — an unanswerable question is never a yes", () => {
  const u = reviewFixture();
  try {
    const sha = headSha(u.repoDir);
    const { name, path } = cutLinkedTree(u, 4794, 5_000_000, sha);
    // Point `origin` at a repo that no longer exists — every ls-remote against it fails.
    execFileSync("git", ["-C", u.repoDir, "remote", "set-url", "origin", join(u.universe, "no-such-remote.git")]);
    const { log } = collector();

    const summary = sweepStrandedReviewWorktrees(u.config, log, {
      clock: fixedClock(5_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1),
    });

    assert.deepEqual(summary.reclaimed, []);
    assert.deepEqual(summary.kept, [{ name, path, reason: "remote-unreadable" }]);
    assert.ok(existsSync(path));
  } finally {
    u.cleanup();
  }
});

test("unreadable git state and a failed removal are retained — every fail-closed branch names why it kept the candidate", () => {
  const u = reviewFixture();
  try {
    const sha = headSha(u.repoDir);
    const noRepo = "review-PR4800-1000";
    const noHead = "review-PR4801-1000";
    const removalFails = "review-PR4802-1000";
    const { log } = collector();

    const summary = sweepStrandedReviewWorktrees(u.config, log, {
      clock: fixedClock(DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1001),
      listEntries: () => [noRepo, noHead, removalFails],
      isDirectory: () => true,
      resolveRepoDir: (path) => (path.endsWith(noRepo) ? undefined : u.repoDir),
      readHeadSha: (path) => (path.endsWith(noHead) ? undefined : sha),
      readRemoteHeadSha: () => sha,
      removeWorktree: () => {
        throw new Error("permission denied");
      },
    });

    assert.deepEqual(summary.reclaimed, []);
    assert.deepEqual(
      summary.kept.map(({ name, reason }) => ({ name, reason })),
      [
        { name: noRepo, reason: "git-unreadable" },
        { name: noHead, reason: "git-unreadable" },
        { name: removalFails, reason: "removal-failed" },
      ],
    );
  } finally {
    u.cleanup();
  }
});

test("the default filesystem and git readers fail closed when a candidate vanishes or is malformed", () => {
  const u = reviewFixture();
  try {
    const missing = "review-PR4803-1000";
    const unreadablePointer = "review-PR4804-1000";
    const invalidHead = "review-PR4805-1000";
    mkdirSync(join(u.worktreesRoot, unreadablePointer));
    mkdirSync(join(u.worktreesRoot, invalidHead));
    writeFileSync(join(u.worktreesRoot, invalidHead, ".git"), `gitdir: ${join(u.repoDir, ".git", "worktrees", "not-real")}\n`);
    const { log } = collector();

    const summary = sweepStrandedReviewWorktrees(u.config, log, {
      clock: fixedClock(DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1001),
      listEntries: () => [missing, unreadablePointer, invalidHead],
    });

    assert.deepEqual(summary.reclaimed, []);
    assert.deepEqual(
      summary.kept.map(({ name, reason }) => ({ name, reason })),
      [
        { name: unreadablePointer, reason: "git-unreadable" },
        { name: invalidHead, reason: "git-unreadable" },
      ],
    );
  } finally {
    u.cleanup();
  }
});

// ── Criterion 3: every outcome ledgers its own reason — a silent sweep is never mistaken for an idle one ──

test("every sweep outcome ledgers its own decision reason, whether reclaimed or kept", () => {
  const u = reviewFixture();
  try {
    const sha = headSha(u.repoDir);
    const reclaimable = cutLinkedTree(u, 4795, 6_000_000, sha);
    const tooYoung = cutLinkedTree(u, 4796, 60_000_000, sha); // far in the "future" relative to `now` below
    const { log, rows } = collector();

    const summary = sweepStrandedReviewWorktrees(u.config, log, {
      clock: fixedClock(6_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1),
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
    u.cleanup();
  }
});

// ── Criterion 4: coverage/ and rmd-* temp directories are never candidates at all ──────────────

test("the sweep leaves coverage and temp directories alone — a real coverage/ and rmd-temp dir both untouched, closed to review worktrees by construction", () => {
  const u = reviewFixture();
  try {
    const sha = headSha(u.repoDir);
    const { name, path } = cutLinkedTree(u, 4797, 7_000_000, sha);
    const coverageDir = join(u.worktreesRoot, "coverage");
    const rmdTempDir = join(u.worktreesRoot, "rmd-proof-base-abcdef");
    mkdirSync(coverageDir, { recursive: true });
    writeFileSync(join(coverageDir, "lcov.info"), "not a worktree\n");
    mkdirSync(rmdTempDir, { recursive: true });
    let removeCalledWith: string[] = [];
    const { log, rows } = collector();

    const summary = sweepStrandedReviewWorktrees(u.config, log, {
      clock: fixedClock(7_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 1),
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
    u.cleanup();
  }
});

test("the real daemon command supplies the stranded-review-worktree sweep hook — deleting its live wiring leaves the core hook absent", async () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-review-worktree-daemon-wiring-"));
  const root = join(home, "state");
  const planPath = join(home, "plan.yaml");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  writeFileSync(planPath, "[]\n");
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.equal(typeof captured?.sweepStrandedReviewWorktrees, "function");
    assert.doesNotThrow(() => captured!.sweepStrandedReviewWorktrees!());
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── A live review is never reclaimed mid-review, however slow (PR #10741, 2026-10-10) ──

test("a review worktree this process still holds survives the sweep past its grace window, and is reclaimed once released", () => {
  const u = reviewFixture();
  try {
    const sha = headSha(u.repoDir);
    const { name, path } = cutLinkedTree(u, 10741, 3_000_000, sha);
    const late = fixedClock(3_000_000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 7 * 60_000);
    holdReviewWorktree(path);
    try {
      const held = sweepStrandedReviewWorktrees(u.config, collector().log, { clock: late });
      assert.deepEqual(held.reclaimed, [], "a held worktree is not reclaimed at 37 minutes");
      assert.deepEqual(held.kept, [{ name, path, reason: "live-review" }]);
      assert.ok(existsSync(path), "the live review's checkout is still on disk");
    } finally {
      releaseReviewWorktree(path);
    }
    const released = sweepStrandedReviewWorktrees(u.config, collector().log, { clock: late });
    assert.deepEqual(released.reclaimed, [name], "once released, the same worktree is reclaimable again");
    assert.equal(existsSync(path), false);
  } finally {
    u.cleanup();
  }
});

test("a worktree materializeReviewWorktree returns stays held for the whole withMaterializedWorktree body and is released at teardown", async () => {
  const u = reviewFixture();
  try {
    const sha = headSha(u.repoDir);
    const prNumber = 10742;
    execFileSync("git", ["-C", u.originDir, "update-ref", `refs/pull/${prNumber}/head`, sha], { encoding: "utf8" });
    const made = materializeReviewWorktree(u.config, u.repoDir, prNumber, sha, {
      fetch: () => {},
      addWorktree: (repoDir, path, revision) => {
        execFileSync("git", ["-C", repoDir, "worktree", "add", "--detach", path, revision], { encoding: "utf8", env: GIT_ENV });
      },
      revParseHead: (path) => headSha(path),
    });
    const path = made.worktreePath;
    assert.ok(path !== undefined, `materialized: ${JSON.stringify(made.failure)}`);
    const late = () => fixedClock(Date.now() + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 7 * 60_000);
    const during = await withMaterializedWorktree(
      path,
      u.repoDir,
      async () => sweepStrandedReviewWorktrees(u.config, collector().log, { clock: late() }),
      () => {},
    );
    assert.deepEqual(during.reclaimed, [], "the sweep never reclaims the checkout a running review still reads");
    assert.deepEqual(during.kept.map((k) => k.reason), ["live-review"]);
    assert.ok(existsSync(path));
    const after = sweepStrandedReviewWorktrees(u.config, collector().log, { clock: late() });
    assert.equal(after.reclaimed.length, 1, "teardown released the hold, so a checkout its removal left behind is reclaimable");
    assert.equal(existsSync(path), false);
  } finally {
    u.cleanup();
  }
});

for (const mode of ["sync", "async", "rung"] as const) {
  test(`both review reapers retain the held physical checkout through ${mode} general reaping, then release permits cleanup`, async () => {
    const u = reviewFixture();
    let path: string | undefined;
    try {
      const sha = headSha(u.repoDir);
      const prNumber = 12929;
      execFileSync("git", ["-C", u.originDir, "update-ref", `refs/pull/${prNumber}/head`, sha], { encoding: "utf8" });
      const made = materializeReviewWorktree(u.config, u.repoDir, prNumber, sha, {
        fetch: () => {}, // The exact head already exists in this private clone and bare origin.
        addWorktree: (repoDir, worktree, revision) => {
          execFileSync("git", ["-C", repoDir, "worktree", "add", "--detach", worktree, revision], { encoding: "utf8", env: GIT_ENV });
        },
        revParseHead: (worktree) => headSha(worktree),
      });
      path = made.worktreePath;
      assert.ok(path !== undefined, `materialized: ${JSON.stringify(made.failure)}`);
      assert.equal(headSha(path), sha, "the real detached physical checkout is at the advertised PR head");
      const name = path.slice(u.worktreesRoot.length + 1);
      const now = Date.now();
      const late = fixedClock(now + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 7 * 60_000);
      // This fixture's commit is empty, so only the directory and .git pointer carry activity.
      // The rung has no clock port: age these two PRIVATE entries, never a host clock or tree.
      const oldSeconds = (now - DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS - 7 * 60_000) / 1000;
      utimesSync(join(path, ".git"), oldSeconds, oldSeconds);
      utimesSync(path, oldSeconds, oldSeconds);
      const activity = newestActivityMs(path);
      assert.equal(activity.complete, true, "the actual bounded activity walk saw the entire fixture");
      assert.ok(activity.mtimeMs > 0 && now - activity.mtimeMs > DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS,
        "recent activity cannot accidentally protect the live review from this regression");
      const reaper = () => mode === "rung" ? runWorktreeReapRung(u.config, collector().log)
        : mode === "async" ? reapStaleWorktreesAsync(u.worktreesRoot, { now: () => late.now() })
        : reapStaleWorktrees(u.worktreesRoot, { now: () => late.now() });

      const reviewHeld = sweepStrandedReviewWorktrees(u.config, collector().log, { clock: late });
      assert.deepEqual(reviewHeld.reclaimed, []);
      assert.deepEqual(reviewHeld.kept, [{ name, path, reason: "live-review" }]);
      const genericHeld = await reaper();
      assert.deepEqual(genericHeld.reaped, [], "the general reaper must honor the SAME active review hold");
      assert.ok(existsSync(path), "the later deterministic proofs still have their physical head checkout");
      assert.equal(headSha(path), sha);
      assert.ok(genericHeld.kept.includes(name));

      releaseReviewWorktree(path);
      const released = await reaper();
      assert.deepEqual(released.reaped, [name], "a released old detached review is genuine cleanup, not a permanent exception");
      assert.equal(existsSync(path), false);
    } finally {
      if (path !== undefined) releaseReviewWorktree(path);
      u.cleanup();
    }
  });
}


test("a separate review worker protects its real checkout from both reapers until its existing claim releases", async () => {
  const u = reviewFixture();
  const pr = 13947;
  const runId = `review-PR${pr}-1234`;
  const claimsDir = join(u.universe, "state", "inflight", "review-workers");
  const lockId = `review-worker-${createHash("sha256").update(runId).digest("hex")}`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {acquireInflightLock} from "#src/lib/inflight-lock.js";
    const held = acquireInflightLock(${JSON.stringify(claimsDir)}, ${JSON.stringify(lockId)}, {run_id:${JSON.stringify(runId)}, reclaim:false});
    process.stdin.resume();
    process.stdout.write("OWNED\\n");
    try { await new Promise(resolve => process.stdin.once("end", resolve)); }
    finally { held.release(); }
  `], {cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"]});
  const exit = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const ready = await Promise.race([once(child.stdout, "data"), exit.then(() => { throw new Error(`owner exited: ${stderr}`); })]);
    assert.match(String(ready[0]), /OWNED/);
    assert.notEqual(child.pid, process.pid, "ownership is in another real process, not the local hold set");
    const late = fixedClock(Date.now() + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 60_000);
    const trees = [1, 2, 3].map(n => cutLinkedTree(u, pr, n, headSha(u.repoDir)));
    const held = sweepStrandedReviewWorktrees(u.config, collector().log, {clock: late});
    assert.deepEqual(held.reclaimed, []);
    assert.equal(held.kept.filter(x => x.reason === "live-review").length, 3);
    const sync = reapStaleWorktrees(u.worktreesRoot, {now: () => late.now()});
    const asyncResult = await reapStaleWorktreesAsync(u.worktreesRoot, {now: () => late.now()});
    assert.deepEqual(sync.reaped, []);
    assert.deepEqual(asyncResult.reaped, []);
    for (const tree of trees) assert.equal(headSha(tree.path), headSha(u.repoDir), "real proof checkout survives");
    assert.ok(existsSync(join(claimsDir, `${lockId}.lock`)), "neither reaper changes the owner's claim");
    child.stdin.end();
    const [code] = await exit;
    assert.equal(code, 0, stderr);
    assert.equal(existsSync(join(claimsDir, `${lockId}.lock`)), false, "normal owner release remains authoritative");
    const released = sweepStrandedReviewWorktrees(u.config, collector().log, {clock: late});
    assert.deepEqual(released.reclaimed.sort(), trees.map(x => x.name).sort());
    for (const tree of trees) assert.equal(existsSync(tree.path), false);
  } finally {
    child.stdin.end();
    await exit;
    u.cleanup();
  }
});

test("unreadable or malformed shared review ownership keeps the checkout as UNKNOWN without changing claims", () => {
  const u = reviewFixture();
  try {
    const tree = cutLinkedTree(u, 13947, 1, headSha(u.repoDir));
    const late = fixedClock(Date.now() + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 60_000);
    const parent = join(u.universe, "state", "inflight");
    mkdirSync(parent, {recursive:true});
    const claimsDir = join(parent, "review-workers");
    // ENOTDIR is a real failed enumeration, independent of privilege-dependent mode bits.
    writeFileSync(claimsDir, "unreadable-directory-control");
    const unreadable = sweepStrandedReviewWorktrees(u.config, collector().log, {clock: late});
    assert.deepEqual(unreadable.reclaimed, []);
    assert.equal(unreadable.kept[0]?.reason, "review-ownership-unknown");
    assert.deepEqual(reapStaleWorktrees(u.worktreesRoot, {now: () => late.now()}).reaped, []);
    rmSync(claimsDir);
    mkdirSync(claimsDir);
    const malformed = join(claimsDir, "review-worker-torn.lock");
    writeFileSync(malformed, '{"run_id":');
    const held = sweepStrandedReviewWorktrees(u.config, collector().log, {clock: late});
    assert.equal(held.kept[0]?.reason, "review-ownership-unknown");
    assert.ok(existsSync(malformed), "read-only ownership check preserves the original damaged evidence");
    assert.equal(headSha(tree.path), headSha(u.repoDir));
    rmSync(malformed);
    const released = sweepStrandedReviewWorktrees(u.config, collector().log, {clock: late});
    assert.deepEqual(released.reclaimed, [tree.name]);
  } finally { u.cleanup(); }
});


test("shared review claims protect only their PR and unverifiable identity never becomes absence", () => {
  const u = reviewFixture();
  try {
    const candidate = join(u.worktreesRoot, "review-PR13947-1");
    const claimsDir = join(u.universe, "state", "inflight", "review-workers");
    mkdirSync(claimsDir, {recursive:true});
    const runId = "review-PR139470-2";
    const lock = join(claimsDir, `review-worker-${createHash("sha256").update(runId).digest("hex")}.lock`);
    writeFileSync(lock, JSON.stringify({run_id:runId, pid:process.pid}));
    assert.equal(reviewWorktreeHoldState(candidate), "unheld", "PR prefixes do not alias");
    assert.equal(reviewWorktreeHoldState(join(u.worktreesRoot, "run-other-1")), "unheld");
    rmSync(lock);
    const matching = "review-PR13947-3";
    const exact = join(claimsDir, `review-worker-${createHash("sha256").update(matching).digest("hex")}.lock`);
    for (const record of [null, {run_id:matching, pid:0}, {run_id:"unknown", pid:process.pid}]) {
      writeFileSync(exact, JSON.stringify(record));
      assert.equal(reviewWorktreeHoldState(candidate), "unknown");
    }
    writeFileSync(exact, JSON.stringify({run_id:matching, pid:2147483647, host:"foreign", startedAt:"unknown"}));
    assert.equal(reviewWorktreeHoldState(candidate), "held", "PID absence or an unverifiable host never grants destruction");
    rmSync(exact);
    writeFileSync(join(claimsDir, "unrecognized.lock"), JSON.stringify({run_id:matching, pid:process.pid}));
    assert.equal(reviewWorktreeHoldState(candidate), "unknown", "a mismatched filename is not a trustworthy owner identity");
  } finally {u.cleanup();}
});
