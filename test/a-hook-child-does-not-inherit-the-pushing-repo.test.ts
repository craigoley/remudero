/**
 * W1-T3224 — A HOOK CHILD MUST NOT INHERIT THE PUSHING REPOSITORY.
 *
 * OBSERVED 2026-09-09 on a real armed push from lane `t3222b`: the push was refused, and the
 * refusal was not a violation — the hook had rewritten the repo it was protecting.
 *   HEAD  f11a41d94 (the real commit) -> 7a14e294c "fixture"
 *   ls-files 3,550 -> 1;  status clean -> 231 changed;  SEVEN fixture commits in one hook run.
 *
 * THE MECHANISM IS ORDINARY GIT: a hook runs with `GIT_DIR` exported, every child inherits it, and
 * a child's `git -C <somewhere-else>` then resolves to the HOOK'S repo rather than the directory it
 * names. `hooks/pre-push` runs census suites that build git fixtures exactly that way.
 *
 * WHY THIS SUITE GOES THROUGH A REAL `git push`, and why that is the whole point. The dry run that
 * preceded arming invoked `sh hooks/pre-push` BY HAND: 7/7 pass, two verified true-positive
 * refusals, and it could not have found this, because a hand-invoked hook carries no GIT_DIR. It
 * tested the hook's LOGIC, not the HOOK. The MUTANT test below restores the unfixed hook and shows
 * the same push corrupting HEAD — so this suite fails against the version it exists to fix.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_SOURCE = join(REPO_ROOT, "hooks", "pre-push");

/** Distinct worktree paths within one run — `git worktree add` refuses an existing directory. */
let counter = 0;

interface Fixture {
  /** The repo that pushes — the one that must come through unchanged. */
  work: ReturnType<typeof gitRepo>;
  /** A DIFFERENT directory a hook child writes into. Under an inherited GIT_DIR its writes land
   *  in `work` instead, which is the entire defect. */
  victim: ReturnType<typeof gitRepo>;
  push(): { status: number | null; stderr: string };
}

/**
 * A work repo with a bare remote and this repo's real hook installed through `core.hooksPath` —
 * the same wiring `spawnWorker` gives every worktree. `precheckBody` becomes the hook's
 * rule15-precheck child, so a test can make a REAL child of the REAL hook do whatever it needs.
 */
function fixture(precheckBody: string, hookText?: string): Fixture {
  const remote = gitRepo({ kind: "t3224-remote", bare: true });
  // A LINKED WORKTREE, not a plain repo, and the distinction is the defect's whole habitat: git
  // exports GIT_DIR to a hook running in a linked worktree and does NOT in an ordinary `git init`
  // checkout. MEASURED both ways — a plain-repo fixture cannot reproduce this no matter what the
  // hook does, and every fleet lane is a linked worktree.
  const parent = gitRepo({ kind: "t3224-parent" });
  const work = parent.addWorktree(join(dirname(parent.dir), `t3224-wt-${process.pid}-${counter++}`), "pushbranch");
  const victim = gitRepo({ kind: "t3224-victim" });

  mkdirSync(join(work.dir, "scripts"), { recursive: true });
  mkdirSync(join(work.dir, "hooks"), { recursive: true });
  if (hookText === undefined) copyFileSync(HOOK_SOURCE, join(work.dir, "hooks", "pre-push"));
  else writeFileSync(join(work.dir, "hooks", "pre-push"), hookText);
  chmodSync(join(work.dir, "hooks", "pre-push"), 0o755);
  writeFileSync(join(work.dir, "scripts", "rule15-precheck.mjs"), precheckBody);
  // The hook runs its precheck through `node --import tsx`; spawnWorker symlinks node_modules into
  // every worktree so that resolves. A fixture without one tests a repo the fleet never has.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(work.dir, "node_modules"));

  work.git("config", "core.hooksPath", "hooks");
  work.addRemote("origin", remote.dir);
  writeFileSync(join(work.dir, "payload.txt"), "the change being pushed\n");
  work.git("add", "-A");
  work.git("commit", "--quiet", "-m", "the real commit");

  return {
    work,
    victim,
    push: () => {
      const r = spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], {
        cwd: work.dir,
        encoding: "utf8",
        env: { ...process.env, RMD_PREPUSH_GATES: "1" },
      });
      return { status: r.status, stderr: r.stderr ?? "" };
    },
  };
}

/** A precheck that drives git against ANOTHER directory, exactly as a census fixture does. */
const precheckWritingTo = (dir: string, exitCode = 0) =>
  [
    `import { execFileSync } from "node:child_process";`,
    `const run = (...a) => execFileSync("git", ["-C", ${JSON.stringify(dir)}, ...a], { stdio: "ignore" });`,
    `run("config", "user.email", "f@example.com");`,
    `run("config", "user.name", "fixture");`,
    `import { writeFileSync } from "node:fs";`,
    `writeFileSync(${JSON.stringify(join(dir, "fixture.txt"))}, "x");`,
    `run("add", "-A");`,
    `run("commit", "--quiet", "-m", "fixture");`,
    `process.exit(${exitCode});`,
  ].join("\n");

