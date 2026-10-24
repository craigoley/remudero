import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * W1-T2494: join an escalation to the answer it provoked.
 *
 * Fourteen modules raise escalations (`escalate.ts`) and 155 feedback entries already come back
 * the other way, but nothing joins the two: an escalation and its later human answer are two
 * unrelated records today, correlated only in an operator's head. This module is the JOIN, not a
 * new channel — GitHub issues stay (MASTER-PLAN §4); this only models and stores which messages
 * belong to the same conversation. It does not render (that's the console, W1-T2497) and it does
 * not carry the reply route (that's W1-T2496) — both depend on this task precisely because a
 * thread they can attach to has to exist first.
 *
 * THE THREAD ID MUST BE DERIVED, NEVER MINTED — the design decision the whole module turns on. A
 * random id per raise would make a re-raised, still-unanswered escalation a NEW thread every
 * time, and an inbox showing the same concern eight times is a notification stream, not
 * correspondence. `escalate.ts` already dedups repeats by a composite identity (taskId, class,
 * optionally cause/PR referent — see its own `findDuplicateEscalation` doc); {@link
 * deriveThreadId} reuses that exact identity, so re-raising an unanswered concern appends to the
 * thread an operator is already reading instead of starting a ninth one.
 */

/** Which side of the conversation a {@link ThreadMessage} came from. */
export type ThreadMessageRole = "escalation" | "reply";

/**
 * The composite identity {@link deriveThreadId} keys on — deliberately the SAME shape
 * `escalate.ts`'s own dedup search already uses (taskId + class, optionally narrowed by cause
 * and/or a PR referent scraped from the escalation's own text), so a concern's thread id and its
 * dedup key never drift apart. Every field here is something the escalation ALREADY carries or
 * already computes for its own dedup — never a new field invented for this task alone.
 */
export interface ThreadIdentity {
  taskId: string;
  class: string;
  cause?: string;
  /** The PR number a caller's own text names, e.g. via `escalate.ts`'s `extractPrRef` — a bare
   *  number string, not a URL, so two callers that name the same PR different ways still match. */
  prRef?: string;
}

/** One message on a thread — either the machine's original escalation prose or a later human
 *  reply. `seq` is an EXPLICIT integer, not array position, so a message's place in the
 *  conversation survives independently of how (or whether) a reader re-sorts the store. */
export interface ThreadMessage {
  threadId: string;
  role: ThreadMessageRole;
  body: string;
  /** 1-based position within THIS thread — never global across the whole store. */
  seq: number;
  /** Epoch millis, from {@link ThreadStoreDeps.now} (real callers: `Date.now`; tests: a fake
   *  clock, so ordering is assertable without a real wall-clock race). */
  ts: number;
  extra?: ThreadMessageExtra;
}

/** W1-T9252: what an operator did on an item, or what the fleet did in answer. The first five are the
 *  operator's (`from: "operator"`); the rest are the daemon's. */
export type ThreadEventKind =
  | "reframed" | "declined" | "restored" | "approved" | "released"
  | "redrafted" | "task_filed" | "released_to_fleet" | "refused" | "retired" | "retirement_outcome";

export interface ThreadEvent {
  kind: ThreadEventKind;
  /** The source ledger row's `run_id|step|ts`: one event per row, however often a writer runs. */
  key: string;
}

/** Whether a stored message is an operator action or fleet outcome ({@link appendThreadEvent}). */
export function hasThreadEvent(extra: ThreadMessageExtra | undefined): boolean {
  return extra !== undefined && extra.event !== undefined;
}

const OPERATOR_EVENT_KINDS: ReadonlySet<ThreadEventKind> = new Set(["reframed", "declined", "restored", "approved", "released"]);

export interface ThreadMessageExtra {
  event?: ThreadEvent;
  did?: { action: InboxThreadAction; undo?: string };
  suggestedAction?: InboxThreadAction;
  question?: boolean;
  operator?: string;
  replyId?: string;
  input?: InboxInputReference;
  response?: InboxResponseReference;
}

export interface InboxInputReference {
  id: string;
  repository: string;
  proposalId: string;
  threadId: string;
  contentSha256: string;
}

export interface InboxResponseReference {
  id: string;
  repository: string;
  proposalId: string;
  threadId: string;
  inputs: InboxInputReference[];
  outcome: "queued" | "completed" | "unknown";
}

export type InboxCausalScope = { repository: string; instance?: string };

export function captureInboxInput(scope: InboxCausalScope, proposalId: string, text: string, id: string = randomUUID()): InboxInputReference {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.repository) || !proposalId || !/^[A-Za-z0-9._:-]+$/.test(id) || id.length > 256) {
    throw new Error("inbox input capture requires verified repository, proposal and distinct input identity");
  }
  return { id, repository: scope.repository, proposalId, threadId: inboxThreadId(proposalId),
    contentSha256: createHash("sha256").update(text).digest("hex") };
}

