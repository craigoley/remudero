import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore executable census module has no declaration file.
import { affectedReachBaselinePatch, measureAffectedReach, reportAffectedReachExactBaseline } from "#scripts/census-precheck.mjs";

/**
 * W1-T10191: fix_refusal:census-precheck cost 19.2 PR-minute(s) across 10 round(s) on 9 PRs. Two of the
 * cited rounds (#12700, #12830) were test/the-affected-suite-reach-ratchet.test.ts refusing a push whose
 * reach genuinely grew, but the refusal names only the grown metrics and the new importer names — never the
 * exact scripts/affected-reach-baseline.json replacement — so a dev had to hand-derive the three metrics
 * and the sorted importers array, costing a second round when the hand-derived patch missed. This proves the
 * remedy: census-precheck now computes the SAME measurement the ratchet test takes and can print the exact
 * baseline patch in the SAME round the refusal is seen, so the cause is prevented rather than retried.
 */

const FIXTURE = new Map([
  ["src/run-task.ts", 'export { a } from "#test/ci/gates/a.js";'],
  ["src/a.ts", "export const a = 1;"],
  ["src/isolated.ts", "export {};"],
  ["test/old.test.ts", 'import "#test/ci/src/run-task.js";'],
  ["test/isolated.test.ts", 'import "#test/ci/src/isolated.js";'],
]);

test("W1-T10191: fix_refusal:census-precheck is prevented, not retried", () => {
  const baseline = measureAffectedReach(FIXTURE);
  assert.deepEqual(baseline, { importerCount: 1, largestScc: 1, medianReachPercent: 50, importers: ["test/old.test.ts"] });

  // A new test genuinely growing the reach — the exact shape of #12700 and #12830's refusal.
  const grown = new Map(FIXTURE).set("test/new.test.ts", 'import "#test/ci/src/run-task.js";');
  const measured = measureAffectedReach(grown);
  assert.ok(measured.importerCount > baseline.importerCount, "the fixture must reproduce genuine growth");

  const recorded = { _comment: "measured ceiling", ...baseline };
  const patch = affectedReachBaselinePatch(measured, recorded);
  const parsed = JSON.parse(patch);

  // The printed patch is the EXACT replacement: applying it in the SAME round the dev saw the refusal in
  // leaves nothing left to hand-derive — every metric and the full importers list is already correct.
  assert.equal(parsed._comment, "measured ceiling", "the patch preserves fields the recorded baseline already carries");
  assert.equal(parsed.importerCount, measured.importerCount);
  assert.equal(parsed.largestScc, measured.largestScc);
  assert.equal(parsed.medianReachPercent, measured.medianReachPercent);
  assert.deepEqual(parsed.importers, measured.importers);

  // Re-measuring against the patched baseline refuses nothing: the round that would have been needed to
  // discover a wrong hand-derived patch never happens.
  const reVerdictMetrics = (["importerCount", "largestScc", "medianReachPercent"] as const)
    .filter((metric) => measured[metric as keyof typeof measured] > parsed[metric]);
  assert.deepEqual(reVerdictMetrics, [], "the exact patch must leave no metric still refused");

  // A failure to measure (or to write the patch) must never be fatal — it is best-effort, reported as text.
  const lines: string[] = [];
  reportAffectedReachExactBaseline("/this/path/does/not/exist", (line: string) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.startsWith("census-precheck: affected-reach exact baseline NOT PRINTED - "),
    "an unmeasurable root must report a diagnostic line, never throw");
});
