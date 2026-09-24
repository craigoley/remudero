// test/incident-events.test.ts — W1-T4383: the SRE gardener's phase 1, `POST
// /v1/incidents/events`. Criteria 1-3 drive the pure helpers directly (fingerprint/scrub are
// side-effect-free by design, see incident-events.ts's own header); criterion 4 drives the real
// route's handler over an injected clock; criterion 6 drives the REAL assembled `rmd serve` table
// (buildServeServer) so the ingest-only token's scoping is proven over the actual dispatch path,
// never a stand-in.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildIncidentEventsRoute,
  fingerprintIncidentEvent,
  INCIDENT_INGEST_ROUTE_PATH,
  scrubIncidentEvent,
  validateIncidentEventBody,
  type IncidentEventInput,
} from "../src/lib/incident-events.js";
import { createService, type Route } from "../src/lib/service.js";
import { buildServeServer, buildServeRoutes, INGEST_TOKEN_ENV, type ServeDeps } from "../src/lib/serve.js";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { fakeGhRateLimitExec } from "./helpers/fake-gh-rate-limit.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-incident-events-"));
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function baseInput(overrides: Partial<IncidentEventInput> = {}): IncidentEventInput {
  return {
    source: "console",
    kind: "exception",
    name: "TypeError",
    message: "Cannot read property 'x' of undefined",
    frames: [{ file: "src/app.ts", fn: "render" }],
    at: new Date().toISOString(),
    ...overrides,
  };
}

// ── criterion 1: two errors differing only in line numbers and ids share one fingerprint ───────

test("two errors differing only in line numbers and ids share one fingerprint", () => {
  const a = scrubIncidentEvent(
    baseInput({ message: "boom at line 42, request id a1b2c3d4e5, count 7", frames: [{ file: "src/app.ts", fn: "render" }] }),
  );
  const b = scrubIncidentEvent(
    baseInput({ message: "boom at line 999, request id f0e1d2c3b4, count 3", frames: [{ file: "src/app.ts", fn: "render" }] }),
  );
  assert.equal(fingerprintIncidentEvent(a), fingerprintIncidentEvent(b));

  // Calibration: a genuinely different message still fingerprints differently, so the equality
  // above is proving normalization, not that everything collapses to one hash.
  const c = scrubIncidentEvent(baseInput({ message: "an entirely different failure", frames: [{ file: "src/app.ts", fn: "render" }] }));
  assert.notEqual(fingerprintIncidentEvent(a), fingerprintIncidentEvent(c));
});

// ── criterion 2: a library frame never changes the fingerprint ─────────────────────────────────

test("a library frame never changes the fingerprint", () => {
  const withoutLibraryFrame = scrubIncidentEvent(baseInput({ frames: [{ file: "src/app.ts", fn: "render" }] }));
  const withLibraryFrameBefore = scrubIncidentEvent(
    baseInput({ frames: [{ file: "node_modules/react/index.js", fn: "dispatch" }, { file: "src/app.ts", fn: "render" }] }),
  );
  const withLibraryFrameAfter = scrubIncidentEvent(
    baseInput({ frames: [{ file: "src/app.ts", fn: "render" }, { file: "node_modules/react/index.js", fn: "dispatch" }] }),
  );
  const fp = fingerprintIncidentEvent(withoutLibraryFrame);
  assert.equal(fingerprintIncidentEvent(withLibraryFrameBefore), fp);
  assert.equal(fingerprintIncidentEvent(withLibraryFrameAfter), fp);

  // Calibration: an ADDITIONAL in-app frame (not a library one) DOES change the fingerprint, so
  // the equalities above are proving the node_modules exclusion, not that frames are ignored.
  const withExtraAppFrame = scrubIncidentEvent(
    baseInput({ frames: [{ file: "src/other.ts", fn: "call" }, { file: "src/app.ts", fn: "render" }] }),
  );
  assert.notEqual(fingerprintIncidentEvent(withExtraAppFrame), fp);
});

// ── criterion 3: an event carrying a token or a query string is stored scrubbed ────────────────

test("an event carrying a token or a query string is stored scrubbed", () => {
  const scrubbed = scrubIncidentEvent(
    baseInput({
      route: "/v1/checkout?token=abcdefghijklmnopqrstuvwxyz0123&session=1#frag",
      message:
        "failed for user someone@example.com with token sk-abcdefghijklmnopqrstuvwxyz0123 " +
        "and id 550e8400-e29b-41d4-a716-446655440000?trailing=1#frag",
    }),
  );
  assert.equal(scrubbed.route, "/v1/checkout");
  assert.ok(!scrubbed.message.includes("?"), "message must have its query string stripped");
  assert.ok(!scrubbed.message.includes("#"), "message must have its fragment stripped");
  assert.ok(!scrubbed.message.includes("someone@example.com"), "an email must be redacted");
  assert.ok(!scrubbed.message.includes("sk-abcdefghijklmnopqrstuvwxyz0123"), "a token must be redacted");
  assert.ok(!scrubbed.message.includes("550e8400-e29b-41d4-a716-446655440000"), "a uuid must be redacted");
  assert.ok(scrubbed.message.includes("[redacted]"), "the redaction marker must be present");

  // The bound: message caps at 500 chars. Short, space-separated words so nothing here matches
  // the 20+-char token pattern above and gets redacted (and shrunk) before the cap applies.
  const long = scrubIncidentEvent(baseInput({ message: "lorem ipsum dolor sit amet ".repeat(30) }));
  assert.equal(long.message.length, 500);

  // The bound: frames cap at 20.
  const manyFrames = scrubIncidentEvent(
    baseInput({ frames: Array.from({ length: 30 }, (_, i) => ({ file: `src/f${i}.ts`, fn: "g" })) }),
  );
  assert.equal(manyFrames.frames.length, 20);
});

