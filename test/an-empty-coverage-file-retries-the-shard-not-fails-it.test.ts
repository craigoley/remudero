import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const wrapper = fileURLToPath(new URL("../scripts/test-with-retry.mjs", import.meta.url));
const emptyName = "coverage-999999-1791500613083-0.json";

function fixture(t: TestContext, mode = "empty") {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}empty-coverage-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "raw"));
  writeFileSync(join(dir, "source.mjs"), "export function firstPass() { return 1; }\nexport function retryPass() { return 2; }\n");
  writeFileSync(join(dir, "fixture.test.mjs"), `
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
if (!existsSync("source.mjs")) writeFileSync("source.mjs", "export function firstPass() { return 1; }\\nexport function retryPass() { return 2; }\\n");
const { firstPass, retryPass } = await import("./source.mjs");
test("fixture passes", (t) => {
  const attempts = "attempts";
  const attempt = existsSync(attempts) ? Number(readFileSync(attempts, "utf8")) + 1 : 1;
  writeFileSync(attempts, String(attempt));
  if (attempt === 1) firstPass(); else retryPass();
  if (${JSON.stringify(mode)} !== "healthy" && (${JSON.stringify(mode)} !== "retry" || attempt === 1)) {
    writeFileSync(join(process.env.NODE_V8_COVERAGE, ${JSON.stringify(emptyName)}), "");
  }
  if (${JSON.stringify(mode)} === "multiple") {
    writeFileSync(join(process.env.NODE_V8_COVERAGE, "coverage-999999-1791500613083-1.json"), "");
  }
  if (${JSON.stringify(mode)} === "corrupt" || ${JSON.stringify(mode)} === "mixed") {
    if (${JSON.stringify(mode)} === "corrupt") unlinkSync(join(process.env.NODE_V8_COVERAGE, ${JSON.stringify(emptyName)}));
    writeFileSync(join(process.env.NODE_V8_COVERAGE, "coverage-999999-1791500613083-2.json"), "{broken");
  }
  if (${JSON.stringify(mode)} === "retry" && attempt === 1 || ${JSON.stringify(mode)} === "retry-fails") unlinkSync("source.mjs");
  if (${JSON.stringify(mode)} === "failure") assert.fail("real test failure");
  if (${JSON.stringify(mode)} === "skipped") t.skip("not an all-pass run");
});
`);
  return dir;
}

function run(dir: string, envOverrides: NodeJS.ProcessEnv = {}, extraArgs: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: "", GITHUB_STEP_SUMMARY: join(dir, "summary"), ...envOverrides };
  delete env.NODE_TEST_CONTEXT;
  delete env.TEST_RETRY;
  delete env.TEST_RETRY_BUDGET_SECONDS;
  Object.assign(env, envOverrides);
  const result = spawnSync(process.execPath, [wrapper, "--coverage-first-pass", "raw", process.execPath,
    "--enable-source-maps", "--experimental-test-coverage", "--test-coverage-include=source.mjs",
    "--test-reporter=tap", "--test-reporter-destination=stderr",
    "--test-reporter=lcov", "--test-reporter-destination=lcov.info", ...extraArgs, "--test", "fixture.test.mjs"],
  { cwd: dir, env, encoding: "utf8", timeout: 20_000 });
  assert.ifError(result.error);
  return { code: result.status, output: result.stdout + result.stderr };
}

test("W1-T6592: an empty coverage file is dropped and lcov is still produced", (t) => {
  const dir = fixture(t);
  const result = run(dir);
  assert.equal(result.code, 0, result.output);
  const lcov = readFileSync(join(dir, "lcov.info"), "utf8");
  assert.match(lcov, /^SF:source\.mjs$/m);
  assert.match(lcov, /^FNDA:1,firstPass$/m);
  assert.match(lcov, /^FNDA:0,retryPass$/m);
  assert.doesNotMatch(lcov, /SF:fixture\.test\.mjs/);
  assert.equal(readFileSync(join(dir, "attempts"), "utf8"), "1");
  assert.equal(existsSync(join(dir, "raw", emptyName)), false);
  assert.match(result.output, /FLAKE-RETRY-RECOVERED:.*coverage-999999-1791500613083-0\.json/);
  assert.match(readFileSync(join(dir, "summary"), "utf8"), /FLAKE-RETRY-RECOVERED:.*coverage-999999/);
});

test("W1-T6592: a rebuild without source data retries the coverage shard once", (t) => {
  const dir = fixture(t, "retry");
  const result = run(dir);
  assert.equal(result.code, 0, result.output);
  assert.equal(readFileSync(join(dir, "attempts"), "utf8"), "2");
  assert.match(result.output, /coverage rebuild failed — retrying the coverage shard once/);
  assert.match(result.output, /FLAKE-RETRY-RECOVERED:.*coverage-999999/);
  assert.match(readFileSync(join(dir, "lcov.info"), "utf8"), /^FNDA:1,retryPass$/m);
});

test("W1-T6592: an unsuccessful coverage retry stops after the second attempt", (t) => {
  const dir = fixture(t, "retry-fails");
  const result = run(dir);
  assert.equal(result.code, 1, result.output);
  assert.equal(readFileSync(join(dir, "attempts"), "utf8"), "2");
  assert.match(result.output, /FLAKE-RETRY: retry ALSO failed/);
  assert.doesNotMatch(result.output, /FLAKE-RETRY-RECOVERED/);
});

