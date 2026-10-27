import test from "node:test";
import assert from "node:assert/strict";
import { locateCiFrictionOwner } from "#src/lib/ci-friction-remedy.js";

const search = { filesContaining: () => [], fileExists: () => true };

test("W1-T10159: hand_fix:src/lib/ci-friction-remedy.ts is prevented, not retried", () => {
  assert.equal(locateCiFrictionOwner("hand_fix:src/lib/ci-friction-remedy.ts", [], search), undefined);
  assert.deepEqual(locateCiFrictionOwner("hand_fix:src/lib/other.ts", [], search)?.files, ["src/lib/other.ts"]);
});
