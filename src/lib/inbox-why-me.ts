/** Source-qualified advisory corrections. Settled Inbox intent receipts are the durable history;
 * the slow lane alone projects that history. Neither a correction nor its observation grants authority. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { inboxThreadId } from "./inbox-thread.js";
import { writeAtomic } from "./fs-race-safe.js";
import { INBOX_STALE_AFTER_MS } from "./inbox-freshness.js";
import type { AttentionCensus } from "./inbox-responder.js";

export const INBOX_RECEIPT_DIR = "inbox-intent-receipts";
/** Conservative O(1) presence index: written before any correction may settle, never authority. */
export const WHY_ME_PRESENCE_DIR = "inbox-why-me-presence";
export const WHY_ME_ACTION = "why-me-correction";
export interface WhyMeScope { repository: string; instance: string }
export interface WhyMeInput {
  proposalId: string; snapshotKey: string; correction: "fleet_can_handle" | "still_need_me";
  note: string; supersedes?: string;
}
type Original = Pick<AttentionCensus["items"][number], "whyMe" | "sourceFacts" | "judgment">;
export interface WhyMeCorrection extends WhyMeInput, WhyMeScope {
  receiptId: string; intentId: string; threadId: string; operator: string; recordedAt: string; original: Original;
}
export interface WhyMeOutcome {
  observedAt: string; assessmentAt: string; snapshotKey: string; state: "held" | "awaiting_assessment" | "assessment_observed" | "item_absent" | "superseded" | "snapshot_changed";
  classification?: string; judgment?: Original["judgment"]; authority: "unchanged";
  assessmentRelation: "receipt_joined" | "unjoined";
}
export interface WhyMeFeedback {
  contract: "inbox-why-me-v1"; identity: string; generatedAt: string;
  scope: WhyMeScope; classificationSnapshotKey: string;
  state: "observed" | "partial" | "unavailable"; reason?: string;
  total: number; truncated: boolean;
  items: Array<WhyMeCorrection & { outcome?: WhyMeOutcome; mismatch: boolean; active: boolean; latest: boolean; sameAskFacts: boolean; currentSnapshot: boolean }>;
}
export interface WhyMeReceipt {
  key: string; payloadHash: string; operator: string; repository: string; instance: string; threadId: string;
  intentId: string; action: string; status: string; httpStatus?: number;
  body?: { correction?: WhyMeCorrection; [key: string]: unknown };
  whyMeOutcome?: WhyMeOutcome;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stableFacts = (facts: Original["sourceFacts"]) => facts.filter(f => f.source !== "judge");
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// BACKSTOP: cap receipt-verification I/O; oversize or growth remains explicitly unknown evidence.
const MAX_RECEIPT_BYTES = 1024 * 1024;
class OversizedReceiptError extends Error {}
/** Check and read one opened regular file; a pathname replacement cannot change its identity. */
function readWhyMeReceipt(path: string): WhyMeReceipt {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("correction receipt is not a regular file");
    if (stat.size > MAX_RECEIPT_BYTES)
      throw new OversizedReceiptError("correction receipt exceeds the verification bound");
    const chunks: Buffer[] = []; let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_RECEIPT_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
      total += count;
      if (total > MAX_RECEIPT_BYTES)
        throw new OversizedReceiptError("correction receipt exceeds the verification bound");
      chunks.push(chunk.subarray(0, count));
    }
  } finally { closeSync(fd); }
}

function validJudgment(value: unknown): boolean {
  return value === undefined || record(value) && typeof value.reason === "string" &&
    (value.whyMeReceiptIds === undefined || Array.isArray(value.whyMeReceiptIds) && value.whyMeReceiptIds.length <= 100 && value.whyMeReceiptIds.every(id => typeof id === "string" && /^[a-f0-9]{64}$/.test(id))) &&
    (value.state === "unclassified" || value.state === "judged" &&
      ["needs_operator", "automate", "backlog"].includes(String(value.decision)) &&
      (value.at === null || typeof value.at === "string" && Number.isFinite(Date.parse(value.at))));
}

