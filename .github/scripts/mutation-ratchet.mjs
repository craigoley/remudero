#!/usr/bin/env -S npx tsx
// mutation-ratchet — the CI-facing CLI half of the mutation-testing gate
// (W1-T25). The DECISION logic (evaluateMutationRatchet,
// computeMutationScore) lives in src/lib/mutation-ratchet.ts, unit-tested
// over fixture scores (test/mutation-ratchet.test.ts) without needing a
// real (multi-hour, see mutation.yml) mutation run. This script owns the
// I/O: run Stryker (reads mutate scope + reporters from stryker.conf.mjs),
// read its JSON report, extract mutant statuses, call the pure functions,
// and translate the verdict into a process exit code.
//
// Stryker's own `thresholds.break` (stryker.conf.mjs, sourced from the same
// baseline file) is a SECOND, native enforcement of the same ratchet —
// belt-and-suspenders, not a conflict: this script's exit code and
// Stryker's own are combined below, so either one failing fails the job.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeMutationScore, evaluateMutationRatchet } from "../../src/lib/mutation-ratchet.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const baselinePath = fileURLToPath(new URL("../../.remudero/quality-baseline.json", import.meta.url));
const reportPath = fileURLToPath(new URL("../../reports/mutation/mutation.json", import.meta.url));

const baselineScore = JSON.parse(readFileSync(baselinePath, "utf8")).mutation.score;

const result = spawnSync("npx", ["stryker", "run"], { cwd: repoRoot, stdio: "inherit" });

if (result.error) {
  console.error("mutation-ratchet: failed to spawn stryker:", result.error);
  process.exit(1);
}

let statuses = [];
try {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  for (const file of Object.values(report.files ?? {})) {
    for (const mutant of file.mutants ?? []) {
      statuses.push(mutant.status);
    }
  }
} catch (err) {
  console.error(`\nmutation-ratchet: FAILED — could not read/parse ${reportPath}:`, err);
  process.exit(1);
}

const score = computeMutationScore(statuses);
const verdict = evaluateMutationRatchet(score, baselineScore);

console.log(
  `\nmutation-ratchet: measured score ${score === null ? "n/a" : `${score.toFixed(2)}%`} ` +
    `over ${statuses.length} mutant(s) (baseline: ${baselineScore === null ? "unset — bootstrap" : `${baselineScore}%`}).`,
);

if (!verdict.pass) {
  console.error(verdict.reasons.map((r) => `  - ${r}`).join("\n"));
}

// Combine this script's own verdict with Stryker's own exit code (its
// thresholds.break may fail the run for the same reason, or Stryker itself
// may have errored/timed out for an unrelated reason) — either is CI-red.
process.exit(verdict.pass && result.status === 0 ? 0 : 1);
