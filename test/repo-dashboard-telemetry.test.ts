import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/lib/service.js";
import {
  buildRepoDashboardRoute,
  computeRepoTelemetryOffThread,
  postRepoTelemetryWorkerResponse,
  projectRepoTelemetry,
  REPO_TELEMETRY_CACHE_TTL_MS,
  type RepoDashboardEntry,
  type RepoTelemetryRequest,
} from "../src/lib/repo-dashboard-route.js";
import { boundConsoleReadRoute, type ServeDeps } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
import { fixedClock } from "../src/lib/clock.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";

const READ_TOKEN = "repo-telemetry-read-token";
const NOW = "2026-09-22T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const ALPHA = { owner: "acme", repo: "alpha" };

function task(id: string, repo: string, extra = "status: queued"): string {
  return `- id: ${id}
  title: t
  repo: ${repo}
  depends_on: []
  type: implement
  verify: auto
  files: [src/x.ts]
  ${extra}
  acceptance:
    - claim: c
      proof: "grep: x in y"
`;
}

function plan(...tasks: string[]): Plan {
  return loadPlanFromYaml(tasks.join(""), "fixture");
}

const start = (run: string, repo: string, ts = "2026-09-20T00:00:00.000Z") => ({ run_id: run, task_id: run, step: "run.start", repo, ts });
const verdict = (run: string, v: string, ts: string) => ({ run_id: run, task_id: run, step: "verdict", verdict: v, ts });
const worker = (run: string, ts: string, cost: number, tokens: Record<string, number>) => ({
  run_id: run,
  task_id: run,
  step: "implement.done",
  ts,
  model: "m",
  billing_mode: "subscription",
  total_cost_usd: cost,
  tokens,
});

test("a repository's error rate and last run come from its verdict rows", () => {
  const ledger = [
    start("r1", "alpha"),
    start("r2", "acme/alpha"),
    start("r3", "alpha"),
    start("r4", "alpha"),
    start("r5", "alpha"),
    start("b1", "beta"),
    verdict("r1", "merged", "2026-09-20T01:00:00.000Z"),
    verdict("r2", "blocked_ci", "2026-09-21T01:00:00.000Z"),
    // transient/infrastructure: in neither set
    verdict("r3", "blocked_transient", "2026-09-22T01:00:00.000Z"),
    // outside the seven-day window: counts toward last run candidacy but not the rate
    verdict("r4", "failed", "2026-09-01T00:00:00.000Z"),
    verdict("r5", "no_pr", "2026-09-21T02:00:00.000Z"),
    verdict("b1", "merged", "2026-09-22T11:00:00.000Z"),
    { run_id: "r1", step: "verdict", verdict: "merged", ts: "not-a-time" },
  ];
  const t = projectRepoTelemetry(ALPHA, { ledger, nowMs: NOW_MS });
  assert.equal(t.errorrate, 2 / 3);
  assert.equal(t.last_run, "2026-09-22T01:00:00.000Z");

  const none = projectRepoTelemetry(ALPHA, { ledger: [start("r3", "alpha"), verdict("r3", "blocked_transient", "2026-09-22T01:00:00.000Z")], nowMs: NOW_MS });
  assert.equal(none.errorrate, null, "only transient verdicts leave the rate unmeasured, not 0");
  assert.equal(none.last_run, "2026-09-22T01:00:00.000Z");
});

test("queued tasks count the repository's open plan tasks", () => {
  const p = plan(
    task("A-1", "alpha"),
    task("A-2", "alpha"),
    task("A-3", "alpha", "status: done"),
    task("A-4", "alpha", "status: blocked\n  retirement: retired"),
    task("A-5", "alpha"),
    task("A-6", "alpha", "status: blocked"),
    task("B-1", "beta"),
  );
  const ledger = [
    { run_id: "x", task_id: "A-2", step: "verdict", verdict: "merged", ts: "2026-09-21T00:00:00.000Z" },
    { run_id: "y", task_id: "A-5", step: "verdict.merged", ts: "2026-09-21T00:00:00.000Z" },
  ];
  assert.equal(projectRepoTelemetry(ALPHA, { ledger, plan: p, nowMs: NOW_MS }).queuedtasks, 2);
  assert.equal(projectRepoTelemetry(ALPHA, { ledger, plan: plan(task("B-1", "beta")), nowMs: NOW_MS }).queuedtasks, 0);
});

