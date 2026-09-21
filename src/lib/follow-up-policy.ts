/** Durable follow-up-policy-v1: a quiet, human-controlled nudge over fresh evidence. */

import { dirname } from "node:path";
import {
  appendLedger,
  FOLLOW_UP_CANDIDATE_STEP,
  FOLLOW_UP_CONTROL_STEP,
  FOLLOW_UP_POLICY_STEP,
  FOLLOW_UP_RECEIPT_STEP,
  FOLLOW_UP_STATE_STEP,
} from "./ledger.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { systemClock, type Clock } from "./clock.js";

export const FOLLOW_UP_POLICY_VERSION = "follow-up-policy-v1" as const;
export const FOLLOW_UP_STATES = [
  "scheduled",
  "eligible",
  "snoozed",
  "suppressed",
  "asked",
  "accepted",
  "rejected",
  "expired",
  "blocked",
] as const;
export type FollowUpState = (typeof FOLLOW_UP_STATES)[number];
export type FollowUpFreshness = "verified" | "stale" | "unavailable";
export type FollowUpControl = "snooze" | "reject" | "revoke" | "policy";

export interface FollowUpQuietHours {
  timezone: string;
  start: string;
  end: string;
}

export interface FollowUpNotificationPolicy {
  enabled: boolean;
  quietHours?: FollowUpQuietHours;
}

export interface FollowUpCandidate {
  version: typeof FOLLOW_UP_POLICY_VERSION;
  candidateId: string;
  sourceEvent: string;
  workstream: string;
  reason: string;
  freshness: FollowUpFreshness;
  deadline?: string;
  dependency?: string;
  quietHours?: FollowUpQuietHours;
  deduplicationKey: string;
  maxAttempts: number;
  owner: string;
  nextAction?: string;
  nextQuestion?: string;
  createdAt: string;
}

export interface FollowUpReceipt {
  delivered: boolean;
  answered?: boolean;
  systemActed: boolean;
  authority?: string;
  completed: false;
  permissionToAct: boolean;
  at: string;
}

export interface FollowUpEvent {
  candidateId: string;
  at: string;
  state?: FollowUpState;
  reason?: string;
  until?: string;
  control?: FollowUpControl;
  notificationPolicy?: FollowUpNotificationPolicy;
  receipt?: FollowUpReceipt;
}

export interface FollowUpHistory extends FollowUpCandidate {
  state: FollowUpState;
  attempts: number;
  events: FollowUpEvent[];
  receipt?: FollowUpReceipt;
  notificationPolicy?: FollowUpNotificationPolicy;
  snoozedUntil?: string;
}

export interface FollowUpEvaluation {
  version: typeof FOLLOW_UP_POLICY_VERSION;
  candidateId: string;
  deduplicationKey: string;
  state: FollowUpState;
  reason: string;
  at: string;
  attempts: number;
  nextAction?: string;
  nextQuestion?: string;
}

export interface FollowUpEvaluationContext {
  now?: number | string;
  sourceTerminal?: boolean;
  dependencyAvailable?: boolean;
  existing?: readonly FollowUpHistory[];
  notificationPolicy?: FollowUpNotificationPolicy;
}

export interface FollowUpLedgerContext {
  ledgerPath: string;
  now?: Clock;
  origin?: string;
}

const MAX_TEXT = 500;
const MAX_ID = 160;
const MAX_OWNER = 200;
const MAX_ATTEMPTS = 20;
const FOLLOW_UP_STEPS = [
  FOLLOW_UP_CANDIDATE_STEP,
  FOLLOW_UP_STATE_STEP,
  FOLLOW_UP_CONTROL_STEP,
  FOLLOW_UP_RECEIPT_STEP,
  FOLLOW_UP_POLICY_STEP,
] as const;
const TERMINAL_STATES = new Set<FollowUpState>(["accepted", "rejected", "expired", "blocked"]);

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validQuietHours(value: unknown): FollowUpQuietHours | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  if (!bounded(policy.timezone, 100) || !validTime(policy.start) || !validTime(policy.end)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: policy.timezone }).format();
  } catch {
    // Intl rejects unknown IANA zones; invalid notification policy is intentionally discarded.
    return null;
  }
  return { timezone: policy.timezone.trim(), start: policy.start, end: policy.end };
}

function validNotificationPolicy(value: unknown): FollowUpNotificationPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  if (typeof policy.enabled !== "boolean") return null;
  if (policy.quietHours === undefined) return { enabled: policy.enabled };
  const quietHours = validQuietHours(policy.quietHours);
  return quietHours ? { enabled: policy.enabled, quietHours } : null;
}

