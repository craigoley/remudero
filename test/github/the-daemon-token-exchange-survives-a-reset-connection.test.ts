import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  MAX_TOKEN_EXCHANGE_ATTEMPTS,
  refreshInstallationToken,
  TOKEN_REFRESH_FAILED_STEP,
} from "#src/lib/github-app.js";

const NOW = Date.UTC(2026, 10, 1, 22, 0, 0);
const TOKEN = "replacement-test-token-never-log";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

type LogRow = { step: string; extra: Record<string, unknown> };
function options(fetchImpl: typeof fetch, logRows: LogRow[], readKey: () => string = () => PRIVATE_KEY_PEM) {
  return {
    env: { GH_TOKEN: "old-test-token", GH_APP_ID: "1", GH_APP_INSTALLATION_ID: "2", GH_APP_PRIVATE_KEY_PATH: "fixture-key" },
    privateKeyPath: "fixture-key",
    readKey,
    now: () => NOW,
    fetchImpl,
    log: (step: string, extra: Record<string, unknown> = {}) => logRows.push({ step, extra }),
  };
}
function tokenResponse(): Response {
  return new Response(JSON.stringify({ token: TOKEN, expires_at: new Date(NOW + 60 * 60 * 1000).toISOString() }), {
    status: 201, headers: { "content-type": "application/json" },
  });
}
function socketError(code: string): Error & { code: string } {
  const error = new Error(`socket failed: ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

for (const code of ["EPIPE", "ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT"]) {
  test(`a GitHub App token exchange retries ${code} on a close-after-request connection`, async () => {
    let calls = 0;
    const rows: LogRow[] = [];
    const env = { GH_TOKEN: "old-test-token", GH_APP_ID: "1", GH_APP_INSTALLATION_ID: "2", GH_APP_PRIVATE_KEY_PATH: "fixture-key" };
    const result = await refreshInstallationToken({
      ...options(async (_url, init) => {
        calls++;
        assert.equal(new Headers(init?.headers).get("connection"), "close");
        if (calls === 1) throw socketError(code);
        return tokenResponse();
      }, rows),
      env,
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.equal(env.GH_TOKEN, TOKEN, "the successful retry publishes its token to the existing consumer seam");
    const failures = rows.filter(row => row.step === TOKEN_REFRESH_FAILED_STEP);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.extra.reason, `exchange request failed: ${code}`);
    assert.equal(failures[0]?.extra.retry_attempt, 2);
    assert.equal(failures[0]?.extra.max_attempts, MAX_TOKEN_EXCHANGE_ATTEMPTS);
    assert.equal(JSON.stringify(rows).includes(TOKEN), false, "ledger data never contains the minted token");
  });
}

test("token exchange retries stop after the configured attempt bound", async () => {
  let calls = 0;
  const rows: LogRow[] = [];
  const result = await refreshInstallationToken(options(async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("connection"), "close");
    throw socketError("ECONNRESET");
  }, rows));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "exchange request failed: ECONNRESET");
  assert.equal(calls, MAX_TOKEN_EXCHANGE_ATTEMPTS);
  const failures = rows.filter(row => row.step === TOKEN_REFRESH_FAILED_STEP);
  assert.equal(failures.length, MAX_TOKEN_EXCHANGE_ATTEMPTS);
  assert.deepEqual(failures.map(row => row.extra.retry_attempt), [2, 3, undefined]);
  assert.ok(failures.every(row => row.extra.reason === "exchange request failed: ECONNRESET"));
});

test("non-socket errors and rejected exchanges are not retried", async () => {
  for (const rejected of [false, true]) {
    let calls = 0;
    const rows: LogRow[] = [];
    const result = await refreshInstallationToken(options(async () => {
      calls++;
      if (rejected) return new Response("{}", { status: 401 });
      throw socketError("ECONNREFUSED");
    }, rows));
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(rows.some(row => "retry_attempt" in row.extra), false);
  }

  let calls = 0;
  const rows: LogRow[] = [];
  const result = await refreshInstallationToken(options(async () => {
    calls++;
    return tokenResponse();
  }, rows, () => { throw new Error("unreadable test key"); }));
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "private key unreadable");
});

test("a real socket reset is retried on a distinct connection and closed after the request", { timeout: 15000 }, async t => {
  const sockets: object[] = [];
  const server = createServer((req, res) => {
    sockets.push(req.socket);
    assert.equal(req.headers.connection, "close");
    if (sockets.length === 1) {
      req.socket.destroy();
      return;
    }
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: TOKEN, expires_at: new Date(NOW + 60 * 60 * 1000).toISOString() }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const rows: LogRow[] = [];
  let calls = 0;
  const result = await refreshInstallationToken(options(async (_url, init) => {
    calls++;
    return fetch(`http://127.0.0.1:${address.port}/token`, init);
  }, rows));
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(sockets.length, 2);
  assert.notEqual(sockets[0], sockets[1], "the retry uses a newly accepted TCP connection");
  assert.equal(JSON.stringify(rows).includes(TOKEN), false);
});
