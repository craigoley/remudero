import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitCiFrictionOwnerSearch } from "../src/lib/ci-friction-gardener.js";
import { locateCiFrictionOwner } from "../src/lib/ci-friction-remedy.js";
import { gitRepo } from "./helpers/git-repo.js";

const TEST = "test/memory-tracker.test.ts";
const SOURCE = "src/lib/dispatch-governor.ts";
const WORKFLOW = ".github/workflows/ci.yml";

function fixture(t: TestContext) {
  const repo = gitRepo({ kind: "ci-friction-test-owner" });
  t.after(() => repo.cleanup());
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    writeFileSync(join(repo.dir, file), text);
  };
  const commit = () => {
    repo.git("add", ".");
    repo.git("commit", "-qm", "fixture");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  };
  put(WORKFLOW, "jobs:\n  tests:\n    name: test\n  coverage:\n    name: coverage-shard\n");
  put(TEST, 'import { missing } from "../src/absent.js";\nimport { govern } from "../src/lib/dispatch-governor.js";\n');
  put(SOURCE, "export const govern = () => true;\n");
  commit();
  const search = () => gitCiFrictionOwnerSearch(args => repo.git(...args));
  return { repo, put, commit, search };
}

test("W1-T9059: a shard failure naming a test file is owned by the source module that test imports", t => {
  const f = fixture(t);
  for (const [key, details] of [
    [`check:test:${TEST}`, []],
    ["check:ci-log:coverage-shard:test-memory-tracker-test-ts", [`coverage-shard (1/8): ${TEST}`]],
  ] as const) {
    const owner = locateCiFrictionOwner(key, details, f.search());
    assert.deepEqual(owner?.files, [SOURCE, TEST]);
    assert.equal(owner?.failingTest, TEST);
    assert.match(owner!.why[0]!, /imports/);
  }
});

test("the Git-backed friction owner resolves source and script package aliases before declaring no owner", t => {
  const f = fixture(t);
  f.put("scripts/remedy.mjs", "export const remedy = true;\n");
  for (const [source, expected] of [
    ['import { govern } from "#src/lib/dispatch-governor.js";\n', SOURCE],
    ['const remedy = await import("#scripts/remedy.mjs");\n', "scripts/remedy.mjs"],
    ['import "#src/absent.js";\nimport "#src/lib/dispatch-governor.js";\n', SOURCE],
  ] as const) {
    f.put(TEST, source);
    f.commit();
    assert.deepEqual(locateCiFrictionOwner(`check:test:${TEST}`, [], f.search())?.files, [expected, TEST]);
  }
  f.put("test/helper.ts", "export {};\n");
  f.put(TEST, 'import "#test/helper.js";\nimport "#src/absent.js";\n');
  f.commit();
  assert.deepEqual(locateCiFrictionOwner(`check:test:${TEST}`, [], f.search())?.files, [TEST]);
});

test("W1-T9059: a timeout signature is owned by the workflow, never by the gardener vocabulary", t => {
  const f = fixture(t);
  const signatures = [
    "timed out with no test result", "timed out after a passing summary", `timed out during ${TEST}`,
    "red with no failing test", "pool defect: leak not isolated to one file",
    `pool defect: ${TEST} leaks into test/other.test.ts`,
    `pool failure: ${TEST} fails pooled, passes isolated`,
    "COVERAGE-REPORT-FAILED: no coverage files found", "Unable to download artifact coverage-1",
  ];
  f.put("src/lib/ci-friction-gardener.ts", JSON.stringify(signatures));
  f.put("src/product.ts", JSON.stringify(signatures));
  f.commit();
  for (const signature of signatures) {
    const owner = locateCiFrictionOwner("check:ci-log:coverage-shard:infrastructure", [`coverage-shard: ${signature}`], f.search());
    assert.deepEqual(owner?.files, [WORKFLOW], signature);
  }
  f.put(WORKFLOW, "jobs:\n  unrelated:\n    runs-on: ubuntu-latest\n");
  f.commit();
  assert.equal(locateCiFrictionOwner("check:ci-log:coverage-shard:infrastructure", ["coverage-shard: pool defect: leak not isolated to one file"], f.search()), undefined);
});

test("W1-T9059: a test without a resolving source import owns its failure alone", t => {
  const f = fixture(t);
  for (const text of ["export {};\n", 'import "./helper.js";\nimport "../src/absent.js";\n']) {
    f.put(TEST, text);
    f.put("test/helper.ts", "export {};\n");
    f.commit();
    assert.deepEqual(locateCiFrictionOwner(`check:test:${TEST}`, [], f.search())?.files, [TEST]);
  }
  assert.deepEqual(locateCiFrictionOwner("check:test:test/missing.test.ts", [], f.search())?.files, [WORKFLOW]);
});

