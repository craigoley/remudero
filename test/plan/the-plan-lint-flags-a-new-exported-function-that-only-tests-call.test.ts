/**
 * W1-T12173: the plan lint flags a new exported function, class or module that only tests reach.
 * Most cases drive `exportsWithoutProductionCaller` over an in-memory tree; the last ones run the production
 * entry, scripts/lint-plan-offline.mjs, as a child over a git fixture, so its git-backed tree reader and its
 * catch arm run. A child, because importing src/run-task.ts in-process grows the affected-reach importer ceiling.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  addedExportsFromPatch,
  addedModulesFromPatch,
  exportsNewInPatch,
  exportsWithoutProductionCaller,
  type AddedExport,
  type ProductionCallerTree,
} from "#src/lib/task-linter.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** A relative specifier, quoted: spelled this way so the alias census reads no relative import in this file. */
const rel = (path: string) => JSON.stringify(`.${path}`);
const EXPORT: AddedExport = { path: "src/lib/existing.ts", symbol: "newReader" };
const EXISTING = "export function oldReader() {}\nexport function newReader(): number { return 1; }\nexport const newValue = 1;\n";
const TEST_USER = 'import { newReader } from "#src/lib/existing.js";\nnewReader();\n';

function fakeTree(files: Record<string, string>): { tree: ProductionCallerTree; reads: string[]; searches: string[][] } {
  const reads: string[] = [];
  const searches: string[][] = [];
  return {
    reads,
    searches,
    tree: {
      filesMentioning: (words) => {
        searches.push([...words]);
        return Object.keys(files).filter((f) => words.some((w) => files[f]!.includes(w)));
      },
      read: (path) => {
        reads.push(path);
        return files[path];
      },
    },
  };
}

const check = (files: Record<string, string>, exports: AddedExport[] = [EXPORT], modules: string[] = []) =>
  exportsWithoutProductionCaller(exports, modules, fakeTree(files).tree);

test("W1-T12173 criterion 1: an export only a test file calls is reported", () => {
  const found = check({ "src/lib/existing.ts": EXISTING, "test/lib/existing.test.ts": TEST_USER });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.check, "production-caller");
  assert.equal(found[0]!.symbol, "newReader");
  assert.equal(found[0]!.path, "src/lib/existing.ts");
});

test("W1-T12173 criterion 1: an export a src or scripts file imports is not reported", () => {
  const consumer = `import { oldReader, newReader as read } from ${rel("/existing.js")};\nread();\n`;
  assert.deepEqual(check({ "src/lib/existing.ts": EXISTING, "src/lib/consumer.ts": consumer, "test/x.test.ts": TEST_USER }), []);
  const script = 'import { newReader } from "#src/lib/existing.js";\nnewReader();\n';
  assert.deepEqual(check({ "src/lib/existing.ts": EXISTING, "scripts/run.mjs": script }), []);
});

test("W1-T12173 criterion 1: a namespace, dynamic or re-exported use is a production call", () => {
  const ns = `import * as existing from ${rel("./lib/existing.js")};\nexisting.newReader();\n`;
  assert.deepEqual(check({ "src/lib/existing.ts": EXISTING, "src/cli/a.ts": ns }), []);
  const dynamic = `const { newReader } = await import(${rel("/existing.js")});\nnewReader();\n`;
  assert.deepEqual(check({ "src/lib/existing.ts": EXISTING, "src/lib/b.ts": dynamic }), []);
  const barrel = `export * from ${rel("/existing.js")};\n`;
  const viaBarrel = `import { newReader } from ${rel("/index.js")};\nnewReader();\n`;
  assert.deepEqual(check({ "src/lib/existing.ts": EXISTING, "src/lib/index.ts": barrel, "src/lib/c.ts": viaBarrel }), []);
});

test("W1-T12173 criterion 1: a same-named function from another module is not a call", () => {
  const other = `import { newReader } from ${rel("/other.js")};\nnewReader();\n`;
  assert.equal(check({ "src/lib/existing.ts": EXISTING, "src/lib/consumer.ts": other }).length, 1);
});

