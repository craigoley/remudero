/**
 * Read-only proof-execution signal for the operator-agent projection.
 *
 * `review.posted.proof_exec` is criterion-level evidence. This adapter counts only the explicit
 * proof outcomes and keeps non-executable and execution-error outcomes outside the pass/fail
 * denominator. A missing or malformed proof field remains visible as unmeasurable.
 */

export const OPERATOR_AGENT_PROOF_SIGNAL = "proof-outcomes" as const;

/** The console-v1 consumer accepts at most this many repeated detail records per signal. */
const MAX_OPERATOR_AGENT_DETAIL_ITEMS = 100;

export type OperatorAgentProofUnavailableCause = "missing-proof-exec" | "empty-proof-exec" | "unknown-proof-exec";

export interface OperatorAgentProofLedgerRow {
  step?: unknown;
  task_id?: unknown;
  proof_exec?: unknown;
}

export interface OperatorAgentProofUnmeasurable {
  taskId?: string;
  cause: OperatorAgentProofUnavailableCause;
  value?: unknown;
  why: string;
}

export interface OperatorAgentProofSignal {
  signal: typeof OPERATOR_AGENT_PROOF_SIGNAL;
  status: "measured" | "not-collected";
  reviewRows: number;
  executedPass: number;
  executedFail: number;
  nonExecutable: number;
  executionError: number;
  otherObserved: number;
  /** executedPass + executedFail; null means no executable pass/fail proof was observed. */
  denominator: number | null;
  /** null when denominator is zero, never a fabricated 0% rate. */
  passRate: number | null;
  /** Exact count of unmeasurable rows; the detail list below is intentionally bounded. */
  unmeasurableCount: number;
  unmeasurable: OperatorAgentProofUnmeasurable[];
  unavailableReason?: string;
}

const NON_EXECUTABLE = new Set(["not_executable"]);
const EXECUTION_ERROR = new Set(["exec_error"]);
const OTHER_OBSERVED = new Set(["executed_stale", "base_unreadable", "not_yet_built", "stale_self_path"]);

function taskId(row: OperatorAgentProofLedgerRow): string | undefined {
  return typeof row.task_id === "string" && row.task_id.trim() ? row.task_id.trim() : undefined;
}

function unmeasurable(
  row: OperatorAgentProofLedgerRow,
  cause: OperatorAgentProofUnavailableCause,
  value?: unknown,
): OperatorAgentProofUnmeasurable {
  const labels: Record<OperatorAgentProofUnavailableCause, string> = {
    "missing-proof-exec": "review.posted has no proof_exec field",
    "empty-proof-exec": "review.posted proof_exec contains no criterion outcomes",
    "unknown-proof-exec": "proof_exec contains an outcome outside the known vocabulary",
  };
  return {
    ...(taskId(row) ? { taskId: taskId(row) } : {}),
    cause,
    ...(value === undefined ? {} : { value }),
    why: `${labels[cause]}; it is excluded from the executed proof denominator`,
  };
}

/** What {@link finishOperatorAgentProof} reads: counts and the first details, never the rows. */
export interface OperatorAgentProofFold {
  reviewRows: number;
  executedPass: number;
  executedFail: number;
  nonExecutable: number;
  executionError: number;
  otherObserved: number;
  unmeasurableCount: number;
  unmeasurable: OperatorAgentProofUnmeasurable[];
}

export function emptyOperatorAgentProofFold(): OperatorAgentProofFold {
  return { reviewRows: 0, executedPass: 0, executedFail: 0, nonExecutable: 0, executionError: 0, otherObserved: 0, unmeasurableCount: 0, unmeasurable: [] };
}

function addUnmeasurable(fold: OperatorAgentProofFold, item: OperatorAgentProofUnmeasurable): void {
  fold.unmeasurableCount += 1;
  if (fold.unmeasurable.length < MAX_OPERATOR_AGENT_DETAIL_ITEMS) fold.unmeasurable.push(item);
}

export function foldOperatorAgentProofRow(fold: OperatorAgentProofFold, row: OperatorAgentProofLedgerRow): void {
  if (row.step !== "review.posted") return;
  fold.reviewRows += 1;
  if (!Array.isArray(row.proof_exec)) {
    addUnmeasurable(fold, unmeasurableRow(row, "missing-proof-exec", row.proof_exec));
    return;
  }
  if (row.proof_exec.length === 0) {
    addUnmeasurable(fold, unmeasurableRow(row, "empty-proof-exec"));
    return;
  }
  for (const outcome of row.proof_exec) {
    if (outcome === "executed_pass") fold.executedPass += 1;
    else if (outcome === "executed_fail") fold.executedFail += 1;
    else if (typeof outcome === "string" && NON_EXECUTABLE.has(outcome)) fold.nonExecutable += 1;
    else if (typeof outcome === "string" && EXECUTION_ERROR.has(outcome)) fold.executionError += 1;
    else if (typeof outcome === "string" && OTHER_OBSERVED.has(outcome)) fold.otherObserved += 1;
    else addUnmeasurable(fold, unmeasurableRow(row, "unknown-proof-exec", outcome));
  }
}

export function finishOperatorAgentProof(fold: OperatorAgentProofFold): OperatorAgentProofSignal {
  const { reviewRows, executedPass, executedFail, nonExecutable, executionError, otherObserved } = fold;
  const denominator = executedPass + executedFail;
  return {
    signal: OPERATOR_AGENT_PROOF_SIGNAL,
    status: denominator > 0 ? "measured" : "not-collected",
    reviewRows,
    executedPass,
    executedFail,
    nonExecutable,
    executionError,
    otherObserved,
    denominator: denominator > 0 ? denominator : null,
    passRate: denominator > 0 ? executedPass / denominator : null,
    unmeasurableCount: fold.unmeasurableCount,
    unmeasurable: fold.unmeasurable.slice(0, MAX_OPERATOR_AGENT_DETAIL_ITEMS),
    ...(denominator > 0 ? {} : { unavailableReason: "no executed proof pass/fail outcome is available yet" }),
  };
}

/** Adapt selected ledger rows without writing state or treating missing proof evidence as a pass. */
export function adaptOperatorAgentProofRows(rows: readonly OperatorAgentProofLedgerRow[]): OperatorAgentProofSignal {
  const fold = emptyOperatorAgentProofFold();
  for (const row of rows) foldOperatorAgentProofRow(fold, row);
  return finishOperatorAgentProof(fold);
}

function unmeasurableRow(
  row: OperatorAgentProofLedgerRow,
  cause: OperatorAgentProofUnavailableCause,
  value?: unknown,
): OperatorAgentProofUnmeasurable {
  return unmeasurable(row, cause, value);
}