test("W1-T9059: test ownership takes the first existing source or script import", t => {
  const f = fixture(t);
  f.put(TEST, 'import "../scripts/absent.js";\nimport "../scripts/remedy.js";\nimport "../src/lib/dispatch-governor.js";\n');
  f.put("scripts/remedy.ts", "export {};\n");
  f.commit();
  assert.deepEqual(locateCiFrictionOwner(`check:test:${TEST}`, [], f.search())?.files, ["scripts/remedy.ts", TEST]);
});

test("W1-T9059: signature searches exclude every ci-friction module and retain product owners", t => {
  const f = fixture(t);
  const signature = "distinctive refusal surface";
  for (const name of ["gardener", "remedy", "other"]) f.put(`src/lib/ci-friction-${name}.ts`, JSON.stringify(signature));
  f.put("src/product.ts", JSON.stringify(signature));
  f.put("scripts/remedy.ts", JSON.stringify(signature));
  f.commit();
  const search = f.search();
  assert.deepEqual(search.filesContaining(signature).map(hit => hit.file).sort(), ["scripts/remedy.ts", "src/product.ts"]);
  assert.deepEqual(locateCiFrictionOwner("check:ci-log:coverage-shard:refusal", [`coverage-shard: ${signature}`], search)?.files,
    ["scripts/remedy.ts", "src/product.ts"]);
});

test("W1-T9059: test source reads stay pinned when fetched main and the worktree change", t => {
  const f = fixture(t);
  const search = f.search();
  assert.ok(search.readSource);
  const original = search.readSource(TEST);
  assert.match(original!, /dispatch-governor/);
  f.put(TEST, 'import "../src/replaced.js";\n');
  f.put("src/replaced.ts", "export {};\n");
  f.commit();
  f.put(TEST, "uncommitted worktree content\n");
  assert.equal(search.readSource(TEST), original);
  assert.deepEqual(locateCiFrictionOwner(`check:test:${TEST}`, [], search)?.files, [SOURCE, TEST]);
  assert.deepEqual(locateCiFrictionOwner(`check:test:${TEST}`, [], f.search())?.files, ["src/replaced.ts", TEST]);
  assert.throws(() => search.readSource!("test/missing.test.ts"), /does not exist/);
});

test("W1-T9059: unreadable test source refuses ownership rather than assigning the workflow", t => {
  const f = fixture(t);
  const search = f.search();
  const failing = { ...search, readSource: () => { throw new Error("test blob unreadable"); } };
  assert.throws(() => locateCiFrictionOwner(`check:test:${TEST}`, [], failing), /test blob unreadable/);
});

test("W1-T9059: an artifact test filename remains a test signature", t => {
  const f = fixture(t);
  const file = "test/artifact.test.ts";
  f.put(file, 'import "../src/lib/dispatch-governor.js";\n');
  f.commit();
  assert.deepEqual(locateCiFrictionOwner("check:ci-log:coverage-shard:test-artifact-test-ts", [`coverage-shard: ${file}`], f.search())?.files,
    [SOURCE, file]);
});


test("a runtime test failure never assigns its remedy to a type-only or quoted import", t => {
  const f = fixture(t);
  f.put("src/lib/config.ts", "export interface Config { value: string }\n");
  for (const inert of [
    'import type { Config } from "#src/lib/config.js";',
    'import { type Config } from "#src/lib/config.js";',
    '// import { config } from "#src/lib/config.js";',
    `const example = 'import { config } from "#src/lib/config.js";';`,
  ]) {
    f.put(TEST, inert + '\nimport { govern } from "#src/lib/dispatch-governor.js";\n');
    f.commit();
    assert.deepEqual(locateCiFrictionOwner(`check:test:${TEST}`, [], f.search())?.files, [SOURCE, TEST], inert);
  }
  f.put(TEST, 'import type { Config } from "#src/lib/config.js";\n');
  f.commit();
  assert.deepEqual(locateCiFrictionOwner(`check:test:${TEST}`, [], f.search())?.files, [TEST]);
  f.put(TEST, 'import type { Config } from "#src/lib/config.js";\nimport "#src/lib/config.js";\n');
  f.commit();
  assert.deepEqual(locateCiFrictionOwner(`check:test:${TEST}`, [], f.search())?.files, ["src/lib/config.ts", TEST], "a separate real side-effect import still supplies an owner candidate");
});
