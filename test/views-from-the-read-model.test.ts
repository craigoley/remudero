import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fixedClock, systemClock, type Clock } from "../src/lib/clock.js";
import {
  createReadModelTicker,
  createReadModelWorker,
  readModelSwitchesPath,
  type ReadModelBodyEntry,
  type ReadModelSwitches,
  type ReadModelWorkerHandle,
} from "../src/lib/read-model-worker.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { createService } from "../src/lib/service.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { buildReadModelViewRoutes, buildViewRoutes, viewEtag, viewKey, type ReadModelViewRoutesOptions, type ViewDefinition, type ViewSource } from "../src/lib/views.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const LIVE = "ledger.ndjson";
const SILENT_WORKER = new URL("data:text/javascript,setInterval(() => {}, 1000)");

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedRows(dir: string, n: number): void {
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify({ ts: new Date(T0 - 60_000 + i).toISOString(), step: "run.start", task_id: `T${i}` }));
  writeFileSync(join(dir, LIVE), `${lines.join("\n")}\n`);
}

/** Runs enough bounded passes for the previous serve to commit its `read-model` body. */
function committedBody(stateDir: string, ledgerDir: string): ReadModelBodyEntry {
  let posted: ReadModelBodyEntry | undefined;
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], post: (m) => void (m.type === "body" && m.entry.view === "read-model" && (posted = m.entry)) });
  for (let pass = 0; pass < 8 && !posted; pass++) ticker.tick();
  ticker.release();
  assert.ok(posted, "the previous serve committed a body");
  return posted;
}

async function listen(t: TestCtx, server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function get(url: string, path: string, headers: Record<string, string> = {}, token = "r"): Promise<{ status: number; etag: string | null; body: Record<string, unknown> | undefined }> {
  const res = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get("etag"), body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
}

function entry(view: string, data: unknown, sources: ViewSource[] = [], at = "2026-09-30T12:00:00.000Z", generation = 1): ReadModelBodyEntry {
  const stale = sources.some((source) => source.state !== "fresh");
  return { view, key: "", version: 1, generation, etag: viewEtag(view, 1, stale, data), body: { view, version: 1, generatedAt: at, asOf: null, stale, sources, data } };
}

/** A worker handle whose bodies and switches the test sets directly; `judge` passes sources through. */
function fakeReadModel(): NonNullable<ReadModelViewRoutesOptions["readModel"]> & { set: (e: ReadModelBodyEntry) => void; switch: (s: ReadModelSwitches) => void } {
  const bodies = new Map<string, ReadModelBodyEntry>();
  let switches: ReadModelSwitches = { projector: "on", views: {} };
  return {
    body: (view, key = "") => bodies.get(`${view}|${key}`),
    judge: (sources) => [...sources],
    switches: () => switches,
    set: (e) => void bodies.set(`${e.view}|${e.key}`, e),
    switch: (s) => void (switches = s),
  };
}

function serveDeps(root: string, stateDir: string, readModel: ServeDeps["readModel"]): ServeDeps {
  const ledgerPath = join(stateDir, LIVE);
  const planPath = join(root, "plan.yaml");
  writeFileSync(planPath, "[]\n");
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "r", write: "w" },
    consoleSha: "aaaaaaaa",
    resolveCurrentSha: () => "aaaaaaaa",
    gatewayCheckout: async () => ({ state: "clean" }) as never,
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    readModel,
  };
}

