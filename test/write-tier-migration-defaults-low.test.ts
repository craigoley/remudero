import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService, type Route, type WriteTier } from "../src/lib/service.js";

// ── W1-T404 acceptance 7: "an existing write credential resolves to the LOW tier, so the change
// cannot ship as a silent grant of everything" ──
//
// design (v), THE SHARPEST RULING IN THE TASK: if the existing bearer write token defaulted to
// HIGH, tiering would ship as a no-op that silently re-grants everything. Proven here by
// bracketing the boundary with the REAL, unmodified bearer-token grantor (no synthetic
// providers) -- the SAME single write token an operator already has today, against three
// otherwise-identical routes that differ only in declared tier.

const READ_TOKEN = "migration-read-token";
const WRITE_TOKEN = "migration-write-token";

function routeAtTier(tier: WriteTier): Route {
  return {
    method: "POST",
    path: `/v1/${tier}`,
    scope: "write",
    tier,
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, tier }));
    },
  };
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: [routeAtTier("low"), routeAtTier("middle"), routeAtTier("high")],
    enforceWriteTiers: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

async function callTier(base: string, tier: WriteTier): Promise<Response> {
  return fetch(`${base}/v1/${tier}`, { method: "POST", headers: { authorization: `Bearer ${WRITE_TOKEN}` } });
}

test("the existing write token: exactly LOW is reachable -- never a silent grant of everything", async () => {
  await withServer(async (base) => {
    const low = await callTier(base, "low");
    assert.equal(low.status, 200, "the write token must keep bookkeeping");

    const middle = await callTier(base, "middle");
    assert.equal(middle.status, 403);
    assert.equal(((await middle.json()) as { required_tier: string }).required_tier, "middle");

    const high = await callTier(base, "high");
    assert.equal(high.status, 403);
    assert.equal(((await high.json()) as { required_tier: string }).required_tier, "high");
  });
});
