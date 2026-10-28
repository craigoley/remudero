import { attemptAssignmentJoin, ORPHANED_BY_PROCESS_EXIT } from "./benchmark-run.js";
import { QuietRoundEndedError } from "./quiet-worker-watchdog.js";
import { SubscriptionOnlyRefusedError, type SpawnWorkerArgs } from "./worker.js";
import {
  CASH_SERVED_MODEL_REASONS, CashDeploymentNotReadyError, OpenWeightAllowanceExhaustedError, OpenWeightDeploymentNotFoundError,
  OpenWeightRequestTimeoutError, OpenWeightRequestTooLargeError, OpenWeightTruncatedReplyError,
  OpenWeightUnsupportedResponseFormatError,
} from "./worker-provider.js";

/** W1-T10875: who an unsuccessful worker.attempt is attributed to before any count names a model.
 *  "unknown" is a third value the caller sees and reports, never folded into success or model. */
export type AttemptOutcome = "success" | "model" | "pre-request-refusal" | "infrastructure" | "unknown";
export interface AttemptAttribution { outcome: AttemptOutcome; signal: string }
export const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = ["success", "model", "pre-request-refusal", "infrastructure", "unknown"];

type FallbackReason = Parameters<NonNullable<SpawnWorkerArgs["onModelFallbackAttempt"]>>[0]["reason"];
// Typed against the ladder's own reason union, so a renamed reason fails to compile instead of drifting.
const PRE_REQUEST_FALLBACKS: readonly FallbackReason[] = ["deployment-absent", "unsupported-response-format", "cash-sonnet-refused"];
const MODEL_FALLBACKS: readonly FallbackReason[] = ["draft-contract"];
const SPAWN_THREW_BEFORE_ASSIGNMENT = attemptAssignmentJoin(undefined, true).selection_assignment_unavailable_reason;
// spawnFailureDetail records `error.constructor.name`; these compare against the classes themselves.
const PRE_REQUEST_ERRORS = new Set([OpenWeightRequestTooLargeError, SubscriptionOnlyRefusedError,
  OpenWeightUnsupportedResponseFormatError, OpenWeightAllowanceExhaustedError, OpenWeightDeploymentNotFoundError,
  CashDeploymentNotReadyError].map((type) => type.name));
const MODEL_ERRORS = new Set([OpenWeightTruncatedReplyError, OpenWeightRequestTimeoutError].map((type) => type.name));

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const observed = (value: unknown): unknown => record(value)?.state === "observed" ? record(value)!.value : undefined;
const positive = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value > 0;

/** A provider reply is evidenced by a named served model, an unnamed or mixed reply, or nonzero spend. */
function invocationEvidence(row: Readonly<Record<string, unknown>>): boolean {
  const reason = row.served_model_reason;
  return (typeof row.served_model === "string" && row.served_model.length > 0)
    || reason === CASH_SERVED_MODEL_REASONS.unnamed
    || (typeof reason === "string" && reason.startsWith(`${CASH_SERVED_MODEL_REASONS.mixed}: `))
    || Object.values(record(row.tokens) ?? {}).some(positive) || positive(row.total_cost_usd);
}

function infrastructureSignal(row: Readonly<Record<string, unknown>>): string | undefined {
  if (row.worker_failure === ORPHANED_BY_PROCESS_EXIT) return ORPHANED_BY_PROCESS_EXIT;
  if (row.selection_assignment_unavailable_reason === SPAWN_THREW_BEFORE_ASSIGNMENT) return SPAWN_THREW_BEFORE_ASSIGNMENT;
  if (row.error_class === QuietRoundEndedError.name) return "round-ended-for-restart-or-recycle";
  if (row.worker_exit === "signal" || (typeof row.worker_exit_signal === "string" && row.worker_exit_signal !== "")) {
    return "worker-exit-signal";
  }
  return undefined;
}

function preRequestSignal(row: Readonly<Record<string, unknown>>): string | undefined {
  const terminal = record(row.terminal_evidence);
  // The ladder's own refusal reason is more specific than the no-response reason it leaves beside it.
  if (PRE_REQUEST_FALLBACKS.includes(row.worker_failure as FallbackReason)) return `fallback-${String(row.worker_failure)}`;
  if (row.served_model_reason === CASH_SERVED_MODEL_REASONS.noResponse) return "cash-no-response";
  if (typeof row.error_class === "string" && PRE_REQUEST_ERRORS.has(row.error_class)) return `refused-${row.error_class}`;
  if (observed(terminal?.invocation) === "not-started") return "invocation-not-started";
  const spent = [terminal?.reservedUsd, terminal?.settledUsd].some((amount) => positive(observed(amount)));
  if (observed(terminal?.allowanceRefused) === true && spent === false) return "allowance-refused";
  return undefined;
}

/** Classify one worker.attempt ledger row. Each class is decided from named fields compared with the
 *  writers' exported constants; free text is never matched, so a reworded reason reads as unknown. */
export function attributeAttemptOutcome(row: Readonly<Record<string, unknown>>): AttemptAttribution {
  if (row.success === true) return { outcome: "success", signal: "success" };
  if (row.success !== false) return { outcome: "unknown", signal: "worker-outcome-unavailable" };
  const infrastructure = infrastructureSignal(row);
  if (infrastructure !== undefined) return { outcome: "infrastructure", signal: infrastructure };
  if (MODEL_FALLBACKS.includes(row.worker_failure as FallbackReason)) return { outcome: "model", signal: String(row.worker_failure) };
  if (typeof row.error_class === "string" && MODEL_ERRORS.has(row.error_class)) return { outcome: "model", signal: `reply-${row.error_class}` };
  const invoked = invocationEvidence(row);
  const refusal = preRequestSignal(row);
  if (refusal !== undefined) {
    return invoked ? { outcome: "unknown", signal: "refusal-with-invocation-evidence" } : { outcome: "pre-request-refusal", signal: refusal };
  }
  if (row.served_model_reason === CASH_SERVED_MODEL_REASONS.unnamed) return { outcome: "model", signal: "served-model-unnamed" };
  return invoked ? { outcome: "model", signal: "provider-invoked" } : { outcome: "unknown", signal: "no-attribution-signal" };
}
