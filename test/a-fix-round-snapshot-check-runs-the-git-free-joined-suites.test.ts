import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
// @ts-ignore executable census module has no declaration file.
import { gitFreeCensusSuites, makeGitAbsentBin, PRECHECK_PATH_TRIGGERED_SUITES, PRECHECK_TRIGGERED_SUITES } from "../scripts/census-precheck.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_ENV = "RMD_CENSUS_SNAPSHOT";
const CITATION = "test/citation-anchor-census.test.ts";
const SCRIPT = "scripts/citation-anchor-census.mjs";
const SKILL_CENSUS = "test/rules/every-applies-to-skill-is-selectable-and-bounded.test.ts";
const SHARD = "plan/tasks.d/W1-T9000-fixture.yaml";
const SHARD_COUNT = 901; // the census's real-repo test refuses a corpus of 900 shards or fewer
const HYGIENE = "./test/setup/tmp-hygiene.ts";
/** A throwaway suite whose only act is spawning git: the positive control for the ENOENT detector. It is written to a
 *  temp dir rather than borrowing a real repo suite, so this file never runs an admitted census suite itself (that run
 *  belongs to fast-gate-admits-the-census-class alone). */
const GIT_SPAWNING_CONTROL = [
  'import { test } from "node:test";',
  'import { execFileSync } from "node:child_process";',
  'test("spawns git", () => { execFileSync("git", ["--version"]); });',
  "",
].join("\n");
/** How a spawn of an absent git reads in a suite's own output. */
const GIT_ENOENT = /spawn(?:Sync)? git ENOENT|ENOENT[^\n]*\bgit\b|\bgit\b[^\n]*ENOENT/;

function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (/^GIT_|^NODE_TEST_CONTEXT$|^NODE_V8_COVERAGE$/.test(key)) delete env[key];
  return env;
}

