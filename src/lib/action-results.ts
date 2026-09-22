/**
 * lib/action-results.ts — GET /v1/action-results's `external-action-results-v1` projection
 * (W1-T4044, MASTER-PLAN §7A). W1-T3899 gave the daemon a bounded external-effect result model
 * (lib/action-reconciliation.ts), worker reconciliation, and an `external_effect.reconciled`
 * ledger row (lib/ledger.ts), but no authenticated public read of it — the console's API-T44 could
 * validate and render only a route core itself owns. This module is that read seam, and nothing
 * more: no second reconciliation engine, no connector call, no compensation/recheck executor
 * (deferred; see the task's `design` note).
 *
 * REDACTION IS BELT-AND-BRACES, NOT TRUST: `reconcileExternalEffect` already redacts
 * `preconditionSnapshot`/`observedState`/`evidenceReference` at write time (action-reconciliation.ts),
 * but this projection additionally DROPS `preconditionSnapshot`/`observedState` entirely from the
 * public shape and re-validates every field it does keep against a closed allowlist, so a malformed
 * or pre-redaction-bug ledger row can never leak raw connector output through this route — it is
 * rejected instead (never guessed into a fabricated healthy shape).
 *
 * BOUNDED THROUGHOUT: query filters are a closed allowlist (an unknown key, a daemon URL, a
 * credential, a connector payload, an observed measurement, or a compensation instruction is
 * refused, never accepted), the row and response byte sizes are capped, and the item count is
 * capped. A corrupt or absent ledger is reported `unavailable`, never a healthy empty array.
 * Falsifier: test/action-results-route.test.ts, test/action-results-redaction.test.ts,
 * test/action-results-bounds.test.ts.
 */

import {
  EXTERNAL_EFFECT_STATES,
  EXTERNAL_EFFECT_VERSION,
  redactConnectorEvidence,
  type ExternalEffectFreshness,
  type ExternalEffectRetryPath,
  type ExternalEffectState,
  type ExternalPostcondition,
} from "./action-reconciliation.js";
import { EXTERNAL_EFFECT_RECONCILED_STEP } from "./ledger.js";
import { isRecord } from "./panel-actions.js";
import type { LedgerLines } from "./status.js";
import { systemClock, type Clock } from "./clock.js";

export const ACTION_RESULTS_CONTRACT_VERSION = "external-action-results-v1" as const;

/** PRIMARY CONTROL: the projection's response item bound, enforced before serialization —
 *  mirrors {@link import("./panel-graph.js").OPERATOR_ACTIVITY_MAX_ITEMS}'s role for that route. */
export const ACTION_RESULTS_MAX_ITEMS = 200;

/** BACKSTOP: bound on any single string filter value (`connector`/`taskId`/`runId`). */
export const ACTION_RESULTS_MAX_FILTER_LENGTH = 200;

/** BACKSTOP: a single ledger row larger than this is rejected outright rather than parsed — oversized
 *  "evidence" smuggled past write-time redaction can never reach this far. */
export const ACTION_RESULTS_MAX_ROW_BYTES = 32 * 1024;

/** PRIMARY CONTROL: total serialized item bytes this projection ever returns in one read; the remainder is
 *  reported via `truncated`, never silently dropped without a signal. */
export const ACTION_RESULTS_MAX_RESPONSE_BYTES = 256 * 1024;

const MAX_LIST_ENTRIES = 50;
const MAX_FIELD_STRING = 500;
export const EVIDENCE_REFERENCE_RE = /^sha256:[0-9a-f]{64}$/;

/** The public, redacted shape of one `external-effect-v1` reconciliation result. Deliberately
 *  omits `preconditionSnapshot` and `observedState` (see module header) — `evidenceReference`
 *  remains the caller's only pointer into the connector-observed state, opaque by construction. */
export interface ActionResultItem {
  version: typeof EXTERNAL_EFFECT_VERSION;
  runId: string;
  taskId: string;
  /** When this reconciliation was ledgered (`ts` on the source row), NOT when the connector was
   *  observed — the freshness/staleness clock lives in `observation` below. */
  recordedAt: string;
  originatingActionId: string;
  originatingReceiptId: string;
  capabilityGrantId: string;
  connector: string;
  targetIdentity: string;
  requestedOperation: string;
  expectedPostconditions: readonly ExternalPostcondition[];
  observation: ExternalEffectFreshness;
  reconciliationState: ExternalEffectState;
  partialSuccess?: { satisfied: readonly string[]; unsatisfied: readonly string[] };
  retryPath: ExternalEffectRetryPath;
  evidenceReference: string;
  safeToComplete: boolean;
  reason?: string;
}

