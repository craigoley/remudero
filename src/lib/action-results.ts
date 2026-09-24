import type { IncomingMessage, ServerResponse } from "node:http";
import { createLedgerRotationMemo } from "./ledger-union.js";
import { readLedgerUnionMemoized, type LedgerLines } from "./status.js";
import type { ExternalEffectResult, ExternalEffectState } from "./action-reconciliation.js";
import type { Route } from "./service.js";
import { redactConnectorEvidence } from "./action-reconciliation.js";
import { sendJson } from "./panel-actions.js";

export const ACTION_RESULTS_CONTRACT_VERSION = "external-action-results-v1" as const;
/** BACKSTOP: keeps a projection response bounded even when the ledger has a large result set. */
export const ACTION_RESULTS_MAX_RESULTS = 200;
/** BACKSTOP: keeps a projection response bounded even when individual receipts are valid. */
export const ACTION_RESULTS_MAX_RESPONSE_BYTES = 64 * 1024;

const MAX_FILTER_LENGTH = 160;
const MAX_RESULT_FIELD_BYTES = 16 * 1024;
const EXTERNAL_EFFECT_STATES: readonly ExternalEffectState[] = [
  "applied",
  "refused",
  "pending",
  "partially-applied",
  "drifted",
  "stale",
  "unobservable",
];

export type ActionResultsState = "verified" | "unavailable";

export interface ActionResultsEnvelope {
  version: typeof ACTION_RESULTS_CONTRACT_VERSION;
  state: ActionResultsState;
  source: string;
  generatedAt: string;
  cursor?: string;
  results?: readonly ExternalEffectResult[];
  truncated?: boolean;
  reason?: string;
  detail?: string;
}

interface ActionResultRow {
  result: ExternalEffectResult;
  taskId?: string;
  rowTimestamp?: string;
}

export interface ActionResultsFilter {
  taskId?: string;
  actionId?: string;
  changedSince?: string;
  limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max = MAX_FILTER_LENGTH): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value : undefined;
}

const CONNECTOR_PAYLOAD_KEY = /(?:evidence|payload|provider|response|headers|body|raw)/i;

function safeProjectionValue(value: unknown, key = ""): unknown {
  if (key && CONNECTOR_PAYLOAD_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => safeProjectionValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, safeProjectionValue(childValue, childKey)]));
  }
  return redactConnectorEvidence(value, key);
}

function boundedRedactedValue(value: unknown): unknown | undefined {
  let redacted: unknown;
  try {
    redacted = safeProjectionValue(value);
    const encoded = JSON.stringify(redacted);
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RESULT_FIELD_BYTES) return undefined;
  } catch {
    // Reason: unserialisable connector-shaped data is unavailable to the safe projection.
    return undefined;
  }
  return redacted;
}

function boundedRecord(value: unknown): Record<string, unknown> | undefined {
  const redacted = boundedRedactedValue(value);
  return isRecord(redacted) ? redacted : undefined;
}