export function whyMePayload(body: Record<string, unknown>): WhyMeInput | { error: string } {
  if (Object.keys(body).some(key => !["repository", "instance", "threadId", "proposalId", "snapshotKey", "intentId", "correction", "note", "supersedes"].includes(key)))
    return { error: "unknown correction field; operator and authority are server-owned" };
  if (typeof body.proposalId !== "string" || !body.proposalId.trim() || typeof body.snapshotKey !== "string" || !/^[a-f0-9]{64}$/.test(body.snapshotKey))
    return { error: "proposalId and observed classification snapshotKey are required" };
  if (body.correction !== "fleet_can_handle" && body.correction !== "still_need_me") return { error: "unknown why-me correction" };
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 2000)) return { error: "note must be at most 2000 characters" };
  if (body.supersedes !== undefined && (typeof body.supersedes !== "string" || !/^[a-f0-9]{64}$/.test(body.supersedes))) return { error: "supersedes must identify a correction receipt" };
  return { proposalId: body.proposalId, snapshotKey: body.snapshotKey, correction: body.correction, note: body.note as string | undefined ?? "",
    ...(body.supersedes === undefined ? {} : { supersedes: body.supersedes as string }) };
}

/** A settled correction effect has one fixed acknowledgement. Malformed durability is unknown. */
function validStoredWhyMeAcknowledgement(receipt: WhyMeReceipt): boolean {
  const body = receipt.body, ack = body?.receipt;
  if (receipt.httpStatus !== 200 || !record(body) || body.ok !== true || body.delivery !== "delivered" ||
    body.authority !== "feedback_only" || body.audit !== "receipt_recorded" || !record(ack)) return false;
  return Object.keys(body).length === 6 && Object.keys(body).every(key => ["ok", "delivery", "authority", "audit", "correction", "receipt"].includes(key)) &&
    Object.keys(ack).length === 5 && ack.intentId === receipt.intentId && ack.key === receipt.key &&
    ack.status === "settled" && ack.action === WHY_ME_ACTION && ack.threadId === receipt.threadId;
}

/** Identity is checked before any original explanation is accepted as this source's evidence. */
export function correctionOf(receipt: WhyMeReceipt, scope: WhyMeScope): WhyMeCorrection | undefined {
  const c = receipt.body?.correction;
  if (receipt.action !== WHY_ME_ACTION || receipt.status !== "settled" || !validStoredWhyMeAcknowledgement(receipt) || !record(c) ||
    receipt.repository !== scope.repository || receipt.instance !== scope.instance ||
    c.repository !== scope.repository || c.instance !== scope.instance || c.receiptId !== receipt.key ||
    typeof receipt.intentId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(receipt.intentId) ||
    c.threadId !== receipt.threadId || c.operator !== receipt.operator || c.intentId !== receipt.intentId ||
    receipt.key !== digest([receipt.operator, receipt.instance, receipt.intentId]) ||
    typeof c.proposalId !== "string" || typeof c.threadId !== "string" || c.threadId !== inboxThreadId(c.proposalId) ||
    typeof c.operator !== "string" || !c.operator.trim() || !Number.isFinite(Date.parse(c.recordedAt)) ||
    !record(c.original) || !validJudgment(c.original.judgment) || typeof c.original.whyMe !== "string" || !Array.isArray(c.original.sourceFacts) ||
    !c.original.sourceFacts.every(f => record(f) && typeof f.source === "string" && typeof f.detail === "string") ||
    "error" in whyMePayload({ proposalId: c.proposalId, snapshotKey: c.snapshotKey, correction: c.correction, note: c.note, ...(c.supersedes ? { supersedes: c.supersedes } : {}) })) return undefined;
  const payload = whyMePayload({ proposalId: c.proposalId, snapshotKey: c.snapshotKey, correction: c.correction, note: c.note,
    ...(c.supersedes ? { supersedes: c.supersedes } : {}) });
  return receipt.payloadHash === digest(payload) ? c : undefined;
}

