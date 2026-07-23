#!/usr/bin/env node
// scripts/coverage-ratchet.mjs
//
// Coverage ratchet gate (W1-T25, MASTER-PLAN §5 TIER 2, quality gate 1/4).
//
// Coverage % is not proof tests are real, but it is a floor that must never go DOWN. This
// script parses an lcov report (`node --experimental-test-coverage --test-reporter=lcov`),
// sums LF/LH (lines found/hit) and BRF/BRH (branches found/hit) across every source-file
// record to compute the run's overall line + branch coverage percentage, and compares it
// against the recorded baseline (scripts/coverage-baseline.json by default). A run scoring
// BELOW the baseline on either metric is a coverage-lowering change -- this script exits
// non-zero. A run AT or ABOVE baseline on both metrics exits zero.
//
// Usage:
//   node scripts/coverage-ratchet.mjs [--lcov <path>] [--baseline <path>]
//
// Defaults: --lcov coverage/lcov.info, --baseline scripts/coverage-baseline.json
//
// The pure functions below (parseLcovTotals, evaluateRatchet) are exported so the falsifier
// fixture test can exercise the CLI process directly (spawn + exit code) as well as the
// parsing/comparison logic in isolation.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/**
 * Sum LF/LH/BRF/BRH across every record in an lcov report and derive overall percentages.
 * @param {string} lcovText
 */
export function parseLcovTotals(lcovText) {
  let lf = 0;
  let lh = 0;
  let brf = 0;
  let brh = 0;
  let skippedRecords = 0;
  // W1-T220: a coverage record is counted only when its source file lives INSIDE
  // the repo checkout. A record whose `SF:` path escapes the checkout (starts with
  // `../` or is absolute) is child-process coverage from a temp copy: several tests
  // `mkdtemp` a dir, copy a repo script into it, and spawn node -- and because
  // `NODE_V8_COVERAGE` is inherited by children, those low-coverage temp copies
  // merge into the aggregate lcov under randomized `/private/var/folders/.../T/rmd-*`
  // paths. Their count varies run-to-run (which fixtures ran, whether each child
  // flushed before exit), which flaked the aggregate branch percentage by a few
  // hundredths of a point and false-blocked test-only/plan-only PRs. Only the
  // repo's own `src/**` should gate.
  let inRepo = true;
  for (const line of lcovText.split('\n')) {
    if (line.startsWith('SF:')) {
      const path = line.slice(3).trim();
      inRepo = !(path.startsWith('../') || path.startsWith('/'));
      if (!inRepo) skippedRecords += 1;
      continue;
    }
    if (!inRepo) continue;
    if (line.startsWith('LF:')) lf += Number(line.slice(3));
    else if (line.startsWith('LH:')) lh += Number(line.slice(3));
    else if (line.startsWith('BRF:')) brf += Number(line.slice(4));
    else if (line.startsWith('BRH:')) brh += Number(line.slice(4));
  }
  return {
    linesPct: lf > 0 ? (100 * lh) / lf : 100,
    branchesPct: brf > 0 ? (100 * brh) / brf : 100,
    lf,
    lh,
    brf,
    brh,
    skippedRecords,
  };
}

/**
 * Compare actual coverage totals against a recorded baseline.
 * @returns {string[]} human-readable violations; empty means the ratchet is satisfied.
 */
export function evaluateRatchet(actual, baseline, epsilon = 1e-9) {
  const violations = [];
  if (typeof baseline.linesPct === 'number' && actual.linesPct < baseline.linesPct - epsilon) {
    const delta = actual.linesPct - baseline.linesPct;
    violations.push(
      `lines coverage ${actual.linesPct.toFixed(2)}% < baseline ${baseline.linesPct.toFixed(2)}% ` +
        `(delta ${delta.toFixed(2)}pts)`,
    );
  }
  if (
    typeof baseline.branchesPct === 'number' &&
    actual.branchesPct < baseline.branchesPct - epsilon
  ) {
    const delta = actual.branchesPct - baseline.branchesPct;
    violations.push(
      `branches coverage ${actual.branchesPct.toFixed(2)}% < baseline ${baseline.branchesPct.toFixed(2)}% ` +
        `(delta ${delta.toFixed(2)}pts)`,
    );
  }
  return violations;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      lcov: { type: 'string', default: 'coverage/lcov.info' },
      baseline: { type: 'string', default: 'scripts/coverage-baseline.json' },
    },
  });

  const lcovText = readFileSync(values.lcov, 'utf8');
  const baseline = JSON.parse(readFileSync(values.baseline, 'utf8'));
  const actual = parseLcovTotals(lcovText);
  const violations = evaluateRatchet(actual, baseline);

  console.log(
    `coverage-ratchet: lines ${actual.linesPct.toFixed(2)}% (baseline ${(baseline.linesPct ?? 0).toFixed(2)}%), ` +
      `branches ${actual.branchesPct.toFixed(2)}% (baseline ${(baseline.branchesPct ?? 0).toFixed(2)}%)` +
      (actual.skippedRecords > 0
        ? ` [excluded ${actual.skippedRecords} out-of-repo record(s) from temp-dir child coverage]`
        : ''),
  );

  if (violations.length > 0) {
    console.error('coverage-ratchet: BLOCKED -- coverage dropped below the recorded baseline:');
    for (const v of violations) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }

  console.log('coverage-ratchet: OK -- at or above baseline.');
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/coverage-ratchet.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
