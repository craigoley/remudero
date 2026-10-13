import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";
import { assertBrowserTeardownSources, assertTrackedBrowserTeardown, trackedBrowserTestSources } from "./lib/browser-test-corpus.js";

const LAUNCH = ["chromium", "launch"].join(".") + "(";
const validSource = () => [
  `browserPromise = ${LAUNCH}{});`,
  "after(async () => {",
  "  const launched = await browserPromise;",
  "  await launched?.close();",
  "});",
].join("\n");

function fixture(t: TestContext): GitRepo {
  const repo = gitRepo({ kind: "browser-corpus" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "test"));
  for (const name of ["a", "b", "c"]) writeFileSync(join(repo.dir, "test", `${name}.test.ts`), validSource());
  repo.git("add", "test");
  repo.git("commit", "--quiet", "-m", "test: seed real corpus");
  return repo;
}

const realList = (root: string) => execFileSync("git", ["ls-files", "-z", "--", "test"], { cwd: root, encoding: "utf8" });

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GUARD_TITLE = "every browser-launching test file awaits the launch PROMISE";

/** Env for a nested `node --test` without the parent runner's markers (see serve-browser-teardown.test.ts). */
function cleanTestEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_V8_COVERAGE = undefined;
  return env;
}

/** Install the REAL shipped guard (and its sibling reader) into a fixture repo, track a fourth browser suite. */
function installGuard(repo: GitRepo): void {
  mkdirSync(join(repo.dir, "test", "lib"), { recursive: true });
  for (const file of ["test/serve-browser-teardown.test.ts", "test/lib/browser-test-corpus.ts"]) {
    copyFileSync(join(REPO_ROOT, file), join(repo.dir, file));
  }
  writeFileSync(join(repo.dir, "test", "d.test.ts"), validSource());
  repo.git("add", "test");
  repo.git("commit", "--quiet", "-m", "test: install the real browser teardown guard");
}

/** Run ONLY the guard's corpus test, as a real subprocess, rooted in the fixture repo. */
function runGuard(repo: GitRepo): { status: number | null; output: string } {
  const run = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--test", "--test-reporter=tap", "--test-name-pattern", GUARD_TITLE, "test/serve-browser-teardown.test.ts"],
    { cwd: repo.dir, timeout: 90_000, encoding: "utf8", env: cleanTestEnv() },
  );
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

test("browser teardown corpus reads tracked nested tests without traversing transient fixtures", (t) => {
  const repo = fixture(t);
  const transient = join(repo.dir, "test", ".tmp-w1-t1053-audit-fixture");
  mkdirSync(transient);
  writeFileSync(join(transient, "not-a-real-suite.test.ts"), `broken ${LAUNCH}{});`);
  assert.deepEqual(trackedBrowserTestSources(repo.dir).map(s => s.path), ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]);
  assertTrackedBrowserTeardown(repo.dir);
  // Removing an untracked fixture after enumeration must not affect any real source read.
  const afterListing = trackedBrowserTestSources(repo.dir, root => {
    const files = realList(root);
    rmSync(transient, { recursive: true });
    return files;
  });
  assert.equal(afterListing.length, 3);
  mkdirSync(join(repo.dir, "test", "nested"));
  const nested = "test/nested/new suite\nwith newline.test.ts";
  writeFileSync(join(repo.dir, nested), validSource());
  repo.git("add", nested);
  repo.git("commit", "--quiet", "-m", "test: add nested browser suite");
  assert.ok(trackedBrowserTestSources(repo.dir).some(s => s.path === nested));
  assertBrowserTeardownSources(trackedBrowserTestSources(repo.dir));
  // Current working bytes must override the older committed launch text.
  writeFileSync(join(repo.dir, nested), "// no browser in current bytes\n");
  assert.equal(trackedBrowserTestSources(repo.dir).length, 3);
});

