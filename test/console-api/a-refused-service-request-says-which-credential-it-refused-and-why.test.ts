import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign as signBytes, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import {
  cloudflareAccessIdentityProvider,
  createService,
  ingestTokenProvider,
  OPERATOR_SESSION_HEADER,
  operatorSessionIdentityProvider,
  type OperatorJwk,
  type Route,
} from "#src/lib/service.js";

// ── W1-T13181 — A REFUSED SERVICE REQUEST SAYS WHICH CREDENTIAL IT CARRIED AND WHY ──────────────
//
// MEASURED 2026-11-16: 17 `service.unauthorized` rows for POST /v1/i/core/inbox/thread/read named
// only { method, path }, so nobody could tell a missing credential from a token serve does not know.
// This suite drives the real `createService` with the real providers (operator session, bearer,
// Cloudflare Access, ingest token) and reads the row the 401 writes.

const READ_TOKEN = `read-${randomBytes(16).toString("hex")}`;
const WRITE_TOKEN = `write-${randomBytes(16).toString("hex")}`;
const INGEST_TOKEN = `ingest-${randomBytes(16).toString("hex")}`;
const STRANGER_TOKEN = `stranger-${randomBytes(16).toString("hex")}`;
const ISSUER = "https://clerk.console.example";
const ORIGIN = "https://console.example";
const OPERATOR = "user_operator";
const NOW_MS = Date.UTC(2026, 10, 16, 13, 30, 0);
const NOW_S = NOW_MS / 1000;
const READ_MARK_PATH = "/v1/i/core/inbox/thread/read";

const REASONS = new Set([
  "no_credential",
  "unknown_token",
  "malformed_header",
  "expired_session",
  "unknown_session",
  "unverified_access",
  "untrusted_identity",
  "other_route",
  "not_granted",
]);

interface Signer {
  jwk: OperatorJwk;
  privateKey: KeyObject;
}

function makeSigner(kid: string): Signer {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid, kty: "RSA", alg: "RS256" } as OperatorJwk;
  return { jwk, privateKey };
}

const known = makeSigner("kid-known");
const stranger = makeSigner("kid-stranger");

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

function sessionToken(signer: Signer, claims: Record<string, unknown> = {}): string {
  const head = b64({ alg: "RS256", typ: "JWT", kid: signer.jwk.kid });
  const body = b64({ iss: ISSUER, sub: OPERATOR, azp: ORIGIN, iat: NOW_S - 10, nbf: NOW_S - 10, exp: NOW_S + 50, fva: [120, -1], ...claims });
  const signature = signBytes("RSA-SHA256", Buffer.from(`${head}.${body}`), signer.privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
}

const fixedClock: Clock = { now: () => NOW_MS, date: () => new Date(NOW_MS), iso: () => new Date(NOW_MS).toISOString() };

interface Row {
  step: string;
  extra: Record<string, unknown>;
}

function handler(status: number): Route["handler"] {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  };
}

async function withService<T>(fn: (base: string, rows: Row[]) => Promise<T>): Promise<T> {
  const rows: Row[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}): void => {
    rows.push({ step, extra });
  };
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    operatorSession: operatorSessionIdentityProvider({
      issuer: ISSUER,
      allowedOrigins: [ORIGIN],
      operatorUserIds: [OPERATOR],
      keys: { key: async (kid) => (kid === known.jwk.kid ? known.jwk : undefined) },
      clock: fixedClock,
      log,
    }),
    providers: [
      cloudflareAccessIdentityProvider({ teamDomain: "https://team.example", audience: "aud", keys: { keys: () => [] }, now: () => NOW_MS, log }),
      ingestTokenProvider({ token: INGEST_TOKEN, method: "POST", path: "/v1/ingest" }),
    ],
    routes: [
      { method: "GET", path: "/v1/state", scope: "read", handler: handler(200) },
      { method: "POST", path: READ_MARK_PATH, scope: "write", handler: handler(200) },
      { method: "POST", path: "/v1/ingest", scope: "write", handler: handler(200) },
    ],
    log,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, rows);
  } finally {
    server.close();
  }
}

async function send(base: string, path: string, headers: Record<string, string>, method = "POST") {
  const res = await fetch(`${base}${path}`, { method, headers });
  return { status: res.status, body: (await res.json()) as unknown };
}

function unauthorizedRows(rows: Row[]): Row[] {
  return rows.filter((r) => r.step === "service.unauthorized");
}

