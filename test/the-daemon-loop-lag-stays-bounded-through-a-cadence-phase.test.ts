// test/the-daemon-loop-lag-stays-bounded-through-a-cadence-phase.test.ts — W1-T5481.
//
// The REAL `runDaemon` cadence phase, with the REAL board-review hooks (`buildBoardReviewDaemonHooks`)
// wired the way `daemonCommand` wires them, over a SLOW board: 20 open PRs, so 41 reads. The same
// work has two faces here — the async reader production prefetches through, and a synchronous
// `fetchOpenPrs` that holds the thread for SYNC_READ_MS, standing for 41 `ghJson` spawns. The loop's
// lag is measured with a 10 ms ticker stamping absolute time across the whole phase.
//
// MEASURED 2026-10-03: `daemon.loop_lag` p50 53 s and max 429 s over 104 rows (16:00Z-19:17Z), and the
// board-review check alone took 29.7-98.0 s of every cadence phase (W1-T4041's lag reading; the
// sibling suite names the attribution).
//
// The control runs the same phase without the prefetch wired: the check then takes the synchronous
// face, and the probe must see a stall of about SYNC_READ_MS. Without it, a quiet probe proves nothing.
//
// W1-T5950: the bound is on the lag the DAEMON adds, not the host's. Run beside 7 other files, the
// absolute max read 1369 ms with nothing blocking the loop. So an idle control samples the same
// window: a worker thread with the same ticker and no work, which also reads every other thread's
// runqueue wait (Linux schedstat: time runnable but given no CPU). Each main-thread stall is charged
// its span less the larger of two host shares inside it: the longest stall the idle control took (a
// stopped host holds both threads), and the longest runqueue wait of one thread (an oversubscribed
// host holds the main thread, or a loader or GC thread it waits on). A loop the daemon blocks, on CPU
// or asleep, is charged in full. The bounded value is the worst charge; stalls are aligned, not
// max-minus-max, so a host stall elsewhere in the window cannot hide a real block. Measured under
// 0.8 s SIGSTOPs beside 7 files: the old max read 804 ms (red); the idle-control overlap alone once
// failed on a 1180 ms main-only stall, and the main thread's own runqueue wait alone on a 654 ms one
// (one core beside 8 spinners) — hence every thread's.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import * as runTask from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { OpenPrRest } from "../src/lib/open-prs-rest.js";
import type { Policy } from "../src/lib/policy.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const NOW = new Date("2026-10-03T17:00:00Z");
const OPEN_PRS = 20;
/** What the synchronous face of the read holds the thread for. */
const SYNC_READ_MS = 1_200;
/** The declared bound on the loop's worst delay through the phase: half the synchronous read. */
const LAG_BOUND_MS = SYNC_READ_MS / 2;

function prRow(i: number) {
  const sha = String(i).padStart(40, "0");
  return { number: 9000 + i, html_url: `https://github.com/o/r/pull/${9000 + i}`, updated_at: NOW.toISOString(), created_at: "2026-10-03T03:00:00Z", head: { ref: `run-${i}`, sha } };
}

/** The async face: every `gh api` answer lands 10 ms later, the loop free in between. */
async function asyncRead(args: string[]): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  const path = args[1]!;
  if (path.includes("/pulls?")) return Array.from({ length: OPEN_PRS }, (_, i) => prRow(i));
  return path.endsWith("/status") ? { statuses: [] } : { check_runs: [] };
}

/** The synchronous face of the same work: the thread is held, as 41 `ghJson` spawns hold it. It spins
 *  for SYNC_READ_MS of the process's own CPU time, not wall time: a host stall inside a wall-clock
 *  spin is the host's share, so it would shorten the block charged to the daemon. */
function syncRead(): OpenPrRest[] {
  const start = process.cpuUsage();
  for (let used = process.cpuUsage(start); used.user + used.system < SYNC_READ_MS * 1_000; used = process.cpuUsage(start)) {
    // spinning: this is the stall the daemon used to take on every tick
  }
  return [];
}

/** Both threads' probe period. A tick that runs late marks its thread held from when it was due. */
const TICK_MS = 10;

/** One thread's probe: stamps absolute time every TICK_MS; `stop` returns the stamps. */
function startTicker(): () => number[] {
  const stamps: number[] = [];
  const stamp = () => void stamps.push(performance.timeOrigin + performance.now());
  stamp();
  const ticker = setInterval(stamp, TICK_MS);
  return () => {
    clearInterval(ticker);
    stamp();
    return stamps;
  };
}