export function verifiedInboxInput(value: unknown, scope: InboxCausalScope, proposalId: string, text?: string): value is InboxInputReference {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Partial<InboxInputReference>;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.repository) && typeof input.id === "string" && /^[A-Za-z0-9._:-]+$/.test(input.id) && input.id.length <= 256 &&
    input.repository === scope.repository && input.proposalId === proposalId && input.threadId === inboxThreadId(proposalId) &&
    typeof input.contentSha256 === "string" && /^[a-f0-9]{64}$/.test(input.contentSha256) &&
    (text === undefined || input.contentSha256 === createHash("sha256").update(text).digest("hex"));
}

function verifiedInboxResponse(value: unknown, scope: InboxCausalScope, proposalId: string): value is InboxResponseReference {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<InboxResponseReference>;
  return typeof response.id === "string" && response.id.length > 0 && response.repository === scope.repository &&
    response.proposalId === proposalId && response.threadId === inboxThreadId(proposalId) &&
    ["queued", "completed", "unknown"].includes(String(response.outcome)) && Array.isArray(response.inputs) && response.inputs.length > 0 &&
    new Set(response.inputs.map(input => input?.id)).size === response.inputs.length &&
    response.inputs.every(input => verifiedInboxInput(input, scope, proposalId));
}

function responseFingerprint(response: InboxResponseReference): string {
  const inputs = response.inputs.map(input => [input.id, input.repository, input.proposalId, input.threadId, input.contentSha256])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return JSON.stringify([response.id, response.repository, response.proposalId, response.threadId, response.outcome, inputs]);
}

export function causalThreadInputs(messages: readonly ThreadMessage[], scope: InboxCausalScope, proposalId: string,
  history: readonly { feedback?: unknown; input?: unknown; retracted?: unknown }[] = []) {
  const candidates = messages.filter(message => message.role === "reply" && (!hasThreadEvent(message.extra) || message.extra?.event?.kind === "reframed"));
  const counts = new Map<string, number>();
  const verified = candidates.flatMap(message => {
    const input = message.extra?.input;
    if (!verifiedInboxInput(input, scope, proposalId, message.body)) return [];
    counts.set(input.id, (counts.get(input.id) ?? 0) + 1);
    return [{ ...message, extra: { ...message.extra, input } }];
  });
  const captured = verified.filter(message => counts.get(message.extra.input.id) === 1);
  const byId = new Map(captured.map(message => [message.extra.input.id, message.extra.input]));
  const acknowledged = new Set<string>();
  const queued = new Set<string>(), completed = new Set<string>();
  const responseBodies = new Map<string, string>(), conflictingResponses = new Set<string>();
  for (const message of messages) {
    const response = message.extra?.response;
    if (message.role !== "escalation" || !verifiedInboxResponse(response, scope, proposalId)) continue;
    const body = responseFingerprint(response), previous = responseBodies.get(response.id);
    if (previous !== undefined && previous !== body) conflictingResponses.add(response.id);
    else responseBodies.set(response.id, body);
  }
  let unknown = captured.length !== candidates.length;
  for (const message of messages) {
    const response = message.extra?.response;
    if (response === undefined) continue;
    if (message.role !== "escalation" || !verifiedInboxResponse(response, scope, proposalId) || conflictingResponses.has(response.id) ||
      response.inputs.some(input => {
        const capturedInput = byId.get(input.id);
        return capturedInput === undefined || capturedInput.contentSha256 !== input.contentSha256;
      })) {
      unknown = true; continue;
    }
    if (response.outcome === "unknown") { unknown = true; continue; }
    for (const input of response.inputs) {
      acknowledged.add(input.id);
      if (response.outcome === "queued") queued.add(input.id);
      else completed.add(input.id);
    }
  }
  const historyIds = new Map<string, number>();
  for (const round of history) {
    const id = (round.input as Partial<InboxInputReference> | undefined)?.id;
    if (typeof id === "string") historyIds.set(id, (historyIds.get(id) ?? 0) + 1);
  }
  const retracted = new Set(history.flatMap(round => round.retracted === true && typeof round.feedback === "string" &&
    verifiedInboxInput(round.input, scope, proposalId, round.feedback) && historyIds.get(round.input.id) === 1 ? [round.input.id] : []));
  const active = captured.filter(message => !retracted.has(message.extra.input.id));
  return { captured, pending: active.filter(message => !acknowledged.has(message.extra.input.id)),
    pendingWork: active.filter(message => queued.has(message.extra.input.id) && !completed.has(message.extra.input.id)), unknown };
}

