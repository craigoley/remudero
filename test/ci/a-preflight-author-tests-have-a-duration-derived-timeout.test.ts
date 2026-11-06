import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
// @ts-expect-error executable JavaScript module has no declaration file.
import { main as preflightAuthor } from "#scripts/preflight-author.mjs";
// @ts-expect-error executable JavaScript module has no declaration file.
import { FAST_TIER_TEST_TIMEOUT_FACTOR } from "#scripts/test-tier-manifest.mjs";
import { join } from "node:path";
import {
  execWhitelistedProof,
  execWhitelistedProofAsync,
  parseWhitelistedProof,
  type AsyncProofSpawner,
  type ProofSpawner,
  type WhitelistedProof,
} from "#src/lib/review.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
const timeoutHelpers = await import("#src/lib/test-run-timeout.js").catch(() => undefined);
import { test } from "node:test";

const FIXTURE_SLOW_THRESHOLD_MS = 7_000;

function assertTimedTestChild(args: readonly string[]): void {
  if (!args.includes("--test")) return;
  const at = args.findIndex(arg => arg === "--test-timeout" || arg.startsWith("--test-timeout="));
  const value = at < 0 ? 0 : Number(args[at] === "--test-timeout" ? args[at + 1] : args[at]!.slice("--test-timeout=".length));
  assert.ok(Number.isFinite(value) && value > 0, "guard refused an untimed real test child before spawning it");
}

function authorFixture() {
  const repo = gitRepo({ kind: "author-timeout", seedCommit: false });
  const root = repo.dir;
  for (const path of ["test/setup", "src", "scripts"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/test-tier-manifest.json"), JSON.stringify({
    thresholdMs: FIXTURE_SLOW_THRESHOLD_MS,
    files: { "test/leaf.test.ts": 12_500 },
  }));
  writeFileSync(join(root, "scripts/diff-class.mjs"), "// fixture has no census path readers\n");
  writeFileSync(join(root, "scripts/census-precheck.mjs"), "console.log('fixture census precheck passed');\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"), "console.log('fixture static preflight passed');\n");
  writeFileSync(join(root, "src/leaf.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "test/leaf.test.ts"), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/leaf.js';",
    "test('fixture leaf', () => assert.equal(value, 2));",
  ].join("\n") + "\n");
  const git = (...args: string[]) => repo.git(...args);
  git("add", ".");
  git("commit", "-m", "test: author timeout fixture base");
  git("remote", "add", "origin", root);
  git("checkout", "-b", "run-unfiled-author-timeout-fixture");
  writeFileSync(join(root, "src/leaf.ts"), "export const value = 2;\n");
  git("add", ".");
  git("commit", "-m", "fix: author timeout fixture change");
  return { root, cleanup: repo.cleanup };
}

function expectedBoundForFile(file: string): number {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/test-tier-manifest.json"), "utf8"));
  const threshold = Number.isFinite(manifest.thresholdMs) && manifest.thresholdMs > 0
    ? manifest.thresholdMs : FIXTURE_SLOW_THRESHOLD_MS;
  const measured = manifest.files?.[file];
  const duration = Number.isFinite(measured) && measured > 0 ? measured : threshold;
  return Math.ceil(Math.max(threshold, duration) * FAST_TIER_TEST_TIMEOUT_FACTOR);
}

test("W1-T11449 criterion 1: the selected author suite gets a bound from its measured duration", (t) => {
  const fixture = authorFixture();
  t.after(fixture.cleanup);
  const argsSeen: string[][] = [];
  const run = (file: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
    if (args.includes("--test")) { argsSeen.push([...args]); assertTimedTestChild(args); }
    return spawnSync(file, args, options);
  };

  assert.equal(preflightAuthor([], { root: fixture.root, spawn: run }), 0);
  const testArgs = argsSeen.find((args) => args.includes("--test") && args.includes("test/leaf.test.ts"));
  assert.ok(testArgs, "the selected fixture suite was actually invoked");
  assert.ok(testArgs.includes(`--test-timeout=${Math.ceil(12_500 * FAST_TIER_TEST_TIMEOUT_FACTOR)}`), testArgs.join(" "));
  assert.ok(testArgs.includes("--test-force-exit"), testArgs.join(" "));
  assert.ok(testArgs.some((arg) => arg.includes("setBlocking")), testArgs.join(" "));
  assert.equal(testArgs.filter((arg) => arg.startsWith("--test-timeout=")).length, 1);
});

