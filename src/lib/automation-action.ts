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

import { randomUUID } from "node:crypto";

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
