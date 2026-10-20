import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { classificationSnapshotKey } from "./read-page.js";

import { systemClock, type Clock } from "./clock.js";
import { buildDecisionSummarySpawnArgs } from "./feedback.js";
import { writeAtomic } from "./fs-race-safe.js";
import { proposalVerdictsWithReceipts, readVerdictReceipts } from "./inbox-verdict-receipts.js";
import { deriveTaskReferent, parseProposalRegistry, recordRowThreadEvents, THREAD_EVENT_STEPS, type Proposal } from "./inbox.js";
import { readLedgerUnionRecords } from "./ledger-union.js";
import { inboxKind, inboxOwner } from "./inbox-owner.js";
import type { InboxClassification } from "./inbox.js";
import type { VerifyHumanRuling } from "./verify-human-judge.js";
import type { InboxDismissalAudit } from "./inbox-dismissal-audit.js";
import { machineTokens, plainInboxMessage, plainStorePath, readPlainStore, type PlainInboxMessage } from "./inbox-plain.js";
import {
  appendThreadMessage,
  hasThreadEvent,
  inboxThreadId,
  inboxThreadIdentity,
  proposalIdOfThread,
  readAllThreads,
  type InboxThreadAction,
  type ThreadMessage,
  type ThreadMessageExtra,
} from "./inbox-thread.js";
import type { Mount } from "./mounts.js";
import { appendPanelLedger } from "./panel-actions.js";
import { readLedgerLines } from "./status.js";
import { spawnWorker } from "./worker.js";
import { benchmarkNonDispatchSpawn } from "./benchmark-run.js";

/**
 * lib/inbox-responder.ts (W1-T4088) — the inbox as a conversation with the daemon.
 *
 * On 2026-09-22 the thread store behind escalation replies had no path in production, no proposal
 * could be replied to, and nothing on the daemon side ever answered a reply. This module:
 *   - builds the thread list and one thread's messages for the console, with each operator item's
 *     plain message as the thread's opening message (derived on read, never written, so it always
 *     matches the current plain text);
 *   - keeps a read mark per thread, so the list can show what is unread;
 *   - answers every operator reply on its own timer, in plain language.
 *
 * A REPLY IS AN INPUT, NEVER A COMMAND. The responder may itself take only the low-tier, reversible
 * inbox actions — decline, restore, and redraft — and says what it did and how to undo it. It never
 * approves from prose: an approve is offered as a suggested action the operator confirms through
 * the existing approve route and its tier. A reply it cannot read gets one clarifying question, and
 * the number of questions per thread is bounded.
 */

// ── Views ──────────────────────────────────────────────────────────────────────────────────────

/** One operator-owned inbox item, as the thread views need it. */
export interface InboxThreadItem {
  requiresReview?: boolean;
  proposalId: string;
  summary: string;
  plain: PlainInboxMessage;
  state: "ready" | "drafting" | "notReady" | "declined" | "retired";
}

export interface ThreadMessageView {
  seq: number;
  from: "daemon" | "operator";
  text: string;
  /** Epoch millis; `null` on the opening message, which is derived, not stored. */
  ts: number | null;
  /** On the opening message: the item's full plain message. */
  plain?: PlainInboxMessage;
  /** On the opening message: the actions the item's state allows. */
  actions?: InboxThreadAction[];
  extra?: ThreadMessageExtra;
}

export interface ThreadSummaryView {
  threadId: string;
  proposalId: string;
  headline: string;
  snippet: string;
  waitingOn: "operator" | "daemon";
  /** Actionability, not just who wrote last. A console badge counts decision/reply only. */
  attention: "decision" | "reply" | "in_progress" | "history" | "awaiting_daemon";
  lastActivity: number | null;
  messageCount: number;
  unread: boolean;
}

export interface ThreadDetailView extends ThreadSummaryView {
  /** The raw summary, for the console's Details. */
  details: string;
  messages: ThreadMessageView[];
}

export type AttentionSourceState = "observed" | "partial" | "unavailable";
export type AttentionJudgment = VerifyHumanRuling | { state?: undefined; decision: string; reason: string };

