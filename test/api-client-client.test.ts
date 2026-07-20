import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService, type Route, type SseRoute } from "../src/lib/service.js";
import { createDaemonClient, type StatusProjection, type StatusSnapshot } from "../packages/api-client/src/client.js";

// ── W3-T2: @remudero/api-client's FIRST runtime layer (MASTER-PLAN §7A) ─────────────────────
//
// packages/api-client/src/client.ts is the ONE sanctioned place a runtime HTTP/SSE layer may
// live (scripts/no-hand-rolled-fetch-check.mjs excludes it by name). This suite drives it
// against a REAL createService()-backed HTTP server -- never a mock of `fetch` -- proving
// getStatus()/subscribeStatus() actually speak the wire protocol src/lib/service.ts defines
// (bearer auth, JSON body, `event:`/`data:` SSE framing), the same discipline
// test/service.test.ts and test/board.test.ts already hold their layers to.

const READ_TOKEN = "client-read-token";
const WRITE_TOKEN = "client-write-token";

const SNAPSHOT: StatusSnapshot = {
  generated_at: "2026-07-19T00:00:00.000Z",
  tasks: [{ taskId: "A", status: "queued", merged: false, source: "none" }],
};

function buildFixtureService() {
  let unsubscribed = false;
  let pushEvent: ((projection: StatusProjection) => void) | undefined;

  const routes: Route[] = [
    {
      method: "GET",
      path: "/v1/status",
      scope: "read",
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(SNAPSHOT));
      },
    },
  ];
  const sse: SseRoute[] = [
    {
      path: "/v1/status/stream",
      scope: "read",
      subscribe: (send) => {
        pushEvent = (projection) => send("status", projection);
        return () => {
          unsubscribed = true;
        };
      },
    },
  ];

  return {
    server: createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes, sse }),
    push: (projection: StatusProjection) => pushEvent?.(projection),
    wasUnsubscribed: () => unsubscribed,
  };
}

async function withFixture<T>(fn: (baseUrl: string, fixture: ReturnType<typeof buildFixtureService>) => Promise<T>): Promise<T> {
  const fixture = buildFixtureService();
  await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  const port = (fixture.server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, fixture);
  } finally {
    fixture.server.close();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

test("createDaemonClient.getStatus(): fetches GET /v1/status with the bearer token, returns the parsed snapshot", async () => {
  await withFixture(async (baseUrl) => {
    const client = createDaemonClient({ baseUrl, token: READ_TOKEN });
    const snapshot = await client.getStatus();
    assert.deepEqual(snapshot, SNAPSHOT);
  });
});

test("createDaemonClient.getStatus(): a 401 (bad token) throws rather than returning a bogus snapshot", async () => {
  await withFixture(async (baseUrl) => {
    const client = createDaemonClient({ baseUrl, token: "not-a-real-token" });
    await assert.rejects(() => client.getStatus());
  });
});

test("createDaemonClient.subscribeStatus(): parses SSE `status` events into StatusProjection objects", async () => {
  await withFixture(async (baseUrl, fixture) => {
    const client = createDaemonClient({ baseUrl, token: READ_TOKEN });
    const received: StatusProjection[] = [];
    const unsubscribe = client.subscribeStatus((projection) => received.push(projection));
    try {
      await new Promise((resolve) => setTimeout(resolve, 50)); // let the stream open + prime
      const flip: StatusProjection = { taskId: "A", status: "merged", merged: true, source: "ledger", prNumber: 1 };
      fixture.push(flip);
      await waitFor(() => received.length > 0);
      assert.deepEqual(received[0], flip);
    } finally {
      unsubscribe();
    }
  });
});

test("createDaemonClient.subscribeStatus(): the returned unsubscribe aborts the stream (server sees the disconnect)", async () => {
  await withFixture(async (baseUrl, fixture) => {
    const client = createDaemonClient({ baseUrl, token: READ_TOKEN });
    const unsubscribe = client.subscribeStatus(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    unsubscribe();
    await waitFor(() => fixture.wasUnsubscribed());
    assert.equal(fixture.wasUnsubscribed(), true);
  });
});
