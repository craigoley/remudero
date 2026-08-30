import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

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
}

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
): string {
  const threadId = deriveThreadId(identity);
  const existing = readThread(threadId, deps);
  if (existing.status === "unresolved") {
    throw new Error(`inbox-thread: cannot append to ${threadId} — ${existing.reason}`);
  }
  const now = deps.now ?? Date.now;
  const message: ThreadMessage = { threadId, role, body, seq: existing.messages.length + 1, ts: now() };
  mkdirSync(dirname(deps.threadStorePath), { recursive: true });
  const fd = openSync(deps.threadStorePath, "a");
  try {
    writeSync(fd, Buffer.from(JSON.stringify(message) + "\n", "utf8"));
  } finally {
    closeSync(fd);
  }
  return threadId;
}
