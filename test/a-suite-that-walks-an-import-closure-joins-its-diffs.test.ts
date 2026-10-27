import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverSourceTextReaders, isUnplacedSourceReader, readerJoins } from "#src/lib/source-text-readers.js";
import { censusPushRefusal } from "#src/run-task.js";
// @ts-ignore executable module has no declaration file.
import * as precheck from "#scripts/census-precheck.mjs";

// @source-text-subject: closure declarations and import text are inputs to reader discovery.
// @census-reads: src/ test/ — the real-tree check discovers the two declared runtime closures.
const SUPERVISOR = "test/baked-supervisor-inputs.test.ts";
const DEPLOYER = "test/a-busy-primary-reaches-its-image-recycle.test.ts";
const TRIGGER = "test/acr-build-trigger.test.ts";
const BAKED = [SUPERVISOR, DEPLOYER, TRIGGER].sort();
const PROOF = "test/a-suite-that-walks-an-import-closure-joins-its-diffs.test.ts";
const SKILL_CONFORMANCE_CENSUS = "test/rules/every-applies-to-skill-is-selectable-and-bounded.test.ts";
const LEDGER = "src/lib/ledger.ts";
const SUPERVISOR_SEED = "src/lib/serve-supervisor-main.ts";
const DEPLOYER_SEED = "src/lib/deployer.ts";

const relativeSpecifier = (name: string) => JSON.stringify(`./${name}.js`);

function discover(files: Record<string, string>) {
  return discoverSourceTextReaders("/fixture", (args) =>
    Object.keys(files).filter((p) => args[0] !== "grep" || p.endsWith(".test.ts")).join("\n"),
  (path) => {
    assert.ok(Object.hasOwn(files, path), `unexpected read: ${path}`);
    return files[path]!;
  });
}

function trees() {
  const base: Record<string, string> = {
    [SUPERVISOR_SEED]: `import ${relativeSpecifier("ledger")};`,
    [DEPLOYER_SEED]: `export * from ${relativeSpecifier("ledger")};`,
    [LEDGER]: "export const value = 1;",
    "src/lib/host-identity.ts": "export const host = 1;",
    "src/lib/outside.ts": "export const other = 1;",
  };
  const head: Record<string, string> = { ...base, [LEDGER]: `import ${relativeSpecifier("host-identity")};\nexport const value = 1;` };
  return { base, head };
}

function evaluate(changed: string[], head: Record<string, string>, base: Record<string, string>, failing: string[] = [], members: object[] = []) {
  const asked: string[] = [];
  const result = precheck.evaluateAdmittedCensusSuites({
    changed, readHead: (p: string) => head[p] ?? null, readBase: (p: string) => base[p] ?? null,
    loadMembers: () => members,
    runSuites: (files: string[]) => { asked.push(...files); return files.filter((p) => failing.includes(p)); },
  });
  assert.equal(result.unmeasured, null);
  return { ...result, asked: asked.filter((p) => BAKED.includes(p)).sort() };
}

test("W1-T9806: a census-closure seed walks its whole runtime import closure", () => {
  const files = {
    "test/closure.test.ts": "// @census-closure: a.ts side.ts — prose missing.ts\n",
    "a.ts": `import { b } from ${relativeSpecifier("b")}; import ${relativeSpecifier("side")};`,
    "b.ts": `export { c } from ${relativeSpecifier("c")}; export * from ${relativeSpecifier("all")};`,
    "c.ts": `import(${relativeSpecifier("dynamic")}); require(${relativeSpecifier("required")}); import ${relativeSpecifier("a")};`,
    "side.ts": "", "all.ts": "", "dynamic.ts": "", "required.ts": "",
    "missing.ts": "", "unused.ts": "",
  };
  const [reader] = discover(files);
  assert.ok(reader);
  assert.deepEqual(reader.walks, ["a.ts", "all.ts", "b.ts", "c.ts", "dynamic.ts", "required.ts", "side.ts"]);
  assert.equal(reader.censusShaped, true);
  assert.equal(readerJoins(reader, "c.ts"), true);
  assert.equal(readerJoins(reader, "unused.ts"), false);
});

test("W1-T9806: the baked-closure censuses join a ledger diff", () => {
  const readers = discoverSourceTextReaders(new URL("..", import.meta.url).pathname);
  for (const suite of [SUPERVISOR, DEPLOYER]) {
    const reader = readers.find((r) => r.testFile === suite);
    assert.ok(reader, suite);
    assert.equal(reader.censusShaped, true, suite);
    assert.equal(readerJoins(reader, LEDGER), true, suite);
  }
});

