import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService, type Route } from "../src/lib/service.js";

// ── W1-T404 acceptance 2: "a bookkeeping route still accepts the ordinary write grant, so the
// common path is not made ceremonious" ──
//
// Mirrors test/write-tier-enforcement.test.ts's harness exactly, at the OPPOSITE pole: a
// LOW-tier route, with `enforceWriteTiers: true` (the mechanism turned all the way on), must
// still be a one-token, no-nonce, no-extra-round-trip call -- exactly what it is today.

const READ_TOKEN = "low-path-read-token";
const WRITE_TOKEN = "low-path-write-token";

function buildLowTierRoute(): Route {
  return {
    method: "POST",
    path: "/v1/low",
    scope: "write",
    tier: "low",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  };
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: [buildLowTierRoute()], enforceWriteTiers: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("LOW-tier route: the ordinary write grant succeeds in ONE call -- no nonce header, no second round trip", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/low`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("LOW-tier route: a read-only token is still refused (scope, unrelated to tier)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/low`, { method: "POST", headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 403);
  });
});
