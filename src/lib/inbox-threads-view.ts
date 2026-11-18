/**
 * W1-T13456 — the `inbox-threads` view: the Inbox's thread LIST, paged, built in the read-model view thread.
 *
 * The Console reads `GET /v1/i/core/inbox/threads?qualified=1&limit=100` on every Inbox render and every 30 s
 * refresh. Serve computes that list on its main thread, per read, from the classification, the thread store and
 * the read marks. This view builds the same rows off the request path, so a read answers a stored body.
 *
 * SAME ROWS. Inputs are the ones the route reads under serve's slow lane: the persisted classification
 * (`readPersistedInbox`: proposals and classifications), the plain-message store, the thread store and the read
 * marks. Rows come from {@link operatorThreadItemsOf} and {@link listThreadViews}, the functions the route calls,
 * never a copy, so order, attention and unread counts cannot drift.
 *
 * PAGES. Bounded by row count ({@link INBOX_THREADS_PAGE_ROWS}) and bytes, as `pageInboxThreads` bounds the route's.
 * The first page's key is `""`; a later page's key is `cursor=<c>`, where the cursor binds the list's
 * `threadListKey` and the page's offset. A cursor from another list is refused 409 `restartRequired`
 * ({@link validateInboxThreadsRequest}), as the route's pager refuses one.
 *
 * INVARIANT inputs-not-clock: no clock is in `data`. A body is rebuilt only when an input file moves (its size,
 * mtime or inode), and a rebuild over unchanged rows reproduces the same data, so an unchanged list keeps its
 * ETag across worker passes. The classification's own time is the source's `asOf`, judged by serve per request.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { persistedInboxPath, readPersistedInbox } from "./fleet-lane.js";
import { fileFingerprint, inboxThreadStoreFile } from "./inbox-thread-view.js";
import { readAllThreads } from "./inbox-thread.js";
import { operatorThreadItemsOf } from "./inbox-thread-items.js";
import { INBOX_THREAD_PAGE_MAX_BYTES } from "./inbox-thread-list-view.js";
import { plainStorePath, readPlainStore } from "./inbox-plain.js";
import { listThreadViews, readMarksPath, readReadMarks, type ThreadSummaryView } from "./inbox-responder.js";
import { instanceInboxContractState } from "./instance-inbox-contract.js";
import { readSnapshotCursor, snapshotCursor } from "./read-page.js";
import { describeSource } from "./view-freshness.js";
import { viewKey, type ViewBodySource, type ViewRequestFailure, type ViewSource } from "./views.js";

export const INBOX_THREADS_VIEW_NAME = "inbox-threads";
export const INBOX_THREADS_VIEW_VERSION = 1;
/** Rows per page: the Console's `limit` (`INBOX_THREAD_PAGE_LIMIT`). */
export const INBOX_THREADS_PAGE_ROWS = 100;
/** PRIMARY CONTROL: a page's data leaves 8 KiB of the Console's 128 KiB read bound for the view envelope and sources. */
export const INBOX_THREADS_PAGE_DATA_BYTES = INBOX_THREAD_PAGE_MAX_BYTES - 8 * 1024;
/** The cursor's section: the same name the route's pager binds. */
const CURSOR_SECTION = "threads";
/** The inbox is core's alone today (inbox-thread-view.ts). */
const INBOX_STORE_INSTANCE = "core";

export interface InboxThreadsPage {
  index: number;
  of: number;
  total: number;
  nextCursor?: string;
}

export type InboxThreadsViewData =
  | {
    state: "ok";
    threads: ThreadSummaryView[];
    /** The classification snapshot the rows were projected from. */
    snapshotKey: string;
    /** The list's identity: every row, the contract and the evidence. A cursor binds it. */
    threadListKey: string;
    contract: "read-write" | "read-only";
    instance: string;
    repository?: string;
    completeness: "complete" | "partial";
    incompleteReason?: string;
    page: InboxThreadsPage;
  }
  | { state: "unavailable"; reason: string };

export interface InboxThreadsViewOptions {
  /** The inbox root (`state/` beneath it holds every input); absent, the view says why. */
  inboxRoot?: string;
  log?: (step: string, extra: Record<string, unknown>) => void;
}

type Built = Array<{ key: string; data: InboxThreadsViewData; sources: ViewSource[] }>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The view's key for a request: the first page is `""`, a later one `cursor=<c>`. */
export function inboxThreadsViewKey(cursor?: string): string {
  return cursor === undefined ? "" : viewKey(new URLSearchParams({ cursor }));
}

/** Rows split into pages of at most {@link INBOX_THREADS_PAGE_ROWS} rows whose data fits {@link INBOX_THREADS_PAGE_DATA_BYTES}. */
function pagesOf(rows: ThreadSummaryView[], envelope: (threads: ThreadSummaryView[]) => object): ThreadSummaryView[][] {
  const pages: ThreadSummaryView[][] = [];
  let page: ThreadSummaryView[] = [];
  for (const row of rows) {
    const next = [...page, row];
    if (page.length > 0 && (next.length > INBOX_THREADS_PAGE_ROWS || Buffer.byteLength(JSON.stringify(envelope(next))) > INBOX_THREADS_PAGE_DATA_BYTES)) {
      pages.push(page);
      page = [row];
    } else page = next;
    if (Buffer.byteLength(JSON.stringify(envelope(page))) > INBOX_THREADS_PAGE_DATA_BYTES) throw new Error(`the thread ${row.threadId} cannot fit a bounded page`);
  }
  if (page.length > 0 || pages.length === 0) pages.push(page);
  return pages;
}

