import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFUSE_CONTROL_SHIFT_DAYS, runSuiteShiftedMeasured } from "#src/lib/gate-gardener.js";
import { repoRoot } from "#test/helpers/repo-root.js";

test("the memory tuner fixture keeps its rate assertions under the census control and future shift", () => {
  for (const shift of [DEFUSE_CONTROL_SHIFT_DAYS, 2]) {
    const result = runSuiteShiftedMeasured(repoRoot(), "test/a-squeezed-page-cache-grows-its-memory-high.test.ts", shift);
    assert.ok(result.tests > 0, "the actual existing suite must report named tests");
    assert.equal(result.passed, true, `existing rate and safety assertions must pass at shift ${shift}: ${JSON.stringify(result)}`);
    assert.equal(result.pass, result.tests, "the shifted suite has no failures or skipped assertions");
  }
});

test("the heartbeat fixture keeps its interval assertions under the census control and future shift", () => {
  for (const shift of [DEFUSE_CONTROL_SHIFT_DAYS, 8]) {
    const result = runSuiteShiftedMeasured(repoRoot(), "test/the-beat-publishes-each-daemons-memory-high.test.ts", shift);
    assert.ok(result.tests > 0, "the actual heartbeat suite must report named tests");
    assert.equal(result.passed, true, `existing interval and unknown controls must pass at shift ${shift}: ${JSON.stringify(result)}`);
    assert.equal(result.pass, result.tests, "the shifted heartbeat suite has no failures or skipped assertions");
  }
});

test("the review summary fixture keeps its escalation assertions beyond the census window", () => {
  for (const shift of [DEFUSE_CONTROL_SHIFT_DAYS, 8]) {
    const result = runSuiteShiftedMeasured(repoRoot(), "test/the-sweep-reads-the-reviewers-own-summary.test.ts", shift);
    assert.ok(result.tests > 0, "the actual review summary suite must report named tests");
    assert.equal(result.passed, true, `existing exact-head and refusal assertions must pass at shift ${shift}: ${JSON.stringify(result)}`);
    assert.equal(result.pass, result.tests, "the shifted review summary suite has no failures or skipped assertions");
  }
});