function isoString(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sanitizeResult(value: unknown): ExternalEffectResult | undefined {
  if (!isRecord(value) || value.version !== "external-effect-v1") return undefined;
  const requiredStrings = [
    "originatingActionId",
    "originatingReceiptId",
    "capabilityGrantId",
    "connector",
    "targetIdentity",
    "requestedOperation",
    "idempotencyKey",
    "evidenceReference",
  ] as const;
  const strings = Object.fromEntries(requiredStrings.map((key) => [key, boundedString(value[key], 240)]));
  if (requiredStrings.some((key) => !strings[key])) return undefined;
  if (!/^sha256:[a-f0-9]{64}$/.test(strings.evidenceReference!)) return undefined;
  if (!EXTERNAL_EFFECT_STATES.includes(value.reconciliationState as ExternalEffectState)) return undefined;
  if (typeof value.safeToComplete !== "boolean") return undefined;

  const preconditionSnapshot = boundedRecord(value.preconditionSnapshot);
  if (!preconditionSnapshot) return undefined;
  if (!Array.isArray(value.expectedPostconditions) || value.expectedPostconditions.length > ACTION_RESULTS_MAX_RESULTS) return undefined;
  const expectedPostconditions = value.expectedPostconditions.map((postcondition) => {
    if (!isRecord(postcondition)) return undefined;
    const path = boundedString(postcondition.path, 240);
    const equals = boundedRedactedValue(postcondition.equals);
    if (!path || equals === undefined) return undefined;
    const description = postcondition.description === undefined ? undefined : boundedString(postcondition.description, 240);
    if (postcondition.description !== undefined && !description) return undefined;
    return { path, equals, ...(description ? { description } : {}) };
  });
  if (expectedPostconditions.some((postcondition) => !postcondition)) return undefined;

  if (!isRecord(value.observation)) return undefined;
  const observationStatus = value.observation.status;
  if (observationStatus !== "fresh" && observationStatus !== "stale" && observationStatus !== "unavailable") return undefined;
  const maxAgeMs = nonNegativeNumber(value.observation.maxAgeMs);
  if (maxAgeMs === undefined) return undefined;
  const observedAt = value.observation.observedAt === undefined ? undefined : isoString(value.observation.observedAt);
  const ageMs = value.observation.ageMs === undefined ? undefined : nonNegativeNumber(value.observation.ageMs);
  if (value.observation.observedAt !== undefined && !observedAt) return undefined;
  if (value.observation.ageMs !== undefined && ageMs === undefined) return undefined;

  if (!isRecord(value.retryPath)) return undefined;
  if (value.retryPath.kind !== "none" && value.retryPath.kind !== "retry" && value.retryPath.kind !== "compensation") return undefined;
  if (typeof value.retryPath.allowed !== "boolean") return undefined;
  const retryReason = boundedString(value.retryPath.reason, 300);
  if (!retryReason) return undefined;
  const rawRetryAttempt = value.retryPath.attemptNumber;
  if (rawRetryAttempt !== undefined && (typeof rawRetryAttempt !== "number" || !Number.isInteger(rawRetryAttempt) || rawRetryAttempt < 1)) return undefined;
  const retryAttempt = rawRetryAttempt as number | undefined;

  let partialSuccess: ExternalEffectResult["partialSuccess"];
  if (value.partialSuccess !== undefined) {
    if (!isRecord(value.partialSuccess) || !Array.isArray(value.partialSuccess.satisfied) || !Array.isArray(value.partialSuccess.unsatisfied)) return undefined;
    const satisfied = value.partialSuccess.satisfied.map((path) => boundedString(path, 240));
    const unsatisfied = value.partialSuccess.unsatisfied.map((path) => boundedString(path, 240));
    if (satisfied.some((path) => !path) || unsatisfied.some((path) => !path)) return undefined;
    partialSuccess = { satisfied: satisfied as string[], unsatisfied: unsatisfied as string[] };
  }

  const observedState = value.observedState === undefined ? undefined : boundedRecord(value.observedState);
  if (value.observedState !== undefined && !observedState) return undefined;
  const reason = value.reason === undefined ? undefined : boundedString(value.reason, 400);
  if (value.reason !== undefined && !reason) return undefined;

  return {
    version: "external-effect-v1",
    originatingActionId: strings.originatingActionId!,
    originatingReceiptId: strings.originatingReceiptId!,
    capabilityGrantId: strings.capabilityGrantId!,
    connector: strings.connector!,
    targetIdentity: strings.targetIdentity!,
    requestedOperation: strings.requestedOperation!,
    preconditionSnapshot,
    expectedPostconditions: expectedPostconditions as ExternalEffectResult["expectedPostconditions"],
    ...(observedState ? { observedState } : {}),
    observation: { status: observationStatus, ...(observedAt ? { observedAt } : {}), ...(ageMs !== undefined ? { ageMs } : {}), maxAgeMs },
    idempotencyKey: strings.idempotencyKey!,
    reconciliationState: value.reconciliationState as ExternalEffectState,
    ...(partialSuccess ? { partialSuccess } : {}),
    retryPath: { kind: value.retryPath.kind, allowed: value.retryPath.allowed, reason: retryReason, ...(retryAttempt !== undefined ? { attemptNumber: retryAttempt } : {}) },
    evidenceReference: strings.evidenceReference!,
    safeToComplete: value.safeToComplete,
    ...(reason ? { reason } : {}),
  };
}

function rowTimestamp(row: Record<string, unknown>): string | undefined {
  return isoString(row.ts);
}

function externalRows(lines: LedgerLines): { rows: ActionResultRow[]; malformed: boolean } {
  const rows: ActionResultRow[] = [];
  let malformed = false;
  for (const row of lines) {
    if (row.step !== "external_effect.reconciled") continue;
    const result = sanitizeResult(row.external_effect);
    if (!result) {
      malformed = true;
      continue;
    }
    rows.push({ result, taskId: boundedString(row.task_id, 160), rowTimestamp: rowTimestamp(row) });
  }
  return { rows, malformed };
}

/** Text only an external-effect row writes: its step, its payload key, or one of its top-level fields. */
const EXTERNAL_EFFECT_ROW_TEXT = /external_effect|reconciliation_state|evidence_reference|capability_grant_id/;
/** Every appended row begins here, so a torn line holding two interleaved rows holds two of these. */
const LEDGER_ROW_START = '{"ts":"';
const STEP_MARKER = /"step":"[^"]*"/;

