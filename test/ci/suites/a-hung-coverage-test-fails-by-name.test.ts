// @source-text-subject: the coverage shard's test command and the corpus test's teardown are this suite's subject.
// W1-T12415. coverage-shard (4/8) on #14880 (job 122319121555) reported all eight results of
// test/operator-agent-gets-read-the-read-model.test.ts, then that file's child never exited and the
// unbounded shard waited 41 minutes for its 49-minute cancel. The cause: corpus() registers its root
// removal as the first `after` hook; node:test stops at the first hook that throws, so its ENOTEMPTY
// skipped every server close registered after it, and the listening servers kept the child alive.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-expect-error — plain .mjs, no declaration file.
import * as tier from "#scripts/test-tier-manifest.mjs";

type Manifest = { thresholdMs: number; files: Record<string, number> };
const boundArgs = tier.coverageShardHangBoundArgs as (files: string[], manifest: Manifest, root?: string) => string[];
const derived = tier.derivedNodeTestTimeoutMs as (files: string[], manifest: Manifest, root?: string) => number;
const withBound = tier.withCoverageHangBound as (args: string[], manifestPath: string, root?: string) => string[];
const MANIFEST_ENV = tier.COVERAGE_HANG_MANIFEST_ENV as string;
const CAP_MS = tier.COVERAGE_SHARD_TEST_TIMEOUT_CAP_MS as number;
const CEILING_MS = tier.COVERAGE_SHARD_JOB_CEILING_MS as number;
const MIN = 60_000;
const timeoutOf = (args: readonly string[]) => Number(args.find((arg) => arg.startsWith("--test-timeout="))?.slice("--test-timeout=".length));

