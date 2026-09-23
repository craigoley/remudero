/**
 * test/local-diff-coverage-matches-ci.test.ts — W1-T4084 acceptance.
 *
 * scripts/diff-coverage-local.mjs exists so a local diff-coverage run cannot silently diverge from
 * ci.yml's "coverage-ratchet" job -- the divergence was MEASURED twice in one session on
 * 2026-09-22: a hand-rolled coverage run missing `--enable-source-maps` reported `diff-coverage: OK`
 * for a PR CI then BLOCKED (uncovered `src/lib/mounts.ts:510`), and later reported real, executed
 * `run-task.ts` lines as uncovered -- both because without source maps `DA:` positions land on
 * tsx-transpiled JS lines while `SF:` still names the `.ts` file. A third hand-rolled defect (a
 * two-dot `A..B` diff against a moved `origin/main`) added a false BLOCKED by including commits the
 * local branch never touched.
 *
 * These two tests are this task's own acceptance criteria, each pinned to a *mechanism* rather
 * than a spot-check of today's ci.yml text or today's git state, so a future edit to either the
 * workflow's flags or the diff semantics is caught rather than silently trusted:
 *  - flags: extractCoverageFlags reads ci.yml at call time, so mutating the workflow's own text
 *    changes what it returns -- proving this is READ, not a hand-copied literal, which is exactly
 *    what would let the two invocations drift apart again.
 *  - diff base: mergeBaseDiff is exercised against a real git fixture where origin/main moves
 *    AFTER the local branch diverged, and the diff is asserted to contain only the branch's own
 *    change -- the same shape as the measured false-BLOCKED defect, reproduced and proven fixed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error The exercised gate is a plain .mjs script without a declaration file.
import { computeMergeBaseDiff, ensureRawCoverageDir, extractCoverageFlags, main, makeTempDiffDir, mergeBaseDiff, readCiYaml, removeTempDiffDir, runDiffCoverageGate, runInstrumentedTests, statLcov, writeDiffFile } from "../scripts/diff-coverage-local.mjs";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL_CI_YAML_TEXT = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");

/** A recording logger pair, plus the two lists it fills, for asserting on `main`'s own output. */
function recorder() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) };
}

/** Every seam `main` needs, defaulted to a happy path that never touches disk/network/a real
 *  instrumented run -- exactly the injection main() -> {@link defaultMainDeps} in scripts/
 *  diff-coverage-local.mjs documents. A test overrides only the seam its branch cares about. */
function fakeDeps(overrides: Record<string, unknown> = {}) {
  const rec = recorder();
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return fn(...args);
  };
  const deps = {
    readCiYaml: record("readCiYaml", () => REAL_CI_YAML_TEXT),
    ensureRawCoverageDir: record("ensureRawCoverageDir", () => undefined),
    runInstrumentedTests: record("runInstrumentedTests", () => ({ status: 0 })),
    statLcov: record("statLcov", () => ({ size: 42 })),
    computeMergeBaseDiff: record("computeMergeBaseDiff", () => "diff --git a/x.ts b/x.ts\n+added\n"),
    runDiffCoverageGate: record("runDiffCoverageGate", () => ({ status: 0 })),
    makeTempDiffDir: record("makeTempDiffDir", () => "/tmp/w1-t4084-fake"),
    writeDiffFile: record("writeDiffFile", () => undefined),
    removeTempDiffDir: record("removeTempDiffDir", () => undefined),
    log: rec.log,
    error: rec.error,
    ...overrides,
  };
  return { deps, calls, ...rec };
}

