/**
 * The public execution seam between an operator-agent recommendation and a durable action.
 *
 * This module is deliberately a small ledger-backed state machine. It validates a bounded action
 * declaration, exposes an honest preflight projection, and records operator decisions as linked
 * receipts. It does not execute a worker, infer measurements, or turn an accepted request into a
 * completed action. A later executor consumes the `in-progress` receipt and appends completion.
 */

import { dirname } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Route } from "./service.js";
import { readLedgerUnionBounded } from "./status.js";
import {
  appendPanelLedger,
  bearerTokenId,
  isRecord,
  jsonAction,
  sendJson,
  type PanelActionDeps,
} from "./panel-actions.js";

export const AUTOMATION_ACTION_VERSION = "automation-action-v1" as const;
export const AUTOMATION_ACTION_STEP = "automation.action";
export const AUTOMATION_ACTION_RECEIPT_STEP = "automation.action.receipt";

export const AUTOMATION_PREFLIGHT_STATES = ["ready", "refused", "stale", "unknown", "expired", "in-progress"] as const;
export type AutomationPreflightState = (typeof AUTOMATION_PREFLIGHT_STATES)[number];
export type AutomationActionRisk = "low" | "medium" | "high";
export type AutomationPreconditionState = "satisfied" | "missing" | "stale" | "unknown";
export type AutomationActionDecision = "approve" | "reject" | "cancel" | "rollback";

export interface AutomationActionScope {
  repository: string;
  instance?: string;
}

export interface AutomationActionPrecondition {
  name: string;
  state: AutomationPreconditionState;
  observedAt: string;
  reason?: string;
}

export interface AutomationActionRollback {
  actionId: string;
  plan: string;
  reason: string;
}

export interface AutomationAction {
  version: typeof AUTOMATION_ACTION_VERSION;
  actionId: string;
  flowId: string;
  scope: AutomationActionScope;
  risk: AutomationActionRisk;
  preconditions: AutomationActionPrecondition[];
  requiredFreshnessMs: number;
  observedAt: string;
  idempotencyKey: string;
  expiresAt: string;
  dryRunSupported: boolean;
  approvalRequired: boolean;
  rollback: AutomationActionRollback;
}

export interface AutomationActionReceipt {
  receiptId: string;
  actionId: string;
  idempotencyKey: string;
  decision: AutomationActionDecision;
  status: "in-progress" | "refused";
  at: string;
  linkedReceiptId?: string;
  reason?: string;
}

export interface AutomationActionPreflight {
  state: AutomationPreflightState;
  reason?: string;
  source: "ledger" | "unavailable";
  observedAt?: string;
  freshness?: "fresh" | "stale" | "unavailable";
  changedSince?: string;
}

export interface AutomationActionHistory extends AutomationAction {
  preflight: AutomationActionPreflight;
  receipts: AutomationActionReceipt[];
}

export interface AutomationActionReadResult {
  version: typeof AUTOMATION_ACTION_VERSION;
  actions: AutomationActionHistory[];
  source: "ledger" | "unavailable";
  reason?: string;
}

export interface AutomationActionRouteDependencies extends Pick<PanelActionDeps, "ledgerPath"> {
  now?: () => number;
}

interface DecisionInput {
  actionId: string;
  decision: AutomationActionDecision;
  idempotencyKey: string;
  reason?: string;
}

interface PreflightInput {
  actionId: string;
}

const MAX_ID = 160;
const MAX_FLOW_ID = 160;
const MAX_REPOSITORY = 200;
const MAX_INSTANCE = 160;
const MAX_NAME = 120;
const MAX_REASON = 500;
const MAX_PLAN = 500;
const MAX_PRECONDITIONS = 20;
const MAX_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_KEY = /^(?:version|actionId|flowId|scope|repository|instance|risk|preconditions|name|state|observedAt|reason|requiredFreshnessMs|idempotencyKey|expiresAt|dryRunSupported|approvalRequired|rollback|plan|decision)$/;
const FORBIDDEN_KEY = /(?:credential|token|secret|password|prompt|model|measurement|metric|daemon.?url|authorization)/i;

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function repo(value: unknown): value is string {
  return boundedString(value, MAX_REPOSITORY) && /^[^\s/]+\/[^\s/]+$/.test(value);
}

function safeKeyTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(safeKeyTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(([key, child]) => !FORBIDDEN_KEY.test(key) && SAFE_KEY.test(key) && safeKeyTree(child));
}

