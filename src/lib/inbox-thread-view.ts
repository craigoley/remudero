/**
 * The `inbox-thread?id=` view (arch Phase 4, P4-T10): one inbox thread's page, built on demand.
 *
 * `/inbox/[threadId]` polled `GET /v1/inbox/thread` every 8 s, and that route classifies every proposal
 * on the request: 15.2 s cold on the host. This view is keyed by the thread id, so it is built only for
 * a thread somebody asked for (view-demand.ts) and kept for ten minutes after the last read.
 *
 * Built in the read-model view thread from two inputs, neither of them a classification:
 * - the thread store (`<inboxRoot>/state/inbox-threads.jsonl`) and the operator's read marks;
 * - the thread's proposal as the persisted `inbox` view holds it (`needsYou` pages, inbox-view.ts): its
 *   plain message, summary and lane, which the slow lane already classified.
 *
 * A key is REBUILT only when an input moved: the thread file's fingerprint (size, mtime, inode), the read
 * marks' fingerprint, or the ETags of the `inbox` view's `needsYou` pages (the proposal's classification).
 * The body carries no clock, so an unchanged thread keeps its ETag across worker passes, and a reply,
 * which appends to the store, moves it. Source: `inbox-store:<instance>`.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { readReadMarks, readMarksPath, threadDetailView, type InboxThreadItem, type ThreadDetailView } from "./inbox-responder.js";
import { inboxThreadId, proposalIdOfThread, readThread } from "./inbox-thread.js";
import type { ReadModelDb } from "./read-model-db.js";
import { describeSource } from "./view-freshness.js";
import type { ViewSource } from "./views.js";
import type { DemandBook } from "./view-demand.js";

export const INBOX_THREAD_VIEW_NAME = "inbox-thread";
export const INBOX_THREAD_VIEW_VERSION = 1;
/** The inbox is core's alone today; its source is named for the instance that classifies it (inbox-view.ts). */
const INBOX_STORE_INSTANCE = "core";
/** The `inbox` view's pages that hold the operator's items. Mirrors inbox-view.ts's `section=needsYou` keys. */
const NEEDS_YOU_KEY_PATTERN = "section=needsYou%";

/** The thread store every inbox thread route and the daemon's responder share (panel-graph.ts's `inboxThreadStorePath`). */
export function inboxThreadStoreFile(inboxRoot: string): string {
  return join(inboxRoot, "state", "inbox-threads.jsonl");
}

/** The view's key: the thread id. */
export function inboxThreadViewKey(threadId: string): string {
  return `id=${encodeURIComponent(threadId)}`;
}

export interface InboxThreadViewData {
  threadId: string;
  /** False when the thread has no item in the inbox, or an input could not be read; `reason` says which. */
  found: boolean;
  reason?: string;
  thread?: ThreadDetailView;
}

export interface InboxThreadViewOptions {
  /** The inbox root (`state/` beneath it holds the thread store and the read marks); absent, every key reports why. */
  inboxRoot?: string;
  demand: DemandBook;
  clock?: Clock;
  log?: (step: string, extra: Record<string, unknown>) => void;
}

type Slot = { db?: ReadModelDb };

/** `size:mtime:inode` of a file, or `absent`: what dirties a key when its file is appended to or replaced. */
export function fileFingerprint(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
  } catch (error) {
    // deliberate: an absent file is a knowable "no messages yet", and its appearance moves the fingerprint.
    void error;
    return "absent";
  }
}

const LANE_STATES: Record<string, InboxThreadItem["state"]> = { ready: "ready", drafting: "drafting", notReady: "notReady", declined: "declined" };

interface InboxPages {
  /** The pages' ETags, in key order: the proposal's classification moves one of them. */
  signature: string;
  /** The newest `asOf` among the pages' sources, or null. */
  asOf: string | null;
  rows: number;
}

function inboxPages(db: ReadModelDb): InboxPages {
  const rows = db.prepare("SELECT key, etag, json_extract(body, '$.sources[0].asOf') AS asOf FROM view_body WHERE view = 'inbox' AND key LIKE ? ORDER BY key").all(NEEDS_YOU_KEY_PATTERN);
  let asOf: string | null = null;
  for (const row of rows) if (typeof row.asOf === "string" && (asOf === null || row.asOf > asOf)) asOf = row.asOf;
  return { signature: rows.map((row) => `${String(row.key)}=${String(row.etag)}`).join("|"), asOf, rows: rows.length };
}

