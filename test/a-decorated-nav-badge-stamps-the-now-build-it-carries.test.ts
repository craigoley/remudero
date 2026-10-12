// 2026-10-06 measurement: every nav-badge `view.emitted` row from 01:10 to 01:31Z carried buildStartedAt
// 01:10:13, and its rowTs stood still while decisions moved. Serve decorates the worker's nav-badge body with
// the needs-you composite's decision count (withNeedsYouView), and the decoration copied the worker entry's
// latency stamps, so a badge pushed by a now build reported the build and ledger row of its last worker body.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { NAV_BADGE_VIEW_NAME } from "../src/lib/nav-badge-view.js";
import { NEEDS_YOU_VIEW_NAME, withNeedsYouView } from "../src/lib/needs-you-view.js";
import type { NowDecision } from "../src/lib/now-decisions.js";
import type { ReadModelInstanceState, ReadModelWorkerHandle } from "../src/lib/read-model-worker.js";
import { createService } from "../src/lib/service.js";
import { createViewEvents, VIEW_EVENTS_PATH } from "../src/lib/view-events.js";
import { viewEtag, type ViewBodyEntry, type ViewSource } from "../src/lib/views.js";

type TestCtx = { after: (fn: () => void) => void };
const T0 = Date.parse("2026-10-06T01:30:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function entry(view: string, key: string, version: number, data: unknown, rowMs: number, buildStartedMs: number): ViewBodyEntry {
  const sources: ViewSource[] = [{ name: "ledger:core", asOf: iso(rowMs), state: "fresh" }];
  return { view, key, version, generation: 1, etag: viewEtag(view, version, false, data), buildStartedMs,
    body: { view, version, generatedAt: iso(rowMs), asOf: iso(rowMs), stale: false, sources, data } };
}

function decision(id: string, askedMs: number): NowDecision {
  return { id, kind: "task_question", instance: "core", title: id, prompt: "p", askedAt: iso(askedMs), answer: { method: "POST", path: "/v1/questions/answer", tier: "low", fields: {}, input: "text" } };
}

/** A now body for core carrying `ids` as open questions, built from rows up to `rowMs`. */
const now = (ids: string[], rowMs: number, startedMs: number): ViewBodyEntry =>
  entry("now", "instance=core", 3, { instance: "core", actions: [], decisions: ids.map((id) => decision(id, rowMs)) }, rowMs, startedMs);

/** The worker's own badge body: built once, long before the now builds that move its decision count. */
const badge = (): ViewBodyEntry => entry(NAV_BADGE_VIEW_NAME, "instances=core", 1, { agent: { proposalIds: [], instances: [] }, inbox: { reason: "fixture" } }, T0 - 20 * 60_000, T0 - 20 * 60_000);

function fakeHandle() {
  const bodies = new Map<string, ViewBodyEntry>();
  const listeners = new Set<(e: ViewBodyEntry) => void>();
  const instances = new Map<string, ReadModelInstanceState>([["core", { instance: "core", generation: 1, lease: "held", failures: 0, newestTs: null }]]);
  const views = { now: "serve", [NAV_BADGE_VIEW_NAME]: "serve", [NEEDS_YOU_VIEW_NAME]: "serve" } as const;
  const handle: ReadModelWorkerHandle = {
    bodies,
    state: () => ({ instances, switches: { projector: "on", views } }),
    body: (view, key = "") => bodies.get(`${view}\u0000${key}`),
    judge: (sources) => [...sources],
    switches: () => ({ projector: "on", views, push: "on" }),
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

test("a decorated nav-badge carries the newest build and ledger row of the now bodies it was decorated from", () => {
  const { handle, post } = fakeHandle();
  const view = withNeedsYouView(handle);
  post(badge());
  post(now(["question:W1-T1:a"], T0 - 2_000, T0 - 9_000));
  const first = view.body(NAV_BADGE_VIEW_NAME, "instances=core")!;
  assert.deepEqual([first.buildStartedMs, first.rowTs], [T0 - 9_000, iso(T0 - 2_000)], "the now build the decoration carries, not the badge's own of 20 min before");
  assert.equal(view.body(NEEDS_YOU_VIEW_NAME)!.buildStartedMs, T0 - 9_000, "the composite names the input build it carries");

  post(now(["question:W1-T1:a", "question:W1-T2:b"], T0 + 50_000, T0 + 44_000));
  const second = view.body(NAV_BADGE_VIEW_NAME, "instances=core")!;
  assert.notEqual(second.etag, first.etag, "control: the decision count moved the badge");
  assert.deepEqual([second.buildStartedMs, second.rowTs], [T0 + 44_000, iso(T0 + 50_000)], "the stamps advance with each now build");
});

test("a nav-badge view.emitted row stamps the now build its decoration carries", async (t: TestCtx) => {
  const { handle, post } = fakeHandle();
  const view = withNeedsYouView(handle);
  let at = T0;
  const clock: Clock = { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString() };
  const rows: Array<Record<string, unknown>> = [];
  const events = createViewEvents({ names: ["now", NAV_BADGE_VIEW_NAME, NEEDS_YOU_VIEW_NAME], readModel: view, clock, every: () => () => {},
    log: (step, extra) => void (step === "view.emitted" && extra?.view === NAV_BADGE_VIEW_NAME && rows.push(extra)) });
  const server = createService({ tokens: { read: "r", write: "w" }, routes: events.routes });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  post(badge());
  post(now([], T0 - 60_000, T0 - 65_000));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${VIEW_EVENTS_PATH}`, { headers: { authorization: "Bearer r" }, signal: controller.signal });
  assert.equal(res.status, 200);
  for (const [n, rowMs, startedMs] of [[1, T0 - 1_000, T0 - 6_000], [2, T0 + 59_000, T0 + 53_000]] as const) {
    at = T0 + (n - 1) * 60_000;
    post(now(Array.from({ length: n }, (_, i) => `question:W1-T${i}:x`), rowMs, startedMs));
  }
  const stamps = rows.map((r) => ({ buildStartedAt: r.buildStartedAt, rowTs: r.rowTs, prevRowTs: r.prevRowTs }));
  assert.equal(stamps.length, 2, `control: one nav-badge row per minute: ${JSON.stringify(rows)}`);
  assert.deepEqual(stamps, [
    { buildStartedAt: iso(T0 - 6_000), rowTs: iso(T0 - 1_000), prevRowTs: iso(T0 - 60_000) },
    { buildStartedAt: iso(T0 + 53_000), rowTs: iso(T0 + 59_000), prevRowTs: iso(T0 - 1_000) },
  ]);
});
