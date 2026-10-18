import { test } from "node:test";
import assert from "node:assert/strict";
import { mechanicalRatchetOf } from "../src/lib/classify.js";

test("W1-T9399: check:ci-log:comment-load-ratchet is prevented, not retried", () => {
  // The harness classifies the ratchet as mechanical (prevented up front), so no fix round is spent.
  assert.equal(mechanicalRatchetOf("ci-log round — comment-load-ratchet"), "comment-load-ratchet");
  assert.equal(mechanicalRatchetOf("too many comment lines"), undefined);
});