/** A child `node --test` must not report into this run's own test stream or coverage directory. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: "", ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test("W1-T12415 criterion 1: the coverage shard's test command carries a per-test timeout from the fast tier's duration policy, inside the 49-minute ceiling", () => {
  const workflow = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { "timeout-minutes"?: number; steps?: Array<{ run?: string }> }>;
  };
  const job = workflow.jobs["coverage-ratchet"]!;
  assert.equal(job["timeout-minutes"]! * MIN, CEILING_MS, "COVERAGE_SHARD_JOB_CEILING_MS mirrors the coverage shard's timeout-minutes");
  const run = job.steps!.map((step) => step.run ?? "").find((text) => text.includes("--coverage-first-pass coverage/raw"));
  assert.ok(run, "positive control: found the coverage shard's instrumented test step");
  const line = run.split("\n").find((text) => text.includes("scripts/test-with-retry.mjs --coverage-first-pass coverage/raw"));
  assert.equal(line?.trim(),
    `${MANIFEST_ENV}=scripts/test-tier-coverage-manifest.json node scripts/test-with-retry.mjs --coverage-first-pass coverage/raw \\`,
    "the shard's wrapper is given the instrumented duration manifest that bounds its run");
  const wrapper = readFileSync(join(REPO_ROOT, "scripts/test-with-retry.mjs"), "utf8");
  assert.match(wrapper, /process\.env\[COVERAGE_HANG_MANIFEST_ENV\]/, "the wrapper reads that manifest");
  assert.match(wrapper, /withCoverageHangBound\(tapArgs, hangManifest, process\.cwd\(\)\)/, "and bounds the run it spawns with it");

  // The shard command's own shape, bounded: the flags ride right after --test.
  const file = "test/operator-agent-gets-read-the-read-model.test.ts";
  const coverageManifest = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/test-tier-coverage-manifest.json"), "utf8")) as Manifest;
  const shard = ["--enable-source-maps", "--experimental-test-coverage", "--test", "--import", "tsx", file];
  const bounded = withBound(shard, "scripts/test-tier-coverage-manifest.json", REPO_ROOT);
  assert.deepEqual(bounded.slice(0, 3), shard.slice(0, 3));
  assert.deepEqual(bounded.slice(3, 3 + boundArgs([file], coverageManifest).length), boundArgs([file], coverageManifest));
  assert.equal(timeoutOf(bounded), Math.min(derived([file], coverageManifest), CAP_MS), "the fast tier's duration policy over the shard's files");
  assert.ok(bounded.includes("--test-force-exit"), "a file whose tests all have results exits even with a leaked handle");
  assert.throws(() => withBound(shard, "scripts/no-such-manifest.json", REPO_ROOT), /ENOENT/, "a missing manifest never runs the shard unbounded");

  // The policy is the fast tier's, capped so a hang fails before the ceiling.
  const [longest] = Object.entries(coverageManifest.files).sort((a, b) => b[1] - a[1]);
  const manifest = { thresholdMs: 5000, files: { "test/short.test.ts": 9000, [longest![0]]: longest![1] } };
  assert.equal(timeoutOf(boundArgs(["test/short.test.ts"], manifest)), derived(["test/short.test.ts"], manifest));
  assert.equal(timeoutOf(boundArgs(["test/short.test.ts", longest![0]], manifest)), CAP_MS, "a full shard's longest file prices hours; the cap holds");
  // Measured 2026-11-16 over 16 successful coverage shards: at most 9 minutes before the test step, and
  // the longest healthy top-level test under coverage took 305 s.
  assert.ok(CAP_MS >= 1.9 * 305_000, "the cap is about twice the longest healthy instrumented test");
  assert.ok(9 * MIN + 30 * MIN + CAP_MS <= CEILING_MS, "a hang in the first 30 minutes of the test step fails inside the ceiling");
});

test("W1-T12415 criterion 2: a planted test that never settles, run under the coverage flags with that bound, fails by its name and the run still writes its lcov file", (t) => {
  const dir = ownedFixtureDir(t, "hung-coverage-planted").dir;
  // Node leaves test files out of coverage, so the covered code is a module the planted test calls.
  writeFileSync(join(dir, "touched.mjs"), "export const touched = () => 1;\n");
  writeFileSync(join(dir, "never-settles.test.mjs"), [
    'import { test } from "node:test";',
    `import { touched } from ${JSON.stringify(pathToFileURL(join(dir, "touched.mjs")).href)};`,
    'test("a planted test that never settles", () => new Promise(() => { touched(); setInterval(() => {}, 60_000); }));',
    "",
  ].join("\n"));
  // A short threshold makes the same policy price a short bound: 24 x 50 ms.
  writeFileSync(join(dir, "durations.json"), JSON.stringify({ thresholdMs: 50, files: {} }));
  const lcov = join(dir, "lcov.info");
  const started = Date.now();
  // The shard's own wrapper, exactly as ci.yml calls it, over the planted file.
  const run = spawnSync(process.execPath, [
    join(REPO_ROOT, "scripts/test-with-retry.mjs"), "--coverage-first-pass", join(dir, "raw"),
    process.execPath, "--enable-source-maps", "--experimental-test-coverage",
    "--test-reporter=tap", "--test-reporter-destination=stdout",
    "--test-reporter=lcov", `--test-reporter-destination=${lcov}`,
    "--test", "never-settles.test.mjs",
  ], { cwd: dir, encoding: "utf8", timeout: 240_000, killSignal: "SIGKILL", env: childEnv({ [MANIFEST_ENV]: join(dir, "durations.json"), GITHUB_STEP_SUMMARY: "" }) });
  assert.equal(run.signal, null, `the bounded run ended by itself (after ${Date.now() - started} ms)`);
  assert.notEqual(run.status, 0, "a hung test fails the run");
  assert.match(run.stdout, /^not ok \d+ - a planted test that never settles$/m, `the hung test fails by its name\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /test timed out after 1200ms/);
  assert.ok(existsSync(lcov) && statSync(lcov).size > 0, `the run still wrote its lcov file\n${run.stdout}\n${run.stderr}`);
  assert.match(readFileSync(lcov, "utf8"), /^SF:.*touched\.mjs$/m, "the lcov file carries the coverage of the code the hung test ran");
});

type Planted = { code: number | null; output: string; hung: boolean };

/** Runs the planted corpus test; `hung` means its result was reported and the process still had not exited. */
function runPlanted(file: string, env: NodeJS.ProcessEnv): Promise<Planted> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", file],
      { cwd: REPO_ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", hung = false, settled = false;
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    // A cold start of the corpus's import graph under a loaded host can take a while; a reported result can not.
    const deadline = setTimeout(kill, 240_000);
    let grace: NodeJS.Timeout | undefined;
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      if (grace === undefined && /^not ok 1 - /m.test(output)) grace = setTimeout(() => { hung = !settled; kill(); }, 15_000);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("close", (code) => {
      settled = true;
      clearTimeout(deadline);
      clearTimeout(grace);
      done({ code, output, hung });
    });
  });
}

