/**
 * Durable operator-agent proposal memory for the panel surface.
 *
 * Proposals are intentionally separate from plan/feedback entries. Feedback is a human filing
 * that enters triage; an operator-agent proposal is a bounded recommendation with its own
 * accept/reject/more-info lifecycle. The ledger is the source of truth so a restart or rotation
 * cannot turn a browser-local decision into apparent learning.
 */

import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { ServerResponse } from "node:http";
import type { Route } from "./service.js";
import { clockFromMillisFn, fixedClock } from "./clock.js";
import { EMERGENCY_STOP_CLEARED_LEDGER_STEP, EMERGENCY_STOP_ISSUED_LEDGER_STEP } from "./ledger.js";
import { readLedgerUnionRecordsSync, realLedgerFs, type LedgerGrepFsDeps } from "./ledger-union.js";
import {
  appendPanelLedger,
  bearerTokenId,
  isRecord,
  jsonAction,
  sendJson,
  type PanelActionDeps,
} from "./panel-actions.js";
import {
  advancePromotionState,
  evaluateAssistantTrust,
  evaluateGuardrails,
  expirePromotionIfDue,
  findScopeConflict,
  isPromotionActive,
  rollbackPromotion,
  validateAssistantTrustControlResults,
  validateAssistantTrustEvidence,
  validateGuardObservations,
  validateRawAssistantTrustContext,
  validatePromotionRecord,
  validatePromotionRollback,
  validateReplaySummary,
  verifyAssistantTrustControls,
  type AssistantTrustControlResult,
  type AssistantTrustEvaluationResult,
  type AssistantTrustEvidence,
  type ExperimentPromotionState,
  type GuardEvaluation,
  type GuardObservation,
  type PromotionAdvanceTarget,
  type PromotionRecord,
  type PromotionRollback,
  type RawAssistantTrustContext,
  type ReplaySummary,
} from "./experiment-promotion.js";
import {
  evaluateFollowUpPolicy,
  readFollowUpHistory,
  type FollowUpCandidate,
  type FollowUpHistory,
} from "./follow-up-policy.js";
import {
  classifyConsequenceAction,
  evaluateConsequencePolicy,
  recordConsequenceRefusal,
  type ConsequenceAction,
  type ConsequenceActionInput,
} from "./consequence-policy.js";
import {
  acceptDelegationEnvelope,
  createDelegationEnvelope,
  executeBoundedDelegation,
  InMemoryDelegationEnvelopeStore,
  type DelegationCapabilityRef,
  type DelegationHumanApproval,
  type DelegationRiskTier,
  type DelegationScope,
} from "./automation-action.js";
import {
  checkEmergencyStop,
  clearEmergencyStop,
  createEmergencyStop,
  emergencyStopIssuedReceipt,
  isEmergencyStopActive,
  parseStoredEmergencyStop,
  EMERGENCY_STOP_CLEAR_POLICIES,
  EMERGENCY_STOP_SCOPES,
  type EmergencyClearRequest,
  type EmergencyStop,
  type EmergencyStopClearPolicy,
  type EmergencyStopScope,
} from "./emergency-control.js";

export const OPERATOR_AGENT_PROPOSAL_STEP = "panel.operator_agent_proposal";
export const OPERATOR_AGENT_DECISION_STEP = "panel.operator_agent_decision";
export const OPERATOR_AGENT_OUTCOME_STEP = "panel.operator_agent_outcome";
export const OPERATOR_AGENT_SETTINGS_STEP = "panel.operator_agent_settings";
export const OPERATOR_AGENT_EXPERIMENT_STEP = "panel.operator_agent_experiment";
export const OPERATOR_AGENT_EXPERIMENT_DECISION_STEP = "panel.operator_agent_experiment_decision";
export const OPERATOR_AGENT_EXPERIMENT_OUTCOME_STEP = "panel.operator_agent_experiment_outcome";
export const OPERATOR_AGENT_EXPERIMENT_ROLLBACK_STEP = "panel.operator_agent_experiment_rollback";
export const OPERATOR_AGENT_EXPERIMENT_VERSION = "experiment-v1";
export const OPERATOR_AGENT_PROMOTION_STEP = "panel.operator_agent_promotion";
export const OPERATOR_AGENT_PROMOTION_REPLAY_STEP = "panel.operator_agent_promotion_replay";
export const OPERATOR_AGENT_PROMOTION_DECISION_STEP = "panel.operator_agent_promotion_decision";
export const OPERATOR_AGENT_PROMOTION_ADVANCE_STEP = "panel.operator_agent_promotion_advance";
export const OPERATOR_AGENT_PROMOTION_ROLLBACK_STEP = "panel.operator_agent_promotion_rollback";
export const OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP = "panel.operator_agent_consequence_preflight";
export const OPERATOR_AGENT_CONSEQUENCE_DECISION_STEP = "panel.operator_agent_consequence_decision";
export const CONTEXT_ITEM_VERSION = "context-item-v1" as const;
export const CONTEXT_ITEM_STEP = "panel.context_item";
export const CONTEXT_REVOKED_STEP = "panel.context_revoked";
export const CONTEXT_DELETED_STEP = "panel.context_deleted";
/** W1-T3883: one bounded handoff — issue, accept, and act all verified through
 *  executeBoundedDelegation( before this ledgers — never a raw prompt or secret, only the
 *  resulting {@link DelegationReceipt}. */
export const OPERATOR_AGENT_DELEGATION_HANDOFF_STEP = "panel.operator_agent_delegation_handoff";
/** W1-T3900: audit trail only (never re-read to decide anything), so — unlike
 *  EMERGENCY_STOP_ISSUED_LEDGER_STEP/EMERGENCY_STOP_CLEARED_LEDGER_STEP (ledger.ts) — these stay
 *  local, matching OPERATOR_AGENT_PROPOSAL_STEP's precedent just above. */
export const EMERGENCY_STOP_REFUSAL_STEP = "panel.emergency_stop_refusal";
export const EMERGENCY_STOP_CANCELLATION_STEP = "panel.emergency_stop_cancellation";
export const OPERATOR_AGENT_DEFAULT_SETTINGS = { enabled: true, confidenceThreshold: 0.9 } as const;

export const OPERATOR_AGENT_CATEGORIES = ["optimize", "fix", "scale"] as const;
export type OperatorAgentCategory = (typeof OPERATOR_AGENT_CATEGORIES)[number];

export const OPERATOR_AGENT_DECISIONS = ["accepted", "rejected", "more-info"] as const;
export type OperatorAgentDecision = (typeof OPERATOR_AGENT_DECISIONS)[number];

export type OperatorAgentFreshness = "verified" | "stale" | "unavailable";

export type ContextFreshness = "fresh" | "stale" | "unavailable";
export type ContextSensitivity = "low" | "moderate" | "high" | "restricted";
export type ContextVisibility = "private" | "operator" | "shared";
export type ContextRevocationState = "active" | "revoked";
export type ContextAvailability = "available" | "stale" | "unavailable" | "revoked" | "deleted";

export interface ContextRetention {
  policy: string;
  expiresAt: string;
}

/** The durable, bounded envelope for assistant memory. `content` is deliberately an internal
 * field: HTTP projections use {@link contextInventoryItem} and never return it to a browser. */
export interface ContextItem {
  version: typeof CONTEXT_ITEM_VERSION;
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
  revocation: { state: ContextRevocationState; revokedAt?: string; reason?: string };
  content: string;
}

export interface ContextInventoryItem extends Omit<ContextItem, "content"> {
  availability: ContextAvailability;
  deletionReceipt?: ContextDeletionReceipt;
}

export type ContextOperation = "revoke" | "delete";

export interface ContextDeletionReceipt {
  receiptId: string;
  contextId: string;
  operation: ContextOperation;
  at: string;
  authorityRef: string;
  affectedDerivations: number;
}

export interface ContextReadQuery {
  purpose: string;
  authorityRef: string;
  now?: number;
}

export interface ContextReadResult {
  items: ContextItem[];
  stale: string[];
  absent: boolean;
}

export interface OperatorAgentEvidence {
  label: string;
  value: string;
  source: string;
  observedAt: string;
  freshness: OperatorAgentFreshness;
}

export interface OperatorAgentProposal {
  proposalId: string;
  repo: string;
  proposalText: string;
  confidence: number;
  reasoning: string;
  category: OperatorAgentCategory;
  status: "pending" | "accepted" | "rejected" | "expired";
  createdAt: string;
  expiresAt?: string;
  evidence: OperatorAgentEvidence[];
}

export interface OperatorAgentOutcome {
  summary: string;
  helped?: boolean;
  observedAt: string;
  evidence?: string[];
}

export interface OperatorAgentDecisionEvent {
  decision: OperatorAgentDecision;
  at: string;
  note?: string;
}

export interface OperatorAgentHistory extends OperatorAgentProposal {
  status: "pending" | "accepted" | "rejected" | "expired";
  outcome?: OperatorAgentOutcome;
  decisionHistory: OperatorAgentDecisionEvent[];
}

export interface OperatorAgentSettings {
  enabled: boolean;
  confidenceThreshold: number;
}

export interface OperatorAgentSettingsScope {
  kind: "repository";
  repository: string;
}

export type OperatorAgentSettingsRead = {
  settings: OperatorAgentSettings;
  source: "ledger" | "default";
  scope?: OperatorAgentSettingsScope;
};

/**
 * The bounded, process-owned slice of the ledger that the proposal/settings routes need.
 * `state: "cold"` is deliberately distinct from an empty row list: the serve-owned analytics
 * refresh has not yet observed the ledger, so a request must not turn that absence into verified
 * empty history.
 */
export type OperatorAgentMemoryLedgerRow = Readonly<Record<string, unknown>>;

export interface OperatorAgentMemorySnapshot {
  state: "cold" | "ready";
  asOf: string | null;
  rows: readonly OperatorAgentMemoryLedgerRow[];
}

export interface OperatorAgentMemorySource {
  current(): OperatorAgentMemorySnapshot;
  /** Record a just-written bounded event without reopening the ledger on the request path. */
  record(row: Record<string, unknown>): void;
}

export type OperatorAgentExperimentState =
  | "proposed"
  | "approved"
  | "observing"
  | "succeeded"
  | "neutral"
  | "regressed"
  | "rolled_back"
  | "expired"
  | "unmeasurable"
  | "rejected";

export type OperatorAgentExperimentOutcomeState = "observing" | "succeeded" | "neutral" | "regressed" | "unmeasurable";
export type OperatorAgentExperimentAttribution = "complete" | "missing" | "mixed";

export interface OperatorAgentExperimentScope {
  repo: string;
  taskType?: string;
  lane?: string;
  provider?: string;
  modelPolicy?: string;
  evidenceAnchors?: string[];
}

export interface OperatorAgentExperimentBaseline {
  metricName: string;
  value: number;
  unit: string;
  denominator: number;
  comparisonPopulation: string;
  windowStart: string;
  windowEnd: string;
  source: string;
  freshness: OperatorAgentFreshness;
}

export interface OperatorAgentExperimentIntervention {
  summary: string;
  plan: string;
  taskId?: string;
  prUrl?: string;
}

export interface OperatorAgentExperimentRollback {
  plan: string;
  reason: string;
  receipt?: string;
}

export interface OperatorAgentExperiment {
  version: typeof OPERATOR_AGENT_EXPERIMENT_VERSION;
  experimentId: string;
  proposalId?: string;
  hypothesis: string;
  intervention: OperatorAgentExperimentIntervention;
  scope: OperatorAgentExperimentScope;
  baseline: OperatorAgentExperimentBaseline;
  rollback: OperatorAgentExperimentRollback;
  createdAt: string;
  state: OperatorAgentExperimentState;
}

export interface OperatorAgentExperimentOutcome {
  state: OperatorAgentExperimentOutcomeState;
  summary: string;
  observedAt: string;
  source?: string;
  freshness?: OperatorAgentFreshness;
  attribution?: OperatorAgentExperimentAttribution;
  denominator?: number;
  comparisonPopulation?: string;
  metricName?: string;
  value?: number;
  reason?: string;
}

export interface OperatorAgentExperimentEvent {
  kind: "decision" | "outcome" | "rollback";
  at: string;
  decision?: "approved" | "rejected";
  outcome?: OperatorAgentExperimentOutcome;
  rollback?: OperatorAgentExperimentRollback;
  note?: string;
}

export interface OperatorAgentExperimentHistory extends OperatorAgentExperiment {
  state: OperatorAgentExperimentState;
  events: OperatorAgentExperimentEvent[];
  outcome?: OperatorAgentExperimentOutcome;
}

/**
 * One step of the experiment-promotion-v1 guarded flow (W1-T3856). Unlike the proposal/experiment
 * events above, each promotion event carries the RESULTING `state` directly: the route handler
 * computes it at write time from the current fold plus the engine (`advancePromotionState`,
 * `rollbackPromotion`, `evaluateGuardrails`), so a later read never has to re-run the state machine
 * over the full event history to know where a promotion stands.
 */
export interface OperatorAgentPromotionEvent {
  kind: "replay" | "decision" | "advance" | "rollback";
  at: string;
  state: ExperimentPromotionState;
  replay?: ReplaySummary;
  decision?: "approved";
  advance?: {
    target: PromotionAdvanceTarget;
    guard: GuardEvaluation;
    exposure?: number;
    /** Set only when the caller submitted assistant-trust evidence (W1-T3882) with this advance
     *  request — see {@link buildOperatorAgentPromotionAdvanceRoute}. Absent, an advance behaves
     *  exactly as the pre-W1-T3882 base guardrail flow always did. */
    assistantTrust?: AssistantTrustEvaluationResult;
  };
  rollback?: PromotionRollback;
  note?: string;
}

export interface OperatorAgentPromotionHistory extends PromotionRecord {
  state: ExperimentPromotionState;
  events: OperatorAgentPromotionEvent[];
}

export type OperatorAgentRouteDependencies = Pick<PanelActionDeps, "ledgerPath"> & {
  now?: () => number;
  memory?: OperatorAgentMemorySource;
};

type ProposalRegistrationInput = { proposal: OperatorAgentProposal };
type ProposalDecisionInput = { proposalId: string; decision: OperatorAgentDecision; note?: string };
type ProposalOutcomeInput = { proposalId: string; outcome: OperatorAgentOutcome };
type OperatorAgentSettingsInput = { settings: OperatorAgentSettings; scope?: OperatorAgentSettingsScope };
type ExperimentRegistrationInput = { experiment: OperatorAgentExperiment };
type ExperimentDecisionInput = { experimentId: string; decision: "approved" | "rejected"; note?: string };
type ExperimentOutcomeInput = { experimentId: string; outcome: OperatorAgentExperimentOutcome };
type ExperimentRollbackInput = { experimentId: string; rollback: OperatorAgentExperimentRollback };
type PromotionRegistrationInput = { promotion: PromotionRecord };
type PromotionReplayInput = { promotionId: string; replay: ReplaySummary };
type PromotionDecisionInput = { promotionId: string; decision: "approved"; note?: string };
/**
 * Assistant-trust evidence (W1-T3882) submitted alongside an advance request. Entirely optional
 * — its absence preserves the pre-existing base-guardrail-only advance behaviour byte for byte;
 * its presence runs {@link evaluateAssistantTrust} and can block or unmeasurable the advance
 * ahead of the base guardrail evaluation.
 */
type PromotionAdvanceAssistantTrustInput = { controls: AssistantTrustControlResult[]; evidence: AssistantTrustEvidence; rawContext?: RawAssistantTrustContext };
type PromotionAdvanceInput = {
  promotionId: string;
  target: PromotionAdvanceTarget;
  observations?: GuardObservation[];
  exposure?: number;
  assistantTrust?: PromotionAdvanceAssistantTrustInput;
};
type PromotionRollbackInput = { promotionId: string; rollback: PromotionRollback };
type ConsequenceDecisionInput = { consequenceId: string; decision: "approve" | "refuse"; reason?: string };

const MAX_ID = 160;
const MAX_REPO = 200;
const MAX_TEXT = 500;
const MAX_REASONING = 4_000;
const MAX_NOTE = 1_000;
const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_VALUE = 600;
const MAX_EXPERIMENT_ID = 160;
const MAX_EXPERIMENT_FIELD = 320;
const MAX_EXPERIMENT_SOURCE = 220;
const MAX_EXPERIMENT_ANCHORS = 12;
const MAX_EXPERIMENT_EVENTS = 100;
const MAX_PROMOTION_EVENTS = 100;
const PROMOTION_ADVANCE_TARGETS = ["shadow", "canary", "observing", "promoted"] as const;
const MIN_EXPERIMENT_DENOMINATOR = 5;
const MIN_CONFIDENCE_THRESHOLD = 0.9;
const MAX_CONFIDENCE_THRESHOLD = 0.99;

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validFreshness(value: unknown): value is OperatorAgentFreshness {
  return value === "verified" || value === "stale" || value === "unavailable";
}

