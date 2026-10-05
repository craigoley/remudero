/**
 * W1-T5844 — A COVERAGE SKIP MESSAGE NAMES THE DIFF CLASS IT SKIPPED FOR.
 *
 * coverage-ratchet's "Test with coverage" and coverage-ratchet-required's "Diff coverage" printed
 * "no src/**\/test/** path in this diff" for every non-SOURCE class. That is true of PLAN_ONLY and
 * DOCS_ONLY, but W1-T5699's NO_SRC class (no src/ path, test/ paths allowed) and TEST_ONLY (every path
 * under test/) both skip with test/ paths in the diff, so an operator reading the skip on a test-only
 * change was told there was no test path. Each skip line now picks its reason by class; the step
 * conditions are untouched, and this file pins them.
 *
 * The REAL step bodies from .github/workflows/ci.yml run through bash with the class substituted and a
 * `node` that fails if reached, so a non-SOURCE class must leave through its skip branch.
 *
 * FALSIFIER: restore the old "no src/**\/test/** path" wording — the NO_SRC lines claim no test/ path
 * and the first test fails.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
type Step = { name?: string; id?: string; if?: string; run?: string };
const jobs = (parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { steps: Step[] }> })
  .jobs;

const NO_SRC_REASON = "no src/** path in this diff";
const PLAN_REASON = "no src/**/test/** path in this diff";

/** The three steps that measure coverage, and the expression each reads its class from. */
const COVERAGE_STEPS = [
  { job: "coverage-ratchet", name: "Test with coverage", classExpr: "${{ steps.classify.outputs.class }}" },
  { job: "coverage-ratchet-required", name: "Diff coverage", classExpr: "${{ steps.coverage-artifact.outputs.class }}" },
  { job: "coverage-ratchet-required", name: "Coverage ratchet", classExpr: "${{ steps.coverage-artifact.outputs.class }}" },
] as const;

function step(job: string, name: string): Step {
  const found = jobs[job]?.steps.find((s) => (s.name ?? "").startsWith(name));
  assert.ok(found?.run, `${job}: step "${name}" is missing`);
  return found;
}

/** Runs one step body as a pull_request with the class substituted; returns the fast-lane lines it
 *  printed to the log and to the step summary. */
