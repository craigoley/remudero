import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { appendThreadMessage, inboxThreadId, inboxThreadIdentity } from "../src/lib/inbox-thread.js";
import { INBOX_THREAD_VIEW_NAME, createInboxThreadView, inboxThreadStoreFile, inboxThreadViewKey, type InboxThreadViewData } from "../src/lib/inbox-thread-view.js";
import { inboxThreadStorePath } from "../src/lib/panel-graph.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createReadModelTicker, type ReadModelBodyEntry, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createDemandBook } from "../src/lib/view-demand.js";

const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const PROPOSAL = "ruling-w1-t1";
const THREAD = inboxThreadId(PROPOSAL);
const KEY = inboxThreadViewKey(THREAD);
const PAGE_KEY = "section=needsYou";

type TestCtx = { after: (fn: () => void) => void };

function mutableClock(): Clock & { advance(ms: number): void } {
  let at = T0;
  return { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString(), advance: (ms) => void (at += ms) };
}

interface Fixture {
  inboxRoot: string;
  stateDir: string;
  ledgerDir: string;
  clock: ReturnType<typeof mutableClock>;
  messages: ReadModelWorkerMessage[];
  tick(times?: number): void;
}

const PLAIN = { headline: "Ruling needed", whatHappened: "The fleet found a conflict.", whatWeNeed: "Pick one.", ifNothingHappens: "It waits.", options: [], source: "template" };

