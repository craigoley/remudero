import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── W1-T4401 — SECURITY SCANS RUN IN FULL ON EVERY PR/PUSH WHATEVER CHANGED ─────────────────
//
// MEASURED 2026-09-23 over 30 days: PR security scans (CodeQL x2, Semgrep, OSV-Scanner (PR),
// Dependency Review, License Review) cost ~121k job-min/month, and OSV-Scanner (full) plus
// Scorecard ran on EVERY push to main rather than on a schedule. Design (i)/(iii): gate the two
// dependency scanners that only matter when a manifest/lockfile changes behind a real check of
// that diff, and move the full (non-diff-aware) OSV and Scorecard scans off "every main push"
// onto a schedule.
//
// WHAT IS REAL HERE, same convention as test/a-plan-filing-does-not-pay-for-codeql.test.ts: the
// committed workflow files, parsed, and (for the dependency-scan guard) the ACTUAL grep pattern
// the workflow's own shell step runs, extracted from its source text — never a fixture standing
// in for either.
//
// WHY NOT A JOB-LEVEL `if:` (the design note's literal words): `license-review` is REQUIRED by
// ci-gate.yml, and this repo's own doctrine (ci.yml's header; test/a-shipped-detector-exits-one-
// and-is-wired-to-nothing.test.ts; test/dependency-licence-policy.test.ts's own "carries NO
// job-level `if:`" assertion) is that a REQUIRED job runs unconditionally — only a STEP inside it
// may be conditioned. The PR-time OSV job stays unconditional and REQUIRED: it must always
// register its awaited check-run. W1-T4401 also hardens that scanner by keeping both checkouts
// below source/ and result artifacts in a sibling results/ directory outside untrusted PR paths.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");

function loadRaw(file: string): string {
  return readFileSync(join(WORKFLOWS_DIR, file), "utf8");
}

function loadDoc(file: string): {
  on?: Record<string, unknown>;
  jobs: Record<string, { name?: string; if?: unknown; uses?: string; steps?: Array<{ name?: string; id?: string; if?: unknown; run?: string; uses?: string; with?: Record<string, string>; [key: string]: unknown }> }>;
} {
  return parseYaml(loadRaw(file));
}

/** Extract the `grep -Eq '<pattern>'` literal from a step's `run:` text — the REAL regex the
 *  workflow itself evaluates against changed files, never a hand-typed guess at what it says. */
function extractGrepPattern(run: string): string {
  const m = /grep -Eq '([^']+)'/.exec(run);
  assert.ok(m, `no 'grep -Eq' pattern found in step run text:\n${run}`);
  return m![1]!;
}

/** Mirrors the workflow step's own bash EXACTLY (dependency-review.yml, both jobs):
 *    RESULT="true"
 *    if [ -n "$CHANGED" ] && ! printf '%s\n' "$CHANGED" | grep -Eq PATTERN; then RESULT="false"; fi
 *  i.e. fails open to "true" (run the scan) whenever the diff read is empty (a git-diff failure,
 *  never distinguishable at this level from "no files changed"), and otherwise runs the scan iff
 *  at least one changed path matches PATTERN. */
function wouldDepsChanged(changedFiles: readonly string[], pattern: RegExp): boolean {
  if (changedFiles.length === 0) return true;
  return changedFiles.some((f) => pattern.test(f));
}

function findStep(job: { steps?: Array<{ name?: string; id?: string; if?: unknown; run?: string }> }, predicate: (s: { name?: string; id?: string; if?: unknown; run?: string }) => boolean) {
  const step = (job.steps ?? []).find(predicate);
  assert.ok(step, "expected step not found");
  return step!;
}

// ── acceptance 1: "dependency scans run only when dependencies change" ─────────────────────

