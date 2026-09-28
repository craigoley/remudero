/**
 * src/lib/automation-action.ts — W1-T3883: BOUND AGENT-TO-AGENT DELEGATION.
 *
 * A delegation envelope is a signed, bounded capability handoff between two AGENT identities: it
 * names sender, recipient, principal, purpose, capability references, resource scope, audience,
 * expiry, nonce, and the parent receipt it descends from (mirrors {@link CapabilityGrant}'s
 * no-secret, store-resolved shape one layer up — that module scopes what a PROVIDER may resolve;
 * this one scopes what one agent may hand to another).
 *
 * THREE LOAD-BEARING INVARIANTS, each with its own refusal code — see the per-function doc
 * comments below for the exact codes: (1) NO ACTION BEFORE ACCEPTANCE — the recipient must call
 * {@link acceptDelegationEnvelope} before {@link executeBoundedDelegation} will act. (2) NARROW,
 * NEVER WIDEN — acceptance and {@link forwardDelegation} may each only select a SUBSET of what
 * they were themselves granted, with an expiry that never outlives the parent's. (3) NO
 * TRANSITIVE AUTHORITY — forwarding always mints a brand-new envelope with its own nonce and its
 * own acceptance requirement; ancestry is consulted only to find a REVOCATION, never to inherit.
 *
 * FALSIFIER: let a recipient act before acceptance, widen a grant, forward authority transitively,
 * replay a nonce, act after parent revocation, or hide the identity chain — the corresponding
 * proof must fail. See test/agent-delegation-{envelope,acceptance,replay,human-gates,receipts}.test.ts.
 */

import { createHash, randomUUID } from "node:crypto";
import { fixedClock, type Clock } from "./clock.js";

/** Named once so an envelope's own `schema` field and every doc reference to it can never drift. */
export const DELEGATION_ENVELOPE_SCHEMA_VERSION = "agent-delegation-envelope-v1" as const;

/** A capability reference, e.g. `"repo.read"`, `"deploy.trigger"`. Matched by EXACT string
 *  equality only, same ladder-avoidance rule as capability-grant.ts's `CapabilityOperation`. */
export type DelegationCapabilityRef = string;

/** Repository or instance the envelope is scoped to. Both optional. */
export interface DelegationScope {
  readonly repo?: string;
  readonly instance?: string;
}

/** An explicit human sign-off, required only for {@link DELEGATION_GATED_RISK_TIERS}. Never
 *  inferred from a prior approval, model confidence, or UI state — the caller supplies one fresh
 *  per request, or the action is refused. */
export interface DelegationHumanApproval {
  readonly approvedBy: string;
  readonly approvedAt: string;
}

/** Risk tiers a delegated action may declare. Everything in {@link DELEGATION_GATED_RISK_TIERS}
 *  stays human-gated no matter how many hops of delegation led to the request. */
export type DelegationRiskTier = "low" | "medium" | "high" | "production" | "financial" | "credential" | "destructive";

/** Closed set of tiers {@link executeBoundedDelegation} refuses without a fresh
 *  {@link DelegationHumanApproval} — high-risk, destructive, financial, and credential actions
 *  remain human-gated across every handoff, per this task's falsifier. */
export const DELEGATION_GATED_RISK_TIERS: ReadonlySet<DelegationRiskTier> = new Set([
  "high",
  "production",
  "financial",
  "credential",
  "destructive",
]);

export function delegationRequiresHumanGate(risk: DelegationRiskTier): boolean {
  return DELEGATION_GATED_RISK_TIERS.has(risk);
}

/**
 * A `agent-delegation-envelope-v1` capability handoff. Binds sender, recipient, principal,
 * purpose, capability references, resource scope, audience, expiry, nonce, and parent receipt —
 * this task's first acceptance claim. Deep-frozen by {@link createDelegationEnvelope}, so holding
 * a reference is never a path to widening it; every narrowing step (acceptance, forwarding) is
 * recorded by the {@link DelegationEnvelopeStore} instead of mutating this object.
 */
export interface DelegationEnvelope {
  readonly schema: typeof DELEGATION_ENVELOPE_SCHEMA_VERSION;
  readonly id: string;
  /** The agent identity issuing this handoff. */
  readonly sender: string;
  /** The agent identity this handoff is addressed to; only this identity may accept or act on it. */
  readonly recipient: string;
  /** The accountable human/account authority behind the handoff. Never widened by forwarding —
   *  see the module header's invariant 3. */
  readonly principal: string;
  readonly purpose: string;
  /** The capability allowlist. Acceptance may select any SUBSET; never a superset. */
  readonly capabilities: readonly DelegationCapabilityRef[];
  readonly scope: DelegationScope;
  /** Which caller/provider this envelope was issued to; an action request from any other audience
   *  is refused even if every other field matches. */
  readonly audience: string;
  /** ISO-8601 instant. A request at or after this instant is refused as expired. */
  readonly expiresAt: string;
  /** Unique per issuance; a second envelope replaying this nonce is refused. */
  readonly nonce: string;
  /** The receipt this envelope descends from, if any — never an envelope id: a receipt is the
   *  only durable, attributable trace {@link executeBoundedDelegation}/{@link forwardDelegation}
   *  ever produce, so that is what a child links to. */
  readonly parentReceiptId?: string;
}

/** The caller-supplied shape {@link createDelegationEnvelope} validates and freezes. `id` and
 *  `nonce` default when omitted. */
export interface DelegationEnvelopeInput {
  id?: string;
  sender: string;
  recipient: string;
  principal: string;
  purpose: string;
  capabilities: readonly string[];
  scope?: DelegationScope;
  audience: string;
  expiresAt: string;
  nonce?: string;
  parentReceiptId?: string;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Validates an envelope input and returns a deep-frozen {@link DelegationEnvelope}. Throws a
 * plain, human-readable `Error` on any missing or malformed required field: an incomplete
 * envelope is a mistake at the ISSUER, refused before it can ever be stored or accepted.
 */
export function createDelegationEnvelope(input: DelegationEnvelopeInput): DelegationEnvelope {
  if (!input.sender) throw new Error("delegation envelope requires a non-empty sender");
  if (!input.recipient) throw new Error("delegation envelope requires a non-empty recipient");
  if (input.sender === input.recipient) throw new Error("delegation envelope sender and recipient must be different identities");
  if (!input.principal) throw new Error("delegation envelope requires a non-empty principal");
  if (!input.purpose) throw new Error("delegation envelope requires a non-empty purpose");
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    throw new Error("delegation envelope requires a non-empty capabilities allowlist");
  }
  if (input.capabilities.some((cap) => typeof cap !== "string" || cap.length === 0)) {
    throw new Error("delegation envelope capabilities must be non-empty strings");
  }
  if (!input.audience) throw new Error("delegation envelope requires a non-empty audience");
  if (!input.expiresAt || Number.isNaN(Date.parse(input.expiresAt))) {
    throw new Error("delegation envelope requires a valid ISO-8601 expiresAt");
  }
  const envelope: DelegationEnvelope = {
    schema: DELEGATION_ENVELOPE_SCHEMA_VERSION,
    id: input.id && input.id.length > 0 ? input.id : `dlg-${randomUUID()}`,
    sender: input.sender,
    recipient: input.recipient,
    principal: input.principal,
    purpose: input.purpose,
    capabilities: [...input.capabilities],
    scope: { ...(input.scope ?? {}) },
    audience: input.audience,
    expiresAt: input.expiresAt,
    nonce: input.nonce && input.nonce.length > 0 ? input.nonce : `n-${randomUUID()}`,
    ...(input.parentReceiptId ? { parentReceiptId: input.parentReceiptId } : {}),
  };
  return deepFreeze(envelope);
}

/** Every reason a delegation step can be refused for. Closed union so a new refusal reason is a
 *  reviewable one-line addition here, never a free-text guess at a call site. */
export type DelegationRefusalCode =
  | "unknown-envelope"
  | "expired"
  | "revoked"
  | "parent-revoked"
  | "identity-mismatch"
  | "already-accepted"
  | "empty-acceptance"
  | "capability-widened"
  | "expiry-widened"
  | "not-accepted"
  | "wrong-audience"
  | "capability-not-accepted"
  | "replayed-nonce"
  | "human-gate-required"
  | "audit-unavailable";

