/**
 * The operator-agent outcome catalog (W1-T3795).
 *
 * This is an adapter, not a second calibration algorithm. `verdictCalibrationReport` already
 * performs the ledger-to-git join and owns the attribution policy, population floor, verdict
 * classes, and unmeasurable causes. The console agent needs those decisions in a stable,
 * read-only shape, so this module carries them across without reclassifying any row.
 *
 * In particular, an unclassified row is not a reverted task. A failed worker can explain why a
 * verdict was not recovered, but it cannot be evidence of a post-merge revert.
 */

import type { AttributionPolicy, ClassOutcome, UnmeasurableCause, UnmeasurableRow, VerdictCalibrationReport, VerdictClass } from "./verdict-calibration.js";

export const OPERATOR_AGENT_OUTCOMES_VERSION = "operator-agent-outcomes-v1";

/* c8 ignore next -- exported type declarations have no runtime statements to execute */
export type OperatorAgentOutcomeStatus = "measured" | "not-collected";

export interface OperatorAgentOutcomeClass {
  verdictClass: VerdictClass;
  /** The complete denominator after the verdict-to-merge join. */
  denominator: number;
  revertedCount: number;
  followupFixedCount: number;
  /** `null` means the calibration policy refused the rate; it is never a healthy zero. */
  revertRate: number | null;
  followupFixRate: number | null;
  lanes: string;
  rateRefusedReason?: ClassOutcome["rateRefusedReason"];
  taskIds: string[];
}

export interface OperatorAgentOutcomes {
  version: typeof OPERATOR_AGENT_OUTCOMES_VERSION;
  /** No rates are available when the required corpus or join produced no measurable rows. */
  status: OperatorAgentOutcomeStatus;
  notCollectedReason?: string;
  /** The policy travels with the figures so a consumer cannot mistake the rule for the result. */
  attributionPolicy: AttributionPolicy;
  minPopulationFloor: number;
  armsSeen: number;
  armsClassified: number;
  classes: OperatorAgentOutcomeClass[];
  /** Rows that could not be joined remain visible and are never added to a class denominator. */
  unmeasurable: UnmeasurableRow[];
  unmeasurableByCause: Record<UnmeasurableCause, number>;
}

function notCollectedReason(report: VerdictCalibrationReport): string | undefined {
  if (report.armsClassified > 0) return undefined;
  const historyUnavailable = report.unmeasurable.find((row) => row.cause === "git-history-unavailable");
  if (historyUnavailable) return `required git history unavailable: ${historyUnavailable.why}`;
  if (report.armsSeen === 0) return "no verdict outcomes were collected for this measurement";
  if (report.armsClassified === 0) return "no verdict outcome could be joined to a measurable merge";
  return undefined;
}

function adaptClass(outcome: ClassOutcome): OperatorAgentOutcomeClass {
  return {
    verdictClass: outcome.verdictClass,
    denominator: outcome.total,
    revertedCount: outcome.revertedCount,
    followupFixedCount: outcome.followupFixedCount,
    revertRate: outcome.revertRate,
    followupFixRate: outcome.followupFixRate,
    lanes: outcome.lanes,
    ...(outcome.rateRefusedReason ? { rateRefusedReason: outcome.rateRefusedReason } : {}),
    taskIds: [...outcome.taskIds],
  };
}

/**
 * Adapt an existing calibration report for the console agent.
 *
 * The function deliberately accepts only the completed report: it cannot see worker results and
 * therefore cannot turn a failed worker into a revert. `not-collected` is reserved for a corpus
 * with no measurable joined rows; a partially measurable report remains `measured` while its
 * unmeasurable rows and their causes stay explicit beside the rates.
 */
export function operatorAgentOutcomeReport(report: VerdictCalibrationReport): OperatorAgentOutcomes {
  const reason = notCollectedReason(report);
  return {
    version: OPERATOR_AGENT_OUTCOMES_VERSION,
    status: reason ? "not-collected" : "measured",
    ...(reason ? { notCollectedReason: reason } : {}),
    attributionPolicy: { ...report.policy },
    minPopulationFloor: report.minPopulationFloor,
    armsSeen: report.armsSeen,
    armsClassified: report.armsClassified,
    classes: report.classes.map(adaptClass),
    unmeasurable: report.unmeasurable.map((row) => ({ ...row })),
    unmeasurableByCause: { ...report.unmeasurableByCause },
  };
}
