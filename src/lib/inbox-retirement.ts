/** Durable reversible lifecycle, shared by the producer, CLI eligibility and owned restore action. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, reclaimStaleLock, writeAtomic } from "./fs-race-safe.js";
import { inboxDismissalReceipt, type InboxDismissalReceipt } from "./inbox-dismissal-audit.js";
import { readAllThreads, inboxThreadId } from "./inbox-thread.js";

export const INBOX_RETIREMENT_RESTORE_ACTION = "retirement-restore";
export type InboxGardenerMode = "off" | "shadow" | "act";
const isGardenerMode = (value: unknown): value is InboxGardenerMode => value === "off" || value === "shadow" || value === "act";
/** The durable `inboxGardenerMode` key of config.json (W1-T13258), read WITHOUT `loadConfig`: that
 *  creates a missing file, and resolving a mode must never write. Absent, unreadable, unparsable or
 *  invalid all read as no setting. */
export function readConfiguredInboxGardenerMode(path: string = join(homedir(), ".config", "remudero", "config.json")): InboxGardenerMode | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    const mode = parsed !== null && typeof parsed === "object" ? (parsed as { inboxGardenerMode?: unknown }).inboxGardenerMode : undefined;
    return isGardenerMode(mode) ? mode : undefined;
  } catch {
    // A missing or malformed file is "no durable setting": the gardener stays off, the fail-closed default.
    return undefined;
  }
}
/** A valid shadow/act env value wins; otherwise the config.json setting; otherwise off. */
export function inboxGardenerMode(
  env: NodeJS.ProcessEnv = process.env,
  readConfigured: () => InboxGardenerMode | undefined = readConfiguredInboxGardenerMode,
): InboxGardenerMode {
  if (env.RMD_INBOX_GARDENER_MODE === "act" || env.RMD_INBOX_GARDENER_MODE === "shadow") return env.RMD_INBOX_GARDENER_MODE;
  return readConfigured() ?? "off";
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const inboxSemanticDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export interface InboxGardenerScope { repository: string; instance: string; root: string }
export interface MechanicalAskPurpose {
  producer: "proof-queue-audit-v1";
  kind: "mechanical-task";
  taskId: string;
  criteriaDigest: string;
  taskDigest: string;
  proposalDigest: string;
}
export interface RetirementProposal {
  id: string; summary: string; evidenceAnchors: unknown[]; reframeHistory?: unknown[];
  automaticRetirement?: MechanicalAskPurpose;
}
const verificationProducerObjects = new WeakSet<object>();
const proofDebtPopulations = new WeakMap<object, ReadonlyMap<string, string>>();
const mechanicalProducerObjects = new WeakSet<object>();
/** Code-owned capability created only after the cadence has excluded credited tasks. It is not JSON. */
export function proofDebtPopulationPermit(unmergedTasks: readonly InboxGardenerTaskFact[]): object {
  const permit = Object.freeze({});
  proofDebtPopulations.set(permit, new Map(unmergedTasks.map(task => [task.id, inboxMechanicalTaskDigest(task)])));
  return permit;
}
export function stampMechanicalAsk<T extends RetirementProposal>(proposal: T, taskId: string, permit?: object): T {
  if (permit && proofDebtPopulations.get(permit)?.has(taskId)) {
    proposal.automaticRetirement = { producer: "proof-queue-audit-v1", kind: "mechanical-task", taskId,
      criteriaDigest: inboxSemanticDigest(proposal.evidenceAnchors), proposalDigest: inboxMechanicalProposalDigest(proposal), taskDigest: proofDebtPopulations.get(permit)!.get(taskId)! };
    // W1-T15033: a stamp the registry guard would reject (an id such as NEW-1a) leaves an ordinary ask, never a throw.
    if (mechanicalAskPurpose(proposal)) mechanicalProducerObjects.add(proposal);
    else delete proposal.automaticRetirement;
  }
  return proposal;
}
export const isMechanicalProducerObject = (proposal: object): boolean => mechanicalProducerObjects.has(proposal);
/** Only a real code producer stamps this capability; a parsed client/model object cannot supply it. */
export function stampVerificationAsk<T extends RetirementProposal>(proposal: T, taskId: string, producer: "verify-human-judge-v1" | "machine-filing-judge-v1" = "verify-human-judge-v1"): T & { verificationAsk: { producer: "verify-human-judge-v1" | "machine-filing-judge-v1"; taskId: string; proposalDigest: string } } {
  verificationProducerObjects.add(proposal);
  return Object.assign(proposal, { verificationAsk: { producer, taskId, proposalDigest: inboxMechanicalProposalDigest(proposal) } });
}
export const isVerificationProducerObject = (proposal: object): boolean => verificationProducerObjects.has(proposal);
export type InboxTerminalProof =
  | { kind: "merged-task"; taskId: string; repository: string; instance: string; number: number; url: string;
      state: "MERGED"; headRefName: string; headSha: string; mergeSha: string; body: string; credit: "trailer" | "run-branch";
      implementationCredit: true; paths: string[] }
  | { kind: "plan-retirement"; taskId: string; repository: string; instance: string; commit: string; blob: string; retirement: string }
  | { kind: "handoff"; taskId: string; repository: string; instance: string; receiptId: string; runId: string;
      authority: "operator"; released: "verify-human"; proposalId: string }
  | { kind: "successor"; taskId: string; repository: string; instance: string; successorId: string; revision: string;
      predecessorCriteria: string; present: true; open: true };
export interface InboxRetirementView {
  retirementId: string; snapshotKey: string; scope: { repository: string; instance: string; proposalId: string; taskId: string | null };
  proofId: string; reason: string; state: "retired" | "restored_for_review";
  proofKind: InboxTerminalProof["kind"];
}
export interface InboxLifecycleEvent {
  receipt: InboxDismissalReceipt;
  reason: string;
  inputDigest: string;
  proposalRevision: string;
  operatorIntent: string;
  proof: InboxTerminalProof;
  proofId: string;
  codeSha: string;
  operator?: string;
  intentId?: string;
  mirrored?: boolean;
}
export interface InboxGardenerEntry {
  digest: string; decision: string; reason: string;
  judge?: "started" | "complete" | "failed" | "unconfigured";
}
export interface InboxGardenerStore {
  version: 1; scope: InboxGardenerScope; entries: Record<string, InboxGardenerEntry>; events: InboxLifecycleEvent[];
  cursor?: { generation: string; after: string };
}
export type InboxGardenerStoreRead = { state: "observed"; store: InboxGardenerStore } | { state: "absent" } | { state: "unavailable"; reason: string };
export const inboxGardenerPath = (stateDir: string): string => join(stateDir, "inbox-gardener.json");
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export const sameInboxGardenerScope = (a: InboxGardenerScope, b: InboxGardenerScope): boolean =>
  a.repository === b.repository && a.instance === b.instance && a.root === b.root;
export function inboxMechanicalProposalDigest(p: RetirementProposal): string {
  return inboxSemanticDigest([p.id, p.summary, p.evidenceAnchors, p.reframeHistory ?? []]);
}
export function mechanicalAskPurpose(p: RetirementProposal): MechanicalAskPurpose | undefined {
  const purpose = p.automaticRetirement;
  return purpose?.producer === "proof-queue-audit-v1" && purpose.kind === "mechanical-task" &&
    typeof purpose.taskId === "string" && purpose.taskId.length <= 160 && /^W\d+-T[A-Za-z0-9]+$/.test(purpose.taskId) &&
    typeof p.id === "string" && new RegExp(`^proof-debt:${purpose.taskId}(?::\\d+)?$`).test(p.id) && Array.isArray(p.evidenceAnchors) && p.evidenceAnchors.length > 0 &&
    hash(purpose.taskDigest) && purpose.proposalDigest === inboxMechanicalProposalDigest(p) && hash(purpose.criteriaDigest) && purpose.criteriaDigest === inboxSemanticDigest(p.evidenceAnchors) ? purpose : undefined;
}
/**
 * W1-T13197: THE ASKS THE GARDENER MAY JUDGE. A proof-debt ask carries its producer's typed purpose; a finished-task ask is
 * a `verify-human:` / `verify-human-automate:` / `machine-judge:` ask, read with core's deriveTaskReferent shapes, whose
 * only possible retirement is its own task having shipped. Operator ruling 2026-11-16 13:47Z ("Yes, retire them
 * reversibly") supersedes W1-T9284's no-backfill rule for finished tasks only: such an ask retires solely on a merged-task
 * or plan-retirement proof of ITS task, never on a handoff, a successor, a judge, or a related task's merge.
 */
export type RetirementAsk = { kind: "mechanical"; taskId: string; purpose: MechanicalAskPurpose } | { kind: "finished-task"; taskId: string };
const FINISHED_TASK_ASK = /^(?:verify-human|verify-human-automate|machine-judge):([A-Za-z0-9][A-Za-z0-9-]*)$/;
export function retirementAsk(p: RetirementProposal): RetirementAsk | undefined {
  const purpose = mechanicalAskPurpose(p);
  if (purpose) return { kind: "mechanical", taskId: purpose.taskId, purpose };
  // A producer-stamped mechanical purpose that no longer verifies is never re-read as a finished-task ask.
  if (p.automaticRetirement || typeof p.id !== "string") return undefined;
  const taskId = FINISHED_TASK_ASK.exec(p.id)?.[1];
  return taskId && taskId.length <= 160 ? { kind: "finished-task", taskId } : undefined;
}
export function validInboxTerminalProof(proof: InboxTerminalProof | undefined, scope: InboxGardenerScope, p: RetirementProposal): proof is InboxTerminalProof {
  const ask = retirementAsk(p);
  if (!ask || !proof || proof.taskId !== ask.taskId || proof.repository !== scope.repository || proof.instance !== scope.instance) return false;
  if (ask.kind === "finished-task" && proof.kind !== "merged-task" && proof.kind !== "plan-retirement") return false;
  if (proof.kind === "merged-task") {
    if (typeof proof.body !== "string" || typeof proof.headRefName !== "string") return false;
    const ownedBranch = new RegExp(`^run-${ask.taskId}-[0-9]+$`).test(proof.headRefName);
    const trailer = proof.body.split(/\r?\n/).some(line => line === `Remudero-Task: ${ask.taskId}`);
    return proof.state === "MERGED" && Number.isSafeInteger(proof.number) && proof.number > 0 &&
      typeof proof.headRefName === "string" && !!proof.headRefName && proof.implementationCredit === true &&
      Array.isArray(proof.paths) && proof.paths.length > 0 && proof.paths.every(p => typeof p === "string" && !!p) &&
      proof.url === `https://github.com/${scope.repository}/pull/${proof.number}` && /^[a-f0-9]{40}$/.test(proof.headSha) &&
      /^[a-f0-9]{40}$/.test(proof.mergeSha) && (proof.credit === "trailer" ? trailer : proof.credit === "run-branch" && ownedBranch);
  }
  if (proof.kind === "plan-retirement") return /^[a-f0-9]{40}$/.test(proof.commit) && /^[a-f0-9]{40}$/.test(proof.blob) &&
    ["retired", "closed", "withdrawn"].includes(proof.retirement);
  if (ask.kind !== "mechanical") return false;
  const purpose = ask.purpose;
  if (proof.kind === "handoff") return proof.authority === "operator" && proof.released === "verify-human" && proof.proposalId === p.id && hash(proof.receiptId) && !!proof.runId;
  return proof.kind === "successor" && proof.present === true && proof.open === true &&
    p.id === `${proof.successorId}:${p.id.split(":").at(-1)}` &&
    proof.successorId === `proof-debt:${purpose.taskId}` && hash(proof.revision) && proof.predecessorCriteria === purpose.criteriaDigest;
}
export const inboxProposalRevision = (p: RetirementProposal): string => inboxSemanticDigest([p.id, p.summary, p.evidenceAnchors, p.reframeHistory ?? [], p.automaticRetirement ?? null]);
export function inboxOperatorIntent(messages: readonly { role: string; body: string; seq: number; ts: number; extra?: { event?: unknown } }[]): string {
  return inboxSemanticDigest(messages.filter(m => m.role === "reply" && m.extra?.event === undefined));
}
export interface InboxGardenerTaskFact { id: string; title: string; repo: string; verify: string; depends_on: string[]; dispatch_hold?: boolean; retirement?: string; status?: string; risk?: string; acceptance?: unknown[] }
export function inboxMechanicalTaskDigest(task: InboxGardenerTaskFact): string {
  const { retirement: _retirement, status: _status, dispatch_hold: _hold, ...identity } = inboxGardenerTaskFact(task);
  return inboxSemanticDigest(identity);
}
export function inboxGardenerTaskFact(task: InboxGardenerTaskFact): InboxGardenerTaskFact {
  return { id: task.id, title: task.title, repo: task.repo, verify: task.verify, depends_on: task.depends_on, acceptance: task.acceptance ?? [],
    ...(task.dispatch_hold ? { dispatch_hold: true } : {}), ...(task.retirement ? { retirement: task.retirement, status: task.status } : {}), ...(task.risk ? { risk: task.risk } : {}) };
}
export function inboxGardenerSource(proposals: RetirementProposal[], tasks: ReadonlyMap<string, InboxGardenerTaskFact>, scope: InboxGardenerScope,
  operatorIntents: ReadonlyMap<string, string> = new Map()) {
  const facts = proposals.map(p => { const id = retirementAsk(p)?.taskId, task = id ? tasks.get(id) : undefined;
    return [p.id, inboxProposalRevision(p), task ? inboxGardenerTaskFact(task) : null,
      task?.depends_on.map(dep => tasks.get(dep) ? inboxGardenerTaskFact(tasks.get(dep)!) : null) ?? [], operatorIntents.get(p.id) ?? inboxSemanticDigest([])]; });
  const owned = { repository: scope.repository, instance: scope.instance, root: scope.root };
  // W1-T13714: one short digest per proposal over its registry revision and plan facts, so a reader holding another plan
  // revision can tell WHICH proposals differ. Operator input stays whole-population: unpublished input still refuses the pass.
  const items: Record<string, string> = Object.fromEntries(facts.map(fact => [fact[0] as string, inboxSemanticDigest(fact.slice(0, 4)).slice(0, 16)]));
  return { scope: owned, identity: inboxSemanticDigest([owned, facts]), items, intents: inboxSemanticDigest(facts.map(fact => [fact[0], fact[4]])) };
}

/** Qualify and consume one owned descriptor; a path replacement cannot bypass the byte bound. */
export function readInboxGardenerFile(path: string, maxBytes: number): string {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Inbox source is oversized or not a regular file");
    const chunks: Buffer[] = []; let bytes = 0;
    while (bytes <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytes));
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > maxBytes) throw new Error("Inbox source grew oversized while being read");
      chunks.push(buffer.subarray(0, read));
    }
    if (fs.fstatSync(fd).size !== stat.size) throw new Error("Inbox source changed while being read");
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally { fs.closeSync(fd); }
}