export type InboxThreadAction = "approve" | "decline" | "edit" | "restore";

export interface ThreadStoreDeps {
  /** Path to the append-only JSONL file every thread's messages are interleaved in — one row per
   *  {@link ThreadMessage}, discriminated by `threadId` on read, mirroring `ledger.ts`'s own
   *  one-file-many-concerns shape. */
  threadStorePath: string;
  /** Injectable clock — defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Derive a thread's id from its {@link ThreadIdentity} — PURE and deterministic, never a random
 * or time-based value, so calling this twice with the same identity always returns the same
 * string (claim: "the thread identity is derived from producer and class, never randomly
 * minted"). Two escalations that share (taskId, class) but differ in `cause` or `prRef` are
 * GENUINELY different concerns (a review-failing PR #10 and a CI-failing PR #10 are different
 * asks even from the same taskId/class) and must resolve to different threads, so every field
 * that distinguishes them in `escalate.ts`'s own dedup key is folded in here too — omitted
 * fields normalize to a fixed placeholder (`"-"`) so `{cause: undefined}` and `{cause: "-"}`
 * can never collide with a real value that happens to be the literal string `"-"`... except a
 * producer could never set `cause` to that (it's a closed three-way enum), so no real caller can
 * hit that edge.
 */
export function deriveThreadId(identity: ThreadIdentity): string {
  const parts = [identity.taskId, identity.class, identity.cause ?? "-", identity.prRef ?? "-"];
  return `thread:${parts.join("::")}`;
}

/**
 * Reading a thread has THREE honest outcomes, not two: messages exist, messages genuinely don't
 * exist yet (no store file, or a readable store with none for this id), or the store could not be
 * read at all (missing directory aside — a corrupt/torn line, a read error). Collapsing the last
 * case into "no messages" would tell an operator a concern has never been answered when the truth
 * is simply unknown — the acceptance claim this type exists for: "a thread whose store cannot be
 * read reports unresolved rather than an empty thread."
 */
export type ThreadReadResult = { status: "ok"; messages: ThreadMessage[] } | { status: "unresolved"; reason: string };

/**
 * Read every message belonging to `threadId`, ordered by {@link ThreadMessage.seq}. A store file
 * that does not exist yet is a genuine, knowable "no messages" (`status: "ok"`, empty array) — a
 * thread's first message hasn't been written, which is not the same failure as a store this
 * function cannot parse at all. ANY unparseable line anywhere in the file — even one belonging to
 * a different thread — degrades the WHOLE read to `"unresolved"`: a torn line means this function
 * cannot be sure what else might be missing or misattributed, so it refuses to assert "empty"
 * from data it could not fully read (fail-safe, mirroring why `ledger.ts`'s own reader counts
 * torn lines rather than silently dropping them).
 */
export function readThread(threadId: string, deps: ThreadStoreDeps): ThreadReadResult {
  if (!existsSync(deps.threadStorePath)) return { status: "ok", messages: [] };
  let raw: string;
  try {
    raw = readFileSync(deps.threadStorePath, "utf8");
  } catch (err) {
    return { status: "unresolved", reason: String((err as Error)?.message ?? err) };
  }
  const messages: ThreadMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: ThreadMessage;
    try {
      parsed = JSON.parse(trimmed) as ThreadMessage;
    } catch {
      return {
        status: "unresolved",
        reason: `unparseable line in ${deps.threadStorePath} — refusing to report a possibly-incomplete thread`,
      };
    }
    if (parsed.threadId === threadId) messages.push(parsed);
  }
  messages.sort((a, b) => a.seq - b.seq);
  return { status: "ok", messages };
}

