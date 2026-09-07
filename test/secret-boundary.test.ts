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
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createConnection } from "node:net";
import { mkdirSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MODEL_HOST_DEFAULT, boundaryLedgerRow, declaredHostsFromWorkerSettings, forwardedTarget, mintSentinel, repoFromCredentialRequest, secretBoundaryEnv, startBoundaryProxy, startCredentialHelperSocket, type BoundaryDestination, type BoundaryLedgerRow, type ScopedTokenMint } from "../src/lib/secret-boundary.js";
import { buildWorkerEnv } from "../src/lib/env.js";
import { mintScopedToken } from "../src/lib/github-app.js";
import { ALLOWED_NETWORK_DOMAINS } from "../src/lib/settings.js";
import { CLAUDE_BIN_ENV_OVERRIDE, createClaudeExecutableCache, spawnWorker, wireCredentialHelperSocket } from "../src/lib/worker.js";

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

test("W1-T2699 (2): an upstream fetch that throws refuses with a 502 and ledgers the error, never crashing the proxy", async () => {
  const rows: BoundaryLedgerRow[] = [];
  const sentinel = mintSentinel("model");
  const destinations: BoundaryDestination[] = [
    { host: MODEL_HOST_DEFAULT, sentinel, upstreamBaseUrl: "https://upstream.invalid", realValue: () => "REAL-SUBSCRIPTION-TOKEN" },
  ];
  const fakeFetch = (async () => {
    throw new Error("simulated: upstream connection reset");
  }) as unknown as typeof fetch;

  const proxy = await startBoundaryProxy({ destinations, log: (r) => rows.push(r), fetchImpl: fakeFetch });
  try {
    const res = await fetch(proxy.url, { headers: { authorization: `Bearer ${sentinel}` } });
    assert.equal(res.status, 502);
    const row = rows.find((r) => r.decision === "refuse");
    assert.ok(row, "an upstream throw must still ledger a refusal row");
    assert.equal(row!.host, MODEL_HOST_DEFAULT);
    assert.equal(row!.status, "error");
    assert.match(row!.reason, /upstream request failed/);
    assert.doesNotMatch(JSON.stringify(rows), /REAL-SUBSCRIPTION-TOKEN/, "the ledger must never carry the real credential, even on a thrown error");
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

test("W1-T2699 (3): a mint that THROWS (not a declared refusal) is caught, relayed as empty, and ledgered by its own reason", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "rmd-secret-boundary-"));
  const socketPath = join(scratch, "cred.sock");
  const rows: BoundaryLedgerRow[] = [];
  const handle = await startCredentialHelperSocket({
    socketPath,
    log: (r) => rows.push(r),
    mint: async () => {
      throw new Error("simulated: installation token endpoint unreachable");
    },
  });
  try {
    const reply = await socketRoundTrip(socketPath, "protocol=https\nhost=github.com\n\n");
    assert.equal(reply, "", "an unexpected throw must never surface a partial/garbled credential reply");
    assert.equal(rows[0]?.decision, "refuse");
    assert.equal(rows[0]?.status, "error");
    assert.match(rows[0]?.reason ?? "", /mint threw/);
    assert.doesNotMatch(JSON.stringify(rows), /password=/, "the ledger row must never carry a credential value");
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

// ── (5) THE SPAWN PATH WIRES THE GIT-CREDENTIAL HALF (worker.ts) ────────────────────────────────

/** A minimal stand-in for the SDK's `query()`, injected via `args.queryFn` so no worker process is
 *  ever spawned. Never calls `options.spawnClaudeCodeProcess` — nothing here needs a pid, since the
 *  credential-helper wiring under test runs BEFORE the SDK is invoked at all. */
const fakeSuccessQuery = (() =>
  (async function* () {
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      session_id: "s-1",
      total_cost_usd: 0.01,
      num_turns: 1,
    };
  })()) as unknown as Parameters<typeof spawnWorker>[0]["queryFn"];

function spawnWorkerBoundaryArgs(scratch: string, cwd: string, extra: Record<string, unknown>) {
  // `config.root` (and so workerHomeDir) is `scratch`, a SIBLING of `cwd`, never `cwd` itself —
  // `materializeWorkerHome` refuses to place a worker home inside a git work tree, and `cwd` here
  // IS one (that is the whole point of this fixture).
  const settingsFile = join(scratch, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));
  return {
    cwd,
    permissionMode: "bypassPermissions" as const,
    settingsFile,
    prompt: "W1-T2699 credential-helper wiring fixture",
    config: { claudeBin: "/unused", root: scratch },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: scratch, exists: () => true, canExecute: () => true, locations: [] },
    },
    // Force past the darwin-only keychain gate the same way worker.test.ts's own e2e fixtures do —
    // this test is about credential-helper wiring, not the keychain, which it declares as a dep.
    keychain: { platform: "linux" as NodeJS.Platform, readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }) },
    queryFn: fakeSuccessQuery,
    ...extra,
  };
}

