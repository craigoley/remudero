// W1-T3925: cold first reads of /v1/status, /v1/recent and /v1/daemon-health must return within
// the client's stated budget, and a same-event-loop expensive read must not be able to starve the
// cache-fallback timer's own registration. W1-T3192's own suite (test/the-console-request-path-
// does-not-block.test.ts) measures OVERLAPPING WARM requests; nothing there exercises a COLD
// cache with nothing to fall back to, nor a handler that blocks the event loop on its own turn
// before the fallback timer would otherwise fire. These two shapes are this file's whole concern.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { boundConsoleReadRoutes, CONSOLE_READ_ROUTE_BUDGET_MS, type ServeDeps } from "../src/lib/serve.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { Route } from "../src/lib/service.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T3925-FIXTURE",
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
  return mkdtempSync(join(tmpdir(), "rmd-cold-status-"));
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
    tokens: { read: "read-token", write: "write-token" },
    pollMs: 50,
    githubAppRefresh: { start: () => ({ armed: false }) },
  };
}

async function serveRoute(route: Route): Promise<Response> {
  const server = createServer((req, res) => {
    void route.handler(req, res, { params: {} });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}${route.path}`);
    const body = await res.arrayBuffer();
    return new Response(body, { status: res.status, headers: res.headers });
  } finally {
    server.close();
  }
}

/** A REAL synchronous event-loop block — not a promise-based delay — standing in for the ~7.5s
 *  synchronous cold-walk (e.g. an `execFileSync` git scan) this task's rationale names. Nothing
 *  else on the process can run, including an already-registered `setTimeout`, until this returns. */
function busyWaitMs(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* deliberately spin the CPU to occupy the event loop, exactly like a synchronous fs/exec call would */
  }
}

function slowJsonRoute(path: string, delayMs: number, blockFirstMs = 0): Route {
  return {
    method: "GET",
    path,
    scope: "read",
    handler: async (_req, res) => {
      if (blockFirstMs > 0) busyWaitMs(blockFirstMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ generated_at: new Date().toISOString(), tasks: [{ taskId: "late" }] }));
    },
  };
}

test("a cold status read with no warm snapshot returns within the client budget instead of waiting for the full read", async () => {
  const deps = depsFor(tmpRoot(), planOf([task({ id: "W1-T3925-COLD" })]));
  const BUDGET_MS = 40;
  const COLD_READ_MS = 400; // stands in for production's measured ~7.5s cold read
  const [route] = boundConsoleReadRoutes([slowJsonRoute("/v1/status", COLD_READ_MS)], deps, BUDGET_MS);

  const started = performance.now();
  const res = await serveRoute(route);
  const elapsedMs = performance.now() - started;
  const body = (await res.json()) as { tasks?: Array<{ unavailableReason?: string }>; staleness?: { status?: string; stale?: boolean } };

  assert.equal(res.status, 200);
  assert.ok(elapsedMs < COLD_READ_MS, `a cold read must not wait for the full underlying read (took ${elapsedMs.toFixed(1)}ms)`);
  assert.ok(elapsedMs < BUDGET_MS * 3, `cold read took ${elapsedMs.toFixed(1)}ms, well past its ${BUDGET_MS}ms budget`);
  assert.equal(body.staleness?.stale, true);
  assert.equal(body.staleness?.status, "unavailable");
  assert.equal(body.tasks?.[0]?.unavailableReason, "not_yet_collected");
});

test("cold /v1/recent and /v1/daemon-health reads also return within the client budget", async () => {
  const deps = depsFor(tmpRoot());
  deps.daemonHealth = { defaultPollIntervalMs: 75 };
  const BUDGET_MS = 30;
  const COLD_READ_MS = 400;

  for (const [path, assertBody] of [
    ["/v1/recent", (body: Record<string, unknown>) => assert.deepEqual(body.entries, [])],
    ["/v1/daemon-health", (body: Record<string, unknown>) => assert.equal(body.pollIntervalMs, 75)],
  ] as const) {
    const slow: Route = {
      method: "GET",
      path,
      scope: "read",
      handler: async (_req, res) => {
        await new Promise((resolve) => setTimeout(resolve, COLD_READ_MS));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      },
    };
    const [route] = boundConsoleReadRoutes([slow], deps, BUDGET_MS);
    const started = performance.now();
    const res = await serveRoute(route);
    const elapsedMs = performance.now() - started;
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(elapsedMs < COLD_READ_MS, `${path} cold read must not wait for the full underlying read (took ${elapsedMs.toFixed(1)}ms)`);
    assert.equal(res.headers.get("x-rmd-cache-state"), "stale");
    assertBody(body);
  }
});

test("an event-loop-blocked read still fires the fallback timer before the client budget", async () => {
  const deps = depsFor(tmpRoot(), planOf([task({ id: "W1-T3925-BLOCKED" })]));
  const BLOCK_MS = 300; // occupies the event loop synchronously, same shape as an in-turn execFileSync scan
  const BUDGET_MS = 100;
  // W1-T3925 round 2: only needs to comfortably outlast BLOCK_MS + BUDGET_MS (400ms worst case) so
  // the deadline reliably wins the race; 5000ms left a real background `setTimeout` dangling for up
  // to 5s past every assertion in this test, which a CI shard without `--test-force-exit` has to
  // sit through before the process can exit. 1000ms keeps a >2x safety margin at a fraction of the cost.
  const [route] = boundConsoleReadRoutes([slowJsonRoute("/v1/status", 1000, BLOCK_MS)], deps, BUDGET_MS);

  const started = performance.now();
  const res = await serveRoute(route);
  const elapsedMs = performance.now() - started;
  const body = (await res.json()) as { staleness?: { stale?: boolean } };

  assert.equal(res.status, 200);
  // BUGGY ordering registers the fallback `setTimeout` only AFTER the synchronous block finishes,
  // so the client pays BLOCK_MS + BUDGET_MS. Arming the deadline first (this task's fix) means the
  // timer is already overdue the instant the block ends, so the client pays roughly BLOCK_MS alone.
  assert.ok(
    elapsedMs < BLOCK_MS + BUDGET_MS * 0.5,
    `a same-turn blocking read took ${elapsedMs.toFixed(1)}ms; the fallback timer must fire promptly ` +
      `after the block ends, not BLOCK_MS(${BLOCK_MS}) + BUDGET_MS(${BUDGET_MS}) later`,
  );
  assert.equal(body.staleness?.stale, true);
});

test("cold or blocked reads report unavailable or stale state instead of a fabricated verified value", async () => {
  const deps = depsFor(tmpRoot(), planOf([task({ id: "W1-T3925-HONEST" })]));
  const BUDGET_MS = 30;

  for (const [label, blockFirstMs] of [
    ["cold", 0],
    ["blocked", 150],
  ] as const) {
    // W1-T3925 round 2: see the sibling "blocked" test above — 1000ms is ample margin over
    // BUDGET_MS + the largest blockFirstMs used here (30 + 150 = 180ms) without dangling a real
    // background timer 5x longer than any assertion in this loop needs.
    const [route] = boundConsoleReadRoutes([slowJsonRoute("/v1/status", 1000, blockFirstMs)], deps, BUDGET_MS);
    const res = await serveRoute(route);
    const body = (await res.json()) as {
      staleness?: { status?: string; stale?: boolean };
      tasks?: Array<{ source?: string; indeterminate?: boolean; unavailableReason?: string }>;
    };
    assert.equal(res.headers.get("x-rmd-cache-state"), "stale", `${label} read must report stale, never fresh, on a fallback`);
    assert.equal(body.staleness?.stale, true, `${label} read must flag stale`);
    assert.equal(body.staleness?.status, "unavailable", `${label} fallback must state that data is unavailable`);
    assert.equal(body.tasks?.[0]?.source, "throttled", `${label} fallback task must not present as a verified source`);
    assert.equal(body.tasks?.[0]?.indeterminate, true, `${label} fallback task must be marked indeterminate, not verified`);
    assert.equal(body.tasks?.[0]?.unavailableReason, "not_yet_collected", `${label} fallback must name an honest, non-fabricated unavailable reason`);
  }
});

test("cold-read timing fixture records a measurable latency", async () => {
  const deps = depsFor(tmpRoot());
  const samples: number[] = [];
  const measure = async <T>(fn: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    try {
      return await fn();
    } finally {
      samples.push(performance.now() - startedAt);
    }
  };

  // Use the same-turn cold-read shape that exposed the ordering bug: a synchronous block runs
  // before the route's first await. The fixed implementation has already armed its deadline, so
  // the measured sample is roughly BLOCK_MS; the old implementation starts its timer only after
  // that block and pays BLOCK_MS + BUDGET_MS.
  const BLOCK_MS = 300;
  const BUDGET_MS = 100;
  const [route] = boundConsoleReadRoutes([slowJsonRoute("/v1/status", 1_000, BLOCK_MS)], deps, BUDGET_MS);
  await measure(() => serveRoute(route));

  assert.equal(samples.length, 1);
  const [latencyMs] = samples;
  assert.ok(Number.isFinite(latencyMs) && latencyMs > 0, `expected a measurable positive cold-read latency, got ${latencyMs}`);
  // The regression this fixture guards against: an ordering bug that lets a cold read balloon past
  // its budget unnoticed. Bounding the recorded sample turns that into a failing assertion here
  // rather than an anecdote discovered later against production.
  assert.ok(
    latencyMs < BLOCK_MS + BUDGET_MS * 0.5,
    `cold-read latency ${latencyMs.toFixed(1)}ms should stay below the blocked-read budget boundary`,
  );
});
