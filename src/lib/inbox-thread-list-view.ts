/**
 * W1-T5269 — the Inbox thread LIST as a maintained, source-qualified projection.
 *
 * `GET /v1/inbox/threads` used to await a fleet-wide proposal classification before it could answer, and
 * on a cold or changed fleet that pass outran the console's five-second timeout: the Inbox showed no
 * conversations. This module takes the classification OUT of the request path. A read joins (or starts)
 * ONE shared refresh and waits for it only a bounded moment; past that it answers from what is already
 * held, labelled with the age of the classification it came from, or says plainly that nothing is
 * available yet. It is deliberately independent of panel-graph: every input arrives through
 * {@link ThreadListSources}, so the freshness rules are testable against a classifier that never returns.
 *
 * WHAT A READ MAY CLAIM. `ok` is the only outcome the legacy `{ threads }` body may carry: the refresh
 * finished inside the wait, so the rows are source-verified fresh. A held-but-old classification is
 * `stale`, which only a client that asked for the qualified envelope may receive. Nothing held, a failed
 * refresh with nothing held, an unreadable thread store, and an incomplete classification that shows no
 * rows are `unavailable`; none of them is ever returned as an empty list.
 */
import { listThreadViews, type InboxThreadItem, type ReadMarks, type ThreadSummaryView } from "./inbox-responder.js";
import { fixedClock } from "./clock.js";
import type { ThreadMessage } from "./inbox-thread.js";
import { createHash } from "node:crypto";
import { readPageRequest, readSnapshotCursor, snapshotCursor } from "./read-page.js";

/** How long a read waits for the shared refresh before answering from what it already holds. Under the console's 5 s. */
export const INBOX_THREAD_LIST_WAIT_MS = 1_500;
/** PRIMARY CONTROL: the complete opt-in thread page, including its scoped envelope, fits the existing Console read bound. */
export const INBOX_THREAD_PAGE_MAX_BYTES = 128 * 1024;

/** One classification pass as the view sees it: the opaque result, when it was made, and whether it saw every input. */
export interface ThreadListClassification<C> {
  classified: C;
  /** Epoch millis the classification itself was computed — never when a projection over it was built. */
  classifiedAtMs: number;
  /** False when an input could not be read in full (an indeterminate GitHub projection, an unverified referent). */
  complete: boolean;
  incompleteReason?: string;
}

export type ThreadStoreRead = { status: "ok"; threads: Map<string, ThreadMessage[]> } | { status: "unresolved"; reason: string };

export interface ThreadListSources<C> {
  now(): number;
  /** The coalescing classifier: resolves once the classification over the CURRENT inputs exists. May be slow. */
  classify(): Promise<ThreadListClassification<C>>;
  /** The last classification held, without computing one. */
  peek(): ThreadListClassification<C> | undefined;
  readThreads(): ThreadStoreRead;
  readMarks(): ReadMarks;
  /** The operator items one classification projects to. */
  items(classified: C): InboxThreadItem[];
  /** Identity of every other input `items` reads (the plain-message store), so a change to one rebuilds. */
  inputsKey(): string;
  /**
   * W1-T5886: told how every shared refresh settled, whether or not a read was still waiting on it. A pass
   * that outran the read's wait used to fail with no trace: the read had already answered "pending", and the
   * next read started another pass that did the same.
   */
  report?(settled: ThreadListRefreshSettled): void;
}

/** How one shared refresh ended, and how long it ran. */
export type ThreadListRefreshSettled =
  | { outcome: "landed"; ms: number; classifiedAtMs: number }
  | { outcome: "failed"; ms: number; error: string };

/** What a response says about the evidence under its rows. */
export interface ThreadListSource {
  state: "fresh" | "stale";
  completeness: "complete" | "partial";
  /** When the classification was made. */
  classifiedAt: string;
  /** When this read confirmed the classification current; null when it could not. */
  verifiedAt: string | null;
  /** `now - classifiedAt` at read time. */
  ageMs: number;
  /** When the projection over it was built: a separate fact from the classification's own time. */
  builtAt: string;
  /** Why a refresh did not land, when it failed. */
  refreshError?: string;
}

export type ThreadListUnavailableCode = "thread_store_unreadable" | "classification_pending" | "classification_failed" | "incomplete_evidence";

export type ThreadListRead =
  | { kind: "ok"; threads: ThreadSummaryView[]; source: ThreadListSource; threadListKey: string }
  | { kind: "stale"; threads: ThreadSummaryView[]; source: ThreadListSource; threadListKey: string }
  | { kind: "unavailable"; code: ThreadListUnavailableCode; detail: string };

