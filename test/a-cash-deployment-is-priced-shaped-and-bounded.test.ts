import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPENWEIGHT_CONTEXT_WINDOWS,
  OPENWEIGHT_PRICES,
  OPENWEIGHT_TEMPERATURE,
} from "../src/lib/worker-provider.js";
import { loadMounts } from "../src/lib/mounts.js";

// W1-T3689. A cash deployment reaches the wire only if THREE tables know it: its price (the
// reservation refuses an unpriced deployment rather than borrowing a neighbour's rate), its
// context window (the pre-transport size refusal), and its request temperature (a deployment may
// REFUSE a value rather than clamp it). A row present in the ladder but absent from any of the
// three is a deployment that fails at dispatch, not at review.
test("W1-T3689: every deployment named in the cash ladder is priced, shaped and bounded", () => {
  const mounts = loadMounts(".remudero/mounts.yaml");
  const cash = (mounts.capabilities as Record<string, Record<string, Record<string, string[]>>>).cash;
  assert.ok(cash, "the cash ladder must exist");

  const named = new Set<string>();
  for (const efforts of Object.values(cash)) for (const row of Object.values(efforts)) for (const id of row) named.add(id);
  assert.ok(named.size > 0, "the ladder must name at least one deployment");

  for (const id of named) {
    assert.ok(OPENWEIGHT_PRICES[id], `${id} is in the cash ladder with no PRICE row — dispatch would refuse it`);
    assert.ok(OPENWEIGHT_CONTEXT_WINDOWS[id], `${id} is in the cash ladder with no CONTEXT WINDOW row`);
    assert.ok(id in OPENWEIGHT_TEMPERATURE, `${id} is in the cash ladder with no TEMPERATURE row`);
  }
});

// THE GAP THE #5765 GUARD LEFT. That guard counted LISTED candidates and covered only the codex
// balanced/frontier rows, so `cash.frontier: [gpt-oss-120b]` — one deployment, no fallback — sat
// unflagged. A single-candidate row is not a preference: when its only model stops answering the
// row has NOTHING, and readCodexCapacity's equivalent on this ladder is a hard dispatch failure.
test("W1-T3689: no cash ladder row is single-candidate", () => {
  const mounts = loadMounts(".remudero/mounts.yaml");
  const cash = (mounts.capabilities as Record<string, Record<string, Record<string, string[]>>>).cash;
  for (const [capability, efforts] of Object.entries(cash)) {
    for (const [effort, row] of Object.entries(efforts)) {
      assert.ok(
        row.length > 1,
        `cash.${capability}.${effort} is single-candidate (${row.join(", ")}): one withdrawn deployment empties it`,
      );
    }
  }
});

// gpt-5-mini earns its place on CAPABILITY, not price, so the price table must keep saying so.
test("W1-T3689: gpt-5-mini is recorded as dearer than both siblings on both axes", () => {
  const mini = OPENWEIGHT_PRICES["gpt-5-mini"]!;
  for (const cheaper of ["gpt-5-nano", "gpt-oss-120b"] as const) {
    const other = OPENWEIGHT_PRICES[cheaper]!;
    assert.ok(mini.inputUsdPerMillion > other.inputUsdPerMillion, `mini must be dearer than ${cheaper} on input`);
    assert.ok(mini.outputUsdPerMillion > other.outputUsdPerMillion, `mini must be dearer than ${cheaper} on output`);
  }
  assert.ok(
    OPENWEIGHT_CONTEXT_WINDOWS["gpt-5-mini"]!.totalTokens > OPENWEIGHT_CONTEXT_WINDOWS["gpt-oss-120b"]!.totalTokens,
    "mini's input ceiling must clear gpt-oss-120b's, which is the reason it leads frontier",
  );
});
