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

const READ_TOKEN = "read-token";
const ARCHIVE_MTIME_S = 1_790_000_000;

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
  ];
  const newer = [row("2026-09-21T11:00:00.000Z", "review.posted"), row("2026-09-21T11:05:00.000Z", "run.end")];
  for (const [name, rows] of [["ledger.2026-09-20T12-00-00-000Z.ndjson.gz", older], ["ledger.2026-09-21T12-00-00-000Z.ndjson.gz", newer]] as const) {
    const path = join(state, name);
    writeFileSync(path, gzipSync(`${rows.join("\n")}\n`));
    fs.utimesSync(path, ARCHIVE_MTIME_S, ARCHIVE_MTIME_S);
  }
  const ledgerPath = join(state, "ledger.ndjson");
  writeFileSync(ledgerPath, `${row("2026-09-22T11:00:00.000Z", "run.start")}\n`);
  return { root, ledgerPath };
}

function depsFor(root: string, ledgerPath: string): Parameters<typeof buildServeRoutes>[0] {
  const github = { getPr: async () => undefined, listOpenPrs: async () => [], listIssues: async () => [] } as never;
  return {
    board: { plan: { version: 1, tasks: [] } as never, ledgerPath, github },
    panelGraph: { root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath, github: {} as never, statusGithub: github, ratify: {} as never },
    ledgerPath,
    issues: {} as never,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: "write-token" },
    pollMs: 60_000,
    githubAppRefresh: { start: () => ({ armed: false }) },
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
      Promise.resolve(route.handler(req, res, { params: {} } as never)).catch(() => {
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

type Measured = { key: string; warmOpens: number; status: number | "unanswered" };

/** Warm each GET read route once, then charge a second request: any archive it opens is a violation. */
async function measure(routes: readonly Route[]): Promise<Measured[]> {
  const out: Measured[] = [];
  for (const route of routes) {
    if (route.method !== "GET" || route.scope !== "read") continue;
    const key = `${route.method} ${route.path}`;
    const url = route.path.replace(/:([A-Za-z]+)/g, "fixture");
    let status: Measured["status"] = "unanswered";
    const warmOpens = await withRoute(key, route, async (base) => {
      const get = async () => {
        try {
          const res = await fetch(`${base}${url}`, { headers: { authorization: `Bearer ${READ_TOKEN}` }, signal: AbortSignal.timeout(8_000) });
          await res.arrayBuffer();
          status = res.status;
        } catch {
          status = "unanswered";
        }
      };
      await get();
      const afterFirst = await settle(key);
      await get();
      return (await settle(key)) - afterFirst;
    });
    out.push({ key, warmOpens, status });
  }
  return out;
}

test("W1-T4576: a GET read route that re-opens ledger archives on a warm request is refused by name", async () => {
  const { root, ledgerPath } = fixture();
  try {
    const measured = await measure(buildServeRoutes(depsFor(root, ledgerPath)));
    const answered = measured.filter((m) => m.status !== "unanswered");
    // THE CORPUS CONTROL: a census that reached no route, or never reached the two routes W1-T4567
    // bounded, would pass vacuously.
    assert.ok(answered.length >= 40, `expected the read-route table to be driven, answered ${answered.length}`);
    for (const bounded of ["GET /v1/self-measurement", "GET /v1/operator-agent/follow-ups"]) {
      assert.ok(answered.some((m) => m.key === bounded), `${bounded} must be measured`);
    }
    const violations = measured.filter((m) => m.warmOpens > 0).map((m) => m.key).sort();
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
