import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createService, type Route } from "../src/lib/service.js";
import {
  buildRepoDashboardRoutes,
  computeRepoTelemetryOffThread,
  deriveRepoCondition,
  projectRepoTelemetry,
  type RepoDashboardResult,
  type RepoTelemetry,
  type RepoTelemetryRequest,
} from "../src/lib/repo-dashboard-route.js";
import {
  assignmentFacts,
  createRepoLedgerIndex,
  realRepoLedgerIndexFs,
  rotationStampMs,
  type RepoLedgerIndexFs,
} from "../src/lib/repo-ledger-index.js";
import { fixedClock } from "../src/lib/clock.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";

const READ_TOKEN = "repo-summary-read-token";
const NOW = "2026-09-22T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ALPHA = { owner: "acme", repo: "alpha" };

type Row = Record<string, unknown>;
const start = (run: string, repo: string) => ({ run_id: run, task_id: run, step: "run.start", repo, ts: "2026-09-20T00:00:00.000Z" });
const verdict = (run: string, task: string, v: string, ts: string) => ({ run_id: run, task_id: task, step: "verdict", verdict: v, ts });
const merged = (task: string, ts: string) => ({ run_id: "DAEMON-1", task_id: task, step: "verdict.merged", verdict: "merged", ts });
const call = (run: string, step: string, ts: string, billing: string, cost: number, tokens: Row) =>
  ({ run_id: run, task_id: run, step, ts, billing_mode: billing, total_cost_usd: cost, tokens, served_model: null });