type Refresh<C> = { ok: true; value: ThreadListClassification<C> } | { ok: false; error: string };

interface Built<C> {
  classified: C;
  threadsKey: string;
  marksKey: string;
  inputsKey: string;
  builtAtMs: number;
  views: ThreadSummaryView[];
  contentKey: string;
}

export interface InboxThreadListView<C> {
  readonly sources: ThreadListSources<C>;
  readonly waitMs: number;
  inflight?: Promise<Refresh<C>>;
  built?: Built<C>;
  /** The last refresh's failure, kept until one lands, so a read that joins its retry can still name it. */
  lastFailure?: string;
}

export function createInboxThreadListView<C>(sources: ThreadListSources<C>, opts: { waitMs?: number } = {}): InboxThreadListView<C> {
  return { sources, waitMs: opts.waitMs ?? INBOX_THREAD_LIST_WAIT_MS };
}

/**
 * Start the shared refresh, or join the one running. A failure is returned, never thrown, and never cached as
 * a result: the next read retries. It IS reported, and remembered as `lastFailure` until a refresh lands.
 */
function refresh<C>(view: InboxThreadListView<C>): Promise<Refresh<C>> {
  if (view.inflight !== undefined) return view.inflight;
  const { sources } = view;
  const startedMs = sources.now();
  const run = (async (): Promise<Refresh<C>> => {
    let settled: Refresh<C>;
    try {
      settled = { ok: true, value: await sources.classify() };
    } catch (err) {
      settled = { ok: false, error: String((err as Error)?.message ?? err) };
    }
    const ms = Math.max(0, sources.now() - startedMs);
    if (settled.ok) {
      view.lastFailure = undefined;
      sources.report?.({ outcome: "landed", ms, classifiedAtMs: settled.value.classifiedAtMs });
    } else {
      view.lastFailure = settled.error;
      sources.report?.({ outcome: "failed", ms, error: settled.error });
    }
    return settled;
  })();
  const inflight = run.finally(() => {
    if (view.inflight === inflight) view.inflight = undefined;
  });
  view.inflight = inflight;
  return inflight;
}

/** Warm the view without a request: start the shared refresh and let it land. Resolves when it has. */
export async function warmInboxThreadListView<C>(view: InboxThreadListView<C>): Promise<void> {
  await refresh(view);
}

