/**
 * Every test run is judged by its summary, not its exit status — the follow-up to #10894.
 *
 * #10894 judged the pure-test pool ladder only. An ISOLATED `node --test` run still reports a file
 * whose own child exits 0 part-way as `ok`, with the rest of that file's tests never run and
 * `# tests` still at least the file count, so the fast tier's isolated rest, the slow tier, the
 * coverage shards (scripts/test-with-retry.mjs), the author preflight and the flake screen all read
 * it green. Each now judges its run: every file it was given must reach its own per-file summary,
 * and a run that does not is a failure naming the file.
 *
 * These drive the REAL `node --test` runner over fixture files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTempDir } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Verdict = { status: number; complete: boolean; missing: string[]; lastStarted: string | null; exitSite: string | null };
const pool = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "pure-test-pool.mjs")).href)) as {
  judgedNodeTestArgs: (args: string[], judgedArgs: string[]) => string[];
  testFilesInArgv: (args: string[], cwd?: string) => string[];
  unreportedFilesIn: (output: string) => string[];
  judgeRun: (files: string[], opts: { status: number; pool: boolean; root?: string; tallyText?: string; markerText?: string }) => Verdict;
  spawnJudgedRun: (
    files: string[],
    opts: { spawn: typeof spawnSync; cwd: string; args: string[]; pool: boolean; role: string; log?: (line: string) => void; env?: NodeJS.ProcessEnv },
  ) => number;
};
const manifest = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "test-tier-manifest.mjs")).href)) as {
  main: (argv: string[], opts: { spawn: (cmd: string, args: string[], o: SpawnSyncOptions) => unknown; env?: NodeJS.ProcessEnv }) => number;
};
const retry = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "test-with-retry.mjs")).href)) as {
  failedFilesOf: (attempt: { output: string; unreported?: string[] }, cwd?: string) => string[];
};
const flakeScreen = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "flake-screen.mjs")).href)) as {
  runTestFile: (file: string, root?: string) => Promise<{ ok: boolean; output: string }>;
};
const author = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "preflight-author.mjs")).href)) as {
  main: (argv: string[], deps: { root: string; host?: () => unknown }) => number;
};

// A nested runner inherits NODE_TEST_CONTEXT (it would report to this file's runner) and the coverage
// session; drop the first and blank the second (a deleted key is re-injected into the child).
function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, NODE_V8_COVERAGE: "" };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

const PASSING = (name: string) => `import test from "node:test";\ntest(${JSON.stringify(name)}, () => {});\n`;
/** Its second test calls the real `process.exit(0)`: the file's child ends with its third test never run. */
const EXITS_PART_WAY =
  `import test from "node:test";\n` +
  `test("b runs first", () => {});\n` +
  `test("b ends its own process", () => { process.exit(0); });\n` +
  `test("b never runs this", () => {});\n`;

