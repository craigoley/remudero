#!/usr/bin/env node
// scripts/mutation-ratchet.mjs
//
// Mutation-testing ratchet gate (W1-T96, MASTER-PLAN §5 TIER 2, quality gate 2/4).
//
// Green tests that kill no mutants are theater -- a mutation score is the falsifier: it proves
// the test suite actually NOTICES when the source is deliberately broken. This script parses a
// Stryker JSON report (mutation-testing-report-schema, `reports/mutation/mutation.json` by
// default) and computes the overall mutation score (killed + timeout mutants, over all VALID
// mutants -- killed + timeout + survived + noCoverage; CompileError/RuntimeError/Ignored mutants
// are excluded from the denominator, matching Stryker's own scoring convention), then compares it
// against the recorded baseline (scripts/mutation-baseline.json by default). A run scoring BELOW
// the baseline is a test-suite-weakening change -- this script exits non-zero. A run AT or ABOVE
// baseline exits zero.
//
// Usage:
//   node scripts/mutation-ratchet.mjs [--report <path>] [--baseline <path>]
//
// Defaults: --report reports/mutation/mutation.json, --baseline scripts/mutation-baseline.json
//
// The pure functions below (parseMutationTotals, evaluateRatchet) are exported so the falsifier
// fixture test can exercise the CLI process directly (spawn + exit code) as well as the
// parsing/comparison logic in isolation.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/**
 * Sum mutant statuses across every file in a Stryker JSON report and derive the overall
 * mutation score. Statuses: Killed, Timeout (both count as "caught"); Survived, NoCoverage
 * (both count as valid-but-uncaught); CompileError/RuntimeError/Ignored are excluded from the
 * denominator entirely (matching Stryker's own scoring convention -- they are not a statement
 * about test-suite quality).
 * @param {{files?: Record<string, {mutants?: Array<{status?: string}>}>}} report
 */
export function parseMutationTotals(report) {
  let killed = 0;
  let timeout = 0;
  let survived = 0;
  let noCoverage = 0;
  const files = report.files ?? {};
  for (const filePath of Object.keys(files)) {
    const mutants = files[filePath].mutants ?? [];
    for (const mutant of mutants) {
      switch (mutant.status) {
        case 'Killed':
          killed += 1;
          break;
        case 'Timeout':
          timeout += 1;
          break;
        case 'Survived':
          survived += 1;
          break;
        case 'NoCoverage':
          noCoverage += 1;
          break;
        default:
          // CompileError / RuntimeError / Ignored -- not a valid mutant, excluded.
          break;
      }
    }
  }
  const validTotal = killed + timeout + survived + noCoverage;
  return {
    scorePct: validTotal > 0 ? (100 * (killed + timeout)) / validTotal : 100,
    killed,
    timeout,
    survived,
    noCoverage,
    validTotal,
  };
}

/**
 * Compare an actual mutation score against a recorded baseline.
 * @returns {string[]} human-readable violations; empty means the ratchet is satisfied.
 */
export function evaluateRatchet(actual, baseline, epsilon = 1e-9) {
  const violations = [];
  if (typeof baseline.scorePct === 'number' && actual.scorePct < baseline.scorePct - epsilon) {
    violations.push(
      `mutation score ${actual.scorePct.toFixed(2)}% < baseline ${baseline.scorePct.toFixed(2)}%`,
    );
  }
  return violations;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: 'string', default: 'reports/mutation/mutation.json' },
      baseline: { type: 'string', default: 'scripts/mutation-baseline.json' },
    },
  });

  const report = JSON.parse(readFileSync(values.report, 'utf8'));
  const baseline = JSON.parse(readFileSync(values.baseline, 'utf8'));
  const actual = parseMutationTotals(report);
  const violations = evaluateRatchet(actual, baseline);

  console.log(
    `mutation-ratchet: score ${actual.scorePct.toFixed(2)}% (baseline ${(baseline.scorePct ?? 0).toFixed(2)}%) -- ` +
      `${actual.killed} killed, ${actual.timeout} timeout, ${actual.survived} survived, ${actual.noCoverage} no-coverage`,
  );

  if (violations.length > 0) {
    console.error('mutation-ratchet: BLOCKED -- mutation score dropped below the recorded baseline:');
    for (const v of violations) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }

  console.log('mutation-ratchet: OK -- at or above baseline.');
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/mutation-ratchet.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
