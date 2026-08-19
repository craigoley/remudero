import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// ── W1-T1027: the playwright install step must survive a CONTENDED apt lock ─────────────────
//
// 18 of 69 failed-or-cancelled CI jobs in a 48h window (2026-08-17T12:17:22Z..2026-08-19T12:05:
// 45Z) died on `npx playwright install --with-deps chromium`; 17 hung until the job cap and the
// one that failed loudly named the cause verbatim: `E: Could not get lock
// /var/lib/apt/lists/lock. It is held by process 2418 (apt-get)`. The pre-existing mitigation
// (W1-T1009/#2160, asserted by test/workflow-job-timeouts.test.ts) bounds a hang into a finite
// retry, but retries the IDENTICAL `--with-deps` command (which itself re-runs `apt-get update`)
// against a lock it cannot win. The task's shard establishes the holder is the runner IMAGE's
// own background apt-get, not another job, and that it always finishes on its own -- so this
// suite asserts each attempt now WAITS (bounded) for that lock to clear before invoking
// playwright install, rather than colliding with it immediately and burning the attempt.
//
// This suite is scoped to `ci.yml`, the only file carrying the step (test/workflow-job-timeouts
// .test.ts's own content-matched search already establishes exactly `ci` and `coverage-ratchet`
// carry it), and reads the real file on disk -- never a copy-pasted fixture -- so a later edit
// is what this suite actually reads.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CI_YAML_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");

type CiJob = {
  name: string;
  steps?: Array<{ run?: string }>;
};

async function loadCiJobs(): Promise<Record<string, CiJob>> {
  const raw = await readFile(CI_YAML_PATH, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, CiJob> };
  return doc.jobs;
}

/** Matched by content, never a hardcoded job-name list -- mirrors
 * test/workflow-job-timeouts.test.ts's own `jobsCarryingPlaywrightInstall`. */
function playwrightInstallStep(job: CiJob): string | undefined {
  return (job.steps ?? []).find((step) => step.run?.includes("playwright install"))?.run;
}

const EXPECTED_JOBS = ["ci", "coverage-ratchet"];

test("W1-T1027: both playwright-carrying jobs exist and each has an install step", async () => {
  const jobs = await loadCiJobs();
  for (const jobId of EXPECTED_JOBS) {
    assert.ok(jobs[jobId], `expected job '${jobId}' in ci.yml`);
    assert.ok(playwrightInstallStep(jobs[jobId]!), `job '${jobId}' must carry a playwright install step`);
  }
});

test("W1-T1027: the install step waits for the apt/dpkg lock before each attempt, rather than blindly re-invoking", async () => {
  const jobs = await loadCiJobs();
  for (const jobId of EXPECTED_JOBS) {
    const run = playwrightInstallStep(jobs[jobId]!)!;
    // W1-T1027 round 2: this used to assert the literal string `flock`, which is why the
    // no-op survived — `flock -w` cannot observe the fcntl(2) record lock dpkg actually holds
    // (measured: rc=0 after 0s against an fcntl-held lock, vs a full block against a
    // flock-held one), so the step matched the assertion while waiting for nothing. The
    // assertion now names MECHANISMS THAT CAN SEE THE HOLDER, and deliberately excludes
    // `flock`: `fuser` reports any process holding the file open whatever the lock flavour,
    // and `DPkg::Lock::Timeout` is apt's own wait applied inside the apt-get `--with-deps`
    // invokes. A future edit that reverts to `flock` alone fails here rather than passing.
    const waitMechanism = /\bfuser\b/.test(run) || /DPkg::Lock::Timeout/.test(run);
    assert.ok(
      waitMechanism,
      `job '${jobId}'s install step must wait on the apt/dpkg lock with a mechanism that can ` +
        "OBSERVE the holder (fuser, or apt's own DPkg::Lock::Timeout) before invoking playwright " +
        "install -- `flock` cannot see dpkg's fcntl lock and returns instantly, which is the " +
        "no-op this round replaces",
    );
    assert.ok(
      run.includes("/var/lib/dpkg/lock-frontend") || run.includes("/var/lib/apt/lists/lock"),
      `job '${jobId}'s install step must name the actual apt/dpkg lock path it waits on`,
    );
  }
});

test("W1-T1027: the W1-T1009 bounded retry is preserved (3 attempts, 360s each) -- it must not be reverted", async () => {
  const jobs = await loadCiJobs();
  for (const jobId of EXPECTED_JOBS) {
    const run = playwrightInstallStep(jobs[jobId]!)!;
    assert.ok(
      /for attempt in 1 2 3/.test(run),
      `job '${jobId}'s install step must keep the 3-attempt retry bound -- it is the only thing ` +
        "making a still-contended lock finite",
    );
    assert.ok(/timeout 360/.test(run), `job '${jobId}'s install step must keep the 360s per-attempt timeout bound`);
  }
});

test("W1-T1027: both jobs carry a byte-identical install step (fix both copies or neither)", async () => {
  const jobs = await loadCiJobs();
  const ciRun = playwrightInstallStep(jobs["ci"]!)!;
  const coverageRun = playwrightInstallStep(jobs["coverage-ratchet"]!)!;
  assert.equal(
    ciRun,
    coverageRun,
    "the `ci` and `coverage-ratchet` jobs' playwright install steps must stay byte-identical -- " +
      "a fix applied to only one leaves the other able to take the board down on its own, exactly " +
      "as PR #2150 did five minutes after PR #2148's `ci` hang on this same step",
  );
});

test("W1-T1027: no third job silently grows an unwaited playwright install step", async () => {
  const jobs = await loadCiJobs();
  const carrying = Object.entries(jobs)
    .filter(([, job]) => playwrightInstallStep(job) !== undefined)
    .map(([jobId]) => jobId);
  assert.deepEqual(
    [...carrying].sort(),
    [...EXPECTED_JOBS].sort(),
    "expected exactly `ci` and `coverage-ratchet` to carry a playwright install step -- a third " +
      "job growing one would need this fix applied too",
  );
});
