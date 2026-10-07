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
  "automerge.plan_pr_held",
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

/** One task class's counts and its first distinct task and actor ids, as {@link finishOperatorDecisions} reads them. */
interface OperatorDecisionClassFold {
  taskClass: string;
  counts: Record<OperatorDecisionKind, number>;
  taskIds: string[];
  actorIds: string[];
}

/** What {@link finishOperatorDecisions} reads: counts and the first details, never the rows. */
export interface OperatorDecisionFold {
  explicitDecisionCount: number;
  automaticMergeEventCount: number;
  unmeasurableCount: number;
  explicitDecisions: OperatorDecisionEvent[];
  automaticMergeEvents: AutomaticMergeEvent[];
  unmeasurable: OperatorDecisionUnmeasurable[];
  classes: OperatorDecisionClassFold[];
}

export function emptyOperatorDecisionFold(): OperatorDecisionFold {
  return { explicitDecisionCount: 0, automaticMergeEventCount: 0, unmeasurableCount: 0, explicitDecisions: [], automaticMergeEvents: [], unmeasurable: [], classes: [] };
}

function firstDistinct(values: string[], value: string): void {
  if (values.length < MAX_OPERATOR_AGENT_DETAIL_ITEMS && !values.includes(value)) values.push(value);
}

function firstItems<T>(values: T[], value: T): void {
  if (values.length < MAX_OPERATOR_AGENT_DETAIL_ITEMS) values.push(value);
}

export function foldOperatorDecisionRow(fold: OperatorDecisionFold, row: OperatorDecisionLedgerRow): void {
  if (AUTOMATIC_MERGE_STEPS.has(row.step)) {
    fold.automaticMergeEventCount += 1;
    firstItems(fold.automaticMergeEvents, automaticEvent(row));
    return;
  }
  const decision = EXPLICIT_DECISION_STEPS.get(row.step);
  if (!decision) return;
  const taskId = stringField(row, ["task_id"]);
  const taskClass = stringField(row, ["task_class", "task_type", "class"]);
  const actor = stringField(row, ["origin", "actor", "by"]);
  const missing = !taskId ? unmeasurable(row, "missing-task-id", undefined, taskClass)
    : !taskClass ? unmeasurable(row, "missing-task-class", taskId)
    : !actor ? unmeasurable(row, "missing-actor", taskId, taskClass)
    : undefined;
  if (missing !== undefined) {
    fold.unmeasurableCount += 1;
    firstItems(fold.unmeasurable, missing);
    return;
  }
  fold.explicitDecisionCount += 1;
  firstItems(fold.explicitDecisions, { source: "explicit-operator", step: row.step, decision, taskId: taskId!, taskClass: taskClass!, actor: actor! });
  let summary = fold.classes.find((entry) => entry.taskClass === taskClass);
  if (summary === undefined) {
    summary = { taskClass: taskClass!, counts: { approved: 0, accepted: 0, rejected: 0, held: 0, released: 0 }, taskIds: [], actorIds: [] };
    fold.classes.push(summary);
  }
  summary.counts[decision] += 1;
  firstDistinct(summary.taskIds, taskId!);
  firstDistinct(summary.actorIds, actor!);
}

function classSummary(entry: OperatorDecisionClassFold): OperatorDecisionClassSummary {
  const { approved: approvedCount, accepted: acceptedCount, rejected: rejectedCount } = entry.counts;
  const approvalDenominator = approvedCount + acceptedCount + rejectedCount;
  return {
    taskClass: entry.taskClass,
    approvedCount,
    acceptedCount,
    rejectedCount,
    heldCount: entry.counts.held,
    releasedCount: entry.counts.released,
    approvalDenominator,
    approvalRate: approvalDenominator === 0 ? null : (approvedCount + acceptedCount) / approvalDenominator,
    taskIds: [...entry.taskIds],
    actorIds: [...entry.actorIds],
  };
}

export function finishOperatorDecisions(fold: OperatorDecisionFold): OperatorAgentDecisionSignal {
  return {
    signal: OPERATOR_AGENT_DECISION_SIGNAL,
    status: fold.explicitDecisionCount > 0 ? "measured" : "not-collected",
    explicitDecisionCount: fold.explicitDecisionCount,
    automaticMergeEventCount: fold.automaticMergeEventCount,
    unmeasurableCount: fold.unmeasurableCount,
    explicitDecisions: [...fold.explicitDecisions],
    automaticMergeEvents: [...fold.automaticMergeEvents],
    classes: [...fold.classes].sort((a, b) => (a.taskClass < b.taskClass ? -1 : a.taskClass > b.taskClass ? 1 : 0)).map(classSummary),
    unmeasurable: [...fold.unmeasurable],
  };
}

/** Adapt supplied ledger rows without writing, classifying automatic merges as human decisions, or guessing missing joins. */
export function adaptOperatorDecisionRows(rows: readonly OperatorDecisionLedgerRow[]): OperatorAgentDecisionSignal {
  const fold = emptyOperatorDecisionFold();
  for (const row of rows) foldOperatorDecisionRow(fold, row);
  return finishOperatorDecisions(fold);
}
