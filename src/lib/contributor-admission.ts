import { createHash } from "node:crypto";
import { systemClock } from "./clock.js";
import { ghExec, ghTextAsync, splitGhHeaderBlock } from "./github-transport.js";
import { runStepsAsync, runStepsSync, step, type Steps } from "./git-push.js";

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
/** A credential-capable resolver must verify this state: a 403/404 alone does not prove
 * non-membership in a private organization. Unreadable or permission-ambiguous reads are unknown. */
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

export interface AdmissionSettings {
  mode: "shadow";
  repositoryId: number;
  policy: AdmissionPolicy;
  organizations: readonly { id: number; login: string }[];
}
export interface AdmissionTarget { owner: string; repo: string; prNumber: number; headSha?: string }
export interface AdmissionResponse { status: number; body: unknown }
export type AdmissionRead = (path: string) => AdmissionResponse | Promise<AdmissionResponse>;
export type AdmissionObserver = (target: AdmissionTarget, action: AdmissionAction) => Promise<void>;
type AdmissionRecord = (step: string, fields: Record<string, unknown>) => void;

// Positive membership only, policy-scoped and bounded. PR origins and negative/unknown reads
// are NEVER cached; each action re-reads the PR, including after a membership round trip.
const verifiedMembers = new Map<string, MembershipEvidence>();
const ADMISSION_READ_TIMEOUT_MS = 5_000;

function admissionResponse(text: string): AdmissionResponse {
  const { headers, body } = splitGhHeaderBlock(text);
  const status = /^HTTP\/\S+ (\d{3})/m.exec(headers);
  if (!status) return { status: 0, body: undefined };
  try { return { status: Number(status[1]), body: JSON.parse(body) }; }
  catch { return { status: 0, body: undefined }; } // malformed response is unreadable, not a negative identity
}

function failedAdmissionResponse(error: unknown): AdmissionResponse {
  const stdout = (error as { stdout?: unknown } | null)?.stdout;
  // Require the actual response header. An error message containing "404" is not evidence.
  return typeof stdout === "string" || Buffer.isBuffer(stdout)
    ? admissionResponse(String(stdout)) : { status: 0, body: undefined };
}

export function readAdmissionRest(path: string): AdmissionResponse {
  try { return admissionResponse(ghExec(["api", path, "-i"], { encoding: "utf8", timeout: ADMISSION_READ_TIMEOUT_MS, maxBuffer: 1 << 20 })); }
  catch (error) { return failedAdmissionResponse(error); }
}

