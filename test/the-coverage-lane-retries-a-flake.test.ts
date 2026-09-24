/**
 * W1-T4398 — the coverage lane retries a flake, and the retry never touches the coverage figures.
 *
 * Since W1-T3207 the instrumented coverage run is a SOURCE pull request's only test verdict, and it
 * called `node --test` directly: one flaky test failed coverage-shard and cost a whole new ~100-minute
 * run. It now runs through scripts/test-with-retry.mjs in `--coverage-first-pass` mode: pass one is
 * the instrumented run and the only writer of lcov and raw V8 coverage; a failed FILE is re-run once
 * uninstrumented, and a pass on retry is reported as a flake. The first half of each test runs the
 * REAL wrapper against a real flaky test file; the second drives the REAL ci.yml step with a stub
 * `node` that records what it was asked to run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER = join(REPO_ROOT, "scripts", "test-with-retry.mjs");
const { coverageRetryInvocation } = (await import(pathToFileURL(WRAPPER).href)) as {
  coverageRetryInvocation: (
    cmd: string,
    args: string[],
    failedFiles: string[],
    env?: NodeJS.ProcessEnv,
  ) => { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null;
};

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, string> };
type CiDoc = { jobs: Record<string, { needs?: string[]; steps?: Step[] }> };
const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as CiDoc;
const coverageSteps = doc.jobs["coverage-ratchet"]!.steps!;
const COVERAGE_STEP = coverageSteps.find((s) => s.name?.startsWith("Test with coverage"))!.run!;

/** A test file that fails its first run and passes every later one, calling a different source
 *  function each time — so the coverage record shows which run it came from. */
function flakyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4398-`));
  writeFileSync(join(dir, "src.mjs"), "export function firstPassOnly() {\n  return 1;\n}\nexport function onlyOnRetry() {\n  return 2;\n}\n");
  writeFileSync(
    join(dir, "flaky.test.mjs"),
    `import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { firstPassOnly, onlyOnRetry } from "./src.mjs";
test("flaky on its first run", () => {
  const marker = new URL("./attempted", import.meta.url);
  if (!existsSync(marker)) {
    writeFileSync(marker, "");
    firstPassOnly();
    assert.fail("first attempt");
  }
  onlyOnRetry();
});
`,
  );
  mkdirSync(join(dir, "raw"));
  return dir;
}

/** Runs the real wrapper the way ci.yml's coverage step does, minus tsx and the repo harness. */
function runCoverageLane(dir: string, testFile: string, outerRaw?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  // Stands in for an enclosing coverage run's NODE_V8_COVERAGE, which the wrapper inherits when
  // this very suite runs in the coverage lane.
  if (outerRaw) env.NODE_V8_COVERAGE = outerRaw;
  delete env.GITHUB_STEP_SUMMARY;
  delete env.NODE_TEST_CONTEXT; // set inside node --test; it would turn the nested run into a v8-protocol child
  delete env.TEST_RETRY;
  delete env.TEST_RETRY_BUDGET_SECONDS;
  const r = spawnSync(
    process.execPath,
    [
      WRAPPER,
      "--coverage-first-pass",
      "raw",
      process.execPath,
      "--enable-source-maps",
      "--experimental-test-coverage",
      "--test-reporter=tap",
      "--test-reporter-destination=stderr",
      "--test-reporter=lcov",
      "--test-reporter-destination=lcov.info",
      "--test",
      testFile,
    ],
    { cwd: dir, encoding: "utf8", env },
  );
  return { status: r.status, out: r.stdout + r.stderr };
}

// GitHub's runner has Bash 5's `mapfile`; macOS's system Bash does not, so supply the narrow
// equivalent only where it is missing (the same shim test/workflow-single-suite-run.test.ts uses).
const MAPFILE_COMPAT = `if ! type mapfile >/dev/null 2>&1; then
mapfile() {
  local _flag="$1" _name="$2" _line
  eval "\${_name}=()"
  while IFS= read -r _line; do
    eval "\${_name}+=(\"\${_line}\")"
  done
}
fi
`;

/** Runs the real coverage step with a stub `node`: it selects one file, records every call, answers
 *  the retry wrapper's call with the given output, and leaves the lcov and raw files a real run would. */
function runCoverageStep(wrapperOutput: string) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4398-step-`));
  mkdirSync(join(dir, "bin"));
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "wrapper-output.txt"), wrapperOutput);
  writeFileSync(
    join(dir, "bin", "node"),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$*" in
  *--select-all*) echo "test/x.test.ts" ;;
  *test-with-retry.mjs*) mkdir -p coverage/raw; echo "SF:src/x.ts" > coverage/lcov.info; echo "{}" > coverage/raw/coverage-1.json; cat "${join(dir, "wrapper-output.txt")}" ;;