test("W1-T11449 criterion 2: the shared policy preserves option pairs and rejects disabled deadlines", () => {
  assert.ok(timeoutHelpers);
  const { boundedNodeTestArgs } = timeoutHelpers;
  const manifest = { thresholdMs: 7_000, files: { "test/moved/slow.test.ts": 20_000 } };
  const args = ["--test", "--test-reporter", "tap", "--test-timeout", "1234", "test/slow.test.ts"];
  const once = boundedNodeTestArgs(args, ["test/slow.test.ts"], manifest);
  assert.deepEqual(once.slice(0, 3), args.slice(0, 3));
  assert.equal(once[once.indexOf("--test-timeout") + 1], "1234");
  assert.deepEqual(boundedNodeTestArgs(once, ["test/slow.test.ts"], manifest), once);
  assert.ok(boundedNodeTestArgs(["--test", "test/slow.test.ts"], ["test/slow.test.ts"], manifest)
    .includes("--test-timeout=480000"), "unique moved basename retains its measurement");
  assert.ok(boundedNodeTestArgs(["--test", "test/moved/slow.test.ts"], [join(REPO_ROOT, "test/moved/slow.test.ts")], manifest, REPO_ROOT)
    .includes("--test-timeout=480000"), "absolute targets are relative to the target checkout");
  for (const value of ["0", "-1", "Infinity", "NaN", ""]) {
    assert.throws(() => boundedNodeTestArgs(["--test", `--test-timeout=${value}`], [], manifest), RangeError);
  }
});

test("W1-T11449 criterion 2: corrupt target metadata is visible and non-test helpers stay lazy", (t) => {
  assert.ok(timeoutHelpers);
  const repo = gitRepo({ kind: "proof-corrupt-metadata", seedCommit: false });
  t.after(repo.cleanup);
  mkdirSync(join(repo.dir, "scripts"));
  writeFileSync(join(repo.dir, "scripts/test-tier-manifest.json"), "{broken");
  assert.throws(() => timeoutHelpers.readTestTierManifest(repo.dir), SyntaxError);
  assert.throws(() => timeoutHelpers.proofTestRunnerArgs(["--test"], repo.dir, []), SyntaxError);
  assert.deepEqual(timeoutHelpers.proofTestRunnerArgs(["grep", "x"], repo.dir, []), ["grep", "x"]);
  assert.equal(timeoutHelpers.derivedNodeTestTimeoutMs([], null), 5_000 * FAST_TIER_TEST_TIMEOUT_FACTOR);
});

const PROOF_FILE = "test/a-proof-timeout-is-not-a-failed-proof.test.ts";
const REPO_MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/test-tier-manifest.json"), "utf8"));
const PROOF_BOUND_MS = expectedBoundForFile(PROOF_FILE);
const observedSync: { args?: readonly string[]; output?: string } = {};
const realSync: ProofSpawner = (_command, args, cwd, timeoutMs) => {
  observedSync.args = [...args];
  assertTimedTestChild(args);
  observedSync.output = execFileSync(process.execPath, [...args], {
    cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  return observedSync.output;
};

const observedAsync: { args?: readonly string[]; output?: string } = {};
const realAsync: AsyncProofSpawner = (_command, args, cwd, timeoutMs) => new Promise((resolve, reject) => {
  observedAsync.args = [...args];
  assertTimedTestChild(args);
  execFile(process.execPath, [...args], {
    cwd, encoding: "utf8", timeout: timeoutMs,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { status: typeof error.code === "number" ? error.code : null, stdout, stderr }));
    else { observedAsync.output = stdout; resolve(stdout); }
  });
});