export type ActionResultsEnvelope =
  | {
      version: typeof ACTION_RESULTS_CONTRACT_VERSION;
      state: "verified";
      source: string;
      generatedAt: string;
      cursor?: string;
      items: ActionResultItem[];
      truncated: boolean;
      /** Ledger rows that matched the reconciliation step but failed this route's own
       *  redaction/shape allowlist — never included, always counted (design note, W1-T4044). */
      rejected: number;
    }
  | {
      version: typeof ACTION_RESULTS_CONTRACT_VERSION;
      state: "unavailable";
      source: string;
      generatedAt: string;
      reason: string;
      detail?: string;
    };

function boundedString(value: unknown, max = MAX_FIELD_STRING): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

/** Runtime ledger values normally came from JSON.parse, but this projection is also a public
 * pure seam. Treat a value that cannot be serialized as a malformed row, not as an exception that
 * turns the whole read into an unrelated 503. */
type SerializedBytes = { bytes: number } | { reason: string };

function serializedByteLength(value: unknown): SerializedBytes {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? { reason: "value is not JSON-serializable" }
      : { bytes: Buffer.byteLength(serialized, "utf8") };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

function parseStringArray(value: unknown, max = MAX_LIST_ENTRIES): string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    const bounded = boundedString(entry, 200);
    if (bounded === undefined) return undefined;
    out.push(bounded);
  }
  return out;
}

function parseObservation(value: unknown): ExternalEffectFreshness | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  if (status !== "fresh" && status !== "stale" && status !== "unavailable") return undefined;
  if (typeof value.maxAgeMs !== "number" || !Number.isFinite(value.maxAgeMs)) return undefined;
  let observedAt: string | undefined;
  if (value.observedAt !== undefined) {
    observedAt = boundedString(value.observedAt, 64);
    if (observedAt === undefined) return undefined;
  }
  let ageMs: number | undefined;
  if (value.ageMs !== undefined) {
    if (typeof value.ageMs !== "number" || !Number.isFinite(value.ageMs)) return undefined;
    ageMs = value.ageMs;
  }
  return { status, maxAgeMs: value.maxAgeMs, ...(observedAt !== undefined ? { observedAt } : {}), ...(ageMs !== undefined ? { ageMs } : {}) };
}

function parseRetryPath(value: unknown): ExternalEffectRetryPath | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind !== "none" && kind !== "retry" && kind !== "compensation") return undefined;
  if (typeof value.allowed !== "boolean") return undefined;
  const reason = boundedString(value.reason);
  if (reason === undefined) return undefined;
  let attemptNumber: number | undefined;
  if (value.attemptNumber !== undefined) {
    if (!Number.isInteger(value.attemptNumber)) return undefined;
    attemptNumber = value.attemptNumber as number;
  }
  return { kind, allowed: value.allowed, reason, ...(attemptNumber !== undefined ? { attemptNumber } : {}) };
}

function parsePostconditions(value: unknown): ExternalPostcondition[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) return undefined;
  const out: ExternalPostcondition[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const path = boundedString(entry.path, 200);
    if (path === undefined) return undefined;
    let description: string | undefined;
    if (entry.description !== undefined) {
      description = boundedString(entry.description, 200);
      if (description === undefined) return undefined;
    }
    // Redacted a SECOND time here (belt-and-braces, module header): a write-time redaction bug
    // must not become a read-time leak.
    out.push({ path, equals: redactConnectorEvidence(entry.equals), ...(description !== undefined ? { description } : {}) });
  }
  return out;
}

function parsePartialSuccess(value: unknown): { satisfied: string[]; unsatisfied: string[] } | undefined {
  if (!isRecord(value)) return undefined;
  const satisfied = parseStringArray(value.satisfied);
  const unsatisfied = parseStringArray(value.unsatisfied);
  if (satisfied === undefined || unsatisfied === undefined) return undefined;
  return { satisfied, unsatisfied };
}

/**
 * Validate and redact ONE candidate ledger row into a public {@link ActionResultItem}, or reject
 * it (`undefined`) — never a partial/guessed shape. Every field the public shape carries is
 * re-checked against its own closed type here; nothing on `row` reaches the response by any other
 * path. Oversized rows are rejected before any field is even read.
 */
