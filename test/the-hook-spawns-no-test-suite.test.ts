/**
 * W1-T3225 — THE PRE-PUSH HOOK SPAWNS NO TEST SUITE.
 *
 * The hook used to run the test runner over every census suite `rmd census-membership` could place
 * for the diff. MEASURED over nine pre-push incidents across two days (#4749 #4750 #4751 #4760
 * #4761, and #4698 #4692 #4681 #4684 from W1-T3205's filing), every one was a single untiered
 * test file, which the tier admission catches without spawning a suite. The census step caught
 * none of them.
 *
 * Every arm below goes through a real `git push`, from a linked worktree. Testing a hook by
 * invoking it directly is what hid W1-T3224's defect through an entire arming cycle: git exports
 * its per-invocation environment to a hook in a worktree, so a hand-invoked hook runs in an
 * environment the fleet never sees.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO_ROOT, "hooks", "pre-push");
const CI_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "ci.yml");

let counter = 0;

function writeNodeRecorder(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "node-spawns.log");
  const node = join(bin, "node");
  writeFileSync(
    node,
    [
      "#!/bin/sh",
      "case \" $* \" in",
      "  *\" --test \"*) printf '%s\\n' \"$*\" >> \"$RMD_NODE_SPAWN_LOG\" ;;",
      "esac",
      "exec \"$RMD_REAL_NODE\" \"$@\"",
      "",
    ].join("\n"),
  );
  chmodSync(node, 0o755);
  return log;
}

/** A linked worktree with a bare remote and this repo's real hook installed via core.hooksPath,
 *  matching the hook route every worker lane uses. */
function fixture(opts: { untieredFile: boolean }) {
  const remote = gitRepo({ kind: "t3225-remote", bare: true });
  const parent = gitRepo({ kind: "t3225-parent" });
  const worktreeDir = mkdtempSync(join(dirname(parent.dir), `rmd-t3225-wt-${process.pid}-${counter++}-`));
  const work = parent.addWorktree(worktreeDir, "pushbranch");
  const spawnLog = writeNodeRecorder(work.dir);

  mkdirSync(join(work.dir, "scripts"), { recursive: true });
  mkdirSync(join(work.dir, "hooks"), { recursive: true });
  mkdirSync(join(work.dir, "test"), { recursive: true });
  copyFileSync(HOOK, join(work.dir, "hooks", "pre-push"));
  chmodSync(join(work.dir, "hooks", "pre-push"), 0o755);
  copyFileSync(join(REPO_ROOT, "scripts", "test-tier-manifest.mjs"), join(work.dir, "scripts", "test-tier-manifest.mjs"));
  writeFileSync(join(work.dir, "scripts", "rule15-precheck.mjs"), "process.exit(0)\n");
  writeFileSync(
    join(work.dir, "scripts", "test-tier-manifest.json"),
    JSON.stringify({ thresholdMs: 1000, files: { "test/seed.test.ts": 0 } }),
  );
  writeFileSync(join(work.dir, "test", "seed.test.ts"), "// tiered\n");
  if (opts.untieredFile) writeFileSync(join(work.dir, "test", "brand-new.test.ts"), "// untiered\n");

  symlinkSync(join(REPO_ROOT, "node_modules"), join(work.dir, "node_modules"));
  work.git("config", "core.hooksPath", "hooks");
  work.addRemote("origin", remote.dir);
  work.git("add", "-A");
  work.git("commit", "--quiet", "-m", "the change being pushed");

  const push = () => {
    const r = spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], {
      cwd: work.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(work.dir, "bin")}:${process.env.PATH ?? ""}`,
        RMD_NODE_SPAWN_LOG: spawnLog,
        RMD_PREPUSH_GATES: "1",
        RMD_REAL_NODE: process.execPath,
      },
    });
    return {
      status: r.status ?? -1,
      stderr: r.stderr ?? "",
      testRunnerSpawns: existsSync(spawnLog) ? readFileSync(spawnLog, "utf8") : "",
    };
  };
  return { push };
}

test("W1-T3225: the hook still REFUSES an untiered test file, through a real git push", () => {
  const { status, stderr } = fixture({ untieredFile: true }).push();
  assert.notEqual(status, 0, "the one defect class nine incidents were made of must still stop a push");
  assert.match(stderr, /brand-new\.test\.ts/, "the refusal names the file");
  assert.match(stderr, /--seed/, "and the remedy, which is what makes an early refusal worth having");
});

test("W1-T3225: the hook still PASSES a clean tree, through a real git push", () => {
  assert.equal(fixture({ untieredFile: false }).push().status, 0, "a fully tiered tree pushes");
});

test("W1-T3225: a real push through the hook spawns no test runner", () => {
  const pushed = fixture({ untieredFile: false }).push();
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(pushed.testRunnerSpawns, "", `unexpected test-runner invocation(s): ${pushed.testRunnerSpawns}`);
  assert.doesNotMatch(pushed.stderr, /running the census suites this diff joins/, "the census step is gone");
  assert.doesNotMatch(pushed.stderr, /census suite\(s\) are unmodelled/, "and so is its unmodelled tally");
});

test("W1-T3225: the hook's own text carries no test-runner invocation", () => {
  const hook = readFileSync(HOOK, "utf8");
  assert.doesNotMatch(hook, /node\s+--test/, "including in a comment");
});

test("W1-T3225: rule15-precheck and the tier admission both survive, in that order", () => {
  const hook = readFileSync(HOOK, "utf8");
  const rule15 = hook.indexOf("scripts/rule15-precheck.mjs");
  const tier = hook.indexOf("scripts/test-tier-manifest.mjs");
  assert.ok(rule15 > 0, "rule15-precheck still runs");
  assert.ok(tier > 0, "the tier admission still runs");
  assert.ok(rule15 < tier, "and in that order");
});

test("W1-T3225: census suites still run in CI, so this changes when a subset runs, not whether", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(ci, /name:\s*ci-shard \(\$\{\{ matrix\.shard \}\}\/4\)/);
  assert.match(ci, /matrix:\s*\n\s*shard:\s*\[1, 2, 3, 4\]/);
  assert.match(ci, /npm run test:ci|test-tier-manifest\.mjs --run fast --shard/);
  assert.match(pkg.scripts.test, /test\/\*\*\/\*\.test\.ts/);
  assert.match(pkg.scripts["test:ci"], /test\/\*\*\/\*\.test\.ts/);
});
