import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  cpuPressureTier,
  selectAdaptiveReviewWidth,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
  type ReviewCapacityState,
} from "#src/lib/review-capacity.js";
import { validateReviewCapacityPolicy } from "#src/lib/sweep.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T11274 — W1-T11129 made cpuPsiLowPct both the recovery watermark and the width of the shed's hysteresis band.
// The operator's 2026-11-03 ruling ("Raise 5 -> 15") is about recovery, so the SHIPPED row must keep recovery at 15.

const POLICY_PATH = join(REPO_ROOT, "plan", "policy.yaml");
const policyText = readFileSync(POLICY_PATH, "utf8");
const POLICY: ReviewCapacityPolicy = validateReviewCapacityPolicy(
  (parseYaml(policyText) as { sweep: { reviewCapacity: unknown } }).sweep.reviewCapacity,
);
const BOUNDS = { minWidth: 1, baseWidth: 4, maxWidth: 4 };
const RULED_RECOVERY_PCT = 15;

function observation(over: Partial<ReviewCapacityObservation>): ReviewCapacityObservation {
  return {
    nowMs: 1_000_000,
    queueDepth: 10,
    activeWorkers: 0,
    memAvailableMib: 20_000,
    cpuPsiSomeAvg10Pct: 70,
    cpuPsiFullAvg10Pct: 0,
    cpuWeightShare: 1,
    memoryPsiSomeAvg10Pct: 0,
    settlements: { successes: 3, failures: 0, timeouts: 0 },
    provider: { fresh: true, readable: true, refused: false, headroomPct: 80, reservePct: 2 },
    ...over,
  } as ReviewCapacityObservation;
}

const shedToOne: ReviewCapacityState = { effectiveWidth: 1, healthySamples: 0 };
const step = (prior: ReviewCapacityState, over: Partial<ReviewCapacityObservation>) =>
  selectAdaptiveReviewWidth(prior, POLICY, observation(over), BOUNDS).decision;

test("the shipped review capacity policy keeps the operator's ruled recovery watermark of 15", () => {
  assert.equal(POLICY.cpuPsiLowPct, RULED_RECOVERY_PCT);
});

test("a width shed to one recovers to base at cpu full PSI at or below the ruled 15, and holds just above it", () => {
  assert.equal(step(shedToOne, { cpuPsiFullAvg10Pct: RULED_RECOVERY_PCT }).effectiveWidth, BOUNDS.baseWidth);
  assert.equal(step(shedToOne, { cpuPsiFullAvg10Pct: 5 }).effectiveWidth, BOUNDS.baseWidth);
  const held = step(shedToOne, { cpuPsiFullAvg10Pct: RULED_RECOVERY_PCT + 0.5 });
  assert.equal(held.effectiveWidth, 1, "just above the ruled watermark the shed width holds");
  assert.notEqual(held.reason, "cpu-pressure", "the hold band is not itself a shed");
});

test("the shipped band sheds only above the shrink point the weight share sets, one lane per sample", () => {
  const shrinkAtFullShare = 2 * POLICY.cpuPsiLowPct;
  const full: ReviewCapacityState = { effectiveWidth: 4, healthySamples: 0 };
  // A share of 1 predicts no contention: the shrink point is the low watermark plus one band.
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: shrinkAtFullShare, cpuPsiSomeAvg10Pct: 70, cpuWeightShare: 1 }, POLICY).tier, "hold");
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: shrinkAtFullShare + 0.5, cpuPsiSomeAvg10Pct: 70, cpuWeightShare: 1 }, POLICY).tier, "shed");
  assert.equal(step(full, { cpuPsiFullAvg10Pct: shrinkAtFullShare }).effectiveWidth, 4);
  const shed = step(full, { cpuPsiFullAvg10Pct: shrinkAtFullShare + 0.5 });
  assert.equal(shed.reason, "cpu-pressure");
  assert.equal(shed.effectiveWidth, 3);
  // A half share with `some` 70 predicts 35 of contention from the weight alone: the shrink point moves up to 35 + 15.
  const halfShare = { cpuPsiSomeAvg10Pct: 70, cpuWeightShare: 0.5 };
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: 50, ...halfShare }, POLICY).tier, "hold");
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: 50.5, ...halfShare }, POLICY).tier, "shed");
});

test("plan/policy.yaml's cpuPsiLowPct comment names the ruling, the meaning it now carries and W1-T11274", () => {
  const lines = policyText.split("\n");
  const row = lines.findIndex((line) => /^\s*cpuPsiLowPct:/.test(line));
  assert.ok(row > 0, "the row exists");
  const comment: string[] = [];
  for (let i = row - 1; i >= 0 && /^\s*#/.test(lines[i]!); i--) comment.unshift(lines[i]!);
  const text = comment.join(" ").replace(/\s*#\s*/g, " ");
  assert.match(text, /Operator ruling 2026-11-03/);
  assert.match(text, /hysteresis band/);
  assert.match(text, /W1-T11274/);
  assert.equal(/5 points of hysteresis under the 20 shed mark/.test(text), false, "the stale 20-shed-mark claim is gone");
});
