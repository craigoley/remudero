/**
 * W1-T13456: the `inbox-threads` view pages the thread list GET /v1/inbox/threads answers, built in the read-model
 * view thread, so the Console's most-read legacy route (every Inbox render and every 30 s refresh) can retire.
 *
 * The fixture is real: a proposal registry classified by serve's own slow-lane refresh into the persisted
 * classification, threads written to the real thread store, and read marks written by the real marker. The route
 * reads it as serve's slow lane serves it (`inboxFromSlowLane`), and the view reads the same files.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { systemClock, type Clock } from "#src/lib/clock.js";
import { appendThreadMessage, inboxThreadId, inboxThreadIdentity } from "#src/lib/inbox-thread.js";
import { inboxThreadStoreFile } from "#src/lib/inbox-thread-view.js";
import { markThreadRead, readMarksPath, type ThreadSummaryView } from "#src/lib/inbox-responder.js";
import {
  createInboxThreadsView, INBOX_THREADS_PAGE_ROWS, INBOX_THREADS_VIEW_NAME, inboxThreadsViewKey, validateInboxThreadsRequest,
  type InboxThreadsViewData,
} from "#src/lib/inbox-threads-view.js";
import { refreshInboxClassification } from "#src/lib/inbox-view.js";
import type { Proposal } from "#src/lib/inbox.js";
import { buildInboxThreadsRoute, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { flushReadModelTransactions } from "#src/lib/read-model-db.js";
import { createReadModelTicker, type ReadModelBodyEntry, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import { createService } from "#src/lib/service.js";
import { makeTempDir } from "#src/lib/tmp.js";
import type { ViewBodyEntry } from "#src/lib/views.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type TestCtx = { after: (fn: () => void | Promise<void>) => void };
const COUNT = 130;

/** A registry of operator rulings (more than one page of rows), classified and persisted as serve's slow lane does. */
async function fixture(t: TestCtx) {
  const repository = gitRepo({ seedCommit: false, kind: "inbox-threads-view" }), root = repository.dir;
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, "plan"));
  const stateDir = join(root, "state");
  const registryPath = join(stateDir, "inbox-proposals.json"), planPath = join(root, "plan/tasks.yaml"), ledgerPath = join(stateDir, "ledger.ndjson");
  const proposals: Proposal[] = Array.from({ length: COUNT }, (_, i) => ({ id: `ruling:list-${String(i).padStart(3, "0")}`, summary: `Ruling ${i}: which policy applies?`, evidenceAnchors: [] }));
  writeFileSync(planPath, "[]\n");
  writeFileSync(ledgerPath, "");
  repository.git("add", "plan/tasks.yaml");
  repository.git("commit", "-qm", "fixture plan");
  writeFileSync(registryPath, JSON.stringify({ proposals }));
  const deps: PanelGraphDeps = { root, inboxRoot: root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(),
    inboxMainSha: () => "a".repeat(40), inboxGrepAnchor: () => true, ratify: { approve: () => undefined, reframe: () => undefined },
    inboxAuditScope: { instance: "core", repository: "owner/core" } };
  t.after(async () => { await flushReadModelTransactions(); rmSync(root, { recursive: true, force: true }); });
  const store = inboxThreadStoreFile(root);
  const write = (i: number, role: "escalation" | "reply", body: string, ts: number) =>
    appendThreadMessage(inboxThreadIdentity(proposals[i]!.id), role, body, { threadStorePath: store, now: () => ts });
  const now = systemClock.now();
  // Daemon-last threads (unread until marked), operator-last threads, and threads with only their opening message.
  for (let i = 0; i < COUNT; i += 3) write(i, "escalation", `Which policy should ruling ${i} use?`, now - 60_000 + i);
  for (let i = 0; i < COUNT; i += 5) write(i, "reply", `Use the first for ${i}.`, now - 30_000 + i);
  // The real marker: some daemon-last threads are read, the rest stay unread.
  for (let i = 0; i < COUNT; i += 6) markThreadRead(readMarksPath(stateDir), inboxThreadId(proposals[i]!.id), 99);
  // Classified at the real clock, so the route's freshness budget accepts it as the slow lane's current pass.
  const classify = async (clock: Clock = systemClock) => { await refreshInboxClassification(deps, {}, clock); };
  await classify();
  return { root, stateDir, deps, proposals, write, classify };
}

