import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildMeasurementCadenceRow, type MeasurementCadenceRunResult } from "../src/lib/measurement-cadence.js";

// ── W1-T2502 — THE CADENCE LOG ROW WAS HAND-MAINTAINED, SO A NEW MEMBER WAS SILENTLY DROPPED
// UNTIL SOMEBODY NOTICED. MeasurementCadenceRunResult carries eight members; the daemon's
// `measurement_cadence.ran` row named only four (`rule_efficacy`, `verdict_calibration`,
// `autonomy_rate`, `adoption_mint`) by hand. `adoptionReport`, and independently
// `proofDebtReport`/`proofDebtMint`, reached zero occurrences in daemon.ts this way — W1-T2473
// fixed the `adoptionMint` instance two days earlier without generalising it. This file proves
// `buildMeasurementCadenceRow` (measurement-cadence.ts) derives the row from `result`'s own keys
// instead, and that daemon.ts's `measurement_cadence.ran` call site actually uses it — the eight
// acceptance criteria on this task's own shard, in that order.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sentinelResult(overrides: Partial<MeasurementCadenceRunResult> = {}): MeasurementCadenceRunResult {
  return {
    ruleEfficacy: "SENTINEL_ruleEfficacy",
    verdictCalibration: "SENTINEL_verdictCalibration",
    autonomyRate: "SENTINEL_autonomyRate",
    adoptionReport: "SENTINEL_adoptionReport",
    adoptionMint: "SENTINEL_adoptionMint",
    boardReview: "SENTINEL_boardReview",
    proofDebtReport: "SENTINEL_proofDebtReport",
    proofDebtMint: "SENTINEL_proofDebtMint",
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as MeasurementCadenceRunResult;
}

// ── acceptance 1 & 5: every member the result carries is named, and the four pre-existing keys
// keep their exact spelling ──────────────────────────────────────────────────────────────────

test("every member the result carries is named on the row", () => {
  const result = sentinelResult();
  const row = buildMeasurementCadenceRow(result);
  assert.equal(row.rule_efficacy, "SENTINEL_ruleEfficacy");
  assert.equal(row.verdict_calibration, "SENTINEL_verdictCalibration");
  assert.equal(row.autonomy_rate, "SENTINEL_autonomyRate");
  assert.equal(row.adoption_report, "SENTINEL_adoptionReport");
  assert.equal(row.adoption_mint, "SENTINEL_adoptionMint");
  assert.equal(row.proof_debt_report, "SENTINEL_proofDebtReport");
  assert.equal(row.proof_debt_mint, "SENTINEL_proofDebtMint");
});

test("the four members named before this task keep their existing key names", () => {
  const row = buildMeasurementCadenceRow(sentinelResult());
  // Pre-W1-T2502, daemon.ts hand-named exactly these four keys on the row — a rename here would
  // break every existing consumer of the ledger just as silently as a drop would.
  assert.deepEqual(
    ["rule_efficacy", "verdict_calibration", "autonomy_rate", "adoption_mint"].every((k) => k in row),
    true,
  );
  assert.equal(row.rule_efficacy, "SENTINEL_ruleEfficacy");
  assert.equal(row.verdict_calibration, "SENTINEL_verdictCalibration");
  assert.equal(row.autonomy_rate, "SENTINEL_autonomyRate");
  assert.equal(row.adoption_mint, "SENTINEL_adoptionMint");
});

// ── acceptance 3: an absent optional member is distinguishable from one present and undefined ──

test("an absent optional member never appears on the row at all", () => {
  // adoptionReport/adoptionMint/boardReview/proofDebtReport/proofDebtMint are optional on the
  // TYPE ONLY (the producer itself never omits them) — this is the shape of a hand-built test
  // double authored before one of those fields existed, which still type-checks.
  const minimal = {
    ruleEfficacy: "SENTINEL_ruleEfficacy",
    verdictCalibration: "SENTINEL_verdictCalibration",
    autonomyRate: "SENTINEL_autonomyRate",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as MeasurementCadenceRunResult;
  const row = buildMeasurementCadenceRow(minimal);
  assert.equal("adoption_report" in row, false, "a truly absent key must not appear on the row at all");
  assert.equal(Object.prototype.hasOwnProperty.call(row, "adoption_report"), false);
});

test("a member present and explicitly undefined is distinguishable from one absent", () => {
  const withExplicitUndefined = sentinelResult({ adoptionReport: undefined });
  const row = buildMeasurementCadenceRow(withExplicitUndefined);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "adoption_report"), true, "an explicit undefined must still land on the row");
  assert.equal(row.adoption_report, undefined);
});

// ── acceptance 4: a member already reported by its own row is not duplicated ────────────────────