function safeExperimentText(value: unknown, max: number): value is string {
  return boundedString(value, max) && !/(?:bearer|token|secret|password|api[_-]?key|sk-[A-Za-z0-9])/i.test(value);
}

const MAX_CONTEXT_ID = 160;
const MAX_CONTEXT_FIELD = 320;
const MAX_CONTEXT_CONTENT = 4_000;
const MAX_CONTEXT_LINKS = 20;
const MAX_CONTEXT_REASON = 500;

function validContextFreshness(value: unknown): value is ContextFreshness {
  return value === "fresh" || value === "stale" || value === "unavailable";
}

function validContextSensitivity(value: unknown): value is ContextSensitivity {
  return value === "low" || value === "moderate" || value === "high" || value === "restricted";
}

function validContextVisibility(value: unknown): value is ContextVisibility {
  return value === "private" || value === "operator" || value === "shared";
}

function validateContextItem(value: unknown): ContextItem | null {
  if (!isRecord(value) || value.version !== CONTEXT_ITEM_VERSION) return null;
  if (!boundedString(value.contextId, MAX_CONTEXT_ID)) return null;
  if (!boundedString(value.source, MAX_CONTEXT_FIELD) || !boundedString(value.principal, MAX_CONTEXT_FIELD)) return null;
  if (!boundedString(value.purpose, MAX_CONTEXT_FIELD) || !validContextSensitivity(value.sensitivity)) return null;
  if (!boundedString(value.authorityRef, MAX_CONTEXT_FIELD) || !iso(value.observedAt)) return null;
  if (!validContextFreshness(value.freshness) || !validContextVisibility(value.visibility)) return null;
  if (!isRecord(value.retention) || !boundedString(value.retention.policy, MAX_CONTEXT_FIELD) || !iso(value.retention.expiresAt)) return null;
  if (!Array.isArray(value.derivationLinks) || value.derivationLinks.length > MAX_CONTEXT_LINKS) return null;
  if (!value.derivationLinks.every((link) => boundedString(link, MAX_CONTEXT_ID))) return null;
  if (!isRecord(value.revocation) || value.revocation.state !== "active") return null;
  if (!boundedString(value.content, MAX_CONTEXT_CONTENT)) return null;
  return {
    version: CONTEXT_ITEM_VERSION,
    contextId: value.contextId.trim(),
    source: value.source.trim(),
    principal: value.principal.trim(),
    purpose: value.purpose.trim(),
    sensitivity: value.sensitivity,
    authorityRef: value.authorityRef.trim(),
    observedAt: new Date(value.observedAt).toISOString(),
    freshness: value.freshness,
    retention: { policy: value.retention.policy.trim(), expiresAt: new Date(value.retention.expiresAt).toISOString() },
    visibility: value.visibility,
    derivationLinks: value.derivationLinks.map((link) => link.trim()),
    revocation: { state: "active" },
    content: value.content.trim(),
  };
}

/** W1-T3893: exported so context-controls.ts's forget/revoke routes accept the SAME bounded
 *  {contextId, authorityRef, reason?} shape as the governance routes below, rather than a second,
 *  driftable copy of these bounds. */
export function validateContextAction(value: unknown): { error: string } | { contextId: string; authorityRef: string; reason?: string } {
  if (!isRecord(value)) return { error: "body must be a JSON object" };
  if (!boundedString(value.contextId, MAX_CONTEXT_ID)) return { error: "contextId is required" };
  if (!boundedString(value.authorityRef, MAX_CONTEXT_FIELD)) return { error: "authorityRef is required" };
  if (value.reason !== undefined && !boundedString(value.reason, MAX_CONTEXT_REASON)) return { error: "reason must be a bounded string" };
  return {
    contextId: value.contextId.trim(),
    authorityRef: value.authorityRef.trim(),
    ...(value.reason ? { reason: value.reason.trim() } : {}),
  };
}

function validateContextRegistration(value: unknown): { error: string } | { context: ContextItem } {
  if (!isRecord(value)) return { error: "body must be a JSON object" };
  const context = validateContextItem(value.context);
  return context ? { context } : { error: "context must be a complete bounded context-item-v1 envelope" };
}

function contextRows(ledgerPath: string): Array<Record<string, unknown>> {
  return readLedgerUnionRecordsSync(dirname(ledgerPath), {
    step: [CONTEXT_ITEM_STEP, CONTEXT_REVOKED_STEP, CONTEXT_DELETED_STEP],
  }).rows;
}

/** W1-T3893: exported so `context-controls.ts` composes self-service inventory, forget, revoke,
 *  and export directly on this restart-safe, ledger-backed engine rather than re-reading rows
 *  itself — a second reader would drift the moment a rotation shape or receipt field changed. */
export interface ContextLedgerState {
  items: Map<string, ContextItem>;
  revocations: Map<string, { at: string; reason?: string; receipt?: ContextDeletionReceipt }>;
  deletions: Map<string, ContextDeletionReceipt>;
}

export function readContextLedgerState(ledgerPath: string): ContextLedgerState {
  const items = new Map<string, ContextItem>();
  const revocations = new Map<string, { at: string; reason?: string }>();
  const deletions = new Map<string, ContextDeletionReceipt>();
  for (const row of contextRows(ledgerPath)) {
    if (row.step === CONTEXT_ITEM_STEP) {
      const context = validateContextItem(row.context);
      if (context && !items.has(context.contextId)) items.set(context.contextId, context);
      continue;
    }
    if (!boundedString(row.context_id, MAX_CONTEXT_ID)) continue;
    if (row.step === CONTEXT_REVOKED_STEP && iso(row.at)) {
      const receipt = validateContextReceipt(row.receipt);
      revocations.set(row.context_id, {
        at: new Date(row.at).toISOString(),
        ...(boundedString(row.reason, MAX_CONTEXT_REASON) ? { reason: row.reason.trim() } : {}),
        ...(receipt ? { receipt } : {}),
      });
      continue;
    }
    if (row.step === CONTEXT_DELETED_STEP && isRecord(row.receipt)) {
      const receipt = validateContextReceipt(row.receipt);
      if (receipt) deletions.set(receipt.contextId, receipt);
    }
  }
  return { items, revocations, deletions };
}

function validateContextReceipt(value: unknown): ContextDeletionReceipt | null {
  if (!isRecord(value)) return null;
  if (!boundedString(value.receiptId, MAX_CONTEXT_ID) || !boundedString(value.contextId, MAX_CONTEXT_ID)) return null;
  if (value.operation !== "revoke" && value.operation !== "delete") return null;
  if (!iso(value.at) || !boundedString(value.authorityRef, MAX_CONTEXT_FIELD)) return null;
  if (typeof value.affectedDerivations !== "number" || !Number.isInteger(value.affectedDerivations) || value.affectedDerivations < 0) return null;
  return {
    receiptId: value.receiptId.trim(),
    contextId: value.contextId.trim(),
    operation: value.operation,
    at: new Date(value.at).toISOString(),
    authorityRef: value.authorityRef.trim(),
    affectedDerivations: value.affectedDerivations,
  };
}

/** W1-T3893: exported — self-service export (context-controls.ts) needs the SAME recursive
 *  derivation-availability check the inventory uses, not a second copy that could disagree about
 *  what "complete source coverage" means. */
export function contextStatus(id: string, state: ContextLedgerState, now: number, stack = new Set<string>()): ContextAvailability {
  if (state.deletions.has(id)) return "deleted";
  if (state.revocations.has(id)) return "revoked";
  const item = state.items.get(id);
  if (!item) return "unavailable";
  if (Date.parse(item.retention.expiresAt) <= now || item.freshness !== "fresh") return "stale";
  if (stack.has(id)) return "unavailable";
  stack.add(id);
  const derivedUnavailable = item.derivationLinks.some((link) => contextStatus(link, state, now, new Set(stack)) !== "available");
  return derivedUnavailable ? "unavailable" : "available";
}

function contextInventoryItem(item: ContextItem, state: ContextLedgerState, now: number): ContextInventoryItem {
  const { content: _privateContent, ...metadata } = item;
  const revoked = state.revocations.get(item.contextId);
  const deletionReceipt = state.deletions.get(item.contextId);
  return {
    ...metadata,
    revocation: revoked
      ? { state: "revoked", revokedAt: revoked.at, ...(revoked.reason ? { reason: revoked.reason } : {}) }
      : item.revocation,
    availability: contextStatus(item.contextId, state, now),
    ...(deletionReceipt ? { deletionReceipt } : revoked?.receipt ? { deletionReceipt: revoked.receipt } : {}),
  };
}

export function readContextInventory(deps: OperatorAgentRouteDependencies): ContextInventoryItem[] {
  const state = readContextLedgerState(deps.ledgerPath);
  const now = deps.now?.() ?? Date.now();
  return [...state.items.values()].map((item) => contextInventoryItem(item, state, now)).sort((a, b) => a.contextId.localeCompare(b.contextId));
}

/** Shared planning/action preflight. A context item is usable only with the current authority,
 * exact declared purpose, fresh retention, and available derivation inputs. */
export function filterContextItems(items: readonly ContextItem[], query: ContextReadQuery): ContextReadResult {
  const now = query.now ?? Date.now();
  const matching = items.filter((item) => item.purpose === query.purpose && item.authorityRef === query.authorityRef);
  const stale = matching.filter((item) => Date.parse(item.retention.expiresAt) <= now || item.freshness !== "fresh").map((item) => item.contextId);
  const usable = matching.filter((item) => item.revocation.state === "active" && !stale.includes(item.contextId));
  return { items: usable, stale, absent: matching.length === 0 };
}

/** W1-T3893: the name the planning path calls through — see {@link readGovernedContext} below.
 *  Same function as {@link filterContextItems}; the alias is the one the acceptance proof greps
 *  for, so the call site (not just an unused export) must read `filterContextForPurpose(`. */
export const filterContextForPurpose = filterContextItems;

export function readGovernedContext(deps: OperatorAgentRouteDependencies, query: ContextReadQuery): ContextReadResult {
  const state = readContextLedgerState(deps.ledgerPath);
  const now = query.now ?? deps.now?.() ?? Date.now();
  const all = [...state.items.values()].filter((item) => contextStatus(item.contextId, state, now) === "available");
  const result = filterContextForPurpose(all, { ...query, now });
  const matching = [...state.items.values()].filter((item) => item.purpose === query.purpose && item.authorityRef === query.authorityRef);
  const unavailableStale = matching.filter((item) => contextStatus(item.contextId, state, now) === "stale").map((item) => item.contextId);
  return { ...result, stale: [...new Set([...result.stale, ...unavailableStale])], absent: matching.length === 0 };
}

export const readPersonalContext = readGovernedContext;

function publicContext(item: ContextItem, state: ContextLedgerState, now: number): ContextInventoryItem {
  return contextInventoryItem(item, state, now);
}

function contextReceiptId(contextId: string, operation: ContextOperation, at: string, count: number): string {
  return `ctxr_${createHash("sha256").update(`${contextId}:${operation}:${at}:${count}`).digest("hex").slice(0, 24)}`;
}

function validExperimentOutcomeState(value: unknown): value is OperatorAgentExperimentOutcomeState {
  return ["observing", "succeeded", "neutral", "regressed", "unmeasurable"].includes(value as string);
}

function validAttribution(value: unknown): value is OperatorAgentExperimentAttribution {
  return value === "complete" || value === "missing" || value === "mixed";
}

function validBoundedNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateExperimentScope(value: unknown): OperatorAgentExperimentScope | null {
  if (!isRecord(value) || !safeExperimentText(value.repo, MAX_REPO)) return null;
  const scope: OperatorAgentExperimentScope = { repo: value.repo.trim() };
  for (const field of ["taskType", "lane", "provider", "modelPolicy"] as const) {
    if (value[field] !== undefined) {
      if (!safeExperimentText(value[field], MAX_EXPERIMENT_FIELD)) return null;
      scope[field] = value[field].trim();
    }
  }
  if (value.evidenceAnchors !== undefined) {
    if (!Array.isArray(value.evidenceAnchors) || value.evidenceAnchors.length > MAX_EXPERIMENT_ANCHORS) return null;
    if (!value.evidenceAnchors.every((item) => safeExperimentText(item, MAX_EXPERIMENT_SOURCE))) return null;
    scope.evidenceAnchors = value.evidenceAnchors.map((item) => item.trim());
  }
  return scope;
}

function validateExperimentBaseline(value: unknown): OperatorAgentExperimentBaseline | null {
  if (!isRecord(value)) return null;
  if (!safeExperimentText(value.metricName, MAX_EXPERIMENT_FIELD) || !safeExperimentText(value.unit, 80)) return null;
  if (!validBoundedNumber(value.value) || !validBoundedNumber(value.denominator) || value.denominator < 1) return null;
  if (!safeExperimentText(value.comparisonPopulation, MAX_EXPERIMENT_FIELD) || !safeExperimentText(value.source, MAX_EXPERIMENT_SOURCE)) return null;
  if (!iso(value.windowStart) || !iso(value.windowEnd) || Date.parse(value.windowStart) >= Date.parse(value.windowEnd)) return null;
  if (!validFreshness(value.freshness)) return null;
  return {
    metricName: value.metricName.trim(),
    value: value.value,
    unit: value.unit.trim(),
    denominator: Math.floor(value.denominator),
    comparisonPopulation: value.comparisonPopulation.trim(),
    windowStart: new Date(value.windowStart).toISOString(),
    windowEnd: new Date(value.windowEnd).toISOString(),
    source: value.source.trim(),
    freshness: value.freshness,
  };
}

