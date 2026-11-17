/**
 * W1-T13282: on 2026-11-16 one Console Inbox load froze serve for 232 s: the agent view's legacy side read every
 * ledger archive synchronously on the request thread. Serve now serves the read-model worker's agent body by default,
 * and the legacy side answers 503 view_not_ready without reading any ledger.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { AGENT_VIEW_NAME, agentLegacyView, agentViewKey } from "#src/lib/agent-view.js";
import { coldAnalyticsSnapshot } from "#src/lib/analytics-route.js";
import { fixedClock } from "#src/lib/clock.js";
import { buildReadModelViewRoutes, renderView, viewEtag, type ViewBody, type ViewBodyEntry, type ViewSwitchMode } from "#src/lib/views.js";

const NOW = Date.parse("2026-11-17T00:30:00.000Z");
const absentLedger = join(tmpdir(), "rmd-no-such-ledger-dir-w1-t13282", "ledger.ndjson");
const legacy = agentLegacyView({ scopes: () => [{ instanceId: "core", repository: "o/r", analytics: coldAnalyticsSnapshot, ledgerPath: absentLedger }], clock: fixedClock(NOW) });

function routes(mode: ViewSwitchMode | undefined, entry: ViewBodyEntry | undefined, servedByDefault: string[]) {
  return buildReadModelViewRoutes({
    legacy: [legacy], readModelViews: [AGENT_VIEW_NAME], requiredParams: { [AGENT_VIEW_NAME]: ["instance", "part"] }, clock: fixedClock(NOW), servedByDefault,
    readModel: {
      switches: () => ({ views: (mode ? { [AGENT_VIEW_NAME]: mode } : {}) as Record<string, ViewSwitchMode> }),
      body: (view, key) => (view === AGENT_VIEW_NAME && entry && key === entry.key ? entry : undefined),
      judge: (sources) => [...sources],
    },
  });
}

async function get(t: { after: (fn: () => void) => void }, rs: ReturnType<typeof routes>, path: string): Promise<{ status: number; body: unknown }> {
  const route = rs.find((r) => r.path === `/v1/views/${AGENT_VIEW_NAME}`)!;
  const server: Server = createServer((req, res) => void route.handler(req, res, {} as never));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  return { status: res.status, body: await res.json() };
}

test("W1-T13282 criterion 1: the legacy side answers view_not_ready for every part and reads no ledger", () => {
  for (const part of ["proposals", "history"]) {
    const rendered = renderView(legacy, fixedClock(NOW), new URLSearchParams({ instance: "core", part }));
    assert.ok("error" in rendered, part);
    assert.equal(rendered.error, "view_not_ready", "a ledger read of the absent directory would have thrown or returned rows");
    assert.equal(rendered.status, 503);
  }
});

test("W1-T13282 criterion 2: served by default, the worker's body answers; with no body the answer is 503 view_not_ready", async (t) => {
  const key = agentViewKey("core", "history");
  const data = { instance: "core", part: "history", body: { source: "worker-marker" } };
  const body: ViewBody = { view: AGENT_VIEW_NAME, version: 1, generatedAt: "2026-11-17T00:29:00.000Z", asOf: "2026-11-17T00:29:00.000Z", stale: false, sources: [], data };
  const entry: ViewBodyEntry = { view: AGENT_VIEW_NAME, key, version: 1, generation: 1, etag: viewEtag(AGENT_VIEW_NAME, 1, false, data), body };
  const served = await get(t, routes(undefined, entry, [AGENT_VIEW_NAME]), `/v1/views/agent?${key}`);
  assert.equal(served.status, 200);
  assert.deepEqual((served.body as ViewBody).data, data, "no switch entry, served by default: the worker's body");
  const missing = await get(t, routes(undefined, undefined, [AGENT_VIEW_NAME]), "/v1/views/agent?instance=core&part=proposals");
  assert.equal(missing.status, 503);
  assert.equal((missing.body as { error: string }).error, "view_not_ready");
});

test("W1-T13282 criterion 3: an unknown part is still refused with 400 before anything else", async (t) => {
  const res = await get(t, routes(undefined, undefined, [AGENT_VIEW_NAME]), "/v1/views/agent?instance=core&part=nope");
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.body), /unknown agent part: nope/);
});
