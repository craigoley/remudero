import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService, type IdentityProvider, type Route } from "../src/lib/service.js";

// ── W1-T430: the auth/identity seam (MASTER-PLAN §6A) ──
//
// §6A names "notifier, VCS, storage, auth/identity, model routing" as extension seams that must
// be first-class plugin interfaces, with a stable contract, BEFORE any Pro/hosted code exists.
// Before this task, scope-granting was two paths inlined into service.ts's dispatch with no
// declared interface a third grantor could implement. This suite is the falsifier named in the
// task's own design note (iv), BOTH directions:
//
//   1. The two existing grantors (bearer token, tailnet identity) pass the CURRENT auth contract
//      through the seam unchanged (401 unknown / 403 underscoped / write⊇read all preserved) --
//      regressing either real provider fails this direction.
//   2. A fixture THIRD provider, registered via `ServiceOptions.providers`, grants a scope the
//      two real providers would refuse -- proving the seam admits a new grantor WITHOUT editing
//      service.ts's dispatch. Deleting the seam's dispatch (i.e. only ever consulting the first
//      provider, or never consulting `providers` at all) fails this direction.
//
// Every test drives the real HTTP server `createService` returns (never a mock), the same
// discipline test/service.test.ts and test/tailnet-identity-scope.test.ts already follow.

const READ_TOKEN = "seam-read-token-abc123";
const WRITE_TOKEN = "seam-write-token-xyz789";
const CAPABILITY = "example.com/cap/console-write";

/** A fixture third grantor: recognizes ONE bespoke header the two real providers know nothing
 * about, and grants write scope for it. Proves an `IdentityProvider` implementation outside
 * service.ts's own file can attach to the seam. */
const FIXTURE_HEADER = "x-fixture-identity";
const FIXTURE_SECRET = "fixture-grantor-secret";
const fixtureProvider: IdentityProvider = {
  name: "fixture-third-provider",
  grant: (req) => {
    const value = req.headers[FIXTURE_HEADER];
    if (value !== FIXTURE_SECRET) return undefined;
    return new Set(["read", "write"]);
  },
};

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

async function withServer<T>(
  server: ReturnType<typeof createService>,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

// ── direction 1: the seam is a declared interface, not a convention ──

test("seam: IdentityProvider is a declared, importable interface", () => {
  // The fixture above is a compile-time proof: it implements `IdentityProvider` and is accepted
  // by `ServiceOptions.providers` below without touching service.ts. If the seam's dispatch were
  // deleted (createService stopped consulting `providers`), this file would still typecheck --
  // the runtime tests below are what actually falsify that.
  assert.equal(fixtureProvider.name, "fixture-third-provider");
  assert.equal(typeof fixtureProvider.grant, "function");
});

// ── direction 1 (byte-identical semantics): the two real grantors, through the seam ──

test("seam: the bearer-token grantor passes the current auth contract unchanged through the seam", async () => {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildRoutes() });
  await withServer(server, async (base) => {
    // 401: no credential at all.
    const anon = await fetch(`${base}/state`);
    assert.equal(anon.status, 401);

    // 401: unrecognized token (not 403 -- unknown stays indistinguishable from absent).
    const unknown = await fetch(`${base}/state`, { headers: { authorization: "Bearer not-a-real-token" } });
    assert.equal(unknown.status, 401);

    // 403: recognized read token on a write-scoped route.
    const underscoped = await fetch(`${base}/control/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(underscoped.status, 403);
    assert.equal(((await underscoped.json()) as { required_scope: string }).required_scope, "write");

    // write ⊇ read: the write token satisfies both a write route and a read route.
    const write = await fetch(`${base}/control/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    });
    assert.equal(write.status, 200);
    const readViaWrite = await fetch(`${base}/state`, { headers: { authorization: `Bearer ${WRITE_TOKEN}` } });
    assert.equal(readViaWrite.status, 200);
  });
});

test("seam: the tailnet-identity grantor passes the current auth contract unchanged through the seam", async () => {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    identity: { trustedLocalAddress: "127.0.0.1", capability: CAPABILITY },
    routes: buildRoutes(),
  });
  await withServer(server, async (base) => {
    // Allowlisted identity, no bearer token anywhere -- grants write (and read, write ⊇ read).
    const capHeader = { "tailscale-app-capabilities": JSON.stringify({ [CAPABILITY]: [{ role: "member" }] }) };
    const write = await fetch(`${base}/control/pause`, { method: "POST", headers: capHeader });
    assert.equal(write.status, 200);
    const read = await fetch(`${base}/state`, { headers: capHeader });
    assert.equal(read.status, 200);

    // An unlisted node's identity grants nothing -- 401, not a bypass.
    const wrongCap = await fetch(`${base}/control/pause`, {
      method: "POST",
      headers: { "tailscale-app-capabilities": JSON.stringify({ "example.com/cap/other": [{ role: "member" }] }) },
    });
    assert.equal(wrongCap.status, 401);

    // Identity absent entirely -- the bearer token still authenticates exactly as before
    // (additive, not a replacement): read token still 403s on the write route.
    const tokenOnly = await fetch(`${base}/control/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(tokenOnly.status, 403);
  });
});

// ── direction 2: a fixture third provider grants a scope the two real ones would refuse ──

test("seam: a fixture third provider grants scope through ServiceOptions.providers without editing the gate", async () => {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    identity: { trustedLocalAddress: "127.0.0.1", capability: CAPABILITY },
    providers: [fixtureProvider],
    routes: buildRoutes(),
  });
  await withServer(server, async (base) => {
    // Neither real grantor recognizes this header -- the bearer token and tailnet identity
    // would BOTH refuse it (unrecognized credential, wrong shape entirely). Only the fixture
    // provider, admitted purely through `ServiceOptions.providers`, grants it.
    const fixtureHeaders = { [FIXTURE_HEADER]: FIXTURE_SECRET };
    const write = await fetch(`${base}/control/pause`, { method: "POST", headers: fixtureHeaders });
    assert.equal(write.status, 200);
    assert.deepEqual(await write.json(), { paused: true });

    const read = await fetch(`${base}/state`, { headers: fixtureHeaders });
    assert.equal(read.status, 200);

    // The real grantors' own refusal is untouched: garbage in the fixture header's slot (wrong
    // secret) still 401s -- the fixture provider isn't a blanket bypass, only its exact credential.
    const wrongSecret = await fetch(`${base}/state`, { headers: { [FIXTURE_HEADER]: "not-the-secret" } });
    assert.equal(wrongSecret.status, 401);
  });
});

test("seam: an unknown/unregistered provider still grants nothing -- deny stays the default", async () => {
  // No `providers` option at all: the fixture credential is meaningless without being
  // registered, exactly like an unrecognized bearer token -- 401, never a bypass.
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildRoutes() });
  await withServer(server, async (base) => {
    const res = await fetch(`${base}/state`, { headers: { [FIXTURE_HEADER]: FIXTURE_SECRET } });
    assert.equal(res.status, 401);
  });
});