test("a malformed body is refused with a 400 and its reason", () => {
  const good = { source: "console", kind: "exception", name: "E", message: "m", at: "2026-09-23T00:00:00Z" };
  const cases: Array<[unknown, RegExp]> = [
    [[], /JSON object/],
    [null, /JSON object/],
    [{ ...good, source: "browser" }, /^source/],
    [{ ...good, kind: "oops" }, /^kind/],
    [{ ...good, name: "" }, /^name/],
    [{ ...good, message: 7 }, /^message/],
    [{ ...good, at: "not a date" }, /^at/],
    [{ ...good, frames: [{ file: "a.ts" }] }, /^frames/],
    [{ ...good, frames: "a.ts" }, /^frames/],
    [{ ...good, route: 1 }, /^route/],
    [{ ...good, sha: 1 }, /^sha/],
  ];
  for (const [body, reason] of cases) {
    const bad = validateIncidentEventBody(body);
    assert.equal(bad.ok, false, JSON.stringify(body));
    if (!bad.ok) assert.match(bad.reason, reason);
  }
  const ok = validateIncidentEventBody({ ...good, frames: [{ file: "src/a.ts", fn: "f" }], route: "/r", sha: "abc" });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.value.frames, [{ file: "src/a.ts", fn: "f" }]);
});

// ── criterion 4: a burst past the per-minute cap is recorded as one sampled count ───────────────

