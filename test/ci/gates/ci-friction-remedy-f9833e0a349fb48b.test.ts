import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore executable census module has no declaration file.
import { affectedReachBaselinePatch, affectedReachGrowth,measureAffectedReach, reportAffectedReachExactBaseline } from "#scripts/census-precheck.mjs";

/**
 * W1-T10191: fix_refusal:census-precheck cost 19.2 PR-minute(s) across 10 round(s) on 9 PRs. Two of the
 * cited rounds (#12700, #12830) were test/the-affected-suite-reach-ratchet.test.ts refusing a push whose
 * reach genuinely grew, but the refusal names only the grown metrics and the new importer names — never the
 * exact scripts/affected-reach-baseline.json replacement — so a dev had to hand-derive the three metrics
 * and the sorted importers array, costing a second round when the hand-derived patch missed. This proves the
 * remedy: census-precheck now computes the SAME measurement the ratchet test takes and can print the exact
 * baseline patch in the SAME round the refusal is seen, so the cause is prevented rather than retried.
 */

// Resolve these imports inside the virtual tree, without making them imports of this suite.
const fixtureImport = (specifier: string) => ["import", JSON.stringify(specifier) + ";"].join(" ");
const FIXTURE = new Map([
  ["src/run-task.ts", ["export { a } from", JSON.stringify("./a.js") + ";"].join(" ")],
  ["src/a.ts", "export const a = 1;"],
  ["src/isolated.ts", "export {};"],
  ["test/old.test.ts", fixtureImport("../src/run-task.js")],
  ["test/isolated.test.ts", fixtureImport("../src/isolated.js")],
]);

test("W1-T10191: fix_refusal:census-precheck is prevented, not retried", () => {
  const baseline = measureAffectedReach(FIXTURE);
  assert.deepEqual(baseline, { importerCount: 1, largestScc: 1, medianReachPercent: 50, importers: ["test/old.test.ts"] });

  // A new test genuinely growing the reach — the exact shape of #12700 and #12830's refusal.
  const grown = new Map(FIXTURE).set("test/new.test.ts", fixtureImport("../src/run-task.js"));
  const measured = measureAffectedReach(grown);
  assert.deepEqual(measured.importers, ["test/new.test.ts", "test/old.test.ts"]);
  assert.ok(measured.importerCount > baseline.importerCount, "the fixture must reproduce genuine growth");

  const recorded = { _comment: "measured ceiling", ...baseline };
  const parsed = JSON.parse(affectedReachBaselinePatch(measured, recorded));

  // The baseline is shrink-only against origin/main: a patch for GROWTH must never raise a ceiling.
  assert.equal(parsed._comment, "measured ceiling", "the patch preserves fields the recorded baseline already carries");
  for (const metric of ["importerCount", "largestScc", "medianReachPercent"] as const) {
    assert.ok(parsed[metric] <= recorded[metric], `${metric} must not exceed the previous ceiling`);
  }
  assert.deepEqual(parsed.importers, recorded.importers, "growth's new importer is not recorded");
  assert.deepEqual(affectedReachGrowth(measured, recorded), ["importerCount"], "the growth is named for removal");

  // A genuine shrink does move the ceiling down, to exactly the measured values.
  const shrunkMeasured = measureAffectedReach(new Map(FIXTURE).set("test/old.test.ts", "export {};"));
  const shrunk = JSON.parse(affectedReachBaselinePatch(shrunkMeasured, recorded));
  assert.equal(shrunk.importerCount, 0);
  assert.equal(shrunk.medianReachPercent, 0);
  assert.deepEqual(shrunk.importers, []);
  assert.deepEqual(affectedReachGrowth(shrunkMeasured, recorded), []);

  // A failure to measure (or to write the patch) must never be fatal — it is best-effort, reported as text.
  const lines: string[] = [];
  reportAffectedReachExactBaseline("/this/path/does/not/exist", (line: string) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.startsWith("census-precheck: affected-reach exact baseline NOT PRINTED - "),
    "an unmeasurable root must report a diagnostic line, never throw");
});
