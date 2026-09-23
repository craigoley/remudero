import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { buildServeServer, operatorIdentityConfig, operatorSessionProvider, type ServeDeps } from "../src/lib/serve.js";
import {
  createOperatorJwksCache,
  createService,
  DEFAULT_OPERATOR_STEP_UP_WINDOW_MINUTES,
  OPERATOR_JWKS_REFETCH_MIN_INTERVAL_MS,
  OPERATOR_JWKS_TTL_MS,
  OPERATOR_SESSION_HEADER,
  operatorJwksUrl,
  operatorStepUpIsFresh,
  verifiedActor,
  type OperatorIdentityConfig,
  type OperatorJwk,
} from "../src/lib/service.js";
import type { Clock } from "../src/lib/clock.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { Plan } from "../src/lib/plan.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import { fakeGitHub } from "./helpers/fake-github.js";

// ── W1-T4244 — THE OPERATOR REACHES CORE AS THEMSELVES ──────────────────────────────────────────
//
// MEASURED 2026-09-23 on the gateway: the console's bearer write token got `403 required_tier:
// middle` on POST /v1/quiet-hours and `403 required_tier: high` on POST /v1/merge-hold, because
// W1-T404 pins that token at `low`. This suite drives the REAL `rmd serve` assembly
// (`buildServeServer`) with the operator-session provider configured, and signs its own Clerk-
// shaped RS256 session tokens with a keypair generated here — no network, no wall clock.

const READ_TOKEN = "operator-read-token";
const WRITE_TOKEN = "operator-write-token";
const ISSUER = "https://clerk.console.example";
const ORIGIN = "https://console.example";
const OPERATOR = "user_operator";
const NOW_MS = Date.UTC(2026, 8, 23, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

interface Signer {
  jwk: OperatorJwk;
  privateKey: KeyObject;
}

function makeSigner(kid: string): Signer {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid, kty: "RSA", alg: "RS256", use: "sig" } as OperatorJwk;
  return { jwk, privateKey };
}

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

function sessionToken(signer: Signer, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const head = b64({ alg: "RS256", typ: "JWT", kid: signer.jwk.kid, ...header });
  const body = b64({ iss: ISSUER, sub: OPERATOR, azp: ORIGIN, iat: NOW_S - 10, nbf: NOW_S - 10, exp: NOW_S + 50, fva: [120, -1], ...claims });
  const signature = signBytes("RSA-SHA256", Buffer.from(`${head}.${body}`), signer.privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
}

function mutableClock(start: number): Clock & { set(ms: number): void } {
  let ms = start;
  return {
    now: () => ms,
    date: () => new Date(ms),
    iso: () => new Date(ms).toISOString(),
    set: (next) => {
      ms = next;
    },
  };
}

/** A key-set endpoint under the test's control: counts calls, serves whatever `keys` holds now. */
function jwksEndpoint(initial: OperatorJwk[]) {
  let keys: unknown[] = initial;
  let calls = 0;
  let failWith: number | "throw" | "no-keys" | undefined;
  const fetchImpl = (async () => {
    calls += 1;
    if (failWith === "throw") throw new Error("network down");
    if (typeof failWith === "number") return new Response("nope", { status: failWith });
    if (failWith === "no-keys") return new Response(JSON.stringify({}), { status: 200 });
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }) as typeof fetch;
  return {
    fetchImpl,
    calls: () => calls,
    serve: (next: unknown[]) => {
      keys = next;
    },
    fail: (mode: number | "throw" | "no-keys" | undefined) => {
      failWith = mode;
    },
  };
}

const CONFIG: OperatorIdentityConfig = {
  issuer: ISSUER,
  allowedOrigins: [ORIGIN],
  operatorUserIds: [OPERATOR],
};

interface Harness {
  base: string;
  ledgerPath: string;
  log: Array<{ step: string; extra?: Record<string, unknown> }>;
}

async function withServe<T>(
  opts: { signer: Signer; config?: OperatorIdentityConfig; endpoint?: ReturnType<typeof jwksEndpoint>; clock?: Clock },
  fn: (h: Harness) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rmd-operator-session-"));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const log: Harness["log"] = [];
  const endpoint = opts.endpoint ?? jwksEndpoint([opts.signer.jwk]);
  const plan: Plan = { tasks: [], byId: new Map() };
  const deps: ServeDeps = {
    board: { plan, ledgerPath, github: fakeGitHub() },
    panelGraph: {
      root,
      planPath,
      ledgerPath,
      github: { prView: () => null } as TraceGithub,
      statusGithub: fakeGitHub(),
      ratify: { approve: () => {}, reframe: () => {} } as RatifyCliGateway,
    },
    ledgerPath,
    issues: { close: () => {} } as IssueCloser,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    // Stated, never read from the host's config.json: this suite must not depend on the machine.
    accessTeamDomain: "",
    accessAudience: "",
    operatorIdentity: opts.config ?? CONFIG,
    operatorIdentityIo: { fetchImpl: endpoint.fetchImpl, clock: opts.clock ?? mutableClock(NOW_MS) },
    log: (step, extra) => log.push({ step, extra }),
  };
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, ledgerPath, log });
  } finally {
    server.close();
  }
}