test("browser teardown corpus reads tracked nested tests without traversing transient fixtures: the shipped guard ignores an untracked broken suite", (t) => {
  const repo = fixture(t);
  installGuard(repo);
  const transient = join(repo.dir, "test", ".tmp-w1-t1053-audit-fixture");
  mkdirSync(transient);
  writeFileSync(join(transient, "not-a-real-suite.test.ts"), `broken ${LAUNCH}{});`);
  const { status, output } = runGuard(repo);
  // A guard that still greps the live tree meets the untracked broken launch text and fails here.
  assert.equal(status, 0, output);
  assert.match(output, /^# pass 1$/m, output);
  assert.match(output, /^# fail 0$/m, output);
});

test("browser teardown corpus refuses unavailable tracked sources without hiding a real regression", (t) => {
  const repo = fixture(t), path = "test/a.test.ts", absolute = join(repo.dir, path);
  rmSync(absolute);
  assert.throws(() => assertTrackedBrowserTeardown(repo.dir), { code: "ENOENT" });
  mkdirSync(absolute);
  assert.throws(() => assertTrackedBrowserTeardown(repo.dir), { code: "EISDIR" });
  rmSync(absolute, { recursive: true });
  writeFileSync(absolute, validSource());
  const denied = Object.assign(new Error("tracked source denied"), { code: "EACCES" });
  assert.throws(() => trackedBrowserTestSources(repo.dir, realList, file => {
    if (file === path) throw denied;
    return readFileSync(join(repo.dir, file), "utf8");
  }), error => error === denied);
  const broken = validSource().replace("const launched = await browserPromise;", "const launched = browser;");
  writeFileSync(absolute, broken);
  assert.throws(() => assertTrackedBrowserTeardown(repo.dir), /test\/a.test.ts: teardown must await/);
});

test("browser teardown corpus refuses unavailable tracked sources without hiding a real regression: the shipped guard fails on a deleted tracked suite", (t) => {
  const repo = fixture(t);
  installGuard(repo);
  // Three tracked browser suites remain on disk, so a guard that scans the live tree still passes its floor.
  rmSync(join(repo.dir, "test", "d.test.ts"));
  const { status, output } = runGuard(repo);
  assert.notEqual(status, 0, output);
  assert.match(output, /ENOENT/, output);
  assert.match(output, /^# fail 1$/m, output);
});

test("browser teardown corpus refuses empty failed malformed and binary evidence", (t) => {
  const repo = fixture(t);
  assert.throws(() => trackedBrowserTestSources(repo.dir, () => ""), /corpus is empty/);
  assert.throws(() => trackedBrowserTestSources(repo.dir, () => "test/a.test.ts"), /not NUL terminated/);
  assert.throws(() => trackedBrowserTestSources(repo.dir, () => "outside.test.ts\0"), /invalid path/);
  assert.throws(() => trackedBrowserTestSources(repo.dir, () => "test/../escape.test.ts\0"), /invalid path/);
  assert.throws(() => trackedBrowserTestSources(repo.dir, () => "test/a.test.ts\0test/a.test.ts\0"), /duplicate paths/);
  assert.throws(() => trackedBrowserTestSources(repo.dir, () => "test/notes.md\0"), /corpus is empty/);
  const outage = new Error("Git corpus unavailable");
  assert.throws(() => trackedBrowserTestSources(repo.dir, () => { throw outage; }), error => error === outage);
  writeFileSync(join(repo.dir, "test", "a.test.ts"), validSource() + "\0");
  assert.throws(() => trackedBrowserTestSources(repo.dir), /source contains NUL bytes/);
});

test("browser teardown corpus rejects missing repository and empty real default listing", (t) => {
  const repo = gitRepo({ kind: "empty-browser-corpus" });
  t.after(() => repo.cleanup());
  assert.throws(() => trackedBrowserTestSources(repo.dir), /tracked test corpus is empty/);
  assert.throws(() => trackedBrowserTestSources(join(repo.dir, "missing")));
});

test("browser teardown corpus excludes only its own source and retains every teardown assertion", (t) => {
  const repo = fixture(t);
  const self = "test/serve-browser-teardown.test.ts";
  writeFileSync(join(repo.dir, self), `guard prose ${LAUNCH}`);
  repo.git("add", self);
  repo.git("commit", "--quiet", "-m", "test: record guard source");
  const sources = trackedBrowserTestSources(repo.dir);
  assert.equal(sources.length, 3);
  assertBrowserTeardownSources(sources);
  assert.throws(() => assertBrowserTeardownSources(sources.slice(0, 2)), /expected at least/);
  assert.throws(() => assertBrowserTeardownSources(sources.map(s => ({ ...s, source: s.source.replace("browserPromise =", "browser =") }))), /assigned to browserPromise/);
  const unsafe = validSource() + "\nafter(async () => {\n  await browser.close();\n});";
  assert.throws(() => assertBrowserTeardownSources(sources.map(s => ({ ...s, source: unsafe }))), /closing the resolved handle is the leak/);
});
