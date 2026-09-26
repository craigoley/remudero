/** Private, metadata-only receipts. The enclosing ledger row owns run/assignment IDs; this
 * envelope deliberately contains neither IDs nor content, and grants no publication rights. */
export const BENCHMARK_RUN_VERSION = "benchmark-run-v1" as const;

type Evidence<T> = { state: "observed"; value: T } | { state: "unavailable"; reason: string };
type Outcome = { state: "observed"; value: true } | { state: "failed"; value: false } | { state: "unavailable"; reason: string };

const unavailable = (reason: string): { state: "unavailable"; reason: string } => ({ state: "unavailable", reason });

function observedString(value: unknown, reason: string): Evidence<string> {
  return typeof value === "string" && value.trim().length > 0
    ? { state: "observed", value } : unavailable(reason);
}

function observedNonnegative(value: unknown, reason: string): Evidence<number> {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { state: "observed", value } : unavailable(reason);
}

export interface BenchmarkRunAssignmentInput {
  id: string;
  requested: { model: string; effort: string };
  selected: { provider: string; model: string; effort: string };
}

export function benchmarkRunAssignmentReceipt(
  assignment: BenchmarkRunAssignmentInput,
  work: { taskClass?: string; risk?: string },
) {
  // No inference from checkout HEAD, route, or site-level consent: none of those pins the
  // actual prompt/tools/scorer used by this worker call or grants this instance publication.
  const revision = unavailable("not-pinned-by-harness");
  return {
    version: BENCHMARK_RUN_VERSION,
    phase: "assignment" as const,
    work: {
      taskClass: observedString(work.taskClass, "not-recorded-at-assignment"),
      risk: observedString(work.risk, "not-recorded-at-assignment"),
    },
    stack: {
      provider: observedString(assignment.selected.provider, "routing-provider-unavailable"),
      requestedModel: observedString(assignment.requested.model, "requested-model-unavailable"),
      selectedModel: observedString(assignment.selected.model, "selected-model-unavailable"),
      requestedEffort: observedString(assignment.requested.effort, "requested-effort-unavailable"),
      selectedEffort: observedString(assignment.selected.effort, "selected-effort-unavailable"),
      harnessRevision: revision,
      promptRevision: revision,
      toolRevision: revision,
      scorerRevision: revision,
      environmentRevision: revision,
    },
    rights: { state: "private" as const, reason: "no-local-consent-receipt" },
    allocation: { method: "observational" as const, reason: "no-random-allocation-receipt" },
  };
}

export function benchmarkRunTerminalReceipt(row: Record<string, unknown>, assignmentObserved: boolean) {
  // Intermediate worker rows can carry identical workerLedgerFields, but they are not a
  // terminal task outcome. An orphan terminal belongs in coverage debt, not a model cohort.
  if (row.step !== "verdict" || !assignmentObserved || typeof row.selection_assignment_id !== "string"
    || row.selection_assignment_id.length === 0) return undefined;

  const rawTokens = row.tokens && typeof row.tokens === "object" && !Array.isArray(row.tokens)
    ? row.tokens as Record<string, unknown> : undefined;
  const input = observedNonnegative(rawTokens?.input, "worker-tokens-not-reported");
  const output = observedNonnegative(rawTokens?.output, "worker-tokens-not-reported");
  const tokens: Evidence<{ input: number; output: number }> = input.state === "observed" && output.state === "observed"
    ? { state: "observed", value: { input: input.value, output: output.value } }
    : unavailable("worker-tokens-not-reported");
  const workerCall: Outcome = row.success === true ? { state: "observed", value: true }
    : row.success === false ? { state: "failed", value: false }
      : unavailable("worker-outcome-not-reported");
  const cost = observedNonnegative(row.total_cost_usd, "worker-cost-not-reported");
  const billingMode = row.billing_mode === "api" || row.billing_mode === "subscription"
    ? row.billing_mode : undefined;
  const otherMode = unavailable("different-billing-mode");
  return {
    version: BENCHMARK_RUN_VERSION,
    phase: "terminal" as const,
    workerCall,
    servedModel: observedString(row.served_model, "provider-did-not-report-served-model"),
    tokens,
    durationMs: observedNonnegative(row.worker_duration_ms, "worker-duration-not-reported"),
    accounting: {
      source: "worker-result-estimate-not-invoice" as const,
      billingMode: billingMode ? { state: "observed" as const, value: billingMode } : unavailable("billing-mode-not-reported"),
      apiCostUsd: billingMode === "api" ? cost : billingMode ? otherMode : unavailable("billing-mode-not-reported"),
      subscriptionNotionalUsd: billingMode === "subscription" ? cost : billingMode ? otherMode : unavailable("billing-mode-not-reported"),
    },
  };
}
