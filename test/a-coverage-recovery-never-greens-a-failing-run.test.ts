import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// 2026-10-12, #11085 coverage-shard (8/8): the W1-T5935 census failed (`# fail 1`), one child's raw V8
// report was truncated, and the wrapper read a NESTED run's earlier `# fail 0` summary as the shard's own.
// It dropped the truncated report, rebuilt lcov, and exited 0 on a failing run. These fixtures replay that
// shape with CI's own reporters: spec on stdout prints a test's bare stdout, TAP on stderr.

const wrapper = fileURLToPath(new URL("../scripts/test-with-retry.mjs", import.meta.url));
const truncated = "coverage-424242-1791500613083-7.json";
const partialReport = '{"result":[{"scriptId":"1","url":"file:///x","functions":[{"functionName":"a';
const RECOVERED = /FLAKE-RETRY-RECOVERED: dropped unreportable coverage/;

function workspace(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}coverage-recovery-verdict-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "raw"));
  writeFileSync(join(dir, "source.mjs"), "export function covered() { return 1; }\nexport function uncovered() { return 2; }\n");
  return dir;
}

// A suite whose first test runs a "nested node --test" that prints its own bare summary, then truncates a
// child report; `failing` adds a real failure after it.
function nestedSummaryFixture(t: TestContext, nested: string, failing: boolean) {
  const dir = workspace(t);
  writeFileSync(join(dir, "fixture.test.mjs"), `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
const { covered } = await import("./source.mjs");
test("a census that runs its own nested node --test", () => {
  covered();
  process.stdout.write(${JSON.stringify(nested)});
  if (process.env.NODE_V8_COVERAGE) writeFileSync(join(process.env.NODE_V8_COVERAGE, ${JSON.stringify(truncated)}), ${JSON.stringify(partialReport)});
});
if (${JSON.stringify(failing)}) test("W1-T5935: the rotation census", () => assert.fail("a real failure"));
`);
  return dir;
}

function wrap(dir: string, command: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary") };
  env.NODE_V8_COVERAGE = ""; // blanked, never deleted: a deleted key is re-injected into the child
  const outer = process.env.NODE_V8_COVERAGE;
  if (outer) env.NODE_V8_COVERAGE = outer;
  delete env.NODE_TEST_CONTEXT;
  delete env.TEST_RETRY;
  delete env.TEST_RETRY_BUDGET_SECONDS;
  const result = spawnSync(process.execPath, [wrapper, "--coverage-first-pass", "raw", process.execPath, ...command],
    { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  return { code: result.status, output: result.stdout + result.stderr };
}

function runSuite(dir: string) {
  return wrap(dir, ["--enable-source-maps", "--experimental-test-coverage", "--test-coverage-include=source.mjs",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=tap", "--test-reporter-destination=stderr",
    "--test-reporter=lcov", "--test-reporter-destination=lcov.info", "--test", "fixture.test.mjs"]);
}

test("W1-T8585: a nested passing summary before a real failure never takes the coverage recovery", (t) => {
  const dir = nestedSummaryFixture(t, "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n", true);
  const result = runSuite(dir);
  assert.match(result.output, /^# tests 2\n# pass 2\n# fail 0\n# cancelled 0$/m, "the nested passing summary is printed bare");
  assert.match(result.output, /^not ok \d+ - W1-T5935: the rotation census$/m);
  assert.notEqual(result.code, 0, result.output);
  assert.doesNotMatch(result.output, RECOVERED);
  assert.equal(existsSync(join(dir, "raw-unparseable")), false, "no coverage file was set aside");
});

test("W1-T8585: a named failing test keeps the run red after a coverage rebuild", (t) => {
  // A runner whose final summary is mangled into an all-pass one, though it named a failing test. Only the
  // named failure separates it from a genuine all-pass run with a truncated report: the rebuild would succeed.
  const dir = workspace(t);
  writeFileSync(join(dir, "runner.mjs"), `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const { covered } = await import("./source.mjs");
covered();
writeFileSync(join(process.env.NODE_V8_COVERAGE, ${JSON.stringify(truncated)}), ${JSON.stringify(partialReport)});
console.log("not ok 1 - W1-T5935: the rotation census");
console.log("# Warning: Could not report code coverage. Error [ERR_OPERATION_FAILED]: Operation failed: failed to parse coverage file ${truncated}: Unexpected end of JSON input");
console.log("# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0");
process.exitCode = 1;
`);
  const result = wrap(dir, ["runner.mjs", "--test", "--experimental-test-coverage", "--test-coverage-include=source.mjs",
    "--test-reporter=lcov", "--test-reporter-destination=lcov.info"]);
  assert.match(result.output, /FLAKE-RETRY: first attempt failed — W1-T5935: the rotation census/);
  assert.notEqual(result.code, 0, result.output);
  assert.doesNotMatch(result.output, RECOVERED);
  assert.equal(existsSync(join(dir, "raw", truncated)), true, "the truncated report was not dropped");
});

test("W1-T8585: an all-pass run with a truncated report still recovers", (t) => {
  // The nested run here FAILED (a fixture of its own); the shard's own final summary is all-pass.
  const dir = nestedSummaryFixture(t, "# tests 3\n# pass 1\n# fail 2\n# cancelled 0\n", false);
  const result = runSuite(dir);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /FLAKE-RETRY-RECOVERED: dropped unreportable coverage file\(s\) — .*coverage-424242-1791500613083-7\.json \(truncated/);
  assert.equal(existsSync(join(dir, "raw", truncated)), false);
  assert.equal(existsSync(join(dir, "raw-unparseable", truncated)), true);
  assert.match(readFileSync(join(dir, "lcov.info"), "utf8"), /^FNDA:1,covered$/m);
});
