/**
 * W1-T6108 — a child process a test spawns writes its coverage under that test's own directory, and
 * the impact map credits the child's executed blocks to the suite that spawned it.
 *
 * The first test runs CI's coverage invocation (`--experimental-test-coverage --test --import tsx
 * --import ./test/setup/tmp-hygiene.ts`) over a fixture tree, so what is proved is the runner's own
 * temp-directory copy as well as the setup's redirect: the child's report must survive that copy,
 * carry its spawning suite, and still count in the merged lcov.
 *
 * NODE_V8_COVERAGE: the fixture runner is given a coverage directory of its OWN on purpose — that
 * directory is the thing under test. The merger children inherit this process's (so their coverage
 * is credited here); none of them is a nested test runner.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Namespace imports, so the file LOADS where these exports do not exist yet and each test fails on
// its own assertion there, rather than the whole file failing to link.
import * as impactMap from "../src/lib/test-impact-map.js";
import type { ImpactArmContext, ImpactMap } from "../src/lib/test-impact-map.js";
import * as hygiene from "./setup/tmp-hygiene.js";
// @ts-expect-error -- plain .mjs script, no type declarations
import * as ratchet from "../scripts/coverage-merge-ratchet.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = import.meta.resolve("tsx");
const SETUP = join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts");
const MERGER = join(REPO_ROOT, "scripts", "coverage-merge-ratchet.mjs");

const SPAWNER = "test/spawner.test.ts";
const GIT_ONLY = "test/git-only.test.ts";
const BLANKS = "test/blanks.test.ts";

/** src/child.mjs — run ONLY by the spawner's child, never loaded by a suite itself. */
const CHILD_MJS = [
  'import { writeFileSync } from "node:fs";', //            1
  "export function childOnly(n) {", //                       2
  "  return n + 1;", //                                      3
  "}", //                                                    4
  "export function neverRun(n) {", //                        5
  "  return n - 1;", //                                      6
  "}", //                                                    7
  'if (process.argv[2] === "run") {', //                    8
  "  childOnly(1);", //                                      9
  '  writeFileSync(process.argv[3], process.env.NODE_V8_COVERAGE ?? "");', // 10
  "}", //                                                    11
  "",
].join("\n");

const SUITES = new Map([
  [SPAWNER, [
    'import { execFileSync, spawnSync } from "node:child_process";',
    'const r = spawnSync(process.execPath, ["src/child.mjs", "run", "observed.txt"], { encoding: "utf8" });',
    "if (r.status !== 0) throw new Error(r.stderr);",
    'execFileSync("git", ["--version"]);',
    "",
  ].join("\n")],
  [GIT_ONLY, 'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["--version"]);\n'],
  [BLANKS, [
    'import { spawnSync } from "node:child_process";',
    'spawnSync(process.execPath, ["src/child.mjs"], { env: { ...process.env, NODE_V8_COVERAGE: "" } });',
    "",
  ].join("\n")],
]);

function buildFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-t6108-child-coverage-")));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  mkdirSync(join(dir, "raw"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  copyFileSync(join(REPO_ROOT, ".nvmrc"), join(dir, ".nvmrc"));
  writeFileSync(join(dir, "src/child.mjs"), CHILD_MJS);
  for (const [path, text] of SUITES) writeFileSync(join(dir, path), text);
  // CI's own coverage flags, over the fixture's three suites, with a raw directory of their own.
  const run = spawnSync(process.execPath, [
    "--enable-source-maps", "--experimental-test-coverage", "--test-coverage-exclude=test/**",
    "--test-reporter=lcov", "--test-reporter-destination=runner.lcov",
    "--test", "--import", TSX, "--import", SETUP, ...SUITES.keys(),
  ], { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: join(dir, "raw"), NODE_TEST_CONTEXT: undefined } });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.doesNotMatch(run.stderr, /Could not clean up code coverage/, "the runner copied its whole coverage directory");
  return { dir, raw: join(dir, "raw") };
}

const fixture = buildFixture();
test.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