/**
 * Append one message to the thread `identity` derives (see {@link deriveThreadId}) and return
 * that thread's id. `seq` is computed from how many messages THIS thread already has — re-raising
 * an unanswered concern (same identity, another `role: "escalation"` message) grows the same
 * thread's seq count rather than starting a new one at 1 (claim: "re-raising an unanswered
 * concern appends rather than starting a new thread"); an escalation followed by a human's reply
 * (same identity, `role: "reply"`) is `seq: 2` on that SAME thread (claim: "an escalation and a
 * later answer on the same concern resolve to one thread").
 *
 * THROWS when the store cannot be read (see {@link readThread}'s `"unresolved"` outcome) rather
 * than guessing a `seq` against data it cannot see — a caller inside a fire-and-forget best-effort
 * path (as `escalate.ts` is) is expected to catch this, exactly as it already tolerates a failed
 * dedup read or a failed label provisioning without losing the escalation itself.
 */
export function appendThreadMessage(
  identity: ThreadIdentity,
  role: ThreadMessageRole,
  body: string,
  deps: ThreadStoreDeps,
  extra?: ThreadMessageExtra,
): string {
  const threadId = deriveThreadId(identity);
  const existing = readThread(threadId, deps);
  if (existing.status === "unresolved") {
    throw new Error(`inbox-thread: cannot append to ${threadId} — ${existing.reason}`);
  }
  const now = deps.now ?? Date.now;
  const message: ThreadMessage = { threadId, role, body, seq: existing.messages.length + 1, ts: now(), ...(extra ? { extra } : {}) };
  mkdirSync(dirname(deps.threadStorePath), { recursive: true });
  const fd = openSync(deps.threadStorePath, "a");
  try {
    writeSync(fd, Buffer.from(JSON.stringify(message) + "\n", "utf8"));
  } finally {
    closeSync(fd);
  }
  return threadId;
}

export function appendThreadReplyOnce(
  identity: ThreadIdentity,
  body: string,
  replyId: string,
  deps: ThreadStoreDeps,
  extra: ThreadMessageExtra = {},
): { kind: "appended" | "existing" | "conflict"; seq: number; ts?: number } {
  const current = readThread(deriveThreadId(identity), deps);
  if (current.status === "unresolved") throw new Error(`inbox-thread: ${current.reason}`);
  const prior = current.messages.find((message) => message.role === "reply" && message.extra?.replyId === replyId);
  if (prior) return { kind: prior.body === body ? "existing" : "conflict", seq: prior.seq, ts: prior.ts };
  appendThreadMessage(identity, "reply", body, deps, { ...extra, replyId });
  return { kind: "appended", seq: current.messages.length + 1 };
}

/**
 * W1-T9252 — THE ONE WRITER of an operator action or a fleet outcome on an item's thread. Idempotent on
 * `event.key`: a retried verb, a re-run boot backfill and a crash-replay each leave one message. Operator
 * kinds are `reply` messages (rendered `from: "operator"`), the fleet's are `escalation` ones. `ts` is the
 * source row's time, so a backfilled event sorts where it happened. An operator event whose text the
 * operator already typed into the thread as a plain reply is that reply's echo and is not written again.
 * THROWS when the store cannot be read, like {@link appendThreadMessage}; callers decide whether that is fatal.
 */
