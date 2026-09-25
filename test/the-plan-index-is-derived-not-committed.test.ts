// @source-text-subject: this suite pins the migration's call-site wiring and absence of retired writer paths; loadPlanIndex behavior is exercised separately.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyPlanProposalCommit } from "../src/lib/plan-architect.js";
import { ENFORCEMENT_DATA_EXCLUSIONS, INSTRUMENT_SURFACE_EXCLUSIONS } from "../src/lib/review.js";
import { loadPlanIndex } from "../src/lib/plan-index.js";
import { REGENERABLE_ARTIFACT_GENERATORS } from "../src/lib/sweep.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_INDEX_PATH = "plan/plan-index.json";

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function seedPlanRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-index-no-writer-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "MASTER-PLAN.md"), "# Plan\n\n## Before\n\nOriginal summary.\n");
  writeFileSync(join(root, "plan", "tasks.yaml"), "tasks: []\n");
  git(root, ["init", "--quiet", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Plan Index Test"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "seed plan"]);
  return root;
}

test("W1-T4432: readers derive and cache the plan index from MASTER-PLAN.md with the shared parser", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-index-reader-"));
  try {
    mkdirSync(join(root, "plan"));
    const source = join(root, "MASTER-PLAN.md");
    const artifact = join(root, PLAN_INDEX_PATH);
    const contents = "# Plan\n\n## 5C. Current section\n\n**Derived** summary.\n\n### Nested\n\n## Next\n";
    writeFileSync(source, contents);
    assert.equal(existsSync(artifact), false, "the source fixture has no JSON index");

    const first = loadPlanIndex(source);
    const canonicalPath = join(root, "canonical-plan-index.json");
    const generated = spawnSync(process.execPath, [join(ROOT, "scripts", "generate-plan-index.mjs"), "--source", source, "--out", canonicalPath], { cwd: ROOT, encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    assert.deepEqual(first?.entries, JSON.parse(readFileSync(canonicalPath, "utf8")).entries, "runtime output matches the canonical generator parser");
    assert.strictEqual(loadPlanIndex(source), first, "unchanged content reuses the cached projection");

    const indexModule = readFileSync(join(ROOT, "src", "lib", "plan-index.ts"), "utf8");
    assert.ok(
      indexModule.includes('import { parsePlanIndex as parsePlanIndexFromGenerator } from "../../scripts/generate-plan-index.mjs";'),
      "runtime imports the canonical generator parser",
    );

    writeFileSync(source, contents.replace("Current section", "Updated section"));
    const updated = loadPlanIndex(source);
    assert.notStrictEqual(updated, first, "a changed source hash invalidates the cached projection");
    assert.equal(updated?.entries[0]?.heading, "5C. Updated section");
    assert.equal(existsSync(artifact), false, "reading does not materialize the generated artifact");

    const runTask = readFileSync(join(ROOT, "src", "run-task.ts"), "utf8");
    const panelGraph = readFileSync(join(ROOT, "src", "lib", "panel-graph.ts"), "utf8");
    assert.match(runTask, /loadPlanIndex\(join\(dirname\(planPath\), "\.\.", "MASTER-PLAN\.md"\)\)/);
    assert.match(panelGraph, /loadPlanIndex\(resolveRepoLayout\(deps\.root\)\.masterPlan\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4432: plan commit flows and capability snapshot do not write a committed plan index", () => {
  const root = seedPlanRepo();
  const capabilityRoot = mkdtempSync(join(tmpdir(), "rmd-plan-index-capability-"));
  try {
    writeFileSync(join(root, "MASTER-PLAN.md"), "# Plan\n\n## After\n\nUpdated summary.\n");
    applyPlanProposalCommit(root, "chore(plan): update master plan");
    const committedFiles = git(root, ["show", "--pretty=format:", "--name-only", "HEAD"]);
    assert.match(committedFiles, /MASTER-PLAN\.md/);
    assert.doesNotMatch(committedFiles, /plan\/plan-index\.json/);
    assert.equal(existsSync(join(root, PLAN_INDEX_PATH)), false);

    writeFileSync(join(capabilityRoot, "MASTER-PLAN.md"), readFileSync(join(ROOT, "MASTER-PLAN.md"), "utf8"));
    const capability = spawnSync(
      process.execPath,
      ["--import", "tsx", join(ROOT, "scripts", "generate-capability-snapshot.mjs"), "--master-plan", join(capabilityRoot, "MASTER-PLAN.md")],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(capability.status, 0, capability.stdout + capability.stderr);
    assert.equal(existsSync(join(capabilityRoot, PLAN_INDEX_PATH)), false, "capability snapshot writes only MASTER-PLAN.md");

    for (const path of ["src/run-task.ts", "src/lib/plan-architect.ts", "src/lib/plan-pr-emitter.ts"]) {
      assert.doesNotMatch(readFileSync(join(ROOT, path), "utf8"), /regeneratePlanIndex(?:File|AndCommit)/, `${path} has no retired writer call`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(capabilityRoot, { recursive: true, force: true });
  }
});

test("W1-T4432: the console receives a generated plan-index artifact from CI", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-index-artifact-"));
  try {
    mkdirSync(join(root, "plan"));
    const source = "# Plan\n\n## 5C. Console section\n\nArtifact summary.\n";
    writeFileSync(join(root, "MASTER-PLAN.md"), source);
    const generated = spawnSync(
      process.execPath,
      [join(ROOT, "scripts", "generate-plan-index.mjs"), "--out", PLAN_INDEX_PATH],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    const artifact = JSON.parse(readFileSync(join(root, PLAN_INDEX_PATH), "utf8")) as {
      source: string;
      entries: Array<{ heading: string; line: number; summary: string }>;
    };
    assert.equal(artifact.source, "MASTER-PLAN.md");
    assert.deepEqual(artifact.entries, [{ heading: "5C. Console section", line: 3, summary: "Artifact summary." }]);

    const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    assert.match(workflow, /Generate the console plan-index artifact \(W1-T4432\)[\s\S]*?node scripts\/generate-plan-index\.mjs --out plan\/plan-index\.json/);
    assert.match(workflow, /Upload the console plan-index artifact \(W1-T4432\)[\s\S]*?name: plan-index-console[\s\S]*?path: plan\/plan-index\.json[\s\S]*?if-no-files-found: error/);
    assert.equal(existsSync(join(ROOT, PLAN_INDEX_PATH)), false, "the artifact is not committed in the source checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4432: no plan-index path registry or gate requires a committed index", () => {
  const packageScripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
  assert.equal(Object.hasOwn(packageScripts, "plan-index"), false);
  assert.equal(Object.hasOwn(packageScripts, "plan-index:check"), false);
  assert.equal(Object.hasOwn(INSTRUMENT_SURFACE_EXCLUSIONS, PLAN_INDEX_PATH), false);
  assert.equal(Object.hasOwn(ENFORCEMENT_DATA_EXCLUSIONS, PLAN_INDEX_PATH), false);
  assert.equal(Object.hasOwn(REGENERABLE_ARTIFACT_GENERATORS, PLAN_INDEX_PATH), false);

  for (const path of ["scripts/ci-control-plane-precheck.mjs", "scripts/unwired-gate-check.mjs"]) {
    assert.doesNotMatch(readFileSync(join(ROOT, path), "utf8"), /plan-index:check|plan\/plan-index\.json/, `${path} has no committed-index gate registration`);
  }
});
