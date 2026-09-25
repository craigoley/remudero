/** Quality of retained model evidence, not a model score or an experimental estimate.
 * Inputs contain local join keys; the returned projection contains only fixed-schema counts. */
export const BENCHMARK_QUALITY_VERSION = "benchmark-quality-v1" as const;

export interface BenchmarkAssignmentEvidence {
  id: string;
  taskClass?: string;
  risk?: string;
  requestedModel?: string;
  selectedModel?: string;
  provider?: string;
  effort?: string;
}

export interface BenchmarkTerminalEvidence {
  success?: boolean;
  servedModel?: string | null;
  tokensMeasured?: boolean;
  durationMs?: number;
  billingMode?: "api" | "subscription";
  costUsd?: number;
}

export interface BenchmarkEvidenceInput {
  assignments: ReadonlyMap<string, BenchmarkAssignmentEvidence>;
  joinedTerminals: ReadonlyMap<string, BenchmarkTerminalEvidence>;
  unmatchedTerminals: ReadonlyMap<string, BenchmarkTerminalEvidence>;
  assignmentRowsSeen: number;
  terminalRowsSeen: number;
  invalidAssignmentRows: number;
  terminalsWithoutAssignmentId: number;
  duplicateAssignmentRows: number;
  duplicateTerminalRows: number;
  asOf: string | null;
  latestSourceAt: string | null;
  /** An unreadable source invalidates all partial counts; never publish healthy/empty. */
  sourceUnavailableReason?: "ledger-source-unreadable" | "ledger-source-missing";
}

export interface BenchmarkFieldCoverage {
  /** Assignment-based denominator; unmatched terminal rows are reported separately. */
  denominator: number;
  observed: number;
  noTerminal: number;
  notRecorded: number;
}

export type BenchmarkCoverageField =
  | "taskClass" | "risk" | "requestedModel" | "selectedModel" | "provider" | "effort"
  | "outcome" | "servedModel" | "tokens" | "duration" | "billingMode" | "cost";

export interface BenchmarkEvidenceSnapshot {
  version: typeof BENCHMARK_QUALITY_VERSION;
  state: "observed" | "unavailable";
  reason?: string;
  asOf: string | null;
  latestSourceAt: string | null;
  sourceRows: { assignments: number; terminals: number; invalidAssignments: number; terminalsWithoutAssignmentId: number };
  assignments: number;
  joinedTerminalOutcomes: number;
  assignmentsWithoutTerminal: number;
  terminalsWithoutAssignment: number;
  duplicates: { assignmentRows: number; terminalRows: number };
  outcomes: { success: number; failure: number; unavailable: number };
  modelEvidence: { requestedDifferentFromSelected: number; servedDifferentFromSelected: number };
  experimentalCrossover: "unavailable-no-random-allocation-receipt";
  coverage: Record<BenchmarkCoverageField, BenchmarkFieldCoverage>;
  accounting: {
    source: "worker-result-estimate-not-invoice";
    apiRequestsWithCost: number;
    apiRequestCostUsd: number;
    subscriptionCallsWithNotionalCost: number;
    subscriptionNotionalCostUsd: number;
    unclassifiedCostRows: number;
  };
}

const ASSIGNMENT_FIELDS = ["taskClass", "risk", "requestedModel", "selectedModel", "provider", "effort"] as const;
const TERMINAL_FIELDS = ["outcome", "servedModel", "tokens", "duration", "billingMode", "cost"] as const;

function blankCoverage(denominator: number): BenchmarkFieldCoverage {
  return { denominator, observed: 0, noTerminal: 0, notRecorded: 0 };
}

function allCoverage(assignmentCount: number, invalidAssignmentRows: number): Record<BenchmarkCoverageField, BenchmarkFieldCoverage> {
  return {
    taskClass: blankCoverage(assignmentCount + invalidAssignmentRows),
    risk: blankCoverage(assignmentCount + invalidAssignmentRows),
    requestedModel: blankCoverage(assignmentCount + invalidAssignmentRows),
    selectedModel: blankCoverage(assignmentCount + invalidAssignmentRows),
    provider: blankCoverage(assignmentCount + invalidAssignmentRows),
    effort: blankCoverage(assignmentCount + invalidAssignmentRows),
    outcome: blankCoverage(assignmentCount),
    servedModel: blankCoverage(assignmentCount),
    tokens: blankCoverage(assignmentCount),
    duration: blankCoverage(assignmentCount),
    billingMode: blankCoverage(assignmentCount),
    cost: blankCoverage(assignmentCount),
  };
}