function skipLines(job: string, name: string, classExpr: string, cls: string): { status: number | null; log: string[]; summary: string[] } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5844-`));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "node"), "#!/usr/bin/env bash\necho \"node reached: $*\" >&2\nexit 97\n");
    chmodSync(join(dir, "bin", "node"), 0o755);
    writeFileSync(join(dir, "step.sh"), step(job, name).run!.replaceAll(classExpr, cls));
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "step.sh")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GITHUB_EVENT_NAME: "pull_request", GITHUB_STEP_SUMMARY: join(dir, "summary.md") },
    });
    const summaryPath = join(dir, "summary.md");
    const fast = (text: string) => text.split("\n").filter((l) => l.includes("W1-T2428 fast-lane:"));
    return { status: r.status, log: fast(`${r.stdout}${r.stderr}`), summary: fast(existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T5844: every coverage skip line a NO_SRC or TEST_ONLY diff prints states no src/ path and never claims no test/ path", () => {
  for (const cls of ["NO_SRC", "TEST_ONLY"]) {
    for (const { job, name, classExpr } of COVERAGE_STEPS) {
      const r = skipLines(job, name, classExpr, cls);
      assert.equal(r.status, 0, `${cls} ${name}: the skip branch must exit 0 before node runs`);
      assert.equal(r.log.length, 1, `${cls} ${name}: one skip line in the log, got ${JSON.stringify(r.log)}`);
      assert.equal(r.summary.length, 1, `${cls} ${name}: one skip line in the step summary, got ${JSON.stringify(r.summary)}`);
      for (const line of [...r.log, ...r.summary]) {
        assert.ok(line.includes(`class=${cls}`), `${cls} ${name}: the line names its class: ${line}`);
        assert.ok(line.includes(NO_SRC_REASON), `${cls} ${name}: the line states no src/ path: ${line}`);
        assert.doesNotMatch(line, /test\/\*\*/, `${cls} ${name}: a ${cls} diff may hold test/ paths: ${line}`);
      }
    }
  }
});

test("W1-T5844: PLAN_ONLY and DOCS_ONLY keep the no src/ or test/ path wording, and the shadow-gardener prefix survives", () => {
  for (const cls of ["PLAN_ONLY", "DOCS_ONLY"]) {
    for (const name of ["Test with coverage", "Diff coverage"]) {
      const { job, classExpr } = COVERAGE_STEPS.find((s) => s.name === name)!;
      const r = skipLines(job, name, classExpr, cls);
      assert.equal(r.status, 0, `${cls} ${name}`);
      assert.ok(r.log[0]?.includes(PLAN_REASON), `${cls} ${name}: ${JSON.stringify(r.log)}`);
      assert.ok(r.summary[0]?.includes(PLAN_REASON), `${cls} ${name}: ${JSON.stringify(r.summary)}`);
    }
  }
  const tested = skipLines("coverage-ratchet", "Test with coverage", COVERAGE_STEPS[0].classExpr, "NO_SRC");
  assert.ok(tested.log[0]?.startsWith("W1-T2428 fast-lane: class=NO_SRC — skipping Test with coverage"), `selector-shadow-gardener matches this prefix: ${tested.log[0]}`);
});

/** The guard lines of each coverage step up to its skip branch's `fi`: everything but the text it
 *  prints and the class-to-reason selection. Captured from origin/main before this change. */
const GUARD_EXPECTATION: Record<string, string[]> = {
  "Test with coverage": [
    `[ "\${GITHUB_EVENT_NAME}" = "pull_request" ] || [ "\${GITHUB_EVENT_NAME}" = "merge_group" ] || { echo "W1-T1033: coverage-ratchet only runs its real work on pull_request/merge_group; skipping the real test-with-coverage run on a \${GITHUB_EVENT_NAME} event (see this job's own comment above)."; exit 0; }`,
    `CLASS="\${{ steps.classify.outputs.class }}"`,
    `if [ "$CLASS" != "SOURCE" ]; then`,
    `exit 0`,
    `fi`,
  ],
  "Diff coverage": [
    `[ "\${GITHUB_EVENT_NAME}" = "pull_request" ] || [ "\${GITHUB_EVENT_NAME}" = "merge_group" ] || { echo "W1-T1033: coverage-ratchet only runs its real work on pull_request/merge_group; skipping on a \${GITHUB_EVENT_NAME} event (no pr.diff was computed above)."; exit 0; }`,
    `CLASS="\${{ steps.coverage-artifact.outputs.class }}"`,
    `if [ "$CLASS" != "SOURCE" ]; then`,
    `exit 0`,
    `fi`,
  ],
  "Coverage ratchet": [
    `[ "\${GITHUB_EVENT_NAME}" = "pull_request" ] || [ "\${GITHUB_EVENT_NAME}" = "merge_group" ] || { echo "W1-T1033: coverage-ratchet only runs its real work on pull_request/merge_group; skipping on a \${GITHUB_EVENT_NAME} event (no coverage/lcov.info was collected above)."; exit 0; }`,
    `CLASS="\${{ steps.coverage-artifact.outputs.class }}"`,
    `if [ "$CLASS" != "SOURCE" ]; then`,
    `exit 0`,
    `fi`,
  ],
};

test("W1-T5844: the coverage steps' if: and skip-branch conditions are byte-unchanged", () => {
  for (const job of ["coverage-ratchet", "coverage-ratchet-required"]) {
    assert.deepEqual(jobs[job]!.steps.filter((s) => s.if !== undefined).map((s) => s.name), [], `${job}: no step carries an if:`);
  }
  for (const { job, name } of COVERAGE_STEPS) {
    const lines = step(job, name).run!.split("\n").map((l) => l.trim());
    const end = lines.indexOf("fi");
    assert.ok(end > 0, `${name}: the skip branch closes with fi`);
    const guards = lines
      .slice(0, end + 1)
      .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("echo ") && !/^case "\$CLASS" in .* WHY=/.test(l));
    assert.deepEqual(guards, GUARD_EXPECTATION[name], `${name}: only the printed text may change`);
  }
});
