// W1-T10872: cloudflared reuses an idle origin socket for up to 90 s, and does not retry a POST.
// Node's 5 s keep-alive default reset every GitHub webhook delivery that reused a socket idle
// past 5 s. This drives the REAL createService server over ONE REAL socket, then a REAL drain.
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, type AddressInfo, type Socket } from "node:net";
import { test } from "node:test";
import { createServeDrain, SERVE_DRAIN_CLOSE_GRACE_MS } from "#src/lib/serve-drain.js";
import {
  CLOUDFLARED_ORIGIN_KEEP_ALIVE_MS,
  createService,
  SERVICE_HEADERS_TIMEOUT_MS,
  SERVICE_KEEP_ALIVE_TIMEOUT_MS,
} from "#src/lib/service.js";

const IDLE_PAST_NODE_DEFAULT_MS = 6_000;

/** Sends one GET on `socket` and resolves with the raw response head, or rejects on reset/EOF. */
function roundTrip(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    const onData = (chunk: Buffer): void => {
      raw += chunk.toString("utf8");
      const headEnd = raw.indexOf("\r\n\r\n");
      const length = /content-length: *(\d+)/i.exec(raw)?.[1];
      const complete = length !== undefined ? raw.length >= headEnd + 4 + Number(length) : raw.endsWith("\r\n0\r\n\r\n");
      if (headEnd !== -1 && complete) {
        cleanup();
        resolve(raw);
      }
    };
    const onError = (e: Error): void => (cleanup(), reject(e));
    const onEnd = (): void => (cleanup(), reject(new Error(`EOF before a response; got ${JSON.stringify(raw)}`)));
    const guard = setTimeout(() => (cleanup(), reject(new Error(`no complete response in 5 s; got ${JSON.stringify(raw)}`))), 5_000);
    const cleanup = (): void => {
      clearTimeout(guard);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
    if (!socket.writable) return onEnd();
    socket.write("GET /v1/hooks/probe HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n", (e) => e && onError(e));
  });
}

test("an origin socket idle past five seconds is still served, and a drain still retires it", async (t) => {
  const server = createService({ tokens: { read: "r-token", write: "w-token" } });
  const drain = createServeDrain({ boundMs: 30_000 });
  drain.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    if (server.listening) server.close();
  });

  const { port } = server.address() as AddressInfo;
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  t.after(() => socket.destroy());

  const first = await roundTrip(socket);
  assert.match(first, /^HTTP\/1\.1 404 /);
  assert.match(first, /connection: keep-alive/i);

  // Past Node's 5 s default: before W1-T10872 this socket was reset here (ECONNRESET or EOF).
  await new Promise((resolve) => setTimeout(resolve, IDLE_PAST_NODE_DEFAULT_MS));
  const second = await roundTrip(socket);
  assert.match(second, /^HTTP\/1\.1 404 /);

  // The configured lifetimes: above cloudflared's reuse, headers clock above it, inside requestTimeout.
  assert.equal(server.keepAliveTimeout, SERVICE_KEEP_ALIVE_TIMEOUT_MS);
  assert.ok(server.keepAliveTimeout > CLOUDFLARED_ORIGIN_KEEP_ALIVE_MS, `keepAliveTimeout ${server.keepAliveTimeout}`);
  assert.equal(CLOUDFLARED_ORIGIN_KEEP_ALIVE_MS, 90_000);
  assert.equal(server.headersTimeout, SERVICE_HEADERS_TIMEOUT_MS);
  assert.ok(server.headersTimeout > server.keepAliveTimeout, `headersTimeout ${server.headersTimeout}`);
  assert.ok(server.headersTimeout <= server.requestTimeout, `requestTimeout ${server.requestTimeout}`);

  // A longer idle lifetime does not lengthen a swap: the drain sweeps this idle socket itself.
  const startedAt = Date.now();
  const closed = once(socket, "close");
  const outcome = await drain.drain("test");
  await closed;
  const elapsed = Date.now() - startedAt;
  assert.equal(outcome, "closed");
  assert.ok(elapsed < SERVE_DRAIN_CLOSE_GRACE_MS + 1_000, `drain took ${elapsed} ms`);
  assert.ok(elapsed < SERVICE_KEEP_ALIVE_TIMEOUT_MS, `drain waited out keep-alive: ${elapsed} ms`);
});
