/**
 * W1-T6083 — each test file's executed source blocks, recorded from a coverage run, select suites in
 * SHADOW beside the floor and the narrow arm (src/lib/test-impact-map.ts).
 *
 * The first tests run REAL V8 coverage over a fixture tree, through coverage-merge-ratchet's own
 * compaction and its --impact-map mode, so the map's function placement is the source map's, not a
 * hand-written guess. The rest pin each soundness rule on small synthetic maps.
 *
 * NODE_V8_COVERAGE: the fixture processes are given a coverage directory of their OWN on purpose —
 * that directory is the thing under test. Every other child here blanks it with `= ""`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { selectAffectedSuites, shadowRecord, stripComments, type AffectedSuitesInput } from "../src/lib/affected-suites.js";
import {
  buildImpactMap,
  decodeMappings,
  IMPACT_MAP_FORMAT,
  impactArmSelection,
  impactDrift,
  impactTouches,
  inertLines,
  readImpactArmInput,
  readImpactMap,
  spawningSuites,
  type CoverageProcessReport,
  type ImpactArmContext,
  type ImpactArmInput,
  type ImpactMap,
} from "../src/lib/test-impact-map.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";
// @ts-expect-error -- plain .mjs script, no type declarations
import * as ratchet from "../scripts/coverage-merge-ratchet.mjs";
// @ts-expect-error -- plain .mjs script, no type declarations
import * as shadowScript from "../scripts/select-affected-suites.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = import.meta.resolve("tsx");
const MERGER = join(REPO_ROOT, "scripts", "coverage-merge-ratchet.mjs");

/** src/m.ts — the line numbers below are the assertions' coordinates. */
const M_TS = [
  "// header comment", //                                 1
  'import { join } from "node:path";', //                 2
  "", //                                                   3
  "export interface Shape {", //                           4
  "  size: number;", //                                    5
  "}", //                                                  6
  "", //                                                   7
  'export const LIMIT = join("a", "b").length;', //       8
  "", //                                                   9
  "export function used(n: number): number {", //         10
  "  const total = n + LIMIT;", //                         11
  "  return total;", //                                    12
  "}", //                                                  13
  "", //                                                   14
  "export function unused(n: number): number {", //       15
  "  return n * 2;", //                                    16
  "}", //                                                  17
  "",
].join("\n");
/** src/tool.mjs — native ESM, so V8 reports it WITHOUT a source map. */
const TOOL_MJS = ["export function hello() {", '  return "hi";', "}", "export const X = 1;", ""].join("\n");

const A = "test/a.test.ts";
const B = "test/b.test.ts";

/** Runs the fixture suites under real V8 coverage, compacts the raw reports the way a CI coverage
 *  shard does, and builds the impact map from the compact corpus with the real CLI. */
