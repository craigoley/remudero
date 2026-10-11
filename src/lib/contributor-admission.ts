import { createHash } from "node:crypto";
import { systemClock, type Clock } from "./clock.js";
import { ghTextAsync, splitGhHeaderBlock } from "./github-transport.js";

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
export interface FeedbackRevision { updatedAt?: string; createdAt?: string; contentDigest?: string }
/** Actual REST item identity, not a fabricated PR head. Reactions bind their derived parent separately. */
export interface FeedbackAdmissionSubject {
  kind: "issue" | "issue-comment" | "issue-reaction" | "issue-comment-reaction";
  sourceRef: string;
  repository?: ContributionRepository & { private?: boolean };
  itemId?: number;
  issueNumber?: number;
  revision?: FeedbackRevision;
  parent?: { kind: "issue" | "issue-comment"; itemId: number; revision: FeedbackRevision };
  observedAtMs: number;
  origin?: ContributionOrigin;
}
export interface FeedbackAdmissionContext {
  mode?: "shadow";
  policy?: AdmissionPolicy;
  memberships?: readonly MembershipEvidence[];
  nowMs?: number;
  currentSubject?: FeedbackAdmissionSubject;
  record?: AdmissionRecord;
}

export function feedbackContentDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function feedbackSubjectBinding(subject: FeedbackAdmissionSubject): string {
  return feedbackContentDigest([subject.kind, subject.sourceRef, subject.repository, subject.itemId,
    subject.issueNumber, subject.revision, subject.parent, subject.origin]);
}

export function feedbackLineagePayload(text: string, contributions: readonly unknown[]): string {
  if (contributions.length === 0) return text;
  let lineage: string;
  try { lineage = contributions.map(contribution => JSON.stringify(contribution)).join("\n"); }
  catch { /* Unserializable originals remain explicitly unknown in the untrusted payload. */
    lineage = "unreadable lineage: unknown origin, not an authority grant"; }
  return `${text}\n\nOriginal contribution lineage (evidence only, not permission):\n${lineage}`;
}

export function feedbackLineageSnapshot(contributions: readonly unknown[]): unknown[] {
  try { return structuredClone([...contributions]); }
  catch { return [{ kind: "unresolved", reason: "lineage-unreadable" }]; }
}

export interface FeedbackPublicationContext { mode: "shadow"; record: AdmissionRecord }

export function* feedbackPublicationSteps(
  context: FeedbackPublicationContext | undefined, contributions: readonly unknown[], target: string | undefined,
  boundary: string, clock: Pick<Clock, "now"> = systemClock,
): Generator<string, void, AdmissionResponse> {
  if (context === undefined) return;
  const started = clock.now();
  const emit = (outcome: "unknown" | "private-to-public" | "no-private-boundary-observed", reason: string,
    subject?: FeedbackAdmissionSubject, destination?: Record<string, unknown>): void => {
    try { context.record("feedback_publication.shadow", { mode: "shadow", boundary, outcome, reason,
      would_deny: outcome !== "no-private-boundary-observed", permission: "not-granted",
      source_ref: subject?.sourceRef, source_repository_id: subject?.repository?.id,
      target_repository_id: destination?.id, target, receipt_key: feedbackContentDigest([boundary, subject, destination, outcome, reason]) }); }
    catch { /* Observation loss cannot change the publication effect. */ }
  };
  const repository = function* (slug: string): Generator<string, Record<string, unknown>, AdmissionResponse> {
    if (!fresh(started, clock.now(), 5_000)) throw new Error("publication-read-bound");
    const response = yield `repos/${slug}`;
    const body = record(response.body);
    if (response.status !== 200 || !validId(body.id as number) || body.full_name !== slug || typeof body.private !== "boolean") {
      throw new Error("repository-visibility-unreadable");
    }
    return body;
  };
  if (context.mode !== "shadow" || target === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) {
    emit("unknown", "publication-target-unresolved"); return;
  }
  let destination: Record<string, unknown>;
  try { destination = yield* repository(target); }
  catch { /* The receipt distinguishes unavailable destination evidence from public visibility. */
    emit("unknown", "publication-target-unreadable"); return; }
  if (contributions.length === 0) emit("unknown", "publication-lineage-missing", undefined, destination);
  for (const contribution of feedbackLineageSnapshot(contributions.slice(0, 8))) {
    let subject: FeedbackAdmissionSubject | undefined;
    try {
      subject = record(contribution).subject as FeedbackAdmissionSubject | undefined;
      const source = subject?.repository;
      const slug = source?.fullName;
      if (!subject || !slug || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)
        || source === undefined || !validId(source.id) || typeof source.private !== "boolean" || !subject.sourceRef.startsWith(`${slug}#`)) {
        throw new Error("publication-lineage-unreadable");
      }
      const current = yield* repository(slug);
      if (current.id !== source.id) throw new Error("publication-source-identity-changed");
      const finalTarget = yield* repository(target);
      if (finalTarget.id !== destination.id || finalTarget.private !== destination.private
        || !fresh(started, clock.now(), 5_000)) throw new Error("publication-target-changed");
      if (destination.private === false && (source.private || current.private)) {
        emit("private-to-public", "actor-admission-is-not-publication-permission", subject, destination);
      } else emit("no-private-boundary-observed", "visibility-observation-only", subject, destination);
    } catch { /* Failed identity/visibility reads carry unknown, never a publication grant. */
      emit("unknown", "publication-evidence-unreadable", subject, destination); }
  }
  if (contributions.length > 8) emit("unknown", "publication-lineage-read-bound", undefined, destination);
}

