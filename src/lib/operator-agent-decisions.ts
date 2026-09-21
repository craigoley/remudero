/**
 * Read-only operator-decision signal for the operator-agent projection.
 *
 * Explicit operator actions and automatic merge activity are different populations. This module
 * keeps them separate so a daemon auto-arming a chore cannot teach the agent that an operator
 * approved a chore. Rows without enough identity to join a decision to a task class remain
 * unmeasurable.
 */

export const OPERATOR_AGENT_DECISION_SIGNAL = "operator-decisions" as const;

/** The console-v1 consumer accepts at most this many repeated detail records per signal. */
const MAX_OPERATOR_AGENT_DETAIL_ITEMS = 100;

const EXPLICIT_DECISION_STEPS = new Map<string, OperatorDecisionKind>([
  ["panel.manual_approved", "approved"],
  ["panel.proposal_accepted", "accepted"],
  ["panel.proposal_rejected", "rejected"],
  ["panel.proposal_declined", "rejected"],
  ["automerge.hold_engaged", "held"],
  ["automerge.hold_released", "released"],
]);

const AUTOMATIC_MERGE_STEPS = new Set([
  "automerge.armed",
  "automerge.clean_status_direct_merge",
  "automerge.direct_merge_failed",
  "automerge.direct_merge_preflight_head_unavailable",
  "automerge.direct_merge_preflight_refused",
  "automerge.direct_merge_update_failed",
  "automerge.direct_merge_updated",
  "automerge.rate_limited_rest_merge",
  "automerge.rate_limited_rest_merge_conflict",
  "automerge.rate_limited_rest_merge_refused",
  "automerge.rate_limited_rest_merge_retry",
]);

export type OperatorDecisionKind = "approved" | "accepted" | "rejected" | "held" | "released";

export type OperatorDecisionUnmeasurableCause = "missing-task-id" | "missing-task-class" | "missing-actor";

export interface OperatorDecisionLedgerRow {
  step: string;
  task_id?: unknown;
  task_class?: unknown;
  task_type?: unknown;
  class?: unknown;
  origin?: unknown;
  actor?: unknown;
  by?: unknown;
}

export interface OperatorDecisionEvent {
  source: "explicit-operator";
  step: string;
  decision: OperatorDecisionKind;
  taskId: string;
  taskClass: string;
  actor: string;
}

export interface AutomaticMergeEvent {
  source: "automatic-merge";
  step: string;
  taskId?: string;
  taskClass?: string;
}

export interface OperatorDecisionUnmeasurable {
  source: "explicit-operator";
  step: string;
  taskId?: string;
  taskClass?: string;
  cause: OperatorDecisionUnmeasurableCause;
  why: string;
}

export interface OperatorDecisionClassSummary {
  taskClass: string;
  approvedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  heldCount: number;
  releasedCount: number;
  /** approved + accepted + rejected; held/released are controls, not approval outcomes. */
  approvalDenominator: number;
  /** null when no approval/rejection outcome exists for the class. */
  approvalRate: number | null;
  taskIds: string[];
  actorIds: string[];
}

export interface OperatorAgentDecisionSignal {
  signal: typeof OPERATOR_AGENT_DECISION_SIGNAL;
  status: "measured" | "not-collected";
  /** Exact counts retained when repeated event/detail arrays are bounded for console-v1. */
  explicitDecisionCount: number;
  automaticMergeEventCount: number;
  unmeasurableCount: number;
  explicitDecisions: OperatorDecisionEvent[];
  automaticMergeEvents: AutomaticMergeEvent[];
  classes: OperatorDecisionClassSummary[];
  unmeasurable: OperatorDecisionUnmeasurable[];
}

