/**
 * W1-T13294: one Console page made nine /v1/views/agent reads on 2026-11-17 (Vercel 00:46:26Z), each paying the tunnel
 * round trip and each timing out at 5 s while the host was loaded. POST /v1/views/batch answers up to 32 view reads in
 * one request, each through the same code the GET uses.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  buildReadModelViewRoutes, VIEW_BATCH_MAX_BODY_BYTES, VIEW_BATCH_MAX_READS, viewEtag, viewKey,
  type ViewBody, type ViewBodyEntry, type ViewDefinition, type ViewSwitchMode,
} from "#src/lib/views.js";

const NOW = Date.parse("2026-11-17T03:00:00.000Z");
type Ctx = { after: (fn: () => void) => void };

/** A world of three views: `held` (worker body, served by default), `legacy` (computed, off) and `dark` (no body). */
function world(t: Ctx) {
  const reads: string[] = [];
  const data = (instance: string, part: string) => ({ instance, part, rows: [1, 2, 3] });
  const entries = new Map<string, ViewBodyEntry>();
  for (const [instance, part] of [["core", "proposals"], ["core", "history"], ["games", "proposals"]] as const) {
    const params = new URLSearchParams({ instance, part });
    const key = viewKey(params);
    const d = data(instance, part);
    const body: ViewBody = { view: "held", version: 1, generatedAt: "2026-11-17T02:59:00.000Z", asOf: "2026-11-17T02:59:00.000Z", stale: false, sources: [], data: d };
    entries.set(key, { view: "held", key, version: 1, generation: 1, etag: viewEtag("held", 1, false, d), body });
  }
  const legacy: ViewDefinition = {
    name: "legacy", version: 2,
    compute: (params) => params.get("bad") ? { error: "bad is not allowed" } : { data: { q: params.get("q") }, sources: [] },
  };
  const routes = buildReadModelViewRoutes({
    legacy: [legacy], readModelViews: ["held", "dark"], requiredParams: { held: ["instance", "part"] }, clock: fixedClock(NOW), servedByDefault: ["held", "dark"],
    readModel: {
      switches: () => ({ views: {} as Record<string, ViewSwitchMode> }),
      body: (view, key) => (reads.push(`${view}:${key}`), view === "held" ? entries.get(key ?? "") : undefined),
      judge: (sources) => [...sources],
    },
  });
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const route = routes.find((r) => r.method === req.method && r.path === path);
    if (!route) return void res.writeHead(404).end();
    void route.handler(req, res, {} as never);
  });
  const ready = new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const base = async () => (await ready, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const get = async (view: string, params: Record<string, string>, ifNoneMatch?: string) => {
    const res = await fetch(`${await base()}/v1/views/${view}?${new URLSearchParams(params)}`, { headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {} });
    const text = await res.text();
    return { status: res.status, headers: Object.fromEntries([...res.headers].filter(([k]) => !["date", "connection", "keep-alive", "transfer-encoding", "content-length"].includes(k))), text };
  };
  const batch = async (body: string) => {
    const res = await fetch(`${await base()}/v1/views/batch`, { method: "POST", headers: { "content-type": "application/json" }, body });
    return { status: res.status, json: (await res.json()) as { answers?: Array<Record<string, unknown>>; error?: string; detail?: string } };
  };
  return { reads, get, batch, entries };
}

