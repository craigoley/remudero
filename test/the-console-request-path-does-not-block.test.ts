// @source-text-subject: this suite's first two assertions intentionally inspect route handler
// source text because W1-T3192's deliverable is a request-path census/ratchet.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  buildServeRoutes,
  buildServeServer,
  boundConsoleReadRoutes,
  buildInboxDigestsRoute,
  consoleBlockingRequestPathViolations,
  CONSOLE_BLOCKING_REQUEST_PATH_BASELINE,
  CONSOLE_READ_ROUTE_BUDGET_MS,
  type ServeDeps,
} from "../src/lib/serve.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { Route } from "../src/lib/service.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";

const READ_TOKEN = "read-token";
const WRITE_TOKEN = "write-token";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T3192-FIXTURE",
    title: "fixture",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "high",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function scmFixture(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    findMergedByTrailerAll: () => [],
    findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [],
    listOpenHeadBranches: () => [],
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    readTruncated: () => false,
  };
}

function traceFixture(): TraceGithub {
  return { prView: () => null };
}

function fakeIssueCloser(): IssueCloser {
  return { close() {} };
}

function fakeRatifyGateway(): RatifyCliGateway {
  return { approve() {}, reframe() {} };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-console-nonblocking-"));
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function writePlan(root: string, plan: Plan): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(
    planPath,
    plan.tasks.map((t) => `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}\n`).join("") || "[]\n",
    { flag: "wx" },
  );
  return planPath;
}

function depsFor(root: string, plan: Plan = planOf([task()])): ServeDeps {
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, plan);
  const github = scmFixture();
  return {
    board: { plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: traceFixture(), statusGithub: github, ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
    githubAppRefresh: { start: () => ({ armed: false }) },
  };
}

async function withServeServer<T>(deps: ServeDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

async function serveRoute(route: Route, path: string = route.path): Promise<Response> {
  const server = createServer((req, res) => {
    void route.handler(req, res, { params: {} });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}${path}`);
    const body = await res.arrayBuffer();
    return new Response(body, { status: res.status, headers: res.headers });
  } finally {
    server.close();
  }
}

test("console blocking request-path census is a zero ratchet over the assembled read routes", () => {
  const routes = buildServeRoutes(depsFor(tmpRoot()));
  const violations = consoleBlockingRequestPathViolations(routes);
  assert.deepEqual(violations, []);
  assert.equal(violations.length, CONSOLE_BLOCKING_REQUEST_PATH_BASELINE);
});

test("console blocking request-path census reports a synthetic blocking read route", () => {
  const synthetic: Route = {
    method: "GET",
    path: "/v1/synthetic",
    scope: "read",
    handler: (_req, res) => {
      const value = readFileSync("/tmp/rmd-synthetic", "utf8");
      res.end(value);
    },
  };
  assert.deepEqual(consoleBlockingRequestPathViolations([synthetic]), [
    { route: "GET /v1/synthetic", symbol: "readFileSync" },
  ]);
  assert.deepEqual(consoleBlockingRequestPathViolations(boundConsoleReadRoutes([synthetic], depsFor(tmpRoot()))), [
    { route: "GET /v1/synthetic", symbol: "readFileSync" },
  ]);
});

test("console read routes answer within budget under four fetches plus an open SSE stream", async () => {
  const deps = depsFor(tmpRoot(), planOf([task({ id: "W1-T3192-A" }), task({ id: "W1-T3192-B" })]));
  await withServeServer(deps, async (base) => {
    const ac = new AbortController();
    const stream = await fetch(`${base}/v1/status/stream`, {
      headers: { authorization: `Bearer ${READ_TOKEN}` },
      signal: ac.signal,
    });
    assert.equal(stream.status, 200);

    const started = performance.now();
    const responses = await Promise.all(
      ["/v1/status", "/v1/recent", "/v1/inbox", "/v1/daemon-health"].map((path) =>
        fetch(`${base}${path}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } }),
      ),
    );
    const elapsedMs = performance.now() - started;
    ac.abort();

    assert.ok(elapsedMs < CONSOLE_READ_ROUTE_BUDGET_MS, `overlapping console fetches took ${elapsedMs.toFixed(1)}ms`);
    for (const res of responses) assert.equal(res.status, 200);
    const bodies = await Promise.all(responses.map((res) => res.json() as Promise<{ staleness?: { budgetMs?: number }; tasks?: unknown[] }>));
    assert.equal(bodies[0].tasks?.length, 2);
    assert.ok(bodies.every((body) => body.staleness?.budgetMs === CONSOLE_READ_ROUTE_BUDGET_MS));
  });
});

test("an over-budget console read route returns a stale fallback with staleness instead of waiting unbounded", async () => {
  const root = tmpRoot();
  const deps = depsFor(root, planOf([task({ id: "W1-T3192-SLOW" })]));
  const slowStatus: Route = {
    method: "GET",
    path: "/v1/status",
    scope: "read",
    handler: async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ generated_at: new Date().toISOString(), tasks: [{ taskId: "late" }] }));
    },
  };
  const [route] = boundConsoleReadRoutes([slowStatus], deps, 20);
  const server = createServer((req, res) => {
    void route.handler(req, res, { params: {} });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const started = performance.now();
    const res = await fetch(`${base}/v1/status`);
    const elapsedMs = performance.now() - started;
    const body = (await res.json()) as { tasks: unknown[]; staleness?: { stale?: boolean; ageMs?: number | null; refreshing?: boolean } };
    assert.ok(elapsedMs < CONSOLE_READ_ROUTE_BUDGET_MS, `stale fallback took ${elapsedMs.toFixed(1)}ms`);
    assert.equal(res.headers.get("x-rmd-cache-state"), "stale");
    assert.equal(body.tasks.length, 1);
    assert.equal(body.staleness?.stale, true);
    assert.equal(body.staleness?.ageMs, null);
    assert.equal(body.staleness?.refreshing, true);
  } finally {
    server.close();
  }
});

