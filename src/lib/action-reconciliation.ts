import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const EXTERNAL_EFFECT_VERSION = "external-effect-v1" as const;

export const EXTERNAL_EFFECT_STATES = [
  "applied",
  "refused",
  "pending",
  "partially-applied",
  "drifted",
  "stale",
  "unobservable",
] as const;

export type ExternalEffectState = (typeof EXTERNAL_EFFECT_STATES)[number];
export type ExternalAttemptOutcome = "applied" | "refused" | "pending" | "partially-applied";

export interface ExternalPostcondition {
  path: string;
  equals: unknown;
  description?: string;
}

export interface ExternalObservation {
  observedState: Record<string, unknown>;
  observedAt: string;
  /** Provider payload is accepted only at this seam and is never copied to a result. */
  evidence?: unknown;
}

export interface UnavailableExternalObservation {
  kind: "unavailable";
  reason: string;
  evidence?: unknown;
}

export type ExternalObservationResponse = ExternalObservation | UnavailableExternalObservation;

export interface ExternalEffectAuthority {
  capabilityGrantId: string;
  expiresAt: string;
  budgetUsd: number;
  spentUsd: number;
  retryCostUsd: number;
}

export interface ExternalEffectAttempt {
  outcome: ExternalAttemptOutcome;
  attemptNumber: number;
  maxAttempts: number;
  idempotent: boolean;
}

export interface ExternalEffectRequest {
  originatingActionId: string;
  originatingReceiptId: string;
  capabilityGrantId: string;
  connector: string;
  targetIdentity: string;
  requestedOperation: string;
  preconditionSnapshot: Record<string, unknown>;
  expectedPostconditions: readonly ExternalPostcondition[];
  idempotencyKey: string;
  freshnessMs: number;
  authority: ExternalEffectAuthority;
  attempt: ExternalEffectAttempt;
  observe: () => Promise<ExternalObservationResponse>;
  now?: () => Date;
}

export interface ExternalEffectRetryPath {
  kind: "none" | "retry" | "compensation";
  allowed: boolean;
  reason: string;
  attemptNumber?: number;
}

export interface ExternalEffectFreshness {
  status: "fresh" | "stale" | "unavailable";
  observedAt?: string;
  ageMs?: number;
  maxAgeMs: number;
}

export interface ExternalEffectResult {
  version: typeof EXTERNAL_EFFECT_VERSION;
  originatingActionId: string;
  originatingReceiptId: string;
  capabilityGrantId: string;
  connector: string;
  targetIdentity: string;
  requestedOperation: string;
  preconditionSnapshot: Record<string, unknown>;
  expectedPostconditions: readonly ExternalPostcondition[];
  observedState?: Record<string, unknown>;
  observation: ExternalEffectFreshness;
  idempotencyKey: string;
  reconciliationState: ExternalEffectState;
  partialSuccess?: {
    satisfied: readonly string[];
    unsatisfied: readonly string[];
  };
  retryPath: ExternalEffectRetryPath;
  evidenceReference: string;
  safeToComplete: boolean;
  reason?: string;
}

interface RedactionContainer {
  [key: string]: unknown;
}

const SENSITIVE_KEY = /(?:authorization|api[-_]?key|credential|cookie|password|secret|token|private[-_]?key)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnavailableObservation(response: ExternalObservationResponse): response is UnavailableExternalObservation {
  return isRecord(response) && response.kind === "unavailable";
}

/** Copy connector data into a bounded, credential-free value. Raw provider output never crosses this seam. */
export function redactConnectorEvidence(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactConnectorEvidence(item));
  if (isRecord(value)) {
    const output: RedactionContainer = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redactConnectorEvidence(childValue, childKey);
    }
    return output;
  }
  if (typeof value === "string" && /^(?:bearer\s+|sk-|gh[ps]_|xox[baprs]-)/i.test(value)) return "[REDACTED]";
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function evidenceReference(value: unknown): string {
  const redacted = redactConnectorEvidence(value);
  return `sha256:${createHash("sha256").update(canonicalJson(redacted), "utf8").digest("hex")}`;
}

