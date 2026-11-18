import type { DraftStats } from "./draft-routing.js";
import { openWeightReservationUsd, type CashAllowanceObservation } from "./worker-provider.js";

/**
 * W1-T13672 -- THE CASH LANE SERVES ONLY THE CALLS THAT FIT ITS SHARE OF THE DAY.
 *
 * OPERATOR RULING 2026-11-18: the Claude and Codex subscriptions have headroom left, so cash is for the easy, simple
 * calls that would not fill the cap. MEASURED that day by 11:10Z: cash had settled $9.32 of the $10 cap, $8.87 of it on
 * inbox drafts (gpt-6-luna $6.25 for 1 success in 15 attempts, claude-haiku-5-5 $2.59 for 2 in 30), while every judge
 * and summary lane together took $0.45 for 260 calls -- each within a full day's share ($10 over about 773 projected
 * attempts, $0.0129) at least four times over, and both draft deployments a hundredfold above it.
 *
 * NO FIXED DOLLAR FIGURE. The bound is derived from the day's own measurements: the tightest allowance limit's
 * remaining room divided by the cash attempts the day is projected to still make, at today's measured rate. A busy
 * day shrinks every share; the reset at 00:00Z restores it. Pure: the caller reads the allowance and the draft stats.
 */

/** Where a spawn's expected cost per success came from. */
export type CashExpectedCostSource = "draft-stats" | "settled-today" | "first-request-reservation";
/** Where its share of the remaining allowance came from. */
export type CashShareSource = "projected-attempts" | "hours-to-reset";

export interface CashAdmissionDecision {
  verdict: "admit" | "defer";
  /** The cheapest holding candidate: the one the decision was made on. */
  deployment: string;
  expectedCostUsd: number;
  expectedCostSource: CashExpectedCostSource;
  shareUsd: number;
  shareSource: CashShareSource;
  remainingUsd: number;
  limit: string;
  attemptsToday: number;
  projectedAttempts: number;
  resetAt: string;
}

export interface CashAdmissionInput {
  /** The cash deployments whose context window holds this prompt, in the ladder's order. */
  candidates: readonly string[];
  reading: CashAllowanceObservation;
  /** A draft spawn's measured posteriors; absent for every other spawn. */
  draftStats?: DraftStats;
  promptBytes: number;
  nowIso: string;
}

const HOUR_MS = 60 * 60 * 1000;

/** Admit the spawn on cash when its cheapest holding candidate's expected cost per success fits its share. */
export function cashAdmission(input: CashAdmissionInput): CashAdmissionDecision {
  if (input.candidates.length === 0) throw new Error("cash admission has no candidate deployment");
  const nowMs = Date.parse(input.nowIso);
  const resetMs = Date.parse(input.reading.resetAt);
  const hoursToReset = (resetMs - nowMs) / HOUR_MS;
  const elapsedHours = 24 - hoursToReset;
  const attemptsToday = input.reading.attemptsToday;
  // Today's measured rate, carried to the reset; with no attempt yet, one per hour left. Either way at least one.
  const projectedAttempts = Math.max(1, attemptsToday > 0 && elapsedHours > 0
    ? attemptsToday / elapsedHours * hoursToReset : hoursToReset);
  const shareSource: CashShareSource = attemptsToday > 0 && elapsedHours > 0 ? "projected-attempts" : "hours-to-reset";
  const judged = input.candidates.map((deployment, index) => {
    const room = input.reading.deployments.find((row) => row.deployment === deployment);
    if (room === undefined) throw new Error(`cash admission has no allowance reading for ${deployment}`);
    const expected = expectedCost(deployment, index, input);
    return { deployment, room, ...expected, shareUsd: room.remainingUsd / projectedAttempts };
  });
  const cheapest = judged.reduce((best, row) => row.expectedCostUsd < best.expectedCostUsd ? row : best);
  return {
    verdict: cheapest.expectedCostUsd <= cheapest.shareUsd ? "admit" : "defer",
    deployment: cheapest.deployment,
    expectedCostUsd: cheapest.expectedCostUsd,
    expectedCostSource: cheapest.expectedCostSource,
    shareUsd: cheapest.shareUsd,
    shareSource,
    remainingUsd: cheapest.room.remainingUsd,
    limit: cheapest.room.limit,
    attemptsToday,
    projectedAttempts,
    resetAt: input.reading.resetAt,
  };
}

/** The larger of the draft posterior's cost per clean draft and today's settled dollars per attempt; with neither,
 *  the first request's reservation for this prompt. */
function expectedCost(deployment: string, index: number, input: CashAdmissionInput):
  { expectedCostUsd: number; expectedCostSource: CashExpectedCostSource } {
  const measured: Array<{ expectedCostUsd: number; expectedCostSource: CashExpectedCostSource }> = [];
  const draft = input.draftStats?.[deployment];
  if (draft && draft.attempts > 0 && draft.costUsd > 0) {
    // The posterior mean of the clean rate, from the same Beta prior chooseDraftDeployment builds (row order).
    const clean = Math.min(draft.attempts, draft.clean);
    const alpha = 1 + clean, beta = 1 + index + draft.attempts - clean;
    measured.push({ expectedCostUsd: draft.costUsd / draft.attempts / (alpha / (alpha + beta)), expectedCostSource: "draft-stats" });
  }
  const settled = input.reading.settledToday[deployment];
  if (settled && settled.attempts > 0) {
    measured.push({ expectedCostUsd: settled.settledUsd / settled.attempts, expectedCostSource: "settled-today" });
  }
  if (measured.length === 0) {
    return { expectedCostUsd: openWeightReservationUsd(deployment, input.promptBytes), expectedCostSource: "first-request-reservation" };
  }
  return measured.reduce((a, b) => b.expectedCostUsd > a.expectedCostUsd ? b : a);
}
