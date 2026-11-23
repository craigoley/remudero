import assert from "node:assert/strict";
import { test } from "node:test";

import { coalesceFreshnessRestart, decideFreshnessRestart, timeToLikelyFreshnessRestart } from "#src/lib/deploy-judge.js";

const threshold = { value: 18, reason: "test score limit" };
const scoring = {
  changes: Array.from({ length: 8 }, (_, i) => ({ sha: `commit-${i}`, files: ["src/lib/daemon.ts"] })),
  busy: true,
  staleSinceMs: 0,
  nowMs: 0,
  state: { total: 0, scoredShas: [] },
  threshold,
  ageHorizonMs: 1_800,
};
const timing = {
  threshold,
  ageHorizonMs: 1_800,
  staleSinceMs: 0,
  lifetimeStartedAtMs: 0,
  minLifetimeMs: 2_000,
};
const coalescing = { ...timing, newSha: "head", lastAdvanceAtMs: 0, window: { value: 1_500, reason: "test quiet window" } };

test("W1-T13413 criterion 1: measured stall pressure tips a busy daemon into restart", () => {
  const input = { ...scoring, nowMs: 100 };
  assert.equal(decideFreshnessRestart(input).action, "defer");
  const decision = decideFreshnessRestart({ ...input, stallShare: 0.53 });
  assert.equal(decision.action, "restart");
  assert.equal(decision.restartTrigger, "stall");
  assert.equal(decision.weight, 8);
  assert.equal(decision.agePressure, 1);
  assert.equal(decision.stallPressure, 9);
  assert.equal(decision.pressure, 18);
  assert.match(decision.reason, /change 8 \+ staleness 1 \+ stall 9/);
  assert.equal(decision.state.total, 8, "a new sample must replace stall pressure, not accumulate it");
  assert.equal(decideFreshnessRestart({ ...input, nowMs: 1_000, stallShare: 0.53 }).restartTrigger, "age");
  assert.equal(decideFreshnessRestart({ ...input, stallShare: 2 }).stallPressure, 18);
});

test("W1-T13413 criterion 2: minimum lifetime releases at the shortened boundary", () => {
  const decision = decideFreshnessRestart({ ...scoring, nowMs: 100, busy: false, stallShare: 0.5 });
  assert.equal(decision.action, "restart");
  assert.deepEqual(coalesceFreshnessRestart({ ...coalescing, decision, nowMs: 999, stallShare: 0.5 }), {
    action: "hold", reason: "min_lifetime", heldMs: 999, windowEndsAtMs: 1_500,
  });
  assert.deepEqual(coalesceFreshnessRestart({ ...coalescing, decision, nowMs: 1_000, stallShare: 0.5 }), {
    action: "restart", reason: "loop_stall", heldMs: 1_000, windowEndsAtMs: 1_500,
  });
  assert.equal(coalesceFreshnessRestart({ ...coalescing, decision, nowMs: 999, stallShare: 0.5, installInputsChanged: true }).reason,
    "install_inputs_changed");
  assert.equal(timeToLikelyFreshnessRestart({ ...timing, weight: 8, nowMs: 100, stallShare: 0.5 }).timeToRestartMs, 900);
  assert.deepEqual(timeToLikelyFreshnessRestart({ ...timing, weight: 8, nowMs: 100, stallShare: 0.25, minLifetimeMs: 200 }), {
    pressure: 13, timeToRestartMs: 500,
  });
});

test("W1-T13413 criterion 3: zero and absent stall share keep the existing decision and outlook", () => {
  for (const options of [{}, { stallShare: 0 }]) {
    assert.deepEqual(decideFreshnessRestart({ ...scoring, nowMs: 100, ...options }), {
      action: "defer",
      reason: "busy, and pressure 9 (change 8 + staleness 1) < 18: wait for an idle moment",
      weight: 8,
      agePressure: 1,
      pressure: 9,
      state: { total: 8, scoredShas: scoring.changes.map(({ sha }) => sha) },
    });
    const decision = decideFreshnessRestart({ ...scoring, nowMs: 1_000, ...options });
    assert.equal(decision.restartTrigger, "age");
    assert.equal(decision.reason, "busy, but pressure 18 (change 8 + staleness 10) >= 18: drain and restart");
    assert.deepEqual(coalesceFreshnessRestart({ ...coalescing, decision, nowMs: 1_999, ...options }), {
      action: "hold", reason: "min_lifetime", heldMs: 1_999, windowEndsAtMs: 1_500,
    });
    assert.deepEqual(coalesceFreshnessRestart({ ...coalescing, decision, nowMs: 2_000, ...options }), {
      action: "restart", reason: decision.reason, heldMs: 0, windowEndsAtMs: 1_500,
    });
    assert.deepEqual(timeToLikelyFreshnessRestart({ ...timing, weight: 8, nowMs: 100, ...options }), {
      pressure: 9, timeToRestartMs: 1_900,
    });
  }
});
