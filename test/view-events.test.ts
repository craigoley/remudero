// P2-01: the view-event publisher behind GET /v1/views/events (arch Phase 2 design D1-D4). Each test
// drives a fake read-model handle (bodies, judge, switches, onBody) through the real HTTP service, so
// the auth, the headers and the SSE framing are the ones a console sees.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { createService } from "../src/lib/service.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readReadModelSwitches } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createViewEvents, VIEW_EVENTS_PATH, VIEW_VERSIONS_PATH, type ViewEventsOptions } from "../src/lib/view-events.js";
import { viewEtag, type ViewBodyEntry, type ViewSource } from "../src/lib/views.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const READ = { authorization: "Bearer r" };
type TestCtx = { after: (fn: () => void | Promise<void>) => void };

function entry(view: string, key: string, data: unknown): ViewBodyEntry {
  const sources: ViewSource[] = [{ name: "ledger:core", asOf: new Date(T0).toISOString(), state: "fresh" }];
  return { view, key, version: 1, generation: 1, etag: viewEtag(view, 1, false, data), body: { view, version: 1, generatedAt: new Date(T0).toISOString(), asOf: null, stale: false, sources, data } };
}

/** A read-model handle a test steers: its bodies, whether the projector reads stalled, and the switches. */
function fakeReadModel(views: Record<string, "serve" | "shadow" | "off">) {
  const bodies = new Map<string, ViewBodyEntry>();
  const listeners = new Set<(e: ViewBodyEntry) => void>();
  const state = { stalled: false, push: "on" as "on" | "off" | undefined };
  return {
    state,
    bodies,
    listeners,
    judge: (sources: readonly ViewSource[]) => sources.map((s) => (state.stalled ? { ...s, state: "stale" as const, reason: "projector stalled" } : s)),
    switches: () => ({ projector: "on" as const, views, ...(state.push ? { push: state.push } : {}) }),
    onBody: (listener: (e: ViewBodyEntry) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** What the worker handle does on a `body` message: store it, then tell the listeners. */
    post(e: ViewBodyEntry): void {
      bodies.set(`${e.view}\u0000${e.key}`, e);
      for (const l of listeners) l(e);
    },
  };
}

function timers() {
  const runs = new Map<number, () => void>();
  return {
    every: (run: () => void, ms: number) => (runs.set(ms, run), () => void runs.delete(ms)),
    fire: (ms: number) => runs.get(ms)?.(),
    runs,
  };
}

const clock: Clock = { now: () => T0, date: () => new Date(T0), iso: () => new Date(T0).toISOString() };

async function serve(t: TestCtx, opts: ViewEventsOptions): Promise<{ url: string; events: ReturnType<typeof createViewEvents> }> {
  const events = createViewEvents(opts);
  const server: Server = createService({ tokens: { read: "r", write: "w" }, routes: events.routes });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, events };
}

interface Frame { event: string; id?: string; data: Record<string, unknown> }