/**
 * Whether a torn ledger row's raw text COULD have been an external-effect row. False only when the text proves
 * otherwise: no external-effect field anywhere, and every row start in it reaches a complete step marker (the
 * step sits before the payload, so a row cut before its step could still be one). Anything unprovable is true.
 */
export function tornRowCouldBeExternalEffect(raw: string): boolean {
  if (EXTERNAL_EFFECT_ROW_TEXT.test(raw) || !STEP_MARKER.test(raw)) return true;
  return raw.split(LEDGER_ROW_START).slice(1).some((row) => !STEP_MARKER.test(row));
}

function unavailable(generatedAt: string, reason: string, detail?: string): ActionResultsEnvelope {
  return {
    version: ACTION_RESULTS_CONTRACT_VERSION,
    state: "unavailable",
    source: "rmd:/v1/action-results",
    generatedAt,
    reason,
    ...(detail ? { detail: detail.slice(0, 400) } : {}),
  };
}

/** `tornExternal` counts the torn rows {@link tornRowCouldBeExternalEffect} could not rule out. Omitted, every
 *  torn row counts, so a caller that never classified its torn rows still fails closed. */
export function buildActionResultsProjection(
  lines: LedgerLines,
  filter: ActionResultsFilter = {},
  now: () => number = Date.now,
  tornExternal?: number,
): ActionResultsEnvelope {
  const generatedAt = new Date(now()).toISOString();
  if (lines.present === false) return unavailable(generatedAt, "ledger-unavailable", "The external-effect ledger was not present.");
  const torn = lines.torn ?? 0;
  if ((tornExternal ?? torn) > 0) return unavailable(generatedAt, "ledger-partial", "The external-effect ledger contained unreadable rows.");
  const { rows, malformed } = externalRows(lines);
  if (malformed) return unavailable(generatedAt, "malformed-external-effect", "An external-effect row failed validation and was not projected.");
  const changedSinceMs = filter.changedSince ? Date.parse(filter.changedSince) : undefined;
  const filtered = rows
    .filter(({ taskId }) => !filter.taskId || taskId === filter.taskId)
    .filter(({ result }) => !filter.actionId || result.originatingActionId === filter.actionId)
    .filter(({ result, rowTimestamp }) => changedSinceMs === undefined || Date.parse(result.observation.observedAt ?? rowTimestamp ?? "") > changedSinceMs)
    .sort((a, b) => Date.parse(b.result.observation.observedAt ?? b.rowTimestamp ?? "") - Date.parse(a.result.observation.observedAt ?? a.rowTimestamp ?? ""));
  const requestedLimit = filter.limit ?? ACTION_RESULTS_MAX_RESULTS;
  const limit = Math.min(Math.max(1, requestedLimit), ACTION_RESULTS_MAX_RESULTS);
  const selected = filtered.slice(0, limit);
  const resultRows: ExternalEffectResult[] = [];
  let truncated = filtered.length > selected.length;
  for (const row of selected) {
    const candidate = [...resultRows, row.result];
    const envelope: ActionResultsEnvelope = {
      version: ACTION_RESULTS_CONTRACT_VERSION,
      state: "verified",
      source: "rmd:/v1/action-results",
      generatedAt,
      cursor: row.result.observation.observedAt ?? row.rowTimestamp ?? generatedAt,
      results: candidate,
      truncated,
    };
    if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > ACTION_RESULTS_MAX_RESPONSE_BYTES) {
      truncated = true;
      break;
    }
    resultRows.push(row.result);
  }
  const cursor = resultRows[0]?.observation.observedAt ?? selected[0]?.rowTimestamp;
  return {
    version: ACTION_RESULTS_CONTRACT_VERSION,
    state: "verified",
    source: "rmd:/v1/action-results",
    generatedAt,
    ...(cursor ? { cursor } : {}),
    results: resultRows,
    truncated,
    ...(torn > 0 ? { detail: `${torn} unreadable ledger row(s) skipped; none could be an external-effect row.` } : {}),
  };
}

