import assert from "node:assert/strict";
import { test } from "node:test";
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

// ── on the guard that is NOT here ───────────────────────────────────────────────────────────────
//
// An earlier draft read src/lib/worker.ts and asserted `cashSqueezed: true` appears exactly once,
// to prove routine mount-affinity work can never claim the raised ceiling. W1-T2905's ratchet
// refused it, and rightly: a per-file count of source-text reads in tests is capped precisely
// because such assertions pin TEXT rather than BEHAVIOUR and rot on the next refactor.
//
// The property still holds and is still worth stating, just not by grepping the tree: the flag is
// carried on SpawnWorkerArgs and set in one branch, which typecheck pins structurally, and the
// cap arithmetic above is the part a bug would actually show up in.