function validateExperimentIntervention(value: unknown): OperatorAgentExperimentIntervention | null {
  if (!isRecord(value) || !safeExperimentText(value.summary, MAX_EXPERIMENT_FIELD) || !safeExperimentText(value.plan, MAX_EXPERIMENT_FIELD)) return null;
  const intervention: OperatorAgentExperimentIntervention = { summary: value.summary.trim(), plan: value.plan.trim() };
  if (value.taskId !== undefined) {
    if (!safeExperimentText(value.taskId, MAX_ID)) return null;
    intervention.taskId = value.taskId.trim();
  }
  if (value.prUrl !== undefined) {
    if (!safeExperimentText(value.prUrl, MAX_EXPERIMENT_SOURCE) || !/^https:\/\//.test(value.prUrl)) return null;
    intervention.prUrl = value.prUrl.trim();
  }
  return intervention;
}

function validateExperimentRollback(value: unknown): OperatorAgentExperimentRollback | null {
  if (!isRecord(value) || !safeExperimentText(value.plan, MAX_EXPERIMENT_FIELD) || !safeExperimentText(value.reason, MAX_EXPERIMENT_FIELD)) return null;
  if (value.receipt !== undefined && !safeExperimentText(value.receipt, MAX_EXPERIMENT_SOURCE)) return null;
  return {
    plan: value.plan.trim(),
    reason: value.reason.trim(),
    ...(value.receipt ? { receipt: value.receipt.trim() } : {}),
  };
}

function validateExperiment(value: unknown): OperatorAgentExperiment | null {
  if (!isRecord(value) || value.version !== OPERATOR_AGENT_EXPERIMENT_VERSION || value.state !== "proposed") return null;
  if (!safeExperimentText(value.experimentId, MAX_EXPERIMENT_ID) || !safeExperimentText(value.hypothesis, MAX_EXPERIMENT_FIELD) || !iso(value.createdAt)) return null;
  if (value.proposalId !== undefined && !safeExperimentText(value.proposalId, MAX_ID)) return null;
  const intervention = validateExperimentIntervention(value.intervention);
  const scope = validateExperimentScope(value.scope);
  const baseline = validateExperimentBaseline(value.baseline);
  const rollback = validateExperimentRollback(value.rollback);
  if (!intervention || !scope || !baseline || !rollback) return null;
  return {
    version: OPERATOR_AGENT_EXPERIMENT_VERSION,
    experimentId: value.experimentId.trim(),
    ...(value.proposalId ? { proposalId: value.proposalId.trim() } : {}),
    hypothesis: value.hypothesis.trim(),
    intervention,
    scope,
    baseline,
    rollback,
    createdAt: new Date(value.createdAt).toISOString(),
    state: "proposed",
  };
}

function validateExperimentOutcome(value: unknown): OperatorAgentExperimentOutcome | null {
  if (!isRecord(value) || !validExperimentOutcomeState(value.state) || !safeExperimentText(value.summary, MAX_EXPERIMENT_FIELD) || !iso(value.observedAt)) return null;
  const outcome: OperatorAgentExperimentOutcome = {
    state: value.state,
    summary: value.summary.trim(),
    observedAt: new Date(value.observedAt).toISOString(),
  };
  for (const field of ["source", "comparisonPopulation", "metricName"] as const) {
    if (value[field] !== undefined) {
      if (!safeExperimentText(value[field], field === "source" ? MAX_EXPERIMENT_SOURCE : MAX_EXPERIMENT_FIELD)) return null;
      outcome[field] = value[field].trim();
    }
  }
  if (value.freshness !== undefined) {
    if (!validFreshness(value.freshness)) return null;
    outcome.freshness = value.freshness;
  }
  if (value.attribution !== undefined) {
    if (!validAttribution(value.attribution)) return null;
    outcome.attribution = value.attribution;
  }
  if (value.denominator !== undefined) {
    if (!validBoundedNumber(value.denominator) || value.denominator < 0) return null;
    outcome.denominator = Math.floor(value.denominator);
  }
  if (value.value !== undefined) {
    if (!validBoundedNumber(value.value)) return null;
    outcome.value = value.value;
  }
  if (value.reason !== undefined) {
    if (!safeExperimentText(value.reason, MAX_EXPERIMENT_FIELD)) return null;
    outcome.reason = value.reason.trim();
  }
  return outcome;
}

function makeUnmeasurableOutcome(outcome: OperatorAgentExperimentOutcome, reason: string): OperatorAgentExperimentOutcome {
  return { ...outcome, state: "unmeasurable", reason: reason.slice(0, MAX_EXPERIMENT_FIELD), summary: `Outcome unmeasurable: ${reason}`.slice(0, MAX_EXPERIMENT_FIELD) };
}

function normaliseExperimentOutcome(outcome: OperatorAgentExperimentOutcome, baseline: OperatorAgentExperimentBaseline): OperatorAgentExperimentOutcome {
  if (outcome.state === "observing" || outcome.state === "unmeasurable") return outcome;
  if (outcome.denominator === undefined || outcome.denominator < MIN_EXPERIMENT_DENOMINATOR) return makeUnmeasurableOutcome(outcome, `denominator is below ${MIN_EXPERIMENT_DENOMINATOR}`);
  if (outcome.attribution !== "complete") return makeUnmeasurableOutcome(outcome, `attribution is ${outcome.attribution ?? "missing"}`);
  if (outcome.freshness !== "verified") return makeUnmeasurableOutcome(outcome, `source freshness is ${outcome.freshness ?? "missing"}`);
  if (outcome.comparisonPopulation !== baseline.comparisonPopulation) return makeUnmeasurableOutcome(outcome, "comparison population does not match the baseline");
  if (outcome.metricName !== baseline.metricName || outcome.value === undefined) return makeUnmeasurableOutcome(outcome, "metric is missing or does not match the baseline");
  return outcome;
}

function isCategory(value: unknown): value is OperatorAgentCategory {
  return OPERATOR_AGENT_CATEGORIES.includes(value as OperatorAgentCategory);
}

function isDecision(value: unknown): value is OperatorAgentDecision {
  return OPERATOR_AGENT_DECISIONS.includes(value as OperatorAgentDecision);
}

function validateSettings(value: unknown): OperatorAgentSettings | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean") return null;
  if (typeof value.confidenceThreshold !== "number" || !Number.isFinite(value.confidenceThreshold) || value.confidenceThreshold < MIN_CONFIDENCE_THRESHOLD || value.confidenceThreshold > MAX_CONFIDENCE_THRESHOLD) return null;
  return { enabled: value.enabled, confidenceThreshold: Number(value.confidenceThreshold.toFixed(3)) };
}

function validateSettingsScope(value: unknown): OperatorAgentSettingsScope | null {
  if (!isRecord(value) || value.kind !== "repository" || !boundedString(value.repository, MAX_REPO)) return null;
  return { kind: "repository", repository: value.repository.trim() };
}

function validateEvidence(value: unknown): OperatorAgentEvidence[] | null {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) return null;
  const evidence: OperatorAgentEvidence[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (!boundedString(item.label, 120) || !boundedString(item.value, MAX_EVIDENCE_VALUE) || !boundedString(item.source, 200)) return null;
    if (!iso(item.observedAt) || !validFreshness(item.freshness)) return null;
    evidence.push({
      label: item.label.trim(),
      value: item.value.trim(),
      source: item.source.trim(),
      observedAt: new Date(item.observedAt).toISOString(),
      freshness: item.freshness,
    });
  }
  return evidence;
}

function validateProposal(value: unknown): OperatorAgentProposal | null {
  if (!isRecord(value)) return null;
  if (!boundedString(value.proposalId, MAX_ID) || !boundedString(value.repo, MAX_REPO)) return null;
  if (!boundedString(value.proposalText, MAX_TEXT) || !boundedString(value.reasoning, MAX_REASONING)) return null;
  if (!isCategory(value.category)) return null;
  if (value.status !== "pending" || !iso(value.createdAt)) return null;
  if (value.expiresAt !== undefined && !iso(value.expiresAt)) return null;
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return null;
  const evidence = validateEvidence(value.evidence);
  if (evidence === null) return null;
  return {
    proposalId: value.proposalId.trim(),
    repo: value.repo.trim(),
    proposalText: value.proposalText.trim(),
    confidence: value.confidence,
    reasoning: value.reasoning.trim(),
    category: value.category,
    status: "pending",
    createdAt: new Date(value.createdAt).toISOString(),
    ...(value.expiresAt ? { expiresAt: new Date(value.expiresAt).toISOString() } : {}),
    evidence,
  };
}

function validateRegistration(body: unknown): { error: string } | ProposalRegistrationInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  const proposal = validateProposal(body.proposal);
  if (!proposal) return { error: "proposal is malformed or exceeds the operator-agent bounds" };
  return { proposal };
}

function validateDecision(body: unknown): { error: string } | ProposalDecisionInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!boundedString(body.proposalId, MAX_ID)) return { error: "proposalId is required" };
  if (!isDecision(body.decision)) return { error: "decision must be accepted, rejected, or more-info" };
  if (body.note !== undefined && !boundedString(body.note, MAX_NOTE)) return { error: "note must be a non-empty string within the operator-agent bound" };
  return { proposalId: body.proposalId.trim(), decision: body.decision, ...(body.note ? { note: body.note.trim() } : {}) };
}

function validateOutcome(body: unknown): { error: string } | ProposalOutcomeInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!boundedString(body.proposalId, MAX_ID)) return { error: "proposalId is required" };
  if (!isRecord(body.outcome) || !boundedString(body.outcome.summary, MAX_TEXT) || !iso(body.outcome.observedAt)) {
    return { error: "outcome.summary and outcome.observedAt are required" };
  }
  if (body.outcome.helped !== undefined && typeof body.outcome.helped !== "boolean") return { error: "outcome.helped must be a boolean" };
  let evidence: string[] | undefined;
  if (body.outcome.evidence !== undefined) {
    if (!Array.isArray(body.outcome.evidence) || body.outcome.evidence.length > MAX_EVIDENCE || !body.outcome.evidence.every((item) => boundedString(item, MAX_EVIDENCE_VALUE))) {
      return { error: "outcome.evidence must be a bounded array of strings" };
    }
    evidence = body.outcome.evidence.map((item) => item.trim());
  }
  return {
    proposalId: body.proposalId.trim(),
    outcome: {
      summary: body.outcome.summary.trim(),
      ...(body.outcome.helped === undefined ? {} : { helped: body.outcome.helped }),
      observedAt: new Date(body.outcome.observedAt).toISOString(),
      ...(evidence ? { evidence } : {}),
    },
  };
}

function validateSettingsInput(body: unknown): { error: string } | OperatorAgentSettingsInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  const settings = validateSettings(body.settings);
  if (!settings) return { error: "settings.enabled and settings.confidenceThreshold must be valid" };
  if (body.scope !== undefined) {
    const scope = validateSettingsScope(body.scope);
    if (!scope) return { error: "scope must identify a repository" };
    return { settings, scope };
  }
  return { settings };
}

function validateExperimentRegistration(body: unknown): { error: string } | ExperimentRegistrationInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  const experiment = validateExperiment(body.experiment);
  if (!experiment) return { error: "experiment is malformed, incomplete, or exceeds the experiment-v1 bounds" };
  return { experiment };
}

function validateExperimentDecision(body: unknown): { error: string } | ExperimentDecisionInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!safeExperimentText(body.experimentId, MAX_EXPERIMENT_ID)) return { error: "experimentId is required" };
  if (body.decision !== "approved" && body.decision !== "rejected") return { error: "decision must be approved or rejected" };
  if (body.note !== undefined && !safeExperimentText(body.note, MAX_NOTE)) return { error: "note must be a bounded string" };
  return { experimentId: body.experimentId.trim(), decision: body.decision, ...(body.note ? { note: body.note.trim() } : {}) };
}

function validateExperimentOutcomeInput(body: unknown): { error: string } | ExperimentOutcomeInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!safeExperimentText(body.experimentId, MAX_EXPERIMENT_ID)) return { error: "experimentId is required" };
  const outcome = validateExperimentOutcome(body.outcome);
  if (!outcome) return { error: "outcome requires a bounded state, summary, and observedAt" };
  return { experimentId: body.experimentId.trim(), outcome };
}

function validateExperimentRollbackInput(body: unknown): { error: string } | ExperimentRollbackInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!safeExperimentText(body.experimentId, MAX_EXPERIMENT_ID)) return { error: "experimentId is required" };
  const rollback = validateExperimentRollback(body.rollback);
  if (!rollback) return { error: "rollback requires a bounded plan and reason" };
  return { experimentId: body.experimentId.trim(), rollback };
}

function isPromotionAdvanceTarget(value: unknown): value is PromotionAdvanceTarget {
  return PROMOTION_ADVANCE_TARGETS.includes(value as PromotionAdvanceTarget);
}

function validatePromotionRegistration(body: unknown): { error: string } | PromotionRegistrationInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  const promotion = validatePromotionRecord(body.promotion);
  if (!promotion) return { error: "promotion is malformed, incomplete, or exceeds the experiment-promotion-v1 bounds" };
  return { promotion };
}

function validatePromotionReplayInput(body: unknown): { error: string } | PromotionReplayInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!safeExperimentText(body.promotionId, MAX_EXPERIMENT_ID)) return { error: "promotionId is required" };
  const replay = validateReplaySummary(body.replay);
  if (!replay) return { error: "replay must be a bounded, well-formed replay summary" };
  return { promotionId: body.promotionId.trim(), replay };
}

function validatePromotionDecisionInput(body: unknown): { error: string } | PromotionDecisionInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!safeExperimentText(body.promotionId, MAX_EXPERIMENT_ID)) return { error: "promotionId is required" };
  if (body.decision !== "approved") return { error: "decision must be approved" };
  if (body.note !== undefined && !safeExperimentText(body.note, MAX_NOTE)) return { error: "note must be a bounded string" };
  return { promotionId: body.promotionId.trim(), decision: "approved", ...(body.note ? { note: body.note.trim() } : {}) };
}

function validatePromotionAdvanceAssistantTrustInput(value: unknown): PromotionAdvanceAssistantTrustInput | null {
  if (!isRecord(value)) return null;
  const controls = validateAssistantTrustControlResults(value.controls);
  const evidence = validateAssistantTrustEvidence(value.evidence);
  if (!controls || !evidence) return null;
  if (value.rawContext !== undefined) {
    const rawContext = validateRawAssistantTrustContext(value.rawContext);
    if (!rawContext) return null;
    return { controls, evidence, rawContext };
  }
  return { controls, evidence };
}

function validatePromotionAdvanceInput(body: unknown): { error: string } | PromotionAdvanceInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!safeExperimentText(body.promotionId, MAX_EXPERIMENT_ID)) return { error: "promotionId is required" };
  if (!isPromotionAdvanceTarget(body.target)) return { error: "target must be shadow, canary, observing, or promoted" };
  const observations = validateGuardObservations(body.observations);
  if (observations === null) return { error: "observations must be a bounded array of guard observations" };
  if (body.exposure !== undefined && (typeof body.exposure !== "number" || !Number.isFinite(body.exposure))) return { error: "exposure must be a finite number" };
  let assistantTrust: PromotionAdvanceAssistantTrustInput | undefined;
  if (body.assistantTrust !== undefined) {
    const parsed = validatePromotionAdvanceAssistantTrustInput(body.assistantTrust);
    if (!parsed) return { error: "assistantTrust requires bounded controls and evidence" };
    assistantTrust = parsed;
  }
  return {
    promotionId: body.promotionId.trim(),
    target: body.target,
    observations,
    ...(body.exposure !== undefined ? { exposure: body.exposure } : {}),
    ...(assistantTrust ? { assistantTrust } : {}),
  };
}

function validatePromotionRollbackInput(body: unknown): { error: string } | PromotionRollbackInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!safeExperimentText(body.promotionId, MAX_EXPERIMENT_ID)) return { error: "promotionId is required" };
  const rollback = validatePromotionRollback(body.rollback);
  if (!rollback) return { error: "rollback requires a bounded plan and reason" };
  return { promotionId: body.promotionId.trim(), rollback };
}

interface ConsequencePreflightInput {
  action: ConsequenceActionInput;
}

/** The body's `action` is handed to {@link classifyConsequenceAction} unvalidated beyond shape —
 *  that function is itself the authoritative validator and throws a human-readable `Error` the
 *  route below turns into a 400, exactly the split `createCapabilityGrant` already uses. */
function validateConsequencePreflightInput(body: unknown): { error: string } | ConsequencePreflightInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!isRecord(body.action)) return { error: "action is required" };
  return { action: body.action as unknown as ConsequenceActionInput };
}

function validateConsequenceDecisionInput(body: unknown): { error: string } | ConsequenceDecisionInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!boundedString(body.consequenceId, MAX_ID)) return { error: "consequenceId is required" };
  if (body.decision !== "approve" && body.decision !== "refuse") return { error: "decision must be approve or refuse" };
  if (body.reason !== undefined && !boundedString(body.reason, MAX_NOTE)) return { error: "reason must be a bounded string" };
  // The console shipped `note` before this core route existed. Accepting it as an alias keeps the
  // gateway backwards-compatible while the durable ledger uses one stable field (`reason`).
  if (body.note !== undefined && !boundedString(body.note, MAX_NOTE)) return { error: "note must be a bounded string" };
  if (body.reason !== undefined && body.note !== undefined) return { error: "provide reason or note, not both" };
  const reason = body.reason !== undefined ? body.reason : body.note;
  return {
    consequenceId: body.consequenceId.trim(),
    decision: body.decision,
    ...(reason !== undefined ? { reason: reason.trim() } : {}),
  };
}

function readExperimentRows(ledgerPath: string): Array<Record<string, unknown>> {
  return readLedgerUnionRecordsSync(dirname(ledgerPath), {
    step: [
      OPERATOR_AGENT_EXPERIMENT_STEP,
      OPERATOR_AGENT_EXPERIMENT_DECISION_STEP,
      OPERATOR_AGENT_EXPERIMENT_OUTCOME_STEP,
      OPERATOR_AGENT_EXPERIMENT_ROLLBACK_STEP,
    ],
  }).rows;
}

function readPromotionRows(ledgerPath: string): Array<Record<string, unknown>> {
  return readLedgerUnionRecordsSync(dirname(ledgerPath), {
    step: [
      OPERATOR_AGENT_PROMOTION_STEP,
      OPERATOR_AGENT_PROMOTION_REPLAY_STEP,
      OPERATOR_AGENT_PROMOTION_DECISION_STEP,
      OPERATOR_AGENT_PROMOTION_ADVANCE_STEP,
      OPERATOR_AGENT_PROMOTION_ROLLBACK_STEP,
    ],
  }).rows;
}

function settingsFromRow(row: Record<string, unknown>, requestedScope?: OperatorAgentSettingsScope): { settings: OperatorAgentSettings; scope?: OperatorAgentSettingsScope } | null {
  if (row.step !== OPERATOR_AGENT_SETTINGS_STEP) return null;
  const settings = validateSettings(row.settings);
  if (!settings) return null;
  const scope = row.scope === undefined ? undefined : validateSettingsScope(row.scope);
  if (scope === null) return null;
  if (requestedScope && (scope === undefined || scope.repository !== requestedScope.repository || scope.kind !== requestedScope.kind)) return null;
  if (requestedScope) return { settings, scope: requestedScope };
  return { settings, ...(scope ? { scope } : {}) };
}