export function whyMeMismatch(correction: WhyMeCorrection, judgment: Original["judgment"]): boolean {
  return judgment?.state === "judged" && (correction.correction === "fleet_can_handle" ? judgment.decision === "needs_operator" : judgment.decision !== "needs_operator");
}

function validWhyMeOutcome(outcome: WhyMeOutcome): boolean {
  return ["receipt_joined", "unjoined"].includes(outcome.assessmentRelation) && validJudgment(outcome.judgment) && outcome.authority === "unchanged" && ["held", "awaiting_assessment", "assessment_observed", "item_absent", "superseded", "snapshot_changed"].includes(outcome.state) &&
    Number.isFinite(Date.parse(outcome.observedAt)) && Number.isFinite(Date.parse(outcome.assessmentAt)) && /^[a-f0-9]{64}$/.test(outcome.snapshotKey);
}

export function validWhyMeFeedback(feedback: WhyMeFeedback | undefined, snapshotKey: string | undefined, scope?: { repository?: string; instance?: string }): boolean {
  if (!feedback) return true;
  const { identity, generatedAt, ...facts } = feedback;
  return feedback.contract === "inbox-why-me-v1" && feedback.scope?.repository === scope?.repository && feedback.scope?.instance === scope?.instance &&
    snapshotKey === feedback.classificationSnapshotKey && identity === digest(facts) && Number.isFinite(Date.parse(generatedAt)) &&
    ["observed", "partial", "unavailable"].includes(feedback.state) && Number.isSafeInteger(feedback.total) && feedback.total >= 0 &&
    Array.isArray(feedback.items) && feedback.items.length <= feedback.total && Buffer.byteLength(JSON.stringify(feedback.items)) <= 16_384;
}

/** Called only by the maintained slow-lane pass, never by a GET. All durable receipts remain on disk;
 * the public history is bounded by bytes and truthfully reports omitted or unreadable evidence. */
export function projectWhyMeFeedback(stateDir: string, scope: WhyMeScope, census: AttentionCensus, at: string): WhyMeFeedback {
  const items: WhyMeFeedback["items"] = [];
  let state: WhyMeFeedback["state"] = "observed", reason: string | undefined;
  const dir = join(stateDir, INBOX_RECEIPT_DIR);
  let names: string[] = [];
  try { names = readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)); }
  catch (error) { /* An unreadable corpus is unavailable, never a verified empty history. */ if ((error as NodeJS.ErrnoException).code !== "ENOENT") { state = "unavailable"; reason = "receipt_store_unreadable"; } }
  for (const name of names) {
    try {
      const path = join(dir, name);
      const receipt = readWhyMeReceipt(path);
      if (receipt.action !== WHY_ME_ACTION) continue;
      if (`${receipt.key}.json` !== name) throw new Error("receipt filename does not match identity");
      const correction = correctionOf(receipt, scope);
      if (!correction) throw new Error("correction receipt is unverified");
      const item = census.items.find(item => item.proposalId === correction.proposalId), judgment = item?.judgment;
      if (receipt.whyMeOutcome && !validWhyMeOutcome(receipt.whyMeOutcome)) throw new Error("outcome is unverified");
      items.push({ ...correction, ...(receipt.whyMeOutcome ? { outcome: receipt.whyMeOutcome } : {}), mismatch: whyMeMismatch(correction, judgment), active: false, latest: false, sameAskFacts: Boolean(item && digest(stableFacts(item.sourceFacts)) === digest(stableFacts(correction.original.sourceFacts))), currentSnapshot: correction.snapshotKey === census.snapshotKey });
    } catch { /* An invalid receipt leaves the public corpus explicitly partial. */ state = "partial"; reason = "correction_history_unverified"; }
  }
  items.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.receiptId.localeCompare(a.receiptId));
  const superseded = new Set(items.flatMap(c => c.supersedes ? [c.supersedes] : []));
  const latest = new Map<string, typeof items>();
  for (const item of items.filter(item => !superseded.has(item.receiptId))) {
    const key = JSON.stringify([item.operator, item.proposalId]), candidates = latest.get(key);
    if (!candidates) latest.set(key, [item]);
    else if (candidates[0]!.recordedAt === item.recordedAt) candidates.push(item);
  }
  for (const candidates of latest.values()) {
    if (candidates.length > 1 && candidates.some(item => item.currentSnapshot)) {
      state = "partial"; reason = "concurrent_operator_feedback";
    }
  }
  for (const item of items) {
    const candidates = latest.get(JSON.stringify([item.operator, item.proposalId]));
    item.latest = candidates?.length === 1 && candidates[0] === item;
    item.active = item.currentSnapshot && item.latest;
    item.mismatch &&= item.latest && item.sameAskFacts;
  }
  const shown: typeof items = [];
  for (const item of items) {
    if (Buffer.byteLength(JSON.stringify([...shown, item]), "utf8") <= 16_384) shown.push(item);
  }
  const facts = { contract: "inbox-why-me-v1" as const, scope, classificationSnapshotKey: census.snapshotKey,
    state, ...(reason ? { reason } : {}), total: items.length, truncated: shown.length !== items.length, items: shown };
  return { ...facts, identity: digest(facts), generatedAt: at };
}

