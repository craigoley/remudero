/**
 * W1-T14786: on core PR #20802 (2026-11-25) the clock sweep listed 15 suites that passed today and failed in the
 * future. Each now takes its "now" from the clock the code under test reads: this process's clock for in-process
 * code, the host clock for a child whose clock the shift preload never moves, or the same shift for a child that
 * models the same host. This suite runs each of the 15 as its own child, exactly as the sweep's runner does, at
 * the 7-day shift that first named them and at the sweep's own shift, so none of them can drift back unseen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type SweepRow = { suite: string };
// `scripts/**` is outside tsconfig's `include`, so the sweep loads through a dynamic specifier, as
// test/clock-sweep.test.ts loads it.
const { classifySweep, SUITE_PRELOAD, suiteName, SWEEP_SHIFT_DAYS } = (await import(
  pathToFileURL(join(REPO_ROOT, "scripts", "clock-sweep.mjs")).href)) as {
  classifySweep: (results: Map<string, { failed: boolean }>) => { newDrift: SweepRow[]; drifted: SweepRow[] };
  SUITE_PRELOAD: string;
  suiteName: (file: string) => string;
  SWEEP_SHIFT_DAYS: number;
};

const FIFTEEN = [
  "test/ci/coverage/the-live-coverage-flip-requires-a-fresh-nightly-floor.test.ts",
  "test/console-api/serve/product-routes.test.ts",
  "test/daemon/a-paused-instance-says-when-it-has-drained.test.ts",
  "test/daemon/a-worktree-janitor-reports-what-it-would-retire.test.ts",
  "test/daemon/repository-maintenance-escalation-heals-itself.test.ts",
  "test/deploy/preserve-retire-keep-declarations-hold-every-action.test.ts",
  "test/dispatch/product-plan-operation.test.ts",
  "test/expiring-fixture-census.test.ts",
  "test/fix-lane/rmd-fix-never-reports-a-round-fixed-when-its-progress-judgment-failed.test.ts",
  "test/github/every-mac-session-reads-github-through-one-broker.test.ts",
  "test/inbox/a-triage-outcome-that-files-no-task-lands-through-the-feedback-landing.test.ts",
  "test/sweep/a-light-pass-decides-from-its-last-good-open-pr-list-when-the-read-fails.test.ts",
  "test/sweep/a-light-pass-with-no-scope-decides-from-the-tick-reads-open-pr-views.test.ts",
  "test/sweep/an-idle-light-pass-decides-from-the-tick-reads-open-pr-views.test.ts",
  "test/sweep/the-sweep-effects-read-terminal-heads-from-the-slice-store.test.ts",
] as const;

type Run = { failed: boolean; output: string };

function withoutTestContext(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _context, ...rest } = env;
  return rest;
}

/** One suite as the sweep's `runSuite` runs it: TAP, the test preload, the shift preload and a private TMPDIR. */
function runShifted(file: string, days: number): Promise<Run> {
  const isolatedTmp = mkdtempSync(join(tmpdir(), "rmd-w1-t14786-"));
  return new Promise((resolve) => {
    execFile(process.execPath,
      ["--test", "--test-reporter=tap", "--import", "tsx", "--import", join(REPO_ROOT, SUITE_PRELOAD),
        "--import", join(REPO_ROOT, "scripts", "clock-shift.mjs"), file],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
        // Without NODE_TEST_CONTEXT the child reports its own TAP, as it does under the sweep's script runner.
        env: { ...withoutTestContext(process.env), TMPDIR: isolatedTmp, FK_SHIFT_DAYS: String(days) } },
      (error, stdout, stderr) => {
        rmSync(isolatedTmp, { recursive: true, force: true });
        resolve({ failed: error !== null, output: `${stdout}${stderr}` });
      });
  });
}

/** Every suite at one shift, a few children at a time. */
async function runAll(days: number): Promise<Map<string, Run>> {
  const results = new Map<string, Run>();
  const queue = [...FIFTEEN];
  const workers = Array.from({ length: Math.max(1, Math.min(4, availableParallelism() - 1)) }, async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) results.set(file, await runShifted(file, days));
  });
  await Promise.all(workers);
  return results;
}

/** A run counts only when its own TAP summary says it ran tests and failed none. */
function verdict(run: Run): string {
  const tests = Number(/^# tests (\d+)$/m.exec(run.output)?.[1] ?? 0);
  const fails = Number(/^# fail (\d+)$/m.exec(run.output)?.[1] ?? -1);
  if (!run.failed && tests > 0 && fails === 0) return "pass";
  const notOk = run.output.split("\n").filter((line) => /^\s*not ok /.test(line)).slice(0, 3).join(" | ");
  return `fail (tests ${tests}, fail ${fails}${notOk ? `: ${notOk}` : ""})`;
}

test("W1-T14786 the fifteen clock drift suites pass under a seven day clock shift", { timeout: 1_800_000 }, async () => {
  const results = await runAll(7);
  assert.equal(results.size, FIFTEEN.length);
  const failing = [...results].map(([file, run]) => [file, verdict(run)]).filter(([, v]) => v !== "pass");
  assert.deepEqual(failing, [], "every suite passes 7 days from now");
});

test("W1-T14786 the clock sweep reports no new drift for the fifteen suites", { timeout: 1_800_000 }, async () => {
  const results = await runAll(SWEEP_SHIFT_DAYS);
  // Positive control: a child that never reported its own summary would read as "not failed" to the classifier.
  assert.deepEqual([...results].map(([file, run]) => [file, verdict(run)]).filter(([, v]) => v !== "pass"), [],
    `every suite runs and passes at +${SWEEP_SHIFT_DAYS} days`);
  const bySuite = new Map([...results].map(([file, run]) => [suiteName(file.slice("test/".length)), run]));
  const sweep = classifySweep(bySuite);
  assert.deepEqual(sweep.newDrift.map((row) => row.suite), [],
    `the sweep's own classifier at +${SWEEP_SHIFT_DAYS} days names none of the fifteen as new drift`);
  assert.deepEqual(sweep.drifted.map((row) => row.suite), []);
});
