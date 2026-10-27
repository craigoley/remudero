import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { baseLacksPrAddedExports } from "#src/lib/proof-missing-export.js";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-subpath-export-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const base = join(dir, "base"), head = join(dir, "head");
  const put = (root: string, path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const pkg = (root: string, imports: unknown = { "#src/*": "./src/*" }, path = "package.json") =>
    put(root, path, JSON.stringify({ type: "module", imports }));
  for (const root of [base, head]) pkg(root);
  put(base, "src/a.ts", "export const existing = 1;\n");
  put(head, "src/a.ts", "export const existing = 1; export const added = 3;\n");
  const importer = join(base, "test/probe.test.ts");
  const output = (specifier = "#src/a.js") =>
    `# ${importer}:1\n# SyntaxError: The requested module '${specifier}' does not provide an export named 'added'\n`;
  return { dir, base, head, put, pkg, output };
}

test("verified local subpath exports discriminate actual Node head/base link outcomes", async t => {
  const f = fixture(t);
  const source = 'import {test} from "node:test";import assert from "node:assert/strict";import {added} from "#src/a.js";test("actual alias export",()=>assert.equal(added,3));\n';
  for (const root of [f.base, f.head]) f.put(root, "test/probe.test.ts", source);
  const env: NodeJS.ProcessEnv = { ...process.env, TSX_DISABLE_CACHE: "1" };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_V8_COVERAGE = undefined;
  const run = (cwd: string) => spawnSync(process.execPath, ["--import", join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
    "--test", "--test-reporter=tap", "test/probe.test.ts"], { cwd, env,
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 ** 2 });
  const head = run(f.head), base = run(f.base);
  assert.equal(head.error, undefined); assert.equal(base.error, undefined);
  assert.equal(head.status, 0, head.stderr); assert.match(head.stdout, /^# tests 1$/m); assert.match(head.stdout, /^# pass 1$/m);
  assert.equal(base.status, 1); assert.match(base.stdout, /does not provide an export named 'added'/);
  assert.match(String(await baseLacksPrAddedExports(base.stdout + base.stderr, f.base, f.head)), /base lacks export\(s\) added \(src\/a\.ts\)/);
});

test("verified local subpath exports accept literal and TAP-escaped hash spellings", async t => {
  const f = fixture(t);
  for (const specifier of ["#src/a.js", "\\#src/a.js"])
    assert.match(String(await baseLacksPrAddedExports(f.output(specifier), f.base, f.head)), /base lacks export/);
});

test("subpath export attribution falls back to tsx only when the ts candidate is missing", async t => {
  const f = fixture(t);
  for (const root of [f.base, f.head]) rmSync(join(root, "src/a.ts"));
  f.put(f.base, "src/a.tsx", "export const existing = 1;\n");
  f.put(f.head, "src/a.tsx", "export const existing = 1; export const added = 3;\n");
  assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head),
    "base lacks export(s) added (src/a.tsx) that the PR adds — the test cannot link there, a genuine miss");
  rmSync(join(f.base, "src/a.tsx"));
  assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
});

test("subpath export attribution keeps module read errors unknown despite a valid fallback", async t => {
  const f = fixture(t);
  f.put(f.base, "src/a.tsx", "export const existing = 1;\n");
  f.put(f.head, "src/a.tsx", "export const added = 3;\n");
  assert.match(String(await baseLacksPrAddedExports(f.output(), f.base, f.head)), /base lacks export/);
  for (const root of [f.base, f.head]) {
    const path = join(root, "src/a.ts");
    rmSync(path);
    symlinkSync("a.ts", path);
    assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined, root);
    rmSync(path);
    f.put(root, "src/a.ts", root === f.base ? "export const existing = 1;\n" : "export const added = 3;\n");
  }
});

test("subpath export attribution refuses changed or ambiguous package mappings", async t => {
  const f = fixture(t);
  for (const imports of [{ "#src/*": "./other/*" }, { "#src/*": { import: "./src/*" } },
    { "#src/*": ["./src/*"] }, { "#src/*": "./src/*", "#src/a.js": "./src/a.js" },
    { "#src/*": "node:fs" }, { "#src/*": "../outside/*" }]) {
    f.pkg(f.head, imports);
    assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
  }
});

test("subpath export attribution respects the nearest package scope and refuses outside modules", async t => {
  const f = fixture(t);
  f.pkg(f.base, {}, "test/package.json");
  assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
  f.pkg(f.base, { "#src/*": "./src/*" });
  f.pkg(f.base, { "#src/*": "../src/*" }, "test/package.json");
  assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
  rmSync(join(f.base, "test/package.json"));
  for (const root of [f.base, f.head]) f.pkg(root, { "#src/*": "./linked/*" });
  f.put(f.base, "linked/a.ts", "export const existing = 1;\n");
  f.put(f.dir, "external/a.ts", "export const added = 3;\n");
  symlinkSync(join(f.dir, "external"), join(f.head, "linked"));
  assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
});

test("subpath export attribution keeps malformed metadata and mixed errors unknown", async t => {
  const f = fixture(t);
  f.put(f.head, "package.json", "{");
  assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
  f.pkg(f.head);
  assert.equal(await baseLacksPrAddedExports(f.output() + "# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/missing'\n", f.base, f.head), undefined);
  assert.equal(await baseLacksPrAddedExports(f.output("#src/../a.js"), f.base, f.head), undefined);
});

test("subpath export attribution accepts an exact local mapping but refuses absent scope metadata", async t => {
  const f = fixture(t);
  for (const root of [f.base, f.head]) f.pkg(root, { "#widget": "./src/a.js" });
  assert.match(String(await baseLacksPrAddedExports(f.output("#widget"), f.base, f.head)), /base lacks export/);
  rmSync(join(f.base, "package.json"));
  assert.equal(await baseLacksPrAddedExports(f.output("#widget"), f.base, f.head), undefined);
});

