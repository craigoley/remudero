import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
// @ts-expect-error The exercised script is a plain .mjs without a declaration file.
import * as local from "../scripts/diff-coverage-local.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function assertTransientRawPath(path: string) {
  assert.ok(isAbsolute(path), "raw coverage must use an absolute path");
  const fromRepo = relative(REPO_ROOT, path);
  assert.ok(fromRepo === ".." || fromRepo.startsWith(`..${sep}`) || isAbsolute(fromRepo));
  assert.equal(dirname(path), tmpdir(), "raw coverage must live directly under os.tmpdir()");
}

function runMain(testStatus: number | null, argv: string[] = [], throws = false, observeRaw = (_path: string) => {}) {
  let rawPath = "";
  const logs: string[] = [];
  const errors: string[] = [];
  const gateCalls: string[] = [];
  const status = local.main([...argv, "test/example.test.ts"], {
    runInstrumentedTests: (_args: string[], lcovPath: string, options: Record<string, unknown>) =>
      local.runInstrumentedTests(["-e", "0"], undefined, {
        ...options,
        spawn: (_command: string, _args: string[], spawnOptions: { env: NodeJS.ProcessEnv; cwd: string }) => {
          rawPath = spawnOptions.env.NODE_V8_COVERAGE as string;
          observeRaw(rawPath);
          assertTransientRawPath(rawPath);
          assert.equal(spawnOptions.cwd, REPO_ROOT);
          assert.ok(existsSync(rawPath), "the directory must exist while the child runs");
          writeFileSync(join(rawPath, "coverage.json"), "raw fixture");
          assert.equal(lcovPath, join(REPO_ROOT, "coverage/lcov.info"));
          if (throws) throw new Error("spawn fixture failed");
          return { status: testStatus };
        },
      }),
    statLcov: () => {
      if (!argv.includes("--keep-raw")) assert.ok(!existsSync(rawPath), "cleanup precedes lcov validation");
      return { size: 42 };
    },
    computeMergeBaseDiff: () => "fixture diff",
    makeTempDiffDir: () => "/unused-diff-fixture",
    writeDiffFile: () => undefined,
    removeTempDiffDir: () => undefined,
    runDiffCoverageGate: (lcovPath: string) => {
      gateCalls.push(lcovPath);
      return { status: 0 };
    },
    log: (message: string) => logs.push(message),
    error: (message: string) => errors.push(message),
  });
  assert.ok(rawPath, "the injected spawn must have run");
  return { status, rawPath, logs, errors, gateCalls };
}

test("W1-T5766: passing instrumented runs remove fresh raw coverage outside the checkout", () => {
  const first = runMain(0);
  const second = runMain(0);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.notEqual(first.rawPath, second.rawPath, "each invocation needs its own fresh directory");
  assert.ok(!existsSync(first.rawPath));
  assert.ok(!existsSync(second.rawPath));
  assert.deepEqual(first.gateCalls, [join(REPO_ROOT, "coverage/lcov.info")]);
});

test("W1-T5766: failing instrumented runs remove raw coverage and preserve the failure status", () => {
  for (const status of [7, null]) {
    const run = runMain(status);
    assert.equal(run.status, status === null ? 1 : status);
    assert.ok(!existsSync(run.rawPath));
    assert.deepEqual(run.gateCalls, []);
    assert.ok(run.errors.some((message) => message.includes(`exited ${status}`)));
  }
});

test("W1-T5766: a thrown spawn still removes raw coverage in finally", () => {
  let rawPath = "";
  assert.throws(() => runMain(0, [], true, (path) => { rawPath = path; }), /spawn fixture failed/);
  assert.ok(rawPath);
  assert.ok(!existsSync(rawPath));
});

test("W1-T5766: --keep-raw retains the output and prints the retained path", () => {
  for (const status of [0, 7]) {
    const run = runMain(status, ["--keep-raw"]);
    try {
      assert.equal(run.status, status);
      assert.equal(readFileSync(join(run.rawPath, "coverage.json"), "utf8"), "raw fixture");
      assert.ok(run.logs.includes(`diff-coverage-local: kept raw coverage at: ${run.rawPath}`));
    } finally {
      rmSync(run.rawPath, { recursive: true, force: true });
    }
  }
});

test("W1-T5766: the default spawn writes real V8 output outside the checkout and removes it", () => {
  const fixture = mkdtempSync(join(tmpdir(), "rmd-w1-t5766-"));
  const observedPath = join(fixture, "raw-path.txt");
  try {
    const result = local.runInstrumentedTests(["-e", `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(observedPath)}, process.env.NODE_V8_COVERAGE);
    `]);
    assert.equal(result.status, 0);
    const rawPath = readFileSync(observedPath, "utf8");
    assertTransientRawPath(rawPath);
    assert.ok(!existsSync(rawPath));

    const logs: string[] = [];
    const kept = local.runInstrumentedTests(["-e", "0"], undefined, {
      keepRaw: true,
      log: (message: string) => logs.push(message),
    });
    assert.equal(kept.status, 0);
    assert.equal(logs.length, 1);
    const retained = logs[0].replace("diff-coverage-local: kept raw coverage at: ", "");
    try {
      assertTransientRawPath(retained);
      assert.ok(readdirSync(retained).some((file) => file.endsWith(".json")));
    } finally {
      rmSync(retained, { recursive: true, force: true });
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("W1-T5766: --dry-run describes transient raw coverage without spawning", () => {
  const logs: string[] = [];
  assert.equal(local.main(["--dry-run", "--keep-raw", "test/example.test.ts"], {
    runInstrumentedTests: () => assert.fail("dry-run must not spawn"),
    log: (message: string) => logs.push(message),
  }), 0);
  assert.ok(logs.some((message) => message.includes("NODE_V8_COVERAGE=<fresh temp directory>")));
});
