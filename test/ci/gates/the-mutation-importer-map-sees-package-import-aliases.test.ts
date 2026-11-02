import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { parseSync } from "@swc/core";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const scriptModule = "#scripts/mutation-ratchet.mjs";
const { deriveDirectImporters, resolveMutateScope, loadNightlyScopeConfig } = await import(scriptModule);

function tree(t: TestContext, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "rmd-mutation-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, contents: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  put("package.json", JSON.stringify({ imports: { "#src/*": "./src/*" } }));
  for (const [path, contents] of Object.entries(files)) put(path, contents);
  return { root, put, read: (path: string) => readFileSync(join(root, path), "utf8") };
}

test("W1-T10354: a test that imports a module through #src is one of its direct importers", (t) => {
  const fixture = tree(t, {
    "src/lib/a.ts": "export const a = 1;",
    "test/nested/a.test.ts": 'import { a } from "#src/lib/a.js"; import type { A } from "#src/lib/a.ts";',
    "test/z.test.ts": 'import "#src/lib/a.js"; export * from "#src/lib/a.js";',
  });
  const map = deriveDirectImporters(["src/lib/a.ts"], ["test/z.test.ts", "test/nested/a.test.ts"], fixture.read, { repoRoot: fixture.root });
  assert.deepEqual(map.get("src/lib/a.ts"), ["test/nested/a.test.ts", "test/z.test.ts"]);
});

test("W1-T10354: the alias targets come from package.json imports", (t) => {
  const fixture = tree(t, {
    "src/lib/a.ts": "export const a = 1;",
    "src/lib/b.ts": "export const b = 2;",
    "test/a.test.ts": 'import { a } from "#fresh/lib/a.js"; export { b } from "#one";',
  });
  fixture.put("package.json", JSON.stringify({ imports: { "#fresh/*": "./src/*", "#one": "./src/lib/b.ts" } }));
  const derive = () => deriveDirectImporters(["src/lib/a.ts", "src/lib/b.ts"], ["test/a.test.ts"], fixture.read, { repoRoot: fixture.root });
  assert.deepEqual([...derive().keys()].sort(), ["src/lib/a.ts", "src/lib/b.ts"]);
  fixture.put("package.json", JSON.stringify({ imports: { "#fresh/*": "./scripts/*", "#one": "./src/lib/b.ts" } }));
  assert.equal(derive().has("src/lib/a.ts"), false, "aliases are re-read on every derivation");
});

test("W1-T10354: a literal dynamic import of a src module is an importer edge", (t) => {
  const fixture = tree(t, {
    "src/lib/a.ts": "export const a = 1;",
    "src/lib/b.ts": "export const b = 2;",
    "test/a.test.ts": `async function load() { await import(${JSON.stringify("../src/lib/a.js")}); await import(\`#src/lib/b.ts\`); }`,
  });
  const map = deriveDirectImporters(["src/lib/a.ts", "src/lib/b.ts"], ["test/a.test.ts"], fixture.read, { repoRoot: fixture.root });
  assert.deepEqual([...map.values()], [["test/a.test.ts"], ["test/a.test.ts"]]);
});

test("W1-T10354: an import specifier inside fixture text is not an importer edge", (t) => {
  const fixture = tree(t, {
    "src/lib/a.ts": "export const a = 1;",
    "test/a.test.ts": [
      `const fixture = \`import { a } from ${JSON.stringify("../src/lib/a.js")}; import("#missing/a.js");\`;`,
      `const text = ${JSON.stringify(`from ${JSON.stringify("../src/lib/missing.js")}`)};`,
      '// import "#unknown/a.js";',
      'const re = /from "#unknown\\/a.js"/;',
      'import "#src/lib/a.js";',
    ].join("\n"),
    "test/b.test.ts": `const fixture = \`from ${JSON.stringify("../src/lib/a.js")}\`;`,
  });
  const map = deriveDirectImporters(["src/lib/a.ts"], ["test/a.test.ts", "test/b.test.ts"], fixture.read, { repoRoot: fixture.root });
  assert.deepEqual(map.get("src/lib/a.ts"), ["test/a.test.ts"]);
});

test("W1-T10354: the nightly plan fails loudly on a src or alias import it cannot resolve", (t) => {
  const fixture = tree(t, {});
  const testPath = relative(REPO_ROOT, join(fixture.root, "test/broken.test.ts"));
  fixture.put("test/relative.test.ts", `import ${JSON.stringify("../src/lib/missing.js")};`);
  assert.throws(() => deriveDirectImporters([], ["test/relative.test.ts"], fixture.read, { repoRoot: fixture.root }),
    /test\/relative.test.ts: "\.\.\/src\/lib\/missing.js": src target does not exist/);
  fixture.put("test/broken.test.ts", 'import "#src/lib/w1-t10354-missing.js"; import "#unknown/a.js";');
  fixture.put("candidates.txt", "src/lib/classify.ts\n");
  fixture.put("tests.txt", `${testPath}\n`);
  const planDir = join(fixture.root, "plan");
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/mutation-ratchet.mjs"),
    "--nightly-plan", "--files", join(fixture.root, "candidates.txt"),
    "--test-files", join(fixture.root, "tests.txt"), "--plan-dir", planDir,
  ], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", NODE_V8_COVERAGE: "" } });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stderr.includes(testPath), result.stderr);
  for (const specifier of ["#src/lib/w1-t10354-missing.js", "#unknown/a.js"]) {
    assert.ok(result.stderr.includes(specifier), result.stderr);
  }
  assert.equal(existsSync(planDir), false, "validation happens before writing configs");
});