export interface AttentionCensusInput {
  retirementSource?: "observed" | "absent" | "unavailable";
  /** The completed producer's lane-visible content and owned source; never read-time clocks. */
  classificationContent?: unknown;
  dismissalAudit?: InboxDismissalAudit;
  views: ThreadSummaryView[];
  classifications: InboxClassification[];
  taskFacts: ReadonlyMap<string, { verify: string; repo: string; title: string; status?: string; retirement?: string; dispatchHold?: boolean; risk?: string }>;
  releasedTaskIds: ReadonlySet<string>;
  releaseReceipts?: ReadonlyMap<string, string>;
  mergedTaskIds?: ReadonlySet<string>;
  judgeByTask: ReadonlyMap<string, AttentionJudgment>;
  sources: {
    plan: AttentionSourceState;
    registry: AttentionSourceState;
    liveLedger: AttentionSourceState;
    archiveLedger: AttentionSourceState;
    githubProjection: AttentionSourceState;
  };
}

/** Source-qualified read model, never an approval or retirement instruction. Snapshot counts may
 * overcount decisions when a missing ledger hides a release; only verifiedCounts are lower bounds. */
export function buildAttentionCensus(input: AttentionCensusInput) {
  const byId = new Map(input.classifications.map((c) => [c.proposalId, c]));
  const visibleIds = new Set(input.views.map((view) => view.proposalId));
  const terminalHistory: ThreadSummaryView[] = input.classifications.flatMap((c) => {
    const taskId = /^verify-human:(W\d+-T[A-Za-z0-9]+)$/.exec(c.proposalId)?.[1];
    if (!taskId || c.state !== "retired" || visibleIds.has(c.proposalId)) return [];
    const task = input.taskFacts.get(taskId);
    const noLongerHuman = task?.verify === "auto" && task.dispatchHold !== true;
    if (!input.releasedTaskIds.has(taskId) && !(task?.status === "blocked" && task.retirement) && !noLongerHuman) return [];
    return [{
      threadId: inboxThreadId(c.proposalId), proposalId: c.proposalId,
      headline: c.proposalId, snippet: c.retiredReason ?? "Closed in the plan or released to the fleet",
      waitingOn: "daemon" as const, attention: "history" as const,
      lastActivity: null, messageCount: 1, unread: false,
    }];
  });
  const items = [...input.views, ...terminalHistory].map((view) => {
    const classification = byId.get(view.proposalId);
    const humanTaskId = /^verify-human:(W\d+-T[A-Za-z0-9]+)$/.exec(view.proposalId)?.[1];
    const taskId = humanTaskId ?? deriveTaskReferent(view.proposalId);
    const task = taskId ? input.taskFacts.get(taskId) : undefined;
    const judge = taskId ? input.judgeByTask.get(taskId) : undefined;
    const judgment: VerifyHumanRuling | undefined = judge?.state !== undefined ? judge :
      humanTaskId || judge ? { state: "unclassified", reason: judge ?
        `prior evidence omitted judgement state; refresh required: ${judge.reason}`.slice(0, 300) : "no judge verdict recorded" } : undefined;
    const released = humanTaskId !== undefined && input.releasedTaskIds.has(humanTaskId);
    const sourceFacts: Array<{ source: string; detail: string }> = [];
    if (classification) sourceFacts.push({ source: "classification", detail: `${view.proposalId}: ${classification.state}${classification.reasons.length ? `; predicates: ${classification.reasons.map((reason) => reason.predicate).join(", ")}` : ""}` });
    if (task) sourceFacts.push({ source: "plan", detail: `${taskId}: verify: ${task.verify}; repo: ${task.repo}; ${task.title}` });
    if (task?.status === "blocked" && task.retirement) sourceFacts.push({ source: "plan-lifecycle", detail: `${taskId}: status blocked; retirement ${task.retirement}` });
    if (task?.dispatchHold) sourceFacts.push({ source: "plan-lifecycle", detail: `${taskId}: dispatch_hold: true; a release receipt alone cannot make this task dispatchable` });
    if (task?.risk === "high") sourceFacts.push({ source: "plan", detail: `${taskId}: risk: high in the filed task` });
    if (judgment) sourceFacts.push({ source: "judge", detail: `${humanTaskId ? "" : "Task verification context, not a proposal ruling: "}${judgment.state === "judged" ? judgment.decision : "unclassified"}: ${judgment.reason.slice(0, 300)}` });
    if (released) sourceFacts.push({ source: "ledger", detail: input.releaseReceipts?.get(taskId!) ?? `${taskId}: ratify.approved released verify-human` });
    if (taskId && input.mergedTaskIds?.has(taskId)) sourceFacts.push({ source: "githubProjection", detail: `${taskId}: merged task credit observed` });
    if (classification?.retiredReason) sourceFacts.push({ source: "classification", detail: classification.retiredReason });
    const whyMe = view.attention === "decision"
      ? taskId ? !humanTaskId
        ? `Proposal ${view.proposalId} references ${taskId}; its recommendation requires review. The task's verification mode is context, not approval of this proposal.`
        : task?.dispatchHold
        ? `${taskId} still has an explicit dispatch hold. A release receipt does not lift it; the operator must review the held task.`
        : judgment?.state === "unclassified"
        ? `${taskId}'s verification judgement is unclassified; triage its evidence before treating it as a verified need for an operator decision.`
        : `${taskId} requires an operator decision${task ? ` (verify: ${task.verify})` : "; task evidence unavailable"}.`
        : `Proposal ${view.proposalId} is ready for an operator decision.`
      : view.attention === "reply" ? `Proposal ${view.proposalId} asks for an operator reply.`
      : view.attention === "awaiting_daemon" ? "Your reply is delivered; waiting for the daemon."
      : view.attention === "history" ? "Past operator item; no current decision requested."
      : "The fleet is still working; no current operator decision is established.";
    return {
      threadId: view.threadId, proposalId: view.proposalId, ...(taskId ? { taskId } : {}),
      kind: inboxKind(view.proposalId), waitingOn: view.waitingOn, attention: view.attention,
      classification: classification?.state ?? "unavailable", whyMe, sourceFacts,
      ...(judgment ? { judgment } : {}),
      ...(classification?.retiredReason ? { retiredReason: classification.retiredReason } : {}),
      ...(classification?.retirement ? { retirement: classification.retirement } : {}),
      ...(classification?.needsTriageReason ? { needsTriageReason: classification.needsTriageReason } : {}),
    };
  }).sort((a, b) => a.proposalId.localeCompare(b.proposalId));
  const counts = { decision: 0, reply: 0, in_progress: 0, history: 0, awaiting_daemon: 0 };
  // A human-attention label is not proof that the proposal is prepared for approval. Keep the
  // observed decision total, but expose that distinction before a UI calls it actionable.
  const decisionReadiness = { ready: 0, needsPreparation: 0, needsTriage: 0, unknown: 0 };
  const kinds: Record<string, number> = {};
  for (const item of items) {
    counts[item.attention] += 1;
    kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
    if (item.attention === "decision") {
      if (item.needsTriageReason || item.proposalId.startsWith("verify-human:") && item.judgment?.state === "unclassified") decisionReadiness.needsTriage += 1;
      else if (item.classification === "ready") decisionReadiness.ready += 1;
      else if (item.classification === "not_ready" || item.classification === "drafting") decisionReadiness.needsPreparation += 1;
      else decisionReadiness.unknown += 1;
    }
  }
  const contradictoryRelease = items.some((item) => item.taskId && item.proposalId === `verify-human:${item.taskId}` && input.releasedTaskIds.has(item.taskId) && item.attention === "decision");
  const missingReferent = items.some((item) => (item.taskId && !input.taskFacts.has(item.taskId)) || item.classification === "unavailable");
  const state = Object.values(input.sources).every((source) => source === "observed") && input.retirementSource !== "unavailable" && !contradictoryRelease && !missingReferent ? "complete" : "partial";
  const verifiedCounts = state === "complete" ? { ...counts } : { decision: 0, reply: 0, in_progress: 0, history: 0, awaiting_daemon: 0 };
  const allRetirements = input.classifications.flatMap(c => c.retirement ? [{ ...c.retirement, reason: c.retirement.reason.slice(0, 300) }] : []).sort((a, b) => a.retirementId.localeCompare(b.retirementId));
  const retirements: typeof allRetirements = [];
  for (const row of allRetirements) {
    if (Buffer.byteLength(JSON.stringify([...retirements, row])) > 16 * 1024) break;
    retirements.push(row);
  }
  const retirementHistory = { state: input.retirementSource ?? "absent", total: input.retirementSource === "observed" ? allRetirements.length : null,
    returned: input.retirementSource === "observed" ? retirements.length : 0, truncated: input.retirementSource === "observed" && retirements.length < allRetirements.length,
    countSemantics: "maintained_classification_retirements" as const };
  const result = { scope: "core" as const, state, countSemantics: "observed_snapshot_not_verified" as const,
    sources: input.sources, counts, decisionReadiness, verifiedCounts, kinds, items,
    retirements: input.retirementSource === "observed" ? retirements : [], retirementHistory,
    ...(input.dismissalAudit ? { dismissalAudit: input.dismissalAudit } : {}), ...(contradictoryRelease ? { discrepancy: "active_human_ask_has_release_receipt" } : {}) };
  const snapshotKey = classificationSnapshotKey(input.classificationContent ?? null, result);
  return { ...result, snapshotKey };
}

