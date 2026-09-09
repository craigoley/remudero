/**
 * W1-T3225 — THE PRE-PUSH HOOK SPAWNS NO TEST SUITE.
 *
 * The hook used to run the test runner over every census suite `rmd census-membership` could place
 * for the diff. MEASURED over nine pre-push incidents across two days (#4749 #4750 #4751 #4760
 * #4761, and #4698 #4692 #4681 #4684 from W1-T3205's filing), every one was a single UNTIERED TEST
 * FILE — which the tier admission catches in about two seconds, spawning nothing. The census step
 * caught NONE of them, and reported clearing 9 suites while naming 125 it could not place.
 *
 * What it did do, twice on 2026-09-09, was damage the repository it was protecting. W1-T3224's env
 * scrub fixed that mechanism and stays; this task answers the separate question of whether a git
 * hook should spawn a test runner at all.
 *
 * EVERY ARM GOES THROUGH A REAL `git push`, from a LINKED WORKTREE. Testing a hook by invoking it
 * directly is what hid W1-T3224's defect through an entire arming cycle: git exports GIT_DIR to a
 * hook in a worktree and not in a plain checkout, so a hand-invoked hook runs in an environment the
 * fleet never sees.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO_ROOT, "hooks", "pre-push");
const CI_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "ci.yml");

let counter = 0;

/** A linked worktree with a bare remote and this repo's real hook installed via core.hooksPath —
 *  the same wiring spawnWorker gives every lane. `tiered` decides whether the tree carries an
 *  untiered test file, which is the one defect class the narrowed hook still exists to catch. */
function fixture(opts: { untieredFile: boolean }) {
  const remote = gitRepo({ kind: "t3225-remote", bare: true });
  const parent = gitRepo({ kind: "t3225-parent" });
  const work = parent.addWorktree(join(dirname(parent.dir), `t3225-wt-${process.pid}-${counter++}`), "pushbranch");

  mkdirSync(join(work.dir, "scripts"), { recursive: true });
  mkdirSync(join(work.dir, "hooks"), { recursive: true });
  mkdirSync(join(work.dir, "test"), { recursive: true });
  copyFileSync(HOOK, join(work.dir, "hooks", "pre-push"));
  chmodSync(join(work.dir, "hooks", "pre-push"), 0o755);
  copyFileSync(join(REPO_ROOT, "scripts", "test-tier-manifest.mjs"), join(work.dir, "scripts", "test-tier-manifest.mjs"));
  writeFileSync(join(work.dir, "scripts", "rule15-precheck.mjs"), "process.exit(0)\n");
  writeFileSync(
    join(work.dir, "scripts", "test-tier-manifest.json"),
    JSON.stringify({ thresholdMs: 1000, files: opts.untieredFile ? {} : { "test/seed.test.ts": 0 } }),
  );
  writeFileSync(join(work.dir, "test", "seed.test.ts"), "// tiered\n");
  if (opts.untieredFile) writeFileSync(join(work.dir, "test", "brand-new.test.ts"), "// untiered\n");
  // spawnWorker symlinks node_modules into every worktree; a fixture without one runs the hook's
  // `node --import tsx` precheck against a repo the fleet never has.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(work.dir, "node_modules"));

  work.git("config", "core.hooksPath", "hooks");
  work.addRemote("origin", remote.dir);
  work.git("add", "-A");
  work.git("commit", "--quiet", "-m", "the change being pushed");

  const push = () => {
    const r = spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], {
      cwd: work.dir,
      encoding: "utf8",
      env: { ...process.env, RMD_PREPUSH_GATES: "1" },
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  };
  return { work, push };
}

test("W1-T3225: the hook still REFUSES an untiered test file, through a real git push", () => {
  const { push } = fixture({ untieredFile: true });
  const { status, stderr } = push();
  assert.notEqual(status, 0, "the one defect class nine incidents were made of must still stop a push");
  assert.match(stderr, /brand-new\.test\.ts/, "and the refusal names the file");
  assert.match(stderr, /--seed/, "and the remedy, which is what makes an early refusal worth having");
});

test("W1-T3225: the hook still PASSES a clean tree, through a real git push", () => {
  // The positive control. "No suite ran" passes trivially against a hook that does nothing, so the
  // suite must also show the hook reaching a verdict in both directions.
  assert.equal(fixture({ untieredFile: false }).push().status, 0, "a fully tiered tree pushes");
});

test("W1-T3225: a real push spawns NO test runner", () => {
  // The property is structural, not a time bound: a wall-clock assertion on a shared host is a
  // flake, and the argument was never speed.
  const { stderr } = fixture({ untieredFile: false }).push();
  assert.doesNotMatch(stderr, /running the census suites this diff joins/, "the census step is gone");
  assert.doesNotMatch(stderr, /^TAP version/m, "no test-runner output reaches a push");
  assert.doesNotMatch(stderr, /census suite\(s\) are unmodelled/, "and neither does its unmodelled tally");
});

test("W1-T3225: the hook's own text carries no test-runner invocation", () => {
  const hook = readFileSync(HOOK, "utf8");
  assert.doesNotMatch(hook, /node\s+--test/, "including in a comment — a suite asserting this must not match its own explanation");
});

test("W1-T3225: rule15-precheck and the tier admission both survive, in that order", () => {
  // Asserting only the ABSENCE cannot tell a narrowed hook from a gutted one.
  const hook = readFileSync(HOOK, "utf8");
  const rule15 = hook.indexOf("scripts/rule15-precheck.mjs");
  const tier = hook.indexOf("scripts/test-tier-manifest.mjs");
  assert.ok(rule15 > 0, "rule15-precheck still runs");
  assert.ok(tier > 0, "the tier admission still runs");
  assert.ok(rule15 < tier, "and in that order — unmet deps and blocked shards are judged before tiering");
});

test("W1-T3225: the census suites still run in CI, so this changes WHEN a subset runs, not WHETHER", () => {
  // If the coverage moved rather than stayed, this task traded a real guarantee for a cheaper hook.
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(ci, /test\/\*\*\/\*\.test\.ts/, "CI still runs the whole suite glob");
  assert.match(ci, /ci-shard/, "across its shards");
});