export function appendThreadEvent(
  proposalId: string,
  event: ThreadEvent,
  text: string,
  deps: ThreadStoreDeps,
  ts?: number,
  extra: Pick<ThreadMessageExtra, "input" | "response"> = {},
): "appended" | "existing" {
  const current = readThread(inboxThreadId(proposalId), deps);
  if (current.status === "unresolved") throw new Error(`inbox-thread: ${current.reason}`);
  if (current.messages.some((message) => message.extra?.event?.key === event.key)) return "existing";
  if (extra.response) {
    const response = extra.response, scope = { repository: response.repository };
    if (!verifiedInboxResponse(response, scope, proposalId)) throw new Error("inbox-thread: invalid scoped completion");
    const sameIdentity = current.messages.filter(message => {
      const previous = message.extra?.response;
      return previous !== undefined && previous.id === response.id && previous.repository === response.repository &&
        previous.proposalId === proposalId && previous.threadId === response.threadId;
    });
    if (sameIdentity.length > 0) {
      if (sameIdentity.some(message => {
        const previous = message.extra?.response;
        return message.role !== "escalation" || !verifiedInboxResponse(previous, scope, proposalId) || responseFingerprint(previous) !== responseFingerprint(response);
      })) throw new Error("inbox-thread: completion identity reused for different inputs or outcome");
      return "existing";
    }
  }
  const operator = OPERATOR_EVENT_KINDS.has(event.kind);
  if (operator && current.messages.some(message => message.role === "reply" && !hasThreadEvent(message.extra) &&
    (extra.input ? verifiedInboxInput(message.extra?.input, { repository: extra.input.repository }, proposalId, message.body) && message.extra?.input?.id === extra.input.id
      : message.body.trim() === text.trim()))) return "existing";
  appendThreadMessage(inboxThreadIdentity(proposalId), operator ? "reply" : "escalation", text, { ...deps, now: ts === undefined ? deps.now : () => ts }, { event, ...extra });
  return "appended";
}

export const INBOX_THREAD_CLASS = "inbox";

export function inboxThreadIdentity(proposalId: string): ThreadIdentity {
  return { taskId: proposalId, class: INBOX_THREAD_CLASS };
}

export function inboxThreadId(proposalId: string): string {
  return deriveThreadId(inboxThreadIdentity(proposalId));
}

const INBOX_THREAD_SUFFIX = `::${INBOX_THREAD_CLASS}::-::-`;

export function proposalIdOfThread(threadId: string): string | undefined {
  if (!threadId.startsWith("thread:") || !threadId.endsWith(INBOX_THREAD_SUFFIX)) return undefined;
  const id = threadId.slice("thread:".length, -INBOX_THREAD_SUFFIX.length);
  return id.length > 0 ? id : undefined;
}

export function readAllThreads(
  deps: ThreadStoreDeps,
): { status: "ok"; threads: Map<string, ThreadMessage[]> } | { status: "unresolved"; reason: string } {
  const threads = new Map<string, ThreadMessage[]>();
  if (!existsSync(deps.threadStorePath)) return { status: "ok", threads };
  let raw: string;
  try {
    raw = readFileSync(deps.threadStorePath, "utf8");
  } catch (err) {
    return { status: "unresolved", reason: String((err as Error)?.message ?? err) };
  }
  return parseAllThreads(raw, deps.threadStorePath);
}


export function parseAllThreads(raw: string, sourcePath: string): ReturnType<typeof readAllThreads> {
  const threads = new Map<string, ThreadMessage[]>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: ThreadMessage;
    try {
      parsed = JSON.parse(trimmed) as ThreadMessage;
    } catch {
      return { status: "unresolved", reason: `unparseable line in ${sourcePath}` };
    }
    const list = threads.get(parsed.threadId) ?? [];
    list.push(parsed);
    threads.set(parsed.threadId, list);
  }
  for (const list of threads.values()) list.sort((a, b) => a.seq - b.seq);
  return { status: "ok", threads };
}