function validateRollback(value: unknown): { error: string } | AutomationActionRollback {
  if (!isRecord(value)) return { error: "rollback metadata is required" };
  const keys = Object.keys(value);
  if (keys.some((key) => !["actionId", "plan", "reason"].includes(key))) return { error: "rollback contains an unsupported field" };
  if (!boundedString(value.actionId, MAX_ID)) return { error: "rollback.actionId must be a bounded string" };
  if (!boundedString(value.plan, MAX_PLAN)) return { error: "rollback.plan must be a bounded string" };
  if (!boundedString(value.reason, MAX_REASON)) return { error: "rollback.reason must be a bounded string" };
  return { actionId: value.actionId.trim(), plan: value.plan.trim(), reason: value.reason.trim() };
}

function validateAction(body: unknown): { error: string } | AutomationAction {
  if (!isRecord(body)) return { error: "action must be a JSON object" };
  if (!safeKeyTree(body)) return { error: "action contains a sensitive or unsupported field" };
  const keys = Object.keys(body);
  const required = [
    "version",
    "actionId",
    "flowId",
    "scope",
    "risk",
    "preconditions",
    "requiredFreshnessMs",
    "observedAt",
    "idempotencyKey",
    "expiresAt",
    "dryRunSupported",
    "approvalRequired",
    "rollback",
  ];
  if (keys.some((key) => !required.includes(key)) || required.some((key) => !(key in body))) return { error: "action fields are incomplete or unsupported" };
  if (body.version !== AUTOMATION_ACTION_VERSION) return { error: `version must be ${AUTOMATION_ACTION_VERSION}` };
  if (!boundedString(body.actionId, MAX_ID)) return { error: "actionId must be a bounded string" };
  if (!boundedString(body.flowId, MAX_FLOW_ID)) return { error: "flowId must be a bounded string" };
  if (!isRecord(body.scope) || !repo(body.scope.repository)) return { error: "scope.repository must be owner/repository" };
  const scopeKeys = Object.keys(body.scope);
  if (scopeKeys.some((key) => !["repository", "instance"].includes(key))) return { error: "scope contains an unsupported field" };
  if (body.scope.instance !== undefined && !boundedString(body.scope.instance, MAX_INSTANCE)) return { error: "scope.instance must be a bounded string" };
  if (body.risk !== "low" && body.risk !== "medium" && body.risk !== "high") return { error: "risk must be low, medium, or high" };
  if (!Array.isArray(body.preconditions) || body.preconditions.length > MAX_PRECONDITIONS || body.preconditions.length === 0) return { error: "preconditions must be a non-empty bounded array" };
  const preconditions: AutomationActionPrecondition[] = [];
  for (const item of body.preconditions) {
    if (!isRecord(item)) return { error: "each precondition must be an object" };
    if (Object.keys(item).some((key) => !["name", "state", "observedAt", "reason"].includes(key))) return { error: "precondition contains an unsupported field" };
    if (!boundedString(item.name, MAX_NAME)) return { error: "precondition.name must be a bounded string" };
    if (!["satisfied", "missing", "stale", "unknown"].includes(item.state as string)) return { error: "precondition.state is invalid" };
    if (!iso(item.observedAt)) return { error: "precondition.observedAt must be an ISO timestamp" };
    if (item.reason !== undefined && !boundedString(item.reason, MAX_REASON)) return { error: "precondition.reason must be bounded" };
    preconditions.push({ name: item.name.trim(), state: item.state as AutomationPreconditionState, observedAt: item.observedAt, ...(item.reason ? { reason: item.reason.trim() } : {}) });
  }
  if (typeof body.requiredFreshnessMs !== "number" || !Number.isInteger(body.requiredFreshnessMs) || body.requiredFreshnessMs <= 0 || body.requiredFreshnessMs > MAX_FRESHNESS_MS) return { error: "requiredFreshnessMs must be a positive bounded integer" };
  if (!iso(body.observedAt) || !iso(body.expiresAt)) return { error: "observedAt and expiresAt must be ISO timestamps" };
  if (Date.parse(body.expiresAt) <= Date.parse(body.observedAt)) return { error: "expiresAt must be after observedAt" };
  if (!boundedString(body.idempotencyKey, MAX_ID)) return { error: "idempotencyKey must be a bounded string" };
  if (typeof body.dryRunSupported !== "boolean" || typeof body.approvalRequired !== "boolean") return { error: "dryRunSupported and approvalRequired must be booleans" };
  const rollback = validateRollback(body.rollback);
  if ("error" in rollback) return rollback;
  return {
    version: AUTOMATION_ACTION_VERSION,
    actionId: body.actionId.trim(),
    flowId: body.flowId.trim(),
    scope: { repository: body.scope.repository.trim(), ...(body.scope.instance ? { instance: body.scope.instance.trim() } : {}) },
    risk: body.risk,
    preconditions,
    requiredFreshnessMs: body.requiredFreshnessMs,
    observedAt: body.observedAt,
    idempotencyKey: body.idempotencyKey.trim(),
    expiresAt: body.expiresAt,
    dryRunSupported: body.dryRunSupported,
    approvalRequired: body.approvalRequired,
    rollback,
  };
}

