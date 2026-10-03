/**
 * test/diff-coverage-local-honours-the-lcov-path-it-is-given.test.ts — W1-T5485 acceptance.
 *
 * Reproduced 2026-10-03 at origin/main 491cd7d0: `diff-coverage-local --lcov <absolute path>`
 * printed "no lcov produced" for an lcov that existed, because `statLcov` `join`ed the absolute
 * path under the repo root; and `--lcov` never reached the instrumented run, which always wrote
 * ci.yml's coverage/lcov.info, so a non-default path named a file the run never wrote (absent, or
 * a stale one from an earlier run -- the vacuous pass the script exists to prevent).
 *
 * The main() cases here run the REAL lcov check, the REAL gate CLI and the REAL stale-file removal
 * inside the real runInstrumentedTests seam. Only two things are replaced: the instrumented suite
 * (a nested `node --test` under this suite's own test context would misbehave), by a tiny `node -e`
 * spawned through the real seam that writes the lcov to whatever destination the run was told;
 * and the merge-base diff, by a fixture diff the fixture lcov covers (or does not).
 *
 * New exports are read off the module namespace so this file loads at a base without them.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error The exercised script is a plain .mjs without a declaration file.
import * as local from "../scripts/diff-coverage-local.mjs";

const REPO_ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(REPO_ROOT, "test", "fixtures", "diff-coverage");
const COVERED_LCOV = readFileSync(join(FIXTURES, "covered.lcov"), "utf8");
const UNCOVERED_LCOV = readFileSync(join(FIXTURES, "uncovered.lcov"), "utf8");
const ADDED_LINE_DIFF = readFileSync(join(FIXTURES, "added-line.diff"), "utf8");
const LCOV_DESTINATION = "--test-reporter-destination=";

/** The destination that follows `--test-reporter=lcov` in a node argv, or undefined. */
function lcovDestinationIn(nodeArgs: string[]): string | undefined {
  const at = nodeArgs.indexOf("--test-reporter=lcov");
  const dest = nodeArgs.slice(at + 1).find((a) => a.startsWith(LCOV_DESTINATION));
  return at === -1 ? undefined : dest?.slice(LCOV_DESTINATION.length);
}

/** A fresh directory OUTSIDE the repo, removed after `fn`. */
function withOutsideDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "w1-t5485-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Drive the real `main` with `--lcov <lcovArg>`. The instrumented suite is replaced by a `node -e`
 * run THROUGH the real runInstrumentedTests seam (so its stale-file removal really runs): it exits
 * 9 if a file is already at the destination it was told to write, else writes `lcovText` there.
 */
function runMain(lcovArg: string, lcovText: string) {
  const logs: string[] = [];
  const errors: string[] = [];
  const instrumentedArgs: string[][] = [];
  const gateLcovPaths: string[] = [];
  const status = local.main(["--lcov", lcovArg, "test/example.test.ts"], {
    runInstrumentedTests: (nodeArgs: string[], lcovPath: string) => {
      instrumentedArgs.push(nodeArgs);
      const dest = lcovDestinationIn(nodeArgs) ?? "";
      const script =
        `const fs = require("node:fs"); const dest = require("node:path").resolve(${JSON.stringify(dest)});` +
        `if (fs.existsSync(dest)) process.exit(9); fs.writeFileSync(dest, ${JSON.stringify(lcovText)});`;
      return local.runInstrumentedTests(["-e", script], lcovPath);
    },
    computeMergeBaseDiff: () => ADDED_LINE_DIFF,
    runDiffCoverageGate: (lcovPath: string, diffPath: string) => {
      gateLcovPaths.push(lcovPath);
      return local.runDiffCoverageGate(lcovPath, diffPath);
    },
    log: (m: string) => logs.push(m),
    error: (m: string) => errors.push(m),
  });
  return { status, logs, errors, instrumentedArgs, gateLcovPaths };
}

test("W1-T5485: an absolute --lcov outside the repo is the path the run writes, the lcov check stats and the gate reads", () => {
  withOutsideDir((dir) => {
    const lcovPath = join(dir, "nested", "precheck-lcov.info");
    const run = runMain(lcovPath, COVERED_LCOV);
    assert.deepEqual(run.errors, [], "an lcov that exists must not be reported missing");
    assert.equal(run.status, 0);
    assert.equal(lcovDestinationIn(run.instrumentedArgs[0] ?? []), lcovPath, "the run must be told to write --lcov");
    assert.deepEqual(run.gateLcovPaths, [lcovPath], "the gate must read --lcov, absolute, as given");
    assert.equal(readFileSync(lcovPath, "utf8"), COVERED_LCOV);
  });
});

test("W1-T5485: the gate's verdict comes from the --lcov file -- an uncovered lcov there blocks", () => {
  withOutsideDir((dir) => {
    const run = runMain(join(dir, "lcov.info"), UNCOVERED_LCOV);
    assert.equal(run.status, 1, "the same diff over an lcov that never hit the added line must block");
    assert.ok(run.errors.some((e) => e.includes("see the gate output above")));
  });
});