test("W1-T12415 criterion 3: a failed corpus root removal no longer skips the server closes, so the file's child exits", async (t) => {
  // The cause, fixed: every corpus test in the hanging file tears down through corpusFixture.
  const source = readFileSync(join(REPO_ROOT, "test/operator-agent-gets-read-the-read-model.test.ts"), "utf8");
  const corpusCalls = source.match(/await corpus\(([^)]*)\)/g) ?? [];
  assert.ok(corpusCalls.length >= 7, "positive control: found the file's corpus tests");
  assert.deepEqual([...new Set(corpusCalls)], ["await corpus(fixture)"], "every corpus() receives the ordered teardown");
  assert.equal(source.match(/const fixture = corpusFixture\(t\);/g)?.length, corpusCalls.length);
  assert.doesNotMatch(source, /listen\(t,/, "no server close is registered behind the root removal");

  const dir = ownedFixtureDir(t, "hung-coverage-corpus").dir;
  const planted = join(dir, "a-corpus-whose-removal-fails.test.ts");
  const helper = pathToFileURL(join(REPO_ROOT, "test/helpers/operator-agent-corpus.ts")).href;
  const routes = pathToFileURL(join(REPO_ROOT, "src/lib/operator-agent.ts")).href;
  writeFileSync(planted, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { corpus, corpusFixture, listen } from ${JSON.stringify(helper)};
import { buildOperatorAgentRoutes } from ${JSON.stringify(routes)};

test("a corpus whose root removal fails", async (t) => {
  const hooks = process.env.PLANT_ORDERED === "1" ? corpusFixture(t) : t;
  const { ledgerPath } = await corpus(hooks);
  await listen(hooks, buildOperatorAgentRoutes({ ledgerPath, now: () => 0 }));
  // The removal fails as it did on #14880.
  const real = fs.rmSync;
  fs.rmSync = ((path: fs.PathLike, options?: fs.RmOptions) => {
    if (String(path).includes("e17-operator-agent")) throw Object.assign(new Error("ENOTEMPTY, Directory not empty: " + String(path)), { code: "ENOTEMPTY" });
    return real(path, options);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
});
`);
  const env = (ordered: boolean) => childEnv({ TMPDIR: dir, NODE_V8_COVERAGE: "", PLANT_ORDERED: ordered ? "1" : "0" });
  const [unordered, ordered] = await Promise.all([runPlanted(planted, env(false)), runPlanted(planted, env(true))]);

  // Without the fix (the plain test context): the result is reported, then the process never exits.
  assert.match(unordered.output, /^not ok 1 - a corpus whose root removal fails$/m, unordered.output);
  assert.match(unordered.output, /ENOTEMPTY/);
  assert.equal(unordered.hung, true, "the old teardown leaves the listening servers open and the child alive");

  // With the fix: the same failure is named and the process exits by itself.
  assert.equal(ordered.hung, false, ordered.output);
  assert.notEqual(ordered.code, null, ordered.output);
  assert.notEqual(ordered.code, 0, "the failed removal still fails the test");
  assert.match(ordered.output, /^not ok 1 - a corpus whose root removal fails$/m, ordered.output);
  assert.match(ordered.output, /ENOTEMPTY/);
});
