import assert from "node:assert/strict";
import { test } from "node:test";

test("deliberate CI-gate red probe", () => {
  assert.equal(1, 2);
});
