import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-ignore the executable .mjs module is exercised directly and has no declaration file.
import { analyzeSource, analyzeSources, parseCount, runCodemod } from "#scripts/test-repo-root-codemod.mjs";

// The root-helper rule suite set the length of the rule-checks step: it parsed every test file four times
// (docs/forensics/root-helper-codemod-suite-timing.md). These tests run the real suite file and the real
// command in a small repository of their own, and plant each kind of defect the suite must still find.

const SUITE = "test/every-test-finds-the-repo-root-through-one-helper.test.ts";
const COMMAND = "scripts/test-repo-root-codemod.mjs";
const SEVEN_TESTS = [
  "W1-T9863: census-precheck refuses new own-folder roots and net count growth",
  "W1-T9863: a census pointed at the wrong root fails its inspected count",
  "W1-T9863: no new test derives the repo root from its own folder",
  "W1-T9863: the own-folder root count never rises above the merge base",
  "the root helper identifies this package independently of the caller",
  "the codemod rewrites supported root shapes without changing quoted examples or fixture paths",
  "the codemod CLI reports a dry-run census of the real tree and refuses unknown arguments",
];
const [, , NO_NEW_ROOT, COUNT_NEVER_RISES, , , COMMAND_TEST] = SEVEN_TESTS as [string, string, string, string, string, string, string];

const OWN_ROOT = 'import { join } from "node:path";\nexport const root = join(import.meta.dirname, "..");\n';
const HELPER_ROOT = 'import { REPO_ROOT } from "#test/helpers/repo-root.js";\nexport const root = REPO_ROOT;\n';

// The fixture command is the real command with these lines put before it. Each start of the command adds a
// line to command-runs.log, and each process that loads the module adds its parse count to parse-counts.log.
const RECORD = [
  'import { appendFileSync as plantedAppend } from "node:fs";',
  'const plantedIsMain = () => String(process.argv[1]).endsWith("test-repo-root-codemod.mjs");',
  'const plantedFile = (name) => new URL(`../${name}`, import.meta.url);',
  'if (plantedIsMain()) plantedAppend(plantedFile("command-runs.log"), `${JSON.stringify(process.argv.slice(2))}\\n`);',
  'process.on("exit", () => plantedAppend(plantedFile("parse-counts.log"), `${plantedIsMain() ? "command" : "suite"} ${parseCount()}\\n`));',
];
const DRY_RUN_WRITES = 'if (plantedIsMain() && process.argv.length === 2) plantedAppend(plantedFile("test/clean.test.ts"), "// written by a dry run\\n");';
const WRONG_INSPECTED_COUNT = 'if (plantedIsMain()) { const print = console.log; console.log = (text) => print(String(text).replace(/"inspected": \\d+/, \'"inspected": 1\')); }';

function git(root: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", env });
}

/** A small repository with the real suite, the real command and two tests. Its one commit is also `origin/main`. */
function fixtureRepo(t: { after: (fn: () => void) => void }, planted: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}root-helper-suite-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ["package.json", SUITE, "test/helpers/repo-root.ts", "test/helpers/inspected-population.ts",
    "scripts/lib/argv.mjs", "scripts/lib/repo-root.mjs"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(REPO_ROOT, file), join(root, file));
  }
  const [shebang, ...command] = readFileSync(join(REPO_ROOT, COMMAND), "utf8").split("\n");
  writeFileSync(join(root, COMMAND), [shebang, ...RECORD, ...planted, ...command].join("\n"));
  // The suite's first test loads the census precheck. It runs from the real tree; the fixture needs only its name.
  symlinkSync(join(REPO_ROOT, "scripts", "census-precheck.mjs"), join(root, "scripts", "census-precheck.mjs"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "test", "old-root.test.ts"), OWN_ROOT);
  writeFileSync(join(root, "test", "clean.test.ts"), HELPER_ROOT);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "package.json", "scripts/lib", COMMAND, "test");
  git(root, "commit", "--quiet", "--message", "base");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

type SuiteRun = { status: number | null; results: [string, boolean][]; output: string; commandRuns: string[]; parseCounts: string[] };

/** Run the suite file of the fixture as the rule-checks step runs it: one `node --test` child. */
function runSuite(root: string, ...more: string[]): SuiteRun {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // without this the child would report to this test run, not print its own results
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", "tsx", ...more, SUITE],
    { cwd: root, encoding: "utf8", env, timeout: 110_000 });
  const output = `${run.stdout}\n${run.stderr}`;
  const lines = (name: string) => existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").trimEnd().split("\n") : [];
  return {
    status: run.status, output,
    results: [...output.matchAll(/^(not ok|ok) \d+ - (.+)$/gm)].map(([, verdict, name]) => [name!, verdict === "ok"]),
    commandRuns: lines("command-runs.log"), parseCounts: lines("parse-counts.log"),
  };
}

const passed = (run: SuiteRun) => run.results.filter(([, ok]) => ok).map(([name]) => name);
const failed = (run: SuiteRun) => run.results.filter(([, ok]) => !ok).map(([name]) => name);