export function readOperatorAgentSettings(deps: OperatorAgentRouteDependencies, requestedScope?: OperatorAgentSettingsScope): OperatorAgentSettingsRead {
  let result: { settings: OperatorAgentSettings; scope?: OperatorAgentSettingsScope } | undefined;
  for (const row of readSettingsRows(deps)) {
    const candidate = settingsFromRow(row, requestedScope);
    if (candidate) result = candidate;
  }
  return result
    ? { settings: result.settings, source: "ledger", ...(result.scope ? { scope: result.scope } : {}) }
    : { settings: { ...OPERATOR_AGENT_DEFAULT_SETTINGS }, source: "default", ...(requestedScope ? { scope: requestedScope } : {}) };
}

function requestedSettingsScope(req: { url?: string }): { scope?: OperatorAgentSettingsScope; error?: string } {
  const url = new URL(req.url ?? "/", "http://rmd.local");
  const repository = url.searchParams.get("repository");
  if (repository === null) return {};
  const scope = validateSettingsScope({ kind: "repository", repository });
  return scope ? { scope } : { error: "repository must identify a repository" };
}

function proposalFromRow(row: Record<string, unknown>): OperatorAgentProposal | null {
  return row.step === OPERATOR_AGENT_PROPOSAL_STEP ? validateProposal(row.proposal) : null;
}

function decisionFromRow(row: Record<string, unknown>): OperatorAgentDecisionEvent | null {
  if (row.step !== OPERATOR_AGENT_DECISION_STEP || !boundedString(row.proposal_id, MAX_ID)) return null;
  if (!isDecision(row.decision) || !iso(row.at)) return null;
  if (row.note !== undefined && !boundedString(row.note, MAX_NOTE)) return null;
  return { decision: row.decision, at: new Date(row.at).toISOString(), ...(row.note ? { note: row.note } : {}) };
}

function outcomeFromRow(row: Record<string, unknown>): { proposalId: string; outcome: OperatorAgentOutcome } | null {
  if (row.step !== OPERATOR_AGENT_OUTCOME_STEP || !boundedString(row.proposal_id, MAX_ID) || !isRecord(row.outcome)) return null;
  const parsed = validateOutcome({ proposalId: row.proposal_id, outcome: row.outcome });
  return "error" in parsed ? null : { proposalId: parsed.proposalId, outcome: parsed.outcome };
}

/**
 * Select and redact one operator-agent event for the serve-owned memory snapshot. The ledger is
 * still the source of truth; this is only the bounded read model. In particular, actor/bearer
 * fields, prompts, and arbitrary ledger payload are never retained here.
 */
export function selectOperatorAgentMemoryRow(row: Record<string, unknown>): OperatorAgentMemoryLedgerRow | undefined {
  const proposal = proposalFromRow(row);
  if (proposal) return { step: OPERATOR_AGENT_PROPOSAL_STEP, proposal };

  const decision = decisionFromRow(row);
  if (decision) {
    return {
      step: OPERATOR_AGENT_DECISION_STEP,
      proposal_id: String(row.proposal_id),
      decision: decision.decision,
      at: decision.at,
      ...(decision.note ? { note: decision.note } : {}),
    };
  }

  const outcome = outcomeFromRow(row);
  if (outcome) {
    return { step: OPERATOR_AGENT_OUTCOME_STEP, proposal_id: outcome.proposalId, outcome: outcome.outcome };
  }

  const settings = settingsFromRow(row);
  if (settings) {
    const updatedAt = iso(row.updatedAt) ? String(row.updatedAt) : undefined;
    return {
      step: OPERATOR_AGENT_SETTINGS_STEP,
      settings: settings.settings,
      ...(settings.scope ? { scope: settings.scope } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }
  return undefined;
}

/**
 * Overlay write receipts on the shared analytics snapshot. This makes a successful write visible
 * immediately while the next background analytics refresh catches the durable row; duplicate
 * receipts are collapsed by their redacted JSON representation.
 */
export function createOperatorAgentMemorySource(
  base: () => OperatorAgentMemorySnapshot,
): OperatorAgentMemorySource {
  const overlay: OperatorAgentMemoryLedgerRow[] = [];
  const maxOverlayRows = 256;
  return {
    current: () => {
      const snapshot = base();
      if (snapshot.state !== "ready" || overlay.length === 0) return snapshot;
      const seen = new Set(snapshot.rows.map((row) => JSON.stringify(row)));
      const additions = overlay.filter((row) => !seen.has(JSON.stringify(row)));
      return additions.length === 0 ? snapshot : { ...snapshot, rows: [...snapshot.rows, ...additions] };
    },
    record: (row) => {
      const selected = selectOperatorAgentMemoryRow(row);
      if (!selected) return;
      overlay.push(selected);
      if (overlay.length > maxOverlayRows) overlay.splice(0, overlay.length - maxOverlayRows);
    },
  };
}

function readRows(deps: OperatorAgentRouteDependencies): ReadonlyArray<Record<string, unknown>> {
  const memory = deps.memory?.current();
  if (memory?.state === "ready") return memory.rows as ReadonlyArray<Record<string, unknown>>;
  return readLedgerUnionRecordsSync(dirname(deps.ledgerPath), {
    step: [OPERATOR_AGENT_PROPOSAL_STEP, OPERATOR_AGENT_DECISION_STEP, OPERATOR_AGENT_OUTCOME_STEP],
  }).rows;
}

function readSettingsRows(deps: OperatorAgentRouteDependencies): ReadonlyArray<Record<string, unknown>> {
  const memory = deps.memory?.current();
  if (memory?.state === "ready") return memory.rows as ReadonlyArray<Record<string, unknown>>;
  return readLedgerUnionRecordsSync(dirname(deps.ledgerPath), { step: OPERATOR_AGENT_SETTINGS_STEP }).rows;
}

/**
 * A serve-owned memory source is intentionally fail-closed before its first background refresh.
 * Returning an observed empty list here would let the console treat cold state as "no history";
 * falling back to a synchronous union scan would recreate the request-path starvation this cache
 * exists to prevent. Direct route callers without a memory source retain the historical reader.
 */
function rejectColdOperatorAgentMemory(deps: OperatorAgentRouteDependencies, res: ServerResponse): boolean {
  const memory = deps.memory?.current();
  if (!memory || memory.state === "ready") return false;
  sendJson(res, 503, {
    error: "unavailable",
    source: "operator-agent-memory",
    detail: "the first background ledger refresh has not completed; no verified operator-agent history is available",
  });
  return true;
}

export function readOperatorAgentHistory(deps: OperatorAgentRouteDependencies): OperatorAgentHistory[] {
  const proposals = new Map<string, OperatorAgentProposal>();
  const decisions = new Map<string, OperatorAgentDecisionEvent[]>();
  const outcomes = new Map<string, OperatorAgentOutcome>();
  for (const row of readRows(deps)) {
    const proposal = proposalFromRow(row);
    if (proposal && !proposals.has(proposal.proposalId)) proposals.set(proposal.proposalId, proposal);
    const decision = decisionFromRow(row);
    if (decision) {
      const id = String(row.proposal_id);
      decisions.set(id, [...(decisions.get(id) ?? []), decision]);
    }
    const outcome = outcomeFromRow(row);
    if (outcome) outcomes.set(outcome.proposalId, outcome.outcome);
  }

  const now = deps.now?.() ?? Date.now();
  return [...proposals.values()]
    .map((proposal): OperatorAgentHistory => {
      const history = decisions.get(proposal.proposalId) ?? [];
      const terminal = [...history].reverse().find((entry) => entry.decision === "accepted" || entry.decision === "rejected");
      const expired = proposal.expiresAt !== undefined && Date.parse(proposal.expiresAt) <= now && terminal === undefined;
      return {
        ...proposal,
        status: terminal?.decision === "accepted" ? "accepted" : terminal?.decision === "rejected" ? "rejected" : expired ? "expired" : "pending",
        ...(outcomes.has(proposal.proposalId) ? { outcome: outcomes.get(proposal.proposalId) } : {}),
        decisionHistory: history,
      };
    })
    .sort((left, right) => right.confidence - left.confidence || left.proposalId.localeCompare(right.proposalId));
}

function findProposal(deps: OperatorAgentRouteDependencies, proposalId: string): OperatorAgentHistory | undefined {
  return readOperatorAgentHistory(deps).find((proposal) => proposal.proposalId === proposalId);
}

function experimentFromRow(row: Record<string, unknown>): OperatorAgentExperiment | null {
  return row.step === OPERATOR_AGENT_EXPERIMENT_STEP ? validateExperiment(row.experiment) : null;
}

function experimentDecisionFromRow(row: Record<string, unknown>): { experimentId: string; event: OperatorAgentExperimentEvent } | null {
  if (row.step !== OPERATOR_AGENT_EXPERIMENT_DECISION_STEP || !safeExperimentText(row.experiment_id, MAX_EXPERIMENT_ID)) return null;
  if ((row.decision !== "approved" && row.decision !== "rejected") || !iso(row.at)) return null;
  if (row.note !== undefined && !safeExperimentText(row.note, MAX_NOTE)) return null;
  return {
    experimentId: row.experiment_id.trim(),
    event: {
      kind: "decision",
      at: new Date(row.at).toISOString(),
      decision: row.decision,
      ...(row.note ? { note: row.note.trim() } : {}),
    },
  };
}

function experimentOutcomeFromRow(row: Record<string, unknown>): { experimentId: string; event: OperatorAgentExperimentEvent } | null {
  if (row.step !== OPERATOR_AGENT_EXPERIMENT_OUTCOME_STEP || !safeExperimentText(row.experiment_id, MAX_EXPERIMENT_ID)) return null;
  const outcome = validateExperimentOutcome(row.outcome);
  if (!outcome || !iso(row.at)) return null;
  return { experimentId: row.experiment_id.trim(), event: { kind: "outcome", at: new Date(row.at).toISOString(), outcome } };
}

function experimentRollbackFromRow(row: Record<string, unknown>): { experimentId: string; event: OperatorAgentExperimentEvent } | null {
  if (row.step !== OPERATOR_AGENT_EXPERIMENT_ROLLBACK_STEP || !safeExperimentText(row.experiment_id, MAX_EXPERIMENT_ID) || !iso(row.at)) return null;
  const rollback = validateExperimentRollback(row.rollback);
  if (!rollback) return null;
  return { experimentId: row.experiment_id.trim(), event: { kind: "rollback", at: new Date(row.at).toISOString(), rollback } };
}

export function readOperatorAgentExperiments(deps: OperatorAgentRouteDependencies): OperatorAgentExperimentHistory[] {
  const experiments = new Map<string, OperatorAgentExperiment>();
  const events = new Map<string, OperatorAgentExperimentEvent[]>();
  for (const row of readExperimentRows(deps.ledgerPath)) {
    const experiment = experimentFromRow(row);
    if (experiment && !experiments.has(experiment.experimentId)) experiments.set(experiment.experimentId, experiment);
    const parsed = experimentDecisionFromRow(row) ?? experimentOutcomeFromRow(row) ?? experimentRollbackFromRow(row);
    if (parsed && experiments.has(parsed.experimentId)) {
      const next = [...(events.get(parsed.experimentId) ?? []), parsed.event];
      if (next.length <= MAX_EXPERIMENT_EVENTS) events.set(parsed.experimentId, next);
    }
  }

  return [...experiments.values()]
    .map((experiment): OperatorAgentExperimentHistory => {
      const history = events.get(experiment.experimentId) ?? [];
      const lastDecision = [...history].reverse().find((event) => event.kind === "decision");
      const outcomeEvent = [...history].reverse().find((event) => event.kind === "outcome" && event.outcome);
      const rollbackEvent = [...history].reverse().find((event) => event.kind === "rollback");
      let state: OperatorAgentExperimentState = experiment.state;
      if (lastDecision?.decision === "approved") state = "approved";
      if (lastDecision?.decision === "rejected") state = "rejected";
      if (outcomeEvent?.outcome) state = outcomeEvent.outcome.state;
      if (rollbackEvent) state = "rolled_back";
      return {
        ...experiment,
        state,
        events: history,
        ...(outcomeEvent?.outcome ? { outcome: outcomeEvent.outcome } : {}),
      };
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.experimentId.localeCompare(right.experimentId));
}

function findExperiment(deps: OperatorAgentRouteDependencies, experimentId: string): OperatorAgentExperimentHistory | undefined {
  return readOperatorAgentExperiments(deps).find((experiment) => experiment.experimentId === experimentId);
}

function promotionFromRow(row: Record<string, unknown>): PromotionRecord | null {
  return row.step === OPERATOR_AGENT_PROMOTION_STEP ? validatePromotionRecord(row.promotion) : null;
}

function promotionEventFromRow(row: Record<string, unknown>): { promotionId: string; event: OperatorAgentPromotionEvent } | null {
  if (!safeExperimentText(row.promotion_id, MAX_EXPERIMENT_ID) || !iso(row.at) || typeof row.state !== "string") return null;
  const promotionId = row.promotion_id.trim();
  const at = new Date(row.at).toISOString();
  const state = row.state as ExperimentPromotionState;
  if (row.step === OPERATOR_AGENT_PROMOTION_REPLAY_STEP) {
    const replay = validateReplaySummary(row.replay);
    return replay ? { promotionId, event: { kind: "replay", at, state, replay } } : null;
  }
  if (row.step === OPERATOR_AGENT_PROMOTION_DECISION_STEP) {
    if (row.decision !== "approved") return null;
    return { promotionId, event: { kind: "decision", at, state, decision: "approved" } };
  }
  if (row.step === OPERATOR_AGENT_PROMOTION_ADVANCE_STEP) {
    if (!isPromotionAdvanceTarget(row.target) || !isRecord(row.guard)) return null;
    const guard = row.guard as unknown as GuardEvaluation;
    // W1-T3882: assistant_trust is a durable receipt of an already-computed evaluation — folded
    // back loosely (like `guard` above), never re-run at read time.
    const assistantTrust = isRecord(row.assistant_trust) ? (row.assistant_trust as unknown as AssistantTrustEvaluationResult) : undefined;
    return {
      promotionId,
      event: {
        kind: "advance",
        at,
        state,
        advance: {
          target: row.target,
          guard,
          ...(typeof row.exposure === "number" ? { exposure: row.exposure } : {}),
          ...(assistantTrust ? { assistantTrust } : {}),
        },
      },
    };
  }
  if (row.step === OPERATOR_AGENT_PROMOTION_ROLLBACK_STEP) {
    const rollback = validatePromotionRollback(row.rollback);
    return rollback ? { promotionId, event: { kind: "rollback", at, state, rollback } } : null;
  }
  return null;
}

/**
 * Reads the durable experiment-promotion-v1 history from the ledger union. Each event was written
 * with its resulting state already computed by the route handler (see {@link
 * buildOperatorAgentPromotionAdvanceRoute}), so the current state is simply the last event's
 * state, adjusted for expiry — never re-derived by replaying the guard/exposure logic at read time.
 */
export function readOperatorAgentPromotions(deps: OperatorAgentRouteDependencies): OperatorAgentPromotionHistory[] {
  const promotions = new Map<string, PromotionRecord>();
  const events = new Map<string, OperatorAgentPromotionEvent[]>();
  for (const row of readPromotionRows(deps.ledgerPath)) {
    const promotion = promotionFromRow(row);
    if (promotion && !promotions.has(promotion.promotionId)) promotions.set(promotion.promotionId, promotion);
    const parsed = promotionEventFromRow(row);
    if (parsed && promotions.has(parsed.promotionId)) {
      const next = [...(events.get(parsed.promotionId) ?? []), parsed.event];
      if (next.length <= MAX_PROMOTION_EVENTS) events.set(parsed.promotionId, next);
    }
  }

  const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString();
  return [...promotions.values()]
    .map((promotion): OperatorAgentPromotionHistory => {
      const history = events.get(promotion.promotionId) ?? [];
      const last = history[history.length - 1];
      const state = expirePromotionIfDue(last?.state ?? "proposed", promotion.expiresAt, nowIso);
      return { ...promotion, state, events: history };
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.promotionId.localeCompare(right.promotionId));
}

function findPromotion(deps: OperatorAgentRouteDependencies, promotionId: string): OperatorAgentPromotionHistory | undefined {
  return readOperatorAgentPromotions(deps).find((promotion) => promotion.promotionId === promotionId);
}

/** GET /v1/operator-agent/context — metadata-only inventory. Raw personal content never crosses
 * this route; planning and action callers use {@link readGovernedContext} instead. */
export function buildContextReadRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "GET",
    path: "/v1/operator-agent/context",
    scope: "read",
    sensitivity: "sensitive",
    handler: (req, res) => {
      const url = new URL(req.url ?? "/", "http://rmd.local");
      const purpose = url.searchParams.get("purpose");
      const authorityRef = url.searchParams.get("authorityRef");
      const now = deps.now?.() ?? Date.now();
      const items = readContextInventory(deps).filter((item) =>
        (purpose === null || item.purpose === purpose) && (authorityRef === null || item.authorityRef === authorityRef),
      );
      const stale = items.filter((item) => item.availability === "stale").map((item) => item.contextId);
      sendJson(res, 200, { items, stale, absent: items.length === 0, source: "ledger", asOf: new Date(now).toISOString() });
    },
  };
}

/** POST /v1/operator-agent/context — register one bounded memory envelope. */
export function buildContextRegisterRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/context",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateContextRegistration, (input, req, res) => {
      const state = readContextLedgerState(deps.ledgerPath);
      const existing = state.items.get(input.context.contextId);
      if (existing) {
        if (state.deletions.has(input.context.contextId) || state.revocations.has(input.context.contextId)) {
          sendJson(res, 409, { error: "conflict", detail: `context ${input.context.contextId} is no longer active and cannot be recreated` });
          return;
        }
        if (JSON.stringify(existing) !== JSON.stringify(input.context)) {
          sendJson(res, 409, { error: "conflict", detail: `contextId ${input.context.contextId} already names different context` });
          return;
        }
        sendJson(res, 200, { ok: true, existing: true, context: publicContext(existing, state, deps.now?.() ?? Date.now()) });
        return;
      }
      appendPanelLedger(deps.ledgerPath, CONTEXT_ITEM_STEP, input.context.contextId, bearerTokenId(req), { context: input.context });
      state.items.set(input.context.contextId, input.context);
      sendJson(res, 201, { ok: true, existing: false, context: publicContext(input.context, state, deps.now?.() ?? Date.now()) });
    }),
  };
}