function validateActionId(body: unknown): { error: string } | PreflightInput {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "actionId") || !boundedString(body.actionId, MAX_ID)) return { error: "actionId must be the only bounded field" };
  return { actionId: body.actionId.trim() };
}

function validateDecision(body: unknown): { error: string } | DecisionInput {
  if (!isRecord(body) || !safeKeyTree(body)) return { error: "decision must be a bounded JSON object" };
  const allowed = ["actionId", "decision", "idempotencyKey", "reason"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) return { error: "decision contains an unsupported field" };
  if (!boundedString(body.actionId, MAX_ID) || !boundedString(body.idempotencyKey, MAX_ID)) return { error: "actionId and idempotencyKey must be bounded strings" };
  if (!["approve", "reject", "cancel", "rollback"].includes(body.decision as string)) return { error: "decision is invalid" };
  if (body.reason !== undefined && !boundedString(body.reason, MAX_REASON)) return { error: "reason must be bounded" };
  return { actionId: body.actionId.trim(), decision: body.decision as AutomationActionDecision, idempotencyKey: body.idempotencyKey.trim(), ...(body.reason ? { reason: body.reason.trim() } : {}) };
}

function isAction(value: unknown): value is AutomationAction {
  return !((validateAction(value) as { error?: string }).error);
}

function isReceipt(value: unknown): value is AutomationActionReceipt {
  if (!isRecord(value)) return false;
  return boundedString(value.receiptId, MAX_ID) && boundedString(value.actionId, MAX_ID) && boundedString(value.idempotencyKey, MAX_ID) &&
    ["approve", "reject", "cancel", "rollback"].includes(value.decision as string) && ["in-progress", "refused"].includes(value.status as string) &&
    iso(value.at) && (value.linkedReceiptId === undefined || boundedString(value.linkedReceiptId, MAX_ID)) && (value.reason === undefined || boundedString(value.reason, MAX_REASON));
}

interface AutomationState {
  actions: Map<string, AutomationAction>;
  receipts: Map<string, AutomationActionReceipt[]>;
  byIdempotency: Map<string, AutomationActionReceipt>;
  present: boolean;
}

function readAutomationState(deps: AutomationActionRouteDependencies): AutomationState {
  // ledger-read-intent: union — action history must survive the live/rotation boundary.
  const lines = readLedgerUnionBounded(deps.ledgerPath);
  const actions = new Map<string, AutomationAction>();
  const receipts = new Map<string, AutomationActionReceipt[]>();
  const byIdempotency = new Map<string, AutomationActionReceipt>();
  for (const row of lines) {
    if (row.step === AUTOMATION_ACTION_STEP && isAction(row.action)) actions.set(row.action.actionId, row.action);
    if (row.step === AUTOMATION_ACTION_RECEIPT_STEP && isReceipt(row.receipt)) {
      const receipt = row.receipt;
      receipts.set(receipt.actionId, [...(receipts.get(receipt.actionId) ?? []), receipt]);
      byIdempotency.set(receipt.idempotencyKey, receipt);
    }
  }
  return { actions, receipts, byIdempotency, present: lines.present };
}

