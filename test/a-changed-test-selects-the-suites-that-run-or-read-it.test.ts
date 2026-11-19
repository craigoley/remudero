import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
// @ts-expect-error The diff classifier has no declaration file.
import { censusSuiteFiles, testOnlyRun } from "#scripts/diff-class.mjs";
import { readAffectedSuitesInput, selectAffectedSuites } from "#src/lib/affected-suites.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const CHILD = "test/fx/child.test.ts";
const HEAD = 'import { test } from "node:test";\nimport { join } from "node:path";\nconst ROOT = process.cwd();\n';

/** Suites that run CHILD as a child process, one per call shape and path form. */
const RUNNERS: Record<string, string> = {
  "test/fx/spawns-literal.test.ts": `${HEAD}test("x", () => { spawnSync(process.execPath, ["--test", "${CHILD}"], { encoding: "utf8" }); });\n`,
  "test/fx/execs-joined.test.ts": `${HEAD}test("x", () => { execFile(process.execPath, ["--test", join(ROOT, "test", "fx", "child.test.ts")], () => {}); });\n`,
  "test/fx/forks-const.test.ts": `${HEAD}const CHILD = join(ROOT, "test", "fx", "child.test.ts");\ntest("x", () => { fork(CHILD, []); });\n`,
  "test/fx/bounded-argv.test.ts": `${HEAD}const FILE = "${CHILD}";\nconst ARGV = ["--test", FILE];\ntest("x", async () => { await runBoundedSuite(process.execPath, ARGV, {}); });\n`,
};
/** Suites that read CHILD's text. */
const READERS: Record<string, string> = {
  "test/fx/reads-literal.test.ts": `${HEAD}test("x", () => { readFileSync("${CHILD}", "utf8"); });\n`,
  "test/fx/reads-const.test.ts": `${HEAD}const SOURCE = join(ROOT, "test/fx/child.test.ts");\ntest("x", async () => { await readFile(SOURCE, "utf8"); });\n`,
};
/** Suites that only name CHILD: as data, in an assertion message, or in a comment. */
const NAMERS: Record<string, string> = {
  "test/fx/table.test.ts": `${HEAD}const OWNERS = { "${CHILD}": "fleet" };\nconst NAMES = ["${CHILD}"];\ntest("x", () => { assert.equal(Object.keys(OWNERS).length, NAMES.length); });\n`,
  "test/fx/message.test.ts": `${HEAD}test("x", () => { assert.equal(spawnSync(process.execPath, ["-e", "1"]).status, 0, "${CHILD} must pass first"); });\n`,
  "test/fx/comment.test.ts": `${HEAD}// spawnSync(process.execPath, ["${CHILD}"]);\n/* readFileSync("${CHILD}", "utf8") */\ntest("x", () => {});\n`,
};
/** A suite that runs one of the runners: selected only by following the edges past one hop. */
const OUTER: Record<string, string> = {
  "test/fx/runs-a-runner.test.ts": `${HEAD}test("x", () => { spawnSync(process.execPath, ["--test", "test/fx/spawns-literal.test.ts"]); });\n`,
};

function world(extra: Record<string, string> = {}): Record<string, string> {
  return { [CHILD]: `${HEAD}test("child", () => {});\n`, ...RUNNERS, ...READERS, ...NAMERS, ...OUTER, ...extra };
}

/** The affected-suite selector's picks for a change to CHILD, with the reason each was picked. */
function affected(files: Record<string, string>): Map<string, string> {
  const selection = selectAffectedSuites([CHILD], { files: new Map(Object.entries(files)), pathReaders: [] });
  assert.equal(selection.fullRun, false, selection.reasons.join("\n"));
  return new Map(selection.reasons.map((r) => r.split(": ")).filter((p) => p.length >= 2).map(([s, ...why]) => [s!, why.join(": ")]));
}

/** The PR lane's census selection for a change to CHILD, over a tree written to disk. */
function census(t: TestContext, files: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), "rmd-runs-or-reads-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return censusSuiteFiles([CHILD], root);
}

test("W1-T13788 criterion 1: the test-only run for the #19469 change includes the suite that spawns that test", () => {
  const changed = "test/a-gate-run-leaves-the-tracked-tree-clean.test.ts";
  const evidence = "test/infra/gate-probe-native-evidence.test.ts";
  const run = testOnlyRun([changed]);
  assert.equal(run?.mode, "files");
  assert.ok(run.files.includes(evidence), `${evidence} is in the test-only run`);
  // The affected-suite graph selects it too, with no diff-class listing in the input.
  const input = readAffectedSuitesInput(REPO_ROOT, [changed]);
  const selection = selectAffectedSuites([changed], { ...input, pathReaders: [] });
  assert.ok(selection.suites.includes(evidence), selection.reasons.join("\n"));
  assert.ok(selection.reasons.includes(`${evidence}: runs or reads ${changed}`));
});

test("W1-T13788 criterion 2: a suite that passes a changed test's path to a run call is selected, and the reason names it", (t) => {
  const picks = affected(world());
  const lane = census(t, world());
  for (const suite of Object.keys(RUNNERS)) {
    assert.equal(picks.get(suite), `runs or reads ${CHILD}`, suite);
    assert.ok(lane.includes(suite), suite);
  }
});

test("W1-T13788 criterion 3: a suite that passes a changed test's path to readFileSync or readFile is selected", (t) => {
  const picks = affected(world());
  const lane = census(t, world());
  for (const suite of Object.keys(READERS)) {
    assert.equal(picks.get(suite), `runs or reads ${CHILD}`, suite);
    assert.ok(lane.includes(suite), suite);
  }
});

test("W1-T13788 criterion 4: the selection follows run edges past one hop, in both selectors", (t) => {
  const outer = "test/fx/runs-a-runner.test.ts";
  assert.equal(affected(world()).get(outer), "runs or reads test/fx/spawns-literal.test.ts");
  assert.ok(census(t, world()).includes(outer));
  // Without the middle suite there is no path from CHILD to the outer suite.
  const withoutMiddle = Object.fromEntries(Object.entries(world()).filter(([path]) => path !== "test/fx/spawns-literal.test.ts"));
  assert.equal(affected(withoutMiddle).has(outer), false);
  assert.equal(census(t, withoutMiddle).includes(outer), false);
});

test("W1-T13788 criterion 5: invariant:named-is-not-run — a suite that names a changed test only as data selects nothing", (t) => {
  const picks = affected(world());
  const lane = census(t, world());
  for (const suite of Object.keys(NAMERS)) {
    assert.equal(picks.has(suite), false, `${suite}: ${picks.get(suite)}`);
    assert.equal(lane.includes(suite), false, suite);
  }
});
