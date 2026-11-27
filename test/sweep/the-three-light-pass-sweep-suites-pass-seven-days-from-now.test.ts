import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSuitesShifted } from "#src/lib/gate-gardener.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T15078. The suites' fixture dates derive from Date.now, so their age stays stable when that clock shifts.
const FILES = [
  "test/sweep/a-light-pass-decides-from-its-last-good-open-pr-list-when-the-read-fails.test.ts",
  "test/sweep/an-idle-light-pass-decides-from-the-tick-reads-open-pr-views.test.ts",
  "test/sweep/a-light-pass-with-no-scope-decides-from-the-tick-reads-open-pr-views.test.ts",
] as const;

function failures(shiftDays: number): string[] {
  const results = runSuitesShifted(REPO_ROOT, FILES, shiftDays);
  assert.equal(results.size, FILES.length, "every suite reported its own result");
  return [...results].flatMap(([file, r]) => {
    if ("error" in r) return [`${file}: ${r.error.message}`];
    assert.ok(r.tests > 0, `${file} ran named tests`);
    return r.passed ? [] : [file];
  });
}

/** The three suites at the real clock, in a child started BEFORE the shifted run and written to a file (never a
 *  pipe the blocked event loop would leave full). It uses one test worker while the shifted batch runs. */
function realClockRun(): Promise<{ code: number | null; tap: string }> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t15078-"));
  const out = join(dir, "real-clock.tap"), fd = openSync(out, "w");
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dir, NODE_V8_COVERAGE: "" };
  for (const name of ["NODE_TEST_CONTEXT", "FK_SHIFT_DAYS", "RMD_SELF_SYNC_DONE"]) delete env[name];
  // As the shifted child does: this run is not part of an enclosing coverage measurement.
  env.NODE_OPTIONS = (env.NODE_OPTIONS ?? "").replace(/(^|\s)--experimental-test-coverage(?=\s|$)/g, "$1").trim();
  if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", ...FILES],
    { cwd: REPO_ROOT, env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  return new Promise((done, fail) => {
    child.once("error", fail);
    child.once("close", (code) => {
      try { done({ code, tap: readFileSync(out, "utf8") }); } catch (error) { fail(error); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
}

test("W1-T15078 criterion 1: the three light-pass suites pass seven days from now", async () => {
  for (const file of FILES) assert.ok(existsSync(join(REPO_ROOT, file)), `${file} exists — a ghost path would read as a clean pass`);
  const real = realClockRun();
  assert.deepEqual(failures(7), [], "every suite passes with Date.now shifted +7 days");
  const { code, tap } = await real;
  const count = (name: string) => Number(new RegExp(`^# ${name} (\\d+)$`, "m").exec(tap)?.[1] ?? NaN);
  assert.ok(count("tests") > 0, `the real-clock run reported its tests:\n${tap.slice(-2000)}`);
  assert.deepEqual([code, count("fail"), count("cancelled")], [0, 0, 0], `every suite passes at the real clock:\n${tap.slice(-2000)}`);
});
