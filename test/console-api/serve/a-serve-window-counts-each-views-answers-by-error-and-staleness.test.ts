/**
 * W1-T13602: on 2026-11-18 serve swapped generations three times, and the only record of what clients saw was an operator's
 * live poll. serve.demand counted each view family by status class alone, so view_not_ready and view_disabled read the same,
 * a stale 200 read as healthy, and a batch hid every inner read behind its one 200. The window now carries a `views` section.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import { buildServeServer, type ServeDeps } from "#src/lib/serve.js";
import { createServeDemand, SERVE_DEMAND_FAMILY_CAP, SERVE_DEMAND_WINDOW_MS } from "#src/lib/serve-demand.js";
import { withTempDir } from "#src/lib/tmp.js";
import { TASK_VIEW_NAME } from "#src/lib/view-demand.js";
import { buildReadModelViewRoutes, viewEtag, viewKey, type ViewBody, type ViewBodyEntry, type ViewSwitchMode } from "#src/lib/views.js";

const NOW = Date.parse("2026-11-18T03:33:00.000Z");
type ViewCounts = { n: number; stale: number; codes: Record<string, number> };
type Row = { step: string; families: Record<string, unknown>; views?: Record<string, ViewCounts> };

function rows(path: string): Row[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Row);
}

/**
 * `held` serves worker bodies (core fresh, games stale), `warming` is served with no body yet (404 view_not_ready),
 * and `dark` has no switch entry and no legacy side (404 view_disabled). Every answer is reported to a real demand window.
 */
async function world(t: { after: (fn: () => void) => void }, root: string) {
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  let clock = 0;
  const demand = createServeDemand({ ledgerPath, routes: [], clock: clockFromMillisFn(() => clock) });
  const entries = new Map<string, ViewBodyEntry>();
  for (const [instance, state] of [["core", "fresh"], ["games", "stale"]] as const) {
    const key = viewKey(new URLSearchParams({ instance }));
    const data = { instance };
    const sources = [{ name: "ledger", state, asOf: "2026-11-18T03:32:00.000Z" }] as unknown as ViewBody["sources"];
    const body: ViewBody = { view: "held", version: 1, generatedAt: "2026-11-18T03:32:00.000Z", asOf: "2026-11-18T03:32:00.000Z", stale: false, sources, data };
    entries.set(key, { view: "held", key, version: 1, generation: 1, etag: viewEtag("held", 1, false, data), body });
  }
  const routes = buildReadModelViewRoutes({
    legacy: [], readModelViews: ["held", "warming", "dark"], clock: fixedClock(NOW), servedByDefault: ["held", "warming"],
    readModel: {
      switches: () => ({ views: {} as Record<string, ViewSwitchMode> }),
      body: (view, key) => view === "held" ? entries.get(key ?? "") : undefined,
      judge: (sources) => [...sources],
    },
    onAnswer: (view, status, code, stale) => demand.recordView(view, status, code, stale),
  });
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const route = routes.find((r) => r.method === req.method && r.path === path);
    if (!route) return void res.writeHead(404).end();
    void route.handler(req, res, {} as never);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (view: string, params: Record<string, string> = {}) => (await fetch(`${base}/v1/views/${view}?${new URLSearchParams(params)}`)).status;
  const batch = async (reads: unknown[]) => (await fetch(`${base}/v1/views/batch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reads }) })).status;
  const flushed = (): Row => { clock += SERVE_DEMAND_WINDOW_MS; demand.flush(); return rows(ledgerPath).at(-1)!; };
  return { get, batch, flushed };
}

test("W1-T13602 criterion 1: one window counts each view by answer code and staleness", async (t) => {
  await withTempDir("view-answers", async (root) => {
    const w = await world(t, root);
    assert.deepEqual([await w.get("held", { instance: "core" }), await w.get("held", { instance: "games" }), await w.get("warming"), await w.get("dark")], [200, 200, 404, 404]);
    const row = w.flushed();
    assert.equal(row.step, "serve.demand");
    assert.deepEqual(row.views, {
      held: { n: 2, stale: 1, codes: { "200 ok": 2 } },
      warming: { n: 1, stale: 0, codes: { "404 view_not_ready": 1 } },
      dark: { n: 1, stale: 0, codes: { "404 view_disabled": 1 } },
    });
  });
});

test("W1-T13602 criterion 2: a batch counts each inner read under its own view and code", async (t) => {
  await withTempDir("view-answers-batch", async (root) => {
    const w = await world(t, root);
    assert.equal(await w.batch([{ view: "held", params: { instance: "games" } }, { view: "warming", params: {} }, { view: "dark", params: {} }]), 200);
    assert.deepEqual(w.flushed().views, {
      held: { n: 1, stale: 1, codes: { "200 ok": 1 } },
      warming: { n: 1, stale: 0, codes: { "404 view_not_ready": 1 } },
      dark: { n: 1, stale: 0, codes: { "404 view_disabled": 1 } },
    });
  });
});

test("W1-T13602 criterion 3: view names past the cap share `other`, and a window with no view read writes no views section", async () => {
  await withTempDir("view-answers-cap", async (root) => {
    const ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    let clock = 0;
    const demand = createServeDemand({ ledgerPath, routes: [{ method: "GET", path: "/v1/probe" }], clock: clockFromMillisFn(() => clock) });
    for (let i = 0; i < SERVE_DEMAND_FAMILY_CAP + 2; i++) demand.recordView(`view-${i}`, 503, "view_not_ready", false);
    clock = SERVE_DEMAND_WINDOW_MS; demand.flush();
    const views = rows(ledgerPath)[0]!.views!;
    assert.equal(Object.keys(views).length, SERVE_DEMAND_FAMILY_CAP + 1);
    assert.deepEqual(views.other, { n: 2, stale: 0, codes: { "503 view_not_ready": 2 } });
    demand.record("/v1/probe", 200, 1, false);
    clock = 2 * SERVE_DEMAND_WINDOW_MS; demand.flush();
    const second = rows(ledgerPath)[1]!;
    assert.ok(second.families["/v1/probe"]);
    assert.equal(Object.hasOwn(second, "views"), false);
  });
});

test("serve's production assembly reports each view answer into its serve.demand window", async () => {
  await withTempDir("view-answers-serve", async (root) => {
    mkdirSync(join(root, "state"));
    const ledgerPath = join(root, "state", "ledger.ndjson"), planPath = join(root, "plan.yaml");
    writeFileSync(ledgerPath, ""); writeFileSync(planPath, "[]\n");
    let clock = 0, tick: (() => void) | undefined;
    const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
    const deps: ServeDeps = {
      ledgerPath, fleetControlRoot: root, questionsRoot: root,
      board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
      panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
      issues: { close() {} }, tokens: { read: "r", write: "w" },
      consoleSha: "aaaaaaaa", resolveCurrentSha: () => "aaaaaaaa", gatewayCheckout: async () => ({ state: "clean" }) as never,
      githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
      assistantRepository: "craigoley/remudero",
      demand: { clock: clockFromMillisFn(() => clock), every: (fn) => { tick = fn; return () => {}; } },
    };
    const server = buildServeServer(deps);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/${TASK_VIEW_NAME}`, { headers: { authorization: "Bearer r" } });
      assert.equal(result.status, 400); await result.text();
      clock = SERVE_DEMAND_WINDOW_MS; tick!();
      const row = rows(ledgerPath).find(r => r.step === "serve.demand");
      assert.deepEqual(row?.views, { [TASK_VIEW_NAME]: { n: 1, stale: 0, codes: { "400 invalid_request": 1 } } });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
