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

import { appendFileSync, readFileSync } from 'node:fs';
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
 *
 * `linesPct`/`branchesPct` ABSENT (undefined/null) is a legitimate, honest "no floor recorded"
 * contract and is left alone -- `branchesPct` in particular is no longer carried by the shipped
 * baseline at all now that branches gate on the absolute tiers in `classifyCoverageTier` instead.
 * Either field PRESENT but not a number (e.g. a hand-edit that quotes the value) is a DIFFERENT
 * thing: a declared floor that cannot be compared against. That must REFUSE, not silently no-op
 * -- same distinction scripts/claude-md-budget-ratchet.mjs's `evaluateRatchet` draws for
 * `capBytes`. This throws rather than returning a violation because it is a config defect, not a
 * coverage-floor breach; the caller is expected to catch it and fail the run before it prints
 * anything claiming to enforce a baseline.
 *
 * @returns {string[]} human-readable violations; empty means the ratchet is satisfied.
 * @throws {Error} if `linesPct` or `branchesPct` is present and not a number.
 */
export function evaluateRatchet(actual, baseline, epsilon = 1e-9) {
  const violations = [];
  if (
    baseline.linesPct !== undefined &&
    baseline.linesPct !== null &&
    typeof baseline.linesPct !== 'number'
  ) {
    throw new Error(`'linesPct' must be a number, got ${JSON.stringify(baseline.linesPct)}`);
  }
  if (typeof baseline.linesPct === 'number' && actual.linesPct < baseline.linesPct - epsilon) {
    const delta = actual.linesPct - baseline.linesPct;
    violations.push(
      `lines coverage ${actual.linesPct.toFixed(2)}% < baseline ${baseline.linesPct.toFixed(2)}% ` +
        `(delta ${delta.toFixed(2)}pts)`,
    );
  }
  if (
    baseline.branchesPct !== undefined &&
    baseline.branchesPct !== null &&
    typeof baseline.branchesPct !== 'number'
  ) {
    throw new Error(`'branchesPct' must be a number, got ${JSON.stringify(baseline.branchesPct)}`);
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

/**
 * TIER ONE OF THE ABSOLUTE-THRESHOLD GATE. Classify a run's BRANCH coverage against fixed cuts
 * instead of against a recorded baseline.
 *
 * WHY ABSOLUTE, AND WHY THIS CANNOT DRIFT. The delta form this replaces compared two whole-tree
 * scalars, and the scalar moves when the DENOMINATOR moves — `coverage-baseline.json`'s own
 * `_branchFloorCorrection` concedes it: "THE DRIVER IS THE DENOMINATOR … dropping them RAISES the
 * ratio." MEASURED across #1739: BRF +204, BRH +107, lines ROSE +2.102pt while branches fell, and
 * the CI readings either side are DISJOINT with a 0.470pt gap. 98% of the newly-uncovered branches
 * sit on UNCALLED FUNCTION DECLARATION LINES — real debt, always present, newly counted. An
 * absolute threshold is immune to all of that: 90% is 90% however many modules the suite loaded.
 * DO NOT REINTRODUCE A DELTA COMPARISON HERE.
 *
 * KEYED ON BRANCHES ALONE, DELIBERATELY. Lines measure ~98.3% and branches ~90.2%, so one pair of
 * cuts cannot mean the same thing to both. "Worse of the two" is equivalent to branches TODAY but
 * silently becomes a lines gate if branches ever overtake — a surprise waiting. Lines keep their
 * own separate floor (see `evaluateRatchet` above), unchanged and still enforced.
 *
 * ONLY `blocking` FAILS THE BUILD, AND THAT IS THE RULING, NOT A SOFTENING. The tiers are:
 *   >= 90  PASS.
 *   85-90  PASS, and (once tier two ships) inject ONE coverage-improvement task.
 *   < 85   remediation loop — tier three, not built.
 * Both upper tiers PASS, so 85 is the only blocking cut. THAT IS WHAT PUTS THE BOUNDARY CLEAR OF
 * THE NOISE. MEASURED from 16 post-regime CI readings: min 90.12, max 90.26, spread 0.140pt. A cut
 * at 90 would sit 0.120pt above the worst reading — INSIDE one spread, so an unlucky run would
 * block for no reason, recreating today's defect at a new number. At 85 the margin is ~5.1pt,
 * about 37x the spread. Hysteresis was considered and rejected: it would make the tier STATEFUL
 * across stateless CI runs, and moving the blocking cut achieves the same thing with no memory.
 * The 90 line is retained as a REPORTED tier boundary so tier two has its trigger already measured.
 *
 * @param {{branchesPct:number}} actual
 * @param {{tierPassPct?:number, tierBlockPct?:number}} thresholds
 */
export function classifyCoverageTier(actual, thresholds = {}) {
  const pass = typeof thresholds.tierPassPct === 'number' ? thresholds.tierPassPct : 90;
  const block = typeof thresholds.tierBlockPct === 'number' ? thresholds.tierBlockPct : 85;
  const pct = actual.branchesPct;
  if (pct < block) {
    return {
      tier: 'remediate',
      blocking: true,
      message:
        `branches ${pct.toFixed(2)}% is below the ${block}% floor — coverage remediation is required ` +
        `(tier three: loop targeted tasks until above ${pass}% or returns diminish)`,
    };
  }
  if (pct < pass) {
    return {
      tier: 'improve',
      blocking: false,
      message:
        `branches ${pct.toFixed(2)}% is between ${block}% and ${pass}% — PASS, and one ` +
        `coverage-improvement task is owed (tier two, not yet wired)`,
    };
  }
  return { tier: 'healthy', blocking: false, message: `branches ${pct.toFixed(2)}% is at or above ${pass}%` };
}

// ── SELF-DESCRIBING FAILURES (the check-run annotation channel) ──────────────
//
// WHY THIS EXISTS. A red run's uncovered-line list lived ONLY in the job log, and the log blob is
// unreachable from a diagnosing agent: `GET /actions/jobs/<id>/logs` 302s to
// `productionresultssa11.blob.core.windows.net`, which a proxied environment refuses (measured: the
// CONNECT tunnel returns 403), and the blob is ~12MB against execFileSync's 1MB default buffer.
// Meanwhile the check-run itself carried ONE annotation reading, in full, `Process completed with
// exit code 1.` -- so #2828 sat 13 hours and #2895 could not be diagnosed at all.
//
// THE CHANNEL IS THE ANNOTATION, NOT `output.summary`. A job cannot write `output.summary` (that
// field belongs to whoever created the check run -- Actions itself -- and is empty on every run
// here, measured). What a job CAN write with no extra token or permission is a workflow command,
// which GitHub turns into a check-run annotation readable at
// `GET /repos/<o>/<r>/check-runs/<id>/annotations` -- an endpoint that returns 200 through the same
// proxy that 403s the blob. `%0A` encoding keeps the whole list inside ONE annotation message.
// $GITHUB_STEP_SUMMARY is written too (same shape scripts/test-with-retry.mjs already uses) so the
// list is also on the run page for a human; that channel has no REST endpoint, so it is a
// convenience, never the fix.
//
// OPT-IN, AND DELIBERATELY NOT `GITHUB_ACTIONS`. This job runs the whole suite to produce its lcov,
// and test/{coverage-ratchet,diff-coverage}.test.ts spawn THIS script over BLOCKING fixtures with
// no `env` override -- so a `GITHUB_ACTIONS`-gated emit would publish fixture failures as real
// annotations and make this instrument untrustworthy exactly where it is meant to be trusted.
// `RMD_CI_REPORT` is set per-STEP on the two gate steps in ci.yml (never job-wide, which would
// reach the test step too), so only a real gate invocation reports.

/** Render a blocked/clean report as one plain-text block. Pure: no env, no I/O. */
export function formatCiReport(tool, headline, details, { cap = 100 } = {}) {
  const shown = details.slice(0, cap);
  const lines = [`${tool}: ${headline}`, ...shown.map((d) => `  - ${d}`)];
  // NO SILENT CAPS (the same rule the exempt-line printing below follows): if the list is trimmed,
  // the report says so and names the cap, so a truncated read is never mistaken for a short list.
  if (details.length > shown.length) {
    lines.push(`  ... ${details.length - shown.length} more not listed (cap ${cap})`);
  }
  return lines.join('\n');
}

/** Encode a report for a `::error::` workflow command. `%` FIRST or the escapes eat each other. */
export function encodeAnnotation(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Write the report to the two channels a job can actually reach. No-op unless RMD_CI_REPORT is set. */
export function emitCiReport(tool, report, { blocked, env = process.env, log = console.log, append = null } = {}) {
  if (!env.RMD_CI_REPORT) return false;
  if (blocked) log(`::error title=${tool}::${encodeAnnotation(report)}`);
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const write = append ?? appendFileSync;
    write(summaryPath, `### ${tool}\n\n\u0060\u0060\u0060\n${report}\n\u0060\u0060\u0060\n\n`);
  }
  return true;
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

  let violations;
  try {
    violations = evaluateRatchet(actual, baseline);
  } catch (err) {
    // Refuse before printing anything about a baseline -- a run that cannot determine its
    // threshold must never print "baseline <n>%" as if it were enforcing one.
    console.error(`coverage-ratchet: ${values.baseline}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    // BRANCHES REPORT THEIR TIER CUTS, NEVER A "baseline". `branchesPct` is GONE from the real
    // baseline file, so the old `(baseline ${x ?? 0})` form would print `(baseline 0.00%)` on every
    // CI run and read as a 0% floor — the misleading-zero shape this repo keeps paying for. Lines
    // keep the old wording because lines keep a real recorded baseline. The harvestable prefix
    // (`lines X% ... branches Y%`) is unchanged so the CI-log harvest that measured the 0.140pt
    // spread still parses.
    `coverage-ratchet: lines ${actual.linesPct.toFixed(2)}% (baseline ${(baseline.linesPct ?? 0).toFixed(2)}%), ` +
      `branches ${actual.branchesPct.toFixed(2)}% (pass ${baseline.tierPassPct ?? 90}% / block ${baseline.tierBlockPct ?? 85}%)` +
      (actual.skippedRecords > 0
        ? ` [excluded ${actual.skippedRecords} out-of-repo record(s) from temp-dir child coverage]`
        : ''),
  );

  const tier = classifyCoverageTier(actual, baseline);
  console.log(`coverage-ratchet: tier=${tier.tier} — ${tier.message}`);

  // BOTH GATES REPORT, NEITHER PRE-EMPTS. An earlier draft returned as soon as the tier blocked,
  // which SUPPRESSED the line-baseline violation: a change dropping lines AND branches was told
  // only about branches, and would fix one, re-push, and discover the other. Collect and print
  // every reason, then exit once.
  const blockers = [...(tier.blocking ? [tier.message] : []), ...violations];

  if (blockers.length > 0) {
    const headline = 'BLOCKED -- coverage is below a floor:';
    console.error(`coverage-ratchet: ${headline}`);
    for (const b of blockers) console.error(`  - ${b}`);
    emitCiReport('coverage-ratchet', formatCiReport('coverage-ratchet', headline, blockers), { blocked: true });
    process.exitCode = 1;
    return;
  }

  console.log('coverage-ratchet: OK -- at or above baseline.');
  emitCiReport('coverage-ratchet', formatCiReport('coverage-ratchet', 'OK -- at or above baseline.', []), {
    blocked: false,
  });
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/coverage-ratchet.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