const lines = (rows: Row[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-repo-summary-"));
}

test("a merge credit counts as a succeeded run and supersedes an earlier failure of the same task", () => {
  const ledger = [
    start("r1", "alpha"), start("r2", "alpha"), start("r3", "alpha"),
    verdict("r1", "T-1", "blocked_ci", "2026-09-20T01:00:00.000Z"),
    merged("T-1", "2026-09-20T05:00:00.000Z"),
    verdict("r2", "T-2", "no_pr", "2026-09-21T01:00:00.000Z"),
    merged("T-3", "2026-09-21T02:00:00.000Z"),
    verdict("r3", "T-4", "blocked_transient", "2026-09-21T03:00:00.000Z"),
  ];
  const t = projectRepoTelemetry(ALPHA, { ledger, nowMs: NOW_MS, own: true });
  assert.deepEqual(t.runs7d, { succeeded: 2, failed: 1, superseded: 1 });
  assert.equal(t.errorrate, 1 / 3);
  assert.equal(t.last_run, "2026-09-21T03:00:00.000Z");
});

test("rows repeated across ledger rotations count once in the error rate and spend", () => {
  const once = [
    start("r1", "alpha"), start("r2", "alpha"),
    verdict("r1", "T-1", "failed", "2026-09-21T01:00:00.000Z"),
    merged("T-2", "2026-09-21T02:00:00.000Z"),
    call("r2", "implement.done", "2026-09-21T01:30:00.000Z", "api", 2, { input: 5 }),
  ];
  const repeated = [...once, ...once, ...once];
  const t = projectRepoTelemetry(ALPHA, { ledger: repeated, nowMs: NOW_MS, own: true });
  assert.deepEqual(t.runs7d, { succeeded: 1, failed: 1, superseded: 0 });
  assert.equal(t.cash_usd_7d, 2);
  assert.equal(t.tokens7d, 5);
});

test("each worker call counts once when its run wrote a worker.attempt receipt", () => {
  const ledger = [
    start("r1", "alpha"), start("r2", "alpha"),
    call("r1", "worker.attempt", "2026-09-21T00:00:00.000Z", "api", 1, { input: 10, cacheRead: 1000 }),
    call("r1", "implement.done", "2026-09-21T00:00:01.000Z", "api", 1, { input: 10, cacheRead: 1000 }),
    call("r2", "review.reviewer", "2026-09-21T00:00:00.000Z", "subscription", 3, { input: 4, output: 6, cacheCreation: 1 }),
  ];
  const t = projectRepoTelemetry(ALPHA, { ledger, nowMs: NOW_MS });
  assert.equal(t.tokens7d, 10 + 11, "input + output + cache creation, one receipt per call");
  assert.equal(t.cache_read_tokens7d, 1000, "cache reads are reported apart and never in tokens7d");
  assert.equal(t.cash_usd_7d, 1, "only the api-billed call is cash; subscription work is not priced");
  assert.equal(t.subscription?.calls7d, 1);
});

test("subscription windows report the router's latest reading per provider window", () => {
  const assignment = (ts: string, used: number) => ({
    run_id: "DAEMON-2", task_id: "unfiled", step: "worker.assignment", ts,
    worker_assignment: {
      selected: { provider: "claude", model: "claude-sonnet-5-5" },
      candidates: [
        { provider: "claude", windows: [{ name: "weekly (all models)", usedPercent: used, resetsAt: "2026-09-25T00:00:00Z" }] },
        { provider: "codex", windows: [{ name: "primary", usedPercent: "n/a", resetsAt: 1790000000 }, { usedPercent: 3 }] },
        { windows: [{ name: "orphan", usedPercent: 1 }] },
        { provider: "none" },
      ],
    },
  });
  const t = projectRepoTelemetry(ALPHA, { ledger: [assignment("2026-09-21T00:00:00.000Z", 40), assignment("2026-09-22T00:00:00.000Z", 49), assignment("2026-09-20T00:00:00.000Z", 10)], nowMs: NOW_MS, own: true });
  assert.deepEqual(t.subscription?.windows, [
    { provider: "claude", window: "weekly (all models)", percent_used: 49, resets_at: "2026-09-25T00:00:00Z", observed_at: "2026-09-22T00:00:00.000Z" },
    { provider: "codex", window: null, percent_used: 3, resets_at: null, observed_at: "2026-09-22T00:00:00.000Z" },
    { provider: "codex", window: "primary", percent_used: null, resets_at: fixedClock(1790000000 * 1000).iso(), observed_at: "2026-09-22T00:00:00.000Z" },
  ]);
  assert.deepEqual(t.modelsused, ["claude-sonnet-5-5"]);
});

test("modelsused adds the canonical assigned model and drops a bare alias", () => {
  const ledger = [
    { run_id: "a", step: "worker.assignment", ts: "2026-09-21T00:00:00.000Z", assigned_model: "sonnet" },
    { run_id: "b", step: "worker.assignment", ts: "2026-09-21T00:00:00.000Z", assigned_model: "gpt-6-sol", windows: [] },
    { run_id: "c", step: "worker.assignment", ts: "2026-09-21T00:00:00.000Z" },
    { ...call("d", "fix.done", "2026-09-21T00:00:00.000Z", "subscription", 0, {}), served_model: "claude-opus-5-5" },
  ];
  assert.deepEqual(projectRepoTelemetry(ALPHA, { ledger, nowMs: NOW_MS, own: true }).modelsused, ["claude-opus-5-5", "gpt-6-sol"]);
  assert.deepEqual(projectRepoTelemetry(ALPHA, { ledger, nowMs: NOW_MS }).modelsused, [], "rows naming no repository belong only to the operating instance");
});

test("the ledger index reads only appended live bytes on a warm refresh", () => {
  const dir = tmp();
  const live = join(dir, "ledger.ndjson");
  writeFileSync(live, lines([start("r1", "alpha"), verdict("r1", "T-1", "failed", "2026-09-21T00:00:00.000Z")]) + '{"torn');
  const index = createRepoLedgerIndex(WEEK_MS);
  const cold = index.refresh(live, NOW_MS);
  assert.equal(cold.present, true);
  assert.equal(cold.rows.length, 2);
  const warm = index.refresh(live, NOW_MS);
  assert.deepEqual([warm.filesRead, warm.bytesRead, warm.rows.length], [0, 0, 2], "an unchanged ledger re-reads nothing");
  writeFileSync(live, lines([start("r1", "alpha"), verdict("r1", "T-1", "failed", "2026-09-21T00:00:00.000Z"), merged("T-1", "2026-09-21T01:00:00.000Z")]));
  const grown = index.refresh(live, NOW_MS);
  assert.equal(grown.filesRead, 1);
  assert.equal(grown.rows.length, 3);
  const assignment = { step: "worker.assignment", ts: "2026-09-21T03:00:00.000Z", worker_assignment: { selected: { model: "gpt-6-sol" }, candidates: [{ provider: "codex", windows: [{ name: "w", usedPercent: 5 }] }] } };
  writeFileSync(live, lines([merged("T-2", "2026-09-21T02:00:00.000Z"), assignment, { step: "daemon.tick", ts: "2026-09-22T11:59:00.000Z" }, { step: "daemon.tick", ts: "bad" }]) + '{"step":"verdict","ts\n');
  const rotated = index.refresh(live, NOW_MS);
  assert.equal(rotated.rows.length, 5, "a shrunken live file is read again from its start");
  assert.deepEqual(rotated.rows.find((r) => r.step === "worker.assignment"), {
    step: "worker.assignment", ts: "2026-09-21T03:00:00.000Z", assigned_model: "gpt-6-sol",
    windows: [{ provider: "codex", name: "w", usedPercent: 5, resetsAt: undefined }],
  });
  assert.equal(rotated.lastDaemonMs, Date.parse("2026-09-22T11:59:00.000Z"));
});

test("a row repeated across a rotation and the live ledger is kept once", () => {
  const dir = tmp();
  const live = join(dir, "ledger.ndjson");
  const row = verdict("r1", "T-1", "failed", "2026-09-21T00:00:00.000Z");
  writeFileSync(live, lines([row]));
  writeFileSync(join(dir, "ledger.2026-09-21T06-00-00-000Z.ndjson.gz"), gzipSync(lines([row, start("r1", "alpha")])));
  writeFileSync(join(dir, "ledger.2026-09-21T07-00-00-000Z.ndjson"), lines([row]));
  writeFileSync(join(dir, "ledger.ndjson.bak"), lines([merged("T-9", "2026-09-21T00:00:00.000Z")]));
  const pass = createRepoLedgerIndex(WEEK_MS).refresh(live, NOW_MS);
  assert.equal(pass.filesRead, 3);
  assert.equal(pass.rows.length, 2);
});

test("a rotation named older than the window is never opened", () => {
  const opened: string[] = [];
  const fs: RepoLedgerIndexFs = {
    readdir: () => ["ledger.ndjson", "ledger.2026-08-01T00-00-00-000Z.ndjson.gz", "ledger.2026-09-10T00-00-00-000Z.ndjson", "ledger.undated.ndjson"],
    size: (path) => (path.endsWith("ledger.ndjson") ? 0 : 10),
    readAll: (path) => (opened.push(path), Buffer.from(lines([merged("T-1", "2026-09-01T00:00:00.000Z"), merged("T-2", "2026-09-21T00:00:00.000Z")]))),
    readFrom: () => Buffer.alloc(0),
  };
  const index = createRepoLedgerIndex(WEEK_MS, fs);
  const pass = index.refresh("/state/ledger.ndjson", NOW_MS);
  assert.deepEqual(opened.map((p) => p.split("/").pop()), ["ledger.2026-09-10T00-00-00-000Z.ndjson", "ledger.undated.ndjson"]);
  assert.equal(pass.rows.length, 1, "a kept row older than twice the window is pruned");
  assert.equal(rotationStampMs("ledger.2026-99-99T00-00-00-000Z.ndjson"), undefined);
});

test("the real index filesystem distinguishes an absent ledger from an unreadable one", () => {
  const dir = tmp();
  assert.equal(realRepoLedgerIndexFs.size(join(dir, "missing.ndjson")), undefined);
  writeFileSync(join(dir, "file"), "x");
  assert.throws(() => realRepoLedgerIndexFs.size(join(dir, "file", "under-a-file")), /ENOTDIR/);
  assert.equal(createRepoLedgerIndex(WEEK_MS).refresh(join(dir, "nope", "ledger.ndjson"), NOW_MS).present, false);
  assert.deepEqual(assignmentFacts({ step: "worker.assignment" }), { windows: [] });
});

const measured = (runs: { succeeded: number; failed: number }): RepoTelemetry => ({
  queuedtasks: 0, queued: 0, errorrate: null, runs7d: { ...runs, superseded: 0 }, last_run: null,
  tokens7d: 0, cache_read_tokens7d: 0, cash_usd_7d: 0, subscription: null, modelsused: [],
});

test("a down repository's reason names when its heartbeat stopped and does not age with the clock", () => {
  const down = { paused: false, stopped: false, lastDaemonMs: NOW_MS - 45 * 60_000, alerts: [] as string[] };
  const ok = measured({ succeeded: 3, failed: 1 });
  const at = (nowMs: number) => deriveRepoCondition(ok, down, nowMs);
  assert.equal(at(NOW_MS).condition, "down", "positive control: the repo is down at both instants");
  assert.deepEqual(at(NOW_MS + 10 * 60_000), at(NOW_MS), "ten minutes later the repositories body is unchanged");
});

test("a repository's condition comes from pause state heartbeat incidents and run outcomes", () => {
  const live = { paused: false, stopped: false, lastDaemonMs: NOW_MS - 60_000, alerts: [] as string[] };
  const ok = measured({ succeeded: 3, failed: 1 });
  assert.deepEqual(deriveRepoCondition({ ...ok, runs7d: null }, live, NOW_MS), { condition: "unknown", reasons: ["no ledger"] });
  assert.deepEqual(deriveRepoCondition(ok, { ...live, paused: true }, NOW_MS), { condition: "paused", reasons: ["instance is paused"] });
  assert.deepEqual(deriveRepoCondition(ok, { ...live, stopped: true }, NOW_MS), { condition: "paused", reasons: ["instance is stopped"] });
  assert.deepEqual(deriveRepoCondition(ok, { ...live, lastDaemonMs: null }, NOW_MS), { condition: "down", reasons: ["no daemon heartbeat in the ledger"] });
  assert.deepEqual(deriveRepoCondition(ok, { ...live, lastDaemonMs: NOW_MS - 45 * 60_000 }, NOW_MS), { condition: "down", reasons: [`no daemon heartbeat since ${new Date(NOW_MS - 45 * 60_000).toISOString()}`] });
  assert.deepEqual(deriveRepoCondition(ok, { ...live, alerts: ["x"] }, NOW_MS), { condition: "degraded", reasons: ["1 open incident(s)"] });
  assert.deepEqual(deriveRepoCondition(measured({ succeeded: 1, failed: 2 }), live, NOW_MS), { condition: "degraded", reasons: ["2 failed vs 1 succeeded runs in 7d"] });
  assert.deepEqual(deriveRepoCondition(measured({ succeeded: 0, failed: 0 }), undefined, NOW_MS), { condition: "idle", reasons: ["no finished run in 7d"] });
  assert.deepEqual(deriveRepoCondition(ok, live, NOW_MS), { condition: "healthy", reasons: [] });
});

async function get(routes: Route[], path: string): Promise<RepoDashboardResult> {
  const server = createService({ tokens: { read: READ_TOKEN, write: "unused-write-token" }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(response.status, 200);
    return (await response.json()) as RepoDashboardResult;
  } finally {
    server.close();
  }
}

const plan = () => loadPlanFromYaml(`- id: A-1
  title: t
  repo: acme/alpha
  depends_on: []
  type: implement
  verify: auto
  files: [src/x.ts]
  status: queued
  acceptance:
    - claim: c
      proof: "grep: x in y"
`, "fixture");

test("GET /v1/repos/summary returns only the operating repository with its actions and alerts", async () => {
  const root = tmp();
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "PAUSE"), "{}");
  writeFileSync(join(root, "state", "incident-lifecycle.json"), JSON.stringify({
    a: { fingerprint: "a", title: "ci red on main", status: "filed", lastSeenMs: NOW_MS - 1000, count24h: 4 },
    b: { fingerprint: "b", title: "fixed already", status: "verified", lastSeenMs: NOW_MS - 1000, count24h: 1 },
    c: { fingerprint: "c", title: "last month", status: "filed", lastSeenMs: NOW_MS - 30 * 24 * 3600_000, count24h: 0 },
  }));
  const routes = buildRepoDashboardRoutes({
    root, instanceRepository: ALPHA, controlRoot: root, incidentsDir: join(root, "state"), ledgerPath: join(root, "state", "ledger.ndjson"),
    clock: fixedClock(NOW_MS),
    readLedger: () => [start("r1", "alpha"), merged("T-1", "2026-09-21T00:00:00.000Z"), { step: "daemon.tick", ts: "2026-09-22T11:59:00.000Z" }],
    readPlan: plan,
  });
  const body = await get(routes, "/v1/repos/summary");
  assert.equal(body.repos.length, 1);
  const [alpha] = body.repos;
  assert.equal(alpha.id, "acme/alpha");
  assert.equal(alpha.active, false);
  assert.deepEqual(alpha.health.alerts, ["ci red on main (filed, 4 in 24h)"]);
  assert.equal(alpha.health.condition, "paused");
  assert.equal(alpha.health.queued, 1);
  assert.deepEqual(alpha.actions[0], { id: "toggleonoff", available: true, method: "POST", path: "control/resume", scope: "write" });
  assert.deepEqual(alpha.actions[1], { id: "viewlogs", available: true, method: "GET", path: "recent", scope: "read" });
  assert.ok(JSON.stringify(body).length < 4096, "the summary is a few KB");
});