esac
`,
  );
  chmodSync(join(dir, "bin", "node"), 0o755);
  const body = COVERAGE_STEP.replaceAll("${{ steps.classify.outputs.class }}", "SOURCE").replaceAll("${{ matrix.shard }}", "2");
  writeFileSync(join(dir, "run.sh"), MAPFILE_COMPAT + body);
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "run.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GITHUB_EVENT_NAME: "pull_request", GITHUB_STEP_SUMMARY: join(dir, "summary.md"), RUNNER_TEMP: dir },
  });
  const evidence = join(dir, "flake-retry", "coverage-shard-2.log");
  return { status: r.status, out: r.stdout + r.stderr, calls: readFileSync(log, "utf8"), evidence: existsSync(evidence) ? readFileSync(evidence, "utf8") : undefined };
}

test("W1-T4398: a coverage-lane flake is retried once and reported", () => {
  const dir = flakyFixture();
  const run = runCoverageLane(dir, "flaky.test.mjs");
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /^FLAKE-RETRY: first attempt failed — flaky on its first run$/m);
  assert.match(run.out, /^FLAKE-RETRY-FILES: retrying 1 failed file\(s\) uninstrumented — flaky\.test\.mjs$/m);
  assert.match(run.out, /^FLAKE-RETRY-RECOVERED: a flake, not a pass .* — flaky on its first run$/m);
  // A deterministic failure fails both passes and says so: the retry cannot mask a real break.
  writeFileSync(join(dir, "broken.test.mjs"), 'import { test } from "node:test";\ntest("always broken", () => { throw new Error("no"); });\n');
  const broken = runCoverageLane(dir, "broken.test.mjs");
  assert.notEqual(broken.status, 0);
  assert.match(broken.out, /^FLAKE-RETRY: retry ALSO failed — always broken$/m);
  assert.doesNotMatch(broken.out, /FLAKE-RETRY-RECOVERED/);
  // A failure no file can be named for is not retried: repeating the whole instrumented run is
  // exactly what the 2026-08-28 ruling removed, so pass one's own code stands.
  const unnamed = runCoverageLane(dir, "no-such.test.mjs");
  assert.notEqual(unnamed.status, 0);
  assert.match(unnamed.out, /^FLAKE-RETRY-FILES: no failed test file could be named — the instrumented run is not repeated/m);
  assert.doesNotMatch(unnamed.out, /uninstrumented —|retry ALSO failed/);

  // The real ci.yml step routes the instrumented run through the wrapper and stages its evidence.
  const step = runCoverageStep("# tests 1\nFLAKE-RETRY: first attempt failed — t\nFLAKE-RETRY-RECOVERED: a flake, not a pass — t\n");
  assert.equal(step.status, 0, step.out);
  assert.match(step.calls, /^scripts\/test-with-retry\.mjs --coverage-first-pass coverage\/raw node --enable-source-maps --experimental-test-coverage /m);
  assert.doesNotMatch(step.calls, /^--enable-source-maps --experimental-test-coverage/m, "the instrumented run must not be called directly");
  assert.equal(step.evidence, "FLAKE-RETRY: first attempt failed — t\nFLAKE-RETRY-RECOVERED: a flake, not a pass — t\n");
  const upload = coverageSteps.find((s) => s.with?.name === "flake-retry-shard-coverage-${{ matrix.shard }}");
  assert.equal(upload?.with?.path, "${{ runner.temp }}/flake-retry", "the evidence the step staged must be uploaded");
  assert.ok(doc.jobs["flake-retry-aggregate"]!.needs!.includes("coverage-ratchet"), "the aggregator must wait for the coverage lane");
  // The control: a shard whose first pass was green records nothing.
  assert.equal(runCoverageStep("# tests 1\n# fail 0\n").evidence, "");
});

test("W1-T4398: a retry never changes the coverage figures", () => {
  const dir = flakyFixture();
  const run = runCoverageLane(dir, "flaky.test.mjs", join(dir, "outer"));
  assert.equal(run.status, 0, run.out);
  // The lcov is pass one's: the function only the retry calls was never hit, the other one was.
  const lcov = readFileSync(join(dir, "lcov.info"), "utf8");
  assert.match(lcov, /^FNDA:1,firstPassOnly$/m);
  assert.match(lcov, /^FNDA:0,onlyOnRetry$/m);
  // The raw V8 reports are pass one's too: no report ANYWHERE — pass one's directory or an enclosing
  // run's — records a call to onlyOnRetry, and pass one's directory holds no report of the wrapper.
  const scripts = (sub: string) =>
    readdirSync(join(dir, sub)).flatMap(
      (f) => (JSON.parse(readFileSync(join(dir, sub, f), "utf8")) as { result: Array<{ url: string; functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }> }).result,
    );
  const functions = scripts("raw");
  assert.ok(functions.length > 0, "pass one must write raw coverage");
  const retryHits = [...functions, ...scripts("outer")].filter((s) => s.url.endsWith("/src.mjs")).flatMap((s) => s.functions).filter((f) => f.functionName === "onlyOnRetry" && f.ranges[0]!.count > 0);
  assert.deepEqual(retryHits, []);
  assert.ok(functions.some((s) => s.url.endsWith("/src.mjs")), "the source module must appear in pass one's raw coverage");
  assert.ok(!functions.some((s) => s.url.endsWith("/test-with-retry.mjs")), "the wrapper must not write its own raw report");

  // The retry command itself: narrowed to the failed file, every coverage and reporter flag gone.
  const args = ["--enable-source-maps", "--experimental-test-coverage", "--test-coverage-exclude=test/**", "--test-reporter", "lcov", "--test-reporter-destination=coverage/lcov.info", "--test", "--import", "tsx", "test/a.test.ts", "test/b.test.ts"];
  const retry = coverageRetryInvocation("node", args, ["test/b.test.ts"], { NODE_V8_COVERAGE: "coverage/raw", KEEP: "1" });
  assert.deepEqual(retry?.args, ["--enable-source-maps", "--test", "--import", "tsx", "test/b.test.ts"]);
  assert.deepEqual(retry?.env, { KEEP: "1", NODE_V8_COVERAGE: "" });
  // Nothing to name, or not a Node test run: no retry, and pass one's verdict stands.
  assert.equal(coverageRetryInvocation("node", args, []), null);
  assert.equal(coverageRetryInvocation("npm", ["test"], ["test/b.test.ts"]), null);
  assert.equal(coverageRetryInvocation("node", ["scripts/x.mjs"], ["test/b.test.ts"]), null);
});