function walk(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? (path === "test/fixtures" ? [] : walk(root, path)) : [path];
  });
}

// @source-text-subject: test import syntax is the input corpus of the importer map.
// @census-reads: src/ test/ package.json — the source modules, test imports and package aliases being mapped.
test("W1-T10354: on the real tree every test that imports src through #src is in the importer map", () => {
  const modules = resolveMutateScope(walk(REPO_ROOT, "src"), loadNightlyScopeConfig().mutate);
  const tests = walk(REPO_ROOT, "test").filter((path) => path.endsWith(".test.ts"));
  const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
  const map = deriveDirectImporters(modules, tests, read);
  let population = 0;
  for (const path of tests) {
    const source = read(path);
    if (!source.includes("#src/")) continue;
    const ast = parseSync(source, { syntax: "typescript", decorators: true });
    for (const node of ast.body) {
      if (node.type !== "ImportDeclaration" || !node.source.value.startsWith("#src/")) continue;
      const target = node.source.value.replace(/^#src\//, "src/").replace(/\.js$/, ".ts");
      if (!modules.includes(target)) continue;
      population++;
      assert.ok(map.get(target)?.includes(path), `${path} must import ${target}`);
    }
  }
  assert.ok(population > 0, "positive control: real tests must import mutable source through #src");
});

test("non-literal imports and alias coverage are reported without following helpers", (t) => {
  const fixture = tree(t, {
    "src/lib/a.ts": "export const a = 1;",
    "src/lib/known.mjs": "export const known = 1;",
    "test/helper.ts": 'import "#src/lib/a.js";',
    "test/a.test.ts": 'import "#src/lib/a.js"; import "#src/lib/known.mjs"; import(name); import(`./${name}`);',
    "test/b.test.ts": 'import "#test/helper.js";',
  });
  fixture.put("package.json", JSON.stringify({ imports: { "#src/*": "./src/*", "#test/*": "./test/*" } }));
  let report!: { testFiles: number; modules: number; pairs: number; aliases: Record<string, number>;
    nonLiteralImports: { testFile: string }[] };
  const map = deriveDirectImporters(["src/lib/a.ts"], ["test/a.test.ts", "test/b.test.ts"], fixture.read,
    { repoRoot: fixture.root, report: (value: typeof report) => { report = value; } });
  assert.deepEqual([...map], [["src/lib/a.ts", ["test/a.test.ts"]]]);
  assert.equal(report.testFiles, 1);
  assert.equal(report.modules, 1);
  assert.equal(report.pairs, 1);
  assert.equal(report.aliases["#src/*"], 2);
  assert.deepEqual(report.nonLiteralImports.map((entry) => entry.testFile), ["test/a.test.ts", "test/a.test.ts"]);
});

test("bare imports, re-exports and type imports each contribute a direct edge", (t) => {
  const fixture = tree(t, {
    "test/a.test.ts": 'import "#src/bare.js"; export * from "#src/all.js"; export { n } from "#src/named.ts"; import type { T } from "#src/type.js";',
  });
  const modules = ["bare", "all", "named", "type"].map((name) => `src/${name}.ts`);
  const map = deriveDirectImporters(modules, ["test/a.test.ts"], fixture.read, { repoRoot: fixture.root });
  assert.deepEqual([...map.keys()], modules);
  for (const module of modules) assert.deepEqual(map.get(module), ["test/a.test.ts"]);
});

test("a malformed test is named rather than silently removing its importers", (t) => {
  const fixture = tree(t, { "test/bad.test.ts": "import {" });
  assert.throws(() => deriveDirectImporters([], ["test/bad.test.ts"], fixture.read, { repoRoot: fixture.root }),
    /test\/bad.test.ts: cannot parse imports/);
});

test("the nightly CLI logs non-literal imports and coverage for known non-mutable src", (t) => {
  const fixture = tree(t, {});
  const known = walk(REPO_ROOT, "src").find((path) => path.endsWith(".mjs"));
  assert.ok(known, "positive control: the real tree contains a non-mutable source module");
  fixture.put("test/a.test.ts", `import "#src/${known.slice(4)}"; import(variable);`);
  fixture.put("tests.txt", `${relative(REPO_ROOT, join(fixture.root, "test/a.test.ts"))}\n`);
  fixture.put("candidates.txt", `${known}\n`);
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/mutation-ratchet.mjs"),
    "--nightly-plan", "--files", join(fixture.root, "candidates.txt"),
    "--test-files", join(fixture.root, "tests.txt"), "--plan-dir", join(fixture.root, "plan"),
  ], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", NODE_V8_COVERAGE: "" } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 test files with src edges, 0 modules with importers, 0 pairs/);
  assert.ok(result.stdout.includes('"#src/*":1'), result.stdout);
  assert.match(result.stdout, /1 non-literal imports/);
  assert.ok(result.stdout.includes(`NON-LITERAL ${relative(REPO_ROOT, join(fixture.root, "test/a.test.ts"))}:`));
});