test("W1-T12248 criterion 1: each distinct file text is parsed once, over a fixture tree and over a base and a current tree that share most files", (t) => {
  const root = fixtureRepo(t);
  const first = runCodemod(root, false);
  assert.equal(first.inspected, 3);
  assert.equal(first.parsed, 3, "the first run over the tree parses each file");
  const second = runCodemod(root, false);
  assert.equal(second.parsed, 0, "the same tree again parses nothing");
  assert.deepEqual({ ...second, parsed: first.parsed }, first, "and reports the same result");

  const text = (n: number) => `// criterion 1 file ${n}\n${n % 2 ? OWN_ROOT : HELPER_ROOT}`;
  const base: [string, string][] = Array.from({ length: 8 }, (_, n) => [`test/member-${n}.test.ts`, text(n)]);
  const current: [string, string][] = [...base.slice(1, 7), ["test/member-7.test.ts", `${text(7)}// changed\n`], ["test/member-8.test.ts", text(8)]];
  const start = parseCount();
  analyzeSources(base);
  assert.equal(parseCount() - start, 8, "the base tree: one parse for each file");
  const results = analyzeSources(current);
  assert.equal(parseCount() - start, 10, "the current tree: one parse for the changed file and one for the new file");
  analyzeSources(base);
  analyzeSources(current);
  assert.equal(parseCount() - start, 10, "both trees again: no parse");
  assert.deepEqual(results, current.map(([file, source]) => analyzeSource(source, file)), "a kept result equals a new parse of the same text");

  // The suite itself: its two merge-base tests read the base tree and the current tree, 3 files each with equal text.
  const run = runSuite(root, "--test-name-pattern", "merge base|no new test derives");
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(passed(run), [NO_NEW_ROOT, COUNT_NEVER_RISES]);
  assert.deepEqual(run.parseCounts, ["suite 3"], "6 file texts in two trees, 3 distinct, 3 parses");
});

test("W1-T12248 criterion 2: the suite starts one dry run of the command and proves by a digest that no test file changed", (t) => {
  const root = fixtureRepo(t);
  const run = runSuite(root);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.commandRuns, ["[]", '["--bogus"]'], "one dry run, then the refused argument");
  assert.ok(run.parseCounts.includes("command 3"), `the one dry run parsed the 3 test files: ${run.parseCounts.join(", ")}`);
  // The digest is what proves it: the same suite fails when the one dry run adds a comment to a file. The
  // report of a second dry run would be equal to the first there, so a second dry run would not see it.
  const written = runSuite(fixtureRepo(t, [DRY_RUN_WRITES]));
  assert.deepEqual(written.commandRuns, ["[]"]);
  assert.deepEqual(failed(written), [COMMAND_TEST]);
});

test("W1-T12248 criterion 3: a planted new test that derives the repo root from its own folder is found, with the same message as today", (t) => {
  const root = fixtureRepo(t);
  writeFileSync(join(root, "test", "planted-new.test.ts"), OWN_ROOT);
  const run = runSuite(root);
  assert.equal(run.status, 1, run.output);
  assert.deepEqual(failed(run), [NO_NEW_ROOT, COUNT_NEVER_RISES]);
  assert.match(run.output, /new tests must import helpers\/repo-root\.js: test\/planted-new\.test\.ts/);
});

test("W1-T12248 criterion 4: a planted own-folder root in a file of the merge base raises the count and is found", (t) => {
  const root = fixtureRepo(t);
  writeFileSync(join(root, "test", "clean.test.ts"), OWN_ROOT);
  const run = runSuite(root);
  assert.equal(run.status, 1, run.output);
  assert.deepEqual(failed(run), [COUNT_NEVER_RISES], "the file is not new, so only the count finds it");
  assert.match(run.output, /own-folder root files: head=2, merge base=1/);
});

test("W1-T12248 criterion 5: a dry run that writes a file fails the digest check, and a report with a wrong inspected count fails as today", (t) => {
  const written = runSuite(fixtureRepo(t, [DRY_RUN_WRITES]));
  assert.equal(written.status, 1, written.output);
  assert.deepEqual(failed(written), [COMMAND_TEST]);
  assert.match(written.output, /the dry run changed a test file: the digest of the test tree differs before and after/);

  const miscounted = runSuite(fixtureRepo(t, [WRONG_INSPECTED_COUNT]));
  assert.equal(miscounted.status, 1, miscounted.output);
  assert.deepEqual(failed(miscounted), [COMMAND_TEST]);
  assert.doesNotMatch(miscounted.output, /the dry run changed a test file/);
  assert.match(miscounted.output, /1 !== 3/, "the report said 1 file inspected; the tree has 3");
});

test("W1-T12248 criterion 6: two texts that differ in one character are parsed separately, and a kept result is never used for another text", () => {
  const rooted = `// criterion 6\n${OWN_ROOT}`;
  const other = rooted.replace('".."', '".x"');
  assert.equal(other.length, rooted.length);
  assert.equal([...rooted].filter((character, index) => character !== other[index]).length, 1, "one character differs");
  const file = "test/one-character.test.ts";
  const start = parseCount();
  const [first, second] = analyzeSources([[file, rooted], [file, other]]);
  assert.equal(parseCount() - start, 2, "same name, same length, one character apart: two parses");
  assert.equal(first.computations.length, 1);
  assert.equal(second.computations.length, 0);
  const [again, firstAgain] = analyzeSources([[file, other], [file, rooted]]);
  assert.equal(parseCount() - start, 2);
  assert.equal(again, second, "each text gets its own kept result");
  assert.equal(firstAgain, first);
  // The result depends on the folder of the file, so one text under two names is two results too.
  const [nested] = analyzeSources([["test/nested/one-character.test.ts", rooted]]);
  assert.equal(parseCount() - start, 3);
  assert.equal(first.edits.length, 1);
  assert.equal(nested.edits.length, 0, "one folder up from test/nested is not the repo root");
  assert.throws(() => first.computations.push({}), TypeError, "a kept result cannot be changed by a caller");
});

test("W1-T12248 criterion 7: the suite keeps its seven tests by name, and all seven pass on a clean tree", (t) => {
  const run = runSuite(fixtureRepo(t));
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.results, SEVEN_TESTS.map((name) => [name, true]));
});
