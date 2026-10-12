// W1-T4576: a GET read route must not re-open ledger archives on every request. The text gate
// (consoleBlockingRequestPathViolations) reads each handler's own source for fs symbols, so a
// handler that delegates to one helper passes it however much it reads: MEASURED 2026-09-26,
// /v1/self-measurement (2.6-3.0 s), /v1/operator-agent/follow-ups (5.8 s) and
// /v1/operator-activity (14.8 s) all passed it. This census measures REACH instead.
//
// HOW IT ATTRIBUTES. Every fs entry point a ledger reader opens an archive through is wrapped
// BEFORE serve.js loads (the readers capture those functions into default-deps objects at import
// time, so a later patch would miss them), and each request runs inside an AsyncLocalStorage
// context naming its route. An archive open is charged to the route whose request caused it,
// including async work that request started; pollers and prewarm run outside any request and are
// charged to nobody. A route is warmed once, then a second request must open no archive at all.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { Route } from "../src/lib/service.js";

const context = new AsyncLocalStorage<string>();
const archiveOpens = new Map<string, number>();
/** A rotated ledger archive, gzipped or plain — never the live `ledger.ndjson`. */
const ARCHIVE_RE = /(?:^|[/\\])ledger\.[^/\\]+\.ndjson(?:\.gz)?$/;

function charged<F extends (...args: never[]) => unknown>(original: F): F {
  return function (this: unknown, ...args: Parameters<F>) {
    const route = context.getStore();
    const target = args[0] as unknown;
    if (route !== undefined && (typeof target === "string" || target instanceof URL) && ARCHIVE_RE.test(String(target))) {
      archiveOpens.set(route, (archiveOpens.get(route) ?? 0) + 1);
    }
    return original.apply(this, args);
  } as F;
}

fs.readFileSync = charged(fs.readFileSync);
fs.createReadStream = charged(fs.createReadStream);
fs.openSync = charged(fs.openSync);
fsp.readFile = charged(fsp.readFile);
syncBuiltinESMExports();

const { buildServeRoutes, CONSOLE_UNBOUNDED_LEDGER_READ_BASELINE } = await import("../src/lib/serve.js");
const { latestMeasurementRows } = await import("../src/lib/measurement-cadence.js");
const { loadPlan } = await import("../src/lib/plan.js");
const { inboxThreadId } = await import("../src/lib/inbox-thread.js");
const { ProviderAuthSessionStore } = await import("../src/lib/provider-auth-sessions.js");

const READ_TOKEN = "read-token";
const ARCHIVE_MTIME_S = 1_790_000_000;
const SAMPLE_CURSOR = Buffer.from(JSON.stringify(["fixture", 1])).toString("base64url");
const SAMPLE_QUERIES: Readonly<Record<string, readonly string[]>> = {
  "GET /v1/replay": ["?since=2026-09-20T00:00:00.000Z&until=2026-09-23T00:00:00.000Z", "?since=2026-09-20T00:00:00.000Z&until=2026-09-23T00:00:00.000Z&task=W1-T1&step=run."],
  "GET /v1/self-measurement": ["?detail=autonomyRate"],
  "GET /v1/peek": ["?runId=R-fixture&lines=1"],
  "GET /v1/onboarding/readiness": ["?repo=owner/repo"],
  "GET /v1/recent": ["?verb=merged,review&limit=1"],
  "GET /v1/feedback": ["?status=new&limit=1", `?limit=1&cursor=${SAMPLE_CURSOR}`],
  "GET /v1/inbox": ["?section=needsYou", `?section=fleet&limit=1&cursor=${SAMPLE_CURSOR}`],
  "GET /v1/inbox/threads": ["?qualified=1"],
  "GET /v1/inbox/thread": [`?id=${encodeURIComponent(inboxThreadId("ruling:census"))}`],
  "GET /v1/trace": ["?id=W1-T1"],
  "GET /v1/plan/view": ["?frontier=1"],
  "GET /v1/task": ["?id=W1-T1"],
  "GET /v1/operator-notes": ["?taskId=W1-T1"],
  "GET /v1/operator-agent/context": ["?purpose=plan-work&authorityRef=consent:census:plan"],
  "GET /v1/operator-agent/settings": ["?repository=owner/repo"],
  "GET /v1/operator-agent/proposals": ["?principalId=operator:census&repository=owner/repo&surface=console"],
  "GET /v1/operator-agent/preferences": ["?principalId=operator:census&repository=owner/repo&surface=console"],
  "GET /v1/context-controls/inventory": ["?principal=operator:census&purpose=plan-work&authorityRef=consent:census:plan"],
  "GET /v1/context-controls/export": ["?principal=operator:census&purpose=plan-work&authorityRef=consent:census:plan"],
  "GET /v1/provider-auth": ["?sessionId=census-session"],
  "GET /v1/views/nav-badge": ["?instances=core"],
  "GET /v1/views/feedback": ["?status=new"],
  "GET /v1/analytics": [
    ...["console-v1", "console-signals-v1", "routing-daily-v1", "benchmark-quality-v1", "routing-pool-v1", "ability-map-v1", "work-integrity-v1", "judge-calibration-v1", "goals-v1", "usage-v1", "usage-v2"].map((version) => `?projectionVersion=${version}`),
    "?projectionVersion=eval-card-v1&trial=census", "?projection=console-signals-v1",
  ],
};

