/**
 * Durable operator-agent proposal memory for the panel surface.
 *
 * Proposals are intentionally separate from plan/feedback entries. Feedback is a human filing
 * that enters triage; an operator-agent proposal is a bounded recommendation with its own
 * accept/reject/more-info lifecycle. The ledger is the source of truth so a restart or rotation
 * cannot turn a browser-local decision into apparent learning.
 */

import { dirname } from "node:path";
import type { Route } from "./service.js";
import { clockFromMillisFn } from "./clock.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
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
  evaluateGuardrails,
  expirePromotionIfDue,
  findScopeConflict,
  isPromotionActive,
  rollbackPromotion,
  validateGuardObservations,
  validatePromotionRecord,
  validatePromotionRollback,
  validateReplaySummary,
  type ExperimentPromotionState,
  type GuardEvaluation,
  type GuardObservation,
  type PromotionAdvanceTarget,
  type PromotionRecord,
  type PromotionRollback,
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
/** W1-T3883: one bounded handoff — issue, accept, and act all verified through
 *  executeBoundedDelegation( before this ledgers — never a raw prompt or secret, only the
 *  resulting {@link DelegationReceipt}. */
export const OPERATOR_AGENT_DELEGATION_HANDOFF_STEP = "panel.operator_agent_delegation_handoff";
export const OPERATOR_AGENT_DEFAULT_SETTINGS = { enabled: true, confidenceThreshold: 0.9 } as const;

export const OPERATOR_AGENT_CATEGORIES = ["optimize", "fix", "scale"] as const;
export type OperatorAgentCategory = (typeof OPERATOR_AGENT_CATEGORIES)[number];

export const OPERATOR_AGENT_DECISIONS = ["accepted", "rejected", "more-info"] as const;
export type OperatorAgentDecision = (typeof OPERATOR_AGENT_DECISIONS)[number];

export type OperatorAgentFreshness = "verified" | "stale" | "unavailable";

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
  advance?: { target: PromotionAdvanceTarget; guard: GuardEvaluation; exposure?: number };
  rollback?: PromotionRollback;
  note?: string;
}

export interface OperatorAgentPromotionHistory extends PromotionRecord {
  state: ExperimentPromotionState;
  events: OperatorAgentPromotionEvent[];
}

type OperatorAgentRouteDependencies = Pick<PanelActionDeps, "ledgerPath"> & { now?: () => number };

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
type PromotionAdvanceInput = { promotionId: string; target: PromotionAdvanceTarget; observations?: GuardObservation[]; exposure?: number };
type PromotionRollbackInput = { promotionId: string; rollback: PromotionRollback };

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

function validatePromotionAdvanceInput(body: unknown): { error: string } | PromotionAdvanceInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (!safeExperimentText(body.promotionId, MAX_EXPERIMENT_ID)) return { error: "promotionId is required" };
  if (!isPromotionAdvanceTarget(body.target)) return { error: "target must be shadow, canary, observing, or promoted" };
  const observations = validateGuardObservations(body.observations);
  if (observations === null) return { error: "observations must be a bounded array of guard observations" };
  if (body.exposure !== undefined && (typeof body.exposure !== "number" || !Number.isFinite(body.exposure))) return { error: "exposure must be a finite number" };
  return { promotionId: body.promotionId.trim(), target: body.target, observations, ...(body.exposure !== undefined ? { exposure: body.exposure } : {}) };
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

function readRows(ledgerPath: string): Array<Record<string, unknown>> {
  // The agent's history is a durable read, so it must include the live ledger and both supported
  // rotation forms. The live reader is intentionally not substituted here: a compacted decision
  // must remain visible in /v1/operator-agent/proposals after restart.
  return readLedgerUnionRecordsSync(dirname(ledgerPath), {
    step: [OPERATOR_AGENT_PROPOSAL_STEP, OPERATOR_AGENT_DECISION_STEP, OPERATOR_AGENT_OUTCOME_STEP],
  }).rows;
}