test("W1-T4084: the local command reads its flags from the CI workflow", () => {
  const ciYamlText = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");

  // Today's real ci.yml, parsed for real: the exact node coverage flags the "Test with coverage"
  // step passes, minus its own test-file placeholder (this script's caller supplies test files).
  const flags = extractCoverageFlags(ciYamlText);
  assert.deepEqual(flags, [
    "--enable-source-maps",
    "--experimental-test-coverage",
    "--test-coverage-exclude=test/**",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    "--test-reporter-destination=stderr",
    "--test-reporter=lcov",
    "--test-reporter-destination=coverage/lcov.info",
    "--test",
    "--import",
    "tsx",
    "--import",
    "./test/setup/tmp-hygiene.ts",
  ]);

  // READ, NOT COPIED: mutating the workflow's OWN text changes what extractCoverageFlags returns,
  // proving this parses ci.yml at call time rather than returning a value hand-copied into this
  // script -- the exact hazard that let the local and CI invocations drift apart in the first
  // place.
  const mutated = ciYamlText.replace(
    '--test-coverage-exclude="test/**"',
    '--test-coverage-exclude="test/**" --test-name-pattern="w1-t4084-mutated"',
  );
  assert.notEqual(mutated, ciYamlText, "the replacement must actually match today's ci.yml text");
  const mutatedFlags = extractCoverageFlags(mutated);
  assert.ok(
    mutatedFlags.includes("--test-name-pattern=w1-t4084-mutated"),
    `expected the mutated flag to be picked up; got ${JSON.stringify(mutatedFlags)}`,
  );
});

test("W1-T4084: the diff is taken from the merge base", () => {
  // A bare "origin" plus a "work" clone that pushes to it, reproducing the exact shape of a real
  // GitHub remote and a real local checkout -- not a single working tree diffed against itself.
  const origin = gitRepo({ bare: true, branch: "main", kind: "w1-t4084-origin" });
  const work = gitRepo({ branch: "main", kind: "w1-t4084-work" });
  work.addRemote("origin", origin.dir);
  work.git("push", "origin", "main");

  const local = gitRepo({ cloneFrom: origin.dir, kind: "w1-t4084-local" });
  local.git("checkout", "-b", "feature");

  writeFileSync(join(local.dir, "feature.txt"), "feature change\n");
  local.git("add", "feature.txt");
  local.git("commit", "-m", "feature change");

  // origin/main MOVES after the branch point -- the exact hazard the rationale measured: a
  // two-dot diff (`A..B`) against a moved base pulls in commits the feature branch never touched.
  writeFileSync(join(work.dir, "moved-base.txt"), "unrelated origin change\n");
  work.git("add", "moved-base.txt");
  work.git("commit", "-m", "unrelated origin change");
  work.git("push", "origin", "main");

  local.git("fetch", "origin");

  const diffText = mergeBaseDiff({ cwd: local.dir, base: "origin/main", head: "feature" });
  assert.match(diffText, /feature\.txt/, `expected the branch's own change in the diff; got:\n${diffText}`);
  assert.doesNotMatch(
    diffText,
    /moved-base\.txt/,
    `origin/main's own later, unrelated commit must not appear in a merge-base diff; got:\n${diffText}`,
  );
});

// ── main()'s own orchestration, each branch driven through the injected seams above rather than
// a real instrumented run or a real git spawn -- fast, and exercises the exact lines a real
// invocation would (the coverage this repo's own diff-coverage.mjs gate checks against THIS file).

test("W1-T4084 main: --help prints usage and exits 0 without touching any seam", () => {
  const { deps, calls, logs } = fakeDeps();
  const status = main(["--help"], deps);
  assert.equal(status, 0);
  assert.ok(logs.some((l) => l.includes("Usage: npm run diff-coverage:local")));
  assert.equal(calls.readCiYaml, undefined, "must not read ci.yml just to print help");
});

test("W1-T4084 main: no test files given -> exits 1 and prints usage", () => {
  const { deps, errors } = fakeDeps();
  const status = main([], deps);
  assert.equal(status, 1);
  assert.ok(errors.some((e) => e.includes("no test files given")));
});

test("W1-T4084 main: an unparsable ci.yml fails loudly instead of silently running with no flags", () => {
  const { deps, errors } = fakeDeps({ readCiYaml: () => "jobs: {}\n" });
  const status = main(["test/example.test.ts"], deps);
  assert.equal(status, 1);
  assert.ok(errors.some((e) => e.includes("coverage-ratchet")));
});

