import { createHash } from "node:crypto";

export interface ContributionActor { id?: number; type?: string; login?: string }
export interface ContributionRepository { id?: number; fullName?: string }
export interface ContributionOrigin {
  actor?: ContributionActor | null;
  headRepository?: ContributionRepository | null;
  targetRepository?: ContributionRepository | null;
  association?: string;
}
export interface RestContributionOrigin {
  user?: ContributionActor | null;
  head?: { repo?: { id?: number; full_name?: string } | null };
  base?: { repo?: { id?: number; full_name?: string } | null };
  author_association?: string;
}
export type AdmissionAction = "review" | "repair" | "auto-merge" | "feedback";
export interface AdmissionPolicy {
  version: string;
  ownerIds: readonly number[];
  organizationIds: readonly number[];
  services: readonly { id: number; actions: readonly AdmissionAction[] }[];
  maxEvidenceAgeMs: number;
}
export interface AdmissionSubject {
  repositoryId: number;
  prNumber: number;
  headSha: string;
  observedAtMs: number;
  origin?: ContributionOrigin;
}
export interface MembershipEvidence {
  actorId: number;
  organizationId: number;
  state: "member" | "not-member" | "unknown";
  observedAtMs: number;
}
export interface AdmissionDecision {
  outcome: "trusted" | "confirmed-external" | "unknown";
  reason: string;
  receiptKey: string;
}

/** Authenticated REST evidence only. An absent field stays absent; a deleted repo stays null.
 * No login, association, branch or target namespace is an authority grant. */
export function contributionOriginFromRest(row: RestContributionOrigin): ContributionOrigin | undefined {
  const origin: ContributionOrigin = {};
  if (row.user !== undefined) origin.actor = row.user === null ? null : {
    id: row.user.id, type: row.user.type, login: row.user.login,
  };
  const repository = (r: { id?: number; full_name?: string } | null): ContributionRepository | null =>
    r === null ? null : { id: r.id, fullName: r.full_name };
  if (row.head?.repo !== undefined) origin.headRepository = repository(row.head.repo);
  if (row.base?.repo !== undefined) origin.targetRepository = repository(row.base.repo);
  if (row.author_association !== undefined) origin.association = row.author_association;
  return Object.keys(origin).length === 0 ? undefined : origin;
}

const validId = (id: number | undefined): id is number => Number.isSafeInteger(id) && (id ?? 0) > 0;
const fresh = (observed: number, now: number, age: number): boolean =>
  Number.isFinite(observed) && observed >= 0 && observed <= now && now - observed <= age;

/** Pure evaluation, not an authorization token or an effect. Callers must supply an explicit
 * policy and authenticated, fresh API evidence; action-time enforcement is a separate task.
 * A receipt fingerprints what was evaluated, never permits replay on another head or policy. */
export function classifyContribution(
  subject: AdmissionSubject, action: AdmissionAction, policy: AdmissionPolicy,
  memberships: readonly MembershipEvidence[], nowMs: number,
): AdmissionDecision {
  const decision = (outcome: AdmissionDecision["outcome"], reason: string): AdmissionDecision => ({
    outcome, reason,
    receiptKey: createHash("sha256").update(JSON.stringify([subject, action, policy, memberships, outcome, reason])).digest("hex"),
  });
  if (!policy.version.trim() || !Number.isFinite(policy.maxEvidenceAgeMs) || policy.maxEvidenceAgeMs < 0
    || policy.ownerIds.length === 0 || !policy.ownerIds.every(validId) || !policy.organizationIds.every(validId)
    || !policy.services.every((service) => validId(service.id))) return decision("unknown", "invalid-policy");
  if (!Number.isFinite(nowMs) || nowMs < 0 || !validId(subject.repositoryId) || !validId(subject.prNumber)
    || !/^[a-f0-9]{40}$/i.test(subject.headSha)) return decision("unknown", "invalid-context");
  if (!fresh(subject.observedAtMs, nowMs, policy.maxEvidenceAgeMs)) return decision("unknown", "stale-origin");
  const origin = subject.origin;
  const actor = origin?.actor;
  if (!validId(actor?.id) || (actor?.type !== "User" && actor?.type !== "Bot")
    || !validId(origin?.headRepository?.id) || origin?.targetRepository?.id !== subject.repositoryId) {
    return decision("unknown", "incomplete-origin");
  }
  if (actor.type === "User" && policy.ownerIds.includes(actor.id)) return decision("trusted", "owner");
  if (actor.type === "Bot") {
    const grants = policy.services.filter((service) => service.id === actor.id);
    if (grants.some((service) => service.actions.includes(action))) return decision("trusted", "scoped-service");
    // A known bot outside its action scope is NOT an external contribution to close.
    return grants.length > 0 ? decision("unknown", "service-out-of-scope") : decision("confirmed-external", "unlisted-service");
  }
  let unresolved = false;
  let member = false;
  for (const organizationId of policy.organizationIds) {
    const rows = memberships.filter((e) => e.actorId === actor.id && e.organizationId === organizationId
      && fresh(e.observedAtMs, nowMs, policy.maxEvidenceAgeMs));
    const newest = Math.max(...rows.map((e) => e.observedAtMs));
    const states = new Set(rows.filter((e) => e.observedAtMs === newest).map((e) => e.state));
    if (states.size !== 1) {
      unresolved = true;
      continue;
    }
    if (states.has("member")) member = true;
    else if (!states.has("not-member")) unresolved = true;
  }
  if (member) return decision("trusted", "organization-member");
  return unresolved ? decision("unknown", "membership-unresolved") : decision("confirmed-external", "not-admitted");
}