function presentString(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function nonnegative(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function usd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function unavailableBenchmarkEvidence(reason: string): BenchmarkEvidenceSnapshot {
  return {
    version: BENCHMARK_QUALITY_VERSION,
    state: "unavailable",
    reason,
    asOf: null,
    latestSourceAt: null,
    sourceRows: { assignments: 0, terminals: 0, invalidAssignments: 0, terminalsWithoutAssignmentId: 0 },
    assignments: 0,
    joinedTerminalOutcomes: 0,
    assignmentsWithoutTerminal: 0,
    terminalsWithoutAssignment: 0,
    duplicates: { assignmentRows: 0, terminalRows: 0 },
    outcomes: { success: 0, failure: 0, unavailable: 0 },
    modelEvidence: { requestedDifferentFromSelected: 0, servedDifferentFromSelected: 0 },
    experimentalCrossover: "unavailable-no-random-allocation-receipt",
    coverage: allCoverage(0, 0),
    accounting: {
      source: "worker-result-estimate-not-invoice",
      apiRequestsWithCost: 0,
      apiRequestCostUsd: 0,
      subscriptionCallsWithNotionalCost: 0,
      subscriptionNotionalCostUsd: 0,
      unclassifiedCostRows: 0,
    },
  };
}

/** This is intentionally a second pass over compact local join state, never over the ledger. */
export function deriveBenchmarkEvidence(input: BenchmarkEvidenceInput): BenchmarkEvidenceSnapshot {
  if (input.sourceUnavailableReason) return unavailableBenchmarkEvidence(input.sourceUnavailableReason);
  if (input.assignmentRowsSeen === 0 && input.terminalRowsSeen === 0) {
    return unavailableBenchmarkEvidence("no-assignment-or-terminal-evidence-in-retained-ledger");
  }

  const result = unavailableBenchmarkEvidence("not-yet-derived");
  result.state = "observed";
  delete result.reason;
  result.asOf = input.asOf;
  result.latestSourceAt = input.latestSourceAt;
  result.sourceRows = {
    assignments: input.assignmentRowsSeen,
    terminals: input.terminalRowsSeen,
    invalidAssignments: input.invalidAssignmentRows,
    terminalsWithoutAssignmentId: input.terminalsWithoutAssignmentId,
  };
  result.assignments = input.assignments.size;
  result.terminalsWithoutAssignment = input.unmatchedTerminals.size + input.terminalsWithoutAssignmentId;
  result.duplicates = { assignmentRows: input.duplicateAssignmentRows, terminalRows: input.duplicateTerminalRows };
  result.coverage = allCoverage(input.assignments.size, input.invalidAssignmentRows);
  for (const field of ASSIGNMENT_FIELDS) result.coverage[field].notRecorded = input.invalidAssignmentRows;

  for (const assignment of input.assignments.values()) {
    for (const field of ASSIGNMENT_FIELDS) {
      if (presentString(assignment[field])) result.coverage[field].observed += 1;
      else result.coverage[field].notRecorded += 1;
    }
    if (presentString(assignment.requestedModel) && presentString(assignment.selectedModel)
      && assignment.requestedModel !== assignment.selectedModel) result.modelEvidence.requestedDifferentFromSelected += 1;

    const terminal = input.joinedTerminals.get(assignment.id);
    if (!terminal) {
      result.assignmentsWithoutTerminal += 1;
      result.outcomes.unavailable += 1;
      for (const field of TERMINAL_FIELDS) result.coverage[field].noTerminal += 1;
      continue;
    }
    result.joinedTerminalOutcomes += 1;
    if (terminal.success === true) result.outcomes.success += 1;
    else if (terminal.success === false) result.outcomes.failure += 1;
    else result.outcomes.unavailable += 1;

    const observed: Record<(typeof TERMINAL_FIELDS)[number], boolean> = {
      outcome: typeof terminal.success === "boolean",
      servedModel: presentString(terminal.servedModel),
      tokens: terminal.tokensMeasured === true,
      duration: nonnegative(terminal.durationMs),
      billingMode: terminal.billingMode === "api" || terminal.billingMode === "subscription",
      cost: nonnegative(terminal.costUsd),
    };
    for (const field of TERMINAL_FIELDS) {
      if (observed[field]) result.coverage[field].observed += 1;
      else result.coverage[field].notRecorded += 1;
    }
    if (observed.servedModel && presentString(assignment.selectedModel)
      && terminal.servedModel !== assignment.selectedModel) result.modelEvidence.servedDifferentFromSelected += 1;

    if (observed.cost && terminal.billingMode === "api") {
      result.accounting.apiRequestsWithCost += 1;
      result.accounting.apiRequestCostUsd = usd(result.accounting.apiRequestCostUsd + terminal.costUsd!);
    } else if (observed.cost && terminal.billingMode === "subscription") {
      result.accounting.subscriptionCallsWithNotionalCost += 1;
      result.accounting.subscriptionNotionalCostUsd = usd(result.accounting.subscriptionNotionalCostUsd + terminal.costUsd!);
    } else if (observed.cost) {
      result.accounting.unclassifiedCostRows += 1;
    }
  }
  return result;
}
