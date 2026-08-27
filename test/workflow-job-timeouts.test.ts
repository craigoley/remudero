import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// ── W1-T1009: every ci.yml job must bound its own runtime ───────────────────────────────────
//
// `timeout-minutes` read 0 across all 15 `.github/workflows/*.yml` files, so every job inherited
// GitHub's 360-minute default — 9x ci-gate.yml's own `WAIT_CAP_SECONDS: 2400`. On 2026-08-18 two
// jobs (`ci` on PR #2148, `coverage-ratchet` on PR #2150) hung on the same
// `npx playwright install --with-deps chromium` step, five minutes apart; ci-gate.yml timed out
// FIRST in both cases (its cap is 9x smaller) and misattributed the failure to itself, while the
// actually-hung job's log was unreadable ("job ... is still in progress") until a human with
// Actions-API write access cancelled it. Both incidents needed manual intervention nothing in
// `src/` can perform (rmd's only relationship to the Actions API is reading a COMPLETED job's
// log — there is no cancel/re-run call anywhere in `src/`), so the bound has to live in the
// workflow file itself.
//
// This suite is scoped to `ci.yml` only (the one file with a measured hang; see the task's
// `design` for why the other 14 workflow files are explicitly out of scope) and asserts all
// four acceptance criteria directly against the real files on disk — never a copy-pasted
// fixture of either workflow, so a later edit to either file is what this suite actually reads.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CI_YAML_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const CI_GATE_YAML_PATH = join(REPO_ROOT, ".github", "workflows", "ci-gate.yml");

type CiJob = {
  name: string;
  "timeout-minutes"?: number;
  steps?: Array<{ run?: string }>;
};

async function loadCiJobs(): Promise<Record<string, CiJob>> {
  const raw = await readFile(CI_YAML_PATH, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, CiJob> };
  return doc.jobs;
}

async function loadWaitCapSeconds(): Promise<number> {
  const raw = await readFile(CI_GATE_YAML_PATH, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, { env?: Record<string, string> }> };
  const gate = doc.jobs["ci-gate"];
  assert.ok(gate?.env?.WAIT_CAP_SECONDS, "ci-gate.yml's `ci-gate` job must declare env.WAIT_CAP_SECONDS");
  const parsed = Number(gate.env.WAIT_CAP_SECONDS);
  assert.ok(Number.isFinite(parsed) && parsed > 0, `WAIT_CAP_SECONDS must parse as a positive number, got ${gate.env.WAIT_CAP_SECONDS}`);
  return parsed;
}

/** A job "carries the Playwright install" when one of its steps' `run` shells out to
 * `playwright install` — matched by content, never by a hardcoded job-name list, so this
 * suite would catch the day a THIRD job grows the same step and stays unbounded. */
function jobsCarryingPlaywrightInstall(jobs: Record<string, CiJob>): string[] {
  return Object.entries(jobs)
    .filter(([, job]) => (job.steps ?? []).some((step) => step.run?.includes("playwright install")))
    .map(([jobId]) => jobId);
}

// ── acceptance 1: every job in ci.yml declares timeout-minutes ──────────────────────────────

test("W1-T1009: every ci.yml job declares a timeout-minutes", async () => {
  const jobs = await loadCiJobs();
  const jobIds = Object.keys(jobs);
  assert.ok(jobIds.length >= 13, `expected at least the 13 jobs ci.yml defined at filing time, got ${jobIds.length}`);

  for (const jobId of jobIds) {
    const value = jobs[jobId]!["timeout-minutes"];
    assert.ok(
      typeof value === "number" && Number.isFinite(value) && value > 0,
      `ci.yml job '${jobId}' has no positive timeout-minutes (got ${JSON.stringify(value)}) — ` +
        "it would inherit GitHub's 360-minute default and reproduce the W1-T1009 incident",
    );
  }
});

// ── acceptance 2: the Playwright-carrying jobs are bounded at the derived heavy-band value ──

