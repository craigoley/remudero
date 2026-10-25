import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { CODE_HEALTH_POLICY_VERSION } from "./code-health-collector.js";
import { codeHealthRepositoryStateDir, readCodeHealthArtifactJson, readCodeHealthCollectionFailure, readCodeHealthSnapshot } from "./code-health-store.js";
import { readCodeHealthInventory, readCodeHealthRelatedWork } from "./code-health-view.js";
import { buildCodeHealthOpportunities } from "./codeql-quality-intake.js";
import { acquireInflightLock, parseInflightLockInfo, type InflightLockHandle } from "./inflight-lock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, reclaimStaleLock, writeAtomic } from "./fs-race-safe.js";
import { invalidateDraft, parseProposalRegistryResult, updateProposalRegistry, type DraftCache, type Proposal } from "./inbox.js";
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
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("The native Inbox file changed during its read.");
    return JSON.parse(bytes.toString("utf8"));
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
  if (matching?.length !== 1) return fail("source_unavailable", "The selected fleet instance cannot be resolved.");
  const options = matching[0]!.options;
  if (![options.controlRoot, options.ledgerPath, options.planPath].every(value => text(value, 4096) && isAbsolute(value)))
    return fail("source_unavailable", "This fleet instance does not provide a verified planning store.");
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
    `Observed finding (quoted): ${JSON.stringify(opportunity.title)}`, `Practical consequence: ${opportunity.consequence}`,
    `Expected result: ${opportunity.expectedResult}`, `Evidence: ${excerpt.length} shown of ${opportunity.evidenceCount} findings.`, JSON.stringify(excerpt),
    `Uncertainty: ${opportunity.uncertainty.join(" ") || "The effect on delivery has not been measured."}`,
    `Effort: ${opportunity.effortMinutes === null ? "Not estimated." : `${opportunity.effortMinutes} minutes, modeled estimate; not a measured duration.`}`,
    `Related work (${related.state}): ${JSON.stringify(opportunity.relatedWork)}`, related.reason ?? "Review existing work before filing.",
    `Draft acceptance ideas: ${opportunity.acceptanceIdeas.join(" ")}`, "Falsifier idea: repeat the same analysis; an unresolved linked finding disproves the improvement.",
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
    catch { return false; } // Unknown ownership never permits a write or release.
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
    if (previous && hash(previous.scope) !== hash(scope)) return fail("source_unavailable", "The saved conversation's fleet store has changed. Review its source before continuing.", requestId);
    if (previous?.stage === "saved") {
      if (!messagesMatch(previous)) return fail("uncertain", "The saved receipt exists, but its conversation cannot currently be verified.", requestId);
      // Repair only this request's interrupted ready marker. Replaying an older request must never reset a later goal or action.
      const registryPath = join(scope.inboxStateDir, "inbox-proposals.json");
      strictRegistry(registryPath);
      updateProposalRegistry(registryPath, current => {
        strictRegistry(registryPath); if (!owns!()) throw new Error("Improvement request ownership changed.");
        const proposal = current.find(row => row.id === previous.proposalId);
        if (!proposal?.improvement) throw new Error("The saved proposal is unavailable.");
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
      const proposal: Proposal = { ...prior, id: intent.proposalId, summary: `${intent.context}\n\nOperator goal:\n${intent.goalBody}`, evidenceAnchors: prior?.evidenceAnchors ?? [],
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
      if (appended.kind !== "appended" && appended.kind !== "existing") return fail(appended.kind === "busy" ? "busy" : "uncertain", "The native Inbox writer could not confirm this message. Retry the same request.", requestId);
    }
    if (!messagesMatch(intent)) return fail("uncertain", "The conversation was written but cannot yet be verified.", requestId);
    persist("messages"); persist("saved");
    updateProposalRegistry(registryPath, current => {
      strictRegistry(registryPath); if (!owns!()) throw new Error("Improvement request ownership changed.");
      const proposal = current.find(row => row.id === intent.proposalId);
      if (!proposal?.improvement) throw new Error("The planning proposal is unavailable.");
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
