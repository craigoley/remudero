import { test } from "node:test";
import assert from "node:assert/strict";
import { mechanicalRatchetOf } from "#src/lib/classify.js";

test("W1-T9399: check:ci-log:comment-load-ratchet is prevented, not retried", () => {
  assert.equal(mechanicalRatchetOf("ci-log round — comment-load-ratchet"), "comment-load-ratchet");
  assert.equal(mechanicalRatchetOf("BLOCKED by source-size-ratchet"), "source-size-ratchet");
  assert.equal(mechanicalRatchetOf("too many comment lines"), undefined);
  assert.equal(mechanicalRatchetOf(undefined), undefined);
});