/** W1-T3893: exported for the same reason as {@link readContextLedgerState} — the one place a
 *  receipt's id and affected-derivation count are computed. */
export function makeContextReceipt(contextId: string, operation: ContextOperation, authorityRef: string, state: ContextLedgerState, at: string): ContextDeletionReceipt {
  const affectedDerivations = [...state.items.values()].filter((item) => item.derivationLinks.includes(contextId)).length;
  return {
    receiptId: contextReceiptId(contextId, operation, at, affectedDerivations),
    contextId,
    operation,
    at,
    authorityRef,
    affectedDerivations,
  };
}

export type ContextActionResult =
  | { status: 200; body: { ok: true; existing: boolean; receipt: ContextDeletionReceipt } }
  | { status: 403 | 404 | 409; body: { error: string; detail: string } };

/** The revoke engine, exported (W1-T3893) so `context-controls.ts`'s self-service revoke route
 *  goes through EXACTLY this receipt/idempotency/authority logic instead of a second copy that
 *  could drift from it. `buildContextRevokeRoute` below is now a thin HTTP wrapper over this. */
export function performContextRevoke(
  deps: OperatorAgentRouteDependencies,
  input: { contextId: string; authorityRef: string; reason?: string },
  actorId: string,
): ContextActionResult {
  const state = readContextLedgerState(deps.ledgerPath);
  const item = state.items.get(input.contextId);
  if (!item) return { status: 404, body: { error: "not_found", detail: `no context item "${input.contextId}"` } };
  if (item.authorityRef !== input.authorityRef) return { status: 403, body: { error: "forbidden", detail: "authorityRef does not match the context item" } };
  if (state.deletions.has(input.contextId)) return { status: 409, body: { error: "conflict", detail: `context ${input.contextId} is deleted` } };
  const existing = state.revocations.get(input.contextId)?.receipt;
  if (existing) return { status: 200, body: { ok: true, existing: true, receipt: existing } };
  const at = new Date(deps.now?.() ?? Date.now()).toISOString();
  const receipt = makeContextReceipt(input.contextId, "revoke", input.authorityRef, state, at);
  appendPanelLedger(deps.ledgerPath, CONTEXT_REVOKED_STEP, input.contextId, actorId, {
    context_id: input.contextId,
    authority_ref: input.authorityRef,
    at,
    ...(input.reason ? { reason: input.reason } : {}),
    receipt,
  });
  return { status: 200, body: { ok: true, existing: false, receipt } };
}

/** The delete ("forget") engine, exported (W1-T3893) for the same reason as
 *  {@link performContextRevoke} — `context-controls.ts`'s self-service forget route delegates
 *  here rather than re-implementing deletion. `buildContextDeleteRoute` below is now a thin HTTP
 *  wrapper over this. */
export function performContextDelete(
  deps: OperatorAgentRouteDependencies,
  input: { contextId: string; authorityRef: string; reason?: string },
  actorId: string,
): ContextActionResult {
  const state = readContextLedgerState(deps.ledgerPath);
  const item = state.items.get(input.contextId);
  if (!item) return { status: 404, body: { error: "not_found", detail: `no context item "${input.contextId}"` } };
  if (item.authorityRef !== input.authorityRef) return { status: 403, body: { error: "forbidden", detail: "authorityRef does not match the context item" } };
  const existing = state.deletions.get(input.contextId);
  if (existing) return { status: 200, body: { ok: true, existing: true, receipt: existing } };
  const at = new Date(deps.now?.() ?? Date.now()).toISOString();
  const receipt = makeContextReceipt(input.contextId, "delete", input.authorityRef, state, at);
  appendPanelLedger(deps.ledgerPath, CONTEXT_DELETED_STEP, input.contextId, actorId, {
    context_id: input.contextId,
    authority_ref: input.authorityRef,
    at,
    receipt,
  });
  return { status: 200, body: { ok: true, existing: false, receipt } };
}

/** POST /v1/operator-agent/context/revoke — append a durable, idempotent revocation receipt. */
export function buildContextRevokeRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/context/revoke",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateContextAction, (input, req, res) => {
      const result = performContextRevoke(deps, input, bearerTokenId(req));
      sendJson(res, result.status, result.body);
    }),
  };
}

/** POST /v1/operator-agent/context/delete — append a durable deletion receipt. */
export function buildContextDeleteRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/context/delete",
    scope: "write",
    tier: "middle",
    handler: jsonAction(validateContextAction, (input, req, res) => {
      const result = performContextDelete(deps, input, bearerTokenId(req));
      sendJson(res, result.status, result.body);
    }),
  };
}

/** GET /v1/operator-agent/proposals — durable proposal and operator-decision history. */
export function buildOperatorAgentProposalReadRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "GET",
    path: "/v1/operator-agent/proposals",
    scope: "read",
    handler: (_req, res) => {
      if (rejectColdOperatorAgentMemory(deps, res)) return;
      sendJson(res, 200, { proposals: readOperatorAgentHistory(deps), source: "ledger" });
    },
  };
}

/** POST /v1/operator-agent/proposals — register an evidence-backed proposal idempotently. */
export function buildOperatorAgentProposalRegisterRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/proposals",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateRegistration, (input, req, res) => {
      if (rejectColdOperatorAgentMemory(deps, res)) return;
      const existing = findProposal(deps, input.proposal.proposalId);
      if (existing) {
        if (JSON.stringify(existing.proposalText) !== JSON.stringify(input.proposal.proposalText) || existing.repo !== input.proposal.repo) {
          sendJson(res, 409, { error: "conflict", detail: `proposalId ${input.proposal.proposalId} already names a different proposal` });
          return;
        }
        sendJson(res, 200, { ok: true, existing: true, proposal: existing });
        return;
      }
      // W1-T3900: a new proposal IS the "new action admission" surface this task's design
      // names — refused BY NAME before any ledger write when an active emergency stop covers
      // this proposal's repo.
      const admission = checkEmergencyStop(activeEmergencyStops(deps), { actionKind: "action-admission", repo: input.proposal.repo }, deps.now?.() ?? Date.now());
      if (!admission.ok) {
        appendPanelLedger(deps.ledgerPath, EMERGENCY_STOP_REFUSAL_STEP, input.proposal.proposalId, bearerTokenId(req), { receipt: admission.receipt });
        sendJson(res, 423, { ok: false, error: "emergency_stop_active", code: admission.code, receipt: admission.receipt });
        return;
      }
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_PROPOSAL_STEP, input.proposal.proposalId, bearerTokenId(req), { proposal: input.proposal });
      deps.memory?.record({ step: OPERATOR_AGENT_PROPOSAL_STEP, proposal: input.proposal });
      sendJson(res, 201, { ok: true, existing: false, proposal: input.proposal });
    }),
  };
}

/** POST /v1/operator-agent/proposals/decision — record accept/reject/more-info in the ledger. */
export function buildOperatorAgentDecisionRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/proposals/decision",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateDecision, (input, req, res) => {
      if (rejectColdOperatorAgentMemory(deps, res)) return;
      const existing = findProposal(deps, input.proposalId);
      if (!existing) {
        sendJson(res, 404, { error: "not_found", detail: `no operator-agent proposal "${input.proposalId}"` });
        return;
      }
      if (existing.status === "expired" || existing.status === "accepted" || existing.status === "rejected") {
        sendJson(res, 409, { error: "conflict", detail: `proposal ${input.proposalId} is already ${existing.status}` });
        return;
      }
      const at = new Date(deps.now?.() ?? Date.now()).toISOString();
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_DECISION_STEP, input.proposalId, bearerTokenId(req), {
        proposal_id: input.proposalId,
        decision: input.decision,
        at,
        ...(input.note ? { note: input.note } : {}),
      });
      deps.memory?.record({
        step: OPERATOR_AGENT_DECISION_STEP,
        proposal_id: input.proposalId,
        decision: input.decision,
        at,
        ...(input.note ? { note: input.note } : {}),
      });
      sendJson(res, 200, { ok: true, proposalId: input.proposalId, decision: input.decision, at });
    }),
  };
}

/** POST /v1/operator-agent/proposals/outcome — attach a later observed outcome, never at accept time. */
export function buildOperatorAgentOutcomeRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/proposals/outcome",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateOutcome, (input, req, res) => {
      if (rejectColdOperatorAgentMemory(deps, res)) return;
      const existing = findProposal(deps, input.proposalId);
      if (!existing) {
        sendJson(res, 404, { error: "not_found", detail: `no operator-agent proposal "${input.proposalId}"` });
        return;
      }
      if (existing.status !== "accepted") {
        sendJson(res, 409, { error: "conflict", detail: `proposal ${input.proposalId} must be accepted before an outcome is recorded` });
        return;
      }
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_OUTCOME_STEP, input.proposalId, bearerTokenId(req), {
        proposal_id: input.proposalId,
        outcome: input.outcome,
      });
      deps.memory?.record({ step: OPERATOR_AGENT_OUTCOME_STEP, proposal_id: input.proposalId, outcome: input.outcome });
      sendJson(res, 200, { ok: true, proposalId: input.proposalId, outcome: input.outcome });
    }),
  };
}

/** GET /v1/operator-agent/experiments — durable experiment-v1 history and measured outcomes. */
export function buildOperatorAgentExperimentReadRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "GET",
    path: "/v1/operator-agent/experiments",
    scope: "read",
    handler: (_req, res) => sendJson(res, 200, { experiments: readOperatorAgentExperiments(deps), source: "ledger" }),
  };
}

/** POST /v1/operator-agent/experiments — register a falsifiable, bounded experiment before approval. */
export function buildOperatorAgentExperimentRegisterRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/experiments",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateExperimentRegistration, (input, req, res) => {
      const existing = findExperiment(deps, input.experiment.experimentId);
      if (existing) {
        const existingDefinition: OperatorAgentExperiment = {
          version: existing.version,
          experimentId: existing.experimentId,
          ...(existing.proposalId ? { proposalId: existing.proposalId } : {}),
          hypothesis: existing.hypothesis,
          intervention: existing.intervention,
          scope: existing.scope,
          baseline: existing.baseline,
          rollback: existing.rollback,
          createdAt: existing.createdAt,
          state: "proposed",
        };
        if (JSON.stringify(existingDefinition) !== JSON.stringify(input.experiment)) {
          sendJson(res, 409, { error: "conflict", detail: `experimentId ${input.experiment.experimentId} already names a different experiment` });
          return;
        }
        sendJson(res, 200, { ok: true, existing: true, experiment: existing });
        return;
      }
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_EXPERIMENT_STEP, input.experiment.experimentId, bearerTokenId(req), { experiment: input.experiment });
      sendJson(res, 201, { ok: true, existing: false, experiment: input.experiment });
    }),
  };
}

/** POST /v1/operator-agent/experiments/decision — approve or reject without manufacturing an outcome. */
export function buildOperatorAgentExperimentDecisionRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/experiments/decision",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateExperimentDecision, (input, req, res) => {
      const existing = findExperiment(deps, input.experimentId);
      if (!existing) {
        sendJson(res, 404, { error: "not_found", detail: `no operator-agent experiment "${input.experimentId}"` });
        return;
      }
      if (existing.state !== "proposed") {
        sendJson(res, 409, { error: "conflict", detail: `experiment ${input.experimentId} is already ${existing.state}` });
        return;
      }
      const at = new Date(deps.now?.() ?? Date.now()).toISOString();
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_EXPERIMENT_DECISION_STEP, input.experimentId, bearerTokenId(req), {
        experiment_id: input.experimentId,
        decision: input.decision,
        at,
        ...(input.note ? { note: input.note } : {}),
      });
      sendJson(res, 200, { ok: true, experimentId: input.experimentId, decision: input.decision, at });
    }),
  };
}

/** POST /v1/operator-agent/experiments/outcome — append an observation, normalising weak evidence to unmeasurable. */
export function buildOperatorAgentExperimentOutcomeRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/experiments/outcome",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateExperimentOutcomeInput, (input, req, res) => {
      const existing = findExperiment(deps, input.experimentId);
      if (!existing) {
        sendJson(res, 404, { error: "not_found", detail: `no operator-agent experiment "${input.experimentId}"` });
        return;
      }
      if (existing.state !== "approved" && existing.state !== "observing") {
        sendJson(res, 409, { error: "conflict", detail: `experiment ${input.experimentId} must be approved or observing before an outcome is recorded` });
        return;
      }
      const outcome = normaliseExperimentOutcome(input.outcome, existing.baseline);
      const at = new Date(deps.now?.() ?? Date.now()).toISOString();
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_EXPERIMENT_OUTCOME_STEP, input.experimentId, bearerTokenId(req), {
        experiment_id: input.experimentId,
        outcome,
        at,
      });
      sendJson(res, 200, { ok: true, experimentId: input.experimentId, outcome, at });
    }),
  };
}

/** POST /v1/operator-agent/experiments/rollback — append a rollback receipt while preserving prior events. */
export function buildOperatorAgentExperimentRollbackRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/experiments/rollback",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateExperimentRollbackInput, (input, req, res) => {
      const existing = findExperiment(deps, input.experimentId);
      if (!existing) {
        sendJson(res, 404, { error: "not_found", detail: `no operator-agent experiment "${input.experimentId}"` });
        return;
      }
      if (existing.state !== "approved" && existing.state !== "observing" && existing.state !== "regressed") {
        sendJson(res, 409, { error: "conflict", detail: `experiment ${input.experimentId} cannot be rolled back from ${existing.state}` });
        return;
      }
      const at = new Date(deps.now?.() ?? Date.now()).toISOString();
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_EXPERIMENT_ROLLBACK_STEP, input.experimentId, bearerTokenId(req), {
        experiment_id: input.experimentId,
        rollback: input.rollback,
        at,
      });
      sendJson(res, 200, { ok: true, experimentId: input.experimentId, state: "rolled_back", rollback: input.rollback, at });
    }),
  };
}

/** GET /v1/operator-agent/promotions — durable experiment-promotion-v1 replay/shadow/canary history. */
export function buildOperatorAgentPromotionReadRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "GET",
    path: "/v1/operator-agent/promotions",
    scope: "read",
    handler: (_req, res) => sendJson(res, 200, { promotions: readOperatorAgentPromotions(deps), source: "ledger" }),
  };
}