/** Replaces the persisted `inbox` view's needsYou page: the proposal's lane is what the thread's state is. */
function seedInbox(f: Fixture, lane: string, etag = `etag-${lane}`): void {
  const db = openProjectorReadModel(f.stateDir, "core");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS view_body(view TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL,
      generation INTEGER NOT NULL, etag TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(view, key)) WITHOUT ROWID;`);
    const body = { data: { section: "needsYou", items: [{ proposalId: PROPOSAL, summary: "the raw summary", plain: PLAIN, lane }] }, sources: [{ name: "inbox-store:core", asOf: new Date(T0).toISOString(), state: "fresh" }] };
    db.prepare("INSERT OR REPLACE INTO view_body(view, key, version, generation, etag, body) VALUES('inbox', ?, 1, 1, ?, ?)").run(PAGE_KEY, etag, JSON.stringify(body));
  } finally {
    db.close();
  }
}

function fixture(t: TestCtx, lane = "ready"): Fixture {
  const root = makeTempDir("inbox-thread-view");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inboxRoot = join(root, "inbox");
  const ledgerDir = join(root, "state");
  mkdirSync(join(inboxRoot, "state"), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
  const clock = mutableClock();
  const demand = createDemandBook({ clock });
  const messages: ReadModelWorkerMessage[] = [];
  const instance = { name: "core", ledgerDir };
  const f: Fixture = { inboxRoot, stateDir: join(root, "read-model-state"), ledgerDir, clock, messages, tick: () => {} };
  seedInbox(f, lane);
  const view = createInboxThreadView({ inboxRoot, demand, clock });
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: [instance], clock, holder: "inbox-thread-view", oracle: "off", demand, views: [view], post: (m) => void messages.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  ticker.want(INBOX_THREAD_VIEW_NAME, KEY);
  f.tick = (times = 1) => {
    for (let i = 0; i < times; i++) {
      ticker.tick();
      clock.advance(1_000);
    }
  };
  return f;
}

function bodies(f: Fixture, key = KEY): ReadModelBodyEntry[] {
  return f.messages.flatMap((m) => (m.type === "body" && m.entry.view === INBOX_THREAD_VIEW_NAME && m.entry.key === key ? [m.entry] : []));
}

const dataOf = (entry: ReadModelBodyEntry | undefined): InboxThreadViewData => {
  assert.ok(entry, "a body was posted");
  return entry.body.data as InboxThreadViewData;
};

function write(f: Fixture, role: "escalation" | "reply", body: string, ts: number): void {
  appendThreadMessage(inboxThreadIdentity(PROPOSAL), role, body, { threadStorePath: inboxThreadStoreFile(f.inboxRoot), now: () => ts });
}

test("W1-T5049: a thread reply changes the inbox thread view etag", (t) => {
  const f = fixture(t);
  write(f, "escalation", "Which one should win?", T0 - 5_000);
  f.tick(3);
  const first = bodies(f).at(-1);
  assert.equal(dataOf(first).found, true);
  assert.equal(dataOf(first).thread?.messageCount, 2, "the opening message and the escalation");
  assert.equal(dataOf(first).thread?.waitingOn, "operator");

  write(f, "reply", "The first.", T0 + 1_000);
  f.tick(3);
  const after = bodies(f).at(-1);
  assert.notEqual(after?.etag, first?.etag, "the reply moved the etag");
  assert.equal(dataOf(after).thread?.messageCount, 3);
  assert.equal(dataOf(after).thread?.waitingOn, "daemon");
  assert.equal(dataOf(after).thread?.messages.at(-1)?.text, "The first.");
});

test("W1-T5049: an unchanged thread keeps its etag across worker passes", (t) => {
  const f = fixture(t);
  write(f, "escalation", "Which one should win?", T0 - 5_000);
  f.tick(1);
  const first = bodies(f).at(-1);
  assert.ok(first);
  f.tick(12);
  f.clock.advance(3_600_000);
  f.tick(3);
  assert.equal(bodies(f).length, 1, "no pass posted a second body for an unchanged thread");
  assert.equal(bodies(f).at(-1)?.etag, first.etag);
});

test("W1-T5049: the proposal's classification moves the etag with no new message", (t) => {
  const f = fixture(t, "ready");
  f.tick(2);
  const first = bodies(f).at(-1);
  assert.deepEqual(dataOf(first).thread?.messages[0]?.actions, ["approve", "decline", "edit"]);
  seedInbox(f, "declined");
  f.tick(2);
  const after = bodies(f).at(-1);
  assert.notEqual(after?.etag, first?.etag, "the new lane changed the body");
  assert.deepEqual(dataOf(after).thread?.messages[0]?.actions, ["restore"]);
});

test("W1-T5049: a thread the inbox does not hold, or an id that is no inbox thread, is reported not thrown", (t) => {
  const f = fixture(t);
  const demand = createDemandBook({ clock: f.clock });
  const view = createInboxThreadView({ inboxRoot: f.inboxRoot, demand, clock: f.clock });
  demand.want(INBOX_THREAD_VIEW_NAME, inboxThreadViewKey("thread:nothing::inbox::-::-"));
  demand.want(INBOX_THREAD_VIEW_NAME, inboxThreadViewKey("not-a-thread"));
  const db = openProjectorReadModel(f.stateDir, "core");
  t.after(() => db.close());
  const built = view.materialize({ now: T0, instances: [{ db }] });
  assert.equal(built.length, 2);
  assert.equal(built[0]!.data.found, false);
  assert.match(String(built[0]!.data.reason), /no inbox thread/);
  assert.equal(built[0]!.sources[0]!.state, "fresh");
  assert.equal(built[1]!.data.found, false);
  assert.match(String(built[1]!.data.reason), /not an inbox thread id/);
  assert.equal(built[1]!.sources[0]!.state, "unavailable");
});

test("W1-T5049: an unreadable thread store is reported as an unavailable source, never an empty thread", (t) => {
  const f = fixture(t);
  writeFileSync(inboxThreadStoreFile(f.inboxRoot), "{not json\n");
  f.tick(2);
  const entry = bodies(f).at(-1);
  assert.equal(dataOf(entry).found, false);
  assert.match(String(dataOf(entry).reason), /thread store cannot be read/);
  assert.equal(entry?.body.sources[0]?.state, "unavailable");
});

test("W1-T5049: a key with no store open or no inbox root says why", (t) => {
  const f = fixture(t);
  const demand = createDemandBook({ clock: f.clock });
  demand.want(INBOX_THREAD_VIEW_NAME, KEY);
  const noDb = createInboxThreadView({ inboxRoot: f.inboxRoot, demand, clock: f.clock }).materialize({ now: T0, instances: [{}] });
  assert.match(String(noDb[0]!.data.reason), /not open yet/);
  const noRoot = createInboxThreadView({ demand, clock: f.clock }).materialize({ now: T0, instances: [{}] });
  assert.match(String(noRoot[0]!.data.reason), /no inbox root/);
});

test("W1-T5049: the thread store path matches the one the thread routes read", () => {
  assert.equal(inboxThreadStoreFile("/some/root"), inboxThreadStorePath("/some/root"));
});