function valueAtPath(value: unknown, path: string): unknown {
  if (path.trim() === "") return value;
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function validateRequest(input: ExternalEffectRequest): void {
  if (!input.originatingActionId || !input.originatingReceiptId || !input.capabilityGrantId) throw new Error("external effect requires its originating action and capability grant");
  if (input.authority.capabilityGrantId !== input.capabilityGrantId) throw new Error("external effect authority does not match its capability grant");
  if (!input.connector || !input.targetIdentity || !input.requestedOperation || !input.idempotencyKey) throw new Error("external effect identity is incomplete");
  if (!Number.isFinite(input.freshnessMs) || input.freshnessMs < 0) throw new Error("external effect freshness must be non-negative");
  if (!Number.isInteger(input.attempt.attemptNumber) || input.attempt.attemptNumber < 1) throw new Error("external effect attempt number must be positive");
  if (!Number.isInteger(input.attempt.maxAttempts) || input.attempt.maxAttempts < input.attempt.attemptNumber) throw new Error("external effect attempt budget is invalid");
  if (input.authority.budgetUsd < 0 || input.authority.spentUsd < 0 || input.authority.retryCostUsd < 0) throw new Error("external effect authority budget is invalid");
}

function retryPath(input: ExternalEffectRequest, now: Date): ExternalEffectRetryPath {
  if (!input.attempt.idempotent) return { kind: "compensation", allowed: false, reason: "non-idempotent operation requires compensation, not replay" };
  if (input.attempt.attemptNumber >= input.attempt.maxAttempts) return { kind: "retry", allowed: false, reason: "retry attempt budget exhausted" };
  if (Date.parse(input.authority.expiresAt) <= now.getTime()) return { kind: "retry", allowed: false, reason: "original capability grant expired" };
  if (input.authority.spentUsd + input.authority.retryCostUsd > input.authority.budgetUsd) return { kind: "retry", allowed: false, reason: "original capability grant budget exhausted" };
  return { kind: "retry", allowed: true, reason: "retry remains within the original authority, idempotency key, and budget", attemptNumber: input.attempt.attemptNumber + 1 };
}

function resultBase(input: ExternalEffectRequest, observation: ExternalEffectFreshness, state: ExternalEffectState, now: Date): ExternalEffectResult {
  return {
    version: EXTERNAL_EFFECT_VERSION,
    originatingActionId: input.originatingActionId,
    originatingReceiptId: input.originatingReceiptId,
    capabilityGrantId: input.capabilityGrantId,
    connector: input.connector,
    targetIdentity: input.targetIdentity,
    requestedOperation: input.requestedOperation,
    preconditionSnapshot: redactConnectorEvidence(input.preconditionSnapshot) as Record<string, unknown>,
    expectedPostconditions: input.expectedPostconditions.map((postcondition) => ({
      ...postcondition,
      equals: redactConnectorEvidence(postcondition.equals),
    })),
    observation,
    idempotencyKey: input.idempotencyKey,
    reconciliationState: state,
    retryPath: retryPath(input, now),
    evidenceReference: evidenceReference({ state, connector: input.connector, target: input.targetIdentity }),
    safeToComplete: state === "applied",
  };
}

/** Reconcile one bounded connector attempt against the connector's observed state. */
export async function reconcileExternalEffect(input: ExternalEffectRequest): Promise<ExternalEffectResult> {
  validateRequest(input);
  const now = input.now?.() ?? new Date();
  let response: ExternalObservationResponse;
  try {
    response = await input.observe();
  } catch (error) {
    const result = resultBase(
      input,
      { status: "unavailable", maxAgeMs: input.freshnessMs },
      "unobservable",
      now,
    );
    result.reason = "connector observation failed";
    result.evidenceReference = evidenceReference({ reason: error instanceof Error ? error.name : "unknown", connector: input.connector });
    return result;
  }

  if (isUnavailableObservation(response)) {
    const result = resultBase(input, { status: "unavailable", maxAgeMs: input.freshnessMs }, "unobservable", now);
    result.reason = "connector observation unavailable";
    result.evidenceReference = evidenceReference(response.evidence);
    return result;
  }

  const observedAtMs = Date.parse(response.observedAt);
  if (!Number.isFinite(observedAtMs)) {
    const result = resultBase(input, { status: "unavailable", maxAgeMs: input.freshnessMs }, "unobservable", now);
    result.reason = "connector observation has no valid observation time";
    result.evidenceReference = evidenceReference(response.evidence);
    return result;
  }
  const ageMs = Math.max(0, now.getTime() - observedAtMs);
  const freshness: ExternalEffectFreshness = { status: ageMs <= input.freshnessMs ? "fresh" : "stale", observedAt: response.observedAt, ageMs, maxAgeMs: input.freshnessMs };
  if (freshness.status === "stale") {
    const result = resultBase(input, freshness, "stale", now);
    result.observedState = redactConnectorEvidence(response.observedState) as Record<string, unknown>;
    result.reason = `connector observation is ${ageMs}ms old; freshness allows ${input.freshnessMs}ms`;
    result.evidenceReference = evidenceReference(response.evidence);
    return result;
  }

  const satisfied = input.expectedPostconditions.filter((postcondition) => isDeepStrictEqual(valueAtPath(response.observedState, postcondition.path), postcondition.equals));
  const unsatisfied = input.expectedPostconditions.filter((postcondition) => !satisfied.includes(postcondition));
  const state: ExternalEffectState = input.attempt.outcome === "partially-applied"
    ? "partially-applied"
    : unsatisfied.length > 0
      ? "drifted"
      : input.attempt.outcome;
  const result = resultBase(input, freshness, state, now);
  result.observedState = redactConnectorEvidence(response.observedState) as Record<string, unknown>;
  result.evidenceReference = evidenceReference(response.evidence);
  if (input.attempt.outcome === "partially-applied" || (satisfied.length > 0 && unsatisfied.length > 0)) {
    result.partialSuccess = { satisfied: satisfied.map((postcondition) => postcondition.path), unsatisfied: unsatisfied.map((postcondition) => postcondition.path) };
  }
  if (state === "drifted") result.reason = "fresh connector state does not satisfy every expected postcondition";
  return result;
}

/** Retry only an idempotent attempt while the original grant and its budget remain valid. */
export async function retryExternalEffect(
  input: ExternalEffectRequest,
  retryOperation: (context: { idempotencyKey: string; capabilityGrantId: string; attemptNumber: number }) => Promise<ExternalObservationResponse>,
): Promise<ExternalEffectResult> {
  validateRequest(input);
  const now = input.now?.() ?? new Date();
  const path = retryPath(input, now);
  if (!path.allowed || path.attemptNumber === undefined) {
    const result = resultBase(input, { status: "unavailable", maxAgeMs: input.freshnessMs }, "unobservable", now);
    result.retryPath = path;
    result.reason = path.reason;
    return result;
  }
  const observation = await retryOperation({
    idempotencyKey: input.idempotencyKey,
    capabilityGrantId: input.capabilityGrantId,
    attemptNumber: path.attemptNumber,
  });
  return reconcileExternalEffect({
    ...input,
    attempt: { ...input.attempt, attemptNumber: path.attemptNumber },
    observe: async () => observation,
    now: input.now,
  });
}
