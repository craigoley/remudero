/**
 * Durable human-handoff-v1 (W1-T3897): a "Needs me" item that is supervised, never just delivered.
 *
 * A handoff names why a human is needed, the source receipt that produced it, the decision it
 * needs, its principal/repository scope, its owner (or unclaimed state), a claim lease, a priority,
 * a response deadline, an escalation policy, quiet hours, its current freshness, and — once closed —
 * the human decision and authoritative outcome. Every mutation returns a linked receipt; a claim is
 * idempotent and leased, an escalation never widens the original action profile, and delivery never
 * closes an item. HUMAN_HANDOFF_LEDGER_STEP sits in the decision-retention set: losing a snapshot on
 * rotation would drop an owner, a lease, an escalation, or a closure after restart.
 *
 * The follow-up path (handOffOperatorAgentFollowUp in operator-agent.ts) mints one of these for a
 * follow-up that cannot proceed autonomously — blocked, or eligible only to ASK a human — at advice-only
 * authority unless its caller names the original profile, and returns a core refusal by name.
 */

import { dirname } from "node:path";
import { fixedClock } from "./clock.js";
import { appendLedger, HUMAN_HANDOFF_LEDGER_STEP } from "./ledger.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";

export const HUMAN_HANDOFF_VERSION = "human-handoff-v1" as const;
export const HANDOFF_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const HANDOFF_AUTHORITY_LEVELS = ["observe", "advise", "approve", "act"] as const;
export const HANDOFF_CLOSURE_OUTCOMES = ["answered", "action_accepted", "action_refused", "expired", "superseded", "unavailable"] as const;
export const HANDOFF_STATES = ["unclaimed", "claimed", "aging", "quiet_hours", "escalated", "expired", "unavailable", "closed"] as const;
export type HandoffPriority = (typeof HANDOFF_PRIORITIES)[number];
export type HandoffAuthorityLevel = (typeof HANDOFF_AUTHORITY_LEVELS)[number];
export type HandoffClosureOutcome = (typeof HANDOFF_CLOSURE_OUTCOMES)[number];
export type HandoffState = (typeof HANDOFF_STATES)[number];
export type HandoffFreshness = "verified" | "stale" | "unavailable";
export type HandoffReceiptKind = "created" | "delivered" | "claimed" | "claim_released" | "reassigned" | "escalated" | "freshness" | "closed";
export type HandoffRefusal =
  | "invalid"
  | "out_of_scope"
  | "claimed_by_other"
  | "assigned_to_other"
  | "idempotency_conflict"
  | "receipt_required"
  | "authority_widening"
  | "not_due"
  | "quiet_hours"
  | "escalation_exhausted"
  | "closed"
  | "claim_required"
  | "decision_required"
  | "outcome_required"
  | "not_expired"
  | "delivery_is_not_closure"
  | "receipt_budget_exhausted";

export interface HandoffScope {
  principal: string;
  repository: string;
}

/** The principals and repositories an actor may act for. Exact names only — no wildcard widens it. */
export interface HandoffActorScope {
  principals: readonly string[];
  repositories: readonly string[];
}

export interface HandoffActionProfile {
  level: HandoffAuthorityLevel;
  capabilities: string[];
}

export interface HandoffEscalationPolicy {
  /** How long an item may sit unowned since it was last offered before it is due to escalate. */
  afterMs: number;
  chain: string[];
}

export interface HandoffQuietHours {
  timezone: string;
  start: string;
  end: string;
}

