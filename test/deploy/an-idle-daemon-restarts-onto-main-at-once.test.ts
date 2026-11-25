import assert from "node:assert/strict";
import { test } from "node:test";

import { coalesceFreshnessRestart, decideFreshnessRestart, IDLE_RELEASE, MIN_LIFETIME_HOLD } from "#src/lib/deploy-judge.js";

// W1-T14751, OPERATOR RULING 2026-11-25 ("After each quiet burst of merges"): an idle daemon inside its minimum
// lifetime restarts onto main once the quiet advance window has passed since the last advance.
const MINUTE = 60_000;
const threshold = { value: 18, reason: "test score limit" };
const advance = [{ sha: "a1", files: ["src/lib/daemon.ts"] }];
const scoring = { changes: advance, staleSinceMs: 0, state: { total: 0, scoredShas: [] }, threshold, ageHorizonMs: 60 * MINUTE };
const coalescing = {
  newSha: "a1",
  lastAdvanceAtMs: 20 * MINUTE,
  staleSinceMs: 20 * MINUTE,
  window: { value: 10 * MINUTE, reason: "test quiet window" },
  threshold,
  ageHorizonMs: 60 * MINUTE,
  lifetimeStartedAtMs: 0,
  minLifetimeMs: 90 * MINUTE,
};

function judge(busy: boolean, nowMs: number, changes = advance) {
  const decision = decideFreshnessRestart({ ...scoring, changes, busy, nowMs });
  return coalesceFreshnessRestart({ ...coalescing, decision, nowMs });
}

test("W1-T14751 an idle daemon inside its minimum lifetime restarts onto main once its merges go quiet", () => {
  const coalesced = judge(false, 30 * MINUTE);
  assert.equal(coalesced.action, "restart");
  assert.equal(coalesced.reason, IDLE_RELEASE);
  assert.equal(coalesced.windowEndsAtMs, 30 * MINUTE);
  // An advance heavy enough to trigger on change alone is still an idle daemon's, so it takes the same release.
  const heavy = Array.from({ length: 18 }, (_, i) => ({ sha: `a${i}`, files: ["src/lib/daemon.ts"] }));
  const decision = decideFreshnessRestart({ ...scoring, changes: heavy, busy: false, nowMs: 30 * MINUTE });
  assert.equal(decision.restartTrigger, "change");
  assert.equal(coalesceFreshnessRestart({ ...coalescing, decision, nowMs: 30 * MINUTE }).reason, IDLE_RELEASE);
});

test("W1-T14751 an idle daemon inside its minimum lifetime waits out a burst of merges", () => {
  const coalesced = judge(false, 30 * MINUTE - 1);
  assert.equal(coalesced.action, "hold");
  assert.equal(coalesced.reason, MIN_LIFETIME_HOLD);
  // The wait ends with the burst: the first decision after the window closes releases the same daemon.
  assert.equal(judge(false, 30 * MINUTE).reason, IDLE_RELEASE);
  // A tests-only advance changes no code this daemon runs, so even a quiet one gives it nothing to restart for.
  const testsOnly = judge(false, 30 * MINUTE, [{ sha: "a1", files: ["test/deploy/x.test.ts"] }]);
  assert.equal(testsOnly.action, "hold");
  assert.equal(testsOnly.reason, MIN_LIFETIME_HOLD);
});

test("W1-T14751 a busy daemon inside its minimum lifetime is still held", () => {
  // The same quiet advance releases an idle daemon and holds a busy one: the floor still protects work in flight.
  assert.equal(judge(false, 30 * MINUTE).reason, IDLE_RELEASE);
  const heavy = Array.from({ length: 18 }, (_, i) => ({ sha: `a${i}`, files: ["src/lib/daemon.ts"] }));
  const busy = judge(true, 30 * MINUTE, heavy);
  assert.equal(busy.action, "hold");
  assert.equal(busy.reason, MIN_LIFETIME_HOLD);
});