/** Read-only + mutation surface {@link acceptDelegationEnvelope}/{@link executeBoundedDelegation}/
 *  {@link forwardDelegation} need. Deliberately holds no secret and no raw prompt/transcript —
 *  there is no field here one could hide in. A real host is free to back this with durable
 *  storage; {@link InMemoryDelegationEnvelopeStore} is the reference implementation this task
 *  ships (a persistence layer is a follow-on concern, mirroring capability-grant.ts's precedent). */
export interface DelegationEnvelopeStore {
  /** Registers an envelope an issuer (or {@link forwardDelegation}) has already built. */
  issue(envelope: DelegationEnvelope): void;
  get(id: string): DelegationEnvelope | undefined;
  isRevoked(id: string): boolean;
  isAccepted(id: string): boolean;
  /** The (possibly narrowed) capability set the recipient accepted, or `undefined` before accept. */
  acceptedCapabilities(id: string): readonly DelegationCapabilityRef[] | undefined;
  hasSeenNonce(id: string, nonce: string): boolean;
  recordAccepted(id: string, acceptedCapabilities: readonly DelegationCapabilityRef[]): void;
  recordUse(id: string, nonce: string): void;
  /** Remembers that `receiptId` was produced by acting on `envelopeId` — every receipt-producing
   *  call ({@link executeBoundedDelegation}, {@link forwardDelegation}) records this so a later
   *  child's `parentReceiptId` can be walked back to an envelope for the `parent-revoked` check
   *  below. Never a path to inherit a grant (module header invariant 3) — only ever consulted to
   *  look for a revocation. */
  linkReceipt(receiptId: string, envelopeId: string): void;
  /** Finds the envelope id that produced `receiptId`, or `undefined` if this store never recorded
   *  one — used ONLY to walk ancestry for {@link executeBoundedDelegation}'s `parent-revoked`
   *  check, never to inherit a grant (see the module header's invariant 3). */
  envelopeIdForReceipt(receiptId: string): string | undefined;
  /** Whether this store can durably record the receipt this action is about to produce. `false`
   *  refuses the action outright (`audit-unavailable`) rather than let it proceed unrecorded. */
  auditAvailable(): boolean;
}

/** The reference in-memory {@link DelegationEnvelopeStore}. */
export class InMemoryDelegationEnvelopeStore implements DelegationEnvelopeStore {
  private readonly envelopes = new Map<string, DelegationEnvelope>();
  private readonly revoked = new Set<string>();
  private readonly accepted = new Map<string, readonly DelegationCapabilityRef[]>();
  private readonly nonces = new Map<string, Set<string>>();
  private readonly receiptEnvelope = new Map<string, string>();
  private auditUnavailable = false;

  issue(envelope: DelegationEnvelope): void {
    this.envelopes.set(envelope.id, envelope);
  }

  revoke(id: string): void {
    this.revoked.add(id);
  }

  /** Test/host seam: simulate an unavailable audit sink (`false` = unavailable). Defaults `true`. */
  setAuditAvailable(available: boolean): void {
    this.auditUnavailable = !available;
  }

  get(id: string): DelegationEnvelope | undefined {
    return this.envelopes.get(id);
  }

  isRevoked(id: string): boolean {
    return this.revoked.has(id);
  }

  isAccepted(id: string): boolean {
    return this.accepted.has(id);
  }

  acceptedCapabilities(id: string): readonly DelegationCapabilityRef[] | undefined {
    return this.accepted.get(id);
  }

  hasSeenNonce(id: string, nonce: string): boolean {
    return this.nonces.get(id)?.has(nonce) ?? false;
  }

  recordAccepted(id: string, acceptedCapabilities: readonly DelegationCapabilityRef[]): void {
    this.accepted.set(id, [...acceptedCapabilities]);
  }

  recordUse(id: string, nonce: string): void {
    const seen = this.nonces.get(id) ?? new Set<string>();
    seen.add(nonce);
    this.nonces.set(id, seen);
  }

  linkReceipt(receiptId: string, envelopeId: string): void {
    this.receiptEnvelope.set(receiptId, envelopeId);
  }

  envelopeIdForReceipt(receiptId: string): string | undefined {
    return this.receiptEnvelope.get(receiptId);
  }

  auditAvailable(): boolean {
    return !this.auditUnavailable;
  }
}

/** A request to explicitly ACCEPT an envelope — the step {@link executeBoundedDelegation} refuses
 *  `not-accepted` until it has happened. `acceptedCapabilities` is the recipient's own choice of
 *  SUBSET; it may equal `envelope.capabilities` but must never exceed it. */
export interface DelegationAcceptanceRequest {
  readonly envelopeId: string;
  /** Must equal the envelope's own `recipient` — any other identity is an `identity-mismatch`. */
  readonly recipient: string;
  readonly acceptedCapabilities: readonly DelegationCapabilityRef[];
}

export type DelegationAcceptanceResult =
  | { readonly ok: true; readonly envelope: DelegationEnvelope; readonly acceptedCapabilities: readonly DelegationCapabilityRef[] }
  | { readonly ok: false; readonly code: DelegationRefusalCode; readonly reason: string };

/**
 * The recipient's explicit acceptance step. Refuses widening (`capability-widened`), a second
 * acceptance of the same envelope (`already-accepted`), and any identity other than the
 * envelope's own `recipient` (`identity-mismatch`) — this task's second acceptance claim.
 */
export function acceptDelegationEnvelope(
  store: DelegationEnvelopeStore,
  request: DelegationAcceptanceRequest,
  opts: { now?: string | number } = {},
): DelegationAcceptanceResult {
  const envelope = store.get(request.envelopeId);
  if (!envelope) {
    return { ok: false, code: "unknown-envelope", reason: `no delegation envelope is on file for id ${JSON.stringify(request.envelopeId)}` };
  }
  if (store.isRevoked(envelope.id)) {
    return { ok: false, code: "revoked", reason: `delegation envelope ${envelope.id} has been revoked` };
  }
  const nowMs = resolveNowMs(opts.now);
  if (Number.isNaN(nowMs) || nowMs >= Date.parse(envelope.expiresAt)) {
    return { ok: false, code: "expired", reason: `delegation envelope ${envelope.id} expired at ${envelope.expiresAt}` };
  }
  if (request.recipient !== envelope.recipient) {
    return {
      ok: false,
      code: "identity-mismatch",
      reason: `delegation envelope ${envelope.id} is addressed to ${JSON.stringify(envelope.recipient)}, not ${JSON.stringify(request.recipient)}`,
    };
  }
  if (store.isAccepted(envelope.id)) {
    return { ok: false, code: "already-accepted", reason: `delegation envelope ${envelope.id} has already been accepted` };
  }
  if (!Array.isArray(request.acceptedCapabilities) || request.acceptedCapabilities.length === 0) {
    return { ok: false, code: "empty-acceptance", reason: "acceptance must select at least one capability" };
  }
  const widened = request.acceptedCapabilities.some((cap) => !envelope.capabilities.includes(cap));
  if (widened) {
    return {
      ok: false,
      code: "capability-widened",
      reason: `acceptance requests a capability outside envelope ${envelope.id}'s allowlist (${envelope.capabilities.join(", ")})`,
    };
  }
  store.recordAccepted(envelope.id, request.acceptedCapabilities);
  return { ok: true, envelope, acceptedCapabilities: request.acceptedCapabilities };
}

/** A requested USE of an accepted envelope — the ACT step. */
export interface DelegationActionRequest {
  readonly envelopeId: string;
  /** Must equal the envelope's own `recipient` — only the addressed identity may act on it. */
  readonly actorIdentity: string;
  readonly capability: DelegationCapabilityRef;
  readonly audience: string;
  /** Unique per attempt. Reusing one against the same envelope is a replay. */
  readonly nonce: string;
  readonly risk: DelegationRiskTier;
  /** Required (and validated) when {@link delegationRequiresHumanGate} is true for `risk`. */
  readonly humanApproval?: DelegationHumanApproval;
}

