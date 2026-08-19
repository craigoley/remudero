import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { chromium, type Browser } from "playwright";

// ── W1-T1027 round 2: apt is off the critical path, so nothing has to survive it ────────────
//
// #2211 (the superseded attempt) kept `--with-deps` and tried to survive the apt lock it takes,
// with a bounded wait plus a three-attempt retry. IT DID NOT WORK, AND THE FAILURE WAS MEASURED
// TWICE, on two different runners: PR #2207 at 13:53Z (lock held by PID 2725) and PR #2199 at
// 14:39Z (PID 2702). In both, the SAME PID appears on attempts 2 AND 3 — it is the apt-get that
// attempt 1's `timeout` orphaned, not the image's own background apt-get the shard diagnosed.
// Two independent defects produced that:
//   * `wait_for_apt_lock` used `flock`, which cannot observe apt's `fcntl(F_SETLK)` lock, and ran
//     `flock … true` (acquire-and-release). It returned in under a second while the lock was
//     demonstrably held — a wait that cannot observe what it waits on.
//   * `timeout` orphaned a ROOT-owned apt-get. Playwright's own CLI help says `--with-deps` "will
//     ask for sudo permissions"; the step runs as `runner`, and kill(2) from non-root to root is
//     EPERM. Attempts 2 and 3 then burned 4.5 seconds against the orphan attempt 1 created.
//
// So this suite asserts the OPPOSITE of its predecessor: the step must invoke NO apt at all, and
// must carry no retry and no wait, because both existed only to survive a call that is gone.
// A retry, a longer wait, or DPkg::Lock::Timeout would each re-create the class.
//
// Scoped to `ci.yml`, the only file carrying the step, and reads the real file on disk rather
// than a fixture, so a later edit is what this suite actually reads.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CI_YAML_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");

type CiJob = { name?: string; steps?: Array<{ run?: string }> };

async function loadCiJobs(): Promise<Record<string, CiJob>> {
  const raw = await readFile(CI_YAML_PATH, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, CiJob> };
  return doc.jobs;
}

/** Matched by CONTENT, never a hardcoded job-name list — the same rule
 *  test/workflow-job-timeouts.test.ts uses, so the two cannot disagree about which jobs carry it. */
function playwrightInstallSteps(jobs: Record<string, CiJob>): Array<[string, string]> {
  return Object.entries(jobs).flatMap(([jobId, job]) =>
    (job.steps ?? [])
      .filter((s) => s.run?.includes("playwright install"))
      .map((s) => [jobId, s.run!] as [string, string]),
  );
}

test("W1-T1027: both playwright-carrying jobs exist and each has exactly one install step", async () => {
  const jobs = await loadCiJobs();
  const steps = playwrightInstallSteps(jobs);
  assert.deepEqual(
    steps.map(([jobId]) => jobId).sort(),
    ["ci", "coverage-ratchet"],
    "expected exactly `ci` and `coverage-ratchet` to carry a playwright install step",
  );
});

test("W1-T1027: no install step passes --with-deps, so no step invokes apt", async () => {
  const jobs = await loadCiJobs();
  const steps = playwrightInstallSteps(jobs);
  assert.ok(steps.length > 0, "sanity: no install step found, so this assertion would be vacuous");
  for (const [jobId, run] of steps) {
    assert.ok(
      !run.includes("--with-deps"),
      `job '${jobId}' passes --with-deps, which invokes apt — measured on a green run it installed ` +
        "0 upgraded, 9 newly installed, ALL fonts, and no Chromium shared library (26 were already " +
        "the newest version in the runner image)",
    );
    for (const token of ["apt", "sudo", "flock", "dpkg"]) {
      assert.ok(!run.includes(token), `job '${jobId}'s install step must not reference '${token}'`);
    }
  }
});

test("W1-T1027: no install step carries a retry, a lock wait, or a per-attempt timeout", async () => {
  const jobs = await loadCiJobs();
  for (const [jobId, run] of playwrightInstallSteps(jobs)) {
    // Each of these existed ONLY to survive apt. Re-adding one would mean apt came back, or that
    // a hang is being paced rather than removed — the exact thing measured not to work.
    for (const token of ["for attempt", "timeout ", "wait_for_apt_lock", "Lock::Timeout", "retry"]) {
      assert.ok(
        !run.includes(token),
        `job '${jobId}'s install step contains '${token}' — the retry/wait machinery was removed with ` +
          "--with-deps and must not return; a retry cannot outlive a lock holder it created and cannot kill",
      );
    }
  }
});

test("W1-T1027: both jobs carry a byte-identical install step (fix both copies or neither)", async () => {
  const jobs = await loadCiJobs();
  const runs = playwrightInstallSteps(jobs).map(([, run]) => run);
  assert.equal(runs.length, 2, "expected exactly two install steps");
  assert.equal(
    runs[0],
    runs[1],
    "the two install steps must stay byte-identical — PR #2150 took the board down on the copy " +
      "that had not been fixed, five minutes after PR #2148 hung on the other",
  );
});

test("W1-T1027: no third job silently grows a playwright install step", async () => {
  const jobs = await loadCiJobs();
  const jobIds = playwrightInstallSteps(jobs).map(([jobId]) => jobId);
  assert.equal(new Set(jobIds).size, 2, "a third job carrying this step would need its own timeout banding too");
});

// ── THE FALSIFIER: the browser still installs, and text still measures, WITHOUT the fonts ────
//
// The static assertions above prove the command no longer calls apt. They cannot prove Chromium
// still runs. These two do, IN THE SAME CI JOB THAT INSTALLED IT — if `npx playwright install
// chromium` (no --with-deps) failed to produce a working browser, `chromium.launch()` throws here
// and this file fails rather than the failure surfacing as an unexplained shell-ux error.
let browser: Browser | undefined;
let launchError: unknown;
before(async () => {
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  } catch (e) {
    launchError = e;
  }
});
after(async () => {
  await browser?.close();
});

test("W1-T1027: chromium launches from an install that never ran apt", async () => {
  assert.equal(
    launchError,
    undefined,
    `chromium.launch() failed, so 'npx playwright install chromium' did not produce a working browser: ${String(launchError)}`,
  );
  assert.ok(browser, "expected a launched browser");
  assert.ok(browser!.version().length > 0, "expected a real browser version string");
});

test("W1-T1027: the console's own font stack still resolves and measures, with no font package installed", async () => {
  assert.ok(browser, "expected a launched browser (see the launch test above)");
  const page = await browser!.newPage();
  try {
    // The console declares `system-ui, -apple-system, "Segoe UI", sans-serif` — no family among the
    // nine --with-deps used to install. If NO font resolved, text would measure zero width and the
    // 390px no-horizontal-overflow assertion in test/serve.shell-ux.test.ts could not mean anything.
    await page.setContent(
      '<div id="probe" style="font-family: system-ui, -apple-system, \'Segoe UI\', sans-serif; font-size: 16px; display: inline-block;">Remudero console</div>',
    );
    const box = await page.evaluate(() => {
      const el = document.getElementById("probe")!;
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    assert.ok(box.w > 0 && box.h > 0, `expected measurable text, got ${JSON.stringify(box)}`);
    // A zero-glyph fallback would collapse to the container; a real font gives width roughly
    // proportional to the string. This is a LOWER bound, deliberately loose — it must not become a
    // metrics assertion that breaks on a font revision.
    assert.ok(box.w > 40, `expected 16px Latin text to measure wider than 40px, got ${box.w}`);
  } finally {
    await page.close();
  }
});