export type AttentionCensus = ReturnType<typeof buildAttentionCensus>;

const ACTIONS_BY_STATE: Record<InboxThreadItem["state"], InboxThreadAction[]> = {
  ready: ["approve", "decline", "edit"],
  drafting: ["decline", "edit"],
  notReady: ["decline", "edit"],
  declined: ["restore"],
  retired: [],
};

function openingMessage(item: InboxThreadItem): ThreadMessageView {
  return {
    seq: 0,
    from: "daemon",
    text: `${item.plain.whatHappened} ${item.plain.whatWeNeed}`,
    ts: null,
    plain: item.plain,
    actions: ACTIONS_BY_STATE[item.state],
  };
}

function storedMessageView(m: ThreadMessage): ThreadMessageView {
  return { seq: m.seq, from: m.role === "reply" ? "operator" : "daemon", text: m.body, ts: m.ts, ...(m.extra ? { extra: m.extra } : {}) };
}

export type ReadMarks = Record<string, number>;

export function readMarksPath(stateDir: string): string {
  return `${stateDir}/inbox-thread-reads.json`;
}

export function readReadMarks(path: string): ReadMarks {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ReadMarks) : {};
  } catch {
    // deliberate: unreadable marks read as "nothing read" — the worst case is threads shown unread.
    return {};
  }
}