function reasonOf(row: Row, provider: string): unknown {
  const refusals = row.extra.refusals as Array<{ provider: string; reason: string }>;
  return refusals.find((r) => r.provider === provider)?.reason;
}

test("W1-T13181 criterion 1 — no credential: presented none and every provider says no_credential", async () => {
  await withService(async (base, rows) => {
    const res = await send(base, READ_MARK_PATH, {});
    assert.equal(res.status, 401);
    const refused = unauthorizedRows(rows);
    assert.equal(refused.length, 1, "one row per refused request");
    const row = refused[0];
    assert.equal(row.extra.method, "POST");
    assert.equal(row.extra.path, READ_MARK_PATH);
    assert.deepEqual(row.extra.presented, ["none"]);
    assert.deepEqual(row.extra.refusals, [
      { provider: "operator-session", reason: "no_credential" },
      { provider: "bearer-token", reason: "no_credential" },
      { provider: "cloudflare-access", reason: "no_credential" },
      { provider: "ingest-token", reason: "no_credential" },
    ]);
  });
});

test("W1-T13181 criterion 2 — a stranger bearer says unknown_token; a bad session says its reason; both are named", async () => {
  await withService(async (base, rows) => {
    await send(base, READ_MARK_PATH, { authorization: `Bearer ${STRANGER_TOKEN}` });
    await send(base, READ_MARK_PATH, { [OPERATOR_SESSION_HEADER]: sessionToken(known, { exp: NOW_S - 600 }) });
    await send(base, READ_MARK_PATH, { [OPERATOR_SESSION_HEADER]: sessionToken(stranger) });
    await send(base, READ_MARK_PATH, { authorization: `Bearer ${STRANGER_TOKEN}`, [OPERATOR_SESSION_HEADER]: sessionToken(stranger) });
    await send(base, READ_MARK_PATH, { authorization: "Token not-a-bearer" });
    await send(base, READ_MARK_PATH, { authorization: `Bearer ${INGEST_TOKEN}` });
    const [bearer, expired, unknown, both, malformed, ingestElsewhere] = unauthorizedRows(rows);

    assert.deepEqual(bearer.extra.presented, ["bearer"]);
    assert.equal(reasonOf(bearer, "bearer-token"), "unknown_token");
    assert.equal(reasonOf(bearer, "operator-session"), "no_credential");
    assert.equal(reasonOf(bearer, "ingest-token"), "unknown_token");

    assert.deepEqual(expired.extra.presented, ["operator_session"]);
    assert.equal(reasonOf(expired, "operator-session"), "expired_session");
    assert.equal(reasonOf(expired, "bearer-token"), "no_credential");

    assert.deepEqual(unknown.extra.presented, ["operator_session"]);
    assert.equal(reasonOf(unknown, "operator-session"), "unknown_session");

    assert.deepEqual(both.extra.presented, ["bearer", "operator_session"]);
    assert.equal(reasonOf(both, "operator-session"), "unknown_session");
    assert.equal(reasonOf(both, "bearer-token"), "unknown_token");

    assert.deepEqual(malformed.extra.presented, ["bearer"]);
    assert.equal(reasonOf(malformed, "bearer-token"), "malformed_header");

    assert.equal(reasonOf(ingestElsewhere, "ingest-token"), "other_route");
    assert.equal(reasonOf(ingestElsewhere, "bearer-token"), "unknown_token");
  });

  await withService(async (base, rows) => {
    await send(base, READ_MARK_PATH, { "cf-access-jwt-assertion": "a.b.c" });
    const [access] = unauthorizedRows(rows);
    assert.deepEqual(access.extra.presented, ["access"]);
    assert.equal(reasonOf(access, "cloudflare-access"), "unverified_access");
  });
});