/** A worker tree holding one real git-free census suite (the citation-anchor census), its script and a 901-shard corpus,
 *  plus a frozen snapshot of that tree as the merge base. No `.git` exists anywhere in it. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-gitfree-snapshot-"));
  const real = [CITATION, SCRIPT, "scripts/lib/argv.mjs", "src/lib/tmp.ts", "src/lib/clock.ts", "package.json"];
  const texts: Record<string, string> = {
    "MASTER-PLAN.md": "# plan\n",
    // The always-on skill census is gitFree and joins every nonempty diff; this tree carries a healthy stand-in for it.
    [SKILL_CENSUS]: 'import { test } from "node:test";\ntest("skill census stand-in", () => undefined);\n',
  };
  for (let i = 0; i < SHARD_COUNT; i++) {
    texts[`plan/tasks.d/W1-T${9000 + i}-fixture.yaml`] = `id: W1-T${9000 + i}\nrationale: |\n  nothing cites a pull request here.\n`;
  }
  for (const path of real) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(root, path));
    texts[path] = readFileSync(join(root, path), "utf8");
  }
  for (const [path, text] of Object.entries(texts)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  const snapshotDir = mkdtempSync(join(tmpdir(), "rmd-gitfree-snapshot-file-"));
  const snapshot = join(snapshotDir, "snapshot.json");
  const paths = Object.keys(texts).filter((p) => p !== "MASTER-PLAN.md");
  writeFileSync(snapshot, JSON.stringify({ version: 1, root, mergeBase: "base-sha", headPaths: paths, basePaths: paths,
    baseBlobs: Object.fromEntries(paths.map((p) => [p, texts[p]])), mainBlobs: {} }));
  return { root, snapshot, snapshotDir };
}

function precheck(f: { root: string; snapshot: string }) {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/census-precheck.mjs"), "--root", f.root],
    { cwd: ROOT, env: cleanEnv({ [SNAPSHOT_ENV]: f.snapshot }), encoding: "utf8", timeout: 120_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, text: `${result.stdout}${result.stderr}` };
}

test("W1-T9484: a joined git-free suite runs from the snapshot and its red refuses the push", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, SHARD), "id: W1-T9001\nrationale: |\n  still nothing to cite.\n");
    const clean = precheck(f);
    assert.equal(clean.status, 0, clean.text);
    assert.doesNotMatch(clean.text, /NOT MEASURED|snapshot reader unavailable/);

    rmSync(join(f.root, SHARD)); // 900 shards are left, which the census's real-repo test refuses
    rmSync(join(f.root, "plan/tasks.d/W1-T9001-fixture.yaml"));
    const refused = precheck(f);
    assert.equal(refused.status, 1, refused.text);
    assert.match(refused.text, /census-suite: test\/citation-anchor-census\.test\.ts fails/);
    assert.doesNotMatch(refused.text, /snapshot reader unavailable/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.snapshotDir, { recursive: true, force: true });
  }
});

test("W1-T9484: a joined suite that needs git stays NOT MEASURED and names itself, beside a measured git-free one", () => {
  const f = fixture();
  try {
    // The nested-preflight census is not gitFree: it is triggered by editing its own file.
    const needsGit = "test/no-test-drives-a-real-preflight-against-the-repository-root.test.ts";
    assert.ok(!gitFreeCensusSuites().includes(needsGit));
    mkdirSync(dirname(join(f.root, needsGit)), { recursive: true });
    writeFileSync(join(f.root, needsGit), "export {};\n");
    writeFileSync(join(f.root, SHARD), "id: W1-T9001\nrationale: |\n  an edited shard.\n");
    const result = precheck(f);
    assert.equal(result.status, 2, result.text);
    assert.match(result.text, /census suites NOT MEASURED - git-free snapshot reader unavailable for test\/no-test-drives-a-real-preflight/);
    assert.doesNotMatch(result.text, /unavailable for [^\n]*citation-anchor-census/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.snapshotDir, { recursive: true, force: true });
  }
});

test("W1-T9484: every suite declared gitFree runs with git absent from PATH", () => {
  const declared = gitFreeCensusSuites() as string[];
  const rows = [...PRECHECK_TRIGGERED_SUITES, ...PRECHECK_PATH_TRIGGERED_SUITES] as { testFile: string; gitFree?: boolean }[];
  assert.deepEqual(declared, rows.filter((row) => row.gitFree === true).map((row) => row.testFile));
  assert.ok(declared.includes("test/worktree-creation-census.test.ts"), "the worktree-creation census qualifies");
  assert.ok(!declared.includes("test/the-affected-suite-reach-ratchet.test.ts"), "the reach ratchet is read from the snapshot, not declared");

  const absent = makeGitAbsentBin();
  const controlDir = mkdtempSync(join(tmpdir(), "rmd-gitfree-control-"));
  try {
    // Positive controls: git really is gone from this PATH, and the detector reads a real git-less failure.
    const probe = spawnSync("git", ["--version"], { env: { PATH: absent.bin }, encoding: "utf8" });
    assert.equal((probe.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
    assert.equal(spawnSync("sh", ["-c", "exit 0"], { env: { PATH: absent.bin } }).status, 0, "other tools stay reachable");
    const run = (files: string[]) => spawnSync(process.execPath,
      ["--test", "--test-reporter=tap", "--import", "tsx", "--import", HYGIENE, ...files],
      { cwd: ROOT, env: cleanEnv({ PATH: absent.bin }), encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    const controlFile = join(controlDir, "spawns-git.test.mjs");
    writeFileSync(controlFile, GIT_SPAWNING_CONTROL);
    const control = run([controlFile]);
    assert.notEqual(control.status, 0, "the git-spawning control fails without git");
    assert.match(`${control.stdout}${control.stderr}`, GIT_ENOENT, "a suite that spawns git reads as ENOENT here");

    const result = run(declared);
    assert.ifError(result.error);
    const text = `${result.stdout}${result.stderr}`;
    assert.match(text, /^# tests \d+$/m, text.slice(-600));
    assert.doesNotMatch(text, GIT_ENOENT, "a gitFree suite spawned git");
  } finally {
    absent.cleanup();
    rmSync(controlDir, { recursive: true, force: true });
  }
});

function reachFixture(headValue = 2, baseValue = 1, baseExpected = 1) {
  const f = fixture();
  const snapshot = JSON.parse(readFileSync(f.snapshot, "utf8"));
  snapshot.instrumentSurface = ["^scripts/citation-anchor-census\\.mjs$"];
  snapshot.instrumentExclusions = {};
  const pkg = JSON.parse(readFileSync(join(f.root, "package.json"), "utf8"));
  pkg.scripts = { fixture: "node scripts/citation-anchor-census.mjs" };
  const packageText = JSON.stringify(pkg);
  writeFileSync(join(f.root, "package.json"), packageText);
  snapshot.baseBlobs["package.json"] = packageText;
  const suite = "test/the-affected-suite-reach-ratchet.test.ts";
  const module = "src/lib/affected-suites.ts";
  const baseline = "scripts/affected-reach-baseline.json";
  const suiteText = [
    'import assert from "node:assert/strict";',
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { test } from "node:test";',
    'import { value } from "../src/lib/affected-suites.js";',
    'const snapshot = JSON.parse(readFileSync(process.env.RMD_CENSUS_SNAPSHOT, "utf8"));',
    'test("snapshot reach uses its own selector and baseline", () => {',
    '  writeFileSync(`${snapshot.root}/reach-child-observed`, String(value));',
    '  assert.equal(value, JSON.parse(readFileSync(`${snapshot.root}/scripts/affected-reach-baseline.json`, "utf8")).expected);',
    '});', "",
  ].join("\n");
  const baseTexts = { [suite]: suiteText, [module]: `export const value = ${baseValue};\n`,
    [baseline]: JSON.stringify({ expected: baseExpected }) };
  const headTexts = { ...baseTexts, [module]: `export const value = ${headValue};\n`,
    [baseline]: JSON.stringify({ expected: 2 }) };
  for (const [path, text] of Object.entries(headTexts)) {
    mkdirSync(dirname(join(f.root, path)), { recursive: true });
    writeFileSync(join(f.root, path), text);
    snapshot.headPaths.push(path);
    snapshot.basePaths.push(path);
    snapshot.baseBlobs[path] = baseTexts[path as keyof typeof baseTexts];
  }
  writeFileSync(f.snapshot, JSON.stringify(snapshot));
  return f;
}

function removeReachFixture(f: ReturnType<typeof reachFixture>) {
  rmSync(f.root, { recursive: true, force: true });
  rmSync(f.snapshotDir, { recursive: true, force: true });
}

test("snapshot reach executes the candidate selector with that candidate's baseline", () => {
  const f = reachFixture();
  try {
    const result = precheck(f);
    assert.equal(result.status, 0, result.text);
    assert.equal(readFileSync(join(f.root, "reach-child-observed"), "utf8"), "2");
  } finally { removeReachFixture(f); }
});

test("snapshot reach refuses a candidate regression against a healthy base using each tree's selector", () => {
  const f = reachFixture(3);
  try {
    const result = precheck(f);
    assert.equal(readFileSync(join(f.root, "reach-child-observed"), "utf8"), "3");
    assert.equal(result.status, 1, result.text);
    assert.match(result.text, /census-suite: test\/the-affected-suite-reach-ratchet\.test\.ts fails/);
  } finally { removeReachFixture(f); }
});

test("snapshot reach retains its existing subtraction of a failure already present on the base", () => {
  const f = reachFixture(3, 4, 1);
  try {
    const result = precheck(f);
    assert.equal(readFileSync(join(f.root, "reach-child-observed"), "utf8"), "3");
    assert.equal(result.status, 0, result.text);
  } finally { removeReachFixture(f); }
});

test("snapshot reach reports an unavailable base suite as unmeasured instead of subtracting its failure", () => {
  const f = reachFixture(3);
  try {
    const snapshot = JSON.parse(readFileSync(f.snapshot, "utf8"));
    snapshot.basePaths = snapshot.basePaths.filter((path: string) => path !== "test/the-affected-suite-reach-ratchet.test.ts");
    writeFileSync(f.snapshot, JSON.stringify(snapshot));
    const result = precheck(f);
    assert.equal(result.status, 2, result.text);
    assert.match(result.text, /merge-base suite test\/the-affected-suite-reach-ratchet\.test\.ts is absent/);
  } finally { removeReachFixture(f); }
});
