/**
 * W1-T445 — SELF-SYNC FAST-FORWARDED WHATEVER TREE IT WAS INVOKED FROM.
 *
 * `checkCliFreshness` refused on exactly four conditions — the guard env, CI, a dirty working
 * tree, and a non-fast-forwardable HEAD — and never asked which branch it was on. `repoDir` is
 * `resolveRepoRoot(argv, process.cwd())`, the toplevel of wherever the verb ran, so inside a
 * worktree it was handed that worktree and advanced ITS branch.
 *
 * OBSERVED, from the reflog of the branch it moved:
 *   `ba377fca run-W1-T444-1786560477@{2026-08-12 14:52:04}: merge origin/main: Fast-forward`
 *   `11dcbf08 run-W1-T444-1786560477@{2026-08-12 14:47:57}: branch: Created from HEAD`
 * A feature branch cut at 14:47 was moved at 14:52 by ONE unguarded verb, before its first commit.
 * Nothing was lost; the base being measured against changed mid-task.
 *
 * EVERY TEST HERE DRIVES REAL GIT REPOS — a real origin, a real clone, a real `merge --ff-only`.
 * A branch guard proven only against a stubbed runner would pass while the real merge still moved
 * a real ref, which is the defect one level down.
 *
 * AND EVERY TEST ASSERTS THE REF, NOT ONLY THE STATUS. `status !== "synced"` passes for an
 * implementation that refuses and fast-forwards anyway; the sha before and after is what settles it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkCliFreshness, SELF_SYNC_GUARD_ENV, type GitRunner } from "../src/lib/self-sync.js";

const git = (dir: string, args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

function planYaml(title: string): string {
  return `- id: T1\n  title: "${title}"\n  repo: remudero\n  type: implement\n`;
}

/** A real origin + a real clone, the clone one commit BEHIND — the only state that can sync. */
function behindFixture(): { originDir: string; localDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-branch-guard-"));
  const originDir = join(root, "origin");
  const localDir = join(root, "local");
  mkdirSync(join(originDir, "plan"), { recursive: true });
  git(originDir, ["init", "--quiet", "-b", "main"]);
  git(originDir, ["config", "user.email", "test@example.com"]);
  git(originDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml("origin-title"), "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);
  execFileSync("git", ["clone", "--quiet", originDir, localDir], { encoding: "utf8" });
  git(localDir, ["config", "user.email", "test@example.com"]);
  git(localDir, ["config", "user.name", "Test"]);
  // Publish a commit the clone does not have, so the clone is CLEAN + BEHIND + ff-possible.
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml("newer-title"), "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "newer"]);
  return { originDir, localDir };
}

const headSha = (dir: string): string => git(dir, ["rev-parse", "HEAD"]).trim();

function spies(localDir: string) {
  const warnCalls: string[] = [];
  const logCalls: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let reexecCalls = 0;
  const gitCalls: string[][] = [];
  const runner: GitRunner = (args) => {
    gitCalls.push(args);
    return execFileSync("git", ["-C", localDir, ...args], { encoding: "utf8" });
  };
  return {
    warnCalls,
    logCalls,
    gitCalls,
    reexecCount: () => reexecCalls,
    deps: {
      git: runner,
      say: () => {},
      warn: (m: string) => void warnCalls.push(m),
      log: (step: string, extra?: Record<string, unknown>) => void logCalls.push({ step, extra }),
      reexec: () => void reexecCalls++,
    },
  };
}

// ── DIRECTION 1: a feature branch is never moved ──────────────────────────────────────────────

test("a clean checkout BEHIND origin/main on a feature branch is refused, and its ref does not move", () => {
  const { localDir } = behindFixture();
  git(localDir, ["checkout", "--quiet", "-b", "run-W1-T445-1786562957"]);
  const before = headSha(localDir);

  const { deps, reexecCount, logCalls } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "refused");
  assert.equal(result.status === "refused" ? result.reason : undefined, "off-main");
  // THE ASSERTION THAT MATTERS: a refusal that fast-forwarded anyway would pass the two above.
  assert.equal(headSha(localDir), before, "the branch ref must be byte-identical after the call");
  assert.equal(
    git(localDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    "run-W1-T445-1786562957",
    "and it must still be checked out on the same branch",
  );
  assert.equal(reexecCount(), 0, "nothing changed, so nothing may re-exec");

  // W1-T486: off-main is now distinguishable from dirty/diverged in the ledger too.
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0].step, "self_sync.refused");
  assert.equal(logCalls[0].extra?.reason, "off-main");
  assert.equal(logCalls[0].extra?.old_sha, before);
  assert.equal(logCalls[0].extra?.count, undefined, "off-main never carries a dirty-style count");
});

test("the refusal names the branch and the remedy rather than failing silently", () => {
  const { localDir } = behindFixture();
  git(localDir, ["checkout", "--quiet", "-b", "fix/some-work"]);
  const { deps, warnCalls } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(warnCalls.length, 1, "a silent skip would trade this defect for the stale-checkout incident");
  const message = result.status === "refused" ? result.message : "";
  assert.match(message, /fix\/some-work/, "the operator must be told WHICH branch stopped it");
  assert.match(message, /git pull --ff-only/, "and the remedy they can run themselves");
  assert.equal(warnCalls[0], message, "the warning and the returned message are the same text");
});

// ── DIRECTION 2: a detached HEAD refuses too, deliberately ────────────────────────────────────

test("a DETACHED HEAD is refused — a silently advanced base turns base-vs-head into head-vs-head", () => {
  const { localDir } = behindFixture();
  git(localDir, ["checkout", "--quiet", "--detach", "HEAD"]);
  const before = headSha(localDir);

  const { deps } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "refused");
  assert.equal(result.status === "refused" ? result.reason : undefined, "off-main");
  assert.match(result.status === "refused" ? result.message : "", /DETACHED HEAD/);
  assert.equal(headSha(localDir), before, "the detached HEAD must not advance");
});

// ── DIRECTION 3: main still syncs, exactly as before ──────────────────────────────────────────

test("a clean checkout BEHIND origin/main ON MAIN still fast-forwards — the healthy path is untouched", () => {
  const { localDir } = behindFixture();
  const before = headSha(localDir);
  assert.equal(git(localDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main", "the fixture starts on main");

  const { deps, reexecCount, logCalls } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "synced", "this is the case self-sync exists for — the #138 stale-checkout shape");
  assert.notEqual(headSha(localDir), before, "and the ref ACTUALLY advanced, not merely reported success");
  assert.equal(reexecCount(), 1, "a real sync re-execs so the new code serves the command");
  assert.equal(logCalls.length, 0, "a successful sync is not a refusal -- W1-T486's sink stays silent");
});

// ── DIRECTION 4: the guard env still short-circuits before any git at all ─────────────────────

test("the guard env short-circuits before a single git command is issued", () => {
  const { localDir } = behindFixture();
  git(localDir, ["checkout", "--quiet", "-b", "some-branch"]);
  const before = headSha(localDir);

  const { deps, gitCalls } = spies(localDir);
  const result = checkCliFreshness(localDir, { [SELF_SYNC_GUARD_ENV]: "1" }, deps);

  assert.equal(result.status, "guarded");
  assert.deepEqual(gitCalls, [], "not even a fetch — this is what a re-exec's child sees");
  assert.equal(headSha(localDir), before);
});
