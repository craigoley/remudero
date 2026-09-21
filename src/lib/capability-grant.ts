/**
 * src/lib/capability-grant.ts — W1-T3880: USE CAPABILITIES WITHOUT EXPOSING SECRETS.
 *
 * A capability grant is a scoped, short-lived, non-secret `id` a provider or host adapter
 * resolves to a real credential/operation at the LAST RESPONSIBLE MOMENT — the same sentinel
 * shape `secret-boundary.ts` (W1-T2699) proved for the model bearer and git token, generalised
 * to a credential this repo does not yet hold at all. {@link CapabilityGrant} has no field a
 * secret could hide in; see it and {@link verifyCapabilityGrant} for the two load-bearing
 * invariants (no-secret-on-the-type, store-resolved-never-caller-supplied).
 *
 * FALSIFIER: put a secret in a grant/receipt/verification/request field (there is none to put it
 * in), accept a grant after expiry or revocation, replay a nonce, exceed a `useLimit`, or let a
 * request built from untrusted content widen what {@link verifyCapabilityGrant} accepts. See
 * test/capability-grant-{scope,secrets,replay,content,receipts}.test.ts.
 */

import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.js";

/** Named once so a grant's own `schema` field and every doc reference to it can never drift. */
export const CAPABILITY_GRANT_SCHEMA_VERSION = "capability-grant-v1" as const;

/** An operation name, e.g. `"email.read"`, `"browser.click"`, `"payment.charge"`. Matched by
 *  EXACT string equality only — see the module header's capability-ladder note. */
export type CapabilityOperation = string;

/** Repository or instance the grant is scoped to. Both optional: a grant may be scoped by
 *  neither, either, or both, depending on what the target identity already narrows. */
export interface CapabilityGrantScope {
  readonly repo?: string;
  readonly instance?: string;
}

/** Who approved this grant, and when — never a value, always an identity plus a timestamp. */
export interface CapabilityApprovalReceipt {
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly reason?: string;
}

/** Field names an outcome record must have {@link applyRedactionPolicy} mask before it reaches
 *  the model, the browser payload, the ledger, or an ordinary log. */
export interface CapabilityRedactionPolicy {
  readonly redactFields: readonly string[];
}

/**
 * A `capability-grant-v1` grant. STRUCTURALLY carries no secret value — see the module header.
 * Every instance this module hands out is deep-frozen ({@link createCapabilityGrant}), so holding
 * a reference to one is never a path to widening it.
 */
export interface CapabilityGrant {
  readonly schema: typeof CAPABILITY_GRANT_SCHEMA_VERSION;
  /** The non-secret grant REFERENCE. This is what the model, the browser payload and the ledger
   *  ever see — never the credential or operation result it stands for. */
  readonly id: string;
  /** The identity the resolved secret acts as/against, e.g. `"github-app:acme/widgets"` or
   *  `"browser-session:checkout"` — itself never a secret, only a label. */
  readonly targetIdentity: string;
  /** The operation allowlist. A request's operation must EXACTLY match one entry. */
  readonly operations: readonly CapabilityOperation[];
  readonly scope: CapabilityGrantScope;
  /** Which caller/provider this grant was issued to; a request from any other audience is
   *  refused even if every other field matches. */
  readonly audience: string;
  /** ISO-8601 instant. A request at or after this instant is refused as expired. */
  readonly expiresAt: string;
  /** How many successful uses this grant permits. `1` is a one-time grant. */
  readonly useLimit: number;
  readonly approval: CapabilityApprovalReceipt;
  readonly redaction: CapabilityRedactionPolicy;
  /** An opaque reference the operator revokes THROUGH — never a secret itself. */
  readonly revocationLink: string;
}

/** The caller-supplied shape {@link createCapabilityGrant} validates and freezes into a
 *  {@link CapabilityGrant}. `id` and `useLimit` default when omitted. */
export interface CapabilityGrantInput {
  id?: string;
  targetIdentity: string;
  operations: readonly string[];
  scope?: CapabilityGrantScope;
  audience: string;
  expiresAt: string;
  useLimit?: number;
  approval: CapabilityApprovalReceipt;
  redaction?: CapabilityRedactionPolicy;
  revocationLink: string;
}

/** Recursively freezes `value` and every own-property it holds. Used ONLY on values this module
 *  itself constructs (never on a caller-supplied object it does not own), so freezing can never
 *  surprise a caller that still holds a mutable reference elsewhere. */
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
 * Validates a grant input and returns a deep-frozen {@link CapabilityGrant}. Throws a plain,
 * human-readable `Error` (never an `RmdError` — construction happens outside any process-boundary
 * catch this repo already unifies exit codes through) on any missing or malformed required field:
 * an incomplete grant is a programming mistake at the ISSUER, refused before it can be stored.
 */