test("W1-T6592: every empty raw file is dropped and non-coverage files are retained", (t) => {
  const dir = fixture(t, "multiple");
  writeFileSync(join(dir, "raw", "keep.json"), "");
  writeFileSync(join(dir, "raw", "coverage-1-1-1.json"), "");
  writeFileSync(join(dir, "raw", "coverage-1-1791500613083-1.json"), JSON.stringify({ result: [] }));
  mkdirSync(join(dir, "raw", "unrelated-directory"));
  const result = run(dir);
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(join(dir, "raw", "coverage-999999-1791500613083-1.json")), false);
  assert.equal(existsSync(join(dir, "raw", "keep.json")), true);
  assert.equal(existsSync(join(dir, "raw", "coverage-1-1-1.json")), true);
  assert.equal(readFileSync(join(dir, "raw", "coverage-1-1791500613083-1.json"), "utf8"), '{"result":[]}');
  assert.equal(existsSync(join(dir, "raw", "unrelated-directory")), true);
  assert.match(result.output, /FLAKE-RETRY-RECOVERED:.*coverage-999999-1791500613083-1\.json/);
});

for (const mode of ["corrupt", "mixed"]) {
  // 2026-10-09: a non-empty truncated report (a child killed mid-write) is now set aside and lcov rebuilt,
  // like an empty one, instead of failing an all-pass shard (see the truncated-report suite).
  test(`W1-T6592: a non-empty corrupt report is set aside, not failed (${mode})`, (t) => {
    const dir = fixture(t, mode);
    const result = run(dir);
    assert.equal(result.code, 0, result.output);
    assert.equal(readFileSync(join(dir, "attempts"), "utf8"), "1");
    assert.equal(existsSync(join(dir, "raw", "coverage-999999-1791500613083-2.json")), false);
    assert.equal(readFileSync(join(dir, "raw-unparseable", "coverage-999999-1791500613083-2.json"), "utf8"), "{broken");
    assert.match(result.output, /FLAKE-RETRY-RECOVERED:.*coverage-999999-1791500613083-2\.json \(truncated/);
  });
}

test("W1-T6592: a real test failure keeps the existing failed-file retry", (t) => {
  const dir = fixture(t, "failure");
  const result = run(dir);
  assert.equal(result.code, 1, result.output);
  assert.equal(readFileSync(join(dir, "attempts"), "utf8"), "2");
  assert.match(result.output, /retrying 1 failed file\(s\) uninstrumented/);
  assert.doesNotMatch(result.output, /coverage rebuild failed|FLAKE-RETRY-RECOVERED/);
  assert.equal(existsSync(join(dir, "raw", emptyName)), true);
});

test("W1-T6592: healthy coverage runs once without recovery evidence", (t) => {
  const dir = fixture(t, "healthy");
  const result = run(dir);
  assert.equal(result.code, 0, result.output);
  assert.equal(readFileSync(join(dir, "attempts"), "utf8"), "1");
  assert.match(readFileSync(join(dir, "lcov.info"), "utf8"), /^FNDA:1,firstPass$/m);
  assert.doesNotMatch(result.output, /FLAKE-RETRY/);
});

test("W1-T6592: the retry kill switch preserves the reporter failure", (t) => {
  const dir = fixture(t);
  const result = run(dir, { TEST_RETRY: "0" });
  assert.equal(result.code, 1, result.output);
  assert.equal(readFileSync(join(dir, "attempts"), "utf8"), "1");
  assert.equal(existsSync(join(dir, "raw", emptyName)), true);
  assert.doesNotMatch(result.output, /FLAKE-RETRY/);
});

test("W1-T6592: a skipped test does not qualify as an all-pass shard", (t) => {
  const dir = fixture(t, "skipped");
  const result = run(dir);
  assert.equal(result.code, 1, result.output);
  assert.equal(readFileSync(join(dir, "attempts"), "utf8"), "1");
  assert.equal(existsSync(join(dir, "raw", emptyName)), true);
  assert.doesNotMatch(result.output, /FLAKE-RETRY-RECOVERED|coverage rebuild failed/);
});

test("W1-T6592: rebuilding keeps split include and exclude options", (t) => {
  const dir = fixture(t);
  const result = run(dir, {}, ["--test-coverage-include", "*.mjs", "--test-coverage-exclude", "fixture.test.mjs"]);
  assert.equal(result.code, 0, result.output);
  const lcov = readFileSync(join(dir, "lcov.info"), "utf8");
  assert.match(lcov, /^SF:source\.mjs$/m);
  assert.doesNotMatch(lcov, /^SF:fixture\.test\.mjs$/m);
});

test("W1-T6592: an unreadable raw directory preserves failure and names the cause", (t) => {
  const dir = fixture(t);
  const stub = join(dir, "node");
  writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "# tests 1" "# pass 1" "# fail 0" "# cancelled 0" "Error [ERR_OPERATION_FAILED]: coverage file is empty: raw/coverage-1-1791500613083-0.json"\nexit 1\n');
  chmodSync(stub, 0o755);
  const result = spawnSync(process.execPath, [wrapper, "--coverage-first-pass", "fixture.test.mjs", stub,
    "--test", "--experimental-test-coverage"], { cwd: dir, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, NODE_V8_COVERAGE: "", TEST_RETRY: "1", TEST_RETRY_BUDGET_SECONDS: "" } });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /could not drop empty or truncated coverage files:.*ENOTDIR/);
  assert.doesNotMatch(result.stdout, /FLAKE-RETRY-RECOVERED/);
});