/** The existing fleet pass observes feedback against its own maintained assessment. It records only
 * evidence, not a release, plan rewrite, owner change or permission to execute a security decision. */
export function observeWhyMeFeedback(stateDir: string, feedback: WhyMeFeedback | undefined, census: AttentionCensus | undefined, at: string, assessmentAt: string): void {
  if (!feedback || !census || feedback.classificationSnapshotKey !== census.snapshotKey || feedback.state === "unavailable") return;
  const age = Date.parse(at) - Date.parse(assessmentAt);
  if (!Number.isFinite(age) || age < 0 || age > INBOX_STALE_AFTER_MS || census.sources.plan !== "observed")
    throw new Error("why-me assessment is not source-verified fresh");
  for (const c of feedback.items) {
    const item = census.items.find(item => item.proposalId === c.proposalId);
    const held = item?.sourceFacts.some(f => f.source === "plan-lifecycle" && f.detail.includes("dispatch_hold: true"));
    const outcome: WhyMeOutcome = { observedAt: at, assessmentAt, snapshotKey: census.snapshotKey, authority: "unchanged",
      assessmentRelation: item?.judgment?.state === "judged" && item.judgment.whyMeReceiptIds?.includes(c.receiptId) ? "receipt_joined" : "unjoined",
      state: !c.currentSnapshot ? "snapshot_changed" : !c.active ? "superseded" : !item ? "item_absent" : held ? "held" : item.judgment?.state === "judged" ? "assessment_observed" : "awaiting_assessment",
      ...(item ? { classification: item.classification, ...(item.judgment ? { judgment: item.judgment } : {}) } : {}) };
    const path = join(stateDir, INBOX_RECEIPT_DIR, `${c.receiptId}.json`);
    const receipt = readWhyMeReceipt(path);
    if (receipt.key !== c.receiptId || !correctionOf(receipt, feedback.scope)) throw new Error("why-me outcome source is unverified");
    if (receipt.whyMeOutcome?.snapshotKey === outcome.snapshotKey && receipt.whyMeOutcome.state === outcome.state) continue;
    writeAtomic(path, JSON.stringify({ ...receipt, whyMeOutcome: outcome }) + "\n");
  }
}


export function whyMePresencePath(stateDir: string, scope: WhyMeScope, proposalId: string): string {
  return join(stateDir, WHY_ME_PRESENCE_DIR, digest([scope.repository, scope.instance, proposalId]));
}