/** An open stream whose frames the test awaits one predicate at a time. */
async function open(t: TestCtx, url: string, headers: Record<string, string> = READ) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  t.after(() => controller.abort());
  const frames: Frame[] = [];
  const raw: string[] = [];
  let buffer = "";
  const waiters: Array<() => void> = [];
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          raw.push(block);
          const fields = Object.fromEntries(block.split("\n").filter((l) => !l.startsWith(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
          if (fields.event) frames.push({ event: fields.event, ...(fields.id ? { id: fields.id } : {}), data: JSON.parse(fields.data ?? "{}") });
          for (const w of waiters.splice(0)) w();
        }
      }
    } catch {
      // The test aborted the stream; nothing more will arrive.
    }
    for (const w of waiters.splice(0)) w();
  })();
  const next = async (pred: (f: Frame) => boolean, ms = 2_000): Promise<Frame> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = frames.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no matching frame in ${JSON.stringify(frames)}`);
      await new Promise<void>((done) => {
        waiters.push(done);
        setTimeout(done, 20);
      });
    }
  };
  return { res, frames, raw, next };
}

test("a new subscriber receives a hello event carrying every served view key and its etag", async (t) => {
  const rm = fakeReadModel({ "nav-badge": "serve", now: "serve", repositories: "off" });
  const nav = entry("nav-badge", "", { n: 1 });
  const core = entry("now", "instance=core", { a: 1 });
  const site = entry("now", "instance=site", { a: 2 });
  for (const e of [nav, core, site, entry("repositories", "", { r: 1 })]) rm.bodies.set(`${e.view}\u0000${e.key}`, e);
  const { url } = await serve(t, { names: ["nav-badge", "now", "repositories", "read-model"], servedByDefault: ["read-model"], readModel: rm, clock, bootId: "boot1", every: timers().every });
  const stream = await open(t, `${url}${VIEW_EVENTS_PATH}`);
  assert.equal(stream.res.status, 200);
  assert.equal(stream.res.headers.get("content-type"), "text/event-stream");
  assert.equal(stream.res.headers.get("cache-control"), "no-cache, no-transform");
  const hello = await stream.next((f) => f.event === "hello");
  assert.deepEqual(hello.data, {
    bootId: "boot1",
    serverNow: new Date(T0).toISOString(),
    views: { "nav-badge": { "": nav.etag }, now: { "instance=core": core.etag, "instance=site": site.etag } },
    disabled: ["repositories"],
  });
  assert.equal(stream.raw[0], "retry: 3000", "the reconnect delay precedes the hello");
});

test("the events stream needs the read token and a read model", async (t) => {
  const { url } = await serve(t, { names: ["now"], readModel: fakeReadModel({ now: "serve" }), every: timers().every });
  assert.equal((await fetch(`${url}${VIEW_EVENTS_PATH}`)).status, 401);
  const absent = await serve(t, { names: ["now"] });
  const res = await fetch(`${absent.url}${VIEW_EVENTS_PATH}`, { headers: READ });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "read_model_absent" });
});

test("a body posted by the read-model worker emits a view event with cause body", async (t) => {
  const rm = fakeReadModel({ now: "serve", repositories: "shadow" });
  rm.post(entry("now", "instance=core", { a: 1 }));
  const { url } = await serve(t, { names: ["now", "repositories"], readModel: rm, clock, bootId: "b", every: timers().every });
  const stream = await open(t, `${url}${VIEW_EVENTS_PATH}`);
  await stream.next((f) => f.event === "hello");
  rm.post(entry("repositories", "", { r: 2 }));
  const changed = entry("now", "instance=core", { a: 2 });
  rm.post(changed);
  const event = await stream.next((f) => f.event === "view");
  const { body, ...wire } = event.data;
  assert.deepEqual(wire, { view: "now", key: "instance=core", etag: changed.etag, stale: false, emittedAt: new Date(T0).toISOString(), asOf: new Date(T0).toISOString(), cause: "body" });
  assert.deepEqual(body, { ...changed.body, asOf: new Date(T0).toISOString() }, "a small body rides in its event");
  assert.equal(event.id, "b:1");
  assert.equal(stream.frames.filter((f) => f.event === "view").length, 1, "a view switched shadow emits nothing");
});

test("an unchanged body posted again emits nothing", async (t) => {
  const rm = fakeReadModel({ now: "serve" });
  rm.post(entry("now", "instance=core", { a: 1 }));
  const { url } = await serve(t, { names: ["now"], readModel: rm, clock, every: timers().every });
  const stream = await open(t, `${url}${VIEW_EVENTS_PATH}`);
  await stream.next((f) => f.event === "hello");
  rm.post(entry("now", "instance=core", { a: 1 }));
  rm.post(entry("now", "instance=console", { a: 1 }));
  const event = await stream.next((f) => f.event === "view");
  assert.equal(event.data.key, "instance=console", "only the new key emitted");
  assert.equal(stream.frames.filter((f) => f.event === "view").length, 1);
});

test("a stalled projector flips a served view's etag and emits a view event with cause judge", async (t) => {
  const rm = fakeReadModel({ now: "serve" });
  const body = entry("now", "instance=core", { a: 1 });
  rm.post(body);
  const clockTimers = timers();
  const { url } = await serve(t, { names: ["now"], readModel: rm, clock, every: clockTimers.every });
  const stream = await open(t, `${url}${VIEW_EVENTS_PATH}`);
  await stream.next((f) => f.event === "hello");
  clockTimers.fire(1_000);
  rm.state.stalled = true;
  clockTimers.fire(1_000);
  const event = await stream.next((f) => f.event === "view");
  assert.equal(event.data.cause, "judge");
  assert.equal(event.data.stale, true);
  assert.equal(event.data.etag, viewEtag("now", 1, true, { a: 1 }), "the etag a GET re-judges to");
  clockTimers.fire(1_000);
  clockTimers.fire(25_000);
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(stream.frames.filter((f) => f.event === "view").length, 1, "a flip emits once");
  assert.ok(stream.raw.includes(": hb"), "the heartbeat is a comment");
});

test("the views filter narrows the hello and the events", async (t) => {
  const rm = fakeReadModel({ now: "serve", "nav-badge": "serve", repositories: "off" });
  rm.post(entry("now", "instance=core", { a: 1 }));
  rm.post(entry("nav-badge", "", { n: 1 }));
  const { url } = await serve(t, { names: ["now", "nav-badge", "repositories"], readModel: rm, clock, every: timers().every });
  const stream = await open(t, `${url}${VIEW_EVENTS_PATH}?views=nav-badge`, { ...READ, "last-event-id": "old:4" });
  const hello = await stream.next((f) => f.event === "hello");
  assert.deepEqual(Object.keys(hello.data.views as object), ["nav-badge"]);
  assert.deepEqual(hello.data.disabled, []);
  rm.post(entry("now", "instance=core", { a: 9 }));
  rm.post(entry("nav-badge", "", { n: 2 }));
  const event = await stream.next((f) => f.event === "view");
  assert.equal(event.data.view, "nav-badge");
  assert.equal(stream.frames.filter((f) => f.event === "view").length, 1);
});

/** A socket the test backs up: `writableLength` is whatever the test says. */
function fakeSocket() {
  const req = new EventEmitter() as IncomingMessage;
  Object.assign(req, { url: VIEW_EVENTS_PATH, headers: {} });
  const res = new EventEmitter() as ServerResponse & { written: string[]; backlog: number };
  const written: string[] = [];
  Object.assign(res, {
    written,
    backlog: 0,
    writableEnded: false,
    writeHead: () => res,
    write: (text: string) => (written.push(text), true),
    end: (text?: string) => {
      if (text) written.push(text);
      Object.assign(res, { writableEnded: true });
      return res;
    },
  });
  Object.defineProperty(res, "writableLength", { get: () => res.backlog });
  return { req, res, written };
}

test("a backed-up subscriber holds only the latest event per view key", async () => {
  const rm = fakeReadModel({ now: "serve" });
  let now = T0;
  const steppedClock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const clockTimers = timers();
  const events = createViewEvents({ names: ["now"], readModel: rm, clock: steppedClock, every: clockTimers.every, highWaterBytes: 1_000, stallMs: 60_000 });
  const { req, res, written } = fakeSocket();
  await events.routes[0]!.handler(req, res, { params: {} });
  assert.equal(events.subscribers(), 1);
  res.backlog = 5_000;
  const before = written.length;
  for (let i = 0; i < 200; i++) rm.post(entry("now", "instance=core", { a: i }));
  rm.post(entry("now", "instance=site", { a: 1 }));
  clockTimers.fire(25_000);
  assert.equal(written.length, before, "nothing is written while the socket is backed up");
  res.backlog = 0;
  res.emit("drain");
  const flushed = written.slice(before).map((text) => JSON.parse(text.split("data: ")[1]!) as { key: string; etag: string });
  assert.deepEqual(flushed.map((e) => e.key), ["instance=core", "instance=site"], "one pending event per key");
  assert.equal(flushed[0]!.etag, viewEtag("now", 1, false, { a: 199 }), "the pending event is the latest");

  res.backlog = 5_000;
  rm.post(entry("now", "instance=core", { a: 500 }));
  now += 60_001;
  clockTimers.fire(1_000);
  assert.equal(events.subscribers(), 0, "a subscriber backed up past the stall bound is ended");
  assert.match(written.at(-1)!, /event: handover\ndata: \{"reason":"slow_consumer","retryMs":0\}/);
  assert.equal(clockTimers.runs.size, 0, "no timer outlives the last subscriber");
});

test("a handover ends every stream and a closed client stops the timers", async () => {
  const rm = fakeReadModel({ now: "serve" });
  const clockTimers = timers();
  const events = createViewEvents({ names: ["now"], readModel: rm, clock, every: clockTimers.every });
  const a = fakeSocket();
  const b = fakeSocket();
  await events.routes[0]!.handler(a.req, a.res, { params: {} });
  await events.routes[0]!.handler(b.req, b.res, { params: {} });
  b.req.emit("close");
  assert.equal(events.subscribers(), 1);
  assert.equal(rm.listeners.size, 1, "the worker listener stays while one subscriber remains");
  events.handover("recycle");
  assert.equal(events.subscribers(), 0);
  assert.equal(rm.listeners.size, 0, "the worker listener is dropped with the last subscriber");
  assert.equal(clockTimers.runs.size, 0);
  assert.match(a.written.at(-1)!, /event: handover\ndata: \{"reason":"recycle","retryMs":0\}/);
  events.handover("again");
  a.req.emit("close");
  assert.equal(a.written.filter((text) => text.includes("handover")).length, 1, "an ended stream is not written again");
});

test("the versions route answers the served etags and a matching if-none-match with 304", async (t) => {
  const rm = fakeReadModel({ now: "serve", repositories: "off" });
  rm.post(entry("now", "instance=site", { a: 2 }));
  rm.post(entry("now", "instance=core", { a: 1 }));
  const { url } = await serve(t, { names: ["now", "repositories"], readModel: rm, clock, every: timers().every });
  const res = await fetch(`${url}${VIEW_VERSIONS_PATH}`, { headers: READ });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { views: { now: { "instance=core": viewEtag("now", 1, false, { a: 1 }), "instance=site": viewEtag("now", 1, false, { a: 2 }) } }, disabled: ["repositories"] });
  const etag = res.headers.get("etag")!;
  assert.match(etag, /^W\/"versions\./);
  assert.equal((await fetch(`${url}${VIEW_VERSIONS_PATH}`, { headers: { ...READ, "if-none-match": etag } })).status, 304);

  // The same served state in another arrival order (a restart's warm boot) has the same version.
  const again = fakeReadModel({ now: "serve", repositories: "off" });
  again.post(entry("now", "instance=core", { a: 1 }));
  again.post(entry("now", "instance=site", { a: 2 }));
  const restarted = await serve(t, { names: ["now", "repositories"], readModel: again, clock, every: timers().every });
  assert.equal((await fetch(`${restarted.url}${VIEW_VERSIONS_PATH}`, { headers: READ })).headers.get("etag"), etag);
  assert.equal((await fetch(`${restarted.url}${VIEW_VERSIONS_PATH}`)).status, 401);
});

test("a view body under the inline limit rides in its view event", async (t) => {
  const rm = fakeReadModel({ now: "serve", "nav-badge": "serve" });
  const { url } = await serve(t, { names: ["now", "nav-badge"], readModel: rm, clock, every: timers().every });
  const stream = await open(t, `${url}${VIEW_EVENTS_PATH}`);
  await stream.next((f) => f.event === "hello");
  const badge = entry("nav-badge", "", { agent: { count: 2 } });
  const large = entry("now", "instance=core", { tasks: "x".repeat(8 * 1024) });
  rm.post(badge);
  rm.post(large);
  const small = await stream.next((f) => f.event === "view" && f.data.view === "nav-badge");
  const big = await stream.next((f) => f.event === "view" && f.data.view === "now");
  // The inlined body is the one a GET answers: the judged envelope with the event's own etag.
  assert.deepEqual(small.data.body, { ...badge.body, asOf: new Date(T0).toISOString() });
  assert.equal(viewEtag("nav-badge", 1, false, (small.data.body as { data: unknown }).data), small.data.etag);
  assert.equal("body" in big.data, false, "a body over the limit is refetched, never inlined");
  assert.equal(big.data.etag, large.etag);
});

test("an emitted view event is ledgered at most once per minute per key", async (t) => {
  const rm = fakeReadModel({ now: "serve" });
  let at = T0;
  const stepped: Clock = { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString() };
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const { url } = await serve(t, { names: ["now"], readModel: rm, clock: stepped, every: timers().every, log: (step, extra) => void rows.push({ step, ...(extra ? { extra } : {}) }) });
  const stream = await open(t, `${url}${VIEW_EVENTS_PATH}`);
  await stream.next((f) => f.event === "hello");
  const emittedRows = () => rows.filter((r) => r.step === "view.emitted").map((r) => r.extra!);
  for (const [offset, n] of [[0, 1], [10_000, 2], [59_999, 3], [60_000, 4]] as const) {
    at = T0 + offset;
    rm.post(entry("now", "instance=core", { n }));
    await stream.next((f) => f.event === "view" && f.id?.endsWith(`:${n}`) === true);
  }
  at = T0 + 60_001;
  rm.post(entry("now", "instance=site", { n: 5 }));
  await stream.next((f) => f.event === "view" && f.data.key === "instance=site");
  assert.equal(stream.frames.filter((f) => f.event === "view").length, 5, "control: every change was emitted");
  const sampled = emittedRows();
  assert.deepEqual(sampled.map((r) => [r.key, r.emittedAt]), [
    ["instance=core", new Date(T0).toISOString()],
    ["instance=core", new Date(T0 + 60_000).toISOString()],
    ["instance=site", new Date(T0 + 60_001).toISOString()],
  ]);
  assert.deepEqual({ ...sampled[0], etag: undefined }, { view: "now", key: "instance=core", etag: undefined, cause: "body", emittedAt: new Date(T0).toISOString(), rowTs: new Date(T0).toISOString(), bytes: sampled[0]!.bytes, inline: true, subscribers: 1 });
});

test("the events route answers 404 push_disabled while the push switch is off", async (t) => {
  const rm = fakeReadModel({ now: "serve" });
  rm.post(entry("now", "instance=core", { a: 1 }));
  const clockTimers = timers();
  const { url, events } = await serve(t, { names: ["now"], readModel: rm, clock, every: clockTimers.every });
  for (const push of [undefined, "off"] as const) {
    rm.state.push = push;
    const res = await fetch(`${url}${VIEW_EVENTS_PATH}`, { headers: READ });
    assert.equal(res.status, 404, `push ${push ?? "absent"}`);
    assert.deepEqual(await res.json(), { error: "push_disabled" });
  }
  assert.equal((await fetch(`${url}${VIEW_VERSIONS_PATH}`, { headers: READ })).status, 200, "the versions poll stays up: it is the fallback");

  // Switched on, a stream opens; switched off again, the next sweep hands it over.
  rm.state.push = "on";
  const stream = await open(t, `${url}${VIEW_EVENTS_PATH}`);
  await stream.next((f) => f.event === "hello");
  assert.equal(events.subscribers(), 1);
  rm.state.push = "off";
  clockTimers.fire(1_000);
  const handover = await stream.next((f) => f.event === "handover");
  assert.deepEqual(handover.data, { reason: "push_disabled", retryMs: 0 });
  assert.equal(events.subscribers(), 0);
  rm.post(entry("now", "instance=core", { a: 2 }));
  assert.equal(stream.frames.filter((f) => f.event === "view").length, 0, "nothing emits to a handed-over stream");
});

test("the switch file's push mode is parsed and a bad one refuses the whole file", (t) => {
  const dir = makeTempDir("push-switch");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "switches.json");
  const read = (body: unknown) => (writeFileSync(path, JSON.stringify(body)), readReadModelSwitches(path));
  const on = read({ push: "on", views: { now: "serve" } });
  assert.ok(on.ok && on.switches.push === "on");
  const absent = read({ views: {} });
  assert.ok(absent.ok && absent.switches.push === undefined, "absent stays absent, which reads as off");
  assert.deepEqual(read({ push: "yes" }), { ok: false, reason: 'push has mode "yes"' });
});
