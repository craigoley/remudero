import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService, type IdentityAuth, type Route } from "../src/lib/service.js";

// ── W1-T371: tailnet-identity auth, additive to the bearer tokens (MASTER-PLAN §7's
// auth-endgame -- the "preferred" half of W1-T202; token-paste-once, the "acceptable" half,
// shipped in #892). Every test drives the real HTTP server `createService` returns (never a
// mock), the same discipline test/service.test.ts's own header states -- this is the generic
// auth MECHANISM's own falsifier.
//
// The service under test binds real 127.0.0.1 -- so `req.socket.localAddress` really is
// "127.0.0.1" for every request these tests send. That lets `trustedLocalAddress` itself be
// the falsifier for the interface gate: set it to the REAL bind address to prove identity is
// honored, or to an address that can never match a request actually arriving on this socket
// (a TEST-NET-3 address, RFC 5737 -- never routable, never a real bind) to prove it is refused
// on "any OTHER bound interface" without needing OS-level multi-homing in a unit test.

const READ_TOKEN = "identity-read-token-abc123";
const WRITE_TOKEN = "identity-write-token-xyz789";
const CAPABILITY = "example.com/cap/console-write";
const NOT_TRUSTED_INTERFACE = "203.0.113.9"; // RFC 5737 TEST-NET-3 -- never a real local bind.

function buildRoutes(): Route[] {
  return [
    {
      method: "GET",
      path: "/state",
      scope: "read",
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    {
      method: "POST",
      path: "/control/pause",
      scope: "write",
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ paused: true }));
      },
    },
  ];
}

async function withIdentityService<T>(identity: IdentityAuth, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, identity, routes: buildRoutes() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function capabilityHeader(name: string): Record<string, string> {
  return { "tailscale-app-capabilities": JSON.stringify({ [name]: [{ role: "member" }] }) };
}

test("tailnet identity: an allowlisted identity on the trusted interface grants write scope with NO bearer token anywhere", async () => {
  await withIdentityService({ trustedLocalAddress: "127.0.0.1", capability: CAPABILITY }, async (base) => {
    // No Authorization header, no ?token= query param -- the credential is REMOVED, not
    // relocated. Hits a write-scoped route directly.
    const res = await fetch(`${base}/control/pause`, {
      method: "POST",
      headers: capabilityHeader(CAPABILITY),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { paused: true });

    // Same identity, same request, also satisfies a read-scoped route on the same port.
    const read = await fetch(`${base}/state`, { headers: capabilityHeader(CAPABILITY) });
    assert.equal(read.status, 200);
  });
});

test("tailnet identity: a forged header arriving on any OTHER bound interface grants nothing", async () => {
  // trustedLocalAddress is configured to an address this test server can never actually be
  // reached on -- simulating a request landing on a DIFFERENT bound interface (e.g. the
  // tailnet IP this service may also bind directly) than the one Serve's proxy delivers to.
  await withIdentityService({ trustedLocalAddress: NOT_TRUSTED_INTERFACE, capability: CAPABILITY }, async (base) => {
    const res = await fetch(`${base}/control/pause`, {
      method: "POST",
      headers: capabilityHeader(CAPABILITY), // a perfectly well-formed, correctly-named header
    });
    // No token was presented either, so this is indistinguishable from no auth at all: 401.
    assert.equal(res.status, 401);
  });
});

test("tailnet identity: an unlisted node's identity (no grant for the configured capability) grants nothing", async () => {
  await withIdentityService({ trustedLocalAddress: "127.0.0.1", capability: CAPABILITY }, async (base) => {
    // Right interface, real Tailscale-App-Capabilities header, but this node/user was never
    // granted `CAPABILITY` by the operator's ACL -- e.g. the appliance sharing the phone's
    // tailnet login (design note iii: the same account, a different node).
    const wrongCapability = await fetch(`${base}/control/pause`, {
      method: "POST",
      headers: capabilityHeader("example.com/cap/something-else"),
    });
    assert.equal(wrongCapability.status, 401);

    // No capabilities granted at all (header simply absent) -- same result.
    const noHeader = await fetch(`${base}/control/pause`, { method: "POST" });
    assert.equal(noHeader.status, 401);

    // A malformed header (never valid JSON) is refused, not crashed on.
    const malformed = await fetch(`${base}/control/pause`, {
      method: "POST",
      headers: { "tailscale-app-capabilities": "not-json{" },
    });
    assert.equal(malformed.status, 401);
  });
});

test("tailnet identity: with no identity presented, the bearer token still authenticates exactly as before", async () => {
  await withIdentityService({ trustedLocalAddress: "127.0.0.1", capability: CAPABILITY }, async (base) => {
    // No Tailscale-App-Capabilities header at all -- e.g. Tailscale itself is down or the
    // request never went through Serve. The write token still grants write (and read).
    const write = await fetch(`${base}/control/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    });
    assert.equal(write.status, 200);

    // The read token still only grants read -- unchanged 403 on the write route.
    const readOnWrite = await fetch(`${base}/control/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(readOnWrite.status, 403);

    const read = await fetch(`${base}/state`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(read.status, 200);

    // No token, no identity -- still 401, exactly as before W1-T371.
    const none = await fetch(`${base}/state`);
    assert.equal(none.status, 401);
  });
});