/** POST /v1/operator-agent/promotions — register a bounded promotion; canary exposure is serialized per policy scope. */
export function buildOperatorAgentPromotionRegisterRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/promotions",
    scope: "write",
    tier: "low",
    handler: jsonAction(validatePromotionRegistration, (input, req, res) => {
      const existing = findPromotion(deps, input.promotion.promotionId);
      if (existing) {
        const existingDefinition: PromotionRecord = {
          version: existing.version,
          promotionId: existing.promotionId,
          ...(existing.experimentId ? { experimentId: existing.experimentId } : {}),
          candidate: existing.candidate,
          baseline: existing.baseline,
          scope: existing.scope,
          comparisonPopulation: existing.comparisonPopulation,
          denominatorFloor: existing.denominatorFloor,
          observationWindow: existing.observationWindow,
          guardMetrics: existing.guardMetrics,
          maxExposure: existing.maxExposure,
          owner: existing.owner,
          expiresAt: existing.expiresAt,
          rollback: existing.rollback,
          createdAt: existing.createdAt,
          state: "proposed",
        };
        if (JSON.stringify(existingDefinition) !== JSON.stringify(input.promotion)) {
          sendJson(res, 409, { error: "conflict", detail: `promotionId ${input.promotion.promotionId} already names a different promotion` });
          return;
        }
        sendJson(res, 200, { ok: true, existing: true, promotion: existing });
        return;
      }
      const active = readOperatorAgentPromotions(deps).filter((promotion) => isPromotionActive(promotion.state));
      const conflict = findScopeConflict(active, input.promotion.scope, input.promotion.promotionId);
      if (conflict) {
        sendJson(res, 409, {
          error: "conflict",
          detail: `policy scope ${input.promotion.scope.repo}:${input.promotion.scope.policyScope} is already held by promotion ${conflict.promotionId}`,
        });
        return;
      }
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_PROMOTION_STEP, input.promotion.promotionId, bearerTokenId(req), { promotion: input.promotion });
      sendJson(res, 201, { ok: true, existing: false, promotion: input.promotion });
    }),
  };
}

/** POST /v1/operator-agent/promotions/replay — attach a deterministic, side-effect-free replay summary. */
export function buildOperatorAgentPromotionReplayRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/promotions/replay",
    scope: "write",
    tier: "low",
    handler: jsonAction(validatePromotionReplayInput, (input, req, res) => {
      const existing = findPromotion(deps, input.promotionId);
      if (!existing) {
        sendJson(res, 404, { error: "not_found", detail: `no operator-agent promotion "${input.promotionId}"` });
        return;
      }
      if (existing.state !== "proposed") {
        sendJson(res, 409, { error: "conflict", detail: `promotion ${input.promotionId} is already ${existing.state}` });
        return;
      }
      const at = new Date(deps.now?.() ?? Date.now()).toISOString();
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_PROMOTION_REPLAY_STEP, input.promotionId, bearerTokenId(req), {
        promotion_id: input.promotionId,
        replay: input.replay,
        state: "replayed",
        at,
      });
      sendJson(res, 200, { ok: true, promotionId: input.promotionId, state: "replayed", replay: input.replay, at });
    }),
  };
}

/** POST /v1/operator-agent/promotions/decision — approve a replayed candidate; approval never manufactures an outcome. */
export function buildOperatorAgentPromotionDecisionRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/promotions/decision",
    scope: "write",
    tier: "low",
    handler: jsonAction(validatePromotionDecisionInput, (input, req, res) => {
      const existing = findPromotion(deps, input.promotionId);
      if (!existing) {
        sendJson(res, 404, { error: "not_found", detail: `no operator-agent promotion "${input.promotionId}"` });
        return;
      }
      if (existing.state !== "replayed") {
        sendJson(res, 409, { error: "conflict", detail: `promotion ${input.promotionId} must be replayed before approval, is ${existing.state}` });
        return;
      }
      const at = new Date(deps.now?.() ?? Date.now()).toISOString();
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_PROMOTION_DECISION_STEP, input.promotionId, bearerTokenId(req), {
        promotion_id: input.promotionId,
        decision: "approved",
        state: "approved",
        at,
        ...(input.note ? { note: input.note } : {}),
      });
      sendJson(res, 200, { ok: true, promotionId: input.promotionId, state: "approved", at });
    }),
  };
}

/**
 * POST /v1/operator-agent/promotions/advance — the one guarded step of the flow. Advances
 * `approved -> shadow` on decision alone; every later step evaluates freshly submitted guard
 * observations and only a `ready` evaluation reaches the requested target. A breach becomes
 * `regressed`, insufficient evidence becomes `unmeasurable` — both are recorded, neither promotes.
 */
export function buildOperatorAgentPromotionAdvanceRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/promotions/advance",
    scope: "write",
    tier: "low",
    handler: jsonAction(validatePromotionAdvanceInput, (input, req, res) => {
      const existing = findPromotion(deps, input.promotionId);
      if (!existing) {
        sendJson(res, 404, { error: "not_found", detail: `no operator-agent promotion "${input.promotionId}"` });
        return;
      }
      const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString();
      const guard: GuardEvaluation =
        input.target === "shadow" ? { state: "ready", reasons: [], breachedMetrics: [] } : evaluateGuardrails(existing, input.observations ?? [], nowIso);

      // W1-T3882: assistant-trust evidence is optional on the wire so a caller that never submits
      // it advances exactly as the pre-W1-T3882 base-guardrail-only flow always did. When it IS
      // submitted, evaluateAssistantTrust runs above the base guardrail evaluation and can demote
      // a would-be-ready advance to `regressed`/`unmeasurable` — never the reverse.
      let assistantTrust: AssistantTrustEvaluationResult | undefined;
      let effectiveGuard = guard;
      if (input.target !== "shadow" && input.assistantTrust) {
        const replayEvent = existing.events.find((event) => event.kind === "replay");
        assistantTrust = evaluateAssistantTrust({
          guard,
          replay: replayEvent?.replay ?? { deterministic: false, sideEffectFree: true },
          controls: verifyAssistantTrustControls(input.assistantTrust.controls),
          evidence: input.assistantTrust.evidence,
          rawContext: input.assistantTrust.rawContext,
        });
        if (assistantTrust.state === "blocked") effectiveGuard = { state: "regressed", reasons: assistantTrust.reasons, breachedMetrics: [] };
        else if (assistantTrust.state === "unmeasurable") effectiveGuard = { state: "unmeasurable", reasons: assistantTrust.reasons, breachedMetrics: [] };
      }

      const result = advancePromotionState({ currentState: existing.state, target: input.target, guard: effectiveGuard, maxExposure: existing.maxExposure, exposure: input.exposure });
      if (result.state === existing.state) {
        sendJson(res, 409, {
          error: "conflict",
          detail: result.reason ?? `promotion ${input.promotionId} cannot advance to ${input.target} from ${existing.state}`,
          ...(assistantTrust ? { assistantTrust } : {}),
        });
        return;
      }
      // W1-T3900: advancing a promotion IS the "follow-up promotion" surface this task's design
      // names — refused BY NAME before any ledger write when an active emergency stop covers
      // this promotion's repo.
      const admission = checkEmergencyStop(activeEmergencyStops(deps), { actionKind: "follow-up-promotion", repo: existing.scope.repo }, deps.now?.() ?? Date.now());
      if (!admission.ok) {
        appendPanelLedger(deps.ledgerPath, EMERGENCY_STOP_REFUSAL_STEP, input.promotionId, bearerTokenId(req), { receipt: admission.receipt });
        sendJson(res, 423, { ok: false, error: "emergency_stop_active", code: admission.code, receipt: admission.receipt });
        return;
      }
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_PROMOTION_ADVANCE_STEP, input.promotionId, bearerTokenId(req), {
        promotion_id: input.promotionId,
        target: input.target,
        guard,
        state: result.state,
        at: nowIso,
        ...(input.exposure !== undefined ? { exposure: input.exposure } : {}),
        ...(assistantTrust ? { assistant_trust: assistantTrust } : {}),
      });
      sendJson(res, 200, {
        ok: true,
        promotionId: input.promotionId,
        state: result.state,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(assistantTrust ? { assistantTrust } : {}),
        at: nowIso,
      });
    }),
  };
}

/** POST /v1/operator-agent/promotions/rollback — append a rollback receipt while preserving prior events. */
export function buildOperatorAgentPromotionRollbackRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/promotions/rollback",
    scope: "write",
    tier: "low",
    handler: jsonAction(validatePromotionRollbackInput, (input, req, res) => {
      const existing = findPromotion(deps, input.promotionId);
      if (!existing) {
        sendJson(res, 404, { error: "not_found", detail: `no operator-agent promotion "${input.promotionId}"` });
        return;
      }
      const result = rollbackPromotion(existing.state);
      if (!result.ok) {
        sendJson(res, 409, { error: "conflict", detail: result.error });
        return;
      }
      const at = new Date(deps.now?.() ?? Date.now()).toISOString();
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_PROMOTION_ROLLBACK_STEP, input.promotionId, bearerTokenId(req), {
        promotion_id: input.promotionId,
        rollback: input.rollback,
        state: "rolled_back",
        at,
      });
      sendJson(res, 200, { ok: true, promotionId: input.promotionId, state: "rolled_back", rollback: input.rollback, at });
    }),
  };
}

/**
 * POST /v1/operator-agent/consequence/preflight — the action path's own gate: every operator-agent
 * action that would go on to use a capability grant (capability-grant.ts, W1-T3880) classifies and
 * evaluates its `consequence-policy-v1` HERE first. Refuses (409, never a manufactured `ready`) an
 * ambiguous or externally-sourced target, stale evidence, an expired quote/confirmation, an
 * exceeded financial ceiling, an active cooling-off window, or a shortfall of approvers — see
 * {@link evaluateConsequencePolicy}. This route never itself uses a capability grant and never
 * reports success before an action; it only records the preflight verdict.
 */
export function buildOperatorAgentConsequencePreflightRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/consequence/preflight",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateConsequencePreflightInput, (input, req, res) => {
      let action;
      try {
        action = classifyConsequenceAction(input.action);
      } catch (err) {
        sendJson(res, 400, { error: "invalid_action", detail: err instanceof Error ? err.message : String(err) });
        return;
      }
      const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString();
      const result = evaluateConsequencePolicy(action, { now: nowIso });
      const refusal = result.ok ? undefined : recordConsequenceRefusal(result, { now: nowIso });
      const approval = consequenceApprovalProjection(action);
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP, action.id, bearerTokenId(req), {
        action_id: action.id,
        consequence_class: action.consequenceClass,
        ready: result.ok,
        at: nowIso,
        ...(refusal ? { code: refusal.code, reason: refusal.reason } : {}),
        // W1-T4104: the bounded operator-facing projection GET /v1/operator-agent/consequences reads
        // back — this row is the ONLY durable record of a pending consequence approval in core.
        ...(approval ? { approval } : {}),
      });
      if (!result.ok) {
        sendJson(res, 409, { ok: false, actionId: action.id, code: result.code, reason: result.reason, at: nowIso });
        return;
      }
      sendJson(res, 200, { ok: true, actionId: action.id, consequenceClass: action.consequenceClass, at: nowIso });
    }),
  };
}

// ── W1-T4104: GET /v1/operator-agent/consequences — the list the console's Approvals page reads ──

export const OPERATOR_AGENT_CONSEQUENCES_PATH = "/v1/operator-agent/consequences";
/** The `source` every listed record carries — the exact string the console's fixtures pin. */
export const OPERATOR_AGENT_CONSEQUENCES_SOURCE = "rmd:core:/v1/operator-agent/consequences";
/** BACKSTOP: the most pending consequence approvals one read returns; `truncated` says when more exist. */
export const MAX_PENDING_CONSEQUENCES = 100;
/** A preflight refused for one of these is WAITING on an operator (an approver, or the cooling-off
 *  window an approver is asked to sit out) — every other refusal code is a dead action, not a queue. */
const PENDING_CONSEQUENCE_CODES: ReadonlySet<string> = new Set(["missing-approvers", "cooling-off-active"]);
/** The console's consequence-v1 classes: only these two ever ask an operator to approve. */
const APPROVAL_CONSEQUENCE_CLASSES: ReadonlySet<string> = new Set(["financial", "irreversible"]);
const MAX_CONSEQUENCE_TARGET = 320;
const MAX_CONSEQUENCE_RECOVERY = 1_000;
const DEFAULT_CONSEQUENCE_REFUSAL_REASON = "operator refused this consequence";
const FINANCIAL_ONLY_RECOVERY =
  "financial action: consequence-policy-v1 records no recovery path for a transfer; treat it as unrecoverable once executed";
const CONSEQUENCE_WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
const CONSEQUENCE_DECISION_PATH = `${OPERATOR_AGENT_CONSEQUENCES_PATH}/decision`;

/** What an operator must see to approve, persisted on the preflight ledger row. */
export interface ConsequenceApprovalProjection {
  target: string;
  amount?: number;
  currency?: string;
  ceiling?: number;
  coolingOffMs?: number;
  coolingOffUntil?: string;
  expiresAt: string;
  approverRequired: boolean;
  recoveryStatement: string;
  evidenceFreshUntil?: string;
}

/** consequence-v1 as the console's `normalizedConsequenceRecord` validates it. */
export interface PendingConsequenceRecord {
  consequenceId: string;
  classes: string[];
  target: string;
  amountUsd?: number;
  currency?: string;
  ceilingUsd?: number;
  coolingOffMs?: number;
  coolingOffUntil?: string;
  expiresAt: string;
  approverRequired: boolean;
  recoveryStatement: string;
  freshness: "verified" | "stale";
  observedAt: string;
  receipts: ConsequenceDecisionReceipt[];
  source: string;
}

export interface ConsequenceDecisionReceipt {
  kind: "approve" | "refuse";
  at: string;
  issuer?: string;
  note?: string;
}

interface StoredConsequenceDecision {
  consequenceId: string;
  decision: "approve" | "refuse";
  at: string;
  actor?: string;
  nonceId?: string;
  reason?: string;
}

function earliestIso(values: ReadonlyArray<string | undefined>): string | undefined {
  const present = values.filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  if (present.length === 0) return undefined;
  return present.reduce((earliest, value) => (Date.parse(value) < Date.parse(earliest) ? value : earliest));
}

/** The approval-facing projection of a classified action, or `undefined` when the action is not
 *  one an operator approves (reversible/disruptive) or cannot be shown without truncating its
 *  target — an identity is never shortened into a different-looking one. */
export function consequenceApprovalProjection(action: ConsequenceAction): ConsequenceApprovalProjection | undefined {
  if (!APPROVAL_CONSEQUENCE_CLASSES.has(action.consequenceClass)) return undefined;
  if (action.target.identity.length > MAX_CONSEQUENCE_TARGET) return undefined;
  const expiresAt = earliestIso([action.financial?.quoteExpiresAt, action.irreversible?.confirmationExpiresAt]);
  if (!expiresAt) return undefined;
  const recovery = action.irreversible?.recoveryStatement ?? FINANCIAL_ONLY_RECOVERY;
  const evidenceFreshUntil = earliestIso(action.evidence.map((item) => fixedClock(Date.parse(item.observedAt) + item.maxAgeSeconds * 1000).iso()));
  const financial = action.financial;
  return {
    target: action.target.identity,
    ...(financial
      ? {
          amount: financial.amount,
          currency: financial.currency,
          ceiling: financial.perActionCeiling,
          coolingOffMs: financial.coolingOffSeconds * 1000,
          coolingOffUntil: fixedClock(Date.parse(financial.coolingOffStartedAt) + financial.coolingOffSeconds * 1000).iso(),
        }
      : {}),
    expiresAt,
    approverRequired: action.requiredApprovers > 0,
    recoveryStatement: recovery.slice(0, MAX_CONSEQUENCE_RECOVERY),
    ...(evidenceFreshUntil ? { evidenceFreshUntil } : {}),
  };
}

function storedApprovalProjection(value: unknown): ConsequenceApprovalProjection | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.target !== "string" || !value.target || value.target.length > MAX_CONSEQUENCE_TARGET) return undefined;
  if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return undefined;
  if (typeof value.approverRequired !== "boolean" || typeof value.recoveryStatement !== "string" || !value.recoveryStatement) return undefined;
  return value as unknown as ConsequenceApprovalProjection;
}

function consequenceRows(deps: OperatorAgentRouteDependencies): Array<Record<string, unknown>> {
  return readLedgerUnionRecordsSync(dirname(deps.ledgerPath), {
    step: [OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP, OPERATOR_AGENT_CONSEQUENCE_DECISION_STEP],
  }).rows;
}

