import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { threadId } from "node:worker_threads";

import type { BoardDeps } from "../src/lib/board.js";
import { fixedClock } from "../src/lib/clock.js";
import { captureFeedback } from "../src/lib/feedback.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { PanelGraphDeps } from "../src/lib/panel-graph.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import { isPlanReloadWorkerFailure, readServePlanAtRef, readServePlanOffLoop, reloadServePlan, serveOnePlanReload, type PlanRead } from "../src/lib/serve-plan-reload.js";
import { createService, type SseSend } from "../src/lib/service.js";
import { subscribeStatusStream } from "../src/lib/status-stream-publisher.js";
import { feedbackOriginTag } from "../src/lib/trace.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { gitRepo } from "./helpers/git-repo.js";

const READ_TOKEN = "reloaded-plan-read-token";
const WRITE_TOKEN = "reloaded-plan-write-token";

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, ...over };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((entry) => [entry.id, entry])) };
}

function record(id: string): string {
  return `- id: ${id}\n  title: "${id}"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: medium\n  status: queued\n  attempts: 0\n`;
}

async function withServe<T>(deps: ServeDeps, fn: (get: (path: string) => Promise<Response>, post: (path: string, body: unknown) => Promise<Response>) => Promise<T>): Promise<T> {
  const server = createService({ tokens: deps.tokens, routes: buildServeRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(
      (path) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } }),
      (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
  } finally {
    server.close();
  }
}

test("trace and feedback read the reloaded serve plan not the working tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-serve-reloaded-plan-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, record("W1-T1"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  captureFeedback(root, { raw: "filed by a plan-only merge", origin: "cli", id: "fb-1" });
  const github = fakeGitHub({
    findMergedByTrailer: (id: string) => (id === "W1-T2" ? { number: 7, url: "https://example.invalid/pull/7", state: "MERGED" } : null),
    findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [],
    readTruncated: () => false,
  });
  const issues: IssueCloser = { close() {} };
  const board: BoardDeps = { plan: planOf([task("W1-T1")]), ledgerPath, github };
  const panelGraph: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} },
  };
  const deps: ServeDeps = {
    board, panelGraph, ledgerPath, issues, fleetControlRoot: root, questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, githubAppRefresh: { start: () => ({ armed: false }) },
  };

  await withServe(deps, async (get, post) => {
    assert.equal((await get("/v1/trace?id=W1-T2")).status, 404, "a task only the working-tree plan lacks is unknown before the reload");
    board.plan = planOf([task("W1-T1"), task("W1-T2", { origin: feedbackOriginTag("fb-1") })]);
    const trace = await get("/v1/trace?id=W1-T2");
    assert.equal(trace.status, 200, await trace.clone().text());
    assert.equal(((await trace.json()) as { chain: { tasks: Array<{ id: string }> } }).chain.tasks[0]?.id, "W1-T2");
    const feedback = (await (await get("/v1/feedback")).json()) as { entries: Array<{ id: string; discharged?: boolean }> };
    assert.deepEqual(feedback.entries.map((e) => [e.id, e.discharged]), [["fb-1", true]], "the reloaded task discharges its feedback entry");
    const decline = await post("/v1/inbox/decline", { proposalId: "P404", reason: "no such proposal" });
    assert.equal(decline.status, 404, "the write route classifies against the reloaded snapshot instead of parsing a plan it cannot read");
  });
});

function streamSink(events: Array<{ event: string; data: { taskId?: string } }>): SseSend {
  return (event, data) => void events.push({ event, data: data as { taskId?: string } });
}

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

test("the status stream publisher derives a task filed after it started", async () => {
  let rows: Array<Record<string, unknown>> = [];
  const deps: BoardDeps = { plan: planOf([task("W1-T1")]), ledgerPath: "/unused", github: fakeGitHub({}), readLedger: () => rows };
  const events: Array<{ event: string; data: { taskId?: string } }> = [];
  const stop = subscribeStatusStream(deps, streamSink(events), { pollMs: 5, heartbeatMs: 60_000 });
  try {
    deps.plan = planOf([task("W1-T1"), task("W1-T2")]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(events.length, 0, "a reload that adds a task primes it and flips nothing");
    rows = [{ task_id: "W1-T2", run_id: "run-1", step: "run.start", ts: new Date().toISOString() }];
    await until(() => events.length > 0);
    assert.deepEqual(events.map((e) => [e.event, e.data.taskId]), [["status", "W1-T2"]], "the task filed after the publisher started reaches the stream");
  } finally {
    stop();
  }
});

test("a serve plan reload parses off the event loop", async () => {
  const repo = gitRepo({ kind: "serve-plan-reload-off-loop" });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), record("W1-T1"));
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T2-a.yaml"), record("W1-T2"));
  repo.git("add", "plan");
  repo.git("commit", "--quiet", "-m", "plan");
  const ref = repo.git("rev-parse", "HEAD");

  const read = await readServePlanOffLoop(repo.dir, ref);
  assert.notEqual(read.threadId, threadId, "the plan was parsed on another thread");
  assert.deepEqual(read.plan.tasks.map((t) => t.id), ["W1-T1", "W1-T2"]);
  assert.deepEqual([...read.plan.byId.keys()], ["W1-T1", "W1-T2"]);
  assert.equal(read.plan.byId.get("W1-T2"), read.plan.tasks[1], "byId and tasks still share one object per task");

  const board = { plan: planOf([]) };
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  assert.equal(await reloadServePlan(board, repo.dir, ref, { log: (s, e) => logs.push([s, e]) }), true);
  assert.equal(board.plan.tasks.length, 2);
  const reloaded = logs.find(([step]) => step === "serve.plan_reloaded")?.[1];
  assert.equal(typeof reloaded?.gitMs, "number", "git time is ledgered on its own");
  assert.equal(typeof reloaded?.parseMs, "number", "parse time is ledgered on its own");

  assert.equal(await reloadServePlan(board, repo.dir, "deadbeef", { log: (s, e) => logs.push([s, e]) }), false);
  assert.equal(board.plan.tasks.length, 2, "a failed reload keeps the old plan serving");
  assert.ok(logs.some(([step]) => step === "serve.plan_reload_failed"));

  await assert.rejects(readServePlanOffLoop(repo.dir, ref, new URL("file:///nonexistent/serve-plan-reload-worker.mjs")));
});