test("W1-T9806: a type-only import or a missing seed adds no walk", () => {
  const readers = discover({
    "test/closure.test.ts": "// @census-closure: src/a.ts\n",
    "test/missing.test.ts": "// @census-closure: src/missing.ts\n",
    "test/unmarked.test.ts": 'const fixture = "// @census-closure: src/unused.ts";',
    "src/a.ts": [
      `import type { T } from ${relativeSpecifier("types")};`,
      `import { type T } from ${relativeSpecifier("inline-types")};`,
      `export type { T } from ${relativeSpecifier("exports")};`,
      `export { type T } from ${relativeSpecifier("inline-exports")};`,
      `import { type T, value } from ${relativeSpecifier("value")};`,
      `// import ${relativeSpecifier("comment")};`,
      `const text = 'import ${relativeSpecifier("string")}';`,
      'const template = `value ${1} import ' + relativeSpecifier("template") + '`;',
      String.raw`const pattern = /^\s*(#|$)/; const decoy = /import "\.\/regexp.js"/;`,
      'if (true) /#/.test("");',
      `const quotient = 6 / 2; import ${relativeSpecifier("after-division")};`,
      'import "node:fs"; import "external-package";',
    ].join("\n"),
    "src/types.ts": "", "src/inline-types.ts": "", "src/exports.ts": "", "src/inline-exports.ts": "",
    "src/value.ts": "", "src/comment.ts": "", "src/string.ts": "", "src/template.ts": "", "src/unused.ts": "",
    "src/regexp.ts": "", "src/after-division.ts": "",
  });
  assert.deepEqual(readers.map((r) => [r.testFile, r.walks]), [
    ["test/closure.test.ts", ["src/a.ts", "src/after-division.ts", "src/value.ts"]], ["test/missing.test.ts", []],
  ]);
  assert.equal(isUnplacedSourceReader(readers[1]!), true);
});

test("W1-T9806: the push precheck asks the baked-closure censuses for a closure import change", () => {
  const { head, base } = trees();
  assert.deepEqual(evaluate([LEDGER], head, base).asked, BAKED);
  assert.deepEqual(evaluate([LEDGER], base, head).asked, BAKED, "removing an import also moves the closure");
  assert.deepEqual(evaluate([LEDGER], base, base).asked, [], "an unchanged import set cannot move the closure");
  const detached = { ...head, [SUPERVISOR_SEED]: "", [DEPLOYER_SEED]: "", [LEDGER]: "" };
  assert.deepEqual(evaluate([LEDGER], detached, head).asked, BAKED, "the base-only closure still joins");
  for (const catalog of ["deploy/install-host-units.sh", "src/lib/baked-runtime-inputs.ts", ".github/workflows/acr-build.yml"]) {
    assert.deepEqual(evaluate([catalog], {}, {}).asked, BAKED, catalog);
  }
  for (const [suite, seed] of [[SUPERVISOR, SUPERVISOR_SEED], [DEPLOYER, DEPLOYER_SEED], [TRIGGER, SUPERVISOR_SEED]]) {
    assert.ok(evaluate([suite!], {}, {}).asked.includes(suite!));
    assert.ok(evaluate([seed!], {}, {}).asked.includes(suite!));
    assert.deepEqual(precheck.PRECHECK_PARITY[suite!], { modeled: precheck.evaluateAdmittedCensusSuites });
  }
  assert.deepEqual(precheck.PRECHECK_PARITY[PROOF], { modeled: precheck.evaluateAdmittedCensusSuites });
});

test("W1-T9806: a baked-closure refusal names the lists that catalog the closure", () => {
  const { head, base } = trees();
  const members = BAKED.map((testFile) => ({ testFile, walks: ["src/"], structural: true, script: "" }));
  const result = evaluate([LEDGER], head, base, BAKED, members);
  assert.deepEqual(result.asked, BAKED, "explicit rows dedupe discovered readers");
  assert.equal(result.violations.length, 3);
  const supervisor = result.violations.find((s: string) => s.includes(SUPERVISOR));
  assert.match(supervisor, /BAKED_RUNTIME_SOURCE_PATHS.*src\/lib\/baked-runtime-inputs\.ts/);
  assert.match(supervisor, /\.github\/workflows\/acr-build\.yml.*on\.push\.paths.*drift loop/);
  assert.match(result.violations.find((s: string) => s.includes(DEPLOYER)), /DEPLOY_LOGIC_PATHS.*deploy\/install-host-units\.sh/);
  assert.match(result.violations.find((s: string) => s.includes(TRIGGER)), /acr-build\.yml.*on\.push\.paths.*drift loop.*BAKED_RUNTIME_SOURCE_PATHS/);
  const refusal = censusPushRefusal(`census-precheck: this branch grows 3 census count(s) CI will refuse:\n${result.violations.map((v: string) => `  ${v}`).join("\n")}`);
  assert.ok(refusal);
  assert.deepEqual(refusal.censuses, ["census-suite"]);
  assert.deepEqual(refusal.offeredBaselines, []);
});

test("W1-T9806: an import outside both closures asks no baked-closure census", () => {
  const { head, base } = trees();
  head["src/lib/outside.ts"] = `import ${relativeSpecifier("host-identity")};`;
  assert.deepEqual(evaluate(["src/lib/outside.ts"], head, base).asked, []);
  assert.deepEqual(evaluate([], head, base).asked, []);
});

test("W1-T9806: unchanged import sets never read the baked closures to select suites", () => {
  const changed = "src/lib/closure-member.ts";
  for (const imports of ["", `import ${relativeSpecifier("host-identity")};\n`]) {
    const asked: string[] = [];
    const read = (value: number) => (path: string) => {
      assert.equal(path, changed, "only changed files are read before an import change is established");
      return `${imports}export const value = ${value};`;
    };
    const result = precheck.evaluateAdmittedCensusSuites({
      changed: [changed], readHead: read(2), readBase: read(1), loadMembers: () => [],
      runSuites: (files: string[]) => { asked.push(...files); return []; },
    });
    assert.deepEqual(result, { violations: [], unmeasured: null });
    assert.deepEqual(asked, [SKILL_CONFORMANCE_CENSUS], "the skill census runs while unchanged imports still avoid baked-closure reads");
  }
});
