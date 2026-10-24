/**
 * The affected-suite NARROW selection names only SOURCE symbols and REAL imports.
 *
 * Two defects made every src change select ~2,374 suites (MEASURED 2026-10-06 on five merged PRs):
 * `changedSymbols` read a changed TEST file's hunks, so its locals (`const one`, `base`) named every
 * suite sharing the word; and `namedPaths` turned src paths held as DATA in src modules
 * (authority.ts, config-schema.ts, …) into src→src import edges, so almost every module "reached"
 * src/run-task.ts. The soundness controls prove neither fix dropped a real read.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitRepo } from "#test/helpers/git-repo.js";

import * as affected from "../src/lib/affected-suites.js";

const TREE: Record<string, string> = {
  "src/heavy.ts": "export const heavy = 1;\n",
  // A table of src paths held as data: no import, no spawn.
  "src/table.ts": 'export const SITES = ["src/heavy.ts", "src/other.ts"];\nexport const SPLIT = join("src", "heavy.ts");\n',
  "src/user.ts": 'import { heavy } from "./heavy.js";\nexport const user = heavy;\n',
  "scripts/spawner.mjs": 'spawnSync(process.execPath, [join(ROOT, "src", "heavy.ts")]);\n',
  "test/table.test.ts": 'import { SITES } from "../src/table.js";\n',
  "test/user.test.ts": 'import { user } from "../src/user.js";\n',
  "test/heavy.test.ts": 'import { heavy } from "../src/heavy.js";\n',
  "test/spawns-heavy.test.ts": 'spawnSync(process.execPath, ["--import", "tsx", "src/heavy.ts"]);\n',
  "test/spawner.test.ts": 'spawnSync(process.execPath, [join(ROOT, "scripts", "spawner.mjs")]);\n',
  "test/reads-doc.test.ts": 'readFileSync("docs/guide.md", "utf8");\n',
};

const select = (changed: string[], over: Partial<affected.AffectedSuitesInput> = {}) =>
  affected.selectAffectedSuites(changed, { files: new Map(Object.entries(TREE)), pathReaders: [], ...over });

test("a changed test file's own declarations name no symbol suites", () => {
  const files: Record<string, string> = {
    "test/x.test.ts": "import { test } from 'node:test';\nconst one = 1;\nconst base = 'b';\ntest('x', () => {});\n",
    "src/heavy.ts": "export const heavy = 2;\n",
  };
  const testOnly = "+++ b/test/x.test.ts\n@@ -2,0 +2,2 @@\n+const one = 1;\n+const base = 'b';\n";
  assert.deepEqual(affected.changedSymbols(testOnly, (p) => files[p]!), [], "a test's locals are namesakes of nothing");
  // Control: the same diff with a src hunk still names the src declaration it touches.
  const both = testOnly + "+++ b/src/heavy.ts\n@@ -1 +1 @@\n-export const heavy = 1;\n+export const heavy = 2;\n";
  assert.deepEqual(affected.changedSymbols(both, (p) => files[p]!), ["heavy"]);
  // The changed test still selects itself in both arms.
  const sel = select(["test/x.test.ts"], { files: new Map(Object.entries(files)), symbolSuites: [] });
  assert.deepEqual(sel.suites, ["test/x.test.ts"]);
  assert.deepEqual(sel.narrow, ["test/x.test.ts"]);
});

test("a src path written as a string in a src module is not an import edge", () => {
  const sel = select(["src/heavy.ts"], { symbolSuites: ["test/heavy.test.ts"] });
  assert.ok(!sel.suites.includes("test/table.test.ts"), "src/table.ts only NAMES src/heavy.ts as data");
  assert.ok(!sel.reasons.some((r) => r.startsWith("test/table.test.ts")));
  assert.ok(!sel.narrow!.includes("test/table.test.ts"));
});

test("soundness: a real import edge from a test to a changed src module still selects that test", () => {
  const sel = select(["src/heavy.ts"], { symbolSuites: ["test/heavy.test.ts"] });
  assert.ok(sel.reasons.includes("test/heavy.test.ts: reaches src/heavy.ts"), "a direct import");
  assert.ok(sel.reasons.includes("test/user.test.ts: reaches src/heavy.ts"), "an import two hops away");
  // Paths a TEST or SCRIPT names are real reads: a spawned module, a script that spawns it.
  assert.ok(sel.reasons.includes("test/spawns-heavy.test.ts: reaches src/heavy.ts"));
  assert.ok(sel.reasons.includes("test/spawner.test.ts: reaches src/heavy.ts"));
  // The narrow arm keeps the suite that names the changed file by path, beside the symbol reach.
  assert.deepEqual(sel.narrow, ["test/heavy.test.ts", "test/spawns-heavy.test.ts"]);
});

test("soundness: a test that reads a changed non-code file by path is still selected", () => {
  const sel = select(["docs/guide.md"], { pathReaders: ["test/reads-doc.test.ts"], symbolSuites: [] });
  assert.equal(sel.fullRun, false);
  assert.deepEqual(sel.suites, ["test/reads-doc.test.ts"]);
  assert.deepEqual(sel.narrow, ["test/reads-doc.test.ts"]);
});

test("W1-T6338: dashboard and settings changes select the view schema suite in the narrow arm", () => {
  const suite = "test/every-view-body-matches-its-schema.test.ts";
  const edges = ["src/lib/repo-dashboard-route.ts", "test/repo-settings-report-their-effective-values.test.ts"];
  const files = new Map<string, string>([
    [suite, 'import { test } from "node:test";\n'],
    ...edges.map((path): [string, string] => [path, 'export const value = 1;\n']),
    ["src/lib/unrelated.ts", 'export const value = 2;\n'],
  ]);
  const selectEdge = (changed: string[], tree = files) =>
    affected.selectAffectedSuites(changed, { files: tree, pathReaders: [], symbolSuites: [] });

  for (const edge of edges) {
    const selected = selectEdge([edge]);
    assert.equal(selected.fullRun, false);
    assert.ok(selected.narrow?.includes(suite), `${edge} must select ${suite}`);
    assert.ok(selected.suites.includes(suite), `${edge} must select ${suite} in the floor`);
  }
  assert.ok(!selectEdge(["src/lib/unrelated.ts"]).narrow?.includes(suite));
  assert.ok(!selectEdge(edges, new Map([...files].filter(([path]) => path !== suite))).narrow?.includes(suite));
});

test("W1-T6339: dashboard and settings changes select the view etag suite in the narrow arm", () => {
  const suite = "test/view-etags-are-deterministic.test.ts";
  const edges = ["src/lib/repo-dashboard-route.ts", "test/repo-settings-report-their-effective-values.test.ts"];
  const files = new Map<string, string>([
    [suite, 'import { test } from "node:test";\n'],
    ...edges.map((path): [string, string] => [path, 'export const value = 1;\n']),
    ["src/lib/unrelated.ts", 'export const value = 2;\n'],
  ]);
  const selectEdge = (changed: string[], tree = files) =>
    affected.selectAffectedSuites(changed, { files: tree, pathReaders: [], symbolSuites: [] });

  for (const edge of edges) {
    const selected = selectEdge([edge]);
    assert.equal(selected.fullRun, false);
    assert.ok(selected.narrow?.includes(suite), `${edge} must select ${suite}`);
    assert.ok(selected.suites.includes(suite), `${edge} must select ${suite} in the floor`);
    assert.ok(selected.reasons.includes(`${suite}: reads a changed file by path`), `${edge} selects ${suite} by its recorded edge`);
  }
  assert.ok(!selectEdge(["src/lib/unrelated.ts"]).narrow?.includes(suite));
  assert.ok(!selectEdge(edges, new Map([...files].filter(([path]) => path !== suite))).narrow?.includes(suite));
});

test("an import-only or deleted source file names no symbol, so a caller knows to run the floor", () => {
  const files: Record<string, string> = { "src/user.ts": 'import { heavy } from "./heavy.js";\nexport const user = heavy;\n' };
  const read = (p: string) => {
    if (files[p] === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    return files[p]!;
  };
  const diff = [
    "diff --git a/src/user.ts b/src/user.ts", "--- a/src/user.ts", "+++ b/src/user.ts", "@@ -1 +1 @@",
    '-import { heavy } from "./heavy.ts";', '+import { heavy } from "./heavy.js";',
    "diff --git a/src/gone.ts b/src/gone.ts", "--- a/src/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-export const gone = 1;",
    "diff --git a/src/heavy.ts b/src/heavy.ts", "--- a/src/heavy.ts", "+++ b/src/heavy.ts", "@@ -1 +1 @@",
    "-export const heavy = 1;", "+export const heavy = 2;", "",
  ].join("\n");
  const withHeavy = (p: string) => (p === "src/heavy.ts" ? "export const heavy = 2;\n" : read(p));
  assert.deepEqual(
    affected.symbollessSourceFiles(["src/user.ts", "src/gone.ts", "src/heavy.ts", "test/x.test.ts", "docs/a.md"], diff, withHeavy),
    ["src/user.ts", "src/gone.ts"],
  );
});

test("a real source-template diff names its host owner, not child-program declarations", t => {
  const fixture = gitRepo({ kind: "selector-template", scope: t });
  const root = fixture.dir, git = (args: string[]) => fixture.git(...args);
  mkdirSync(join(root, "src"));
  const path = join(root, "src", "generated.ts");
  const source = [
    'export const CHILD_CHECK = `',
    'const root = "child";',
    'const build = await import("private-child-module");',
    '${(() => {',
    'const holeLocal = 1;',
    'return `nested ${liveCall()}`;',
    '})()}',
    '`;',
    'export function actualLater() { return 1; }',
    '',
  ].join("\n");
  writeFileSync(path, source); git(["add", "src/generated.ts"]);
  git(["commit", "-qm", "base"]);
  writeFileSync(path, source.replace('"child"', '"changed child"').replace('holeLocal = 1', 'holeLocal = 2'));
  const diff = git(["diff", "-U0", "--", "src/generated.ts"]);
  assert.match(diff, /const root/); assert.match(diff, /holeLocal = 2/);
  assert.deepEqual(affected.changedSymbols(diff, relative => readFileSync(join(root, relative), "utf8")), ["CHILD_CHECK"]);
});

test("source declarations keep real owners and line mappings past comments, regexes and nested scopes", () => {
  const lines = ['/*', 'const commentName = 1;', '*/',
    'export function Owner() {', 'const nestedLocal = 1;', 'return /`/.test(value);', '}',
    'export class ActualClass {', 'method() { return 1; }', '}',
    'export interface ActualInterface {', 'value: number;', '}',
    'export type ActualType = {', 'value: number;', '};',
    'export const raw = "const stringName = 1;";', ''];
  const source = lines.join("\r\n");
  for (const [line, expected] of [[5, "Owner"], [9, "ActualClass"], [12, "ActualInterface"], [15, "ActualType"], [17, "raw"]] as const) {
    const diff = `+++ b/src/private.ts\n@@ -${line} +${line} @@\n`;
    assert.deepEqual(affected.changedSymbols(diff, () => source), [expected]);
  }
});