async function withRoute<T>(route: Route, run: (url: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await run(`http://127.0.0.1:${port}${route.path}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("a burst past the per-minute cap is recorded as one sampled count", async () => {
  const root = tmpRoot();
  const ledgerPath = ledgerPathFor(root);
  let nowMs = 1_700_000_000_000;
  const clock: Clock = { ...fixedClock(0), now: () => nowMs };
  const route = buildIncidentEventsRoute({ ledgerPath }, clock, 20);

  const body = JSON.stringify(baseInput({ message: "burst failure" }));
  await withRoute(route, async (url) => {
    for (let i = 0; i < 25; i++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer write", "content-type": "application/json" },
        body,
      });
      const json = (await res.json()) as { fingerprint: string; accepted: boolean; sampled: boolean };
      assert.equal(res.status, 200);
      assert.equal(json.accepted, true);
      assert.equal(json.sampled, i >= 20);
      nowMs += 100; // stay well inside the same 60s window
    }
  });

  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const events = lines.filter((l) => l.step === "incident.event");
  const sampled = lines.filter((l) => l.step === "incident.sampled");
  assert.equal(events.length, 20, "exactly the cap's worth of incident.event rows");
  assert.equal(sampled.length, 1, "exactly ONE incident.sampled row for the whole burst");
  assert.equal(sampled[0].fingerprint, events[0].fingerprint);
  assert.equal(sampled[0].task_id, "INCIDENT");
});

test("a new minute window ledgers the same fingerprint as an incident.event again", async () => {
  const ledgerPath = ledgerPathFor(tmpRoot());
  let nowMs = 1_700_000_000_000;
  const route = buildIncidentEventsRoute({ ledgerPath }, { ...fixedClock(0), now: () => nowMs }, 1);
  const body = JSON.stringify(baseInput({ message: "window failure" }));
  const sampledFlags: boolean[] = [];
  await withRoute(route, async (url) => {
    for (const advance of [0, 0, 60_000]) {
      nowMs += advance;
      const res = await fetch(url, { method: "POST", headers: { authorization: "Bearer write" }, body });
      sampledFlags.push(((await res.json()) as { sampled: boolean }).sampled);
    }
  });
  assert.deepEqual(sampledFlags, [false, true, false]);
  const steps = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l).step);
  assert.deepEqual(steps, ["incident.event", "incident.sampled", "incident.event"]);
});

test("the ingest route refuses invalid JSON, a malformed event, and an oversized body without ledgering", async () => {
  const ledgerPath = ledgerPathFor(tmpRoot());
  const route = buildIncidentEventsRoute({ ledgerPath });
  await withRoute(route, async (url) => {
    const post = (body: string) => fetch(url, { method: "POST", headers: { authorization: "Bearer write" }, body });
    const notJson = await post("{not json");
    assert.equal(notJson.status, 400);
    assert.equal(((await notJson.json()) as { detail: string }).detail, "body is not valid JSON");
    const malformed = await post(JSON.stringify({ source: "console" }));
    assert.equal(malformed.status, 400);
    assert.match(((await malformed.json()) as { detail: string }).detail, /^kind must be/);
    const huge = await post(JSON.stringify(baseInput({ message: "x".repeat(20 * 1024) })));
    assert.equal(huge.status, 413);
    await huge.arrayBuffer();
  });
  assert.equal(readFileSync(ledgerPath, "utf8"), "", "a refused body must never reach the ledger");
});

test("a request stream that errors propagates the error instead of answering", async () => {
  const route = buildIncidentEventsRoute({ ledgerPath: ledgerPathFor(tmpRoot()) });
  const req = new PassThrough() as unknown as IncomingMessage;
  const pending = route.handler(req, {} as ServerResponse, { params: {} });
  (req as unknown as PassThrough).destroy(new Error("socket reset"));
  await assert.rejects(Promise.resolve(pending), /socket reset/);
});

// ── criterion 6: the ingest-only token posts incident events and is refused on every other route

function writePlan(root: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n", { flag: "wx" });
  return planPath;
}

const READ_TOKEN = "incident-events-read-token";
const WRITE_TOKEN = "incident-events-write-token";
const INGEST_TOKEN = "incident-events-ingest-token";

function depsFor(root: string, ingest?: string): ServeDeps {
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root);
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github: fakeGitHub() },
    panelGraph: {
      root,
      planPath,
      ledgerPath,
      github: { prView: () => null },
      statusGithub: fakeGitHub(),
      ratify: { approve: () => {}, reframe: () => {} },
    },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN, ingest },
    daemonHealth: { exec: fakeGhRateLimitExec() },
    pollMs: 50,
    log: () => {},
  };
}

async function withListening<T>(server: ReturnType<typeof buildServeServer>, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("the incident ingest route is mounted in the real assembled table", () => {
  const routes = buildServeRoutes(depsFor(tmpRoot()));
  const found = routes.find((r) => r.path === INCIDENT_INGEST_ROUTE_PATH && r.method === "POST");
  assert.ok(found, "expected POST /v1/incidents/events in the real assembled table");
  assert.equal(found?.scope, "write");
  assert.equal(found?.tier, "low");
});

test("the ingest-only token posts incident events and is refused on every other route", async () => {
  const root = tmpRoot();
  const deps = depsFor(root, INGEST_TOKEN);

  await withListening(buildServeServer(deps), async (base) => {
    // Works on the one route it's meant for.
    const ok = await fetch(`${base}${INCIDENT_INGEST_ROUTE_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(baseInput({ message: "ingest-token-can-post" })),
    });
    const okBody = (await ok.json()) as { accepted: boolean };
    assert.equal(ok.status, 200);
    assert.equal(okBody.accepted, true);

    // Refused on a handful of other real, mounted routes — a read-scoped one and a write-scoped
    // one, both genuinely different paths from the ingest route.
    const otherProbes: Array<{ method: string; path: string }> = [
      { method: "GET", path: "/v1/status" },
      { method: "POST", path: "/v1/control/pause" },
    ];
    for (const probe of otherProbes) {
      const res = await fetch(`${base}${probe.path}`, {
        method: probe.method,
        headers: { authorization: `Bearer ${INGEST_TOKEN}` },
      });
      await res.arrayBuffer();
      assert.equal(res.status, 401, `${probe.method} ${probe.path} with the ingest token must be refused, got ${res.status}`);
    }

    // Calibration: the ordinary write bearer still reaches the ingest route past the ingest provider.
    const viaWrite = await fetch(`${base}${INCIDENT_INGEST_ROUTE_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
      body: JSON.stringify(baseInput({ message: "write-token-can-post" })),
    });
    assert.equal(viaWrite.status, 200);
    await viaWrite.arrayBuffer();
  });
});

test("the ingest token defaults to RMD_SERVE_INGEST_TOKEN and is refused when unset", async () => {
  const post = (base: string) =>
    fetch(`${base}${INCIDENT_INGEST_ROUTE_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer env-ingest-token" },
      body: JSON.stringify(baseInput()),
    });
  const saved = process.env[INGEST_TOKEN_ENV];
  try {
    delete process.env[INGEST_TOKEN_ENV];
    await withListening(buildServeServer(depsFor(tmpRoot())), async (base) => {
      const res = await post(base);
      await res.arrayBuffer();
      assert.equal(res.status, 401, "no ingest token configured means no ingest grantor at all");
    });
    process.env[INGEST_TOKEN_ENV] = "env-ingest-token";
    await withListening(buildServeServer(depsFor(tmpRoot())), async (base) => {
      const res = await post(base);
      await res.arrayBuffer();
      assert.equal(res.status, 200, "the env-sourced ingest token reaches the ingest route");
    });
  } finally {
    if (saved === undefined) delete process.env[INGEST_TOKEN_ENV];
    else process.env[INGEST_TOKEN_ENV] = saved;
  }
});
