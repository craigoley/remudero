import assert from "node:assert/strict";
import { test } from "node:test";
import type { AffectedSelection } from "../src/lib/affected-suites.js";
import { coveragePrecheck, PREFLIGHT_SCOPED_COVERAGE_SUITE_CEILING, type CoveragePrecheckPorts } from "../src/run-task.js";

// MEASURED 2026-10-01: W1-T4772's push precheck ran CI's instrumented suite over 1839 files for 42 minutes inside
// the daemon process (a synchronous spawn), freezing every sweep, tick and ledger write, and the run's push then
// failed on an expired token. A precheck whose scope exceeds preflight's own scoped-coverage ceiling is skipped as
// unavailable, so the push proceeds exactly as the precheck already does for every other way it cannot look quickly.

const suites = (n: number) => Array.from({ length: n }, (_, i) => `test/s${i}.test.ts`);

function ports(n: number, calls: string[][]): CoveragePrecheckPorts {
  const selection: AffectedSelection = { suites: suites(n), fullRun: false, reasons: [], recentOnly: { floor: [] } };
  return {
    changedFiles: () => ["src/lib/widely-imported.ts"],
    select: () => selection,
    manifest: () => ({ thresholdMs: 5000, files: {} }),
    run: (_wt, s) => {
      calls.push(s);
      return { status: 0, output: "", timedOut: false };
    },
  };
}

test("a coverage precheck wider than the preflight scoped ceiling is skipped as unavailable without spawning", async () => {
  const calls: string[][] = [];
  const result = await coveragePrecheck("/w", ports(PREFLIGHT_SCOPED_COVERAGE_SUITE_CEILING + 1, calls));
  assert.equal(result.outcome, "unavailable");
  assert.match((result as { reason: string }).reason, /too wide to precheck quickly/);
  assert.equal(calls.length, 0, "no instrumented run is spawned");
});

test("a coverage precheck within the preflight scoped ceiling still runs", async () => {
  const calls: string[][] = [];
  const result = await coveragePrecheck("/w", ports(PREFLIGHT_SCOPED_COVERAGE_SUITE_CEILING, calls));
  assert.equal(result.outcome, "covered");
  assert.equal(calls.length, 1);
});