test("seven-day tokens and cost sum the repository's worker rows in the window", () => {
  const ledger = [
    start("r1", "alpha"),
    start("b1", "beta"),
    worker("r1", "2026-09-21T00:00:00.000Z", 1.5, { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 }),
    worker("r1", "2026-09-22T00:00:00.000Z", 0.25, { input: 1, output: 2 }),
    { ...worker("r1", "2026-09-22T00:00:00.000Z", 9, { input: 5 }), tokens: undefined },
    // a row that names its repo directly, with no run.start
    { ...worker("z9", "2026-09-22T00:00:00.000Z", 0.25, { input: 100 }), repo: "acme/alpha" },
    // out of window, another repo, a verdict restating cost, and a cost.anomaly restatement
    worker("r1", "2026-09-10T00:00:00.000Z", 100, { input: 1000 }),
    worker("b1", "2026-09-22T00:00:00.000Z", 100, { input: 1000 }),
    { ...worker("r1", "2026-09-22T00:00:00.000Z", 100, { input: 1000 }), step: "verdict", verdict: "merged" },
    { ...worker("r1", "2026-09-22T00:00:00.000Z", 100, { input: 1000 }), step: "cost.anomaly" },
    { ...worker("r1", "2026-09-22T00:00:00.000Z", 100, { input: 1000 }), billing_mode: undefined },
  ];
  const t = projectRepoTelemetry(ALPHA, { ledger, nowMs: NOW_MS });
  assert.equal(t.tokens7d, 100 + 3 + 100);
  assert.equal(t.cost_7d, 1.5 + 0.25 + 9 + 0.25);
});

test("a telemetry field with no source stays null rather than zero", () => {
  const unknown = projectRepoTelemetry(ALPHA, { nowMs: NOW_MS });
  assert.deepEqual(unknown, { queuedtasks: null, errorrate: null, last_run: null, tokens7d: null, cost_7d: null });
  const noPlan = projectRepoTelemetry(ALPHA, { ledger: [], nowMs: NOW_MS });
  assert.equal(noPlan.queuedtasks, null);
  assert.equal(noPlan.errorrate, null);
  assert.equal(noPlan.last_run, null);
  assert.equal(noPlan.tokens7d, 0, "a present ledger with no rows in the window is a measured zero");
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-repo-telemetry-"));
  mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["acme/alpha"] }));
  return root;
}

