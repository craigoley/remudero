// @source-text-subject: this suite's first two assertions intentionally inspect route handler
// source text because W1-T3192's deliverable is a request-path census/ratchet.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  buildServeRoutes,
  buildServeServer,
  boundConsoleReadRoutes,
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

function fakeGitHub(): GitHub {
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

function fakeTraceGithub(): TraceGithub {
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
  const github = fakeGitHub();
  return {
    board: { plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github, ratify: fakeRatifyGateway() },
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
    const bodies = await Promise.all(responses.map((res) => res.json() as Promise<{ staleness?: { stale?: boolean; ageMs?: number | null } }>));
    assert.ok(bodies.every((body) => body.staleness && body.staleness.stale === true));
    assert.ok(bodies.every((body) => body.staleness?.ageMs === null));
  });
});
