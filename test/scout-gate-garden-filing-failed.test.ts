import assert from "node:assert/strict";
import { test } from "node:test";

import { renderCommentCompressionShard, renderHeadroomShard } from "#src/lib/gate-gardener.js";

/**
 * W1-T9271: the gate gardener logs `gate.garden_filing_failed` when its drafted shard is refused by the
 * shared machine-shard lint (`refused` on the rendered shard). W1-T12833 made every shard declare its
 * invariants; this holds that the gate gardener's own renderers draft shards that lint clean.
 */
test("W1-T9271: gate.garden_filing_failed no longer recurs", () => {
  const headroom = renderHeadroomShard({
    gate: "source-size", field: "files", limitFile: "scripts/source-size-baseline.json",
    measured: 95, limit: 100, files: ["src/lib/example.ts"],
  }, "W1-T99991");
  assert.equal(headroom.refused, undefined, `headroom draft refused: ${headroom.refused}`);
  assert.match(headroom.text, /invariant/i, "the draft declares its invariant");

  const compression = renderCommentCompressionShard({ file: "src/lib/example.ts", comments: 400 }, "W1-T99992");
  assert.equal(compression.refused, undefined, `compression draft refused: ${compression.refused}`);
});
