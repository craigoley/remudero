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
 * TWO MORE ARMS, added for the two edge cases the four arms above never drive (W1-T3243 round 2):
 * the design's own doc names both as real conditions ("(v) A ROLLBACK THAT ITSELF FAILS SAYS
 * SO"), not just theoretical branches, so each gets its own falsifier:
 *  (5) the `git write-tree` SNAPSHOT itself can fail (e.g. an unmerged index elsewhere in the
 *      tree) — recorded via `log`, and rollback is then correctly SKIPPED rather than attempted
 *      against a snapshot that was never taken.
 *  (6) the ROLLBACK's own `git read-tree <preTree>` can fail (e.g. the snapshot object is gone) —
 *      recorded via `log`, but the ORIGINAL commit refusal is still what the caller sees, never
 *      the rollback's own error.
 *
 * Both call sites are exercised (design (iv): "the pair is the unit of repair") — a synthetic
 * `hooks/pre-commit` that always refuses, never the real (expensive, unrelated-content-aware)
 * hook this repo ships, so the arm under test is purely "the commit exits non-zero", not this
 * repo's own lint/test gate.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** Arm (5): puts `path` into the index as a real three-way UNMERGED entry (stages 1/2/3, no
 *  stage 0) — the same shape a real `git merge` conflict leaves, and the one condition that makes
 *  `git write-tree` itself refuse ("error building trees") before either function under test ever
 *  reaches `add`/`commit`. Built from plumbing (`hash-object -w` + `update-index --index-info`)
 *  rather than an actual conflicting merge so the fixture stays two calls instead of two branches
 *  and a real divergent history. */
function makeUnmergedIndexEntry(repo: GitRepo, path: string): void {
  const scratchDir = join(repo.dir, ".t3243-scratch");
  mkdirSync(scratchDir, { recursive: true });
  const stageObjects = ["base", "ours", "theirs"].map((label, i) => {
    const scratchPath = join(scratchDir, label);
    writeFileSync(scratchPath, `${label}\n`, "utf8");
    return { stage: i + 1, sha: repo.git("hash-object", "-w", scratchPath) };
  });
  const indexInfo = stageObjects.map(({ stage, sha }) => `100644 ${sha} ${stage}\t${path}\n`).join("");
  execFileSync("git", ["-C", repo.dir, "update-index", "--index-info"], { input: indexInfo, encoding: "utf8" });
  rmSync(scratchDir, { recursive: true, force: true });
}

/** Arm (6): a synthetic `hooks/pre-commit` that, when the caller has told it (via
 *  `$T3243_PRETREE`, set on `process.env` right before the call under test — both functions'
 *  `execFileSync` calls carry no explicit `env`, so they inherit it live) which tree object the
 *  function's OWN `write-tree` snapshot just captured, deletes that object's loose file BEFORE
 *  refusing. By the time the function's catch clause runs its own `git read-tree <preTree>`, the
 *  object is gone and the rollback itself fails — the exact condition design note (v) names. */
const ROLLBACK_SABOTAGE_HOOK = [
  "#!/bin/sh",
  'if [ -n "$T3243_PRETREE" ]; then',
  '  PREFIX=$(printf "%s" "$T3243_PRETREE" | cut -c1-2)',
  '  REST=$(printf "%s" "$T3243_PRETREE" | cut -c3-)',
  '  rm -f "$(git rev-parse --git-dir)/objects/$PREFIX/$REST"',
  "fi",
  'echo "pre-commit refused: synthetic test hook" >&2',
  "exit 1",
  "",
].join("\n");

/** `commitGeneratorOutputViaGit` has no injectable `log` — arms (5)/(6) for it read
 *  `process.stderr.write`'s own text directly (the same channel the function's `stdio: "pipe"`
 *  children's refusal text already reaches the caller through), captured and restored around
 *  exactly one call so no other test in this file ever sees a patched stream. */
function captureStderr(fn: () => void): { thrown: unknown; stderrText: string } {
  const original = process.stderr.write.bind(process.stderr);
  let stderrText = "";
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    stderrText += typeof chunk === "string" ? chunk : String(chunk);
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  } finally {
    process.stderr.write = original;
  }
  return { thrown, stderrText };
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