function latestReceipt(receipts: AutomationActionReceipt[]): AutomationActionReceipt | undefined {
  return [...receipts].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

function preflight(action: AutomationAction | undefined, receipts: AutomationActionReceipt[], nowMs: number, source: "ledger" | "unavailable"): AutomationActionPreflight {
  if (!action) return { state: "unknown", source, reason: source === "unavailable" ? "ledger-unavailable" : "action-not-found", freshness: source === "unavailable" ? "unavailable" : undefined };
  const latest = latestReceipt(receipts);
  if (latest?.status === "in-progress") return { state: "in-progress", source, observedAt: action.observedAt, freshness: "fresh", changedSince: latest.at };
  if (nowMs >= Date.parse(action.expiresAt)) return { state: "expired", source, observedAt: action.observedAt, freshness: "stale", reason: "action-expired" };
  const ageMs = Math.max(0, nowMs - Date.parse(action.observedAt));
  if (ageMs > action.requiredFreshnessMs) return { state: "stale", source, observedAt: action.observedAt, freshness: "stale", reason: "action-observation-stale" };
  const unknown = action.preconditions.find((item) => item.state === "unknown");
  if (unknown) return { state: "unknown", source, observedAt: action.observedAt, freshness: "unavailable", reason: `${unknown.name}: precondition-unknown` };
  const stale = action.preconditions.find((item) => item.state === "stale");
  if (stale) return { state: "stale", source, observedAt: action.observedAt, freshness: "stale", reason: `${stale.name}: precondition-stale` };
  const refused = action.preconditions.find((item) => item.state === "missing");
  if (refused) return { state: "refused", source, observedAt: action.observedAt, freshness: "fresh", reason: `${refused.name}: precondition-missing` };
  if (action.approvalRequired && latest?.decision !== "approve") return { state: "refused", source, observedAt: action.observedAt, freshness: "fresh", reason: "approval-required" };
  return { state: "ready", source, observedAt: action.observedAt, freshness: "fresh", changedSince: latest?.at };
}

function history(deps: AutomationActionRouteDependencies, state: AutomationState, nowMs: number): AutomationActionHistory[] {
  return [...state.actions.values()].map((action) => ({
    ...action,
    preflight: preflight(action, state.receipts.get(action.actionId) ?? [], nowMs, state.present ? "ledger" : "unavailable"),
    receipts: state.receipts.get(action.actionId) ?? [],
  })).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || a.actionId.localeCompare(b.actionId));
}

function receiptId(actionId: string, idempotencyKey: string, nowMs: number): string {
  return `automation:${actionId}:${nowMs.toString(36)}:${idempotencyKey.slice(0, 12)}`;
}

function appendReceipt(deps: AutomationActionRouteDependencies, req: IncomingMessage, receipt: AutomationActionReceipt): void {
  appendPanelLedger(deps.ledgerPath, AUTOMATION_ACTION_RECEIPT_STEP, receipt.actionId, bearerTokenId(req), { receipt });
}

export function buildAutomationActionReadRoute(deps: AutomationActionRouteDependencies): Route {
  return {
    method: "GET",
    path: "/v1/automation/actions",
    scope: "read",
    handler: (_req, res) => {
      try {
        const state = readAutomationState(deps);
        sendJson(res, 200, { version: AUTOMATION_ACTION_VERSION, actions: history(deps, state, deps.now?.() ?? Date.now()), source: state.present ? "ledger" : "unavailable", ...(state.present ? {} : { reason: "ledger-absent" }) } satisfies AutomationActionReadResult);
      } catch {
        sendJson(res, 503, { version: AUTOMATION_ACTION_VERSION, actions: [], source: "unavailable", reason: "ledger-unreadable" } satisfies AutomationActionReadResult);
      }
    },
  };
}

export function buildAutomationActionRegisterRoute(deps: AutomationActionRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/automation/actions",
    scope: "write",
    tier: "middle",
    handler: jsonAction((body) => {
      if (!isRecord(body) || Object.keys(body).some((key) => key !== "action") || !isRecord(body.action)) return { error: "body must contain only action" };
      return validateAction(body.action);
    }, (action, req, res) => {
      try {
        const state = readAutomationState(deps);
        const existing = state.actions.get(action.actionId);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(action)) {
            sendJson(res, 409, { error: "conflict", detail: `actionId ${action.actionId} already names a different action` });
            return;
          }
          sendJson(res, 200, { ok: true, existing: true, action });
          return;
        }
        appendPanelLedger(deps.ledgerPath, AUTOMATION_ACTION_STEP, action.actionId, bearerTokenId(req), { action });
        sendJson(res, 201, { ok: true, existing: false, action });
      } catch {
        sendJson(res, 503, { error: "unavailable", detail: "automation action ledger is unavailable" });
      }
    }),
  };
}

