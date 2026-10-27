// @source-text-subject: this suite's subject is the import specifiers in tracked test files and package.json's imports map.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  affectedSelectionOrFull,
  buildAffectedSuitesGraph,
  readPackageImports,
  selectAffectedSuites,
} from "#src/lib/affected-suites.js";
import { coverageNarrowSuites } from "#src/lib/coverage-narrow.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ALIASES = { "#src/*": "./src/*", "#scripts/*": "./scripts/*", "#test/*": "./test/*" };
const CODE = /\.(?:ts|mts|mjs|js|cjs)$/;

const fixture = (extra: Record<string, string> = {}) => new Map<string, string>(Object.entries({
  "src/run-task.ts": "export const run = 1;",
  "test/alias.test.ts": 'import { run } from "#src/run-task.js";\nrun;',
  "test/relative.test.ts": 'import { run } from "../src/run-task.js";\nrun;',
  ...extra,
}));

/** A scratch root holding only a package.json whose `imports` is `imports` (or whose body is `raw`). */
function packageRoot(t: { after: (fn: () => void) => void }, imports: unknown, raw?: string): string {
  const repo = gitRepo({ scope: t, kind: "w10820-package-root", seedCommit: false });
  writeFileSync(join(repo.dir, "package.json"), raw ?? JSON.stringify({ name: "fixture", imports }));
  return repo.dir;
}

test("W1-T10820: a suite importing #src/run-task.js is selected for a change to src/run-task.ts", () => {
  const files = fixture();
  const graph = buildAffectedSuitesGraph(files);
  assert.deepEqual([...graph.directImports.get("test/alias.test.ts")!], ["src/run-task.ts"]);
  assert.deepEqual([...graph.directImports.get("test/relative.test.ts")!], ["src/run-task.ts"]);
  const selected = selectAffectedSuites(["src/run-task.ts"], { files, pathReaders: [] });
  assert.equal(selected.fullRun, false);
  assert.deepEqual(selected.suites, ["test/alias.test.ts", "test/relative.test.ts"]);
  // Two hops: an alias suite reaching src/run-task.ts through a module that imports it by alias.
  const hop = fixture({ "src/mid.ts": 'export { run } from "#src/run-task.js";', "test/hop.test.ts": 'import "#src/mid.js";' });
  assert.ok(selectAffectedSuites(["src/run-task.ts"], { files: hop, pathReaders: [] }).suites.includes("test/hop.test.ts"));
});

test("W1-T10820: the alias targets are read from package.json imports", (t) => {
  const files = fixture({ "src/lib/a.ts": "export {};", "test/uses.test.ts": 'import "#lib/a"; import "#entry"; import "#src/run-task.js";' });
  const root = packageRoot(t, { "#lib/*": "./src/lib/*.ts", "#entry": "./src/run-task.ts" });
  const direct = [...buildAffectedSuitesGraph(files, [], { root }).directImports.get("test/uses.test.ts")!].sort();
  assert.deepEqual(direct, ["src/lib/a.ts", "src/run-task.ts"], "a key this repo never declared resolves; #src is no key here, so it gives no edge");
  assert.deepEqual(readPackageImports(root), { "#lib/*": "./src/lib/*.ts", "#entry": "./src/run-task.ts" });
  // The same selector input, a different tree: the map follows the tree being graphed.
  const picked = selectAffectedSuites(["src/lib/a.ts"], { files, pathReaders: [], packageRoot: root });
  assert.deepEqual(picked.suites, ["test/uses.test.ts"]);
  assert.deepEqual(selectAffectedSuites(["src/lib/a.ts"], { files, pathReaders: [], packageRoot: REPO_ROOT }).suites, []);
  assert.deepEqual(Object.keys(readPackageImports(REPO_ROOT)).sort(), Object.keys(ALIASES).sort(), "control: the real map is the one the fixtures copy");
  // The longest matching pattern prefix wins, and an exact key beats a pattern.
  const rules = { "#a/*": "./src/*", "#a/deep/*": "./scripts/*", "#a/deep/exact": "./test/exact.test.ts" };
  const longest = buildAffectedSuitesGraph(new Map([
    ["src/x.ts", ""], ["scripts/y.mjs", ""], ["test/exact.test.ts", ""],
    ["test/p.test.ts", 'import "#a/x.js"; import "#a/deep/y.mjs"; import "#a/deep/exact";'],
  ]), [], rules);
  assert.deepEqual([...longest.directImports.get("test/p.test.ts")!].sort(), ["scripts/y.mjs", "src/x.ts", "test/exact.test.ts"]);
});

