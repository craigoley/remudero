/**
 * test/a-refused-commit-leaves-no-staged-residue.test.ts — W1-T3243.
 *
 * MEASURED 2026-09-09 (this task's own rationale, plan/tasks.d/): a real daemon checkout carried
 * 88 staged `plan/` entries for hours after a refused commit, and every plan-reading verb
 * (`checkCliFreshness`) refused on them. THE SHAPE: `applyPlanProposalCommit`
 * (src/lib/plan-architect.ts) and `commitGeneratorOutputViaGit` (src/run-task.ts) both ran
 * `git add` then `git commit`, with no rollback if the commit was refused (e.g. by
 * `hooks/pre-commit`) — a non-zero commit threw AFTER the add had already succeeded, and
 * nothing ever unstaged it.
 *
 * FOUR ARMS, matching the task's own falsifier:
 *  (1) a refused commit leaves the index exactly as it was on entry — no plan path stays staged.
 *  (2) the commit's own refusal text still reaches the caller (never swallowed to look clean).
 *  (3) POSITIVE CONTROL for (1): content the CALLER had already staged before the call survives
 *      the rollback untouched — the failure mode a blunt `git reset --hard` / `git checkout --
 *      .` would not catch, and both are explicitly forbidden by the task's own design.
 *  (4) POSITIVE CONTROL for the whole suite: a SUCCESSFUL commit still commits every staged
 *      path — "nothing is staged afterwards" must not be satisfied by the writer never staging
 *      anything at all.
 *
 * Both call sites are exercised (design (iv): "the pair is the unit of repair") — a synthetic
 * `hooks/pre-commit` that always refuses, never the real (expensive, unrelated-content-aware)
 * hook this repo ships, so the arm under test is purely "the commit exits non-zero", not this
 * repo's own lint/test gate.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { applyPlanProposalCommit } from "../src/lib/plan-architect.js";
import { commitGeneratorOutputViaGit } from "../src/run-task.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

/** Always refuses, on stderr, with the same "pre-commit refused" phrase the real hook uses
 *  (recon: `hooks/pre-commit` prints it) — so a test asserting on that text is asserting on the
 *  house's own refusal vocabulary, not an invented one. */
const REFUSING_HOOK = ["#!/bin/sh", 'echo "pre-commit refused: synthetic test hook" >&2', "exit 1", ""].join("\n");

/** A throwaway repo with `plan/tasks.yaml` + `MASTER-PLAN.md` committed, and — when `hook` is
 *  given — a synthetic `hooks/pre-commit` wired via `core.hooksPath` (never the real hook: see
 *  the file header). Mirrors `test/plan-architect.test.ts`'s `seedPlanRepo`. */
function seedRepo(hook?: string): GitRepo {
  const repo = gitRepo({ kind: "t3243-commit-rollback" });
  mkdirSync(join(repo.dir, "plan"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "tasks: []\n", "utf8");
  writeFileSync(join(repo.dir, "MASTER-PLAN.md"), "# MASTER-PLAN\n", "utf8");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base");

  if (hook !== undefined) {
    mkdirSync(join(repo.dir, "hooks"), { recursive: true });
    writeFileSync(join(repo.dir, "hooks", "pre-commit"), hook, "utf8");
    chmodSync(join(repo.dir, "hooks", "pre-commit"), 0o755);
    // Committed into the base commit (via a plain `git commit`, before `core.hooksPath` is set
    // below) so the hook file itself never shows up as untracked noise in a later test's
    // porcelain assertions.
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "-m", "install synthetic pre-commit hook");
    repo.git("config", "core.hooksPath", "hooks");
  }
  return repo;
}

function porcelainLines(repo: GitRepo): string[] {
  return repo
    .git("status", "--porcelain=v1")
    .split("\n")
    .map((s) => s.trimEnd())
    .filter(Boolean)
    .sort();
}

// ── applyPlanProposalCommit (src/lib/plan-architect.ts) ─────────────────────────────────────