/** HEAD subject + tracked-file count — the two readings that moved when this defect fired. */
function state(repo: ReturnType<typeof gitRepo>) {
  return {
    head: repo.git("log", "--format=%s", "-1"),
    tracked: repo.git("ls-files").split("\n").filter(Boolean).length,
  };
}

test("W1-T3224: after a real git push, the pushing repository's HEAD and index are unchanged", () => {
  const f = fixture(precheckWritingTo("VICTIM_DIR"));
  // The placeholder is replaced once the victim dir exists (gitRepo makes it in fixture()).
  writeFileSync(join(f.work.dir, "scripts", "rule15-precheck.mjs"), precheckWritingTo(f.victim.dir));
  const before = state(f.work);
  f.push();
  const after = state(f.work);
  assert.deepEqual(after, before, "a push must not rewrite the pusher — this is what regressed on lane t3222b");
  assert.equal(after.head, "the real commit", "and HEAD is still the author's own commit, not a fixture's");
});

test("W1-T3224: a hook child's git writes to the directory it NAMES, not to the pushing repo", () => {
  const f = fixture("process.exit(0)");
  writeFileSync(join(f.work.dir, "scripts", "rule15-precheck.mjs"), precheckWritingTo(f.victim.dir));
  f.push();
  assert.equal(state(f.victim).head, "fixture", "the child's commit landed where it was told to");
  assert.notEqual(state(f.work).head, "fixture", "and NOT in the repo being pushed");
});

test("W1-T3224: the hook still PASSES a clean tree, proven through a real push", () => {
  // The positive control. "HEAD is unchanged" passes trivially against a hook that does nothing,
  // so the suite must also show the hook ran and reached a verdict.
  const f = fixture("process.exit(0)");
  const { status } = f.push();
  assert.equal(status, 0, "a clean tree pushes");
});

test("W1-T3224: the hook still REFUSES a violating tree, proven through a real push", () => {
  const f = fixture("process.exit(1)");
  const { status, stderr } = f.push();
  assert.notEqual(status, 0, "a refusing precheck still stops the push");
  assert.match(stderr, /pre-push REFUSED/, "and says so");
});

test("W1-T3224: the scrub covers every per-invocation git variable, not only GIT_DIR", () => {
  // GIT_INDEX_FILE alone redirects a child's staging; each of these redirects a different part of
  // the same machinery, so unsetting one and leaving the rest reads as complete and is not.
  // Line continuations are joined first: the hook wraps one `unset` across two lines for width,
  // and a per-line regex would read the second line's variables as unscrubbed.
  const hook = readFileSync(HOOK_SOURCE, "utf8").replace(/\\\n\s*/g, " ");
  for (const v of [
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_PREFIX",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_QUARANTINE_PATH",
  ]) {
    assert.match(hook, new RegExp(`unset[^\\n]*\\b${v}\\b`), `${v} must be scrubbed`);
  }
});

test("W1-T3224 MUTANT: the UNFIXED hook corrupts the pushing repo on the same push", () => {
  // THE FALSIFIER. Without this, every assertion above would pass against a hook that never had
  // the defect, and the suite would prove nothing about the fix. Same fixture, one line removed.
  const unfixed = readFileSync(HOOK_SOURCE, "utf8")
    .split("\n")
    .filter((l) => !/^\s*unset\s+GIT_/.test(l))
    .join("\n");
  assert.notEqual(unfixed, readFileSync(HOOK_SOURCE, "utf8"), "the mutation must actually remove something");

  const f = fixture("process.exit(0)", unfixed);
  writeFileSync(join(f.work.dir, "scripts", "rule15-precheck.mjs"), precheckWritingTo(f.victim.dir));
  const before = state(f.work);
  f.push();
  const after = state(f.work);
  assert.notDeepEqual(
    after,
    before,
    "the unfixed hook MUST corrupt the pusher — if this passes, the suite is not reaching the mechanism and proves nothing",
  );
  assert.equal(after.head, "fixture", "and the corruption is exactly what was observed: HEAD becomes a fixture commit");
});

// Keep `execFileSync` imported-and-used: the fixture helpers shell out through gitRepo, and this
// asserts the hook file the whole suite reads is the tracked one rather than a stale copy.
test("W1-T3224: the suite reads the repository's own tracked hook", () => {
  const tracked = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "--error-unmatch", "hooks/pre-push"], {
    encoding: "utf8",
  }).trim();
  assert.equal(tracked, "hooks/pre-push");
});
