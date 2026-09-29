// test/the-strike-schedule-follows-measured-pass-rates.test.ts — W1-T4671: the "two sonnet
// strikes, then opus" ladder is fixed for every shape today. Every case here is pure: no ledger,
// no worker spawn, no mount load — see lib/strike-schedule.ts's own module doc for why no ledger
// read lives there.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANDIDATE_CHEAP_STRIKE_BUDGETS,
  DEFAULT_CHEAP_STRIKE_BUDGET,
  MIN_ROWS_FOR_SIGNAL,
  OPUS_WINDOW_COST_MULTIPLIER,
  expectedWindowsForSchedule,
  measureStrikePassRates,
  strikeScheduleFor,
  type StrikePassRate,
  type StrikePassRow,
} from "../src/lib/strike-schedule.js";
import { taskShapeKey } from "../src/lib/parallel-attempts.js";

const RISKY_SHAPE_TASK = { risk: "high" as const, files: ["src/lib/sweep.ts"] };

function rowsForShape(
  shape: string,
  strikeNumber: 1 | 2,
  opts: { n: number; passN: number },
): StrikePassRow[] {
  const rows: StrikePassRow[] = [];
  for (let i = 0; i < opts.n; i++) {
    rows.push({ shape, strikeNumber, passed: i < opts.passN });
  }
  return rows;
}

test("W1-T4671: a shape whose cheap strikes rarely pass steps up sooner", () => {
  const shape = taskShapeKey(RISKY_SHAPE_TASK);
  // 20 rows of sonnet strike 1, only 2/20 pass (10%): cheap strikes rarely pay off here, and
  // opus costs OPUS_WINDOW_COST_MULTIPLIER windows against 1 for cheap — the expected-window-cost
  // minimum should therefore be BELOW the default two-strike schedule.
  const rows = rowsForShape(shape, 1, { n: 20, passN: 2 });
  const rates = measureStrikePassRates(rows);
  const schedule = strikeScheduleFor({ task: RISKY_SHAPE_TASK, rates });
  assert.equal(schedule.shape, shape);
  assert.ok(
    schedule.cheapStrikeBudget < DEFAULT_CHEAP_STRIKE_BUDGET,
    `expected a shorter-than-default schedule, got ${schedule.cheapStrikeBudget}`,
  );
  assert.match(schedule.reason, /steps-up-sooner/);
});

test("W1-T4671: a shape without evidence keeps the cheap-first schedule", () => {
  const shape = taskShapeKey(RISKY_SHAPE_TASK);
  const emptyRates = measureStrikePassRates([]);
  const schedule = strikeScheduleFor({ task: RISKY_SHAPE_TASK, rates: emptyRates });
  assert.equal(schedule.shape, shape);
  assert.equal(schedule.cheapStrikeBudget, DEFAULT_CHEAP_STRIKE_BUDGET);
  assert.equal(schedule.reason, "shape-unmeasured-cheap-first-default");

  // Fewer rows than MIN_ROWS_FOR_SIGNAL is UNMEASURED even with a striking rate: never a guess
  // dressed as a measurement.
  const sparseRows = rowsForShape(shape, 1, { n: MIN_ROWS_FOR_SIGNAL - 1, passN: 0 });
  const sparseRates = measureStrikePassRates(sparseRows);
  const sparseSchedule = strikeScheduleFor({ task: RISKY_SHAPE_TASK, rates: sparseRates });
  assert.equal(sparseSchedule.cheapStrikeBudget, DEFAULT_CHEAP_STRIKE_BUDGET);
  assert.equal(sparseSchedule.reason, "shape-unmeasured-cheap-first-default");
});

test("W1-T4671: a shape whose cheap strikes usually pass earns another cheap strike", () => {
  const shape = taskShapeKey(RISKY_SHAPE_TASK);
  // 20 rows of sonnet strike 1, 18/20 pass (90%): cheap strikes usually clear it here, so the
  // expected-window-cost minimum should extend PAST the default two-strike schedule.
  const rows = rowsForShape(shape, 1, { n: 20, passN: 18 });
  const rates = measureStrikePassRates(rows);
  const schedule = strikeScheduleFor({ task: RISKY_SHAPE_TASK, rates });
  assert.ok(
    schedule.cheapStrikeBudget > DEFAULT_CHEAP_STRIKE_BUDGET,
    `expected a longer-than-default schedule, got ${schedule.cheapStrikeBudget}`,
  );
  assert.match(schedule.reason, /earns-another-cheap-strike/);
});

test("W1-T4671: measureStrikePassRates reduces rows per shape and strike position", () => {
  const shapeA = "high:1-file";
  const shapeB = "low:2-3-file";
  const rows: StrikePassRow[] = [
    ...rowsForShape(shapeA, 1, { n: 10, passN: 3 }),
    ...rowsForShape(shapeA, 2, { n: 5, passN: 5 }),
    ...rowsForShape(shapeB, 1, { n: 4, passN: 4 }),
  ];
  const rates = measureStrikePassRates(rows);
  const a1 = rates.get(`${shapeA}::1`) as StrikePassRate;
  const a2 = rates.get(`${shapeA}::2`) as StrikePassRate;
  const b1 = rates.get(`${shapeB}::1`) as StrikePassRate;
  assert.equal(a1.rows, 10);
  assert.equal(a1.passRate, 0.3);
  assert.equal(a2.rows, 5);
  assert.equal(a2.passRate, 1);
  assert.equal(b1.rows, 4);
  assert.equal(b1.passRate, 1);
});

