// Arch Phase 4, P4-T08 (design §1.2): `needs-you` is a view of views. Serve's main thread recomposes it
// from the `now` bodies and the inbox's needsYou page it already holds, so /needs-you is one read with
// no store read of its own; an input it does not hold reads absent with a reason, never zero.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { NEEDS_YOU_VIEW_NAME, withNeedsYouView, type NeedsYouData } from "../src/lib/needs-you-view.js";
import type { NowDecision } from "../src/lib/now-decisions.js";
import type { NowAction } from "../src/lib/now-view.js";
import type { ReadModelInstanceState, ReadModelSwitches, ReadModelWorkerHandle } from "../src/lib/read-model-worker.js";
import { createService } from "../src/lib/service.js";
import { buildReadModelViewRoutes, viewEtag, type ViewBodyEntry, type ViewSource } from "../src/lib/views.js";

type TestCtx = { after: (fn: () => void) => void };
const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const clock: Clock = { now: () => T0, date: () => new Date(T0), iso: () => new Date(T0).toISOString() };
const at = (minutesAgo: number): string => new Date(T0 - minutesAgo * 60_000).toISOString();

function entry(view: string, key: string, version: number, data: unknown, sources: ViewSource[]): ViewBodyEntry {
  return { view, key, version, generation: 1, etag: viewEtag(view, version, false, data), body: { view, version, generatedAt: at(0), asOf: null, stale: false, sources, data } };
}

function decision(instance: string, id: string, askedAt?: string): NowDecision {
  return { id, kind: "task_question", instance, title: id, prompt: "p", ...(askedAt ? { askedAt } : {}), answer: { method: "POST", path: "/v1/questions/answer", tier: "low", fields: {}, input: "text" } };
}

const ACTION: NowAction = { kind: "blocked_pr", prNumber: 7, disposition: "blocked-fixable", reason: "fix strikes 1/2", tone: "blocked" };

function now(instance: string, decisions: NowDecision[], extra: Record<string, unknown> = {}, version = 3): ViewBodyEntry {
  return entry("now", `instance=${instance}`, version, { instance, actions: [ACTION], decisions, ...extra }, [
    { name: `ledger:${instance}`, asOf: at(1), state: "fresh" }, { name: "github:core", asOf: at(1), state: "fresh" },
  ]);
}

function inboxPage(key: string, ids: string[]): ViewBodyEntry {
  const data = { section: "needsYou", items: ids.map((proposalId) => ({ proposalId, lane: "ready" })), counts: { ready: ids.length }, page: { index: 0, of: 1, total: ids.length } };
  return entry("inbox", key, 1, data, [{ name: "inbox-store:core", asOf: at(2), state: "fresh" }]);
}

