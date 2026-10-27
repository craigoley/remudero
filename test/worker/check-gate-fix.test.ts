import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveFixMode } from "#src/lib/prompt-render.js";

test("W1-T10574: check:gate-fix is prevented, not retried", () => {
  const review = { unmetCriteria: [], summary: "failed" };
  const rule15 = [{ reason: "Standing rule 15: criteria edited beside non-plan files" }];
  assert.notEqual(deriveFixMode({ review, actionableGateFailures: rule15 }), "gate-fix");
  const entangled = [{ reason: "entangled: instrument path(s) src/x.ts" }];
  assert.notEqual(deriveFixMode({ review, actionableGateFailures: entangled }), "gate-fix");
  const fixable = [{ reason: "changeset contradiction: body says no foo.ts" }];
  assert.equal(deriveFixMode({ review, actionableGateFailures: fixable }), "gate-fix");
});
