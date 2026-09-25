import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPlanProposalCommit } from "../src/lib/plan-architect.js";
import { loadPlanIndex } from "../src/lib/plan-index.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-derived-plan-index-"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  writeFileSync(join(dir, "MASTER-PLAN.md"), "# MASTER-PLAN\n\n## Before\n\nOriginal summary.\n");
  writeFileSync(join(dir, "plan", "tasks.yaml"), "tasks: []\n");
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "base"]);
  return dir;
}

test("W1-T4432: an Architect commit carries the plan edit without generating a JSON index", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "MASTER-PLAN.md"), "# MASTER-PLAN\n\n## After\n\nUpdated summary.\n");
    applyPlanProposalCommit(dir, "chore(plan): update master plan");

    const changed = git(dir, ["diff", "--name-only", "HEAD~1", "HEAD"]).trim().split("\n");
    assert.ok(changed.includes("MASTER-PLAN.md"));
    assert.ok(!changed.includes("plan/plan-index.json"));
    assert.equal(existsSync(join(dir, "plan", "plan-index.json")), false);
    assert.deepEqual(loadPlanIndex(join(dir, "MASTER-PLAN.md"))?.entries, [
      { heading: "After", line: 3, summary: "Updated summary." },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4432 falsifier: staging only plan/ leaves the MASTER-PLAN edit out of the commit", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "MASTER-PLAN.md"), "# MASTER-PLAN\n\n## After\n\nUpdated summary.\n");
    writeFileSync(join(dir, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T1\n    status: proposed\n");
    git(dir, ["add", "-A", "--", "plan/"]);
    git(dir, ["commit", "--quiet", "-m", "old-style plan-only commit"]);
    const changed = git(dir, ["diff", "--name-only", "HEAD~1", "HEAD"]);
    assert.doesNotMatch(changed, /MASTER-PLAN\.md/);
    assert.equal(git(dir, ["status", "--short"]).trim(), "M MASTER-PLAN.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
