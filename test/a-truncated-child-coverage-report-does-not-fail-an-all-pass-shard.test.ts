import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// 2026-10-09: coverage shards on several PRs went red with every test passing because one child process,
// killed mid-write, left a truncated raw V8 report ("COVERAGE-REPORT-FAILED … Unexpected end of JSON input").
// Node then reports no coverage at all, so the shard has no lcov and fails. The fix lane can only call it a
// flake. The wrapper now sets the truncated report aside and rebuilds lcov from the intact ones.

const wrapper = fileURLToPath(new URL("../scripts/test-with-retry.mjs", import.meta.url));
const truncated = "coverage-424242-1791500613083-7.json";

function fixture(t: TestContext, failing = false) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}truncated-coverage-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "raw"));
  writeFileSync(join(dir, "source.mjs"), "export function covered() { return 1; }\nexport function uncovered() { return 2; }\n");
  writeFileSync(join(dir, "fixture.test.mjs"), `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
const { covered } = await import("./source.mjs");
test("an all-pass suite whose child was killed mid-write", () => {
  covered();
  writeFileSync(join(process.env.NODE_V8_COVERAGE, ${JSON.stringify(truncated)}), '{"result":[{"scriptId":"1","url":"file:///x","functions":[{"functionName":"a');
  if (${JSON.stringify(failing)}) assert.fail("a real failure");
});
`);
  return dir;
}

function run(dir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: "", GITHUB_STEP_SUMMARY: join(dir, "summary") };
  delete env.NODE_TEST_CONTEXT;
  delete env.TEST_RETRY;
  delete env.TEST_RETRY_BUDGET_SECONDS;
  const result = spawnSync(process.execPath, [wrapper, "--coverage-first-pass", "raw", process.execPath,
    "--enable-source-maps", "--experimental-test-coverage", "--test-coverage-include=source.mjs",
    "--test-reporter=tap", "--test-reporter-destination=stderr",
    "--test-reporter=lcov", "--test-reporter-destination=lcov.info", "--test", "fixture.test.mjs"],
  { cwd: dir, env, encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  return { code: result.status, output: result.stdout + result.stderr };
}

test("a truncated child coverage report is set aside and the all-pass shard still produces lcov", (t) => {
  const dir = fixture(t);
  const result = run(dir);
  assert.equal(result.code, 0, result.output);
  const lcov = readFileSync(join(dir, "lcov.info"), "utf8");
  assert.match(lcov, /^SF:source\.mjs$/m);
  assert.match(lcov, /^FNDA:1,covered$/m);
  assert.equal(existsSync(join(dir, "raw", truncated)), false);
  assert.equal(existsSync(join(dir, "raw-unparseable", truncated)), true);
  assert.match(result.output, /FLAKE-RETRY-RECOVERED: dropped unreportable coverage file\(s\) — .*coverage-424242-1791500613083-7\.json \(truncated/);
});

test("a truncated child coverage report never hides a real test failure", (t) => {
  const dir = fixture(t, true);
  const result = run(dir);
  assert.notEqual(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /FLAKE-RETRY-RECOVERED/);
});