function row(ts: string, step: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, host: "fixture", run_id: `R-${ts}`, task_id: "W1-T1", step, ...extra });
}

/** A state dir with a live ledger and two gz rotations, so a route that scans the union must open them. */
function fixture(): { root: string; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t4576-"));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), '- id: W1-T1\n  title: "fixture"\n  repo: remudero\n  type: implement\n');
  const older = [
    row("2026-09-20T11:00:00.000Z", "run.start"),
    row("2026-09-20T11:05:00.000Z", "measurement_cadence.ran", { autonomy_rate: { status: "measured", zeroTouchRate: 0.4 } }),
    row("2026-09-20T11:10:00.000Z", "panel.context_item", { context: {
      version: "context-item-v1", contextId: "ctx:census", source: "census fixture", principal: "operator:census",
      purpose: "plan-work", sensitivity: "moderate", authorityRef: "consent:census:plan",
      observedAt: new Date().toISOString(), freshness: "fresh",
      retention: { policy: "census", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      visibility: "private", derivationLinks: [], revocation: { state: "active" }, content: "fixture context",
    } }),
  ];
  const newer = [row("2026-09-21T11:00:00.000Z", "review.posted"), row("2026-09-21T11:05:00.000Z", "run.end")];
  for (const [name, rows] of [["ledger.2026-09-20T12-00-00-000Z.ndjson.gz", older], ["ledger.2026-09-21T12-00-00-000Z.ndjson.gz", newer]] as const) {
    const path = join(state, name);
    writeFileSync(path, gzipSync(`${rows.join("\n")}\n`));
    fs.utimesSync(path, ARCHIVE_MTIME_S, ARCHIVE_MTIME_S);
  }
  const ledgerPath = join(state, "ledger.ndjson");
  writeFileSync(ledgerPath, `${row("2026-09-22T11:00:00.000Z", "run.start")}\n`);
  writeFileSync(join(state, "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: "ruling:census", summary: "fixture question", evidenceAnchors: [] }] }));
  mkdirSync(join(state, "runs"));
  writeFileSync(join(state, "runs", "R-fixture.tail"), "first line\nlast line\n");
  return { root, ledgerPath };
}

function depsFor(root: string, ledgerPath: string): Parameters<typeof buildServeRoutes>[0] {
  const github = {
    prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined,
    getPr: async () => undefined, listOpenPrs: async () => [], listIssues: async () => [],
  };
  const auth = new ProviderAuthSessionStore({ profiles: [], randomId: () => "census-session" });
  void auth.start({ provider: "codex", profileId: "fixture" });
  return {
    board: { plan: loadPlan(join(root, "plan", "tasks.yaml")), ledgerPath, github },
    panelGraph: { root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath, github: {} as never, statusGithub: github, ratify: {} as never },
    ledgerPath,
    issues: {} as never,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: "write-token" },
    providerAuth: { store: auth },
    pollMs: 60_000,
    githubAppRefresh: { start: () => ({ armed: false }) },
    // The onboarding inventory is a GitHub read, not a ledger scan. Keep this census offline
    // while still driving the route and checking its warm-request archive reach.
    onboardingRepositoryInventory: { read: async () => "0" },
    onboardingReadiness: { asyncGateway: {
      listInstallationRepos: async () => [], getRepo: async () => undefined,
      getBranchProtection: async () => undefined, getBranchRules: async () => undefined, getContents: async () => undefined,
    } },
    daemonHealth: { exec: () => JSON.stringify({ resources: { core: { remaining: 4999, reset: 1_790_000_000 } } }) },
  } as never;
}

/** Idle until this route's charge has not moved for `quietMs`, so async work a request started lands in its count. */
async function settle(key: string, quietMs = 150, maxMs = 4_000): Promise<number> {
  const started = Date.now();
  let last = archiveOpens.get(key) ?? 0;
  let stableSince = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const now = archiveOpens.get(key) ?? 0;
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) break;
  }
  return last;
}

