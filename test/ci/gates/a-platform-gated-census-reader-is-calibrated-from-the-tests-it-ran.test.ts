// @not-a-rule-suite: exercises the source-reader runner on isolated fixture repositories.
// @census-reads: none
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FAST_GATE_CENSUS_REMEASURE_MARGIN } from "#src/lib/ci-parity.js";
import { gitRepo } from "#test/helpers/git-repo.js";
// @ts-ignore executable gate module.
import { censusReaderHistoryKey, main, runCensusSuitesViaChild } from "#scripts/census-precheck.mjs";

const FILE = "test/reader.test.ts";
const OTHER = "test/other-reader.test.ts";
const POLICY = { floorMs: 1000, multiple: 4, remeasureMargin: FAST_GATE_CENSUS_REMEASURE_MARGIN };
const PRIORITY = { wrap: (file: string, args: string[]) => ({ file, args }) };
const OPTION = `test("option gate", { skip: process.platform !== "linux" }, () => {});`;
const BODY = `it("body gate", async (t) => {
  if (process.platform !== 'linux') { t.skip("reads Linux /proc"); return; }
});`;
const PASS = 'test("portable", () => {});';
const GATED = ["option gate", "body gate"];
const UNKNOWN = /calibration has no complete unskipped pass/;

function fixture(t: TestContext, source: string, platform?: NodeJS.Platform) {
  const repo = gitRepo({ kind: "platform-gated-reader" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "test"));
  const platformSetup = platform === undefined ? "" : `Object.defineProperty(process, "platform", { value: "${platform}" });`;
  writeFileSync(join(repo.dir, FILE), `import { test, it, describe } from "node:test";\n${platformSetup}\n${source}\n`);
  return repo;
}

function tap(...rows: string[]) {
  const count = (directive: string) => rows.filter((row) => row.includes(directive)).length;
  const skipped = count(" # SKIP");
  const todo = count(" # TODO");
  return `TAP version 13\n${rows.map((row, i) => `${row.replace(" - ", ` ${i + 1} - `)}\n`).join("")}` +
    `1..${rows.length}\n# tests ${rows.length}\n# pass ${rows.length - skipped - todo}\n` +
    `# fail 0\n# cancelled 0\n# skipped ${skipped}\n# todo ${todo}\n`;
}

function drive(root: string, platform: NodeJS.Platform, stdout: string, history = null as null | { path: string; mode: string },
  status = 0) {
  let next = 0;
  const times = [0, 1500, 1501, 1502, 3002];
  return runCensusSuitesViaChild({ root, files: [FILE], platform, readerRuntimePolicy: POLICY, priority: PRIORITY, history,
    readContext: () => "same", now: () => times[next++], run: () => ({ status, stdout }) });
}

function capture(t: TestContext) {
  const stdout: string[] = [], stderr: string[] = [];
  t.mock.method(console, "log", (line: string) => stdout.push(line));
  t.mock.method(console, "error", (line: string) => stderr.push(line));
  return { stdout, stderr };
}

function readerLines(lines: string[], label: string) {
  return lines.filter((line) => line.startsWith(label + ": ")).map((line) => JSON.parse(line.slice(label.length + 2)));
}

function runPrecheck(t: TestContext, repo: ReturnType<typeof gitRepo>, stdout: string, other = false,
  platform: NodeJS.Platform = "darwin") {
  const snapshot = process.env.RMD_CENSUS_SNAPSHOT;
  delete process.env.RMD_CENSUS_SNAPSHOT;
  t.after(() => { if (snapshot !== undefined) process.env.RMD_CENSUS_SNAPSHOT = snapshot; });
  repo.git("add", ".");
  repo.git("commit", "--quiet", "-m", "reader input");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src", "sample.ts"), "export const value = 1;\n");
  repo.git("add", "src/sample.ts");
  repo.git("commit", "--quiet", "-m", "touch source");
  const calls: string[] = [];
  const members = (other ? [FILE, OTHER] : [FILE]).map((testFile) =>
    ({ testFile, script: "", walks: ["src/"], structural: true, readerRuntimePolicy: POLICY }));
  const code = main(["--root", repo.dir], {
    platform, admitted: () => members,
    runSuites: (options: { root: string; files: string[]; platform?: NodeJS.Platform; readerRuntimePolicy?: typeof POLICY }) => {
      assert.equal(options.root, repo.dir, "a clean or deferred head has no merge-base run");
      if (options.files[0] === OTHER) throw new Error("another reader could not be measured");
      if (!options.files.includes(FILE)) return [];
      calls.push(options.root);
      assert.equal(options.readerRuntimePolicy, POLICY);
      return drive(options.root, options.platform ?? "darwin", stdout);
    },
  });
  assert.deepEqual(calls, [repo.dir]);
  return code;
}