/** Mark a thread read up to `seq`. Marks only move forward. */
export function markThreadRead(path: string, threadId: string, seq: number): void {
  const marks = readReadMarks(path);
  if ((marks[threadId] ?? -1) >= seq) return;
  marks[threadId] = seq;
  writeAtomic(path, JSON.stringify(marks, null, 2) + "\n");
}

/** W1-T9252: replies and answers read in the order they were stored; an EVENT is stored when it is mirrored or
 *  backfilled, which can be after later messages, so each one is placed by its own time instead. */
function inTimeOrder(stored: ThreadMessageView[]): ThreadMessageView[] {
  const events = stored.filter((m) => m.extra?.event).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.seq - b.seq);
  const ordered = stored.filter((m) => !hasThreadEvent(m.extra)).sort((a, b) => a.seq - b.seq);
  for (const event of events) {
    const at = ordered.findIndex((m) => !hasThreadEvent(m.extra) && (m.ts ?? 0) > (event.ts ?? 0));
    ordered.splice(at === -1 ? ordered.length : at, 0, event);
  }
  return ordered;
}

function detailFor(item: InboxThreadItem, stored: ThreadMessage[], marks: ReadMarks): ThreadDetailView {
  const messages = [openingMessage(item), ...inTimeOrder(stored.map(storedMessageView))];
  const last = messages[messages.length - 1]!;
  const threadId = inboxThreadId(item.proposalId);
  return {
    threadId,
    proposalId: item.proposalId,
    headline: item.plain.headline,
    snippet: last.text.split(/(?<=[.!?])\s/)[0]!.slice(0, 160),
    waitingOn: last.from === "operator" ? "daemon" : "operator",
    attention: attentionFor(item, last),
    lastActivity: last.ts,
    messageCount: messages.length,
    unread: last.from === "daemon" && (marks[threadId] ?? -1) < last.seq,
    details: item.summary,
    messages,
  };
}