/** A read-model handle a test steers: `post` is what the worker handle does on a `body` message. */
function fakeHandle(known: string[], views: ReadModelSwitches["views"] = {}) {
  const bodies = new Map<string, ViewBodyEntry>();
  const listeners = new Set<(e: ViewBodyEntry) => void>();
  const instances = new Map(known.map((instance): [string, ReadModelInstanceState] => [instance, { instance, generation: 1, lease: "held", failures: 0, newestTs: null }]));
  const handle: ReadModelWorkerHandle = {
    bodies,
    state: () => ({ instances, switches: { projector: "on", views } }),
    body: (view, key = "") => bodies.get(`${view}\u0000${key}`),
    judge: (sources) => [...sources],
    switches: () => ({ projector: "on", views }),
    start: () => {},
    stop: () => true,
    reload: () => 0,
    shadow: () => {},
    driveShadow: () => {},
    onBody: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const post = (e: ViewBodyEntry): void => {
    bodies.set(`${e.view}\u0000${e.key}`, e);
    for (const l of listeners) l(e);
  };
  return { handle, post };
}

const dataOf = (handle: ReadModelWorkerHandle): NeedsYouData => handle.body(NEEDS_YOU_VIEW_NAME)!.body.data as NeedsYouData;

test("the needs you view recomposes when one instance now body changes", () => {
  const { handle, post } = fakeHandle(["core", "wild"]);
  const view = withNeedsYouView(handle, clock);
  const pushed: ViewBodyEntry[] = [];
  view.onBody((e) => void pushed.push(e));
  post(now("core", [decision("core", "question:W1-T1:a", at(30))]));
  post(now("wild", [decision("wild", "question:W1-T2:b", at(20))]));
  post(inboxPage("section=needsYou", ["ruling:a"]));
  const before = view.body(NEEDS_YOU_VIEW_NAME)!;
  assert.deepEqual((before.body.data as NeedsYouData).decisions.map((d) => d.id), ["question:W1-T2:b", "question:W1-T1:a"], "merged across instances, newest first");

  pushed.length = 0;
  post(now("wild", [decision("wild", "question:W1-T2:b", at(20)), decision("wild", "question:W1-T3:c", at(5)), decision("wild", "question:W1-T4:d")]));
  const after = view.body(NEEDS_YOU_VIEW_NAME)!;
  assert.notEqual(after.etag, before.etag, "one instance's new decision moves the composite's ETag");
  assert.deepEqual((after.body.data as NeedsYouData).decisions.map((d) => d.id), ["question:W1-T3:c", "question:W1-T2:b", "question:W1-T1:a", "question:W1-T4:d"]);
  assert.deepEqual(pushed.map((e) => e.view), ["now", NEEDS_YOU_VIEW_NAME], "the input passes through, then the recomposed body is pushed");
  assert.equal(pushed[1], after, "the pushed body is the one a read answers");
  assert.deepEqual((after.body.data as NeedsYouData).instances.map((i) => [i.instance, i.counts]), [
    ["core", { decisions: 1, decisionsMore: 0, actions: 1 }], ["wild", { decisions: 3, decisionsMore: 0, actions: 1 }],
  ]);

  pushed.length = 0;
  post(now("wild", [decision("wild", "question:W1-T2:b", at(20)), decision("wild", "question:W1-T3:c", at(5)), decision("wild", "question:W1-T4:d")]));
  post(entry("repositories", "", 2, { unrelated: true }, []));
  assert.deepEqual(pushed.map((e) => e.view), ["now", "repositories"], "an unchanged input and a non-input push no composite");
  assert.equal(view.body(NEEDS_YOU_VIEW_NAME), after, "an unchanged composite keeps its entry");
  assert.equal(view.body("repositories")?.view, "repositories", "every other body still reads through");
  assert.equal(view.bodies.get(`${NEEDS_YOU_VIEW_NAME}\u0000`), after, "the composite is in the bodies the events stream walks");
  assert.equal(view.bodies.size, handle.bodies.size + 1);
});

test("a needs you input with no body reads absent with a reason never zero", () => {
  const { handle, post } = fakeHandle(["core", "wild"]);
  const view = withNeedsYouView(handle, clock);
  post(now("core", [decision("core", "grill:fb-1", at(3))], { decisionsMore: 4, decisionsReasons: { task_question: "unreadable" } }));
  const composed = view.body(NEEDS_YOU_VIEW_NAME)!;
  const data = composed.body.data as NeedsYouData;
  assert.deepEqual(data.instances, [
    { instance: "core", counts: { decisions: 1, decisionsMore: 4, actions: 1 }, actions: [ACTION], decisionsReasons: { task_question: "unreadable" } },
    { instance: "wild", reason: "no now body for this instance yet" },
  ], "the instance with no now body carries a reason and no counts");
  assert.equal(data.inbox, undefined);
  assert.equal(data.reasons?.inbox, "no inbox needsYou page yet");
  const unavailable = composed.body.sources.filter((s) => s.state === "unavailable").map((s) => [s.name, s.reason]);
  assert.deepEqual(unavailable, [["read-model:inbox@core", "no inbox needsYou page yet"], ["read-model:now@wild", "no now body for this instance yet"]]);
  assert.equal(composed.body.stale, true, "a missing input makes the composite stale");

  const empty = withNeedsYouView(fakeHandle([]).handle, clock);
  assert.deepEqual(dataOf(empty).reasons, { instances: "the read model has reported no instance yet", inbox: "no inbox needsYou page yet" });
});

test("a needs you now body of an older version reads absent with its version named", () => {
  const { handle, post } = fakeHandle(["core"]);
  post(now("core", [], { questions: { count: 2 } }, 2));
  post(inboxPage("section=needsYou", []));
  const data = dataOf(withNeedsYouView(handle, clock));
  assert.deepEqual(data.instances, [{ instance: "core", reason: "its now body is version 2; this view reads 3" }]);
  assert.deepEqual(data.decisions, []);
});

test("the needs you view carries the inbox needsYou first page and the union of its sources", () => {
  const { handle, post } = fakeHandle(["core"]);
  const view = withNeedsYouView(handle, clock);
  post(now("core", []));
  post(inboxPage("section=needsYou", ["ruling:a", "ruling:b"]));
  post(inboxPage("cursor=2&section=needsYou", ["ruling:c"]));
  post(inboxPage("section=ready", ["ruling:d"]));
  const composed = view.body(NEEDS_YOU_VIEW_NAME)!;
  const data = composed.body.data as NeedsYouData;
  assert.deepEqual(data.inbox?.items.map((i) => i.proposalId), ["ruling:a", "ruling:b"], "only the needsYou first page");
  assert.equal(data.reasons, undefined);
  assert.deepEqual(composed.body.sources.map((s) => s.name), ["github:core", "inbox-store:core", "ledger:core"], "each input source once, by name");
  assert.equal(composed.body.asOf, at(2), "the oldest input's as-of");
  assert.equal(composed.body.stale, false);
});

test("the needs you route answers view_disabled while dark and the composite under serve", async (t) => {
  const views: ReadModelSwitches["views"] = {};
  const { handle, post } = fakeHandle(["core"], views);
  const view = withNeedsYouView(handle, clock);
  post(now("core", [decision("core", "grill:fb-1", at(3))]));
  const server = createService({ tokens: { read: "r", write: "w" }, routes: buildReadModelViewRoutes({ legacy: [], readModel: view, readModelViews: [NEEDS_YOU_VIEW_NAME], clock }) });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const read = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/needs-you`, { headers: { authorization: "Bearer r" } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  assert.deepEqual(await read(), { status: 404, body: { error: "view_disabled", view: NEEDS_YOU_VIEW_NAME } });
  views[NEEDS_YOU_VIEW_NAME] = "serve";
  const served = await read();
  assert.equal(served.status, 200);
  assert.deepEqual((served.body.data as NeedsYouData).decisions.map((d) => d.id), ["grill:fb-1"]);
});
