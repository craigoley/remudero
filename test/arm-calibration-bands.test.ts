import assert from "node:assert/strict";
import { test } from "node:test";

import { decideAutoMergeArm, type ArmDecision, type CappedOverride } from "../src/lib/review.js";
import { loadDefaultPolicy, type ArmCalibrationBandRow } from "../src/lib/policy.js";

/**
 * test/arm-calibration-bands.test.ts — W1-T2579, THE ARM GATE'S OPERATOR-RATIFIED BAND TABLE.
 *
 * `decideAutoMergeArm` is the SINGLE owner of arm goodness (per its own delegation history —
 * see review.ts's own doc). This shard adds ONE seam to it: after every existing refusal, on
 * the already-arming (uncapped) path only, it consults `plan/policy.yaml`'s
 * `armCalibrationBands` — a ratified table `verdict-calibration.ts`/`measurement_cadence`
 * MEASURE toward but never WRITE. A `hold` row refuses; a `notify` row arms and annotates. The
 * table SHIPS EMPTY (design (iv)), so every claim this file proves is checked against BOTH an
 * injected fixture (the fast, hermetic path every test below uses for the positive/negative
 * band cases) and, once, the REAL shipped `plan/policy.yaml` (the "decideAutoMergeArm actually
 * reads it" claim — no test here should be satisfiable by a seam that only accepts an injected
 * table and never consults the committed one).
 */

function fullPassVerdict(): { state: "success"; capped: boolean; planOnly: boolean } {
  return { state: "success", capped: false, planOnly: false };
}

function keywordFloorVerdict(): {
  state: "success";
  capped: boolean;
  planOnly: boolean;
  partiallyExecuted: boolean;
  executedProofCount?: number;
  executableProofCount?: number;
} {
  return { state: "success", capped: false, planOnly: false, partiallyExecuted: true };
}

function cappedNoOverrideVerdict(): { state: "success"; capped: boolean; planOnly: boolean } {
  return { state: "success", capped: true, planOnly: false };
}

function cappedPlanOnlyVerdict(): { state: "success"; capped: boolean; planOnly: boolean } {
  return { state: "success", capped: true, planOnly: true };
}

function failedStateVerdict(): { state: "failure"; capped: boolean; planOnly: boolean } {
  return { state: "failure" as const, capped: false, planOnly: false };
}

const SOME_OVERRIDE: CappedOverride = { by: "operator", reason: "manually reviewed, arming anyway" };

// ── acceptance 1: absent/empty table ⇒ byte-identical to today, across EVERY path ────────────

test("W1-T2579 acceptance 1: an absent band table (no 5th argument) is byte-identical to an explicit empty table, across every refusal and approval path", () => {
  const cases: Array<{ label: string; verdict: unknown; tddStrict: boolean; override?: CappedOverride; irreversible?: boolean }> = [
    { label: "irreversible refuses", verdict: fullPassVerdict(), tddStrict: false, irreversible: true },
    { label: "non-success state refuses", verdict: failedStateVerdict(), tddStrict: false },
    { label: "capped, no override refuses", verdict: cappedNoOverrideVerdict(), tddStrict: false },
    { label: "capped, override arms", verdict: cappedNoOverrideVerdict(), tddStrict: false, override: SOME_OVERRIDE },
    { label: "capped, plan-only arms", verdict: cappedPlanOnlyVerdict(), tddStrict: false },
    { label: "full-pass arms", verdict: fullPassVerdict(), tddStrict: false },
    {
      label: "partial-pass WITH counts arms",
      verdict: { ...keywordFloorVerdict(), executedProofCount: 3, executableProofCount: 5 },
      tddStrict: false,
    },
    { label: "partial-pass WITHOUT counts arms", verdict: keywordFloorVerdict(), tddStrict: false },
  ];

  for (const c of cases) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = c.verdict as any;
    const withoutTable = decideAutoMergeArm(v, c.tddStrict, c.override, c.irreversible);
    const withEmptyTable = decideAutoMergeArm(v, c.tddStrict, c.override, c.irreversible, []);
    assert.deepEqual(withEmptyTable, withoutTable, `${c.label}: empty table must be byte-identical to no table`);
  }
});

test("W1-T2579 acceptance 1 (real seam): the SHIPPED plan/policy.yaml carries an empty armCalibrationBands table, and omitting the parameter really does read it", () => {
  const shipped = loadDefaultPolicy().values.armCalibrationBands;
  assert.deepEqual(shipped, [], "plan/policy.yaml's armCalibrationBands must ship EMPTY (design iv)");
  const verdict = fullPassVerdict();
  const withoutParam = decideAutoMergeArm(verdict, false);
  const withInjectedEmpty = decideAutoMergeArm(verdict, false, undefined, undefined, []);
  assert.deepEqual(withoutParam, withInjectedEmpty, "omitting the 5th argument must resolve through the real, shipped (empty) table");
});

// ── acceptance 2: a ratified HOLD band refuses, naming its class ─────────────────────────────

test("W1-T2579 acceptance 2: a ratified hold band on full-pass refuses the arm, naming the class", () => {
  const bands: ArmCalibrationBandRow[] = [{ class: "full-pass", verdict: "hold" }];
  const decision = decideAutoMergeArm(fullPassVerdict(), false, undefined, undefined, bands);
  assert.equal(decision.arm, false);
  assert.match(decision.reason, /calibration-band:full-pass/);
});

test("W1-T2579 acceptance 2: a ratified hold band on keyword-floor refuses a partial-pass, naming the class", () => {
  const bands: ArmCalibrationBandRow[] = [{ class: "keyword-floor", verdict: "hold" }];
  const decision = decideAutoMergeArm(keywordFloorVerdict(), false, undefined, undefined, bands);
  assert.equal(decision.arm, false);
  assert.match(decision.reason, /calibration-band:keyword-floor/);
});