export function readInboxGardenerStore(stateDir: string, scope?: InboxGardenerScope): InboxGardenerStoreRead {
  try {
    const path = inboxGardenerPath(stateDir);
    const s = JSON.parse(readInboxGardenerFile(path, 8 * 1024 * 1024));
    if (!record(s) || s.version !== 1 || !record(s.scope) || ![s.scope.repository, s.scope.instance, s.scope.root].every(x => typeof x === "string" && x) ||
      scope && !sameInboxGardenerScope({ repository: s.scope.repository, instance: s.scope.instance, root: s.scope.root }, scope) || !record(s.entries) || !Array.isArray(s.events) ||
      s.cursor !== undefined && (!record(s.cursor) || !hash(s.cursor.generation) || typeof s.cursor.after !== "string")) throw new Error("unverified lifecycle journal");
    const ids = new Set<string>();
    for (const e of s.events) {
      const receipt = inboxDismissalReceipt(e?.receipt);
      if (!record(e) || !receipt || ids.has(receipt.id) || receipt.scope.repository !== s.scope.repository || receipt.scope.instance !== s.scope.instance ||
        ![e.inputDigest, e.proposalRevision, e.operatorIntent, e.proofId].every(hash) || typeof e.reason !== "string" || !record(e.proof) ||
        inboxSemanticDigest(e.proof) !== e.proofId || typeof e.codeSha !== "string" || e.mirrored !== undefined && typeof e.mirrored !== "boolean") throw new Error("unverified lifecycle event");
      ids.add(receipt.id);
      if (receipt.kind !== "retire") {
        const original = s.events.find((x: InboxLifecycleEvent) => x.receipt.id === receipt.retirementId && x.receipt.kind === "retire");
        if (!original || original.receipt.snapshotKey !== receipt.snapshotKey || JSON.stringify(original.receipt.scope) !== JSON.stringify(receipt.scope)) throw new Error("lifecycle event has no exact original anchor");
        if (receipt.kind === "restore" && (receipt.authority !== "operator" || typeof e.operator !== "string" || !e.operator || !/^[A-Za-z0-9._:-]{8,128}$/.test(e.intentId) ||
          receipt.operator !== e.operator || receipt.intentId !== e.intentId || receipt.id !== inboxSemanticDigest([original.receipt.id, "restore", e.operator, e.intentId,
            inboxSemanticDigest({ proposalId: receipt.scope.proposalId, retirementId: original.receipt.id, snapshotKey: original.receipt.snapshotKey, taskId: receipt.scope.taskId, reason: e.reason })]))) throw new Error("restoration acknowledgement binding is unverified");
      }
    }
    for (const entry of Object.values(s.entries)) if (!record(entry) || !hash(entry.digest) || typeof entry.decision !== "string" || typeof entry.reason !== "string" ||
      entry.judge !== undefined && !["started", "complete", "failed", "unconfigured"].includes(entry.judge)) throw new Error("unverified lifecycle evaluation");
    return { state: "observed", store: s as unknown as InboxGardenerStore };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "unavailable", reason: String(error) };
  }
}
export function writeInboxGardenerStore(stateDir: string, store: InboxGardenerStore): void {
  fs.mkdirSync(stateDir, { recursive: true });
  writeAtomic(inboxGardenerPath(stateDir), JSON.stringify(store) + "\n");
}