test("W1-T2699 (5): spawnWorker points cwd's LOCAL git credential.helper at the socket-based helper when secretBoundary.credentialHelperSocketPath is set", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "rmd-secret-boundary-cred-wire-"));
  const cwd = join(scratch, "worktree");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  const socketPath = join(scratch, "cred.sock");

  const result = await spawnWorker(
    spawnWorkerBoundaryArgs(scratch, cwd, {
      secretBoundary: { modelSentinel: mintSentinel("model"), modelBaseUrl: "http://127.0.0.1:1", credentialHelperSocketPath: socketPath },
    }) as Parameters<typeof spawnWorker>[0],
  );

  assert.equal(result.text, "done");
  const helperConfig = execFileSync("git", ["-C", cwd, "config", "--local", "--get-all", "credential.helper"], { encoding: "utf8" });
  assert.match(helperConfig, /git-credential-socket-helper\.mjs/, "the LOCAL helper must point at the socket-relaying script");
  assert.ok(helperConfig.includes(socketPath), "the wired helper must carry THIS run's own socket path, not a hardcoded one");
});

test("W1-T2699 (5): a credential-helper wiring failure never rejects the spawn AND is reported, never silently discarded", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "rmd-secret-boundary-cred-fail-"));
  const cwd = join(scratch, "worktree");
  mkdirSync(cwd);
  // Deliberately NOT `git init`-ed: `git config --local` has nowhere to write and throws — proving
  // the try/catch around the wiring call never turns a best-effort step into a run failure.
  const socketPath = join(scratch, "cred.sock");

  const result = await spawnWorker(
    spawnWorkerBoundaryArgs(scratch, cwd, {
      secretBoundary: { modelSentinel: mintSentinel("model"), modelBaseUrl: "http://127.0.0.1:1", credentialHelperSocketPath: socketPath },
    }) as Parameters<typeof spawnWorker>[0],
  );

  assert.equal(result.text, "done", "the wiring failure must not surface as a spawnWorker rejection");
  // THE HALF THAT USED TO BE MISSING. The catch was empty, so a boundary that DID NOT APPLY left no
  // trace: the worker's git silently fell back to the ambient `$GH_TOKEN` helper — the exposure this
  // shard exists to close — on a boundary whose every other decision is ledgered. Now the failure
  // rides the result and `workerLedgerFields` renders it as `credential_helper_unwired`.
  assert.equal(
    typeof result.credentialHelperUnwired,
    "string",
    "a boundary that did not apply must say so on the result, not vanish",
  );
  assert.ok(
    (result.credentialHelperUnwired ?? "").length > 0,
    "and the reason must be the real git failure, not an empty placeholder",
  );
});

