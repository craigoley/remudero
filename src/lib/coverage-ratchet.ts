/**
 * Coverage ratchet — PURE decision logic (W1-T25, MASTER-PLAN §5 TIER 2
 * "Coverage ratchet — never down; ratchets up. A coverage-lowering PR is
 * CI-red. Baseline captured at onboarding so the ratchet has a floor.").
 *
 * `evaluateCoverageRatchet()` takes already-measured coverage numbers and a
 * baseline as INPUTS and returns a verdict — it makes no live calls (no
 * spawning `node --test`, no reading a baseline file off disk) and is never
 * interactive, so it is unit-testable over FIXTURE data (below/at/above the
 * baseline) without needing to run the real suite. The caller
 * (.github/scripts/coverage-ratchet.mjs) owns the I/O: run the real suite
 * with coverage, parse its summary line, load the baseline file, then call
 * this.
 *
 * `parseCoverageSummary()` is the other pure half: it extracts the "all
 * files" totals row Node's `--test --experimental-test-coverage` text
 * reporter prints, e.g.:
 *
 *   # all files                          |  93.75 |    91.77 |   92.03 |
 *
 * DELIBERATELY NOT using Node's own `--test-coverage-lines/-branches/
 * -functions` threshold flags to gate: verified empirically (distrust the
 * assumed spelling/behavior of an installed flag, Standing rule 7) that
 * those flags only compare at WHOLE-PERCENT granularity — a threshold of
 * 93.76 against an actual measured 93.75% still PASSED, and so did every
 * other non-integer threshold below 94. Parsing the real percentage
 * ourselves and comparing here gets full floating-point precision instead
 * of being silently truncated to whole points.
 */

export interface CoverageMetrics {
  lines: number;
  branches: number;
  functions: number;
}

export interface RatchetVerdict {
  pass: boolean;
  reasons: string[];
}

const METRIC_KEYS = ["lines", "branches", "functions"] as const;

/**
 * A coverage-lowering PR is CI-red: `pass` is false if ANY metric measured
 * is strictly below the corresponding baseline floor. Equal-to-baseline
 * passes (the floor is inclusive, not exclusive) — a baseline captured from
 * a real measurement must itself pass against that same baseline.
 */
export function evaluateCoverageRatchet(measured: CoverageMetrics, baseline: CoverageMetrics): RatchetVerdict {
  const reasons: string[] = [];
  for (const key of METRIC_KEYS) {
    if (measured[key] < baseline[key]) {
      reasons.push(`${key} coverage ${measured[key]}% is below the ratcheted floor of ${baseline[key]}%`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

const SUMMARY_ROW_RE = /^#?\s*all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/m;

/**
 * Parses the "all files" totals row out of Node's `--experimental-test-
 * coverage` text-reporter output. Returns null if the row is absent (e.g.
 * the coverage flag was not passed, or the reporter format changes) —
 * NEVER fabricates a metric it did not find, so a parse miss surfaces as an
 * explicit failure at the call site rather than a silently-wrong pass.
 */
export function parseCoverageSummary(output: string): CoverageMetrics | null {
  const match = SUMMARY_ROW_RE.exec(output);
  if (!match) return null;
  return { lines: Number(match[1]), branches: Number(match[2]), functions: Number(match[3]) };
}
