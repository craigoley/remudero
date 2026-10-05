import test from "node:test";
import assert from "node:assert/strict";
import {
  createInboxThreadListView,
  readInboxThreadListView,
  warmInboxThreadListView,
  type ThreadListClassification,
  type ThreadListRefreshSettled,
  type ThreadListSources,
  type ThreadStoreRead,
} from "../src/lib/inbox-thread-list-view.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixedClock } from "../src/lib/clock.js";
import { writeClassificationSnapshot } from "../src/lib/fleet-lane.js";
import { inboxLegacyView } from "../src/lib/inbox-view.js";
import * as panelGraph from "../src/lib/panel-graph.js";
import type { PanelGraphDeps } from "../src/lib/panel-graph.js";
import { loadPlan } from "../src/lib/plan.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";
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

// ── W1-T5886: the thread list across serve generations ─────────────────────────────────────────────────
// MEASURED 2026-10-05 on the fleet host: serve forked a generation on every main merge (15 between 12:40Z and
// 15:59Z, some 2-4 min apart); each starts with an empty main-thread memo, and a cold main-thread pass took up
// to ~6.5 min. The thread list answered `classification_pending` all that time, while the slow lane wrote a
// fresh classification to state/inbox-classified.json every few minutes, and a pass that failed after the
// read's 1.5 s wait left no trace at all.

test("a late classification failure is reported", async () => {
  const r = rig([message("p1", 1)]);
  const reports: ThreadListRefreshSettled[] = [];
  r.sources.report = (settled) => reports.push(settled);
  const view = createInboxThreadListView(r.sources, { waitMs: 10 });
  const first = await readInboxThreadListView(view);
  assert.ok(first.kind === "unavailable" && first.code === "classification_pending", "the read stopped waiting before the pass ended");
  r.clock.now += 4_000;
  r.reject(new Error("anchor grep exceeded its bound"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reports, [{ outcome: "failed", ms: 4_000, error: "anchor grep exceeded its bound" }], "the failure no read was waiting for is named, with how long the pass ran");
  // The next read joins a retry that also outruns its wait: it says the last pass failed, never just "pending".
  const second = await readInboxThreadListView(view);
  assert.equal(r.calls.classify, 2, "the failure was not cached: a retry is running");
  assert.ok(second.kind === "unavailable" && second.code === "classification_failed", `got ${JSON.stringify(second)}`);
  if (second.kind === "unavailable") assert.match(second.detail, /anchor grep exceeded its bound/);
  r.settle(classification([item("p1")], r.clock.now));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports.at(-1)?.outcome, "landed", "a pass that lands is reported too");
  const third = await readInboxThreadListView(view);
  assert.equal(third.kind, "ok", "a landed retry clears the failure");
});

const SLOW_LANE_AT = Date.parse("2026-10-05T15:57:21.212Z");

/** A cold serve generation's inbox: two operator proposals, and the snapshot the slow lane wrote over them. */
function slowLaneWorld(t: { after: (fn: () => void) => void }): PanelGraphDeps {
  const dir = makeTempDir("rmd-thread-list-slow-lane");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "state"), { recursive: true });
  mkdirSync(join(dir, "plan"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(dir, "state", "ledger.ndjson"), "");
  const proposals = [{ id: "ruling:p0", summary: "first operator ask", evidenceAnchors: [] }, { id: "ruling:p1", summary: "second operator ask", evidenceAnchors: [] }];
  writeFileSync(join(dir, "state", "inbox-proposals.json"), JSON.stringify({ proposals }));
  writeClassificationSnapshot(join(dir, "state"), [{ proposalId: "ruling:p0", state: "not_ready" }, { proposalId: "ruling:p1", state: "ready" }], fixedClock(SLOW_LANE_AT), { complete: true });
  return {
    root: dir, inboxRoot: dir, planPath: join(dir, "plan", "tasks.yaml"), ledgerPath: join(dir, "state", "ledger.ndjson"),
    github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40), inboxGrepAnchor: () => true,
  };
}

/** The real panel-graph seams over `deps`, with this generation's own pass still running. */
function coldGenerationSources(deps: PanelGraphDeps): ThreadListSources<unknown> {
  const real = (panelGraph as Record<string, unknown>).inboxThreadListSources as ((d: PanelGraphDeps) => ThreadListSources<unknown>) | undefined;
  assert.equal(typeof real, "function", "panel-graph exposes the thread list's seams");
  return { ...real!(deps), classify: () => new Promise(() => {}) };
}

test("a cold main memo answers from the slow lane classification", async (t) => {
  const deps = slowLaneWorld(t);
  const view = createInboxThreadListView(coldGenerationSources(deps), { waitMs: 10 });
  const read = await readInboxThreadListView(view);
  assert.equal(read.kind, "stale", `a held slow-lane classification is served qualified, never classification_pending: ${JSON.stringify(read)}`);
  if (read.kind !== "stale") return;
  assert.deepEqual(read.threads.map((thread) => thread.proposalId).sort(), ["ruling:p0", "ruling:p1"]);
  assert.equal(read.source.state, "stale", "rows this serve did not verify are never labelled fresh");
  assert.equal(read.source.completeness, "complete", "the slow lane recorded that its pass saw every input");
});

