import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  buildEscalationIndexSnapshot, createEscalationConversationIndexReader, ESCALATION_INDEX_MAX_ROWS, ESCALATION_INDEX_MAX_STORE_BYTES,
  type EscalationIndexBoard, type EscalationIndexBoardFlag, type EscalationIndexRead,
} from "#src/lib/escalation-conversation-index.js";
import { appendThreadMessage, type ThreadIdentity } from "#src/lib/inbox-thread.js";

const REPOSITORY = "craigoleyagent/remudero";
const AT = "2026-11-02T12:00:00.000Z";
const REVISION = "b".repeat(64);
const url = (n: number, repo = REPOSITORY) => `https://github.com/${repo}/issues/${n}`;
const identity = (n: number): ThreadIdentity => ({ taskId: `W1-T${n}`, class: "MANUAL", cause: "stage-stall" });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-escalation-index-coverage-"));
  mkdirSync(join(root, "state"));
  const store = join(root, "state", "inbox-threads.jsonl");
  let tick = Date.parse(AT);
  const deps = { threadStorePath: store, now: () => (tick += 1000) };
  let board: EscalationIndexBoard = { state: "ready", flags: [] };
  /** A saved native conversation bound to one issue by an immutable reply receipt. */
  const bound = (n: number, issue = url(n), who: ThreadIdentity = identity(n)) => {
    appendThreadMessage(who, "escalation", `Headline ${n}\n\nDetail ${n}`, deps);
    appendThreadMessage(who, "reply", `Answer ${n}`, deps, { replyId: `reply-${String(n).padStart(8, "0")}`, escalation: { issueUrl: issue, revision: REVISION } });
  };
  const reader = (overrides: Record<string, unknown> = {}) => createEscalationConversationIndexReader({ repository: REPOSITORY,
    threadStorePath: store, readBoard: () => board, clock: fixedClock(Date.parse(AT)), ...overrides });
  const list = (query: { limit?: string; cursor?: string; folder?: string } = {}, overrides: Record<string, unknown> = {}): EscalationIndexRead => {
    const result = reader(overrides)(query);
    assert.equal(result.state, "served", JSON.stringify(result));
    return result as EscalationIndexRead;
  };
  return { root, store, deps, bound, reader, list, setBoard: (b: EscalationIndexBoard) => { board = b; },
    flags: (...n: number[]): EscalationIndexBoardFlag[] => n.map(i => ({ taskId: `W1-T${i}`, issueUrl: url(i), openedAt: AT })) };
}

test("a complete snapshot reports whole folder counts and distinct loaded counts for one page", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  for (let n = 1; n <= 7; n++) f.bound(n);
  f.setBoard({ state: "ready", flags: f.flags(7, 8) });
  const first = f.list({ limit: "3" });
  assert.equal(first.counts.complete, true);
  assert.equal(first.counts.total, 8);
  assert.deepEqual(first.counts.folders, { needs_input: 0, waiting_for_agent: 7, archived: 0, unknown: 1 });
  assert.equal(first.items.length, 3);
  assert.equal(first.counts.loaded.total, 3, "the loaded count names the page, not the mailbox");
  assert.notEqual(first.counts.loaded.total, first.counts.total);
  assert.ok(first.page.nextCursor);
  const seen = new Set(first.items.map(i => i.id));
  let cursor = first.page.nextCursor, pages = 1;
  while (cursor) {
    const next = f.list({ limit: "3", cursor });
    for (const item of next.items) { assert.equal(seen.has(item.id), false, "no row repeats across pages"); seen.add(item.id); }
    assert.equal(next.counts.total, 8);
    cursor = next.page.nextCursor; pages++;
  }
  assert.equal(seen.size, 8);
  assert.equal(pages, 3);
});

test("a folder filter pages that folder while counts stay whole-mailbox", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  for (let n = 1; n <= 4; n++) f.bound(n);
  f.setBoard({ state: "ready", flags: f.flags(9) });
  const read = f.list({ folder: "unknown", limit: "1" });
  assert.equal(read.items.length, 1);
  assert.equal(read.items[0]!.issueUrl, url(9));
  assert.equal(read.counts.folders.waiting_for_agent, 4);
  assert.equal(read.page.nextCursor, null);
  const empty = f.list({ folder: "archived" });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.counts.folders.archived, 0, "a complete snapshot may say a folder is empty");
});

