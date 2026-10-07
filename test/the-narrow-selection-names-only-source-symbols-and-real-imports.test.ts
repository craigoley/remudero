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
  const sel = select(["test/x.test.ts"], { symbolSuites: [] });
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