function attentionFor(item: InboxThreadItem, last: ThreadMessageView): ThreadSummaryView["attention"] {
  if (item.state === "retired") return "history";
  if (item.requiresReview) return "decision";
  // A recorded decline is the end of the item's story, not a reply the daemon owes an answer to.
  if (item.state === "declined" && last.extra?.event) return "history";
  if (last.from === "operator") return "awaiting_daemon";
  if (last.extra?.question === true) return "reply";
  if (item.state === "declined") return "history";
  const kind = inboxKind(item.proposalId);
  // These kinds carry an explicit human judgement even before an Architect has a draft. A
  // generic not-ready proposal, by contrast, is the fleet's next step, not the operator's.
  if (kind === "verify-human" || kind === "ruling" || item.state === "ready") return "decision";
  return "in_progress";
}

/** The list order by attention (#7708). `waitingOn` only says who wrote last, so ordering by it
 *  listed a fleet thread the daemon last wrote on beside, and often above, a real decision. Same
 *  ranks as the console's `sortInboxThreads`, so every reader of the API sees the order the phone
 *  shows: what needs the operator first, an answer already owed by the daemon last. */
const ATTENTION_RANK: Record<ThreadSummaryView["attention"], number> = {
  decision: 0,
  reply: 1,
  in_progress: 2,
  history: 3,
  awaiting_daemon: 4,
};

/** Every operator item's thread, in {@link ATTENTION_RANK} order, then most recent activity. A
 *  declined item is listed only once someone has written on its thread. */
export function listThreadViews(
  items: InboxThreadItem[],
  threads: Map<string, ThreadMessage[]>,
  marks: ReadMarks,
): ThreadSummaryView[] {
  const views = items
    .filter((item) => item.state !== "retired" && (item.state !== "declined" || (threads.get(inboxThreadId(item.proposalId))?.some((m) => !hasThreadEvent(m.extra)) ?? false)))
    .map((item) => {
      const { details: _details, messages: _messages, ...summary } = detailFor(item, threads.get(inboxThreadId(item.proposalId)) ?? [], marks);
      return summary;
    });
  return views.sort((a, b) => {
    if (a.attention !== b.attention) return ATTENTION_RANK[a.attention] - ATTENTION_RANK[b.attention];
    return (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
  });
}

export function threadDetailView(item: InboxThreadItem, threads: Map<string, ThreadMessage[]>, marks: ReadMarks): ThreadDetailView {
  return detailFor(item, threads.get(inboxThreadId(item.proposalId)) ?? [], marks);
}

// ── The responder ──────────────────────────────────────────────────────────────────────────────

/** What the daemon decided an operator reply means. */
export interface ThreadDecision {
  action: InboxThreadAction | "question" | "none";
  /** The plain reply to write on the thread. */
  reply: string;
  /** For `edit`: what to change. For `decline`: why. */
  note?: string;
}

export interface ThreadDecisionContext {
  item: InboxThreadItem;
  messages: ThreadMessageView[];
  replyText: string;
}

/** PRIMARY CONTROL: questions the responder asks on one thread before it stops asking and points
 *  at the buttons instead — the operator is never asked the same thing without end. */
export const MAX_THREAD_QUESTIONS = 2;

const ACTIONS: ReadonlySet<string> = new Set(["approve", "decline", "edit", "restore", "question", "none"]);

function validateDecision(x: unknown): ThreadDecision | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.action !== "string" || !ACTIONS.has(o.action)) return null;
  if (typeof o.reply !== "string" || !o.reply.trim()) return null;
  return { action: o.action as ThreadDecision["action"], reply: o.reply.trim(), ...(typeof o.note === "string" && o.note.trim() ? { note: o.note.trim() } : {}) };
}

/** The deterministic reading used when no model writer is available or its answer is unusable. */
export function keywordDecision(replyText: string): ThreadDecision {
  const t = replyText.toLowerCase();
  if (/\b(bring it back|restore|undo|reopen)\b/.test(t)) return { action: "restore", reply: "" };
  if (/\b(decline|drop it|drop this|close it|not needed|no thanks|reject)\b/.test(t)) return { action: "decline", reply: "", note: replyText };
  if (/\b(change|instead|rather|edit|redraft|rewrite)\b/.test(t)) return { action: "edit", reply: "", note: replyText };
  if (/\b(yes|approve|go ahead|do it|ship it|file it|looks good|lgtm)\b/.test(t)) return { action: "approve", reply: "" };
  return { action: "question", reply: "" };
}

