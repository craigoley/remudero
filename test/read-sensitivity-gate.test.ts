import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService, type IdentityProvider, type Route } from "../src/lib/service.js";

// ── W1-T495 acceptance, ALL THREE claims, BOTH falsifier directions (design v) ──
//
// Before this task `Scope` was exactly `read | write` -- a GET that returns spend or provenance
// (account-usage, trace) was indistinguishable from a GET that returns a static shell, so any
// role model layered on top would grant the most revealing reads by default. This suite proves
// the READ half of the W1-T404 `WriteTier` axis: `Route.sensitivity` (the per-route label) and
// `IdentityProvider.readSensitivity` (the grant-side entitlement), gated by
// `ServiceOptions.enforceReadSensitivity` -- OFF by default, the exact `enforceWriteTiers`
// precedent (design ii).
//
// Every test drives the real HTTP server `createService` returns (never a mock), the same
// discipline test/write-tier-enforcement.test.ts and test/identity-provider-seam.test.ts follow.

const READ_TOKEN = "sensitivity-read-token";
const WRITE_TOKEN = "sensitivity-write-token";

// A fixture grantor entitled to sensitive reads -- proves the ALLOWED direction without touching
// the two real, built-in providers (neither of which declares `readSensitivity` -- see
// ServiceOptions.enforceReadSensitivity's own doc: this ships dark on both sides).
const SENSITIVE_HEADER = "x-fixture-sensitive-identity";
const SENSITIVE_SECRET = "fixture-sensitive-grantor-secret";
const sensitiveProvider: IdentityProvider = {
  name: "fixture-sensitive-provider",
  grant: (req) => (req.headers[SENSITIVE_HEADER] === SENSITIVE_SECRET ? new Set(["read"]) : undefined),
  readSensitivity: "sensitive",
};

let sensitiveHandlerCalls = 0;

function buildRoutes(): Route[] {
  sensitiveHandlerCalls = 0;
  return [
    {
      method: "GET",
      path: "/v1/ordinary",
      scope: "read",
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    {
      method: "GET",
      path: "/v1/sensitive",
      scope: "read",
      sensitivity: "sensitive",
      handler: (_req, res) => {
        sensitiveHandlerCalls++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ spend: 42 }));
      },
    },
  ];
}

async function withServer<T>(enforceReadSensitivity: boolean, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    providers: [sensitiveProvider],
    routes: buildRoutes(),
    enforceReadSensitivity,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

// ── claim 1: flag ON, both directions -- the label discriminates ──

test("flag ON: an ordinary read grant is refused on the sensitive-labelled route, naming the required sensitivity", async () => {
  await withServer(true, async (base) => {
    const res = await fetch(`${base}/v1/sensitive`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string; required_scope: string; required_sensitivity: string };
    assert.equal(body.error, "forbidden");
    assert.equal(body.required_scope, "read");
    assert.equal(body.required_sensitivity, "sensitive", "the refusal must SAY which sensitivity it required");
    assert.equal(sensitiveHandlerCalls, 0, "a refused request must never reach the handler");
  });
});

test("flag ON: the SAME ordinary read grant is allowed on the unlabelled read route -- the label discriminates, not a blanket downgrade", async () => {
  await withServer(true, async (base) => {
    const res = await fetch(`${base}/v1/ordinary`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("flag ON: a grant that IS entitled to sensitive reads is allowed on the sensitive-labelled route", async () => {
  await withServer(true, async (base) => {
    const res = await fetch(`${base}/v1/sensitive`, { headers: { [SENSITIVE_HEADER]: SENSITIVE_SECRET } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { spend: 42 });
    assert.equal(sensitiveHandlerCalls, 1);
  });
});

// ── claim 2: flag OFF, both routes behave exactly as today -- the mechanism is inert ──

test("flag OFF: the ordinary read grant reaches the sensitive-labelled route exactly as it does today", async () => {
  await withServer(false, async (base) => {
    const sensitive = await fetch(`${base}/v1/sensitive`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(sensitive.status, 200, "mounting the label must not, by itself, change what a caller can reach");
    assert.deepEqual(await sensitive.json(), { spend: 42 });

    const ordinary = await fetch(`${base}/v1/ordinary`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(ordinary.status, 200);
  });
});

// ── claim 3: the refusal is decided inside dispatch, before any handler runs, failing closed ──

test("flag ON: no credential at all still 401s before sensitivity is even consulted", async () => {
  await withServer(true, async (base) => {
    const res = await fetch(`${base}/v1/sensitive`);
    assert.equal(res.status, 401);
    assert.equal(sensitiveHandlerCalls, 0);
  });
});

test("flag ON: the plain scope check refuses first -- an unscoped credential never reaches the sensitivity check", async () => {
  await withServer(true, async (base) => {
    const res = await fetch(`${base}/v1/sensitive`, { headers: { authorization: `Bearer not-a-real-token` } });
    assert.equal(res.status, 401, "unrecognized token stays 401, distinct from a scoped-but-underscoped 403");
    assert.equal(sensitiveHandlerCalls, 0);
  });
});
