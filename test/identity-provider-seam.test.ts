import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  createService,
  cloudflareAccessIdentityProvider,
  type CloudflareAccessJwk,
  type CloudflareAccessKeyCache,
  type IdentityProvider,
  type Route,
} from "../src/lib/service.js";

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

// ── W1-T531: the third grantor -- Cloudflare Access JWT (MASTER-PLAN §6A) ──
//
// Same seam, third adopter: `cloudflareAccessIdentityProvider` validates the
// `Cf-Access-Jwt-Assertion` header's SIGNATURE against a cached key set rather than trusting the
// header's mere presence, and must never throw -- `grant` runs inside `createService`'s
// unawaited, uncaught `void (async () => { ... })()`, so an exception here would kill the whole
// process rather than deny one request.

const ACCESS_TEAM_DOMAIN = "https://example.cloudflareaccess.com";
const ACCESS_AUDIENCE = "console-app-tag";
const ACCESS_KID = "seam-test-kid";

const { publicKey: accessPublicKey, privateKey: accessPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// A second, unrelated keypair -- stands in for an ATTACKER who does not hold Cloudflare's real
// private key but can still craft a syntactically valid, correctly-shaped JWT.
const { privateKey: forgedPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function accessJwk(): CloudflareAccessJwk {
  const jwk = accessPublicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { ...jwk, kid: ACCESS_KID } as CloudflareAccessJwk;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/** Build a Cloudflare-Access-shaped JWT signed with the given key -- `signingKey` defaults to the
 *  real key so most callers only ever override the claims or the kid to construct a bad token. */
function makeAccessAssertion(opts: {
  claims?: Record<string, unknown>;
  kid?: string;
  alg?: string;
  signingKey?: KeyObject;
}): string {
  const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? ACCESS_KID };
  const claims = {
    iss: ACCESS_TEAM_DOMAIN,
    aud: [ACCESS_AUDIENCE],
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "operator@example.com",
    ...opts.claims,
  };
  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), opts.signingKey ?? accessPrivateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function cachedKeys(keys: readonly CloudflareAccessJwk[] | undefined): CloudflareAccessKeyCache {
  return { keys: () => keys };
}

function buildAccessRoutes(): Route[] {
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
  ];
}

test("W1-T531: an access grant validates the assertion rather than trusting the header", async () => {
  const provider = cloudflareAccessIdentityProvider({
    teamDomain: ACCESS_TEAM_DOMAIN,
    audience: ACCESS_AUDIENCE,
    keys: cachedKeys([accessJwk()]),
  });
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    providers: [provider],
    routes: buildAccessRoutes(),
  });
  await withServer(server, async (base) => {
    // A correctly signed assertion (real key, matching kid/claims) is granted.
    const valid = await fetch(`${base}/state`, {
      headers: { "cf-access-jwt-assertion": makeAccessAssertion({}) },
    });
    assert.equal(valid.status, 200);

    // The load-bearing case: an assertion with the IDENTICAL header and claims -- same kid, same
    // iss/aud/exp -- but signed by a DIFFERENT private key (an attacker who never had
    // Cloudflare's real key) must be refused. If this provider trusted the header's mere
    // presence/shape rather than verifying the signature against the cached public key, this
    // forged token would pass exactly like the valid one above.
    const forged = await fetch(`${base}/state`, {
      headers: { "cf-access-jwt-assertion": makeAccessAssertion({ signingKey: forgedPrivateKey }) },
    });
    assert.equal(forged.status, 401);

    // A bare, non-JWT string in the header is also just "not my credential" -- 401, not a crash.
    const garbage = await fetch(`${base}/state`, { headers: { "cf-access-jwt-assertion": "not-a-jwt-at-all" } });
    assert.equal(garbage.status, 401);
  });
});

test("W1-T531: an unreadable key set denies and never grants", async () => {
  // The cache never populated (e.g. no successful fetch yet) -- `keys()` returns `undefined`, so
  // even a CORRECTLY signed, fully valid assertion has no key to verify against.
  const provider = cloudflareAccessIdentityProvider({
    teamDomain: ACCESS_TEAM_DOMAIN,
    audience: ACCESS_AUDIENCE,
    keys: cachedKeys(undefined),
  });
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    providers: [provider],
    routes: buildAccessRoutes(),
  });
  await withServer(server, async (base) => {
    const res = await fetch(`${base}/state`, {
      headers: { "cf-access-jwt-assertion": makeAccessAssertion({}) },
    });
    assert.equal(res.status, 401);
  });
});

test("W1-T531: a throwing validator cannot take the console down", async () => {
  // A key cache whose `keys()` itself throws -- stands in for "network failure, rotated key,
  // malformed key set" (rationale 4), the exact class of failure a JWT validator is prone to.
  const throwingKeys: CloudflareAccessKeyCache = {
    keys: () => {
      throw new Error("simulated key-cache failure");
    },
  };
  const provider = cloudflareAccessIdentityProvider({
    teamDomain: ACCESS_TEAM_DOMAIN,
    audience: ACCESS_AUDIENCE,
    keys: throwingKeys,
  });
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    providers: [provider],
    routes: buildAccessRoutes(),
  });
  await withServer(server, async (base) => {
    // The throwing provider denies rather than crashing the request...
    const res = await fetch(`${base}/state`, {
      headers: { "cf-access-jwt-assertion": makeAccessAssertion({}) },
    });
    assert.equal(res.status, 401);

    // ...and, more importantly, the SERVER PROCESS is still alive to answer the NEXT request --
    // if `grant`'s throw had propagated out of `createService`'s unawaited, uncaught IIFE, the
    // whole test process would be gone and this second request would never get a response at
    // all (not even a clean 401/500).
    const stillAlive = await fetch(`${base}/state`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(stillAlive.status, 200);
  });
});

test("W1-T531: the tailnet provider still grants when access declines", async () => {
  // Both the tailnet identity grantor AND the Cloudflare Access provider are configured, but the
  // request carries only tailnet identity headers -- no `Cf-Access-Jwt-Assertion` at all, so the
  // access provider recognizes nothing here and declines (`undefined`, not a denial of the whole
  // request). Additive by construction (design i): registering the third provider must not take
  // anything away from the first.
  const provider = cloudflareAccessIdentityProvider({
    teamDomain: ACCESS_TEAM_DOMAIN,
    audience: ACCESS_AUDIENCE,
    keys: cachedKeys([accessJwk()]),
  });
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    identity: { trustedLocalAddress: "127.0.0.1", capability: CAPABILITY },
    providers: [provider],
    routes: buildRoutes(),
  });
  await withServer(server, async (base) => {
    const capHeader = { "tailscale-app-capabilities": JSON.stringify({ [CAPABILITY]: [{ role: "member" }] }) };
    const write = await fetch(`${base}/control/pause`, { method: "POST", headers: capHeader });
    assert.equal(write.status, 200);
    const read = await fetch(`${base}/state`, { headers: capHeader });
    assert.equal(read.status, 200);
  });
});
