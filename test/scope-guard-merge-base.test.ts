/**
 * The push-time scope guard diffs against the MERGE BASE, so a merge to `main` cannot break a
 * running drain.
 *
 * MEASURED, NOT HYPOTHESISED. A drain booted at `3147755` dispatched W1-T395; the worker committed
 * (`git rev-list --count origin/main..run-W1-T395-1786372560173` = 1); #1533 merged to main WHILE
 * THE DRAIN WAS RUNNING; and the guard refused the push naming `src/run-task.ts` and
 * `test/drain-gateway-batched.test.ts` — #1533's own files, which that worker never opened.
 *
 * THE CAUSE IS THE DOT COUNT. `git diff --name-only origin/main..HEAD` compares the two TIPS, so
 * every file merged after the worktree was cut reads as something this branch changed.
 * `origin/main...HEAD` compares against the merge base — what THIS BRANCH changed relative to where
 * it started — which is the question the guard is asking, and is already what `lib/ci-parity.ts`
 * uses at both of its diff sites.
 *
 * THE FIXTURE HAS TO REACH THAT. A test where origin never advances passes under BOTH dot forms and
 * proves nothing about this defect, so every case below advances origin after cutting the branch.
 * And the guard must still refuse a genuine violation: a fix that simply stopped refusing would
 * satisfy a one-sided test.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scopeGuardOutOfScopeFiles } from "../src/run-task.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, ["-c", "user.name=Fixture", "-c", "user.email=f@example.invalid", "commit", "-qm", message]);
}

/**
 * A real origin with one commit, a clone whose branch is cut from it, and then an ORIGIN THAT MOVES
 * — the condition the defect needs. Returns the clone, so a caller can commit on the branch and
 * then ask what the guard would see.
 */
function fixture(): { clone: string; originFile: string } {
  const origin = mkdtempSync(join(tmpdir(), "scope-guard-origin-"));
  git(origin, ["init", "-q", "-b", "main"]);
  writeFileSync(join(origin, "seed.txt"), "seed\n");
  git(origin, ["add", "-A"]);
  commit(origin, "seed");

  const clone = mkdtempSync(join(tmpdir(), "scope-guard-clone-"));
  git(clone, ["clone", "-q", origin, "."]);
  git(clone, ["checkout", "-q", "-b", "run-W1-T395-1786372560173", "origin/main"]);

  // ORIGIN ADVANCES AFTER THE BRANCH WAS CUT — this is #1533 merging mid-drain.
  writeFileSync(join(origin, "src-run-task.ts"), "someone else's change\n");
  git(origin, ["add", "-A"]);
  commit(origin, "a sibling PR merges to main");
  git(clone, ["fetch", "-q", "origin"]);

  return { clone, originFile: "src-run-task.ts" };
}

/** What the guard computes at push time, in each dot form. */
function diffNames(clone: string, range: string): string[] {
  return git(clone, ["diff", "--name-only", range])
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

test("a merge to main mid-run does NOT make the sibling's files look like the worker's", () => {
  const { clone, originFile } = fixture();
  writeFileSync(join(clone, "mine.ts"), "the worker's own change\n");
  git(clone, ["add", "-A"]);
  commit(clone, "the worker's commit");

  // THE DEFECT, REPRODUCED: two-dot drags the sibling's file in.
  const twoDot = diffNames(clone, "origin/main..HEAD");
  assert.ok(twoDot.includes(originFile), "two-dot must see the sibling's file — otherwise the fixture never reached the defect");

  // THE FIX: three-dot sees only what this branch did.
  const threeDot = diffNames(clone, "origin/main...HEAD");
  assert.deepEqual(threeDot, ["mine.ts"]);

  // And through the guard itself, with the task declaring only its own file.
  assert.deepEqual(scopeGuardOutOfScopeFiles(threeDot, ["mine.ts"]), [], "nothing out of scope");
  assert.ok(
    scopeGuardOutOfScopeFiles(twoDot, ["mine.ts"]).includes(originFile),
    "the old comparison blamed the worker for the sibling's file",
  );
});

test("a GENUINE scope violation is still refused, with origin moved underneath it", () => {
  // The other direction. A fix that simply stopped refusing would pass the test above.
  const { clone } = fixture();
  writeFileSync(join(clone, "mine.ts"), "declared\n");
  writeFileSync(join(clone, "sneaky.ts"), "NOT declared\n");
  git(clone, ["add", "-A"]);
  commit(clone, "the worker touched something it did not declare");

  const threeDot = diffNames(clone, "origin/main...HEAD");
  assert.deepEqual(scopeGuardOutOfScopeFiles(threeDot, ["mine.ts"]), ["sneaky.ts"]);
});

test("a branch that changed nothing of its own is clean even when origin raced ahead", () => {
  // The pure-race case: no commit on the branch at all. Two-dot reports the sibling's file as this
  // branch's work; three-dot correctly reports nothing.
  const { clone, originFile } = fixture();
  assert.ok(diffNames(clone, "origin/main..HEAD").includes(originFile));
  assert.deepEqual(diffNames(clone, "origin/main...HEAD"), []);
  assert.deepEqual(scopeGuardOutOfScopeFiles(diffNames(clone, "origin/main...HEAD"), ["mine.ts"]), []);
});

test("an undeclared files: list still means everything is out of scope — unchanged by the fix", () => {
  // `scopeGuardOutOfScopeFiles`'s own contract: a task declaring nothing is not treated as
  // declaring everything. Asserted here so the dot change cannot be read as loosening it.
  assert.deepEqual(scopeGuardOutOfScopeFiles(["a.ts", "b.ts"], undefined), ["a.ts", "b.ts"]);
  assert.deepEqual(scopeGuardOutOfScopeFiles([], ["a.ts"]), []);
});

test("MUTANT: the guard's range must be three-dot, and the refusal must not assert a cause it cannot see", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");

  const threeDot = '"diff", "--name-only", "origin/main...HEAD"';
  assert.equal(src.split(threeDot).length - 1, 1, "the substitution target must be UNIQUE or the mutant proves nothing");

  const twoDot = '"diff", "--name-only", "origin/main..HEAD"';
  assert.equal(src.split(twoDot).length - 1, 0, "no two-dot file-list diff may remain — that is the defect");

  // The message no longer asserts the rarest cause as fact (design Q4). Kept as a source check
  // because the string is what a human reads at 3am, and nothing else in the suite pins it.
  assert.ok(
    !src.includes("likely a forged merge-base / phantom revert (the reset --soft near-miss); NOT pushing"),
    "the refusal must not assert a cause the guard cannot distinguish",
  );
});