async function readDashboard(route: ReturnType<typeof buildRepoDashboardRoute>): Promise<{ repos: RepoDashboardEntry[] }> {
  const server = createService({ tokens: { read: READ_TOKEN, write: "unused-write-token" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/repos`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(response.status, 200);
    return (await response.json()) as { repos: RepoDashboardEntry[] };
  } finally {
    server.close();
  }
}

test("GET /v1/repos fills telemetry from the real ledger and plan files and keeps registry and settings null", async () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan", "tasks.yaml"), task("A-1", "alpha"));
  const state = join(root, "state");
  mkdirSync(state);
  const ledgerPath = join(state, "ledger.ndjson");
  writeFileSync(ledgerPath, [
    start("r1", "alpha"),
    worker("r1", "2026-09-21T00:00:00.000Z", 2, { input: 7 }),
    verdict("r1", "merged", "2026-09-21T01:00:00.000Z"),
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const route = buildRepoDashboardRoute({ root, ledgerPath, clock: fixedClock(NOW_MS) });
  const [body, concurrent] = await Promise.all([readDashboard(route), readDashboard(route)]);
  assert.deepEqual(concurrent, body, "a concurrent read shares the one off-thread pass");
  const [alpha] = body.repos;
  assert.deepEqual(alpha.health, { status: "unknown", queuedtasks: 1, errorrate: 0, last_run: "2026-09-21T01:00:00.000Z", alerts: null });
  assert.deepEqual(alpha.telemetry, { tokens7d: 7, modelsused: [], cost_7d: 2 });
  assert.equal(alpha.connected_at, null);
  assert.equal(alpha.active, null);
  assert.deepEqual(alpha.settings, { proofpolicy: null, workerpoolsize: null, alertthreshold: null });
});

test("GET /v1/repos leaves ledger fields null for an absent ledger", async () => {
  const root = fixtureRoot();
  const missing = await readDashboard(buildRepoDashboardRoute({ root, ledgerPath: join(root, "state", "ledger.ndjson"), clock: fixedClock(NOW_MS) }));
  assert.deepEqual(missing.repos[0].telemetry, { tokens7d: null, modelsused: [], cost_7d: null });
  assert.equal(missing.repos[0].health.queuedtasks, null);
});

async function getBound(route: Route): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createService({ tokens: { read: READ_TOKEN, write: "unused-write-token" }, routes: [boundConsoleReadRoute(route, {} as ServeDeps)] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/repos`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

test("a warm repos read reuses its cached upstream result", async () => {
  const root = fixtureRoot();
  let ledgerReads = 0;
  let planReads = 0;
  const route = buildRepoDashboardRoute({
    root,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    clock: fixedClock(NOW_MS),
    readLedger: () => {
      ledgerReads += 1;
      return [start("r1", "alpha"), verdict("r1", "blocked_review", "2026-09-22T00:00:00.000Z")];
    },
    readPlan: () => {
      planReads += 1;
      return plan(task("A-1", "alpha"));
    },
  });
  const cold = await readDashboard(route);
  const warm = await readDashboard(route);
  assert.deepEqual(warm, cold);
  assert.equal(warm.repos[0].health.errorrate, 1);
  assert.equal(ledgerReads, 1, "the warm read must not re-read the ledger union");
  assert.equal(planReads, 1, "the warm read must not re-read the plan");
});

test("a repos read recomputes once an input changes or the cache ages out", async () => {
  const root = fixtureRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  let reads = 0;
  let nowMs = NOW_MS;
  const clock = { now: () => nowMs, date: () => fixedClock(nowMs).date(), iso: () => fixedClock(nowMs).iso() };
  const route = buildRepoDashboardRoute({ root, ledgerPath, clock, readLedger: () => (reads += 1, []), readPlan: () => plan(task("A-1", "alpha")) });
  await readDashboard(route);
  writeFileSync(ledgerPath, "{}\n");
  await readDashboard(route);
  assert.equal(reads, 2, "a changed ledger stamp recomputes");
  nowMs += REPO_TELEMETRY_CACHE_TTL_MS;
  await readDashboard(route);
  assert.equal(reads, 3, "an aged entry recomputes");
});

test("a failed plan read is reported unavailable with its reason", async () => {
  const route = buildRepoDashboardRoute({
    root: fixtureRoot(),
    ledgerPath: "/unused",
    clock: fixedClock(NOW_MS),
    readLedger: () => [start("r1", "alpha")],
    readPlan: () => {
      throw new Error("plan unreadable EACCES");
    },
  });
  const { status, body } = await getBound(route);
  assert.equal(status, 200);
  assert.equal(body.repos, undefined, "no healthy default rows stand in for the failed read");
  const staleness = body.staleness as { status: string; reason?: string };
  assert.equal(staleness.status, "unavailable");
  assert.equal(staleness.reason, "plan read failed: plan unreadable EACCES");
});

test("a failed ledger read after a good one serves the last result stale with its reason", async () => {
  const root = fixtureRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  let fail = false;
  let nowMs = NOW_MS;
  const clock = { now: () => nowMs, date: () => fixedClock(nowMs).date(), iso: () => fixedClock(nowMs).iso() };
  const route = buildRepoDashboardRoute({
    root,
    ledgerPath,
    clock,
    readLedger: () => {
      if (fail) throw new Error("gunzip: unexpected end of file");
      return [start("r1", "alpha"), verdict("r1", "merged", "2026-09-22T00:00:00.000Z")];
    },
    readPlan: () => plan(task("A-1", "alpha")),
  });
  const bound = boundConsoleReadRoute(route, {} as ServeDeps, 0);
  const server = createService({ tokens: { read: READ_TOKEN, write: "unused-write-token" }, routes: [bound] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const get = async () => (await (await fetch(`http://127.0.0.1:${port}/v1/repos`, { headers: { authorization: `Bearer ${READ_TOKEN}` } })).json()) as Record<string, unknown>;
  try {
    await get();
    await new Promise((resolve) => setTimeout(resolve, 20));
    fail = true;
    nowMs += REPO_TELEMETRY_CACHE_TTL_MS;
    await get();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const body = await get();
    const staleness = body.staleness as { stale: boolean; reason?: string };
    assert.equal(staleness.stale, true);
    assert.equal(staleness.reason, "ledger read failed: gunzip: unexpected end of file");
    assert.equal((body.repos as RepoDashboardEntry[])[0].health.errorrate, 0, "the last good result is what is served");
  } finally {
    server.close();
  }
});

const REQ = (ledgerPath: string, planPath: string): RepoTelemetryRequest => ({
  kind: "remudero-repo-telemetry",
  repos: [ALPHA],
  ledgerPath,
  planPath,
  nowMs: NOW_MS,
});

test("the repo telemetry worker body posts its computed outcome", () => {
  const ledgerPath = join(fixtureRoot(), "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify(start("r1", "alpha")) + "\n");
  const posted: unknown[] = [];
  postRepoTelemetryWorkerResponse({ postMessage: (v) => posted.push(v) }, REQ(ledgerPath, "/nonexistent/tasks.yaml"));
  assert.equal(posted.length, 1);
  const outcome = posted[0] as { ok: boolean; reason?: string };
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason ?? "", /^plan read failed: cannot read plan file/);
  postRepoTelemetryWorkerResponse(null, REQ("/nonexistent/ledger.ndjson", "/nonexistent/tasks.yaml"));
});

test("an off-thread repo telemetry pass reports a dead worker as unavailable", async () => {
  const req = REQ("/nonexistent/ledger.ndjson", "/nonexistent/tasks.yaml");
  const crashed = await computeRepoTelemetryOffThread(req, new URL(`data:text/javascript,${encodeURIComponent("throw new Error('fixture crash');")}`));
  assert.deepEqual(crashed, { ok: false, reason: "repo telemetry worker failed: fixture crash" });
  const exited = await computeRepoTelemetryOffThread(req, new URL(`data:text/javascript,${encodeURIComponent("process.exit(3);")}`));
  assert.deepEqual(exited, { ok: false, reason: "repo telemetry worker exited with code 3 before reporting" });
  const unspawnable = await computeRepoTelemetryOffThread(req, new URL("http://127.0.0.1/not-a-worker.js"));
  assert.equal(unspawnable.ok, false);
  assert.match((unspawnable as { reason: string }).reason, /^repo telemetry worker could not start: /);
});
