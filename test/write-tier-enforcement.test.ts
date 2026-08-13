import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService, type Route } from "../src/lib/service.js";

// ── W1-T404 acceptance 1: "a high-consequence route refuses a credential that carries only the
// ordinary write grant, and says which tier it required" ──
//
// The MECHANISM (Route.tier + ServiceOptions.enforceWriteTiers), exercised the same way
// test/service.test.ts's own generic scope falsifier is -- a real HTTP server, real routes, no
// mock. `enforceWriteTiers` is OFF by default (see its own doc in src/lib/service.ts); every
// test below turns it ON explicitly, which is what proves the gate is real rather than assumed.

const READ_TOKEN = "enforcement-read-token";
const WRITE_TOKEN = "enforcement-write-token"; // the "ordinary write grant" -- resolves tier "low".

function buildHighTierRoute(): Route {
  return {
    method: "POST",
    path: "/v1/high",
    scope: "write",
    tier: "high",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ran: true }));
    },
  };
}

async function withServer<T>(routes: Route[], fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes, enforceWriteTiers: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("HIGH-tier route: the ordinary write grant (bearer token, tier low) is refused, naming the required tier", async () => {
  await withServer([buildHighTierRoute()], async (base) => {
    const res = await fetch(`${base}/v1/high`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string; required_scope: string; required_tier: string };
    assert.equal(body.error, "forbidden");
    assert.equal(body.required_scope, "write");
    assert.equal(body.required_tier, "high", "the refusal must SAY which tier it required");
  });
});

test("HIGH-tier route: no credential at all still 401s before any tier is even consulted", async () => {
  await withServer([buildHighTierRoute()], async (base) => {
    const res = await fetch(`${base}/v1/high`, { method: "POST" });
    assert.equal(res.status, 401);
  });
});

test("HIGH-tier route: a read-only token is refused on plain scope, not tier -- the two checks are independent", async () => {
  await withServer([buildHighTierRoute()], async (base) => {
    const res = await fetch(`${base}/v1/high`, { method: "POST", headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { required_scope: string; required_tier?: string };
    assert.equal(body.required_scope, "write");
    assert.equal(body.required_tier, undefined, "the scope check refuses first; tier is never reached");
  });
});
