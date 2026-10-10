import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildActionResultsRoute, buildActionResultsProjection } from "../src/lib/action-results.js";
import { buildOperatorActivityRoute, buildOperatorActivityProjection } from "../src/lib/panel-graph.js";
import { RouteResponseBuffer } from "../src/lib/console-snapshot-cache.js";
import { boundConsoleReadRoutes, buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { oldestAsOf, type ViewBodyEntry, type ViewBodySource, type ViewSource } from "../src/lib/views.js";

function fixture(t: TestContext) {
  const root = makeTempDir("serve-no-legacy-prewarm");
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), step: "daemon.tick" }) + "\n");
  const planPath = join(root, "plan.yaml");
  writeFileSync(planPath, "[]\n");
  const plan = { tasks: [], byId: new Map() };
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  const steps: string[] = [];
  const deps: ServeDeps = {
    board: { plan, ledgerPath, github }, ledgerPath, fleetControlRoot: root, questionsRoot: root,
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github,
      ratify: { approve() {}, reframe() {} } },
    issues: { close() {} }, tokens: { read: "r", write: "w" },
    consoleSha: "aaaaaaaa", resolveCurrentSha: () => "aaaaaaaa",
    gatewayCheckout: async () => ({ state: "clean" }) as never,
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    assistantRepository: "craigoley/remudero",
    // An old caller's config must not start raw reads, even after the production wiring is removed.
    consoleSnapshots: { dir: join(root, "snapshots"), ...{ prewarmPaths: ["/v1/operator-activity", "/v1/action-results"] } },
    log: (step) => void steps.push(step),
  };
  const now = Date.now();
  const generatedAt = new Date(now - 1_000).toISOString();
  const asOf = new Date(now - 2_000).toISOString();
  const activity = buildOperatorActivityProjection({ plan, projection: new Map(), ledgerLines: [], now: () => now - 1_000 });
  const results = buildActionResultsProjection(Object.assign([], { present: true, torn: 0 }), {}, () => now - 1_000);
  const bodies = new Map<string, ViewBodyEntry>();
  for (const [view, field, body] of [["workstreams", "activity", activity], ["actions", "results", results]] as const) {
    bodies.set(view, { view, key: "", version: 1, generation: 1, etag: `W/"${view}"`,
      body: { view, version: 1, generatedAt, asOf, stale: true,
        sources: [{ name: "ledger:core", instance: "core", asOf, state: "fresh" },
          { name: "ledger:other", instance: "other", asOf: null, state: "unavailable" }],
        data: { instances: [{ instance: "other", [field]: { ...body, source: "other-instance" } }, { instance: "core", [field]: body }] } } });
  }
  let state: ViewSource["state"] = "fresh";
  const judged: string[][] = [];
  const source: ViewBodySource = {
    body: (view) => bodies.get(view),
    judge: (sources, _now, entry) => {
      assert.equal(entry?.key, "");
      judged.push(sources.map((s) => s.name));
      return sources.map((s) => ({ ...s, state }));
    },
    switches: () => ({ views: {} }),
  };
  const calls = { activity: 0, results: 0 };
  const raw = [buildOperatorActivityRoute({ ...deps.panelGraph, inboxRoot: root, ratify: deps.panelGraph.ratify! }, () => plan), buildActionResultsRoute(ledgerPath)]
    .map((route, i): Route => ({ ...route, handler: (req, res, ctx) => {
      calls[i === 0 ? "activity" : "results"]++;
      return route.handler(req, res, ctx);
    } }));
  const bind = (instance = "core", withSource = true) => boundConsoleReadRoutes(raw, deps, 500, undefined,
    withSource ? { source, instance } : undefined);
  return { deps, steps, bodies, source, calls, bind, activity, results, generatedAt, asOf, judged,
    setState: (value: ViewSource["state"]) => void (state = value) };
}

async function read(route: Route, url = route.path, etag?: string) {
  const buffer = new RouteResponseBuffer();
  await route.handler({ method: "GET", url, headers: etag ? { "if-none-match": etag } : {} } as never,
    buffer as never, { params: {} });
  return buffer.buffered(Date.now());
}

test("W1-T7390: serve boot pays no legacy prewarm and the legacy reads answer from the views", async (t) => {
  const f = fixture(t);
  const routes = f.bind();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, { activity: 0, results: 0 }, "binding serve's reads never folds either raw ledger");
  assert.deepEqual(f.steps, []);
  for (const [i, expected] of [f.activity, f.results].entries()) {
    const response = await read(routes[i]!);
    assert.equal(response.status, 200);
    const { staleness, ...body } = JSON.parse(response.body);
    assert.deepEqual(body, expected, "the legacy envelope is the selected instance's view entry");
    assert.equal(staleness.generatedAt, f.generatedAt);
    assert.equal(staleness.stale, false, "another instance's unavailable source does not age core's answer");
    assert.ok(staleness.ageMs >= 2_000, "age reflects the view's inputs, not this request");
    const unchanged = await read(routes[i]!, routes[i]!.path, response.headers.etag);
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body, "");
    assert.equal(unchanged.headers.etag, response.headers.etag);
  }
  assert.deepEqual(f.judged[0], ["ledger:core"]);
  assert.deepEqual(f.calls, { activity: 0, results: 0 }, "neither view read invokes the raw projection");
  const first = f.bodies.get("actions")!;
  f.bodies.set("actions", { ...first, body: { ...first.body, data: { instances: [{ instance: "core", results: { ...f.results, cursor: "new-view-cursor" } }] } } });
  assert.equal(JSON.parse((await read(routes[1]!)).body).cursor, "new-view-cursor", "view updates bypass the legacy memo");
});