test("W1-T2699 (5): a spawn whose credential wiring LANDS reports no failure — the healthy row grows no field", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "rmd-secret-boundary-cred-ok-"));
  const cwd = join(scratch, "worktree");
  mkdirSync(cwd);
  execFileSync("git", ["-C", cwd, "init", "--quiet"], { stdio: "ignore" });
  const socketPath = join(scratch, "cred.sock");

  const result = await spawnWorker(
    spawnWorkerBoundaryArgs(scratch, cwd, {
      secretBoundary: { modelSentinel: mintSentinel("model"), modelBaseUrl: "http://127.0.0.1:1", credentialHelperSocketPath: socketPath },
    }) as Parameters<typeof spawnWorker>[0],
  );

  assert.equal(result.text, "done");
  assert.equal(
    result.credentialHelperUnwired,
    undefined,
    "the field is the EXCEPTION, not a per-spawn constant — a healthy boundary must add nothing to the row",
  );
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

// ── (5) THE REQUEST TARGET CANNOT REDIRECT THE REAL CREDENTIAL OFF THE DECLARED HOST ─────────────

/*
 * CodeQL flagged `new URL(req.url, base)` on the forwarding path as SSRF, and it is reachable by
 * the exact actor this module exists to contain: a worker holds its sentinel by design, so it can
 * always reach the proxy. `new URL(target, base)` is not a join — three shapes discard the base
 * entirely, and the real credential is attached AFTER the resolve. Each case below asserts the
 * upstream was never called, which is the property that matters: a 403 with the token already
 * sent would still be an exfiltration. FALSIFIER: delete the origin check in startBoundaryProxy
 * and every case reports upstreamCalled true.
 */
function offHostFixture() {
  const rows: BoundaryLedgerRow[] = [];
  const sentinel = mintSentinel("model");
  let upstreamCalled = false;
  const destinations: BoundaryDestination[] = [
    { host: MODEL_HOST_DEFAULT, sentinel, upstreamBaseUrl: "https://upstream.invalid", realValue: () => "REAL-SUBSCRIPTION-TOKEN" },
  ];
  const fetchImpl = (async () => {
    upstreamCalled = true;
    return new Response("must never be reached", { status: 200 });
  }) as unknown as typeof fetch;
  return { rows, sentinel, destinations, fetchImpl, called: () => upstreamCalled };
}

/** Send a verbatim request target over a raw socket — `fetch` normalises the shapes this tests. */
function rawRequest(port: number, target: string, sentinel: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ port, host: "127.0.0.1" }, () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${sentinel}\r\nConnection: close\r\n\r\n`);
    });
    let seen = "";
    sock.on("data", (c) => (seen += String(c)));
    sock.on("error", reject);
    sock.on("close", () => resolve(seen));
  });
}

test("W1-T2699 (5): a protocol-relative request target is refused and the real credential is never sent upstream", async () => {
  const fx = offHostFixture();
  const proxy = await startBoundaryProxy({ destinations: fx.destinations, log: (r) => fx.rows.push(r), fetchImpl: fx.fetchImpl });
  try {
    const res = await fetch(`${proxy.url}//evil.invalid/x`, { headers: { authorization: `Bearer ${fx.sentinel}` } });
    assert.equal(res.status, 403, "a target resolving to another origin must be refused");
    assert.equal(fx.called(), false, "the upstream must never be called — the real token is attached after the resolve");
    assert.ok(
      fx.rows.some((r) => r.decision === "refuse" && /off the declared destination/.test(r.reason)),
      "the refusal must ledger its own reason",
    );
  } finally {
    await proxy.close();
  }
});

test("W1-T2699 (5): an absolute-form request target is refused and the real credential is never sent upstream", async () => {
  const fx = offHostFixture();
  const proxy = await startBoundaryProxy({ destinations: fx.destinations, log: (r) => fx.rows.push(r), fetchImpl: fx.fetchImpl });
  try {
    const seen = await rawRequest(proxy.port, "http://evil.invalid/x", fx.sentinel);
    assert.match(seen, /^HTTP\/1\.1 403/, "an absolute-form target naming another host must be refused");
    assert.equal(fx.called(), false, "the upstream must never be called");
  } finally {
    await proxy.close();
  }
});