test("W1-T11449 criterion 2: measured and unmeasured suite durations derive finite policy bounds", () => {
  assert.ok(timeoutHelpers, "the shared timeout helper must be available after the wiring change");
  const { boundedNodeTestArgs, derivedNodeTestTimeoutMs, readTestTierManifest } = timeoutHelpers;
  const fixtureManifest = { thresholdMs: 7_000, files: { "test/slow.test.ts": 20_000, "test/short.test.ts": 2_000 } };
  assert.equal(derivedNodeTestTimeoutMs(["test/short.test.ts", "test/unmeasured.test.ts"], fixtureManifest), 168_000,
    "an unmeasured selected suite uses the manifest threshold");
  assert.equal(derivedNodeTestTimeoutMs(["test/short.test.ts", "test/slow.test.ts"], fixtureManifest), 480_000,
    "the slowest measured selected suite sets the bound");
  assert.equal(readTestTierManifest(join(REPO_ROOT, "missing-test-manifest-fixture")).thresholdMs, 5_000,
    "an unreadable target manifest retains the established default boundary");
  const explicitArgv = boundedNodeTestArgs(["--test", "--test-timeout=1234", "test/short.test.ts"],
    ["test/short.test.ts"], fixtureManifest);
  assert.equal(explicitArgv.filter((arg) => arg.startsWith("--test-timeout=")).length, 1);
  assert.ok(explicitArgv.includes("--test-timeout=1234"));
  assert.deepEqual(boundedNodeTestArgs(["grep", "pattern", "file"], [], fixtureManifest), ["grep", "pattern", "file"],
    "non-Node commands stay unchanged");
});

test("W1-T11449 criterion 2: the synchronous Node proof gets a derived timeout and retains its complete summary", () => {
  assert.ok(REPO_MANIFEST.files?.[PROOF_FILE] > 0, `positive measured-duration control for ${PROOF_FILE}`);
  const proof = parseWhitelistedProof(`unit test: ${PROOF_FILE}`)!;
  assert.equal(execWhitelistedProof(proof, REPO_ROOT, PROOF_BOUND_MS, realSync), "pass");
  assert.ok(observedSync.args?.includes(`--test-timeout=${PROOF_BOUND_MS}`), observedSync.args?.join(" "));
  assert.ok(observedSync.args?.includes("--test-force-exit"), observedSync.args?.join(" "));
  assert.ok(observedSync.args?.some((arg) => arg.includes("setBlocking")), observedSync.args?.join(" "));
  assert.match(observedSync.output ?? "", /# tests \d+/);
  assert.match(observedSync.output ?? "", /# pass \d+/);
});

test("W1-T11449 criterion 2: the asynchronous Node proof gets a derived timeout and retains its complete summary", async () => {
  const proof = parseWhitelistedProof(`unit test: ${PROOF_FILE}`)!;
  assert.equal(await execWhitelistedProofAsync(proof, REPO_ROOT, PROOF_BOUND_MS, realAsync), "pass");
  assert.ok(observedAsync.args?.includes(`--test-timeout=${PROOF_BOUND_MS}`), observedAsync.args?.join(" "));
  assert.ok(observedAsync.args?.includes("--test-force-exit"), observedAsync.args?.join(" "));
  assert.ok(observedAsync.args?.some((arg) => arg.includes("setBlocking")), observedAsync.args?.join(" "));
  assert.match(observedAsync.output ?? "", /# tests \d+/);
  assert.match(observedAsync.output ?? "", /# pass \d+/);
});

test("W1-T11449 criterion 2: an explicit timeout is preserved and non-Node proof argv is unchanged", () => {
  const explicit = parseWhitelistedProof(`unit test: ${PROOF_FILE}`)!;
  explicit.args = ["--test", `--test-timeout=${Math.floor(PROOF_BOUND_MS / 2)}`, ...explicit.args.slice(1)];
  const explicitSeen: string[][] = [];
  const explicitSpawn: ProofSpawner = (_command, args, cwd, timeoutMs) => {
    explicitSeen.push([...args]);
    assertTimedTestChild(args);
    return execFileSync(process.execPath, [...args], {
      cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
  };
  assert.equal(execWhitelistedProof(explicit, REPO_ROOT, PROOF_BOUND_MS, explicitSpawn), "pass");
  assert.equal(explicitSeen[0]?.filter((arg) => arg.startsWith("--test-timeout=")).length, 1);
  assert.ok(explicitSeen[0]?.includes(`--test-timeout=${Math.floor(PROOF_BOUND_MS / 2)}`));

  const grepProof = parseWhitelistedProof("grep: FAST_TIER_TEST_TIMEOUT_FACTOR in scripts/test-tier-manifest.mjs")!;
  const grepArgs: string[][] = [];
  const grepSpawn: ProofSpawner = (command, args, cwd, timeoutMs) => {
    grepArgs.push([...args]);
    return execFileSync(command, [...args], { cwd, encoding: "utf8", timeout: timeoutMs });
  };
  assert.equal(execWhitelistedProof(grepProof, REPO_ROOT, PROOF_BOUND_MS, grepSpawn), "pass");
  assert.deepEqual(grepArgs[0], grepProof.args, "grep proof argv stays byte-for-byte unchanged");
});