/** One shared lock coordinates child passes and restoration. Reclaims only a proven dead own-host holder. */
export async function withInboxGardenerLock<T>(stateDir: string, run: () => T | Promise<T>, clock: Clock = systemClock): Promise<T | { state: "busy" }> {
  fs.mkdirSync(stateDir, { recursive: true });
  const path = inboxGardenerPath(stateDir) + ".lock";
  const acquire = () => {
    const fd = fs.openSync(path, "wx");
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: clock.iso() })); }
    finally { fs.closeSync(fd); }
  };
  try { acquire(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const result = reclaimStaleLock(path, { parseHolder: raw => { try { const p = JSON.parse(raw); return typeof p?.pid === "number" ? p : null; } catch (error) { /* Malformed holder identity is unknown; the stale-lock helper must refuse reclamation. */ return null; } },
      isStale: held => isHolderStale(held, { isPidAlive: defaultIsPidAlive }) });
    if (result.outcome !== "reclaimed" && result.outcome !== "missing") return { state: "busy" };
    try { acquire(); } catch (race) { if ((race as NodeJS.ErrnoException).code === "EEXIST") return { state: "busy" }; throw race; }
  }
  try { return await run(); }
  finally { fs.unlinkSync(path); }
}

export function inboxRetirementFor(read: InboxGardenerStoreRead, p: RetirementProposal, operatorIntent?: string): InboxRetirementView | { unknown: string } | undefined {
  if (read.state === "unavailable") return { unknown: read.reason };
  if (read.state === "absent") return undefined;
  const retirement = [...read.store.events].reverse().find(e => e.receipt.kind === "retire" && e.receipt.scope.proposalId === p.id);
  if (!retirement) {
    const pending = read.store.entries[p.id];
    return pending && (pending.decision === "needs_triage" || pending.decision === "defer_source") ? { unknown: `Inbox revalidation needs triage: ${pending.judge === "started" ? "judge completion unknown; not automatically retried" : pending.reason}` } : undefined;
  }
  if (!validInboxTerminalProof(retirement.proof, read.store.scope, p) || retirement.receipt.authority !== "automatic" || retirement.receipt.heldAtRetirement !== false ||
    retirement.receipt.scope.taskId !== retirementAsk(p)?.taskId) return { unknown: "retirement proof or current mechanical purpose is unverified" };
  const restored = read.store.events.some(e => e.receipt.kind === "restore" && e.receipt.retirementId === retirement.receipt.id);
  const changed = inboxProposalRevision(p) !== retirement.proposalRevision || operatorIntent !== undefined && operatorIntent !== retirement.operatorIntent;
  return { retirementId: retirement.receipt.id, snapshotKey: retirement.receipt.snapshotKey, scope: retirement.receipt.scope,
    proofId: retirement.proofId, proofKind: retirement.proof.kind, reason: restored ? "Operator restored this ask for review; the original terminal proof remains history" : changed ? "New operator or proposal input requires review after retirement" : retirement.reason,
    state: restored || changed ? "restored_for_review" : "retired" };
}

