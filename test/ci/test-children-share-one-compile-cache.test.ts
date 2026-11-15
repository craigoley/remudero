import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
// @ts-expect-error The measurement CLI has no declaration file.
import { measureSuiteStarts } from "#scripts/list-rule-suites.mjs";
// @ts-expect-error The coverage runner has no declaration file.
import { coverageChildEnvironment } from "#scripts/test-with-retry.mjs";
import { acquireTestSlot, acquireTestSlotAsync, admitStaticWork, type TestSlotLease } from "#src/lib/test-slot.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-test-compile-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "slots");
  mkdirSync(dir);
  const options = { dir, slots: 1, waitBoundMs: 0, load: () => ({ cores: 4, load1: 0 }),
    memoryHeadroom: () => undefined, log: () => {} };
  const lease = acquireTestSlot("compile cache fixture", options);
  assert.equal(lease.outcome, "acquired");
  t.after(() => lease.release());
  return { root, dir, options, lease };
}

function childEnv(lease: TestSlotLease): NodeJS.ProcessEnv {
  assert.ok(lease.childEnvironment?.NODE_COMPILE_CACHE, "the lease must supply the cache directory");
  return { ...process.env, ...lease.childEnvironment, NODE_DISABLE_COMPILE_CACHE: undefined,
    NODE_V8_COVERAGE: "", NODE_TEST_CONTEXT: undefined };
}

const probe = `
import { enableCompileCache, getCompileCacheDir } from 'node:module';
console.log(JSON.stringify({ status: enableCompileCache().status, dir: getCompileCacheDir() ?? null }));
`;

function runProbe(env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", probe],
    { cwd: REPO_ROOT, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { status: number; dir: string | null };
}

function cacheFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? cacheFiles(path) : [path];
  });
}

test("W1-T11938 c1 test children get one scratch compile cache", async t => {
  const { dir, options, lease } = fixture(t);
  const env = childEnv(lease);
  const cache = join(dir, "node-compile-cache");
  assert.equal(env.NODE_COMPILE_CACHE, cache, "cache follows the shared scratch slot directory");
  assert.equal(existsSync(cache), false, "Node creates the cache on demand");
  assert.equal(runProbe(env).status, constants.compileCacheStatus.ALREADY_ENABLED);
  assert.equal(existsSync(cache), true);
  lease.release();
  const next = await acquireTestSlotAsync("next compile cache child", options);
  t.after(() => next.release());
  assert.equal(next.childEnvironment?.NODE_COMPILE_CACHE, cache, "new leases reuse the same directory");
  const staticWork = admitStaticWork("tsx static child", { ...options, memoryBytes: 1 });
  t.after(() => staticWork.release());
  assert.equal(staticWork.childEnvironment?.NODE_COMPILE_CACHE, cache);
  const inherited = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { acquireTestSlot } from '#src/lib/test-slot.js';
    const lease = acquireTestSlot('nested compile cache child', { waitBoundMs: 0 });
    console.log(JSON.stringify({ note: lease.note, cache: lease.childEnvironment?.NODE_COMPILE_CACHE }));
    lease.release();
  `], { cwd: REPO_ROOT, env: childEnv(next), encoding: "utf8" });
  assert.equal(inherited.status, 0, inherited.stderr);
  const nested = JSON.parse(inherited.stdout);
  assert.match(nested.note, /inherited live parent test slot/);
  assert.equal(nested.cache, cache);
});

test("W1-T11938 c2 coverage children keep the compile cache off", t => {
  const { lease } = fixture(t);
  const ordinary = childEnv(lease);
  const covered = coverageChildEnvironment(ordinary) as NodeJS.ProcessEnv;
  assert.equal(covered.NODE_COMPILE_CACHE, undefined);
  assert.equal(covered.NODE_DISABLE_COMPILE_CACHE, "1");
  assert.ok(ordinary.NODE_COMPILE_CACHE, "coverage must not mutate the ordinary child environment");
  assert.deepEqual(runProbe(covered), { status: constants.compileCacheStatus.DISABLED, dir: null });
  assert.equal(existsSync(ordinary.NODE_COMPILE_CACHE), false, "coverage creates no cache");
});

test("W1-T11938 c3 a second measured start reuses the cache", t => {
  const { root, lease } = fixture(t);
  const env = childEnv(lease);
  const cache = env.NODE_COMPILE_CACHE!;
  const suite = join(root, "measured.test.mjs");
  writeFileSync(suite, "import { test } from 'node:test'; test('measured child', () => {});\n");
  t.diagnostic("before: compile cache disabled; after: the leased compile cache, initially empty");
  const uncached = (file: string, args: readonly string[], options: SpawnSyncOptions) => spawnSync(file, args,
    { ...options, env: coverageChildEnvironment({ ...env, NODE_DEBUG_NATIVE: "COMPILE_CACHE" }), stdio: "pipe" });
  assert.equal(measureSuiteStarts(3, suite, { repoRoot: REPO_ROOT, run: uncached }), 0);
  assert.equal(existsSync(cache), false);
  let starts = 0;
  let written: string[] = [];
  const run = (file: string, args: readonly string[], options: SpawnSyncOptions) => {
    const result = spawnSync(file, args, { ...options, env: { ...env, NODE_DEBUG_NATIVE: "COMPILE_CACHE" }, stdio: "pipe" });
    assert.equal(result.status, 0, String(result.stderr));
    starts++;
    if (starts === 1) {
      written = cacheFiles(cache);
      assert.ok(written.length > 0, "the first measured start wrote cache entries");
    } else {
      const trace = `${String(result.stdout)}\n${String(result.stderr)}`;
      const reads = trace.split("\n").filter(line => line.includes("success, size="));
      assert.ok(written.some(path => reads.some(line => line.includes(`reading cache from ${path} for `))),
        "the second measured start read entries written by the first");
      assert.ok(trace.includes(`${suite} was accepted`), "V8 accepted the measured suite's cached code");
    }
    return result;
  };
  assert.equal(measureSuiteStarts(3, suite, { repoRoot: REPO_ROOT, run }), 0);
  assert.equal(starts, 3);
});

test("W1-T11938 c4 an unusable cache dir runs the child uncached", t => {
  const { lease } = fixture(t);
  const env = childEnv(lease);
  writeFileSync(env.NODE_COMPILE_CACHE!, "a file cannot be a cache directory");
  const result = runProbe(env);
  assert.equal(result.status, constants.compileCacheStatus.FAILED);
  assert.equal(result.dir, null);
});
