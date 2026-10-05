import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { withTempDir } from "../src/lib/tmp.js";

const SCRIPT = new URL("../scripts/diff-class.mjs", import.meta.url);
const { planReadingSuiteFiles, censusSuiteFiles, REPO_ROOT } = await import(SCRIPT.href) as {
  planReadingSuiteFiles: (root?: string, changed?: string[]) => string[];
  censusSuiteFiles: (changed: string[], root?: string) => string[];
  REPO_ROOT: string;
};
const SHARD = "plan/tasks.d/W1-T5698-a-plan-only-diff-runs-the-suites-that-read-its-paths.yaml";

async function fixture(run: (root: string) => void): Promise<void> {
  await withTempDir("plan-path-suites", (root) => {
    mkdirSync(join(root, "test"));
    const suites: Record<string, string> = {
      policy: 'readFileSync("plan/policy.yaml");',
      "joined-policy": 'readFileSync(join(REPO_ROOT, "plan", "policy.yaml"));',
      shard: `readFileSync("${SHARD}");`,
      id: 'assert.ok(plan.byId.has("W1-T5698"));',
      "other-id": 'assert.ok(plan.byId.has("W1-T56980"));',
      directory: 'readFileSync("plan/tasks.d/");',
      "joined-directory": 'readdirSync(join(REPO_ROOT, "plan", "tasks.d"));',
      "dynamic-directory": 'readFileSync(join(REPO_ROOT, "plan", "tasks.d", name));',
      "template-directory": 'readFileSync(`plan/tasks.d/${name}`);',
      loader: 'loadPlan(join(REPO_ROOT, "plan", "tasks.yaml"));',
      "url-loader": 'loadPlan(fileURLToPath(new URL("../plan/tasks.yaml", import.meta.url)));',
      feedback: 'readFileSync("plan/feedback/item.yaml");',
      docs: 'readFileSync("docs/guide.md");',
      "joined-docs": 'readFileSync(join(REPO_ROOT, "docs", "guide.md"));',
      master: 'readFileSync("MASTER-PLAN.md");',
      census: 'const area = "plan/"; readdirSync(root);',
      source: 'readFileSync("src/lib/policy.ts");',
      "near-prefix": 'readFileSync("plan/tasks.different");',
    };
    for (const [name, content] of Object.entries(suites)) {
      writeFileSync(join(root, "test", `${name}.test.ts`), content);
    }
    run(root);
  });
}

test("test/a-plan-only-diff-runs-the-suites-that-read-its-paths.test.ts", async () => {
  await fixture((root) => {
    const shard = planReadingSuiteFiles(root, [SHARD]);
    assert.ok(!shard.includes("test/policy.test.ts"), "a shard edit must exclude a policy-only reader");
    assert.ok(!shard.includes("test/joined-policy.test.ts"));
    for (const name of ["shard", "id", "directory", "joined-directory", "dynamic-directory",
      "template-directory", "loader", "url-loader", "census"]) {
      assert.ok(shard.includes(`test/${name}.test.ts`), `${name} must run for a shard edit`);
    }
    for (const name of ["other-id", "feedback", "docs", "joined-docs", "master", "source", "near-prefix"]) {
      assert.ok(!shard.includes(`test/${name}.test.ts`), `${name} does not read the changed shard`);
    }
    const policy = planReadingSuiteFiles(root, ["plan/policy.yaml"]);
    assert.ok(policy.includes("test/policy.test.ts"));
    assert.ok(policy.includes("test/joined-policy.test.ts"));
    assert.ok(!policy.includes("test/id.test.ts"));
    for (const suite of censusSuiteFiles([SHARD], root)) assert.ok(shard.includes(suite));
  });
  const real = planReadingSuiteFiles(REPO_ROOT, [SHARD]);
  for (const name of ["every-shard-on-main-is-lintable", "credited-proof-visibility-seam-defaults",
    "learnings-injection-w1t6", "merged-claim-audit", "mounts-wiring", "retro", "task-linter"]) {
    assert.ok(real.includes(`test/${name}.test.ts`), `${name} is a documented plan-reader regression floor`);
  }
});

test("changed docs, feedback and master paths select their readers with directory boundaries", async () => {
  await fixture((root) => {
    for (const [path, names] of [
      ["docs/guide.md", ["docs", "joined-docs"]],
      ["plan/feedback/item.yaml", ["feedback"]],
      ["MASTER-PLAN.md", ["master"]],
    ] as const) {
      const selected = planReadingSuiteFiles(root, [path]);
      for (const name of names) assert.ok(selected.includes(`test/${name}.test.ts`));
      assert.ok(!selected.includes("test/policy.test.ts"));
    }
    assert.ok(!planReadingSuiteFiles(root, ["plan/policy.yaml.bak"]).includes("test/policy.test.ts"));
    assert.ok(!planReadingSuiteFiles(root, ["plan/tasks.different/a.yaml"]).includes("test/directory.test.ts"));
    const mixed = planReadingSuiteFiles(root, [SHARD, "docs/guide.md"]);
    assert.ok(mixed.includes("test/id.test.ts") && mixed.includes("test/docs.test.ts"));
    assert.ok(planReadingSuiteFiles(root).includes("test/policy.test.ts"), "no changed list preserves the broad fallback");
  });
});

test("the CLI prints scoped and previous counts without contaminating its suite list", async () => {
  await fixture((root) => {
    const list = join(root, "changed.txt");
    writeFileSync(list, SHARD + "\n");
    const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT.pathname,
      "--list-plan-reading-suites", "--plan-reading-root", root, "--changed-files", list],
    { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const selected = planReadingSuiteFiles(root, [SHARD]);
    assert.deepEqual(result.stdout.trim().split("\n"), selected);
    assert.match(result.stderr, new RegExp(`selected_count=${selected.length} previous_count=${planReadingSuiteFiles(root).length}`));
  });
});