function stringField(row: OperatorDecisionLedgerRow, keys: readonly (keyof OperatorDecisionLedgerRow)[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function automaticEvent(row: OperatorDecisionLedgerRow): AutomaticMergeEvent {
  const taskId = stringField(row, ["task_id"]);
  const taskClass = stringField(row, ["task_class", "task_type", "class"]);
  return {
    source: "automatic-merge",
    step: row.step,
    ...(taskId ? { taskId } : {}),
    ...(taskClass ? { taskClass } : {}),
  };
}

function classSummary(taskClass: string, events: readonly OperatorDecisionEvent[]): OperatorDecisionClassSummary {
  const forClass = events.filter((event) => event.taskClass === taskClass);
  const count = (decision: OperatorDecisionKind): number => forClass.filter((event) => event.decision === decision).length;
  const approvedCount = count("approved");
  const acceptedCount = count("accepted");
  const rejectedCount = count("rejected");
  const approvalDenominator = approvedCount + acceptedCount + rejectedCount;
  return {
    taskClass,
    approvedCount,
    acceptedCount,
    rejectedCount,
    heldCount: count("held"),
    releasedCount: count("released"),
    approvalDenominator,
    approvalRate: approvalDenominator === 0 ? null : (approvedCount + acceptedCount) / approvalDenominator,
    taskIds: [...new Set(forClass.map((event) => event.taskId))].slice(0, MAX_OPERATOR_AGENT_DETAIL_ITEMS),
    actorIds: [...new Set(forClass.map((event) => event.actor))].slice(0, MAX_OPERATOR_AGENT_DETAIL_ITEMS),
  };
}

function unmeasurable(row: OperatorDecisionLedgerRow, cause: OperatorDecisionUnmeasurableCause, taskId?: string, taskClass?: string): OperatorDecisionUnmeasurable {
  const labels: Record<OperatorDecisionUnmeasurableCause, string> = {
    "missing-task-id": "task identity is missing",
    "missing-task-class": "task class is missing",
    "missing-actor": "operator identity is missing",
  };
  return {
    source: "explicit-operator",
    step: row.step,
    ...(taskId ? { taskId } : {}),
    ...(taskClass ? { taskClass } : {}),
    cause,
    why: `${row.step}: ${labels[cause]}; the decision is not used in a task-class preference rate`,
  };
}

/** Adapt supplied ledger rows without writing, classifying automatic merges as human decisions, or guessing missing joins. */
export function adaptOperatorDecisionRows(rows: readonly OperatorDecisionLedgerRow[]): OperatorAgentDecisionSignal {
  const explicitDecisions: OperatorDecisionEvent[] = [];
  const automaticMergeEvents: AutomaticMergeEvent[] = [];
  const unmeasurableRows: OperatorDecisionUnmeasurable[] = [];

  for (const row of rows) {
    if (AUTOMATIC_MERGE_STEPS.has(row.step)) {
      automaticMergeEvents.push(automaticEvent(row));
      continue;
    }
    const decision = EXPLICIT_DECISION_STEPS.get(row.step);
    if (!decision) continue;

    const taskId = stringField(row, ["task_id"]);
    const taskClass = stringField(row, ["task_class", "task_type", "class"]);
    const actor = stringField(row, ["origin", "actor", "by"]);
    if (!taskId) {
      unmeasurableRows.push(unmeasurable(row, "missing-task-id", undefined, taskClass));
      continue;
    }
    if (!taskClass) {
      unmeasurableRows.push(unmeasurable(row, "missing-task-class", taskId));
      continue;
    }
    if (!actor) {
      unmeasurableRows.push(unmeasurable(row, "missing-actor", taskId, taskClass));
      continue;
    }
    explicitDecisions.push({ source: "explicit-operator", step: row.step, decision, taskId, taskClass, actor });
  }

  const classes = [...new Set(explicitDecisions.map((event) => event.taskClass))]
    .sort()
    .map((taskClass) => classSummary(taskClass, explicitDecisions));

  return {
    signal: OPERATOR_AGENT_DECISION_SIGNAL,
    status: explicitDecisions.length > 0 ? "measured" : "not-collected",
    explicitDecisionCount: explicitDecisions.length,
    automaticMergeEventCount: automaticMergeEvents.length,
    unmeasurableCount: unmeasurableRows.length,
    explicitDecisions: explicitDecisions.slice(0, MAX_OPERATOR_AGENT_DETAIL_ITEMS),
    automaticMergeEvents: automaticMergeEvents.slice(0, MAX_OPERATOR_AGENT_DETAIL_ITEMS),
    classes,
    unmeasurable: unmeasurableRows.slice(0, MAX_OPERATOR_AGENT_DETAIL_ITEMS),
  };
}