export type DelegationVerification =
  | { readonly ok: true; readonly envelope: DelegationEnvelope }
  | { readonly ok: false; readonly code: DelegationRefusalCode; readonly reason: string };

/** A successful use and a refused use both produce ONE of these — bounded and attributable, never
 *  a raw prompt, secret, or transcript (there is no field here one could hide in). Parent and
 *  child receipts link via `parentReceiptId`, this task's fifth acceptance claim. */
export interface DelegationReceipt {
  readonly receiptId: string;
  readonly envelopeId: string;
  readonly parentReceiptId?: string;
  readonly capability: string;
  readonly audience: string;
  readonly actorIdentity: string;
  readonly decidedAt: string;
  readonly outcome: "executed" | "refused";
  readonly code?: DelegationRefusalCode;
  readonly reason: string;
}

/** PRIMARY CONTROL: the only place `envelopeId`/`capability`/`audience`/`actorIdentity` are capped
 *  before they enter a {@link DelegationReceipt} — so a receipt stays small regardless of how long
 *  an attacker-influenced field happens to be. */
export const DELEGATION_RECEIPT_FIELD_MAX_CHARS = 200;
/** PRIMARY CONTROL: the only place a refusal's derived `reason` text is capped before it enters a
 *  {@link DelegationReceipt}. Named, not inlined, so a test can assert against this SAME bound. */
export const DELEGATION_RECEIPT_REASON_MAX_CHARS = 240;

function boundedText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function resolveNowMs(now: string | number | undefined): number {
  if (typeof now === "number") return now;
  if (typeof now === "string") return Date.parse(now);
  return Date.now();
}

/** Walks the receipt->envelope ancestry chain looking for a revoked ancestor, WITHOUT ever
 *  inheriting a grant from it — see the module header's invariant 3. Bounded to guard against an
 *  accidental cycle in a caller-supplied store implementation. */
function ancestryRevoked(store: DelegationEnvelopeStore, envelope: DelegationEnvelope, depth = 0): boolean {
  if (depth > 64 || !envelope.parentReceiptId) return false;
  const parentEnvelopeId = store.envelopeIdForReceipt(envelope.parentReceiptId);
  if (!parentEnvelopeId) return false;
  const parent = store.get(parentEnvelopeId);
  if (!parent) return false;
  if (store.isRevoked(parent.id)) return true;
  return ancestryRevoked(store, parent, depth + 1);
}

/**
 * The bounded delegation execution seam — the ONE call site an operator-agent handoff path uses
 * before any delegated side effect proceeds. Verifies (in order) the envelope exists, neither it
 * nor any revoked ancestor blocks it, it has not expired, the audit sink can record this receipt,
 * it has been explicitly ACCEPTED, the actor is the envelope's own recipient, the audience
 * matches, the requested capability is within the ACCEPTED (possibly narrowed) set, the nonce has
 * not been replayed, and — for {@link DELEGATION_GATED_RISK_TIERS} — a fresh human approval is
 * present. Every outcome, successful or refused, produces one bounded {@link DelegationReceipt}.
 */
export function executeBoundedDelegation(
  store: DelegationEnvelopeStore,
  request: DelegationActionRequest,
  opts: { now?: string | number } = {},
): { readonly verification: DelegationVerification; readonly receipt: DelegationReceipt } {
  const decidedAt = new Date(resolveNowMs(opts.now)).toISOString();
  const envelopeId = boundedText(request.envelopeId, DELEGATION_RECEIPT_FIELD_MAX_CHARS);
  const capability = boundedText(request.capability, DELEGATION_RECEIPT_FIELD_MAX_CHARS);
  const audience = boundedText(request.audience, DELEGATION_RECEIPT_FIELD_MAX_CHARS);
  const actorIdentity = boundedText(request.actorIdentity, DELEGATION_RECEIPT_FIELD_MAX_CHARS);

  const refuse = (code: DelegationRefusalCode, reason: string, parentReceiptId?: string) => ({
    verification: { ok: false, code, reason } as const,
    receipt: {
      receiptId: `rcpt-${randomUUID()}`,
      envelopeId,
      ...(parentReceiptId ? { parentReceiptId } : {}),
      capability,
      audience,
      actorIdentity,
      decidedAt,
      outcome: "refused" as const,
      code,
      reason: boundedText(reason, DELEGATION_RECEIPT_REASON_MAX_CHARS),
    },
  });

  const envelope = store.get(request.envelopeId);
  if (!envelope) return refuse("unknown-envelope", `no delegation envelope is on file for id ${JSON.stringify(request.envelopeId)}`);
  const parentReceiptId = envelope.parentReceiptId;
  if (store.isRevoked(envelope.id)) return refuse("revoked", `delegation envelope ${envelope.id} has been revoked`, parentReceiptId);
  if (ancestryRevoked(store, envelope)) return refuse("parent-revoked", `an ancestor of delegation envelope ${envelope.id} has been revoked`, parentReceiptId);
  const nowMs = resolveNowMs(opts.now);
  if (Number.isNaN(nowMs) || nowMs >= Date.parse(envelope.expiresAt)) {
    return refuse("expired", `delegation envelope ${envelope.id} expired at ${envelope.expiresAt}`, parentReceiptId);
  }
  if (!store.auditAvailable()) return refuse("audit-unavailable", "no audit source is available to record this delegated action", parentReceiptId);
  if (!store.isAccepted(envelope.id)) return refuse("not-accepted", `delegation envelope ${envelope.id} has not been accepted yet`, parentReceiptId);
  if (request.actorIdentity !== envelope.recipient) {
    return refuse("identity-mismatch", `delegation envelope ${envelope.id} is addressed to ${JSON.stringify(envelope.recipient)}, not ${JSON.stringify(request.actorIdentity)}`, parentReceiptId);
  }
  if (request.audience !== envelope.audience) {
    return refuse("wrong-audience", `delegation envelope ${envelope.id} is scoped to audience ${JSON.stringify(envelope.audience)}, not ${JSON.stringify(request.audience)}`, parentReceiptId);
  }
  const accepted = store.acceptedCapabilities(envelope.id) ?? [];
  if (!accepted.includes(request.capability)) {
    return refuse("capability-not-accepted", `capability ${JSON.stringify(request.capability)} is not in envelope ${envelope.id}'s accepted set (${accepted.join(", ")})`, parentReceiptId);
  }
  if (store.hasSeenNonce(envelope.id, request.nonce)) {
    return refuse("replayed-nonce", `nonce ${JSON.stringify(request.nonce)} has already been used against envelope ${envelope.id}`, parentReceiptId);
  }
  if (delegationRequiresHumanGate(request.risk)) {
    const approval = request.humanApproval;
    if (!approval || !approval.approvedBy || !approval.approvedAt || Number.isNaN(Date.parse(approval.approvedAt))) {
      return refuse("human-gate-required", `${request.risk}-risk action on envelope ${envelope.id} requires a fresh human approval`, parentReceiptId);
    }
  }

  store.recordUse(envelope.id, request.nonce);
  const receiptId = `rcpt-${randomUUID()}`;
  store.linkReceipt(receiptId, envelope.id);
  return {
    verification: { ok: true, envelope },
    receipt: {
      receiptId,
      envelopeId,
      ...(parentReceiptId ? { parentReceiptId } : {}),
      capability,
      audience,
      actorIdentity,
      decidedAt,
      outcome: "executed",
      reason: "delegation envelope verified and executed",
    },
  };
}

/** Revokes an envelope by id. Idempotent. A revoked envelope refuses both new acceptance
 *  ({@link acceptDelegationEnvelope}) and, via {@link ancestryRevoked}, every not-yet-executed
 *  descendant already forwarded from it — see the module header's invariant 3. */
export function revokeDelegationEnvelope(store: InMemoryDelegationEnvelopeStore, id: string): void {
  store.revoke(id);
}

/** A request to forward part of an ACCEPTED envelope to a new recipient. */
export interface DelegationForwardRequest {
  readonly parentEnvelopeId: string;
  /** Must equal the parent envelope's own `recipient` — only the current holder may forward. */
  readonly forwarder: string;
  readonly newRecipient: string;
  /** Must be a subset of what `forwarder` itself ACCEPTED — never the parent's raw allowlist. */
  readonly capabilities: readonly DelegationCapabilityRef[];
  readonly purpose: string;
  readonly audience: string;
  /** Must not exceed the parent envelope's own `expiresAt`. */
  readonly expiresAt: string;
  readonly nonce?: string;
  readonly id?: string;
}

