import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSuitesShifted } from "#src/lib/gate-gardener.js";
import { admitStaticWorkAsync, testRunArgv, unwrapLowPriority } from "#src/lib/test-slot.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T15078. The suites' fixture dates derive from Date.now, so their age stays stable when that clock shifts.
const FILES = [
  "test/sweep/a-light-pass-decides-from-its-last-good-open-pr-list-when-the-read-fails.test.ts",
  "test/sweep/an-idle-light-pass-decides-from-the-tick-reads-open-pr-views.test.ts",
  "test/sweep/a-light-pass-with-no-scope-decides-from-the-tick-reads-open-pr-views.test.ts",
] as const;

/** runSuitesShifted's own child (its batch, clock shift, judge and reporters), started at this test's priority with
 *  one worker per suite. The gardener's run is niced and gets one worker on a loaded host, so the suites (44 s, 15 s
 *  and 7.7 s in the tier manifest) ran one after another at nice 10. On a loaded host the proof then ran longer than
 *  the reviewer's 180 s bound twice. */
const atTestPriority: NonNullable<NonNullable<Parameters<typeof runSuitesShifted>[3]>["execFile"]> = (command, args, options) => {
  const child = unwrapLowPriority(command, args);
  return execFileSync(child.file, testRunArgv(child.args, FILES.length), options);
};

function failures(shiftDays: number): string[] {
  const results = runSuitesShifted(REPO_ROOT, FILES, shiftDays, { execFile: atTestPriority });
  assert.equal(results.size, FILES.length, "every suite reported its own result");
  return [...results].flatMap(([file, r]) => {
    if ("error" in r) return [`${file}: ${r.error.message}`];
    assert.ok(r.tests > 0, `${file} ran named tests`);
    return r.passed ? [] : [file];
  });
}

/** The three suites at the real clock, in a child started BEFORE the shifted run and written to a file (never a
 *  pipe the blocked event loop would leave full). Like the shifted batch, it runs one worker per suite. */
function realClockRun(): Promise<{ code: number | null; tap: string }> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t15078-"));
  const out = join(dir, "real-clock.tap"), fd = openSync(out, "w");
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dir, NODE_V8_COVERAGE: "" };
  for (const name of ["NODE_TEST_CONTEXT", "FK_SHIFT_DAYS", "RMD_SELF_SYNC_DONE"]) delete env[name];
  // As the shifted child does: this run is not part of an enclosing coverage measurement.
  env.NODE_OPTIONS = (env.NODE_OPTIONS ?? "").replace(/(^|\s)--experimental-test-coverage(?=\s|$)/g, "$1").trim();
  if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ["--test", `--test-concurrency=${FILES.length}`, "--test-reporter=tap", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", ...FILES],
    { cwd: REPO_ROOT, env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  return new Promise((done, fail) => {
    child.once("error", fail);
    child.once("close", (code) => {
      try { done({ code, tap: readFileSync(out, "utf8") }); } catch (error) { fail(error); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
}

/** One run of this test (the real-clock child beside the shifted batch, six suites) peaked at 4.5 GiB of process tree
 *  on Azure (2026-11-27). The flake screen starts twice the runner's cores of copies at once (eight on CI, about 36 GiB)
 *  and the 16 GiB runner was shut down twice. Each run names its peak in a static admission over a directory every
 *  copy on the host shares, so a copy waits for memory instead of starting beside the others; the run itself is unchanged. */
const RUN_PEAK_BYTES = 5 * 1024 ** 3;
const ADMISSION_DIR = join(tmpdir(), "rmd-w1-t15078-shifted-suite-admission");

// Its own bound, kept by every tier (scripts/test-tier-manifest.mjs): two runs of three suites, beyond a derived 120 s.
test("W1-T15078 criterion 1: the three light-pass suites pass seven days from now", { timeout: 600_000 }, async () => {
  for (const file of FILES) assert.ok(existsSync(join(REPO_ROOT, file)), `${file} exists — a ghost path would read as a clean pass`);
  mkdirSync(ADMISSION_DIR, { recursive: true });
  const admission = await admitStaticWorkAsync("test:W1-T15078 shifted suites", { memoryBytes: RUN_PEAK_BYTES, dir: ADMISSION_DIR, log: () => {} });
  let real: Awaited<ReturnType<typeof realClockRun>>;
  try {
    const running = realClockRun();
    assert.deepEqual(failures(7), [], "every suite passes with Date.now shifted +7 days");
    real = await running;
  } finally {
    admission.release();
  }
  const { code, tap } = real;
  const count = (name: string) => Number(new RegExp(`^# ${name} (\\d+)$`, "m").exec(tap)?.[1] ?? NaN);
  assert.ok(count("tests") > 0, `the real-clock run reported its tests:\n${tap.slice(-2000)}`);
  assert.deepEqual([code, count("fail"), count("cancelled")], [0, 0, 0], `every suite passes at the real clock:\n${tap.slice(-2000)}`);
});