/** The plain reply written for each action when the writer's own text is missing or not plain. */
function plainReplyFor(action: ThreadDecision["action"]): string {
  switch (action) {
    case "approve":
      return "It sounds like you want the fleet to go ahead. Press Approve to confirm, and the fleet will start.";
    case "decline":
      return "Done. I dropped this item. If you change your mind, reply \"bring it back\".";
    case "restore":
      return "Done. I brought this item back, so it is open again.";
    case "edit":
      return "Thanks. I asked for the item to be redrafted with your change. I will post the new version here when it is ready.";
    case "question":
      return "I am not sure what you would like. Should the fleet go ahead, drop this item, or change it?";
    case "none":
      return "I still cannot tell what you would like. Please use one of the buttons: Approve, Drop it, or Change it.";
  }
}

export interface InboxResponderDeps {
  threadStorePath: string;
  ledgerPath: string;
  /** The operator items as they stand now. */
  readItems: () => InboxThreadItem[];
  /** Hand a redraft to the existing reframe flow. */
  reframe: (proposalId: string, feedback: string) => void;
  /** W1-T9252: mirror the ledger rows the fleet wrote since the last tick (a redraft, a filed task, a refusal)
   *  onto their items' threads. Returns how many events it wrote. */
  syncEvents?: () => number | Promise<number>;
  /** The model reader; absent → {@link keywordDecision}. */
  decide?: (ctx: ThreadDecisionContext) => unknown | Promise<unknown>;
  clock?: Clock;
}

async function decideFor(ctx: ThreadDecisionContext, deps: InboxResponderDeps): Promise<ThreadDecision> {
  let decision: ThreadDecision | null = null;
  if (deps.decide) {
    try {
      decision = validateDecision(await deps.decide(ctx));
    } catch {
      // deliberate: a writer outage falls back to the keyword reading below, never to silence.
      decision = null;
    }
  }
  return decision ?? keywordDecision(ctx.replyText);
}

/** Answer ONE thread whose last message is the operator's. Returns the action taken, or
 *  `undefined` when there was nothing to answer. */
export async function answerThread(threadId: string, deps: InboxResponderDeps): Promise<ThreadDecision["action"] | undefined> {
  const proposalId = proposalIdOfThread(threadId);
  if (!proposalId) return undefined;
  const all = readAllThreads({ threadStorePath: deps.threadStorePath });
  if (all.status === "unresolved") throw new Error(all.reason);
  const stored = all.threads.get(threadId) ?? [];
  const last = stored[stored.length - 1];
  // Action events already record an executed operation, not new input for the reply decider.
  if (!last || last.role !== "reply" || hasThreadEvent(last.extra)) return undefined;
  const item = deps.readItems().find((i) => i.proposalId === proposalId);
  if (!item) return undefined;

  const detail = threadDetailView(item, all.threads, {});
  let decision = await decideFor({ item, messages: detail.messages, replyText: last.body }, deps);
  // W1-T9252: a reply that is no decline, restore, approval or clarifying question is the operator's DIRECTION for
  // the item: it goes to the same redraft `rmd reframe` starts, rather than back to the operator as a question.
  if ((decision.action === "question" && !decision.reply) || decision.action === "none") decision = { action: "edit", reply: "", note: last.body };
  const questionsAsked = stored.filter((m) => m.role === "escalation" && m.extra?.question).length;
  if (decision.action === "question" && questionsAsked >= MAX_THREAD_QUESTIONS) decision = { action: "none", reply: "" };
  // Only what the item's state allows; anything else becomes a question.
  if (decision.action !== "question" && decision.action !== "none" && !ACTIONS_BY_STATE[item.state].includes(decision.action)) {
    decision = questionsAsked >= MAX_THREAD_QUESTIONS ? { action: "none", reply: "" } : { action: "question", reply: "" };
  }
  const text = decision.reply && machineTokens(decision.reply).length === 0 ? decision.reply : plainReplyFor(decision.action);

  const extra: ThreadMessageExtra = {};
  switch (decision.action) {
    case "decline":
      appendPanelLedger(deps.ledgerPath, "panel.proposal_declined", proposalId, "inbox-responder", { reason: decision.note ?? last.body });
      extra.did = { action: "decline", undo: 'Reply "bring it back".' };
      break;
    case "restore":
      appendPanelLedger(deps.ledgerPath, "panel.proposal_restored", proposalId, "inbox-responder", { reason: last.body });
      extra.did = { action: "restore" };
      break;
    case "edit":
      appendPanelLedger(deps.ledgerPath, "panel.proposal_reframe_requested", proposalId, "inbox-responder", { feedback: decision.note ?? last.body });
      deps.reframe(proposalId, decision.note ?? last.body);
      extra.did = { action: "edit" };
      break;
    case "approve":
      // A reply never approves: the operator confirms with the approve route and its tier.
      extra.suggestedAction = "approve";
      break;
    case "question":
      extra.question = true;
      break;
    case "none":
      break;
  }
  appendThreadMessage(inboxThreadIdentity(proposalId), "escalation", text, { threadStorePath: deps.threadStorePath, now: (deps.clock ?? systemClock).now }, extra);
  appendPanelLedger(deps.ledgerPath, "inbox.thread_answered", proposalId, "inbox-responder", { thread_id: threadId, action: decision.action });
  return decision.action;
}