test("over-budget cached JSON routes return route-shaped stale fallbacks", async () => {
  const deps = depsFor(tmpRoot());
  deps.daemonHealth = { defaultPollIntervalMs: 50 };
  for (const [path, assertBody] of [
    ["/v1/recent", (body: Record<string, unknown>) => assert.deepEqual(body.entries, [])],
    ["/v1/inbox", (body: Record<string, unknown>) => {
      assert.deepEqual(body.ready, []);
      assert.deepEqual(body.drafting, []);
      assert.deepEqual(body.notReady, []);
    }],
    ["/v1/daemon-health", (body: Record<string, unknown>) => assert.equal(body.pollIntervalMs, 50)],
  ] as const) {
    const slow: Route = {
      method: "GET",
      path,
      scope: "read",
      handler: async (_req, res) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      },
    };
    const [route] = boundConsoleReadRoutes([slow], deps, 20);
    const res = await serveRoute(route);
    const body = (await res.json()) as Record<string, unknown> & { staleness?: { stale?: boolean; refreshing?: boolean } };
    assert.equal(res.headers.get("x-rmd-cache-state"), "stale");
    assert.equal(body.staleness?.stale, true);
    assert.equal(body.staleness?.refreshing, true);
    assertBody(body);
  }
});

test("cached console read routes reuse buffered bodies when a later refresh misses the budget", async () => {
  const deps = depsFor(tmpRoot());
  let calls = 0;
  const source: Route = {
    method: "GET",
    path: "/v1/recent",
    scope: "read",
    handler: async (_req, res) => {
      calls += 1;
      if (calls > 1) await new Promise((resolve) => setTimeout(resolve, 200));
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.write('{"entries":[');
      res.end('{"id":"cached"}]}');
    },
  };
  const [route] = boundConsoleReadRoutes([source], deps, 20);
  const first = await serveRoute(route);
  assert.equal(first.headers.get("x-rmd-cache-state"), "fresh");
  const second = await serveRoute(route);
  const body = (await second.json()) as { entries?: Array<{ id?: string }>; staleness?: { stale?: boolean; ageMs?: number | null } };
  assert.equal(second.headers.get("x-rmd-cache-state"), "stale");
  assert.equal(body.entries?.[0]?.id, "cached");
  assert.equal(body.staleness?.stale, true);
  assert.equal(typeof body.staleness?.ageMs, "number");
});

test("a malformed cached JSON body is preserved while cache headers still report staleness", async () => {
  const deps = depsFor(tmpRoot());
  const source: Route = {
    method: "GET",
    path: "/v1/recent",
    scope: "read",
    handler: (_req, res) => {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end("{malformed");
    },
  };
  const [route] = boundConsoleReadRoutes([source], deps, 20);
  const response = await serveRoute(route);

  assert.equal(await response.text(), "{malformed");
  assert.equal(response.headers.get("x-rmd-cache-state"), "fresh");
  assert.ok(Number.isFinite(Number(response.headers.get("x-rmd-cache-age-ms"))));
});

test("a throwing cached JSON route returns its stale fallback with the failure reason", async () => {
  const deps = depsFor(tmpRoot());
  const source: Route = {
    method: "GET",
    path: "/v1/recent",
    scope: "read",
    handler: async () => {
      throw new Error("refresh exploded");
    },
  };
  const [route] = boundConsoleReadRoutes([source], deps, 20);
  const res = await serveRoute(route);
  const body = (await res.json()) as { entries?: unknown[]; staleness?: { stale?: boolean; reason?: string } };
  assert.equal(res.headers.get("x-rmd-cache-state"), "stale");
  assert.deepEqual(body.entries, []);
  assert.equal(body.staleness?.stale, true);
  assert.equal(body.staleness?.reason, "refresh exploded");
});

test("the document shell is served live and reports an unreadable checkout sha", async () => {
  const deps = depsFor(tmpRoot());
  deps.resolveCurrentSha = () => {
    throw new Error("git unavailable");
  };
  await withServeServer(deps, async (base) => {
    const res = await fetch(`${base}/`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.headers.get("x-rmd-cache-state"), null);
    const html = await res.text();
    assert.match(html, /data-idle-reasons="unknown"/);
    assert.match(html, /console-code-unknown/);
  });
});

test("an injected inbox digest reader returns directly through the real route", async () => {
  const route = buildInboxDigestsRoute({
    root: tmpRoot(),
    read: () => ({ entries: [{ ts: "2026-09-08T00:00:00.000Z", text: "W1-T3192-DIGEST" }], omitted: 0 }),
  });
  const res = await serveRoute(route, "/v1/inbox/digests");
  const body = (await res.json()) as { entries?: Array<{ text?: string }> };
  assert.equal(body.entries?.[0]?.text, "W1-T3192-DIGEST");
});