export function createCapabilityGrant(input: CapabilityGrantInput): CapabilityGrant {
  if (!input.targetIdentity) throw new Error("capability grant requires a non-empty targetIdentity");
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new Error("capability grant requires a non-empty operations allowlist");
  }
  if (input.operations.some((op) => typeof op !== "string" || op.length === 0)) {
    throw new Error("capability grant operations must be non-empty strings");
  }
  if (!input.audience) throw new Error("capability grant requires a non-empty audience");
  if (!input.expiresAt || Number.isNaN(Date.parse(input.expiresAt))) {
    throw new Error("capability grant requires a valid ISO-8601 expiresAt");
  }
  if (!input.approval || !input.approval.approvedBy || !input.approval.approvedAt) {
    throw new Error("capability grant requires an approval receipt (approvedBy and approvedAt)");
  }
  if (Number.isNaN(Date.parse(input.approval.approvedAt))) {
    throw new Error("capability grant approval.approvedAt must be a valid ISO-8601 instant");
  }
  if (!input.revocationLink) throw new Error("capability grant requires a non-empty revocationLink");
  const useLimit = input.useLimit ?? 1;
  if (!Number.isInteger(useLimit) || useLimit < 1) {
    throw new Error("capability grant useLimit must be a positive integer");
  }
  const grant: CapabilityGrant = {
    schema: CAPABILITY_GRANT_SCHEMA_VERSION,
    id: input.id && input.id.length > 0 ? input.id : `cap-${randomUUID()}`,
    targetIdentity: input.targetIdentity,
    operations: [...input.operations],
    scope: { ...(input.scope ?? {}) },
    audience: input.audience,
    expiresAt: input.expiresAt,
    useLimit,
    approval: { ...input.approval },
    redaction: { redactFields: [...(input.redaction?.redactFields ?? [])] },
    revocationLink: input.revocationLink,
  };
  return deepFreeze(grant);
}

/**
 * A requested USE of a grant, built ONLY from fields the caller trusts structurally — this type
 * has no field a document, an email, a page or tool OUTPUT can be assigned into by this module;
 * a caller that builds one FROM untrusted content has done so entirely outside this file's own
 * surface, and {@link verifyCapabilityGrant} enforces the grant's real allowlist/target/audience
 * regardless of how any individual field was produced.
 */
export interface CapabilityUseRequest {
  readonly grantId: string;
  readonly operation: string;
  readonly target: string;
  readonly audience: string;
  /** Unique per attempt. Reusing one against the same grant is a replay, refused whether or not
   *  the grant's use limit is otherwise exhausted. */
  readonly nonce: string;
}

/** Every reason {@link verifyCapabilityGrant} can refuse a request for. Closed union so a new
 *  refusal reason is a reviewable one-line addition here, never a free-text guess at a call site. */
export type CapabilityRefusalCode =
  | "unknown-grant"
  | "expired"
  | "revoked"
  | "wrong-audience"
  | "wrong-target"
  | "operation-not-granted"
  | "use-limit-exceeded"
  | "replayed-nonce";

/** `ok: true` carries the canonical (store-resolved) grant and how many uses remain AFTER this
 *  one; `ok: false` carries a machine-readable `code` plus a human `reason`. No third state. */
export type CapabilityVerification =
  | { readonly ok: true; readonly grant: CapabilityGrant; readonly remainingUses: number }
  | { readonly ok: false; readonly code: CapabilityRefusalCode; readonly reason: string };

/** Read-only + mutation surface {@link verifyCapabilityGrant}/{@link useCapabilityGrant} need.
 *  `resolveSecret` is deliberately SEPARATE from every other method: neither of those two
 *  functions ever calls it, so a real secret is resolved only by a caller that has already
 *  verified the grant and is about to use it — see {@link InMemoryCapabilityGrantStore}. */
export interface CapabilityGrantStore {
  get(id: string): CapabilityGrant | undefined;
  isRevoked(id: string): boolean;
  useCount(id: string): number;
  hasSeenNonce(id: string, nonce: string): boolean;
  /** Marks one successful use: increments the use count and remembers the nonce. Callers MUST
   *  call this only after {@link verifyCapabilityGrant} returned `ok: true` for the same request —
   *  {@link useCapabilityGrant} is the one call site inside this module that does. */
  record(id: string, nonce: string): void;
  /** Resolves the REAL value behind a grant reference, or `undefined` if none is registered.
   *  Never called by {@link verifyCapabilityGrant} or {@link useCapabilityGrant} — see the module
   *  header. A provider/host adapter calls this itself, only after its own verified use. */
  resolveSecret(id: string): string | undefined;
}