test("W1-T4671: a trusted strike-2 measurement is actually incorporated, not just strike-1", () => {
  // W1-T4671 follow-up (round 2): no prior case in this file gave BOTH strike positions enough
  // rows to be trusted, so a regression that dropped rate2 on the floor (e.g. `positions` always
  // resolving to `[rate1.passRate]`) could not have been caught here. This is the falsifier: strike
  // 1 passes almost always (95%), which — considered ALONE — makes a longer schedule the
  // cost-minimizing answer (a near-certain first strike makes the eventual opus cost rare either
  // way, so the tie-break favors trying more cheap strikes). But strike 2 almost never passes once
  // strike 1 has already failed (10%), which correctly reverses that conclusion: extending past the
  // default no longer pays, because the extra cheap strike it would buy is a strike that rarely
  // clears. If rate2 were silently ignored, this shape would wrongly earn a longer schedule instead.
  const shape = taskShapeKey(RISKY_SHAPE_TASK);
  const rows = [
    ...rowsForShape(shape, 1, { n: 20, passN: 19 }),
    ...rowsForShape(shape, 2, { n: 20, passN: 2 }),
  ];
  const rates = measureStrikePassRates(rows);
  assert.equal(rates.get(`${shape}::2`)?.rows, 20, "strike 2 has enough rows to be trusted");
  const schedule = strikeScheduleFor({ task: RISKY_SHAPE_TASK, rates });
  assert.ok(
    schedule.cheapStrikeBudget <= DEFAULT_CHEAP_STRIKE_BUDGET,
    `expected the poor strike-2 rate to hold the schedule at or below default, got ${schedule.cheapStrikeBudget}`,
  );
  assert.doesNotMatch(
    schedule.reason,
    /earns-another-cheap-strike/,
    "a 95% strike-1 rate ALONE would extend the schedule; the trusted 10% strike-2 rate must override that",
  );
});

test("W1-T4671: a shape at the exact break-even pass rate keeps the default schedule (a tie never overrides it)", () => {
  // W1-T4671 round-3 follow-up: no prior case in this file ever landed on the THIRD arm of
  // strikeScheduleFor's direction ternary ("keeps-default-two-strike-schedule") or exercised the
  // strict `cost < bestCost` comparison's tie-break behaviour — every existing case picked a
  // budget strictly cheaper or strictly pricier than the default. At OPUS_WINDOW_COST_MULTIPLIER=2
  // and a measured 50% strike-1 pass rate (reused for every later position, single-position
  // evidence), hand computation of expectedWindowsForSchedule gives EXACTLY 2.0 for budgets 1, 2,
  // AND 3 -- a genuine three-way tie, not an approximation. Since the comparison loop only
  // replaces `best` on a STRICT improvement (`cost < bestCost`), and `best` starts at
  // DEFAULT_CHEAP_STRIKE_BUDGET, a tie must leave the schedule at the default: this is the
  // falsifier for a regression that used `<=` instead and let a later, no-better candidate win.
  const shape = taskShapeKey(RISKY_SHAPE_TASK);
  const rows = rowsForShape(shape, 1, { n: 20, passN: 10 });
  const rates = measureStrikePassRates(rows);
  assert.equal(rates.get(`${shape}::1`)?.passRate, 0.5, "exactly the break-even rate for OPUS_WINDOW_COST_MULTIPLIER=2");
  const schedule = strikeScheduleFor({ task: RISKY_SHAPE_TASK, rates });
  assert.equal(schedule.cheapStrikeBudget, DEFAULT_CHEAP_STRIKE_BUDGET, "a tie must keep the default, never wander to a no-better candidate");
  assert.match(schedule.reason, /keeps-default-two-strike-schedule/);
});

test("W1-T4671: expectedWindowsForSchedule reuses the last measured position past the evidence", () => {
  // A single measured position (strike 1 only) at a high pass rate: a 3-strike schedule should
  // reuse that same rate for strikes 2 and 3, and cost less than a 1-strike schedule that pays
  // the full opus multiplier immediately whenever the (likely) cheap pass fails to land first.
  const highRate = [0.9];
  const costOne = expectedWindowsForSchedule(highRate, 1);
  const costThree = expectedWindowsForSchedule(highRate, 3);
  assert.ok(costThree < costOne, `expected schedule length 3 (${costThree}) to cost less than 1 (${costOne})`);
});

test("W1-T4671: OPUS_WINDOW_COST_MULTIPLIER prices the step-up mount above one cheap window", () => {
  assert.ok(OPUS_WINDOW_COST_MULTIPLIER > 1);
});

test("W1-T4671: CANDIDATE_CHEAP_STRIKE_BUDGETS always tries the cheap lane at least once", () => {
  assert.ok(CANDIDATE_CHEAP_STRIKE_BUDGETS.every((k) => k >= 1));
  assert.ok(CANDIDATE_CHEAP_STRIKE_BUDGETS.includes(DEFAULT_CHEAP_STRIKE_BUDGET));
});