/** Serve ONE route, running every request inside its attribution context. */
async function withRoute<T>(key: string, route: Route, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    context.run(key, () => {
      Promise.resolve().then(() => route.handler(req, res, { params: {} } as never)).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

type Measured = { key: string; query: string; warmOpens: number; status: number | "unanswered"; body: string };

/** Warm each GET read route once, then charge a second request: any archive it opens is a violation. */
async function measure(routes: readonly Route[], samples = SAMPLE_QUERIES): Promise<Measured[]> {
  const out: Measured[] = [];
  for (const route of routes) {
    if (route.method !== "GET" || route.scope !== "read") continue;
    const key = `${route.method} ${route.path}`;
    for (const query of ["", ...(samples[key] ?? [])]) {
      const attribution = key + query;
      const url = route.path.replace(/:([A-Za-z]+)/g, "fixture") + query;
      let status: Measured["status"] = "unanswered";
      let body = "";
      const warmOpens = await withRoute(attribution, route, async (base) => {
        const get = async () => {
          try {
            const res = await fetch(`${base}${url}`, { headers: { authorization: `Bearer ${READ_TOKEN}` }, signal: AbortSignal.timeout(8_000) });
            body = await res.text();
            status = res.status;
          } catch {
            status = "unanswered";
          }
          if (query) assert.ok(typeof status === "number" && status < 400, `${key} sample query ${query} answered HTTP ${status}: ${body}`);
        };
        await get();
        const afterFirst = await settle(attribution);
        await get();
        return (await settle(attribution)) - afterFirst;
      });
      out.push({ key, query, warmOpens, status, body });
    }
  }
  return out;
}

test("W1-T4576: a GET read route that re-opens ledger archives on a warm request is refused by name", async () => {
  const { root, ledgerPath } = fixture();
  try {
    const measured = await measure(buildServeRoutes(depsFor(root, ledgerPath)));
    const answered = measured.filter((m) => m.query === "" && m.status !== "unanswered");
    // THE CORPUS CONTROL: a census that reached no route, or never reached the two routes W1-T4567
    // bounded, would pass vacuously.
    assert.ok(answered.length >= 40, `expected the read-route table to be driven, answered ${answered.length}`);
    for (const bounded of ["GET /v1/self-measurement", "GET /v1/operator-agent/follow-ups"]) {
      assert.ok(answered.some((m) => m.key === bounded), `${bounded} must be measured`);
    }
    for (const [key, queries] of Object.entries(SAMPLE_QUERIES)) {
      assert.deepEqual(measured.filter((m) => m.key === key && m.query).map((m) => m.query), queries, `${key} samples must reach the mounted route`);
    }
    const detail = measured.find((m) => m.key === "GET /v1/self-measurement" && m.query);
    assert.ok(detail && detail.warmOpens >= 2, "the detail read must reach the archived measurement");
    assert.equal(JSON.parse(detail.body).value.zeroTouchRate, 0.4);
    const peek = measured.find((m) => m.key === "GET /v1/peek" && m.query);
    assert.deepEqual(JSON.parse(peek!.body).lines, ["last line"]);
    const violations = [...new Set(measured.filter((m) => m.warmOpens > 0).map((m) => m.key))].sort();
    for (const key of CONSOLE_UNBOUNDED_LEDGER_READ_BASELINE) {
      assert.ok(CONSOLE_UNBOUNDED_LEDGER_READ_BASELINE.reasons[key]?.trim(), `${key} needs a baseline reason`);
    }
    assert.deepEqual(
      violations,
      [...CONSOLE_UNBOUNDED_LEDGER_READ_BASELINE].sort(),
      "a route that newly re-opens ledger archives per request is refused; a baselined route that no longer does must leave the baseline",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4576: the census charges a synthetic full-union read to the route that made it", async () => {
  const { root, ledgerPath } = fixture();
  try {
    const stateDir = join(root, "state");
    const unbounded: Route = {
      method: "GET",
      path: "/v1/synthetic-unbounded",
      scope: "read",
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(latestMeasurementRows(stateDir, 10)));
      },
    };
    const [measured] = await measure([unbounded]);
    assert.equal(measured?.status, 200);
    assert.ok((measured?.warmOpens ?? 0) >= 2, `the full-union read must be charged on the warm request, got ${measured?.warmOpens}`);
    assert.ok(ledgerPath.endsWith("ledger.ndjson"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the reach census exercises each route's declared sample query", async () => {
  for (const [key, samples] of Object.entries(SAMPLE_QUERIES)) {
    const requests: string[] = [];
    const path = key.slice(4);
    const route: Route = {
      method: "GET", path, scope: "read",
      handler: (req, res) => {
        requests.push(req.url!);
        res.writeHead(200);
        res.end();
      },
    };
    await measure([route]);
    assert.deepEqual(requests, [path, path, ...samples.flatMap((query) => [path + query, path + query])]);
  }
});

test("the reach census charges the replay route when since and until are sent", async () => {
  const { root, ledgerPath } = fixture();
  try {
    const routes = buildServeRoutes(depsFor(root, ledgerPath)).filter((route) => route.path === "/v1/replay");
    const measured = await measure(routes);
    assert.equal(measured[0]?.status, 400);
    assert.equal(measured[0]?.warmOpens, 0);
    assert.ok(measured.length > 1, "replay's query must be exercised separately from its bare path");
    for (const sample of measured.slice(1)) {
      assert.equal(sample.status, 200);
      assert.ok(sample.warmOpens >= 2, `both fixture archives must be charged, got ${sample.warmOpens}`);
      assert.match(sample.body, /2026-09-20T11:00:00.000Z/);
      assert.match(sample.body, /2026-09-21T11:05:00.000Z/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sample query that answers 4xx fails the reach census", async () => {
  const { root, ledgerPath } = fixture();
  try {
    const routes = buildServeRoutes(depsFor(root, ledgerPath)).filter((route) => route.path === "/v1/self-measurement");
    for (const query of ["?detail=", "?detail=missing"]) {
      await assert.rejects(measure(routes, { "GET /v1/self-measurement": [query] }), /GET \/v1\/self-measurement.*sample query.*HTTP 4[0-9]{2}/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  for (const status of [400, 404, 422]) {
    for (const failedRequest of [1, 2]) {
      let sampleRequests = 0;
      const route: Route = {
        method: "GET", path: "/v1/self-measurement", scope: "read",
        handler: (req, res) => {
          const fail = req.url?.includes("?") && ++sampleRequests === failedRequest;
          res.writeHead(fail ? status : 200);
          res.end();
        },
      };
      await assert.rejects(measure([route]), /GET \/v1\/self-measurement.*sample query.*HTTP 4[0-9]{2}/);
    }
  }
});
