import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as parity from "#src/lib/ci-parity.js";
import { newShardRuleSuiteViolations } from "#src/lib/task-linter.js";
import { resolveTestPath } from "#src/lib/test-path-resolver.js";
import type { Task } from "#src/lib/plan.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { censusSuiteFiles } = await import(pathToFileURL(join(root, "scripts/diff-class.mjs")).href);

function fixture(t: TestContext, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-rule-declaration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function listed(t: TestContext, files: Record<string, string>): string[] {
  const filler = Object.fromEntries(Array.from({ length: parity.MIN_RULE_SUITE_COUNT }, (_, i) => [`test/filler-${i}-ratchet.test.ts`, ""]));
  const tracked = { ...filler, ...files };
  const dir = fixture(t, tracked);
  t.mock.method(childProcess, "spawnSync", (file: string, args: string[]) => {
    assert.equal(file, "git");
    assert.deepEqual(args, [["ls", "files"].join("-"), "--", "test"]);
    return { status: 0, stdout: Object.keys(tracked).join("\n"), stderr: "" };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return parity.listRuleSuites(dir).filter((path) => !(path in filler));
}

function violations(path: string, rationale = "") {
  return newShardRuleSuiteViolations({
    id: "W1-T9999", files: [path], rationale, acceptance: [],
  } as unknown as Task, { riskTransition: { baseTask: undefined } });
}

test("W1-T9877: a suite under test/rules is a rule suite whatever its name", (t) => {
  const path = "test/rules/nested/x.test.ts";
  assert.deepEqual(listed(t, { [path]: "// @not-a-rule-suite: fixture\n" }), [path]);
  assert.equal(violations(path).length, 1);
  assert.equal(violations(path, "@not-a-rule-suite: fixture").length, 1);
});

test("W1-T9877: a folder named like a rule suite enrols nothing", (t) => {
  const path = "test/ci/census-y/z.test.ts";
  assert.deepEqual(listed(t, { [path]: "" }), []);
  assert.deepEqual(violations(path), []);
});

test("W1-T9877: a legacy basename match keeps its enrolment in any folder", (t) => {
  const paths = ["test/ci/gates/x-census.test.ts", "test/other/y-RATCHET.test.ts", "test/unit/z-baseline.test.ts"];
  assert.deepEqual(listed(t, Object.fromEntries(paths.map((path) => [path, ""]))), paths.sort());
  for (const path of paths) {
    assert.equal(violations(path).length, 1);
    assert.deepEqual(violations(path, "@not-a-rule-suite: a unit fixture"), []);
  }
});

test("W1-T9877: a nested rule suite gets a job slug without a slash", () => {
  assert.equal(parity.censusJobSlug("test/rules/nested/x.test.ts"), "rules-nested-x-census");
});

test("W1-T9877: header opt-outs apply only to legacy basename matches", (t) => {
  const path = "test/ci/gates/x-census.test.ts";
  assert.deepEqual(listed(t, { [path]: "\uFEFF\n/**\n * @not-a-rule-suite: a fixture\n */\nexport {};" }), []);
  assert.equal(parity.isRuleSuitePath(path, 'export {};\n// @not-a-rule-suite: body'), true);
  assert.throws(() => parity.isRuleSuitePath(path, "// @not-a-rule-suite:\n"), /requires a reason/);
  assert.equal(parity.isRuleSuitePath("src/rules/x-census.test.ts", ""), false);
  assert.equal(parity.isRuleSuitePath("test/rules/README.md", ""), false);
});

test("W1-T9877: a roster member stays enrolled after a move and cannot opt out", (t) => {
  const member = parity.CENSUS_POPULATION.find((m) => !parity.RULE_SUITE_NAME_RE.test(m.testFile))!;
  assert.ok(member, "control: the roster contributes a suite with no legacy name");
  const path = member.testFile.replace("test/", "test/ci/gates/");
  assert.deepEqual(listed(t, { [path]: "// @not-a-rule-suite:\n" }), [path]);
  assert.equal(violations(path, "@not-a-rule-suite: fixture").length, 1);
});

test("W1-T9877: diff classification includes declared rules and preserves structural discovery", (t) => {
  const files = {
    "test/rules/x.test.ts": "",
    "test/ci/census-y/z.test.ts": "",
    "test/ci/gates/x-census.test.ts": "",
    "test/ci/gates/optout-baseline.test.ts": "// @not-a-rule-suite: a unit fixture\n",
    "test/unit/walker.test.ts": 'readdirSync("src/");',
    "test/unit/plain.test.ts": "",
  };
  const dir = fixture(t, files);
  assert.deepEqual(censusSuiteFiles(["src/lib/x.ts"], dir), [
    "test/ci/gates/x-census.test.ts", "test/rules/x.test.ts", "test/unit/walker.test.ts",
  ]);
  assert.ok(!censusSuiteFiles(["test/rules/x.test.ts"], dir).includes("test/rules/x.test.ts"));
  assert.deepEqual(censusSuiteFiles(["CLAUDE.md", "doctrine/x/y.md"], dir), [], "a docs-only diff joins no rule suite");
});

test("W1-T9877: census drift resolves moved roster paths with the shared resolver", (t) => {
  const member = parity.CENSUS_POPULATION[0]!;
  const path = member.testFile.replace("test/", "test/rules/");
  const dir = fixture(t, { [path]: 'execFileSync("git", ["ls-files", "--", "src/"]);\n' });
  const resolvePath: typeof resolveTestPath = (cited, opts) => resolveTestPath(cited, {
    ...opts, cache: new Map(), git: { treeSha: () => "fixture-tree", listTestTree: () => [path] },
  });
  const result = parity.censusPopulationDrift(dir, () => ({ status: 0, stdout: path, stderr: "" }),
    (p: string) => readFileSync(join(dir, p), "utf8"), resolvePath);
  assert.deepEqual(result.unknown, []);
  assert.ok(!result.stale.includes(member.testFile));
  assert.ok(!result.stale.includes(path));
  assert.ok(result.stale.length > 0, "control: genuinely absent roster entries remain stale");
});

test("W1-T9877: census drift uses its default resolver for exact roster paths", (t) => {
  const files = Object.fromEntries(parity.CENSUS_POPULATION.map((member) => [
    member.testFile, 'execFileSync("git", ["ls-files", "--", "src/"]);\n',
  ]));
  const dir = fixture(t, files);
  const result = parity.censusPopulationDrift(dir,
    () => ({ status: 0, stdout: Object.keys(files).join("\n"), stderr: "" }),
    (p) => readFileSync(join(dir, p), "utf8"));
  assert.deepEqual(result, { unknown: [], stale: [] });
});