test("W1-T13294 criterion 1: each batch answer equals the GET for the same read, in request order", async (t) => {
  const w = world(t);
  const heldEtag = [...w.entries.values()][0]!.etag;
  const cases: Array<{ view: string; params: Record<string, string>; ifNoneMatch?: string }> = [
    { view: "held", params: { instance: "core", part: "proposals" } },
    { view: "held", params: { instance: "core", part: "proposals" }, ifNoneMatch: heldEtag },
    { view: "held", params: { instance: "games", part: "proposals" } },
    { view: "held", params: { instance: "core" } },
    { view: "legacy", params: { q: "x" } },
    { view: "legacy", params: { bad: "1" } },
    { view: "dark", params: {} },
  ];
  const { status, json } = await w.batch(JSON.stringify({ reads: cases }));
  assert.equal(status, 200);
  assert.equal(json.answers!.length, cases.length);
  for (const [i, c] of cases.entries()) {
    const single = await w.get(c.view, c.params, c.ifNoneMatch);
    const answer = json.answers![i]!;
    assert.equal(answer.status, single.status, `${i}: status`);
    if (single.status === 200) {
      assert.equal(answer.etag, single.headers.etag, `${i}: etag`);
      assert.deepEqual(answer.body, JSON.parse(single.text), `${i}: body`);
    } else if (single.status === 304) {
      assert.equal(answer.etag, single.headers.etag);
      assert.equal(answer.body, undefined);
    } else {
      const { status: _s, ...rest } = answer;
      assert.deepEqual(rest, JSON.parse(single.text), `${i}: refusal`);
    }
  }
  assert.deepEqual(json.answers!.map((a) => a.status), [200, 304, 200, 400, 200, 400, 404], "positive control: every kind of answer is covered");
});

test("W1-T13294 criterion 2: an oversized, malformed or unknown batch is refused with 400 before any view is read", async (t) => {
  const w = world(t);
  const one = { view: "held", params: { instance: "core", part: "proposals" } };
  const refusals = [
    JSON.stringify({ reads: Array.from({ length: VIEW_BATCH_MAX_READS + 1 }, () => one) }),
    JSON.stringify({ reads: [] }),
    JSON.stringify({ reads: one }),
    JSON.stringify({ reads: [one, { view: "nope", params: {} }] }),
    JSON.stringify({ reads: [one, { view: "held", params: { instance: 1 } }] }),
    "{not json",
    JSON.stringify({ reads: [one], pad: "x".repeat(VIEW_BATCH_MAX_BODY_BYTES) }),
  ];
  for (const body of refusals) {
    const res = await w.batch(body);
    assert.equal(res.status, 400, body.slice(0, 60));
    assert.equal(res.json.error, "invalid_request");
  }
  assert.deepEqual(w.reads, [], "no refused batch read any view");
  const ok = await w.batch(JSON.stringify({ reads: Array.from({ length: VIEW_BATCH_MAX_READS }, () => one) }));
  assert.equal(ok.status, 200, "positive control: exactly 32 reads are answered");
  assert.equal(w.reads.length, VIEW_BATCH_MAX_READS);
});

test("W1-T13294 criterion 3: GET /v1/views/<name> answers byte for byte, status for status and header for header as before", async (t) => {
  const w = world(t);
  // A held body is re-judged at request time: with no sources its asOf reads null.
  const [entry] = [...w.entries.values()];
  const json = { "content-type": "application/json; charset=utf-8" };
  const expected: Array<[string, Record<string, string>, string | undefined, number, Record<string, string>, string]> = [
    ["held", { instance: "core", part: "proposals" }, undefined, 200, { ...json, etag: entry!.etag, "cache-control": "no-cache" }, JSON.stringify({ ...entry!.body, asOf: null })],
    ["held", { instance: "core", part: "proposals" }, entry!.etag, 304, { etag: entry!.etag, "cache-control": "no-cache" }, ""],
    ["held", { instance: "core" }, undefined, 400, json, JSON.stringify({ error: "invalid_request", detail: "the held view needs ?part=" })],
    ["legacy", { bad: "1" }, undefined, 400, json, JSON.stringify({ error: "invalid_request", detail: "bad is not allowed" })],
    ["dark", {}, undefined, 404, json, JSON.stringify({ error: "view_not_ready", view: "dark" })],
  ];
  for (const [view, params, inm, status, headers, text] of expected) {
    const got = await w.get(view, params, inm);
    assert.equal(got.status, status, `${view} ${JSON.stringify(params)}`);
    assert.deepEqual(got.headers, headers, `${view} headers`);
    assert.equal(got.text, text, `${view} bytes`);
  }
});