/** The merger, as CI runs it, in the fixture tree. Its own coverage is inherited, so it counts. */
function merger(args: string[], node: string[] = ["--expose-internals"]) {
  const r = spawnSync(process.execPath, [...node, MERGER, ...args], { cwd: fixture.dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function readMap(name: string): ImpactMap {
  return JSON.parse(readFileSync(join(fixture.dir, name), "utf8")) as ImpactMap;
}

test("W1-T6108: the child writes under its suite's directory, and its report lands beside a record naming that suite", () => {
  const observed = readFileSync(join(fixture.dir, "observed.txt"), "utf8");
  assert.match(observed, new RegExp(`${hygiene.CHILD_COVERAGE_DIR_PREFIX}[^/]+/test/spawner\\.test\\.ts$`), `the child inherited ${observed}`);
  const names = readdirSync(fixture.raw);
  const records = names.filter((n) => n.startsWith("rmd-v8-children-"));
  assert.equal(records.length, 1, `exactly the spawner moved child reports: ${names.join(", ")}`);
  const record = JSON.parse(readFileSync(join(fixture.raw, records[0]!), "utf8")) as { format: string; suite: string; reports: string[] };
  assert.equal(record.format, hygiene.CHILD_COVERAGE_RECORD_FORMAT);
  assert.equal(record.suite, SPAWNER);
  assert.ok(record.reports.length >= 1);
  for (const report of record.reports) {
    assert.ok(names.includes(report), `${report} moved back into the flat directory`);
    const text = readFileSync(join(fixture.raw, report), "utf8");
    assert.match(text, /src\/child\.mjs/, `${report} is the child's own report`);
  }
  assert.deepEqual(names.filter((n) => !/^coverage-\d+-\d{13}-\d+\.json$/.test(n) && !records.includes(n)), [], "nothing else is left in it");
  // Every suite's own report is still in the flat directory, where it always was.
  for (const suite of SUITES.keys()) {
    assert.ok(names.some((n) => n.startsWith("coverage-") && readFileSync(join(fixture.raw, n), "utf8").includes(suite)), `${suite}'s own report`);
  }
});

test("W1-T6108: the impact map credits the child's executed blocks to the spawning suite, from compact and raw coverage alike", async () => {
  merger(["--compact-output", "compact", "raw"]);
  merger(["--impact-map", "map.json", "--sha", "f".repeat(40), "--source-root", fixture.dir, "compact"], ["--import", TSX]);
  const map = readMap("map.json");
  const spawner = map.suites.indexOf(SPAWNER);
  assert.ok(spawner >= 0);
  const child = map.files["src/child.mjs"];
  assert.ok(child, `src/child.mjs is in the map: ${Object.keys(map.files).join(", ")}`);
  assert.deepEqual(child.loadedBy, [spawner], "the child's load is the spawner's");
  assert.deepEqual(child.functions.find((r) => r[0] === 2 && r[1] === 4)?.slice(2), [spawner], "childOnly() is credited to the spawner");
  assert.deepEqual(child.functions.find((r) => r[0] === 5 && r[1] === 7)?.slice(2), [], "neverRun() to nobody");
  assert.deepEqual(map.spawnCredited, [spawner], "only the spawner is credited with a child's report");
  // The raw directory, read without compaction, credits the same.
  const cwd = process.cwd();
  process.chdir(fixture.dir);
  try {
    const r = await ratchet.writeImpactMap([fixture.raw], "map-raw.json", { sha: "s", sourceRoot: fixture.dir });
    assert.equal(r.spawnCredited, 1);
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(readMap("map-raw.json").files["src/child.mjs"], child);
});

test("W1-T6108: the merged lcov still counts the child's coverage, as the runner's own lcov does", () => {
  merger(["--output", "merged.lcov", "raw"]);
  for (const lcov of ["merged.lcov", "runner.lcov"]) {
    const text = readFileSync(join(fixture.dir, lcov), "utf8");
    const record = text.split("end_of_record").find((r) => r.includes("SF:src/child.mjs"));
    assert.ok(record, `${lcov} has src/child.mjs`);
    assert.match(record, /^FNDA:1,childOnly$/m, `${lcov} counts the child's call`);
    assert.match(record, /^DA:3,1$/m, `${lcov} counts the child's line`);
  }
});

test("W1-T6108: a suite that only spawns git is not a spawner, and a credited spawner is selected by what its child executed", () => {
  const files = new Map([...SUITES, ["src/child.mjs", CHILD_MJS], ["src/never.mjs", "export const n = 1;\n"]]);
  assert.deepEqual([...impactMap.spawningSuites(files)].sort(), [BLANKS, SPAWNER], "git-only spawns no repo code");
  assert.deepEqual([...impactMap.uncreditableSpawners(files)], [BLANKS]);
  const map = readMap("map.json");
  const diffOf = (path: string, hunk: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunk}\n`;
  const arm = (diffText: string, over: Partial<ImpactMap> = {}, ctx: Partial<ImpactArmContext> = {}) => impactMap.impactArmSelection(
    { map: { ...map, ...over }, diffText, drift: { distance: 0, changedSinceMap: [] }, baseText: (p) => files.get(p) },
    { changed: ["src/child.mjs"], files, floor: [...SUITES.keys()], pathReaders: [], pathNamers: [], recent: [], fallback: [], ...ctx },
  );
  const reasons = (a: ReturnType<typeof arm>) => a.reasons.join("\n");
  // An edit inside childOnly(): the spawner is selected because its child executed it.
  const executed = arm(diffOf("src/child.mjs", "@@ -3 +3 @@\n-  return n + 1;\n+  return n + 2;"));
  assert.deepEqual(executed.suites, [BLANKS, SPAWNER]);
  assert.match(reasons(executed), /test\/spawner\.test\.ts: executed src\/child\.mjs:2-4/);
  assert.match(reasons(executed), /test\/blanks\.test\.ts: sets NODE_V8_COVERAGE for its children/);
  // An edit inside neverRun(): nobody executed it; only the suite whose children blank coverage rides.
  const unexecuted = arm(diffOf("src/child.mjs", "@@ -6 +6 @@\n-  return n - 1;\n+  return n - 2;"));
  assert.deepEqual(unexecuted.suites, [BLANKS], "neither the credited spawner nor the git-only suite is force-selected");
  // A map from before attribution, or one that credits the spawner nothing, still selects it.
  const { spawnCredited: _drop, ...old } = map;
  const legacy = impactMap.impactArmSelection(
    { map: old as ImpactMap, diffText: diffOf("src/child.mjs", "@@ -6 +6 @@\n-a\n+b"), drift: { distance: 0, changedSinceMap: [] }, baseText: (p) => files.get(p) },
    { changed: ["src/child.mjs"], files, floor: [...SUITES.keys()], pathReaders: [], pathNamers: [], recent: [], fallback: [] },
  );
  assert.match(reasons(legacy), /spawner\.test\.ts: spawns children the map cannot credit \(it predates child attribution\)/);
  assert.doesNotMatch(reasons(legacy), /git-only/);
  assert.match(reasons(arm(diffOf("src/child.mjs", "@@ -6 +6 @@\n-a\n+b"), { spawnCredited: [] })), /spawner\.test\.ts: spawns repo code but the map credits it no child report/);
  // A file no process loaded on the map's sha: the floor's code spawners cover it.
  const unloaded = arm(diffOf("src/never.mjs", "@@ -1 +1 @@\n-export const n = 1;\n+export const n = 2;"), {}, { changed: ["src/never.mjs"] });
  assert.match(reasons(unloaded), /spawner\.test\.ts: spawns repo code and src\/never\.mjs is loaded by no process/);
  assert.doesNotMatch(reasons(unloaded), /git-only/);
});

test("W1-T6108: the redirect applies only to a suite's main thread under coverage, and a bad record is refused by name", () => {
  const cwd = REPO_ROOT;
  const script = join(REPO_ROOT, "test", "x.test.ts");
  assert.equal(hygiene.redirectChildCoverage({}, { script, cwd }), undefined, "no coverage, no redirect");
  assert.equal(hygiene.redirectChildCoverage({ NODE_V8_COVERAGE: "/c" }, { script, cwd, mainThread: false }), undefined, "a worker keeps its parent's");
  assert.equal(hygiene.redirectChildCoverage({ NODE_V8_COVERAGE: `/t/${hygiene.CHILD_COVERAGE_DIR_PREFIX}1-0-a/test/y.test.ts` }, { script, cwd }), undefined, "a suite's child keeps its suite's");
  assert.equal(hygiene.redirectChildCoverage({ NODE_V8_COVERAGE: "/c" }, { script: join(REPO_ROOT, "src", "cli.ts"), cwd }), undefined, "not a suite");
  const out = mkdtempSync(join(tmpdir(), "rmd-t6108-flat-"));
  try {
    const env: NodeJS.ProcessEnv = { NODE_V8_COVERAGE: out };
    const redirect = hygiene.redirectChildCoverage(env, { script, cwd });
    assert.ok(redirect);
    assert.equal(env.NODE_V8_COVERAGE, redirect.childDir);
    assert.ok(redirect.childDir.endsWith(join("test", "x.test.ts")));
    writeFileSync(join(redirect.childDir, "coverage-1-0000000000000-0.json"), "{}");
    writeFileSync(join(redirect.childDir, "unrelated.txt"), "");
    assert.deepEqual(hygiene.flattenChildCoverage(redirect, () => 1234567890123), ["coverage-1-0000000000000-0.json"]);
    assert.deepEqual(readdirSync(out).sort(), ["coverage-1-0000000000000-0.json", `rmd-v8-children-${process.pid}-1234567890123.json`]);
    // A late writer (a thread holding the redirected value) lands flat, through the link.
    assert.equal(lstatSync(redirect.childDir).isSymbolicLink(), true);
    writeFileSync(join(redirect.childDir, "coverage-2-0000000000000-1.json"), "{}");
    assert.ok(readdirSync(out).includes("coverage-2-0000000000000-1.json"));
    const empty = hygiene.redirectChildCoverage({ NODE_V8_COVERAGE: out }, { script, cwd });
    assert.ok(empty);
    assert.deepEqual(hygiene.flattenChildCoverage(empty), [], "no child, no record");
    assert.equal(readdirSync(out).filter((n) => n.startsWith("rmd-v8-children-")).length, 1);
    assert.equal(ratchet.childSuitesIn(out).get(join(out, "coverage-1-0000000000000-0.json")), "test/x.test.ts");
    writeFileSync(join(out, `rmd-v8-children-${process.pid}-1234567890124.json`), JSON.stringify({ format: hygiene.CHILD_COVERAGE_RECORD_FORMAT, suite: "src/x.ts", reports: [] }));
    assert.throws(() => ratchet.childSuitesIn(out), /is not a valid rmd-v8-child-suites-v1 record/);
    assert.throws(() => ratchet.childSuitesIn(join(out, "missing")), /cannot read raw coverage directory/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