export function validateFollowUpNotificationPolicy(value: unknown): FollowUpNotificationPolicy | null {
  return validNotificationPolicy(value);
}

function normaliseNow(value: FollowUpEvaluationContext["now"]): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return systemClock.now();
}

function isoAt(value: FollowUpEvaluationContext["now"]): string {
  if (value === undefined) return systemClock.iso();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(normaliseNow(value));
  const part = (name: string): string => parts.find((item) => item.type === name)?.value ?? "00";
  const milliseconds = String(Math.max(0, Math.trunc(normaliseNow(value) % 1000))).padStart(3, "0");
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}.${milliseconds}Z`;
}

function parseMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function inQuietHours(now: number, quietHours: FollowUpQuietHours): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: quietHours.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const current = hour * 60 + minute;
  const start = parseMinutes(quietHours.start);
  const end = parseMinutes(quietHours.end);
  return start === end ? true : start < end ? current >= start && current < end : current >= start || current < end;
}

function isState(value: unknown): value is FollowUpState {
  return FOLLOW_UP_STATES.includes(value as FollowUpState);
}

function historyForCandidate(candidate: FollowUpCandidate, existing: readonly FollowUpHistory[] = []): FollowUpHistory | undefined {
  return existing.find((item) => item.candidateId === candidate.candidateId);
}

function duplicateForCandidate(candidate: FollowUpCandidate, existing: readonly FollowUpHistory[] = []): FollowUpHistory | undefined {
  return existing.find((item) => item.deduplicationKey === candidate.deduplicationKey && item.candidateId !== candidate.candidateId);
}

export function validateFollowUpCandidate(value: unknown): FollowUpCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== FOLLOW_UP_POLICY_VERSION) return null;
  if (!bounded(candidate.candidateId, MAX_ID) || !bounded(candidate.sourceEvent, MAX_TEXT)) return null;
  if (!bounded(candidate.workstream, MAX_TEXT) || !bounded(candidate.reason, MAX_TEXT)) return null;
  if (candidate.freshness !== "verified" && candidate.freshness !== "stale" && candidate.freshness !== "unavailable") return null;
  if (candidate.deadline !== undefined && !iso(candidate.deadline)) return null;
  if (candidate.dependency !== undefined && !bounded(candidate.dependency, MAX_TEXT)) return null;
  if (candidate.deadline === undefined && candidate.dependency === undefined) return null;
  if (!bounded(candidate.deduplicationKey, MAX_ID) || !bounded(candidate.owner, MAX_OWNER)) return null;
  if (!Number.isInteger(candidate.maxAttempts) || Number(candidate.maxAttempts) < 1 || Number(candidate.maxAttempts) > MAX_ATTEMPTS) return null;
  if (!iso(candidate.createdAt)) return null;
  const quietHours = candidate.quietHours === undefined ? undefined : validQuietHours(candidate.quietHours);
  if (candidate.quietHours !== undefined && !quietHours) return null;
  const hasAction = bounded(candidate.nextAction, MAX_TEXT);
  const hasQuestion = bounded(candidate.nextQuestion, MAX_TEXT);
  if (hasAction === hasQuestion) return null;
  const nextAction = hasAction ? String(candidate.nextAction).trim() : undefined;
  const nextQuestion = hasQuestion ? String(candidate.nextQuestion).trim() : undefined;
  return {
    version: FOLLOW_UP_POLICY_VERSION,
    candidateId: candidate.candidateId.trim(),
    sourceEvent: candidate.sourceEvent.trim(),
    workstream: candidate.workstream.trim(),
    reason: candidate.reason.trim(),
    freshness: candidate.freshness,
    ...(candidate.deadline ? { deadline: candidate.deadline } : {}),
    ...(candidate.dependency ? { dependency: candidate.dependency.trim() } : {}),
    ...(quietHours ? { quietHours } : {}),
    deduplicationKey: candidate.deduplicationKey.trim(),
    maxAttempts: Number(candidate.maxAttempts),
    owner: candidate.owner.trim(),
    ...(nextAction ? { nextAction } : { nextQuestion: nextQuestion! }),
    createdAt: candidate.createdAt,
  };
}

export function evaluateFollowUpPolicy(candidate: FollowUpCandidate, context: FollowUpEvaluationContext = {}): FollowUpEvaluation {
  const now = normaliseNow(context.now);
  const at = isoAt(now);
  const current = historyForCandidate(candidate, context.existing);
  const attempts = current?.attempts ?? 0;
  const base = (state: FollowUpState, reason: string): FollowUpEvaluation => ({
    version: FOLLOW_UP_POLICY_VERSION,
    candidateId: candidate.candidateId,
    deduplicationKey: candidate.deduplicationKey,
    state,
    reason,
    at,
    attempts,
    ...(candidate.nextAction ? { nextAction: candidate.nextAction } : { nextQuestion: candidate.nextQuestion }),
  });

  if (current && TERMINAL_STATES.has(current.state)) return base("suppressed", `terminal receipt is already ${current.state}`);
  if (current?.state === "rejected" || current?.state === "suppressed") return base("suppressed", "human stop control is active");
  if (current?.state === "asked" || current?.state === "eligible") return base("suppressed", "candidate is already in flight");
  const duplicate = duplicateForCandidate(candidate, context.existing);
  if (duplicate && TERMINAL_STATES.has(duplicate.state)) return base("suppressed", `terminal receipt already exists for ${duplicate.deduplicationKey}`);
  if (duplicate) return base("suppressed", `coalesced with ${duplicate.candidateId}`);
  if (candidate.freshness === "stale") return base("suppressed", "source evidence is stale");
  if (candidate.freshness === "unavailable") return base("suppressed", "source evidence is unavailable");
  if (context.sourceTerminal) return base("suppressed", "source event is terminal");
  if (candidate.deadline && Date.parse(candidate.deadline) <= now) return base("expired", "deadline has passed");
  if (candidate.dependency && context.dependencyAvailable === false) return base("blocked", `dependency is unavailable: ${candidate.dependency}`);
  if (attempts >= candidate.maxAttempts) return base("blocked", "maximum attempts reached");
  const policy = context.notificationPolicy ?? current?.notificationPolicy;
  if (policy?.enabled === false) return base("suppressed", "notification policy is disabled");
  if (current?.snoozedUntil && Date.parse(current.snoozedUntil) > now) return base("snoozed", `snoozed until ${current.snoozedUntil}`);
  const quietHours = policy?.quietHours ?? candidate.quietHours;
  if (quietHours && inQuietHours(now, quietHours)) return base("snoozed", "quiet hours are active");
  return base("eligible", "fresh source is eligible for one human follow-up");
}

export function applyFollowUpControl(
  history: FollowUpHistory,
  control: FollowUpControl,
    options: { until?: string; notificationPolicy?: FollowUpNotificationPolicy; at?: number | string },
): FollowUpEvent | { error: string } {
  const at = isoAt(options.at);
  if (control === "snooze") {
    if (!options.until || !iso(options.until) || Date.parse(options.until) <= Date.parse(at)) return { error: "snooze requires a future until timestamp" };
    if (TERMINAL_STATES.has(history.state)) return { error: `candidate is already ${history.state}` };
    return { candidateId: history.candidateId, at, state: "snoozed", control, until: options.until, reason: "snoozed by operator" };
  }
  if (control === "policy") {
    if (!options.notificationPolicy || !validNotificationPolicy(options.notificationPolicy)) return { error: "policy control requires a valid notificationPolicy" };
    return { candidateId: history.candidateId, at, control, notificationPolicy: options.notificationPolicy, reason: "notification policy changed" };
  }
  if (history.state === "accepted" || history.state === "rejected") return { error: `candidate is already ${history.state}` };
  return {
    candidateId: history.candidateId,
    at,
    state: "rejected",
    control,
    reason: control === "revoke" ? "revoked by operator" : "rejected by operator",
  };
}

export function followUpReceipt(
  history: FollowUpHistory,
  input: { answered?: boolean; systemActed?: boolean; authority?: string; at?: number | string },
): FollowUpReceipt | { error: string } {
  if (TERMINAL_STATES.has(history.state)) return { error: `candidate is already ${history.state}` };
  if (input.systemActed && !bounded(input.authority, MAX_OWNER)) return { error: "systemActed requires an authority" };
  const at = isoAt(input.at);
  return {
    delivered: true,
    ...(input.answered === undefined ? {} : { answered: input.answered }),
    systemActed: input.systemActed === true,
    ...(input.authority ? { authority: input.authority.trim() } : {}),
    completed: false,
    permissionToAct: input.systemActed === true && bounded(input.authority, MAX_OWNER),
    at,
  };
}

export function readFollowUpHistory(ledgerPath: string, now: number = systemClock.now()): FollowUpHistory[] {
  const rows = readLedgerUnionRecordsSync(dirname(ledgerPath), { step: [...FOLLOW_UP_STEPS] }).rows;
  const candidates = new Map<string, FollowUpCandidate>();
  const events = new Map<string, FollowUpEvent[]>();
  for (const row of rows) {
    if (row.step === FOLLOW_UP_CANDIDATE_STEP) {
      const candidate = validateFollowUpCandidate(row.candidate);
      if (candidate && !candidates.has(candidate.candidateId)) candidates.set(candidate.candidateId, candidate);
      continue;
    }
    if (!bounded(row.candidate_id, MAX_ID) || !iso(row.at)) continue;
    const notificationPolicy = validNotificationPolicy(row.notificationPolicy);
    const event: FollowUpEvent = {
      candidateId: row.candidate_id.trim(),
      at: row.at,
      ...(isState(row.state) ? { state: row.state } : {}),
      ...(bounded(row.reason, MAX_TEXT) ? { reason: row.reason.trim() } : {}),
      ...(iso(row.until) ? { until: row.until } : {}),
      ...(row.control === "snooze" || row.control === "reject" || row.control === "revoke" || row.control === "policy" ? { control: row.control } : {}),
      ...(notificationPolicy ? { notificationPolicy } : {}),
      ...(row.receipt && typeof row.receipt === "object" ? { receipt: row.receipt as FollowUpReceipt } : {}),
    };
    events.set(event.candidateId, [...(events.get(event.candidateId) ?? []), event]);
  }
  return [...candidates.values()]
    .map((candidate): FollowUpHistory => {
      const history = events.get(candidate.candidateId) ?? [];
      let state: FollowUpState = "scheduled";
      let attempts = 0;
      let receipt: FollowUpReceipt | undefined;
      let notificationPolicy: FollowUpNotificationPolicy | undefined;
      let snoozedUntil: string | undefined;
      for (const event of history) {
        if (event.state) state = event.state;
        if (event.state === "asked") attempts += 1;
        if (event.receipt) receipt = event.receipt;
        if (event.notificationPolicy) notificationPolicy = event.notificationPolicy;
        if (event.control === "snooze" && event.until) snoozedUntil = event.until;
        if (event.control === "reject" || event.control === "revoke") state = "rejected";
      }
      if (state === "snoozed" && snoozedUntil && Date.parse(snoozedUntil) <= now) state = "scheduled";
      return { ...candidate, state, attempts, events: history, ...(receipt ? { receipt } : {}), ...(notificationPolicy ? { notificationPolicy } : {}), ...(snoozedUntil ? { snoozedUntil } : {}) };
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.candidateId.localeCompare(right.candidateId));
}

export function appendFollowUpCandidate(deps: FollowUpLedgerContext, candidate: FollowUpCandidate): void {
  appendLedger(deps.ledgerPath, {
    run_id: `FOLLOW-UP-${deps.now?.now() ?? systemClock.now()}`,
    task_id: candidate.candidateId,
    step: FOLLOW_UP_CANDIDATE_STEP,
    candidate,
    ...(deps.origin ? { origin: deps.origin } : {}),
  });
}

export function appendFollowUpState(deps: FollowUpLedgerContext, evaluation: FollowUpEvaluation): void {
  appendLedger(deps.ledgerPath, {
    run_id: `FOLLOW-UP-${deps.now?.now() ?? systemClock.now()}`,
    task_id: evaluation.candidateId,
    step: FOLLOW_UP_STATE_STEP,
    candidate_id: evaluation.candidateId,
    state: evaluation.state,
    reason: evaluation.reason,
    at: evaluation.at,
    deduplication_key: evaluation.deduplicationKey,
    ...(deps.origin ? { origin: deps.origin } : {}),
  });
}

export function appendFollowUpControl(deps: FollowUpLedgerContext, event: FollowUpEvent): void {
  appendLedger(deps.ledgerPath, {
    run_id: `FOLLOW-UP-${deps.now?.now() ?? systemClock.now()}`,
    task_id: event.candidateId,
    step: event.control === "policy" ? FOLLOW_UP_POLICY_STEP : FOLLOW_UP_CONTROL_STEP,
    candidate_id: event.candidateId,
    ...event,
    ...(deps.origin ? { origin: deps.origin } : {}),
  });
}

export function appendFollowUpReceipt(deps: FollowUpLedgerContext, receipt: FollowUpReceipt, candidateId: string): void {
  appendLedger(deps.ledgerPath, {
    run_id: `FOLLOW-UP-${deps.now?.now() ?? systemClock.now()}`,
    task_id: candidateId,
    step: FOLLOW_UP_RECEIPT_STEP,
    candidate_id: candidateId,
    state: "asked",
    receipt,
    at: receipt.at,
    ...(deps.origin ? { origin: deps.origin } : {}),
  });
}
