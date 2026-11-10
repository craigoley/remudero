import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  cpuPressureTier,
  initialReviewCapacityState,
  selectAdaptiveReviewWidth,
  type ReviewCapacityObservation,
} from "#src/lib/review-capacity.js";
import { validateReviewCapacityPolicy } from "#src/lib/sweep.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T11274 — W1-T11129 made cpuPsiLowPct both the calm line and the hysteresis band. The operator's 2026-11-03
// ruling ("Raise 5 -> 15") is the calm line; this pins what the SHIPPED row gives the real width controller.

const POLICY_TEXT = readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8");
const POLICY = validateReviewCapacityPolicy(
  (parseYaml(POLICY_TEXT) as { sweep: { reviewCapacity: unknown } }).sweep.reviewCapacity,
);
const BOUNDS = { minWidth: 1, baseWidth: 4, maxWidth: 4 };

function sample(full: number, share = 1, some = full): ReviewCapacityObservation {
  return {
    nowMs: 1_000_000,
    memAvailableMib: 28_000,
    cpuPsiSomeAvg10Pct: some,
    cpuPsiFullAvg10Pct: full,
    cpuWeightShare: share,
    memoryPsiSomeAvg10Pct: 0,
    activeWorkers: 0,
    queueDepth: 9,
    hostLoad1: 40,
    hostCpuCount: 8,
    settlements: { failures: 0, timeouts: 0, successes: 5, cpuPhaseMs: 60_000 },
    provider: { fresh: true, readable: true, refused: false, headroomPct: 80, reservePct: 5 },
  } as unknown as ReviewCapacityObservation;
}

const widthAfter = (start: number, full: number): number => {
  const prior = { ...initialReviewCapacityState(BOUNDS.baseWidth), effectiveWidth: start };
  return selectAdaptiveReviewWidth(prior, POLICY, sample(full), BOUNDS).decision.effectiveWidth;
};

test("the shipped review cpu band recovers a shed width to base at or under the ruled 15", () => {
  assert.equal(POLICY.cpuPsiLowPct, 15);
  assert.equal(widthAfter(1, 15), 4);
  assert.equal(widthAfter(1, 0), 4);
  assert.equal(widthAfter(1, 15.5), 1, "just over the ruled point holds the shed width");
});

test("the shipped review cpu band still sheds above its shrink point and holds between", () => {
  // At share 1 the weight excuses nothing: the shed point is the low watermark plus one band width.
  assert.equal(cpuPressureTier(sample(30), POLICY).tier, "hold");
  assert.equal(cpuPressureTier(sample(31), POLICY).tier, "shed");
  assert.equal(widthAfter(4, 31), 3);
  assert.equal(widthAfter(4, 30), 4);
  // A low weight share predicts contention, so it only ever raises the shed point.
  assert.equal(cpuPressureTier(sample(40, 0.5, 80), POLICY).tier, "hold");
  assert.equal(cpuPressureTier(sample(56, 0.5, 80), POLICY).tier, "shed");
});

test("the cpuPsiLowPct row's comment names the 2026-11-03 ruling, W1-T11274 and its two meanings", () => {
  const lines = POLICY_TEXT.split("\n");
  const at = lines.findIndex((line) => /^\s+cpuPsiLowPct:/.test(line));
  assert.ok(at > 0, "the row exists");
  const comment: string[] = [];
  for (let i = at - 1; i >= 0 && lines[i]!.trim().startsWith("#"); i -= 1) comment.unshift(lines[i]!);
  const text = comment.map((line) => line.replace(/^\s*#\s?/, "")).join(" ").replace(/\s+/g, " ");
  assert.match(text, /W1-T11274/);
  assert.match(text, /2026-11-03/);
  assert.match(text, /hysteresis band/);
  assert.doesNotMatch(text, /5 points of hysteresis under the 20 shed mark/);
});
