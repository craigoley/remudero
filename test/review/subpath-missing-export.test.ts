import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("verified local subpath exports discriminate actual Node head/base link outcomes", t => {
  const f = fixture(t);
  const source = 'import {test} from "node:test";import assert from "node:assert/strict";import {added} from "#src/a.js";test("actual alias export",()=>assert.equal(added,3));\n';
  for (const root of [f.base, f.head]) f.put(root, "test/probe.test.ts", source);
  const run = (cwd: string) => spawnSync(process.execPath, ["--import", join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
    "--test", "--test-reporter=tap", "test/probe.test.ts"], { cwd, env: { ...process.env, TSX_DISABLE_CACHE: "1" },
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 ** 2 });
  const head = run(f.head), base = run(f.base);
  assert.equal(head.error, undefined); assert.equal(base.error, undefined);
  assert.equal(head.status, 0, head.stderr); assert.match(head.stdout, /^# tests 1$/m); assert.match(head.stdout, /^# pass 1$/m);
  assert.equal(base.status, 1); assert.match(base.stdout, /does not provide an export named 'added'/);
  assert.match(String(baseLacksPrAddedExports(base.stdout + base.stderr, f.base, f.head)), /base lacks export\(s\) added \(src\/a\.ts\)/);
});

test("verified local subpath exports accept literal and TAP-escaped hash spellings", t => {
  const f = fixture(t);
  for (const specifier of ["#src/a.js", "\\#src/a.js"])
    assert.match(String(baseLacksPrAddedExports(f.output(specifier), f.base, f.head)), /base lacks export/);
});

test("subpath export attribution refuses changed or ambiguous package mappings", t => {
  const f = fixture(t);
  for (const imports of [{ "#src/*": "./other/*" }, { "#src/*": { import: "./src/*" } },
    { "#src/*": ["./src/*"] }, { "#src/*": "./src/*", "#src/a.js": "./src/a.js" },
    { "#src/*": "node:fs" }, { "#src/*": "../outside/*" }]) {
    f.pkg(f.head, imports);
    assert.equal(baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
  }
});

test("subpath export attribution respects the nearest package scope and refuses outside modules", t => {
  const f = fixture(t);
  f.pkg(f.base, {}, "test/package.json");
  assert.equal(baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
  f.pkg(f.base, { "#src/*": "./src/*" });
  f.pkg(f.base, { "#src/*": "../src/*" }, "test/package.json");
  assert.equal(baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
  for (const root of [f.base, f.head]) f.pkg(root, { "#src/*": "./linked/*" });
  f.put(f.dir, "external/a.ts", "export const added = 3;\n");
  symlinkSync(join(f.dir, "external"), join(f.head, "linked"));
  assert.equal(baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
});

test("subpath export attribution keeps malformed metadata and mixed errors unknown", t => {
  const f = fixture(t);
  f.put(f.head, "package.json", "{");
  assert.equal(baseLacksPrAddedExports(f.output(), f.base, f.head), undefined);
  f.pkg(f.head);
  assert.equal(baseLacksPrAddedExports(f.output() + "# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/missing'\n", f.base, f.head), undefined);
  assert.equal(baseLacksPrAddedExports(f.output("#src/../a.js"), f.base, f.head), undefined);
});
