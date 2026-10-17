// @source-text-subject: src/lib/affected-suites.ts — its suite-path literals must name real tests.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { selectAffectedSuites } from "../src/lib/affected-suites.js";
import { resolveTestPath } from "../src/lib/test-path-resolver.js";
import { withTempDir } from "../src/lib/tmp.js";

const { planReadingSuiteFiles, planOnlySuiteFiles, censusSuiteFiles } = await import(
  new URL("../scripts/diff-class.mjs", import.meta.url).href
) as {
  planReadingSuiteFiles: (root: string, changed?: string[]) => string[];
  planOnlySuiteFiles: (root: string, changed?: string[]) => string[];
  censusSuiteFiles: (changed: string[], root: string) => string[];
};
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

test("W1-T9869: a nested suite that reads plan paths is selected for a plan-only diff", async () => {
  await withTempDir("nested-plan-suites", (root) => {
    const content = 'readFileSync("plan/policy.yaml");';
    write(root, "test/z/deep/reader.test.ts", content);
    write(root, "test/a.test.ts", content);
    write(root, "test/fixtures/ignored.test.ts", content);
    write(root, "test/z/helper.ts", content);
    symlinkSync(join(root, "test"), join(root, "test/z/cycle"), "dir");
    const expected = ["test/a.test.ts", "test/z/deep/reader.test.ts"];
    assert.deepEqual(planReadingSuiteFiles(root, ["plan/policy.yaml"]), expected);
    assert.deepEqual(planReadingSuiteFiles(root), expected);
    assert.deepEqual(planOnlySuiteFiles(root, ["plan/policy.yaml"]), expected);
    write(root, "test/z/deep/docs.test.ts", 'readFileSync("docs/guide.md");');
    assert.deepEqual(planReadingSuiteFiles(root, ["docs/guide.md"]), ["test/z/deep/docs.test.ts"]);
  });
});

test("W1-T9869: a nested census suite is selected by censusSuiteFiles", async () => {
  await withTempDir("nested-census-suites", (root) => {
    const walker = 'readdirSync(join(root, "src"));';
    write(root, "test/a/deep/census.test.ts", walker);
    write(root, "test/fixtures/census.test.ts", walker);
    write(root, "test/a/helper.ts", walker);
    write(root, "scripts/walker.mjs", walker);
    write(root, "test/a/deep/imported.test.ts", 'import { scan } from "../../../scripts/walker.mjs";');
    write(root, "test/a/deep/reader.test.ts", 'readFileSync("src/lib/changed.ts");');
    assert.deepEqual(censusSuiteFiles(["src/lib/changed.ts"], root), [
      "test/a/deep/census.test.ts", "test/a/deep/imported.test.ts", "test/a/deep/reader.test.ts",
    ]);
    assert.deepEqual(censusSuiteFiles(["src/lib/changed.ts", "test/a/deep/census.test.ts"], root), [
      "test/a/deep/imported.test.ts", "test/a/deep/reader.test.ts",
    ]);
  });
});

test("W1-T9869: a moved edge-path suite is still selected by affected-suites", () => {
  const census = "test/census/nested/mkdtemp-allowlist-rekey.test.ts";
  const sender = "test/census/every-message-names-one-declared-sender.test.ts";
  const verdict = "test/sweep/a-verdict-is-reused-when-nothing-it-judged-changed.test.ts";
  const claims = "test/plan/claims-check.test.ts";
  const movedEdge = "test/plan/one-bad-plan-shard-never-takes-the-daemon-down.test.ts";
  const files = new Map([census, sender, verdict, claims, movedEdge].map((path) => [path, "export {};"]));
  const source = selectAffectedSuites(["src/lib/sweep.ts"], { files, pathReaders: [], symbolSuites: [] });
  assert.equal(source.fullRun, false);
  for (const suite of [census, sender, verdict]) {
    assert.ok(source.suites.includes(suite), `floor selects ${suite}`);
    assert.ok(source.narrow?.includes(suite), `narrow selects ${suite}`);
  }
  const edge = selectAffectedSuites([movedEdge], { files, pathReaders: [] });
  assert.deepEqual(edge.suites, [census, movedEdge, claims].sort());
  assert.deepEqual(selectAffectedSuites(["src/unrelated.ts"], {
    files: new Map([[verdict, "export {};"]]), pathReaders: [],
  }).suites, []);
  assert.deepEqual(selectAffectedSuites(["src/unrelated.ts"], {
    files: new Map([["test/fixtures/mkdtemp-allowlist-rekey.test.ts", ""]]), pathReaders: [],
  }).suites, []);
  const ambiguous = new Map([
    ["test/one/mkdtemp-allowlist-rekey.test.ts", ""],
    ["test/two/mkdtemp-allowlist-rekey.test.ts", ""],
    ["test/fixtures/mkdtemp-allowlist-rekey.test.ts", ""],
  ]);
  assert.deepEqual(selectAffectedSuites(["src/unrelated.ts"], { files: ambiguous, pathReaders: [] }).suites, []);
  ambiguous.set("test/mkdtemp-allowlist-rekey.test.ts", "");
  assert.deepEqual(selectAffectedSuites(["src/unrelated.ts"], { files: ambiguous, pathReaders: [] }).suites,
    ["test/mkdtemp-allowlist-rekey.test.ts"]);
});

test("W1-T9869: every hard-coded suite path in affected-suites resolves at head", () => {
  const source = readFileSync(join(ROOT, "src/lib/affected-suites.ts"), "utf8");
  const paths = [...new Set([...source.matchAll(/"(test\/[^"\n]+\.test\.ts)"/g)].map((match) => match[1]!))];
  assert.ok(paths.length >= 31, "the inventory includes both destination suites and test trigger edges");
  for (const path of paths) {
    const resolved = resolveTestPath(path, { root: ROOT });
    assert.ok("path" in resolved, `${path}: ${JSON.stringify(resolved)}`);
  }
  const seams = [...source.matchAll(/"((?:src|scripts)\/[^"\n]+\.(?:ts|json))"/g)].map((match) => match[1]!);
  const flat = new Map(paths.map((path) => [path, "export {};"]));
  const movedPath = (path: string) => `test/moved/${posix.basename(path)}`;
  const moved = new Map(paths.map((path) => [movedPath(path), "export {};"]));
  const before = selectAffectedSuites(seams, { files: flat, pathReaders: [], symbolSuites: [] });
  assert.ok(before.suites.length >= 19, "positive control reaches every explicit suite rule");
  const after = selectAffectedSuites(seams, { files: moved, pathReaders: [], symbolSuites: [] });
  assert.deepEqual(after.suites, before.suites.map(movedPath).sort());
  assert.deepEqual(after.narrow, before.narrow?.map(movedPath).sort());
});