test("the plan reload worker answers with the read or the reason it failed", async () => {
  const repo = gitRepo({ kind: "serve-plan-reload-worker" });
  mkdirSync(join(repo.dir, "plan"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), record("W1-T1"));
  repo.git("add", "plan");
  repo.git("commit", "--quiet", "-m", "plan");
  const ref = repo.git("rev-parse", "HEAD");
  const sent: unknown[] = [];
  await serveOnePlanReload({ repoDir: repo.dir, ref }, { postMessage: (m) => void sent.push(m) });
  await serveOnePlanReload({ repoDir: repo.dir, ref: "deadbeef" }, { postMessage: (m) => void sent.push(m) });
  await serveOnePlanReload({ repoDir: repo.dir, ref }, null);
  assert.equal((sent[0] as { ok: boolean }).ok, true);
  assert.equal((sent[1] as { ok: boolean }).ok, false);
  assert.equal(sent.length, 2);
  const timed = await readServePlanAtRef(repo.dir, ref, fixedClock(1_000));
  assert.deepEqual([timed.gitMs, timed.parseMs], [0, 0]);
});

test("a plan reload worker that cannot do the job degrades to an inline read, never to a stale plan", async () => {
  const repo = gitRepo({ kind: "serve-plan-reload-fallback" });
  mkdirSync(join(repo.dir, "plan"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), record("W1-T1"));
  repo.git("add", "plan");
  repo.git("commit", "--quiet", "-m", "plan");
  const ref = repo.git("rev-parse", "HEAD");
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const log = (step: string, extra?: Record<string, unknown>) => void logs.push([step, extra]);
  const steps = () => logs.map(([step]) => step);

  const missing = readServePlanOffLoop(repo.dir, ref, new URL("file:///nonexistent/serve-plan-reload-worker.mjs"));
  await assert.rejects(missing, isPlanReloadWorkerFailure);
  await assert.rejects(readServePlanOffLoop(repo.dir, ref, "relative-worker.js" as unknown as URL), isPlanReloadWorkerFailure);
  assert.equal(isPlanReloadWorkerFailure(new Error("plain")), false);
  assert.equal(isPlanReloadWorkerFailure("not an error"), false);

  const board = { plan: planOf([]) };
  const dead = (): Promise<PlanRead> => readServePlanOffLoop(repo.dir, ref, "relative-worker.js" as unknown as URL);
  assert.equal(await reloadServePlan(board, repo.dir, ref, { offLoop: dead, log }), true);
  assert.deepEqual(board.plan.tasks.map((t) => t.id), ["W1-T1"], "the plan still reloads, on the loop");
  assert.deepEqual(steps(), ["serve.plan_reload_worker_failed", "serve.plan_reloaded"]);
  assert.match(String(logs[0]?.[1]?.reason), /worker|path/i);
  assert.equal(logs[0]?.[1]?.ref, ref);

  logs.length = 0;
  const failed = async (): Promise<PlanRead> => {
    throw new Error("duplicate frontmatter");
  };
  const before = board.plan;
  assert.equal(await reloadServePlan(board, repo.dir, ref, { offLoop: failed, log }), false);
  assert.equal(board.plan, before, "a worker that ran and failed keeps the old plan serving");
  assert.deepEqual(steps(), ["serve.plan_reload_failed"], "no inline retry of a read the worker already failed");

  logs.length = 0;
  const fresh = planOf([task("W1-T1"), task("W1-T2")]);
  assert.equal(await reloadServePlan(board, repo.dir, ref, { offLoop: async () => ({ plan: fresh, quarantined: [] }), log }), true);
  assert.equal(board.plan, fresh);
  assert.deepEqual(steps(), ["serve.plan_reloaded"], "a working worker is used as is");
});
