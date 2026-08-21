import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyPlanProposalCommit } from "../src/lib/plan-architect.js";

// ── W1-T1089: every Architect filing lane that may amend MASTER-PLAN.md must (1) actually
// commit that amendment, and (2) ship a plan/plan-index.json regenerated FROM it ────────────
//
// Two defects, one code path, both read out of `applyPlanProposalCommit` (lib/plan-architect.ts)
// — the ONE shared stage-and-commit function `rmd plan`'s propose outcome AND (as of this task)
// triage's propose-path commit both call:
//
//   (1) triage's OWN inline commit used to stage only `plan/` — never `MASTER-PLAN.md`, a
//       root-level file outside that pathspec — so a plan amendment the Architect wrote (and
//       triagePrompt/decideTriage/nonPlanFilesInDiff all explicitly license) was silently
//       dropped: the PR opened, but the edit was never in it and died with the worktree.
//   (2) even when MASTER-PLAN.md IS staged (approve, and now triage), plan/plan-index.json is
//       LINE-NUMBERED (`line: idx + 1` per `## ` heading, scripts/generate-plan-index.mjs) — an
//       edit that inserts prose ABOVE a heading without adding one shifts every entry below it,
//       so "did a heading get added" is the wrong staleness test.
//
// This suite drives the REAL `applyPlanProposalCommit` — never a description of what it does —
// against a REAL throwaway git repo carrying the REAL `scripts/generate-plan-index.mjs` (copied
// byte-for-byte, never reimplemented), so every assertion below reads state back off actual
// `git`/generator output. It proves the fix in BOTH directions (design (iv)): a "stages the old
// way" variant must fail the commit-contains-the-edit assertion, and a "regeneration suppressed"
// variant must fail the index-is-fresh assertion — a test that cannot fail proves nothing.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const REAL_GENERATOR_SCRIPT = join(REPO_ROOT, "scripts", "generate-plan-index.mjs");

const BASELINE_MASTER_PLAN = [
  "# MASTER-PLAN",
  "",
  "## Section One",
  "",
  "Prose about section one.",
  "",
  "## Section Two",
  "",
  "Prose about section two.",
  "",
].join("\n");

// Inserts two prose lines ABOVE the existing "## Section Two" heading — the precise case the
// old "did a heading get added" folklore missed: heading COUNT is unchanged (still 2), but
// every entry from Section Two on now sits two lines lower than the committed index says.
const EDITED_MASTER_PLAN = [
  "# MASTER-PLAN",
  "",
  "## Section One",
  "",
  "Prose about section one.",
  "",
  "A new sentence.",
  "Another new sentence.",
  "## Section Two",
  "",
  "Prose about section two.",
  "",
].join("\n");

const BASELINE_PLAN_TASKS_YAML = "tasks:\n  - id: W1-T1\n    status: queued\n";
// Mirrors the harness-owned status write (setFeedbackStatus) every real triage commit ships
// ALONGSIDE a propose-path MASTER-PLAN.md amendment — without it, the "stages plan/ only"
// falsifier below would have nothing under plan/ to stage and `git commit` would fail outright
// on an empty index rather than reproducing the dropped-amendment bug it exists to demonstrate.
const EDITED_PLAN_TASKS_YAML = "tasks:\n  - id: W1-T1\n    status: proposed\n";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

// Mirrors regeneratePlanIndexFile's OWN invocation exactly (relative --source/--out, cwd set to
// the worktree) — an absolute --source would get recorded verbatim in the output's `source`
// field and make every byte-equal comparison below a false negative unrelated to staleness.
function runRealGenerator(cwd: string, outRelPath: string, sourceRelPath = "MASTER-PLAN.md"): void {
  const result = spawnSync(process.execPath, [REAL_GENERATOR_SCRIPT, "--source", sourceRelPath, "--out", outRelPath], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

/**
 * A real, throwaway git repo carrying MASTER-PLAN.md, plan/, and the REAL
 * scripts/generate-plan-index.mjs (copied, never reimplemented) — with a baseline
 * plan/plan-index.json committed that already matches a fresh regeneration of the baseline
 * MASTER-PLAN.md, exactly the "matching committed index" starting state design (iv) calls for.
 */
function seedFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-architect-lane-master-plan-commit-"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "MASTER-PLAN.md"), BASELINE_MASTER_PLAN, "utf8");
  writeFileSync(join(dir, "plan", "tasks.yaml"), BASELINE_PLAN_TASKS_YAML, "utf8");
  copyFileSync(REAL_GENERATOR_SCRIPT, join(dir, "scripts", "generate-plan-index.mjs"));
  runRealGenerator(dir, join("plan", "plan-index.json"));

  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "base"]);
  return dir;
}

