// Fixture "test file" for assertion-discrimination-check's falsifier suite (W1-T1051).
// Deliberately carries NO qualifying assertion site at all (no readFileSync-bound variable
// checked against a literal) -- proves the checker treats an empty resolved set as a FAILURE,
// never a vacuous pass.
import assert from "node:assert/strict";
import { test } from "node:test";

test("fixture: no assertion sites here", () => {
  assert.ok(true);
});