/** A fixture root the tier manifest can run: `b-exits` is impure (it names process.exit), so it never pools. */
function tierFixture(slow: string[] = []): string {
  const root = makeTempDir("judged-run");
  const files: Record<string, string> = {
    "package.json": `{ "type": "module" }\n`,
    "test/setup/tmp-hygiene.ts": "export {};\n",
    "test/a-first.test.ts": PASSING("a-first passes"),
    "test/b-exits.test.ts": EXITS_PART_WAY,
    "test/c-after.test.ts": PASSING("c-after passes"),
    "scripts/test-tier-manifest.json": JSON.stringify({ thresholdMs: 5000, files: Object.fromEntries(slow.map((f) => [f, 60_000])) }),
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** The real runner, minus tsx (the fixtures are plain JavaScript that node strips as .ts), piped. */
const realSpawn = (cmd: string, args: string[], opts: SpawnSyncOptions) => {
  const kept = args.filter((arg, i) => !(arg === "--import" && args[i + 1] === "tsx") && !(arg === "tsx" && args[i - 1] === "--import"));
  return spawnSync(cmd, kept, { ...opts, stdio: "pipe", encoding: "utf8", maxBuffer: 1 << 26, env: childEnv(opts.env as NodeJS.ProcessEnv) });
};

function runManifest(t: { mock: { method: (...a: never[]) => { mock: { calls: { arguments: unknown[] }[] } } } }, root: string, tier: string) {
  const logged = t.mock.method(console as never, "error" as never, (() => {}) as never);
  const code = manifest.main(["--root", root, "--run", tier], { spawn: realSpawn, env: {} });
  return { code, log: logged.mock.calls.map((c) => c.arguments.join(" ")).join("\n") };
}

test("an isolated fast-tier file whose process exits 0 part-way fails the shard, naming the file", (t) => {
  const root = tierFixture();
  // Control: this is the shape that read green — the bare isolated runner exits 0 and reports b `ok`.
  const bare = realSpawn(process.execPath, ["--test", "--test-reporter=tap", "test/b-exits.test.ts"], { cwd: root, env: process.env });
  assert.equal(bare.status, 0, "the unjudged isolated run exits 0");
  assert.match(String(bare.stdout), /^ok 1 - test\/b-exits\.test\.ts$/m, "and reports the cut-short file as ok");

  const { code, log } = runManifest(t as never, root, "fast");
  assert.notEqual(code, 0, log);
  assert.match(log, /pure-test-pool: pool run complete — 2\/2 file\(s\) reported/, "the pure files still pool, and pass");
  assert.match(log, /test-tier-manifest: REST RUN INCOMPLETE — its exit 0 is counted as FAILED/);
  assert.match(log, /never reported \(first: test\/b-exits\.test\.ts\)/);
  assert.match(log, /Last test started: test\/b-exits\.test\.ts > b ends its own process/);
  assert.match(log, /process\.exit\(0\) from .*b-exits\.test\.ts/);
  assert.match(log, /^test-judge: UNREPORTED FILE test\/b-exits\.test\.ts$/m);
});

test("a slow-tier file whose process exits 0 part-way fails the slow tier, naming the file", (t) => {
  const root = tierFixture(["test/b-exits.test.ts", "test/c-after.test.ts"]);
  const { code, log } = runManifest(t as never, root, "slow");
  assert.notEqual(code, 0, log);
  assert.match(log, /REST RUN INCOMPLETE/);
  assert.match(log, /1\/2 file\(s\) reported/);
  assert.match(log, /never reported \(first: test\/b-exits\.test\.ts\)/);

  // Positive control: the same slow tier without the cut-short file is green, and says how much it heard.
  writeFileSync(join(root, "test/b-exits.test.ts"), PASSING("b now finishes"));
  const healthy = runManifest(t as never, root, "slow");
  assert.equal(healthy.code, 0, healthy.log);
  assert.match(healthy.log, /test-tier-manifest: rest run complete — 2\/2 file\(s\) reported, # tests 2, # fail 0\./);
});

test("a coverage shard whose file process exits 0 part-way is reported failed, and only that file is retried", () => {
  const root = tierFixture();
  const raw = join(root, "coverage-raw");
  mkdirSync(raw, { recursive: true });
  // The wrapper's own retry knobs come from the environment; a caller's must not reach this fixture.
  const env: NodeJS.ProcessEnv = { ...childEnv(), RMD_TEST_FLAKE_LEDGER: join(root, "flake-ledger.ndjson"), GITHUB_STEP_SUMMARY: "" };
  delete env.TEST_RETRY;
  delete env.TEST_RETRY_BUDGET_SECONDS;
  const wrapper = (args: string[]) =>
    spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "test-with-retry.mjs"), ...args], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26, env });

  // The coverage lane's shape: an instrumented first pass, then an uninstrumented failed-file retry.
  const coverage = wrapper([
    "--coverage-first-pass", raw,
    process.execPath, "--experimental-test-coverage", "--test-coverage-exclude=test/**",
    "--test-reporter=tap", "--test-reporter-destination=stdout",
    "--test-reporter=lcov", `--test-reporter-destination=${join(root, "lcov.info")}`,
    "--test", "test/a-first.test.ts", "test/b-exits.test.ts", "test/c-after.test.ts",
  ]);
  const coverageOut = `${coverage.stdout}${coverage.stderr}`;
  assert.notEqual(coverage.status, 0, coverageOut);
  assert.match(coverageOut, /test-judge: NODE --TEST RUN INCOMPLETE — its exit 0 is counted as FAILED/);
  assert.match(coverageOut, /2\/3 file\(s\) reported/);
  assert.match(coverageOut, /FLAKE-RETRY-FILES: retrying 1 failed file\(s\) uninstrumented — test\/b-exits\.test\.ts$/m);
  assert.match(coverageOut, /FLAKE-RETRY: retry ALSO failed/);

  // `npm run test:ci`'s shape: a glob, expanded to the files the run must hear from.
  const glob = wrapper([process.execPath, "--test", "--test-reporter=tap", "test/**/*.test.ts"]);
  const globOut = `${glob.stdout}${glob.stderr}`;
  assert.notEqual(glob.status, 0, globOut);
  assert.match(globOut, /never reported \(first: test\/b-exits\.test\.ts\)/);
  assert.match(globOut, /FLAKE-RETRY-FILES: retrying 1 failed file\(s\) — test\/b-exits\.test\.ts$/m);
});

