/** Pure ledger-row validation; no filesystem, goal executor or retrospective imports. */
export type GoalMeasurement = "pr-flow-minutes" | "ci-friction-minutes" | "terminal-missing-percent";

export interface GoalObservation {
  goal_id: string;
  key: string;
  step: "goal.moved" | "goal.unmoved" | "goal.unmeasured";
  ts: string;
  baseline: number;
  value: number | null;
  reason?: string;
  tasks: string[];
  pricedUsd: number;
  unpricedRows: number;
  priorityAction: "governed-proposal";
  measurement: GoalMeasurement;
  windowDays: 7;
  costBasis: "produced-ledger-receipts";
  costComplete: boolean;
}

export function goalObservationFromRow(row: Record<string, unknown>): GoalObservation | undefined {
  if (typeof row.goal_id !== "string" || !/^G-[\w-]{1,80}$/.test(row.goal_id) ||
    !["goal.moved", "goal.unmoved", "goal.unmeasured"].includes(String(row.step)) ||
    typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts)) || typeof row.key !== "string" || !/^[a-f0-9]{64}$/.test(row.key) ||
    typeof row.baseline !== "number" || !Number.isFinite(row.baseline) ||
    !(row.value === null || typeof row.value === "number" && Number.isFinite(row.value)) ||
    !Array.isArray(row.tasks) || row.tasks.length > 1000 || !row.tasks.every((id) => typeof id === "string" && /^[A-Za-z0-9]+-T[0-9]+[a-z]?$/.test(id)) ||
    typeof row.pricedUsd !== "number" || !Number.isFinite(row.pricedUsd) || row.pricedUsd < 0 ||
    !Number.isSafeInteger(row.unpricedRows) || (row.unpricedRows as number) < 0 ||
    row.priorityAction !== "governed-proposal" || row.windowDays !== 7 || row.costBasis !== "produced-ledger-receipts" ||
    typeof row.costComplete !== "boolean" || !["pr-flow-minutes", "ci-friction-minutes", "terminal-missing-percent"].includes(String(row.measurement))) return undefined;
  if (row.step === "goal.unmeasured" ? row.value !== null : row.value === null) return undefined;
  return Object.fromEntries(["goal_id", "key", "step", "ts", "baseline", "value", "tasks", "pricedUsd", "unpricedRows", "priorityAction", "measurement", "windowDays", "costBasis", "costComplete", ...(typeof row.reason === "string" ? ["reason"] : [])]
    .map((key) => [key, key === "reason" ? (row.reason as string).slice(0, 256) : row[key]])) as unknown as GoalObservation;
}