test("slow lane classification keeps its own classifiedAt", async (t) => {
  const deps = slowLaneWorld(t);
  const view = createInboxThreadListView(coldGenerationSources(deps), { waitMs: 10 });
  const before = Date.now();
  const read = await readInboxThreadListView(view);
  assert.ok(read.kind === "stale", `got ${JSON.stringify(read)}`);
  assert.equal(read.source.classifiedAt, new Date(SLOW_LANE_AT).toISOString(), "the slow lane's write time, never when this serve read it");
  assert.ok(read.source.ageMs >= before - SLOW_LANE_AT, "the age runs from the slow lane's classification");
  // A snapshot whose writer did not record completeness is not claimed complete.
  const snapshotPath = join(deps.inboxRoot, "state", "inbox-classified.json");
  const raw = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  delete raw.complete;
  writeFileSync(snapshotPath, `${JSON.stringify({ ...raw, generatedAt: new Date(SLOW_LANE_AT + 1_000).toISOString() })}\n`);
  const unrecorded = await readInboxThreadListView(view);
  assert.ok(unrecorded.kind === "stale" && unrecorded.source.completeness === "partial", `got ${JSON.stringify(unrecorded)}`);
  assert.equal(unrecorded.source.classifiedAt, new Date(SLOW_LANE_AT + 1_000).toISOString(), "a rewritten snapshot is re-read");
});

test("the inbox view's legacy side reads the classification the panel routes hold", async (t) => {
  const base = slowLaneWorld(t);
  const plan = loadPlan(base.planPath);
  const deps: PanelGraphDeps = { ...base, readPlanSnapshot: () => plan };
  const legacy = inboxLegacyView(deps);
  assert.ok("error" in legacy.compute(new URLSearchParams({ section: "needsYou" })), "nothing is classified yet");
  const route = panelGraph.buildPanelGraphRoutes(deps, deps.readPlanSnapshot).find((r) => r.path === "/v1/inbox/threads" && r.method === "GET");
  assert.ok(route);
  const sent: { status?: number; body?: string } = {};
  const res = { setHeader: () => undefined, writeHead: (status: number) => { sent.status = status; }, end: (body: string) => { sent.body = body; } };
  await route.handler({ url: "/v1/inbox/threads" } as never, res as never, {} as never);
  assert.equal(sent.status, 200, `the small inbox classifies inside the read's wait: ${sent.body}`);
  const answered = legacy.compute(new URLSearchParams({ section: "needsYou" }));
  assert.ok(!("error" in answered), `the legacy side sees what the routes classified: ${JSON.stringify(answered)}`);
});

test("the panel thread list logs a failed pass and claims no slow-lane rows without a snapshot", async (t) => {
  const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const deps: PanelGraphDeps = { ...slowLaneWorld(t), logProjection: (step, extra) => logged.push({ step, extra }) };
  const stateDir = join(deps.inboxRoot, "state");
  rmSync(join(stateDir, "inbox-classified.json"));
  const sources = { ...coldGenerationSources(deps), classify: () => Promise.reject(new Error("plan pin unreadable")) };
  const view = createInboxThreadListView(sources, { waitMs: 50 });
  const read = await readInboxThreadListView(view);
  assert.ok(read.kind === "unavailable" && read.code === "classification_failed", `no snapshot is no evidence: ${JSON.stringify(read)}`);
  assert.deepEqual(logged.map((row) => [row.step, row.extra.error]), [["inbox.thread_list_classification_failed", "plan pin unreadable"]]);
  writeClassificationSnapshot(stateDir, [{ proposalId: "ruling:p0", state: "not_ready" }], fixedClock(SLOW_LANE_AT), { complete: false, incompleteReason: "the GitHub projection is indeterminate" });
  const partial = await readInboxThreadListView(view);
  assert.ok(partial.kind === "stale" && partial.source.completeness === "partial", `got ${JSON.stringify(partial)}`);
  assert.deepEqual(partial.threads.map((thread) => thread.proposalId), ["ruling:p0"], "a proposal the slow lane did not classify is not shown");
  writeFileSync(join(stateDir, "inbox-classified.json"), `${JSON.stringify({ generatedAt: new Date(SLOW_LANE_AT + 5).toISOString(), complete: false, states: { "ruling:p1": "ready" } })}\n`);
  const unnamed = await readInboxThreadListView(view);
  assert.ok(unnamed.kind === "stale" && unnamed.source.completeness === "partial" && unnamed.threads[0]?.proposalId === "ruling:p1", `got ${JSON.stringify(unnamed)}`);
});
