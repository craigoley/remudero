import test from "node:test";
import assert from "node:assert/strict";
import {
  createInboxThreadListView,
  readInboxThreadListView,
  warmInboxThreadListView,
  type ThreadListClassification,
  type ThreadListSources,
  type ThreadStoreRead,
} from "../src/lib/inbox-thread-list-view.js";
import type { InboxThreadItem, ReadMarks } from "../src/lib/inbox-responder.js";
import { inboxThreadId, type ThreadMessage } from "../src/lib/inbox-thread.js";

// A classification is opaque to the view: these tests carry the operator items it would project.
interface Fake {
  items: InboxThreadItem[];
}

function item(proposalId: string, state: InboxThreadItem["state"] = "ready"): InboxThreadItem {
  return { proposalId, summary: `summary of ${proposalId}`, plain: { headline: `Headline ${proposalId}`, whatHappened: "It happened.", whatWeNeed: "Decide.", ifNothingHappens: "Nothing.", options: [], source: "template" }, state };
}

function message(proposalId: string, seq: number, role: ThreadMessage["role"] = "escalation", ts = 1_000 + seq): ThreadMessage {
  return { threadId: inboxThreadId(proposalId), role, body: `message ${seq}.`, seq, ts };
}

interface Rig {
  sources: ThreadListSources<Fake>;
  calls: { classify: number; items: number };
  clock: { now: number };
  store: { read: ThreadStoreRead };
  marks: { value: ReadMarks };
  settle(c: ThreadListClassification<Fake>): void;
  reject(err: Error): void;
  held: { peek?: ThreadListClassification<Fake> };
}

/** Every seam is controllable; `classify` stays blocked until the test settles it. */
function rig(initial: ThreadMessage[] = []): Rig {
  const calls = { classify: 0, items: 0 };
  const clock = { now: 5_000_000 };
  const byThread = new Map<string, ThreadMessage[]>();
  for (const m of initial) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
  const store = { read: { status: "ok", threads: byThread } as ThreadStoreRead };
  const marks = { value: {} as ReadMarks };
  const held: Rig["held"] = {};
  let settledOnce = false;
  let resolveFn: (c: ThreadListClassification<Fake>) => void = () => {};
  let rejectFn: (e: Error) => void = () => {};
  const sources: ThreadListSources<Fake> = {
    now: () => clock.now,
    classify: () => {
      calls.classify += 1;
      if (settledOnce && held.peek) return Promise.resolve(held.peek); // an unchanged input set answers from the memo
      return new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    },
    peek: () => held.peek,
    readThreads: () => store.read,
    readMarks: () => marks.value,
    items: (c) => {
      calls.items += 1;
      return c.items;
    },
    inputsKey: () => "inputs",
  };
  return {
    sources, calls, clock, store, marks, held,
    settle: (c) => { held.peek = c; settledOnce = true; resolveFn(c); },
    reject: (e) => rejectFn(e),
  };
}

const classification = (items: InboxThreadItem[], classifiedAtMs: number, complete = true): ThreadListClassification<Fake> =>
  ({ classified: { items }, classifiedAtMs, complete, ...(complete ? {} : { incompleteReason: "github projection is indeterminate" }) });

test("first thread-list read does not await a blocked classifier", async () => {
  const r = rig([message("p1", 1)]);
  const view = createInboxThreadListView(r.sources, { waitMs: 15 });
  const read = await readInboxThreadListView(view); // returns at all only because it does not wait on the classifier, which is never settled
  assert.equal(read.kind, "unavailable", "with nothing classified yet it says so; it does not invent a list");
  if (read.kind === "unavailable") assert.equal(read.code, "classification_pending");
  assert.equal(r.calls.classify, 1, "the refresh is running in the background");
  // Once the blocked pass lands, the next read serves it.
  r.settle(classification([item("p1")], r.clock.now - 400));
  await new Promise((resolve) => setImmediate(resolve));
  const next = await readInboxThreadListView(view);
  assert.equal(next.kind, "ok");
  if (next.kind === "ok") assert.deepEqual(next.threads.map((t) => t.proposalId), ["p1"]);
});

