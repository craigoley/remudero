/**
 * Read-only task-outcome signal for the operator-agent projection.
 *
 * This module deliberately adapts the existing verdict-calibration report instead of redoing
 * its git join. The calibration module owns attribution policy, population floors, lane labels,
 * and unmeasurable causes; this adapter makes those decisions travel to the console as data.
 * A missing or unusable join is not a healthy zero.
 */

import type { AttributionPolicy, ClassOutcome, UnmeasurableCause, UnmeasurableRow, VerdictCalibrationReport, VerdictClass } from "./verdict-calibration.js";

export const OPERATOR_AGENT_TASK_OUTCOME_SIGNAL = "task-outcomes" as const;

/* c8 ignore next 8 -- exported type declarations have no runtime statements to execute */
export type OperatorAgentTaskOutcomeStatus = "measured" | "not-collected";

export type OperatorAgentTaskOutcomeUnavailableReason =
  | "empty-corpus"
  | "git-history-unavailable"
  | "verdict-join-unavailable";

export interface OperatorAgentOutcomeClass {
  verdictClass: VerdictClass;
  total: number;
  revertedCount: number;
  followupFixedCount: number;
  revertRate: number | null;
  followupFixRate: number | null;
  lanes: string;
  rateRefusedReason?: ClassOutcome["rateRefusedReason"];
  taskIds: string[];
}

export interface OperatorAgentTaskOutcomeSignal {
  signal: typeof OPERATOR_AGENT_TASK_OUTCOME_SIGNAL;
  status: OperatorAgentTaskOutcomeStatus;
  unavailableReason?: OperatorAgentTaskOutcomeUnavailableReason;
  policy: AttributionPolicy;
  minPopulationFloor: number;
  classes: OperatorAgentOutcomeClass[];
  unmeasurable: UnmeasurableRow[];
  unmeasurableByCause: Record<UnmeasurableCause, number>;
  armsSeen: number;
  armsClassified: number;
}

function statusFor(report: VerdictCalibrationReport): {
  status: OperatorAgentTaskOutcomeStatus;
  unavailableReason?: OperatorAgentTaskOutcomeUnavailableReason;
} {
  if (report.armsSeen === 0) return { status: "not-collected", unavailableReason: "empty-corpus" };
  if (report.unmeasurableByCause["git-history-unavailable"] > 0) {
    return { status: "not-collected", unavailableReason: "git-history-unavailable" };
  }
  if (report.armsClassified === 0) return { status: "not-collected", unavailableReason: "verdict-join-unavailable" };
  return { status: "measured" };
}

/**
 * Adapt the host-side calibration report for console-v1.
 *
 * The returned arrays and records are copies so a projection consumer cannot mutate the
 * calibration report that another caller may still be using. Rates remain null when the source
 * report refused them for a population floor or mixed-lane reason.
 */
export function adaptVerdictCalibrationReport(report: VerdictCalibrationReport): OperatorAgentTaskOutcomeSignal {
  const availability = statusFor(report);
  return {
    signal: OPERATOR_AGENT_TASK_OUTCOME_SIGNAL,
    ...availability,
    policy: { ...report.policy },
    minPopulationFloor: report.minPopulationFloor,
    classes: report.classes.map((item) => ({
      verdictClass: item.verdictClass,
      total: item.total,
      revertedCount: item.revertedCount,
      followupFixedCount: item.followupFixedCount,
      revertRate: item.revertRate,
      followupFixRate: item.followupFixRate,
      lanes: item.lanes,
      ...(item.rateRefusedReason ? { rateRefusedReason: item.rateRefusedReason } : {}),
      taskIds: [...item.taskIds],
    })),
    unmeasurable: report.unmeasurable.map((item) => ({ ...item })),
    unmeasurableByCause: { ...report.unmeasurableByCause },
    armsSeen: report.armsSeen,
    armsClassified: report.armsClassified,
  };
}