const bearer = { authorization: `Bearer ${WRITE_TOKEN}` };
const json = { "content-type": "application/json" };

async function post(base: string, path: string, headers: Record<string, string>, payload: string, nonce?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...json, ...headers, ...(nonce ? { "x-confirm-nonce": nonce } : {}) },
    body: payload,
  });
}

async function nonceFor(base: string, headers: Record<string, string>, path: string, payload: string): Promise<string> {
  const res = await post(base, "/v1/confirm", headers, JSON.stringify({ method: "POST", path, payload }));
  assert.equal(res.status, 200, "POST /v1/confirm is a low-tier route every write credential reaches");
  return ((await res.json()) as { nonce: string }).nonce;
}

const MERGE_HOLD = JSON.stringify({ action: "engage", reason: "operator-session test" });

// ── criterion 1 ────────────────────────────────────────────────────────────────────────────────

test("an allowlisted operator's verified session reaches middle-tier routes", async () => {
  const signer = makeSigner("k1");
  await withServe({ signer }, async ({ base }) => {
    // CONTROL: the bearer token alone is refused exactly as measured on the gateway.
    const refused = await post(base, "/v1/quiet-hours", bearer, JSON.stringify({ enabled: true }));
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { required_tier: string }).required_tier, "middle");

    const session = { ...bearer, [OPERATOR_SESSION_HEADER]: sessionToken(signer, {}) };
    const quiet = await post(base, "/v1/quiet-hours", session, JSON.stringify({ enabled: true }));
    assert.equal(quiet.status, 200);
    assert.deepEqual(await quiet.json(), { quietHours: true });
    const pause = await post(base, "/v1/control/pause", session, JSON.stringify({ reason: "operator" }));
    assert.equal(pause.status, 200);
    // The session alone — no bearer token — is also a complete write credential.
    const alone = await post(base, "/v1/control/resume", { [OPERATOR_SESSION_HEADER]: sessionToken(signer, {}) }, "{}");
    assert.equal(alone.status, 200);
  });
});

// ── criterion 2 ────────────────────────────────────────────────────────────────────────────────