test("subpath export attribution refuses repeated substitutions and unsafe package files", async t => {
  const f = fixture(t);
  for (const root of [f.base, f.head]) f.pkg(root, { "#src/*": "./src/**/*" });
  assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);

  f.pkg(f.base);
  rmSync(join(f.head, "package.json"));
  symlinkSync(join(f.base, "package.json"), join(f.head, "package.json"));
  assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);

  rmSync(join(f.head, "package.json"));
  f.put(f.head, "package.json", JSON.stringify({ imports: { "#src/*": "./src/*" }, padding: "x".repeat(65536) }));
  assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
});

test("an unreadable mapped source stays unknown even when a later extension would supply its export", async t => {
  const f = fixture(t), source = join(f.head, "src/a.ts");
  assert.match(String(await baseLacksPrAddedExports(f.output(), f.base, f.head)), /base lacks export/);
  f.put(f.dir, "outside.ts", "export const added = 3;\n");
  f.put(f.head, "src/a.js", "export const added = 3;\n");
  rmSync(source); symlinkSync(join(f.dir, "outside.ts"), source);
  assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined,
    "ELOOP is unavailable evidence, not ENOENT permission to credit an alternate module");
  rmSync(source); f.put(f.head, "src/a.ts", "export const added = 3;\n");
  assert.match(String(await baseLacksPrAddedExports(f.output(), f.base, f.head)), /base lacks export/);
});


test("export attribution refuses a descriptor opened outside before its pathname moves inside", async t => {
  const f = fixture(t), parent = join(f.head, "src"), source = join(parent, "a.ts");
  assert.match(String(await baseLacksPrAddedExports(f.output(), f.base, f.head)), /base lacks export/);
  f.put(f.head, "src/a.ts", "export const existing = 1;\n");
  assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
  f.put(f.dir, "outside/a.ts", "export const added = 3;\n");
  const open = fs.openSync, realpath = fs.realpathSync;
  const sources = new Set([source, realpathSync(source)]); let raced = false;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
    if (!raced && sources.has(String(args[0]))) {
      raced = true; renameSync(parent, join(f.head, "inside-src")); symlinkSync(join(f.dir, "outside"), parent);
      const fd = open(...args);
      rmSync(parent); renameSync(join(f.head, "inside-src"), parent);
      return fd;
    }
    return open(...args);
  });
  t.mock.method(fs, "realpathSync", (...args: Parameters<typeof realpathSync>) => {
    const result = realpath(...args);
    if (!raced && sources.has(String(args[0]))) {
      raced = true; renameSync(parent, join(f.head, "inside-src")); symlinkSync(join(f.dir, "outside"), parent);
    }
    return result;
  }); syncBuiltinESMExports();
  try {
    const result = await baseLacksPrAddedExports(f.output(), f.base, f.head);
    assert.equal(raced, true, "the ancestor replacement must actually fire once");
    assert.equal(result, undefined, "outside bytes cannot attest an export absent from the checked head source");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});


test("subpath package metadata keeps its exact byte bound with healthy controls", async t => {
  const f = fixture(t), text = JSON.stringify({ type: "module", imports: { "#src/*": "./src/*" } });
  f.put(f.base, "package.json", text.padEnd(65536, " "));
  f.put(f.head, "package.json", text.padEnd(65536, " "));
  assert.match(String(await baseLacksPrAddedExports(f.output(), f.base, f.head)), /base lacks export/);
  f.put(f.head, "package.json", text.padEnd(65537, " "));
  assert.equal(await baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
  f.put(f.head, "package.json", text);
  assert.match(String(await baseLacksPrAddedExports(f.output(), f.base, f.head)), /base lacks export/);
});


test("an aliased proof root attributes real Node output only inside its canonical base", async t => {
  const f = fixture(t);
  const source = 'import {test} from "node:test";import {added} from "#src/a.js";test("root alias export",()=>{if(added!==3)throw Error("wrong export")});\n';
  for (const root of [f.base, f.head]) f.put(root, "test/probe.test.ts", source);
  const baseAlias = join(f.dir, "base-alias"), headAlias = join(f.dir, "head-alias");
  symlinkSync(f.base, baseAlias, "dir"); symlinkSync(f.head, headAlias, "dir");
  const env: NodeJS.ProcessEnv = { ...process.env, TSX_DISABLE_CACHE: "1" };
  delete env.NODE_TEST_CONTEXT;
  const run = (cwd: string) => spawnSync(process.execPath, ["--import", join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
    "--test", "--test-reporter=tap", "test/probe.test.ts"], { cwd, env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 ** 2 });
  const head = run(headAlias), base = run(baseAlias);
  assert.equal(head.status, 0, head.stdout + head.stderr);
  assert.equal(base.status, 1, base.stdout + base.stderr);
  assert.match(base.stdout, /does not provide an export named 'added'/);
  assert.match(String(await baseLacksPrAddedExports(base.stdout + base.stderr, baseAlias, headAlias)), /base lacks export\(s\) added/);
  const foreign = realpathSync(f.base) + "-outside/test/probe.test.ts";
  const escaped = `# ${foreign}:1\n# SyntaxError: The requested module '#src/a.js' does not provide an export named 'added'\n`;
  assert.equal(await baseLacksPrAddedExports(escaped, baseAlias, headAlias), undefined);
  rmSync(baseAlias); symlinkSync(baseAlias, baseAlias);
  assert.equal(await baseLacksPrAddedExports(base.stdout + base.stderr, baseAlias, headAlias), undefined, "an unresolvable trusted root stays unknown");
});