/** Answer waiting threads on its own timer, one at a time, never two at once — the W1-T4077 pump
 *  pattern, so a busy daemon main loop never delays an answer. */
export function startInboxResponder(
  deps: InboxResponderDeps,
  intervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
): { stop: () => void; settled: () => Promise<void>; isBusy: () => boolean } {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return;
    running = (async () => {
      if (deps.syncEvents) {
        try {
          const mirrored = await deps.syncEvents();
          if (mirrored > 0) log("inbox.thread_events_mirrored", { count: mirrored });
        } catch (error) {
          log("inbox.thread_event_sync_failed", { error: String((error as Error)?.message ?? error) });
        }
      }
      const all = readAllThreads({ threadStorePath: deps.threadStorePath });
      if (all.status === "unresolved") throw new Error(all.reason);
      for (const [threadId, messages] of all.threads) {
        if (messages[messages.length - 1]?.role !== "reply" || !proposalIdOfThread(threadId)) continue;
        const action = await answerThread(threadId, deps);
        if (action) log("inbox.thread_answered", { thread_id: threadId, action });
      }
    })()
      .catch((e) => log("inbox.thread_answer_failed", { error: String((e as Error)?.message ?? e) }))
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    isBusy: () => running !== undefined,
    settled: async () => {
      await running;
    },
  };
}

/** The daemon's reading of the operator items: the registry, the plain store, and whether the ledger
 *  has the item declined. The console's routes use the full classification instead; the responder
 *  needs only open-or-declined, because an approve is only ever offered, and the approve route
 *  itself refuses an item that is not ready. */
export function registryThreadItems(stateDir: string, ledgerPath: string): InboxThreadItem[] {
  const proposals = parseProposalRegistry(existsSync(`${stateDir}/inbox-proposals.json`) ? readFileSync(`${stateDir}/inbox-proposals.json`, "utf8") : undefined);
  const plainStore = readPlainStore(plainStorePath(stateDir));
  const lines = readLedgerLines(ledgerPath);
  const verdicts = proposalVerdictsWithReceipts(lines, readVerdictReceipts(stateDir));
  return proposals
    .filter((p) => inboxOwner(p) === "operator")
    .map((p) => ({
      proposalId: p.id,
      summary: p.summary,
      plain: plainInboxMessage(p, plainStore),
      state: verdicts.isDeclined(p.id) !== undefined ? ("declined" as const) : ("ready" as const),
    }));
}

// ── The production reader ──────────────────────────────────────────────────────────────────────

export function buildThreadDecisionPrompt(ctx: ThreadDecisionContext): string {
  return [
    "You are the Remudero daemon, replying to the operator in an inbox thread. Read the thread and",
    "the operator's latest reply, and decide what they want. Respond with ONLY a JSON object:",
    '{"action": "approve" | "decline" | "edit" | "restore" | "question", "reply": string, "note": string}',
    "- approve: they want the fleet to go ahead. You cannot approve; your reply asks them to press Approve.",
    "- decline: they want the item dropped. note = their reason.",
    "- edit: they want it changed. note = the change, in their words.",
    "- restore: they want a dropped item back.",
    "- question: you cannot tell. reply = ONE short question.",
    "Write the reply in plain, friendly English: short sentences, active voice, no code, file names,",
    "ids, commands or internal names. Say what you understood and what happens next.",
    "",
    `Item: ${ctx.item.plain.headline}. ${ctx.item.plain.whatHappened}`,
    "Thread:",
    ...ctx.messages.map((m) => `${m.from}: ${m.text}`),
  ].join("\n");
}