test("boardReview is never duplicated onto this row — it already has its own board_review.* log family", () => {
  const row = buildMeasurementCadenceRow(sentinelResult({ boardReview: "SENTINEL_boardReview" as never }));
  assert.equal("board_review" in row, false);
  assert.equal("boardReview" in row, false);
});

// ── acceptance 7: a failure building the row never prevents the cadence from running ────────────

test("buildMeasurementCadenceRow never throws — a hostile result yields a fallback row, not a propagated error", () => {
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("boom: cannot enumerate this result");
      },
    },
  ) as unknown as MeasurementCadenceRunResult;
  const row = buildMeasurementCadenceRow(hostile);
  assert.ok(typeof row.row_build_failed === "string" && row.row_build_failed.includes("boom"));
});

test("runDaemon still logs measurement_cadence.ran (not run_failed) when building the row throws internally", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-cadence-row-hostile-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let stopChecks = 0;
    let runs = 0;
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("boom: cannot enumerate this result");
        },
      },
    ) as unknown as MeasurementCadenceRunResult;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      checkMeasurementCadence: () => ({ fire: true, reason: "first run" }),
      runMeasurementCadence: async () => {
        runs++;
        return hostile;
      },
    });
    assert.ok(runs >= 1, "the cadence itself must actually run — the result was produced");
    assert.ok(
      lines.some((l) => l.step === "measurement_cadence.ran"),
      "a row-build failure must not be mistaken for a run failure — the cadence DID run",
    );
    assert.equal(
      lines.some((l) => l.step === "measurement_cadence.run_failed"),
      false,
      "the cadence itself never threw, so run_failed must never be logged",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance 2 & 8: a member added to the result appears in the row without editing the row,
// and reverting to a hand-enumerated row would make that same assertion fail ────────────────────

test("a brand-new member added to the result is named on the daemon's logged row with zero edits to the row itself", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-cadence-row-new-member-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let stopChecks = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      checkMeasurementCadence: () => ({ fire: true, reason: "first run" }),
      runMeasurementCadence: async () => {
        // A hypothetical NINTH member — added to the result the same way any future verb would
        // be — that neither this test file nor daemon.ts has ever named by hand.
        const withFutureMember = {
          ruleEfficacy: "SENTINEL_ruleEfficacy",
          verdictCalibration: "SENTINEL_verdictCalibration",
          autonomyRate: "SENTINEL_autonomyRate",
          futureVerbOutcome: "SENTINEL_futureVerbOutcome",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any as MeasurementCadenceRunResult;
        return withFutureMember;
      },
    });
    const ran = lines.find((l) => l.step === "measurement_cadence.ran");
    assert.ok(ran, "the cadence must still log a .ran row");
    // A hand-enumerated row (the pre-W1-T2502 shape: rule_efficacy/verdict_calibration/
    // autonomy_rate/adoption_mint typed out by hand at the call site) CANNOT contain a key it was
    // never told to name — so this assertion is also the proof for acceptance 8: reverting
    // daemon.ts's call site back to that hand-enumerated object literal makes this line fail.
    assert.equal(ran!.extra.future_verb_outcome, "SENTINEL_futureVerbOutcome");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance 6: what the cadence runs and when it fires are unchanged ─────────────────────────

test("a FIRING decision still runs the cadence exactly once and logs fired then ran, unchanged", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-cadence-row-fire-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let stopChecks = 0;
    let runs = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      checkMeasurementCadence: () => ({ fire: true, reason: "first run" }),
      runMeasurementCadence: async () => {
        runs++;
        return sentinelResult();
      },
    });
    assert.equal(runs, 1, "a firing decision must run the cadence exactly once — unchanged by this task");
    assert.deepEqual(
      lines.filter((l) => l.step.startsWith("measurement_cadence")).map((l) => l.step),
      ["measurement_cadence.fired", "measurement_cadence.ran"],
    );
    assert.equal(lines.find((l) => l.step === "measurement_cadence.fired")!.extra.reason, "first run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a REFUSING decision never runs the cadence and logs only skipped, unchanged", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-cadence-row-skip-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let stopChecks = 0;
    let runs = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      checkMeasurementCadence: () => ({ fire: false, reason: "only 5.0m since the last run (minInterval 360m)" }),
      runMeasurementCadence: async () => {
        runs++;
        return sentinelResult();
      },
    });
    assert.equal(runs, 0, "a refusing decision must never invoke the runner — unchanged by this task");
    assert.deepEqual(
      lines.filter((l) => l.step.startsWith("measurement_cadence")).map((l) => l.step),
      ["measurement_cadence.skipped"],
    );
    assert.equal(lines.find((l) => l.step === "measurement_cadence.skipped")!.extra.reason, "only 5.0m since the last run (minInterval 360m)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
