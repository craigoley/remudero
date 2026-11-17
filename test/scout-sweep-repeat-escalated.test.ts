import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SWEEP_POLICY, repeatDispositionStreaksFromLedger } from "#test/helpers/sweep-test.js";

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  step: "sweep.disposed",
  pr_number: 4522,
  head_sha: "c93b421ec55799d01b1de0cc8b76d25a1cce96be",
  disposition: "blocked-fixable",
  acted: false,
  ...over,
});

test("W1-T9938: sweep.repeat_escalated no longer recurs", () => {
  const bound = DEFAULT_SWEEP_POLICY.repeatDispositionBound;
  // The trip row is written once, on the pass that stamps `repeat_escalated: true` on its disposed row.
  const tripped = [row({ repeat_streak: bound, repeat_escalated: true })];
  // Every later pass on the same unmoved head folds to escalated, so the sweep's
  // `!repeatAlreadyEscalated` guard stays shut and no further sweep.repeat_escalated row is written.
  const later = [...tripped, row({ repeat_streak: bound + 1 }), row({ repeat_streak: bound + 2 })];
  const run = repeatDispositionStreaksFromLedger(later).get(4522);
  assert.equal(run?.escalated, true, "the trip must stay recorded for the unmoved head");
  assert.ok((run?.streak ?? 0) >= bound);
  // A moved head is a new run and re-arms the trip, the only legitimate recurrence.
  const moved = [...later, row({ head_sha: "deadbeef", repeat_streak: 1 })];
  assert.equal(repeatDispositionStreaksFromLedger(moved).get(4522)?.escalated, false);
});