test("a high-tier route needs a factor verified within the step-up window", async () => {
  const signer = makeSigner("k1");
  await withServe({ signer }, async ({ base }) => {
    // Two hours since any factor: middle, so merge hold is refused at the tier gate.
    const stale = { [OPERATOR_SESSION_HEADER]: sessionToken(signer, { fva: [120, 120] }) };
    const staleRes = await post(base, "/v1/merge-hold", stale, MERGE_HOLD, await nonceFor(base, stale, "/v1/merge-hold", MERGE_HOLD));
    assert.equal(staleRes.status, 403);
    assert.equal(((await staleRes.json()) as { required_tier: string }).required_tier, "high");

    // A second factor two minutes ago: high — and the confirm-nonce step is still required.
    const fresh = { [OPERATOR_SESSION_HEADER]: sessionToken(signer, { fva: [120, 2] }) };
    const noNonce = await post(base, "/v1/merge-hold", fresh, MERGE_HOLD);
    assert.equal(noNonce.status, 403);
    assert.deepEqual(await noNonce.json(), { error: "confirm_nonce_required" });
    const ok = await post(base, "/v1/merge-hold", fresh, MERGE_HOLD, await nonceFor(base, fresh, "/v1/merge-hold", MERGE_HOLD));
    assert.equal(ok.status, 200);

    // A step-up is aged by the time since the token was issued: 8 minutes at issue + 5 minutes held.
    const aged = { [OPERATOR_SESSION_HEADER]: sessionToken(signer, { fva: [8, -1], iat: NOW_S - 300, nbf: NOW_S - 300 }) };
    const agedRes = await post(base, "/v1/merge-hold", aged, MERGE_HOLD, await nonceFor(base, aged, "/v1/merge-hold", MERGE_HOLD));
    assert.equal(agedRes.status, 403);
  });
  // The window is the config's, and the rule reads the most recent non-negative entry.
  assert.equal(DEFAULT_OPERATOR_STEP_UP_WINDOW_MINUTES, 10);
  assert.equal(operatorStepUpIsFresh([-1, 3], NOW_S, NOW_MS, 10), true);
  assert.equal(operatorStepUpIsFresh([30, -1], NOW_S, NOW_MS, 10), false);
  assert.equal(operatorStepUpIsFresh([30, -1], NOW_S, NOW_MS, 45), true);
  assert.equal(operatorStepUpIsFresh([-1, -1], NOW_S, NOW_MS, 10), false);
  assert.equal(operatorStepUpIsFresh(undefined, NOW_S, NOW_MS, 10), false);
  assert.equal(operatorStepUpIsFresh([4], undefined, NOW_MS, 10), true);
});

// ── criterion 3 ────────────────────────────────────────────────────────────────────────────────

test("an unknown user, a bad signature or an expired session gets no write tier", async () => {
  const signer = makeSigner("k1");
  const forger = makeSigner("k1"); // same kid, different private key.
  const cases: Array<[string, string]> = [
    ["unknown user", sessionToken(signer, { sub: "user_stranger" })],
    ["bad signature", sessionToken(forger, {})],
    ["expired", sessionToken(signer, { exp: NOW_S - 60 })],
    ["not yet valid", sessionToken(signer, { nbf: NOW_S + 60 })],
    ["wrong issuer", sessionToken(signer, { iss: "https://evil.example" })],
    ["wrong origin", sessionToken(signer, { azp: "https://evil.example" })],
    ["no origin", sessionToken(signer, { azp: undefined })],
    ["alg none", sessionToken(signer, {}, { alg: "none" })],
    ["unknown kid", sessionToken(signer, {}, { kid: "k-unknown" })],
    ["no kid", sessionToken(signer, {}, { kid: undefined })],
    ["not a jwt", "not-a-jwt"],
    ["undecodable", "%%%.%%%.%%%"],
  ];
  await withServe({ signer }, async ({ base, log }) => {
    for (const [label, token] of cases) {
      // Session alone: nobody vouched, 401.
      const alone = await post(base, "/v1/quiet-hours", { [OPERATOR_SESSION_HEADER]: token }, JSON.stringify({ enabled: true }));
      assert.equal(alone.status, 401, `${label}: a refused session grants nothing on its own`);
      // With the bearer token too: it falls through to the bearer, which stays at low.
      const withBearer = await post(base, "/v1/quiet-hours", { ...bearer, [OPERATOR_SESSION_HEADER]: token }, JSON.stringify({ enabled: true }));
      assert.equal(withBearer.status, 403, `${label}: falls through to the bearer token's low tier`);
    }
    const reasons = new Set(log.filter((l) => l.step === "service.operator_session_refused").map((l) => l.extra?.reason));
    for (const r of ["unknown_user", "signature", "expired", "not_yet_valid", "issuer", "origin", "algorithm", "unknown_key", "malformed"]) {
      assert.ok(reasons.has(r), `refusal reason ${r} is ledgered`);
    }
  });
});

