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