test("W1-T12173 criterion 1: an exported constant is left out, and a call in its own file is not a production call", () => {
  assert.deepEqual(check({ "src/lib/existing.ts": EXISTING }, [{ path: EXPORT.path, symbol: "newValue" }]), []);
  const selfCalling = `${EXISTING}export function run() { return [...newReader()]; }\n`;
  const found = check({ "src/lib/existing.ts": selfCalling, "test/x.test.ts": TEST_USER });
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /src\/lib\/existing\.ts calls it itself, so only a test needs the export/);
});

test("W1-T12173 criterion 2: a new module only a test imports is reported, and one src imports is not", () => {
  const module = "src/lib/fresh.ts";
  const files = { [module]: "export function fresh() {}\n", "test/lib/fresh.test.ts": 'import { fresh } from "#src/lib/fresh.js";\n' };
  const found = check(files, [], [module]);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.path, module);
  assert.equal(found[0]!.symbol, undefined);
  assert.deepEqual(check({ ...files, "src/run.ts": `import ${rel("/lib/fresh.js")};\n` }, [], [module]), []);
});

test("W1-T12173 criterion 3: a mention in a comment or a string is not a call", () => {
  const prose = [
    "// newReader() from ./existing.js is not called here",
    `/* import { newReader } from ${rel("/existing.js")}; */`,
    `const text = "import { newReader } from '${rel("/existing.js").slice(1, -1)}'; newReader()";`,
    "const tpl = `newReader() ${text}`;",
  ].join("\n");
  const found = check({ "src/lib/existing.ts": EXISTING, "src/lib/prose.ts": prose });
  assert.equal(found.length, 1, "a comment and a string are text, not a call");
  // CONTROL: the same file with a real import clears it, so the case above is not vacuous.
  assert.deepEqual(check({ "src/lib/existing.ts": EXISTING, "src/lib/prose.ts": `${prose}\nimport { newReader } from ${rel("/existing.js")};\n` }), []);
});

test("W1-T12173 criterion 3: an import only another new and uncalled module makes is not a call", () => {
  const files = {
    "src/lib/existing.ts": EXISTING,
    "src/lib/new-a.ts": `import { newReader } from ${rel("/existing.js")};\nimport { b } from ${rel("/new-b.js")};\nexport const a = () => b(newReader());\n`,
    "src/lib/new-b.ts": "export function b(n: number) { return n; }\n",
  };
  const found = check(files, [EXPORT], ["src/lib/new-a.ts", "src/lib/new-b.ts"]);
  assert.deepEqual(found.map((f) => f.symbol ?? f.path).sort(), ["newReader", "src/lib/new-a.ts", "src/lib/new-b.ts"]);
  // Once production imports the new module, everything it reaches is called.
  const wired = { ...files, "src/run.ts": `import { a } from ${rel("/lib/new-a.js")};\na();\n` };
  assert.deepEqual(check(wired, [EXPORT], ["src/lib/new-a.ts", "src/lib/new-b.ts"]), []);
});

test("W1-T12173 criterion 4: the finding names the export, its file, its test files and what to add", () => {
  const files = { "src/lib/existing.ts": EXISTING, "test/lib/existing.test.ts": TEST_USER, "test/other.test.ts": TEST_USER };
  const [finding] = check(files);
  assert.deepEqual(finding!.testUsers, ["test/lib/existing.test.ts", "test/other.test.ts"]);
  assert.match(finding!.message, /newReader/);
  assert.match(finding!.message, /src\/lib\/existing\.ts/);
  assert.match(finding!.message, /only test\/lib\/existing\.test\.ts, test\/other\.test\.ts use it/);
  assert.match(finding!.message, /Add a call to newReader from the production code that needs it/);
  const [module] = check({ "src/lib/fresh.ts": "", "test/f.test.ts": 'import "#src/lib/fresh.js";\n' }, [], ["src/lib/fresh.ts"]);
  assert.match(module!.message, /src\/lib\/fresh\.ts: the diff adds this module.*only test\/f\.test\.ts use it\. Add an import of src\/lib\/fresh\.ts/);
});

