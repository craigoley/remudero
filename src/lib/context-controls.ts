/**
 * context-controls-v1 (W1-T3893): the operator self-service surface over the context-governance
 * engine W1-T3881 built in operator-agent.ts.
 *
 * This module owns NO second memory store and NO new validation of context-item-v1 envelopes —
 * every function here reads the SAME ledger-backed, restart-safe state
 * ({@link readContextLedgerState}) and reuses the SAME receipt/availability primitives
 * ({@link performContextDelete}, {@link performContextRevoke}, {@link contextStatus},
 * {@link readContextInventory}) that operator-agent.ts's context-governance routes already use
 * and test. A second reader would drift from the first the moment a ledger rotation shape or a
 * receipt field changed (see readContextLedgerState's own doc comment in operator-agent.ts).
 *
 * What is genuinely NEW here:
 *   - principal-scoped inventory: an operator names WHOSE context they are inspecting, not every
 *     principal's (readContextInventory alone returns everyone's).
 *   - "forget" as the operator-facing verb for permanent deletion (performContextDelete), paired
 *     with "revoke" under one self-service surface — this task's title names the pair directly.
 *   - export: bounded, redacted, principal+purpose+authority scoped, and REFUSES rather than
 *     partially serving when any selected item's derivation chain is not fully "available". This
 *     is the one capability T3881 did not build.
 *
 * Never returns raw `content`: inventory strips it structurally (ContextInventoryItem omits the
 * field); export never touches raw `content` except to build a bounded, secret-scrubbed preview.
 */

import { createHash } from "node:crypto";
import type { Route } from "./service.js";
import { bearerTokenId, jsonAction, sendJson } from "./panel-actions.js";
import {
  contextStatus,
  performContextDelete,
  performContextRevoke,
  readContextInventory,
  readContextLedgerState,
  validateContextAction,
  type ContextFreshness,
  type ContextInventoryItem,
  type ContextRetention,
  type ContextSensitivity,
  type ContextVisibility,
  type OperatorAgentRouteDependencies,
} from "./operator-agent.js";

export const CONTEXT_CONTROLS_VERSION = "context-controls-v1" as const;

export type ContextControlsDeps = OperatorAgentRouteDependencies;

export interface ContextControlsInventoryQuery {
  principal: string;
  purpose?: string;
  authorityRef?: string;
}

/** Metadata-only, principal-scoped inventory. Delegates entirely to {@link readContextInventory}
 *  (never a second ledger read) and narrows to one principal — the self-service framing T3881's
 *  ungated, everyone's-context inventory route does not offer. */
export function readContextControlsInventory(deps: ContextControlsDeps, query: ContextControlsInventoryQuery): ContextInventoryItem[] {
  return readContextInventory(deps).filter(
    (item) =>
      item.principal === query.principal &&
      (query.purpose === undefined || item.purpose === query.purpose) &&
      (query.authorityRef === undefined || item.authorityRef === query.authorityRef),
  );
}

/** GET /v1/context-controls/inventory?principal=...&purpose=...&authorityRef=... */
export function buildContextControlsInventoryRoute(deps: ContextControlsDeps): Route {
  return {
    method: "GET",
    path: "/v1/context-controls/inventory",
    scope: "read",
    sensitivity: "sensitive",
    handler: (req, res) => {
      const url = new URL(req.url ?? "/", "http://rmd.local");
      const principal = url.searchParams.get("principal");
      if (!principal) {
        sendJson(res, 400, { error: "bad_request", detail: "principal is required" });
        return;
      }
      const purpose = url.searchParams.get("purpose") ?? undefined;
      const authorityRef = url.searchParams.get("authorityRef") ?? undefined;
      const now = deps.now?.() ?? Date.now();
      const items = readContextControlsInventory(deps, { principal, purpose, authorityRef });
      sendJson(res, 200, { items, count: items.length, absent: items.length === 0, asOf: new Date(now).toISOString() });
    },
  };
}

/** POST /v1/context-controls/forget — the operator-facing verb for permanent deletion. A thin
 *  named wrapper over {@link performContextDelete}: same receipt, same idempotency, same
 *  derivation-unavailability propagation, same restart safety (the underlying ledger step is
 *  already in ledger.ts's permanent-retention set). */
export function buildContextControlsForgetRoute(deps: ContextControlsDeps): Route {
  return {
    method: "POST",
    path: "/v1/context-controls/forget",
    scope: "write",
    tier: "middle",
    handler: jsonAction(validateContextAction, (input, req, res) => {
      const result = performContextDelete(deps, input, bearerTokenId(req));
      sendJson(res, result.status, result.body);
    }),
  };
}

/** POST /v1/context-controls/revoke — a thin named wrapper over {@link performContextRevoke}. */
export function buildContextControlsRevokeRoute(deps: ContextControlsDeps): Route {
  return {
    method: "POST",
    path: "/v1/context-controls/revoke",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateContextAction, (input, req, res) => {
      const result = performContextRevoke(deps, input, bearerTokenId(req));
      sendJson(res, result.status, result.body);
    }),
  };
}

// ── Export: bounded, redacted, scoped, coverage-checked ──────────────────────────────────────

/** Above any real operator's single-purpose context set (measured against the fixtures in
 *  test/context-controls-export.test.ts); below a size an accidental unscoped query could return
 *  unbounded. A caller past this must narrow purpose/authority, not receive a silent truncation —
 *  silent truncation is exactly the "call incomplete coverage complete" failure this task's
 *  falsifier names. */
