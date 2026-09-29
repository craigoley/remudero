/**
 * lib/strike-schedule.ts — W1-T4671: the "two sonnet strikes, then opus" ladder
 * (.remudero/mounts.yaml's `step_up` mount, operator ruling 2026-09-22: "try Luna and Sonnet for
 * most tasks") is the SAME fixed length for every task shape today. Speculative decoding sizes
 * its draft length from the verifier's MEASURED acceptance rate
 * (https://github.com/NVIDIA/Model-Optimizer/tree/main/examples/specdec_bench) — this module is
 * the same rule applied to rmd's own draft-then-verify shape: the cheap (sonnet) lane is the
 * draft, the step-up (opus) mount is the verifier of last resort.
 *
 * Two phases, kept as separate as {@link import("./parallel-attempts.js")} keeps its own two:
 *
 *   (i) OFFLINE MEASUREMENT — {@link measureStrikePassRates} reduces per-attempt ledger-union
 *       rows (the caller's job to read — see the module-level INVARIANT below) to, per task
 *       shape and strike position, how often that shape's sonnet strike passed.
 *   (ii) SCHEDULING — {@link strikeScheduleFor} decides how many cheap strikes THIS shape gets
 *       before stepping up, by comparing the EXPECTED WINDOW COST (a window is one dispatched
 *       attempt, cheap or opus) of a few candidate schedule lengths and picking whichever is
 *       cheapest given the shape's measured pass rate — never a fixed number (design (iii): "the
 *       schedule is recomputed from data each retro").
 *
 * INVARIANT: this module never reads the ledger union itself. It is handed rows already reduced
 * from evidence, exactly the posture {@link import("./parallel-attempts.js").measureShapeGains}
 * holds — a live per-shape measurement source is a separate concern from what the schedule DOES
 * with one once it exists. A shape with no measured rows (or too few to trust) always gets
 * {@link DEFAULT_CHEAP_STRIKE_BUDGET} — cheap-first stays the default for any shape without
 * evidence (design (ii)), the operator's cheap-first ruling this module must keep.
 */

import { taskShapeKey, type TaskShape } from "./parallel-attempts.js";
import type { Task } from "./plan.js";

export type { TaskShape };

/** Which cheap (sonnet) strike an attempt was: the fixed ladder allows exactly two today, so
 *  those are the only positions the ledger union can have evidence for yet. */
export type CheapStrikePosition = 1 | 2;

/** One historical cheap-lane attempt: this shape, this strike position, whether it passed. Read
 *  from the ledger union by the caller (see the module INVARIANT) — never here. */
export interface StrikePassRow {
  shape: TaskShape;
  strikeNumber: CheapStrikePosition;
  passed: boolean;
}

/** Per-shape, per-position measured pass rate, plus the row count {@link strikeScheduleFor} uses
 *  to decide whether that rate is trusted. */
export interface StrikePassRate {
  shape: TaskShape;
  strikeNumber: CheapStrikePosition;
  rows: number;
  passRate: number;
}

/** Below this many rows, a shape/position's measured pass rate is not trusted —
 *  {@link strikeScheduleFor} falls back to {@link DEFAULT_CHEAP_STRIKE_BUDGET}. Matches
 *  {@link import("./parallel-attempts.js").MIN_ROWS_FOR_SIGNAL} — the same "how many rows earn
 *  trust" bar this sibling measurement already established. */
export const MIN_ROWS_FOR_SIGNAL = 8;

function strikeRateKey(shape: TaskShape, strikeNumber: CheapStrikePosition): string {
  return `${shape}::${strikeNumber}`;
}

/** Reduces per-attempt rows to one {@link StrikePassRate} per shape+position seen. Pure: no I/O —
 *  the caller supplies rows already read from the ledger union (design (i)). */
export function measureStrikePassRates(rows: readonly StrikePassRow[]): Map<string, StrikePassRate> {
  const byKey = new Map<string, StrikePassRow[]>();
  for (const row of rows) {
    const key = strikeRateKey(row.shape, row.strikeNumber);
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }
  const out = new Map<string, StrikePassRate>();
  for (const [key, group] of byKey) {
    const n = group.length;
    const passRate = group.filter((r) => r.passed).length / n;
    out.set(key, { shape: group[0]!.shape, strikeNumber: group[0]!.strikeNumber, rows: n, passRate });
  }
  return out;
}

/** The fixed ladder's own length today (.remudero/mounts.yaml: two implement strikes, then
 *  diagnose, then the step-up opus mount) — the schedule EVERY shape without trusted evidence
 *  keeps, so a shape with no measurement yet is never guessed into a shorter or longer one. */
export const DEFAULT_CHEAP_STRIKE_BUDGET = 2;

/** Candidate cheap-strike budgets {@link strikeScheduleFor} compares by expected window cost.
 *  Bounded on both sides: 1 is the shortest schedule that still tries the cheap lane once before
 *  stepping up (never zero — cheap-first, per the operator ruling, always gets a first look), and
 *  3 is the longest this module will grant without dedicated evidence for a third position. */
