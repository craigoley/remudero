import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { threadId, Worker } from "node:worker_threads";

import { createBoardProjectionWorker } from "../src/lib/board-worker.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { reloadServePlan } from "../src/lib/serve-plan-reload.js";
import { PLAN_PIN_ADOPT_FAILED_STEP, PLAN_PIN_ADOPTED_STEP, publishThreadPlan, threadPlanPin, threadStrictPlan } from "../src/lib/thread-plan.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { gitRepo } from "./helpers/git-repo.js";

type Row = [string, Record<string, unknown>];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const record = (id: string): string => [
  `- id: ${id}`, "  title: pinned fixture", "  repo: remudero", "  depends_on: []",
  "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", "",
].join("\n");

/** A checkout whose working tree stays at the first commit while later plan-only commits exist, as a generation slot's does. */
function slot(): { dir: string; planPath: string; ledgerPath: string; shas: string[] } {
  const repo = gitRepo();
  mkdirSync(join(repo.dir, "plan"), { recursive: true });
  const planPath = join(repo.dir, "plan", "tasks.yaml");
  const shas: string[] = [];
  for (const ids of [["W1-T1"], ["W1-T1", "W1-T2"], ["W1-T1", "W1-T2", "W1-T3"]]) {
    writeFileSync(planPath, ids.map(record).join(""));
    repo.git("add", "plan/tasks.yaml");
    repo.git("commit", "-q", "-m", `plan ${ids.length}`);
    shas.push(repo.git("rev-parse", "HEAD"));
  }
  repo.git("update-ref", "refs/remotes/origin/main", shas[2]!);
  repo.git("reset", "-q", "--hard", shas[0]!);
  const ledgerPath = join(repo.dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  return { dir: repo.dir, planPath, ledgerPath, shas };
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > deadline) assert.fail(`${label}: last read ${JSON.stringify(value)}`);
    await sleep(25);
    value = await read();
  }
  return value;
}

function boardWorker(t: { after(fn: () => void): void }, fixture: ReturnType<typeof slot>) {
  const github = fakeGitHub({ listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], findMergedByHeadBranch: () => [] });
  const worker = createBoardProjectionWorker(github, { planPath: fixture.planPath, ledgerPath: fixture.ledgerPath, inflightDir: join(fixture.dir, "inflight") }, { intervalMs: 50 });
  t.after(() => worker.stop());
  worker.start();
  const ids = (): string[] => {
    const state = worker.current();
    return state.state === "ready" ? state.snapshot.tasks.map((task) => task.taskId) : [];
  };
  return { worker, ids };
}

/** What serve's gate does on a plan-only advance: reloadServePlan, publishing what it installed to every thread. */
function reload(fixture: ReturnType<typeof slot>, board: { plan: Plan }, rows: Row[], ref: string): Promise<boolean> {
  const log = (step: string, extra: Record<string, unknown> = {}): void => void rows.push([step, extra]);
  return reloadServePlan(board, fixture.dir, ref, { log, onReloaded: (at, read) => publishThreadPlan({ path: fixture.planPath, repoDir: fixture.dir, ref: at }, read, log) });
}

const adoptions = (rows: Row[], path?: string): Row[] => rows.filter(([step, row]) => step === PLAN_PIN_ADOPTED_STEP && (path === undefined || row.path === path));

test("a plan-only commit the slot's working tree never sees reaches the board worker and a views thread after reloadServePlan", async (t) => {
  const fixture = slot();
  const { ids } = boardWorker(t, fixture);
  const view = new Worker(new URL("./helpers/plan-pin-view-thread.ts", import.meta.url), { workerData: { planPath: fixture.planPath, ledgerDir: fixture.dir, ids: ["W1-T1", "W1-T2"] }, execArgv: process.execArgv });
  t.after(() => void view.terminate());
  const viewIds = async (): Promise<string[]> => {
    const answer = new Promise<string[]>((resolve) => view.once("message", resolve));
    view.postMessage("build");
    return answer;
  };
  assert.deepEqual(await until(ids, (now) => now.length > 0, "the board worker is ready"), ["W1-T1"]);
  assert.deepEqual(await viewIds(), ["W1-T1"], "the views thread reads the working tree's plan before any reload");

  const board = { plan: loadPlan(fixture.planPath) };
  const rows: Row[] = [];
  assert.equal(await reload(fixture, board, rows, fixture.shas[1]!), true);
  assert.deepEqual(board.plan.tasks.map((task) => task.id), ["W1-T1", "W1-T2"], "the main thread installed the new plan");
  assert.deepEqual(await until(ids, (now) => now.includes("W1-T2"), "the board worker follows the main thread"), ["W1-T1", "W1-T2"]);
  assert.deepEqual(await until(viewIds, (now) => now.includes("W1-T2"), "the views thread follows the main thread"), ["W1-T1", "W1-T2"]);
});