/** CLI/write eligibility reads one owned lifecycle and one current thread population per operation. */
export function inboxRetirementContext(stateDir: string, scope: InboxGardenerScope) {
  const read = readInboxGardenerStore(stateDir, scope);
  const threads = read.state === "absent" ? undefined : readAllThreads({ threadStorePath: join(stateDir, "inbox-threads.jsonl") });
  return (p: RetirementProposal) => read.state !== "absent" && threads?.status !== "ok" ? { unknown: "current operator intent unavailable" }
    : inboxRetirementFor(read, p, inboxOperatorIntent(threads?.status === "ok" ? threads.threads.get(inboxThreadId(p.id)) ?? [] : []));
}

export interface InboxRetirementRestoreInput { proposalId: string; retirementId: string; snapshotKey: string; taskId: string | null; reason: string }
export async function restoreInboxRetirement(stateDir: string, scope: InboxGardenerScope, input: InboxRetirementRestoreInput, actor: string, intentId: string, now: string, admit?: () => boolean) {
  return withInboxGardenerLock(stateDir, () => {
    const read = readInboxGardenerStore(stateDir, scope);
    if (read.state !== "observed") return { status: 503, body: { error: "inbox_retirement_unavailable", delivery: "not_delivered" } };
    const original = read.store.events.find(e => e.receipt.kind === "retire" && e.receipt.id === input.retirementId &&
      e.receipt.scope.proposalId === input.proposalId && e.receipt.scope.taskId === input.taskId && e.receipt.snapshotKey === input.snapshotKey);
    if (!original) return { status: 409, body: { error: "inbox_retirement_mismatch", delivery: "not_delivered" } };
    const priorIntent = read.store.events.find(e => e.receipt.kind === "restore" && e.operator === actor && e.intentId === intentId);
    if (priorIntent && (priorIntent.receipt.retirementId !== original.receipt.id || priorIntent.reason !== input.reason))
      return { status: 409, body: { error: "inbox_intent_conflict", delivery: "not_delivered" } };
    const existing = read.store.events.find(e => e.receipt.kind === "restore" && e.receipt.retirementId === original.receipt.id);
    if (existing) {
      if (existing.operator !== actor || existing.intentId !== intentId) return { status: 409, body: { error: "inbox_retirement_already_restored", delivery: "not_delivered", receipt: existing.receipt } };
      if (existing.reason !== input.reason)
        return { status: 409, body: { error: "inbox_intent_conflict", delivery: "not_delivered" } };
      return { status: 200, body: { ok: true, accepted: true, delivery: "delivered", audit: "journal_recorded", materialization: "pending_refresh", replayed: true, receipt: existing.receipt } };
    }
    if (admit && !admit()) return { status: 503, body: { error: "inbox_retirement_source_unavailable", delivery: "not_delivered" } };
    const event: InboxLifecycleEvent = { ...original, receipt: { id: inboxSemanticDigest([original.receipt.id, "restore", actor, intentId, inboxSemanticDigest(input)]), kind: "restore", scope: original.receipt.scope,
      snapshotKey: original.receipt.snapshotKey, retirementId: original.receipt.id, at: now, authority: "operator", operator: actor, intentId }, reason: input.reason, operator: actor, intentId, mirrored: false };
    read.store.events.push(event); writeInboxGardenerStore(stateDir, read.store);
    return { status: 200, body: { ok: true, accepted: true, delivery: "delivered", audit: "journal_recorded", materialization: "pending_refresh", receipt: event.receipt } };
  });
}
