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

export const OPERATOR_AGENT_PROPOSAL_STEP = "panel.operator_agent_proposal";
export const OPERATOR_AGENT_DECISION_STEP = "panel.operator_agent_decision";
export const OPERATOR_AGENT_OUTCOME_STEP = "panel.operator_agent_outcome";
export const OPERATOR_AGENT_SETTINGS_STEP = "panel.operator_agent_settings";
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

export type OperatorAgentSettingsRead = {
  settings: OperatorAgentSettings;
  source: "ledger" | "default";
};

type OperatorAgentRouteDependencies = Pick<PanelActionDeps, "ledgerPath"> & { now?: () => number };

type ProposalRegistrationInput = { proposal: OperatorAgentProposal };
type ProposalDecisionInput = { proposalId: string; decision: OperatorAgentDecision; note?: string };
type ProposalOutcomeInput = { proposalId: string; outcome: OperatorAgentOutcome };
type OperatorAgentSettingsInput = { settings: OperatorAgentSettings };

const MAX_ID = 160;
const MAX_REPO = 200;
const MAX_TEXT = 500;
const MAX_REASONING = 4_000;
const MAX_NOTE = 1_000;
const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_VALUE = 600;
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
  return { settings };
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

function settingsFromRow(row: Record<string, unknown>): OperatorAgentSettings | null {
  if (row.step !== OPERATOR_AGENT_SETTINGS_STEP) return null;
  return validateSettings(row.settings);
}

export function readOperatorAgentSettings(deps: OperatorAgentRouteDependencies): OperatorAgentSettingsRead {
  let settings: OperatorAgentSettings | undefined;
  for (const row of readSettingsRows(deps.ledgerPath)) {
    const candidate = settingsFromRow(row);
    if (candidate) settings = candidate;
  }
  return settings ? { settings, source: "ledger" } : { settings: { ...OPERATOR_AGENT_DEFAULT_SETTINGS }, source: "default" };
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

/** GET /v1/operator-agent/settings — durable settings or explicit conservative defaults. */
export function buildOperatorAgentSettingsReadRoute(deps: OperatorAgentRouteDependencies): Route {
  return {
    method: "GET",
    path: "/v1/operator-agent/settings",
    scope: "read",
    handler: (_req, res) => sendJson(res, 200, readOperatorAgentSettings(deps)),
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
        updatedAt,
      });
      sendJson(res, 200, { settings: input.settings, source: "ledger", updatedAt });
    }),
  };
}

export function buildOperatorAgentRoutes(deps: OperatorAgentRouteDependencies): Route[] {
  return [
    buildOperatorAgentProposalReadRoute(deps),
    buildOperatorAgentProposalRegisterRoute(deps),
    buildOperatorAgentDecisionRoute(deps),
    buildOperatorAgentOutcomeRoute(deps),
    buildOperatorAgentSettingsReadRoute(deps),
    buildOperatorAgentSettingsWriteRoute(deps),
  ];
}
