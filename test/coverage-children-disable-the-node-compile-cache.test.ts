import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// @census-reads: none — only child JSON and raw V8 reports from the private fixture are read.
const wrapper = fileURLToPath(new URL("../scripts/test-with-retry.mjs", import.meta.url));
const { coverageChildEnvironment, coverageRetryInvocation } = (await import(pathToFileURL(wrapper).href)) as {
  coverageChildEnvironment: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  coverageRetryInvocation: (cmd: string, args: string[], files: string[], env: NodeJS.ProcessEnv) =>
    { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null;
};

test("coverage child environments disable Node compile caching and preserve native V8 coverage", () => {
  for (const inheritedDisable of [undefined, "", "0", "1"]) {
    const env = Object.freeze({
      NODE_COMPILE_CACHE: "/inherited/compile-cache",
      NODE_DISABLE_COMPILE_CACHE: inheritedDisable,
      NODE_V8_COVERAGE: "/native/coverage",
      NODE_OPTIONS: "--enable-source-maps",
    });
    const child = coverageChildEnvironment(env);
    assert.deepEqual(child, {
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_V8_COVERAGE: "/native/coverage",
      NODE_OPTIONS: "--enable-source-maps",
    });
    assert.equal(Object.hasOwn(child, "NODE_COMPILE_CACHE"), false);
    assert.equal(env.NODE_COMPILE_CACHE, "/inherited/compile-cache");
    assert.equal(env.NODE_DISABLE_COMPILE_CACHE, inheritedDisable);
  }
});

test("uninstrumented coverage retries preserve the original compile-cache environment", () => {
  const env = Object.freeze({
    NODE_COMPILE_CACHE: "/ordinary/compile-cache",
    NODE_DISABLE_COMPILE_CACHE: "0",
    NODE_V8_COVERAGE: "/outer/coverage",
  });
  const retry = coverageRetryInvocation(process.execPath,
    ["--test", "--experimental-test-coverage", "test/*.test.ts"], ["test/failed.test.ts"], env);
  assert.ok(retry);
  assert.deepEqual(retry.env, { ...env, NODE_V8_COVERAGE: "" });
  assert.deepEqual(retry.args, ["--test", "--test-reporter=tap", "test/failed.test.ts"]);
  assert.equal(env.NODE_V8_COVERAGE, "/outer/coverage");
});

// A real wrapper and Node child exercise the default spawn boundary without a nested test runner.
const probe = `
import { constants, enableCompileCache, getCompileCacheDir } from "node:module";
console.log(JSON.stringify({
  cache: process.env.NODE_COMPILE_CACHE ?? null,
  disabled: process.env.NODE_DISABLE_COMPILE_CACHE ?? null,
  coverage: process.env.NODE_V8_COVERAGE ?? null,
  status: enableCompileCache().status,
  disabledStatus: constants.compileCacheStatus.DISABLED,
  cacheDir: getCompileCacheDir() ?? null,
}));
`;

function runProbe(t: TestContext, coverage: boolean, inheritedDisable?: string) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}coverage-compile-cache-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = join(dir, "compile-cache");
  const raw = join(dir, "raw");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_COMPILE_CACHE: cache,
    // Node v24 treats nonempty "0" as disabling too; undefined is the enabled positive control.
    NODE_DISABLE_COMPILE_CACHE: inheritedDisable,
    NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? "",
    TEST_RETRY: "0",
  };
  // This probe is not a nested test runner; retain its suite's child-attribution marker.
  delete env.GITHUB_STEP_SUMMARY;
  const result = spawnSync(process.execPath,
    [wrapper, ...(coverage ? ["--coverage-first-pass", raw] : []), process.execPath,
      "--input-type=module", "--eval", probe],
    { cwd: dir, env, encoding: "utf8", timeout: 10_000, maxBuffer: 1 << 20 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { cache, raw, observed: JSON.parse(result.stdout.trim()) as {
    cache: string | null; disabled: string | null; coverage: string | null;
    status: number; disabledStatus: number; cacheDir: string | null;
  } };
}

test("the real coverage first pass disables inherited and programmatic Node compile caching", (t) => {
  for (const inheritedDisable of [undefined, "0", "1"]) {
  const { raw, observed } = runProbe(t, true, inheritedDisable);
  assert.equal(observed.cache, null);
  assert.equal(observed.disabled, "1");
  assert.equal(observed.status, observed.disabledStatus);
  assert.equal(observed.cacheDir, null);
  assert.equal(observed.coverage, raw);
  const reports = readdirSync(raw).filter((name) => /^coverage-.*\.json$/.test(name));
  assert.ok(reports.length > 0, "native NODE_V8_COVERAGE must still produce raw reports");
  assert.ok(reports.some((name) => {
    const report = JSON.parse(readFileSync(join(raw, name), "utf8")) as { result?: unknown[] };
    return Array.isArray(report.result) && report.result.length > 0;
  }), "a real nonempty V8 coverage corpus is the positive control");
  }
});

test("ordinary wrapper commands retain their original Node compile-cache environment", (t) => {
  const { cache, observed } = runProbe(t, false);
  assert.equal(observed.cache, cache);
  assert.equal(observed.disabled, null);
  assert.notEqual(observed.status, observed.disabledStatus);
  assert.equal(observed.coverage, process.env.NODE_V8_COVERAGE ?? "");
  assert.ok(observed.cacheDir?.startsWith(cache), "the ordinary child's cache remains enabled");
  for (const inheritedDisable of ["0", "1"]) {
    const disabled = runProbe(t, false, inheritedDisable).observed;
    assert.equal(disabled.disabled, inheritedDisable);
    assert.equal(disabled.status, disabled.disabledStatus);
    assert.notEqual(disabled.cache, null, "ordinary settings are not rewritten even when disabled");
  }
});