test("W1-T5485: a stale lcov at the --lcov path is removed before the run, so it cannot pass", () => {
  withOutsideDir((dir) => {
    const lcovPath = join(dir, "lcov.info");
    writeFileSync(lcovPath, "TN:\nSF:stale.ts\nDA:1,1\nend_of_record\n");
    const run = runMain(lcovPath, COVERED_LCOV);
    assert.equal(run.status, 0, `the run saw a stale file at its destination: ${run.errors.join("\n")}`);
    assert.equal(readFileSync(lcovPath, "utf8"), COVERED_LCOV, "the file read is the one THIS run wrote");
  });
});

test("W1-T5485: a run that writes nothing fails 'no lcov produced' at the --lcov path, even with a stale one there", () => {
  withOutsideDir((dir) => {
    const lcovPath = join(dir, "lcov.info");
    writeFileSync(lcovPath, "stale\n");
    const errors: string[] = [];
    const status = local.main(["--lcov", lcovPath, "test/example.test.ts"], {
      runInstrumentedTests: (_args: string[], path: string) => local.runInstrumentedTests(["-e", "0"], path),
      computeMergeBaseDiff: () => {
        throw new Error("must not reach the diff step");
      },
      log: () => undefined,
      error: (m: string) => errors.push(m),
    });
    assert.equal(status, 1);
    assert.ok(existsSync(dir) && !existsSync(lcovPath), "the stale file must be gone");
    assert.ok(errors.some((e) => e.includes("no lcov produced") && e.includes(lcovPath) && e.includes("ENOENT")));
  });
});

test("W1-T5485: a relative --lcov resolves against the repo root, for the run and for the check", () => {
  assert.equal(local.resolveLcovPath("coverage/x.info"), join(REPO_ROOT, "coverage", "x.info"));
  assert.equal(local.resolveLcovPath("/elsewhere/x.info"), "/elsewhere/x.info");
  const flags = local.extractCoverageFlags(local.readCiYaml());
  const rewritten = local.withLcovDestination(flags, local.resolveLcovPath("coverage/precheck-lcov.info"));
  assert.equal(lcovDestinationIn(rewritten), join(REPO_ROOT, "coverage", "precheck-lcov.info"));
});

test("W1-T5485: the default --lcov leaves ci.yml's flags byte-for-byte unchanged", () => {
  const flags = local.extractCoverageFlags(local.readCiYaml());
  assert.equal(lcovDestinationIn(flags), "coverage/lcov.info", "ci.yml's own lcov destination");
  assert.deepEqual(local.withLcovDestination(flags, local.resolveLcovPath("coverage/lcov.info")), flags);
  const logs: string[] = [];
  const status = local.main(["--dry-run", "test/example.test.ts"], { log: (m: string) => logs.push(m) });
  assert.equal(status, 0);
  assert.ok(logs.some((l) => l.includes(" --test-reporter-destination=coverage/lcov.info ")), logs.join("\n"));
  assert.ok(logs.some((l) => l.endsWith(`read the lcov at: ${join(REPO_ROOT, "coverage", "lcov.info")}`)));
});

test("W1-T5485: --dry-run prints the rewritten lcov destination, and every other flag is untouched", () => {
  const flags: string[] = local.extractCoverageFlags(local.readCiYaml());
  const rewritten: string[] = local.withLcovDestination(flags, "/elsewhere/lcov.info");
  assert.equal(rewritten.length, flags.length);
  const changed = rewritten.flatMap((f, i) => (f === flags[i] ? [] : [f]));
  assert.deepEqual(changed, ["--test-reporter-destination=/elsewhere/lcov.info"]);
  const logs: string[] = [];
  assert.equal(local.main(["--dry-run", "--lcov", "/elsewhere/lcov.info", "t.test.ts"], { log: (m: string) => logs.push(m) }), 0);
  assert.ok(logs.some((l) => l.includes("--test-reporter-destination=/elsewhere/lcov.info")), logs.join("\n"));
});

test("W1-T5485: a ci.yml coverage step with no lcov reporter destination fails loudly, never runs", () => {
  assert.throws(() => local.withLcovDestination(["--test-reporter=spec"], "/x/lcov.info"), /no "--test-reporter=lcov"/);
  assert.throws(
    () => local.withLcovDestination(["--test-reporter-destination=a", "--test-reporter=lcov"], "/x/lcov.info"),
    /followed by a "--test-reporter-destination=<path>"/,
  );
  const yaml =
    "jobs:\n  coverage-ratchet:\n    steps:\n      - name: Test with coverage\n" +
    '        run: node --enable-source-maps --test-reporter=spec "${COVERAGE_TEST_FILES[@]}"\n';
  const errors: string[] = [];
  let ran = false;
  const status = local.main(["t.test.ts"], {
    readCiYaml: () => yaml,
    runInstrumentedTests: () => {
      ran = true;
      return { status: 0 };
    },
    error: (m: string) => errors.push(m),
  });
  assert.equal(status, 1);
  assert.equal(ran, false);
  assert.ok(errors.some((e) => e.includes("cannot point the run at --lcov")));
});