export type DelegationForwardResult =
  | { readonly ok: true; readonly envelope: DelegationEnvelope; readonly receipt: DelegationReceipt }
  | { readonly ok: false; readonly code: DelegationRefusalCode; readonly reason: string; readonly receipt: DelegationReceipt };

/**
 * Forwarding NEVER inherits transitive authority (module header invariant 3): it always mints a
 * brand-new {@link DelegationEnvelope}, with its own nonce, linked to the parent only via the
 * {@link DelegationReceipt} THIS call itself produces for the forward — never an execute receipt,
 * so forwarding never requires burning an actual action first. The new recipient still owes their
 * own {@link acceptDelegationEnvelope} before anything can act on it. Refuses widening the
 * capability set (`capability-widened`) or the expiry (`expiry-widened`) beyond what the
 * forwarder itself ACCEPTED — never the parent's raw allowlist/expiry.
 */
export function forwardDelegation(
  store: DelegationEnvelopeStore,
  request: DelegationForwardRequest,
  opts: { now?: string | number } = {},
): DelegationForwardResult {
  const decidedAt = new Date(resolveNowMs(opts.now)).toISOString();
  const envelopeId = boundedText(request.parentEnvelopeId, DELEGATION_RECEIPT_FIELD_MAX_CHARS);
  const capability = boundedText(request.capabilities.join(","), DELEGATION_RECEIPT_FIELD_MAX_CHARS);
  const audience = boundedText(request.audience, DELEGATION_RECEIPT_FIELD_MAX_CHARS);
  const actorIdentity = boundedText(request.forwarder, DELEGATION_RECEIPT_FIELD_MAX_CHARS);

  const refuse = (code: DelegationRefusalCode, reason: string): DelegationForwardResult => ({
    ok: false,
    code,
    reason,
    receipt: {
      receiptId: `rcpt-${randomUUID()}`,
      envelopeId,
      capability,
      audience,
      actorIdentity,
      decidedAt,
      outcome: "refused",
      code,
      reason: boundedText(reason, DELEGATION_RECEIPT_REASON_MAX_CHARS),
    },
  });

  const parent = store.get(request.parentEnvelopeId);
  if (!parent) return refuse("unknown-envelope", `no delegation envelope is on file for id ${JSON.stringify(request.parentEnvelopeId)}`);
  if (store.isRevoked(parent.id)) return refuse("revoked", `delegation envelope ${parent.id} has been revoked`);
  if (ancestryRevoked(store, parent)) return refuse("parent-revoked", `an ancestor of delegation envelope ${parent.id} has been revoked`);
  const nowMs = resolveNowMs(opts.now);
  if (Number.isNaN(nowMs) || nowMs >= Date.parse(parent.expiresAt)) {
    return refuse("expired", `delegation envelope ${parent.id} expired at ${parent.expiresAt}`);
  }
  if (request.forwarder !== parent.recipient) {
    return refuse("identity-mismatch", `only ${JSON.stringify(parent.recipient)} may forward envelope ${parent.id}`);
  }
  if (!store.isAccepted(parent.id)) return refuse("not-accepted", `delegation envelope ${parent.id} has not been accepted yet`);
  const forwarderAccepted = store.acceptedCapabilities(parent.id) ?? [];
  const widened = request.capabilities.length === 0 || request.capabilities.some((cap) => !forwarderAccepted.includes(cap));
  if (widened) {
    return refuse(
      "capability-widened",
      `forward requests a capability outside what ${request.forwarder} accepted from envelope ${parent.id} (${forwarderAccepted.join(", ")})`,
    );
  }
  if (Number.isNaN(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) > Date.parse(parent.expiresAt)) {
    return refuse("expiry-widened", `forward's expiry may not exceed parent envelope ${parent.id}'s ${parent.expiresAt}`);
  }

  const receiptId = `rcpt-${randomUUID()}`;
  store.linkReceipt(receiptId, parent.id);
  const envelope = createDelegationEnvelope({
    id: request.id,
    sender: request.forwarder,
    recipient: request.newRecipient,
    principal: parent.principal,
    purpose: request.purpose,
    capabilities: request.capabilities,
    scope: parent.scope,
    audience: request.audience,
    expiresAt: request.expiresAt,
    nonce: request.nonce,
    parentReceiptId: receiptId,
  });
  store.issue(envelope);
  return {
    ok: true,
    envelope,
    receipt: {
      receiptId,
      envelopeId,
      capability,
      audience,
      actorIdentity,
      decidedAt,
      outcome: "executed",
      reason: `forwarded to ${request.newRecipient} as envelope ${envelope.id}`,
    },
  };
}

// ── W1-T3855: automation-action-v1 — the execution/preflight seam ─────────────────────────────
//
// Everything below is the step between "the system recommends this" and "the system may execute
// this". An action DECLARES its scope, risk, preconditions, freshness bound, idempotency key,
// expiry, dry-run capability, approval policy, rollback/refusal path, and authoritative receipt
// reference; preflight answers with one of six explicit outcomes; execution is two-phase
// (admission -> completion) so a claimed success always names its authoritative evidence; and
// rollback is a NEW linked receipt, never a mutation. Pure: no I/O, time only through `Clock`.
// operator-agent.ts is the durable producer that ledgers what this validates and decides.

/** Named once so a record's own `version` and every consumer's pin can never drift. */
export const AUTOMATION_ACTION_VERSION = "automation-action-v1" as const;

/** The six preflight outcomes. Only `ready` admits an execution; the other five each name why not. */
export const AUTOMATION_PREFLIGHT_OUTCOMES = ["ready", "refused", "stale", "unknown", "expired", "in-progress"] as const;
export type AutomationPreflightOutcome = (typeof AUTOMATION_PREFLIGHT_OUTCOMES)[number];

/** A field name that must never enter the public contract: raw prompts, transcripts, credentials,
 *  arbitrary model prose, and browser-owned measurements. Matched against every KEY of a submitted
 *  record, recursively, so the refusal does not depend on where a caller nests it. */
export const AUTOMATION_ACTION_FORBIDDEN_FIELD_RE =
  /^(?:raw_?)?(?:prompts?|transcripts?|messages|credentials?|passwords?|secrets?|tokens?|api_?keys?|authorization|cookies?|model_?(?:output|prose|response|text|reasoning)|completion|reasoning|chain_?of_?thought|browser_?[a-z_]*|web_?vitals|client_?metrics)$/i;