test("W1-T1009: the Playwright-carrying jobs are bounded inside the heavy band", async () => {
  const jobs = await loadCiJobs();
  const playwrightJobs = jobsCarryingPlaywrightInstall(jobs);

  // The two measured hangs (PR #2148's `ci`, PR #2150's `coverage-ratchet`) were both on this
  // exact step. If a future edit adds or removes a `playwright install` step from a job, this
  // assertion is what forces the heavy/light banding to be reconsidered rather than silently
  // drifting.
  assert.deepEqual(
    [...playwrightJobs].sort(),
    ["ci", "coverage-ratchet"].sort(),
    "expected exactly `ci` and `coverage-ratchet` to carry a `playwright install` step — " +
      "if this changed, the heavy/light timeout banding needs to change with it",
  );

  // W1-T1009 asserted EQUALITY to 35 here. That was right while both heavy jobs shared a number
  // and wrong the moment they stopped: PR #3064 raised `coverage-ratchet` to 39m because it runs
  // the whole suite under --experimental-test-coverage and one flaky test sends that step into a
  // second full pass, neither of which `ci` pays for. THE BAND IS THE INVARIANT, NOT THE NUMBER --
  // a heavy job sits at or above the derived floor, strictly below ci-gate's cap, and strictly
  // above every light-band job; it may sit anywhere in between, and the two heavy jobs need not
  // agree. Asserting the literal made a legitimate raise fail a guard that had nothing to say
  // about it, which is how a ratchet gets deleted rather than satisfied.
  const HEAVY_FLOOR_MINUTES = 35; // 2100s — the derived FLOOR; see the comment beside `ci`'s timeout-minutes in ci.yml
  const waitCapSeconds = await loadWaitCapSeconds();

  // Both guards below exist so a broken scan cannot make this test pass by asserting nothing:
  // an empty heavy band would skip the loop entirely, and an empty light band would make the
  // separation check compare against -Infinity.
  assert.ok(
    playwrightJobs.length > 0,
    "expected at least one Playwright-carrying job — an empty band would make every assertion below vacuous",
  );
  const lightMinutes = Object.entries(jobs)
    .filter(([jobId]) => !playwrightJobs.includes(jobId))
    .map(([, job]) => job["timeout-minutes"])
    .filter((m): m is number => typeof m === "number" && Number.isFinite(m));
  assert.ok(lightMinutes.length > 0, "expected at least one light-band job to separate the heavy band from");
  const heaviestLight = Math.max(...lightMinutes);

  for (const jobId of playwrightJobs) {
    const minutes = jobs[jobId]!["timeout-minutes"];
    assert.ok(
      typeof minutes === "number" && Number.isFinite(minutes),
      `Playwright-carrying job '${jobId}' declares no numeric timeout-minutes (got ${JSON.stringify(minutes)}) — ` +
        "a job that grows this step must be bounded with it, or it inherits GitHub's 360-minute default",
    );
    assert.ok(
      minutes! >= HEAVY_FLOOR_MINUTES,
      `Playwright-carrying job '${jobId}' is bounded at ${minutes}m, BELOW the derived heavy floor ` +
        `(${HEAVY_FLOOR_MINUTES}m) — under the observed non-hung tail it kills honest work`,
    );
    assert.ok(
      minutes! * 60 < waitCapSeconds,
      `Playwright-carrying job '${jobId}' (${minutes}m = ${minutes! * 60}s) must stay strictly below ` +
        `ci-gate.yml's WAIT_CAP_SECONDS (${waitCapSeconds}s) — at or above it ci-gate times out first ` +
        "and the misattribution defect this task fixes returns intact",
    );
    assert.ok(
      minutes! > heaviestLight,
      `Playwright-carrying job '${jobId}' (${minutes}m) must be bounded strictly ABOVE every light-band ` +
        `job (heaviest light is ${heaviestLight}m) — otherwise the heavy/light banding is not a banding`,
    );
  }
});

// ── acceptance 3: the heavy bound is strictly below ci-gate's own declared wait cap ─────────

test("W1-T1009: the bound is strictly below ci-gate's own declared wait cap", async () => {
  const jobs = await loadCiJobs();
  const waitCapSeconds = await loadWaitCapSeconds();
  const playwrightJobs = jobsCarryingPlaywrightInstall(jobs);
  assert.ok(playwrightJobs.length > 0, "expected at least one Playwright-carrying job to check against WAIT_CAP_SECONDS");

  for (const jobId of playwrightJobs) {
    const timeoutMinutes = jobs[jobId]!["timeout-minutes"];
    assert.ok(typeof timeoutMinutes === "number", `job '${jobId}' has no timeout-minutes to compare`);
    const timeoutSeconds = timeoutMinutes! * 60;
    assert.ok(
      timeoutSeconds < waitCapSeconds,
      `job '${jobId}'s timeout-minutes (${timeoutMinutes}m = ${timeoutSeconds}s) must be strictly ` +
        `below ci-gate.yml's WAIT_CAP_SECONDS (${waitCapSeconds}s) — at or above it, ci-gate always ` +
        "times out first and the misattribution defect this task fixes returns intact",
    );
  }

  // Every LIGHT-band job must also clear the tail comfortably below the cap — this is the same
  // property, just checked for the whole file rather than only the two heavy jobs.
  for (const [jobId, job] of Object.entries(jobs)) {
    const timeoutMinutes = job["timeout-minutes"];
    if (typeof timeoutMinutes !== "number") continue;
    assert.ok(
      timeoutMinutes * 60 < waitCapSeconds,
      `job '${jobId}'s timeout-minutes (${timeoutMinutes}m) must stay strictly below ci-gate's WAIT_CAP_SECONDS`,
    );
  }
});

// ── acceptance 4: the coupling to ci-gate's cap is written down in ci.yml itself ────────────

test("W1-T1009: ci.yml's heavy-band comment names WAIT_CAP_SECONDS, coupling the two files", async () => {
  const raw = await readFile(CI_YAML_PATH, "utf8");
  assert.ok(
    raw.includes("WAIT_CAP_SECONDS"),
    "ci.yml must mention WAIT_CAP_SECONDS in a comment beside the heavy-band value, so a later " +
      "raise of one number without the other cannot silently restore the 2026-08-18 misattribution defect",
  );

  // The mention must sit beside the actual heavy-band job, not somewhere unrelated — a job
  // whose own comment block (from its `name:`/id line up to its `steps:` line) contains the
  // string proves the coupling is legible right where a future editor would change the number.
  const jobs = await loadCiJobs();
  const playwrightJobs = jobsCarryingPlaywrightInstall(jobs);
  const lines = raw.split("\n");
  for (const jobId of playwrightJobs) {
    const jobStartIdx = lines.findIndex((l) => new RegExp(`^  ${jobId}:\\s*$`).test(l));
    assert.ok(jobStartIdx >= 0, `could not locate job '${jobId}' block in ci.yml`);
    const stepsIdx = lines.findIndex((l, i) => i > jobStartIdx && /^\s{4}steps:\s*$/.test(l));
    assert.ok(stepsIdx > jobStartIdx, `could not locate '${jobId}'s steps: line in ci.yml`);
    const block = lines.slice(jobStartIdx, stepsIdx).join("\n");
    assert.ok(
      block.includes("WAIT_CAP_SECONDS"),
      `job '${jobId}'s block (between its job key and its steps:) must mention WAIT_CAP_SECONDS`,
    );
  }
});