test("a cursor from another snapshot, repository or folder requires a refresh, never a merged page", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  for (let n = 1; n <= 4; n++) f.bound(n);
  const cursor = f.list({ limit: "2" }).page.nextCursor!;
  assert.equal(f.list({ limit: "2", cursor }).items.length, 2);
  f.bound(5);
  const changed = f.reader()({ limit: "2", cursor });
  assert.equal(changed.state, "unavailable");
  assert.equal(changed.state === "unavailable" && changed.reason, "refresh_required");
  const other = createEscalationConversationIndexReader({ repository: "craigoleyagent/other", threadStorePath: f.store, readBoard: () => ({ state: "ready", flags: [] }) });
  assert.equal(other({ cursor }).state === "unavailable" && (other({ cursor }) as { reason: string }).reason, "refresh_required");
  const fresh = f.list({ limit: "2" }).page.nextCursor!;
  const wrongFolder = f.reader()({ limit: "2", cursor: fresh, folder: "archived" });
  assert.equal(wrongFolder.state === "unavailable" && wrongFolder.reason, "refresh_required");
});

test("malformed limits, folders and cursors are invalid requests", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  for (const query of [{ limit: "0" }, { limit: "51" }, { limit: "abc" }, { limit: "-1" }, { folder: "inbox" }, { cursor: "!!!" }, { cursor: "e30" },
    { cursor: Buffer.from(JSON.stringify({ r: 1, s: "x", o: 0, f: null })).toString("base64url") },
    { cursor: Buffer.from(JSON.stringify({ r: "a", s: "x", o: -1, f: null })).toString("base64url") },
    { cursor: "A".repeat(600) }]) {
    const result = f.reader()(query);
    assert.equal(result.state === "unavailable" && result.reason, "invalid_request", JSON.stringify(query));
  }
  assert.equal(f.list({ limit: "50" }).page.limit, 50);
});

test("an unreadable saved discussion store cannot claim an empty mailbox or zero asks", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.setBoard({ state: "ready", flags: f.flags(1) });
  writeFileSync(f.store, "not JSON\n");
  const read = f.list();
  assert.equal(read.coverage.sources.threads, "unavailable");
  assert.equal(read.coverage.state, "partial");
  assert.equal(read.counts.complete, false);
  assert.equal(read.counts.total, null);
  assert.deepEqual(read.counts.folders, { needs_input: null, waiting_for_agent: null, archived: null, unknown: null });
  assert.equal(read.items.length, 1, "the flag stays visible");
  // A JSON null line throws inside the real parser; that is unreadable too.
  writeFileSync(f.store, "null\n");
  assert.equal(f.list().coverage.sources.threads, "unavailable");
});

test("an unconfigured store, a throwing reader and a throwing board are explicit outages", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.bound(1);
  const unconfigured = f.list({}, { threadStorePath: undefined });
  assert.equal(unconfigured.coverage.sources.threads, "unavailable");
  const throwing = f.list({}, { readThreads: () => { throw new Error("boom"); } });
  assert.equal(throwing.coverage.sources.threads, "unavailable");
  const board = f.list({}, { readBoard: () => { throw new Error("boom"); } });
  assert.equal(board.coverage.sources.board, "unavailable");
  assert.equal(board.counts.total, null);
  const both = f.list({}, { readBoard: () => ({ state: "unavailable", reason: "x" }), readThreads: () => ({ status: "unresolved", reason: "x" }) });
  assert.equal(both.coverage.state, "unavailable");
  assert.deepEqual(both.items, []);
  assert.equal(both.counts.total, null, "nothing was read, so no zero is claimed");
  assert.equal(both.counts.folders.needs_input, null);
});

test("an unavailable board leaves saved conversations visible with incomplete counts", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.bound(1);
  f.setBoard({ state: "unavailable", reason: "building" });
  const read = f.list();
  assert.equal(read.items.length, 1);
  assert.equal(read.coverage.sources.board, "unavailable");
  assert.equal(read.counts.complete, false);
  assert.equal(read.counts.total, null);
  assert.equal(read.counts.loaded.total, 1);
});

test("an oversized saved store is refused as an outage instead of being read whole", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  writeFileSync(f.store, "");
  truncateSync(f.store, ESCALATION_INDEX_MAX_STORE_BYTES + 1);
  const read = f.list();
  assert.equal(read.coverage.sources.threads, "unavailable");
  assert.equal(read.counts.complete, false);
});

