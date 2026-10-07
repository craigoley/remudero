import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createBoardProjectionWorker } from "../src/lib/board-worker.js";
import { loadPlan } from "../src/lib/plan.js";
import { repoRoot } from "../src/lib/repo-location.js";
import { planFilesIdentity } from "../src/lib/thread-plan.js";
import { serveCommand } from "../src/run-task.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { ghShim } from "./helpers/gh-shim.js";

// W1-T5639: after an initial assembly failure the DEFAULT board worker recovers on its own. Plan-view must adopt the
// generation that worker read, rather than stay bound to the failed placeholder beside a healthy board.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const gatewayShim = ghShim([{ when: "api ", stdout: "[]" }], { kind: "plan-source-default-worker-gh" });

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("the default board worker reports the plan identity it projected from, and tells serve on every snapshot", { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-source-worker-"));
  mkdirSync(join(root, "plan"));
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "- id: W1-T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n");
  writeFileSync(join(root, "ledger.ndjson"), "");
  const told: string[] = [];
  const worker = createBoardProjectionWorker(fakeGitHub({ listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], findMergedByHeadBranch: () => [] }),
    { planPath, ledgerPath: join(root, "ledger.ndjson"), inflightDir: join(root, "inflight") },
    { intervalMs: 60_000, onSnapshot: (identity) => told.push(identity) });
  t.after(() => worker.stop());
  assert.equal(worker.planIdentity?.(), undefined, "nothing is claimed before a snapshot is published");
  worker.start();
  const deadline = Date.now() + 30_000;
  while (told.length === 0 && Date.now() < deadline) await sleep(20);
  assert.deepEqual(told, [planFilesIdentity(planPath)], "the callback carries the identity of the files the thread parsed");
  assert.equal(worker.planIdentity?.(), planFilesIdentity(planPath));
});

test("real default worker and Plan-view agree on the adopted generation after an initial assembly failure", { timeout: 240_000 }, async (t) => {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "rmd-plan-source-default-"));
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
  let reads = 0;
  const snapshots: string[] = [];
  const running = serveCommand([], {
    branch: () => "main",
    boardGhBin: join(gatewayShim.dir, "gh"),
    boardProjectionOptions: { delayMs: 200, onSnapshot: (identity) => snapshots.push(identity) },
    // Only serve's FIRST read fails; the thread reads the real file itself and recovers.
    loadBoardPlan: (path) => {
      if (reads++ === 0) throw new Error("forced initial board plan read failure");
      return loadPlan(path);
    },
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
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };

  const adoptedBy = Date.now() + 150_000;
  let view = await get("/v1/plan/view");
  while (view.body.planSource?.state !== "loaded" && Date.now() < adoptedBy) {
    await sleep(500);
    view = await get("/v1/plan/view");
  }
  const expected = planFilesIdentity(join(repoRoot, "plan", "tasks.yaml"));
  assert.equal(view.body.planSource.state, "loaded", "serve adopted the plan once the default worker published one");
  assert.equal(view.body.planSource.generation, 1);
  assert.equal(view.body.planSource.identity, expected, "Plan-view names the generation the worker projected from");
  assert.ok(snapshots.includes(expected), "and the worker published that same generation");
  assert.ok(view.body.sections.length > 0 || view.body.progress.total > 0, "the adopted plan has real tasks");
  assert.equal((await get("/v1/status")).status, 200, "the board worker and Plan-view now agree");
  assert.match(readFileSync(join(root, "state", "ledger.ndjson"), "utf8"), /serve\.plan_source_adopted/);
  const census = await get("/v1/inbox/attention-census");
  assert.notEqual(census.body.error, "plan_source_unavailable", "the readers that refused are repaired without a restart");
  process.emit("SIGTERM");
  assert.equal(await running, 0);
});
