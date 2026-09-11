import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import {
  classifyVerdictDrift,
  escalateVerdictCalibrationDrift,
  verdictCalibrationDriftLedgerLines,
  verdictCalibrationDriftProposalId,
  DEFAULT_DRIFT_BANDS,
  ATTRIBUTION_POLICY,
  MIN_POPULATION_FLOOR,
  type ClassOutcome,
  type VerdictCalibrationReport,
  type VerdictClass,
  type UnmeasurableCause,
} from "../src/lib/verdict-calibration.js";
import { parseProposalRegistry } from "../src/lib/inbox.js";
import { installPolicyPath } from "../src/lib/policy.js";
import { makeTempDir } from "../src/lib/tmp.js";

/**
 * test/a-calibration-drift-reaches-the-inbox.test.ts — W1-T3082.
 *
 * MASTER-PLAN's own "Verdict calibration" section says a periodic job "FILES TUNING TASKS when
 * calibration drifts". `verdictCalibrationReport` (verdict-calibration.ts) computed the rates
 * four times a day and nothing consumed drift. This shard proves the three things that changed:
 * (1) a class whose MEASURED rate exceeds its band raises exactly one inbox proposal per window,
 * naming the rate, the denominator and the members; (2) a class below the population floor never
 * drifts and the ledger evidence names the floor; (3) the bands themselves are policy rows with
 * bounds. The falsifier: remove the (class, window) dedup key and the SAME fixture run twice in
 * one window must raise two proposals instead of one — proven below by asserting a rerun over the
 * unchanged registry raises nothing new.
 */

function tmpStateDir(kind: string): string {
  return makeTempDir(kind);
}

const UNMEASURABLE_BY_CAUSE: Record<UnmeasurableCause, number> = {
  "no-head-sha": 0,
  "no-review-posted": 0,
  "merge-sha-unrecoverable": 0,
  "git-history-unavailable": 0,
};

function fixtureClass(overrides: Partial<ClassOutcome> & { verdictClass: VerdictClass }): ClassOutcome {
  return {
    total: 0,
    revertedCount: 0,
    followupFixedCount: 0,
    revertRate: null,
    followupFixRate: null,
    lanes: "none",
    taskIds: [],
    ...overrides,
  };
}

/** Every class defaults to an empty, below-floor bucket; `overrides` replaces named classes. */
function fixtureReport(overrides: Partial<Record<VerdictClass, ClassOutcome>>): VerdictCalibrationReport {
  const classes: ClassOutcome[] = (["full-pass", "keyword-floor", "degraded-arm"] as const).map(
    (verdictClass) => overrides[verdictClass] ?? fixtureClass({ verdictClass, rateRefusedReason: "below-population-floor" }),
  );
  return {
    policy: ATTRIBUTION_POLICY,
    minPopulationFloor: MIN_POPULATION_FLOOR,
    classes,
    unmeasurable: [],
    armsSeen: classes.reduce((sum, c) => sum + c.total, 0),
    armsClassified: classes.reduce((sum, c) => sum + c.total, 0),
    unmeasurableByCause: UNMEASURABLE_BY_CAUSE,
  };
}

// ── acceptance 1: a drifted class, at/above the floor, raises exactly one proposal per window ──