test("an operator session is refused when the key set cannot be fetched", async () => {
  const signer = makeSigner("k1");
  for (const mode of [503, "throw", "no-keys"] as const) {
    const endpoint = jwksEndpoint([signer.jwk]);
    endpoint.fail(mode);
    await withServe({ signer, endpoint }, async ({ base, log }) => {
      const res = await post(base, "/v1/quiet-hours", { [OPERATOR_SESSION_HEADER]: sessionToken(signer, {}) }, JSON.stringify({ enabled: true }));
      assert.equal(res.status, 401, `fetch failure (${mode}) fails closed`);
      assert.ok(log.some((l) => l.step === "service.operator_jwks_fetch_failed"));
    });
  }
});

test("the operator key set is cached, refetched on rotation, and forgotten when a refetch fails", async () => {
  const clock = mutableClock(NOW_MS);
  const k1 = makeSigner("k1");
  const k2 = makeSigner("k2");
  const endpoint = jwksEndpoint([k1.jwk, { kid: "ec", kty: "EC" }]);
  const cache = createOperatorJwksCache({ jwksUrl: operatorJwksUrl({ issuer: `${ISSUER}/` }), fetchImpl: endpoint.fetchImpl, clock });
  assert.equal(operatorJwksUrl({ issuer: `${ISSUER}/` }), `${ISSUER}/.well-known/jwks.json`);
  assert.equal(operatorJwksUrl({ issuer: ISSUER, jwksUrl: "https://keys.example/jwks" }), "https://keys.example/jwks");

  // Concurrent first lookups share ONE fetch; a non-RSA key is never admitted.
  const [a, b] = await Promise.all([cache.key("k1"), cache.key("k1")]);
  assert.equal(a?.kid, "k1");
  assert.equal(b?.kid, "k1");
  assert.equal(await cache.key("ec"), undefined);
  assert.equal(endpoint.calls(), 1);

  // Rotation: an unknown kid inside the throttle is refused without a fetch; after it, one refetch.
  endpoint.serve([k2.jwk]);
  assert.equal(await cache.key("k2"), undefined);
  assert.equal(endpoint.calls(), 1);
  clock.set(NOW_MS + OPERATOR_JWKS_REFETCH_MIN_INTERVAL_MS);
  assert.equal((await cache.key("k2"))?.kid, "k2");
  assert.equal(endpoint.calls(), 2);

  // Cached until the TTL; then refetched — and a FAILED refetch forgets every key (fail closed).
  assert.equal((await cache.key("k2"))?.kid, "k2");
  assert.equal(endpoint.calls(), 2);
  clock.set(NOW_MS + OPERATOR_JWKS_REFETCH_MIN_INTERVAL_MS + OPERATOR_JWKS_TTL_MS);
  endpoint.fail("throw");
  assert.equal(await cache.key("k2"), undefined);
  assert.equal(endpoint.calls(), 3);
  // Throttled after the failure: still refused, still no fetch storm.
  endpoint.fail(undefined);
  assert.equal(await cache.key("k2"), undefined);
  assert.equal(endpoint.calls(), 3);
});

test("an incomplete operator identity config composes no provider", () => {
  const log: string[] = [];
  const io = { log: (step: string) => log.push(step) };
  assert.equal(operatorSessionProvider(undefined, io), undefined);
  assert.equal(operatorSessionProvider({ ...CONFIG, issuer: "  " }, io), undefined);
  assert.equal(operatorSessionProvider({ ...CONFIG, allowedOrigins: [] }, io), undefined);
  assert.equal(operatorSessionProvider({ ...CONFIG, operatorUserIds: [] }, io), undefined);
  assert.deepEqual(log, ["serve.operator_identity_incomplete", "serve.operator_identity_incomplete", "serve.operator_identity_incomplete"]);
  // Read off config: present, absent, and an unreadable config all answer without throwing.
  assert.deepEqual(operatorIdentityConfig(() => ({ serve: { operatorIdentity: CONFIG } })), CONFIG);
  assert.equal(operatorIdentityConfig(() => ({})), undefined);
  assert.equal(
    operatorIdentityConfig(() => {
      throw new Error("config unreadable");
    }),
    undefined,
  );
  const provider = operatorSessionProvider(CONFIG, io);
  assert.equal(provider?.name, "operator-session");
  // `grant` is never the answer path — verification is async.
  assert.equal(provider?.grant({ headers: { [OPERATOR_SESSION_HEADER]: "x" } } as unknown as IncomingMessage, false), undefined);
});

