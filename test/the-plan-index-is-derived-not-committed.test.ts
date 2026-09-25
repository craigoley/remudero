import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadPlanIndex } from "../src/lib/plan-index.js";
import { applyPlanProposalCommit } from "../src/lib/plan-architect.js";

test("W1-T4432: the plan index is built from plan/ at read time", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-derived-plan-index-"));
  try {
    mkdirSync(join(root, "plan"));
    const path = join(root, "plan", "plan-index.json");
    const source = join(root, "MASTER-PLAN.md");
    writeFileSync(source, "# Plan\n\n## First\n\nFirst summary.\n");
    assert.equal(existsSync(path), false);
    const first = loadPlanIndex(path);
    assert.deepEqual(first?.entries, [{ heading: "First", line: 3, summary: "First summary." }]);
    assert.strictEqual(loadPlanIndex(path), first, "unchanged source content reuses the cached index");
    writeFileSync(source, "# Plan\n\n## Second\n\nSecond summary.\n");
    const second = loadPlanIndex(path);
    assert.notStrictEqual(second, first, "changed source content invalidates the cache");
    assert.deepEqual(second?.entries, [{ heading: "Second", line: 3, summary: "Second summary." }]);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4432: no pull request regenerates the plan index", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-pr-without-index-"));
  try {
    mkdirSync(join(root, "plan"));
    mkdirSync(join(root, "scripts"));
    const sourceScripts = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
    copyFileSync(join(sourceScripts, "generate-plan-index.mjs"), join(root, "scripts", "generate-plan-index.mjs"));
    cpSync(join(sourceScripts, "lib"), join(root, "scripts", "lib"), { recursive: true });
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.name", "Plan Index Test"]);
    execFileSync("git", ["-C", root, "config", "user.email", "plan-index@example.invalid"]);
    writeFileSync(join(root, "MASTER-PLAN.md"), "# Plan\n\n## Current\n\nCurrent summary.\n");
    writeFileSync(join(root, "plan", "tasks.yaml"), "tasks: []\n");
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
    writeFileSync(join(root, "MASTER-PLAN.md"), "# Plan\n\n## Changed\n\nChanged summary.\n");
    applyPlanProposalCommit(root, "chore(plan): update master plan");
    const files = execFileSync("git", ["-C", root, "show", "--pretty=format:", "--name-only", "HEAD"], { encoding: "utf8" });
    assert.match(files, /MASTER-PLAN\.md/);
    assert.doesNotMatch(files, /plan-index\.json/);
    assert.equal(existsSync(join(root, "plan", "plan-index.json")), false);
    assert.equal(readFileSync(join(root, "MASTER-PLAN.md"), "utf8").includes("## Changed"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