export async function readAdmissionRestAsync(path: string): Promise<AdmissionResponse> {
  try { return admissionResponse(await ghTextAsync(["api", path, "-i"], { timeout: ADMISSION_READ_TIMEOUT_MS, maxBuffer: 1 << 20 })); }
  catch (error) { return failedAdmissionResponse(error); }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function* contributorAdmissionSteps(
  settings: AdmissionSettings | undefined, target: AdmissionTarget, action: AdmissionAction,
  log: AdmissionRecord, read: AdmissionRead, now: () => number = () => systemClock.now(),
  classify: typeof classifyContribution = classifyContribution,
): Steps<void> {
  if (settings === undefined) return;
  const snapshot = JSON.stringify(settings);
  const started = now();
  let subject: AdmissionSubject = { repositoryId: settings.repositoryId, prNumber: target.prNumber,
    headSha: target.headSha ?? "", observedAtMs: started };
  const memberships: MembershipEvidence[] = [];
  const finish = (overrideReason?: string): void => {
    const decision = overrideReason === undefined ? classify(subject, action, settings.policy, memberships, now()) : {
      outcome: "unknown", reason: overrideReason,
      receiptKey: createHash("sha256").update(JSON.stringify([subject, action, snapshot, overrideReason])).digest("hex"),
    };
    log("contributor_admission.shadow", { ...decision, mode: "shadow", action, pr_number: target.prNumber,
      repository_id: settings.repositoryId, head_sha: subject.headSha, policy_version: settings.policy.version });
  };
  if (settings.mode !== "shadow" || !/^[A-Za-z0-9_.-]+$/.test(target.owner) || !/^[A-Za-z0-9_.-]+$/.test(target.repo)
    || !validId(target.prNumber) || settings.organizations.length > 8
    || settings.organizations.some((o) => !validId(o.id) || !/^[A-Za-z0-9-]+$/.test(o.login))) {
    finish("invalid-action-config"); return;
  }
  const path = `repos/${target.owner}/${target.repo}/pulls/${target.prNumber}`;
  let response: AdmissionResponse;
  try { response = yield* step(() => read(path)); }
  catch { finish("origin-unreadable"); return; }
  if (response.status !== 200) { finish("origin-unreadable"); return; }
  const pull = record(response.body);
  const head = record(pull.head);
  subject = { ...subject, headSha: typeof head.sha === "string" ? head.sha : "", observedAtMs: now(),
    origin: contributionOriginFromRest(pull as RestContributionOrigin) };
  if (pull.number !== target.prNumber || pull.state !== "open") { finish("pr-context-changed"); return; }
  if (target.headSha !== undefined && target.headSha !== subject.headSha) { finish("head-changed"); return; }
  const actor = subject.origin?.actor;
  const initial = classify(subject, action, settings.policy, [], now());
  if (initial.reason === "membership-unresolved" && actor != null && validId(actor.id) && actor.type === "User") {
    for (const organizationId of settings.policy.organizationIds) {
      const namespace = settings.organizations.find((o) => o.id === organizationId);
      if (!namespace || typeof actor.login !== "string" || !/^[A-Za-z0-9-]+$/.test(actor.login)) continue;
      const key = JSON.stringify([snapshot, actor.id, organizationId]);
      const cached = verifiedMembers.get(key);
      if (cached && fresh(cached.observedAtMs, now(), settings.policy.maxEvidenceAgeMs)) { memberships.push(cached); continue; }
      verifiedMembers.delete(key);
      let state: MembershipEvidence["state"] = "unknown";
      try {
        const membership = yield* step(() => read(`orgs/${namespace.login}/memberships/${actor.login}`));
        const body = record(membership.body);
        if (membership.status === 200 && record(body.user).id === actor.id && record(body.organization).id === organizationId) {
          if (body.state === "active") state = "member";
          else if (body.state === "pending") state = "not-member";
        } else if (membership.status === 404) {
          // Same credential, fresh positive control: unauthorized/hidden org 404s remain unknown.
          const viewer = yield* step(() => read("user"));
          const principal = record(viewer.body);
          if (viewer.status === 200 && validId(principal.id as number) && typeof principal.login === "string"
            && /^[A-Za-z0-9-]+$/.test(principal.login)) {
            const control = yield* step(() => read(`orgs/${namespace.login}/memberships/${principal.login}`));
            const proof = record(control.body);
            if (control.status === 200 && proof.state === "active" && record(proof.user).id === principal.id
              && record(proof.organization).id === organizationId) state = "not-member";
          }
        }
      } catch { state = "unknown"; } // read outage cannot become non-membership or block another PR
      const evidence: MembershipEvidence = { actorId: actor.id, organizationId, state, observedAtMs: now() };
      memberships.push(evidence);
      if (state === "member") {
        if (verifiedMembers.size >= 256) verifiedMembers.clear();
        verifiedMembers.set(key, evidence);
      }
    }
  }
  try { response = yield* step(() => read(path)); }
  catch { finish("origin-recheck-unreadable"); return; }
  const current = record(response.body);
  if (response.status !== 200) { finish("origin-recheck-unreadable"); return; }
  if (record(current.head).sha !== subject.headSha) { finish("head-changed"); return; }
  if (current.number !== target.prNumber || current.state !== "open"
    || JSON.stringify(contributionOriginFromRest(current as RestContributionOrigin)) !== JSON.stringify(subject.origin)) {
    finish("origin-changed"); return;
  }
  if (JSON.stringify(settings) !== snapshot) { finish("policy-changed"); return; }
  if (!fresh(started, now(), settings.policy.maxEvidenceAgeMs)) { finish("stale-action-evidence"); return; }
  finish();
}

export async function observeContributorAdmission(
  settings: AdmissionSettings | undefined, target: AdmissionTarget, action: AdmissionAction, log: AdmissionRecord,
  read: AdmissionRead = readAdmissionRestAsync, now?: () => number,
): Promise<void> {
  await runStepsAsync(contributorAdmissionSteps(settings, target, action, log, read, now));
}

export function observeContributorAdmissionSync(
  settings: AdmissionSettings | undefined, target: AdmissionTarget, action: AdmissionAction, log: AdmissionRecord,
  read: AdmissionRead = readAdmissionRest, classify?: typeof classifyContribution,
): void {
  runStepsSync(contributorAdmissionSteps(settings, target, action, log, read, undefined, classify));
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
  if (origin === undefined) return decision("unknown", "missing-origin");
  const actor = origin.actor;
  if (actor == null) return decision("unknown", "missing-actor");
  if (!validId(actor.id) || (actor.type !== "User" && actor.type !== "Bot")) return decision("unknown", "invalid-actor");
  const headRepository = origin.headRepository;
  if (headRepository == null) return decision("unknown", "missing-head-repository");
  if (!validId(headRepository.id)) return decision("unknown", "invalid-head-repository");
  const targetRepository = origin.targetRepository;
  if (targetRepository == null) return decision("unknown", "missing-target-repository");
  if (targetRepository.id !== subject.repositoryId) return decision("unknown", "target-mismatch");
  if ((actor.type === "Bot" && policy.ownerIds.includes(actor.id))
    || (actor.type === "User" && policy.services.some((service) => service.id === actor.id))) {
    return decision("unknown", "identity-type-mismatch");
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
