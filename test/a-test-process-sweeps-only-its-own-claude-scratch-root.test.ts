/**
 * fb-1791856944992-903702, item 2. `worktreeRemove` ends with a sweep of the claude-<uid> scratch root, and that root
 * defaults to the one live Claude Code sessions share: a suite calling the real `worktreeRemove` deleted a live session's
 * tree mid-run. test/setup/tmp-hygiene.ts pins CLAUDE_CODE_TMPDIR to each test process's own HOME, so any suite that
 * reaches a real sweep reaps only scratch it owns.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { worktreeAdd, worktreeRemove } from "#src/lib/worker.js";
import { claudeScratchRoot } from "#src/lib/worker-scratch.js";

/** The scratch root this process sweeps, refused BEFORE anything touches it unless it sits inside the test HOME. */
function pinnedScratchRoot(): string {
  const home = process.env.HOME ?? "";
  const root = claudeScratchRoot() ?? "";
  assert.ok(home && root.startsWith(realpathSync(home) + sep), `scratch root ${root} is outside the test HOME ${home}`);
  return root;
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

test("a test process's Claude scratch root is inside its own test HOME, never the shared claude-<uid> root", () => {
  const root = pinnedScratchRoot();
  assert.equal(process.env.CLAUDE_CODE_TMPDIR, process.env.HOME);
  assert.notEqual(root, resolve(realpathSync(tmpdir()), `claude-${process.getuid?.()}`));
});

test("a real worktreeRemove in a test process reaps a stale orphan from its pinned scratch root", () => {
  const scratch = pinnedScratchRoot();
  const root = mkdtempSync(join(tmpdir(), "rmd-pinned-scratch-"));
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  const orphan = join(scratch, "-orphan-of-a-killed-run");
  try {
    seedClone(clone);
    worktreeAdd(clone, wt, "run-pinned-scratch-probe", "origin/main");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "left.bin"), "x");
    const stale = (Date.now() - 5 * 60 * 60 * 1000) / 1000;
    utimesSync(join(orphan, "left.bin"), stale, stale);
    utimesSync(orphan, stale, stale);
    worktreeRemove(clone, wt);
    assert.ok(!existsSync(orphan), "the teardown sweep reaches the pinned root, so it is the root a test process sweeps");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(orphan, { recursive: true, force: true });
  }
});