for (const unavailable of ["absent-worker", "unbuilt", "missing-instance", "unavailable-entry", "not-collected", "missing-data", "wrong-version", "missing-sources", "stale", "unavailable-source"] as const) {
  test(`W1-T7390: ${unavailable} falls through to the raw legacy handlers`, async (t) => {
    const f = fixture(t);
    if (unavailable === "unbuilt") f.bodies.clear();
    if (unavailable === "stale") f.setState("stale");
    if (unavailable === "unavailable-source") f.setState("unavailable");
    if (unavailable === "unavailable-entry") {
      for (const entry of f.bodies.values()) entry.body.data = { instances: [{ instance: "core", activity: { state: "unavailable" }, results: { state: "unavailable" } }] };
    }
    if (unavailable === "not-collected") f.bodies.get("workstreams")!.body.data = { instances: [{ instance: "core", activity: { state: "not-collected" } }] };
    if (unavailable === "missing-data") for (const entry of f.bodies.values()) entry.body.data = null;
    if (unavailable === "wrong-version") for (const entry of f.bodies.values()) entry.version++;
    if (unavailable === "missing-sources") for (const entry of f.bodies.values()) entry.body.sources = [];
    const routes = f.bind(unavailable === "missing-instance" ? "missing" : "core", unavailable !== "absent-worker");
    for (const route of routes) assert.equal((await read(route)).status, 200);
    assert.deepEqual(f.calls, { activity: 1, results: unavailable === "not-collected" ? 0 : 1 });
  });
}

test("W1-T7390: instance-bound legacy reads select that instance instead of core", async (t) => {
  const f = fixture(t);
  for (const route of f.bind("other")) {
    assert.equal(JSON.parse((await read(route)).body).source, "other-instance");
  }
  assert.deepEqual(f.judged, [["ledger:other"], ["ledger:other"]]);
  assert.deepEqual(f.calls, { activity: 0, results: 0 });
});

test("W1-T7390: queries preserve raw filtering and invalid-request responses", async (t) => {
  const f = fixture(t);
  const routes = f.bind();
  for (const query of ["taskId=W1-T1", "actionId=a", "changedSince=2026-01-01T00:00:00.000Z", "limit=1", "unknown=value"]) {
    const response = await read(routes[1]!, `/v1/action-results?${query}`);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body).results, []);
  }
  for (const query of ["limit=0", "changedSince=bad", "taskId=", "actionId=", "credential=secret"]) {
    const response = await read(routes[1]!, `/v1/action-results?${query}`);
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error, "invalid_request");
  }
  assert.equal(f.calls.results, 10);
  await read(routes[0]!, "/v1/operator-activity?filter=unknown");
  assert.equal(f.calls.activity, 1);
});

test("W1-T7390: the real serve route assembly answers both legacy paths from worker bodies", async (t) => {
  const f = fixture(t);
  const entries = [...f.bodies.values()].map((entry) => ({ ...entry, body: { ...entry.body,
    stale: false, sources: entry.body.sources.filter((s) => s.instance === "core") } }));
  const workerCode = `import { parentPort } from 'node:worker_threads';
    parentPort.postMessage({ type: 'state', at: Date.now(), switches: { views: {} },
      instances: [{ instance: 'core', generation: 1, lease: 'held', tickedAt: Date.now(), failures: 0, newestTs: '${f.asOf}' }] });
    for (const entry of ${JSON.stringify(entries)}) parentPort.postMessage({ type: 'body', entry });
    parentPort.postMessage({ type: 'log', step: 'test.views_ready', extra: {} });
    parentPort.on('message', msg => { if (msg.type === 'stop') process.exit(0); });`;
  f.deps.readModel = { workerUrl: new URL(`data:text/javascript,${encodeURIComponent(workerCode)}`), every: () => () => {} };
  const server = buildServeServer(f.deps);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (let attempt = 0; attempt < 100 && !f.steps.includes("test.views_ready"); attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(f.steps.includes("test.views_ready"));
  for (const view of ["workstreams", "actions"]) {
    const entry = entries.find((e) => e.view === view)!;
    const path = view === "workstreams" ? "/v1/operator-activity" : "/v1/action-results";
    const response = await fetch(`${url}${path}`, { headers: { authorization: "Bearer r" } });
    assert.equal(response.status, 200);
    const { staleness, ...body } = await response.json() as Record<string, unknown>;
    assert.deepEqual(body, view === "workstreams" ? f.activity : f.results);
    assert.equal((staleness as { generatedAt: string }).generatedAt, entry.body.generatedAt);
    assert.equal(oldestAsOf(entry.body.sources), f.asOf);
  }
  assert.equal(f.steps.includes("serve.boot_prewarm"), false);
});
