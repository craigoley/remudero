// test/a-chronic-evidence-gap-is-still-a-gap.test.ts — W1-T4640: a chronic evidence gap is still a gap.
//
// Acceptance (plan/tasks.d/W1-T4640-a-chronic-evidence-gap-is-still-a-gap.yaml):
//   - a lane-field whose coverage sits below the absolute floor is filed as a gap even when it
//     never dropped, and a sub-floor reading never becomes the baseline
//
// Falsifier replayed below: escalation-summary at 0.19% assignment coverage was adopted as its
// healthy baseline on the first pass and never filed. Every test writes only under its own
// mkdtemp root; the clock is the Clock port, and every fixture instant is relative to it.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { systemClock, type Clock } from "../src/lib/clock.js";
import {
  EVIDENCE_COVERAGE_DROP_TOLERANCE,
  EVIDENCE_COVERAGE_FIELDS,
  EVIDENCE_COVERAGE_FLOORS,
  EVIDENCE_COVERAGE_JOIN_FLOOR,
  EVIDENCE_COVERAGE_MEASURED_FLOOR,
  EVIDENCE_COVERAGE_MIN_DENOMINATOR,
  EVIDENCE_COVERAGE_PASS_INTERVAL_MS,
  evidenceCoverageStatePath,
  judgeCoverageCell,
  runEvidenceCoverageGardener,
  type EvidenceCoverageFollowup,
  type EvidenceCoverageInput,
} from "../src/lib/evidence-coverage-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

type Row = Record<string, unknown>;

const T0 = systemClock.now();
const ROW_TS = new Date(T0 - 60 * 60 * 1000).toISOString();

function clockAt(ref: { t: number }): Clock {
  return { now: () => ref.t, date: () => new Date(ref.t), iso: () => new Date(ref.t).toISOString() };
}

function assignment(lane: string, id: string): Row {
  return {
    ts: ROW_TS,
    step: "worker.assignment",
    lane,
    run_id: `run-${id}`,
    worker_assignment: { id, requested: { model: "sonnet" }, selected: { provider: "anthropic", model: "claude-x" } },
  };
}

function attempt(lane: string, id: string, served: boolean): Row {
  return {
    ts: ROW_TS,
    step: "worker.attempt",
    lane,
    run_id: `run-${id}`,
    selection_assignment_id: id,
    success: true,
    ...(served ? { served_model: "claude-x" } : {}),
    tokens: { input: 10, output: 20 },
    total_cost_usd: 0.01,
  };
}

/** A lane with `joined` assignment+attempt pairs (the first `unserved` carry no served model),
 *  `pending` assignments with no terminal, and `orphans` terminals carrying no assignment id. */
function lane(name: string, shape: { joined: number; unserved?: number; pending?: number; orphans?: number }): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < shape.joined; i += 1) {
    rows.push(assignment(name, `${name}-j${i}`), attempt(name, `${name}-j${i}`, i >= (shape.unserved ?? 0)));
  }
  for (let i = 0; i < (shape.pending ?? 0); i += 1) rows.push(assignment(name, `${name}-p${i}`));
  for (let i = 0; i < (shape.orphans ?? 0); i += 1) rows.push({ ts: ROW_TS, step: "worker.attempt", lane: name, run_id: `run-${name}-o${i}` });
  return rows;
}

