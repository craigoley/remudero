// @source-text-subject: criterion 3 is that the idle interval is DECLARED with a BACKSTOP comment, so the
// declaration's own text in src/lib/board-worker.ts is that criterion's subject; every other claim here is behaviour.
//
// W1-T11935: serve's board worker projected every 3 s with nobody watching (serve research, 2026-11-10). While serve
// reports no status or event-stream client the thread projects only every idle interval; a client connecting puts it
// back on the active interval at once, projecting first when the snapshot is older than that interval. These run the
// real projection thread, with short intervals so the cadence is countable.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBoardSnapshotCache, type BoardSnapshot } from "#src/lib/board.js";
import {
  BOARD_PROJECTION_IDLE_INTERVAL_MS,
  BOARD_PROJECTION_INTERVAL_MS,
  BOARD_PROJECTION_STALE_MS,
  boardWorkerPass,
  createBoardProjectionWorker,
  paceBoardProjection,
  type BoardProjectionWorker,
} from "#src/lib/board-worker.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const boardFacts = () => fakeGitHub({ listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], findMergedByHeadBranch: () => [] });

function paths(t: { after(fn: () => void): void }): { planPath: string; ledgerPath: string; inflightDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-board-backoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan"));
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, ["- id: W1-T1", "  title: backoff fixture", "  repo: remudero", "  depends_on: []",
    "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n"));
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify({ ts: "2026-11-10T12:00:00Z", task_id: "W1-T1", step: "run.start", run_id: "r1" }) + "\n");
  return { planPath, ledgerPath, inflightDir: join(root, "inflight") };
}

/** A real board worker whose every published snapshot is counted, with its wall-clock arrival. */
function countedWorker(t: { after(fn: () => void): void }, options: { intervalMs: number; idleIntervalMs: number }) {
  const arrivals: number[] = [];
  const input = paths(t);
  const worker = createBoardProjectionWorker(boardFacts(), input, { ...options, onSnapshot: () => arrivals.push(Date.now()) });
  t.after(() => worker.stop());
  return { worker, arrivals, input };
}

async function until(what: string, ok: () => boolean, boundMs = 10_000): Promise<void> {
  const deadline = Date.now() + boundMs;
  while (!ok() && Date.now() < deadline) await sleep(10);
  assert.ok(ok(), what);
}

const snapshotOf = (worker: BoardProjectionWorker): BoardSnapshot => {
  const state = worker.current();
  assert.equal(state.state, "ready", JSON.stringify(state));
  return (state as { snapshot: BoardSnapshot }).snapshot;
};

test("W1-T11935 criterion 1: with no connected client the board worker projects no more often than the idle interval", async (t) => {
  const { worker, arrivals } = countedWorker(t, { intervalMs: 50, idleIntervalMs: 600 });
  worker.setClientPresence(false);
  worker.start();
  await until("the idle thread publishes its first snapshot", () => arrivals.length >= 1);
  await sleep(1_500);
  // At the 50 ms active interval this window holds ~30 passes; idle at 600 ms it holds the first and at most three more.
  assert.ok(arrivals.length <= 4, `idle passes in ~1.5 s: ${arrivals.length}`);
  for (let i = 1; i < arrivals.length; i++) assert.ok(arrivals[i]! - arrivals[i - 1]! >= 500, `idle gap ${arrivals[i]! - arrivals[i - 1]!} ms`);
});

test("W1-T11935 criterion 1: a client leaving moves a running thread to the idle interval", async (t) => {
  const { worker, arrivals } = countedWorker(t, { intervalMs: 50, idleIntervalMs: 60_000 });
  worker.start();
  await until("the active thread projects on its 50 ms interval", () => arrivals.length >= 3);
  worker.setClientPresence(false);
  await sleep(150);
  const settled = arrivals.length;
  await sleep(1_000);
  assert.equal(arrivals.length, settled, "no pass while idle inside a minute-long idle interval");
});