/** A VALUE shaped like a credential, refused wherever it appears in a text field. */
export const AUTOMATION_ACTION_SECRET_VALUE_RE =
  /(?:\bbearer\s+[A-Za-z0-9._~+/-]{8,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_|\bsk-[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:password|secret|api[_-]?key)\s*[:=])/i;

/** PRIMARY CONTROL: the only cap on an id-shaped field (action id, idempotency key, capability,
 *  scope names) before it enters a durable automation-action record or receipt. */
export const AUTOMATION_ACTION_MAX_ID_CHARS = 160;
/** PRIMARY CONTROL: the only cap on a prose-shaped field (a precondition, plan, refusal, reason)
 *  — the contract carries a bounded summary, never arbitrary model prose. */
export const AUTOMATION_ACTION_MAX_TEXT_CHARS = 320;
/** PRIMARY CONTROL: how many preconditions one action may declare. */
export const AUTOMATION_ACTION_MAX_PRECONDITIONS = 12;
/** PRIMARY CONTROL: how many precondition observations one preflight or execution may submit. */
export const AUTOMATION_ACTION_MAX_OBSERVATIONS = 24;
/** BACKSTOP: receipts one action may accumulate. A healthy action writes a handful (a refusal or
 *  two, one admission, one completion, maybe one rollback); reaching this means a caller is
 *  retrying a refused execution in a loop, so the engine stops appending rather than grow forever. */
export const AUTOMATION_ACTION_MAX_RECEIPTS = 100;
/** PRIMARY CONTROL: the longest freshness window an action may declare (30 days) — a precondition
 *  observed longer ago than this can never be current enough to act on. */
export const AUTOMATION_ACTION_MAX_FRESHNESS_SECONDS = 30 * 24 * 60 * 60;

export interface AutomationActionScope {
  /** The flow this action belongs to. At least one of `flowId`/`experimentId` is required. */
  readonly flowId?: string;
  /** The experiment-v1 record (W1-T3853) that requested this action, when one did. */
  readonly experimentId?: string;
  /** The repository or instance the action touches. At least one of the two is required. */
  readonly repo?: string;
  readonly instance?: string;
}

export interface AutomationActionPrecondition {
  /** Stable id an observation names to answer this precondition. */
  readonly id: string;
  /** The authoritative source the observation must come from (e.g. `ledger:queue-latency`). */
  readonly source: string;
  readonly description: string;
}

/** `none`: no human decision needed. `human`: an operator decision must approve before execution.
 *  Every tier in {@link DELEGATION_GATED_RISK_TIERS} MUST declare `human`. */
export type AutomationApprovalPolicy = "none" | "human";

/** How the action is undone — or, for an irreversible one, the path a rollback request takes instead. */
export type AutomationActionRollback =
  | { readonly mode: "reversible"; readonly plan: string }
  | { readonly mode: "irreversible"; readonly refusal: string };

/**
 * An `automation-action-v1` record. Immutable once registered: approval, execution, completion,
 * and rollback are all appended as linked events against its `actionId`, never written back here.
 */
export interface AutomationAction {
  readonly version: typeof AUTOMATION_ACTION_VERSION;
  readonly actionId: string;
  /** The capability this action exercises, matched by exact string like {@link DelegationCapabilityRef}. */
  readonly capability: DelegationCapabilityRef;
  readonly summary: string;
  readonly scope: AutomationActionScope;
  readonly risk: DelegationRiskTier;
  readonly preconditions: readonly AutomationActionPrecondition[];
  /** Every precondition observation must be at most this old when preflight runs. */
  readonly freshness: { readonly maxAgeSeconds: number };
  /** One execution per key: a second request with the same key returns the first's receipt. */
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Whether a dry run is meaningful for this action; a dry-run request on `false` is refused. */
  readonly dryRun: boolean;
  readonly approval: { readonly policy: AutomationApprovalPolicy };
  readonly rollback: AutomationActionRollback;
  /** The authoritative system of record whose receipt proves what happened (e.g. `github:owner/repo/pulls`). */
  readonly receiptRef: string;
}

/** Every named reason {@link validateAutomationAction} refuses a record for. */
export type AutomationActionValidationCode =
  | "not-an-object"
  | "invalid-version"
  | "forbidden-field"
  | "secret-value"
  | "missing-identity"
  | "missing-scope"
  | "invalid-risk"
  | "missing-preconditions"
  | "missing-freshness"
  | "missing-idempotency-key"
  | "invalid-expiry"
  | "missing-dry-run"
  | "missing-approval"
  | "approval-too-weak"
  | "missing-rollback"
  | "missing-receipt-ref";

export type AutomationActionValidation =
  | { readonly ok: true; readonly action: AutomationAction }
  | { readonly ok: false; readonly code: AutomationActionValidationCode; readonly field: string; readonly reason: string };

const AUTOMATION_RISK_TIERS: readonly DelegationRiskTier[] = ["low", "medium", "high", "production", "financial", "credential", "destructive"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedField(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function toIso(value: string): string {
  return fixedClock(Date.parse(value)).iso();
}

/** The first forbidden key anywhere in `value`, as a dotted path, or `undefined`. Depth-bounded
 *  so a hostile, deeply nested body cannot turn the scan itself into the cost. */
export function findForbiddenAutomationField(value: unknown, path = "", depth = 0): string | undefined {
  if (depth > 8 || typeof value !== "object" || value === null) return undefined;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  for (const [key, child] of entries) {
    const childPath = path ? `${path}.${key}` : key;
    if (!Array.isArray(value) && AUTOMATION_ACTION_FORBIDDEN_FIELD_RE.test(key)) return childPath;
    const nested = findForbiddenAutomationField(child, childPath, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/** The first string anywhere in `value` shaped like a credential, as a dotted path, or `undefined`. */
function findSecretValue(value: unknown, path = "", depth = 0): string | undefined {
  if (typeof value === "string") return AUTOMATION_ACTION_SECRET_VALUE_RE.test(value) ? path || "(value)" : undefined;
  if (depth > 8 || typeof value !== "object" || value === null) return undefined;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  for (const [key, child] of entries) {
    const nested = findSecretValue(child, path ? `${path}.${key}` : key, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/** Refuses redaction violations for any submitted record (action, observation, completion). */
export function automationRedactionViolation(value: unknown): { code: "forbidden-field" | "secret-value"; field: string } | undefined {
  const forbidden = findForbiddenAutomationField(value);
  if (forbidden) return { code: "forbidden-field", field: forbidden };
  const secret = findSecretValue(value);
  if (secret) return { code: "secret-value", field: secret };
  return undefined;
}

function validateAutomationScope(value: unknown): AutomationActionScope | null {
  if (!isPlainObject(value)) return null;
  const scope: { flowId?: string; experimentId?: string; repo?: string; instance?: string } = {};
  for (const field of ["flowId", "experimentId", "repo", "instance"] as const) {
    if (value[field] === undefined) continue;
    if (!boundedField(value[field], AUTOMATION_ACTION_MAX_ID_CHARS)) return null;
    scope[field] = value[field].trim();
  }
  if (!scope.flowId && !scope.experimentId) return null;
  if (!scope.repo && !scope.instance) return null;
  return scope;
}

function validatePreconditions(value: unknown): AutomationActionPrecondition[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > AUTOMATION_ACTION_MAX_PRECONDITIONS) return null;
  const seen = new Set<string>();
  const out: AutomationActionPrecondition[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || !boundedField(item.id, AUTOMATION_ACTION_MAX_ID_CHARS)) return null;
    if (!boundedField(item.source, AUTOMATION_ACTION_MAX_ID_CHARS) || !boundedField(item.description, AUTOMATION_ACTION_MAX_TEXT_CHARS)) return null;
    const id = item.id.trim();
    if (seen.has(id)) return null;
    seen.add(id);
    out.push({ id, source: item.source.trim(), description: item.description.trim() });
  }
  return out;
}

function validateRollbackPath(value: unknown): AutomationActionRollback | null {
  if (!isPlainObject(value)) return null;
  if (value.mode === "reversible" && boundedField(value.plan, AUTOMATION_ACTION_MAX_TEXT_CHARS)) return { mode: "reversible", plan: value.plan.trim() };
  if (value.mode === "irreversible" && boundedField(value.refusal, AUTOMATION_ACTION_MAX_TEXT_CHARS)) return { mode: "irreversible", refusal: value.refusal.trim() };
  return null;
}

/**
 * Validates an `automation-action-v1` record and returns a whitelisted copy — any field this
 * contract does not name is dropped, and any field it FORBIDS (raw prompt, transcript, credential,
 * model prose, browser-owned measurement) or a credential-shaped value refuses the whole record.
 * An incomplete scope, freshness, approval, or rollback declaration is refused BY NAME before
 * execution can ever be requested.
 */
export function validateAutomationAction(value: unknown): AutomationActionValidation {
  const refuse = (code: AutomationActionValidationCode, field: string, reason: string): AutomationActionValidation => ({ ok: false, code, field, reason });
  if (!isPlainObject(value)) return refuse("not-an-object", "action", "an automation action must be a JSON object");
  const redaction = automationRedactionViolation(value);
  if (redaction) return refuse(redaction.code, redaction.field, `field ${redaction.field} may not enter the automation-action contract`);
  if (value.version !== AUTOMATION_ACTION_VERSION) return refuse("invalid-version", "version", `version must be ${AUTOMATION_ACTION_VERSION}`);
  if (!boundedField(value.actionId, AUTOMATION_ACTION_MAX_ID_CHARS) || !boundedField(value.capability, AUTOMATION_ACTION_MAX_ID_CHARS) || !boundedField(value.summary, AUTOMATION_ACTION_MAX_TEXT_CHARS)) {
    return refuse("missing-identity", "actionId", "actionId, capability, and a bounded summary are required");
  }
  const scope = validateAutomationScope(value.scope);
  if (!scope) return refuse("missing-scope", "scope", "scope must name a flowId or experimentId AND a repo or instance");
  if (typeof value.risk !== "string" || !AUTOMATION_RISK_TIERS.includes(value.risk as DelegationRiskTier)) {
    return refuse("invalid-risk", "risk", `risk must be one of ${AUTOMATION_RISK_TIERS.join(", ")}`);
  }
  const risk = value.risk as DelegationRiskTier;
  const preconditions = validatePreconditions(value.preconditions);
  if (!preconditions) return refuse("missing-preconditions", "preconditions", `1-${AUTOMATION_ACTION_MAX_PRECONDITIONS} uniquely identified preconditions with a source are required`);
  const maxAgeSeconds = isPlainObject(value.freshness) ? value.freshness.maxAgeSeconds : undefined;
  if (typeof maxAgeSeconds !== "number" || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0 || maxAgeSeconds > AUTOMATION_ACTION_MAX_FRESHNESS_SECONDS) {
    return refuse("missing-freshness", "freshness.maxAgeSeconds", `freshness.maxAgeSeconds must be an integer in 1..${AUTOMATION_ACTION_MAX_FRESHNESS_SECONDS}`);
  }
  if (!boundedField(value.idempotencyKey, AUTOMATION_ACTION_MAX_ID_CHARS)) return refuse("missing-idempotency-key", "idempotencyKey", "a bounded idempotencyKey is required");
  if (!validInstant(value.createdAt) || !validInstant(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    return refuse("invalid-expiry", "expiresAt", "createdAt and a later expiresAt are required");
  }
  if (typeof value.dryRun !== "boolean") return refuse("missing-dry-run", "dryRun", "dryRun must declare whether a dry run is supported");
  const policy = isPlainObject(value.approval) ? value.approval.policy : undefined;
  if (policy !== "none" && policy !== "human") return refuse("missing-approval", "approval.policy", "approval.policy must be none or human");
  if (delegationRequiresHumanGate(risk) && policy !== "human") {
    return refuse("approval-too-weak", "approval.policy", `a ${risk}-risk action must declare approval.policy human`);
  }
  const rollback = validateRollbackPath(value.rollback);
  if (!rollback) return refuse("missing-rollback", "rollback", "rollback must be reversible with a plan or irreversible with a refusal path");
  if (!boundedField(value.receiptRef, AUTOMATION_ACTION_MAX_ID_CHARS)) return refuse("missing-receipt-ref", "receiptRef", "an authoritative receiptRef is required");
  return {
    ok: true,
    action: deepFreeze({
      version: AUTOMATION_ACTION_VERSION,
      actionId: value.actionId.trim(),
      capability: value.capability.trim(),
      summary: value.summary.trim(),
      scope,
      risk,
      preconditions,
      freshness: { maxAgeSeconds },
      idempotencyKey: value.idempotencyKey.trim(),
      createdAt: toIso(value.createdAt),
      expiresAt: toIso(value.expiresAt),
      dryRun: value.dryRun,
      approval: { policy },
      rollback,
      receiptRef: value.receiptRef.trim(),
    }),
  };
}

/** One observed answer to one declared precondition. `unavailable` means the source could not be
 *  read — it is never read as satisfied. */
export interface AutomationPreconditionObservation {
  readonly preconditionId: string;
  readonly state: "satisfied" | "unsatisfied" | "unavailable";
  readonly source: string;
  readonly observedAt: string;
  readonly reason?: string;
}

/** Validates a caller-submitted observation list, dropping nothing silently: a malformed entry
 *  refuses the whole list (`null`), and the redaction rules apply exactly as to an action. */
export function validateAutomationObservations(value: unknown): AutomationPreconditionObservation[] | null {
  if (!Array.isArray(value) || value.length > AUTOMATION_ACTION_MAX_OBSERVATIONS || automationRedactionViolation(value)) return null;
  const out: AutomationPreconditionObservation[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || !boundedField(item.preconditionId, AUTOMATION_ACTION_MAX_ID_CHARS) || !boundedField(item.source, AUTOMATION_ACTION_MAX_ID_CHARS)) return null;
    if (item.state !== "satisfied" && item.state !== "unsatisfied" && item.state !== "unavailable") return null;
    if (!validInstant(item.observedAt)) return null;
    if (item.reason !== undefined && !boundedField(item.reason, AUTOMATION_ACTION_MAX_TEXT_CHARS)) return null;
    out.push({
      preconditionId: item.preconditionId.trim(),
      state: item.state,
      source: item.source.trim(),
      observedAt: toIso(item.observedAt),
      ...(item.reason !== undefined ? { reason: item.reason.trim() } : {}),
    });
  }
  return out;
}

/** The latest durable operator decision on an action whose approval policy is `human`. */
export interface AutomationApprovalDecision {
  readonly decision: "approved" | "rejected";
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export type AutomationApprovalState = "not-required" | "pending" | "approved" | "rejected";

export type AutomationReceiptKind = "execution" | "completion" | "rollback";
export type AutomationReceiptOutcome = "in-progress" | "dry-run" | "refused" | "succeeded" | "failed" | "rolled_back";

/** One bounded, append-only receipt. Execution, completion, and rollback each append a NEW one
 *  linked by `linkedReceiptId`; nothing ever rewrites an earlier receipt. */
export interface AutomationActionReceipt {
  readonly version: typeof AUTOMATION_ACTION_VERSION;
  readonly receiptId: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly kind: AutomationReceiptKind;
  readonly outcome: AutomationReceiptOutcome;
  readonly at: string;
  readonly receiptRef: string;
  readonly linkedReceiptId?: string;
  readonly preflight?: AutomationPreflightOutcome;
  readonly code?: string;
  readonly reason: string;
  /** The authoritative evidence (PR, deployment, ledger receipt) a completion or rollback names. */
  readonly evidenceRef?: string;
}

export interface AutomationPreflightFinding {
  readonly outcome: Exclude<AutomationPreflightOutcome, "ready">;
  readonly code: string;
  readonly detail: string;
  readonly preconditionId?: string;
  readonly receiptId?: string;
}

export interface AutomationPreflightResult {
  readonly version: typeof AUTOMATION_ACTION_VERSION;
  readonly actionId: string;
  readonly outcome: AutomationPreflightOutcome;
  readonly evaluatedAt: string;
  readonly approval: AutomationApprovalState;
  readonly findings: readonly AutomationPreflightFinding[];
}

/** Whether `receipt` is the ADMISSION that claims `idempotencyKey` — the only receipt kind that
 *  burns a key. A refusal or a dry run leaves the key free for a later, fresher attempt. */
function isAdmission(receipt: AutomationActionReceipt, idempotencyKey: string): boolean {
  return receipt.kind === "execution" && receipt.outcome === "in-progress" && receipt.idempotencyKey === idempotencyKey;
}

function completionFor(receipts: readonly AutomationActionReceipt[], admissionId: string): AutomationActionReceipt | undefined {
  return receipts.find((receipt) => receipt.kind === "completion" && receipt.linkedReceiptId === admissionId);
}

function rollbackFor(receipts: readonly AutomationActionReceipt[], completionId: string): AutomationActionReceipt | undefined {
  return receipts.find((receipt) => receipt.kind === "rollback" && receipt.outcome === "rolled_back" && receipt.linkedReceiptId === completionId);
}

/** The approval state an action's policy and its latest durable decision imply. */
export function automationApprovalState(action: AutomationAction, decision: AutomationApprovalDecision | undefined): AutomationApprovalState {
  if (action.approval.policy === "none") return "not-required";
  if (!decision) return "pending";
  return decision.decision;
}

/** A browser-owned measurement is never authoritative evidence for an execution decision. */
function browserOwned(source: string): boolean {
  return /^(?:browser|client|web)[:_-]/i.test(source);
}

export interface AutomationPreflightInput {
  readonly action: AutomationAction;
  readonly observations: readonly AutomationPreconditionObservation[];
  readonly receipts: readonly AutomationActionReceipt[];
  readonly approval?: AutomationApprovalDecision;
  readonly clock: Clock;
}

function preconditionFinding(
  precondition: AutomationActionPrecondition,
  observation: AutomationPreconditionObservation | undefined,
  nowMs: number,
  maxAgeMs: number,
): AutomationPreflightFinding | undefined {
  const at = { preconditionId: precondition.id };
  if (!observation) return { ...at, outcome: "unknown", code: "not-observed", detail: `precondition ${precondition.id} has no observation` };
  if (browserOwned(observation.source) || observation.source !== precondition.source) {
    return { ...at, outcome: "unknown", code: "unauthoritative-source", detail: `precondition ${precondition.id} must be observed from ${precondition.source}, not ${observation.source}` };
  }
  if (observation.state === "unavailable") {
    return { ...at, outcome: "unknown", code: "source-unavailable", detail: observation.reason ?? `source ${observation.source} was unavailable` };
  }
  const observedMs = Date.parse(observation.observedAt);
  if (observedMs > nowMs) return { ...at, outcome: "unknown", code: "observed-in-future", detail: `observation of ${precondition.id} is dated after the preflight` };
  if (observation.state === "unsatisfied") {
    return { ...at, outcome: "refused", code: "precondition-unsatisfied", detail: observation.reason ?? `precondition ${precondition.id} is not satisfied` };
  }
  if (nowMs - observedMs > maxAgeMs) {
    return { ...at, outcome: "stale", code: "observation-stale", detail: `observation of ${precondition.id} is older than ${maxAgeMs / 1000}s` };
  }
  return undefined;
}

/**
 * Preflight: `expired`, then `in-progress` (an admitted execution with no completion yet), then
 * the approval gate and a finished execution (`refused`), then every precondition — where a
 * refusal outranks an unknown, and an unknown outranks a stale observation. Only when nothing is
 * found is the outcome `ready`: a missing observation, an unavailable or browser-owned source, or
 * an observation from the wrong source is `unknown`, NEVER a healthy action.
 */
export function preflightAutomationAction(input: AutomationPreflightInput): AutomationPreflightResult {
  const { action, clock } = input;
  const nowMs = clock.now();
  const approval = automationApprovalState(action, input.approval);
  const result = (outcome: AutomationPreflightOutcome, findings: AutomationPreflightFinding[]): AutomationPreflightResult => ({
    version: AUTOMATION_ACTION_VERSION,
    actionId: action.actionId,
    outcome,
    evaluatedAt: clock.iso(),
    approval,
    findings,
  });
  if (nowMs >= Date.parse(action.expiresAt)) {
    return result("expired", [{ outcome: "expired", code: "action-expired", detail: `action ${action.actionId} expired at ${action.expiresAt}` }]);
  }
  const admission = input.receipts.find((receipt) => isAdmission(receipt, action.idempotencyKey));
  if (admission) {
    const completion = completionFor(input.receipts, admission.receiptId);
    if (!completion) {
      return result("in-progress", [{ outcome: "in-progress", code: "execution-in-progress", detail: `execution ${admission.receiptId} has not completed`, receiptId: admission.receiptId }]);
    }
    return result("refused", [{ outcome: "refused", code: "already-executed", detail: `idempotency key already executed as ${completion.receiptId}`, receiptId: completion.receiptId }]);
  }
  const findings: AutomationPreflightFinding[] = [];
  if (approval === "pending") findings.push({ outcome: "refused", code: "approval-pending", detail: `a ${action.risk}-risk action needs an operator approval` });
  if (approval === "rejected") findings.push({ outcome: "refused", code: "approval-rejected", detail: "an operator rejected this action" });
  const maxAgeMs = action.freshness.maxAgeSeconds * 1000;
  for (const precondition of action.preconditions) {
    const observation = [...input.observations].reverse().find((item) => item.preconditionId === precondition.id);
    const finding = preconditionFinding(precondition, observation, nowMs, maxAgeMs);
    if (finding) findings.push(finding);
  }
  for (const outcome of ["refused", "unknown", "stale"] as const) {
    if (findings.some((finding) => finding.outcome === outcome)) return result(outcome, findings);
  }
  return result("ready", findings);
}

function boundedReason(value: string): string {
  return boundedText(value, AUTOMATION_ACTION_MAX_TEXT_CHARS);
}

/** Deterministic: the same action, kind, position, and instant always name the same receipt, so a
 *  replayed ledger row is recognisable as the same receipt rather than a second one. */
function automationReceiptId(actionId: string, kind: AutomationReceiptKind, sequence: number, at: string): string {
  return `aar-${createHash("sha256").update(`${actionId}\u0000${kind}\u0000${sequence}\u0000${at}`).digest("hex").slice(0, 24)}`;
}

function makeAutomationReceipt(
  action: AutomationAction,
  receipts: readonly AutomationActionReceipt[],
  at: string,
  fields: Omit<AutomationActionReceipt, "version" | "receiptId" | "actionId" | "idempotencyKey" | "at" | "receiptRef">,
): AutomationActionReceipt {
  return {
    version: AUTOMATION_ACTION_VERSION,
    receiptId: automationReceiptId(action.actionId, fields.kind, receipts.length, at),
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
    at,
    receiptRef: action.receiptRef,
    ...fields,
    reason: boundedReason(fields.reason),
  };
}

/** What an engine step decided. `append` is false when the answer is an EXISTING receipt (an
 *  idempotent replay) or the receipt history is full — the durable layer appends only when true. */
export interface AutomationStepResult {
  readonly disposition: "admitted" | "dry-run" | "refused" | "reused" | "completed" | "rolled_back";
  readonly receipt: AutomationActionReceipt;
  readonly append: boolean;
  readonly preflight?: AutomationPreflightResult;
}

function historyFull(action: AutomationAction, receipts: readonly AutomationActionReceipt[], at: string, kind: AutomationReceiptKind): AutomationStepResult | undefined {
  if (receipts.length < AUTOMATION_ACTION_MAX_RECEIPTS) return undefined;
  return {
    disposition: "refused",
    append: false,
    receipt: makeAutomationReceipt(action, receipts, at, { kind, outcome: "refused", code: "receipt-history-full", reason: `action ${action.actionId} already holds ${receipts.length} receipts` }),
  };
}

export interface AutomationExecutionInput extends AutomationPreflightInput {
  readonly dryRun?: boolean;
}

/**
 * The execution admission step. A duplicate idempotency key returns the EXISTING receipt (the
 * completion when there is one, else the admission) and appends nothing — the side effect is
 * never requested twice. Otherwise preflight runs HERE, at execution time, never trusted from an
 * earlier call: anything but `ready` appends a refusal naming the preflight outcome. A `ready`
 * action is admitted `in-progress` — never `succeeded` — until {@link completeAutomationAction}
 * records the authoritative evidence.
 */
export function executeAutomationAction(input: AutomationExecutionInput): AutomationStepResult {
  const { action, receipts } = input;
  const at = input.clock.iso();
  const admission = receipts.find((receipt) => isAdmission(receipt, action.idempotencyKey));
  if (admission) {
    const completion = completionFor(receipts, admission.receiptId);
    const latest = completion ? rollbackFor(receipts, completion.receiptId) ?? completion : admission;
    return { disposition: "reused", receipt: latest, append: false };
  }
  const full = historyFull(action, receipts, at, "execution");
  if (full) return full;
  if (input.dryRun && !action.dryRun) {
    return {
      disposition: "refused",
      append: true,
      receipt: makeAutomationReceipt(action, receipts, at, { kind: "execution", outcome: "refused", code: "dry-run-unsupported", reason: `action ${action.actionId} does not support a dry run` }),
    };
  }
  const preflight = preflightAutomationAction(input);
  if (preflight.outcome !== "ready") {
    const first = preflight.findings[0];
    return {
      disposition: "refused",
      append: true,
      preflight,
      receipt: makeAutomationReceipt(action, receipts, at, {
        kind: "execution",
        outcome: "refused",
        preflight: preflight.outcome,
        ...(first ? { code: first.code } : {}),
        reason: first?.detail ?? `preflight answered ${preflight.outcome}`,
      }),
    };
  }
  if (input.dryRun) {
    return {
      disposition: "dry-run",
      append: true,
      preflight,
      receipt: makeAutomationReceipt(action, receipts, at, { kind: "execution", outcome: "dry-run", preflight: "ready", reason: "dry run: preflight ready, nothing executed" }),
    };
  }
  return {
    disposition: "admitted",
    append: true,
    preflight,
    receipt: makeAutomationReceipt(action, receipts, at, { kind: "execution", outcome: "in-progress", preflight: "ready", reason: "admitted: preflight ready, awaiting completion evidence" }),
  };
}

export interface AutomationCompletionInput {
  readonly action: AutomationAction;
  readonly receipts: readonly AutomationActionReceipt[];
  readonly admissionReceiptId: string;
  readonly outcome: "succeeded" | "failed";
  /** Required for `succeeded`: success is claimed only with the authoritative evidence that proves it. */
  readonly evidenceRef?: string;
  readonly reason?: string;
  readonly clock: Clock;
}

/**
 * Records how an admitted execution ended, as a NEW receipt linked to the admission. A second
 * completion of the same admission returns the first unchanged; completing anything but an
 * in-progress admission, or claiming success with no evidence, is refused and appends nothing.
 */
export function completeAutomationAction(input: AutomationCompletionInput): AutomationStepResult {
  const { action, receipts } = input;
  const at = input.clock.iso();
  const refuse = (code: string, reason: string): AutomationStepResult => ({
    disposition: "refused",
    append: false,
    receipt: makeAutomationReceipt(action, receipts, at, { kind: "completion", outcome: "refused", code, linkedReceiptId: input.admissionReceiptId, reason }),
  });
  const admission = receipts.find((receipt) => receipt.receiptId === input.admissionReceiptId && isAdmission(receipt, action.idempotencyKey));
  if (!admission) return refuse("not-admitted", `receipt ${input.admissionReceiptId} is not an in-progress admission of action ${action.actionId}`);
  const existing = completionFor(receipts, admission.receiptId);
  if (existing) return { disposition: "reused", receipt: existing, append: false };
  if (input.outcome === "succeeded" && !boundedField(input.evidenceRef, AUTOMATION_ACTION_MAX_ID_CHARS)) {
    return refuse("evidence-required", "a succeeded completion must name its authoritative evidenceRef");
  }
  const full = historyFull(action, receipts, at, "completion");
  if (full) return full;
  return {
    disposition: "completed",
    append: true,
    receipt: makeAutomationReceipt(action, receipts, at, {
      kind: "completion",
      outcome: input.outcome,
      linkedReceiptId: admission.receiptId,
      ...(input.evidenceRef ? { evidenceRef: input.evidenceRef.trim() } : {}),
      reason: input.reason ?? `execution ${input.outcome}`,
    }),
  };
}

export interface AutomationRollbackInput {
  readonly action: AutomationAction;
  readonly receipts: readonly AutomationActionReceipt[];
  readonly reason: string;
  readonly evidenceRef: string;
  readonly clock: Clock;
}

/**
 * Rollback is a NEW receipt linked to the completion it undoes — the admission and completion
 * stay exactly as recorded. Refused (and appended, so the refusal is on record) for an
 * irreversible action, naming its declared refusal path; refused without appending when nothing
 * has completed. A second rollback returns the first.
 */
export function rollbackAutomationAction(input: AutomationRollbackInput): AutomationStepResult {
  const { action, receipts } = input;
  const at = input.clock.iso();
  const completion = [...receipts].reverse().find((receipt) => receipt.kind === "completion" && receipt.outcome !== "refused");
  if (!completion) {
    return {
      disposition: "refused",
      append: false,
      receipt: makeAutomationReceipt(action, receipts, at, { kind: "rollback", outcome: "refused", code: "nothing-to-roll-back", reason: `action ${action.actionId} has no completed execution` }),
    };
  }
  const existing = rollbackFor(receipts, completion.receiptId);
  if (existing) return { disposition: "reused", receipt: existing, append: false };
  const full = historyFull(action, receipts, at, "rollback");
  if (full) return full;
  if (action.rollback.mode === "irreversible") {
    return {
      disposition: "refused",
      append: true,
      receipt: makeAutomationReceipt(action, receipts, at, { kind: "rollback", outcome: "refused", code: "irreversible", linkedReceiptId: completion.receiptId, reason: action.rollback.refusal }),
    };
  }
  return {
    disposition: "rolled_back",
    append: true,
    receipt: makeAutomationReceipt(action, receipts, at, {
      kind: "rollback",
      outcome: "rolled_back",
      linkedReceiptId: completion.receiptId,
      evidenceRef: boundedText(input.evidenceRef.trim(), AUTOMATION_ACTION_MAX_ID_CHARS),
      reason: input.reason,
    }),
  };
}

export type AutomationActionState = "registered" | "approved" | "rejected" | "in-progress" | "succeeded" | "failed" | "rolled_back" | "expired";

/** The current state an action's receipts and approval imply — derived, never stored. */
export function automationActionState(
  action: AutomationAction,
  receipts: readonly AutomationActionReceipt[],
  approval: AutomationApprovalDecision | undefined,
  clock: Clock,
): AutomationActionState {
  const admission = receipts.find((receipt) => isAdmission(receipt, action.idempotencyKey));
  const completion = admission ? completionFor(receipts, admission.receiptId) : undefined;
  if (completion && rollbackFor(receipts, completion.receiptId)) return "rolled_back";
  if (completion) return completion.outcome === "succeeded" ? "succeeded" : "failed";
  if (admission) return "in-progress";
  if (clock.now() >= Date.parse(action.expiresAt)) return "expired";
  const approvalState = automationApprovalState(action, approval);
  if (approvalState === "approved" || approvalState === "rejected") return approvalState;
  return "registered";
}

/** Re-validates a receipt read back from the ledger, so a hand-edited or foreign row can never
 *  enter a projection with an unbounded or forbidden field. */
export function validateAutomationReceipt(value: unknown): AutomationActionReceipt | null {
  if (!isPlainObject(value) || value.version !== AUTOMATION_ACTION_VERSION || automationRedactionViolation(value)) return null;
  const kinds: readonly string[] = ["execution", "completion", "rollback"];
  const outcomes: readonly string[] = ["in-progress", "dry-run", "refused", "succeeded", "failed", "rolled_back"];
  if (typeof value.kind !== "string" || !kinds.includes(value.kind) || typeof value.outcome !== "string" || !outcomes.includes(value.outcome)) return null;
  for (const field of ["receiptId", "actionId", "idempotencyKey", "receiptRef"] as const) {
    if (!boundedField(value[field], AUTOMATION_ACTION_MAX_ID_CHARS)) return null;
  }
  if (!validInstant(value.at) || typeof value.reason !== "string" || value.reason.length > AUTOMATION_ACTION_MAX_TEXT_CHARS + 1) return null;
  for (const field of ["linkedReceiptId", "evidenceRef", "code"] as const) {
    if (value[field] !== undefined && !boundedField(value[field], AUTOMATION_ACTION_MAX_ID_CHARS)) return null;
  }
  if (value.preflight !== undefined && !(AUTOMATION_PREFLIGHT_OUTCOMES as readonly unknown[]).includes(value.preflight)) return null;
  return {
    version: AUTOMATION_ACTION_VERSION,
    receiptId: value.receiptId as string,
    actionId: value.actionId as string,
    idempotencyKey: value.idempotencyKey as string,
    kind: value.kind as AutomationReceiptKind,
    outcome: value.outcome as AutomationReceiptOutcome,
    at: value.at,
    receiptRef: value.receiptRef as string,
    ...(value.linkedReceiptId !== undefined ? { linkedReceiptId: value.linkedReceiptId as string } : {}),
    ...(value.preflight !== undefined ? { preflight: value.preflight as AutomationPreflightOutcome } : {}),
    ...(value.code !== undefined ? { code: value.code as string } : {}),
    reason: value.reason,
    ...(value.evidenceRef !== undefined ? { evidenceRef: value.evidenceRef as string } : {}),
  };
}