function latestConsequenceRows(deps: OperatorAgentRouteDependencies): {
  preflights: Map<string, Record<string, unknown>>;
  decisions: Map<string, StoredConsequenceDecision>;
} {
  const preflights = new Map<string, Record<string, unknown>>();
  const decisions = new Map<string, StoredConsequenceDecision>();
  for (const row of consequenceRows(deps)) {
    if (row.step === OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP) {
      if (typeof row.action_id === "string" && row.action_id) preflights.set(row.action_id, row);
      continue;
    }
    if (row.step !== OPERATOR_AGENT_CONSEQUENCE_DECISION_STEP) continue;
    if (typeof row.consequence_id !== "string" || !row.consequence_id) continue;
    if (row.decision !== "approve" && row.decision !== "refuse") continue;
    if (typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))) continue;
    const actor = typeof row.actor === "string" && row.actor ? row.actor : typeof row.origin === "string" && row.origin ? row.origin : undefined;
    const reason = typeof row.reason === "string" && row.reason ? row.reason : undefined;
    decisions.set(row.consequence_id, {
      consequenceId: row.consequence_id,
      decision: row.decision,
      at: fixedClock(Date.parse(row.at)).iso(),
      ...(actor ? { actor } : {}),
      ...(typeof row.nonce_id === "string" && row.nonce_id ? { nonceId: row.nonce_id } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  return { preflights, decisions };
}

function consequenceDecisionReceipt(decision: StoredConsequenceDecision): ConsequenceDecisionReceipt {
  return {
    kind: decision.decision,
    at: decision.at,
    ...(decision.actor ? { issuer: decision.actor } : {}),
    ...(decision.reason ? { note: decision.reason } : {}),
  };
}

function currentConsequence(
  deps: OperatorAgentRouteDependencies,
  consequenceId: string,
  nowMs: number,
):
  | { kind: "found"; row: Record<string, unknown>; projection: ConsequenceApprovalProjection; decision?: StoredConsequenceDecision }
  | { kind: "expired"; expiresAt: string }
  | { kind: "not_found" }
  | { kind: "not_pending" } {
  const { preflights, decisions } = latestConsequenceRows(deps);
  const row = preflights.get(consequenceId);
  if (!row || row.ready !== false || typeof row.code !== "string" || !PENDING_CONSEQUENCE_CODES.has(row.code)) {
    return { kind: row ? "not_pending" : "not_found" };
  }
  const projection = storedApprovalProjection(row.approval);
  if (!projection || typeof row.at !== "string") return { kind: "not_found" };
  if (Date.parse(projection.expiresAt) <= nowMs) return { kind: "expired", expiresAt: projection.expiresAt };
  const decision = decisions.get(consequenceId);
  if (decision && Date.parse(decision.at) >= Date.parse(row.at)) return { kind: "not_pending" };
  return { kind: "found", row, projection, ...(decision ? { decision } : {}) };
}

export interface PendingConsequenceRead {
  state: "verified";
  consequences: PendingConsequenceRecord[];
  source: "ledger";
  generatedAt: string;
  max: number;
  total: number;
  truncated: boolean;
  /** Pending preflight rows written before W1-T4104 carried no approval projection — counted,
   *  never guessed into a record. */
  unprojected: number;
}

/** The pending consequence approvals: every action whose LATEST preflight row was refused for a
 *  {@link PENDING_CONSEQUENCE_CODES} reason, is financial/irreversible, and has not expired. */
export function readPendingConsequences(deps: OperatorAgentRouteDependencies): PendingConsequenceRead {
  const clock = clockFromMillisFn(deps.now);
  const nowMs = clock.now();
  const { preflights, decisions } = latestConsequenceRows(deps);
  const pending: PendingConsequenceRecord[] = [];
  let unprojected = 0;
  for (const [consequenceId, row] of preflights) {
    if (row.ready !== false || typeof row.code !== "string" || !PENDING_CONSEQUENCE_CODES.has(row.code)) continue;
    if (typeof row.consequence_class !== "string" || !APPROVAL_CONSEQUENCE_CLASSES.has(row.consequence_class)) continue;
    const projection = storedApprovalProjection(row.approval);
    if (!projection || typeof row.at !== "string") {
      unprojected += 1;
      continue;
    }
    if (Date.parse(projection.expiresAt) <= nowMs) continue;
    const decision = decisions.get(consequenceId);
    if (decision && Date.parse(decision.at) >= Date.parse(row.at)) {
      // An approve is terminal and leaves the pending projection. A refuse remains visible so the
      // operator can see the durable reason in the same bounded receipt projection.
      if (decision.decision === "approve") continue;
    }
    const stale = projection.evidenceFreshUntil !== undefined && Date.parse(projection.evidenceFreshUntil) <= nowMs;
    pending.push({
      consequenceId,
      classes: [row.consequence_class],
      target: projection.target,
      ...(projection.amount !== undefined ? { amountUsd: projection.amount, currency: projection.currency } : {}),
      ...(projection.ceiling !== undefined ? { ceilingUsd: projection.ceiling } : {}),
      ...(projection.coolingOffMs !== undefined ? { coolingOffMs: projection.coolingOffMs } : {}),
      ...(projection.coolingOffUntil !== undefined ? { coolingOffUntil: projection.coolingOffUntil } : {}),
      expiresAt: projection.expiresAt,
      approverRequired: projection.approverRequired,
      recoveryStatement: projection.recoveryStatement,
      freshness: stale ? "stale" : "verified",
      observedAt: row.at,
      receipts: decision && Date.parse(decision.at) >= Date.parse(row.at) ? [consequenceDecisionReceipt(decision)] : [],
      source: OPERATOR_AGENT_CONSEQUENCES_SOURCE,
    });
  }
  pending.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt) || left.consequenceId.localeCompare(right.consequenceId));
  return {
    state: "verified",
    consequences: pending.slice(0, MAX_PENDING_CONSEQUENCES),
    source: "ledger",
    generatedAt: clock.iso(),
    max: MAX_PENDING_CONSEQUENCES,
    total: pending.length,
    truncated: pending.length > MAX_PENDING_CONSEQUENCES,
    unprojected,
  };
}

/** GET /v1/operator-agent/consequences — bounded, read-only list of pending consequence approvals.
 *  An empty queue is an empty list with its read time, never a 404. */
export function buildOperatorAgentConsequencesReadRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "GET",
    path: "/v1/operator-agent/consequences",
    scope: "read",
    handler: (_req, res) => sendJson(res, 200, readPendingConsequences(deps)),
  };
}

/** POST /v1/operator-agent/consequences/decision — the nonce-protected approval decision writer.
 *  The service's HIGH-tier dispatcher consumes the exact action-bound nonce before this handler is
 *  reached. The handler also requires the header so a direct route invocation cannot accidentally
 *  turn the route into an unguarded write when a caller constructs a service without enforcement.
 */
export function buildOperatorAgentConsequencesDecisionRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: CONSEQUENCE_DECISION_PATH,
    scope: "write",
    tier: "high",
    handler: jsonAction(validateConsequenceDecisionInput, (input, req, res) => {
      const rawNonce = req.headers["x-confirm-nonce"];
      const nonce = Array.isArray(rawNonce) ? rawNonce[0] : rawNonce;
      if (!nonce || !nonce.trim()) {
        sendJson(res, 403, { error: "confirm_nonce_required", consequenceId: input.consequenceId });
        return;
      }

      const current = currentConsequence(deps, input.consequenceId, clockFromMillisFn(deps.now).now());
      if (current.kind === "not_found") {
        sendJson(res, 404, {
          error: "not_found",
          consequenceId: input.consequenceId,
          detail: `no pending consequence "${input.consequenceId}" exists`,
        });
        return;
      }
      if (current.kind === "expired") {
        sendJson(res, 409, {
          error: "expired_consequence",
          consequenceId: input.consequenceId,
          detail: `consequence "${input.consequenceId}" expired at ${current.expiresAt}`,
        });
        return;
      }
      if (current.kind === "not_pending") {
        sendJson(res, 409, {
          error: "consequence_not_pending",
          consequenceId: input.consequenceId,
          detail: `consequence "${input.consequenceId}" is no longer pending`,
        });
        return;
      }

      const at = clockFromMillisFn(deps.now).iso();
      const actor = bearerTokenId(req);
      const nonceId = createHash("sha256").update(nonce).digest("hex").slice(0, 32);
      const reason = input.reason ?? (input.decision === "refuse" ? DEFAULT_CONSEQUENCE_REFUSAL_REASON : undefined);
      const row = {
        consequence_id: input.consequenceId,
        decision: input.decision,
        actor,
        nonce_id: nonceId,
        at,
        ...(reason ? { reason } : {}),
      };
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_CONSEQUENCE_DECISION_STEP, input.consequenceId, actor, row);
      deps.memory?.record({ step: OPERATOR_AGENT_CONSEQUENCE_DECISION_STEP, ...row });
      sendJson(res, 200, {
        ok: true,
        consequenceId: input.consequenceId,
        decision: input.decision,
        at,
        receipt: {
          kind: input.decision,
          at,
          issuer: actor,
          ...(reason ? { note: reason } : {}),
        },
      });
    }),
  };
}

/** Every write verb on the list path, refused BY NAME (405 `read_only`, `allow: GET`) rather than
 *  the router's anonymous 404 — the list records nothing; a decision is a different surface. */
export function buildOperatorAgentConsequencesWriteRefusalRoutes(): Route[] {
  return CONSEQUENCE_WRITE_METHODS.map((method): Route => ({
    method,
    path: OPERATOR_AGENT_CONSEQUENCES_PATH,
    scope: "read",
    handler: (_req, res) => {
      res.setHeader("allow", "GET");
      sendJson(res, 405, {
        error: "read_only",
        method,
        path: OPERATOR_AGENT_CONSEQUENCES_PATH,
        detail: `${method} ${OPERATOR_AGENT_CONSEQUENCES_PATH} refused: the pending consequence approval list is read-only`,
        allow: ["GET"],
      });
    },
  }));
}

function followUpHistory(deps: OperatorAgentRouteDependencies): FollowUpHistory[] {
  return readFollowUpHistory(deps.ledgerPath, clockFromMillisFn(deps.now).now());
}

/** The operator-agent execution seam delegates policy decisions to the durable follow-up module. */
export function evaluateOperatorAgentFollowUp(candidate: FollowUpCandidate, now?: number) {
  return evaluateFollowUpPolicy(candidate, { now });
}

/** GET /v1/operator-agent/follow-ups — durable follow-up candidates and receipts. */
export function buildOperatorAgentFollowUpReadRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "GET",
    path: "/v1/operator-agent/follow-ups",
    scope: "read",
    handler: (_req, res) => sendJson(res, 200, { followUps: followUpHistory(deps), source: "ledger" }),
  };
}

/** GET /v1/operator-agent/settings — durable settings or explicit conservative defaults. */
export function buildOperatorAgentSettingsReadRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "GET",
    path: "/v1/operator-agent/settings",
    scope: "read",
    handler: (req, res) => {
      if (rejectColdOperatorAgentMemory(deps, res)) return;
      const requested = requestedSettingsScope(req);
      if (requested.error) {
        sendJson(res, 400, { error: "invalid_request", detail: requested.error });
        return;
      }
      sendJson(res, 200, readOperatorAgentSettings(deps, requested.scope));
    },
  };
}

/** POST /v1/operator-agent/settings — persist bounded operator-agent settings. */
export function buildOperatorAgentSettingsWriteRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/settings",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateSettingsInput, (input, req, res) => {
      if (rejectColdOperatorAgentMemory(deps, res)) return;
      const updatedAt = clockFromMillisFn(deps.now).iso();
      const row = {
        step: OPERATOR_AGENT_SETTINGS_STEP,
        settings: input.settings,
        ...(input.scope ? { scope: input.scope } : {}),
        updatedAt,
      };
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_SETTINGS_STEP, "operator-agent-settings", bearerTokenId(req), {
        settings: input.settings,
        ...(input.scope ? { scope: input.scope } : {}),
        updatedAt,
      });
      deps.memory?.record(row);
      sendJson(res, 200, { settings: input.settings, source: "ledger", ...(input.scope ? { scope: input.scope } : {}), updatedAt });
    }),
  };
}

// ── W1-T3900: emergency-stop circuit ────────────────────────────────────────────────────────
// Ledger-backed, UNLIKE the delegation store just below: an emergency stop must survive a daemon
// restart mid-incident (ledger.ts's EMERGENCY_STOP_ISSUED_LEDGER_STEP doc explains why it is
// decision-relevant), so state is reconstructed from the ledger on every check rather than held
// in a per-process Map.

const MAX_EMERGENCY_ID = 160;
const MAX_EMERGENCY_TEXT = 500;
const MAX_EMERGENCY_CLASS_LIST = 50;

function validEmergencyClassList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_EMERGENCY_CLASS_LIST && value.every((v) => boundedString(v, MAX_ID));
}

/** `undefined` = field omitted (caller defaults it); `{ error }` = present but malformed. */
function validateEmergencyClassField(value: unknown): { error: string } | { value?: readonly string[] | "*" } {
  if (value === undefined) return {};
  if (value === "*") return { value: "*" };
  if (!validEmergencyClassList(value)) return { error: 'must be "*" or a bounded, non-empty array of strings' };
  return { value };
}

interface EmergencyStopIssueInput {
  scope: EmergencyStopScope;
  scopeTarget?: string;
  reason: string;
  issuedBy: string;
  clearPolicy: EmergencyStopClearPolicy;
  expiresAt?: string;
  affectedCapabilities?: readonly string[] | "*";
  affectedDelegationClasses?: readonly string[] | "*";
  incidentReceiptId: string;
  id?: string;
}

function validateEmergencyStopIssue(body: unknown): { error: string } | EmergencyStopIssueInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.scope !== "string" || !EMERGENCY_STOP_SCOPES.includes(body.scope as EmergencyStopScope)) {
    return { error: `scope must be one of ${EMERGENCY_STOP_SCOPES.join(", ")}` };
  }
  if (body.scopeTarget !== undefined && !boundedString(body.scopeTarget, MAX_EMERGENCY_ID)) return { error: "scopeTarget must be a bounded string" };
  if (!boundedString(body.reason, MAX_EMERGENCY_TEXT)) return { error: "reason is required" };
  if (!boundedString(body.issuedBy, MAX_EMERGENCY_ID)) return { error: "issuedBy is required" };
  if (typeof body.clearPolicy !== "string" || !EMERGENCY_STOP_CLEAR_POLICIES.includes(body.clearPolicy as EmergencyStopClearPolicy)) {
    return { error: `clearPolicy must be one of ${EMERGENCY_STOP_CLEAR_POLICIES.join(", ")}` };
  }
  if (body.expiresAt !== undefined && !iso(body.expiresAt)) return { error: "expiresAt must be a valid ISO-8601 instant" };
  if (!boundedString(body.incidentReceiptId, MAX_EMERGENCY_ID)) return { error: "incidentReceiptId is required" };
  const capabilities = validateEmergencyClassField(body.affectedCapabilities);
  if ("error" in capabilities) return { error: `affectedCapabilities ${capabilities.error}` };
  const delegationClasses = validateEmergencyClassField(body.affectedDelegationClasses);
  if ("error" in delegationClasses) return { error: `affectedDelegationClasses ${delegationClasses.error}` };
  if (body.id !== undefined && !boundedString(body.id, MAX_EMERGENCY_ID)) return { error: "id must be a bounded string" };
  return {
    scope: body.scope as EmergencyStopScope,
    ...(body.scopeTarget ? { scopeTarget: (body.scopeTarget as string).trim() } : {}),
    reason: (body.reason as string).trim(),
    issuedBy: (body.issuedBy as string).trim(),
    clearPolicy: body.clearPolicy as EmergencyStopClearPolicy,
    ...(body.expiresAt ? { expiresAt: new Date(body.expiresAt as string).toISOString() } : {}),
    ...("value" in capabilities && capabilities.value !== undefined ? { affectedCapabilities: capabilities.value } : {}),
    ...("value" in delegationClasses && delegationClasses.value !== undefined ? { affectedDelegationClasses: delegationClasses.value } : {}),
    incidentReceiptId: (body.incidentReceiptId as string).trim(),
    ...(body.id ? { id: (body.id as string).trim() } : {}),
  };
}