export interface HandoffClaim {
  owner: string;
  claimId: string;
  idempotencyKey: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface HandoffClosure {
  outcome: HandoffClosureOutcome;
  decidedBy: string;
  decision?: string;
  authoritativeOutcome?: string;
  supersededBy?: string;
  closedAt: string;
  receiptId: string;
}

export interface HandoffReceipt {
  receiptId: string;
  handoffId: string;
  kind: HandoffReceiptKind;
  actor: string;
  at: string;
  detail: string;
  linkedReceipt?: string;
  idempotencyKey?: string;
}

export interface HumanHandoffInput {
  handoffId: string;
  reason: string;
  sourceReceipt: string;
  requiredDecision: string;
  scope: HandoffScope;
  priority: HandoffPriority;
  responseDeadline: string;
  escalationPolicy: HandoffEscalationPolicy;
  quietHours?: HandoffQuietHours;
  freshness: HandoffFreshness;
  actionProfile: HandoffActionProfile;
  createdBy: string;
}

export interface HumanHandoff extends HumanHandoffInput {
  version: typeof HUMAN_HANDOFF_VERSION;
  createdAt: string;
  freshAt: string;
  claim: HandoffClaim | null;
  assignee?: string;
  escalationLevel: number;
  grantedAuthority: HandoffActionProfile;
  deliveries: number;
  closure: HandoffClosure | null;
  receipts: HandoffReceipt[];
}

export type HandoffResult =
  | { ok: true; changed: boolean; handoff: HumanHandoff; receipt: HandoffReceipt }
  | { ok: false; error: HandoffRefusal; detail: string };

export interface HandoffAssessment {
  handoffId: string;
  state: HandoffState;
  ownerState: "unclaimed" | "claimed" | "claim_expired";
  owner?: string;
  assignee?: string;
  priority: HandoffPriority;
  freshness: HandoffFreshness;
  ageMs: number;
  msToDeadline: number;
  escalationLevel: number;
  escalationDue: boolean;
  /** True whenever an unowned item is past its escalation age — whatever {@link state} reads, so a
   *  quiet-hour or escalated label can never hide an overdue unclaimed item. */
  overdue: boolean;
  inQuietHours: boolean;
}

export interface HumanHandoffLedgerContext {
  ledgerPath: string;
  origin?: string;
}

const MAX_TEXT = 500;
const MAX_ID = 200;
const MAX_LIST = 32;
const MAX_RECEIPTS = 200;
export const MIN_CLAIM_LEASE_MS = 60_000;
export const MAX_CLAIM_LEASE_MS = 24 * 60 * 60 * 1000;

const isoOf = (ms: number): string => fixedClock(ms).iso();
const refuse = (error: HandoffRefusal, detail: string): HandoffResult => ({ ok: false, error, detail });

function bounded(value: unknown, max: number = MAX_TEXT): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function boundedList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_LIST && value.every((item) => bounded(item, MAX_ID));
}

function validQuietHours(value: unknown): HandoffQuietHours | null {
  if (!value || typeof value !== "object") return null;
  const hours = value as Record<string, unknown>;
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!bounded(hours.timezone, 100) || typeof hours.start !== "string" || typeof hours.end !== "string") return null;
  if (!clock.test(hours.start) || !clock.test(hours.end)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: hours.timezone }).format(0);
  } catch (error) {
    void error; // Intl throws RangeError for an unknown IANA zone: the quiet-hours policy is invalid, so the caller refuses the handoff.
    return null;
  }
  return { timezone: hours.timezone.trim(), start: hours.start, end: hours.end };
}