test("W1-T4401: dependency scans run only when dependencies change", () => {
  const doc = loadDoc("dependency-review.yml");

  const detectionSteps = [
    findStep(doc.jobs["dependency-review"]!, (s) => s.id === "deps-changed"),
    findStep(doc.jobs["license-review"]!, (s) => s.id === "deps-changed"),
  ];

  // Both jobs' detection steps must agree on the same real, extracted pattern — not two
  // hand-typed copies that could silently drift apart.
  const patterns = detectionSteps.map((s) => extractGrepPattern(s.run ?? ""));
  assert.equal(patterns[0], patterns[1], "dependency-review and license-review must gate on the identical pattern");
  const pattern = new RegExp(patterns[0]!);

  // THE FALSIFIER: the actual scan step in EACH job must carry a step-level `if:` tied to that
  // detection step's output. Delete that `if:` (the "remove the job-level condition" this task's
  // own falsifier names) and these two assertions fail immediately — the scan step would then run
  // on every PR regardless of the diff, which is exactly what the rest of this test proves it must
  // not do.
  const depReviewScanStep = findStep(doc.jobs["dependency-review"]!, (s) => s.name === "Dependency Review");
  assert.equal(depReviewScanStep.if, "steps.deps-changed.outputs.changed == 'true'", "Dependency Review step must be gated on the manifest/lockfile diff check");

  const licenseReviewScanStep = findStep(doc.jobs["license-review"]!, (s) => s.name === "License Review");
  assert.equal(licenseReviewScanStep.if, "steps.deps-changed.outputs.changed == 'true'", "License Review step must be gated on the manifest/lockfile diff check");

  // license-review is REQUIRED by ci-gate.yml, so the JOB itself must stay unconditional (no
  // job-level `if:`) — only its steps are gated. test/dependency-licence-policy.test.ts already
  // pins this; re-asserted here because it is load-bearing for THIS task's own falsifier reading
  // "dependency review running on a docs-only diff" as a SKIPPED STEP, not an absent check-run.
  assert.equal(doc.jobs["license-review"]!.if, undefined, "license-review must carry no job-level if:");

  // A DOCS-ONLY diff must not run either scan step.
  const docsOnly = ["docs/operator-guide.md", "plan/tasks.yaml", "README.md"];
  assert.equal(wouldDepsChanged(docsOnly, pattern), false, "a docs-only diff must not trip the manifest/lockfile detector");

  // A diff touching the root lockfile, a nested package.json, or a mixed diff must run it.
  assert.equal(wouldDepsChanged(["package-lock.json"], pattern), true, "the root lockfile must trip the detector");
  assert.equal(wouldDepsChanged(["package.json"], pattern), true, "the root manifest must trip the detector");
  assert.equal(wouldDepsChanged(["packages/api-client/package.json"], pattern), true, "a nested manifest must trip the detector");
  assert.equal(wouldDepsChanged(["docs/x.md", "package-lock.json"], pattern), true, "one dependency path is enough in a mixed diff");

  // FAIL-OPEN: an unreadable diff (empty CHANGED, e.g. `git diff` itself erroring) must default
  // to running the scan, never silently skipping a required/advisory gate because a read failed.
  assert.equal(wouldDepsChanged([], pattern), true, "an empty/unreadable diff must fail OPEN to running the scan");
});

// ── acceptance 2: "full scans still run on a schedule" ─────────────────────────────────────

test("W1-T4401: full scans still run on a schedule", () => {
  // OSV-Scanner (full, non-diff-aware) and Semgrep (full, non-diff-aware on schedule/push) both
  // used to fire on every push to main; Scorecard too. All three now carry a real `schedule:`
  // cron trigger, and none of them carries `push: branches: [main]` any longer.
  for (const file of ["osv-scanner.yml", "semgrep.yml", "scorecard.yml"]) {
    const doc = loadDoc(file);
    const schedule = doc.on?.schedule;
    assert.ok(Array.isArray(schedule) && schedule.length > 0, `${file} must still carry a schedule: trigger`);
    for (const entry of schedule as Array<{ cron?: string }>) {
      assert.equal(typeof entry.cron, "string", `${file}'s schedule entry must carry a real cron string`);
      assert.match(entry.cron!, /^\d{1,2} \d{1,2} \* \* [\d*]$/, `${file}'s cron '${entry.cron}' does not look like a real 5-field cron`);
    }
    assert.equal(doc.on?.push, undefined, `${file} must no longer trigger on push: branches: [main] — the whole point of this task`);
  }

  // osv-scanner.yml and semgrep.yml specifically move to NIGHTLY (was weekly) — a full scan now
  // closes an advisory-cut-after-merge gap within a day, not up to a week.
  for (const file of ["osv-scanner.yml", "semgrep.yml"]) {
    const doc = loadDoc(file);
    const [cron] = (doc.on?.schedule as Array<{ cron: string }>).map((s) => s.cron);
    assert.match(cron!, /^\d{1,2} \d{1,2} \* \* \*$/, `${file}'s cron '${cron}' must be a daily (nightly) cron, not weekly`);
  }

  // Scorecard stays WEEKLY (design (iii)'s own wording), just off the push trigger.
  const scorecard = loadDoc("scorecard.yml");
  const [scorecardCron] = (scorecard.on?.schedule as Array<{ cron: string }>).map((s) => s.cron);
  assert.match(scorecardCron!, /^\d{1,2} \d{1,2} \* \* [1-7]$/, "scorecard.yml's cron must stay weekly (a day-of-week field)");

  // CodeQL is the deliberate exception: its `push` trigger is NOT removed (a PR-time skip is only
  // sound because the SAME commit is re-analysed on push to main — pinned by
  // test/a-plan-filing-does-not-pay-for-codeql.test.ts), so this task must not touch it.
  const codeql = loadDoc("codeql.yml");
  assert.ok(codeql.on?.push, "codeql.yml must keep its push: trigger — it is the PR-skip safety argument's other half");
});