export function parseActionResultRow(row: Record<string, unknown>): ActionResultItem | undefined {
  if (!isRecord(row)) return undefined;
  const rowSize = serializedByteLength(row);
  if ("reason" in rowSize || rowSize.bytes > ACTION_RESULTS_MAX_ROW_BYTES) return undefined;

  const runId = row.run_id;
  const taskId = row.task_id;
  const recordedAt = row.ts;
  if (typeof runId !== "string" || runId.length === 0) return undefined;
  if (typeof taskId !== "string" || taskId.length === 0) return undefined;
  if (typeof recordedAt !== "string" || !Number.isFinite(Date.parse(recordedAt))) return undefined;

  const effect = row.external_effect;
  if (!isRecord(effect)) return undefined;
  if (effect.version !== EXTERNAL_EFFECT_VERSION) return undefined;

  const reconciliationState = effect.reconciliationState;
  if (typeof reconciliationState !== "string" || !(EXTERNAL_EFFECT_STATES as readonly string[]).includes(reconciliationState)) return undefined;

  const originatingActionId = boundedString(effect.originatingActionId);
  const originatingReceiptId = boundedString(effect.originatingReceiptId);
  const capabilityGrantId = boundedString(effect.capabilityGrantId);
  const connector = boundedString(effect.connector);
  const targetIdentity = boundedString(effect.targetIdentity);
  const requestedOperation = boundedString(effect.requestedOperation);
  const evidenceReference = typeof effect.evidenceReference === "string" && EVIDENCE_REFERENCE_RE.test(effect.evidenceReference) ? effect.evidenceReference : undefined;
  if (
    originatingActionId === undefined ||
    originatingReceiptId === undefined ||
    capabilityGrantId === undefined ||
    connector === undefined ||
    targetIdentity === undefined ||
    requestedOperation === undefined ||
    evidenceReference === undefined
  ) {
    return undefined;
  }

  if (typeof effect.safeToComplete !== "boolean") return undefined;

  const observation = parseObservation(effect.observation);
  if (observation === undefined) return undefined;

  const retryPath = parseRetryPath(effect.retryPath);
  if (retryPath === undefined) return undefined;

  const expectedPostconditions = parsePostconditions(effect.expectedPostconditions);
  if (expectedPostconditions === undefined) return undefined;

  let partialSuccess: { satisfied: string[]; unsatisfied: string[] } | undefined;
  if (effect.partialSuccess !== undefined) {
    partialSuccess = parsePartialSuccess(effect.partialSuccess);
    if (partialSuccess === undefined) return undefined;
  }

  let reason: string | undefined;
  if (effect.reason !== undefined) {
    reason = boundedString(effect.reason);
    if (reason === undefined) return undefined;
  }

  return {
    version: EXTERNAL_EFFECT_VERSION,
    runId,
    taskId,
    recordedAt,
    originatingActionId,
    originatingReceiptId,
    capabilityGrantId,
    connector,
    targetIdentity,
    requestedOperation,
    expectedPostconditions,
    observation,
    reconciliationState: reconciliationState as ExternalEffectState,
    ...(partialSuccess !== undefined ? { partialSuccess } : {}),
    retryPath,
    evidenceReference,
    safeToComplete: effect.safeToComplete,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** Bounded read filters GET /v1/action-results accepts — a CLOSED allowlist (see
 *  {@link parseActionResultsFilters}). Server-owned identity (repository/run/action/receipt) is
 *  never accepted from the caller; these five are the only knobs offered. */
export interface ActionResultsFilters {
  state?: ExternalEffectState;
  connector?: string;
  taskId?: string;
  runId?: string;
  changedSince?: string;
  limit?: number;
}

const ACTION_RESULTS_FILTER_KEYS: ReadonlySet<string> = new Set(["state", "connector", "taskId", "runId", "changedSince", "limit"]);

export type ActionResultsFilterParse = { ok: true; filters: ActionResultsFilters } | { ok: false; detail: string };

/**
 * Validate GET /v1/action-results's query string against the closed allowlist above. Any key
 * outside it — a daemon URL, a credential, a connector payload, an observed measurement, a
 * compensation instruction, or simply a typo — is REFUSED, never silently ignored or accepted
 * (W1-T4044 design: "do not accept a daemon URL, credential, connector payload, observed
 * measurement, or compensation instruction from the caller").
 */
export function parseActionResultsFilters(params: URLSearchParams): ActionResultsFilterParse {
  for (const key of params.keys()) {
    if (!ACTION_RESULTS_FILTER_KEYS.has(key)) {
      return { ok: false, detail: `unsupported filter '${key}' -- only ${[...ACTION_RESULTS_FILTER_KEYS].join(", ")} are accepted` };
    }
  }

  const filters: ActionResultsFilters = {};

  const state = params.get("state");
  if (state !== null) {
    if (!(EXTERNAL_EFFECT_STATES as readonly string[]).includes(state)) {
      return { ok: false, detail: `state must be one of ${EXTERNAL_EFFECT_STATES.join(", ")}` };
    }
    filters.state = state as ExternalEffectState;
  }

  for (const key of ["connector", "taskId", "runId"] as const) {
    const value = params.get(key);
    if (value !== null) {
      if (value.length === 0 || value.length > ACTION_RESULTS_MAX_FILTER_LENGTH) {
        return { ok: false, detail: `${key} must be 1-${ACTION_RESULTS_MAX_FILTER_LENGTH} characters` };
      }
      filters[key] = value;
    }
  }

  const changedSince = params.get("changedSince");
  if (changedSince !== null) {
    if (changedSince.length > 64 || !Number.isFinite(Date.parse(changedSince))) {
      return { ok: false, detail: "changedSince must be a valid ISO 8601 timestamp" };
    }
    filters.changedSince = changedSince;
  }

  const limit = params.get("limit");
  if (limit !== null) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > ACTION_RESULTS_MAX_ITEMS) {
      return { ok: false, detail: `limit must be an integer between 1 and ${ACTION_RESULTS_MAX_ITEMS}` };
    }
    filters.limit = parsed;
  }

  return { ok: true, filters };
}

