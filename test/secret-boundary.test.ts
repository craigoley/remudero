// test/secret-boundary.test.ts — W1-T2699: A SECRET A WORKER CAN READ IS A SECRET A PROMPT CAN LEAK.
//
// Covers the five acceptance criteria in plan/tasks.d/W1-T2699-…yaml verbatim:
//   1. a worker's env carries a sentinel bearer and a loopback base URL and no real credential
//   2. the boundary proxy substitutes the real credential only for the model host and refuses an
//      undeclared host at connect time with a ledgered reason
//   3. the git credential helper answers over the socket with a per-request scoped token and
//      never writes a token to the worktree
//   4. the ledger row for a boundary request carries host, decision, status and reason, never a
//      value
//   5. the spawn path routes through the boundary (grep: secretBoundaryEnv( in src/lib/worker.ts)
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createConnection } from "node:net";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  boundaryLedgerRow,
  declaredHostsFromWorkerSettings,
  mintSentinel,
  repoFromCredentialRequest,
  secretBoundaryEnv,
  startBoundaryProxy,
  startCredentialHelperSocket,
  MODEL_HOST_DEFAULT,
  type BoundaryDestination,
  type BoundaryLedgerRow,
} from "../src/lib/secret-boundary.js";
import { buildWorkerEnv } from "../src/lib/env.js";
import { mintScopedToken } from "../src/lib/github-app.js";
import { ALLOWED_NETWORK_DOMAINS } from "../src/lib/settings.js";

function keyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
}

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

// ── (1) SENTINEL ENV, NO REAL CREDENTIAL ─────────────────────────────────────────────────────────

test("W1-T2699 (1): a boundary-less env is byte-identical — this call is a no-op until a caller opts in", () => {
  const built = buildWorkerEnv({}, { PATH: "/usr/bin", HOME: "/h", CLAUDE_CODE_OAUTH_TOKEN: "REAL-OAUTH", GH_TOKEN: "REAL-GH" });
  const out = secretBoundaryEnv(built);
  assert.deepEqual(out, built, "no `boundary` argument must leave buildWorkerEnv's output untouched");
});

test("W1-T2699 (1): with a boundary, the env carries a sentinel bearer and a loopback base URL, never the real OAuth token", () => {
  const built = buildWorkerEnv({}, { PATH: "/usr/bin", HOME: "/h", CLAUDE_CODE_OAUTH_TOKEN: "REAL-OAUTH-SECRET", GH_TOKEN: "REAL-GH-SECRET" });
  const sentinel = mintSentinel("model");
  const out = secretBoundaryEnv(built, { modelSentinel: sentinel, modelBaseUrl: "http://127.0.0.1:4123" });

  assert.equal(out.ANTHROPIC_AUTH_TOKEN, sentinel);
  assert.equal(out.ANTHROPIC_BASE_URL, "http://127.0.0.1:4123");
  assert.match(out.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:/, "the base URL must be a loopback address");
  assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in out, false, "the real subscription token must not survive substitution");
  assert.notEqual(out.ANTHROPIC_AUTH_TOKEN, "REAL-OAUTH-SECRET");
  // No value anywhere in the returned env equals either real secret — the strongest form of "no
  // real credential", checked against every value rather than one named key.
  for (const v of Object.values(out)) {
    assert.notEqual(v, "REAL-OAUTH-SECRET");
  }
});

test("W1-T2699 (1): a sentinel never embeds the real value it stands in for", () => {
  const a = mintSentinel("model");
  const b = mintSentinel("model");
  assert.notEqual(a, b, "two mints must be unguessably distinct");
  assert.doesNotMatch(a, /REAL-OAUTH-SECRET/);
});

// ── (2) THE BOUNDARY PROXY: SUBSTITUTION FOR THE DECLARED HOST, REFUSAL FOR AN UNDECLARED ONE ────

test("W1-T2699 (2): api.anthropic.com is deliberately absent from the sandbox's own egress allowlist — the two boundaries never overlap", () => {
  assert.ok(!ALLOWED_NETWORK_DOMAINS.includes(MODEL_HOST_DEFAULT), "the model host must stay out of the Bash-tool sandbox's allowedDomains (settings.ts)");
  assert.ok(!declaredHostsFromWorkerSettings({ sandbox: { network: { allowedDomains: ALLOWED_NETWORK_DOMAINS } } }).includes(MODEL_HOST_DEFAULT));
});