test("W1-T11935 criterion 2: a client connecting returns the interval to the active 3 seconds within one tick and the first snapshot it reads is current", async (t) => {
  const activeMs = 200;
  const { worker, arrivals } = countedWorker(t, { intervalMs: activeMs, idleIntervalMs: 60_000 });
  worker.setClientPresence(false);
  worker.start();
  await until("the idle thread publishes its first snapshot", () => arrivals.length >= 1);
  await sleep(activeMs * 2);
  assert.equal(arrivals.length, 1, "idle: no second pass inside the minute-long idle interval");
  const connectedAt = Date.now();
  worker.setClientPresence(true);
  // The snapshot is older than the active interval, so the connect projects at once rather than waiting out the
  // minute-long idle interval: a pass inside 5 s can only be the connect's own, or the active interval's.
  await until("a pass follows the connect long before the idle interval would", () => arrivals.length >= 2, 5_000);
  assert.ok(Date.parse(snapshotOf(worker).generated_at) >= connectedAt - 1_000, "the client reads a snapshot projected for its connect");
  await until("the active interval resumes: two more passes inside the idle interval", () => arrivals.length >= 4, 5_000);
  assert.equal(BOARD_PROJECTION_INTERVAL_MS, 3_000, "the production active interval stays 3 s");
});

test("W1-T11935 criterion 2: the thread pacer re-paces on each presence change and projects at once for an old snapshot", () => {
  const ticks: string[] = [];
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
  const pace = paceBoardProjection(() => ticks.push("tick"), 3_000, {
    setInterval: (run, ms) => { const timer = { run, ms, cleared: false }; timers.push(timer); return timer; },
    clearInterval: (timer) => { (timer as { cleared: boolean }).cleared = true; },
  });
  assert.deepEqual([ticks.length, timers.map((x) => x.ms)], [1, [3_000]], "one pass at once, then the active interval");
  pace({ kind: "pace", intervalMs: 15_000, projectNow: false });
  assert.deepEqual([ticks.length, timers.map((x) => [x.ms, x.cleared])], [1, [[3_000, true], [15_000, false]]], "idle re-paces without a pass");
  pace({ kind: "pace", intervalMs: 3_000, projectNow: true });
  assert.deepEqual([ticks.length, timers.map((x) => [x.ms, x.cleared])], [2, [[3_000, true], [15_000, true], [3_000, false]]],
    "a connect to an old snapshot projects at once and returns to the active interval");
  // A handle that was never started has no thread to tell; presence still decides the interval it starts on.
  const unstarted = createBoardProjectionWorker(boardFacts(), { planPath: "/nonexistent/plan.yaml", ledgerPath: "/nonexistent/ledger", inflightDir: "/nonexistent" });
  unstarted.setClientPresence(false);
  unstarted.setClientPresence(false);
  unstarted.setClientPresence(true);
  assert.equal(unstarted.current().state, "unavailable");
});

test("W1-T11935 criterion 3: the idle interval is a declared constant with a BACKSTOP comment, and the board snapshot content is unchanged", async (t) => {
  assert.ok(BOARD_PROJECTION_IDLE_INTERVAL_MS >= 15_000 && BOARD_PROJECTION_IDLE_INTERVAL_MS <= 30_000, `idle interval ${BOARD_PROJECTION_IDLE_INTERVAL_MS} ms`);
  assert.ok(BOARD_PROJECTION_IDLE_INTERVAL_MS < BOARD_PROJECTION_STALE_MS, "an idle snapshot is never reported projection_stale for its age alone");
  const source = readFileSync(join(REPO_ROOT, "src", "lib", "board-worker.ts"), "utf8");
  const declaration = source.indexOf("export const BOARD_PROJECTION_IDLE_INTERVAL_MS =");
  assert.ok(declaration > 0, "declared as an exported constant");
  const comment = source.slice(source.lastIndexOf("/**", declaration), declaration);
  assert.match(comment, /^\/\*\*\s*\n?\s*\*?\s*BACKSTOP:/, "its own doc comment opens with BACKSTOP");

  const { worker, input } = countedWorker(t, { intervalMs: 60_000, idleIntervalMs: 60_000 });
  worker.setClientPresence(false);
  worker.start();
  await until("the idle thread publishes a snapshot", () => worker.isReady());
  const idle = { ...snapshotOf(worker), generated_at: "" };
  const inProcess = { ...boardWorkerPass(input, boardFacts(), createBoardSnapshotCache()), generated_at: "" };
  assert.deepEqual(idle, inProcess, "the idle pass projects the same board the in-process pass does");
});
