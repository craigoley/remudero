import { existsSync, readFileSync } from "node:fs";

import { systemClock, type Clock } from "./clock.js";
import { buildDecisionSummarySpawnArgs } from "./feedback.js";
import { writeAtomic } from "./fs-race-safe.js";
import { declinedReasonInLedger, parseProposalRegistry } from "./inbox.js";
import { inboxOwner } from "./inbox-owner.js";
import { machineTokens, plainInboxMessage, plainStorePath, readPlainStore, type PlainInboxMessage } from "./inbox-plain.js";
import {
  appendThreadMessage,
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
  proposalId: string;
  summary: string;
  plain: PlainInboxMessage;
  state: "ready" | "drafting" | "notReady" | "declined";
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
  lastActivity: number | null;
  messageCount: number;
  unread: boolean;
}

export interface ThreadDetailView extends ThreadSummaryView {
  /** The raw summary, for the console's Details. */
  details: string;
  messages: ThreadMessageView[];
}

const ACTIONS_BY_STATE: Record<InboxThreadItem["state"], InboxThreadAction[]> = {
  ready: ["approve", "decline", "edit"],
  drafting: ["decline", "edit"],
  notReady: ["decline", "edit"],
  declined: ["restore"],
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

function detailFor(item: InboxThreadItem, stored: ThreadMessage[], marks: ReadMarks): ThreadDetailView {
  const messages = [openingMessage(item), ...stored.map(storedMessageView)];
  const last = messages[messages.length - 1]!;
  const threadId = inboxThreadId(item.proposalId);
  return {
    threadId,
    proposalId: item.proposalId,
    headline: item.plain.headline,
    snippet: last.text.split(/(?<=[.!?])\s/)[0]!.slice(0, 160),
    waitingOn: last.from === "operator" ? "daemon" : "operator",
    lastActivity: last.ts,
    messageCount: messages.length,
    unread: last.from === "daemon" && (marks[threadId] ?? -1) < last.seq,
    details: item.summary,
    messages,
  };
}

/** Every operator item's thread, waiting-on-you first, then most recent activity. A declined item
 *  is listed only once someone has written on its thread. */
export function listThreadViews(
  items: InboxThreadItem[],
  threads: Map<string, ThreadMessage[]>,
  marks: ReadMarks,
): ThreadSummaryView[] {
  const views = items
    .filter((item) => item.state !== "declined" || (threads.get(inboxThreadId(item.proposalId))?.length ?? 0) > 0)
    .map((item) => {
      const { details: _details, messages: _messages, ...summary } = detailFor(item, threads.get(inboxThreadId(item.proposalId)) ?? [], marks);
      return summary;
    });
  return views.sort((a, b) => {
    if (a.waitingOn !== b.waitingOn) return a.waitingOn === "operator" ? -1 : 1;
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
  if (!last || last.role !== "reply") return undefined;
  const item = deps.readItems().find((i) => i.proposalId === proposalId);
  if (!item) return undefined;

  const detail = threadDetailView(item, all.threads, {});
  let decision = await decideFor({ item, messages: detail.messages, replyText: last.body }, deps);
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
): { stop: () => void; settled: () => Promise<void> } {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return;
    running = (async () => {
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
  return proposals
    .filter((p) => inboxOwner(p) === "operator")
    .map((p) => ({
      proposalId: p.id,
      summary: p.summary,
      plain: plainInboxMessage(p, plainStore),
      state: declinedReasonInLedger(lines, p.id) !== undefined ? ("declined" as const) : ("ready" as const),
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
  const spawn = opts.spawn ?? spawnWorker;
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