test("warm boot serves a view before the first tick", async (t) => {
  const root = scratch(t, "views-warm");
  const stateDir = join(root, "state");
  seedRows(stateDir, 3);
  const committed = committedBody(stateDir, stateDir);

  // The restarted serve's worker never ticks: whatever it answers came from the committed body.
  const server = buildServeServer(serveDeps(root, stateDir, { workerUrl: SILENT_WORKER, stopWaitMs: 20 }));
  const url = await listen(t, server);
  const got = await get(url, "/v1/views/read-model");
  assert.equal(got.status, 200);
  assert.deepEqual(got.body?.data, committed.body.data, "the body the previous serve committed");
  assert.equal(got.body?.generatedAt, committed.body.generatedAt);
  assert.equal(got.body?.stale, true, "a body from before this serve started is not claimed fresh");
  const sources = got.body?.sources as ViewSource[];
  assert.equal(sources[0]?.name, "ledger:core");
  assert.match(String(sources[0]?.reason), /read model warming/);
  assert.equal(got.etag, viewEtag("read-model", 1, true, committed.body.data));

  const coldRoot = scratch(t, "views-cold");
  const coldState = join(coldRoot, "state");
  seedRows(coldState, 1);
  const cold = await get(await listen(t, buildServeServer(serveDeps(coldRoot, coldState, { workerUrl: SILENT_WORKER, stopWaitMs: 20 }))), "/v1/views/read-model");
  assert.deepEqual([cold.status, cold.body], [404, { error: "view_not_ready", view: "read-model" }], "with nothing committed the view says so");
  const absent = await get(await listen(t, buildServeServer(serveDeps(coldRoot, coldState, undefined))), "/v1/views/read-model");
  assert.equal(absent.status, 404, "the route exists without a worker and answers not ready");
});

test("a view switched off answers with its legacy computation or 404 view_disabled", async (t) => {
  const legacy: ViewDefinition = { name: "demo", version: 1, compute: (params) => (params.get("bad") ? { error: "bad param" } : { data: { from: "legacy" }, sources: [] }) };
  const readModel = fakeReadModel();
  readModel.set(entry("demo", { from: "read-model" }));
  readModel.set(entry("only-read-model", { n: 1 }));
  const url = await listen(t, createService({ tokens: { read: "r", write: "w" }, routes: buildReadModelViewRoutes({ legacy: [legacy], readModel, readModelViews: ["only-read-model"] }) }));

  readModel.switch({ projector: "on", views: { demo: "serve" } });
  assert.deepEqual((await get(url, "/v1/views/demo")).body?.data, { from: "read-model" }, "serve mode answers from the read model");
  readModel.switch({ projector: "on", views: { demo: "off", "only-read-model": "off" } });
  assert.deepEqual((await get(url, "/v1/views/demo")).body?.data, { from: "legacy" }, "off falls back to the legacy computation");
  assert.equal((await get(url, "/v1/views/demo?bad=1")).status, 400, "the legacy computation keeps its own 400");
  assert.deepEqual((await get(url, "/v1/views/only-read-model")).body, { error: "view_disabled", view: "only-read-model" });
  readModel.switch({ projector: "on", views: { demo: "shadow" } });
  assert.deepEqual((await get(url, "/v1/views/demo")).body?.data, { from: "legacy" }, "shadow keeps the legacy computation primary");

  // The real switch file, read by serve's main thread: it works with no worker running at all.
  const stateDir = scratch(t, "views-switch");
  seedRows(stateDir, 2);
  committedBody(stateDir, stateDir);
  let refresh: (() => void) | undefined;
  const handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], workerUrl: SILENT_WORKER, stopWaitMs: 20, every: (run) => ((refresh = run), () => undefined) });
  t.after(() => handle.stop());
  handle.start();
  const real = await listen(t, createService({ tokens: { read: "r", write: "w" }, routes: buildReadModelViewRoutes({ legacy: [], readModel: handle, readModelViews: ["read-model"], servedByDefault: ["read-model"] }) }));
  assert.equal((await get(real, "/v1/views/read-model")).status, 200);
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { "read-model": "off" } }));
  assert.equal((await get(real, "/v1/views/read-model")).status, 200, "the file is not read on the request path");
  refresh?.();
  assert.deepEqual((await get(real, "/v1/views/read-model")).body, { error: "view_disabled", view: "read-model" });
  writeFileSync(readModelSwitchesPath(stateDir), "{ half");
  refresh?.();
  assert.equal((await get(real, "/v1/views/read-model")).status, 200, "a half-written file reverts every view to its default");
});

