/**
 * test/temp-hygiene-suite.test.ts — proof for W1-T131 (TEST-FIXTURE TEMP HYGIENE).
 *
 * The fix (test/setup/tmp-hygiene.ts, wired in via a second `--import` on the `test`
 * npm script) wraps `fs.mkdtempSync`, propagates the wrap to every fixture's named
 * `import { mkdtempSync } from "node:fs"` binding via `syncBuiltinESMExports()`, and
 * removes every dir it recorded from a `process.on("exit", ...)` handler.
 *
 * These tests prove that mechanism end-to-end by actually spawning `node --test`
 * child processes with the real `--import` flags (not by asserting against the
 * hygiene module's internals) — the same shape of proof `withTempDir`'s external-spy
 * tests in test/tmp.test.ts use for the analogous production-code fix (W1-T115):
 * observe the effect from outside, not the mechanism's own bookkeeping.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HYGIENE_IMPORT = join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts");

/** Count dirs directly under the OS tmp root whose name carries the given prefix —
 * an external, filesystem-level count, not anything the hygiene module reports about
 * itself. */
function countTmpDirs(prefix: string): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).length;
}

/** Run one `.test.ts` file exactly the way the real `test` npm script does (same two
 * `--import` flags, same runner), optionally narrowed to one test by name. Never
 * throws on a nonzero exit — the caller decides whether that's expected (claim 3
 * deliberately runs a failing fixture). */
function runNodeTestFile(fixturePath: string, testNamePattern?: string): { status: number } {
  const args = ["--test", "--import", "tsx", "--import", HYGIENE_IMPORT];
  if (testNamePattern) args.push("--test-name-pattern", testNamePattern);
  args.push(fixturePath);
  // This proof file is itself a test/**/*.test.ts run under `node --test`, so it
  // inherits `NODE_TEST_CONTEXT=child-v8` from its OWN parent test runner. Left in
  // the child's env, that variable makes the spawned `node --test` below think IT is
  // a coordinated subtest of an outer harness (reporting over an inherited IPC
  // channel) rather than a standalone run — its own thrown test then exits 0 instead
  // of nonzero, silently defeating this exact proof. Strip it so the child behaves
  // exactly like the real `npm test` invocation does at the top level.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    execFileSync(process.execPath, args, { cwd: REPO_ROOT, stdio: "pipe", env });
    return { status: 0 };
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    return { status: status ?? 1 };
  }
}

test("claim 1: a full test-suite run leaves ZERO net new rmd- prefixed dirs under the temp root, counted before and after", () => {
  const scratch = mkdtempSync(join(tmpdir(), "temp-hygiene-suite-"));
  try {
    const fixture = join(scratch, "fixture-claim1.test.ts");
    writeFileSync(
      fixture,
      [
        'import { mkdtempSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        'import { test } from "node:test";',
        "",
        'test("a fixture that creates rmd- dirs and never removes them — the leak shape this fix closes", () => {',
        '  mkdtempSync(join(tmpdir(), "rmd-suite-claim1-a-"));',
        '  mkdtempSync(join(tmpdir(), "rmd-suite-claim1-b-"));',
        "});",
        "",
      ].join("\n"),
    );

    // Scoped to this fixture's own "rmd-suite-claim1-" prefix, not the bare "rmd-"
    // root: this proof file is itself one file among many the real suite runs
    // concurrently (node --test's default process-per-file parallelism), and other
    // in-flight sibling files legitimately create/remove their own "rmd-"-rooted
    // dirs at the same instant — counting the bare root here would make this proof
    // flaky on suite noise it has no business asserting about. The dirs this
    // fixture creates ARE "rmd-" prefixed (see above), so this is the same claim,
    // just measured without cross-file interference.
    const before = countTmpDirs("rmd-suite-claim1-");
    const { status } = runNodeTestFile(fixture);
    assert.equal(status, 0, "the fixture itself passes — this is the ordinary leak shape, not a thrown test");
    const after = countTmpDirs("rmd-suite-claim1-");

    assert.equal(after, before, "no net new rmd- prefixed dirs survive a run under the hygiene import");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("claim 2: test/worker.test.ts:374's rmd-worker-guard- dir — the confirmed instance that anchored the census — no longer leaks", () => {
  const before = countTmpDirs("rmd-worker-guard-");
  const { status } = runNodeTestFile(
    join(REPO_ROOT, "test", "worker.test.ts"),
    "an invalid settings file is REJECTED at the spawn boundary",
  );
  assert.equal(status, 0, "the anchor test itself passes");
  const after = countTmpDirs("rmd-worker-guard-");

  assert.equal(after, before, "the rmd-worker-guard- dir mkdtempSync'd at worker.test.ts:374 is gone after the run");
});

test("claim 3: a test whose body THROWS still leaves no temp dir behind — the error path is the one that leaks at scale", () => {
  const scratch = mkdtempSync(join(tmpdir(), "temp-hygiene-suite-"));
  try {
    const fixture = join(scratch, "fixture-claim3.test.ts");
    writeFileSync(
      fixture,
      [
        'import { mkdtempSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        'import { test } from "node:test";',
        "",
        'test("creates a dir, then throws", () => {',
        '  mkdtempSync(join(tmpdir(), "rmd-suite-claim3-"));',
        '  throw new Error("boom — simulated failing test, the error path this claim pins");',
        "});",
        "",
      ].join("\n"),
    );

    const before = countTmpDirs("rmd-suite-claim3-");
    const { status } = runNodeTestFile(fixture);
    assert.notEqual(status, 0, "the fixture is EXPECTED to fail (it throws) — proves this is a real thrown-test proof, not a false pass");
    const after = countTmpDirs("rmd-suite-claim3-");

    assert.equal(after, before, "the dir created before the throw is still swept away when the process exits");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("claim 4: a mutation-style repeated run of the same fixture N times creates at most a bounded number of dirs — pinning the Stryker multiplier", () => {
  const scratch = mkdtempSync(join(tmpdir(), "temp-hygiene-suite-"));
  try {
    const fixture = join(scratch, "fixture-claim4.test.ts");
    writeFileSync(
      fixture,
      [
        'import { mkdtempSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        'import { test } from "node:test";',
        "",
        'test("creates exactly one rmd- dir per run", () => {',
        '  mkdtempSync(join(tmpdir(), "rmd-suite-claim4-"));',
        "});",
        "",
      ].join("\n"),
    );

    // Stryker re-invokes the WHOLE `npm test` command once per mutant (see
    // stryker.conf.json's commandRunner) — i.e. N separate `node --test` process
    // launches, exactly what this loop simulates. That is the actual mechanism that
    // turned a one-dir-per-fixture leak into 202,830 dirs / 14G: N reruns, each
    // leaking its own dir, with nothing ever reclaiming them between runs.
    const N = 5;
    const before = countTmpDirs("rmd-suite-claim4-");
    for (let i = 0; i < N; i++) {
      const { status } = runNodeTestFile(fixture);
      assert.equal(status, 0, `run ${i + 1}/${N} of the fixture itself passes`);
    }
    const after = countTmpDirs("rmd-suite-claim4-");

    // Bounded, not one-per-run: each of the N process launches sweeps its own dir at
    // exit, so the count left behind after all N runs must stay flat — not grow with N.
    assert.equal(after, before, `${N} repeated runs of the same fixture must leave the same rmd-suite-claim4- count behind, not accumulate one per run`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