function readSettingsRows(ledgerPath: string): Array<Record<string, unknown>> {
  return readLedgerUnionRecordsSync(dirname(ledgerPath), { step: OPERATOR_AGENT_SETTINGS_STEP }).rows;
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
  for (const row of readSettingsRows(deps.ledgerPath)) {
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

export function readOperatorAgentHistory(deps: OperatorAgentRouteDependencies): OperatorAgentHistory[] {
  const proposals = new Map<string, OperatorAgentProposal>();
  const decisions = new Map<string, OperatorAgentDecisionEvent[]>();
  const outcomes = new Map<string, OperatorAgentOutcome>();
  for (const row of readRows(deps.ledgerPath)) {
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
    return { promotionId, event: { kind: "advance", at, state, advance: { target: row.target, guard, ...(typeof row.exposure === "number" ? { exposure: row.exposure } : {}) } } };
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

/** GET /v1/operator-agent/proposals — durable proposal and operator-decision history. */
export function buildOperatorAgentProposalReadRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "GET",
    path: "/v1/operator-agent/proposals",
    scope: "read",
    handler: (_req, res) => sendJson(res, 200, { proposals: readOperatorAgentHistory(deps), source: "ledger" }),
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
      const existing = findProposal(deps, input.proposal.proposalId);
      if (existing) {
        if (JSON.stringify(existing.proposalText) !== JSON.stringify(input.proposal.proposalText) || existing.repo !== input.proposal.repo) {
          sendJson(res, 409, { error: "conflict", detail: `proposalId ${input.proposal.proposalId} already names a different proposal` });
          return;
        }
        sendJson(res, 200, { ok: true, existing: true, proposal: existing });
        return;
      }
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_PROPOSAL_STEP, input.proposal.proposalId, bearerTokenId(req), { proposal: input.proposal });
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
      const result = advancePromotionState({ currentState: existing.state, target: input.target, guard, maxExposure: existing.maxExposure, exposure: input.exposure });
      if (result.state === existing.state) {
        sendJson(res, 409, { error: "conflict", detail: result.reason ?? `promotion ${input.promotionId} cannot advance to ${input.target} from ${existing.state}` });
        return;
      }
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_PROMOTION_ADVANCE_STEP, input.promotionId, bearerTokenId(req), {
        promotion_id: input.promotionId,
        target: input.target,
        guard,
        state: result.state,
        at: nowIso,
        ...(input.exposure !== undefined ? { exposure: input.exposure } : {}),
      });
      sendJson(res, 200, { ok: true, promotionId: input.promotionId, state: result.state, ...(result.reason ? { reason: result.reason } : {}), at: nowIso });
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
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP, action.id, bearerTokenId(req), {
        action_id: action.id,
        consequence_class: action.consequenceClass,
        ready: result.ok,
        at: nowIso,
        ...(refusal ? { code: refusal.code, reason: refusal.reason } : {}),
      });
      if (!result.ok) {
        sendJson(res, 409, { ok: false, actionId: action.id, code: result.code, reason: result.reason, at: nowIso });
        return;
      }
      sendJson(res, 200, { ok: true, actionId: action.id, consequenceClass: action.consequenceClass, at: nowIso });
    }),
  };
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
      const updatedAt = clockFromMillisFn(deps.now).iso();
      appendPanelLedger(deps.ledgerPath, OPERATOR_AGENT_SETTINGS_STEP, "operator-agent-settings", bearerTokenId(req), {
        settings: input.settings,
        ...(input.scope ? { scope: input.scope } : {}),
        updatedAt,
      });
      sendJson(res, 200, { settings: input.settings, source: "ledger", ...(input.scope ? { scope: input.scope } : {}), updatedAt });
    }),
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
    buildOperatorAgentFollowUpReadRoute(deps),
    buildOperatorAgentSettingsReadRoute(deps),
    buildOperatorAgentSettingsWriteRoute(deps),
    buildOperatorAgentDelegationHandoffRoute(deps),
  ];
}
