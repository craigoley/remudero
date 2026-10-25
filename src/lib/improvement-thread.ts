import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { CODE_HEALTH_POLICY_VERSION } from "./code-health-collector.js";
import { codeHealthRepositoryStateDir, readCodeHealthArtifactJson, readCodeHealthCollectionFailure, readCodeHealthSnapshot } from "./code-health-store.js";
import { readCodeHealthInventory, readCodeHealthRelatedWork } from "./code-health-view.js";
import { buildCodeHealthOpportunities } from "./codeql-quality-intake.js";
import { acquireInflightLock, parseInflightLockInfo, type InflightLockHandle } from "./inflight-lock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, reclaimStaleLock, writeAtomic } from "./fs-race-safe.js";
import { inboxDraftGeneration, invalidateDraft, parseProposalRegistryResult, updateProposalRegistry, type DraftCache, type DraftedCandidate, type Proposal } from "./inbox.js";
import { bearerTokenId, jsonAction, sendJson } from "./panel-actions.js";
import type { Route } from "./service.js";
import { appendThreadMessageOnce, inboxThreadId, inboxThreadIdentity, readThread, type ThreadMessageExtra } from "./inbox-thread.js";

export const IMPROVEMENT_THREAD_VERSION = "improvement-thread-v1" as const;
export interface ImprovementThreadRequest {
  repository: string; opportunityId: string; snapshotId: string; goal: string; constraints?: string[];
  idempotencyKey: string; instance?: string;
}
export interface ImprovementThreadDeps {
  stateDir: string; actorId: string; clock?: Clock;
  /** Persistence interruption seam; never accepted from a browser request. */
  afterPersist?: (stage: "intent" | "proposal" | "messages" | "receipt") => void;
}
export type ImprovementThreadResult = {
  state: "saved"; version: typeof IMPROVEMENT_THREAD_VERSION; requestId: string; threadId: string; proposalId: string;
  repository: string; instance: string; snapshotId: string; opportunityId: string; reused: boolean;
  planning: { state: "not_requested" }; execution: { state: "not_requested" };
} | { state: "invalid_request" | "source_unavailable" | "source_stale" | "conflict" | "busy" | "uncertain"; reason: string; requestId?: string };

type Failure = Exclude<ImprovementThreadResult, { state: "saved" }>;
type Scope = { instance: string; inboxStateDir: string; ledgerPath: string; planPath: string };
type Binding = NonNullable<ThreadMessageExtra["improvement"]>;
type Intent = {
  version: typeof IMPROVEMENT_THREAD_VERSION; requestId: string; payloadHash: string; actorId: string;
  request: ImprovementThreadRequest; scope: Scope; binding: Binding; proposalId: string; threadId: string;
  context: string; goalBody: string; contextId: string; goalId: string;
  stage: "intent" | "proposal" | "messages" | "saved";
};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
const fail = (state: Failure["state"], reason: string, requestId?: string): Failure => ({ state, reason, ...(requestId ? { requestId } : {}) });