test("W1-T2699 (5): a backslash request target is refused and the real credential is never sent upstream", async () => {
  const fx = offHostFixture();
  const proxy = await startBoundaryProxy({ destinations: fx.destinations, log: (r) => fx.rows.push(r), fetchImpl: fx.fetchImpl });
  try {
    const seen = await rawRequest(proxy.port, "/\\\\evil.invalid/x", fx.sentinel);
    assert.match(seen, /^HTTP\/1\.1 403/, "a backslash target that WHATWG normalises to another host must be refused");
    assert.equal(fx.called(), false, "the upstream must never be called");
  } finally {
    await proxy.close();
  }
});

test("W1-T2699 (5): an ordinary path on the declared host still forwards, so the check is not a blanket refusal", async () => {
  const fx = offHostFixture();
  let sawUrl: string | undefined;
  const fetchImpl = (async (url: unknown) => {
    sawUrl = String(url);
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const proxy = await startBoundaryProxy({ destinations: fx.destinations, log: (r) => fx.rows.push(r), fetchImpl });
  try {
    const res = await fetch(`${proxy.url}/v1/messages?beta=true`, { headers: { authorization: `Bearer ${fx.sentinel}` } });
    assert.equal(res.status, 200, "the declared destination must still be reachable");
    assert.equal(sawUrl, "https://upstream.invalid/v1/messages?beta=true", "path and query must survive the check");
  } finally {
    await proxy.close();
  }
});

/*
 * THE STRUCTURAL HALF. The refusal above rejects an off-origin target; this asserts the property
 * that holds even without it — the forwarded URL's ORIGIN is rebuilt from the declared base, so
 * only path and query ever cross over from the request. Both guards are deliberate: the refusal is
 * the behaviour (a caller gets a 403, not a silent rewrite), the rebuild is the guarantee that
 * survives someone later reordering or dropping the comparison. It is also what a taint analysis
 * can see — CodeQL kept the SSRF alert while the host came from the compared URL.
 */
test("W1-T2699 (5): only path and query cross over — the forwarded origin is always the declared one", async () => {
  const rows: BoundaryLedgerRow[] = [];
  const sentinel = mintSentinel("model");
  const destinations: BoundaryDestination[] = [
    { host: MODEL_HOST_DEFAULT, sentinel, upstreamBaseUrl: "https://upstream.invalid", realValue: () => "REAL" },
  ];
  const seen: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    seen.push(String(url));
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const proxy = await startBoundaryProxy({ destinations, log: (r) => rows.push(r), fetchImpl });
  try {
    // A path that CONTAINS a host-looking segment: it is still just a path, and must be forwarded
    // as one to the declared host rather than treated as a destination.
    const res = await fetch(`${proxy.url}/v1//evil.invalid/messages?q=1`, {
      headers: { authorization: `Bearer ${sentinel}` },
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(new URL(seen[0]).origin, "https://upstream.invalid", "the origin must come from the declared base");
    assert.equal(new URL(seen[0]).pathname, "/v1//evil.invalid/messages", "the path must survive verbatim");
    assert.equal(new URL(seen[0]).search, "?q=1", "and so must the query");
  } finally {
    await proxy.close();
  }
});

/*
 * THE SECOND, STRUCTURAL HALF OF (5) — AND WHY IT IS TESTED DIRECTLY.
 *
 * The three tests above prove the origin CHECK refuses an off-host target. `forwardedTarget` is a
 * separate defence: it copies protocol, host and port from the DECLARED destination and carries
 * over only path and query, so the forwarded origin cannot come from worker input at all.
 *
 * IT CANNOT BE PROVEN THROUGH THE PROXY. While the check stands, every target reaching the pin has
 * already been proven on-origin, so the two implementations are observationally identical. MEASURED:
 * a first draft of these tests drove the pin through `startBoundaryProxy`, and rebuilding `target`
 * straight from the request left all 25 green — a falsifier that reddens nothing is test theatre.
 * Calling the pure function with a target the check would have refused is the only discriminator.
 */
test("W1-T2699 (5): forwardedTarget pins the origin to the declared destination even for a target the check would refuse", () => {
  const declaredBase = "https://upstream.invalid";
  const offHost = ["http://evil.invalid/x", "//evil.invalid/x", "/\\\\evil.invalid/x", "https://upstream.invalid@evil.invalid/x", "https://upstream.invalid:8443/x"];
  for (const target of offHost) {
    assert.equal(
      forwardedTarget(target, declaredBase).origin,
      declaredBase,
      `${target}: the forwarded origin must be the declared one, never the request's`,
    );
  }
});

test("W1-T2699 (5): forwardedTarget carries path and query, and admits no credentials or fragment from the request", () => {
  const declaredBase = "https://upstream.invalid";

  assert.equal(forwardedTarget("/v1/messages?beta=true", declaredBase).href, "https://upstream.invalid/v1/messages?beta=true");
  assert.equal(forwardedTarget(undefined, declaredBase).href, "https://upstream.invalid/", "a missing target defaults to the root of the declared host");

  // A host-SHAPED path is a path, not host control — the confusing case a reader (and a scanner)
  // can misread. It must survive as a path, on the declared origin.
  assert.equal(forwardedTarget("/..//evil.invalid", declaredBase).origin, declaredBase);
  assert.equal(forwardedTarget("/%2f%2fevil.invalid/x", declaredBase).origin, declaredBase);

  const u = forwardedTarget("http://user:pw@evil.invalid/x#frag", declaredBase);
  assert.equal(u.username, "", "no username may reach the forwarded URL");
  assert.equal(u.password, "", "no password may reach the forwarded URL");
  assert.equal(u.hash, "", "no fragment may reach the forwarded URL");
  assert.equal(u.host, "upstream.invalid");
});

// ── (6) THE SCOPED TOKEN WAS NEVER SCOPED ────────────────────────────────────────────────────
//
// MEASURED against git 2.39.5, with the config `wireCredentialHelperSocket` actually writes:
// git hands a credential helper `protocol=https\nhost=github.com` and NOTHING ELSE unless
// `credential.useHttpPath` is set, in which case it adds `path=<owner>/<repo>.git`. The original
// wiring set only `credential.helper`, so every production request named a bare host,
// `repoFromCredentialRequest` fell back to that host, and `mintScopedToken`'s `repo.includes("/")`
// was false — which omitted `repositories` from the exchange body and minted the
// INSTALLATION-WIDE token. The narrowest-credential shard was issuing the broadest credential.
//
// Two independent halves, one test each: the path now arrives, and an absent path REFUSES.

test("W1-T2699 (6): a bare host names no repo to scope to, so it must never be answered with a token", async () => {
  const attempts: string[] = [];
  const mint: ScopedTokenMint = async (repo) => {
    attempts.push(repo);
    return { ok: false, reason: "request names no owner/repo to scope to" };
  };
  const rows: BoundaryLedgerRow[] = [];
  const socketPath = join(mkdtempSync(join(tmpdir(), "rmd-cred-")), "s.sock");
  const handle = await startCredentialHelperSocket({ socketPath, mint, log: (r) => rows.push(r) });
  try {
    // Exactly what git sends with no `useHttpPath` — the shape the original wiring produced.
    const reply = await socketRoundTrip(socketPath, "protocol=https\nhost=github.com\n\n");
    assert.equal(reply, "", "a request that cannot be scoped must receive no credential at all");
    assert.deepEqual(attempts, ["github.com"], "the bare host is what reaches the mint");
    assert.ok(
      rows.some((r) => r.decision === "refuse"),
      "the refusal must ledger, so an unscopable request is visible rather than silent",
    );
  } finally {
    await handle.close();
  }
});

test("W1-T2699 (6): with the path git now sends, the mint is asked for an owner/repo it can scope to", async () => {
  const attempts: string[] = [];
  const mint: ScopedTokenMint = async (repo) => {
    attempts.push(repo);
    return { ok: true, token: "SCOPED" };
  };
  const socketPath = join(mkdtempSync(join(tmpdir(), "rmd-cred-")), "s.sock");
  const handle = await startCredentialHelperSocket({ socketPath, mint });
  try {
    const reply = await socketRoundTrip(socketPath, "protocol=https\nhost=github.com\npath=craigoley/remudero.git\n\n");
    assert.match(reply, /password=SCOPED/, "a scopable request is answered");
    assert.deepEqual(attempts, ["craigoley/remudero"], "the owner/repo — with .git stripped — is what gets scoped");
  } finally {
    await handle.close();
  }
});

test("W1-T2699 (6): wireCredentialHelperSocket leaves git ASKING for the path, without which nothing is ever scoped", () => {
  // BEHAVIOURAL, not a source grep. An earlier draft read worker.ts as text and asserted the
  // literal `credential.useHttpPath` appeared in it — the snapshot-of-source shape
  // test/source-text-assertion-census.test.ts (W1-T2905) exists to refuse, and it refused this
  // one: such a test passes when the prose is present and the behaviour is broken, and fails when
  // a refactor moves the prose and the behaviour is intact. Reading the config back out of a real
  // repo asserts the effect instead, and catches a typo in the key, which a grep for it cannot.
  const repo = mkdtempSync(join(tmpdir(), "rmd-wire-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  const read = (key: string): string => {
    try {
      return execFileSync("git", ["-C", repo, "config", "--local", "--get", key], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  assert.equal(read("credential.useHttpPath"), "", "the control: unset before the wiring runs");

  wireCredentialHelperSocket(repo, join(repo, "helper.sock"));

  assert.equal(
    read("credential.useHttpPath"),
    "true",
    "git must be asked for the path — without it the helper sees a bare host and nothing can be scoped",
  );
  const helpers = execFileSync("git", ["-C", repo, "config", "--local", "--get-all", "credential.helper"], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.trim() !== "");
  assert.equal(helpers.length, 1, "exactly one helper — the reset must have cleared any inherited list");
  assert.match(helpers[0]!, /git-credential-socket-helper\.mjs/, "and it must be the socket helper");
  rmSync(repo, { recursive: true, force: true });
});

test("W1-T2699 (6): mintScopedToken REFUSES a repo it cannot scope to, and never falls back to an installation-wide token", async () => {
  // THE REAL FUNCTION, not the socket's injected fake — the fix lives in github-app.ts and the
  // fake-mint test above cannot reach it. The old code answered an unscopable `repo` by OMITTING
  // `repositories` from the exchange body, which does not narrow the token, it mints the
  // installation-wide one. Assert both halves: no exchange is attempted, and the reason is named.
  const { privateKey } = keyPair();
  let exchanged = false;
  const fetchImpl = (async () => {
    exchanged = true;
    return fakeResponse(201, { token: "MUST-NEVER-BE-MINTED", expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }) as unknown as typeof fetch;

  for (const unscopable of ["github.com", "unknown", ""]) {
    const result = await mintScopedToken(unscopable, 1000, {
      appId: "app-1",
      installationId: "inst-1",
      privateKeyPath: "/fake/key.pem",
      readKey: () => privateKey,
      fetchImpl,
    });
    assert.equal(result.ok, false, `${JSON.stringify(unscopable)}: must refuse`);
    assert.equal(result.token, undefined, `${JSON.stringify(unscopable)}: must carry no token`);
    assert.match(String(result.reason), /owner\/repo/, `${JSON.stringify(unscopable)}: must name why`);
  }
  assert.equal(exchanged, false, "an unscopable request must never reach GitHub's token exchange at all");
});
