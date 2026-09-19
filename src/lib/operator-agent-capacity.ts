/**
 * Read-only capacity signal for the operator-agent projection.
 *
 * Queue depth is pressure, not utilization. A useful capacity observation must join the
 * configured bound, the scheduler's admitted lanes, the worker occupancy, and the queue sample
 * to one measurement window. Missing any of those fields keeps the row unavailable so the agent
 * cannot recommend scaling from a queue count alone.
 */

// PRIMARY CONTROL: this is a signal namespace, not a scheduler timeout or capacity ceiling.
export const OPERATOR_AGENT_CAPACITY_SIGNAL = "worker-capacity" as const;

export type OperatorAgentCapacityRecommendation = "scale-up" | "underutilized" | "balanced";

export type OperatorAgentCapacityUnavailableCause =
  | "missing-repo"
  | "missing-configured-capacity"
  | "missing-admitted-lanes"
  | "missing-active-workers"
  | "missing-queued-work"
  | "missing-window-start"
  | "missing-window-end"
  | "invalid-window";

/** Raw fields supplied by the ledger/telemetry caller. This adapter does not read or write a ledger. */
export interface OperatorAgentCapacityLedgerRow {
  repo?: unknown;
  repository?: unknown;
  configured_capacity?: unknown;
  configured_pool_size?: unknown;
  worker_pool_size?: unknown;
  wip_limit?: unknown;
  admitted_lanes?: unknown;
  lane_budget?: unknown;
  active_workers?: unknown;
  queued_work?: unknown;
  queue_pending?: unknown;
  window_start?: unknown;
  measurement_start?: unknown;
  window_end?: unknown;
  measurement_end?: unknown;
}

export interface OperatorAgentCapacityMeasurement {
  repo: string;
  configuredCapacity: number;
  admittedLanes: number;
  activeWorkers: number;
  queuedWork: number;
  utilizationRatio: number;
  windowStart: string;
  windowEnd: string;
  recommendation: OperatorAgentCapacityRecommendation;
}

export interface OperatorAgentCapacityUnavailable {
  repo?: string;
  missing: OperatorAgentCapacityUnavailableCause[];
  why: string;
}

export interface OperatorAgentCapacitySignal {
  signal: typeof OPERATOR_AGENT_CAPACITY_SIGNAL;
  status: "measured" | "not-collected";
  measurements: OperatorAgentCapacityMeasurement[];
  unavailable: OperatorAgentCapacityUnavailable[];
}

function stringField(row: OperatorAgentCapacityLedgerRow, keys: readonly (keyof OperatorAgentCapacityLedgerRow)[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberField(row: OperatorAgentCapacityLedgerRow, keys: readonly (keyof OperatorAgentCapacityLedgerRow)[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function validCount(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

function validCapacity(value: number | undefined): value is number {
  return validCount(value) && value > 0;
}

function validWindow(value: string | undefined): value is string {
  return value !== undefined && Number.isFinite(Date.parse(value));
}

function unavailable(
  row: OperatorAgentCapacityLedgerRow,
  repo: string | undefined,
  missing: OperatorAgentCapacityUnavailableCause[],
): OperatorAgentCapacityUnavailable {
  const labels: Record<OperatorAgentCapacityUnavailableCause, string> = {
    "missing-repo": "repository identity is missing",
    "missing-configured-capacity": "configured pool or lane capacity is missing or invalid",
    "missing-admitted-lanes": "observed admitted lanes are missing or invalid",
    "missing-active-workers": "observed worker occupancy is missing or invalid",
    "missing-queued-work": "queued work is missing or invalid",
    "missing-window-start": "measurement-window start is missing or invalid",
    "missing-window-end": "measurement-window end is missing or invalid",
    "invalid-window": "measurement-window end does not follow its start",
  };
  const fields = missing.map((cause) => labels[cause]).join("; ");
  return {
    ...(repo ? { repo } : {}),
    missing,
    why: `${repo ?? "capacity observation"}: ${fields}; no utilization or scale signal was emitted`,
  };
}

function recommendation(
  configuredCapacity: number,
  admittedLanes: number,
  activeWorkers: number,
  queuedWork: number,
): OperatorAgentCapacityRecommendation {
  // A scale-up signal requires both queue pressure and observed occupancy at the configured
  // bound. Queue depth by itself therefore cannot create a scaling proposal.
  if (queuedWork > 0 && activeWorkers >= configuredCapacity && admittedLanes >= configuredCapacity) return "scale-up";
  if (queuedWork === 0 && activeWorkers < configuredCapacity && admittedLanes < configuredCapacity) return "underutilized";
  return "balanced";
}

/** Adapt supplied capacity rows without guessing configured worker count or mutating state. */
export function adaptOperatorAgentCapacityRows(rows: readonly OperatorAgentCapacityLedgerRow[]): OperatorAgentCapacitySignal {
  const measurements: OperatorAgentCapacityMeasurement[] = [];
  const unavailableRows: OperatorAgentCapacityUnavailable[] = [];

  for (const row of rows) {
    const repo = stringField(row, ["repo", "repository"]);
    const configuredCapacity = numberField(row, ["configured_capacity", "configured_pool_size", "worker_pool_size", "wip_limit"]);
    const admittedLanes = numberField(row, ["admitted_lanes", "lane_budget"]);
    const activeWorkers = numberField(row, ["active_workers"]);
    const queuedWork = numberField(row, ["queued_work", "queue_pending"]);
    const windowStart = stringField(row, ["window_start", "measurement_start"]);
    const windowEnd = stringField(row, ["window_end", "measurement_end"]);
    const missing: OperatorAgentCapacityUnavailableCause[] = [];

    if (!repo) missing.push("missing-repo");
    if (!validCapacity(configuredCapacity)) missing.push("missing-configured-capacity");
    if (!validCount(admittedLanes)) missing.push("missing-admitted-lanes");
    if (!validCount(activeWorkers)) missing.push("missing-active-workers");
    if (!validCount(queuedWork)) missing.push("missing-queued-work");
    if (!validWindow(windowStart)) missing.push("missing-window-start");
    if (!validWindow(windowEnd)) missing.push("missing-window-end");
    if (validWindow(windowStart) && validWindow(windowEnd) && Date.parse(windowEnd) <= Date.parse(windowStart)) {
      missing.push("invalid-window");
    }
    if (missing.length > 0) {
      unavailableRows.push(unavailable(row, repo, missing));
      continue;
    }
    const measuredRepo = repo as string;
    const measuredConfiguredCapacity = configuredCapacity as number;
    const measuredAdmittedLanes = admittedLanes as number;
    const measuredActiveWorkers = activeWorkers as number;
    const measuredQueuedWork = queuedWork as number;
    const measuredWindowStart = windowStart as string;
    const measuredWindowEnd = windowEnd as string;
    measurements.push({
      repo: measuredRepo,
      configuredCapacity: measuredConfiguredCapacity,
      admittedLanes: measuredAdmittedLanes,
      activeWorkers: measuredActiveWorkers,
      queuedWork: measuredQueuedWork,
      utilizationRatio: measuredActiveWorkers / measuredConfiguredCapacity,
      windowStart: measuredWindowStart,
      windowEnd: measuredWindowEnd,
      recommendation: recommendation(measuredConfiguredCapacity, measuredAdmittedLanes, measuredActiveWorkers, measuredQueuedWork),
    });
  }

  return {
    signal: OPERATOR_AGENT_CAPACITY_SIGNAL,
    status: measurements.length > 0 ? "measured" : "not-collected",
    measurements,
    unavailable: unavailableRows,
  };
}