// ── acceptance 3: a NOTIFY band arms and carries the note ────────────────────────────────────

test("W1-T2579 acceptance 3: a notify band arms and carries its note in the decision reason", () => {
  const bands: ArmCalibrationBandRow[] = [
    { class: "keyword-floor", verdict: "notify", note: "watching this class per the 2026-09 baseline" },
  ];
  const decision = decideAutoMergeArm(keywordFloorVerdict(), false, undefined, undefined, bands);
  assert.equal(decision.arm, true);
  assert.match(decision.reason, /calibration-band:keyword-floor/);
  assert.match(decision.reason, /watching this class per the 2026-09 baseline/);
});

test("W1-T2579 acceptance 3: a notify band with no note still arms and names the class, without a dangling separator", () => {
  const bands: ArmCalibrationBandRow[] = [{ class: "full-pass", verdict: "notify" }];
  const decision = decideAutoMergeArm(fullPassVerdict(), false, undefined, undefined, bands);
  assert.equal(decision.arm, true);
  assert.match(decision.reason, /calibration-band:full-pass notify\)/);
});

// ── acceptance 4: a band can never arm a verdict the existing refusals hold ──────────────────

test("W1-T2579 acceptance 4: a band never overrides the irreversible refusal", () => {
  const bands: ArmCalibrationBandRow[] = [{ class: "full-pass", verdict: "notify" }];
  const withoutBand = decideAutoMergeArm(fullPassVerdict(), false, undefined, true);
  const withBand = decideAutoMergeArm(fullPassVerdict(), false, undefined, true, bands);
  assert.equal(withBand.arm, false);
  assert.deepEqual(withBand, withoutBand, "irreversible refusal is evaluated before any band and is untouchable by it");
});

test("W1-T2579 acceptance 4: a band never overrides the non-success state refusal", () => {
  const bands: ArmCalibrationBandRow[] = [{ class: "full-pass", verdict: "hold" }];
  const withoutBand = decideAutoMergeArm(failedStateVerdict(), false);
  const withBand = decideAutoMergeArm(failedStateVerdict(), false, undefined, undefined, bands);
  assert.equal(withBand.arm, false);
  assert.deepEqual(withBand, withoutBand, "a non-success verdict never even resolves a class, so the band is never consulted");
});

test("W1-T2579 acceptance 4: a band never overrides the CAPPED-no-override refusal", () => {
  const bands: ArmCalibrationBandRow[] = [{ class: "degraded-arm", verdict: "notify" }];
  const withoutBand = decideAutoMergeArm(cappedNoOverrideVerdict(), false);
  const withBand = decideAutoMergeArm(cappedNoOverrideVerdict(), false, undefined, undefined, bands);
  assert.equal(withBand.arm, false);
  assert.deepEqual(withBand, withoutBand, "the capped refusal is evaluated before any band and is untouchable by it");
});

// ── acceptance 5: the capped class is refused band eligibility by construction ───────────────

test("W1-T2579 acceptance 5: a hold band aimed at the capped class cannot disarm a CAPPED+override arm", () => {
  const bands: ArmCalibrationBandRow[] = [{ class: "degraded-arm", verdict: "hold" }];
  const withoutBand = decideAutoMergeArm(cappedNoOverrideVerdict(), false, SOME_OVERRIDE);
  const withBand = decideAutoMergeArm(cappedNoOverrideVerdict(), false, SOME_OVERRIDE, undefined, bands);
  assert.equal(withBand.arm, true);
  assert.deepEqual(withBand, withoutBand, "the override arm never even reaches band consultation — capped is ineligible by construction");
});

test("W1-T2579 acceptance 5: a hold band aimed at the capped class cannot disarm a plan-only CAPPED arm", () => {
  const bands: ArmCalibrationBandRow[] = [{ class: "degraded-arm", verdict: "hold" }];
  const withoutBand = decideAutoMergeArm(cappedPlanOnlyVerdict(), false);
  const withBand = decideAutoMergeArm(cappedPlanOnlyVerdict(), false, undefined, undefined, bands);
  assert.equal(withBand.arm, true);
  assert.deepEqual(withBand, withoutBand, "the W1-T205 plan-only carve-out never even reaches band consultation");
});

// ── acceptance 6: a malformed band row is inert and named, never disarming or holding ────────

test("W1-T2579 acceptance 6: a malformed band row (unrecognized verdict) leaves arm/reason untouched but names itself", () => {
  const malformed = [{ class: "full-pass", verdict: "disable" }] as unknown as ArmCalibrationBandRow[];
  const baseline = decideAutoMergeArm(fullPassVerdict(), false);
  const decision: ArmDecision = decideAutoMergeArm(fullPassVerdict(), false, undefined, undefined, malformed);
  assert.equal(decision.arm, baseline.arm);
  assert.equal(decision.reason, baseline.reason, "a malformed row must never perturb arm/reason — it is inert, not merely non-disarming");
  assert.ok(decision.bandWarning, "a malformed row that matched the resolved class must be NAMED, not silently dropped");
  assert.match(decision.bandWarning!, /full-pass/);
  assert.match(decision.bandWarning!, /malformed/i);
});

test("W1-T2579 acceptance 6: a malformed row for a DIFFERENT class than the one resolved has zero effect and no warning", () => {
  const malformed = [{ class: "keyword-floor", verdict: "bogus" }] as unknown as ArmCalibrationBandRow[];
  const baseline = decideAutoMergeArm(fullPassVerdict(), false);
  const decision = decideAutoMergeArm(fullPassVerdict(), false, undefined, undefined, malformed);
  assert.deepEqual(decision, baseline, "a row naming a class that never matches the resolved one must be indistinguishable from an empty table");
});
