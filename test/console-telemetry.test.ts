// P2-06 (arch Phase 2 design D9 and §5): POST /v1/console/telemetry turns the console's latency beacon
// into `console.latency` ledger rows. The auth tests drive the REAL assembled serve, so the ingest-only
// token's scoping is proven over the actual dispatch path; the pacing test drives the handler over a
// stepped clock.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "../src/lib/clock.js";
import { buildConsoleTelemetryRoute, CONSOLE_TELEMETRY_ROUTE_PATH, TELEMETRY_BURST_ROWS } from "../src/lib/console-telemetry.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

type TestCtx = { after: (fn: () => void | Promise<void>) => void };
const READ = "telemetry-read-token";
const WRITE = "telemetry-write-token";
const INGEST = "telemetry-ingest-token";

function record(i: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { view: "now", key: "instance=core", cause: "body", emittedAt: "2026-09-30T12:00:00.000Z", transportMs: 80 + i, fetchMs: 240.4, totalMs: 900, clockOffsetMs: -12.6, ...extra };
}

function rows(ledgerPath: string): Array<Record<string, unknown>> {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => String(r.step).startsWith("console."));
}

async function serve(t: TestCtx): Promise<{ base: string; ledgerPath: string }> {
  const root = makeTempDir("console-telemetry");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ, write: WRITE, ingest: INGEST },
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    log: () => {},
  };
  const server = buildServeServer(deps);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ledgerPath };
}

const post = (base: string, token: string | undefined, body: unknown, path = CONSOLE_TELEMETRY_ROUTE_PATH): Promise<Response> =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("a telemetry batch appends one console.latency row per record", async (t) => {
  const { base, ledgerPath } = await serve(t);
  const res = await post(base, INGEST, { records: [record(0), record(1, { view: "nav-badge", key: "", cause: "hello", unknown: "dropped" })] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accepted: 2, dropped: 0 });
  const written = rows(ledgerPath);
  assert.equal(written.length, 2);
  assert.deepEqual(written.map((r) => [r.step, r.view, r.key, r.cause, r.transportMs, r.fetchMs, r.clockOffsetMs]), [
    ["console.latency", "now", "instance=core", "body", 80, 240, -13],
    ["console.latency", "nav-badge", "", "hello", 81, 240, -13],
  ]);
  assert.equal(written[1]!.unknown, undefined, "an undeclared field never reaches the ledger");
  assert.equal(written[0]!.emittedAt, "2026-09-30T12:00:00.000Z");
});

test("a telemetry post without the ingest token is refused", async (t) => {
  const { base, ledgerPath } = await serve(t);
  const body = { records: [record(0)] };
  assert.equal((await post(base, undefined, body)).status, 401);
  assert.equal((await post(base, READ, body)).status, 403, "the read token cannot write telemetry");
  assert.equal((await post(base, INGEST, {}, "/v1/control/pause")).status, 401, "the ingest token reaches nothing else");
  assert.equal((await post(base, WRITE, body)).status, 200, "calibration: the write token still reaches it");
  assert.equal(rows(ledgerPath).length, 1);
});

test("an unusable telemetry batch is refused and ledgers nothing", async (t) => {
  const { base, ledgerPath } = await serve(t);
  const cases: Array<[unknown, number, RegExp]> = [
    ["{not json", 400, /not valid JSON/],
    [{ records: [] }, 400, /non-empty array/],
    [{ records: Array.from({ length: 51 }, (_, i) => record(i)) }, 400, /at most 50/],
    [{ records: [record(0, { view: "" })] }, 400, /needs a view and a key/],
    [{ records: [record(0, { key: 7 })] }, 400, /needs a view and a key/],
    [{ records: [record(0, { cause: "guess" })] }, 400, /cause must be/],
    [{ records: [record(0, { emittedAt: "yesterday" })] }, 400, /emittedAt is not a time/],
    [{ records: [record(0, { fetchMs: -1 })] }, 400, /fetchMs must be/],
    [{ records: [record(0, { paintMs: 4_000_000 })] }, 400, /paintMs must be/],
    [{ records: [record(0, { clockOffsetMs: "a" })] }, 400, /clockOffsetMs must be a number/],
    [{ records: [record(0, { note: "x".repeat(17 * 1024) })] }, 413, /body_too_large/],
  ];
  for (const [body, status, detail] of cases) {
    const res = await post(base, INGEST, body);
    assert.equal(res.status, status, JSON.stringify(body).slice(0, 80));
    assert.match(JSON.stringify(await res.json()), detail);
  }
  assert.deepEqual(rows(ledgerPath), []);
});

/** Drives the handler directly, the way service.ts does once auth passed. */
async function call(route: ReturnType<typeof buildConsoleTelemetryRoute>, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new PassThrough() as unknown as IncomingMessage;
  Object.assign(req, { method: "POST", url: CONSOLE_TELEMETRY_ROUTE_PATH, headers: {} });
  let status = 0;
  let sent = "";
  const res = { writeHead: (s: number) => ((status = s), res), setHeader: () => res, end: (text?: string) => void (sent = text ?? "") } as unknown as ServerResponse;
  const done = route.handler(req, res, { params: {} });
  (req as unknown as PassThrough).end(JSON.stringify(body));
  await done;
  return { status, body: JSON.parse(sent) as Record<string, unknown> };
}

test("telemetry rows are paced to about one a second after a burst", async (t) => {
  const root = makeTempDir("console-telemetry-pace");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  let now = Date.parse("2026-09-30T12:00:00.000Z");
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const route = buildConsoleTelemetryRoute({ ledgerPath }, clock);
  const batch = { records: Array.from({ length: 50 }, (_, i) => record(i)) };
  assert.deepEqual((await call(route, batch)).body, { accepted: 50, dropped: 0 });
  assert.deepEqual((await call(route, batch)).body, { accepted: TELEMETRY_BURST_ROWS - 50, dropped: 100 - TELEMETRY_BURST_ROWS });
  now += 30_000;
  assert.deepEqual((await call(route, batch)).body, { accepted: 30, dropped: 20 }, "30 s refills 30 rows");
  assert.deepEqual((await call(route, batch)).body, { accepted: 0, dropped: 50 });
  now += 30_000;
  assert.deepEqual((await call(route, { records: [record(0)] })).body, { accepted: 1, dropped: 0 });
  const written = rows(ledgerPath);
  assert.equal(written.filter((r) => r.step === "console.latency").length, TELEMETRY_BURST_ROWS + 30 + 1);
  assert.deepEqual(written.filter((r) => r.step === "console.latency_dropped").map((r) => r.dropped), [40, 70],
    "at most one dropped row a minute, each carrying every drop since the last");
});
