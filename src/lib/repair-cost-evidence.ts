/** Private PR repair accounting from the existing caller-owned worker receipts. */
const PR = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9][0-9]*)$/;

export interface RepairReceiptContext { prUrl: string; roundId: string }
export interface RepairCostContext {
  repo: string | null; number: number | null; roundId: string | null;
  workerRunId: string | null; rung: string | null; assignmentObserved: boolean;
}
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

export function repairReceiptFields(context?: RepairReceiptContext): Record<string, string> {
  return context && PR.test(context.prUrl) && text(context.roundId) !== null
    ? { repair_pr_url: context.prUrl, repair_round_id: context.roundId } : {};
}

export function projectRepairCostContext(row: Record<string, unknown>): RepairCostContext {
  const match = PR.exec(String(row.repair_pr_url ?? "")); const number = Number(match?.[2]);
  return { repo: match?.[1] ?? null, number: match && Number.isSafeInteger(number) ? number : null,
    roundId: text(row.repair_round_id), workerRunId: text(row.worker_run_id), rung: text(row.worker_rung),
    assignmentObserved: row.assignment_observed !== false };
}

export interface RepairCostRow {
  step: string; assignmentId: string | null; costUsd: number | null; billingMode: "api" | "subscription" | null;
  provider?: string | null;
  notionalCostReported?: boolean; notionalCostUsd?: number | null; repair?: RepairCostContext;
}
export interface RepairCostReport {
  source: "worker-result-estimate-not-invoice"; history: "unavailable-retention-uncertified";
  identifiedAssignments: number; knownApiAttempts: number; knownSubscriptionAttempts: number;
  missingTerminal: number; missingCost: number; conflictingIdentities: number; unjoinedAttemptRows: number;
  apiCostEstimateUsd: number | null; subscriptionNotionalUsd: number | null;
}

function empty(): RepairCostReport {
  return { source: "worker-result-estimate-not-invoice", history: "unavailable-retention-uncertified",
    identifiedAssignments: 0, knownApiAttempts: 0, knownSubscriptionAttempts: 0, missingTerminal: 0,
    missingCost: 0, conflictingIdentities: 0, unjoinedAttemptRows: 0,
    apiCostEstimateUsd: null, subscriptionNotionalUsd: null };
}

/** A run/assignment is a worker rung whose result aggregates any SDK-internal calls. Replayed
 * ledger lines and final verdicts are never additional charges; unknown history stays unknown. */
export function repairCostsByPull(rows: readonly RepairCostRow[], repo: string): Map<number, RepairCostReport> {
  const reports = new Map<number, RepairCostReport>();
  const reportFor = (number: number) => {
    let report = reports.get(number);
    if (report === undefined) { report = empty(); reports.set(number, report); }
    return report;
  };
  const groups = new Map<string, RepairCostRow[]>();
  for (const row of rows) {
    if (row.repair?.rung !== "fix" || (row.step !== "worker.assignment" && row.step !== "worker.attempt")) continue;
    const key = row.repair.workerRunId && row.assignmentId ? JSON.stringify([row.repair.workerRunId, row.assignmentId]) : null;
    if (key === null) {
      if (row.step === "worker.attempt" && row.repair.repo === repo && row.repair.number !== null)
        reportFor(row.repair.number).unjoinedAttemptRows += 1;
    } else {
      let group = groups.get(key);
      if (group === undefined) { group = []; groups.set(key, group); }
      group.push(row);
    }
  }
  for (const group of groups.values()) {
    const numbers = new Set(group.flatMap((row) => row.repair?.repo === repo && row.repair.number !== null ? [row.repair.number] : []));
    for (const number of numbers) accountGroup(group, reportFor(number));
  }
  return reports;
}

function accountGroup(group: RepairCostRow[], result: RepairCostReport): void {
    const assigned = group.filter((row) => row.step === "worker.assignment");
    const attempts = group.filter((row) => row.step === "worker.attempt");
    if (assigned.length === 0) { result.unjoinedAttemptRows += attempts.length; return; }
    result.identifiedAssignments += 1;
    const identities = new Set(group.map((row) => JSON.stringify([row.repair?.repo, row.repair?.number, row.repair?.roundId])));
    const firstIdentity = assigned[0]!.repair;
    if (identities.size !== 1 || firstIdentity === undefined || firstIdentity.roundId === null
      || group.some((row) => row.repair?.assignmentObserved === false)) {
      result.conflictingIdentities += 1; return;
    }
    if (attempts.length === 0) { result.missingTerminal += 1; return; }
    const providers = new Set(group.flatMap((row) => typeof row.provider === "string" ? [row.provider] : []));
    if (providers.size > 1) { result.conflictingIdentities += 1; return; }
    const provider = providers.values().next().value;
    const costs = new Set(attempts.map((row) => JSON.stringify([row.billingMode, row.costUsd,
      row.notionalCostReported ?? false, row.notionalCostUsd ?? null])));
    if (costs.size !== 1) { result.conflictingIdentities += 1; return; }
    const terminal = attempts[0]!;
    const cost = terminal.billingMode === "subscription"
      ? terminal.notionalCostReported ? terminal.notionalCostUsd ?? null
        : provider === "codex" ? null : terminal.costUsd
      : terminal.costUsd;
    if (cost === null || !Number.isFinite(cost) || cost < 0 || terminal.billingMode === null) {
      result.missingCost += 1; return;
    }
    if (terminal.billingMode === "api") {
      result.knownApiAttempts += 1; result.apiCostEstimateUsd = (result.apiCostEstimateUsd ?? 0) + cost;
    } else {
      result.knownSubscriptionAttempts += 1; result.subscriptionNotionalUsd = (result.subscriptionNotionalUsd ?? 0) + cost;
    }
}

export function repairCostCells(reports: readonly RepairCostReport[]): RepairCostReport {
  const result = empty();
  for (const report of reports) {
    for (const key of ["identifiedAssignments", "knownApiAttempts", "knownSubscriptionAttempts", "missingTerminal",
      "missingCost", "conflictingIdentities", "unjoinedAttemptRows"] as const) result[key] += report[key];
    if (report.knownApiAttempts > 0) result.apiCostEstimateUsd = (result.apiCostEstimateUsd ?? 0) + report.apiCostEstimateUsd!;
    if (report.knownSubscriptionAttempts > 0)
      result.subscriptionNotionalUsd = (result.subscriptionNotionalUsd ?? 0) + report.subscriptionNotionalUsd!;
  }
  return result;
}