const MIXED = tap("ok - portable", "ok - option gate # SKIP", "ok - body gate # SKIP reads Linux /proc");
const ALL_GATED = tap("ok - option gate # SKIP", "ok - body gate # SKIP reads Linux /proc");

test("W1-T13551 criterion 1 accepts option and body gates through calibration, qualification and history", (t) => {
  const repo = fixture(t, [PASS, OPTION, BODY].join("\n"));
  const { stdout, stderr } = capture(t);
  assert.deepEqual(drive(repo.dir, "darwin", MIXED), []);
  const history = join(repo.dir, "history.json");
  writeFileSync(history, JSON.stringify({ version: 1, runs: { [censusReaderHistoryKey(FILE)]: [1500] } }));
  assert.deepEqual(drive(repo.dir, "darwin", MIXED, { path: history, mode: "act" }), []);
  assert.equal(runPrecheck(t, repo, MIXED), 0);
  assert.deepEqual(stderr, []);
  assert.deepEqual(readerLines(stdout, "census-reader-calibration").map(({ tests, platformGated }) => ({ tests, platformGated })),
    Array.from({ length: 2 }, () => ({ tests: 1, platformGated: { platform: "darwin", cases: GATED } })));
  assert.deepEqual(readerLines(stdout, "census-reader-runtime").map(({ tests, platformGated, budgetSource }) =>
    ({ tests, platformGated, budgetSource })), [undefined, "history", undefined].map((budgetSource) =>
    ({ tests: 1, platformGated: { platform: "darwin", cases: GATED }, budgetSource })));
});

test("W1-T13551 criterion 1 accepts TAP from real Node option and body skips", (t) => {
  const nativeOption = OPTION.replace("option gate", "café # option gate");
  const repo = fixture(t, [PASS, nativeOption, BODY].join("\n"), "darwin");
  const { stdout } = capture(t);
  assert.deepEqual(runCensusSuitesViaChild({ root: repo.dir, files: [FILE], platform: "darwin", readerRuntimePolicy: POLICY,
    priority: PRIORITY, history: null }), []);
  assert.deepEqual(readerLines(stdout, "census-reader-runtime").map((row) => row.platformGated),
    [{ platform: "darwin", cases: ["café # option gate", "body gate"] }]);
});

test("W1-T13551 criterion 2 marks the reader deferred and skips timing and qualification", (t) => {
  const repo = fixture(t, [OPTION, BODY].join("\n"));
  const { stdout } = capture(t);
  assert.throws(() => drive(repo.dir, "darwin", ALL_GATED), { censusPlatformDeferred: true });
  assert.deepEqual(stdout, []);
});

test("W1-T13551 criterion 2 exits clean for a deferral and preserves another reader's refusal", (t) => {
  const clean = fixture(t, [OPTION, BODY].join("\n"));
  const mixed = fixture(t, [OPTION, BODY].join("\n"));
  const { stdout, stderr } = capture(t);
  assert.equal(runPrecheck(t, clean, ALL_GATED), 0);
  assert.deepEqual(stderr, []);
  assert.equal(runPrecheck(t, mixed, ALL_GATED, true), 2);
  const line = `census-precheck: census suites deferred to CI: platform-gated on darwin - ${FILE}`;
  assert.deepEqual(stdout.filter((message) => message.includes("deferred to CI")), [line, line]);
  assert.equal(readerLines(stdout, "census-reader-calibration").length, 0);
  assert.equal(readerLines(stdout, "census-reader-runtime").length, 0);
  assert.deepEqual(stderr, [`census-precheck: census suites NOT MEASURED - ${OTHER}: another reader could not be measured`]);
});