test("applyPlanProposalCommit: a MASTER-PLAN.md amendment lands in the commit, and the committed plan-index is byte-fresh even with no heading added", () => {
  const dir = seedFixtureRepo();
  try {
    writeFileSync(join(dir, "MASTER-PLAN.md"), EDITED_MASTER_PLAN, "utf8");
    writeFileSync(join(dir, "plan", "tasks.yaml"), EDITED_PLAN_TASKS_YAML, "utf8");

    // The REAL commit — the SAME exported function triage's propose-path commit and `rmd
    // plan`'s propose outcome both call (run-task.ts's imports + call sites).
    applyPlanProposalCommit(dir, "chore(plan): amend MASTER-PLAN.md\n\nRemudero-Task: W1-T1089");

    // (a) the committed tree carries the MASTER-PLAN.md edit — read straight off `git show`,
    // never asserted from memory.
    const committedMasterPlan = git(dir, ["show", "HEAD:MASTER-PLAN.md"]);
    assert.equal(committedMasterPlan, EDITED_MASTER_PLAN);
    const changedFiles = git(dir, ["diff", "--name-only", "HEAD~1", "HEAD"]).split("\n").filter(Boolean);
    assert.ok(changedFiles.includes("MASTER-PLAN.md"), `expected MASTER-PLAN.md in ${changedFiles.join(", ")}`);

    // (b) the committed plan/plan-index.json byte-equals a FRESH regeneration off the edited
    // MASTER-PLAN.md — proving the index was regenerated FROM the edit that landed, not left
    // over from the baseline, even though the heading count never changed (still 2 headings).
    const committedIndex = git(dir, ["show", "HEAD:plan/plan-index.json"]);
    const freshOutRel = "fresh-plan-index.json";
    runRealGenerator(dir, freshOutRel);
    const freshIndex = readFileSync(join(dir, freshOutRel), "utf8");
    assert.equal(committedIndex, freshIndex);

    // The regenerated index actually shifted (not a vacuous byte-equal against unchanged
    // content) — Section Two's line moved down by the two inserted lines.
    const baselineIndex = JSON.parse(execFileSync("git", ["-C", dir, "show", "HEAD~1:plan/plan-index.json"], { encoding: "utf8" }));
    const editedIndex = JSON.parse(freshIndex);
    const sectionTwoBefore = baselineIndex.entries.find((e: { heading: string }) => e.heading === "Section Two").line;
    const sectionTwoAfter = editedIndex.entries.find((e: { heading: string }) => e.heading === "Section Two").line;
    assert.equal(sectionTwoAfter, sectionTwoBefore + 2);
    assert.equal(editedIndex.entries.length, baselineIndex.entries.length); // heading COUNT unchanged
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER (a): a commit that stages the OLD way (plan/ only, never MASTER-PLAN.md) fails the 'amendment landed' assertion", () => {
  const dir = seedFixtureRepo();
  try {
    writeFileSync(join(dir, "MASTER-PLAN.md"), EDITED_MASTER_PLAN, "utf8");
    writeFileSync(join(dir, "plan", "tasks.yaml"), EDITED_PLAN_TASKS_YAML, "utf8");

    // triage's pre-fix inline commit, reproduced here (never calling applyPlanProposalCommit)
    // to prove this suite's own assertion (a) is falsifiable, not vacuously true.
    execFileSync("git", ["-C", dir, "add", "-A", "--", "plan/"], { stdio: "pipe" });
    execFileSync("git", ["-C", dir, "commit", "-m", "old-style commit (plan/ only)"], { stdio: "pipe" });

    const changedFiles = git(dir, ["diff", "--name-only", "HEAD~1", "HEAD"]).split("\n").filter(Boolean);
    assert.ok(
      !changedFiles.includes("MASTER-PLAN.md"),
      "the old pathspec must NOT have picked up MASTER-PLAN.md — reproducing the dropped-amendment bug",
    );
    // The edit is still sitting, uncommitted, in the working tree — exactly the "discarded
    // silently" failure mode the rationale describes (nothing says a file was dropped).
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
    assert.match(status, /MASTER-PLAN\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER (b): a commit that stages both files but SKIPS regeneration fails the 'index is fresh' assertion", () => {
  const dir = seedFixtureRepo();
  try {
    writeFileSync(join(dir, "MASTER-PLAN.md"), EDITED_MASTER_PLAN, "utf8");
    writeFileSync(join(dir, "plan", "tasks.yaml"), EDITED_PLAN_TASKS_YAML, "utf8");

    // applyPlanProposalCommit's pre-fix body, reproduced here (stage + commit, no
    // regeneratePlanIndexFile call) to prove assertion (b) is falsifiable too.
    execFileSync("git", ["-C", dir, "add", "-A", "--", "plan/", "MASTER-PLAN.md"], { stdio: "pipe" });
    execFileSync("git", ["-C", dir, "commit", "-m", "old-style commit (no regeneration)"], { stdio: "pipe" });

    const committedIndex = git(dir, ["show", "HEAD:plan/plan-index.json"]);
    const freshOutRel = "fresh-plan-index.json";
    runRealGenerator(dir, freshOutRel);
    const freshIndex = readFileSync(join(dir, freshOutRel), "utf8");
    assert.notEqual(
      committedIndex,
      freshIndex,
      "the committed index should be STALE — it still reflects the baseline MASTER-PLAN.md, not the edit that just landed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyPlanProposalCommit: a regeneration failure is logged and non-fatal — the commit still lands (design (iii))", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-architect-lane-master-plan-commit-noscript-"));
  try {
    // No scripts/ directory at all — regeneratePlanIndexFile's execFileSync will ENOENT.
    mkdirSync(join(dir, "plan"), { recursive: true });
    writeFileSync(join(dir, "MASTER-PLAN.md"), BASELINE_MASTER_PLAN, "utf8");
    git(dir, ["init", "--quiet", "-b", "main"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "--quiet", "-m", "base"]);

    writeFileSync(join(dir, "MASTER-PLAN.md"), EDITED_MASTER_PLAN, "utf8");
    writeFileSync(join(dir, "plan", "tasks.yaml"), EDITED_PLAN_TASKS_YAML, "utf8");
    const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    applyPlanProposalCommit(dir, "chore(plan): amend without a generator present", (step, extra) =>
      logged.push({ step, extra }),
    );

    assert.equal(git(dir, ["show", "HEAD:MASTER-PLAN.md"]), EDITED_MASTER_PLAN);
    assert.ok(
      logged.some((l) => l.step === "plan_index.regen.error"),
      "a missing generator must be logged under the SAME key the existing approve/retro call sites use, never thrown",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