const MAX_CONTEXT_EXPORT_ITEMS = 200;
/** Bounded preview length for exported content — export is redacted, not a raw-content channel. */
const MAX_CONTEXT_EXPORT_PREVIEW = 240;
/** Same class of leak safe-experiment-text guards against elsewhere in operator-agent.ts
 *  (safeExperimentText's regex) — a bearer/token/secret/password/api-key/sk-... span, scrubbed
 *  rather than merely truncated, since truncation alone could still leave a secret's prefix. */
const CONTEXT_EXPORT_SECRET_PATTERN = /\b(?:bearer|api[_-]?key|sk-[A-Za-z0-9]+|token|secret|password)\S*/gi;

export type ContextExportRefusalReason = "absent" | "incomplete_coverage" | "bounded_exceeded";

export interface ContextExportQuery {
  principal: string;
  purpose: string;
  authorityRef: string;
  now?: number;
}

export interface ContextExportItem {
  contextId: string;
  source: string;
  principal: string;
  purpose: string;
  sensitivity: ContextSensitivity;
  authorityRef: string;
  observedAt: string;
  freshness: ContextFreshness;
  retention: ContextRetention;
  visibility: ContextVisibility;
  derivationLinks: string[];
  redactedContent: string;
}

export type ContextExportResult =
  | { status: "completed"; exportId: string; asOf: string; items: ContextExportItem[] }
  | { status: "refused"; reason: ContextExportRefusalReason; detail: string; incompleteContextIds?: string[] };

function redactContextContent(content: string): string {
  const scrubbed = content.replace(CONTEXT_EXPORT_SECRET_PATTERN, "[redacted]");
  return scrubbed.length > MAX_CONTEXT_EXPORT_PREVIEW ? `${scrubbed.slice(0, MAX_CONTEXT_EXPORT_PREVIEW)}…` : scrubbed;
}

function contextExportId(query: ContextExportQuery, at: string): string {
  const digest = createHash("sha256").update(`${query.principal}:${query.purpose}:${query.authorityRef}:${at}`).digest("hex");
  return `ctxx_${digest.slice(0, 24)}`;
}

/**
 * User-authorized export: scoped to one principal AND one purpose AND one authority (all three,
 * narrower than {@link readContextControlsInventory}'s optional filters — export never returns a
 * mixed-purpose bundle). Refuses entirely — never a partial "completed" — when any selected
 * item's own status, or any item in its derivation chain, is not "available"
 * ({@link contextStatus} already walks the whole chain recursively, so one call per selected item
 * is sufficient coverage, not merely its direct links).
 */
export function exportGovernedContext(deps: ContextControlsDeps, query: ContextExportQuery): ContextExportResult {
  const now = query.now ?? deps.now?.() ?? Date.now();
  const state = readContextLedgerState(deps.ledgerPath);
  const matching = [...state.items.values()]
    .filter((item) => item.principal === query.principal && item.purpose === query.purpose && item.authorityRef === query.authorityRef)
    .sort((a, b) => a.contextId.localeCompare(b.contextId));

  if (matching.length === 0) {
    return { status: "refused", reason: "absent", detail: "no context matches the requested principal, purpose, and authority" };
  }
  if (matching.length > MAX_CONTEXT_EXPORT_ITEMS) {
    return { status: "refused", reason: "bounded_exceeded", detail: `export exceeds the bounded limit of ${MAX_CONTEXT_EXPORT_ITEMS} items; narrow purpose or authority` };
  }

  const incomplete = matching.filter((item) => contextStatus(item.contextId, state, now) !== "available").map((item) => item.contextId);
  if (incomplete.length > 0) {
    return {
      status: "refused",
      reason: "incomplete_coverage",
      detail: "one or more selected items, or an item they derive from, is stale, unavailable, revoked, or deleted",
      incompleteContextIds: incomplete,
    };
  }

  const at = new Date(now).toISOString();
  const items: ContextExportItem[] = matching.map((item) => ({
    contextId: item.contextId,
    source: item.source,
    principal: item.principal,
    purpose: item.purpose,
    sensitivity: item.sensitivity,
    authorityRef: item.authorityRef,
    observedAt: item.observedAt,
    freshness: item.freshness,
    retention: item.retention,
    visibility: item.visibility,
    derivationLinks: item.derivationLinks,
    redactedContent: redactContextContent(item.content),
  }));
  return { status: "completed", exportId: contextExportId(query, at), asOf: at, items };
}

/** GET /v1/context-controls/export?principal=...&purpose=...&authorityRef=... — refuses (409,
 *  never a 200 "completed") on absent, over-bounded, or incomplete-coverage selections. */
export function buildContextControlsExportRoute(deps: ContextControlsDeps): Route {
  return {
    method: "GET",
    path: "/v1/context-controls/export",
    scope: "read",
    sensitivity: "sensitive",
    handler: (req, res) => {
      const url = new URL(req.url ?? "/", "http://rmd.local");
      const principal = url.searchParams.get("principal");
      const purpose = url.searchParams.get("purpose");
      const authorityRef = url.searchParams.get("authorityRef");
      if (!principal || !purpose || !authorityRef) {
        sendJson(res, 400, { error: "bad_request", detail: "principal, purpose, and authorityRef are required" });
        return;
      }
      const result = exportGovernedContext(deps, { principal, purpose, authorityRef });
      sendJson(res, result.status === "completed" ? 200 : 409, result);
    },
  };
}

/** Every context-controls-v1 route, aggregated — mounted alongside operator-agent's own routes
 *  in serve.ts (see that file's `context controls` comment). */
export function buildContextControlsRoutes(deps: ContextControlsDeps): Route[] {
  return [
    buildContextControlsInventoryRoute(deps),
    buildContextControlsForgetRoute(deps),
    buildContextControlsRevokeRoute(deps),
    buildContextControlsExportRoute(deps),
  ];
}