function previousWhyMePresence(stateDir: string, scope?: WhyMeScope, proposalId?: string): "absent" | "present" | "unavailable" {
  try { return statSync(scope && proposalId ? whyMePresencePath(stateDir, scope, proposalId) : join(stateDir, WHY_ME_PRESENCE_DIR)).isDirectory() ? "present" : "unavailable"; }
  catch (error) { /* A missing marker is distinct from unreadable prior-correction presence. */ return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable"; }
}

/** Reuse the existing judge's cadence/cache with exact accepted receipts as advisory evidence.
 * Global bookkeeping-key changes retain feedback only while this ask's non-judge facts match.
 * The bounded maintained projection is intake; only its selected receipts are re-verified on disk. */
export function withWhyMeJudgmentInput<T extends { id: string }>(
  shards: readonly T[], stateDir: string,
  source: { generatedAt: string; snapshotKey?: string; snapshotScope?: { repository?: string; instance?: string }; attentionCensus?: AttentionCensus; whyMeFeedback?: WhyMeFeedback } | undefined,
  now: number, expected: { repository: string | undefined; instance: string | undefined },
): Array<T & { whyMeFeedback?: { projectionIdentity: string; snapshotKey: string; historyTruncated: boolean; receipts: Array<WhyMeCorrection & { context: "current_snapshot" | "historical_matching_facts" }> }; whyMeFeedbackUnavailable?: string }> {
  const feedback = source?.whyMeFeedback, census = source?.attentionCensus;
  const age = now - Date.parse(source?.generatedAt ?? "");
  const unavailable = (shard: T, reason: string) => ({ ...shard, whyMeFeedbackUnavailable: reason });
  if ((!feedback || feedback.state === "observed" && feedback.total === 0) && previousWhyMePresence(stateDir) === "absent") return [...shards];
  if (!feedback) return shards.map(shard => unavailable(shard, "previous correction presence exists but its maintained source is unavailable"));
  if (!census || validWhyMeFeedback(feedback, source?.snapshotKey, source?.snapshotScope) === false || feedback.state !== "observed" || !Number.isFinite(age) || age < 0 || age > INBOX_STALE_AFTER_MS || census.sources.plan !== "observed")
    return shards.map(shard => unavailable(shard, "maintained correction source is unverified"));
  if (expected.repository === undefined || expected.instance === undefined || feedback.scope.repository !== expected.repository || feedback.scope.instance !== expected.instance)
    return shards.map(shard => unavailable(shard, "maintained correction source is unverified"));
  return shards.map(shard => {
    const proposalId = `verify-human:${shard.id}`, item = census.items.find(item => item.proposalId === proposalId);
    const omitted = () => previousWhyMePresence(stateDir, feedback.scope, proposalId) === "absent" ? shard
      : unavailable(shard, "previous correction history for this proposal is unavailable in the bounded maintained source");
    if (!item) return omitted();
    const receipts: Array<WhyMeCorrection & { context: "current_snapshot" | "historical_matching_facts" }> = [];
    for (const projected of feedback.items.filter(c => c.latest && c.proposalId === proposalId)) {
      try {
        const path = join(stateDir, INBOX_RECEIPT_DIR, projected.receiptId + ".json");
        const correction = correctionOf(readWhyMeReceipt(path), feedback.scope);
        const { outcome: _outcome, mismatch: _mismatch, active: _active, latest: _latest, sameAskFacts: _sameAskFacts, currentSnapshot: _currentSnapshot, ...published } = projected;
        if (!correction || correction.receiptId !== projected.receiptId || digest(correction) !== digest(published) ||
          digest(stableFacts(correction.original.sourceFacts)) !== digest(stableFacts(item.sourceFacts))) return unavailable(shard, "correction receipt or current ask facts are unverified");
        receipts.push({ ...correction, context: correction.snapshotKey === census.snapshotKey ? "current_snapshot" : "historical_matching_facts" });
      } catch (error) {
        if (error instanceof OversizedReceiptError) return unavailable(shard, error.message);
        const reason = `correction receipt cannot be verified: ${(error as NodeJS.ErrnoException).code ?? (error as Error).name}`;
        return unavailable(shard, reason);
      }
    }
    return receipts.length ? { ...shard, whyMeFeedback: { projectionIdentity: feedback.identity, snapshotKey: census.snapshotKey, historyTruncated: feedback.truncated, receipts } } : omitted();
  });
}
