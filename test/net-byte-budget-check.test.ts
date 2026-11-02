import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error The executable .mjs module has no declaration file; exercise its export directly.
import { checkNetByteBudget } from "#scripts/claude-md-budget-ratchet.mjs";

test("net-byte budget check returns false on oversized budget", () => {
  assert.equal(checkNetByteBudget(101, 100), false);
  assert.equal(checkNetByteBudget(100, 100), true);
  assert.equal(checkNetByteBudget(99, 100), true);
  assert.equal(checkNetByteBudget(1, 0), false);
  assert.equal(checkNetByteBudget(0, 0), true);
  assert.equal(checkNetByteBudget(101, null), true);
  assert.equal(checkNetByteBudget(101, undefined), true);
});
