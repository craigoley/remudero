import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { effectiveCashCapUsd } from "../src/lib/worker-provider.js";

// this change. Operator intent, 2026-09-16: "$10 on a normal day and $25 on a day when the
// subscriptions are tapped out." The higher figure is a CEILING that stops the cap refusing work
// on the one day cash is the only thing that can do it -- not permission to spend more.

test("a plain number is the whole cap, squeezed or not — existing configs are untouched", () => {
  assert.equal(effectiveCashCapUsd(20), 20);
  assert.equal(effectiveCashCapUsd(20, { squeezed: true }), 20);
  assert.equal(effectiveCashCapUsd(20, { squeezed: false }), 20);
});

test("a pair uses `normal` for routine work and `squeezed` only when subscriptions are tapped", () => {
  const cap = { normal: 10, squeezed: 25 };
  assert.equal(effectiveCashCapUsd(cap), 10, "absent flag means an ordinary day");
  assert.equal(effectiveCashCapUsd(cap, { squeezed: false }), 10);
  assert.equal(effectiveCashCapUsd(cap, { squeezed: true }), 25);
});

test("an absent cap stays absent, so the transport still refuses to run uncapped", () => {
  // reserveOpenWeightBudget throws on undefined; this must not invent a default.
  assert.equal(effectiveCashCapUsd(undefined), undefined);
  assert.equal(effectiveCashCapUsd(null), undefined);
  assert.equal(effectiveCashCapUsd(null, { squeezed: true }), undefined);
});

test("a pair whose squeezed is BELOW normal is refused as a transposition", () => {
  // Silently honouring it would cap the fleet hardest exactly when it is most constrained.
  assert.throws(
    () => effectiveCashCapUsd({ normal: 25, squeezed: 10 }),
    /squeezed \(\$10\) is below dailyCapUsd\.normal \(\$25\)/,
  );
  assert.throws(() => effectiveCashCapUsd({ normal: 25, squeezed: 10 }), /swap them/);
});

test("equal figures are allowed — that is an operator opting OUT of the raise", () => {
  assert.equal(effectiveCashCapUsd({ normal: 10, squeezed: 10 }, { squeezed: true }), 10);
});

test("a non-finite figure refuses rather than reaching the reservation as NaN", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => effectiveCashCapUsd({ normal: bad, squeezed: 25 }), /two finite numbers/);
    assert.throws(() => effectiveCashCapUsd({ normal: 10, squeezed: bad }), /two finite numbers/);
  }
});

// ── the signal is reachable, and only from the one path that may claim it ──────────────────────

test("the squeeze ceiling is claimed in exactly ONE place, and it is the blocked-auction fallback", () => {
  // A COUNT, not a proximity match. The risk this guards is not "the code moved" but "a second
  // caller started claiming the raised ceiling" -- routine mount-affinity cash work must never set
  // it, or the squeeze figure silently becomes the everyday one.
  const src = readFileSync("src/lib/worker.ts", "utf8");
  const assignments = [...src.matchAll(/cashSqueezed:\s*true/g)];
  assert.equal(assignments.length, 1, "exactly one caller may claim the raised ceiling");

  // And it is inside the `ProviderCapacityBlockedError` branch: take the text from that branch's
  // start to the assignment and require no intervening function boundary to have closed it.
  const branch = src.lastIndexOf("ProviderCapacityBlockedError", assignments[0]!.index!);
  assert.ok(branch > 0, "the assignment must follow a ProviderCapacityBlockedError branch");
  const between = src.slice(branch, assignments[0]!.index!);
  assert.match(between, /cashFallbackRefusal\(/, "it must sit after the eligibility gate, not before it");
  assert.match(between, /worker\.provider\.cash_fallback/, "and after the ledger line that records the fallback");
});

test("the adapter passes the flag to EVERY reservation the run makes, not just the first", () => {
  // The reservation happens once per turn of the tool loop; a flag applied to the first turn only
  // would let a long run fall back to the normal ceiling mid-flight.
  const src = readFileSync("src/lib/worker-provider.ts", "utf8");
  const reserveCall = src.slice(src.indexOf("reserveOpenWeightBudget(config, {"));
  assert.match(reserveCall.slice(0, 400), /squeezed: args\.cashSqueezed === true/);
  assert.match(src, /for \(;;\) \{/, "the reservation sits inside the per-turn loop");
});