test("one issue claimed by two threads is a conflict: neither is listed and counts are incomplete", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.bound(1); f.bound(2); f.bound(3, url(2));
  const read = f.list();
  assert.deepEqual(read.items.map(i => i.issueUrl).sort(), [url(1)]);
  assert.ok(read.coverage.conflicts >= 1);
  assert.equal(read.counts.complete, false);
  assert.equal(read.counts.total, null);
  assert.equal(read.coverage.state, "partial");
});

test("a flag whose task contradicts the saved thread is rejected, not silently re-pointed", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.bound(1);
  f.setBoard({ state: "ready", flags: [{ taskId: "W1-T999", issueUrl: url(1), openedAt: AT }] });
  const read = f.list();
  assert.deepEqual(read.items, []);
  assert.ok(read.coverage.conflicts >= 1);
  assert.equal(read.counts.complete, false);
});

test("two flags naming one issue for different tasks conflict while identical duplicates collapse", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.setBoard({ state: "ready", flags: [...f.flags(1, 1), { taskId: "W1-T2", issueUrl: url(5), openedAt: AT }, { taskId: "W1-T3", issueUrl: url(5), openedAt: AT }] });
  const read = f.list();
  assert.deepEqual(read.items.map(i => i.issueUrl), [url(1)]);
  assert.equal(read.counts.complete, false);
});

test("a thread bound to two different issues is a conflict", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.bound(1);
  appendThreadMessage(identity(1), "reply", "again", f.deps, { replyId: "reply-other-001", escalation: { issueUrl: url(77), revision: REVISION } });
  const read = f.list();
  assert.deepEqual(read.items, []);
  assert.equal(read.counts.complete, false);
});

test("a foreign-repository or malformed binding is never listed", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.bound(1, url(1, "craigoleyagent/other"));
  f.bound(2, "https://example.test/issues/2");
  f.setBoard({ state: "ready", flags: [{ taskId: "W1-T3", issueUrl: url(3, "craigoleyagent/other") }, { taskId: "", issueUrl: url(4) },
    { taskId: "W1-T5", issueUrl: 5 as never }] });
  const read = f.list();
  assert.deepEqual(read.items, []);
  assert.equal(read.counts.complete, false);
  assert.equal(read.coverage.conflicts, 5);
});

test("truncated or oversized history stays visible as unknown with incomplete-history coverage", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.bound(1);
  for (let i = 0; i < 100; i++) appendThreadMessage(identity(1), "reply", `more ${i}`, f.deps);
  const read = f.list();
  assert.equal(read.items[0]!.history, "partial");
  assert.deepEqual(read.items[0]!.correspondence, { state: "unknown", reason: "history_incomplete" });
  assert.equal(read.items[0]!.preview, null);
  assert.equal(read.coverage.incompleteHistory, 1);
});

test("a snapshot over the row bound is truncated and reports no whole-mailbox total", () => {
  const flags = Array.from({ length: ESCALATION_INDEX_MAX_ROWS + 1 }, (_, i) => ({ taskId: `W1-T${i + 1}`, issueUrl: url(i + 1) }));
  const snapshot = buildEscalationIndexSnapshot({ repository: REPOSITORY, readBoard: () => ({ state: "ready", flags }),
    readThreads: () => ({ status: "ok", threads: new Map() }), threadStorePath: "/unused" });
  assert.equal(snapshot.rows.length, ESCALATION_INDEX_MAX_ROWS);
  assert.equal(snapshot.coverage.truncated, true);
  assert.equal(snapshot.complete, false);
});

test("saved escalations with no source binding are reported, not listed, and do not void the counts", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  appendThreadMessage(identity(1), "escalation", "Only an original\n\nNo receipt", f.deps);
  appendThreadMessage({ taskId: "p1", class: "inbox" }, "escalation", "A proposal thread", f.deps);
  const read = f.list();
  assert.deepEqual(read.items, []);
  assert.equal(read.coverage.unboundThreads, 1, "proposal threads are another surface and are not counted");
  assert.equal(read.counts.complete, true);
  assert.equal(read.counts.total, 0);
});

test("a missing repository is an unavailable source, never an empty mailbox", () => {
  const result = createEscalationConversationIndexReader({ readBoard: () => ({ state: "ready", flags: [] }) })({});
  assert.equal(result.state, "unavailable");
  assert.equal(result.state === "unavailable" && result.reason, "source_unavailable");
  const snapshot = buildEscalationIndexSnapshot({ readBoard: () => ({ state: "ready", flags: [] }), readThreads: () => ({ status: "ok", threads: new Map() }), threadStorePath: "/x" });
  assert.equal(snapshot.complete, false);
});