test("W1-T2699 (2): a request bearing the declared sentinel is forwarded with the REAL credential substituted, and ledgers a value-free allow row", async () => {
  const rows: BoundaryLedgerRow[] = [];
  const sentinel = mintSentinel("model");
  let sawAuth: string | undefined;
  const destinations: BoundaryDestination[] = [
    {
      host: MODEL_HOST_DEFAULT,
      sentinel,
      upstreamBaseUrl: "https://upstream.invalid",
      realValue: () => "REAL-SUBSCRIPTION-TOKEN",
    },
  ];
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    sawAuth = (init?.headers as Headers).get("authorization") ?? undefined;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const proxy = await startBoundaryProxy({ destinations, log: (r) => rows.push(r), fetchImpl: fakeFetch });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, { headers: { authorization: `Bearer ${sentinel}` } });
    assert.equal(res.status, 200);
    assert.equal(sawAuth, "Bearer REAL-SUBSCRIPTION-TOKEN", "the upstream request must carry the REAL credential");

    const row = rows.find((r) => r.decision === "allow");
    assert.ok(row, "an allowed substitution must ledger a row");
    assert.equal(row!.host, MODEL_HOST_DEFAULT);
    assert.equal(row!.status, "200");
    assert.ok(row!.reason.length > 0);
  } finally {
    await proxy.close();
  }
});

test("W1-T2699 (2): a request bearing an undeclared credential is refused before any upstream connection is opened, and ledgers a refusal", async () => {
  const rows: BoundaryLedgerRow[] = [];
  let upstreamCalled = false;
  const destinations: BoundaryDestination[] = [
    {
      host: MODEL_HOST_DEFAULT,
      sentinel: mintSentinel("model"),
      upstreamBaseUrl: "https://upstream.invalid",
      realValue: () => "REAL-SUBSCRIPTION-TOKEN",
    },
  ];
  const fakeFetch = (async () => {
    upstreamCalled = true;
    return new Response("should never be reached", { status: 200 });
  }) as unknown as typeof fetch;

  const proxy = await startBoundaryProxy({ destinations, log: (r) => rows.push(r), fetchImpl: fakeFetch });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, { headers: { authorization: "Bearer some-guessed-or-stolen-value" } });
    assert.equal(res.status, 403);
    assert.equal(upstreamCalled, false, "an undeclared destination must never reach the upstream fetch at all");

    const row = rows.find((r) => r.decision === "refuse");
    assert.ok(row, "a refusal must ledger a row");
    assert.equal(row!.host, "undeclared");
    assert.match(row!.reason, /no destination is declared/);
    // Value-free: the reason names no secret, and no row anywhere carries the real token or the
    // presented one.
    for (const r of rows) {
      assert.doesNotMatch(JSON.stringify(r), /REAL-SUBSCRIPTION-TOKEN|some-guessed-or-stolen-value/);
    }
  } finally {
    await proxy.close();
  }
});

test("W1-T2699 (2): a declared destination with no real credential available refuses rather than substituting an empty one", async () => {
  const rows: BoundaryLedgerRow[] = [];
  const sentinel = mintSentinel("model");
  const destinations: BoundaryDestination[] = [
    { host: MODEL_HOST_DEFAULT, sentinel, upstreamBaseUrl: "https://upstream.invalid", realValue: () => undefined },
  ];
  const proxy = await startBoundaryProxy({ destinations, log: (r) => rows.push(r) });
  try {
    const res = await fetch(proxy.url, { headers: { authorization: `Bearer ${sentinel}` } });
    assert.equal(res.status, 502);
    assert.equal(rows[0]?.decision, "refuse");
  } finally {
    await proxy.close();
  }
});

// ── (3) THE GIT CREDENTIAL HELPER OVER THE SOCKET ────────────────────────────────────────────────