/** The idle control's thread: the main thread's ticker over an event loop with no work, plus the
 *  cumulative runqueue wait in ms of every OTHER thread in the process at every stamp, by tid — the
 *  main thread and the loader and GC threads it can block on. A host without schedstat records none,
 *  which leaves the idle-control overlap as the only host share. */
const IDLE_CONTROL_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { existsSync, readdirSync, readFileSync, readlinkSync } = require("node:fs");
const tasks = "/proc/" + process.pid + "/task";
const readable = existsSync(tasks + "/" + process.pid + "/schedstat");
const self = readable ? readlinkSync("/proc/thread-self").split("/").pop() : "";
const stamps = [];
const runqueueWaitMs = [];
const stamp = () => {
  stamps.push(performance.timeOrigin + performance.now());
  const waits = {};
  for (const tid of readable ? readdirSync(tasks) : []) {
    if (tid === self) continue;
    try {
      waits[tid] = Number(readFileSync(tasks + "/" + tid + "/schedstat", "utf8").split(" ")[1]) / 1e6;
    } catch {
      // The thread exited after the listing: it is absent from this sample, so it is credited no wait.
    }
  }
  runqueueWaitMs.push(waits);
};
stamp();
const ticker = setInterval(stamp, ${TICK_MS});
parentPort.once("message", () => { clearInterval(ticker); stamp(); parentPort.postMessage({ stamps, runqueueWaitMs }); });
setTimeout(() => parentPort.postMessage("sampling"), 50);
`;

interface IdleControl {
  stamps: number[];
  runqueueWaitMs: Array<Record<string, number>>;
}

/** Start the idle control; resolves once it samples, with a `stop` that resolves its samples. */
async function startIdleControl(): Promise<{ stop: () => Promise<IdleControl> }> {
  const worker = new Worker(IDLE_CONTROL_SOURCE, { eval: true });
  const replies: Array<(value: unknown) => void> = [];
  worker.on("message", (value: unknown) => replies.shift()?.(value));
  const reply = () => new Promise((resolve, reject) => { replies.push(resolve); worker.once("error", reject); });
  await reply();
  return {
    stop: async () => {
      const answer = reply();
      worker.postMessage("stop");
      const samples = (await answer) as IdleControl;
      await worker.terminate();
      return samples;
    },
  };
}

/** The [due, ran) intervals a ticker's thread was held past a tick. */
function stalls(stamps: number[]): Array<[number, number]> {
  const held: Array<[number, number]> = [];
  for (let i = 1; i < stamps.length; i++) {
    const due = stamps[i - 1]! + TICK_MS;
    if (stamps[i]! > due) held.push([due, stamps[i]!]);
  }
  return held;
}

/** The longest stall in ms, or 0 for none. */
const worstMs = (held: Array<[number, number]>) => Math.max(0, ...held.map(([from, to]) => to - from));

/** The longest runqueue wait any one thread took between two instants, read at the idle control's
 *  first stamp at or after each. One thread, not a sum: threads queue at once, so a sum over-credits. */
function runqueueWaitBetween(control: IdleControl, from: number, to: number): number {
  const at = (t: number) => {
    const i = control.stamps.findIndex((stamp) => stamp >= t);
    return control.runqueueWaitMs[i < 0 ? control.runqueueWaitMs.length - 1 : i]!;
  };
  const [before, after] = [at(from), at(to)];
  return Math.max(0, ...Object.keys(after).map((tid) => after[tid]! - (before[tid] ?? after[tid]!)));
}

/** The worst main-thread stall's charge: its span less the larger host share inside it — the longest
 *  idle-control stall, or the longest runqueue wait of one thread. */
function worstExcessMs(main: Array<[number, number]>, control: IdleControl): number {
  const idle = stalls(control.stamps);
  let worst = 0;
  for (const [from, to] of main) {
    const shared = Math.max(0, ...idle.map(([c, d]) => Math.min(to, d) - Math.max(from, c)));
    worst = Math.max(worst, to - from - Math.max(shared, runqueueWaitBetween(control, from, to)));
  }
  return worst;
}

/** One daemon run that stops after its first board-review row; resolves the worst loop delay in ms,
 *  the idle control's worst delay over the same window, and the worst excess of the one over the other. */
async function cadencePhaseLag(wirePrefetch: boolean): Promise<{ maxLagMs: number; idleControlLagMs: number; excessLagMs: number; steps: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t5481-lag-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "- id: W1-T5481-HOLD\n  title: nothing dispatches\n  repo: remudero\n  type: implement\n  verify: human\n  depends_on: []\n  status: queued\n");
  const hooks = runTask.buildBoardReviewDaemonHooks({
    config: { root } as unknown as Config,
    policy: { values: { boardReview: { enabled: true, minIntervalMinutes: 120, maxPerDay: 6 } } } as unknown as Policy,
    now: () => NOW,
    plan: () => ({ tasks: [], byId: new Map() }),
    projection: () => new Map(),
    reconcile: () => ({ retiredProposalIds: [], retired: [] }),
    readJson: asyncRead,
    itemsIo: { resolveOwnerRepo: () => ({ owner: "o", repo: "r" }), now: () => NOW, fetchOpenPrs: syncRead },
  }) as ReturnType<typeof runTask.buildBoardReviewDaemonHooks> & { prefetchBoardReview?: () => Promise<void> };
  const steps: string[] = [];
  const deps = {
    refreshMerged: () => () => false,
    runOne: async (taskId: string) => ({ taskId, runId: `${taskId}-run`, merged: true, costUsd: 0, verdict: "merged" }),
    sleep: async () => {},
    log: (step: string) => void steps.push(step),
    checkStop: () => (steps.some((s) => s.startsWith("board_review.")) ? "phase measured" : undefined),
    checkBoardReview: hooks.checkBoardReview,
    runBoardReview: hooks.runBoardReview,
    ...(wirePrefetch ? { prefetchBoardReview: hooks.prefetchBoardReview } : {}),
  } as DaemonDeps;
  // The idle control's window encloses the main probe's: it starts sampling first and stops last.
  const idleControl = await startIdleControl();
  const stopProbe = startTicker();
  let mainStamps: number[] = [];
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runDaemon(loadPlan(planPath), deps);
    // A stall ending last shows only at the next tick: give the probe that turn.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    mainStamps = stopProbe();
    rmSync(root, { recursive: true, force: true });
  }
  const main = stalls(mainStamps);
  const control = await idleControl.stop();
  return { maxLagMs: worstMs(main), idleControlLagMs: worstMs(stalls(control.stamps)), excessLagMs: worstExcessMs(main, control), steps };
}

void test("W1-T5481: a daemon cadence phase over a slow board-review read keeps the loop's lag under a declared bound", async (t) => {
  const { maxLagMs, idleControlLagMs, excessLagMs, steps } = await cadencePhaseLag(true);
  t.diagnostic(`max loop delay, read prefetched: ${maxLagMs.toFixed(0)} ms; idle control over the same window: ${idleControlLagMs.toFixed(0)} ms; excess ${excessLagMs.toFixed(0)} ms`);
  assertWallClockBound(
    excessLagMs,
    LAG_BOUND_MS,
    `the loop's worst delay through the cadence phase was ${maxLagMs.toFixed(0)} ms, ${excessLagMs.toFixed(0)} ms of it the daemon's once the host's share is taken out (idle control's worst: ${idleControlLagMs.toFixed(0)} ms)`,
  );
  assert.ok(steps.includes("board_review.fired"), `the phase reached the board-review check (saw ${steps.join(", ")})`);
  assert.ok(steps.includes("board_review.ran"), "and the fired run completed over the prefetched board");
});

void test("W1-T5481 control: the same phase with the read left on the loop stalls it for the read's length", async (t) => {
  const { maxLagMs, idleControlLagMs, excessLagMs, steps } = await cadencePhaseLag(false);
  t.diagnostic(`max loop delay, read on the loop: ${maxLagMs.toFixed(0)} ms; idle control over the same window: ${idleControlLagMs.toFixed(0)} ms; excess ${excessLagMs.toFixed(0)} ms`);
  assert.ok(steps.includes("board_review.fired") || steps.includes("board_review.skipped"), `the phase reached the board-review check (saw ${steps.join(", ")})`);
  assert.ok(maxLagMs >= SYNC_READ_MS * 0.9, `the probe saw the synchronous read: ${maxLagMs.toFixed(0)} ms against ${SYNC_READ_MS} ms`);
  // The idle control's thread is not the one the read holds, so a blocked loop still clears the bound.
  assert.ok(excessLagMs >= LAG_BOUND_MS, `the stall stands once the host's share is taken out: ${excessLagMs.toFixed(0)} ms (idle control's worst: ${idleControlLagMs.toFixed(0)} ms)`);
});