test("W1-T10820: #scripts and #test specifiers resolve like #src", () => {
  const files = new Map<string, string>([
    ["scripts/tool.mjs", "export {};"],
    ["test/helpers/h.ts", "export {};"],
    ["src/m.ts", "export {};"],
    ["test/s.test.ts", 'import "#scripts/tool.mjs"; import "#test/helpers/h.js"; import "#src/m.js";'],
    ["test/none.test.ts", 'import "#nope/m.js"; import "#src"; import "#src/gone.js"; import "#"; import "node:fs";'],
  ]);
  const graph = buildAffectedSuitesGraph(files, [], ALIASES);
  assert.deepEqual([...graph.directImports.get("test/s.test.ts")!].sort(), ["scripts/tool.mjs", "src/m.ts", "test/helpers/h.ts"]);
  assert.deepEqual([...graph.directImports.get("test/none.test.ts")!], [], "an unmatched # specifier, or one naming no file, gives no edge");
  // A tree that names no # specifier never reads a map, so even a missing one cannot fail it.
  assert.doesNotThrow(() => buildAffectedSuitesGraph(new Map([["src/a.ts", 'import "./b.js";'], ["src/b.ts", ""]]), [], { root: join(REPO_ROOT, "no-such-root") }));
});

test("W1-T10820: an imports target the resolver does not model is a named full run", (t) => {
  const files = fixture();
  const shapes: Array<[string, unknown]> = [
    ["a conditions object", { "#src/*": { default: "./src/*" } }],
    ["an array", { "#src/*": ["./src/*"] }],
    ["a target outside the package", { "#src/*": "../elsewhere/*" }],
    ["a bare package target", { "#src/*": "some-package" }],
  ];
  for (const [what, imports] of shapes) {
    assert.throws(() => buildAffectedSuitesGraph(files, [], imports as Record<string, unknown>), /does not model/, what);
    const root = packageRoot(t, imports);
    const selection = affectedSelectionOrFull(["src/run-task.ts"], () => ({ files, pathReaders: [], packageRoot: root }));
    assert.equal(selection.fullRun, true, what);
    assert.deepEqual(selection.suites, []);
    assert.match(selection.reasons[0]!, /full run: the selector could not read its input.*#src\/\*.*does not model/, what);
  }
  const unreadable = packageRoot(t, undefined, "{ not json");
  assert.throws(() => buildAffectedSuitesGraph(files, [], { root: unreadable }), new RegExp(`cannot read the package imports map from ${join(unreadable, "package.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.throws(() => readPackageImports(join(unreadable, "missing")), /cannot read the package imports map/);
  assert.throws(() => readPackageImports(packageRoot(t, undefined, '{"imports":["x"]}')), /not an object map/);
  assert.deepEqual(readPackageImports(packageRoot(t, undefined, "{}")), {}, "a package with no imports has no aliases");
  assert.throws(() => buildAffectedSuitesGraph(files, [], { "src/*": "./src/*" }), /not one the affected-suite resolver models/);
  assert.throws(() => buildAffectedSuitesGraph(files, [], { "#a/*/*": "./src/*" }), /not one the affected-suite resolver models/);
});

test("W1-T10820: coverage-narrow lists a #src importer as a direct importer", async (t) => {
  const repo = gitRepo({ scope: t, kind: "w10820-coverage-narrow" });
  mkdirSync(join(repo.dir, "test"), { recursive: true });
  writeFileSync(join(repo.dir, "test", "by-alias.test.ts"), 'import { small } from "#src/lib/small.js";\nsmall();\n');
  writeFileSync(join(repo.dir, "test", "by-path.test.ts"), 'import { small } from "../src/lib/small.js";\nsmall();\n');
  writeFileSync(join(repo.dir, "test", "unrelated.test.ts"), 'import { other } from "#src/lib/other.js";\nother();\n');
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "tree");
  assert.deepEqual(await coverageNarrowSuites(repo.dir, ["src/lib/small.ts"]), ["test/by-alias.test.ts", "test/by-path.test.ts"]);
});

test("W1-T10820: on the real tree every suite importing #src/run-task.js is an importer of src/run-task.ts", () => {
  const tracked = execFileSync("git", ["ls-files", "--", "src", "scripts", "bin", "test"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n").filter((p) => p !== "" && CODE.test(p));
  const files = new Map(tracked.map((p) => [p, readFileSync(join(REPO_ROOT, p), "utf8")]));
  const aliasImporters = tracked.filter((p) => /^test\/.*\.test\.ts$/.test(p) && /\bfrom\s*["']#src\/run-task\.js["']/.test(files.get(p)!));
  assert.ok(aliasImporters.length > 0, "control: the population is non-empty — a suite imports #src/run-task.js");
  const { importers, directImports } = buildAffectedSuitesGraph(files, [], { root: REPO_ROOT });
  const missing = aliasImporters.filter((p) => !directImports.get(p)?.has("src/run-task.ts") || !importers.get("src/run-task.ts")?.has(p));
  assert.deepEqual(missing, [], "every alias importer must be a direct importer of src/run-task.ts");
  const selected = new Set(selectAffectedSuites(["src/run-task.ts"], { files, pathReaders: [], packageRoot: REPO_ROOT }).suites);
  assert.deepEqual(aliasImporters.filter((p) => !selected.has(p)), [], "and the selector must pick each for a change to src/run-task.ts");
});