test("an unchanged view answers 304 even after it is materialized again", async (t) => {
  const readModel = fakeReadModel();
  readModel.set(entry("demo", { count: 2 }, [], "2026-09-30T12:00:00.000Z", 1));
  const url = await listen(t, createService({ tokens: { read: "r", write: "w" }, routes: buildReadModelViewRoutes({ legacy: [], readModel, readModelViews: ["demo"], servedByDefault: ["demo"] }) }));
  const first = await get(url, "/v1/views/demo");
  assert.equal(first.status, 200);
  assert.ok(first.etag?.startsWith('W/"demo.1.'));
  readModel.set(entry("demo", { count: 2 }, [], "2026-09-30T12:05:00.000Z", 9));
  const again = await get(url, "/v1/views/demo", { "if-none-match": first.etag ?? "" });
  assert.deepEqual([again.status, again.body, again.etag], [304, undefined, first.etag], "a new generation with the same data is still a 304");
  readModel.set(entry("demo", { count: 3 }));
  const changed = await get(url, "/v1/views/demo", { "if-none-match": first.etag ?? "" });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.etag, first.etag);
  assert.deepEqual(changed.body?.data, { count: 3 });
});

test("a stale source makes the view stale and names the source", async (t) => {
  const stateDir = scratch(t, "views-stale");
  seedRows(stateDir, 4);
  const handle: ReadModelWorkerHandle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], tickMs: 20 });
  t.after(() => handle.stop());
  handle.start();
  const deadline = Date.now() + 30_000;
  while ((!handle.body("read-model") || handle.state().instances.get("core")?.tickedAt === undefined) && Date.now() < deadline) await sleep(20);
  const tickedAt = handle.state().instances.get("core")?.tickedAt;
  assert.ok(tickedAt !== undefined && handle.body("read-model"), "the worker materialized the read-model view");
  let now = tickedAt;
  const clock: Clock = { ...systemClock, now: () => now, iso: () => fixedClock(now).iso() };
  const url = await listen(t, createService({ tokens: { read: "r", write: "w" }, routes: buildReadModelViewRoutes({ legacy: [], readModel: handle, readModelViews: ["read-model"], servedByDefault: ["read-model"], clock }) }));

  const fresh = await get(url, "/v1/views/read-model");
  assert.equal(fresh.body?.stale, false);
  assert.deepEqual((fresh.body?.sources as ViewSource[]).map((s) => [s.name, s.state]), [["ledger:core", "fresh"]]);
  assert.equal(fresh.body?.asOf, new Date(T0 - 60_000 + 3).toISOString(), "asOf is the newest applied row");

  handle.stop();
  now = tickedAt + 12_000;
  const behind = await get(url, "/v1/views/read-model");
  assert.equal(behind.body?.stale, true);
  const source = (behind.body?.sources as ViewSource[])[0];
  assert.equal(source?.name, "ledger:core");
  assert.equal(source?.state, "stale");
  assert.match(String(source?.reason), /^projector 1\d s behind/);
  assert.notEqual(behind.etag, fresh.etag, "a view that turned stale is a different entity");
  assert.equal((await get(url, "/v1/views/read-model", { "if-none-match": behind.etag ?? "" })).status, 304, "and its own tag still matches");
});

test("a view body is selected by its query sorted by parameter name", () => {
  assert.equal(viewKey(new URLSearchParams("b=2&a=1")), "a=1&b=2");
  assert.equal(viewKey(new URLSearchParams("instance=con sole")), "instance=con%20sole");
  assert.equal(viewKey(new URLSearchParams("a=2&a=1")), "a=2&a=1");
  assert.equal(viewKey(new URLSearchParams("")), "");
});

test("a legacy-only view route computes its body per request with no read model behind it", async (t) => {
  let calls = 0;
  const view: ViewDefinition<{ calls: number }> = { name: "legacy-only", version: 2, compute: () => ({ data: { calls: ++calls }, sources: [{ name: "s", asOf: null, state: "fresh" }] }) };
  const server = createService({ tokens: { read: "r", write: "w" }, routes: buildViewRoutes([view], fixedClock(T0)) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/legacy-only`;
  const first = (await (await fetch(url, { headers: { authorization: "Bearer r" } })).json()) as { data: { calls: number }; generatedAt: string };
  const second = (await (await fetch(url, { headers: { authorization: "Bearer r" } })).json()) as { data: { calls: number } };
  assert.deepEqual([first.data.calls, second.data.calls], [1, 2], "each request runs the legacy computation");
  assert.equal(first.generatedAt, new Date(T0).toISOString(), "the route renders with the clock it was given");
});
