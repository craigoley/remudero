/**
 * test/a-new-test-that-passes-on-the-base-tree-proves-nothing.test.ts — W1-T3098.
 *
 * THE DEFECT. `classifyBaseProofOutcome` (src/lib/review.ts) grades a head-passing `unit test:`
 * proof by re-running it at the merge-base: pass there ⇒ `"stale"` (discriminates nothing), else
 * ⇒ `"discriminates"`. R-11 fixed HALF of the hole this task closes: `buildBaseProofDir`
 * (src/run-task.ts) now checks out a REAL detached worktree at the merge-base instead of a blob-only
 * directory, and gates `unit test:` on `baseIsCheckout` so an unusable base reads `base_unknown`,
 * never `discriminates`. But a real checkout of the MERGE-BASE still does not contain a file the PR
 * itself ADDED — `node --test` there finds nothing, exits nonzero, and the classifier read that as
 * `discriminates`: a test that would have passed identically against the unmodified implementation
 * was certified as proof the implementation changed. THE ONE PROOF SHAPE THE JUDGE COULD NOT ACTUALLY
 * EVALUATE WAS THE ONE IT GRADED MOST CONFIDENTLY.
 *
 * WHAT CLOSES IT. `buildBaseProofDir` now copies the diff's ADDED/CHANGED `test/**` files from the
 * head checkout into the base worktree, at the same repo-relative paths, before handing the dir
 * back — so the SAME proof that just passed on the head can genuinely be RE-RUN at the base. The
 * classifier's own ternary (and the R-11 `baseIsCheckout` guard) are UNCHANGED; only the tree it
 * runs against is now complete enough to answer honestly.
 *
 * FOUR CLAIMS, each driven against a REAL two-commit repository with the REAL executor — no fake
 * `exec`, so the copy-and-run genuinely happens exactly as the reviewer performs it:
 *   (1) a PR-added test that would PASS against the base implementation (it asserts nothing) is
 *       copied in, genuinely re-run, genuinely passes, and grades `executed_stale` — the reason
 *       names the file;
 *   (2) a PR-added test that genuinely FAILS against the base implementation (it asserts a value
 *       only true after the PR's own implementation change) is copied in, genuinely re-run,
 *       genuinely fails, and still grades `discriminates` — the fix NARROWS the grade, it does not
 *       empty it;
 *   (3) a copied test that cannot even load at the base — it imports a module the PR itself added —
 *       throws at import (a module-load error, `PureProofNeverExecutedError`) and grades
 *       `base_unknown`: never `pass`, never `discriminates`, an environment gap read as evidence in
 *       neither direction;
 *   (4) a pre-existing test file the diff never touched is NOT re-copied over itself — the copy step
 *       is scoped to exactly the diff's ADDED `test/**` paths, observed directly off the
 *       injected `copyFile` seam.
 *
 * FALSIFIER (per the task shard): with the copy step reverted (checkout `buildBaseProofDir` at the
 * commit before this one, or force `addWorktree` while stubbing `changedTestFiles`/`copyFile` to
 * no-ops), claim (1)'s probe grades `discriminates` instead of `executed_stale` — the gate goes
 * blind exactly as described above — while claim (2)'s genuinely-failing probe still grades
 * `discriminates` either way, so this suite discriminates the COPY, not merely the classifier.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildBaseProofDir, type BaseProofDir } from "../src/run-task.js";
import { execWhitelistedProof, judgeCriterion, parseWhitelistedProof } from "../src/lib/review.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Identity from `-c` flags, never ambient config (CLAUDE.md, "A fixture shelling git PLUMBING …"). */
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const WOULD_PASS_AT_BASE = 'import { test } from "node:test";\ntest("asserts nothing — would pass anywhere", () => {});\n';
const WOULD_FAIL_AT_BASE =
  'import { test } from "node:test";\n' +
  'import assert from "node:assert/strict";\n' +
  'import { widget } from "../src/a.js";\n' +
  'test("only true after the PR\'s own implementation change", () => { assert.equal(widget, 2); });\n';
const HEAD_ONLY_IMPORT =
  'import { test } from "node:test";\n' +
  'import assert from "node:assert/strict";\n' +
  'import { headOnly } from "../src/head-only.js";\n' +
  'test("imports a module the PR itself added", () => { assert.equal(headOnly, 1); });\n';
const UNTOUCHED = 'import { test } from "node:test";\ntest("pre-existing, never touched by this diff", () => {});\n';