test("W1-T3243: applyPlanProposalCommit — a write-tree snapshot failure is recorded, and rollback is then correctly SKIPPED rather than attempted", () => {
  const repo = seedRepo(); // no hook needed — git itself refuses a commit with unmerged paths
  makeUnmergedIndexEntry(repo, "conflict.txt");
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T996\n", "utf8");

  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  // `gitAddAndCommitWithRollback` runs with `stdio: "inherit"` here (matching the existing "the
  // commit's own refusal reaches the caller" test above), so the thrown error's own `.message` is
  // execFileSync's generic "Command failed" text, never the child's stderr — asserted only as a
  // real `Error`, the same posture that sibling test already takes.
  assert.throws(() =>
    applyPlanProposalCommit(repo.dir, "chore(plan): test", (step, extra) => logs.push({ step, extra })),
  );

  // (5) The `write-tree` snapshot itself failed (an unmerged index elsewhere in the tree, not
  // even under `plan/`) — recorded via `log`, never left silent.
  assert.ok(
    logs.some((l) => l.step === "plan_commit.snapshot.error"),
    "a write-tree snapshot failure must be recorded",
  );
  // With no snapshot to roll back to, the catch takes the SKIPPED branch, not a rollback attempt
  // against a tree that was never captured.
  assert.ok(
    logs.some((l) => l.step === "plan_commit.rollback.skipped"),
    "no snapshot means rollback must be reported as skipped, not attempted",
  );
});

test("W1-T3243: applyPlanProposalCommit — a rollback that itself fails is recorded, but the ORIGINAL commit refusal is still what the caller sees", () => {
  const repo = seedRepo(ROLLBACK_SABOTAGE_HOOK);
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T995\n", "utf8");

  // The index is unchanged since seedRepo's last commit, so this is EXACTLY the tree
  // `gitAddAndCommitWithRollback`'s own pre-`add` `git write-tree` is about to capture — letting
  // the sabotage hook above delete precisely that object once the commit it refuses runs.
  const preTree = repo.git("write-tree");
  process.env.T3243_PRETREE = preTree;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let thrown: unknown;
  try {
    try {
      applyPlanProposalCommit(repo.dir, "chore(plan): test", (step, extra) => logs.push({ step, extra }));
    } catch (e) {
      thrown = e;
    }
  } finally {
    delete process.env.T3243_PRETREE;
  }

  // (6) The rollback's own `read-tree` failed against the now-missing object — recorded, never
  // silent (design note (v)).
  assert.ok(
    logs.some((l) => l.step === "plan_commit.rollback.error"),
    "a rollback that itself fails must be recorded",
  );
  // The hook's OWN refusal — never the rollback's internal error — is what the caller sees. Same
  // `stdio: "inherit"` posture as above: a real `Error` is the assertion, not its `.message` text.
  assert.ok(thrown instanceof Error, "the commit's own refusal must still reach the caller");
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

test("W1-T3243: commitGeneratorOutputViaGit — a write-tree snapshot failure is recorded on stderr, and the refused commit still surfaces to the caller", () => {
  const repo = seedRepo(REFUSING_HOOK);
  // Unmerged BEFORE this function's own `git add -A` runs, so its pre-add `write-tree` call
  // (design (i)) sees the same unmerged index `applyPlanProposalCommit`'s falsifier above drives —
  // `add -A` then resolves it away (the working file was never materialized), which is exactly why
  // this arm needs the hook: the resolved index alone would let a plain commit through.
  makeUnmergedIndexEntry(repo, "conflict.txt");
  writeFileSync(join(repo.dir, "generator-output.txt"), "generated content\n", "utf8");

  const { thrown, stderrText } = captureStderr(() => {
    commitGeneratorOutputViaGit({ cwd: repo.dir, message: "chore: generator output" });
  });

  // (5) The write-tree snapshot failure is recorded, never left silent.
  assert.match(stderrText, /commitGeneratorOutputViaGit: snapshot\.error/);
  // The commit's own refusal still reaches the caller — recording the snapshot failure never
  // swallows it.
  assert.ok(thrown instanceof Error, "a refused commit must still throw");
  assert.match(String((thrown as Error).message), /pre-commit refused/);
});

test("W1-T3243: commitGeneratorOutputViaGit — a rollback that itself fails is recorded on stderr, but the ORIGINAL commit refusal is still what the caller sees", () => {
  const repo = seedRepo(ROLLBACK_SABOTAGE_HOOK);
  writeFileSync(join(repo.dir, "generator-output.txt"), "generated content\n", "utf8");

  // The index is unchanged since seedRepo's last commit — EXACTLY the tree this function's own
  // pre-`add` `git write-tree` is about to capture.
  const preTree = repo.git("write-tree");
  process.env.T3243_PRETREE = preTree;
  let thrown: unknown;
  let stderrText = "";
  try {
    ({ thrown, stderrText } = captureStderr(() => {
      commitGeneratorOutputViaGit({ cwd: repo.dir, message: "chore: generator output" });
    }));
  } finally {
    delete process.env.T3243_PRETREE;
  }

  // (6) The rollback's own `read-tree` failed against the now-missing object — recorded, never
  // silent (design note (v)).
  assert.match(stderrText, /commitGeneratorOutputViaGit: rollback\.error/);
  // The hook's OWN refusal — never the rollback's internal error — is what the caller sees.
  assert.ok(thrown instanceof Error, "the commit's own refusal must still reach the caller");
  assert.match(String((thrown as Error).message), /pre-commit refused/);
});
