import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { acquireTestSlot, COMPILE_CACHE_TEST_LABELS, TEST_COMPILE_CACHE_DIR_NAME, TEST_SLOT_DIR_ENV, TEST_SLOT_PARENT_ENV, testCompileCache,
  withTestCompileCache, type TestSlotLease } from "#src/lib/test-slot.js";
// @ts-ignore the executable .mjs module is exercised directly and has no declaration file.
import { suiteEnvironment as untypedSuiteEnvironment } from "#scripts/list-rule-suites.mjs";
// @ts-ignore the executable .mjs module is exercised directly and has no declaration file.
import { coverageChildEnvironment as untypedCoverageChildEnvironment } from "#scripts/test-with-retry.mjs";

const suiteEnvironment = untypedSuiteEnvironment as (args: readonly string[], env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
const coverageChildEnvironment = untypedCoverageChildEnvironment as (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

// @census-reads: none — only fixture directories and the probe children's own output are read.
const SUITE_ARGS = ["--test", "--test-reporter=spec", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "test/x.test.ts"];
const COVERAGE_ARGS = ["--enable-source-maps", "--experimental-test-coverage", "--test", "--import", "tsx", "test/x.test.ts"];

function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}compile-cache-`));
  t.after(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function lease(slotDir: string): TestSlotLease {
  return { outcome: "acquired", concurrency: 1, waitedMs: 0, note: "fixture", refresh: () => {}, release: () => {},
    childEnvironment: { [TEST_SLOT_DIR_ENV]: slotDir } };
}

/** A real node child under `env` (no ambient cache, coverage or test context): its compile-cache dir and status. */
function probe(env: NodeJS.ProcessEnv, cwd: string): { cacheDir: string | null; status: number | null; stderr: string } {
  const script = 'const m = require("node:module"); console.log(JSON.stringify({ cacheDir: m.getCompileCacheDir() ?? null }));';
  const res = spawnSync(process.execPath, ["-e", script], { cwd, encoding: "utf8", timeout: 60_000,
    env: { ...env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: "" } });
  const line = res.stdout.trim().split("\n").at(-1) ?? "{}";
  return { cacheDir: (JSON.parse(line || "{}") as { cacheDir?: string | null }).cacheDir ?? null, status: res.status, stderr: res.stderr };
}

const plainEnv = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({ ...process.env, NODE_COMPILE_CACHE: undefined, NODE_DISABLE_COMPILE_CACHE: undefined, NODE_V8_COVERAGE: "",
    [TEST_SLOT_PARENT_ENV]: undefined, ...extra });

test("W1-T11938 criterion 1: test and rule-suite children name one NODE_COMPILE_CACHE directory on the scratch disk", (t) => {
  const slotDir = fixture(t);
  const shared = join(slotDir, TEST_COMPILE_CACHE_DIR_NAME);
  const env = plainEnv({ [TEST_SLOT_DIR_ENV]: slotDir });

  // A rule-suite child: the configured slot dir (the scratch bind) holds the one cache directory, made on demand.
  const cache = testCompileCache(SUITE_ARGS, env);
  assert.deepEqual(cache, { environment: { NODE_COMPILE_CACHE: shared }, dir: shared });
  assert.equal(statSync(shared).isDirectory(), true);
  assert.equal(statSync(shared).mode & 0o777, 0o777, "a directory this process made is shared with every uid");
  assert.equal(suiteEnvironment(SUITE_ARGS, env).NODE_COMPILE_CACHE, shared);
  assert.equal(suiteEnvironment(SUITE_ARGS, env).PATH, process.env.PATH, "the suite child keeps this process's environment");

  // A `npm test` child: the test:npm lease names the same directory beside its slot claim; other labels add nothing.
  assert.equal(COMPILE_CACHE_TEST_LABELS.has("test:npm"), true);
  const npm = withTestCompileCache("test:npm", lease(slotDir), ["node", "scripts/test-run.mjs", ...SUITE_ARGS], env);
  assert.deepEqual(npm.childEnvironment, { [TEST_SLOT_DIR_ENV]: slotDir, NODE_COMPILE_CACHE: shared });
  const other = withTestCompileCache("coverage-ratchet:test-with-coverage", lease(slotDir), SUITE_ARGS, env);
  assert.deepEqual(other.childEnvironment, { [TEST_SLOT_DIR_ENV]: slotDir });
  const unslotted = withTestCompileCache("test:npm", { ...lease(slotDir), childEnvironment: undefined }, SUITE_ARGS, env);
  assert.equal(unslotted.childEnvironment, undefined);

  // The real acquisition path hands the directory down, and a real child under that environment uses it.
  const slots = fixture(t);
  const held = acquireTestSlot("test:npm", { dir: slots, slots: 1 });
  try {
    const childEnvironment = held.childEnvironment ?? {};
    if (process.env.NODE_V8_COVERAGE || process.env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
      assert.equal(childEnvironment.NODE_COMPILE_CACHE, undefined, "this coverage process's own lease stays uncached");
    } else {
      assert.equal(childEnvironment.NODE_COMPILE_CACHE, join(slots, TEST_COMPILE_CACHE_DIR_NAME));
    }
  } finally {
    held.release();
  }
  const child = probe(suiteEnvironment(SUITE_ARGS, env), slotDir);
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.cacheDir?.startsWith(`${shared}/`), `child cache dir ${child.cacheDir} is inside ${shared}`);
});

test("W1-T11938 criterion 2: coverage children still disable the compile cache", (t) => {
  const slotDir = fixture(t);
  const shared = join(slotDir, TEST_COMPILE_CACHE_DIR_NAME);
  const env = plainEnv({ [TEST_SLOT_DIR_ENV]: slotDir });

  const byArgv = testCompileCache(COVERAGE_ARGS, env);
  assert.deepEqual(byArgv.environment, { NODE_DISABLE_COMPILE_CACHE: "1" });
  assert.equal(byArgv.dir, undefined);
  const byEnv = testCompileCache(SUITE_ARGS, { ...env, NODE_V8_COVERAGE: join(slotDir, "raw") });
  assert.deepEqual(byEnv.environment, { NODE_DISABLE_COMPILE_CACHE: "1" });
  assert.deepEqual(testCompileCache(SUITE_ARGS, { ...env, NODE_DISABLE_COMPILE_CACHE: "" }).environment, {});
  assert.throws(() => statSync(shared), /ENOENT/, "a coverage child never creates the cache directory");

  // A `npm test -- --experimental-test-coverage` run: its lease disables the cache instead of naming it.
  const npm = withTestCompileCache("test:npm", lease(slotDir), ["node", "scripts/test-run.mjs", ...COVERAGE_ARGS], env);
  assert.deepEqual(npm.childEnvironment, { [TEST_SLOT_DIR_ENV]: slotDir, NODE_DISABLE_COMPILE_CACHE: "1" });

  // A coverage child built from a cached test child's environment, as scripts/test-with-retry.mjs builds it, is uncached.
  const cachedParent = suiteEnvironment(SUITE_ARGS, env);
  assert.equal(cachedParent.NODE_COMPILE_CACHE, shared);
  const coverageChild = coverageChildEnvironment(cachedParent);
  assert.equal(Object.hasOwn(coverageChild, "NODE_COMPILE_CACHE"), false);
  const disabled = probe({ ...cachedParent, ...testCompileCache(COVERAGE_ARGS, cachedParent).environment }, slotDir);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.cacheDir, null, "Node honours NODE_DISABLE_COMPILE_CACHE over an inherited NODE_COMPILE_CACHE");
});

test("W1-T11938 criterion 3: a repeated child start reuses the compile cache its first start wrote", (t) => {
  const slotDir = fixture(t);
  const module = join(slotDir, "probe.mjs");
  writeFileSync(module, "export const answer = 42;\nconsole.log(`answer ${answer}`);\n");
  const env = { ...suiteEnvironment(SUITE_ARGS, plainEnv({ [TEST_SLOT_DIR_ENV]: slotDir })), NODE_DEBUG_NATIVE: "COMPILE_CACHE",
    NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: "" };
  const start = () => spawnSync(process.execPath, [module], { cwd: slotDir, env, encoding: "utf8", timeout: 60_000 });
  const first = start();
  assert.equal(first.status, 0, first.stderr);
  const shared = join(slotDir, TEST_COMPILE_CACHE_DIR_NAME);
  assert.equal(readdirSync(shared).length, 1, "the first start wrote one versioned cache directory");
  const second = start();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /answer 42/);
  assert.match(second.stderr, /V8 code cache for ESM \S*probe\.mjs was accepted/, "the second start skipped parse and compile");
});

test("W1-T11938 criterion 4: an unusable cache directory never fails a child, it runs uncached", (t) => {
  const root = fixture(t);
  const file = join(root, "a-file");
  writeFileSync(file, "not a directory\n");
  const readOnly = join(root, "read-only");
  mkdirSync(readOnly);
  chmodSync(readOnly, 0o555);
  const env = plainEnv();
  const unusable = [join(file, TEST_COMPILE_CACHE_DIR_NAME), file, ...(process.getuid?.() === 0 ? [] : [join(readOnly, "cache")])];
  for (const dir of unusable) {
    const cache = testCompileCache(SUITE_ARGS, env, { dir });
    assert.deepEqual(cache.environment, {}, `${dir} adds no NODE_COMPILE_CACHE`);
    assert.match(cache.reason ?? "", /unusable: (?:EEXIST|ENOTDIR|EACCES)/);
  }
  // A slot dir under a regular file (the default resolution) is unusable the same way, and so is a test:npm lease's.
  assert.deepEqual(testCompileCache(SUITE_ARGS, plainEnv({ [TEST_SLOT_DIR_ENV]: file })).environment, {});
  assert.deepEqual(withTestCompileCache("test:npm", lease(file), SUITE_ARGS, env).childEnvironment, { [TEST_SLOT_DIR_ENV]: file });
  // The rule-suite child really runs, uncached, with the environment it was handed.
  const child = probe(suiteEnvironment(SUITE_ARGS, plainEnv({ [TEST_SLOT_DIR_ENV]: file })), root);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.cacheDir, null);
});