test("main and worker plan identities match after a reload and each thread's adoption is ledgered", async (t) => {
  const fixture = slot();
  const { ids } = boardWorker(t, fixture);
  await until(ids, (now) => now.length > 0, "the board worker is ready");
  const board = { plan: loadPlan(fixture.planPath) };
  const rows: Row[] = [];
  await reload(fixture, board, rows, fixture.shas[1]!);
  const [, adopted] = (await until(() => adoptions(rows, fixture.planPath), (found) => found.length > 0, "the worker reports its adoption"))[0]!;
  const reloaded = rows.find(([step]) => step === "serve.plan_reloaded")![1];
  assert.equal(adopted.ref, reloaded.ref, "the worker loaded the commit the main thread loaded");
  assert.equal(adopted.repoDir, fixture.dir);
  assert.equal(adopted.path, fixture.planPath);
  assert.equal(adopted.tasks, board.plan.tasks.length);
  assert.notEqual(adopted.threadId, threadId, "the row comes from another thread");
  assert.equal(threadPlanPin(fixture.planPath), `ref:${fixture.dir}@${fixture.shas[1]}`, "the main thread answers from the same commit");
  assert.equal(threadStrictPlan(fixture.planPath), board.plan, "the main thread's readers share the plan reloadServePlan installed");
});

test("an unchanged pinned plan is not re-parsed in a worker", async (t) => {
  const fixture = slot();
  const { ids } = boardWorker(t, fixture);
  await until(ids, (now) => now.length > 0, "the board worker is ready");
  const board = { plan: loadPlan(fixture.planPath) };
  const rows: Row[] = [];
  await reload(fixture, board, rows, fixture.shas[1]!);
  await until(() => adoptions(rows, fixture.planPath), (found) => found.length === 1, "the first adoption");
  await reload(fixture, board, rows, fixture.shas[1]!);
  await reload(fixture, board, rows, fixture.shas[2]!);
  await until(ids, (now) => now.includes("W1-T3"), "the later commit is adopted");
  await until(() => adoptions(rows, fixture.planPath), (found) => found.length === 2, "the later commit's adoption row");
  assert.deepEqual(adoptions(rows, fixture.planPath).map(([, row]) => row.ref), [fixture.shas[1], fixture.shas[2]], "the repeated commit was loaded once");
});

test("a worker started after the reload asks for the current plan and adopts it", async (t) => {
  const fixture = slot();
  const board = { plan: loadPlan(fixture.planPath) };
  const rows: Row[] = [];
  await reload(fixture, board, rows, fixture.shas[1]!);
  const { ids } = boardWorker(t, fixture);
  assert.deepEqual(await until(ids, (now) => now.includes("W1-T2"), "a late worker adopts the published plan"), ["W1-T1", "W1-T2"]);
});

test("a worker that cannot read the pinned commit keeps its plan and the failure is ledgered", async (t) => {
  const fixture = slot();
  const { ids } = boardWorker(t, fixture);
  await until(ids, (now) => now.length > 0, "the board worker is ready");
  const rows: Row[] = [];
  const missing = "0".repeat(40);
  publishThreadPlan({ path: fixture.planPath, repoDir: fixture.dir, ref: missing }, { plan: loadPlan(fixture.planPath), quarantined: [] }, (step, extra = {}) => void rows.push([step, extra]));
  const [, failed] = (await until(() => rows.filter(([step]) => step === PLAN_PIN_ADOPT_FAILED_STEP), (found) => found.length > 0, "the failure row"))[0]!;
  assert.equal(failed.ref, missing);
  assert.match(String(failed.reason), /./);
  assert.deepEqual(ids(), ["W1-T1"], "the worker keeps serving its last plan");
});

test("a pinned plan that quarantined a duplicate answers the strict read with the plan the main thread installed", () => {
  const fixture = slot();
  const plan = loadPlan(fixture.planPath);
  publishThreadPlan({ path: fixture.planPath, repoDir: fixture.dir, ref: fixture.shas[0]! }, { plan, quarantined: [{ id: "W1-T9", files: ["plan/tasks.yaml"] }] as never });
  assert.equal(threadStrictPlan(fixture.planPath), plan);
});
