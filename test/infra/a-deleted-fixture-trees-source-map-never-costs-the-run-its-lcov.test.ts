/**
 * PR 13218 — a child that ran a bundle from a fixture tree, through the bundle's LINKED map (recipe 5,
 * scripts/build-child-entries.mjs), never costs the coverage run its lcov once that tree is deleted.
 *
 * Node maps a report's `source-map-cache` onto the map's sources at report time, and throws
 * ERR_SOURCE_MAP_MISSING_SOURCE when one is gone: no lcov at all (12 of the 19 bundle-building suites, and 7 of 8
 * coverage shards, on #13218). test/setup/tmp-hygiene.ts now drops such an entry from a child's report, as Node
 * itself drops a deleted unmapped file. The first test runs CI's coverage invocation over a fixture repo whose one
 * suite runs two real-recipe bundles: one built from the repo's own sources, which stay, and one built in a second
 * tree the suite deletes.
 *
 * NODE_V8_COVERAGE: the fixture runner is given a coverage directory of its OWN, the thing under test; the merger
 * children inherit this process's.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dropUnmappableSourceMaps } from "../setup/tmp-hygiene.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = import.meta.resolve("tsx");
const SETUP = join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts");
const MERGER = join(REPO_ROOT, "scripts", "coverage-merge-ratchet.mjs");
const SCRIPT = join(REPO_ROOT, "scripts", "build-child-entries.mjs");

const source = (name: string) => [
  `export function ${name}(n: number): number {`, //  1
  "  return n + 1;", //                                2
  "}", //                                              3
  `console.log(${name}(1));`, //                       4
  "",
].join("\n");

/** A tree the real build can bundle: one entry, `src/<name>.ts`, built to dist/child-entries/<name>.mjs. */
function tree(root: string, name: string): { name: string; source: string } {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  writeFileSync(join(root, "src", `${name}.ts`), source(name));
  return { name, source: `src/${name}.ts` };
}

function buildFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-pr13218-kept-")));
  const doomed = realpathSync(mkdtempSync(join(tmpdir(), "rmd-pr13218-doomed-")));
  const builds = [{ root: dir, entries: [tree(dir, "kept")], workers: [] }, { root: doomed, entries: [tree(doomed, "doomed")], workers: [] }];
  const build = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)}); for (const b of ${JSON.stringify(builds)}) await m.buildChildEntries(b);`],
  { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_OPTIONS: "" } });
  assert.equal(build.status, 0, `the real build ran: ${build.stderr}`);
  const kept = join(dir, "dist", "child-entries", "kept.mjs");
  const lost = join(doomed, "dist", "child-entries", "doomed.mjs");
  for (const bundle of [kept, lost]) assert.ok(statSync(`${bundle}.map`).isFile(), `${bundle} has its linked map`);
  mkdirSync(join(dir, "test"));
  mkdirSync(join(dir, "raw"));
  copyFileSync(join(REPO_ROOT, ".nvmrc"), join(dir, ".nvmrc"));
  writeFileSync(join(dir, "test", "bundles.test.ts"), [
    'import { rmSync } from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    `for (const bundle of ${JSON.stringify([kept, lost])}) {`,
    '  const r = spawnSync(process.execPath, [bundle], { encoding: "utf8" });',
    "  if (r.status !== 0) throw new Error(r.stderr);",
    "}",
    `rmSync(${JSON.stringify(doomed)}, { recursive: true, force: true });`,
    "",
  ].join("\n"));
  // CI's own coverage flags (ci.yml's coverage-ratchet step), with a raw directory of their own.
  const run = spawnSync(process.execPath, [
    "--enable-source-maps", "--experimental-test-coverage", "--test-coverage-exclude=test/**",
    "--test-reporter=tap", "--test-reporter-destination=stdout", "--test-reporter=lcov", "--test-reporter-destination=runner.lcov",
    "--test", "--import", TSX, "--import", SETUP, "test/bundles.test.ts",
  ], { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: join(dir, "raw"), NODE_TEST_CONTEXT: undefined } });
  return { dir, doomed, run };
}

const fixture = buildFixture();
test.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

/** The merger, as CI runs it, in the fixture repo. */
function merger(args: string[]) {
  return spawnSync(process.execPath, ["--expose-internals", MERGER, ...args], { cwd: fixture.dir, encoding: "utf8" });
}

function keptRecord(lcov: string): string | undefined {
  return readFileSync(join(fixture.dir, lcov), "utf8").split("end_of_record").find((r) => r.includes("SF:src/kept.ts"));
}

test("PR 13218: a bundle run from a deleted fixture tree leaves the coverage run its lcov, and a kept map still maps", () => {
  const { run } = fixture;
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /Could not report code coverage/, "the runner mapped every report it kept");
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const record = keptRecord("runner.lcov");
  assert.ok(record, "the runner's lcov maps the kept bundle onto src/kept.ts");
  assert.match(record, /^DA:2,1$/m, "and counts the line the bundle ran");
  assert.doesNotMatch(readFileSync(join(fixture.dir, "runner.lcov"), "utf8"), /doomed/, "the deleted tree reaches no record");
  // The shard's premap and the aggregate merge read the same raw reports through Node's mapper.
  for (const args of [["--premap-output", "premapped", "raw"], ["--output", "merged.lcov", "raw"]]) {
    const r = merger(args);
    assert.equal(r.status, 0, `merger ${args[0]}: ${r.stderr}`);
  }
  assert.match(keptRecord("merged.lcov") ?? "", /^DA:2,1$/m, "the merged lcov counts the kept bundle's line too");
});

test("PR 13218: only a map naming an unreadable source with no content is dropped", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-pr13218-report-")));
  try {
    const here = pathToFileURL(join(dir, "here.ts")).href;
    const gone = pathToFileURL(join(dir, "gone.ts")).href;
    writeFileSync(join(dir, "here.ts"), "export {};\n");
    const entry = (sources: string[], sourcesContent?: (string | null)[]) => ({ lineLengths: [1], data: { version: 3, sources, sourcesContent, mappings: "" } });
    const report = {
      result: [],
      "source-map-cache": {
        "file:///b/kept.mjs": entry([here]),
        "file:///b/lost.mjs": entry([here, gone]),
        "file:///b/carried.mjs": entry([gone], ["export {};\n"]),
        "node:internal/x": entry(["node:internal/x"]),
      },
    };
    const path = join(dir, "coverage-1-1792500000000-0.json");
    writeFileSync(path, JSON.stringify(report));
    assert.deepEqual(dropUnmappableSourceMaps(path), ["file:///b/lost.mjs", "node:internal/x"]);
    const after = JSON.parse(readFileSync(path, "utf8")) as typeof report;
    assert.deepEqual(Object.keys(after["source-map-cache"]), ["file:///b/kept.mjs", "file:///b/carried.mjs"], "a readable or carried source keeps its map");
    const unchanged = JSON.stringify(after);
    assert.deepEqual(dropUnmappableSourceMaps(path), [], "a report whose sources all read is left alone");
    assert.equal(readFileSync(path, "utf8"), unchanged);
    writeFileSync(path, JSON.stringify({ result: [] }));
    assert.deepEqual(dropUnmappableSourceMaps(path), [], "a report with no maps is never parsed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