/** The proposal's item off the persisted `needsYou` pages: its lane is the thread's state. */
function itemOf(db: ReadModelDb, proposalId: string): InboxThreadItem | undefined {
  const rows = db.prepare("SELECT body FROM view_body WHERE view = 'inbox' AND key LIKE ? ORDER BY key").all(NEEDS_YOU_KEY_PATTERN);
  for (const row of rows) {
    const items = (JSON.parse(String(row.body)) as { data?: { items?: Array<{ proposalId: string; summary: string; plain: InboxThreadItem["plain"]; lane?: string }> } }).data?.items ?? [];
    const item = items.find((candidate) => candidate.proposalId === proposalId);
    const state = item?.lane ? LANE_STATES[item.lane] : undefined;
    if (item && state) return { proposalId: item.proposalId, summary: item.summary, plain: item.plain, state };
  }
  return undefined;
}

export function createInboxThreadView(opts: InboxThreadViewOptions): {
  name: string;
  version: number;
  demand: true;
  materialize(ctx: { now: number; instances: ReadonlyArray<Slot> }): Array<{ key: string; data: InboxThreadViewData; sources: ViewSource[] }>;
} {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? (() => {});
  /** The last body each key built, and the inputs it was built from: an unchanged signature is answered from here. */
  const memo = new Map<string, { signature: string; data: InboxThreadViewData; state: "fresh" | "unavailable"; reason?: string }>();

  const source = (state: "fresh" | "unavailable", asOf: string | null, reason?: string): ViewSource =>
    describeSource({ name: `inbox-store:${INBOX_STORE_INSTANCE}`, asOf: state === "fresh" ? asOf ?? clock.iso() : null, state, ...(reason ? { reason } : {}) });

  function build(key: string, db: ReadModelDb | undefined): { data: InboxThreadViewData; sources: ViewSource[] } {
    const threadId = new URLSearchParams(key).get("id") ?? "";
    const unavailable = (reason: string): { data: InboxThreadViewData; sources: ViewSource[] } => ({ data: { threadId, found: false, reason }, sources: [source("unavailable", null, reason)] });
    const proposalId = proposalIdOfThread(threadId);
    if (!proposalId) return unavailable(`"${threadId}" is not an inbox thread id`);
    if (!opts.inboxRoot) return unavailable("no inbox root is configured for the view thread");
    if (!db) return unavailable("the read model store is not open yet");
    const pages = inboxPages(db);
    if (pages.rows === 0) return unavailable("the inbox has not been classified yet");
    const storePath = inboxThreadStoreFile(opts.inboxRoot);
    const marksPath = readMarksPath(join(opts.inboxRoot, "state"));
    const signature = `${pages.signature}#${fileFingerprint(storePath)}#${fileFingerprint(marksPath)}`;
    const held = memo.get(key);
    if (held?.signature === signature) return { data: held.data, sources: [source(held.state, pages.asOf, held.reason)] };
    let data: InboxThreadViewData;
    let state: "fresh" | "unavailable" = "fresh";
    let reason: string | undefined;
    const item = itemOf(db, proposalId);
    const stored = readThread(inboxThreadId(proposalId), { threadStorePath: storePath });
    if (stored.status === "unresolved") {
      state = "unavailable";
      reason = `the thread store cannot be read: ${stored.reason}`;
      data = { threadId, found: false, reason };
    } else if (!item) {
      data = { threadId, found: false, reason: `no inbox thread "${threadId}"` };
    } else {
      data = { threadId, found: true, thread: threadDetailView(item, new Map([[threadId, stored.messages]]), readReadMarks(marksPath)) };
    }
    memo.set(key, { signature, data, state, ...(reason ? { reason } : {}) });
    return { data, sources: [source(state, pages.asOf, reason)] };
  }

  return {
    name: INBOX_THREAD_VIEW_NAME,
    version: INBOX_THREAD_VIEW_VERSION,
    demand: true,
    materialize: ({ instances }) => {
      const keys = opts.demand.keys(INBOX_THREAD_VIEW_NAME);
      for (const key of memo.keys()) if (!keys.includes(key)) memo.delete(key);
      const db = instances[0]?.db;
      return keys.map((key) => {
        try {
          return { key, ...build(key, db) };
        } catch (error) {
          // One key that cannot be built answers as unavailable; it never takes the other keys' bodies with it.
          const reason = (error as Error).message;
          const threadId = new URLSearchParams(key).get("id") ?? "";
          log("read_model.inbox_thread_view_failed", { threadId, error: reason });
          return { key, data: { threadId, found: false, reason }, sources: [source("unavailable", null, reason)] };
        }
      });
    },
  };
}