/** Every row of the route's pages, walked by its own continuation, as the Console walks them. */
async function routeRows(t: TestCtx, deps: PanelGraphDeps): Promise<ThreadSummaryView[]> {
  const route = buildInboxThreadsRoute({ ...deps, inboxFromSlowLane: true }, undefined, { warm: false, waitMs: 10_000 });
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox/threads?qualified=1&limit=${INBOX_THREADS_PAGE_ROWS}`;
  const rows: ThreadSummaryView[] = [];
  for (let path = base, pages = 0; ; pages++) {
    assert.ok(pages < 10, "the route's chain ends");
    const res = await fetch(path, { headers: { authorization: "Bearer read" } });
    const body = await res.json() as { threads: ThreadSummaryView[]; source: { state: string }; page: { nextCursor?: string } };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.source.state, "fresh", "control: the route answered from the slow lane's current classification");
    rows.push(...body.threads);
    if (!body.page.nextCursor) return rows;
    path = `${base}&cursor=${encodeURIComponent(body.page.nextCursor)}`;
  }
}

type Built = { key: string; data: InboxThreadsViewData };
const ok = (data: InboxThreadsViewData) => {
  assert.equal(data.state, "ok", JSON.stringify(data));
  return data as Extract<InboxThreadsViewData, { state: "ok" }>;
};

/** Every row of the view's pages, walked from the first key by each page's cursor. */
function viewRows(built: Built[]): { rows: ThreadSummaryView[]; pages: Array<Extract<InboxThreadsViewData, { state: "ok" }>> } {
  const byKey = new Map(built.map((entry) => [entry.key, entry.data]));
  const pages: Array<Extract<InboxThreadsViewData, { state: "ok" }>> = [];
  for (let key: string | undefined = inboxThreadsViewKey(); key !== undefined;) {
    const data = byKey.get(key);
    assert.ok(data, `the view holds a body for key "${key}"`);
    const page = ok(data);
    pages.push(page);
    key = page.page.nextCursor === undefined ? undefined : inboxThreadsViewKey(page.page.nextCursor);
  }
  assert.equal(pages.length, built.length, "every key the view built is on the one cursor chain");
  return { rows: pages.flatMap((page) => page.threads), pages };
}

/** A body source over one materialization, as serve's read model hands the validator its held bodies. */
function heldBodies(built: Built[]): Pick<import("#src/lib/views.js").ViewBodySource, "body"> {
  const byKey = new Map(built.map((entry) => [entry.key, { view: INBOX_THREADS_VIEW_NAME, key: entry.key, body: { data: entry.data } } as unknown as ViewBodyEntry]));
  return { body: (view, key = "") => view === INBOX_THREADS_VIEW_NAME ? byKey.get(key) : undefined };
}

test("W1-T13456 criterion 1: the view pages the same rows in the same order with the same unread flags as GET /v1/inbox/threads", async (t) => {
  const f = await fixture(t);
  const legacy = await routeRows(t, f.deps);
  const view = createInboxThreadsView({ inboxRoot: f.root });
  const { rows, pages } = viewRows(view.materialize({ now: systemClock.now() }));
  // CONTROLS: a real multi-page list with both read and unread daemon-last threads, so order and unread were compared.
  assert.equal(legacy.length, COUNT, "positive control: the route lists every operator ruling");
  assert.ok(pages.length > 1, "positive control: the list spans more than one page");
  assert.ok(legacy.some((row) => row.unread) && legacy.some((row) => !row.unread && row.waitingOn === "operator"), "both unread and read threads are listed");
  assert.deepEqual(rows, legacy, "the same rows, in the same order, field for field");
  assert.equal(rows.filter((row) => row.unread).length, legacy.filter((row) => row.unread).length, "the same unread count");
  assert.ok(pages.every((page) => page.threads.length <= INBOX_THREADS_PAGE_ROWS && page.page.total === COUNT), "each page is bounded and names the whole census");
  assert.ok(pages.every((page) => page.instance === "core" && page.repository === "owner/core" && page.contract === "read-write" && page.completeness === "complete"));
});

test("W1-T13456 criterion 2: each page carries snapshotKey, threadListKey and a cursor, and a cursor from an older list is refused 409 restartRequired", async (t) => {
  const f = await fixture(t);
  const view = createInboxThreadsView({ inboxRoot: f.root });
  const before = view.materialize({ now: systemClock.now() });
  const { pages } = viewRows(before);
  for (const page of pages) {
    assert.match(page.snapshotKey, /^[a-f0-9]{64}$/);
    assert.equal(page.threadListKey, pages[0]!.threadListKey, "every page of one list binds one threadListKey");
  }
  assert.match(pages[0]!.threadListKey, /^[a-f0-9]{64}$/);
  const cursor = pages[0]!.page.nextCursor;
  assert.ok(cursor, "the first page names the next");
  assert.equal(pages.at(-1)!.page.nextCursor, undefined, "the last page names none");
  // The current list accepts its own cursor, and nothing but a cursor.
  assert.equal(validateInboxThreadsRequest(new URLSearchParams({ cursor }), heldBodies(before)), undefined);
  assert.equal(validateInboxThreadsRequest(new URLSearchParams(), heldBodies(before)), undefined);
  assert.equal(validateInboxThreadsRequest(new URLSearchParams({ limit: "100" }), heldBodies(before))?.status, 400);
  assert.equal(validateInboxThreadsRequest(new URLSearchParams({ cursor: "not a cursor!" }), heldBodies(before))?.status, 400);
  // A reply moves the list: the old cursor now belongs to an older list.
  f.write(1, "reply", "A new answer.", systemClock.now());
  const after = view.materialize({ now: systemClock.now() });
  assert.notEqual(ok(after.find((entry) => entry.key === "")!.data).threadListKey, pages[0]!.threadListKey, "control: the list moved");
  const refused = validateInboxThreadsRequest(new URLSearchParams({ cursor }), heldBodies(after));
  assert.equal(refused?.status, 409, JSON.stringify(refused));
  assert.equal(refused?.error, "inbox_snapshot_changed");
  assert.equal(refused?.restartRequired, true);
  // Through serve's own validator wiring: no list held yet answers 503, never a guessed page.
  assert.equal(validateInboxThreadsRequest(new URLSearchParams({ cursor }), { body: () => undefined })?.status, 503);
});

test("W1-T13456 criterion 3: an unchanged list keeps its ETag across worker passes, and a read mark moves it", async (t) => {
  const f = await fixture(t);
  let at = systemClock.now();
  const clock: Clock = { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString() };
  const messages: ReadModelWorkerMessage[] = [];
  const view = createInboxThreadsView({ inboxRoot: f.root });
  const readModelState = makeTempDir("inbox-threads-view-rm");
  const ledgerDir = join(readModelState, "ledger");
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
  // No switch file: the view is served by default, so its declared reader builds it with none.
  const ticker = createReadModelTicker({ stateDir: readModelState, instances: [{ name: "core", ledgerDir }], clock, holder: "inbox-threads-view", oracle: "off", views: [view], post: (m) => void messages.push(m) });
  t.after(async () => { ticker.release(); await flushReadModelTransactions(); rmSync(readModelState, { recursive: true, force: true }); });
  ticker.start();
  const firstPage = (): ReadModelBodyEntry[] => messages.flatMap((m) => m.type === "body" && m.entry.view === INBOX_THREADS_VIEW_NAME && m.entry.key === "" ? [m.entry] : []);
  const tick = (n: number, stepMs = 1_000) => { for (let i = 0; i < n; i++) { ticker.tick(); at += stepMs; } };
  tick(2);
  const first = firstPage().at(-1);
  assert.ok(first, "the view built its first page with no switch entry");
  const builds = view.builds();
  tick(10, 60_000);
  assert.equal(view.builds(), builds, "no input moved, so no pass rebuilt the rows");
  // The slow lane re-stamps an unchanged classification an hour later: the input file moves, the rows do not.
  await f.classify({ now: () => at + 3_600_000, date: () => new Date(at + 3_600_000), iso: () => new Date(at + 3_600_000).toISOString() });
  tick(2);
  assert.ok(view.builds() > builds, "control: the re-stamped classification was re-read");
  assert.equal(firstPage().length, 1, "the rebuilt page has the same data, so no second body was posted");
  assert.equal(firstPage().at(-1)?.etag, first.etag);
  // A read mark moves the list's unread flags, so its ETag moves.
  const unread = ok(first.body.data as InboxThreadsViewData).threads.find((row) => row.unread);
  assert.ok(unread, "positive control: an unread thread is on the first page");
  markThreadRead(readMarksPath(f.stateDir), unread.threadId, 1_000);
  tick(2);
  assert.notEqual(firstPage().at(-1)?.etag, first.etag, "the read mark moved the ETag");
  assert.equal(ok(firstPage().at(-1)!.body.data as InboxThreadsViewData).threads.find((row) => row.threadId === unread.threadId)?.unread, false);
});

test("the view says why, never an empty list, when the classification is absent or the thread store is unreadable", async (t) => {
  const empty = makeTempDir("inbox-threads-view-empty");
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  mkdirSync(join(empty, "state"), { recursive: true });
  const none = createInboxThreadsView({ inboxRoot: empty }).materialize({ now: 0 });
  assert.deepEqual(none.map((entry) => [entry.key, entry.data.state, entry.sources[0]?.state]), [["", "unavailable", "unavailable"]]);
  assert.deepEqual(createInboxThreadsView({}).materialize({ now: 0 }).map((entry) => entry.data.state), ["unavailable"]);
  const f = await fixture(t);
  writeFileSync(inboxThreadStoreFile(f.root), "{not json\n");
  const logged: string[] = [];
  const torn = createInboxThreadsView({ inboxRoot: f.root, log: (step) => void logged.push(step) }).materialize({ now: 0 });
  assert.equal(torn.length, 1);
  assert.equal(torn[0]!.data.state, "unavailable", JSON.stringify(torn[0]!.data));
});