test("the author preflight's affected tests fail when a suite's process exits 0 part-way", (t) => {
  const repo = gitRepo({ kind: "judged-author", seedCommit: false });
  const root = repo.dir;
  for (const path of ["test/setup", "src", "scripts"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/diff-class.mjs"), "// This fixture has no census path readers.\n");
  writeFileSync(join(root, "scripts/census-precheck.mjs"), "console.log('fixture census precheck passed');\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"), "console.log('fixture static preflight passed');\n");
  writeFileSync(join(root, "test/leaf.test.ts"), PASSING("leaf passes"));
  repo.git("add", ".");
  repo.git("commit", "-m", "test: baseline");
  repo.git("remote", "add", "origin", root);
  repo.git("checkout", "-b", "run-unfiled-judged-author");
  writeFileSync(join(root, "test/leaf.test.ts"), EXITS_PART_WAY);
  repo.git("add", ".");
  repo.git("commit", "-m", "test: the leaf ends its own process");

  t.mock.method(console as never, "log" as never, (() => {}) as never);
  t.mock.method(console as never, "error" as never, (() => {}) as never);
  const status = author.main([], { root, host: () => ({ cores: 64, load1: 0, headroomBytes: 64 * 2 ** 30 }) });
  const receipt = JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8"));
  const step = receipt.steps.find((s: { name: string }) => s.name === "affected-tests");
  assert.ok(step, JSON.stringify(receipt.steps));
  assert.equal(step.exitCode, 0, "the runner itself exited 0");
  assert.equal(step.testSummary?.fail, 0, "and printed a summary with no failure");
  assert.equal(step.ok, false, "but the suite never reached its own summary");
  assert.deepEqual(step.judge.unreported, ["test/leaf.test.ts"]);
  assert.match(step.judge.lastStarted, /test\/leaf\.test\.ts > b ends its own process/);
  assert.equal(receipt.verdict, "failed");
  assert.notEqual(status, 0);
});

test("a flake-screen run whose file exits 0 part-way is a failed run", async () => {
  const root = tierFixture();
  const exiting = await flakeScreen.runTestFile(join(root, "test/b-exits.test.ts"), REPO_ROOT);
  assert.equal(exiting.ok, false, exiting.output);
  assert.match(exiting.output, /flake-screen: SCREEN RUN INCOMPLETE/);
  const passing = await flakeScreen.runTestFile(join(root, "test/a-first.test.ts"), REPO_ROOT);
  assert.equal(passing.ok, true, passing.output);
  assert.match(passing.output, /flake-screen: screen run complete — 1\/1 file\(s\) reported/);
});

test("unit test: a judged child that starts node again with its own preloads does not leak the judge into it", () => {
  const root = tierFixture();
  // The child re-runs node with this process's --import preloads (the judge's marker among them) and
  // the inherited env: it must print only its own output, not a test summary of its own.
  writeFileSync(
    join(root, "test/d-respawns.test.ts"),
    `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { spawnSync } from "node:child_process";\n` +
      `const imports = process.execArgv.flatMap((arg, i, all) => arg.startsWith("--import=") ? ["--import", arg.slice(9)] : arg === "--import" ? ["--import", all[i + 1]] : []);\n` +
      `test("a respawned node prints only its own output", () => {\n` +
      `  const r = spawnSync(process.execPath, [...imports, "-e", "console.log('only-this')"], { encoding: "utf8" });\n` +
      `  assert.equal(r.stdout, "only-this\\n");\n});\n`,
  );
  const log: string[] = [];
  const status = pool.spawnJudgedRun(["test/d-respawns.test.ts", "test/a-first.test.ts"], {
    spawn: realSpawn as never, cwd: root, args: ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout"],
    pool: false, role: "rest", log: (l) => log.push(l), env: childEnv(),
  });
  assert.equal(status, 0, log.join("\n"));
  assert.match(log.join("\n"), /rest run complete — 2\/2 file\(s\) reported/);
});

test("the judge's preload stays out of worker threads: a thread that throws still exits 1, pooled or isolated", () => {
  const root = tierFixture();
  // A node:test hook registered inside a worker rewrites that thread's exit code to 0 (a local
  // #10894 shard-2 run with an unguarded marker failed the read model's integrity-thread test this way).
  writeFileSync(
    join(root, "test/e-thread.test.ts"),
    `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { Worker } from "node:worker_threads";\n` +
      `test("a worker that throws exits 1", async () => {\n` +
      `  const worker = new Worker(new URL("data:text/javascript,throw new Error('boom')"));\n` +
      `  let message = "";\n  worker.on("error", (error) => { message = error.message; });\n` +
      `  const code = await new Promise((done) => worker.on("exit", done));\n` +
      `  assert.equal(\`\${code}:\${message}\`, "1:boom");\n});\n`,
  );
  for (const pooled of [true, false]) {
    const log: string[] = [];
    const status = pool.spawnJudgedRun(["test/e-thread.test.ts", "test/a-first.test.ts"], {
      spawn: realSpawn as never, cwd: root,
      args: ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", ...(pooled ? ["--experimental-test-isolation=none"] : [])],
      pool: pooled, role: pooled ? "pool" : "rest", log: (l) => log.push(l), env: childEnv(),
    });
    assert.equal(status, 0, log.join("\n"));
    assert.match(log.join("\n"), /run complete — 2\/2 file\(s\) reported, # tests 2, # fail 0/);
  }
});

test("a run whose test timed out under --test-force-exit fails, pooled or isolated, though node exits 0 with # fail 0", () => {
  const root = tierFixture();
  // CI 38972373415: seven pooled tests hit their timeout; node counts that `cancelled`, not `fail`,
  // and --test-force-exit exited 0, so the pool read green and its leak ladder never ran.
  writeFileSync(join(root, "test/f-hangs.test.ts"), `import test from "node:test";\ntest("f never settles", () => new Promise(() => {}));\n`);
  for (const pooled of [true, false]) {
    const log: string[] = [];
    const status = pool.spawnJudgedRun(["test/a-first.test.ts", "test/f-hangs.test.ts"], {
      spawn: realSpawn as never, cwd: root,
      args: ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", "--test-timeout=300", "--test-force-exit",
        ...(pooled ? ["--experimental-test-isolation=none"] : [])],
      pool: pooled, role: pooled ? "pool" : "rest", log: (l) => log.push(l), env: childEnv(),
    });
    assert.notEqual(status, 0, `pooled=${pooled}: ${log.join("\n")}`);
    assert.match(log.join("\n"), /# cancelled 1: a test that timed out/, `pooled=${pooled}`);
  }
});

test("unit test: an isolated run names the unreported file's own last test and exit", () => {
  const root = "/fixture-root";
  const files = ["test/a.test.ts", "test/b.test.ts"];
  const tally = JSON.stringify({ version: 1, summary: { tests: 4, failed: 0 }, testFiles: ["/fixture-root/test/a.test.ts", "/fixture-root/test/b.test.ts"], fileSummaries: ["/fixture-root/test/b.test.ts"] });
  // Children write in parallel: b's lines land after a's exit, so "the last line" would name b.
  const markerText = [
    "start\t/fixture-root/test/a.test.ts\ta one",
    "start\t/fixture-root/test/a.test.ts\ta two",
    "exit\t0\tlib/recycle.mjs:2:20\t/fixture-root/test/a.test.ts",
    "start\t/fixture-root/test/b.test.ts\tb one",
    "exit\t0\tnode:internal/somewhere\t/fixture-root/test/b.test.ts",
  ].join("\n");
  const verdict = pool.judgeRun(files, { status: 0, pool: false, root, tallyText: tally, markerText });
  assert.equal(verdict.status, 1);
  assert.deepEqual(verdict.missing, ["test/a.test.ts"]);
  assert.equal(verdict.lastStarted, "test/a.test.ts > a two");
  assert.equal(verdict.exitSite, "process.exit(0) from lib/recycle.mjs:2:20");
});

test("unit test: the judge joins any node --test argv with its reporters still paired, and finds its files", () => {
  const J = ["--import", "MARKER", "--test-reporter=TALLY", "--test-reporter-destination=OUT"];
  // A lone reporter keeps stdout; the judge goes after it so destinations stay in order.
  assert.deepEqual(pool.judgedNodeTestArgs(["--test", "--test-reporter=tap", "--import", "tsx", "a.test.ts"], J), [
    "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", ...J, "--import", "tsx", "a.test.ts",
  ]);
  // No reporter keeps node's default spec on stdout rather than only the judge's.
  assert.deepEqual(pool.judgedNodeTestArgs(["--test", "a.test.ts"], J), [
    "--test", "--test-reporter=spec", "--test-reporter-destination=stdout", ...J, "a.test.ts",
  ]);
  // Paired reporters before --test, one spelled with a space: the judge follows the last of them.
  const coverage = ["--test-reporter", "tap", "--test-reporter-destination", "stderr", "--test-reporter=lcov", "--test-reporter-destination=l.info", "--test", "x.test.ts"];
  assert.deepEqual(pool.judgedNodeTestArgs(coverage, J), [...coverage.slice(0, 7), ...J, "x.test.ts"]);
  assert.deepEqual(pool.judgedNodeTestArgs(["scripts/x.mjs"], J), ["scripts/x.mjs"], "not a test run: unchanged");

  const root = tierFixture();
  assert.deepEqual(pool.testFilesInArgv(["--test", "--import", "./test/setup/tmp-hygiene.ts", "test/**/*.test.ts"], root), [
    "test/a-first.test.ts", "test/b-exits.test.ts", "test/c-after.test.ts",
  ]);
  assert.deepEqual(pool.testFilesInArgv(["--test-reporter-destination=coverage/test-durations.json", "test/x.test.ts"], root), ["test/x.test.ts"]);

  const output = "ok 1 - a\ntest-judge: UNREPORTED FILE test/b-exits.test.ts\ntest-judge: UNREPORTED FILE test/no-such.test.ts\n";
  assert.deepEqual(pool.unreportedFilesIn(output), ["test/b-exits.test.ts", "test/no-such.test.ts"]);
  // Read from a wrapped runner's output, only files that exist are retried: a test of the judge prints
  // judge lines about fixture files that are not this checkout's.
  assert.deepEqual(retry.failedFilesOf({ output }, root), ["test/b-exits.test.ts"]);
  // An attempt the wrapper judged itself trusts its own verdict, never the lines its tests printed.
  assert.deepEqual(retry.failedFilesOf({ output, unreported: [join(root, "test/c-after.test.ts")] }, root), ["test/c-after.test.ts"]);
  assert.deepEqual(retry.failedFilesOf({ output: "", unreported: ["/elsewhere/c.test.ts"] }, root), [], "a file outside the checkout is never retried");
});