export interface ActionResultsProjectionInput {
  ledgerLines: LedgerLines;
  filters: ActionResultsFilters;
  /** Shared time seam; production falls back to the daemon wall clock. */
  clock?: Clock;
  source?: string;
}

/**
 * The pure projection: bounded ledger lines + validated filters -> a versioned envelope. An
 * absent OR corrupt (any torn line) ledger is explicit `unavailable`, never a healthy empty
 * array (W1-T4044 falsifier) — a torn line means the read itself could not be trusted, not just
 * that one row was skipped.
 */
export function buildActionResultsProjection(input: ActionResultsProjectionInput): ActionResultsEnvelope {
  const generatedAt = (input.clock ?? systemClock).iso();
  const source = input.source ?? "rmd:/v1/action-results";

  if (!input.ledgerLines.present) {
    return { version: ACTION_RESULTS_CONTRACT_VERSION, state: "unavailable", source, generatedAt, reason: "ledger-unavailable", detail: "The action-results ledger was not present." };
  }
  if (input.ledgerLines.torn > 0) {
    return {
      version: ACTION_RESULTS_CONTRACT_VERSION,
      state: "unavailable",
      source,
      generatedAt,
      reason: "ledger-corrupt",
      detail: `${input.ledgerLines.torn} unreadable ledger line(s) blocked a safe read.`,
    };
  }

  const changedSinceMs = input.filters.changedSince !== undefined ? Date.parse(input.filters.changedSince) : undefined;
  const limit = Math.min(input.filters.limit ?? ACTION_RESULTS_MAX_ITEMS, ACTION_RESULTS_MAX_ITEMS);

  let rejected = 0;
  const matched: Array<{ item: ActionResultItem; ts: number }> = [];
  for (const row of input.ledgerLines) {
    if (!isRecord(row)) {
      rejected += 1;
      continue;
    }
    if (row.step !== EXTERNAL_EFFECT_RECONCILED_STEP) continue;
    const item = parseActionResultRow(row);
    if (item === undefined) {
      rejected += 1;
      continue;
    }
    if (input.filters.state !== undefined && item.reconciliationState !== input.filters.state) continue;
    if (input.filters.connector !== undefined && item.connector !== input.filters.connector) continue;
    if (input.filters.taskId !== undefined && item.taskId !== input.filters.taskId) continue;
    if (input.filters.runId !== undefined && item.runId !== input.filters.runId) continue;
    const tsMs = Date.parse(item.recordedAt);
    if (changedSinceMs !== undefined && (!Number.isFinite(tsMs) || tsMs < changedSinceMs)) continue;
    matched.push({ item, ts: Number.isFinite(tsMs) ? tsMs : 0 });
  }

  // Newest first: a bounded read that must truncate keeps the freshest evidence, and the
  // envelope's cursor (the newest kept item's own recordedAt) stays meaningful either way.
  matched.sort((a, b) => b.ts - a.ts);

  const items: ActionResultItem[] = [];
  let bytes = 0;
  let truncated = false;
  for (const entry of matched) {
    if (items.length >= limit) {
      truncated = true;
      break;
    }
    const size = Buffer.byteLength(JSON.stringify(entry.item), "utf8");
    if (bytes + size > ACTION_RESULTS_MAX_RESPONSE_BYTES) {
      truncated = true;
      break;
    }
    items.push(entry.item);
    bytes += size;
  }
  if (items.length < matched.length) truncated = true;

  return {
    version: ACTION_RESULTS_CONTRACT_VERSION,
    state: "verified",
    source,
    generatedAt,
    ...(items[0] !== undefined ? { cursor: items[0].recordedAt } : {}),
    items,
    truncated,
    rejected,
  };
}
