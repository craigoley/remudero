/**
 * W1-T7808 — A TEST PROCESS NEVER SWEEPS THE MACHINE'S REAL TEMP ROOT.
 *
 * Every test that boots `daemonCommand` or `main()` ran `sweepStaleTempDirs()` on `tmpdir()`, deleting
 * every rmd-* dir older than 24 h in the real temp root, and under a clock that moves `Date.now` but
 * not the file clock it deleted the test's own fixture (#10719). These tests spawn a REAL `node --test`
 * child under the repo's own setup imports with TMPDIR pointed at a sandbox, so the sandbox stands in
 * for the machine's real temp root. They do not depend on HOW the sweep is kept off that root.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP_MODULE = pathToFileURL(join(REPO, "src", "lib", "tmp.ts")).href;
const TWO_DAYS_MS = 2 * 86_400_000;

/** The child's body: boot both sweeps exactly as `main()` and the daemon rung do (no root named), optionally
 *  with `Date.now` moved ahead of the file clock, and check its own fixture is still there afterwards. */
const CHILD_SOURCE = `
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sweepStaleTempDirs, sweepStaleTempDirsAsync } from ${JSON.stringify(TMP_MODULE)};

test("child: the boot sweeps run", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "w1t7808-fixture-"));
  const shift = Number(process.env.W1_T7808_SHIFT_MS ?? "0");
  const realNow = Date.now;
  if (shift > 0) Date.now = () => realNow() + shift;
  try {
    sweepStaleTempDirs();
    await sweepStaleTempDirsAsync();
  } finally {
    Date.now = realNow;
  }
  assert.equal(existsSync(fixture), true, "the sweep must not delete this process's own fixture");
});
`;

interface Sandbox {
  /** Stands in for the machine's real temp root: the child's TMPDIR. */
  root: string;
  /** Holds the child's test file; outside `root`, so the sweep could never touch it. */
  scripts: string;
  /** An rmd- dir in `root`, aged two days past the file clock. */
  canary: string;
}

function withSandbox<T>(run: (sb: Sandbox) => T): T {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t7808-root-"));
  const scripts = mkdtempSync(join(tmpdir(), "rmd-w1t7808-scripts-"));
  const canary = join(root, "rmd-w1t7808-canary");
  mkdirSync(canary);
  const aged = new Date(Date.now() - TWO_DAYS_MS);
  utimesSync(canary, aged, aged);
  try {
    return run({ root, scripts, canary });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scripts, { recursive: true, force: true });
  }
}

/** The env a child needs: this process's, minus the test-runner markers that would make a nested
 *  `node --test` behave as a file child of THIS run, with TMPDIR moved to the sandbox. */
function childEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, ...extra };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_V8_COVERAGE = ""; // blank, never delete: child_process re-injects a deleted variable
  return env;
}

function runTestChild(sb: Sandbox, extra: Record<string, string> = {}) {
  const file = join(sb.scripts, "child.test.ts");
  writeFileSync(file, CHILD_SOURCE);
  return spawnSync(
    process.execPath,
    ["--test", "--import", "tsx", "--import", join(REPO, "test", "setup", "tmp-hygiene.ts"), file],
    { cwd: REPO, env: childEnv(sb.root, extra), encoding: "utf8", timeout: 120_000 },
  );
}

test("W1-T7808: a test process that runs the temp sweep leaves an aged rmd- dir in the real temp root", () =>
  withSandbox((sb) => {
    const child = runTestChild(sb);
    assert.equal(child.status, 0, `child failed:\n${child.stdout}\n${child.stderr}`);
    assert.equal(existsSync(sb.canary), true, "an aged rmd- dir in the temp root must survive a test process's sweep");
  }));

test("W1-T7808: a shifted wall clock does not let the sweep delete the test fixture", () =>
  withSandbox((sb) => {
    const child = runTestChild(sb, { W1_T7808_SHIFT_MS: String(TWO_DAYS_MS) });
    assert.equal(child.status, 0, `child failed (its fixture was deleted?):\n${child.stdout}\n${child.stderr}`);
    assert.equal(existsSync(sb.canary), true, "a shifted clock must not widen the sweep onto the temp root either");
  }));

test("W1-T7808: outside a test the sweep still reaps an aged rmd- dir", () =>
  withSandbox((sb) => {
    const code = [
      `import { sweepStaleTempDirs, sweepStaleTempDirsAsync } from ${JSON.stringify(TMP_MODULE)};`,
      "const sync = sweepStaleTempDirs();",
      "const async_ = await sweepStaleTempDirsAsync();",
      "console.log(JSON.stringify({ sync, async_ }));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: REPO, env: childEnv(sb.root), encoding: "utf8", timeout: 120_000,
    });
    assert.equal(child.status, 0, `child failed:\n${child.stdout}\n${child.stderr}`);
    assert.equal(existsSync(sb.canary), false, "production reclaim is unchanged: the aged rmd- dir is removed");
    const out = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as {
      sync: { removed: string[]; refused?: string };
    };
    assert.deepEqual(out.sync.removed, ["rmd-w1t7808-canary"]);
    assert.equal(out.sync.refused, undefined);
  }));