test("unknown lexical source causes the existing conservative full selection, not a success-shaped empty set", () => {
  for (const source of ['if (ready) {} /`/.test(value);\nexport function actualLater() {}\n',
    'await / liveCall() /g;\nexport function actualLater() {}\n']) {
    const diff = '+++ b/src/private.ts\n@@ -2 +2 @@\n';
    const result = affected.affectedSelectionOrFull(["src/private.ts"], () => {
      affected.changedSymbols(diff, () => source);
      return { files: new Map([["src/private.ts", source]]), pathReaders: [], symbolSuites: [] };
    });
    assert.equal(result.fullRun, true);
    assert.match(result.reasons.join("\n"), /lexical context unknown/);
    assert.match(result.reasons.join("\n"), /changed-symbols "src\/private\.ts":/);
    assert.deepEqual(result.suites, []);
  }
});

test("changed-symbol lexical fallback names the actual file and retains its cause", () => {
  const reads: string[] = [];
  const diff = '+++ b/src/first.ts\n@@ -1 +1 @@\n+++ b/src/with space.ts\n@@ -1 +1 @@\n';
  assert.throws(() => affected.changedSymbols(diff, path => {
    reads.push(path);
    return path === "src/first.ts" ? "export const known = 1;" : "await / liveCall() /g;";
  }), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /^changed-symbols "src\/with space\.ts": lexical context unknown at line 1 /);
    assert(error.cause instanceof Error);
    assert.match(error.cause.message, /^lexical context unknown at line 1 /);
    return true;
  });
  assert.deepEqual(reads, ["src/first.ts", "src/with space.ts"]);
});

test("changed-symbol diagnostics preserve non-lexical read errors and confirmed deletion semantics", () => {
  const diff = '+++ b/src/private.ts\n@@ -1 +1 @@\n';
  const denied = Object.assign(new Error("owned fixture denied"), { code: "EACCES" });
  assert.throws(() => affected.changedSymbols(diff, () => { throw denied; }), error => error === denied);
  assert.deepEqual(affected.changedSymbols(diff, () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); }), []);
});
