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

/**
 * The step's EXECUTABLE lines only — every `#` comment and blank line removed.
 *
 * W1-T1027 round 2: the assertions below used to run against the whole `run:` block, so a
 * mechanism named in a COMMENT satisfied them. That is how round 1's `flock` no-op passed its
 * own gate, and this round's first attempt then satisfied the same assertions with prose about
 * `fuser` while the command line no longer waited on anything at all. A gate that a comment can
 * satisfy is not a gate.
 */
function playwrightInstallCommands(job: CiJob): string {
  const run = playwrightInstallStep(job) ?? "";
  return run
    .split("\n")
    .filter((line) => !/^\s*#/.test(line) && line.trim() !== "")
    .join("\n");
}

const EXPECTED_JOBS = ["ci", "coverage-ratchet"];

test("W1-T1027: both playwright-carrying jobs exist and each has an install step", async () => {
  const jobs = await loadCiJobs();
  for (const jobId of EXPECTED_JOBS) {
    assert.ok(jobs[jobId], `expected job '${jobId}' in ci.yml`);
    assert.ok(playwrightInstallStep(jobs[jobId]!), `job '${jobId}' must carry a playwright install step`);
  }
});

test("W1-T1027: the install step either avoids apt entirely, or waits with a mechanism that can SEE the holder", async () => {
  const jobs = await loadCiJobs();
  for (const jobId of EXPECTED_JOBS) {
    const cmd = playwrightInstallCommands(jobs[jobId]!);

    // THE MEASUREMENT THIS ENCODES. `--with-deps` is the only reason this step touches apt, and
    // apt on this runner fleet is contended by the image's own background apt-get: on PR #2225
    // the step waited its full 3 x 300s and the holder was STILL there at 1010 seconds, refuting
    // round 1's "that holder always finishes on its own". A green run showed `--with-deps`
    // installs ONLY font packages, never a Chromium shared library. So the sanctioned shapes are
    // (a) do not invoke apt at all, or (b) invoke it behind a wait that can OBSERVE the holder —
    // `fuser` (any open handle, whatever the lock flavour) or apt's own DPkg::Lock::Timeout.
    // `flock` is deliberately NOT accepted: it cannot see dpkg's fcntl(2) record lock at all.
    const invokesApt = /--with-deps/.test(cmd);
    const waitsObservably = /\bfuser\b/.test(cmd) || /DPkg::Lock::Timeout/.test(cmd);
    assert.ok(
      !invokesApt || waitsObservably,
      `job '${jobId}'s install step invokes apt via --with-deps without an observing wait. Either ` +
        "drop --with-deps (the browser download needs no apt) or wait with fuser / " +
        "DPkg::Lock::Timeout -- flock cannot see dpkg's fcntl lock and returns instantly.",
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