function parseFilter(url: URL): { filter: ActionResultsFilter } | { error: string } {
  for (const forbidden of ["daemonUrl", "credential", "measurement", "observedState", "providerOutput"]) {
    if (url.searchParams.has(forbidden)) return { error: `${forbidden} is server-owned and cannot be supplied by the caller` };
  }
  const taskId = url.searchParams.get("taskId") ?? undefined;
  const actionId = url.searchParams.get("actionId") ?? undefined;
  const changedSince = url.searchParams.get("changedSince") ?? undefined;
  for (const [name, value] of [["taskId", taskId], ["actionId", actionId]] as const) {
    if (value !== undefined && (!value.trim() || value.length > MAX_FILTER_LENGTH)) return { error: `${name} must be a non-empty bounded string` };
  }
  if (changedSince !== undefined && !isoString(changedSince)) return { error: "changedSince must be an ISO timestamp" };
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > ACTION_RESULTS_MAX_RESULTS)) {
    return { error: `limit must be an integer from 1 to ${ACTION_RESULTS_MAX_RESULTS}` };
  }
  return { filter: { ...(taskId ? { taskId } : {}), ...(actionId ? { actionId } : {}), ...(changedSince ? { changedSince } : {}), ...(rawLimit ? { limit: Number(rawLimit) } : {}) } };
}

/** GET /v1/action-results — bounded, read-only projection of redacted external-effect receipts. */
export function buildActionResultsRoute(ledgerPath: string): Route {
  // Only reconciled rows reach the projection; the memo keeps each rotation's torn count for `ledger-partial`.
  const rotations = createLedgerRotationMemo((rows) => rows.filter((row) => row.step === "external_effect.reconciled"));
  return {
    method: "GET",
    path: "/v1/action-results",
    scope: "read",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parsed = parseFilter(url);
      if ("error" in parsed) {
        sendJson(res, 400, { error: "invalid_request", detail: parsed.error });
        return;
      }
      try {
        let tornExternal = 0;
        const onTorn = (raw: string): void => {
          if (tornRowCouldBeExternalEffect(raw)) tornExternal += 1;
        };
        const lines = await readLedgerUnionMemoized(ledgerPath, rotations, onTorn);
        sendJson(res, 200, buildActionResultsProjection(lines, parsed.filter, undefined, tornExternal));
      } catch (error) {
        // Reason: a ledger read failure is an explicit unavailable result, never an empty success.
        sendJson(res, 200, unavailable(new Date().toISOString(), "ledger-unavailable", error instanceof Error ? error.message : "The ledger could not be read."));
      }
    },
  };
}
