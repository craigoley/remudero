import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusRoute, createBoardSnapshotCache } from "../src/lib/board.js";
import { computeWorkerBoardSnapshot, createBoardProjectionWorker, type BoardProjectionWorker } from "../src/lib/board-worker.js";
import { loadPlan } from "../src/lib/plan.js";
import { serveCommand } from "../src/run-task.js";
import { fakeGitHub, type FakeGitHub } from "./helpers/fake-github.js";
import { ghShim } from "./helpers/gh-shim.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const gatewayShim = ghShim([{ when: "api ", stdout: "[]" }], { kind: "board-projection-gh" });

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function fixture(t: { after(fn: () => void | Promise<void>): void }, options: {
  delayMs?: number; taskCount?: number; ledgerRows?: number;
  missingSource?: "plan" | "ledger";
  staleGithub?: boolean;
  crashWorker?: boolean;
  spawnFailWorker?: boolean;
  throwGithubFact?: boolean;
  slowGithubFact?: boolean;
  lateGithubHealthFact?: boolean;
  trailerLookup?: "ready" | "unavailable";
  intervalMs?: number;
  staleMs?: number;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-board-worker-"));
  const planDir = join(root, "plan");
  mkdirSync(planDir);
  const planPath = join(planDir, "tasks.yaml");
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(planPath, Array.from({ length: options.taskCount ?? 1 }, (_, index) => [
    `- id: W1-T${index + 1}`, "  title: worker fixture", "  repo: remudero", "  depends_on: []",
    "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", "",
  ].join("\n")).join(""));
  writeFileSync(ledgerPath, Array.from({ length: options.ledgerRows ?? 0 }, (_, index) =>
    JSON.stringify({ ts: "2026-09-30T12:00:00Z", task_id: `W1-T${index % (options.taskCount ?? 1) + 1}`, step: "run.start", run_id: `r${index}` }) + "\n",
  ).join(""));
  let delayedHealthFact = false;
  const github: FakeGitHub = fakeGitHub({
    readFailed: () => {
      if (options.lateGithubHealthFact && !delayedHealthFact) {
        delayedHealthFact = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_300);
      }
      return false;
    },
    listMergedHeadBranches: () => {
      if (options.throwGithubFact) throw new Error("forced board fact failure");
      if (options.slowGithubFact) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_600);
      return [];
    },
    listOpenHeadBranches: () => [],
    findMergedByHeadBranch: () => [],
    ...(options.trailerLookup ? { mergedTrailerLookup: () => options.trailerLookup === "ready" ? (_taskId: string) => null : null } : {}),
    ...(options.staleGithub ? { factsAgeMs: () => 60_000, factsStale: () => true } : {}),
  });
  const worker = createBoardProjectionWorker(github, { planPath, ledgerPath, inflightDir: join(root, "inflight") }, {
    intervalMs: options.intervalMs ?? 1_000,
    delayMs: options.delayMs,
    staleMs: options.staleMs,
    ...(options.crashWorker ? { workerUrl: new URL('data:text/javascript,throw new Error("forced board worker crash")') } : {}),
    ...(options.spawnFailWorker ? { workerUrl: new URL("https://example.invalid/worker.js") } : {}),
  });
  const route = buildStatusRoute({ plan: loadPlan(planPath), ledgerPath, github }, undefined, worker);
  const server = createHttpServer((req, res) => {
    if (req.url === "/v1/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"version":"test"}');
    } else if (req.url === "/v1/status") {
      void route.handler(req, res, {} as never);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    worker.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  if (options.missingSource === "plan") rmSync(planPath);
  if (options.missingSource === "ledger") rmSync(ledgerPath);
  const startedAt = Date.now();
  worker.start();
  return { worker, github, planPath, ledgerPath, url: `http://127.0.0.1:${port}`, startedAt };
}

async function ready(worker: BoardProjectionWorker, boundMs = 10_000): Promise<void> {
  const deadline = Date.now() + boundMs;
  while (!worker.isReady() && Date.now() < deadline) await sleep(20);
  assert.equal(worker.isReady(), true, JSON.stringify(worker.current()));
}

async function expectUnavailableReason(worker: BoardProjectionWorker, marker: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = worker.current();
    if (state.state === "unavailable" && state.reason.includes(marker)) return;
    await sleep(20);
  }
  assert.fail(`board never reported ${marker}: ${JSON.stringify(worker.current())}`);
}

test("W1-T5004: a synchronous worker spawn refusal stays unavailable", async (t) => {
  const { worker } = await fixture(t, { spawnFailWorker: true });
  await expectUnavailableReason(worker, "worker_spawn_failed");
});

test("W1-T5004: a failed GitHub fact reaches the worker as an error", async (t) => {
  const { worker } = await fixture(t, { throwGithubFact: true });
  await expectUnavailableReason(worker, "forced board fact failure");
});

test("W1-T5004: an unanswered GitHub fact times out", async (t) => {
  const { worker } = await fixture(t, { slowGithubFact: true, intervalMs: 60_000 });
  await expectUnavailableReason(worker, "timed out");
});

test("board worker discards a late timed-out health reply before reading merged PRs", { timeout: 30_000 }, async (t) => {
  const { worker, github } = await fixture(t, { lateGithubHealthFact: true, intervalMs: 60_000 });
  await ready(worker, 20_000);
  assert.equal(worker.current().state, "ready", "the first pass recovers without waiting for the next minute-long tick");
  assert.ok(github.calls.some((call) => call.method === "listMergedHeadBranches"), "merged PRs were read after the late health reply");
});

test("W1-T5004: merged-trailer lookup preserves ready and unavailable answers", async (t) => {
  for (const trailerLookup of ["ready", "unavailable"] as const) {
    const { worker, github } = await fixture(t, { trailerLookup });
    await ready(worker);
    assert.ok(github.calls.some((call) => call.method === "mergedTrailerLookup"), `${trailerLookup} lookup reached the parent`);
  }
});

test("W1-T5004: default cold projection leaves cheap routes responsive", async (t) => {
  const { worker, url, startedAt } = await fixture(t, { delayMs: 200, taskCount: 1_800, ledgerRows: 20_000 });
  const started = Date.now();
  const version = await fetch(`${url}/v1/version`);
  assert.equal(version.status, 200);
  const bootToFirstAnswerMs = Date.now() - startedAt;
  assertWallClockBound(Date.now() - started, 600, "the worker's held projection cannot hold the HTTP loop");
  let last = Date.now();
  let largestLag = 0;
  const probe = setInterval(() => {
    const now = Date.now();
    largestLag = Math.max(largestLag, now - last - 50);
    last = now;
  }, 50);
  try {
    await ready(worker, 30_000);
  } finally {
    clearInterval(probe);
  }
  t.diagnostic(`1800 tasks / 20000 ledger rows: boot-to-first-answer=${bootToFirstAnswerMs}ms, max event-loop lag=${largestLag}ms`);
  assertWallClockBound(largestLag, 600, "the representative projection cannot hold the serving loop");
});

test("W1-T5004: cold status is bounded and explicitly unavailable", async (t) => {
  const { url } = await fixture(t, { delayMs: 700 });
  const started = Date.now();
  const response = await fetch(`${url}/v1/status`);
  assert.equal(response.status, 503);
  assertWallClockBound(Date.now() - started, 600, "cold status responds before the projection completes");
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.error, "board_unavailable");
  assert.equal(body.reason, "not_ready");
  assert.ok(Number.isFinite(Date.parse(String(body.buildStartedAt))));
  assert.ok(Number.isFinite(Date.parse(String(body.checkedAt))));
  assert.equal(body.counts, undefined, "cold is not a fabricated zero");
});

