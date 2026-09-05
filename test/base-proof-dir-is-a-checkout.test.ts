/**
 * test/base-proof-dir-is-a-checkout.test.ts — recon 2026-09-05, finding R-11.
 *
 * THE DEFECT. `buildBaseProofDir` (src/run-task.ts) materialised ONLY the blobs `grep:` proofs
 * name into a temp dir and returned a base dir only when at least one was written. W1-T362 had
 * already extended the merge-base staleness check to `unit test:` proofs, so every one of those
 * was re-run in a directory with no `package.json` and no `test/` (or against no base at all):
 * `node --test` exits 1 with empty stdout, `execWhitelistedProof` returns "fail", and
 * `classifyBaseProofOutcome` (src/lib/review.ts) graded anything-but-pass as "discriminates" —
 * `executed_pass`, with a reason asserting the proof told done from not-done. A test that passes
 * IDENTICALLY at base and head was therefore certified. Every W1-T362 test injected a fake
 * executor, so this shape was never exercised; this suite drives the REAL executor against a real
 * two-commit repository, exactly as the reviewer does.
 *
 * WHAT CLOSES IT. The base side is now a real detached git worktree at the merge-base, and the
 * builder reports `baseIsCheckout` so the classifier grades a `unit test:` proof `base_unknown` —
 * never "discriminates" — whenever the base is the blob-only fallback (or when a caller never said
 * what the base is: fail closed).
 *
 * FALSIFIERS, as the audit brief names them:
 *   (i)   a test file passing at both base and head is graded `executed_stale`;
 *   (ii)  a test file absent at base is graded `executed_pass` and recorded as discriminating;
 *   (iii) with the worktree seam forced to fail, a `unit test:` proof is `base_unknown`, never
 *         "discriminates".
 * Deleting the worktree materialisation reddens (i) (no base dir is ever built for a test-only
 * review, so nothing is ever stale); deleting the `base_unknown` classification reddens (iii).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildBaseProofDir, type BaseProofDir } from "../src/run-task.js";
import { execWhitelistedProof, judgeCriterion, parseWhitelistedProof, preexistingProofHits } from "../src/lib/review.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Identity from `-c` flags, never ambient config (CLAUDE.md, "A fixture shelling git PLUMBING …"). */
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const STALE_TEST = 'import { test } from "node:test";\ntest("stale: passes identically at base and head", () => {});\n';
const FRESH_TEST = 'import { test } from "node:test";\ntest("fresh: exists only on the head", () => {});\n';

/**
 * A REAL two-commit repository shaped so the REAL `unit test:` executor can run in BOTH trees:
 *   base:  package.json, a committed `node_modules` symlink to this repo's own install (so
 *          `--import tsx` resolves and `ensureDeps` sees an install and never runs `npm ci`), the
 *          `test/setup/tmp-hygiene.ts` stub the proof argv imports, `test/stale.test.ts`, and
 *          `src/a.ts` (a grep target for the fallback control); `origin/main` points here.
 *   head:  the same plus `test/fresh.test.ts` — the forward-referencing TDD case.
 * Returns the working directory that stands in for the reviewer's materialised head worktree.
 */