test("W1-T12173 criterion 5: a diff that adds no export gets no finding and reads no file", () => {
  const diff = [
    "diff --git a/src/lib/existing.ts b/src/lib/existing.ts",
    "--- a/src/lib/existing.ts",
    "+++ b/src/lib/existing.ts",
    "@@ -1 +1 @@",
    "-export function oldReader() {}",
    "+export function oldReader() { return 0; }",
  ].join("\n");
  // An edited declaration of an export the base already held is not an added export.
  assert.deepEqual(addedExportsFromPatch(diff), [{ path: "src/lib/existing.ts", symbol: "oldReader" }]);
  const exports = exportsNewInPatch(addedExportsFromPatch(diff), diff);
  const modules = addedModulesFromPatch(diff);
  assert.deepEqual([exports, modules], [[], []]);
  const probe = fakeTree({ "src/lib/existing.ts": EXISTING });
  assert.deepEqual(exportsWithoutProductionCaller(exports, modules, probe.tree), []);
  assert.deepEqual([probe.reads, probe.searches], [[], []]);
});

test("W1-T12173 criterion 2: the diff reader names only new src modules", () => {
  const diff = [
    "diff --git a/src/lib/new.ts b/src/lib/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/lib/new.ts",
    "diff --git a/src/lib/new.test.ts b/src/lib/new.test.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/lib/new.test.ts",
    "diff --git a/src/types.d.ts b/src/types.d.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/types.d.ts",
    "diff --git a/src/lib/old.ts b/src/lib/old.ts", "--- a/src/lib/old.ts", "+++ b/src/lib/old.ts",
  ].join("\n");
  assert.deepEqual(addedModulesFromPatch(diff), ["src/lib/new.ts"]);
});

// ── the real lint command over a git fixture ────────────────────────────────────────────────
function write(repo: GitRepo, rel: string, text: string): void {
  mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
  writeFileSync(join(repo.dir, rel), text, "utf8");
}

/** main holds one module; the branch adds an export only a test calls and a module nothing imports. */
function fixture(): GitRepo {
  const repo = gitRepo({ kind: "w1-t12173" });
  write(repo, "plan/tasks.yaml", [
    "- id: ZZ-Fixture", '  title: "an unchanged fixture task"', "  repo: remudero", "  depends_on: []",
    "  type: implement", "  verify: human", "  status: queued", '  origin: "W1-T12173 test fixture"',
    "  acceptance:", '    - claim: "something is proven"', '      proof: "unit test: test/w1-t12173-fixture.test.ts"', "",
  ].join("\n"));
  write(repo, "src/lib/existing.ts", "export function oldReader() {}\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "base");
  repo.git("checkout", "-q", "-b", "feature");
  write(repo, "src/lib/existing.ts", EXISTING);
  write(repo, "src/lib/lonely.ts", "export function unreached() {}\n");
  write(repo, "test/lib/existing.test.ts", TEST_USER);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feature");
  return repo;
}

function lint(repo: GitRepo): { code: number | null; out: string[] } {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
    join(REPO_ROOT, "scripts/lint-plan-offline.mjs"), "--repo-root", repo.dir, "--base", "main"], {
    cwd: repo.dir, encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", LANG: "C", TZ: "UTC" },
  });
  assert.equal(r.error, undefined, "the offline lint child completes");
  return { code: r.status, out: `${r.stdout}${r.stderr}`.split("\n") };
}

test("W1-T12173 criterion 6: the lint command runs the check on the exports it reads from the diff", () => {
  const { out } = lint(fixture());
  const lines = out.filter((l) => l.includes("[production-caller]"));
  assert.equal(lines.length, 2, out.join("\n"));
  assert.match(lines.join("\n"), /the export newReader.*only test\/lib\/existing\.test\.ts use it/);
  assert.match(lines.join("\n"), /src\/lib\/lonely\.ts: the diff adds this module/);
});

test("W1-T12173 criterion 6: an unreadable tree is named as not checked, never as clean", () => {
  const repo = fixture();
  rmSync(join(repo.dir, "src/lib/existing.ts"));
  mkdirSync(join(repo.dir, "src/lib/existing.ts"));
  const { out } = lint(repo);
  assert.ok(out.some((l) => /\[production-caller\] not checked: /.test(l)), out.join("\n"));
});