export function buildAutomationActionPreflightRoute(deps: AutomationActionRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/automation/actions/preflight",
    scope: "read",
    handler: jsonAction(validateActionId, (input, _req, res) => {
      try {
        const state = readAutomationState(deps);
        const action = state.actions.get(input.actionId);
        sendJson(res, 200, { version: AUTOMATION_ACTION_VERSION, actionId: input.actionId, preflight: preflight(action, state.receipts.get(input.actionId) ?? [], deps.now?.() ?? Date.now(), state.present ? "ledger" : "unavailable") });
      } catch {
        sendJson(res, 503, { version: AUTOMATION_ACTION_VERSION, actionId: input.actionId, preflight: { state: "unknown", source: "unavailable", reason: "ledger-unreadable", freshness: "unavailable" } satisfies AutomationActionPreflight });
      }
    }),
  };
}

export function buildAutomationActionDecisionRoute(deps: AutomationActionRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/automation/actions/decision",
    scope: "write",
    tier: "high",
    handler: jsonAction(validateDecision, (input, req, res) => {
      let state: AutomationState;
      try {
        state = readAutomationState(deps);
      } catch {
        sendJson(res, 503, { error: "unavailable", detail: "automation action ledger is unavailable" });
        return;
      }
      const existingByKey = state.byIdempotency.get(input.idempotencyKey);
      if (existingByKey) {
        if (existingByKey.actionId !== input.actionId || existingByKey.decision !== input.decision) {
          sendJson(res, 409, { error: "conflict", detail: "idempotencyKey already names a different decision" });
          return;
        }
        sendJson(res, 200, { ok: true, existing: true, receipt: existingByKey });
        return;
      }
      const action = state.actions.get(input.actionId);
      if (!action) {
        sendJson(res, 409, { error: "refused", state: "unknown", reason: state.present ? "action-not-found" : "ledger-unavailable" });
        return;
      }
      const actionReceipts = state.receipts.get(action.actionId) ?? [];
      const current = preflight(action, actionReceipts, deps.now?.() ?? Date.now(), "ledger");
      if (input.decision === "approve" && current.state !== "ready") {
        const refused: AutomationActionReceipt = { receiptId: receiptId(action.actionId, input.idempotencyKey, deps.now?.() ?? Date.now()), actionId: action.actionId, idempotencyKey: input.idempotencyKey, decision: input.decision, status: "refused", at: new Date(deps.now?.() ?? Date.now()).toISOString(), reason: current.reason ?? current.state };
        appendReceipt(deps, req, refused);
        sendJson(res, 409, { ok: false, preflight: current, receipt: refused });
        return;
      }
      if ((input.decision === "cancel" || input.decision === "rollback") && !actionReceipts.some((receipt) => receipt.status === "in-progress")) {
        const refused: AutomationActionReceipt = { receiptId: receiptId(action.actionId, input.idempotencyKey, deps.now?.() ?? Date.now()), actionId: action.actionId, idempotencyKey: input.idempotencyKey, decision: input.decision, status: "refused", at: new Date(deps.now?.() ?? Date.now()).toISOString(), reason: "no-in-progress-action" };
        appendReceipt(deps, req, refused);
        sendJson(res, 409, { ok: false, preflight: current, receipt: refused });
        return;
      }
      const prior = latestReceipt(actionReceipts);
      const receipt: AutomationActionReceipt = { receiptId: receiptId(action.actionId, input.idempotencyKey, deps.now?.() ?? Date.now()), actionId: action.actionId, idempotencyKey: input.idempotencyKey, decision: input.decision, status: input.decision === "reject" ? "refused" : "in-progress", at: new Date(deps.now?.() ?? Date.now()).toISOString(), ...(input.decision === "rollback" && prior ? { linkedReceiptId: prior.receiptId } : {}), ...(input.reason ? { reason: input.reason } : {}) };
      appendReceipt(deps, req, receipt);
      sendJson(res, 200, { ok: true, existing: false, receipt });
    }),
  };
}

export function buildAutomationActionRoutes(deps: AutomationActionRouteDependencies): Route[] {
  return [
    buildAutomationActionReadRoute(deps),
    buildAutomationActionRegisterRoute(deps),
    buildAutomationActionPreflightRoute(deps),
    buildAutomationActionDecisionRoute(deps),
  ];
}
