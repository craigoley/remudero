import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Config } from "../src/lib/config.js";
import { appendLedger } from "../src/lib/ledger.js";
import { pruneStaleRuns, reapStaleWorktrees, runLockPath, writeRunLock } from "../src/lib/worker.js";
import { buildSweepHook, sweepCommand } from "../src/run-task.js";

// pruneStaleRuns needs a real git repo + worktree to exercise `git worktree list`.
// Build one: repoDir with a NAMED worktree under worktreesRoot, then assert the
// liveness guard skips a live-pid worktree and reaps a dead/absent-lock one.
function makeRepoWithNamedWorktree(
  dirName: string,
  branch: string,
): {
  dir: string;
  repoDir: string;
  worktreesRoot: string;
  wtPath: string;
  dirName: string;
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
  const wtPath = join(worktreesRoot, dirName);
  git("worktree", "add", "-b", branch, wtPath);
  return { dir, repoDir, worktreesRoot, wtPath, dirName, branch };
}

function makeRepoWithRunWorktree(): {
  dir: string;
  repoDir: string;
  worktreesRoot: string;
  wtPath: string;
  branch: string;
} {
  const branch = "run-W1-T7-1784075267898";
  return makeRepoWithNamedWorktree(branch, branch);
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

// ── W1-T175: reapStaleWorktrees — closes pruneStaleRuns' three coverage holes ──────────────
// (1) a directory git no longer registers, (2) the cadence hole (fires only at run start),
// (3) detached-HEAD sweep-* orphans + widowed .lock files. See worker.ts's block comment
// above reapStaleWorktrees for the full rationale.

test("reapStaleWorktrees: REAPS a directory git no longer registers — the confirmed hole (1) that stranded 453M — once past the age gate with a stale lock naming a dead pid", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-invisible-")));
  try {
    const entryPath = join(root, "run-W1-T156-1784574954974");
    // Deliberately NOT a real git worktree — no `.git` gitdir pointer at all — so no
    // `git worktree list --porcelain`, for any repo, can ever register it. That is the
    // exact git-invisible shape hole (1) exists to cover.
    mkdirSync(entryPath, { recursive: true });
    writeRunLock(entryPath, { pid: 97514, run_id: "W1-T156-1784574954974", startedAt: "2026-07-20T19:17:23.863Z" });

    const summary = reapStaleWorktrees(root, {
      isPidAlive: (p) => p !== 97514, // 97514 is dead — killed by the host restart
      now: () => 4_000_000_000_000, // far past the age gate
    });
    assert.ok(!existsSync(entryPath), "a git-invisible, dead-pid, aged directory is reaped");
    assert.ok(summary.reaped.includes("run-W1-T156-1784574954974"));
    assert.ok(!existsSync(runLockPath(entryPath)), "its stale lock sibling is cleared on reap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: KEEPS a worktree whose run.lock names a LIVE pid — never reaped, however old (fail-closed)", () => {
  const t = makeRepoWithNamedWorktree("run-W1-T900-live", "run-W1-T900-1784000000000");
  try {
    writeRunLock(t.wtPath, { pid: process.pid, run_id: "W1-T900-1784000000000", startedAt: "2026-07-20T00:00:00Z" });
    const summary = reapStaleWorktrees(t.worktreesRoot, {
      now: () => 4_000_000_000_000,
      branchIsLiveUpstream: () => false, // even a "branch is gone" signal must lose to a live pid
    });
    assert.ok(existsSync(t.wtPath), "a LIVE-pid worktree must NOT be force-removed");
    assert.ok(summary.kept.includes(t.dirName));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: KEEPS a worktree whose branch backs an OPEN, unmerged PR — even past the age gate and with NO run.lock at all (the sweep-W1-T154 falsifier: a blanket age-only sweep would have destroyed in-flight work)", () => {
  const t = makeRepoWithNamedWorktree("sweep-W1-T154-1784578318525", "run-W1-T154-1784573313900");
  try {
    // No run.lock at all — sweep-* dirs write none (hole 3). Only the branch/PR signal
    // stands between this entry and a force-remove.
    const summary = reapStaleWorktrees(t.worktreesRoot, {
      now: () => 4_000_000_000_000,
      branchIsLiveUpstream: (branch) => branch === t.branch, // simulates: still backs an OPEN PR
    });
    assert.ok(existsSync(t.wtPath), "a worktree backing an OPEN PR must NOT be reaped");
    assert.ok(summary.kept.includes(t.dirName));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: REAPS a worktree once its branch is confirmed merged-or-deleted upstream, past the age gate", () => {
  const t = makeRepoWithNamedWorktree("sweep-W1-T156-1784574954954", "run-W1-T156-1784574954900");
  try {
    const summary = reapStaleWorktrees(t.worktreesRoot, {
      now: () => 4_000_000_000_000,
      branchIsLiveUpstream: () => false, // simulates: `gh api .../branches/<b>` => 404, deleted upstream
    });
    assert.ok(!existsSync(t.wtPath), "a merged/deleted-branch worktree is reaped once aged");
    assert.ok(summary.reaped.includes(t.dirName));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: PROTECTS a git-invisible, dead-pid directory within the age gate (mirrors pruneStaleRuns' create-before-lock grace)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-grace-")));
  try {
    const entryPath = join(root, "sweep-fresh-1");
    mkdirSync(entryPath, { recursive: true });
    writeRunLock(entryPath, { pid: 97514, run_id: "X", startedAt: new Date().toISOString() });
    // Dead pid, but freshly created (real clock/mtime) — still inside the default age gate.
    const summary = reapStaleWorktrees(root, { isPidAlive: () => false });
    assert.ok(existsSync(entryPath), "a just-created entry is not reaped inside the default age gate");
    assert.ok(summary.kept.includes("sweep-fresh-1"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: REAPS a widowed .lock file whose worktree directory is already gone (hole 3 — removeRunLock only fires INSIDE a successful removal, so a lock orphaned any other way lingers forever)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-widow-")));
  try {
    // `writeRunLock` writes `<path>.lock`; deliberately never create the owning dir.
    writeRunLock(join(root, "run-W1-T999-orphan"), {
      pid: 1,
      run_id: "W1-T999",
      startedAt: "2026-07-01T00:00:00Z",
    });
    const summary = reapStaleWorktrees(root);
    assert.ok(!existsSync(join(root, "run-W1-T999-orphan.lock")), "a widowed lock with no owning dir is removed");
    assert.ok(summary.reapedLocks.includes("run-W1-T999-orphan.lock"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: does NOT touch a `.lock` whose owning worktree directory still exists", () => {
  const t = makeRepoWithNamedWorktree("run-W1-T901-owned", "run-W1-T901-1784000000000");
  try {
    writeRunLock(t.wtPath, { pid: process.pid, run_id: "W1-T901", startedAt: "2026-07-20T00:00:00Z" });
    const summary = reapStaleWorktrees(t.worktreesRoot, { now: () => 4_000_000_000_000 });
    assert.ok(existsSync(runLockPath(t.wtPath)), "the owned lock is untouched — its dir is still present");
    assert.equal(summary.reapedLocks.length, 0);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

// ── CADENCE (hole 2): the reaper runs from `rmd sweep` AND from the daemon's own per-poll ──
// ── buildSweepHook, not only at a run's own start — an idle fleet must still reap. ─────────

test("W1-T175 cadence: buildSweepHook (the daemon's per-poll sweep) reaps a stale worktree directory — an idle fleet still reaps, not only a run's own start", async () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-reap-hook-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const root = mkdtempSync(join(tmpdir(), "rmd-reap-cadence-hook-"));
  try {
    const worktreesRoot = join(root, "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    const staleDir = join(worktreesRoot, "sweep-STALE-1784000000000");
    // Not a real git worktree (git-invisible), dead pid, and backdated well past
    // DEFAULT_PRUNE_GRACE_MS (2 min) — unambiguous debris.
    mkdirSync(staleDir, { recursive: true });
    writeRunLock(staleDir, { pid: 999999, run_id: "STALE", startedAt: "2026-07-01T00:00:00Z" });
    const past = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(staleDir, past, past);

    const ledgerPath = join(root, "ledger.ndjson");
    const log = (step: string, extra: Record<string, unknown> = {}) =>
      appendLedger(ledgerPath, { run_id: "SWEEP-1", task_id: "SWEEP", step, ...extra });
    const hook = buildSweepHook(
      "o",
      "r",
      { root, claudeBin: "/bin/true" } as Config,
      ledgerPath,
      "SWEEP-1",
      { tasks: [], byId: new Map() },
      log,
    );
    await hook();

    assert.ok(!existsSync(staleDir), "the daemon's own per-poll sweep reaped the stale worktree — no run had to start");
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(
      lines.some((l) => l.step === "worktree.reaped" && Array.isArray(l.reaped) && l.reaped.includes("sweep-STALE-1784000000000")),
      "worktree.reaped is ledgered, naming the reaped dir",
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T175 cadence: `rmd sweep` reaps a stale worktree directory on the SAME cadence as the daemon's per-poll hook", async () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-reap-cmd-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const home = mkdtempSync(join(tmpdir(), "rmd-reap-cmd-home-"));
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  const configRoot = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root: configRoot }));
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.HOME = home;
  try {
    const worktreesRoot = join(configRoot, "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    const staleDir = join(worktreesRoot, "sweep-STALE-CLI-1784000000000");
    mkdirSync(staleDir, { recursive: true });
    writeRunLock(staleDir, { pid: 999999, run_id: "STALE", startedAt: "2026-07-01T00:00:00Z" });
    const past = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(staleDir, past, past);

    const code = await sweepCommand(["--repo", "remudero-sandbox"]);
    assert.equal(code, 0);
    assert.ok(!existsSync(staleDir), "`rmd sweep` reaped the stale worktree via the SAME reapStaleWorktrees");

    const ledgerPath = join(configRoot, "state", "ledger.ndjson");
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(
      lines.some((l) => l.step === "worktree.reaped" && Array.isArray(l.reaped) && l.reaped.includes("sweep-STALE-CLI-1784000000000")),
      "worktree.reaped is ledgered, naming the reaped dir",
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T175 cadence: `rmd sweep --dry-run` does NOT reap — matches every other rung in this command", async () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-reap-dry-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const home = mkdtempSync(join(tmpdir(), "rmd-reap-dry-home-"));
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  const configRoot = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root: configRoot }));
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.HOME = home;
  try {
    const worktreesRoot = join(configRoot, "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    const staleDir = join(worktreesRoot, "sweep-STALE-DRY-1784000000000");
    mkdirSync(staleDir, { recursive: true });
    writeRunLock(staleDir, { pid: 999999, run_id: "STALE", startedAt: "2026-07-01T00:00:00Z" });
    const past = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(staleDir, past, past);

    const code = await sweepCommand(["--repo", "remudero-sandbox", "--dry-run"]);
    assert.equal(code, 0);
    assert.ok(existsSync(staleDir), "--dry-run takes no effects, same contract as the other sweep rungs");
  } finally {
    process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
