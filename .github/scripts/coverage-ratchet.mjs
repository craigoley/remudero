#!/usr/bin/env -S npx tsx
// coverage-ratchet — the CI-facing CLI half of the coverage gate (W1-T25).
// The DECISION logic (evaluateCoverageRatchet, parseCoverageSummary) lives
// in src/lib/coverage-ratchet.ts, where it is unit-tested over fixture data
// (test/coverage-ratchet.test.ts) independent of ever running the real
// suite. This script owns the I/O the pure functions deliberately don't:
// run the real suite with coverage, parse its summary, load the baseline,
// call the pure functions, and translate the verdict into a process exit
// code CI can gate on.
//
// Run via tsx (see package.json "test:coverage") so it can import the
// TypeScript source directly — same pattern as "lint-plan" (tsx
// src/run-task.ts lint-plan), no separate build step for a CI-only script.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateCoverageRatchet, parseCoverageSummary } from "../../src/lib/coverage-ratchet.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const baselinePath = fileURLToPath(new URL("../../.remudero/quality-baseline.json", import.meta.url));

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")).coverage;

const result = spawnSync(
  process.execPath,
  ["--test", "--experimental-test-coverage", "--import", "tsx", "test/**/*.test.ts"],
  { cwd: repoRoot, encoding: "utf8" },
);

// Always echo the real suite's own output (pass/fail, per-file coverage
// table) so a human reading CI logs sees exactly what ran — this script
// never swallows that in favor of just its own verdict line.
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");

if (result.error) {
  console.error("coverage-ratchet: failed to spawn node --test:", result.error);
  process.exit(1);
}

if (result.status !== 0) {
  console.error("\ncoverage-ratchet: FAILED — the suite itself failed (see output above); coverage was not evaluated.");
  process.exit(result.status ?? 1);
}

const measured = parseCoverageSummary(result.stdout ?? "");
if (!measured) {
  console.error("\ncoverage-ratchet: FAILED — could not find the 'all files' coverage summary row in node --test's output.");
  process.exit(1);
}

const verdict = evaluateCoverageRatchet(measured, baseline);
if (!verdict.pass) {
  console.error(
    `\ncoverage-ratchet: FAILED — coverage dropped below the ratcheted floor (.remudero/quality-baseline.json):\n` +
      verdict.reasons.map((r) => `  - ${r}`).join("\n") +
      `\nA coverage-lowering PR is CI-red by design.`,
  );
  process.exit(1);
}

console.log(
  `\ncoverage-ratchet: PASSED — lines ${measured.lines}%>=${baseline.lines}%, ` +
    `branches ${measured.branches}%>=${baseline.branches}%, functions ${measured.functions}%>=${baseline.functions}%.`,
);