function realImpactMap(): { map: ImpactMap; dir: string; raw: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t6083-`));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  mkdirSync(join(dir, "raw"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  copyFileSync(join(REPO_ROOT, ".nvmrc"), join(dir, ".nvmrc"));
  writeFileSync(join(dir, "src/m.ts"), M_TS);
  writeFileSync(join(dir, "src/tool.mjs"), TOOL_MJS);
  // A executes used() and hello(), and spawns src/tool.mjs (an ORPHAN report: it names no suite).
  writeFileSync(join(dir, A), [
    'import { spawnSync } from "node:child_process";',
    'import { used } from "../src/m.js";',
    'import { hello } from "../src/tool.mjs";',
    "used(1); hello();",
    'spawnSync(process.execPath, ["src/tool.mjs"]);',
    "",
  ].join("\n"));
  // B only LOADS src/m.ts.
  writeFileSync(join(dir, B), 'import "../src/m.js";\n');
  for (const suite of [A, B]) {
    const r = spawnSync(process.execPath, ["--import", TSX, suite], {
      cwd: dir, encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: join(dir, "raw") },
    });
    assert.equal(r.status, 0, r.stderr);
  }
  const blank = { ...process.env, NODE_V8_COVERAGE: "" };
  const compact = spawnSync(process.execPath, ["--expose-internals", MERGER, "--compact-output", "compact", "raw"], { cwd: dir, encoding: "utf8", env: blank });
  assert.equal(compact.status, 0, compact.stderr);
  const built = spawnSync(process.execPath, ["--import", TSX, MERGER, "--impact-map", "map.json", "--sha", "f".repeat(40), "--source-root", dir, "compact"], {
    cwd: dir, encoding: "utf8", env: blank,
  });
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /impact map of \d+ process report\(s\): 2 suite\(s\)/);
  return { map: JSON.parse(readFileSync(join(dir, "map.json"), "utf8")) as ImpactMap, dir, raw: join(dir, "raw") };
}

const fixture = realImpactMap();
test.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

const suitesOf = (map: ImpactMap, ids: readonly number[]) => ids.map((i) => map.suites[i]);

/** A `git diff -U0` section editing `oldStart..+oldCount` of `path`. */
const diffOf = (path: string, hunks: string[], newPath = path) =>
  `diff --git a/${path} b/${newPath}\n--- a/${path}\n+++ ${newPath === "/dev/null" ? "/dev/null" : `b/${newPath}`}\n${hunks.join("\n")}\n`;

const FIXTURE_FILES = new Map([
  ["src/m.ts", M_TS], ["src/tool.mjs", TOOL_MJS],
  [A, 'import { used } from "../src/m.js";\n'], [B, 'import "../src/m.js";\n'],
]);

function armFor(map: ImpactMap, diffText: string, over: Partial<ImpactArmInput> = {}, ctx: Partial<ImpactArmContext> = {}) {
  return impactArmSelection(
    { map, diffText, drift: { distance: 0, changedSinceMap: [] }, baseText: (p) => FIXTURE_FILES.get(p), ...over },
    { changed: ["src/m.ts"], files: FIXTURE_FILES, floor: [A, B], pathReaders: [], pathNamers: [], recent: [], fallback: ["test/narrow.test.ts"], ...ctx },
  );
}

test("W1-T6083: the impact map credits a function body only to the suites that executed it, not to those that only loaded its module", () => {
  const { map } = fixture;
  assert.equal(map.format, IMPACT_MAP_FORMAT);
  assert.deepEqual(map.suites, [A, B]);
  const m = map.files["src/m.ts"]!;
  assert.deepEqual(suitesOf(map, m.loadedBy), [A, B], "both suites LOADED src/m.ts");
  const used = m.functions.find((r) => r[0] === 10 && r[1] === 13);
  const unused = m.functions.find((r) => r[0] === 15 && r[1] === 17);
  assert.ok(used && unused, `used() and unused() placed on their source lines: ${JSON.stringify(m.functions)}`);
  assert.deepEqual(suitesOf(map, used.slice(2)), [A], "only A executed used()");
  assert.deepEqual(unused.slice(2), [], "nobody executed unused()");
  // The unmapped native script is placed from its own text (--source-root).
  const tool = map.files["src/tool.mjs"]!;
  assert.deepEqual(suitesOf(map, tool.loadedBy), [A]);
  assert.deepEqual(tool.functions.find((r) => r[0] === 1 && r[1] === 3)?.slice(2), [0]);
  assert.ok(map.orphanReports >= 1, "the spawned child's report names no suite and is counted, not credited");
});

test("W1-T6083: the coverage arm selects a suite that executed a changed function body and skips one that only loaded the module", () => {
  const arm = armFor(fixture.map, diffOf("src/m.ts", ["@@ -11 +11 @@", "-  const total = n + LIMIT;", "+  const total = n + LIMIT + 1;"]));
  assert.equal(arm.fallback, undefined);
  assert.deepEqual(arm.suites, [A]);
  assert.match(arm.reasons[0]!, /executed src\/m\.ts:10-13/);
  // An insertion inside the body places the same way.
  const inserted = armFor(fixture.map, diffOf("src/m.ts", ["@@ -11,0 +12 @@", "+  void 0;"]));
  assert.deepEqual(inserted.suites, [A]);
  // A body nobody executed selects nobody.
  assert.deepEqual(armFor(fixture.map, diffOf("src/m.ts", ["@@ -16 +16 @@", "-  return n * 2;", "+  return n * 3;"])).suites, []);
});

test("W1-T6083: an edit to an exported module-scope binding selects every suite that loaded the module", () => {
  const arm = armFor(fixture.map, diffOf("src/m.ts", ["@@ -8 +8 @@", "-old", "+export const LIMIT = 4;"]));
  assert.deepEqual(arm.suites, [A, B]);
  assert.match(arm.reasons.join("\n"), /loads src\/m\.ts \(module-scope edit\)/);
  // A function's declaration line is the exported binding, not its body: every loader.
  assert.deepEqual(armFor(fixture.map, diffOf("src/m.ts", ["@@ -10 +10 @@", "-a", "+export function used(n: number, k = 0): number {"])).suites, [A, B]);
  // Deleting or renaming the module reaches every loader too.
  assert.deepEqual(armFor(fixture.map, diffOf("src/m.ts", ["@@ -1,17 +0,0 @@"], "/dev/null")).suites, [A, B]);
  assert.deepEqual(armFor(fixture.map, diffOf("src/m.ts", ["@@ -1 +1 @@"], "src/moved.ts")).suites, [A, B]);
});

test("W1-T6083: an impact map older than its staleness bound falls back to the narrow selection and names the fallback", () => {
  const diffText = diffOf("src/m.ts", ["@@ -11 +11 @@", "-a", "+b"]);
  const stale = armFor(fixture.map, diffText, { drift: { distance: 151, changedSinceMap: [] } });
  assert.deepEqual(stale.suites, ["test/narrow.test.ts"]);
  assert.match(stale.fallback!, /stale: 151 commits behind the base, past its bound of 150/);
  assert.equal(armFor(fixture.map, diffText, { drift: { distance: 150, changedSinceMap: [] } }).fallback, undefined, "at the bound it still speaks");
  // Through the selector: on a fallback the arm IS the narrow selection, and the shadow record says why.
  const input: AffectedSuitesInput = {
    files: FIXTURE_FILES, pathReaders: [], symbolSuites: [B],
    impact: { map: fixture.map, diffText, drift: { distance: 900, changedSinceMap: [] } },
  };
  const sel = selectAffectedSuites(["src/m.ts"], input);
  assert.deepEqual(sel.impact, sel.narrow);
  assert.match(sel.impactFallback!, /stale/);
  const record = shadowRecord(sel, [A]);
  assert.equal(record.impactSize, sel.narrow!.length);
  assert.match(record.impactFallback!, /stale/);
});

test("W1-T6083: the other fallbacks — no map, a base not descended from it, a non-code input, a drifted file, no diff — each name themselves", () => {
  const diffText = diffOf("src/m.ts", ["@@ -11 +11 @@", "-a", "+b"]);
  const cases: Array<[Partial<ImpactArmInput>, Partial<ImpactArmContext>, RegExp]> = [
    [{ map: undefined, mapProblem: "no impact map at /x" }, {}, /no impact map \(no impact map at \/x\)/],
    [{ map: undefined }, {}, /none supplied/],
    [{ drift: { changedSinceMap: [], problem: "HEAD does not descend" } }, {}, /not an ancestor of the base \(HEAD does not descend\)/],
    [{ drift: { changedSinceMap: [] } }, {}, /not an ancestor of the base \(unknown\)/],
    [{}, { changed: ["src/m.ts", "src/lib/config.yaml"] }, /non-code input src\/lib\/config\.yaml — the read map \(W1-T6084\)/],
    [{ drift: { distance: 3, changedSinceMap: ["src/m.ts"] } }, {}, /src\/m\.ts changed after the impact map's sha/],
    [{ diffText: "" }, {}, /no diff to place the change/],
  ];
  for (const [over, ctx, why] of cases) {
    const arm = armFor(fixture.map, diffText, over, ctx);
    assert.match(arm.fallback ?? "(none)", why);
    assert.deepEqual(arm.suites, ["test/narrow.test.ts"]);
  }
});

test("W1-T6083: changed tests select themselves, census path readers stay selected by path, and recent failures are labelled", () => {
  const arm = armFor(fixture.map, "", {}, {
    changed: ["test/new.test.ts"], floor: [], pathReaders: ["test/census.test.ts"], pathNamers: ["test/names.test.ts"], recent: ["test/flaky.test.ts"],
  });
  assert.equal(arm.fallback, undefined, "a test-only change needs no diff");
  assert.deepEqual(arm.suites, ["test/census.test.ts", "test/flaky.test.ts", "test/names.test.ts", "test/new.test.ts"]);
  assert.deepEqual(arm.recentOnly, ["test/flaky.test.ts"]);
  const record = shadowRecord({ suites: [], fullRun: false, reasons: [], recentOnly: { floor: [], impact: arm.recentOnly }, impact: arm.suites }, ["test/flaky.test.ts", "test/new.test.ts", "test/other.test.ts"]);
  assert.deepEqual(record.failures.map((f) => f.impact), ["flake", "selected", "missed"]);
});

test("W1-T6083: a suite that spawns children, or one the map never saw, is selected whenever the floor reaches it", () => {
  const files = new Map([
    ...FIXTURE_FILES,
    // W1-T6108: a spawner is a suite whose children run repo code, not one that merely imports child_process.
    ["test/spawns.test.ts", 'import { spawnSync } from "node:child_process";\nspawnSync(process.execPath, ["src/tool.mjs"]);\n'],
    ["test/via-helper.test.ts", 'import { run } from "./helpers/run.js";\n'],
    ["test/helpers/run.ts", 'import { spawnSync } from "node:child_process";\nexport const run = () => spawnSync(process.execPath, ["bin/rmd"]);\n'],
    ["test/git-only.test.ts", 'import { g } from "./helpers/git.js";\n'],
    ["test/helpers/git.ts", 'import { execFileSync } from "node:child_process";\nexport const g = () => execFileSync("git", ["status"]);\n'],
    ["test/unseen.test.ts", "export {};\n"],
  ]);
  assert.deepEqual([...spawningSuites(files)].sort(), ["test/spawns.test.ts", "test/via-helper.test.ts"], "a git-only helper spawns no repo code");
  const body = diffOf("src/m.ts", ["@@ -16 +16 @@", "-a", "+b"]);
  const reached = armFor(fixture.map, body, {}, { files, floor: [A, B, "test/spawns.test.ts", "test/via-helper.test.ts", "test/git-only.test.ts", "test/unseen.test.ts"] });
  assert.deepEqual(reached.suites, ["test/git-only.test.ts", "test/spawns.test.ts", "test/unseen.test.ts", "test/via-helper.test.ts"]);
  assert.match(reached.reasons.join("\n"), /spawns repo code but the map credits it no child report/);
  assert.match(reached.reasons.join("\n"), /absent from the impact map/);
  assert.deepEqual(armFor(fixture.map, body, {}, { files, floor: [] }).suites, [], "nothing the floor does not reach");
  // A suite changed after the map's sha is stale in it: the floor's reach selects it.
  const drifted = armFor(fixture.map, body, { drift: { distance: 2, changedSinceMap: [B] } });
  assert.deepEqual(drifted.suites, [B]);
});

test("W1-T6083: comment, blank, import and type-only edits are inert and select nothing", () => {
  const inert = inertLines(M_TS);
  for (const line of [1, 2, 3, 4, 5, 6, 7, 9, 14]) assert.ok(inert.has(line), `line ${line} is inert`);
  for (const line of [8, 10, 11, 12, 13, 15]) assert.ok(!inert.has(line), `line ${line} is code`);
  const multi = inertLines([
    "/* a", " * b */", "import {", "  x,", '} from "./x.js";', 'export * from "./y.js";', "export type { T };",
    "type U =", "  | 1", "  | 2;", "const live = `", "// in a template", "`;", 'const d = import("./z.js");', "",
  ].join("\n"));
  assert.deepEqual([...multi].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15]);
  for (const hunk of [["@@ -1 +1 @@", "-// old", "+// new"], ["@@ -5 +5 @@", "-  size: number;", "+  size: string;"], ["@@ -2 +2 @@", "-a", "+b"]]) {
    assert.deepEqual(armFor(fixture.map, diffOf("src/m.ts", hunk), {}, { files: new Map([...FIXTURE_FILES, ["src/m.ts", M_TS.replace("size: number", "size: string")]]) }).suites, [], hunk.join(" "));
  }
  const blankAdded = M_TS.split("\n");
  blankAdded.splice(9, 0, "");
  assert.deepEqual(armFor(fixture.map, diffOf("src/m.ts", ["@@ -9,0 +10 @@", "+"]), {}, { files: new Map([...FIXTURE_FILES, ["src/m.ts", blankAdded.join("\n")]]) }).suites, [], "an inserted blank line");
  // New code replacing a comment lands where the comment was: module scope here.
  const head = new Map([...FIXTURE_FILES, ["src/m.ts", M_TS.replace("// header comment", "sideEffect();")]]);
  assert.deepEqual(armFor(fixture.map, diffOf("src/m.ts", ["@@ -1 +1 @@", "-// header comment", "+sideEffect();"]), {}, { files: head }).suites, [A, B]);
  // Without the base text nothing is inert: the edit is placed, conservatively.
  assert.deepEqual(armFor(fixture.map, diffOf("src/m.ts", ["@@ -5 +5 @@"]), { baseText: undefined }, { files: new Map() }).suites, [A, B]);
  // stripComments keeps its old one-space block replacement unless asked to keep lines.
  assert.equal(stripComments("a/* x\ny */b"), "a b");
  assert.equal(stripComments("a/* x\ny */b", { keepLines: true }), "a\nb");
  assert.equal(stripComments("a/**/b", { keepLines: true }), "a b");
});