test("a stale classification is never served as a verified list", async () => {
  const r = rig([message("p1", 1)]);
  r.held.peek = classification([item("p1")], r.clock.now - 90_000);
  const view = createInboxThreadListView(r.sources, { waitMs: 10 });
  const read = await readInboxThreadListView(view); // refresh is blocked: only the old classification exists
  assert.equal(read.kind, "stale");
  if (read.kind === "stale") {
    assert.equal(read.source.state, "stale");
    assert.equal(read.source.ageMs, 90_000, "age is the classification's, not the build's");
    assert.deepEqual(read.threads.map((t) => t.proposalId), ["p1"]);
  }
});

test("incomplete thread-list evidence is not a verified empty inbox", async () => {
  // A classification that could not see every input, and so shows no rows.
  const partial = rig();
  const view = createInboxThreadListView(partial.sources, { waitMs: 200 });
  const pending = readInboxThreadListView(view);
  partial.settle(classification([], partial.clock.now, false));
  const read = await pending;
  assert.equal(read.kind, "unavailable");
  if (read.kind === "unavailable") {
    assert.equal(read.code, "incomplete_evidence");
    assert.match(read.detail, /indeterminate/);
  }

  // An unreadable thread store is unavailable too, never an empty success.
  const torn = rig();
  torn.store.read = { status: "unresolved", reason: "unparseable line" };
  const tornRead = await readInboxThreadListView(createInboxThreadListView(torn.sources, { waitMs: 10 }));
  assert.equal(tornRead.kind, "unavailable");
  if (tornRead.kind === "unavailable") assert.equal(tornRead.code, "thread_store_unreadable");

  // A failed classification with nothing retained is unavailable as well.
  const failed = rig();
  const failView = createInboxThreadListView(failed.sources, { waitMs: 200 });
  const failing = readInboxThreadListView(failView);
  failed.reject(new Error("anchor grep exploded"));
  const failRead = await failing;
  assert.equal(failRead.kind, "unavailable");
  if (failRead.kind === "unavailable") {
    assert.equal(failRead.code, "classification_failed");
    assert.match(failRead.detail, /anchor grep exploded/);
  }

  // Control: the same machinery over a complete, genuinely empty classification IS a verified empty list.
  const empty = rig();
  const emptyView = createInboxThreadListView(empty.sources, { waitMs: 200 });
  const emptyRead = readInboxThreadListView(emptyView);
  empty.settle(classification([], empty.clock.now));
  const verified = await emptyRead;
  assert.equal(verified.kind, "ok");
  if (verified.kind === "ok") assert.deepEqual(verified.threads, []);
});