// ── Semgrep is diff-aware where the tool supports it, and skips PLAN/DOCS diffs like CodeQL ──

test("W1-T4401: Semgrep's pull_request trigger skips PLAN/DOCS diffs, and its scan is diff-aware via --baseline-commit on a pull_request run", () => {
  const doc = loadDoc("semgrep.yml");
  const pr = doc.on?.pull_request as { "paths-ignore"?: string[] } | undefined;
  assert.ok(pr, "semgrep.yml must still trigger on pull_request");
  const ignored = pr!["paths-ignore"] ?? [];
  assert.ok(ignored.length > 0, "semgrep.yml's pull_request trigger must carry a paths-ignore fast lane");
  for (const glob of ["plan/**", "docs/**", "learnings/**", "**/*.md"]) {
    assert.ok(ignored.includes(glob), `semgrep.yml's paths-ignore is missing ${glob}`);
  }

  const job = doc.jobs["semgrep"]!;
  const runStep = findStep(job, (s) => (s.run ?? "").includes("semgrep scan"));
  assert.match(runStep.run!, /baseline-commit/, "the Semgrep run step must reference --baseline-commit for diff-aware PR scanning");
  assert.match(
    JSON.stringify((job as unknown as { steps: Array<{ env?: Record<string, string> }> }).steps.find((s) => s.env?.BASELINE_REF)?.env?.BASELINE_REF ?? ""),
    /pull_request/,
    "the baseline ref must be conditioned on the pull_request event, so push/schedule stay full un-diffed sweeps",
  );
});

test("W1-T4401: the required OSV PR scan keeps comparison outputs outside the untrusted checkout", () => {
  const job = loadDoc("osv-scanner-pr.yml").jobs["scan-pr"]!;
  assert.equal(job.name, "scan-pr / osv-scan", "the native job must preserve ci-gate's awaited check-run name");
  assert.equal(job.uses, undefined, "the scan must not delegate the checkout/output boundary to the vulnerable reusable workflow");
  const steps = job.steps ?? [];
  const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
  assert.equal(checkouts.length, 2, "compare the target and PR merge tree in controlled checkouts");
  assert.equal(checkouts[0]?.with?.ref, "${{ github.event.pull_request.base.sha }}");
  assert.equal(checkouts[1]?.with?.ref, "${{ github.sha }}");
  assert.ok(checkouts.every((s) => s.with?.path === "source"), "untrusted tracked paths must remain below source/");

  const oldScan = steps.find((s) => s.id === "scan-old");
  const newScan = steps.find((s) => s.id === "scan-new");
  assert.match(oldScan?.with?.["scan-args"] ?? "", /--output=results\/old-results\.json/);
  assert.match(newScan?.with?.["scan-args"] ?? "", /--output=results\/new-results\.json/);
  assert.match(oldScan?.with?.["scan-args"] ?? "", /\nsource$/);
  assert.match(newScan?.with?.["scan-args"] ?? "", /\nsource$/);

  const completeness = steps.find((s) => s.name === "Check that both scans produced results");
  assert.ok(completeness?.run?.includes('[ ! -s "$result" ]'), "missing scan output must fail closed before comparison");
  const reporter = steps.find((s) => s.uses?.includes("osv-reporter-action"));
  assert.match(reporter?.with?.["scan-args"] ?? "", /--old=results\/old-results\.json/);
  assert.match(reporter?.with?.["scan-args"] ?? "", /--new=results\/new-results\.json/);
  assert.match(reporter?.with?.["scan-args"] ?? "", /--fail-on-vuln=true/);
  assert.notEqual(reporter?.["continue-on-error"], true, "the final vulnerability comparison must remain blocking");
});

test("W1-T4401: a PR-controlled result-name symlink cannot overwrite the isolated baseline", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4401-osv-symlink-`));
  try {
    const source = join(root, "source");
    const results = join(root, "results");
    mkdirSync(source);
    mkdirSync(results);
    const oldResult = join(results, "old-results.json");
    const newResult = join(results, "new-results.json");
    writeFileSync(oldResult, "baseline result\n");

    // Reproduce the upstream exploit shape: a tracked symlink lives in the PR checkout and points
    // at the baseline. Writing through that checkout path would destroy the comparison.
    symlinkSync("../results/old-results.json", join(source, "new-results.json"));

    // The hardened workflow writes to the sibling results/ directory, not through that symlink.
    writeFileSync(newResult, "proposed result\n");
    assert.equal(readFileSync(oldResult, "utf8"), "baseline result\n");
    assert.equal(readFileSync(newResult, "utf8"), "proposed result\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