export async function observeFeedbackPublication(
  context: FeedbackPublicationContext | undefined, contributions: readonly unknown[], target: string | undefined, boundary: string,
  read: AdmissionRead = readAdmissionRestAsync, clock: Pick<Clock, "now"> = systemClock,
): Promise<void> {
  const steps = feedbackPublicationSteps(context, contributions, target, boundary, clock);
  let next = steps.next();
  while (!next.done) {
    try { next = steps.next(await read(next.value)); }
    catch (error) { next = steps.throw(error); }
  }
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
export type AdmissionRecord = (step: string, fields: Record<string, unknown>) => void;
type AdmissionSteps = Generator<() => unknown, void, unknown>;

// Positive membership only, policy-scoped and bounded. PR origins and negative/unknown reads
// are NEVER cached; each action re-reads the PR, including after a membership round trip.
const verifiedMembers = new Map<string, MembershipEvidence>();
const ADMISSION_READ_TIMEOUT_MS = 5_000;

function admissionResponse(text: string): AdmissionResponse {
  const { headers, body } = splitGhHeaderBlock(text);
  const status = /^HTTP\/\S+ (\d{3})/m.exec(headers);
  if (!status) return { status: 0, body: undefined };
  try { return { status: Number(status[1]), body: JSON.parse(body) }; }
  catch {
    // Malformed response is unreadable, not a negative identity.
    return { status: 0, body: undefined };
  }
}

function failedAdmissionResponse(error: unknown): AdmissionResponse {
  const stdout = (error as { stdout?: unknown } | null)?.stdout;
  // Require the actual response header. An error message containing "404" is not evidence.
  return typeof stdout === "string" || Buffer.isBuffer(stdout)
    ? admissionResponse(String(stdout)) : { status: 0, body: undefined };
}

// The synchronous CLI boundary supplies its existing transport explicitly. The shared resolver
// owns HTTP interpretation and read bounds, not a new synchronous daemon transport default.
export function readAdmissionRest(path: string,
  run: (args: string[], options: { encoding: "utf8"; timeout: number; maxBuffer: number }) => string | Buffer,
): AdmissionResponse {
  try { return admissionResponse(String(run(["api", path, "-i"], { encoding: "utf8", timeout: ADMISSION_READ_TIMEOUT_MS, maxBuffer: 1 << 20 }))); }
  catch (error) {
    // Preserve an HTTP response from the failed child; absent response bytes remain unreadable.
    return failedAdmissionResponse(error);
  }
}

export async function readAdmissionRestAsync(path: string): Promise<AdmissionResponse> {
  try { return admissionResponse(await ghTextAsync(["api", path, "-i"], { timeout: ADMISSION_READ_TIMEOUT_MS, maxBuffer: 1 << 20 })); }
  catch (error) {
    // Preserve the same HTTP/transport distinction on the daemon's asynchronous transport.
    return failedAdmissionResponse(error);
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function* contributorAdmissionSteps(
  settings: AdmissionSettings | undefined, target: AdmissionTarget, action: AdmissionAction,
  log: AdmissionRecord, read: AdmissionRead, clock: Pick<Clock, "now"> = systemClock,
  classify: typeof classifyContribution = classifyContribution,
): AdmissionSteps {
  if (settings === undefined) return;
  const now = () => clock.now();
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
  try { response = yield* admissionReadStep(read, path); }
  catch {
    // This PR's origin read failed; shadow observation records unknown and does not refuse effects.
    finish("origin-unreadable"); return;
  }
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
    memberships.push(...yield* contributorMembershipSteps(settings, { ...actor, id: actor.id }, snapshot, read, clock));
  }
  try { response = yield* admissionReadStep(read, path); }
  catch {
    // A failed recheck invalidates this observation, never a prior trusted result on another PR.
    finish("origin-recheck-unreadable"); return;
  }
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

function* contributorMembershipSteps(
  settings: AdmissionSettings, actor: ContributionActor & { id: number }, snapshot: string,
  read: AdmissionRead, clock: Pick<Clock, "now">,
): Generator<() => unknown, MembershipEvidence[], unknown> {
  const memberships: MembershipEvidence[] = [];
  const now = () => clock.now();
  for (const organizationId of new Set(settings.policy.organizationIds)) {
      const namespace = settings.organizations.find((o) => o.id === organizationId);
      if (!namespace || typeof actor.login !== "string" || !/^[A-Za-z0-9-]+$/.test(actor.login)) continue;
      const key = JSON.stringify([snapshot, actor.id, organizationId]);
      const cached = verifiedMembers.get(key);
      if (cached && fresh(cached.observedAtMs, now(), settings.policy.maxEvidenceAgeMs)) { memberships.push(cached); break; }
      verifiedMembers.delete(key);
      let state: MembershipEvidence["state"] = "unknown";
      try {
        const membership = yield* admissionReadStep(read, `orgs/${namespace.login}/memberships/${actor.login}`);
        const body = record(membership.body);
        if (membership.status === 200 && record(body.user).id === actor.id && record(body.organization).id === organizationId) {
          if (body.state === "active") state = "member";
          else if (body.state === "pending") state = "not-member";
        } else if (membership.status === 404) {
          // Same credential, fresh positive control: unauthorized/hidden org 404s remain unknown.
          const viewer = yield* admissionReadStep(read, "user");
          const principal = record(viewer.body);
          if (viewer.status === 200 && validId(principal.id as number) && typeof principal.login === "string"
            && /^[A-Za-z0-9-]+$/.test(principal.login)) {
            const control = yield* admissionReadStep(read, `orgs/${namespace.login}/memberships/${principal.login}`);
            const proof = record(control.body);
            if (control.status === 200 && proof.state === "active" && record(proof.user).id === principal.id
              && record(proof.organization).id === organizationId) state = "not-member";
          }
        }
      } catch {
        // Read outage cannot become non-membership or block another PR; evidence stays unknown.
        state = "unknown";
      }
      const evidence: MembershipEvidence = { actorId: actor.id, organizationId, state, observedAtMs: now() };
      memberships.push(evidence);
      if (state === "member") {
        if (verifiedMembers.size >= 256) verifiedMembers.clear();
        verifiedMembers.set(key, evidence);
        break; // One verified admitted membership is sufficient; unrelated org outages add no authority.
      }
  }
  return memberships;
}

function* admissionReadStep(read: AdmissionRead, path: string): Generator<() => unknown, AdmissionResponse, unknown> {
  return (yield () => read(path)) as AdmissionResponse;
}

export interface FeedbackSourceObservation {
  decision: AdmissionDecision;
  subject?: FeedbackAdmissionSubject;
  memberships: readonly MembershipEvidence[];
  wouldDeny: boolean;
}

async function readFeedbackSourceSubject(
  expected: FeedbackAdmissionSubject, read: AdmissionRead, clock: Pick<Clock, "now">,
): Promise<FeedbackAdmissionSubject> {
  const ref = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)(?:\/comment\/([1-9]\d*))?(?:\/reaction\/([1-9]\d*))?$/.exec(expected.sourceRef)!;
  const repoPath = `repos/${ref[1]}`;
  const requireBody = async (path: string): Promise<Record<string, unknown>> => {
    const response = await read(path);
    if (response.status !== 200 || Object.keys(record(response.body)).length === 0) throw new Error("source-unreadable");
    return record(response.body);
  };
  const repository = await requireBody(repoPath);
  if (!validId(repository.id as number) || repository.full_name !== ref[1] || typeof repository.private !== "boolean") {
    throw new Error("source-unreadable");
  }
  const parentPath = ref[3] === undefined ? `${repoPath}/issues/${ref[2]}` : `${repoPath}/issues/comments/${ref[3]}`;
  let item = await requireBody(parentPath);
  if (ref[3] === undefined ? item.number !== Number(ref[2]) || "pull_request" in item
    : item.id !== Number(ref[3]) || item.issue_url !== `https://api.github.com/${repoPath}/issues/${ref[2]}`) {
    throw new Error("source-context-changed");
  }
  const parentRevision: FeedbackRevision = { updatedAt: item.updated_at as string,
    contentDigest: feedbackContentDigest(ref[3] === undefined ? [item.title, item.body, item.labels] : item.body) };
  const parentId = item.id as number;
  if (ref[4] !== undefined) {
    let reaction: Record<string, unknown> | undefined;
    for (let page = 1; page <= 3; page++) {
      const response = await read(`${parentPath}/reactions?per_page=100&page=${page}`);
      if (response.status !== 200 || !Array.isArray(response.body)) throw new Error("source-unreadable");
      reaction = response.body.map(record).find(row => row.id === Number(ref[4]));
      if (reaction || response.body.length < 100) break;
    }
    if (!reaction) throw new Error("source-reaction-unresolved");
    item = reaction;
  }
  return { kind: expected.kind, sourceRef: expected.sourceRef,
    repository: { id: repository.id as number, fullName: repository.full_name as string, private: repository.private },
    itemId: item.id as number, issueNumber: Number(ref[2]), observedAtMs: clock.now(),
    origin: contributionOriginFromRest(item as RestContributionOrigin),
    revision: ref[4] === undefined ? parentRevision
      : { createdAt: item.created_at as string, contentDigest: feedbackContentDigest(item.content) },
    ...(ref[4] === undefined ? {} : { parent: { kind: ref[3] === undefined ? "issue" as const : "issue-comment" as const,
      itemId: parentId, revision: parentRevision } }) };
}

/** Recheck one selected original source, not an inbox scan. Shadow receipts never authorize an
 * effect or the publication of private material. A changed/unreadable source remains unknown. */
export async function observeFeedbackSource(
  settings: AdmissionSettings | undefined, expected: FeedbackAdmissionSubject, boundary: string,
  log: AdmissionRecord, sourceRead: AdmissionRead = readAdmissionRestAsync, clock: Pick<Clock, "now"> = systemClock,
): Promise<FeedbackSourceObservation | undefined> {
  if (settings === undefined) return undefined;
  const started = clock.now();
  const snapshot = JSON.stringify(settings);
  let subject: FeedbackAdmissionSubject | undefined;
  let memberships: MembershipEvidence[] = [];
  const finish = (reason?: string): FeedbackSourceObservation => {
    const decision = reason === undefined ? classifyContribution(subject!, "feedback", settings.policy, memberships, clock.now())
      : { outcome: "unknown" as const, reason, receiptKey: feedbackContentDigest([expected, snapshot, boundary, reason]) };
    const result = { decision, subject, memberships, wouldDeny: decision.outcome !== "trusted" };
    try { log("feedback_admission.shadow", { ...decision, mode: "shadow", boundary, source_kind: expected.kind,
      source_ref: expected.sourceRef, item_id: expected.itemId, repository_id: expected.repository?.id,
      policy_version: settings.policy.version, would_deny: result.wouldDeny }); }
    catch { /* Diagnostic failure is not permission and cannot change shadow effects. */ }
    return result;
  };
  if (settings.mode !== "shadow" || settings.organizations.length > 8
    || settings.organizations.some(o => !validId(o.id) || !/^[A-Za-z0-9-]+$/.test(o.login))) return finish("invalid-action-config");
  const initial = classifyContribution({ ...expected, observedAtMs: started }, "feedback", settings.policy, [], started);
  if (initial.outcome === "unknown" && initial.reason !== "membership-unresolved") return finish(initial.reason);
  let reads = 0;
  const read: AdmissionRead = async path => {
    if (++reads > 16 || !fresh(started, clock.now(), Math.min(settings.policy.maxEvidenceAgeMs, 15_000))) throw new Error("source-read-bound");
    return sourceRead(path);
  };
  try {
    subject = await readFeedbackSourceSubject(expected, read, clock);
    if (feedbackSubjectBinding(subject) !== feedbackSubjectBinding(expected)) return finish("source-revision-changed");
    const decision = classifyContribution(subject, "feedback", settings.policy, [], clock.now());
    const actor = subject.origin?.actor;
    if (decision.reason === "membership-unresolved" && actor && validId(actor.id)) {
      const steps = contributorMembershipSteps(settings, { ...actor, id: actor.id }, snapshot, read, clock);
      let next = steps.next();
      while (!next.done) {
        try { next = steps.next(await next.value()); }
        catch (error) { next = steps.throw(error); }
      }
      memberships = next.value;
    }
    const current = await readFeedbackSourceSubject(expected, read, clock);
    if (feedbackSubjectBinding(current) !== feedbackSubjectBinding(subject)) return finish("source-revision-changed");
    subject = current;
    if (JSON.stringify(settings) !== snapshot) return finish("policy-changed");
    if (!fresh(started, clock.now(), Math.min(settings.policy.maxEvidenceAgeMs, 15_000))) return finish("stale-action-evidence");
    return finish();
  } catch {
    // The returned observation retains transport/revision failure as unknown with its own reason.
    return finish("source-recheck-unavailable");
  }
}

export async function observeFeedbackInputs(
  settings: AdmissionSettings | undefined, contributions: readonly unknown[], boundary: string, log: AdmissionRecord,
  read: AdmissionRead = readAdmissionRestAsync, clock: Pick<Clock, "now"> = systemClock,
): Promise<void> {
  if (settings === undefined) return;
  if (contributions.length === 0) {
    try { log("feedback_admission.shadow", { mode: "shadow", boundary, outcome: "unknown", would_deny: true,
      reason: "lineage-missing", policy_version: settings.policy.version }); }
    catch { /* A missing diagnostic never changes legacy adoption. */ }
    return;
  }
  const seen = new Set<string>();
  for (const contribution of feedbackLineageSnapshot(contributions.slice(0, 8))) {
    try {
      const subject = record(contribution).subject as FeedbackAdmissionSubject | undefined;
      if (!subject || typeof subject !== "object" || Array.isArray(subject)) throw new Error("missing-source-binding");
      const binding = feedbackSubjectBinding(subject);
      if (seen.has(binding)) continue;
      seen.add(binding);
      await observeFeedbackSource(settings, structuredClone(subject), boundary, log, read, clock);
    } catch {
      try { log("feedback_admission.shadow", { mode: "shadow", boundary, outcome: "unknown", would_deny: true,
        reason: "lineage-unreadable", policy_version: settings.policy.version }); }
      catch { /* Lost diagnostic must not turn an observation into a hold. */ }
    }
  }
  if (contributions.length > 8) {
    try { log("feedback_admission.shadow", { mode: "shadow", boundary, outcome: "unknown", would_deny: true,
      reason: "lineage-read-bound", policy_version: settings.policy.version }); }
    catch { /* The bounded observation never filters or discards additional lineage. */ }
  }
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
  subject: AdmissionSubject | FeedbackAdmissionSubject, action: AdmissionAction, policy: AdmissionPolicy,
  memberships: readonly MembershipEvidence[], nowMs: number,
): AdmissionDecision {
  const decision = (outcome: AdmissionDecision["outcome"], reason: string): AdmissionDecision => ({
    outcome, reason,
    receiptKey: createHash("sha256").update(JSON.stringify([subject, action, policy, memberships, outcome, reason])).digest("hex"),
  });
  if (!policy.version.trim() || !Number.isFinite(policy.maxEvidenceAgeMs) || policy.maxEvidenceAgeMs < 0
    || policy.ownerIds.length === 0 || !policy.ownerIds.every(validId) || !policy.organizationIds.every(validId)
    || !policy.services.every((service) => validId(service.id))) return decision("unknown", "invalid-policy");
  const pr = "sourceRef" in subject ? undefined : subject;
  if (!Number.isFinite(nowMs) || nowMs < 0) return decision("unknown", "invalid-context");
  if (pr === undefined) {
    const item = subject as FeedbackAdmissionSubject;
    if (action !== "feedback") return decision("unknown", "invalid-context");
    const ref = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)(?:\/comment\/([1-9]\d*))?(?:\/reaction\/([1-9]\d*))?$/.exec(item.sourceRef);
    const reaction = item.kind === "issue-reaction" || item.kind === "issue-comment-reaction";
    const comment = item.kind === "issue-comment" || item.kind === "issue-comment-reaction";
    if (!ref || !["issue", "issue-comment", "issue-reaction", "issue-comment-reaction"].includes(item.kind)
      || comment !== (ref[3] !== undefined) || reaction !== (ref[4] !== undefined)
      || item.repository == null || !validId(item.repository.id) || item.repository.fullName !== ref[1]
      || !validId(item.itemId) || item.issueNumber !== Number(ref[2])
      || (reaction ? item.itemId !== Number(ref[4]) : comment && item.itemId !== Number(ref[3]))) {
      return decision("unknown", "invalid-source-identity");
    }
    const validRevision = (revision: FeedbackRevision | undefined, isReaction = false): boolean => {
      const timestamp = isReaction ? revision?.createdAt : revision?.updatedAt;
      const time = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
      return Number.isFinite(time) && time >= 0 && time <= item.observedAtMs
        && /^[a-f0-9]{64}$/.test(revision?.contentDigest ?? "")
        && (!isReaction || revision?.updatedAt === undefined);
    };
    if (!validRevision(item.revision, reaction)) return decision("unknown", "invalid-source-revision");
    if (reaction && (!item.parent || item.parent.kind !== (comment ? "issue-comment" : "issue")
      || !validId(item.parent.itemId) || (comment && item.parent.itemId !== Number(ref[3]))
      || !validRevision(item.parent.revision))) return decision("unknown", "invalid-parent-revision");
  } else if (!validId(pr.repositoryId) || !validId(pr.prNumber) || !/^[a-f0-9]{40}$/i.test(pr.headSha)) {
    return decision("unknown", "invalid-context");
  }
  if (!fresh(subject.observedAtMs, nowMs, policy.maxEvidenceAgeMs)) return decision("unknown", "stale-origin");
  const origin = subject.origin;
  if (origin === undefined) return decision("unknown", "missing-origin");
  const actor = origin.actor;
  if (actor == null) return decision("unknown", "missing-actor");
  if (!validId(actor.id) || (actor.type !== "User" && actor.type !== "Bot")) return decision("unknown", "invalid-actor");
  if (pr !== undefined) {
    const headRepository = origin.headRepository;
    if (headRepository == null) return decision("unknown", "missing-head-repository");
    if (!validId(headRepository.id)) return decision("unknown", "invalid-head-repository");
    const targetRepository = origin.targetRepository;
    if (targetRepository == null) return decision("unknown", "missing-target-repository");
    if (targetRepository.id !== pr.repositoryId) return decision("unknown", "target-mismatch");
  }
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
