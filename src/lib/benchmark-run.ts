/** Private, metadata-only receipts. The enclosing ledger row owns run/assignment IDs; this
 * envelope deliberately contains neither IDs nor content, and grants no publication rights. */
import { loadConfig } from "./config.js";
import { appendLedger } from "./ledger.js";
import { ledgerPathFor } from "./ledger-path.js";
import { spawnWorker, workerLedgerFields, type WorkerResult } from "./worker.js";

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

function callEvidence(row: Record<string, unknown>) {
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

/** Keep the billing derivation at the canonical worker boundary, including cash-provider calls.
 * An empty result envelope carries default usage zeros, not observations. Codex CLI currently
 * supplies zero placeholders when dollars or token usage are not reported. */
export function benchmarkWorkerAttemptResources(result: WorkerResult) {
  const fields = workerLedgerFields(result);
  const observedEnvelope = typeof result.subtype === "string" && result.subtype.length > 0;
  const codexPlaceholder = result.provider === "codex";
  const costObserved = observedEnvelope && !(codexPlaceholder && result.costUsd === 0);
  const tokensObserved = observedEnvelope && !(codexPlaceholder && result.tokens.input === 0
    && result.tokens.output === 0 && result.tokens.cacheRead === 0 && result.tokens.cacheCreation === 0);
  return {
    served_model: fields.served_model,
    worker_duration_ms: fields.worker_duration_ms,
    ...(observedEnvelope ? { billing_mode: fields.billing_mode } : {}),
    ...(tokensObserved ? { tokens: fields.tokens } : {}),
    ...(costObserved ? { total_cost_usd: fields.total_cost_usd } : {}),
  };
}

/** One worker call, including non-final recon/repair calls. This is not a verified task outcome. */
export function benchmarkRunAttemptReceipt(row: Record<string, unknown>) {
  if (row.step !== "worker.attempt") return undefined;
  return {
    version: BENCHMARK_RUN_VERSION,
    phase: "attempt" as const,
    assignmentJoin: row.assignment_observed === false
      ? unavailable("assignment-not-observed-in-run")
      : typeof row.selection_assignment_id === "string" && row.selection_assignment_id.length > 0
      ? { state: "observed" as const, value: true as const }
      : unavailable("assignment-id-not-reported"),
    ...callEvidence(row),
  };
}

export function benchmarkRunTerminalReceipt(row: Record<string, unknown>, assignmentObserved: boolean) {
  // The task verdict is distinct from each worker-attempt receipt. Legacy consumers retain
  // this phase until the cohort builder can join end-to-end verification separately.
  if (row.step !== "verdict" || !assignmentObserved || typeof row.selection_assignment_id !== "string"
    || row.selection_assignment_id.length === 0) return undefined;
  return { version: BENCHMARK_RUN_VERSION, phase: "terminal" as const, ...callEvidence(row) };
}

/** Capture an auxiliary worker call without turning telemetry into a worker or PR gate. The
 * caller's existing assignment sink remains authoritative when one is supplied. */
export function benchmarkNonDispatchSpawn(
  lane: string, raw: typeof spawnWorker = spawnWorker,
): typeof spawnWorker {
  return async (args) => {
    let observedAssignmentId: string | undefined;
    const write = (step: string, fields: Record<string, unknown>): void => {
      const config = args.config ?? loadConfig();
      appendLedger(ledgerPathFor(config), {
        run_id: args.runId ?? `${lane}-${observedAssignmentId ?? "unassigned"}`,
        task_id: args.taskId ?? lane.toUpperCase(), step, lane, ...fields,
      });
    };
    const recordAttempt = (fields: Record<string, unknown>): void => {
      try {
        const row = { step: "worker.attempt", ...fields,
          assignment_observed: fields.selection_assignment_id === observedAssignmentId && observedAssignmentId !== undefined };
        write("worker.attempt", { ...fields, benchmark_run: benchmarkRunAttemptReceipt(row) });
      } catch {
        // A missing sink is coverage debt, never a reason to retry or change the worker result.
        console.error(JSON.stringify({ event: "benchmark.non_dispatch_attempt_unavailable", lane, reason: "ledger-write-failed" }));
      }
    };
    let result: WorkerResult;
    try {
      result = await raw({ ...args, onSelectionAssignment: (assignment) => {
        const priorId = observedAssignmentId;
        observedAssignmentId = assignment.id;
        try {
          write("worker.assignment", { worker_assignment: assignment,
            benchmark_run: benchmarkRunAssignmentReceipt(assignment, {}) });
        } catch {
          observedAssignmentId = priorId;
          console.error(JSON.stringify({ event: "benchmark.non_dispatch_assignment_unavailable", lane, reason: "ledger-write-failed" }));
        }
        // A failed benchmark sink must not skip the caller's existing assignment callback.
        args.onSelectionAssignment?.(assignment);
      }, onModelFallbackAttempt: (attempt) => {
        let resources: Record<string, unknown> = {};
        try { if (attempt.result) resources = benchmarkWorkerAttemptResources(attempt.result); }
        catch (error) {
          resources = { benchmark_run_unavailable_reason: "worker-result-fields-unavailable" };
          console.error(JSON.stringify({ event: "benchmark.non_dispatch_resource_unavailable", lane,
            reason: "worker-result-fields-unavailable",
            error_class: error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "non-error" }));
        }
        recordAttempt({ ...(attempt.selectionAssignmentId ? { selection_assignment_id: attempt.selectionAssignmentId } : {}),
          attempted_model: attempt.model, success: false, worker_failure: attempt.reason, ...resources });
        try { args.onModelFallbackAttempt?.(attempt); }
        catch { console.error(JSON.stringify({ event: "benchmark.non_dispatch_fallback_hook_unavailable", lane })); }
      } });
    } catch (error) {
      recordAttempt({ ...(observedAssignmentId ? { selection_assignment_id: observedAssignmentId } : {}),
        success: false, worker_failure: "spawn-threw-before-result" });
      throw error;
    }
    const assignmentId = result.selectionAssignmentId ?? observedAssignmentId;
    const observedEnvelope = typeof result.subtype === "string" && result.subtype.length > 0;
    let resources: Record<string, unknown>;
    try { resources = benchmarkWorkerAttemptResources(result); }
    catch (error) {
      resources = { benchmark_run_unavailable_reason: "worker-result-fields-unavailable" };
      console.error(JSON.stringify({ event: "benchmark.non_dispatch_resource_unavailable", lane,
        reason: "worker-result-fields-unavailable",
        error_class: error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "non-error" }));
    }
    recordAttempt({ ...(assignmentId ? { selection_assignment_id: assignmentId } : {}),
      ...(result.isError || result.apiError || result.usageRefusal ? { success: false }
        : observedEnvelope ? { success: true } : {}), ...resources });
    return result;
  };
}