test("W1-T4084 main: --dry-run prints the real flags and the merge-base diff line, runs nothing", () => {
  const { deps, calls, logs } = fakeDeps();
  const status = main(["--dry-run", "test/example.test.ts"], deps);
  assert.equal(status, 0);
  assert.ok(logs.some((l) => l.includes("--enable-source-maps") && l.includes("test/example.test.ts")));
  assert.ok(logs.some((l) => l.includes("origin/main...HEAD")));
  assert.equal(calls.runInstrumentedTests, undefined, "dry-run must not actually spawn the suite");
  assert.equal(calls.computeMergeBaseDiff, undefined, "dry-run must not actually compute the diff");
});

test("W1-T4084 main: no lcov produced -> exits 1, never reaches the diff step", () => {
  const { deps, calls, errors } = fakeDeps({
    statLcov: () => {
      throw new Error("ENOENT");
    },
  });
  const status = main(["test/example.test.ts"], deps);
  assert.equal(status, 1);
  assert.ok(errors.some((e) => e.includes("no lcov produced")));
  assert.equal(calls.computeMergeBaseDiff, undefined);
});

test("W1-T4084 main: an empty lcov -> exits 1, never reaches the diff step", () => {
  const { deps, calls, errors } = fakeDeps({ statLcov: () => ({ size: 0 }) });
  const status = main(["test/example.test.ts"], deps);
  assert.equal(status, 1);
  assert.ok(errors.some((e) => e.includes("empty")));
  assert.equal(calls.computeMergeBaseDiff, undefined);
});

test("W1-T4084 main: a failing instrumented suite still checks lcov, then reports the real exit code", () => {
  const { deps, calls, errors } = fakeDeps({ runInstrumentedTests: () => ({ status: 7 }) });
  const status = main(["test/example.test.ts"], deps);
  assert.equal(status, 7);
  assert.ok(errors.some((e) => e.includes("exited 7")));
  assert.equal(calls.computeMergeBaseDiff, undefined, "a real test failure must not go on to gate a diff");
});

test("W1-T4084 main: an empty merge-base diff -> OK, the gate is never spawned", () => {
  const { deps, calls, logs } = fakeDeps({ computeMergeBaseDiff: () => "" });
  const status = main(["test/example.test.ts"], deps);
  assert.equal(status, 0);
  assert.ok(logs.some((l) => l.includes("is empty, nothing to check")));
  assert.equal(calls.runDiffCoverageGate, undefined);
});

test("W1-T4084 main: computing the merge-base diff can itself fail loudly (e.g. an unfetched base)", () => {
  const { deps, errors } = fakeDeps({
    computeMergeBaseDiff: () => {
      throw new Error("git diff origin/main...HEAD failed: unknown revision");
    },
  });
  const status = main(["test/example.test.ts"], deps);
  assert.equal(status, 1);
  assert.ok(errors.some((e) => e.includes("unknown revision")));
});

test("W1-T4084 main: the happy path writes the diff, runs the real gate CLI, and cleans up its tmp dir", () => {
  const { deps, calls } = fakeDeps();
  const status = main(["test/example.test.ts"], deps);
  assert.equal(status, 0);
  assert.equal(calls.writeDiffFile?.length, 1);
  assert.equal(calls.runDiffCoverageGate?.length, 1);
  assert.equal(calls.removeTempDiffDir?.length, 1, "the tmp dir must be removed even on success");
});

test("W1-T4084 main: a BLOCKED gate propagates its exit code and names the remedy", () => {
  const { deps, calls, errors } = fakeDeps({ runDiffCoverageGate: () => ({ status: 1 }) });
  const status = main(["test/example.test.ts"], deps);
  assert.equal(status, 1);
  assert.ok(errors.some((e) => e.includes("add a test file")));
  assert.equal(calls.removeTempDiffDir?.length, 1, "the tmp dir must still be removed on a BLOCKED gate");
});

// ── extractCoverageFlags' fail-closed arms: ci.yml's shape changing must be a loud error, not a
// silently empty flag set (which would run the instrumented suite with none of the source-map/
// coverage flags this whole script exists to reproduce).