test("W1-T5004: worker snapshot reaches status without a serve-thread recompute", async (t) => {
  const { worker, github, url } = await fixture(t);
  await ready(worker);
  const callsBefore = github.calls.length;
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${url}/v1/status`);
    assert.equal(response.status, 200);
    const body = await response.json() as { tasks: Array<{ taskId: string }>; generated_at: string };
    assert.equal(body.tasks[0]?.taskId, "W1-T1");
    assert.ok(Number.isFinite(Date.parse(body.generated_at)));
  }
  assert.equal(github.calls.length, callsBefore, "status reads only the atomically published snapshot");
});

test("W1-T5004: a later ledger change is projected off-thread", async (t) => {
  const { worker, ledgerPath, url } = await fixture(t, { intervalMs: 100 });
  await ready(worker);
  const first = worker.current();
  assert.equal(first.state, "ready");
  appendFileSync(ledgerPath, JSON.stringify({
    ts: new Date().toISOString(), task_id: "W1-T1", run_id: "r1", step: "run.start",
  }) + "\n");
  const deadline = Date.now() + 5_000;
  let phase: string | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/v1/status`);
    const body = await response.json() as { tasks?: Array<{ phase?: string }> };
    phase = body.tasks?.[0]?.phase;
    if (phase === "recon") break;
    await sleep(30);
  }
  assert.equal(phase, "recon", "the worker's next pass publishes the ledger change");
});