/** The model reader behind {@link InboxResponderDeps.decide}: the decision-summary rung's cheap
 *  mount and spawn shape, with this module's prompt. */
export function realThreadDecider(opts: {
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): (ctx: ThreadDecisionContext) => Promise<unknown> {
  const spawn = opts.spawn ?? benchmarkNonDispatchSpawn("inbox-response");
  return async (ctx) => {
    const args = buildDecisionSummarySpawnArgs({ input: { context: "" }, mount: opts.mount, cwd: opts.cwd, settingsFile: opts.settingsFile });
    const result = await spawn({ ...args, prompt: buildThreadDecisionPrompt(ctx) });
    const match = /\{[\s\S]*\}/.exec(result.text);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      // deliberate: an unparseable answer is no answer; the keyword reading takes over.
      return null;
    }
  };
}

// ── W1-T9252: the operator's actions and the fleet's outcomes, mirrored onto the item's thread ─────────────

export interface ThreadEventSync {
  /** One walk of the ledger UNION (live + archives) for every operator-action and outcome row; safe to repeat.
   *  Streams, so the daemon's loop is not held for the whole corpus. */
  backfill(): Promise<number>;
  /** The live ledger's rows appended since the last call (or since the backfill read it). */
  poll(): number;
  /** The daemon's timer: the backfill on its first call (boot), then {@link poll}. */
  sync(): Promise<number>;
}

/** The registry's operator-owned proposals: the only items that have a thread. */
function operatorProposals(stateDir: string): Proposal[] {
  const path = join(stateDir, "inbox-proposals.json");
  return parseProposalRegistry(existsSync(path) ? readFileSync(path, "utf8") : undefined).filter((p) => inboxOwner(p) === "operator");
}

export function createThreadEventSync(opts: {
  ledgerPath: string;
  threadStorePath: string;
  /** The proposal registry's state directory; defaults to the ledger's own. */
  stateDir?: string;
  log?: (step: string, extra?: Record<string, unknown>) => void;
}): ThreadEventSync {
  const stateDir = opts.stateDir ?? dirname(opts.ledgerPath);
  const store = { threadStorePath: opts.threadStorePath };
  let offset = -1;
  const liveSize = (): number => {
    try {
      return statSync(opts.ledgerPath).size;
    } catch (error) {
      // deliberate: no live ledger yet reads as empty; the next tick looks again.
      void error;
      return 0;
    }
  };
  const mirror = (rows: ReadonlyArray<Record<string, unknown>>): number => {
    const proposals = operatorProposals(stateDir);
    let written = 0;
    for (const row of rows) written += recordRowThreadEvents(row, proposals, store, opts.log);
    return written;
  };
  let booted = false;
  const api: ThreadEventSync = {
    backfill: async () => {
      booted = true;
      offset = liveSize();
      const rows = await readLedgerUnionRecords(stateDir, { step: [...THREAD_EVENT_STEPS] });
      rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      return mirror(rows);
    },
    sync: async () => (booted ? api.poll() : api.backfill()),
    poll: () => {
      const size = liveSize();
      if (offset < 0) {
        offset = size;
        return 0;
      }
      if (size < offset) offset = 0; // the ledger was rotated; what rotated out is the next boot backfill's
      if (size === offset) return 0;
      const buffer = Buffer.alloc(size - offset);
      const fd = openSync(opts.ledgerPath, "r");
      let read: number;
      try {
        read = readSync(fd, buffer, 0, buffer.length, offset);
      } finally {
        closeSync(fd);
      }
      const complete = buffer.subarray(0, read).lastIndexOf(0x0a) + 1;
      if (complete === 0) return 0;
      offset += complete;
      const rows: Array<Record<string, unknown>> = [];
      for (const line of buffer.subarray(0, complete).toString("utf8").split("\n")) {
        if (!THREAD_EVENT_STEPS.some((step) => line.includes(`"${step}"`))) continue;
        try {
          rows.push(JSON.parse(line) as Record<string, unknown>);
        } catch (error) {
          opts.log?.("inbox.thread_event_row_unreadable", { error: String((error as Error)?.message ?? error) });
        }
      }
      return rows.length === 0 ? 0 : mirror(rows);
    },
  };
  return api;
}
