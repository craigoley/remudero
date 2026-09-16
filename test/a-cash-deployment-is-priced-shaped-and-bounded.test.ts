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
  const cash = mounts.capabilities?.cash;
  assert.ok(cash, "the cash ladder must exist");

  const named = new Set<string>();
  for (const efforts of Object.values(cash)) for (const row of Object.values(efforts)) for (const id of row) named.add(id);
  assert.ok(named.size > 0, "the ladder must name at least one deployment");
  // W1-T3689's OWN claim, not just the census: gpt-5-mini must actually be one of the named rows,
  // so this proof cannot pass vacuously against a merge base where the ladder never named it at all.
  assert.ok(named.has("gpt-5.6-luna"), "luna leads the cash ladder");
  assert.ok(!named.has("gpt-5-mini"), "gpt-5-mini was removed, not demoted — a trailing row would imply a fallback worth reaching");

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
  const cash = mounts.capabilities?.cash;
  assert.ok(cash, "the cash ladder must exist");
  for (const [capability, efforts] of Object.entries(cash)) {
    for (const [effort, row] of Object.entries(efforts)) {
      assert.ok(
        row.length > 1,
        `cash.${capability}.${effort} is single-candidate (${row.join(", ")}): one withdrawn deployment empties it`,
      );
    }
  }
});

// Terra earns its place on CAPABILITY, not price: it is 10x luna on both axes and may lead the
// frontier band only. A test keeps the price table saying so.
test("W1-T3699: terra is recorded as dearer than luna on both axes, so nothing routes to it to save money", () => {
  const terra = OPENWEIGHT_PRICES["gpt-5.6-terra"]!;
  const luna = OPENWEIGHT_PRICES["gpt-5.6-luna"]!;
  assert.ok(terra.inputUsdPerMillion > luna.inputUsdPerMillion, "terra must be dearer on input");
  assert.ok(terra.outputUsdPerMillion > luna.outputUsdPerMillion, "terra must be dearer on output");
  assert.equal(OPENWEIGHT_PRICES["gpt-5-mini"], undefined, "gpt-5-mini is gone from the price table");
});

test("W1-T3699: terra leads NOTHING — it is the escalation behind luna, never a lane's first choice", () => {
  const mounts = loadMounts(".remudero/mounts.yaml");
  const cash = (mounts.capabilities as unknown as Record<string, Record<string, Record<string, string[]>>>).cash;
  let frontierRows = 0;
  for (const [capability, efforts] of Object.entries(cash)) {
    for (const [effort, row] of Object.entries(efforts)) {
      assert.notEqual(row[0], "gpt-5.6-terra", `cash.${capability}.${effort} must not LEAD with terra — it is 10x luna`);
      if (capability === "frontier") {
        frontierRows++;
        assert.equal(row[0], "gpt-5.6-luna", `frontier.${effort} leads with luna, which replaced gpt-5-mini`);
        assert.ok(row.includes("gpt-5.6-terra"), `frontier.${effort} keeps terra reachable as the escalation`);
      }
    }
  }
  assert.ok(frontierRows > 0, "the frontier band must exist, or this asserts nothing");
});
