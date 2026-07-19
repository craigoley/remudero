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
// Usage (ratchet mode -- compares a completed Stryker run against the baseline):
//   node scripts/mutation-ratchet.mjs [--report <path>] [--baseline <path>]
//
// Defaults: --report reports/mutation/mutation.json, --baseline scripts/mutation-baseline.json
//
// Usage (path-filter mode -- W1-T108, MASTER-PLAN §5C/§5A, decides whether the CI job needs to
// run Stryker at all for THIS diff):
//   node scripts/mutation-ratchet.mjs --changed-files <path> [--relevant-paths <json-file>]
//
// `--changed-files` points at a newline-delimited list of this PR's changed paths (e.g. the
// output of `git diff --name-only <base>...HEAD`). This mode NEVER reads --report/--baseline
// and NEVER shells out to Stryker -- it only decides and prints a reason, then exits 0
// regardless of the decision (a "skip" verdict is not a failure; it means this diff cannot
// possibly move src/lib/classify.ts's mutation score, so there is nothing to falsify). The
// caller (ci.yml's mutation-ratchet job) reads the `matched` $GITHUB_OUTPUT this mode writes and
// gates the actual `npx stryker run` step on it -- same always-registers-but-internally-scoped
// shape as `containment-probe` (see ci.yml). The paths list itself is DATA:
// scripts/mutation-relevant-paths.json, a plain JSON array read by loadRelevantPaths() -- not a
// literal embedded in this script. `--relevant-paths <json-file>` optionally points path-filter
// mode at a DIFFERENT json file instead of the production default, purely so a test can prove the
// filter is driven by that external data (swap in a seeded list, decision flips) without touching
// this script's logic OR the production data file; CI itself never passes it.
//
// The pure functions below (parseMutationTotals, evaluateRatchet, evaluatePathFilter) are
// exported so the falsifier fixture test can exercise the CLI process directly (spawn + exit
// code) as well as the parsing/comparison logic in isolation.

import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// DATA, not control flow, and not even embedded in THIS script (W1-T108): the exhaustive set of
// paths that can move src/lib/classify.ts's mutation score -- the mutated file itself, its test,
// and this gate's own machinery (Stryker config, this script, the recorded baseline) -- lives in
// scripts/mutation-relevant-paths.json, a plain JSON array, not a JS literal in this file. That
// means "adding a path row" is purely a data-file edit: zero changes to this script, zero changes
// to evaluatePathFilter's logic, and (unlike an array literal embedded here) it is not even
// possible to conflate "editing the paths list" with "editing the script" -- they are different
// files. Kept in sync BY HAND with stryker.conf.json's `mutate` glob; widening that glob later
// means widening this JSON array too (the "one-line glob change" the ci.yml mutation-ratchet
// comment already calls out).
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RELEVANT_PATHS_FILE = join(__dirname, 'mutation-relevant-paths.json');

/** Read the paths-list JSON data file at the given path (default: the real production list). */
export function loadRelevantPaths(filePath = DEFAULT_RELEVANT_PATHS_FILE) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

// The production list, read once at import time from the JSON data file above. Exported (as
// before) so a test can prove the default itself is sourced from data; --relevant-paths lets a
// test point at an isolated seeded fixture COPY instead, without ever touching this file or
// scripts/mutation-relevant-paths.json.
export const MUTATION_RELEVANT_PATHS = loadRelevantPaths();

/**
 * Decide whether a diff's changed files can move src/lib/classify.ts's mutation score.
 * @param {readonly string[]} changedFiles
 * @param {readonly string[]} relevantPaths
 * @returns {{run: boolean, reason: string}}
 */
export function evaluatePathFilter(changedFiles, relevantPaths = MUTATION_RELEVANT_PATHS) {
  const relevant = new Set(relevantPaths);
  const matchedPath = changedFiles.find((path) => relevant.has(path));
  if (matchedPath !== undefined) {
    return { run: true, reason: `diff touches ${matchedPath}` };
  }
  return {
    run: false,
    reason: "no changed path can move src/lib/classify.ts's mutation score",
  };
}

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
      'changed-files': { type: 'string' },
      'relevant-paths': { type: 'string' },
    },
  });

  // Path-filter mode (W1-T108): decide, print, write $GITHUB_OUTPUT, exit 0 -- never touches
  // --report/--baseline, never shells out to Stryker, in EITHER branch. See the usage comment
  // at the top of this file.
  if (values['changed-files'] !== undefined) {
    const changedFiles = readFileSync(values['changed-files'], 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const relevantPaths = values['relevant-paths']
      ? loadRelevantPaths(values['relevant-paths'])
      : MUTATION_RELEVANT_PATHS;
    const { run, reason } = evaluatePathFilter(changedFiles, relevantPaths);

    if (run) {
      console.log(`mutation-ratchet: REQUIRED -- ${reason}`);
    } else {
      console.log(`mutation-ratchet: skip -- ${reason}`);
    }

    const out = process.env.GITHUB_OUTPUT;
    if (out) {
      appendFileSync(out, `matched=${run}\n`);
    }

    process.exitCode = 0;
    return;
  }

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