function threadsDigest(threads: Map<string, ThreadMessage[]>): string {
  const hash = createHash("sha256");
  for (const id of [...threads.keys()].sort()) {
    hash.update(JSON.stringify([id, sequenceDigest(threads.get(id)!)])).update("\n");
  }
  return hash.digest("hex");
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** Compact JSON escapes embedded newlines, so each complete row has an unambiguous boundary without a corpus string. */
function sequenceDigest(values: Iterable<unknown>): string {
  const hash = createHash("sha256");
  for (const value of values) hash.update(JSON.stringify(value)).update("\n");
  return hash.digest("hex");
}

/** The projection over `classification`, rebuilt only when a thing it was built from has changed. */
function project<C>(view: InboxThreadListView<C>, classification: ThreadListClassification<C>, threads: Map<string, ThreadMessage[]>): Built<C> {
  const { sources } = view;
  const marks = sources.readMarks();
  const threadsKey = threadsDigest(threads);
  const marksKey = JSON.stringify(Object.entries(marks).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const inputsKey = sources.inputsKey();
  const held = view.built;
  if (held !== undefined && held.classified === classification.classified && held.threadsKey === threadsKey && held.marksKey === marksKey && held.inputsKey === inputsKey) return held;
  const items = sources.items(classification.classified);
  const built: Built<C> = {
    classified: classification.classified, threadsKey, marksKey, inputsKey,
    builtAtMs: sources.now(),
    views: listThreadViews(items, threads, marks),
    contentKey: digest([sequenceDigest(items), threadsKey, marksKey]),
  };
  view.built = built;
  return built;
}

function sourceOf<C>(view: InboxThreadListView<C>, classification: ThreadListClassification<C>, built: Built<C>, state: ThreadListSource["state"], refreshError?: string): ThreadListSource {
  const now = view.sources.now();
  return {
    state,
    completeness: classification.complete ? "complete" : "partial",
    classifiedAt: fixedClock(classification.classifiedAtMs).iso(),
    verifiedAt: state === "fresh" ? fixedClock(now).iso() : null,
    ageMs: Math.max(0, now - classification.classifiedAtMs),
    builtAt: fixedClock(built.builtAtMs).iso(),
    ...(refreshError === undefined ? {} : { refreshError }),
  };
}

/**
 * One read of the thread list. Reads the live thread messages and read marks (cheap, and the reason a
 * reply or a read cursor shows at once), joins the shared classification refresh for at most `waitMs`,
 * and answers from the maintained projection with the evidence it stands on.
 */
export async function readInboxThreadListView<C>(view: InboxThreadListView<C>): Promise<ThreadListRead> {
  const stored = view.sources.readThreads();
  if (stored.status === "unresolved") return { kind: "unavailable", code: "thread_store_unreadable", detail: stored.reason };
  const running = refresh(view);
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    running,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), view.waitMs);
    }),
  ]).finally(() => clearTimeout(timer));

  if (outcome?.ok === true) {
    const classification = outcome.value;
    const built = project(view, classification, stored.threads);
    if (!classification.complete && built.views.length === 0) {
      return { kind: "unavailable", code: "incomplete_evidence", detail: classification.incompleteReason ?? "the classification did not see every input" };
    }
    return { kind: "ok", threads: built.views, source: sourceOf(view, classification, built, "fresh"),
      threadListKey: digest([built.contentKey, classification.complete, classification.incompleteReason ?? null]) };
  }

  // A refresh that failed after an earlier read stopped waiting is still this read's evidence (W1-T5886).
  const refreshError = outcome === undefined ? (view.lastFailure === undefined ? undefined : `the last classification failed: ${view.lastFailure}; a retry is running`) : outcome.error;
  const held = view.sources.peek();
  if (held === undefined) {
    return refreshError === undefined
      ? { kind: "unavailable", code: "classification_pending", detail: "the first classification is still running" }
      : { kind: "unavailable", code: "classification_failed", detail: refreshError };
  }
  const built = project(view, held, stored.threads);
  return { kind: "stale", threads: built.views, source: sourceOf(view, held, built, "stale", refreshError),
    threadListKey: digest([built.contentKey, held.complete, held.incompleteReason ?? null]) };
}

export interface ThreadListEnvelope {
  threads: ThreadSummaryView[];
  source: ThreadListSource;
  repository?: string;
  instance?: string;
  contract?: string;
}

/** Page only a completed projection. No request-time classification, history I/O or new retained generation. */
export function pageInboxThreads(body: ThreadListEnvelope, contentKey: string, params: URLSearchParams): { status: number; body: object } {
  const limitOnly = new URLSearchParams(params); limitOnly.delete("cursor");
  const request = readPageRequest(limitOnly, 100, 500);
  if ("error" in request) return { status: 400, body: request };
  const threadListKey = digest(["thread-list-v1", body.repository ?? null, body.instance ?? null, body.contract ?? null,
    request.limit, params.get("qualified") === "1", contentKey]);
  const cursor = readSnapshotCursor(params.get("cursor") ?? undefined, threadListKey, "threads");
  if ("error" in cursor) { const { status, ...failure } = cursor; return { status, body: failure }; }
  const total = body.threads.length;
  if (cursor.offset > total || cursor.offset === total && total > 0) return { status: 409, body: { error: "inbox_snapshot_changed", restartRequired: true, detail: "The continuation is outside this thread list; restart at its first page." } };
  const envelope = (threads: ThreadSummaryView[], end: number) => ({ ...body, threads, threadListKey,
    page: { total, ...(end < total ? { nextCursor: snapshotCursor({ snapshotKey: threadListKey, section: "threads", offset: end }) } : {}) } });
  const tooLarge = () => ({ status: 413, body: { error: "inbox_thread_page_too_large", detail: "A thread summary or its source envelope cannot fit the bounded page; no row was omitted or truncated." } });
  const threads: ThreadSummaryView[] = [];
  let result = envelope(threads, cursor.offset);
  if (Buffer.byteLength(JSON.stringify(result)) > INBOX_THREAD_PAGE_MAX_BYTES) return tooLarge();
  for (const item of body.threads.slice(cursor.offset, cursor.offset + request.limit)) {
    const next = envelope([...threads, item], cursor.offset + threads.length + 1);
    if (Buffer.byteLength(JSON.stringify(next)) > INBOX_THREAD_PAGE_MAX_BYTES) {
      if (threads.length === 0) return tooLarge();
      break;
    }
    threads.push(item); result = next;
  }
  return { status: 200, body: result };
}
