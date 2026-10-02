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

/** How long a read waits for the shared refresh before answering from what it already holds. Under the console's 5 s. */
export const INBOX_THREAD_LIST_WAIT_MS = 1_500;

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
}

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
  | { kind: "ok"; threads: ThreadSummaryView[]; source: ThreadListSource }
  | { kind: "stale"; threads: ThreadSummaryView[]; source: ThreadListSource }
  | { kind: "unavailable"; code: ThreadListUnavailableCode; detail: string };

type Refresh<C> = { ok: true; value: ThreadListClassification<C> } | { ok: false; error: string };

interface Built<C> {
  classified: C;
  threadsKey: string;
  marksKey: string;
  inputsKey: string;
  builtAtMs: number;
  views: ThreadSummaryView[];
}

export interface InboxThreadListView<C> {
  readonly sources: ThreadListSources<C>;
  readonly waitMs: number;
  inflight?: Promise<Refresh<C>>;
  built?: Built<C>;
}

export function createInboxThreadListView<C>(sources: ThreadListSources<C>, opts: { waitMs?: number } = {}): InboxThreadListView<C> {
  return { sources, waitMs: opts.waitMs ?? INBOX_THREAD_LIST_WAIT_MS };
}

/** Start the shared refresh, or join the one running. A failure is returned, never thrown, and never kept. */
function refresh<C>(view: InboxThreadListView<C>): Promise<Refresh<C>> {
  if (view.inflight !== undefined) return view.inflight;
  const run = (async (): Promise<Refresh<C>> => {
    try {
      return { ok: true, value: await view.sources.classify() };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
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
  const parts: string[] = [];
  for (const [id, messages] of threads) {
    const last = messages[messages.length - 1];
    parts.push(`${id}:${messages.length}:${last?.seq ?? 0}:${last?.ts ?? 0}:${last?.body.length ?? 0}`);
  }
  return parts.sort().join("|");
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
  const built: Built<C> = {
    classified: classification.classified, threadsKey, marksKey, inputsKey,
    builtAtMs: sources.now(),
    views: listThreadViews(sources.items(classification.classified), threads, marks),
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
    return { kind: "ok", threads: built.views, source: sourceOf(view, classification, built, "fresh") };
  }

  const refreshError = outcome === undefined ? undefined : outcome.error;
  const held = view.sources.peek();
  if (held === undefined) {
    return refreshError === undefined
      ? { kind: "unavailable", code: "classification_pending", detail: "the first classification is still running" }
      : { kind: "unavailable", code: "classification_failed", detail: refreshError };
  }
  const built = project(view, held, stored.threads);
  return { kind: "stale", threads: built.views, source: sourceOf(view, held, built, "stale", refreshError) };
}