test("W1-T4084: a coverage-ratchet job missing its Test with coverage step fails loudly", () => {
  const yamlText = "jobs:\n  coverage-ratchet:\n    steps:\n      - name: some other step\n        run: echo hi\n";
  assert.throws(() => extractCoverageFlags(yamlText), /has no "Test with coverage" step/);
});

test("W1-T4084: a Test with coverage step whose run: no longer invokes node --enable-source-maps fails loudly", () => {
  const yamlText =
    "jobs:\n  coverage-ratchet:\n    steps:\n      - name: Test with coverage (renamed)\n        run: echo hi\n";
  assert.throws(() => extractCoverageFlags(yamlText), /could not find "node --enable-source-maps"/);
});

test("W1-T4084: a Test with coverage step missing the shard's test-file placeholder fails loudly", () => {
  const yamlText =
    "jobs:\n  coverage-ratchet:\n    steps:\n      - name: Test with coverage (renamed)\n        run: node --enable-source-maps --test\n";
  assert.throws(() => extractCoverageFlags(yamlText), /could not find .*COVERAGE_TEST_FILES/);
});

// ── the real implementation behind each injectable seam, exercised directly and cheaply --
// {@link defaultMainDeps} only NAMES these; this is what actually proves their bodies correct.

test("W1-T4084: readCiYaml reads the real ci.yml off disk", () => {
  const text = readCiYaml();
  assert.match(text, /coverage-ratchet:/);
});

test("W1-T4084: ensureRawCoverageDir creates coverage/raw", () => {
  ensureRawCoverageDir();
  assert.ok(existsSync(join(REPO_ROOT, "coverage", "raw")));
});

test("W1-T4084: runInstrumentedTests really spawns node with the given argv and reports its exit code", () => {
  const result = runInstrumentedTests(["-e", "process.exit(0)"]);
  assert.equal(result.status, 0);
});

test("W1-T4084: statLcov reads a real file's size, relative to the repo root", () => {
  ensureRawCoverageDir(); // guarantees coverage/ itself exists to hold this fixture
  const relative = "coverage/w1-t4084-stat-fixture.tmp";
  const absolute = join(REPO_ROOT, relative);
  writeDiffFile(absolute, "some lcov text\n");
  try {
    const stat = statLcov(relative);
    assert.ok(stat.size > 0);
  } finally {
    removeTempDiffDir(absolute);
  }
});

test("W1-T4084: computeMergeBaseDiff against the repo's own HEAD is empty (same ref both sides)", () => {
  assert.equal(computeMergeBaseDiff("HEAD", "HEAD"), "");
});

test("W1-T4084: runDiffCoverageGate really spawns scripts/diff-coverage.mjs and reports its exit code", () => {
  const fixtures = join(REPO_ROOT, "test", "fixtures", "diff-coverage");
  const result = runDiffCoverageGate(join(fixtures, "covered.lcov"), join(fixtures, "added-line.diff"));
  assert.equal(result.status, 0);
});

test("W1-T4084: makeTempDiffDir/writeDiffFile/removeTempDiffDir round-trip a real temp file", () => {
  const dir = makeTempDiffDir();
  assert.ok(existsSync(dir));
  const diffPath = join(dir, "pr.diff");
  writeDiffFile(diffPath, "diff --git a/x b/x\n+added\n");
  assert.equal(readFileSync(diffPath, "utf8"), "diff --git a/x b/x\n+added\n");
  removeTempDiffDir(dir);
  assert.ok(!existsSync(dir));
});

// ── the real CLI entrypoint (`if (isMainModule(...)) { process.exitCode = main(...); }`), which
// only runs when this script is invoked directly -- not merely imported, as every test above does.

test("W1-T4084 CLI: `node scripts/diff-coverage-local.mjs --help` runs via the real entrypoint and exits 0", () => {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "diff-coverage-local.mjs"), "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Usage: npm run diff-coverage:local/);
});