export function createInboxThreadsView(opts: InboxThreadsViewOptions): {
  name: string;
  version: number;
  materialize(ctx: { now: number }): Built;
  /** Test seam: how many times the rows were rebuilt from their inputs. */
  builds(): number;
} {
  const log = opts.log ?? (() => {});
  let memo: { signature: string; built: Built } | undefined;
  let builds = 0;

  const unavailable = (reason: string): Built => [{ key: "", data: { state: "unavailable", reason },
    sources: [describeSource({ name: `inbox-store:${INBOX_STORE_INSTANCE}`, asOf: null, state: "unavailable", reason })] }];

  function build(root: string): Built {
    const stateDir = join(root, "state");
    const persisted = readPersistedInbox(stateDir);
    if (!persisted) return unavailable("serve's slow lane has not persisted an inbox classification yet");
    if (!persisted.snapshotKey) return unavailable("the persisted inbox classification has no snapshot identity");
    const stored = readAllThreads({ threadStorePath: inboxThreadStoreFile(root) });
    if (stored.status === "unresolved") return unavailable(`the thread store cannot be read: ${stored.reason}`);
    const scope = persisted.snapshotScope;
    const instance = scope?.instance ?? INBOX_STORE_INSTANCE;
    const repository = typeof scope?.repository === "string" && scope.repository !== "" ? scope.repository : undefined;
    const causalScope = repository ? { instance, repository } : undefined;
    const items = operatorThreadItemsOf(persisted, readPlainStore(plainStorePath(stateDir)), causalScope);
    const rows = listThreadViews(items, stored.threads, readReadMarks(readMarksPath(stateDir)));
    const complete = persisted.complete;
    const incompleteReason = complete ? undefined : persisted.incompleteReason ?? "the classification did not see every input";
    // As the route answers: an incomplete classification that shows no rows is no evidence of an empty inbox.
    if (!complete && rows.length === 0) return unavailable(incompleteReason!);
    const contract = instanceInboxContractState(stateDir).mode;
    const threadListKey = digest(["inbox-threads-v1", instance, repository ?? null, contract, complete, incompleteReason ?? null, rows]);
    const evidence = { snapshotKey: persisted.snapshotKey, threadListKey, contract, instance, ...(repository ? { repository } : {}),
      completeness: complete ? "complete" as const : "partial" as const, ...(incompleteReason ? { incompleteReason } : {}) };
    const envelope = (threads: ThreadSummaryView[]) => ({ state: "ok", threads, ...evidence, page: { index: 0, of: 0, total: rows.length, nextCursor: "x".repeat(160) } });
    const pages = pagesOf(rows, envelope);
    const source = describeSource({ name: `inbox-store:${INBOX_STORE_INSTANCE}`, asOf: persisted.generatedAt, state: "fresh" });
    let offset = 0;
    return pages.map((threads, index) => {
      const at = offset;
      offset += threads.length;
      const cursorAt = (n: number) => snapshotCursor({ snapshotKey: threadListKey, section: CURSOR_SECTION, offset: n });
      const page: InboxThreadsPage = { index, of: pages.length, total: rows.length, ...(index + 1 < pages.length ? { nextCursor: cursorAt(offset) } : {}) };
      return { key: inboxThreadsViewKey(index === 0 ? undefined : cursorAt(at)), data: { state: "ok" as const, threads, ...evidence, page }, sources: [source] };
    });
  }

  return {
    name: INBOX_THREADS_VIEW_NAME,
    version: INBOX_THREADS_VIEW_VERSION,
    builds: () => builds,
    materialize: () => {
      const root = opts.inboxRoot;
      if (!root) return unavailable("no inbox root is configured for the view thread");
      const stateDir = join(root, "state");
      // Every input the rows, the contract and the source read: an unchanged signature answers the held bodies.
      const signature = [persistedInboxPath(stateDir), inboxThreadStoreFile(root), readMarksPath(stateDir), plainStorePath(stateDir),
        join(stateDir, "inbox-proposals.json")].map(fileFingerprint).join("#");
      if (memo?.signature === signature) return memo.built;
      let built: Built;
      try {
        builds += 1;
        built = build(root);
      } catch (error) {
        // An input that cannot be projected answers as unavailable, never as an empty list.
        const reason = (error as Error).message;
        log("read_model.inbox_threads_view_failed", { error: reason });
        built = unavailable(reason);
      }
      memo = { signature, built };
      return built;
    },
  };
}

/**
 * Serve's request check for `GET /v1/views/inbox-threads`, run before a body is read: only `cursor` is accepted,
 * and a cursor must belong to the list the first page holds now. A cursor from an older list is refused 409
 * `restartRequired`, as `pageInboxThreads` refuses one; a malformed one 400.
 */
export function validateInboxThreadsRequest(params: URLSearchParams, source?: Pick<ViewBodySource, "body">): ViewRequestFailure | undefined {
  const unknown = [...params.keys()].find((name) => name !== "cursor");
  if (unknown !== undefined || params.getAll("cursor").length > 1) {
    return { status: 400, error: "invalid_request", detail: `the ${INBOX_THREADS_VIEW_NAME} view takes only ?cursor=, from the page before it` };
  }
  const raw = params.get("cursor") ?? undefined;
  if (raw === undefined || !source) return undefined;
  const head = source.body(INBOX_THREADS_VIEW_NAME, inboxThreadsViewKey())?.body.data as InboxThreadsViewData | undefined;
  const cursor = readSnapshotCursor(raw, head?.state === "ok" ? head.threadListKey : undefined, CURSOR_SECTION);
  if ("error" in cursor) return cursor;
  if (!source.body(INBOX_THREADS_VIEW_NAME, inboxThreadsViewKey(raw))) {
    return { status: 409, error: "inbox_snapshot_changed", restartRequired: true, snapshotKey: cursor.snapshotKey,
      detail: "The continuation is outside this thread list; restart at its first page." };
  }
  return undefined;
}