test("a class whose revert rate exceeds its band, at the population floor, drifts and names rate/denominator/members", () => {
  const taskIds = Array.from({ length: MIN_POPULATION_FLOOR }, (_, i) => `W1-T${100 + i}`);
  const report = fixtureReport({
    "keyword-floor": fixtureClass({
      verdictClass: "keyword-floor",
      total: MIN_POPULATION_FLOOR,
      revertedCount: 3,
      revertRate: 0.6, // > DEFAULT_DRIFT_BANDS["keyword-floor"].revertRateCeiling (0.15)
      followupFixRate: 0.1, // <= 0.25 — this class drifts on revert-rate only
      taskIds,
    }),
  });

  const classification = classifyVerdictDrift(report, DEFAULT_DRIFT_BANDS);
  assert.equal(classification.drifted.length, 1);
  assert.equal(classification.drifted[0].verdictClass, "keyword-floor");
  assert.deepEqual(classification.drifted[0].reasons, ["revert-rate"]);
  assert.equal(classification.withinBands.length, 2, "the other two classes are not drifted");

  const dir = tmpStateDir("calibration-drift");
  const registryPath = join(dir, "inbox-proposals.json");
  try {
    const window = "2026-09-11";
    const drafted = escalateVerdictCalibrationDrift(classification.drifted, window, registryPath);
    assert.ok(drafted, "a drifted class at the floor must draft a proposal");
    assert.equal(drafted!.length, 1);
    assert.equal(drafted![0].id, verdictCalibrationDriftProposalId("keyword-floor", window));
    // The rate, the denominator and the named members must all be readable off the proposal text.
    assert.match(drafted![0].summary, /60\.0%/, "the revert rate");
    assert.match(drafted![0].summary, new RegExp(`over ${MIN_POPULATION_FLOOR} measured`), "the denominator");
    for (const id of taskIds) {
      assert.ok(drafted![0].summary.includes(id), `member ${id} must be named in the proposal`);
    }

    assert.ok(existsSync(registryPath));
    const onDisk = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.equal(onDisk.length, 1, "exactly one proposal for this window");

    // FALSIFIER, made concrete: a rerun over the SAME window must never duplicate it — this is
    // exactly what breaks if the (class, window) dedup key is removed from the escalator.
    const second = escalateVerdictCalibrationDrift(classification.drifted, window, registryPath);
    assert.equal(second, null, "an already-open proposal for this (class, window) must never be re-drafted");
    const onDiskAfterRerun = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.equal(onDiskAfterRerun.length, 1, "still exactly one proposal per window, not two");

    // A LATER window is a DIFFERENT key — the same still-drifted class raises a fresh proposal
    // rather than being silently blocked by the first window's id (design: "goes stale when the
    // window moves"). `escalateVerdictCalibrationDrift` returns the WHOLE registry state after
    // the update (current + additions), the same contract `escalateRepeatingRules` uses, so this
    // now carries both windows' proposals.
    const third = escalateVerdictCalibrationDrift(classification.drifted, "2026-09-12", registryPath);
    assert.ok(third, "a new window must raise its own proposal");
    assert.deepEqual(
      third!.map((p) => p.id).sort(),
      [verdictCalibrationDriftProposalId("keyword-floor", "2026-09-11"), verdictCalibrationDriftProposalId("keyword-floor", "2026-09-12")].sort(),
    );
    const onDiskAfterNewWindow = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.equal(onDiskAfterNewWindow.length, 2, "one proposal per window, not collapsed across windows");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance 2: below the population floor, nothing is raised and the ledger names the floor ─

test("a class above its band but below the population floor raises nothing, and the ledger says within_bands naming the floor", () => {
  const belowFloorTotal = MIN_POPULATION_FLOOR - 1;
  const taskIds = Array.from({ length: belowFloorTotal }, (_, i) => `W1-T${200 + i}`);
  // This class's raw counts (2 of 4 reverted = 50%) would clear the keyword-floor band's 15%
  // ceiling if it had enough rows — but verdictCalibrationReport itself already refused the rate
  // (revertRate: null, rateRefusedReason set) because total < MIN_POPULATION_FLOOR. That refusal
  // must win: "below the floor is never drifted" (P48 — an anecdote is not a rate).
  const report = fixtureReport({
    "full-pass": fixtureClass({
      verdictClass: "full-pass",
      total: belowFloorTotal,
      revertedCount: 2,
      revertRate: null,
      followupFixRate: null,
      rateRefusedReason: "below-population-floor",
      taskIds,
    }),
  });

  const classification = classifyVerdictDrift(report, DEFAULT_DRIFT_BANDS);
  assert.equal(classification.drifted.length, 0, "a below-floor class must never be classified as drifted");
  const fullPassEntry = classification.withinBands.find((w) => w.verdictClass === "full-pass");
  assert.ok(fullPassEntry);
  assert.equal(fullPassEntry!.reason, "below-population-floor");
  assert.equal(fullPassEntry!.total, belowFloorTotal);

  const dir = tmpStateDir("calibration-nodrift");
  const registryPath = join(dir, "inbox-proposals.json");
  try {
    const drafted = escalateVerdictCalibrationDrift(classification.drifted, "2026-09-11", registryPath);
    assert.equal(drafted, null, "nothing measurable enough to drift must raise nothing");
    assert.equal(existsSync(registryPath), false, "no proposal registry write at all");

    const lines = verdictCalibrationDriftLedgerLines(classification, "2026-09-11", report.minPopulationFloor);
    const fullPassLine = lines.find((l) => l.verdict_class === "full-pass");
    assert.ok(fullPassLine, "the ledger must carry a row for the below-floor class");
    assert.equal(fullPassLine!.step, "verdict_calibration.within_bands");
    assert.equal(fullPassLine!.reason, "below-population-floor");
    assert.equal(fullPassLine!.population_floor, MIN_POPULATION_FLOOR, "the floor itself must be named");
    assert.equal(fullPassLine!.total, belowFloorTotal);

    // Every OTHER class (also below floor, by this fixture's defaults) gets its own within_bands
    // row too — one row per class, always, never omitted (P48).
    assert.equal(lines.filter((l) => l.step === "verdict_calibration.within_bands").length, 3);
    assert.equal(lines.filter((l) => l.step === "verdict_calibration.drift").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the DRIFT ledger row carries the rate, the denominator and the members — the within_bands rows never do", () => {
  // The suite already drives verdictCalibrationDriftLedgerLines over a classification with NOTHING
  // drifted, which exercises only the within_bands arm. The drifted arm — the row an operator
  // actually reads when a class goes out of band — had no caller at all, which is what
  // diff-coverage named. One classification with both arms populated covers the pair.
  const taskIds = Array.from({ length: MIN_POPULATION_FLOOR }, (_, i) => `W1-T${200 + i}`);
  const report = fixtureReport({
    "keyword-floor": fixtureClass({
      verdictClass: "keyword-floor",
      total: MIN_POPULATION_FLOOR,
      revertedCount: 3,
      revertRate: 0.6, // > the band's 0.15 revert ceiling
      followupFixRate: 0.1,
      taskIds,
    }),
  });
  const classification = classifyVerdictDrift(report, DEFAULT_DRIFT_BANDS);
  assert.equal(classification.drifted.length, 1, "control: the fixture must actually drift one class");

  const lines = verdictCalibrationDriftLedgerLines(classification, "2026-09-11", report.minPopulationFloor);
  const drift = lines.find((l) => l.step === "verdict_calibration.drift");
  assert.ok(drift, "a drifted class must get its own drift row");
  assert.equal(drift!.verdict_class, "keyword-floor");
  assert.equal(drift!.window, "2026-09-11");
  assert.equal(drift!.total, MIN_POPULATION_FLOOR, "the denominator travels with the row");
  assert.equal(drift!.revert_rate, 0.6, "the rate that broke the band");
  assert.equal(drift!.followup_fix_rate, 0.1);
  assert.deepEqual(drift!.reasons, ["revert-rate"]);
  assert.deepEqual(drift!.task_ids, taskIds, "the members, so the row is checkable without re-deriving it");

  // ONE ROW PER CLASS, ALWAYS: the two undrifted classes still report, and a drift row must not
  // carry the floor field that only a below-floor within_bands row earns.
  assert.equal(lines.length, 3);
  assert.equal(lines.filter((l) => l.step === "verdict_calibration.within_bands").length, 2);
  assert.equal(drift!.population_floor, undefined, "the floor belongs to below-floor rows, not drift rows");
});

test("a genuinely clean measured pass (population at the floor, rate within its band) reports within-bands, not below-population-floor", () => {
  const report = fixtureReport({
    "degraded-arm": fixtureClass({
      verdictClass: "degraded-arm",
      total: MIN_POPULATION_FLOOR,
      revertedCount: 0,
      revertRate: 0.0,
      followupFixRate: 0.0,
      taskIds: ["W1-T300", "W1-T301", "W1-T302", "W1-T303", "W1-T304"],
    }),
  });
  const classification = classifyVerdictDrift(report, DEFAULT_DRIFT_BANDS);
  assert.equal(classification.drifted.length, 0);
  const entry = classification.withinBands.find((w) => w.verdictClass === "degraded-arm");
  assert.equal(entry!.reason, "within-bands");
});

// ── acceptance 3: the drift bands are policy rows, with bounds ─────────────────────────────────

test("driftBands are policy rows with bounds in plan/policy.yaml", () => {
  const raw = readFileSync(installPolicyPath(), "utf8");
  assert.match(raw, /driftBands:/, "grep: driftBands in plan/policy.yaml");

  const doc = parseYaml(raw) as Record<string, unknown>;
  const verdictCalibration = doc.verdictCalibration as { driftBands?: Record<string, unknown> } | undefined;
  assert.ok(verdictCalibration?.driftBands, "verdictCalibration.driftBands must be a mapping");
  for (const verdictClass of ["full-pass", "keyword-floor", "degraded-arm"] as const) {
    const row = (verdictCalibration!.driftBands as Record<string, unknown>)[verdictClass] as
      | Record<string, { value: number; min: number; max: number }>
      | undefined;
    assert.ok(row, `driftBands must carry a ${verdictClass} row`);
    for (const field of ["revertRateCeiling", "followupFixRateCeiling"] as const) {
      const cell: { value: number; min: number; max: number } = row![field];
      assert.equal(typeof cell.value, "number");
      assert.equal(typeof cell.min, "number");
      assert.equal(typeof cell.max, "number");
      assert.ok(cell.min <= cell.value && cell.value <= cell.max, `${verdictClass}.${field} must sit within its own [min, max]`);
    }
  }
});

test("DEFAULT_DRIFT_BANDS mirrors the shipped policy's numbers, per class", () => {
  const doc = parseYaml(readFileSync(installPolicyPath(), "utf8")) as {
    verdictCalibration: { driftBands: Record<string, { revertRateCeiling: { value: number }; followupFixRateCeiling: { value: number } }> };
  };
  for (const verdictClass of ["full-pass", "keyword-floor", "degraded-arm"] as const) {
    const shipped = doc.verdictCalibration.driftBands[verdictClass];
    assert.equal(DEFAULT_DRIFT_BANDS[verdictClass].revertRateCeiling, shipped.revertRateCeiling.value);
    assert.equal(DEFAULT_DRIFT_BANDS[verdictClass].followupFixRateCeiling, shipped.followupFixRateCeiling.value);
  }
});