test("the core summary resolves its own repository from the registry and names an unreadable incident store", async () => {
  const root = tmp();
  mkdirSync(join(root, ".remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const repoRegistryPath = join(root, ".remudero", "daemon-instances.yaml");
  writeFileSync(repoRegistryPath, ["instances:", "  core:", "    github_repo: acme/core", "  site:", "    github_repo: acme/site", ""].join("\n"));
  writeFileSync(join(root, "state", "incident-lifecycle.json"), "{not json");
  const routes = buildRepoDashboardRoutes({
    root, repoRegistryPath, ownInstance: "core", controlRoot: root, incidentsDir: join(root, "state"), ledgerPath: join(root, "state", "ledger.ndjson"),
    clock: fixedClock(NOW_MS),
    readLedger: () => [{ step: "daemon.tick", ts: "2026-09-22T11:59:00.000Z" }],
    readPlan: plan,
  });
  const summary = await get(routes, "/v1/repos/summary");
  assert.deepEqual(summary.repos.map((r) => r.id), ["acme/core"]);
  assert.equal(summary.repos[0].active, true);
  assert.equal(summary.repos[0].health.alerts, null);
  assert.deepEqual(summary.repos[0].health.reasons, ["no finished run in 7d", "incident store malformed"]);
  assert.equal(summary.repos[0].actions[0].path, "control/pause");
  const all = await get(routes, "/v1/repos");
  assert.deepEqual(all.repos.map((r) => [r.id, r.active]), [["acme/core", true], ["acme/site", null]]);
  const bare = buildRepoDashboardRoutes({ root, instanceRepository: ALPHA, ledgerPath: join(root, "state", "ledger.ndjson"), clock: fixedClock(NOW_MS), readLedger: () => [], readPlan: plan });
  const noSignals = (await get(bare, "/v1/repos/summary")).repos[0];
  assert.deepEqual(noSignals.actions[0], { id: "toggleonoff", available: false, reason: "no fleet-control state was read for this instance" });
  assert.equal(noSignals.active, null);
});

test("the persistent telemetry worker keeps its ledger index warm between passes", async () => {
  const dir = tmp();
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, lines([start("r1", "alpha"), merged("r1", "2026-09-21T00:00:00.000Z")]));
  writeFileSync(join(dir, "ledger.2026-09-21T06-00-00-000Z.ndjson.gz"), gzipSync(lines([start("r2", "alpha")])));
  writeFileSync(join(dir, "tasks.yaml"), "[]\n");
  const req: RepoTelemetryRequest = { kind: "remudero-repo-telemetry", repos: [ALPHA], ledgerPath, planPath: join(dir, "tasks.yaml"), nowMs: NOW_MS, planStamp: "s1", own: 0 };
  const first = await computeRepoTelemetryOffThread(req);
  const second = await computeRepoTelemetryOffThread(req);
  assert.ok(first.ok && second.ok);
  assert.equal(first.index?.filesRead, 2);
  assert.equal(second.index?.filesRead, 0, "the second pass re-reads nothing: the worker and its index persisted");
  assert.equal(second.telemetry[0].runs7d?.succeeded, 1);
});