export const CANDIDATE_CHEAP_STRIKE_BUDGETS = [1, 2, 3] as const;

/** How many windows a step-up (opus) attempt costs relative to one cheap window — the "verify is
 *  pricier than draft" half of speculative decoding's cost ratio. Opus runs at the fleet's
 *  highest effort/context tier (.remudero/mounts.yaml `step_up`) against every other worker row's
 *  sonnet ceiling, so it is modelled as costing MORE than one cheap window, never the same. This
 *  is the number that makes "step up sooner when cheap rarely passes, extend when it usually
 *  passes" the cost-minimizing answer rather than an arbitrary threshold on the raw pass rate. */
export const OPUS_WINDOW_COST_MULTIPLIER = 2;

/**
 * Expected number of windows (dispatched attempts, cheap or opus) spent before a pass, running up
 * to `cheapStrikeBudget` cheap strikes and then — only if every one of those fails — one opus
 * attempt, assumed to always clear (opus is the ladder's ceiling tier; this models the ladder's
 * guarantee, not a measured opus rate this module has no evidence for). `cheapPassRateByPosition`
 * gives the measured pass probability for strike 1, strike 2, and so on; a candidate budget
 * longer than the measured positions reuses the LAST measured rate (steady state), never an
 * invented one.
 */
export function expectedWindowsForSchedule(
  cheapPassRateByPosition: readonly number[],
  cheapStrikeBudget: number,
): number {
  let expected = 0;
  let survival = 1; // probability no attempt up to this point has passed yet
  for (let i = 1; i <= cheapStrikeBudget; i++) {
    const p = cheapPassRateByPosition[Math.min(i - 1, cheapPassRateByPosition.length - 1)] ?? 0;
    expected += survival * p * i;
    survival *= 1 - p;
  }
  expected += survival * (cheapStrikeBudget + OPUS_WINDOW_COST_MULTIPLIER);
  return expected;
}

export interface StrikeSchedule {
  shape: TaskShape;
  /** How many sonnet strikes this shape gets before stepping up to the opus mount. */
  cheapStrikeBudget: number;
  reason: string;
}

export interface StrikeScheduleInput {
  task: Pick<Task, "risk"> & { files?: readonly string[] };
  /** The offline measurement (design (i)), keyed by {@link strikeRateKey}. An empty map schedules
   *  {@link DEFAULT_CHEAP_STRIKE_BUDGET} for every shape — the same "no evidence yet" posture
   *  {@link import("./parallel-attempts.js").planParallelAttempts} holds inert by default. */
  rates: ReadonlyMap<string, StrikePassRate>;
}

/**
 * Decides how many cheap (sonnet) strikes this task's shape gets before the ladder steps up to
 * the opus mount. A shape whose measured strike-1 pass rate has fewer than
 * {@link MIN_ROWS_FOR_SIGNAL} rows keeps {@link DEFAULT_CHEAP_STRIKE_BUDGET} — cheap-first stays
 * the default for any shape without evidence (design (ii), the operator's cheap-first ruling).
 * Otherwise the schedule is whichever candidate budget in {@link CANDIDATE_CHEAP_STRIKE_BUDGETS}
 * has the lowest {@link expectedWindowsForSchedule}, ties going to the default for stability: a
 * shape whose cheap strikes rarely pass steps up sooner (a shorter budget wins), and a shape
 * whose cheap strikes usually pass earns another cheap strike (a longer budget wins) — never a
 * fixed number (design (iii): recomputed from data, not hardcoded).
 */
export function strikeScheduleFor(input: StrikeScheduleInput): StrikeSchedule {
  const shape = taskShapeKey(input.task);
  const rate1 = input.rates.get(strikeRateKey(shape, 1));
  if (!rate1 || rate1.rows < MIN_ROWS_FOR_SIGNAL) {
    return { shape, cheapStrikeBudget: DEFAULT_CHEAP_STRIKE_BUDGET, reason: "shape-unmeasured-cheap-first-default" };
  }
  const rate2 = input.rates.get(strikeRateKey(shape, 2));
  const positions = rate2 && rate2.rows >= MIN_ROWS_FOR_SIGNAL ? [rate1.passRate, rate2.passRate] : [rate1.passRate];

  let best = DEFAULT_CHEAP_STRIKE_BUDGET;
  let bestCost = expectedWindowsForSchedule(positions, DEFAULT_CHEAP_STRIKE_BUDGET);
  for (const k of CANDIDATE_CHEAP_STRIKE_BUDGETS) {
    const cost = expectedWindowsForSchedule(positions, k);
    if (cost < bestCost) {
      best = k;
      bestCost = cost;
    }
  }

  const direction =
    best < DEFAULT_CHEAP_STRIKE_BUDGET
      ? "steps-up-sooner"
      : best > DEFAULT_CHEAP_STRIKE_BUDGET
        ? "earns-another-cheap-strike"
        : "keeps-default-two-strike-schedule";
  return {
    shape,
    cheapStrikeBudget: best,
    reason: `measured-strike-1-pass-rate-${rate1.passRate.toFixed(3)}-${direction}`,
  };
}