function harness() {
  const ref = { t: T0 };
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}chronic-evidence-gap-`));
  const rows: { current: Row[] } = { current: [] };
  const filed: EvidenceCoverageFollowup[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps: EvidenceCoverageInput = {
    stateDir,
    readRows: () => ({ ok: true, rows: rows.current }),
    file: (followup) => {
      filed.push(followup);
    },
    log: (step, extra) => logs.push({ step, extra }),
    clock: clockAt(ref),
  };
  const state = () => JSON.parse(readFileSync(evidenceCoverageStatePath(stateDir), "utf8"));
  return {
    ref, stateDir, rows, filed, logs, state,
    pass: () => runEvidenceCoverageGardener(deps),
    advance: () => {
      ref.t += EVIDENCE_COVERAGE_PASS_INTERVAL_MS;
    },
  };
}

// The measured live state (evidence-coverage-gardener.json, 2026-09-27): each of these was baselined as healthy.
const OTHER_BROKEN_LANES: Row[] = [
  ...lane("verify-human-judge", { joined: 1, orphans: 28 }), // assignment 1/29 = 3.4%
  ...lane("run-task", { joined: 50, unserved: 26, pending: 120 }), // served model 24/50 = 48%, outcome 50/170 = 29%
];
const MEASURED_BROKEN_LANES: Row[] = [
  ...lane("escalation-summary", { joined: 1, orphans: 530 }), // assignment 1/531 = 0.19%
  ...OTHER_BROKEN_LANES,
];

// ── the acceptance criterion ────────────────────────────────────────────────────────────────

test("a lane-field below the absolute floor on its FIRST pass is filed as a below-floor gap with its ratio and denominator, never adopted as a baseline", () => {
  const h = harness();
  h.rows.current = MEASURED_BROKEN_LANES;
  const result = h.pass();
  assert.deepEqual(
    result.gaps.map((g) => `${g.lane}/${g.field}/${g.kind}`),
    ["escalation-summary/assignment/below-floor", "run-task/outcome/below-floor", "run-task/servedModel/below-floor", "verify-human-judge/assignment/below-floor"],
  );
  assert.deepEqual(result.filed, [
    "evidence-coverage-escalation-summary-assignment",
    "evidence-coverage-run-task-outcome",
    "evidence-coverage-run-task-served-model",
    "evidence-coverage-verify-human-judge-assignment",
  ]);
  const escalation = h.filed[0];
  assert.equal(escalation.action, "file");
  assert.match(escalation.raw, /lane `escalation-summary`, field `assignment`/);
  assert.match(escalation.raw, /1\/531 terminal worker results .* \(0\.2%\)/);
  assert.match(escalation.raw, /below the field's 80\.0% floor/);
  assert.match(escalation.raw, /never gates a PR/);
  assert.match(h.filed[2].raw, /24\/50 joined worker calls \(48\.0%\).*below the field's 90\.0% floor/);
  const gap = result.gaps[0];
  assert.equal(gap.observed, 1);
  assert.equal(gap.denominator, 531);
  assert.equal(gap.floor, EVIDENCE_COVERAGE_JOIN_FLOOR);
  assert.equal(gap.baseline, undefined);

  const cells = h.state().cells;
  for (const key of ["escalation-summary/assignment", "verify-human-judge/assignment", "run-task/servedModel", "run-task/outcome"]) {
    assert.equal(cells[key].baseline, undefined, `${key}: a sub-floor reading never becomes the baseline`);
    assert.equal(cells[key].gap.kind, "below-floor");
  }
  assert.equal(cells["run-task/assignment"].baseline, 1, "the lane's healthy fields still baseline");
});

test("a persisting sub-floor gap never refreshes a baseline and is not re-filed while its reading holds", () => {
  const h = harness();
  h.rows.current = MEASURED_BROKEN_LANES;
  const first = h.pass();
  const firstSeen = first.gaps[0].firstSeenAt;
  h.advance();
  const second = h.pass();
  assert.equal(second.gaps.length, 4, "the chronic gaps are still reported");
  assert.deepEqual(second.filed, []);
  assert.deepEqual(second.updated, []);
  assert.equal(second.gaps[0].firstSeenAt, firstSeen);
  assert.equal(h.state().cells["escalation-summary/assignment"].baseline, undefined);

  h.advance();
  h.rows.current = [...lane("escalation-summary", { joined: 3, orphans: 530 }), ...OTHER_BROKEN_LANES];
  const third = h.pass();
  assert.deepEqual(third.updated, ["evidence-coverage-escalation-summary-assignment"], "a moved reading updates the same follow-up");
  assert.equal(h.state().cells["escalation-summary/assignment"].baseline, undefined);
});

test("a stored sub-floor baseline is discarded on read, so the lane is judged against the floor and filed", () => {
  const h = harness();
  const earlier = new Date(T0 - 2 * EVIDENCE_COVERAGE_PASS_INTERVAL_MS).toISOString();
  mkdirSync(h.stateDir, { recursive: true });
  writeFileSync(
    evidenceCoverageStatePath(h.stateDir),
    JSON.stringify({
      version: 1,
      lastPassAt: earlier,
      cells: {
        "escalation-summary/assignment": { baseline: 0.0018832391713747645, baselineAt: earlier },
        "run-task/servedModel": { baseline: 0.4779874213836478, baselineAt: earlier },
        "fix/servedModel": { baseline: 1, baselineAt: earlier },
        "legacy/unknownField": { baseline: 0.01, baselineAt: earlier },
      },
    }),
  );
  h.rows.current = [...lane("escalation-summary", { joined: 1, orphans: 530 }), ...lane("run-task", { joined: 50, unserved: 26 })];
  const result = h.pass();
  const discarded = h.logs.find((l) => l.step === "evidence_coverage.baseline_discarded");
  assert.deepEqual(discarded?.extra?.cells, ["escalation-summary/assignment", "run-task/servedModel"]);
  assert.deepEqual(
    result.gaps.map((g) => `${g.lane}/${g.field}/${g.kind}`),
    ["escalation-summary/assignment/below-floor", "run-task/servedModel/below-floor"],
    "both readings are judged against the floor alone",
  );
  const cells = h.state().cells;
  assert.equal(cells["escalation-summary/assignment"].baseline, undefined);
  assert.equal(cells["escalation-summary/assignment"].baselineAt, undefined);
  assert.equal(cells["fix/servedModel"].baseline, 1, "an above-floor baseline is kept");
  assert.equal(cells["legacy/unknownField"].baseline, 0.01, "a cell naming no required field has no floor to fall under");
});

test("a pass that is not due discards nothing and logs nothing about baselines", () => {
  const h = harness();
  mkdirSync(h.stateDir, { recursive: true });
  writeFileSync(
    evidenceCoverageStatePath(h.stateDir),
    JSON.stringify({ version: 1, lastPassAt: new Date(T0).toISOString(), cells: { "x/assignment": { baseline: 0.1 } } }),
  );
  assert.equal(h.pass().skipped, "not-due");
  assert.equal(h.logs.some((l) => l.step === "evidence_coverage.baseline_discarded"), false);
  assert.equal(h.state().cells["x/assignment"].baseline, 0.1, "the state file is untouched until a pass runs");
});

// ── an above-floor lane behaves as before ───────────────────────────────────────────────────

test("an above-floor lane still baselines when healthy, files below-baseline on a drop that stays above the floor, and files absent at zero", () => {
  const h = harness();
  h.rows.current = lane("fix", { joined: 30 });
  const healthy = h.pass();
  assert.deepEqual(healthy.gaps, []);
  assert.equal(h.state().cells["fix/outcome"].baseline, 1);

  h.advance();
  h.rows.current = lane("fix", { joined: 30, pending: 5 }); // outcome 30/35 = 85.7%: above the join floor, a drop past tolerance
  const dropped = h.pass();
  assert.deepEqual(dropped.gaps.map((g) => `${g.lane}/${g.field}/${g.kind}`), ["fix/outcome/below-baseline"]);
  assert.match(h.filed[0].raw, /trailing baseline 100\.0%/);
  assert.equal(h.state().cells["fix/outcome"].baseline, 1, "the baseline is held while the gap is open");

  h.advance();
  h.rows.current = lane("fix", { joined: 30, unserved: 30 });
  const absent = h.pass();
  assert.deepEqual(absent.gaps.map((g) => `${g.lane}/${g.field}/${g.kind}`), ["fix/servedModel/absent"]);
  assert.ok(h.logs.some((l) => l.step === "evidence_coverage.recovered" && l.extra?.field === "outcome"));
});

test("judgeCoverageCell: the floor adds below-floor without changing absent, below-baseline or healthy", () => {
  const floor = EVIDENCE_COVERAGE_JOIN_FLOOR;
  assert.deepEqual(judgeCoverageCell({ observed: 0, denominator: 40 }, 1, floor), { kind: "gap", gap: "absent" });
  assert.deepEqual(judgeCoverageCell({ observed: 34, denominator: 40 }, 1, floor), { kind: "gap", gap: "below-baseline" });
  assert.deepEqual(judgeCoverageCell({ observed: 10, denominator: 40 }, 1, floor), { kind: "gap", gap: "below-baseline" }, "a drop from a healthy baseline keeps its more specific name");
  assert.deepEqual(judgeCoverageCell({ observed: 39, denominator: 40 }, 1, floor), { kind: "healthy", ratio: 39 / 40 });
  assert.deepEqual(judgeCoverageCell({ observed: 32, denominator: 40 }, undefined, floor), { kind: "healthy", ratio: 0.8 }, "exactly the floor is healthy");
  assert.deepEqual(judgeCoverageCell({ observed: 31, denominator: 40 }, undefined, floor), { kind: "gap", gap: "below-floor" });
  assert.ok(0.85 - EVIDENCE_COVERAGE_DROP_TOLERANCE < 31 / 40, "the fixture below sits within tolerance of its baseline");
  assert.deepEqual(judgeCoverageCell({ observed: 31, denominator: 40 }, 0.85, floor), { kind: "gap", gap: "below-floor" }, "under the floor is a gap whatever the baseline");
  assert.deepEqual(judgeCoverageCell({ observed: 1, denominator: 531 }, 0.0018832391713747645, floor), { kind: "gap", gap: "below-floor" });
  assert.deepEqual(judgeCoverageCell({ observed: 1, denominator: 531 }, undefined), { kind: "healthy", ratio: 1 / 531 }, "with no floor passed the old behaviour stands");
});

// ── insufficient is unchanged ───────────────────────────────────────────────────────────────

test("a thin lane stays insufficient even under the floor, files nothing and writes no baseline", () => {
  assert.deepEqual(judgeCoverageCell({ observed: 1, denominator: EVIDENCE_COVERAGE_MIN_DENOMINATOR - 1 }, undefined, EVIDENCE_COVERAGE_JOIN_FLOOR), { kind: "insufficient" });
  const h = harness();
  h.rows.current = lane("thin", { joined: 1, orphans: EVIDENCE_COVERAGE_MIN_DENOMINATOR - 2 });
  const result = h.pass();
  assert.deepEqual(result.gaps, []);
  assert.equal(h.filed.length, 0);
  assert.ok(result.insufficient.some((c) => c.lane === "thin" && c.field === "assignment" && c.denominator === EVIDENCE_COVERAGE_MIN_DENOMINATOR - 1));
  assert.equal(h.state().cells["thin/assignment"], undefined);
});

// ── the calibration ─────────────────────────────────────────────────────────────────────────

test("every required field has a floor, and the floors separate the measured broken lanes from the measured healthy ones", () => {
  for (const field of EVIDENCE_COVERAGE_FIELDS) assert.equal(typeof EVIDENCE_COVERAGE_FLOORS[field], "number", field);
  assert.equal(EVIDENCE_COVERAGE_FLOORS.assignment, EVIDENCE_COVERAGE_JOIN_FLOOR);
  assert.equal(EVIDENCE_COVERAGE_FLOORS.outcome, EVIDENCE_COVERAGE_JOIN_FLOOR);
  for (const field of ["servedModel", "tokens", "cost"] as const) assert.equal(EVIDENCE_COVERAGE_FLOORS[field], EVIDENCE_COVERAGE_MEASURED_FLOOR);
  // Joins: in-flight rows depress a healthy join by up to a drop tolerance.
  for (const broken of [0.0019, 0.034, 0.29, 0.68]) assert.ok(broken < EVIDENCE_COVERAGE_JOIN_FLOOR, `join ${broken}`);
  for (const healthy of [0.91, 0.99, 1]) assert.ok(healthy >= EVIDENCE_COVERAGE_JOIN_FLOOR + EVIDENCE_COVERAGE_DROP_TOLERANCE - 0.01, `join ${healthy}`);
  // Measured fields are judged over joined calls, which no in-flight row depresses.
  assert.ok(0.48 < EVIDENCE_COVERAGE_MEASURED_FLOOR);
  for (const healthy of [0.93, 0.95, 1]) assert.ok(healthy >= EVIDENCE_COVERAGE_MEASURED_FLOOR, `measured ${healthy}`);
});
