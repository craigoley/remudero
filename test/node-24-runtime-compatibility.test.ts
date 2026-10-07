import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { ndjsonLines } from "../src/lib/ledger-union.js";
import { parseWhitelistedProof } from "../src/lib/review.js";
// @ts-expect-error The production coverage merger is an executable .mjs module outside tsconfig.
import { newTestCoverage } from "../scripts/coverage-merge-ratchet.mjs";
// @ts-expect-error The flake-retry wrapper is an executable .mjs module outside tsconfig.
import { withTapReporter } from "../scripts/test-with-retry.mjs";

// W1-T5882: the behaviour Node 22.22.3 gave this repo for free and Node 24.21.0 does not. Each test
// below is written to hold on BOTH runtimes, so the fixes land while CI still runs 22 and the pin
// flip (W1-T5883) changes nothing they assert.

const REPO_ROOT = process.cwd();

function trackedSources(): string[] {
  return execFileSync("git", ["ls-files", "src", "scripts", "bin"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|mjs|cjs|js)$/.test(f));
}

test("W1-T5882: every captured nested node --test run names the TAP reporter", () => {
  // Node 22 defaulted a piped `node --test` to TAP; Node 24 defaults every stream to spec, so a
  // caller that parses `# tests`, `not ok` or `location:` reads nothing unless it asks for TAP. A
  // spawn whose output nobody parses says so at its own call site: `node-test-reporter: exempt`.
  const argvTest = /(?:^|[[,]\s*)(["'])--test\1\s*(?:,|\])/;
  const offenders: string[] = [];
  for (const file of trackedSources()) {
    const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!argvTest.test(line)) return;
      const around = lines.slice(Math.max(0, index - 1), index + 4).join("\n");
      if (!around.includes("--test-reporter") && !around.includes("node-test-reporter: exempt")) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.ok(trackedSources().length > 500, "the census must read the real tree, not an empty list");
  assert.deepEqual(offenders, [], "each of these spawns `node --test` and reads its output without naming a reporter");
});

test("W1-T5882: a proof run prints TAP whichever runtime executes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-node24-tap-"));
  writeFileSync(join(dir, "one.test.mjs"), 'import { test } from "node:test"; test("one", () => {});\n');
  const proof = parseWhitelistedProof("unit test: test/foo.test.ts");
  assert.ok(proof);
  // The proof executor's own reporter flags, applied to a fixture with no tsx dependency.
  const reporterFlags = proof.args.filter((arg) => arg.startsWith("--test-reporter"));
  assert.deepEqual(reporterFlags, ["--test-reporter=tap"]);
  // A child that inherits NODE_TEST_CONTEXT reports to this runner over IPC and prints nothing.
  const { NODE_TEST_CONTEXT: _inherited, ...env } = process.env;
  const result = spawnSync(process.execPath, ["--test", ...reporterFlags, "one.test.mjs"], { cwd: dir, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# tests 1$/m);
  assert.match(result.stdout, /^ok 1 - one$/m);
});

test("W1-T5882: test-with-retry names TAP for a node --test command that names no reporter", () => {
  assert.deepEqual(withTapReporter(process.execPath, ["--test", "--import", "tsx", "a.test.ts"]),
    ["--test", "--test-reporter=tap", "--import", "tsx", "a.test.ts"]);
  assert.deepEqual(withTapReporter(process.execPath, ["--test", "--test-reporter=spec", "a.test.ts"]),
    ["--test", "--test-reporter=spec", "a.test.ts"], "a command that names its own reporter is left as written");
  assert.deepEqual(withTapReporter("npm", ["run", "test"]), ["run", "test"], "only a node --test command is touched");
});

test("W1-T5882: no worker thread is handed process.execArgv", () => {
  // Under Node 24's test runner process.execArgv carries per-process flags (--stack-trace-limit,
  // --tls-cipher-list, ...) that a Worker refuses with ERR_WORKER_INVALID_EXEC_ARGV. A worker that
  // inherits its execArgv (the default) gets the same loader and none of the refusal.
  const tests = execFileSync("git", ["ls-files", "test"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter((f) => /\.(ts|mjs)$/.test(f));
  assert.ok(tests.length > 500, "the census must read the real test tree, not an empty list");
  // Only a Worker's options count: a probe that records `execArgv: process.execArgv` as data is not one.
  const offenders = [...trackedSources(), ...tests].filter((file) =>
    /new Worker\([^;]*?execArgv:\s*process\.execArgv/.test(readFileSync(join(REPO_ROOT, file), "utf8")));
  assert.deepEqual(offenders, []);
});

test("W1-T5882: the coverage merger builds Node's TestCoverage for either constructor shape", () => {
  const calls: unknown[][] = [];
  class Seven { constructor(...args: unknown[]) { calls.push(args); } }
  Object.defineProperty(Seven, "length", { value: 7 });
  class Three { constructor(...args: unknown[]) { calls.push(args); } }
  Object.defineProperty(Three, "length", { value: 3 });
  newTestCoverage(Seven, { cwd: "/r", excludeGlobs: ["test/**"], includeGlobs: undefined, sourceMaps: true });
  newTestCoverage(Three, { cwd: "/r", excludeGlobs: ["test/**"], includeGlobs: undefined, sourceMaps: true });
  assert.deepEqual(calls[0], ["", undefined, "/r", ["test/**"], undefined, true, { line: 0, branch: 0, function: 0 }]);
  assert.deepEqual(calls[1], ["", undefined, {
    cwd: "/r", coverageExcludeGlobs: ["test/**"], coverageIncludeGlobs: undefined, sourceMaps: true,
    lineCoverage: 0, branchCoverage: 0, functionCoverage: 0,
  }]);
  class Five {}
  Object.defineProperty(Five, "length", { value: 5 });
  assert.throws(() => newTestCoverage(Five, { cwd: "/r", excludeGlobs: [], includeGlobs: undefined, sourceMaps: false }), /5 arguments/);

  // And against the real internal class of whichever Node runs this suite: its summary must report
  // the working directory it was given, which the old call shape silently dropped on Node 24.
  const out = execFileSync(process.execPath, ["--expose-internals", "--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { newTestCoverage } from "./scripts/coverage-merge-ratchet.mjs";
    const { TestCoverage } = createRequire(import.meta.url)("internal/test_runner/coverage");
    const collector = newTestCoverage(TestCoverage, { cwd: "/w1-t5882", excludeGlobs: ["test/**"], includeGlobs: undefined, sourceMaps: false });
    collector.getCoverageFromDirectory = () => [];
    process.stdout.write(collector.summary().workingDirectory);
  `], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(out, "/w1-t5882");
});

test("W1-T5882: a ledger row carrying U+2028 reads as one row", async () => {
  const withSeparators = JSON.stringify({ step: "a", note: "line para end" });
  const multiByte = Buffer.from(`${JSON.stringify({ step: "é→" })}\n`, "utf8");
  // A chunk boundary inside a multi-byte character, a CRLF row and a final row with no newline.
  const chunks = [
    Buffer.from(`${withSeparators}\n`),
    multiByte.subarray(0, 12),
    multiByte.subarray(12),
    Buffer.from(`${JSON.stringify({ step: "crlf" })}\r\n${JSON.stringify({ step: "tail" })}`),
  ];
  const lines: string[] = [];
  for await (const line of ndjsonLines(Readable.from(chunks))) lines.push(line);
  assert.deepEqual(lines.map((line) => (JSON.parse(line) as { step: string }).step), ["a", "é→", "crlf", "tail"]);
  assert.equal((JSON.parse(lines[0]!) as { note: string }).note, "line para end");
});