/** Reads the real secret behind a grant id fresh, per call — never a captured string — so a
 *  rotated credential is honoured without re-issuing the grant. Mirrors
 *  `BoundaryDestination.realValue` in secret-boundary.ts. */
export type CapabilitySecretResolver = (grantId: string) => string | undefined;

/**
 * The reference in-memory implementation of {@link CapabilityGrantStore}. Production wiring is a
 * follow-on concern (this task ships the boundary, not a persistence layer); a test constructs
 * one directly and a real host adapter is free to implement the interface over durable storage
 * instead.
 */
export class InMemoryCapabilityGrantStore implements CapabilityGrantStore {
  private readonly grants = new Map<string, CapabilityGrant>();
  private readonly revoked = new Set<string>();
  private readonly uses = new Map<string, number>();
  private readonly nonces = new Map<string, Set<string>>();
  private readonly secrets = new Map<string, CapabilitySecretResolver>();

  /** Registers a grant an issuer has already built with {@link createCapabilityGrant}. The
   *  optional resolver is the ONLY place a real secret value ever enters this store, and it is
   *  held as a thunk, never invoked here. */
  issue(grant: CapabilityGrant, resolveSecret?: CapabilitySecretResolver): void {
    this.grants.set(grant.id, grant);
    if (resolveSecret) this.secrets.set(grant.id, resolveSecret);
  }

  /** Revokes a grant by id. Idempotent; revoking an unknown id is a no-op. */
  revoke(id: string): void {
    this.revoked.add(id);
  }

  get(id: string): CapabilityGrant | undefined {
    return this.grants.get(id);
  }

  isRevoked(id: string): boolean {
    return this.revoked.has(id);
  }

  useCount(id: string): number {
    return this.uses.get(id) ?? 0;
  }

  hasSeenNonce(id: string, nonce: string): boolean {
    return this.nonces.get(id)?.has(nonce) ?? false;
  }

  record(id: string, nonce: string): void {
    this.uses.set(id, this.useCount(id) + 1);
    const seen = this.nonces.get(id) ?? new Set<string>();
    seen.add(nonce);
    this.nonces.set(id, seen);
  }

  resolveSecret(id: string): string | undefined {
    return this.secrets.get(id)?.(id);
  }
}

/**
 * Verifies a requested USE against the CANONICAL grant, resolved from `store` by
 * `request.grantId` — never from any field the caller passes in, so a request built (even
 * carelessly) from untrusted content has no path to substitute a wider grant. Pure with respect
 * to `store`'s read methods; does not call {@link CapabilityGrantStore.record} or
 * {@link CapabilityGrantStore.resolveSecret} — see {@link useCapabilityGrant} for the call that
 * consumes a verified grant, and the module header for why secret resolution is separate again.
 */
export function verifyCapabilityGrant(
  store: CapabilityGrantStore,
  request: CapabilityUseRequest,
  opts: { now?: string | number } = {},
): CapabilityVerification {
  const grant = store.get(request.grantId);
  if (!grant) {
    return {
      ok: false,
      code: "unknown-grant",
      reason: `no capability grant is on file for reference ${JSON.stringify(request.grantId)}`,
    };
  }
  if (store.isRevoked(grant.id)) {
    return { ok: false, code: "revoked", reason: `capability grant ${grant.id} has been revoked` };
  }
  const nowMs = typeof opts.now === "number" ? opts.now : Date.parse(typeof opts.now === "string" ? opts.now : new Date().toISOString());
  if (Number.isNaN(nowMs) || nowMs >= Date.parse(grant.expiresAt)) {
    return { ok: false, code: "expired", reason: `capability grant ${grant.id} expired at ${grant.expiresAt}` };
  }
  if (request.audience !== grant.audience) {
    return {
      ok: false,
      code: "wrong-audience",
      reason: `capability grant ${grant.id} is scoped to audience ${JSON.stringify(grant.audience)}, not ${JSON.stringify(request.audience)}`,
    };
  }
  if (request.target !== grant.targetIdentity) {
    return {
      ok: false,
      code: "wrong-target",
      reason: `capability grant ${grant.id} is scoped to target ${JSON.stringify(grant.targetIdentity)}, not ${JSON.stringify(request.target)}`,
    };
  }
  // EXACT MEMBERSHIP ONLY. Never `startsWith`/`includes` against a single joined string: either
  // would let an operation that merely CONTAINS an allowed name (e.g. "email.read.and.forward"
  // against an allowlist of ["email.read"]) ride the allowed entry through. See module header.
  if (!grant.operations.includes(request.operation)) {
    return {
      ok: false,
      code: "operation-not-granted",
      reason: `operation ${JSON.stringify(request.operation)} is not in grant ${grant.id}'s allowlist (${grant.operations.join(", ")})`,
    };
  }
  if (store.hasSeenNonce(grant.id, request.nonce)) {
    return {
      ok: false,
      code: "replayed-nonce",
      reason: `nonce ${JSON.stringify(request.nonce)} has already been used against grant ${grant.id}`,
    };
  }
  const used = store.useCount(grant.id);
  if (used >= grant.useLimit) {
    return {
      ok: false,
      code: "use-limit-exceeded",
      reason: `capability grant ${grant.id} has exhausted its ${grant.useLimit}-use limit`,
    };
  }
  return { ok: true, grant, remainingUses: grant.useLimit - used - 1 };
}

