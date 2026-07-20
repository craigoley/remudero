import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService, type Route, type SseRoute } from "../src/lib/service.js";

// ── W3-T1a: daemon service surface v0 (MASTER-PLAN §7A) ──
//
// Acceptance: "the daemon serves REST + SSE on a SINGLE port with bearer READ
// and WRITE scopes enforced" -- proof: a read-scope token can GET state +
// subscribe to the SSE stream but a WRITE call is 403; a write-scope token
// succeeds; both on one port. Every test below drives the real HTTP server
// `createService` returns (never a mock of it) with routes registered the
// same way a real CLI wiring would -- this module is the generic mechanism,
// so its own falsifier registers routes directly, exactly like
// `test/daemon.test.ts` proves `runDaemon` with injected fakes rather than a
// live GitHub.

const READ_TOKEN = "read-scope-token-abc123";
const WRITE_TOKEN = "write-scope-token-xyz789";

interface TestService {
  server: ReturnType<typeof createService>;
  wasUnsubscribed: () => boolean;
}

function buildTestService(): TestService {
  let unsubscribed = false;

  const routes: Route[] = [
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

  const sse: SseRoute[] = [
    {
      path: "/events",
      scope: "read",
      subscribe: (send) => {
        send("ping", { hello: "world" });
        return () => {
          unsubscribed = true;
        };
      },
    },
  ];

  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes, sse });
  return { server, wasUnsubscribed: () => unsubscribed };
}

async function withService<T>(fn: (baseUrl: string, svc: TestService) => Promise<T>): Promise<T> {
  const svc = buildTestService();
  await new Promise<void>((resolve) => svc.server.listen(0, "127.0.0.1", resolve));
  const port = (svc.server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, svc);
  } finally {
    svc.server.close();
  }
}

test("service surface: a read-scope token can GET state", async () => {
  await withService(async (base) => {
    const res = await fetch(`${base}/state`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("service surface: a read-scope token is 403 on a WRITE route", async () => {
  await withService(async (base) => {
    const res = await fetch(`${base}/control/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { required_scope: string };
    assert.equal(body.required_scope, "write");
  });
});

test("service surface: a write-scope token succeeds on the WRITE route AND the read route -- SAME port", async () => {
  await withService(async (base) => {
    const write = await fetch(`${base}/control/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    });
    assert.equal(write.status, 200);
    assert.deepEqual(await write.json(), { paused: true });

    // ONE surface, not two -- the same server/port also serves the read route.
    const read = await fetch(`${base}/state`, { headers: { authorization: `Bearer ${WRITE_TOKEN}` } });
    assert.equal(read.status, 200);
  });
});

test("service surface: a read-scope token can subscribe to the SSE stream, on the same port as REST", async () => {
  await withService(async (base) => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events`, {
      headers: { authorization: `Bearer ${READ_TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");

    const reader = res.body!.getReader();
    // Skip the priming comment (":ok\n\n") if it arrives as its own chunk, then
    // find the real event frame.
    let received = "";
    while (!received.includes("event: ping")) {
      const { value, done } = await reader.read();
      if (done) break;
      received += Buffer.from(value!).toString("utf8");
    }
    assert.match(received, /event: ping/);
    assert.match(received, /"hello":"world"/);

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

test("service surface: aborting an SSE connection runs the route's unsubscribe (no leaked subscription)", async () => {
  await withService(async (base, svc) => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events`, {
      headers: { authorization: `Bearer ${READ_TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    controller.abort();
    // let the server's `req.on("close")` handler fire
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(svc.wasUnsubscribed(), true);
  });
});

test("service surface: no bearer token -> 401", async () => {
  await withService(async (base) => {
    const res = await fetch(`${base}/state`);
    assert.equal(res.status, 401);
  });
});

test("service surface: an unrecognized bearer token -> 401 (not 403)", async () => {
  await withService(async (base) => {
    const res = await fetch(`${base}/state`, { headers: { authorization: "Bearer not-a-real-token" } });
    assert.equal(res.status, 401);
  });
});

test("service surface: an unknown path -> 404, even with a valid token", async () => {
  await withService(async (base) => {
    const res = await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 404);
  });
});

// W3-T3 fix round: a real WKWebView (the Tauri shell) sending the `authorization` header
// triggers a browser CORS preflight (`OPTIONS`) before the actual request -- Node's own
// `fetch`, what every OTHER test in this file drives, never emulates that, so this whole
// class was invisible until a real browser-family client (WebKit) hit it. These two tests
// drive the preflight and the real-response headers directly, over HTTP, the same discipline
// as every other assertion in this file.
test("service surface: an OPTIONS preflight succeeds with CORS headers, UNAUTHENTICATED (no bearer token needed)", async () => {
  await withService(async (base) => {
    const res = await fetch(`${base}/state`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /GET/);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /authorization/);
  });
});

test("service surface: every real response carries Access-Control-Allow-Origin -- success AND error paths, so a browser can read them", async () => {
  await withService(async (base) => {
    const ok = await fetch(`${base}/state`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "*");

    const unauthorized = await fetch(`${base}/state`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), "*");

    const notFound = await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(notFound.status, 404);
    assert.equal(notFound.headers.get("access-control-allow-origin"), "*");
  });
});

test("service surface: a handler that throws -> 500, never crashes the server", async () => {
  await withService(async (base, svc) => {
    // register a throwing route on a FRESH service instance sharing the same tokens,
    // to prove the catch path without disturbing the other fixtures' routes.
    const throwing = createService({
      tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
      routes: [
        {
          method: "GET",
          path: "/boom",
          scope: "read",
          handler: () => {
            throw new Error("kaboom");
          },
        },
      ],
    });
    await new Promise<void>((resolve) => throwing.listen(0, "127.0.0.1", resolve));
    const port = (throwing.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/boom`, {
        headers: { authorization: `Bearer ${READ_TOKEN}` },
      });
      assert.equal(res.status, 500);
    } finally {
      throwing.close();
    }
    void svc; // outer service untouched by this sub-fixture
  });
});
