import assert from "node:assert/strict";
import test from "node:test";
import {
  assessRefreshClearance,
  refreshedOnSameRed,
  refreshRecordsFromLedger,
  type BaseProbeFile,
} from "#src/lib/base-reproduction.js";

const PR = 13324;
const CHECK = "coverage-shard (4/8)";
const PERSISTENT = "test/inbox/an-amended-contract-releases-a-design-or-scope-hold.test.ts";
const OTHER_FAILING = "test/fix-lane/other-failing.test.ts";
const CLEARED = "test/fix-lane/cleared.test.ts";
const reach = { counted: ["src/lib/sweep.ts"], complete: true };
const probe = (file: string, outcome: BaseProbeFile["outcome"]): BaseProbeFile =>
  ({ file, outcome, duration_ms: 1, cached: false });

test("W1-T10388: a partial trial merge refuses the refresh and names the still-failing files", async () => {
  const mergedFiles = [probe(PERSISTENT, "fails"), probe(CLEARED, "passes"), probe(OTHER_FAILING, "fails")];
  for (const priorRefresh of [false, true, undefined]) {
    const clearance = await assessRefreshClearance({
      failingTestFiles: [PERSISTENT, CLEARED, OTHER_FAILING], reach, priorRefresh,
    }, async () => mergedFiles);
    assert.equal(clearance.refresh, false);
    assert.equal(clearance.evidence, "partial");
    assert.equal(clearance.mergedVerdict, "partial");
    assert.deepEqual(clearance.mergedFiles, mergedFiles);
    assert.deepEqual(clearance.countedPaths, reach.counted);
    assert.ok(clearance.reason.includes(PERSISTENT), clearance.reason);
    assert.ok(clearance.reason.includes(OTHER_FAILING), clearance.reason);
    assert.equal(clearance.reason.includes(CLEARED), false, clearance.reason);
  }
});

test("W1-T10388: a prior refresh sharing a failing file is the same red", async () => {
  const records = refreshRecordsFromLedger([{
    step: "sweep.base_fixed.refresh", pr_number: PR, outcome: "updated",
    check_names: [CHECK], test_files: [CLEARED, PERSISTENT],
  }]);
  const files = [OTHER_FAILING, PERSISTENT];
  const priorRefresh = refreshedOnSameRed(records, PR, ["rule-checks", CHECK], files);
  assert.equal(priorRefresh, true);
  const clearance = await assessRefreshClearance({
    failingTestFiles: files, reach: { counted: [], complete: false }, priorRefresh,
  }, undefined);
  assert.equal(clearance.refresh, false);
  assert.equal(clearance.evidence, "repeat");
  assert.equal(refreshedOnSameRed(records, PR, ["rule-checks"], files), false);
  assert.equal(refreshedOnSameRed(records, PR, [CHECK], [OTHER_FAILING]), false);
  assert.equal(refreshedOnSameRed(records, PR + 1, [CHECK], files), false);
  assert.equal(refreshedOnSameRed(records, PR, [CHECK], []), false);

  const fileless = refreshRecordsFromLedger([{
    step: "fix.base_refreshed", pr_number: PR, red_checks: [CHECK], test_files: [],
  }]);
  assert.equal(refreshedOnSameRed(fileless, PR, [CHECK], files), true);
  assert.equal(refreshedOnSameRed(fileless, PR, [CHECK], []), true);
  assert.equal(refreshedOnSameRed(fileless, PR, ["rule-checks"], files), false);
  const legacy = refreshRecordsFromLedger([{
    step: "sweep.base_fixed.refresh", pr_number: PR, outcome: "updated", test_files: [PERSISTENT],
  }]);
  assert.equal(refreshedOnSameRed(legacy, PR, ["rule-checks"], files), true);
});

test("W1-T10388: clear and reproduced trial merges preserve their refresh decisions", async () => {
  for (const priorRefresh of [false, true, undefined]) {
    const input = { failingTestFiles: [PERSISTENT, CLEARED], reach, priorRefresh };
    const clear = await assessRefreshClearance(input, async () => [
      probe(PERSISTENT, "passes"), probe(CLEARED, "absent"),
    ]);
    assert.deepEqual([clear.refresh, clear.evidence, clear.mergedVerdict], [true, "merged-probe", "clear"]);
    const reproduced = await assessRefreshClearance(input, async () => [
      probe(PERSISTENT, "fails"), probe(CLEARED, "fails"),
    ]);
    assert.deepEqual([reproduced.refresh, reproduced.evidence, reproduced.mergedVerdict],
      [false, "merged-probe", "reproduced"]);
  }
});

test("W1-T10388: unrunnable and fileless refresh decisions remain unchanged", async () => {
  for (const priorRefresh of [false, true, undefined]) {
    const input = { failingTestFiles: [PERSISTENT], reach, priorRefresh };
    const expected = priorRefresh === false;
    const unwired = await assessRefreshClearance(input, undefined);
    assert.deepEqual([unwired.refresh, unwired.evidence], [expected, "unrunnable"]);
    const unrunnable = await assessRefreshClearance(input, async () => [probe(PERSISTENT, "unrunnable")]);
    assert.deepEqual([unrunnable.refresh, unrunnable.evidence, unrunnable.mergedVerdict],
      [expected, "unrunnable", "unrunnable"]);
    const thrown = await assessRefreshClearance(input, async () => { throw new Error("trial merge conflict"); });
    assert.deepEqual([thrown.refresh, thrown.evidence], [expected, "unrunnable"]);
    assert.ok(thrown.reason.includes("trial merge conflict"), thrown.reason);
    const fileless = await assessRefreshClearance({ ...input, failingTestFiles: [] }, undefined);
    assert.deepEqual([fileless.refresh, fileless.evidence], [expected, "fileless"]);
  }
});