test("thread-list inputs invalidate the projection", async () => {
  const r = rig([message("p1", 1), message("p2", 1)]);
  const fixed = classification([item("p1"), item("p2")], r.clock.now);
  r.sources.classify = async () => { r.calls.classify += 1; return fixed; };
  const view = createInboxThreadListView(r.sources, { waitMs: 200 });
  const first = await readInboxThreadListView(view);
  assert.equal(first.kind, "ok");
  assert.equal(r.calls.items, 1);

  // Nothing changed: the projection is reused, not rebuilt.
  await readInboxThreadListView(view);
  assert.equal(r.calls.items, 1, "an unchanged input set reuses the projection");

  // A reply on one thread invalidates it, and the new message shows.
  r.store.read = { status: "ok", threads: new Map([
    [inboxThreadId("p1"), [message("p1", 1), message("p1", 2, "reply")]],
    [inboxThreadId("p2"), [message("p2", 1)]],
  ]) };
  const replied = await readInboxThreadListView(view);
  assert.equal(r.calls.items, 2);
  assert.ok(replied.kind === "ok" && replied.threads.find((t) => t.proposalId === "p1")!.messageCount === 3, "the reply is counted");

  // A read cursor invalidates it, and the thread stops being unread.
  const unreadBefore = replied.kind === "ok" ? replied.threads.find((t) => t.proposalId === "p2")!.unread : undefined;
  assert.equal(unreadBefore, true);
  r.marks.value = { [inboxThreadId("p2")]: 1 };
  const read = await readInboxThreadListView(view);
  assert.equal(r.calls.items, 3);
  assert.ok(read.kind === "ok" && read.threads.find((t) => t.proposalId === "p2")!.unread === false, "the mark clears unread");

  // A proposal input change (a new classification) invalidates it.
  const changed = classification([item("p1"), item("p2"), item("p3")], r.clock.now + 10);
  r.sources.classify = async () => changed;
  const grown = await readInboxThreadListView(view);
  assert.equal(r.calls.items, 4);
  assert.ok(grown.kind === "ok" && grown.threads.some((t) => t.proposalId === "p3"));

  // A change in the plain-message store (another input the items read) invalidates it.
  r.sources.inputsKey = () => "inputs-2";
  await readInboxThreadListView(view);
  assert.equal(r.calls.items, 5);
});

test("concurrent thread-list reads retain source age", async () => {
  const r = rig([message("p1", 1)]);
  const view = createInboxThreadListView(r.sources, { waitMs: 500 });
  const classifiedAt = r.clock.now - 7_000;
  const reads = [readInboxThreadListView(view), readInboxThreadListView(view), readInboxThreadListView(view)];
  r.clock.now += 3_000; // time passes while the one shared pass runs
  r.settle(classification([item("p1")], classifiedAt));
  const done = await Promise.all(reads);
  assert.equal(r.calls.classify, 1, "three concurrent reads share one classification pass");
  assert.equal(r.calls.items, 1, "and one projection build");
  for (const read of done) {
    assert.equal(read.kind, "ok");
    if (read.kind !== "ok") continue;
    assert.equal(read.source.classifiedAt, new Date(classifiedAt).toISOString(), "the source time is the classification's, not the build time");
    assert.notEqual(read.source.builtAt, read.source.classifiedAt);
    assert.equal(read.source.ageMs, 10_000, "age is measured from the source, at read time");
    assert.equal(read.source.completeness, "complete");
  }
  // A later read keeps the same source time while its age grows.
  r.sources.classify = async () => { r.calls.classify += 1; return classification([item("p1")], classifiedAt); };
  r.clock.now += 5_000;
  const later = await readInboxThreadListView(view);
  assert.ok(later.kind === "ok" && later.source.classifiedAt === new Date(classifiedAt).toISOString() && later.source.ageMs === 15_000);
});

test("a failed refresh does not cache its failure", async () => {
  const r = rig([message("p1", 1)]);
  const view = createInboxThreadListView(r.sources, { waitMs: 100 });
  const first = readInboxThreadListView(view);
  r.reject(new Error("boom"));
  assert.equal((await first).kind, "unavailable");
  const second = readInboxThreadListView(view);
  assert.equal(r.calls.classify, 2, "the next read starts a fresh attempt");
  r.settle(classification([item("p1")], r.clock.now));
  assert.equal((await second).kind, "ok");
});

test("warming a thread-list view with no request lands its classification, so the next read is fresh", async () => {
  const r = rig([message("p1", 1)]);
  const view = createInboxThreadListView(r.sources, { waitMs: 10 });
  const warming = warmInboxThreadListView(view);
  assert.equal(r.calls.classify, 1, "the warm starts the shared refresh");
  r.settle(classification([item("p1")], r.clock.now));
  await warming;
  const read = await readInboxThreadListView(view);
  assert.equal(read.kind, "ok", "a warmed view answers fresh");
  if (read.kind === "ok") assert.deepEqual(read.threads.map((t) => t.proposalId), ["p1"]);
});