// ── criterion 4 ────────────────────────────────────────────────────────────────────────────────

test("every write ledgers the operator who made it", async () => {
  const signer = makeSigner("k1");
  await withServe({ signer }, async ({ base, ledgerPath }) => {
    const middle = { ...bearer, [OPERATOR_SESSION_HEADER]: sessionToken(signer, {}) };
    assert.equal((await post(base, "/v1/quiet-hours", middle, JSON.stringify({ enabled: true }))).status, 200);
    assert.equal((await post(base, "/v1/control/pause", middle, JSON.stringify({ reason: "r" }))).status, 200);
    const high = { ...bearer, [OPERATOR_SESSION_HEADER]: sessionToken(signer, { fva: [1, -1] }) };
    assert.equal((await post(base, "/v1/merge-hold", high, MERGE_HOLD, await nonceFor(base, high, "/v1/merge-hold", MERGE_HOLD))).status, 200);

    const rows = readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const quiet = rows.find((r) => r.step === "panel.quiet_hours_toggled");
    const pause = rows.find((r) => r.step === "panel.pause_requested");
    assert.equal(quiet?.origin, `operator:${OPERATOR}`);
    assert.equal(pause?.origin, `operator:${OPERATOR}`);
    const hold = rows.find((r) => r.step === "automerge.hold_engaged");
    assert.equal(hold?.by, `operator:${OPERATOR}`, "the HIGH-tier merge hold names the operator");
  });
});

test("the verified actor is set only by the dispatch, never by a request header", async () => {
  const seen: Array<string | undefined> = [];
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: [
      {
        method: "POST",
        path: "/v1/echo",
        scope: "write",
        tier: "low",
        handler: (req, res) => {
          seen.push(verifiedActor(req));
          res.writeHead(200);
          res.end();
        },
      },
    ],
    enforceWriteTiers: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await post(`http://127.0.0.1:${port}`, "/v1/echo", { ...bearer, [OPERATOR_SESSION_HEADER]: "forged" }, "{}");
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [undefined]);
  } finally {
    server.close();
  }
});

// ── criterion 5 ────────────────────────────────────────────────────────────────────────────────

test("the bearer write token stays pinned at low", async () => {
  const signer = makeSigner("k1");
  // The operator provider is CONFIGURED on this server: the bearer token must not borrow from it.
  await withServe({ signer }, async ({ base, ledgerPath }) => {
    // Low: reached.
    const payload = JSON.stringify({ enabled: true });
    const nonce = await nonceFor(base, bearer, "/v1/merge-hold", MERGE_HOLD);
    // Middle: refused.
    const middle = await post(base, "/v1/quiet-hours", bearer, payload);
    assert.equal(middle.status, 403);
    assert.equal(((await middle.json()) as { required_tier: string }).required_tier, "middle");
    // High: refused even with a valid nonce in hand.
    const high = await post(base, "/v1/merge-hold", bearer, MERGE_HOLD, nonce);
    assert.equal(high.status, 403);
    assert.equal(((await high.json()) as { required_tier: string }).required_tier, "high");
    // Reads keep working.
    const read = await fetch(`${base}/v1/control/status`, { headers: bearer });
    assert.equal(read.status, 200);
    // Nothing the bearer token did names an operator.
    assert.ok(!readFileSync(ledgerPath, "utf8").includes("operator:"));
  });
});