test("W1-T13551 criterion 3 refuses skips without a unique direct Linux gate and refuses unfinished runs", (t) => {
  const skipped = tap("ok - portable", "ok - option gate # SKIP");
  for (const source of [
    'test("option gate", { skip: true }, () => {});',
    'test("option gate", { skip: "temporarily disabled" }, () => {});',
    OPTION.replace('!== "linux"', '!== "linux" && enabled'),
    OPTION.replace('!== "linux"', '!== "win32"'),
    OPTION.replace('!== "linux"', '=== "linux"'),
    'test("option gate", { skip: !hasOriginMain }, () => {});',
    'test("option gate", (t) => { if (!hasBash32) { t.skip("no bash 3.2"); return; } });',
    `describe("option gate", { skip: true }, () => {}); ${OPTION}`,
    `describe("parent", () => { ${OPTION} });`,
    `${OPTION} test("option gate", () => {});`,
    `// ${OPTION}\nconst fake = ${JSON.stringify(OPTION)};`,
    `const fake = \`before \${1} ${OPTION} after\`;`,
    BODY.replace("body gate", "option gate").replace("if (", "const first = 1; if ("),
    BODY.replace("body gate", "option gate").replace("return;", ""),
  ]) {
    const { dir } = fixture(t, [PASS, source].join("\n"));
    assert.throws(() => drive(dir, "darwin", skipped), UNKNOWN, source);
  }
  const { dir } = fixture(t, [PASS, OPTION].join("\n"));
  const { stdout } = capture(t);
  for (const incomplete of [skipped.replace("# cancelled 0", "# cancelled 1"), skipped.replace("# todo 0", "# todo 1"),
    skipped.replace("# skipped 1", "# skipped 2"), skipped.replace("# pass 1\n", ""),
    skipped.replace("ok 2 -", "    ok 2 -"), tap("ok - option gate # SKIP", "ok - option gate # SKIP")]) {
    assert.throws(() => drive(dir, "darwin", incomplete), UNKNOWN);
  }
  const failed = skipped.replace("ok 1 - portable", `not ok 1 - portable\n  ---\n  location: '${FILE}:3:1'\n  ...`)
    .replace("# pass 1", "# pass 0").replace("# fail 0", "# fail 1");
  assert.deepEqual(drive(dir, "darwin", failed, null, 1), [FILE]);
  assert.deepEqual(stdout, []);
  assert.throws(() => runCensusSuitesViaChild({ root: dir, files: [FILE], platform: "darwin", readerRuntimePolicy: POLICY,
    priority: PRIORITY, history: null, readContext: () => "same", run: () => {
      rmSync(join(dir, FILE));
      return { status: 0, stdout: skipped };
    } }), { code: "ENOENT" });
});

test("W1-T13551 criterion 4 keeps ordinary Linux calibration output and refuses Linux skips", (t) => {
  const repo = fixture(t, [PASS, OPTION, BODY].join("\n"));
  const { stdout, stderr } = capture(t);
  const allPass = tap("ok - portable", "ok - option gate", "ok - body gate");
  assert.deepEqual(drive(repo.dir, "linux", allPass), []);
  assert.deepEqual(stdout, [
    'census-reader-calibration: {"file":"test/reader.test.ts","context":"same","tests":3,"cases":["0:portable","0:option gate","0:body gate"],"measuredMs":1500,"assurance":"observation-not-qualification"}',
    'census-reader-runtime: {"file":"test/reader.test.ts","context":"same","tests":3,"cases":["0:portable","0:option gate","0:body gate"],"calibrationMs":1500,"budgetMs":6000,"measuredMs":1500,"assurance":"fresh-timing-only-no-cached-verdict"}',
  ]);
  assert.throws(() => drive(repo.dir, "linux", MIXED), UNKNOWN);
  assert.throws(() => drive(repo.dir, "linux", ALL_GATED), UNKNOWN);
  assert.equal(runPrecheck(t, repo, MIXED, false, "linux"), 2);
  assert.deepEqual(stderr, [`census-precheck: census suites NOT MEASURED - ${FILE}: source-reader runtime is UNKNOWN: calibration has no complete unskipped pass`]);
});

test("W1-T13551 criterion 4 preserves the existing Linux verdict for a legacy inverse platform option", (t) => {
  const repo = fixture(t, [PASS, OPTION.replace("!==", "===")].join("\n"));
  const { stdout } = capture(t);
  assert.deepEqual(drive(repo.dir, "linux", tap("ok - portable", "ok - option gate # SKIP")), []);
  assert.deepEqual(stdout, [
    'census-reader-calibration: {"file":"test/reader.test.ts","context":"same","tests":2,"cases":["0:portable","0:option gate # SKIP"],"measuredMs":1500,"assurance":"observation-not-qualification"}',
    'census-reader-runtime: {"file":"test/reader.test.ts","context":"same","tests":2,"cases":["0:portable","0:option gate # SKIP"],"calibrationMs":1500,"budgetMs":6000,"measuredMs":1500,"assurance":"fresh-timing-only-no-cached-verdict"}',
  ]);
});