test("W1-T3243: applyPlanProposalCommit — a refused commit leaves no plan path staged, restores the index exactly, and content the caller had already staged survives", () => {
  const repo = seedRepo(REFUSING_HOOK);

  // (3) Content the CALLER staged BEFORE this call — must come out the other side untouched.
  writeFileSync(join(repo.dir, "caller-owned.txt"), "caller's own staged change\n", "utf8");
  repo.git("add", "caller-owned.txt");
  assert.deepEqual(porcelainLines(repo), ["A  caller-owned.txt"]);

  // The plan-scope edit this call is meant to commit.
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T999\n", "utf8");

  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  assert.throws(() =>
    applyPlanProposalCommit(repo.dir, "chore(plan): test", (step, extra) => logs.push({ step, extra })),
  );

  // (1) No plan path remains staged, and the index is EXACTLY what it held on entry: only the
  // caller's own pre-staged file, in the same staged state as before the call.
  assert.deepEqual(porcelainLines(repo), [" M plan/tasks.yaml", "A  caller-owned.txt"]);

  // The plan edit itself is NOT thrown away — it is back in the WORKING TREE, unstaged, never
  // destroyed by the rollback (design (ii) forbids `git reset --hard` / `git checkout -- .`,
  // which would have wiped it).
  assert.match(repo.git("diff", "--", "plan/tasks.yaml"), /W1-T999/);
});

test("W1-T3243: applyPlanProposalCommit — the commit's own refusal reaches the caller (rethrown, not swallowed)", () => {
  const repo = seedRepo(REFUSING_HOOK);
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T998\n", "utf8");

  let thrown: unknown;
  try {
    applyPlanProposalCommit(repo.dir, "chore(plan): test");
  } catch (e) {
    thrown = e;
  }
  // (2) The rollback never swallows the failure into a clean-looking return — a real error
  // still comes out, so a caller cannot mistake this for a successful commit.
  assert.ok(thrown instanceof Error, "a refused commit must still throw");
});

test("W1-T3243: applyPlanProposalCommit — a SUCCESSFUL commit still commits every path it staged (positive control)", () => {
  const repo = seedRepo(); // no hook installed — nothing refuses this commit
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T997\n", "utf8");
  writeFileSync(join(repo.dir, "MASTER-PLAN.md"), "# MASTER-PLAN\n\nW1-T997\n", "utf8");

  applyPlanProposalCommit(repo.dir, "chore(plan): test success");

  // (4) Nothing is left staged BECAUSE it landed in a real commit, not because the writer
  // stopped staging things.
  assert.deepEqual(porcelainLines(repo), []);
  const committedDiff = repo.git("diff", "--no-color", "HEAD~1", "HEAD");
  assert.match(committedDiff, /W1-T997/);
  assert.match(committedDiff, /plan\/tasks\.yaml/);
  assert.match(committedDiff, /MASTER-PLAN\.md/);
});

// ── commitGeneratorOutputViaGit (src/run-task.ts) — the SAME shape, the OTHER call site ─────

test("W1-T3243: commitGeneratorOutputViaGit — a refused commit leaves no residue, restores the index exactly, keeps the caller's own staged content, and rethrows the hook's own text", () => {
  const repo = seedRepo(REFUSING_HOOK);

  writeFileSync(join(repo.dir, "caller-owned.txt"), "caller's own staged change\n", "utf8");
  repo.git("add", "caller-owned.txt");
  assert.deepEqual(porcelainLines(repo), ["A  caller-owned.txt"]);

  writeFileSync(join(repo.dir, "generator-output.txt"), "generated content\n", "utf8");

  let thrown: unknown;
  try {
    commitGeneratorOutputViaGit({ cwd: repo.dir, message: "chore: generator output" });
  } catch (e) {
    thrown = e;
  }
  // (2) `git add -A`/`git commit` run with `stdio: "pipe"` here, so the thrown error carries the
  // hook's own stderr text verbatim — the actionable half the rollback must never hide.
  assert.ok(thrown instanceof Error, "a refused commit must still throw");
  assert.match(String((thrown as Error).message), /pre-commit refused/);

  // (1)/(3) The caller's own staged file survives; the generator's output is unstaged again
  // (back to untracked, exactly as it stood before this call staged it).
  assert.deepEqual(porcelainLines(repo), ["?? generator-output.txt", "A  caller-owned.txt"]);
});

test("W1-T3243: commitGeneratorOutputViaGit — a SUCCESSFUL commit still commits the generator's staged output (positive control)", () => {
  const repo = seedRepo(); // no hook installed — nothing refuses this commit
  writeFileSync(join(repo.dir, "generator-output.txt"), "generated content\n", "utf8");

  const result = commitGeneratorOutputViaGit({ cwd: repo.dir, message: "chore: generator output" });

  assert.equal(result.changed, true);
  assert.equal(result.sha, repo.git("rev-parse", "HEAD"));
  assert.deepEqual(porcelainLines(repo), []);
  assert.match(repo.git("diff", "--no-color", "HEAD~1", "HEAD"), /generator-output\.txt/);
});
