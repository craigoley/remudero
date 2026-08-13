import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService, createConfirmNonceStore, makeConfirmNonceRoute, type IdentityProvider, type Route } from "../src/lib/service.js";

// ── W1-T404 acceptance 6: "the second factor is checked by the server, so a request made
// outside the console cannot skip it" ──
//
// design (iv), ruled 2026-08-13, option (c): a server-issued, single-use, action-and-payload-
// bound confirm nonce. Every call here is a bare `fetch` -- no browser, no console JS, exactly
// "outside the console" -- proving the SERVER itself is what refuses a HIGH-tier call with no
// nonce, not a client-side guard that a direct HTTP caller could simply not run.
//
// The credential below already satisfies tier HIGH (a synthetic provider, same W1-T430 seam
// test/write-tier-middle-tier.test.ts uses) so every refusal in this suite is the NONCE check
// specifically, never the tier check from test/write-tier-enforcement.test.ts.

const READ_TOKEN = "second-factor-read-token";
const WRITE_TOKEN = "second-factor-write-token";
const HIGH_HEADER = "x-high-grant";
const HIGH_SECRET = "high-grant-secret";

const highGrantProvider: IdentityProvider = {
  name: "test-high-provider",
  grant: (req) => (req.headers[HIGH_HEADER] === HIGH_SECRET ? new Set(["read", "write"] as const) : undefined),
  writeTier: "high",
};

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

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const store = createConfirmNonceStore();
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: [makeConfirmNonceRoute(store), buildHighTierRoute()],
    enforceWriteTiers: true,
    confirmNonces: store,
    providers: [highGrantProvider],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const HIGH_AUTH = { [HIGH_HEADER]: HIGH_SECRET };

test("HIGH-tier route: a fully-scoped, fully-tiered credential is STILL refused with no nonce", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/high`, { method: "POST", headers: { ...HIGH_AUTH, "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "confirm_nonce_required");
  });
});

test("HIGH-tier route: a server-issued nonce for this EXACT action+payload, presented once, succeeds", async () => {
  await withServer(async (base) => {
    const payload = JSON.stringify({ taskId: "W1-T1" });

    const issued = await fetch(`${base}/v1/confirm`, {
      method: "POST",
      headers: { ...HIGH_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ method: "POST", path: "/v1/high", payload }),
    });
    assert.equal(issued.status, 200);
    const { nonce } = (await issued.json()) as { nonce: string };
    assert.ok(nonce && nonce.length > 0, "the server must issue a real nonce");

    const ran = await fetch(`${base}/v1/high`, {
      method: "POST",
      headers: { ...HIGH_AUTH, "content-type": "application/json", "x-confirm-nonce": nonce },
      body: payload,
    });
    assert.equal(ran.status, 200);
    assert.deepEqual(await ran.json(), { ran: true });
  });
});

test("HIGH-tier route: the SAME nonce cannot be replayed -- single-use, even against the identical action", async () => {
  await withServer(async (base) => {
    const payload = JSON.stringify({ taskId: "W1-T1" });
    const issued = await fetch(`${base}/v1/confirm`, {
      method: "POST",
      headers: { ...HIGH_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ method: "POST", path: "/v1/high", payload }),
    });
    const { nonce } = (await issued.json()) as { nonce: string };

    const first = await fetch(`${base}/v1/high`, { method: "POST", headers: { ...HIGH_AUTH, "x-confirm-nonce": nonce }, body: payload });
    assert.equal(first.status, 200);

    const replay = await fetch(`${base}/v1/high`, { method: "POST", headers: { ...HIGH_AUTH, "x-confirm-nonce": nonce }, body: payload });
    assert.equal(replay.status, 403);
    assert.equal(((await replay.json()) as { error: string }).error, "confirm_nonce_required");
  });
});

test("HIGH-tier route: a nonce issued for a DIFFERENT payload does not authorize this one -- action-bound, not just route-bound", async () => {
  await withServer(async (base) => {
    const issuedPayload = JSON.stringify({ taskId: "W1-T1" });
    const issued = await fetch(`${base}/v1/confirm`, {
      method: "POST",
      headers: { ...HIGH_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ method: "POST", path: "/v1/high", payload: issuedPayload }),
    });
    const { nonce } = (await issued.json()) as { nonce: string };

    const differentPayload = JSON.stringify({ taskId: "W1-T2" });
    const res = await fetch(`${base}/v1/high`, { method: "POST", headers: { ...HIGH_AUTH, "x-confirm-nonce": nonce }, body: differentPayload });
    assert.equal(res.status, 403);
  });
});
