import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService, type Route, type SseRoute } from "../src/lib/service.js";
import { createDaemonClient, type StatusProjection, type StatusSnapshot } from "../packages/api-client/src/client.js";
import {
  buildAnswerQuestionRoute,
  buildApproveManualRoute,
  buildPauseRoute,
  buildQuietHoursRoute,
  buildResumeRoute,
  buildStopRoute,
  type IssueCloser,
} from "../src/lib/panel-actions.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ── W3-T5: the write-scoped panel-action methods (MASTER-PLAN §7) ──────────────────────────
//
// Same discipline: drive createDaemonClient against a REAL createService()-backed server
// registering the real src/lib/panel-actions.ts routes, never a mock of fetch.

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-api-client-panel-"));
}

function fakeIssueCloser(): IssueCloser & { closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    close(issueUrl: string) {
      closed.push(issueUrl);
    },
  };
}

function buildWriteFixtureService(root: string, issues: IssueCloser = fakeIssueCloser()) {
  const deps = { root, ledgerPath: join(root, "state", "ledger.ndjson"), issues };
  const routes: Route[] = [
    buildPauseRoute(deps),
    buildResumeRoute(deps),
    buildStopRoute(deps),
    buildQuietHoursRoute(deps),
    buildAnswerQuestionRoute(deps),
    buildApproveManualRoute(deps),
  ];
  return createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes });
}

async function withWriteFixture<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = buildWriteFixtureService(tmpRoot());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("createDaemonClient.pauseFleet(): POSTs /v1/control/pause with a write-scoped token, returns the result", async () => {
  await withWriteFixture(async (baseUrl) => {
    const client = createDaemonClient({ baseUrl, token: WRITE_TOKEN });
    const result = await client.pauseFleet("operator break");
    assert.deepEqual(result, { paused: true, reason: "operator break" });
  });
});

test("createDaemonClient.pauseFleet(): reason omitted still works", async () => {
  await withWriteFixture(async (baseUrl) => {
    const client = createDaemonClient({ baseUrl, token: WRITE_TOKEN });
    const result = await client.pauseFleet();
    assert.deepEqual(result, { paused: true, reason: null });
  });
});

test("createDaemonClient.resumeFleet(): POSTs /v1/control/resume, returns what cleared", async () => {
  await withWriteFixture(async (baseUrl) => {
    const client = createDaemonClient({ baseUrl, token: WRITE_TOKEN });
    const result = await client.resumeFleet();
    assert.deepEqual(result, { clearedStop: false, clearedPause: false });
  });
});

test("createDaemonClient.stopFleet(): POSTs /v1/control/stop, returns the result", async () => {
  await withWriteFixture(async (baseUrl) => {
    const client = createDaemonClient({ baseUrl, token: WRITE_TOKEN });
    const result = await client.stopFleet("panel STOP");
    assert.deepEqual(result, { stopped: true, reason: "panel STOP" });
  });
});

test("createDaemonClient.setQuietHours(): POSTs /v1/quiet-hours, returns the resulting state", async () => {
  await withWriteFixture(async (baseUrl) => {
    const client = createDaemonClient({ baseUrl, token: WRITE_TOKEN });
    assert.deepEqual(await client.setQuietHours(true), { quietHours: true });
    assert.deepEqual(await client.setQuietHours(false), { quietHours: false });
  });
});

test("createDaemonClient.answerQuestion(): POSTs /v1/questions/answer, returns the recorded answer", async () => {
  await withWriteFixture(async (baseUrl) => {
    const client = createDaemonClient({ baseUrl, token: WRITE_TOKEN });
    const result = await client.answerQuestion("W1-T78", "use approach X");
    assert.deepEqual(result, { ok: true, taskId: "W1-T78", answer: "use approach X" });
  });
});

test("createDaemonClient.approveManualItem(): POSTs /v1/manual/approve, returns the approval", async () => {
  const issues = fakeIssueCloser();
  await new Promise<void>((resolve) => {
    const root = tmpRoot();
    const server = buildWriteFixtureService(root, issues);
    server.listen(0, "127.0.0.1", async () => {
      const port = (server.address() as AddressInfo).port;
      const client = createDaemonClient({ baseUrl: `http://127.0.0.1:${port}`, token: WRITE_TOKEN });
      const issueUrl = "https://github.com/craigoley/remudero/issues/42";
      const result = await client.approveManualItem("W2-T3", issueUrl);
      assert.deepEqual(result, { ok: true, taskId: "W2-T3", issueUrl });
      assert.deepEqual(issues.closed, [issueUrl]);
      server.close();
      resolve();
    });
  });
});

test("createDaemonClient write methods: a read-only token gets a thrown 403, never a silent no-op", async () => {
  await withWriteFixture(async (baseUrl) => {
    const client = createDaemonClient({ baseUrl, token: READ_TOKEN });
    await assert.rejects(() => client.stopFleet(), /403/);
  });
});

test("createDaemonClient.answerQuestion(): a 400 (invalid body) throws with the daemon's detail, not a bogus result", async () => {
  await withWriteFixture(async (baseUrl) => {
    const client = createDaemonClient({ baseUrl, token: WRITE_TOKEN });
    // Empty taskId is well-typed but fails the daemon's runtime validation (src/lib/panel-actions.ts).
    await assert.rejects(() => client.answerQuestion("", "x"), /400/);
  });
});

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
