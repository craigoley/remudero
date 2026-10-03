// test/the-daemon-loop-lag-stays-bounded-through-a-cadence-phase.test.ts — W1-T5481.
//
// The REAL `runDaemon` cadence phase, with the REAL board-review hooks (`buildBoardReviewDaemonHooks`)
// wired the way `daemonCommand` wires them, over a SLOW board: 20 open PRs, so 41 reads. The same
// work has two faces here — the async reader production prefetches through, and a synchronous
// `fetchOpenPrs` that holds the thread for SYNC_READ_MS, standing for 41 `ghJson` spawns. The loop's
// lag is measured with `perf_hooks.monitorEventLoopDelay` across the whole phase.
//
// MEASURED 2026-10-03: `daemon.loop_lag` p50 53 s and max 429 s over 104 rows (16:00Z-19:17Z), and the
// board-review check alone took 29.7-98.0 s of every cadence phase (W1-T4041's lag reading; the
// sibling suite names the attribution).
//
// The control runs the same phase without the prefetch wired: the check then takes the synchronous
// face, and the probe must see a stall of about SYNC_READ_MS. Without it, a quiet probe proves nothing.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { test } from "node:test";
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

/** The synchronous face of the same work: the thread is held, as 41 `ghJson` spawns hold it. */
function syncRead(): OpenPrRest[] {
  const end = performance.now() + SYNC_READ_MS;
  while (performance.now() < end) {
    // spinning: this is the stall the daemon used to take on every tick
  }
  return [];
}

/** One daemon run that stops after its first board-review row; resolves the worst loop delay in ms. */
async function cadencePhaseLag(wirePrefetch: boolean): Promise<{ maxLagMs: number; steps: string[] }> {
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
  const probe = monitorEventLoopDelay({ resolution: 10 });
  probe.enable();
  try {
    // Its first tick only sets a baseline, so a stall before that tick would go unmeasured: warm it up.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runDaemon(loadPlan(planPath), deps);
    // The histogram records only when its own timer runs: give it the turn a stall ending last would miss.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    probe.disable();
    rmSync(root, { recursive: true, force: true });
  }
  return { maxLagMs: probe.max / 1e6, steps };
}

void test("W1-T5481: a daemon cadence phase over a slow board-review read keeps the loop's lag under a declared bound", async (t) => {
  const { maxLagMs, steps } = await cadencePhaseLag(true);
  t.diagnostic(`max loop delay, read prefetched: ${maxLagMs.toFixed(0)} ms`);
  assertWallClockBound(maxLagMs, LAG_BOUND_MS, `the loop's worst delay through the cadence phase was ${maxLagMs.toFixed(0)} ms`);
  assert.ok(steps.includes("board_review.fired"), `the phase reached the board-review check (saw ${steps.join(", ")})`);
  assert.ok(steps.includes("board_review.ran"), "and the fired run completed over the prefetched board");
});

void test("W1-T5481 control: the same phase with the read left on the loop stalls it for the read's length", async (t) => {
  const { maxLagMs, steps } = await cadencePhaseLag(false);
  t.diagnostic(`max loop delay, read on the loop: ${maxLagMs.toFixed(0)} ms`);
  assert.ok(steps.includes("board_review.fired") || steps.includes("board_review.skipped"), `the phase reached the board-review check (saw ${steps.join(", ")})`);
  assert.ok(maxLagMs >= SYNC_READ_MS * 0.9, `the probe saw the synchronous read: ${maxLagMs.toFixed(0)} ms against ${SYNC_READ_MS} ms`);
});
