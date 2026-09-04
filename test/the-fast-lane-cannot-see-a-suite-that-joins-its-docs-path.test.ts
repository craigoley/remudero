import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "diff-class.mjs");

const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  namesPlanOrDocsPath: (content: string) => boolean;
  planReadingSuiteFiles: (root?: string) => string[];
};

const { namesPlanOrDocsPath, planReadingSuiteFiles } = mod;

const MEASURED_DOC_JOIN_SUITES = [
  "test/claude-md-rules-reach-their-scope.test.ts",
  "test/cli-reference.test.ts",
  "test/container-config-mount.test.ts",
  "test/declared-files-correction-exit.test.ts",
  "test/github-event-sweep-wake.test.ts",
  "test/operator-message-standard.test.ts",
  "test/orientation.test.ts",
  "test/reap-cadence.test.ts",
];

const JOINED_ONLY_SUITES = MEASURED_DOC_JOIN_SUITES.filter((file) => {
  const source = readFileSync(join(REPO_ROOT, file), "utf8");
  return !literalOnlyNamesPlanOrDocsPath(source);
});

function literalOnlyNamesPlanOrDocsPath(content: string): boolean {
  return /["'`](?:\.\.\/)*(?:plan\/|docs\/)/.test(content) || /MASTER-PLAN\.md/.test(content);
}

function literalOnlyPlanReadingSuiteFiles(root: string): string[] {
  const testDir = join(root, "test");
  const out: string[] = [];
  for (const entry of readdirSync(testDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
    const abs = join(testDir, entry.name);
    if (literalOnlyNamesPlanOrDocsPath(readFileSync(abs, "utf8"))) {
      out.push(relative(root, abs).split(sep).join("/"));
    }
  }
  return out.sort();
}

test("W1-T2667: a suite that joins REPO_ROOT with docs/plan segments names a plan-or-docs path", () => {
  assert.equal(namesPlanOrDocsPath('readFileSync(join(REPO_ROOT, "docs", "operator-guide.md"));'), true);
  assert.equal(namesPlanOrDocsPath("readFileSync(join(REPO_ROOT, 'plan', 'tasks.yaml'));"), true);
});

test("W1-T2667: the eight measured docs-reading suites are all in the fast-lane enumeration", () => {
  const suites = planReadingSuiteFiles();
  for (const file of MEASURED_DOC_JOIN_SUITES) {
    assert.ok(suites.includes(file), `${file} must be enumerated when docs/ changes can fail it`);
  }
});

test("W1-T2667: a pure-source suite with no repo-root plan/docs join is still not enumerated", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t2667-"));
  try {
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "source-only.test.ts"), 'const p = join(sourceRoot, "docs", "fixture.md");\n');
    writeFileSync(join(root, "test", "repo-docs.test.ts"), 'const p = join(REPO_ROOT, "docs", "operator-guide.md");\n');

    assert.deepEqual(planReadingSuiteFiles(root), ["test/repo-docs.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2667: restoring the literal-only predicate drops the joined-only measured suites", () => {
  assert.ok(JOINED_ONLY_SUITES.length > 0, "the falsifier needs at least one joined-only measured suite");

  const widened = planReadingSuiteFiles();
  const literalOnly = literalOnlyPlanReadingSuiteFiles(REPO_ROOT);

  for (const file of JOINED_ONLY_SUITES) {
    assert.ok(widened.includes(file), `${file} must be present with the widened predicate`);
    assert.ok(!literalOnly.includes(file), `${file} must be absent with the literal-only predicate`);
  }
});
