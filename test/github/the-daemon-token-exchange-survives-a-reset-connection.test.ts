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
function interruptedResponse(code: string): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`{"token":"${TOKEN}",`));
      controller.error(new TypeError("terminated", { cause: socketError(code) }));
    },
  }), { status: 201 });
}

for (const code of ["EPIPE", "ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT"]) {
  test(`a token response body interrupted by ${code} retries before publishing the token`, async () => {
    let calls = 0;
    const rows: LogRow[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const opts = options(async (_url, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get("connection"), "close");
      signals.push(init?.signal);
      assert.equal(opts.env.GH_TOKEN, "old-test-token");
      return calls === 1 ? interruptedResponse(code) : tokenResponse();
    }, rows);
    const result = await refreshInstallationToken(opts);
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.notEqual(signals[0], signals[1], "each attempt has an independent abort controller");
    assert.equal(opts.env.GH_TOKEN, TOKEN);
    assert.deepEqual(rows.filter(row => row.step === TOKEN_REFRESH_FAILED_STEP), [{
      step: TOKEN_REFRESH_FAILED_STEP,
      extra: { reason: `exchange request failed: ${code}`, retry_attempt: 2, max_attempts: MAX_TOKEN_EXCHANGE_ATTEMPTS },
    }]);
    assert.equal(JSON.stringify(rows).includes(TOKEN), false);
  });

  test(`token response body retries for ${code} stop at the attempt bound`, async () => {
    let calls = 0;
    const rows: LogRow[] = [];
    const opts = options(async (_url, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get("connection"), "close");
      return interruptedResponse(code);
    }, rows);
    assert.deepEqual(await refreshInstallationToken(opts), { ok: false, reason: `exchange request failed: ${code}` });
    assert.equal(calls, MAX_TOKEN_EXCHANGE_ATTEMPTS);
    assert.equal(opts.env.GH_TOKEN, "old-test-token");
    const failures = rows.filter(row => row.step === TOKEN_REFRESH_FAILED_STEP);
    assert.equal(failures.length, MAX_TOKEN_EXCHANGE_ATTEMPTS);
    assert.deepEqual(failures.map(row => row.extra.retry_attempt), [2, 3, undefined]);
    assert.ok(failures.every(row => row.extra.reason === `exchange request failed: ${code}`));
    assert.equal(JSON.stringify(rows).includes(TOKEN), false);
  });

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

test("malformed JSON and rejected exchanges with interrupted bodies are not retried", async () => {
  for (const status of [201, 401, 403]) {
    let calls = 0;
    const rows: LogRow[] = [];
    const opts = options(async () => {
      calls++;
      return status === 201
        ? new Response(`{"token":"${TOKEN}","error":"UND_ERR_SOCKET"`, { status })
        : new Response(new ReadableStream({ start(controller) { controller.error(socketError("UND_ERR_SOCKET")); } }), { status });
    }, rows);
    const reason = status === 201 ? "exchange response unparsable" : `exchange rejected: ${status}`;
    assert.deepEqual(await refreshInstallationToken(opts), { ok: false, reason });
    assert.equal(calls, 1);
    assert.equal(opts.env.GH_TOKEN, "old-test-token");
    assert.deepEqual(rows, [{ step: TOKEN_REFRESH_FAILED_STEP, extra: { reason } }]);
    assert.equal(JSON.stringify(rows).includes(TOKEN), false);
  }
});

for (const duringBody of [false, true]) {
test(`a real socket reset ${duringBody ? "during the body" : "before headers"} retries on a distinct closed connection`, { timeout: 15000 }, async t => {
  const sockets: object[] = [];
  const server = createServer((req, res) => {
    sockets.push(req.socket);
    assert.equal(req.headers.connection, "close");
    if (sockets.length === 1) {
      if (duringBody) {
        res.writeHead(201, { "content-type": "application/json" });
        res.write(`{"token":"${TOKEN}",`);
      } else {
        req.socket.destroy();
      }
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
  const opts = options(async (_url, init) => {
    calls++;
    const response = await fetch(`http://127.0.0.1:${address.port}/token`, init);
    if (duringBody && calls === 1) server.closeAllConnections();
    return response;
  }, rows);
  const result = await refreshInstallationToken(opts);
  assert.equal(result.ok, true, JSON.stringify({ result, rows }));
  assert.equal(opts.env.GH_TOKEN, TOKEN);
  assert.equal(calls, 2);
  assert.equal(sockets.length, 2);
  assert.notEqual(sockets[0], sockets[1], "the retry uses a newly accepted TCP connection");
  const failures = rows.filter(row => row.step === TOKEN_REFRESH_FAILED_STEP);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.extra.reason, "exchange request failed: UND_ERR_SOCKET");
  assert.equal(failures[0]?.extra.retry_attempt, 2);
  assert.equal(JSON.stringify(rows).includes(TOKEN), false);
});
}