test("W1-T6083: impactTouches skips new and non-code files and leaves unmapped files to the floor's spawners", () => {
  const diffText = diffOf("/dev/null", ["@@ -0,0 +1 @@"], "src/new.ts").replace("--- a//dev/null", "--- /dev/null") +
    diffOf("docs/x.md", ["@@ -1 +1 @@"]) + diffOf("src/never-loaded.ts", ["@@ -1 +1 @@"]);
  const touches = impactTouches(diffText, fixture.map, { base: () => undefined, head: () => undefined });
  assert.deepEqual(touches, [{ path: "src/never-loaded.ts", moduleScope: true, functions: [] }]);
  assert.deepEqual(armFor(fixture.map, diffText, {}, { changed: ["src/new.ts", "src/never-loaded.ts"] }).suites, []);
});

test("W1-T6083: the builder refuses a map of nothing, counts orphans, and reads raw reports with no recorded suite", () => {
  assert.throws(() => buildImpactMap([{ result: [] }], { sha: "s", root: fixture.dir }), /no process report names a suite \(1 orphan/);
  const raw = readdirSync(fixture.raw).map((f) => JSON.parse(readFileSync(join(fixture.raw, f), "utf8")) as CoverageProcessReport);
  // V8 writes REAL paths (macOS /tmp is /private/tmp), so the root must be one too.
  const map = buildImpactMap(raw, { sha: "s", root: realpathSync(fixture.dir) });
  assert.deepEqual(map.suites, [A, B], "the suite is read from the report's own scripts");
  assert.ok(map.orphanReports >= 1);
  assert.deepEqual(map.files["src/m.ts"], fixture.map.files["src/m.ts"], "raw and compacted reports build the same map");
  assert.deepEqual(map.files["src/tool.mjs"]!.functions, [], "an unmapped script with no source text records its loaders only");
  // A compaction-recorded identity wins, under its own recorded root.
  const moved = buildImpactMap([{ test: "test/x.test.ts", root: "file:///elsewhere/", result: [{ url: "file:///elsewhere/src/q.ts", functions: [] }] }], { sha: "s", root: "file:///here" });
  assert.deepEqual(Object.keys(moved.files), ["src/q.ts"]);
  assert.throws(() => decodeMappings("A!"), /invalid base64 character "!"/);
  assert.deepEqual(decodeMappings("AAAA,CAAC;AACA"), [[[0, 0], [1, 0]], [[0, 1]]]);
});

test("W1-T6083: compaction records which suite each process ran, and the impact-map mode refuses a bad call", async () => {
  const url = pathToFileURL(join(REPO_ROOT, A)).href;
  assert.deepEqual(ratchet.reportSuiteIdentity([{ url: "node:fs" }, { url: pathToFileURL(join(REPO_ROOT, "src/x.ts")).href }, { url }], REPO_ROOT),
    { test: A, root: pathToFileURL(REPO_ROOT + "/").href });
  assert.deepEqual(ratchet.reportSuiteIdentity([{ url: pathToFileURL(join(REPO_ROOT, "src/x.ts")).href }], REPO_ROOT), {}, "a spawned child names no suite");
  await assert.rejects(ratchet.writeImpactMap([], "out.json", { sha: "s" }), /at least one coverage directory/);
  await assert.rejects(ratchet.writeImpactMap(["compact"], "out.json", {}), /requires --sha/);
  const both = spawnSync(process.execPath, [MERGER, "--output", "a", "--impact-map", "b", "raw"], { cwd: fixture.dir, encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: "" } });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /exactly one of --output, --compact-output or --premap-output is required, or --impact-map alone/);
  // In process: the CLI's impact-map mode over the compact corpus equals the spawned build; a
  // source root missing the file places nothing for it; one that cannot be read fails the build.
  const out = join(fixture.dir, "map-nosrc.json");
  const cwd = process.cwd();
  const logs: string[] = [];
  const log = console.log;
  mkdirSync(join(fixture.dir, "weird", "src", "tool.mjs"), { recursive: true });
  process.chdir(fixture.dir);
  console.log = (line: string) => logs.push(line);
  try {
    await ratchet.main(["--impact-map", "map-inproc.json", "--sha", "f".repeat(40), "--source-root", fixture.dir, "compact"]);
    assert.match(logs.join("\n"), /impact map of \d+ process report\(s\): 2 suite\(s\), 2 source file\(s\), \d+ orphan report\(s\) -> map-inproc\.json/);
    await assert.rejects(ratchet.main(["--compact-output", "x", "--impact-map", "y", "raw"]), /or --impact-map alone/);
    const r = await ratchet.writeImpactMap([fixture.raw], out, { sha: "s", sourceRoot: join(fixture.dir, "nowhere") });
    assert.equal(r.suites, 2);
    await assert.rejects(ratchet.writeImpactMap([fixture.raw], out, { sha: "s", sourceRoot: join(fixture.dir, "weird") }), /EISDIR/);
  } finally {
    console.log = log;
    process.chdir(cwd);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.dir, "map-inproc.json"), "utf8")), fixture.map);
  assert.deepEqual((JSON.parse(readFileSync(out, "utf8")) as ImpactMap).files["src/tool.mjs"]!.functions, []);
});