function requestInput(value: unknown): ImprovementThreadRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const b = value as Record<string, unknown>;
  if (Object.keys(b).some(key => !["repository", "opportunityId", "snapshotId", "goal", "constraints", "idempotencyKey", "instance"].includes(key)) ||
      !text(b.repository, 140) || !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(b.repository) ||
      !text(b.opportunityId, 4096) || typeof b.snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(b.snapshotId) || !text(b.goal, 2000) ||
      typeof b.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(b.idempotencyKey) ||
      b.instance !== undefined && (!text(b.instance, 128) || !/^[A-Za-z0-9._-]+$/.test(b.instance)) ||
      b.constraints !== undefined && (!Array.isArray(b.constraints) || b.constraints.length > 16 || !b.constraints.every(value => text(value, 1000)))) return undefined;
  return { repository: b.repository.toLowerCase(), opportunityId: b.opportunityId, snapshotId: b.snapshotId, goal: b.goal.trim(),
    constraints: (b.constraints as string[] | undefined)?.map(value => value.trim()) ?? [], idempotencyKey: b.idempotencyKey,
    ...(b.instance ? { instance: b.instance as string } : {}) };
}
function syncPath(path: string, directory = false): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Same 16 MiB observation bound as the existing native Inbox contract. */
function readInboxJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new Error("The native Inbox file is not a bounded regular file.");
    const bytes = Buffer.alloc(16 * 1024 * 1024 + 1); let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    const after = fstatSync(fd);
    if (length > 16 * 1024 * 1024 || length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("The native Inbox file changed during its read.");
    return JSON.parse(bytes.toString("utf8", 0, length));
  } finally { closeSync(fd); }
}
function strictRegistry(path: string): Proposal[] {
  let raw: string;
  try { raw = JSON.stringify(readInboxJson(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const read = parseProposalRegistryResult(raw);
  if (read.kind !== "ok" || !read.proposals.every(p => p && typeof p.id === "string" && typeof p.summary === "string" && Array.isArray(p.evidenceAnchors)) ||
      new Set(read.proposals.map(p => p.id)).size !== read.proposals.length) throw new Error("The saved proposal registry cannot be read safely.");
  return read.proposals;
}
function scopeFor(request: ImprovementThreadRequest, stateDir: string): Scope | Failure {
  const inventory = readCodeHealthInventory(stateDir), member = inventory.repositories.find(row => row.repository === request.repository);
  if (!member) return fail("source_unavailable", "This repository is not in the configured fleet.");
  const instance = request.instance ?? (member.instanceIds.length === 1 ? member.instanceIds[0] : undefined);
  if (!instance || !member.instanceIds.includes(instance)) return fail("invalid_request", "Choose one of this repository's configured fleet instances.");
  const raw = readCodeHealthArtifactJson(join(stateDir, "read-model", "repositories-sources.json"), 2 * 1024 * 1024) as {
    instances?: Array<{ instanceId: string; options: { controlRoot?: string; ledgerPath?: string; planPath?: string } }> };
  const matching = raw.instances?.filter(row => row.instanceId === instance);
  if (matching?.length !== 1) return fail("source_unavailable", "The selected fleet could not be found.");
  const options = matching[0]!.options;
  if (![options.controlRoot, options.ledgerPath, options.planPath].every(value => text(value, 4096) && isAbsolute(value)))
    return fail("source_unavailable", "Saved planning is not available for this fleet yet.");
  return { instance, inboxStateDir: join(options.controlRoot!, "state"), ledgerPath: options.ledgerPath!, planPath: options.planPath! };
}
function sourceFor(request: ImprovementThreadRequest, scope: Scope, deps: ImprovementThreadDeps): { binding: Binding; context: string; sourceProposalId: string } | Failure {
  const now = (deps.clock ?? systemClock).now(), repoState = codeHealthRepositoryStateDir(deps.stateDir, request.repository);
  const latest = readCodeHealthSnapshot(repoState, request.repository);
  if (latest.state !== "observed") return fail("source_unavailable", "Refresh Code health before opening this improvement.");
  if (latest.snapshot.snapshotId !== request.snapshotId) return fail("source_stale", "Code health has changed. Review the latest finding before continuing.");
  const input = latest.snapshot.input, scan = input.scans.find(value => value.kind === "quality"), failure = readCodeHealthCollectionFailure(repoState, request.repository);
  if (failure.state !== "none" || input.registry.version !== CODE_HEALTH_POLICY_VERSION || !scan || scan.state !== "complete" || scan.analyzedSha !== input.currentSha ||
      !Number.isFinite(Date.parse(scan.observedAt)) || Date.parse(scan.observedAt) > now || now - Date.parse(scan.observedAt) > 86_400_000)
    return fail("source_stale", "This finding needs a current, complete source before planning can begin.");
  const inventory = readCodeHealthInventory(deps.stateDir), related = readCodeHealthRelatedWork(deps.stateDir, inventory, request.repository, now);
  const opportunity = buildCodeHealthOpportunities(input, related.work).find(row => row.id === request.opportunityId);
  if (!opportunity || !opportunity.mayPlan || opportunity.snapshotId !== request.snapshotId) return fail("source_unavailable", "The selected finding is not available in this repository snapshot.");
  const binding: Binding = { repository: request.repository, instance: scope.instance, opportunityId: opportunity.id, snapshotId: request.snapshotId,
    policyVersion: CODE_HEALTH_POLICY_VERSION, analyzedSha: scan.analyzedSha };
  // Scanner text is quoted evidence. It never becomes a command or a human approval.
  const excerpt = opportunity.evidence.slice(0, 20).map(row => ({ path: row.path, finding: row.title, severity: row.severity, scan: row.scanId, observedAt: row.observedAt }));
  const context = [
    `Improvement in ${request.repository} (${scope.instance})`, `Source commit: ${scan.analyzedSha}`, `Source checked: ${scan.observedAt}`,
    `Saved snapshot: ${request.snapshotId}`, `Opportunity: ${opportunity.id}`, `Existing policy: ${CODE_HEALTH_POLICY_VERSION}`,
    `Observed finding (quoted): ${JSON.stringify(opportunity.title)}`, `What this may affect: ${opportunity.consequence}`,
    `Expected result: ${opportunity.expectedResult}`, `Evidence: ${excerpt.length} shown of ${opportunity.evidenceCount} findings.`, JSON.stringify(excerpt),
    `What we do not know: ${opportunity.uncertainty.join(" ") || "The effect on delivery has not been measured."}`,
    `Effort: ${opportunity.effortMinutes === null ? "Not estimated." : `${opportunity.effortMinutes} minutes, modeled estimate; not a measured duration.`}`,
    `Related work (${related.state}): ${JSON.stringify(opportunity.relatedWork)}`, related.reason ?? "Review existing work before filing.",
    `Ideas for checking the result: ${opportunity.acceptanceIdeas.join(" ")}`, "How to check if the change did not help: repeat the same analysis. A linked finding that is still open means the expected improvement was not confirmed.",
    "This is a saved planning conversation. Choose Draft plan tasks when ready. Creating or replying does not file tasks or start execution.",
  ].join("\n");
  if (Buffer.byteLength(context) > 64 * 1024) return fail("source_unavailable", "This finding's briefing exceeds the saved conversation limit.");
  return { binding, context, sourceProposalId: opportunity.proposalId };
}

/** Separate request-store ownership; this never grants task dispatch or an author test slot. */
function requestLock(root: string, key: string): InflightLockHandle | undefined {
  const dir = join(root, "locks"), path = join(dir, `${key}.lock`);
  const acquire = () => acquireInflightLock(dir, key, { run_id: `improvement:${randomUUID()}`, reclaim: false });
  try { return acquire(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  const reclaimed = reclaimStaleLock(path, { parseHolder: raw => ({ info: parseInflightLockInfo(raw) }),
    isStale: held => held.info !== null && Number.isSafeInteger(held.info.pid) && held.info.pid > 0 && typeof held.info.host === "string" &&
      Number.isFinite(Date.parse(held.info.startedAt)) && isHolderStale(held.info, { isPidAlive: defaultIsPidAlive }) });
  if (!["missing", "reclaimed"].includes(reclaimed.outcome)) return undefined;
  try { return acquire(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw error; }
}
function lockOwnership(lock: InflightLockHandle): () => boolean {
  const stat = lstatSync(lock.path), original = hash(lock.info);
  return () => {
    try { const current = lstatSync(lock.path); return current.isFile() && current.dev === stat.dev && current.ino === stat.ino && hash(readCodeHealthArtifactJson(lock.path, 4096)) === original; }
    catch {
      // Unreadable or replaced ownership is unknown, so every write and release is refused.
      return false;
    }
  };
}
function readIntent(path: string): Intent | undefined {
  let raw: unknown;
  try { raw = readCodeHealthArtifactJson(path, 128 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const { contentHash, ...intent } = raw as Intent & { contentHash: string };
  if (intent.version !== IMPROVEMENT_THREAD_VERSION || contentHash !== hash(intent) || !/^[a-f0-9]{64}$/.test(intent.requestId) ||
      !["intent", "proposal", "messages", "saved"].includes(intent.stage) || !requestInput(intent.request) ||
      intent.threadId !== inboxThreadId(intent.proposalId)) throw new Error("The saved improvement request is invalid.");
  return intent;
}
function saved(intent: Intent, reused: boolean): ImprovementThreadResult {
  return { state: "saved", version: IMPROVEMENT_THREAD_VERSION, requestId: intent.requestId, threadId: intent.threadId, proposalId: intent.proposalId,
    repository: intent.request.repository, instance: intent.scope.instance, snapshotId: intent.request.snapshotId, opportunityId: intent.request.opportunityId, reused,
    planning: { state: "not_requested" }, execution: { state: "not_requested" } };
}
function messagesMatch(intent: Intent): boolean {
  const read = readThread(intent.threadId, { threadStorePath: join(intent.scope.inboxStateDir, "inbox-threads.jsonl") });
  if (read.status !== "ok") return false;
  return [[intent.contextId, intent.context, "escalation"], [intent.goalId, intent.goalBody, "reply"]].every(([id, body, role]) => {
    const rows = read.messages.filter(row => row.extra?.messageId === id);
    return rows.length === 1 && rows[0]!.body === body && rows[0]!.role === role && hash(rows[0]!.extra?.improvement) === hash(intent.binding) && !rows[0]!.extra?.input;
  });
}

/** Resolve server-owned evidence, save native Inbox messages, then acknowledge a durable receipt. */
export async function createImprovementThread(value: unknown, deps: ImprovementThreadDeps): Promise<ImprovementThreadResult> {
  const request = requestInput(value);
  if (!request || !text(deps.actorId, 256)) return fail("invalid_request", "Choose a repository finding and provide a goal and request identity.");
  const requestId = hash([deps.actorId, request.idempotencyKey]), payloadHash = hash(request), root = join(deps.stateDir, "improvement-threads"), path = join(root, `${requestId}.json`);
  let lock: InflightLockHandle | undefined, requestOwner: InflightLockHandle | undefined, owns: (() => boolean) | undefined, ownsRequest: (() => boolean) | undefined;
  let mayHaveWritten = false;
  try {
    const scope = scopeFor(request, deps.stateDir); if ("state" in scope) return scope;
    requestOwner = requestLock(root, `request-${requestId}`);
    if (!requestOwner) return fail("busy", "This request is being saved, or its writer's ownership is not yet known.", requestId);
    ownsRequest = lockOwnership(requestOwner);
    // Serialize requests for the same source opportunity, including different retry keys and goals.
    lock = requestLock(root, hash([request.repository, scope.instance, request.opportunityId]));
    if (!lock) return fail("busy", "This improvement is being saved, or its writer's ownership is not yet known.", requestId);
    const ownsOpportunity = lockOwnership(lock);
    owns = () => ownsOpportunity() && ownsRequest!();
    const previous = readIntent(path);
    if (previous && (previous.payloadHash !== payloadHash || previous.actorId !== deps.actorId)) return fail("conflict", "This request identity was already used for a different goal or finding.", requestId);
    if (previous && hash(previous.scope) !== hash(scope)) return fail("source_unavailable", "This chat's repository or fleet has changed. Review its source before continuing.", requestId);
    if (previous?.stage === "saved") {
      if (!messagesMatch(previous)) return fail("uncertain", "The saved receipt exists, but its conversation cannot currently be verified.", requestId);
      // Repair only this request's interrupted ready marker. Replaying an older request must never reset a later goal or action.
      const registryPath = join(scope.inboxStateDir, "inbox-proposals.json");
      strictRegistry(registryPath);
      updateProposalRegistry(registryPath, current => {
        strictRegistry(registryPath); if (!owns!()) throw new Error("Improvement request ownership changed.");
        const proposal = current.find(row => row.id === previous.proposalId);
        if (proposal === undefined || proposal.improvement === undefined) throw new Error("The saved proposal is unavailable.");
        if (proposal.improvement.requestId !== requestId || proposal.improvement.conversationReady) return null;
        return current.map(row => row.id === previous.proposalId ? { ...row, improvement: { ...row.improvement!, conversationReady: true } } : row);
      }, { maxWaitMs: 0 });
      syncPath(registryPath); syncPath(scope.inboxStateDir, true);
      return owns() ? saved(previous, true) : fail("uncertain", "The request writer changed before acknowledgement.", requestId);
    }
    const source = sourceFor(request, scope, deps); if ("state" in source) return { ...source, requestId };
    const proposalId = `improvement:${hash([request.repository, scope.instance, source.sourceProposalId])}`;
    const goalBody = [request.goal, ...(request.constraints!.length ? ["Constraints:", ...request.constraints!.map(line => `- ${line}`)] : [])].join("\n");
    const intent: Intent = previous ?? { version: IMPROVEMENT_THREAD_VERSION, requestId, payloadHash, actorId: deps.actorId, request, scope, binding: source.binding,
      proposalId, threadId: inboxThreadId(proposalId), context: source.context, goalBody,
      contextId: `context:${hash([source.binding, source.context])}`, goalId: `goal:${hash([proposalId, source.binding, deps.actorId, goalBody])}`, stage: "intent" };
    const persist = (stage: Intent["stage"]) => {
      if (!owns!()) throw new Error("Improvement request ownership changed.");
      intent.stage = stage; mayHaveWritten = true; mkdirSync(root, { recursive: true });
      if (!writeAtomic(path, JSON.stringify({ ...intent, contentHash: hash(intent) }), { mode: 0o600, beforeRename: owns })) throw new Error("Improvement request ownership changed.");
      syncPath(root, true); deps.afterPersist?.(stage === "saved" ? "receipt" : stage);
    };
    if (!previous) persist("intent");
    if (!readActionIndex(deps.stateDir, intent.proposalId)) writeActionIndex(deps.stateDir, { version: "improvement-actions-v1", proposalId: intent.proposalId, draft: null, file: null }, owns);
    mayHaveWritten = true;
    const registryPath = join(scope.inboxStateDir, "inbox-proposals.json"), draftsPath = join(scope.inboxStateDir, "inbox-drafts.json");
    strictRegistry(registryPath);
    updateProposalRegistry(registryPath, current => {
      strictRegistry(registryPath); if (!owns!()) throw new Error("Improvement request ownership changed.");
      const prior = current.find(row => row.id === intent.proposalId), goalDigest = hash([intent.binding, intent.goalBody, intent.context]);
      if (prior && (!prior.improvement || prior.improvement.repository !== request.repository || prior.improvement.instance !== scope.instance)) throw new Error("The saved proposal belongs to another source.");
      if (prior?.improvement?.goalDigest === goalDigest && prior.improvement.conversationReady) return null;
      if (prior && prior.improvement?.goalDigest !== goalDigest) {
        let drafts: DraftCache;
        try { drafts = readInboxJson(draftsPath) as DraftCache; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; drafts = {}; }
        if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) throw new Error("The existing draft cache is unavailable.");
        if (!writeAtomic(draftsPath, JSON.stringify(invalidateDraft(drafts, intent.proposalId)), { mode: 0o600, beforeRename: owns })) throw new Error("Improvement request ownership changed.");
      }
      const proposal: Proposal = { ...prior, id: intent.proposalId, summary: `${intent.context}\n\nOperator goal:\n${intent.goalBody}`, retainAfterRatification: true, evidenceAnchors: prior?.evidenceAnchors ?? [],
        trigger: { fired: false, description: "Choose Draft plan tasks when ready." },
        ...(prior && prior.improvement?.goalDigest !== goalDigest ? { reframeHistory: [...(prior.reframeHistory ?? []), { feedback: intent.goalBody }] } : {}),
        improvement: { version: IMPROVEMENT_THREAD_VERSION, repository: request.repository, instance: scope.instance, opportunityId: request.opportunityId,
          snapshotId: request.snapshotId, requestId, threadId: intent.threadId, goalDigest, conversationReady: false } };
      return [...current.filter(row => row.id !== proposal.id), proposal];
    }, { maxWaitMs: 0 });
    syncPath(registryPath); syncPath(scope.inboxStateDir, true); persist("proposal");
    const store = { threadStorePath: join(scope.inboxStateDir, "inbox-threads.jsonl"), now: () => (deps.clock ?? systemClock).now() };
    for (const [role, body, id] of [["escalation", intent.context, intent.contextId], ["reply", intent.goalBody, intent.goalId]] as const) {
      if (!owns()) return fail("uncertain", "The writer changed before the conversation was saved.", requestId);
      const appended = appendThreadMessageOnce(inboxThreadIdentity(intent.proposalId), role, body, id, store,
        { improvement: intent.binding, ...(role === "reply" ? { operator: deps.actorId } : {}) });
      if (appended.kind !== "appended" && appended.kind !== "existing") return fail(appended.kind === "busy" ? "busy" : "uncertain", "This message could not be confirmed as saved. Retry the same request.", requestId);
    }
    if (!messagesMatch(intent)) return fail("uncertain", "The conversation was written but cannot yet be verified.", requestId);
    persist("messages"); persist("saved");
    updateProposalRegistry(registryPath, current => {
      strictRegistry(registryPath); if (!owns!()) throw new Error("Improvement request ownership changed.");
      const proposal = current.find(row => row.id === intent.proposalId);
      if (proposal === undefined || proposal.improvement === undefined) throw new Error("The planning proposal is unavailable.");
      if (proposal.improvement.requestId !== requestId) {
        if (proposal.improvement.goalDigest === hash([intent.binding, intent.goalBody, intent.context]) && proposal.improvement.conversationReady) return null;
        throw new Error("The planning proposal changed while saving.");
      }
      return current.map(row => row.id === intent.proposalId ? { ...row, improvement: { ...row.improvement!, conversationReady: true } } : row);
    }, { maxWaitMs: 0 });
    syncPath(registryPath); syncPath(scope.inboxStateDir, true);
    return owns() ? saved(intent, previous !== undefined) : fail("uncertain", "The writer changed before the saved conversation could be acknowledged.", requestId);
  } catch {
    // A write may have reached disk. Only the same-key retry and the native messages can establish its outcome.
    return fail(mayHaveWritten ? "uncertain" : "source_unavailable", mayHaveWritten ? "The conversation could not be confirmed. Retry the same request; drafting and execution were not requested." : "The saved source or planning store is unavailable. No new conversation was confirmed.", requestId);
  } finally {
    if (lock && owns?.()) lock.release();
    if (requestOwner && ownsRequest?.()) requestOwner.release();
  }
}


export type ImprovementThreadView = Failure | {
  state: "saved"; version: typeof IMPROVEMENT_THREAD_VERSION; requestId: string; currentRequestId: string; proposalId: string; threadId: string;
  repository: string; instance: string; snapshotId: string; opportunityId: string; goal: string; constraints: string[]; goalDigest: string;
  source: { state: "current" | "stale" | "unavailable"; reason: string | null };
  messages: import("./inbox-thread.js").ThreadMessage[]; messageCount: number; messagesPartial: boolean; nextBeforeSeq: number | null;
  drafting: { state: "not_requested" | "requested" | "ready" | "unavailable" | "refused"; digest: string | null; fragmentYaml: string | null; reason: string | null; operationId?: string; sourceRequestId?: string };
  filing: { state: "not_requested" | "requested" | "plan_pr_opened" | "refused" | "uncertain"; operationId?: string; sourceRequestId?: string; receipt?: ImprovementPlanReceipt; reason?: string | null }; execution: { state: "not_requested" };
};

/** A saved chat remains readable when its source ages; new actions still require current evidence. */
export function readImprovementThread(requestId: string, deps: ImprovementThreadDeps, beforeSeq?: number): ImprovementThreadView {
  if (!/^[a-f0-9]{64}$/.test(requestId) || beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) return fail("invalid_request", "Use the saved conversation's request identity and a valid message position.");
  try {
    const root = join(deps.stateDir, "improvement-threads"), savedRequest = readIntent(join(root, `${requestId}.json`));
    if (!savedRequest) return fail("source_unavailable", "This saved conversation is unavailable.", requestId);
    const scope = scopeFor(savedRequest.request, deps.stateDir); if ("state" in scope) return { ...scope, requestId };
    if (hash(scope) !== hash(savedRequest.scope) || !messagesMatch(savedRequest)) return fail("uncertain", "This conversation's saved messages or fleet binding cannot be verified.", requestId);
    const proposal = strictRegistry(join(scope.inboxStateDir, "inbox-proposals.json")).find(row => row.id === savedRequest.proposalId);
    if (!proposal || !proposal.improvement || !proposal.improvement.conversationReady) return fail("uncertain", "This conversation's planning record cannot yet be verified. Retry its save request.", requestId);
    const current = readIntent(join(root, `${proposal.improvement.requestId}.json`));
    if (!current || current.stage !== "saved" || current.proposalId !== savedRequest.proposalId || hash(current.scope) !== hash(scope) || !messagesMatch(current))
      return fail("uncertain", "The conversation's latest goal cannot be verified.", requestId);
    const source = sourceFor(current.request, scope, deps);
    const sourceState: Extract<ImprovementThreadView, { state: "saved" }>["source"] = "state" in source
      ? { state: source.state === "source_stale" ? "stale" : "unavailable", reason: source.reason } : { state: "current", reason: null };
    let drafting: Extract<ImprovementThreadView, { state: "saved" }>["drafting"] = { state: proposal.trigger?.fired ? "requested" : "not_requested", digest: null, fragmentYaml: null, reason: null };
    try {
      const cache = readInboxJson(join(scope.inboxStateDir, "inbox-drafts.json")) as DraftCache;
      if (!cache || typeof cache !== "object" || Array.isArray(cache)) throw new Error("Invalid draft cache.");
      const draft = cache[proposal.id];
      if (draft) {
        if (draft.proposalId !== proposal.id || !text(draft.fragmentYaml, 512 * 1024) || !draft.completion || !draft.completion.lintClean ||
            draft.completion.violations.length !== 0 || draft.completion.snapshot.repository !== current.request.repository ||
            draft.completion.snapshot.generation !== inboxDraftGeneration(proposal))
          drafting = { state: "unavailable", digest: null, fragmentYaml: null, reason: "This draft is incomplete or belongs to an earlier goal. Request a new draft." };
        else drafting = { state: "ready", digest: hash(draft), fragmentYaml: draft.fragmentYaml, reason: null };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") drafting = { state: "unavailable", digest: null, fragmentYaml: null, reason: "The saved draft cache cannot be read." };
    }
    const read = readThread(current.threadId, { threadStorePath: join(scope.inboxStateDir, "inbox-threads.jsonl") });
    if (read.status !== "ok") return fail("uncertain", "The saved messages cannot currently be read.", requestId);
    const candidates = read.messages.filter(message => beforeSeq === undefined || message.seq < beforeSeq), messages: typeof read.messages = [];
    let bytes = 0;
    for (const message of candidates.toReversed()) {
      const size = Buffer.byteLength(JSON.stringify(message));
      if (messages.length === 100 || bytes + size > 512 * 1024) break;
      messages.unshift(message); bytes += size;
    }
    if (candidates.length && !messages.length) return fail("source_unavailable", "This conversation message exceeds the supported page size.", requestId);
    let filing: Extract<ImprovementThreadView, { state: "saved" }>["filing"] = { state: "not_requested" };
    try {
      const index = readActionIndex(deps.stateDir, proposal.id);
      if (!index) throw new Error("The action index is unavailable.");
      if (index.draft) {
        const action = readAction(deps.stateDir, index.draft);
        if (!action || action.proposalId !== proposal.id || action.kind !== "draft") {
          if (drafting.state !== "ready") drafting = { state: "unavailable", digest: null, fragmentYaml: null, reason: "A draft decision was started, but its saved receipt cannot currently be verified." };
        } else if (action.goalDigest === proposal.improvement.goalDigest) {
          if (drafting.state === "not_requested") drafting = { state: action.state === "refused" ? "refused" : action.state === "completed" || action.state === "uncertain" ? "unavailable" : "requested", digest: null, fragmentYaml: null,
            reason: action.reason ?? (action.state === "completed" ? "The completed draft's cached content cannot currently be verified." : null) };
          drafting = { ...drafting, operationId: action.operationId, sourceRequestId: action.requestId };
        }
      }
      if (index.file) {
        const action = readAction(deps.stateDir, index.file);
        if (!action || action.proposalId !== proposal.id || action.kind !== "file") throw new Error("The filing receipt cannot be verified.");
        filing = { state: action.state === "completed" && action.receipt ? "plan_pr_opened" : action.state === "refused" ? "refused" : action.state === "uncertain" || action.state === "completed" ? "uncertain" : "requested",
          operationId: action.operationId, sourceRequestId: action.requestId, ...(action.receipt ? { receipt: action.receipt } : {}), reason: action.reason };
      }
    } catch {
      // An unreadable index or pending pointer cannot prove the absence of a filing decision.
      filing = { state: "uncertain", reason: "This chat's filing history cannot currently be checked." };
      if (drafting.state !== "ready") drafting = { state: "unavailable", digest: null, fragmentYaml: null, reason: "This chat's drafting history cannot currently be checked." };
    }
    return { state: "saved", version: IMPROVEMENT_THREAD_VERSION, requestId, currentRequestId: current.requestId, proposalId: proposal.id, threadId: current.threadId,
      repository: current.request.repository, instance: scope.instance, snapshotId: current.request.snapshotId, opportunityId: current.request.opportunityId,
      goal: current.request.goal, constraints: current.request.constraints ?? [], goalDigest: proposal.improvement.goalDigest, source: sourceState,
      messages, messageCount: read.messages.length, messagesPartial: messages.length < read.messages.length,
      nextBeforeSeq: candidates.length > messages.length ? messages[0]!.seq : null, drafting, filing, execution: { state: "not_requested" } };
  } catch {
    // A store read failed; no empty chat, missing draft, or current-source authority can be inferred.
    return fail("source_unavailable", "This saved conversation cannot currently be read.", requestId);
  }
}

function resultStatus(result: { state: string }): number {
  return result.state === "saved" ? 200 : result.state === "invalid_request" ? 400 : ["source_stale", "conflict", "busy"].includes(result.state) ? 409 : 503;
}

/** Every write uses the service's existing authentication and tier admission. No client supplies a store path. */
export function buildImprovementThreadRoutes(options: { stateDir: string; clock?: Clock; launchAction?: ImprovementActionDeps["launchAction"] }): Route[] {
  return [
    { method: "POST", path: "/v1/improvements/threads", scope: "write", tier: "low", handler: jsonAction(
      body => { const request = requestInput(body); return request ?? { error: "Choose a saved repository finding, a goal, constraints, and a request identity." }; },
      async (request, req, res) => {
        const result = await createImprovementThread(request, { ...options, actorId: bearerTokenId(req) });
        sendJson(res, resultStatus(result), result);
      }) },
    ...(["draft", "file"] as const).map((kind): Route => ({ method: "POST", path: `/v1/improvements/threads/${kind}`, scope: "write", tier: kind === "file" ? "high" : "middle",
      handler: jsonAction(body => actionInput(body, kind) ?? { error: "Review the current saved goal and draft, then provide an explicit request identity." }, async (input, req, res) => {
        const result = await requestImprovementAction(kind, input, { ...options, actorId: bearerTokenId(req) });
        sendJson(res, result.state === "requested" ? 202 : resultStatus(result), result);
      }) })),
    { method: "GET", path: "/v1/improvements/action", scope: "read", handler: (req, res) => {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      if ([...params.keys()].some(key => key !== "operationId") || params.getAll("operationId").length !== 1 || !/^[a-f0-9]{64}$/.test(params.get("operationId")!)) { sendJson(res, 400, { error: "invalid_request", detail: "Use one saved action identity." }); return; }
      try {
        const operation = readAction(options.stateDir, params.get("operationId")!);
        if (!operation) { sendJson(res, 503, { state: "source_unavailable", reason: "The saved action is unavailable." }); return; }
        const view = readImprovementThread(operation.requestId, { ...options, actorId: bearerTokenId(req) });
        if (view.state !== "saved") { sendJson(res, resultStatus(view), view); return; }
        sendJson(res, 200, { state: "observed", operation, execution: { state: "not_requested" } });
      } catch {
        // Missing or unreadable operation data cannot establish that no action occurred.
        sendJson(res, 503, { state: "uncertain", reason: "The saved action cannot currently be verified." });
      }
    } },
    { method: "GET", path: "/v1/improvements/thread", scope: "read", handler: (req, res) => {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      if ([...params.keys()].some(key => !["requestId", "beforeSeq"].includes(key)) || params.getAll("requestId").length !== 1 || params.getAll("beforeSeq").length > 1 || params.has("beforeSeq") && !/^[1-9][0-9]{0,15}$/.test(params.get("beforeSeq")!)) { sendJson(res, 400, { error: "invalid_request", detail: "Use one saved conversation request identity." }); return; }
      const result = readImprovementThread(params.get("requestId")!, { ...options, actorId: bearerTokenId(req) }, params.has("beforeSeq") ? Number(params.get("beforeSeq")) : undefined);
      sendJson(res, resultStatus(result), result);
    } },
  ];
}

export interface ImprovementActionRequest { requestId: string; goalDigest: string; idempotencyKey: string; draftDigest?: string }
export interface ImprovementPlanReceipt {
  state: "plan_pr_opened"; prUrl: string; branch: string; taskIds: string[]; nativeReceiptId: string;
}
export interface ImprovementAction {
  version: "improvement-action-v1"; operationId: string; kind: "draft" | "file"; requestId: string; proposalId: string;
  actorId: string; payloadHash: string; goalDigest: string; draftDigest: string | null; requestedAt: string;
  state: "requested" | "waiting" | "completed" | "refused" | "uncertain"; reason: string | null;
  receipt: ImprovementPlanReceipt | null;
}
export interface ImprovementActionDeps extends ImprovementThreadDeps {
  /** Starts only the owned fresh-source CLI handoff. A request receipt is not a completed action. */
  launchAction?: (target: { operationId: string; stateDir: string; repoRoot: string }) => void;
}
export type ImprovementActionResult = Failure | { state: "requested"; operation: ImprovementAction; execution: { state: "not_requested" } };
function actionInput(value: unknown, kind: ImprovementAction["kind"]): ImprovementActionRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const b = value as Record<string, unknown>;
  if (Object.keys(b).some(key => !["requestId", "goalDigest", "idempotencyKey", ...(kind === "file" ? ["draftDigest"] : [])].includes(key)) ||
      ![b.requestId, b.goalDigest, ...(kind === "file" ? [b.draftDigest] : [])].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) ||
      typeof b.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(b.idempotencyKey)) return undefined;
  return b as unknown as ImprovementActionRequest;
}
interface ActionIndex { version: "improvement-actions-v1"; proposalId: string; draft: string | null; file: string | null }
function readActionIndex(stateDir: string, proposalId: string): ActionIndex | undefined {
  let value: unknown;
  try { value = readCodeHealthArtifactJson(join(stateDir, "improvement-threads", "action-index", `${hash(proposalId)}.json`), 4096); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const { contentHash, ...index } = value as ActionIndex & { contentHash: string };
  if (contentHash !== hash(index) || index.version !== "improvement-actions-v1" || index.proposalId !== proposalId ||
      ![index.draft, index.file].every(id => id === null || typeof id === "string" && /^[a-f0-9]{64}$/.test(id))) throw new Error("The saved action index is invalid.");
  return index;
}
function writeActionIndex(stateDir: string, index: ActionIndex, owns: () => boolean): void {
  const dir = join(stateDir, "improvement-threads", "action-index");
  if (!writeAtomic(join(dir, `${hash(index.proposalId)}.json`), JSON.stringify({ ...index, contentHash: hash(index) }), { mode: 0o600, beforeRename: owns })) throw new Error("Improvement action ownership changed.");
  syncPath(dir, true);
}
function actionPath(stateDir: string, operationId: string): string { return join(stateDir, "improvement-threads", "actions", `${operationId}.json`); }
function readAction(stateDir: string, operationId: string): ImprovementAction | undefined {
  if (!/^[a-f0-9]{64}$/.test(operationId)) throw new Error("Invalid improvement action identity.");
  let raw: unknown;
  try { raw = readCodeHealthArtifactJson(actionPath(stateDir, operationId), 32 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const { contentHash, ...action } = raw as ImprovementAction & { contentHash: string };
  if (contentHash !== hash(action) || action.version !== "improvement-action-v1" || action.operationId !== operationId ||
      !["draft", "file"].includes(action.kind) || !["requested", "waiting", "completed", "refused", "uncertain"].includes(action.state) ||
      ![action.requestId, action.goalDigest, action.payloadHash].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error("Invalid saved improvement action.");
  return action;
}
function writeAction(stateDir: string, action: ImprovementAction, owns: () => boolean): void {
  const path = actionPath(stateDir, action.operationId);
  if (!writeAtomic(path, JSON.stringify({ ...action, contentHash: hash(action) }), { mode: 0o600, beforeRename: owns })) throw new Error("Improvement action ownership changed.");
  syncPath(dirname(path), true);
}
function actionTarget(intent: Intent): { operationId: string; stateDir: string; repoRoot: string } {
  // The plan path is published by the server-owned instance registry, never supplied in the request.
  if (!intent.scope.planPath.endsWith("/plan/tasks.yaml")) throw new Error("The instance does not provide a supported repository plan path.");
  return { operationId: "", stateDir: "", repoRoot: dirname(dirname(intent.scope.planPath)) };
}

/** Save the explicit decision before requesting an owned CLI handoff. Filing binds the exact reviewed draft. */
export async function requestImprovementAction(kind: ImprovementAction["kind"], value: unknown, deps: ImprovementActionDeps): Promise<ImprovementActionResult> {
  const input = actionInput(value, kind);
  if (!input || !text(deps.actorId, 256)) return fail("invalid_request", "Use this conversation's current goal and an explicit request identity.");
  const operationId = hash([deps.actorId, "improvement-action", input.idempotencyKey]);
  let lock: InflightLockHandle | undefined, owns: (() => boolean) | undefined;
  let requestOwner: InflightLockHandle | undefined, ownsRequest: (() => boolean) | undefined;
  let wrote = false;
  try {
    requestOwner = requestLock(join(deps.stateDir, "improvement-threads"), `action-${operationId}`);
    if (!requestOwner) return fail("busy", "This action request is being saved, or its ownership is not yet known.");
    ownsRequest = lockOwnership(requestOwner);
    const intent = readIntent(join(deps.stateDir, "improvement-threads", `${input.requestId}.json`));
    if (!intent || intent.stage !== "saved") return fail("source_unavailable", "Save this conversation before requesting an action.");
    const currentScope = scopeFor(intent.request, deps.stateDir);
    if ("state" in currentScope || hash(currentScope) !== hash(intent.scope)) return fail("source_unavailable", "This chat could not be matched to its repository and fleet.");
    lock = requestLock(join(deps.stateDir, "improvement-threads"), hash([intent.request.repository, intent.scope.instance, intent.request.opportunityId]));
    if (!lock) return fail("busy", "This conversation is being updated, or its writer's ownership is not yet known.");
    const ownsConversation = lockOwnership(lock);
    owns = () => ownsConversation() && ownsRequest!();
    const previous = readAction(deps.stateDir, operationId), payloadHash = hash([kind, input]);
    if (previous && (previous.payloadHash !== payloadHash || previous.actorId !== deps.actorId)) return fail("conflict", "This action identity was already used for a different decision.");
    if (previous && ["completed", "refused", "uncertain"].includes(previous.state)) {
      if (previous.state === "uncertain" && previous.kind === "file" && deps.launchAction) deps.launchAction({ ...actionTarget(intent), operationId, stateDir: deps.stateDir });
      return { state: "requested", operation: previous, execution: { state: "not_requested" } };
    }
    const view = readImprovementThread(input.requestId, deps);
    if (view.state !== "saved") return view;
    if (view.currentRequestId !== input.requestId || view.goalDigest !== input.goalDigest) return fail("conflict", "The goal changed. Review the latest conversation before continuing.");
    const source = sourceFor(intent.request, intent.scope, deps); if ("state" in source) return source;
    if (kind === "file" && (view.drafting.state !== "ready" || view.drafting.digest !== input.draftDigest)) return fail("conflict", "Review the current completed draft before requesting filing.");
    if (deps.launchAction === undefined) return fail("source_unavailable", "This repository cannot start plan drafting or filing right now. No action was requested.");
    const action: ImprovementAction = previous ?? { version: "improvement-action-v1", operationId, kind, requestId: input.requestId, proposalId: intent.proposalId,
      actorId: deps.actorId, payloadHash, goalDigest: input.goalDigest, draftDigest: input.draftDigest ?? null, requestedAt: (deps.clock ?? systemClock).iso(), state: "requested", reason: null, receipt: null };
    if (!previous) {
      const index = readActionIndex(deps.stateDir, intent.proposalId);
      if (!index) throw new Error("The saved action index is unavailable.");
      // Publish the pointer first: interruption exposes an unverified decision, never a false 'not requested'.
      writeActionIndex(deps.stateDir, { ...index, [kind]: operationId }, owns); wrote = true;
      writeAction(deps.stateDir, action, owns);
    }
    if (kind === "draft" && ["requested", "waiting"].includes(action.state)) {
      const registryPath = join(intent.scope.inboxStateDir, "inbox-proposals.json");
      strictRegistry(registryPath);
      updateProposalRegistry(registryPath, current => {
        strictRegistry(registryPath); if (!owns!()) throw new Error("Improvement action ownership changed.");
        const proposal = current.find(row => row.id === intent.proposalId);
        if (!proposal || !proposal.improvement || proposal.improvement.goalDigest !== input.goalDigest || !proposal.improvement.conversationReady) throw new Error("The conversation changed before drafting was requested.");
        return current.map(row => row.id === intent.proposalId ? { ...row, trigger: { fired: true, description: "Plan drafting explicitly requested for this saved goal." } } : row);
      }, { maxWaitMs: 0 });
      syncPath(registryPath); syncPath(intent.scope.inboxStateDir, true);
    }
    if (!owns()) return fail("uncertain", "The decision was saved, but its writer changed before handoff.");
    // The worker independently takes the same conversation lock and revalidates source, goal and draft.
    // Only pending work is re-handed off; completed or ambiguous filing is never blindly repeated.
    if (["requested", "waiting"].includes(action.state)) deps.launchAction({ ...actionTarget(intent), operationId, stateDir: deps.stateDir });
    return { state: "requested", operation: action, execution: { state: "not_requested" } };
  } catch {
    // A saved decision can precede a failed handoff. Recovery must inspect the operation, not invent success.
    return fail(wrote ? "uncertain" : "source_unavailable", "The action could not be confirmed. Reuse the same request identity to inspect or recover it.");
  } finally {
    if (lock && owns?.()) lock.release();
    if (requestOwner && ownsRequest?.()) requestOwner.release();
  }
}

export interface ImprovementActionRunnerDeps extends ImprovementThreadDeps {
  draft: (target: { proposalId: string; repository: string; controlRoot: string; repoRoot: string; planPath: string }) => Promise<void>;
  file: (target: { proposalId: string; repository: string; controlRoot: string; repoRoot: string; planPath: string; goalDigest: string; draftDigest: string }) => Promise<ImprovementPlanReceipt | undefined>;
  recoverFiling: (target: { proposalId: string; ledgerPath: string }) => ImprovementPlanReceipt | undefined;
}

/** Owned CLI worker: no caller-provided paths, commands, routing changes, force-draft, or admission exemptions. */
export async function runImprovementAction(operationId: string, deps: ImprovementActionRunnerDeps): Promise<ImprovementAction | Failure> {
  let lock: InflightLockHandle | undefined, owns: (() => boolean) | undefined;
  let action: ImprovementAction | undefined;
  try {
    action = readAction(deps.stateDir, operationId);
    if (!action) return fail("source_unavailable", "This saved action request is unavailable.");
    if (["completed", "refused"].includes(action.state)) return action;
    const intent = readIntent(join(deps.stateDir, "improvement-threads", `${action.requestId}.json`));
    if (!intent || intent.stage !== "saved" || intent.proposalId !== action.proposalId) return fail("source_unavailable", "This action's saved conversation cannot be verified.");
    const scope = scopeFor(intent.request, deps.stateDir);
    if ("state" in scope || hash(scope) !== hash(intent.scope)) return fail("source_unavailable", "This action's fleet store has changed.");
    lock = requestLock(join(deps.stateDir, "improvement-threads"), hash([intent.request.repository, scope.instance, intent.request.opportunityId]));
    if (!lock) return fail("busy", "A conversation writer or action still owns this improvement.");
    owns = lockOwnership(lock);
    action = readAction(deps.stateDir, operationId);
    if (!action || action.proposalId !== intent.proposalId || action.requestId !== intent.requestId) return fail("uncertain", "The action changed during admission.");
    if (["completed", "refused"].includes(action.state)) return action;
    // The native ratification receipt is the recovery authority, including after source or goal changes.
    if (action.kind === "file") {
      const recovered = deps.recoverFiling({ proposalId: intent.proposalId, ledgerPath: scope.ledgerPath });
      if (recovered) { action.state = "completed"; action.receipt = recovered; action.reason = null; writeAction(deps.stateDir, action, owns); return action; }
      if (action.state === "uncertain") return action; // Do not repeat ambiguous consequential work without its native receipt.
    }
    const view = readImprovementThread(action.requestId, deps);
    const source = sourceFor(intent.request, scope, deps);
    if (view.state !== "saved" || view.currentRequestId !== action.requestId || view.goalDigest !== action.goalDigest || "state" in source ||
        action.kind === "file" && (view.drafting.state !== "ready" || view.drafting.digest !== action.draftDigest)) {
      action.state = "refused"; action.reason = "The source, goal, or reviewed draft changed before this action could run."; writeAction(deps.stateDir, action, owns); return action;
    }
    const target = { proposalId: intent.proposalId, repository: intent.request.repository, controlRoot: dirname(scope.inboxStateDir),
      repoRoot: actionTarget(intent).repoRoot, planPath: scope.planPath };
    // Save uncertainty BEFORE any consequential native filing call. A crash cannot look unattempted on restart.
    action.state = action.kind === "file" ? "uncertain" : "waiting"; action.reason = "Waiting for the repository workflow to confirm the result.";
    writeAction(deps.stateDir, action, owns);
    if (!owns()) return fail("uncertain", "The action writer changed before execution.");
    if (action.kind === "draft") {
      await deps.draft(target);
      if (!owns()) return fail("uncertain", "The draft writer changed before acknowledgement.");
      const after = readImprovementThread(action.requestId, deps);
      action.state = after.state === "saved" && after.drafting.state === "ready" ? "completed" : "waiting";
      action.reason = action.state === "completed" ? null : "Plan drafting has not finished. Normal checks and retry limits still apply.";
    } else {
      const receipt = await deps.file({ ...target, goalDigest: action.goalDigest, draftDigest: action.draftDigest! });
      if (!owns()) return fail("uncertain", "The filing writer changed before acknowledgement. Inspect the native receipt.");
      action.receipt = receipt ?? null; action.state = receipt ? "completed" : "uncertain";
      action.reason = receipt ? null : "A plan pull request could not be confirmed. Check the saved result before retrying.";
    }
    writeAction(deps.stateDir, action, owns); return action;
  } catch {
    // Preserve the pre-call uncertainty journal. The absence of a response never establishes a failed or completed filing.
    return fail("uncertain", "The action's outcome cannot currently be verified. Check its saved receipt before trying again.");
  } finally { if (lock && owns?.()) lock.release(); }
}


/** The ordinary approve path calls this too; a legacy CLI or cached approval cannot substitute another draft. */
export function isReviewedImprovementDraft(proposal: Proposal, draft: DraftedCandidate | undefined,
  reviewed: { goalDigest: string; draftDigest: string } | undefined): boolean {
  return proposal.improvement !== undefined && proposal.improvement.conversationReady && reviewed !== undefined && draft !== undefined &&
    proposal.improvement.goalDigest === reviewed.goalDigest && hash(draft) === reviewed.draftDigest && draft.proposalId === proposal.id &&
    draft.completion !== undefined && draft.completion.lintClean && Array.isArray(draft.completion.violations) && draft.completion.violations.length === 0 &&
    draft.completion.snapshot.repository === proposal.improvement.repository && draft.completion.snapshot.generation === inboxDraftGeneration(proposal);
}