function minutesOf(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Whether `now` falls inside the quiet-hour window, in the window's own timezone (wraps midnight). */
export function inHandoffQuietHours(now: number, quietHours: HandoffQuietHours | undefined): boolean {
  if (!quietHours) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: quietHours.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const current = Number(parts.find((part) => part.type === "hour")?.value ?? "0") * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const start = minutesOf(quietHours.start);
  const end = minutesOf(quietHours.end);
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function validActionProfile(value: unknown): HandoffActionProfile | null {
  if (!value || typeof value !== "object") return null;
  const profile = value as Record<string, unknown>;
  if (!HANDOFF_AUTHORITY_LEVELS.includes(profile.level as HandoffAuthorityLevel) || !boundedList(profile.capabilities)) return null;
  return { level: profile.level as HandoffAuthorityLevel, capabilities: [...new Set(profile.capabilities.map((item) => item.trim()))] };
}

/** True when `grant` is no wider than `profile`: a level at or below it, and a capability subset. */
export function handoffAuthorityWithin(grant: HandoffActionProfile, profile: HandoffActionProfile): boolean {
  const rank = (level: HandoffAuthorityLevel): number => HANDOFF_AUTHORITY_LEVELS.indexOf(level);
  return rank(grant.level) <= rank(profile.level) && grant.capabilities.every((capability) => profile.capabilities.includes(capability));
}

function actorInScope(actorScope: HandoffActorScope | undefined, scope: HandoffScope): boolean {
  return Boolean(actorScope && actorScope.principals.includes(scope.principal) && actorScope.repositories.includes(scope.repository));
}

function liveClaim(handoff: HumanHandoff, now: number): HandoffClaim | null {
  return handoff.claim && Date.parse(handoff.claim.leaseExpiresAt) > now ? handoff.claim : null;
}

function withReceipt(
  handoff: HumanHandoff,
  draft: Omit<HandoffReceipt, "receiptId" | "handoffId" | "at">,
  now: number,
  patch: Partial<HumanHandoff>,
): HandoffResult {
  if (handoff.receipts.length >= MAX_RECEIPTS) return refuse("receipt_budget_exhausted", `handoff ${handoff.handoffId} already carries ${MAX_RECEIPTS} receipts`);
  const receipt: HandoffReceipt = {
    receiptId: `${handoff.handoffId}#${handoff.receipts.length + 1}:${draft.kind}`,
    handoffId: handoff.handoffId,
    at: isoOf(now),
    ...draft,
  };
  return { ok: true, changed: true, handoff: { ...handoff, ...patch, receipts: [...handoff.receipts, receipt] }, receipt };
}

function unchanged(handoff: HumanHandoff, receipt: HandoffReceipt): HandoffResult {
  return { ok: true, changed: false, handoff, receipt };
}

function lastReceipt(handoff: HumanHandoff, kind: HandoffReceiptKind): HandoffReceipt | undefined {
  return [...handoff.receipts].reverse().find((receipt) => receipt.kind === kind);
}

/** Validate an input and mint an open, unclaimed handoff with its `created` receipt. */
export function createHumanHandoff(value: unknown, now: number): HandoffResult {
  if (!value || typeof value !== "object") return refuse("invalid", "handoff input must be an object");
  const input = value as Record<string, unknown>;
  for (const field of ["handoffId", "reason", "sourceReceipt", "requiredDecision", "createdBy"] as const) {
    if (!bounded(input[field], field === "handoffId" || field === "sourceReceipt" ? MAX_ID : MAX_TEXT)) return refuse("invalid", `${field} is required`);
  }
  const scope = input.scope as Record<string, unknown> | undefined;
  if (!scope || !bounded(scope.principal, MAX_ID) || !bounded(scope.repository, MAX_ID)) return refuse("invalid", "scope.principal and scope.repository are required");
  if (!HANDOFF_PRIORITIES.includes(input.priority as HandoffPriority)) return refuse("invalid", "priority must be low, normal, high, or urgent");
  if (!iso(input.responseDeadline) || Date.parse(input.responseDeadline) <= now) return refuse("invalid", "responseDeadline must be a future timestamp");
  const policy = input.escalationPolicy as Record<string, unknown> | undefined;
  if (!policy || !Number.isInteger(policy.afterMs) || Number(policy.afterMs) <= 0 || !boundedList(policy.chain) || policy.chain.length === 0) {
    return refuse("invalid", "escalationPolicy needs a positive afterMs and a non-empty chain");
  }
  const quietHours = input.quietHours === undefined ? undefined : validQuietHours(input.quietHours);
  if (quietHours === null) return refuse("invalid", "quietHours needs a valid timezone and HH:MM start/end");
  if (input.freshness !== "verified" && input.freshness !== "stale" && input.freshness !== "unavailable") return refuse("invalid", "freshness must be verified, stale, or unavailable");
  const actionProfile = validActionProfile(input.actionProfile);
  if (!actionProfile) return refuse("invalid", "actionProfile needs a known level and a bounded capability list");
  const handoffId = String(input.handoffId).trim();
  const at = isoOf(now);
  const handoff: HumanHandoff = {
    version: HUMAN_HANDOFF_VERSION,
    handoffId,
    reason: String(input.reason).trim(),
    sourceReceipt: String(input.sourceReceipt).trim(),
    requiredDecision: String(input.requiredDecision).trim(),
    scope: { principal: String(scope.principal).trim(), repository: String(scope.repository).trim() },
    priority: input.priority as HandoffPriority,
    responseDeadline: isoOf(Date.parse(input.responseDeadline)),
    escalationPolicy: { afterMs: Number(policy.afterMs), chain: policy.chain.map((item) => item.trim()) },
    ...(quietHours ? { quietHours } : {}),
    freshness: input.freshness,
    actionProfile,
    createdBy: String(input.createdBy).trim(),
    createdAt: at,
    freshAt: at,
    claim: null,
    escalationLevel: 0,
    grantedAuthority: actionProfile,
    deliveries: 0,
    closure: null,
    receipts: [],
  };
  return withReceipt(handoff, { kind: "created", actor: handoff.createdBy, detail: `needs a human: ${handoff.reason}`, linkedReceipt: handoff.sourceReceipt }, now, {});
}

/** Classify an open or closed handoff at `now`. The states are mutually exclusive; {@link HandoffAssessment.overdue} is orthogonal. */
export function assessHumanHandoff(handoff: HumanHandoff, now: number): HandoffAssessment {
  const live = liveClaim(handoff, now);
  const ownerState = live ? "claimed" : handoff.claim ? "claim_expired" : "unclaimed";
  const ageMs = Math.max(0, now - Date.parse(handoff.createdAt));
  const msToDeadline = Date.parse(handoff.responseDeadline) - now;
  // Measured from the last time the item was offered to someone new, so each chain entry gets its own window.
  const offeredAt = [...handoff.receipts].reverse().find((receipt) => receipt.kind === "escalated" || receipt.kind === "reassigned")?.at ?? handoff.createdAt;
  const escalationDue = !handoff.closure && !live && now - Date.parse(offeredAt) >= handoff.escalationPolicy.afterMs;
  const quiet = inHandoffQuietHours(now, handoff.quietHours);
  let state: HandoffState;
  if (handoff.closure) state = "closed";
  else if (handoff.freshness === "unavailable") state = "unavailable";
  else if (msToDeadline <= 0) state = "expired";
  else if (live) state = "claimed";
  else if (quiet) state = "quiet_hours";
  else if (handoff.escalationLevel > 0) state = "escalated";
  else if (escalationDue) state = "aging";
  else state = "unclaimed";
  return {
    handoffId: handoff.handoffId,
    state,
    ownerState,
    ...(live ? { owner: live.owner } : {}),
    ...(handoff.assignee ? { assignee: handoff.assignee } : {}),
    priority: handoff.priority,
    freshness: handoff.freshness,
    ageMs,
    msToDeadline,
    escalationLevel: handoff.escalationLevel,
    escalationDue,
    overdue: escalationDue || (!handoff.closure && msToDeadline <= 0),
    inQuietHours: quiet,
  };
}

/** Open items first-overdue, then by priority, then oldest — so nothing overdue sorts below a fresh item. */
export function humanHandoffQueue(handoffs: readonly HumanHandoff[], now: number): HandoffAssessment[] {
  const rank = (priority: HandoffPriority): number => HANDOFF_PRIORITIES.indexOf(priority);
  return handoffs
    .filter((handoff) => !handoff.closure)
    .map((handoff) => assessHumanHandoff(handoff, now))
    .sort((left, right) => Number(right.overdue) - Number(left.overdue) || rank(right.priority) - rank(left.priority) || right.ageMs - left.ageMs || left.handoffId.localeCompare(right.handoffId));
}

/** Claim an open handoff for `claimant` under a bounded lease. Re-claiming one's own live claim is a no-op. */
export function claimHumanHandoff(
  handoff: HumanHandoff,
  input: { claimant: string; claimantScope: HandoffActorScope; idempotencyKey: string; leaseMs: number },
  now: number,
): HandoffResult {
  if (handoff.closure) return refuse("closed", `handoff ${handoff.handoffId} is already ${handoff.closure.outcome}`);
  if (!bounded(input.claimant, MAX_ID) || !bounded(input.idempotencyKey, MAX_ID)) return refuse("invalid", "claimant and idempotencyKey are required");
  if (!Number.isInteger(input.leaseMs) || input.leaseMs < MIN_CLAIM_LEASE_MS || input.leaseMs > MAX_CLAIM_LEASE_MS) {
    return refuse("invalid", `leaseMs must be between ${MIN_CLAIM_LEASE_MS} and ${MAX_CLAIM_LEASE_MS}`);
  }
  if (!actorInScope(input.claimantScope, handoff.scope)) return refuse("out_of_scope", `${input.claimant} may not act for ${handoff.scope.principal} in ${handoff.scope.repository}`);
  const reused = handoff.receipts.find((receipt) => receipt.kind === "claimed" && receipt.idempotencyKey === input.idempotencyKey);
  if (reused && reused.actor !== input.claimant) return refuse("idempotency_conflict", `idempotency key ${input.idempotencyKey} belongs to ${reused.actor}`);
  const live = liveClaim(handoff, now);
  if (live && live.owner === input.claimant) return unchanged(handoff, lastReceipt(handoff, "claimed")!);
  if (live) return refuse("claimed_by_other", `handoff ${handoff.handoffId} is claimed by ${live.owner} until ${live.leaseExpiresAt}`);
  if (reused) return refuse("idempotency_conflict", `idempotency key ${input.idempotencyKey} already backed an earlier, now-lapsed claim`);
  if (handoff.assignee && handoff.assignee !== input.claimant) return refuse("assigned_to_other", `handoff ${handoff.handoffId} is assigned to ${handoff.assignee}`);
  const leaseExpiresAt = isoOf(Math.min(now + input.leaseMs, Date.parse(handoff.responseDeadline)));
  const claim: HandoffClaim = { owner: input.claimant.trim(), claimId: `${handoff.handoffId}:claim:${handoff.receipts.length + 1}`, idempotencyKey: input.idempotencyKey, claimedAt: isoOf(now), leaseExpiresAt };
  return withReceipt(handoff, { kind: "claimed", actor: claim.owner, detail: `claimed until ${leaseExpiresAt}`, idempotencyKey: input.idempotencyKey }, now, { claim });
}

/** Return an item whose claim lease lapsed to the bounded unclaimed state, with a receipt. A no-op when no lapsed claim exists. */
export function releaseExpiredHandoffClaim(handoff: HumanHandoff, now: number): HandoffResult {
  if (!handoff.claim || liveClaim(handoff, now)) return unchanged(handoff, handoff.receipts[handoff.receipts.length - 1]);
  const lapsed = handoff.claim;
  return withReceipt(
    handoff,
    { kind: "claim_released", actor: "system", detail: `claim by ${lapsed.owner} lapsed at ${lapsed.leaseExpiresAt}; returned to unclaimed`, linkedReceipt: lapsed.claimId },
    now,
    { claim: null },
  );
}

/** Reassign to `to`, backed by a linked receipt. The prior claim is cleared; `to` must claim it. */
export function reassignHumanHandoff(
  handoff: HumanHandoff,
  input: { actor: string; actorScope: HandoffActorScope; to: string; toScope: HandoffActorScope; linkedReceipt: string; grant?: HandoffActionProfile },
  now: number,
): HandoffResult {
  if (handoff.closure) return refuse("closed", `handoff ${handoff.handoffId} is already ${handoff.closure.outcome}`);
  if (!bounded(input.linkedReceipt, MAX_ID)) return refuse("receipt_required", "a reassignment needs a linked receipt");
  if (!bounded(input.to, MAX_ID) || !bounded(input.actor, MAX_ID)) return refuse("invalid", "actor and to are required");
  if (!actorInScope(input.actorScope, handoff.scope) || !actorInScope(input.toScope, handoff.scope)) return refuse("out_of_scope", `reassignment must stay inside ${handoff.scope.principal}/${handoff.scope.repository}`);
  const grant = input.grant ?? handoff.grantedAuthority;
  if (!handoffAuthorityWithin(grant, handoff.actionProfile)) return refuse("authority_widening", "a reassignment may not grant more than the original action profile");
  const prior = lastReceipt(handoff, "reassigned");
  if (prior && prior.linkedReceipt === input.linkedReceipt && handoff.assignee === input.to) return unchanged(handoff, prior);
  const live = liveClaim(handoff, now);
  if (live && live.owner !== input.actor) return refuse("claimed_by_other", `only ${live.owner} may hand off a live claim`);
  return withReceipt(handoff, { kind: "reassigned", actor: input.actor, detail: `reassigned to ${input.to}`, linkedReceipt: input.linkedReceipt }, now, { claim: null, assignee: input.to.trim(), grantedAuthority: grant });
}

/** Escalate an overdue, unowned item to the next chain entry, backed by a linked receipt. Never widens authority. */
export function escalateHumanHandoff(handoff: HumanHandoff, input: { actor: string; linkedReceipt: string; grant?: HandoffActionProfile }, now: number): HandoffResult {
  if (handoff.closure) return refuse("closed", `handoff ${handoff.handoffId} is already ${handoff.closure.outcome}`);
  if (!bounded(input.linkedReceipt, MAX_ID)) return refuse("receipt_required", "an escalation needs a linked receipt");
  const prior = lastReceipt(handoff, "escalated");
  if (prior && prior.linkedReceipt === input.linkedReceipt) return unchanged(handoff, prior);
  const grant = input.grant ?? handoff.grantedAuthority;
  if (!handoffAuthorityWithin(grant, handoff.actionProfile)) return refuse("authority_widening", "an escalation may not grant more than the original action profile");
  const assessment = assessHumanHandoff(handoff, now);
  if (!assessment.escalationDue) return refuse("not_due", `handoff ${handoff.handoffId} is not yet due to escalate`);
  if (assessment.inQuietHours && handoff.priority !== "urgent") return refuse("quiet_hours", "quiet hours defer a non-urgent escalation");
  const target = handoff.escalationPolicy.chain[handoff.escalationLevel];
  if (!target) return refuse("escalation_exhausted", `escalation chain of ${handoff.escalationPolicy.chain.length} is exhausted`);
  return withReceipt(
    handoff,
    { kind: "escalated", actor: input.actor, detail: `escalated to ${target} (level ${handoff.escalationLevel + 1})`, linkedReceipt: input.linkedReceipt },
    now,
    { claim: null, assignee: target, escalationLevel: handoff.escalationLevel + 1, grantedAuthority: grant },
  );
}

/** Record that the item reached a human. Delivery is a receipt, never a closure: the item stays open. */
export function recordHumanHandoffDelivery(handoff: HumanHandoff, input: { channel: string; actor: string }, now: number): HandoffResult {
  if (handoff.closure) return refuse("closed", `handoff ${handoff.handoffId} is already ${handoff.closure.outcome}`);
  if (!bounded(input.channel, MAX_ID)) return refuse("invalid", "channel is required");
  return withReceipt(handoff, { kind: "delivered", actor: input.actor, detail: `delivered via ${input.channel}; awaiting a decision` }, now, { deliveries: handoff.deliveries + 1 });
}

/** Refresh the source freshness that every assessment reads. */
export function refreshHumanHandoffFreshness(handoff: HumanHandoff, input: { freshness: HandoffFreshness; actor: string; linkedReceipt: string }, now: number): HandoffResult {
  if (!bounded(input.linkedReceipt, MAX_ID)) return refuse("receipt_required", "a freshness change needs a linked receipt");
  return withReceipt(handoff, { kind: "freshness", actor: input.actor, detail: `source is ${input.freshness}`, linkedReceipt: input.linkedReceipt }, now, { freshness: input.freshness, freshAt: isoOf(now) });
}

/** Whether `actor` may do the handoff's work now. Only a LIVE claim on an open, fresh, in-deadline item authorizes. */
export function authorizeHumanHandoffWork(
  handoff: HumanHandoff,
  actor: string,
  now: number,
): { authorized: true; authority: HandoffActionProfile; claimId: string } | { authorized: false; reason: string; state: HandoffState } {
  const assessment = assessHumanHandoff(handoff, now);
  const deny = (reason: string) => ({ authorized: false as const, reason, state: assessment.state });
  if (handoff.closure) return deny(`handoff is closed as ${handoff.closure.outcome}`);
  if (assessment.state === "unavailable" || handoff.freshness !== "verified") return deny(`source evidence is ${handoff.freshness}`);
  if (assessment.state === "expired") return deny("response deadline has passed");
  if (assessment.ownerState === "claim_expired") return deny(`claim lease expired at ${handoff.claim!.leaseExpiresAt}`);
  const live = liveClaim(handoff, now);
  if (!live) return deny("handoff is unclaimed");
  if (live.owner !== actor) return deny(`handoff is claimed by ${live.owner}`);
  return { authorized: true, authority: handoff.grantedAuthority, claimId: live.claimId };
}

/** Close with a named outcome. A human decision needs a live claim; an action outcome needs its authoritative receipt. */
export function closeHumanHandoff(
  handoff: HumanHandoff,
  input: { outcome: string; actor: string; decision?: string; authoritativeOutcome?: string; supersededBy?: string },
  now: number,
): HandoffResult {
  if (!HANDOFF_CLOSURE_OUTCOMES.includes(input.outcome as HandoffClosureOutcome)) {
    return refuse("delivery_is_not_closure", `"${input.outcome}" is not a closure outcome; delivery or acknowledgement leaves the handoff open`);
  }
  const outcome = input.outcome as HandoffClosureOutcome;
  if (handoff.closure) {
    if (handoff.closure.outcome === outcome && handoff.closure.decision === input.decision) return unchanged(handoff, lastReceipt(handoff, "closed")!);
    return refuse("closed", `handoff ${handoff.handoffId} is already ${handoff.closure.outcome}`);
  }
  const human = outcome === "answered" || outcome === "action_accepted" || outcome === "action_refused";
  if (human) {
    const authorization = authorizeHumanHandoffWork(handoff, input.actor, now);
    if (!authorization.authorized) return refuse("claim_required", `a human decision needs ${input.actor}'s live claim: ${authorization.reason}`);
    if (!bounded(input.decision)) return refuse("decision_required", `${outcome} needs the human decision`);
  }
  if ((outcome === "action_accepted" || outcome === "action_refused" || outcome === "unavailable") && !bounded(input.authoritativeOutcome, MAX_ID)) {
    return refuse("outcome_required", `${outcome} needs the authoritative outcome receipt`);
  }
  if (outcome === "expired" && Date.parse(handoff.responseDeadline) > now) return refuse("not_expired", `deadline ${handoff.responseDeadline} has not passed`);
  if (outcome === "superseded" && !bounded(input.supersededBy, MAX_ID)) return refuse("receipt_required", "superseded needs the superseding receipt");
  const receiptId = `${handoff.handoffId}#${handoff.receipts.length + 1}:closed`;
  const closure: HandoffClosure = {
    outcome,
    decidedBy: input.actor,
    ...(bounded(input.decision) ? { decision: input.decision.trim() } : {}),
    ...(bounded(input.authoritativeOutcome, MAX_ID) ? { authoritativeOutcome: input.authoritativeOutcome.trim() } : {}),
    ...(bounded(input.supersededBy, MAX_ID) ? { supersededBy: input.supersededBy.trim() } : {}),
    closedAt: isoOf(now),
    receiptId,
  };
  const linkedReceipt = closure.authoritativeOutcome ?? closure.supersededBy;
  return withReceipt(handoff, { kind: "closed", actor: input.actor, detail: `closed as ${outcome}`, ...(linkedReceipt ? { linkedReceipt } : {}) }, now, { claim: null, closure });
}

/** Append the handoff's snapshot with the receipt that produced it. The newest snapshot per id is the state. */
export function appendHumanHandoff(deps: HumanHandoffLedgerContext, handoff: HumanHandoff, receipt: HandoffReceipt): void {
  appendLedger(deps.ledgerPath, {
    run_id: `HANDOFF-${receipt.receiptId}`,
    task_id: handoff.handoffId,
    step: HUMAN_HANDOFF_LEDGER_STEP,
    handoff_id: handoff.handoffId,
    receipt,
    handoff,
    ...(deps.origin ? { origin: deps.origin } : {}),
  });
}

/** Fold the durable handoffs from every ledger rotation. `complete: false` names an unread rotation, so a partial queue is never read as a whole one. */
export function readHumanHandoffs(ledgerPath: string): { handoffs: HumanHandoff[]; complete: boolean } {
  const read = readLedgerUnionRecordsSync(dirname(ledgerPath), { step: [HUMAN_HANDOFF_LEDGER_STEP], refuseIncomplete: true });
  const latest = new Map<string, HumanHandoff>();
  for (const row of read.rows) {
    const handoff = row.handoff as HumanHandoff | undefined;
    if (row.step !== HUMAN_HANDOFF_LEDGER_STEP || !handoff || handoff.version !== HUMAN_HANDOFF_VERSION || !bounded(handoff.handoffId, MAX_ID)) continue;
    const prior = latest.get(handoff.handoffId);
    if (!prior || handoff.receipts.length >= prior.receipts.length) latest.set(handoff.handoffId, handoff);
  }
  return { handoffs: [...latest.values()], complete: read.ok };
}