/**
 * A REAL two-commit repository:
 *   base (== the merge-base, `origin/main`): package.json, a committed `node_modules` symlink to
 *     this repo's own install, the `test/setup/tmp-hygiene.ts` stub the proof argv imports,
 *     `src/a.ts` exporting `widget = 1`, and `test/untouched.test.ts` — a file this diff never
 *     touches, present identically at both commits.
 *   head (the PR branch): `src/a.ts` changed to `widget = 2` (the implementation change), plus
 *     three ADDED test files — one that would pass at base, one that genuinely wouldn't, and one
 *     that can't even load there — and `src/head-only.ts`, added alongside the third.
 * Returns the working directory that stands in for the reviewer's materialised head worktree.
 */
function fourScenarioRepo(): { head: string; mergeBase: string } {
  const head = mkdtempSync(join(tmpdir(), "rmd-w1t3098-head-"));
  git(head, "init", "--quiet", "-b", "main");
  writeFileSync(join(head, "package.json"), JSON.stringify({ name: "w1t3098-fixture", private: true, type: "module" }));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(head, "node_modules"));
  mkdirSync(join(head, "test", "setup"), { recursive: true });
  writeFileSync(join(head, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
  mkdirSync(join(head, "src"), { recursive: true });
  writeFileSync(join(head, "src", "a.ts"), "export const widget = 1;\n");
  writeFileSync(join(head, "test", "untouched.test.ts"), UNTOUCHED);
  git(head, "add", "-A");
  git(head, "commit", "--quiet", "-m", "base");
  const mergeBase = git(head, "rev-parse", "HEAD");
  git(head, "update-ref", "refs/remotes/origin/main", "HEAD");

  writeFileSync(join(head, "src", "a.ts"), "export const widget = 2;\n");
  writeFileSync(join(head, "src", "head-only.ts"), "export const headOnly = 1;\n");
  writeFileSync(join(head, "test", "would-pass-at-base.test.ts"), WOULD_PASS_AT_BASE);
  writeFileSync(join(head, "test", "would-fail-at-base.test.ts"), WOULD_FAIL_AT_BASE);
  writeFileSync(join(head, "test", "head-only-import.test.ts"), HEAD_ONLY_IMPORT);
  git(head, "add", "-A");
  git(head, "commit", "--quiet", "-m", "branch work");
  return { head, mergeBase };
}

/** Remove whatever the builder created (a worktree is deregistered before its dir goes), then the repo. */
function teardown(head: string, built: BaseProofDir | undefined): void {
  if (built?.baseIsCheckout && built.baseCheckoutDir) {
    try {
      git(head, "worktree", "remove", "--force", built.baseCheckoutDir);
    } catch {
      /* best-effort — rmSync below still clears the dir */
    }
  }
  if (built?.baseCheckoutDir) rmSync(built.baseCheckoutDir, { recursive: true, force: true });
  rmSync(head, { recursive: true, force: true });
}

/** The reviewer's own judgement of ONE criterion, with the REAL executor on both sides. */
function judgeWithRealExecutor(head: string, built: BaseProofDir, proof: string) {
  return judgeCriterion({ claim: "the widget is frobnicated", proof }, new Set(), undefined, {
    cwd: head,
    exec: execWhitelistedProof,
    baseCwd: built.baseCheckoutDir,
    baseUnreadablePaths: built.baseUnreadablePaths,
    baseIsCheckout: built.baseIsCheckout,
  });
}

const ALL_CRITERIA = [
  { proof: "unit test: test/would-pass-at-base.test.ts" },
  { proof: "unit test: test/would-fail-at-base.test.ts" },
  { proof: "unit test: test/head-only-import.test.ts" },
  { proof: "unit test: test/untouched.test.ts" },
];

// ── (1) would pass at base ⇒ executed_stale, reason names the file ─────────────────────────────

test("W1-T3098 (1): a PR-added test that asserts nothing is copied into the base, genuinely PASSES there, and grades executed_stale naming the file", () => {
  const { head } = fourScenarioRepo();
  let built: BaseProofDir | undefined;
  try {
    built = buildBaseProofDir(ALL_CRITERIA, head);
    assert.equal(built.baseIsCheckout, true, "a worktree was created — no fallback was needed");
    assert.equal(
      existsSync(join(built.baseCheckoutDir!, "test", "would-pass-at-base.test.ts")),
      true,
      "the diff-added file was copied into the base worktree",
    );
    // Precondition, measured directly: the copied file genuinely PASSES at the base.
    const wp = parseWhitelistedProof("unit test: test/would-pass-at-base.test.ts")!;
    assert.equal(execWhitelistedProof(wp, built.baseCheckoutDir!), "pass", "precondition: the base run is a real pass");

    const v = judgeWithRealExecutor(head, built, "unit test: test/would-pass-at-base.test.ts");
    assert.equal(v.proof_exec, "executed_stale", `a new test that would pass on the base proves nothing: ${v.reason}`);
    assert.equal(v.met, false, "the positive override is withdrawn, never converted into a failure");
    assert.match(v.reason, /non-discriminating/);
    assert.match(v.reason, /would-pass-at-base\.test\.ts/, "the reason NAMES the file");
  } finally {
    teardown(head, built);
  }
});

// ── (2) genuinely fails at base ⇒ discriminates (the fix narrows, never empties) ────────────────

test("W1-T3098 (2): a PR-added test that genuinely FAILS at base (it needs the PR's own implementation change) is copied in, genuinely fails there, and still grades discriminates", () => {
  const { head } = fourScenarioRepo();
  let built: BaseProofDir | undefined;
  try {
    built = buildBaseProofDir(ALL_CRITERIA, head);
    assert.equal(built.baseIsCheckout, true);
    assert.equal(
      existsSync(join(built.baseCheckoutDir!, "test", "would-fail-at-base.test.ts")),
      true,
      "the diff-added file was copied into the base worktree",
    );
    // Precondition, measured directly: the copied file genuinely FAILS at the base (widget is still 1).
    const wp = parseWhitelistedProof("unit test: test/would-fail-at-base.test.ts")!;
    assert.equal(execWhitelistedProof(wp, built.baseCheckoutDir!), "fail", "precondition: the base run is a real, genuine fail");

    const v = judgeWithRealExecutor(head, built, "unit test: test/would-fail-at-base.test.ts");
    assert.equal(v.proof_exec, "executed_pass", `passed on the head, and a genuine base fail discriminates: ${v.reason}`);
    assert.equal(v.met, true);
    assert.match(v.reason, /discriminates/);
    assert.doesNotMatch(v.reason, /base_unknown/, "a real checkout answered — this is not an environment gap");
  } finally {
    teardown(head, built);
  }
});

// ── (3) cannot even load at base ⇒ base_unknown, never pass, never discriminates ────────────────

test("W1-T3098 (3): a copied test that imports a module the PR itself added throws at import (module-load error) and grades base_unknown — never pass, never discriminates", () => {
  const { head } = fourScenarioRepo();
  let built: BaseProofDir | undefined;
  try {
    built = buildBaseProofDir(ALL_CRITERIA, head);
    assert.equal(built.baseIsCheckout, true);
    assert.equal(
      existsSync(join(built.baseCheckoutDir!, "test", "head-only-import.test.ts")),
      true,
      "the diff-added test itself was copied into the base worktree",
    );
    assert.equal(
      existsSync(join(built.baseCheckoutDir!, "src", "head-only.ts")),
      false,
      "…but the module it imports is SOURCE, not test/**, and the copy step never reaches it",
    );
    // Precondition, measured directly: the base run genuinely THROWS (a module-load error), it
    // does not cleanly resolve to "pass" or "fail".
    const wp = parseWhitelistedProof("unit test: test/head-only-import.test.ts")!;
    assert.throws(() => execWhitelistedProof(wp, built!.baseCheckoutDir!), "precondition: the raw base run throws");

    const v = judgeWithRealExecutor(head, built, "unit test: test/head-only-import.test.ts");
    assert.equal(v.proof_exec, "executed_pass", "no downgrade on an environment gap — executed_pass stands");
    assert.match(v.reason, /base_unknown/, `graded base_unknown: ${v.reason}`);
    assert.doesNotMatch(v.reason, /discriminates/, "and NEVER credited with a discrimination nobody measured");
  } finally {
    teardown(head, built);
  }
});

// ── (4) a file this diff never touched is not re-copied over itself ─────────────────────────────

test("W1-T3098 (4): only the diff's ADDED test/** files are copied — a pre-existing, untouched test file is never handed to the copy seam", () => {
  const { head } = fourScenarioRepo();
  let built: BaseProofDir | undefined;
  const copiedRelPaths: string[] = [];
  try {
    built = buildBaseProofDir(ALL_CRITERIA, head, {
      copyFile: (src: string, dest: string) => {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(src));
        copiedRelPaths.push(relative(head, src).split(sep).join("/"));
      },
    });
    assert.equal(built.baseIsCheckout, true);
    assert.deepEqual(
      [...copiedRelPaths].sort(),
      ["test/head-only-import.test.ts", "test/would-fail-at-base.test.ts", "test/would-pass-at-base.test.ts"],
      "exactly the diff's three added test/** files — never test/untouched.test.ts, never test/setup/tmp-hygiene.ts",
    );
    // The base's OWN copy of the untouched file is still there (from the checkout itself, not from
    // a copy this step performed) and its own proof still runs and passes — nothing was disturbed.
    assert.equal(existsSync(join(built.baseCheckoutDir!, "test", "untouched.test.ts")), true);
    const untouched = parseWhitelistedProof("unit test: test/untouched.test.ts")!;
    assert.equal(execWhitelistedProof(untouched, built.baseCheckoutDir!), "pass");
  } finally {
    teardown(head, built);
  }
});
