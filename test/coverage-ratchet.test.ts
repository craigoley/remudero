import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCoverageRatchet, parseCoverageSummary } from "../src/lib/coverage-ratchet.js";

const BASELINE = { lines: 93, branches: 91, functions: 92 };

// W1-T25 acceptance: "the coverage ratchet BLOCKS a coverage-lowering change
// — its gate script exits non-zero below the recorded baseline." Fixture
// data BELOW the baseline must fail; AT/above must pass — the falsifier
// proves the gate is ACTIVE, not merely present.

test("evaluateCoverageRatchet: FAILS when a metric is below the baseline (the falsifier — a coverage-lowering PR)", () => {
  const v = evaluateCoverageRatchet({ lines: 92, branches: 91, functions: 92 }, BASELINE);
  assert.equal(v.pass, false);
  assert.equal(v.reasons.length, 1);
  assert.match(v.reasons[0], /lines coverage 92% is below the ratcheted floor of 93%/);
});

test("evaluateCoverageRatchet: FAILS and reports EVERY metric below baseline, not just the first", () => {
  const v = evaluateCoverageRatchet({ lines: 80, branches: 80, functions: 80 }, BASELINE);
  assert.equal(v.pass, false);
  assert.equal(v.reasons.length, 3);
});

test("evaluateCoverageRatchet: PASSES when every metric is exactly AT the baseline (the floor is inclusive)", () => {
  const v = evaluateCoverageRatchet(BASELINE, BASELINE);
  assert.equal(v.pass, true);
  assert.deepEqual(v.reasons, []);
});

test("evaluateCoverageRatchet: PASSES when every metric is ABOVE the baseline", () => {
  const v = evaluateCoverageRatchet({ lines: 99, branches: 99, functions: 99 }, BASELINE);
  assert.equal(v.pass, true);
  assert.deepEqual(v.reasons, []);
});

test("parseCoverageSummary: extracts the 'all files' totals row from Node's text-coverage-reporter output", () => {
  const output = [
    "# start of coverage report",
    "# file            | line % | branch % | funcs % | uncovered lines",
    "# ---------------------------------------------------------------",
    "#  foo.ts                            |  95.00 |    88.00 |   90.00 | 12-14",
    "# ------------------------------------------------------------------------------------------------",
    "# all files                          |  93.75 |    91.77 |   92.03 | ",
    "# ------------------------------------------------------------------------------------------------",
    "# end of coverage report",
  ].join("\n");
  const parsed = parseCoverageSummary(output);
  assert.deepEqual(parsed, { lines: 93.75, branches: 91.77, functions: 92.03 });
});

test("parseCoverageSummary: returns null (never fabricates a metric) when the summary row is absent", () => {
  assert.equal(parseCoverageSummary("no coverage report here"), null);
});