test("W1-T5004: worker failure is unavailable not zero", async (t) => {
  const { worker, url } = await fixture(t, { crashWorker: true });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = worker.current();
    if (current.state === "unavailable" && current.reason !== "not_ready") break;
    await sleep(20);
  }
  const response = await fetch(`${url}/v1/status`);
  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, unknown>;
  assert.match(String(body.reason), /worker_crashed|worker_exited/);
  assert.equal(body.counts, undefined);
  assert.equal((await fetch(`${url}/v1/version`)).status, 200);
});

test("W1-T5004: unreadable plan and ledger stay unavailable", async (t) => {
  for (const missingSource of ["plan", "ledger"] as const) {
    const { worker, url } = await fixture(t, { missingSource });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const current = worker.current();
      if (current.state === "unavailable" && current.reason !== "not_ready") break;
      await sleep(20);
    }
    const response = await fetch(`${url}/v1/status`);
    assert.equal(response.status, 503);
    const body = await response.json() as Record<string, unknown>;
    assert.match(String(body.reason), /worker_projection_failed/);
    assert.equal(body.counts, undefined);
  }
});

test("W1-T5004: worker projection helper shares the cache and refuses a missing ledger", async (t) => {
  const { github, planPath, ledgerPath } = await fixture(t);
  const deps = { plan: loadPlan(planPath), ledgerPath, github };
  const cache = createBoardSnapshotCache();
  const first = computeWorkerBoardSnapshot(deps, cache);
  assert.equal(first.tasks[0]?.taskId, "W1-T1");
  assert.equal(computeWorkerBoardSnapshot(deps, cache), first, "an unchanged projection reuses its worker cache");
  rmSync(ledgerPath);
  assert.throws(() => computeWorkerBoardSnapshot(deps, cache), /ENOENT/);
});

test("W1-T5004: stale GitHub facts keep their source timestamp", async (t) => {
  const { worker, url } = await fixture(t, { staleGithub: true });
  await ready(worker);
  const response = await fetch(`${url}/v1/status`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.github_facts_status, "stale");
  assert.equal(body.github_facts_age_ms, 60_000);
});

test("W1-T5004: a stalled projection becomes dated unavailable", async (t) => {
  const { worker, url } = await fixture(t, { intervalMs: 60_000, staleMs: 200 });
  await ready(worker);
  await sleep(250);
  const response = await fetch(`${url}/v1/status`);
  assert.equal(response.status, 503);
  assert.equal(worker.isReady(), false, "the standby readiness probe sees the same stale verdict");
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.reason, "projection_stale");
  assert.ok(Number.isFinite(Date.parse(String(body.checkedAt))));
});

test("W1-T5004: real serve boot answers while projection is cold", async (t) => {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "rmd-board-serve-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({
    claudeBin: "/bin/true", root, installRoot: join(import.meta.dirname, ".."), serve: { host: "127.0.0.1", port },
  }));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  const running = serveCommand([], {
    branch: () => "main",
    boardGhBin: join(gatewayShim.dir, "gh"),
    boardProjectionOptions: { delayMs: 2_000 },
    loadBoardPlan: () => { throw new Error("forced initial board plan read failure"); },
  });
  t.after(async () => {
    process.emit("SIGTERM");
    await running;
    console.log = oldLog;
    process.env.HOME = oldHome;
  });
  const deadline = Date.now() + 90_000;
  while (!lines.some((line) => line.includes("listening on")) && Date.now() < deadline) await sleep(50);
  assert.ok(lines.some((line) => line.includes(`127.0.0.1:${port}`)), "the configured interface bound");
  const token = (JSON.parse(readFileSync(join(root, "state", "service-tokens.json"), "utf8")) as { read: string }).read;
  const headers = { authorization: `Bearer ${token}` };
  assert.match(readFileSync(join(root, "state", "ledger.ndjson"), "utf8"), /serve\.board_plan_unreadable.*forced initial board plan read failure/);
  const started = Date.now();
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/version`, { headers })).status, 200);
  assertWallClockBound(Date.now() - started, 1_000, "the real boot path answers inside the client budget");
  const cold = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers });
  assert.equal(cold.status, 503);
  const coldBody = await cold.json() as Record<string, unknown>;
  assert.equal(coldBody.error, "board_unavailable", "the default worker source owns the refusal");
  assert.ok(Number.isFinite(Date.parse(String(coldBody.checkedAt))));
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/status`)).status, 401);
  process.emit("SIGTERM");
  assert.equal(await running, 0);
});
