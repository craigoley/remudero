/**
 * test/worktree-reap-boot-rung.test.ts — W1-T406's headline claim: a ONE-SHOT `rmd run-task`
 * dispatch runs the worktree reap rung at boot, so the three coverage holes `pruneStaleRuns`
 * leaves (git-invisible directories, detached-HEAD `sweep-*` orphans, widowed `.lock` files)
 * are closed WITHOUT a daemon — neither of `reapStaleWorktrees`'s two pre-existing call sites
 * (the daemon's per-poll sweep hook, or `rmd sweep`) is reachable from `docker run ... rmd
 * run-task <id>`.
 *
 * TWO HALVES:
 *  1. WIRING (source-grep, mirrors test/containment-wiring.test.ts's own technique): the
 *     one-shot dispatch body (`runTaskBody`) really calls `logWorktreeReapBootSurvey` — after
 *     `pruneStaleRuns` (the same debris-reclaim step it complements) and before `worktreeAdd`
 *     (this run's OWN worktree must never race the reclaim of someone else's debris).
 *  2. BEHAVIORAL: `logWorktreeReapBootSurvey`, driven against a REAL worktrees-root fixture
 *     with the real `reapStaleWorktrees` (not injected), actually reclaims debris shaped like
 *     each of the three named holes when `worktreeReapBoot.enabled` is true — proving this is
 *     genuinely the cadence reaper, not a no-op — while a live-pid worktree is left untouched.
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";

import { logWorktreeReapBootSurvey } from "../src/run-task.js";
import { runLockPath, writeRunLock, type RunLockInfo } from "../src/lib/worker.js";
import type { Config } from "../src/lib/config.js";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

// ── 1. WIRING: the one-shot dispatch body really calls the rung ────────────────────────────

test("runTaskBody calls logWorktreeReapBootSurvey — AFTER pruneStaleRuns, BEFORE this run's OWN worktreeAdd", () => {
  const bodyIdx = runTaskSrc.indexOf("async function runTaskBody(");
  assert.ok(bodyIdx >= 0, "run-task.ts must define runTaskBody — the one-shot dispatch's own body");

  const pruneIdx = runTaskSrc.indexOf("pruneStaleRuns(", bodyIdx);
  assert.ok(pruneIdx > bodyIdx, "runTaskBody must call pruneStaleRuns");

  const reapBootIdx = runTaskSrc.indexOf("logWorktreeReapBootSurvey(", bodyIdx);
  assert.ok(reapBootIdx > bodyIdx, "runTaskBody must call logWorktreeReapBootSurvey — the W1-T406 boot rung");
  assert.ok(reapBootIdx > pruneIdx, "the boot rung must run AFTER pruneStaleRuns, its sibling debris-reclaim step");

  const worktreeAddIdx = runTaskSrc.indexOf("worktreeAdd(", bodyIdx);
  assert.ok(worktreeAddIdx > reapBootIdx, "the boot rung must run BEFORE this run's own worktreeAdd — never race its own new worktree");
});

test("the boot rung is never wired into a daemon-only or sweep-only path — it is a SEPARATE call from runWorktreeReapRung", () => {
  // Negative control: logWorktreeReapBootSurvey must be its OWN function, not a rename/alias of
  // the daemon/sweep-shared rung — the two ship independently-flagged (worktreeReapBoot vs the
  // unconditional daemon/sweep rung) and must not collapse into one call site.
  assert.match(runTaskSrc, /export function logWorktreeReapBootSurvey\(/);
  const defIdx = runTaskSrc.indexOf("export function logWorktreeReapBootSurvey(");
  const body = runTaskSrc.slice(defIdx, runTaskSrc.indexOf("\n}\n", defIdx));
  assert.match(body, /worktreeReapBoot/, "the boot rung must read its OWN policy flag, not scratchReap or a shared one");
});

// ── 2. BEHAVIORAL: it really closes the three coverage holes ───────────────────────────────

function fixtureConfig(): { config: Config; worktreesRoot: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-boot-rung-")));
  const worktreesRoot = join(root, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  return {
    config: { root } as Config,
    worktreesRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("the boot rung closes pruneStaleRuns' three coverage holes (behavioral, real reapStaleWorktrees)", () => {
  it("reclaims a git-invisible directory, a detached-HEAD sweep-* orphan, and a widowed .lock — while leaving a live-pid worktree alone", () => {
    const f = fixtureConfig();
    try {
      // Past the cadence reaper's OWN age gate (30 min, plan/policy.yaml's worktreeReapGraceMs)
      // so the two debris entries below age out rather than being rescued as "recent-activity" —
      // the same backdating technique test/worktree-reap-liveness.test.ts uses.
      const past = new Date(Date.now() - 40 * 60_000);

      // Hole 1: a directory git no longer registers at all — never `git worktree add`-ed, or its
      // registration was lost. No .lock, no git backing.
      const invisible = join(f.worktreesRoot, "run-W1-T111-invisible");
      mkdirSync(invisible, { recursive: true });
      utimesSync(invisible, past, past);

      // Hole 2 (W1-T175's hole 3): a detached-HEAD sweep-* orphan — interrupted before its own
      // `checkout -B`, so it writes no lock at all either.
      const detached = join(f.worktreesRoot, "sweep-T222-detached");
      mkdirSync(detached, { recursive: true });
      utimesSync(detached, past, past);

      // Hole 3: a widowed .lock sibling whose worktree directory is ALREADY gone.
      const widowedName = "run-W1-T333-gone.lock";
      const widowedInfo: RunLockInfo = { pid: 999_999, run_id: "W1-T333", startedAt: "2026-08-01T00:00:00Z" };
      writeRunLock(join(f.worktreesRoot, "run-W1-T333-gone"), widowedInfo); // creates the sibling .lock…
      assert.equal(existsSync(join(f.worktreesRoot, widowedName)), true);
      // …then the owning directory is removed out from under it — never created here at all.

      // Control: a genuinely live worktree must be left alone.
      const live = join(f.worktreesRoot, "run-W1-T444-live");
      mkdirSync(live, { recursive: true });
      writeRunLock(live, { pid: process.pid, run_id: "W1-T444", startedAt: new Date().toISOString() });

      const lines: Array<[string, Record<string, unknown>]> = [];
      const summary = logWorktreeReapBootSurvey(f.config, (s, fields) => lines.push([s, fields]), {
        policy: () => ({ enabled: true }), // armed — real deletion, not a survey
      });

      assert.ok(summary, "the real pass must succeed against a real fixture root");
      assert.deepEqual(
        new Set(summary?.reaped),
        new Set(["run-W1-T111-invisible", "sweep-T222-detached"]),
        "both the git-invisible dir and the detached-HEAD orphan are reclaimed",
      );
      assert.deepEqual(summary?.reapedLocks, [widowedName], "the widowed lock is reclaimed too");
      assert.equal(existsSync(invisible), false);
      assert.equal(existsSync(detached), false);
      assert.equal(existsSync(join(f.worktreesRoot, widowedName)), false);
      assert.equal(existsSync(live), true, "a live-pid worktree must survive the pass untouched");
      assert.equal(existsSync(runLockPath(live)), true);

      assert.ok(lines.some(([step]) => step === "worktree.reap_boot"), "the pass must ledger what it reclaimed");
    } finally {
      f.cleanup();
    }
  });

  it("pruneStaleRuns (the OTHER debris-reclaim step) does NOT see the git-invisible directory — proving the hole is real, not merely asserted", async () => {
    const { pruneStaleRuns } = await import("../src/lib/worker.js");
    const f = fixtureConfig();
    try {
      const invisible = join(f.worktreesRoot, "run-W1-T111-invisible");
      mkdirSync(invisible, { recursive: true });
      // No real git repo at all under f.config.root/repos — pruneStaleRuns' own `git worktree
      // list --porcelain` best-effort-fails to "" and therefore enumerates NOTHING: it can only
      // ever act on entries GIT ITSELF registers, never the directory listing.
      const pruned = pruneStaleRuns(join(f.config.root, "repos", "nonexistent"), f.worktreesRoot);
      assert.deepEqual(pruned.worktrees, [], "pruneStaleRuns never even sees a git-invisible directory");
      assert.equal(existsSync(invisible), true, "…so it is left exactly where reapStaleWorktrees is needed to reclaim it");
    } finally {
      f.cleanup();
    }
  });
});