/** Every form a refused value could leak in: whole, a prefix, a suffix, or a common digest. */
function leakForms(value: string): string[] {
  const forms = [value, value.slice(0, 8), value.slice(-8)];
  for (const algorithm of ["sha256", "sha1", "md5"]) {
    const digest = createHash(algorithm).update(value).digest();
    forms.push(digest.toString("hex"), digest.toString("hex").slice(0, 12), digest.toString("base64"), digest.toString("base64url"));
  }
  forms.push(Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url"));
  return forms;
}

test("W1-T13181 criterion 3 — invariant:no-secret-on-the-row: no token, session, header value or digest of one", async () => {
  const expiredSession = sessionToken(known, { exp: NOW_S - 600 });
  const strangerSession = sessionToken(stranger);
  const accessAssertion = `${b64({ alg: "RS256", kid: "x" })}.${b64({ aud: "aud" })}.c2lnbmF0dXJl`;
  const refusedValues = [STRANGER_TOKEN, expiredSession, strangerSession, accessAssertion, "not-a-bearer-value-42"];
  await withService(async (base, rows) => {
    await send(base, READ_MARK_PATH, { authorization: `Bearer ${STRANGER_TOKEN}`, [OPERATOR_SESSION_HEADER]: expiredSession });
    await send(base, READ_MARK_PATH, { authorization: `Bearer ${STRANGER_TOKEN}`, [OPERATOR_SESSION_HEADER]: strangerSession });
    await send(base, READ_MARK_PATH, { "cf-access-jwt-assertion": accessAssertion });
    await send(base, READ_MARK_PATH, { authorization: "Token not-a-bearer-value-42" });
    await send(base, "/v1/state", {}, "GET");
    const refused = unauthorizedRows(rows);
    assert.equal(refused.length, 5);

    for (const row of refused) {
      assert.deepEqual(Object.keys(row.extra).sort(), ["method", "path", "presented", "refusals"]);
      for (const kind of row.extra.presented as string[]) {
        assert.ok(["bearer", "operator_session", "access", "tailnet_identity", "none"].includes(kind), `kind ${kind}`);
      }
      for (const refusal of row.extra.refusals as Array<Record<string, unknown>>) {
        assert.deepEqual(Object.keys(refusal).sort(), ["provider", "reason"]);
        assert.ok(REASONS.has(String(refusal.reason)), `fixed reason word, got ${String(refusal.reason)}`);
      }
      const text = JSON.stringify(row);
      for (const value of [...refusedValues, READ_TOKEN, WRITE_TOKEN, INGEST_TOKEN]) {
        for (const form of leakForms(value)) {
          assert.ok(!text.includes(form), "the row must not carry any form of a credential value");
        }
      }
    }
  });
});

test("W1-T13181 criterion 4 — invariant:logging-grants-nothing: every refused request keeps its status and body", async () => {
  const unauthorized = { error: "unauthorized" };
  const cases: Array<{ path: string; method: string; headers: Record<string, string>; status: number; body: unknown }> = [
    { path: READ_MARK_PATH, method: "POST", headers: {}, status: 401, body: unauthorized },
    { path: READ_MARK_PATH, method: "POST", headers: { authorization: `Bearer ${STRANGER_TOKEN}` }, status: 401, body: unauthorized },
    { path: READ_MARK_PATH, method: "POST", headers: { authorization: "Token x" }, status: 401, body: unauthorized },
    { path: READ_MARK_PATH, method: "POST", headers: { [OPERATOR_SESSION_HEADER]: sessionToken(known, { exp: NOW_S - 600 }) }, status: 401, body: unauthorized },
    { path: READ_MARK_PATH, method: "POST", headers: { [OPERATOR_SESSION_HEADER]: sessionToken(stranger) }, status: 401, body: unauthorized },
    { path: READ_MARK_PATH, method: "POST", headers: { "cf-access-jwt-assertion": "a.b.c" }, status: 401, body: unauthorized },
    { path: READ_MARK_PATH, method: "POST", headers: { authorization: `Bearer ${INGEST_TOKEN}` }, status: 401, body: unauthorized },
    { path: "/v1/state", method: "GET", headers: {}, status: 401, body: unauthorized },
    { path: READ_MARK_PATH, method: "POST", headers: { authorization: `Bearer ${READ_TOKEN}` }, status: 403, body: { error: "forbidden", required_scope: "write" } },
  ];
  await withService(async (base, rows) => {
    for (const c of cases) {
      const res = await send(base, c.path, c.headers, c.method);
      assert.equal(res.status, c.status, `${c.method} ${c.path} ${Object.keys(c.headers).join(",")}`);
      assert.deepEqual(res.body, c.body);
    }
    assert.equal(unauthorizedRows(rows).length, 8);
    assert.equal(rows.filter((r) => r.step === "service.forbidden").length, 1);

    // The control: the credentials serve knows still reach the route.
    assert.equal((await send(base, READ_MARK_PATH, { authorization: `Bearer ${WRITE_TOKEN}` })).status, 200);
    assert.equal((await send(base, READ_MARK_PATH, { [OPERATOR_SESSION_HEADER]: sessionToken(known) })).status, 200);
    assert.equal((await send(base, "/v1/ingest", { authorization: `Bearer ${INGEST_TOKEN}` })).status, 200);
    assert.equal(unauthorizedRows(rows).length, 8, "a granted request writes no refusal row");
  });
});