function validateEmergencyStopClear(body: unknown): { error: string } | { stopId: string; request: EmergencyClearRequest } {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!boundedString(body.stopId, MAX_EMERGENCY_ID)) return { error: "stopId is required" };
  const confirmation = body.confirmation;
  if (!isRecord(confirmation) || !boundedString(confirmation.confirmedBy, MAX_EMERGENCY_ID) || !iso(confirmation.confirmedAt)) {
    return { error: "confirmation requires a bounded confirmedBy and a valid ISO confirmedAt" };
  }
  const health = body.health;
  if (!isRecord(health) || !boundedString(health.source, MAX_EMERGENCY_ID) || !iso(health.checkedAt)) {
    return { error: "health requires a bounded source and a valid ISO checkedAt" };
  }
  if (health.status !== "healthy" && health.status !== "degraded" && health.status !== "unavailable") {
    return { error: "health.status must be healthy, degraded, or unavailable" };
  }
  const revocation = body.revocation;
  if (!isRecord(revocation) || (revocation.coverage !== "complete" && revocation.coverage !== "partial" && revocation.coverage !== "unavailable")) {
    return { error: "revocation.coverage must be complete, partial, or unavailable" };
  }
  const stopId = (body.stopId as string).trim();
  return {
    stopId,
    request: {
      stopId,
      confirmation: { confirmedBy: (confirmation.confirmedBy as string).trim(), confirmedAt: confirmation.confirmedAt as string },
      health: { source: (health.source as string).trim(), status: health.status, checkedAt: health.checkedAt as string },
      revocation: { coverage: revocation.coverage },
    },
  };
}

const EMERGENCY_STEPS = [EMERGENCY_STOP_ISSUED_LEDGER_STEP, EMERGENCY_STOP_CLEARED_LEDGER_STEP];

/** W1-T4334: archive-derived emergency rows per state dir, keyed by the archive file names. A rotated
 *  archive never changes once written, so only a NEW name can change these rows. */
const emergencyArchiveRows = new Map<string, { key: string; rows: Array<Record<string, unknown>> }>();

/** W1-T4334 — the emergency rows in union order (archives, then live), parsing the archives once per
 *  archive set: re-reading 900+ files on every status read and admission check froze the gateway's
 *  event loop for 10-30 s under console load (CPU profile, 2026-09-23). */
export function emergencyStopRows(ledgerPath: string, fsDeps: LedgerGrepFsDeps = realLedgerFs): Array<Record<string, unknown>> {
  const stateDir = dirname(ledgerPath);
  let names: string[];
  try {
    names = fsDeps.readdirSync(stateDir);
  } catch {
    // An unreadable state dir is an empty corpus, exactly as the union reader itself treats it.
    names = [];
  }
  const key = names.filter((n) => n.startsWith("ledger.")).sort().join("\n");
  let archived = emergencyArchiveRows.get(stateDir);
  if (archived?.key !== key) {
    const rows = readLedgerUnionRecordsSync(stateDir, { step: EMERGENCY_STEPS, readLiveRecords: () => [] }, fsDeps).rows;
    archived = { key, rows };
    emergencyArchiveRows.set(stateDir, archived);
  }
  const live = readLedgerUnionRecordsSync(stateDir, { step: EMERGENCY_STEPS }, { ...fsDeps, readdirSync: () => [] }).rows;
  return [...archived.rows, ...live];
}

interface EmergencyControlState {
  stops: Map<string, EmergencyStop>;
  clearedIds: Set<string>;
}

function readEmergencyControlState(ledgerPath: string): EmergencyControlState {
  const stops = new Map<string, EmergencyStop>();
  const clearedIds = new Set<string>();
  for (const row of emergencyStopRows(ledgerPath)) {
    if (row.step === EMERGENCY_STOP_ISSUED_LEDGER_STEP) {
      const stop = parseStoredEmergencyStop(row.stop);
      if (stop && !stops.has(stop.id)) stops.set(stop.id, stop);
      continue;
    }
    if (row.step === EMERGENCY_STOP_CLEARED_LEDGER_STEP && boundedString(row.stop_id, MAX_EMERGENCY_ID)) {
      clearedIds.add(row.stop_id);
    }
  }
  return { stops, clearedIds };
}

/** The currently ACTIVE stops — already filtered by {@link isEmergencyStopActive} — this task's
 *  admission call sites pass straight to {@link checkEmergencyStop}. */
function activeEmergencyStops(deps: OperatorAgentRouteDependencies): EmergencyStop[] {
  const { stops, clearedIds } = readEmergencyControlState(deps.ledgerPath);
  const now = deps.now?.() ?? Date.now();
  return [...stops.values()].filter((stop) => isEmergencyStopActive(stop, clearedIds, now));
}

/** POST /v1/operator-agent/emergency/stop — issue a bounded, incident-linked emergency stop. */
export function buildEmergencyStopIssueRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/emergency/stop",
    scope: "write",
    tier: "high",
    handler: jsonAction(validateEmergencyStopIssue, (input, req, res) => {
      let stop: EmergencyStop;
      try {
        stop = createEmergencyStop(input);
      } catch (e) {
        sendJson(res, 400, { error: "invalid_request", detail: (e as Error).message });
        return;
      }
      const receipt = emergencyStopIssuedReceipt(stop, { now: deps.now?.() });
      appendPanelLedger(deps.ledgerPath, EMERGENCY_STOP_ISSUED_LEDGER_STEP, stop.id, bearerTokenId(req), { stop, receipt });
      sendJson(res, 201, { ok: true, stop, receipt });
    }),
  };
}

/**
 * POST /v1/operator-agent/emergency/clear — the only path that lifts a stop. Requires explicit
 * human confirmation, a fresh healthy authoritative health read, and complete revocation-source
 * coverage (see clearEmergencyStop( in src/lib/emergency-control.ts); a `409` here writes nothing.
 */
export function buildEmergencyStopClearRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/emergency/clear",
    scope: "write",
    tier: "high",
    handler: jsonAction(validateEmergencyStopClear, (input, req, res) => {
      const { stops, clearedIds } = readEmergencyControlState(deps.ledgerPath);
      const stop = stops.get(input.stopId);
      if (!stop) {
        sendJson(res, 404, { error: "not_found", detail: `no emergency stop ${JSON.stringify(input.stopId)}` });
        return;
      }
      const result = clearEmergencyStop(stop, clearedIds.has(stop.id), input.request, { now: deps.now?.() });
      if (!result.ok) {
        sendJson(res, 409, { ok: false, code: result.code, receipt: result.receipt });
        return;
      }
      appendPanelLedger(deps.ledgerPath, EMERGENCY_STOP_CLEARED_LEDGER_STEP, stop.id, bearerTokenId(req), { stop_id: stop.id, receipt: result.receipt });
      sendJson(res, 200, { ok: true, receipt: result.receipt });
    }),
  };
}

/** GET /v1/operator-agent/emergency/status — the currently active stops, for panel visibility. */
export function buildEmergencyStopStatusRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "GET",
    path: "/v1/operator-agent/emergency/status",
    scope: "read",
    handler: (_req, res) => sendJson(res, 200, { active: activeEmergencyStops(deps), source: "ledger" }),
  };
}

// W1-T3883: the operator-agent handoff path's envelope state. In-memory, per-process — a
// durable/ledger-backed store is a follow-on concern, mirroring capability-grant.ts's own
// precedent (W1-T3880) of shipping the boundary before a persistence layer.
const operatorAgentDelegationStore = new InMemoryDelegationEnvelopeStore();

interface DelegationHandoffInput {
  envelope: {
    id?: string;
    sender: string;
    recipient: string;
    principal: string;
    purpose: string;
    capabilities: DelegationCapabilityRef[];
    scope?: DelegationScope;
    audience: string;
    expiresAt: string;
    nonce?: string;
  };
  acceptedCapabilities: DelegationCapabilityRef[];
  action: {
    capability: string;
    nonce: string;
    risk: DelegationRiskTier;
    humanApproval?: DelegationHumanApproval;
  };
}

const DELEGATION_RISK_TIERS: readonly DelegationRiskTier[] = ["low", "medium", "high", "production", "financial", "credential", "destructive"];

function validateDelegationCapabilities(value: unknown): value is DelegationCapabilityRef[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every((cap) => boundedString(cap, MAX_ID));
}

function validateDelegationScope(value: unknown): DelegationScope | undefined {
  if (value === undefined || !isRecord(value)) return undefined;
  const scope: DelegationScope = {
    ...(typeof value.repo === "string" ? { repo: value.repo } : {}),
    ...(typeof value.instance === "string" ? { instance: value.instance } : {}),
  };
  return scope;
}

function validateHumanApproval(value: unknown): { error: string } | DelegationHumanApproval | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !boundedString(value.approvedBy, MAX_ID) || !iso(value.approvedAt)) {
    return { error: "action.humanApproval requires a bounded approvedBy and a valid ISO approvedAt" };
  }
  return { approvedBy: value.approvedBy.trim(), approvedAt: value.approvedAt };
}

function validateDelegationHandoff(body: unknown): { error: string } | DelegationHandoffInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  const envelope = body.envelope;
  if (!isRecord(envelope)) return { error: "envelope is required" };
  if (!boundedString(envelope.sender, MAX_ID)) return { error: "envelope.sender is required" };
  if (!boundedString(envelope.recipient, MAX_ID)) return { error: "envelope.recipient is required" };
  if (!boundedString(envelope.principal, MAX_ID)) return { error: "envelope.principal is required" };
  if (!boundedString(envelope.purpose, MAX_TEXT)) return { error: "envelope.purpose is required" };
  if (!validateDelegationCapabilities(envelope.capabilities)) return { error: "envelope.capabilities must be a bounded, non-empty array of strings" };
  if (!boundedString(envelope.audience, MAX_ID)) return { error: "envelope.audience is required" };
  if (!iso(envelope.expiresAt)) return { error: "envelope.expiresAt must be a valid ISO-8601 instant" };
  if (envelope.id !== undefined && !boundedString(envelope.id, MAX_ID)) return { error: "envelope.id must be a bounded string" };
  if (envelope.nonce !== undefined && !boundedString(envelope.nonce, MAX_ID)) return { error: "envelope.nonce must be a bounded string" };

  const acceptedCapabilities = body.acceptedCapabilities;
  if (!validateDelegationCapabilities(acceptedCapabilities)) return { error: "acceptedCapabilities must be a bounded, non-empty array of strings" };

  const action = body.action;
  if (!isRecord(action)) return { error: "action is required" };
  if (!boundedString(action.capability, MAX_ID)) return { error: "action.capability is required" };
  if (!boundedString(action.nonce, MAX_ID)) return { error: "action.nonce is required" };
  if (typeof action.risk !== "string" || !DELEGATION_RISK_TIERS.includes(action.risk as DelegationRiskTier)) {
    return { error: `action.risk must be one of ${DELEGATION_RISK_TIERS.join(", ")}` };
  }
  const humanApproval = validateHumanApproval(action.humanApproval);
  if (humanApproval && "error" in humanApproval) return humanApproval;

  return {
    envelope: {
      ...(envelope.id ? { id: envelope.id } : {}),
      sender: envelope.sender.trim(),
      recipient: envelope.recipient.trim(),
      principal: envelope.principal.trim(),
      purpose: envelope.purpose.trim(),
      capabilities: [...(envelope.capabilities as string[])],
      scope: validateDelegationScope(envelope.scope),
      audience: envelope.audience.trim(),
      expiresAt: new Date(envelope.expiresAt).toISOString(),
      ...(envelope.nonce ? { nonce: envelope.nonce } : {}),
    },
    acceptedCapabilities: [...acceptedCapabilities],
    action: {
      capability: action.capability.trim(),
      nonce: action.nonce.trim(),
      risk: action.risk as DelegationRiskTier,
      ...(humanApproval ? { humanApproval } : {}),
    },
  };
}

/**
 * POST /v1/operator-agent/delegation/handoff — the operator-agent handoff path: issues a bounded
 * delegation envelope (W1-T3883), requires the recipient's explicit acceptance (narrow-only), and
 * then verifies and executes the requested capability through executeBoundedDelegation( — the
 * single call site every check (acceptance, replay, expiry, revocation, identity mismatch, audit
 * availability, and the human gate for high-risk/production/financial/credential/destructive
 * actions) runs through before any delegated side effect proceeds. Ledgers only the bounded
 * receipt, never the raw envelope purpose or capability text a second time.
 */
export function buildOperatorAgentDelegationHandoffRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "POST",
    path: "/v1/operator-agent/delegation/handoff",
    scope: "write",
    tier: "high",
    handler: jsonAction(validateDelegationHandoff, (input, req, res) => {
      let envelope;
      try {
        envelope = createDelegationEnvelope(input.envelope);
      } catch (e) {
        sendJson(res, 400, { error: "invalid_request", detail: (e as Error).message });
        return;
      }
      // W1-T3900: THE "agent handoff" surface this task's design names — refused BY NAME before
      // the envelope is even issued when an active emergency stop covers this handoff's repo,
      // instance, principal, or the specific capability requested.
      const admission = checkEmergencyStop(
        activeEmergencyStops(deps),
        {
          actionKind: "agent-handoff",
          repo: envelope.scope.repo,
          instance: envelope.scope.instance,
          principal: envelope.principal,
          delegationClass: input.action.capability,
        },
        deps.now?.() ?? Date.now(),
      );
      if (!admission.ok) {
        appendPanelLedger(deps.ledgerPath, EMERGENCY_STOP_REFUSAL_STEP, envelope.id, bearerTokenId(req), { receipt: admission.receipt });
        sendJson(res, 423, { ok: false, error: "emergency_stop_active", code: admission.code, receipt: admission.receipt });
        return;
      }
      operatorAgentDelegationStore.issue(envelope);

      const acceptance = acceptDelegationEnvelope(operatorAgentDelegationStore, {
        envelopeId: envelope.id,
        recipient: envelope.recipient,
        acceptedCapabilities: input.acceptedCapabilities,
      });
      if (!acceptance.ok) {
        sendJson(res, 409, { ok: false, stage: "accept", code: acceptance.code, detail: acceptance.reason });
        return;
      }

      const { verification, receipt } = executeBoundedDelegation(operatorAgentDelegationStore, {
        envelopeId: envelope.id,
        actorIdentity: envelope.recipient,
        capability: input.action.capability,
        audience: envelope.audience,
        nonce: input.action.nonce,
        risk: input.action.risk,
        ...(input.action.humanApproval ? { humanApproval: input.action.humanApproval } : {}),
      }, { now: deps.now?.() });

      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_DELEGATION_HANDOFF_STEP, envelope.id, bearerTokenId(req), { receipt });
      sendJson(res, verification.ok ? 200 : 409, { ok: verification.ok, receipt });
    }),
  };
}

export function buildOperatorAgentRoutes(deps: OperatorAgentRouteDependencies): Route[] {
  return [
    buildContextReadRoute(deps),
    buildContextRegisterRoute(deps),
    buildContextRevokeRoute(deps),
    buildContextDeleteRoute(deps),
    buildOperatorAgentProposalReadRoute(deps),
    buildOperatorAgentProposalRegisterRoute(deps),
    buildOperatorAgentDecisionRoute(deps),
    buildOperatorAgentOutcomeRoute(deps),
    buildOperatorAgentExperimentReadRoute(deps),
    buildOperatorAgentExperimentRegisterRoute(deps),
    buildOperatorAgentExperimentDecisionRoute(deps),
    buildOperatorAgentExperimentOutcomeRoute(deps),
    buildOperatorAgentExperimentRollbackRoute(deps),
    buildOperatorAgentPromotionReadRoute(deps),
    buildOperatorAgentPromotionRegisterRoute(deps),
    buildOperatorAgentPromotionReplayRoute(deps),
    buildOperatorAgentPromotionDecisionRoute(deps),
    buildOperatorAgentPromotionAdvanceRoute(deps),
    buildOperatorAgentPromotionRollbackRoute(deps),
    buildOperatorAgentConsequencePreflightRoute(deps),
    buildOperatorAgentConsequencesReadRoute(deps),
    buildOperatorAgentConsequencesDecisionRoute(deps),
    ...buildOperatorAgentConsequencesWriteRefusalRoutes(),
    buildOperatorAgentFollowUpReadRoute(deps),
    buildOperatorAgentSettingsReadRoute(deps),
    buildOperatorAgentSettingsWriteRoute(deps),
    buildOperatorAgentDelegationHandoffRoute(deps),
    buildEmergencyStopIssueRoute(deps),
    buildEmergencyStopClearRoute(deps),
    buildEmergencyStopStatusRoute(deps),
  ];
}