/** A successful use and a refused use both produce ONE of these — bounded (every text field is
 *  capped, see {@link boundedText}) and attributable (grant id, operation and audience always
 *  present), never a secret and never an unbounded echo of caller/content input. */
export interface CapabilityReceipt {
  readonly grantId: string;
  readonly operation: string;
  readonly audience: string;
  readonly requestedAt: string;
  readonly outcome: "used" | "refused";
  readonly code?: CapabilityRefusalCode;
  readonly reason: string;
  readonly remainingUses?: number;
}

/** Caps on every free-text {@link CapabilityReceipt} field, so a receipt stays a small, bounded
 *  record regardless of how long an attacker-influenced `grantId`/`operation`/`audience` or a
 *  refusal's derived `reason` happens to be. Named constants, not inlined, so a test can assert
 *  against the SAME bound this module enforces. */
export const CAPABILITY_RECEIPT_FIELD_MAX_CHARS = 200;
export const CAPABILITY_RECEIPT_REASON_MAX_CHARS = 240;

function boundedText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Verifies `request` and, ONLY on success, records the use ({@link CapabilityGrantStore.record})
 * so a subsequent replay or an over-limit reuse is refused. Returns the {@link
 * CapabilityVerification} alongside a bounded, attributable {@link CapabilityReceipt} for either
 * outcome — a refused request records a receipt too, and never touches `store.record` or
 * `store.resolveSecret`.
 */
export function useCapabilityGrant(
  store: CapabilityGrantStore,
  request: CapabilityUseRequest,
  opts: { now?: string | number; clock?: Pick<Clock, "iso"> } = {},
): { readonly verification: CapabilityVerification; readonly receipt: CapabilityReceipt } {
  const requestedAt = opts.clock
    ? opts.clock.iso()
    : new Date(typeof opts.now === "number" ? opts.now : (opts.now ?? Date.now())).toISOString();
  const verification = verifyCapabilityGrant(store, request, opts);
  const grantId = boundedText(request.grantId, CAPABILITY_RECEIPT_FIELD_MAX_CHARS);
  const operation = boundedText(request.operation, CAPABILITY_RECEIPT_FIELD_MAX_CHARS);
  const audience = boundedText(request.audience, CAPABILITY_RECEIPT_FIELD_MAX_CHARS);
  if (!verification.ok) {
    return {
      verification,
      receipt: {
        grantId,
        operation,
        audience,
        requestedAt,
        outcome: "refused",
        code: verification.code,
        reason: boundedText(verification.reason, CAPABILITY_RECEIPT_REASON_MAX_CHARS),
      },
    };
  }
  store.record(request.grantId, request.nonce);
  return {
    verification,
    receipt: {
      grantId,
      operation,
      audience,
      requestedAt,
      outcome: "used",
      reason: "capability grant verified and consumed",
      remainingUses: verification.remainingUses,
    },
  };
}

/** The fixed placeholder every redacted field is replaced with — one literal, so a reader (and a
 *  test) never has to guess whether a masked value is this module's own mask or coincidentally
 *  matches attacker content. */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Applies `policy.redactFields` to a plain record, replacing each present field's value with
 * {@link REDACTED_PLACEHOLDER} — the "redacted outcome" the model, browser payload and ordinary
 * logs receive per the module header. Every OTHER field passes through unchanged; a field the
 * policy names that is absent from `record` is left absent, never invented.
 */
export function applyRedactionPolicy(
  policy: CapabilityRedactionPolicy,
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  for (const field of policy.redactFields) {
    if (field in out) out[field] = REDACTED_PLACEHOLDER;
  }
  return out;
}