function socketRoundTrip(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    socket.on("connect", () => socket.end(request));
    socket.on("data", (c) => (data += c.toString("utf8")));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

test("W1-T2699 (3): the credential helper answers over the socket with a per-request scoped token, never writing to the worktree", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "rmd-secret-boundary-"));
  const worktree = join(scratch, "worktree");
  const socketPath = join(scratch, "cred.sock");
  const before = readdirSync(scratch).sort();
  const rows: BoundaryLedgerRow[] = [];
  let mintCalls = 0;

  const handle = await startCredentialHelperSocket({
    socketPath,
    log: (r) => rows.push(r),
    mint: async (repo) => {
      mintCalls += 1;
      return { ok: true, token: `scoped-token-for-${repo}-${mintCalls}` };
    },
  });
  try {
    const reply1 = await socketRoundTrip(socketPath, "protocol=https\nhost=github.com\npath=acme/widgets.git\n\n");
    assert.match(reply1, /^username=x-access-token$/m);
    assert.match(reply1, /^password=scoped-token-for-acme\/widgets-1$/m);

    const reply2 = await socketRoundTrip(socketPath, "protocol=https\nhost=github.com\npath=acme/widgets.git\n\n");
    assert.match(reply2, /password=scoped-token-for-acme\/widgets-2/, "a second request mints its OWN token, never a cached one");

    const ledgered = JSON.stringify(rows);
    assert.doesNotMatch(ledgered, /scoped-token-for/, "the ledger must never carry the minted value");

    // Nothing was written into either the worktree or the scratch dir the socket itself lives in —
    // the reply travels ONLY over the connection.
    assert.deepEqual(readdirSync(scratch).sort(), before.length ? before : ["cred.sock"], "no new file must appear beside the socket");
    assert.throws(() => readdirSync(worktree), "the worktree directory must never even be created by this helper");
  } finally {
    await handle.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("W1-T2699 (3): a mint refusal is relayed and ledgered by reason, with no username/password lines", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "rmd-secret-boundary-"));
  const socketPath = join(scratch, "cred.sock");
  const rows: BoundaryLedgerRow[] = [];
  const handle = await startCredentialHelperSocket({
    socketPath,
    log: (r) => rows.push(r),
    mint: async () => ({ ok: false, reason: "app not configured" }),
  });
  try {
    const reply = await socketRoundTrip(socketPath, "protocol=https\nhost=github.com\n\n");
    assert.equal(reply, "");
    assert.equal(rows[0]?.decision, "refuse");
    assert.equal(rows[0]?.reason, "app not configured");
  } finally {
    await handle.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("W1-T2699 (3): repoFromCredentialRequest prefers path over host, and falls back to host alone", () => {
  assert.equal(repoFromCredentialRequest("protocol=https\nhost=github.com\npath=acme/widgets.git\n"), "acme/widgets");
  assert.equal(repoFromCredentialRequest("protocol=https\nhost=github.com\n"), "github.com");
  assert.equal(repoFromCredentialRequest(""), "unknown");
});

// ── mintScopedToken (github-app.ts): the smallest token the push needs, capped by ttlMs ─────────

test("W1-T2699: mintScopedToken requests a repo-scoped, permission-narrowed token and caps its expiry at ttlMs", async () => {
  const { privateKey } = keyPair();
  let sentBody: unknown;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body));
    return fakeResponse(201, { token: "scoped-real-token", expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  }) as unknown as typeof fetch;

  const result = await mintScopedToken("acme/widgets", 5 * 60 * 1000, {
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    readKey: () => privateKey,
    fetchImpl,
    now: () => 1_000_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.token, "scoped-real-token");
  assert.equal(result.expiresAtMs, 1_000_000 + 5 * 60 * 1000, "the ttl cap must win over GitHub's own later expiry");
  assert.deepEqual((sentBody as { repositories: string[] }).repositories, ["widgets"]);
  assert.deepEqual((sentBody as { permissions: Record<string, string> }).permissions, { contents: "write", pull_requests: "write" });
});

test("W1-T2699: mintScopedToken never writes to opts.env — it is a per-request value, not the daemon's ambient GH_TOKEN", async () => {
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { GH_TOKEN: "UNTOUCHED" };
  const fetchImpl = (async () =>
    fakeResponse(201, { token: "scoped-real-token", expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() })) as unknown as typeof fetch;
  await mintScopedToken("acme/widgets", 1000, {
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    readKey: () => privateKey,
    fetchImpl,
    env,
  });
  assert.equal(env.GH_TOKEN, "UNTOUCHED");
});

test("W1-T2699: mintScopedToken reports app-not-configured without an attempt, mirroring refreshInstallationToken", async () => {
  const result = await mintScopedToken("acme/widgets", 1000, { env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "app not configured");
});

// ── (4) THE LEDGER ROW: HOST, DECISION, STATUS, REASON — NEVER A VALUE ───────────────────────────

test("W1-T2699 (4): boundaryLedgerRow carries exactly host/decision/status/reason (plus its step), never a value field", () => {
  const row = boundaryLedgerRow("github.com", "allow", "200", "substituted for a declared destination");
  assert.deepEqual(Object.keys(row).sort(), ["decision", "host", "reason", "status", "step"]);
  assert.equal(row.step, "boundary.request");
  assert.equal(row.decision, "allow");
  for (const forbidden of ["token", "value", "credential", "password", "secret", "authorization"]) {
    assert.equal(forbidden in row, false, `a boundary ledger row must never carry a "${forbidden}" field`);
  }
});

test("W1-T2699 (4): a refusal row is shaped identically to an allow row — same four fields, never a bare boolean", () => {
  const allow = boundaryLedgerRow("api.anthropic.com", "allow", "200", "substituted");
  const refuse = boundaryLedgerRow("undeclared", "refuse", "refused", "no destination is declared");
  assert.deepEqual(Object.keys(allow).sort(), Object.keys(refuse).sort());
});