function twoCommitRepo(): { head: string; mergeBase: string } {
  const head = mkdtempSync(join(tmpdir(), "rmd-r11-head-"));
  git(head, "init", "--quiet", "-b", "main");
  writeFileSync(join(head, "package.json"), JSON.stringify({ name: "r11-fixture", private: true, type: "module" }));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(head, "node_modules"));
  mkdirSync(join(head, "test", "setup"), { recursive: true });
  writeFileSync(join(head, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(head, "test", "stale.test.ts"), STALE_TEST);
  mkdirSync(join(head, "src"), { recursive: true });
  writeFileSync(join(head, "src", "a.ts"), "export const alreadyHere = 1;\n");
  git(head, "add", "-A");
  git(head, "commit", "--quiet", "-m", "base");
  const mergeBase = git(head, "rev-parse", "HEAD");
  git(head, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(head, "test", "fresh.test.ts"), FRESH_TEST);
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

// ── the base is a real checkout ──────────────────────────────────────────────────────────────────

test("R-11: the base dir is a detached worktree AT THE MERGE-BASE, and a unit-test-only review gets one", () => {
  const { head, mergeBase } = twoCommitRepo();
  let built: BaseProofDir | undefined;
  try {
    built = buildBaseProofDir([{ proof: "unit test: test/stale.test.ts" }], head);
    assert.equal(built.baseIsCheckout, true, "a worktree was created — no fallback was needed");
    assert.ok(built.baseCheckoutDir, "a `unit test:` proof alone is enough to want a base");
    assert.equal(git(built.baseCheckoutDir!, "rev-parse", "HEAD"), mergeBase, "checked out at the merge-base, not the head");
    assert.equal(existsSync(join(built.baseCheckoutDir!, "test", "stale.test.ts")), true, "the base's own test file is there");
    assert.equal(existsSync(join(built.baseCheckoutDir!, "test", "fresh.test.ts")), false, "the head-only file is not");
    assert.equal(existsSync(join(built.baseCheckoutDir!, "package.json")), true, "a tree `node --test` can run in");
    assert.deepEqual([...built.baseUnreadablePaths], [], "a checkout has no per-blob read step to fail");
    assert.equal(built.baseWorktreeFailure, undefined);
  } finally {
    teardown(head, built);
  }
});

// ── (i) passes at both commits ⇒ executed_stale ──────────────────────────────────────────────────

test("R-11 (i): a `unit test:` file that passes at BOTH base and head is graded executed_stale by the real executor", () => {
  const { head } = twoCommitRepo();
  let built: BaseProofDir | undefined;
  try {
    built = buildBaseProofDir([{ proof: "unit test: test/stale.test.ts" }], head);
    // Precondition, measured directly: the proof genuinely PASSES in the base worktree.
    const wp = parseWhitelistedProof("unit test: test/stale.test.ts")!;
    assert.equal(execWhitelistedProof(wp, built.baseCheckoutDir!), "pass", "precondition: the base run is a real pass");
    assert.equal(preexistingProofHits(wp, execWhitelistedProof, built.baseCheckoutDir, built.baseUnreadablePaths, built.baseIsCheckout), true);

    const v = judgeWithRealExecutor(head, built, "unit test: test/stale.test.ts");
    assert.equal(v.proof_exec, "executed_stale", `a pass at both commits discriminates nothing: ${v.reason}`);
    assert.equal(v.met, false, "the positive override is withdrawn, never converted into a failure");
    assert.match(v.reason, /non-discriminating/);
  } finally {
    teardown(head, built);
  }
});

// ── (ii) absent at base ⇒ discriminates ──────────────────────────────────────────────────────────

test("R-11 (ii): a `unit test:` file ABSENT at the base (forward-referencing TDD) keeps executed_pass and is recorded as discriminating", () => {
  const { head } = twoCommitRepo();
  let built: BaseProofDir | undefined;
  try {
    built = buildBaseProofDir([{ proof: "unit test: test/fresh.test.ts" }], head);
    assert.equal(built.baseIsCheckout, true);
    const v = judgeWithRealExecutor(head, built, "unit test: test/fresh.test.ts");
    assert.equal(v.proof_exec, "executed_pass", `absent at base is the OPPOSITE of stale: ${v.reason}`);
    assert.equal(v.met, true);
    assert.match(v.reason, /discriminates/);
    assert.doesNotMatch(v.reason, /base_unknown/, "a real checkout answered — this is not an environment gap");
  } finally {
    teardown(head, built);
  }
});

// ── (iii) the worktree cannot be created ⇒ base_unknown, never discriminates ────────────────────

test("R-11 (iii): with the worktree seam forced to fail, a `unit test:` proof is base_unknown — NEVER discriminates — while a grep sibling still uses its blob", () => {
  const { head } = twoCommitRepo();
  let built: BaseProofDir | undefined;
  try {
    built = buildBaseProofDir(
      [{ proof: "unit test: test/stale.test.ts" }, { proof: "grep: alreadyHere in src/a.ts" }],
      head,
      {
        addWorktree: () => {
          throw new Error("worktree refused by the fixture");
        },
      },
    );
    assert.equal(built.baseIsCheckout, false, "the fallback was taken");
    assert.match(built.baseWorktreeFailure ?? "", /refused by the fixture/, "and the builder says why");
    assert.ok(built.baseCheckoutDir, "the grep sibling's blob still yields a base dir (the pre-R-11 shape)");
    assert.equal(existsSync(join(built.baseCheckoutDir!, "test", "stale.test.ts")), false, "…which holds no test file at all");

    // THE DEFECT, reproduced on the raw executor: in that blob dir the base run of the test proof
    // is a "fail" — `node --test` finds no file — which the classifier used to read as evidence.
    const wp = parseWhitelistedProof("unit test: test/stale.test.ts")!;
    assert.equal(execWhitelistedProof(wp, built.baseCheckoutDir!), "fail", "the raw base run cannot tell 'no file here' from 'failed before the work'");

    const v = judgeWithRealExecutor(head, built, "unit test: test/stale.test.ts");
    assert.equal(v.proof_exec, "executed_pass", "no downgrade on an environment gap");
    assert.match(v.reason, /base_unknown/, `graded base_unknown: ${v.reason}`);
    assert.doesNotMatch(v.reason, /discriminates/, "and NEVER credited with a discrimination nobody measured");
    assert.match(v.reason, /cannot be re-run against blobs/, "the reason names the cause");
    assert.equal(
      preexistingProofHits(wp, execWhitelistedProof, built.baseCheckoutDir, built.baseUnreadablePaths, built.baseIsCheckout),
      false,
    );

    // CONTROL: the grep sibling IS checked against its blob in the same fallback — and is stale,
    // because the symbol already exists at the base. The fallback lost nothing it ever had.
    const g = judgeWithRealExecutor(head, built, "grep: alreadyHere in src/a.ts");
    assert.equal(g.proof_exec, "executed_stale", `the grep half of the fallback still discriminates honestly: ${g.reason}`);
  } finally {
    teardown(head, built);
  }
});

test("R-11: the classifier FAILS CLOSED — a base dir handed over without `baseIsCheckout` grades a `unit test:` proof base_unknown", () => {
  const { head } = twoCommitRepo();
  let built: BaseProofDir | undefined;
  try {
    built = buildBaseProofDir([{ proof: "unit test: test/stale.test.ts" }], head);
    assert.equal(built.baseIsCheckout, true, "the dir IS a checkout — a pass there would be stale (see (i))…");
    const v = judgeCriterion({ claim: "the widget is frobnicated", proof: "unit test: test/stale.test.ts" }, new Set(), undefined, {
      cwd: head,
      exec: execWhitelistedProof,
      baseCwd: built.baseCheckoutDir,
      baseUnreadablePaths: built.baseUnreadablePaths,
      // …but a caller that never SAID so (every caller predating R-11) gets no discrimination claim.
    });
    assert.equal(v.proof_exec, "executed_pass");
    assert.match(v.reason, /base_unknown/);
    assert.doesNotMatch(v.reason, /discriminates/);
  } finally {
    teardown(head, built);
  }
});

// ── no dialect proof ⇒ no worktree paid for ──────────────────────────────────────────────────────

test("R-11: prose-only criteria build no base at all — a checkout nobody would run in is never added", () => {
  const { head } = twoCommitRepo();
  try {
    const built = buildBaseProofDir([{ proof: "some prose claim" }, {}], head);
    assert.equal(built.baseCheckoutDir, undefined);
    assert.equal(built.baseIsCheckout, false);
    assert.equal(git(head, "worktree", "list").split("\n").length, 1, "the fixture repo has only its own worktree");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});