test("W1-T6083: readImpactMap names every reason a map is unusable", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t6083-read-`));
  try {
    assert.match(readImpactMap(join(dir, "none.json")).problem!, /no impact map at/);
    assert.match(readImpactMap(dir).problem!, /unreadable/);
    writeFileSync(join(dir, "bad.json"), "{");
    assert.match(readImpactMap(join(dir, "bad.json")).problem!, /is not JSON/);
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ ...fixture.map, suites: [] }));
    assert.match(readImpactMap(join(dir, "empty.json")).problem!, /is not a non-empty rmd-test-impact-map-v1 map/);
    writeFileSync(join(dir, "ok.json"), JSON.stringify(fixture.map));
    assert.deepEqual(readImpactMap(join(dir, "ok.json")).map, fixture.map);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T6083: impactDrift measures the map's distance with real git, and names a base that does not descend from it", () => {
  const repo = gitRepo();
  try {
    writeFileSync(join(repo.dir, "a.txt"), "1\n");
    repo.git("add", "a.txt");
    repo.git("commit", "-q", "-m", "one");
    const mapSha = repo.git("rev-parse", "HEAD");
    writeFileSync(join(repo.dir, "src.ts"), "x\n");
    repo.git("add", "src.ts");
    repo.git("commit", "-q", "-m", "two");
    assert.deepEqual(impactDrift(repo.dir, mapSha, "HEAD"), { distance: 1, changedSinceMap: ["src.ts"] });
    const branch = repo.git("rev-parse", "--abbrev-ref", "HEAD");
    repo.git("checkout", "-q", "--orphan", "other");
    repo.git("commit", "-q", "--allow-empty", "-m", "unrelated");
    assert.match(impactDrift(repo.dir, mapSha, "HEAD").problem!, /does not descend from/);
    assert.match(impactDrift(repo.dir, "0".repeat(40), "HEAD").problem!, /git merge-base failed/);
    const failing = (cmd: string, args: string[]) => ({ status: args[0] === "merge-base" ? 0 : 128, stdout: "", stderr: "boom" });
    assert.match(impactDrift(repo.dir, mapSha, "HEAD", failing).problem!, /could not measure the drift: boom/);
    // The checkout reader: the map from disk, its drift, and base texts through git show.
    repo.git("checkout", "-q", branch);
    const mapPath = join(repo.dir, "map.json");
    writeFileSync(mapPath, JSON.stringify({ ...fixture.map, sha: mapSha }));
    const input = readImpactArmInput(repo.dir, mapPath, "HEAD", "d");
    assert.equal(input.drift.distance, 1);
    assert.equal(input.baseText!("src.ts"), "x\n");
    assert.equal(input.baseText!("missing.ts"), undefined);
    const none = readImpactArmInput(repo.dir, join(repo.dir, "absent.json"), "HEAD", "");
    assert.match(none.mapProblem!, /no impact map at/);
    assert.equal(none.map, undefined);
  } finally { repo.cleanup(); }
});

test("W1-T6083: the shadow CLI records the impact arm beside the floor and the narrow arm", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t6083-cli-`));
  const logs: string[] = [];
  const log = console.log;
  console.log = (line: string) => logs.push(line);
  try {
    const self = "test/each-test-files-executed-source-blocks-select-in-shadow.test.ts";
    writeFileSync(join(dir, "changed.txt"), `${self}\n`);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
    writeFileSync(join(dir, "map.json"), JSON.stringify({ ...fixture.map, sha: head }));
    const status = shadowScript.main(["--changed-files", join(dir, "changed.txt"), "--impact-map", join(dir, "map.json"), "--base", "HEAD"], { root: REPO_ROOT, summaryPath: join(dir, "summary.md") });
    assert.equal(status, 0);
    const record = JSON.parse(logs.find((l) => l.startsWith("AFFECTED-SUITES-SHADOW: "))!.slice("AFFECTED-SUITES-SHADOW: ".length));
    assert.equal(record.impactFallback, undefined);
    assert.ok(record.impactSize >= 1 && record.impactSize <= record.floorSize, JSON.stringify(record));
    assert.match(readFileSync(join(dir, "summary.md"), "utf8"), /\d+ impact/);
    logs.length = 0;
    shadowScript.main(["--changed-files", join(dir, "changed.txt"), "--impact-map", join(dir, "absent.json")], { root: REPO_ROOT, summaryPath: undefined });
    assert.match(logs.join("\n"), /impact \(fallback\)/);
    assert.match(logs.join("\n"), /impact arm fell back to the narrow selection: no impact map/);
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
});
