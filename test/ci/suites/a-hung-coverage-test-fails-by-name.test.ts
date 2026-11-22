// @source-text-subject: the coverage shard's test command and the corpus test's teardown are this suite's subject.
// W1-T12415. coverage-shard (4/8) on #14880 (job 122319121555) reported all eight results of
// test/operator-agent-gets-read-the-read-model.test.ts, then that file's child never exited and the
// unbounded shard waited 41 minutes for its 49-minute cancel. The cause: corpus() registers its root
// removal as the first `after` hook; node:test stops at the first hook that throws, so its ENOTEMPTY
// skipped every server close registered after it, and the listening servers kept the child alive.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-expect-error — plain .mjs, no declaration file.
import * as tier from "#scripts/test-tier-manifest.mjs";
// @ts-expect-error — plain .mjs, no declaration file.
import * as wrapper from "#scripts/test-with-retry.mjs";

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

test("W1-T12415: the hang manifest variable reaches no test process, so a fixture copy of the wrapper never looks for it", () => {
  const coverageEnv = (wrapper.coverageChildEnvironment as (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv)({ [MANIFEST_ENV]: "scripts/test-tier-coverage-manifest.json", KEEP: "1" });
  assert.equal(MANIFEST_ENV in coverageEnv, false);
  assert.equal(coverageEnv.KEEP, "1", "positive control: the rest of the environment is kept");
  const retry = (wrapper.coverageRetryInvocation as (cmd: string, args: string[], files: string[], env: NodeJS.ProcessEnv) => { env: NodeJS.ProcessEnv } | null)(
    "node", ["--test", "test/a.test.ts"], ["test/a.test.ts"], { [MANIFEST_ENV]: "scripts/test-tier-coverage-manifest.json", KEEP: "1" });
  assert.ok(retry);
  assert.equal(MANIFEST_ENV in retry.env, false);
  assert.equal(retry.env.KEEP, "1");
});

test("W1-T12415: a deleted fixture module's source map outside the tree is dropped from raw coverage; an in-tree missing source is not", (t) => {
  const dir = ownedFixtureDir(t, "missing-fixture-source").dir;
  const raw = join(dir, "raw");
  mkdirSync(raw);
  const fixture = pathToFileURL(join(dir, "gone", "publisher.mjs")).href;
  const kept = pathToFileURL(join(REPO_ROOT, "src", "lib", "read-model-worker.ts")).href;
  const inTree = pathToFileURL(join(REPO_ROOT, "src", "no-such-source.ts")).href;
  const report = { result: [], "source-map-cache": { [fixture]: { data: { sources: [fixture] } }, [kept]: { data: { sources: [kept] } } } };
  const name = "coverage-1-1794859933719-1.json";
  writeFileSync(join(raw, name), JSON.stringify(report));
  writeFileSync(join(raw, "coverage-2-1794859933719-2.json"), JSON.stringify({ result: [], "source-map-cache": { [kept]: { data: { sources: [kept] } } } }));
  const warning = (source: string, script: string) =>
    `# Warning: Could not report code coverage. Error [ERR_SOURCE_MAP_MISSING_SOURCE]: Cannot find '${source}' imported from the source map for '${script}'`;
  const missing = wrapper.missingFixtureSourceMaps as (output: string, cwd?: string) => string[];
  assert.deepEqual(missing(warning(fixture, fixture), REPO_ROOT), [fixture]);
  assert.deepEqual(missing(warning(inTree, fixture), REPO_ROOT), [], "a missing source inside the tree is never dropped");
  assert.deepEqual(missing(warning("https://example.com/gone.ts", fixture), REPO_ROOT), [], "a source that is no file URL is never dropped");
  const changed = (wrapper.dropFixtureSourceMaps as (rawDir: string, scripts: string[]) => string[])(raw, [fixture]);
  assert.deepEqual(changed, [join(raw, name)], "only the report that holds the fixture's source map changes");
  const after = JSON.parse(readFileSync(join(raw, name), "utf8")) as { "source-map-cache": Record<string, unknown> };
  assert.deepEqual(Object.keys(after["source-map-cache"]), [kept], "the in-tree source map is kept");
  assert.deepEqual(readdirSync(`${raw}-missing-source`), [name], "the original report is kept beside the raw directory as evidence");
});

/**
 * The coverage shard's own wrapper over a real `node --test` run whose one test loads `count` modules from a
 * tree OUTSIDE the working directory, each through an inline source map naming a `.ts` that never exists, and
 * then deletes that tree. Node cannot map those reports, so it writes no lcov and exits 1 although the test
 * passed: the failure the wrapper repairs. An enclosing coverage run's directory passes through to the
 * wrapper itself, so the lines it runs here are measured.
 */
function runDeletedFixtureShard(t: Parameters<typeof ownedFixtureDir>[0], count: number, truncatedReport = false) {
  const dir = realpathSync(ownedFixtureDir(t, "deleted-fixture-shard").dir);
  const work = join(dir, "work");
  const gone = join(dir, "gone");
  mkdirSync(join(work, "raw"), { recursive: true });
  writeFileSync(join(work, "source.mjs"), "export function covered() { return 1; }\nexport function uncovered() { return 2; }\n");
  writeFileSync(join(work, "fixture.test.mjs"), [
    'import { mkdirSync, rmSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { test } from "node:test";',
    'import { pathToFileURL } from "node:url";',
    `const gone = ${JSON.stringify(gone)};`,
    'test("an all-pass suite that loads mapped modules from a tree it then deletes", async () => {',
    "  mkdirSync(gone, { recursive: true });",
    // Built from the module's own URL, so this file's text carries no location-relative specifier (W1-T9864).
    '  const { covered } = await import(new URL("source.mjs", import.meta.url).href);',
    "  covered();",
    `  for (let i = 0; i < ${count}; i += 1) {`,
    "    const file = join(gone, `fixture-${i}.mjs`);",
    '    const map = { version: 3, sources: [pathToFileURL(join(gone, `fixture-${i}.ts`)).href], names: [], mappings: "AAAA" };',
    '    writeFileSync(file, `export const f = () => ${i};\\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\\n`);',
    "    (await import(pathToFileURL(file).href)).f();",
    "  }",
    "  rmSync(gone, { recursive: true, force: true });",
    // A truncated raw report that names fixture-0's script: the repair cannot parse it to drop that source map.
    ...(truncatedReport ? [`  writeFileSync(${JSON.stringify(join(work, "raw", "coverage-1-1794859933719-1.json"))}, ${
      JSON.stringify(`{"source-map-cache":{${JSON.stringify(pathToFileURL(join(gone, "fixture-0.mjs")).href)}:`)});`] : []),
    "});",
    "",
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary"), NODE_V8_COVERAGE: "" };
  if (process.env.NODE_V8_COVERAGE) env.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  delete env.TEST_RETRY;
  delete env.TEST_RETRY_BUDGET_SECONDS;
  delete env[MANIFEST_ENV];
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/test-with-retry.mjs"), "--coverage-first-pass", "raw", process.execPath,
    "--enable-source-maps", "--experimental-test-coverage",
    "--test-reporter=tap", "--test-reporter-destination=stderr",
    "--test-reporter=lcov", "--test-reporter-destination=lcov.info", "--test", "fixture.test.mjs"],
  { cwd: work, env, encoding: "utf8", timeout: 240_000, killSignal: "SIGKILL" });
  assert.ifError(result.error);
  return { work, dir, code: result.status, output: result.stdout + result.stderr };
}

test("W1-T12415: a shard whose only failure is a deleted fixture module's source map rebuilds its lcov and passes", (t) => {
  const run = runDeletedFixtureShard(t, 1);
  assert.match(run.output, /Could not report code coverage[^\n]*Cannot find '[^']*fixture-0\.ts'/, `the first pass could not report\n${run.output}`);
  const line = /^FLAKE-RETRY-RECOVERED: dropped the source maps of deleted fixture module\(s\) outside the tree and rebuilt lcov — (.*)$/m.exec(run.output);
  assert.ok(line, `the repair is announced\n${run.output}`);
  assert.match(line[1]!, /fixture-0\.mjs$/, "and names the module it dropped");
  assert.equal(run.code, 0, run.output);
  assert.match(readFileSync(join(run.dir, "summary"), "utf8"), /FLAKE-RETRY-RECOVERED: dropped the source maps of deleted fixture module\(s\)/, "the step summary carries it too");
  const lcov = readFileSync(join(run.work, "lcov.info"), "utf8");
  assert.match(lcov, /^SF:source\.mjs$/m, "the rebuilt lcov reports the in-tree module");
  assert.match(lcov, /^FNDA:1,covered$/m);
  assert.doesNotMatch(lcov, /fixture-\d/, "and none of the deleted fixtures");
  assert.equal(existsSync(join(run.work, "raw-missing-source")), true, "the original report is kept as evidence");
});

test("W1-T12415: a shard with more deleted fixture source maps than the repair has rounds keeps its failing verdict", (t) => {
  const run = runDeletedFixtureShard(t, 45);
  assert.match(run.output, /Could not report code coverage[^\n]*Cannot find '[^']*fixture-\d+\.ts'/, `the first pass could not report\n${run.output}`);
  assert.match(run.output, /test-with-retry: coverage rebuild failed: [^\n]*Cannot find '[^']*fixture-\d+\.ts'/, "a rebuild that still names a missing source is read for the next one");
  assert.doesNotMatch(run.output, /FLAKE-RETRY-RECOVERED/, "a repair that never rebuilt the lcov is not announced");
  assert.notEqual(run.code, 0, "the run stays failed");
  assert.match(run.output, /FLAKE-RETRY-FILES: no failed test file could be named/, "and its verdict stands, unrepeated");
});

test("W1-T12415: a deleted fixture's source map that the repair cannot drop from a truncated raw report keeps the shard failed", (t) => {
  const run = runDeletedFixtureShard(t, 1, true);
  assert.match(run.output, /Could not report code coverage[^\n]*Cannot find '[^']*fixture-0\.ts'/, `the first pass could not report\n${run.output}`);
  assert.match(run.output, /test-with-retry: could not drop deleted fixtures' source maps: /, `the failed drop is named\n${run.output}`);
  assert.doesNotMatch(run.output, /FLAKE-RETRY-RECOVERED: dropped the source maps of deleted fixture module/, "a repair that dropped nothing is not announced");
  assert.notEqual(run.code, 0, "the run stays failed");
});

test("the coverage shard's runner and each file child run without concurrent Sparkplug or recompilation, so its force-exit cannot deadlock on Node 24.22.3", (t) => {
  const workaround = tier.NODE_EXIT_DEADLOCK_WORKAROUND_ARGS as readonly string[];
  assert.deepEqual([...workaround], ["--no-concurrent-sparkplug", "--no-concurrent-recompilation"]);
  const coverageManifest = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/test-tier-coverage-manifest.json"), "utf8")) as Manifest;
  const file = "test/operator-agent-gets-read-the-read-model.test.ts";
  for (const flag of workaround) {
    assert.ok(boundArgs([file], coverageManifest).includes(flag), `the coverage bound carries ${flag}`);
    assert.ok(withBound(["--test", file], "scripts/test-tier-coverage-manifest.json", REPO_ROOT).includes(flag), `and the shard command gets ${flag}`);
    assert.ok(!(tier.slowTierHangBoundArgs as () => string[])().includes(flag), "the slow tier, which never reached this exit, is unchanged");
  }
  // NODE_OPTIONS refuses these V8 flags, which is why the bound puts them on the runner's command line.
  const viaEnv = spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8", env: childEnv({ NODE_OPTIONS: workaround[0]! }) });
  assert.equal(viaEnv.status, 9, `NODE_OPTIONS rejects ${workaround[0]}\n${viaEnv.stderr}`);
  assert.match(viaEnv.stderr, /is not allowed in NODE_OPTIONS/);

  // The shard's own wrapper, exactly as ci.yml calls it: a file child inherits only the runner's own flags.
  const dir = ownedFixtureDir(t, "coverage-exit-deadlock-flags").dir;
  const seen = join(dir, "exec-argv.json");
  writeFileSync(join(dir, "touched.mjs"), "export const touched = () => 1;\n");
  writeFileSync(join(dir, "records-its-flags.test.mjs"), [
    'import { writeFileSync } from "node:fs";',
    'import { test } from "node:test";',
    `import { touched } from ${JSON.stringify(pathToFileURL(join(dir, "touched.mjs")).href)};`,
    `test("a file child records its flags", () => { touched(); writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.execArgv)); });`,
    "",
  ].join("\n"));
  writeFileSync(join(dir, "durations.json"), JSON.stringify({ thresholdMs: 5000, files: {} }));
  const lcov = join(dir, "lcov.info");
  const run = spawnSync(process.execPath, [
    join(REPO_ROOT, "scripts/test-with-retry.mjs"), "--coverage-first-pass", join(dir, "raw"),
    process.execPath, "--enable-source-maps", "--experimental-test-coverage",
    "--test-reporter=tap", "--test-reporter-destination=stdout",
    "--test-reporter=lcov", `--test-reporter-destination=${lcov}`,
    "--test", "records-its-flags.test.mjs",
  ], { cwd: dir, encoding: "utf8", timeout: 240_000, killSignal: "SIGKILL", env: childEnv({ [MANIFEST_ENV]: join(dir, "durations.json"), GITHUB_STEP_SUMMARY: "" }) });
  assert.equal(run.signal, null, `the run ended by itself\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.status, 0, `the bounded run passes\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /^ok \d+ - a file child records its flags$/m);
  const childArgv = JSON.parse(readFileSync(seen, "utf8")) as string[];
  for (const flag of workaround) assert.ok(childArgv.includes(flag), `the file child ran with ${flag}: ${childArgv.join(" ")}`);
  assert.ok(existsSync(lcov) && statSync(lcov).size > 0, "the run still wrote its lcov file");
  assert.match(readFileSync(lcov, "utf8"), /^SF:.*touched\.mjs$/m, "and the coverage of the code the test ran");
});
