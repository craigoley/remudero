/**
 * Read-only proof-execution signal for the operator-agent projection.
 *
 * `review.posted.proof_exec` is criterion-level evidence. This adapter counts only the explicit
 * proof outcomes and keeps non-executable and execution-error outcomes outside the pass/fail
 * denominator. A missing or malformed proof field remains visible as unmeasurable.
 */

export const OPERATOR_AGENT_PROOF_SIGNAL = "proof-outcomes" as const;

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

/** Adapt selected ledger rows without writing state or treating missing proof evidence as a pass. */
export function adaptOperatorAgentProofRows(rows: readonly OperatorAgentProofLedgerRow[]): OperatorAgentProofSignal {
  let reviewRows = 0;
  let executedPass = 0;
  let executedFail = 0;
  let nonExecutable = 0;
  let executionError = 0;
  let otherObserved = 0;
  const unmeasurable: OperatorAgentProofUnmeasurable[] = [];

  for (const row of rows) {
    if (row.step !== "review.posted") continue;
    reviewRows += 1;
    if (!Array.isArray(row.proof_exec)) {
      unmeasurable.push(unmeasurableRow(row, "missing-proof-exec", row.proof_exec));
      continue;
    }
    if (row.proof_exec.length === 0) {
      unmeasurable.push(unmeasurableRow(row, "empty-proof-exec"));
      continue;
    }
    for (const outcome of row.proof_exec) {
      if (outcome === "executed_pass") executedPass += 1;
      else if (outcome === "executed_fail") executedFail += 1;
      else if (typeof outcome === "string" && NON_EXECUTABLE.has(outcome)) nonExecutable += 1;
      else if (typeof outcome === "string" && EXECUTION_ERROR.has(outcome)) executionError += 1;
      else if (typeof outcome === "string" && OTHER_OBSERVED.has(outcome)) otherObserved += 1;
      else unmeasurable.push(unmeasurableRow(row, "unknown-proof-exec", outcome));
    }
  }

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
    unmeasurable,
    ...(denominator > 0 ? {} : { unavailableReason: "no executed proof pass/fail outcome is available yet" }),
  };
}

function unmeasurableRow(
  row: OperatorAgentProofLedgerRow,
  cause: OperatorAgentProofUnavailableCause,
  value?: unknown,
): OperatorAgentProofUnmeasurable {
  return unmeasurable(row, cause, value);
}
