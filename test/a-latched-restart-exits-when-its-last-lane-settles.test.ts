import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { runDaemon } from "../src/lib/daemon.js";
import { DEPLOY_RESTART_SCORE_THRESHOLD, FRESHNESS_COALESCE_WINDOW_MS } from "../src/lib/deploy-judge.js";
import { loadPlan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const windowMs = FRESHNESS_COALESCE_WINDOW_MS.value;
// W1-T9089: the daemon's own code weighs the source floor of 1, so the advance carries the threshold's worth of commits.
const stale = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: Array.from({ length: DEPLOY_RESTART_SCORE_THRESHOLD.value }, (_, index) => ({
    sha: index === 0 ? "b".repeat(40) : String(index).padStart(40, "e"), subject: "fix: refresh", files: ["src/lib/daemon.ts"],
  })) };
const result: RunResult = { taskId: "A", runId: "fixture", merged: true, verdict: "merged", costUsd: 0 };
type PassMode = "completed" | "running" | "failed" | "boot-running" | "running-after-completed";

async function phase(t: TestContext, mode: PassMode = "completed", sweepWallClockBoundMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t8170-"));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, "- id: A\n  title: A\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n");
  const lane = deferred<RunResult>();
  const pass = deferred<void>();
  const abandoned = deferred<void>();
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const calls: Array<{ atMs: number; afterSettled: boolean }> = [];
  const epoch = Date.now();
  let nowMs = epoch;
  let isStale = false;
  let cleaning = false;
  let finished = false;
  let started = false;
  const run = runDaemon(loadPlan(path), {
    now: () => new Date(nowMs),
    checkFreshness: () => isStale ? stale : { stale: false },
    checkStop: () => cleaning ? "cleanup" : undefined,
    refreshMerged: () => () => false,
    runOne: () => { started = true; return lane.promise; },
    sweep: async () => {
      calls.push({ atMs: nowMs, afterSettled: rows.some(({ step }) => step === "dispatch.settled_set") });
      if ((calls.length === 1 && mode === "boot-running") || (calls.length === 2 && mode === "running") ||
        (calls.length === 3 && mode === "running-after-completed")) await pass.promise;
      if (calls.length === 2 && mode === "failed") throw new Error("fixture pass failed");
    },
    sleep: () => { const wait = deferred<void>(); sleeps.push(wait); return wait.promise; },
    log: (step, extra) => {
      rows.push({ step, extra });
      if (step === "daemon.sweep.abandoned") abandoned.resolve();
    },
  }, { freshnessMinLifetimeMs: 0, laneCount: 1, max: 1, sweepRetriggerIntervalMs: 2 * windowMs, sweepWallClockBoundMs });
  void run.then(() => { finished = true; });
  t.after(async () => {
    cleaning = true;
    lane.resolve(result);
    pass.resolve();
    for (const wait of sleeps.splice(0)) wait.resolve();
    await run;
    rmSync(root, { recursive: true, force: true });
  });
  const tick = async (ageMs: number) => {
    nowMs = epoch + ageMs;
    for (const wait of sleeps.splice(0)) wait.resolve();
    await flush();
    await flush();
  };
  await flush();
  await flush();
  assert.equal(started, true, "the real daemon entered dispatch");
  assert.equal(calls.length, 1, "boot already ran a full pass");
  isStale = true;
  await tick(1);
  await tick(windowMs + 1);
  assert.ok(rows.some(({ step, extra }) => step === "daemon.freshness_decision" && extra?.action === "restart"),
    "the dispatch ticker latched a restart before any later pass");
  return {
    run, rows, calls, tick, pass, abandoned,
    finished: () => finished,
    settle: async () => {
      nowMs++;
      lane.resolve(result);
      await flush();
      await flush();
      assert.ok(rows.some(({ step }) => step === "dispatch.settled_set"));
    },
    restart: () => rows.find(({ step }) => step === "daemon_selfrestart_for_freshness")?.extra,
  };
}

test("W1-T8170: a pass since the latch is not repeated at exit", async (t) => {
  const h = await phase(t);
  await h.tick(2 * windowMs + 2);
  assert.equal(h.calls.length, 2, "the dispatch wait ran a full pass after the latch");
  await h.settle();
  assert.equal((await h.run).stopReason, "stale");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls.some(({ afterSettled }) => afterSettled), false);
  assert.equal(h.restart()?.pre_exit_pass, "skipped_ran_since_latch");
});

test("W1-T8170: an exit with no pass since the latch still runs one", async (t) => {
  const h = await phase(t);
  await h.settle();
  assert.equal((await h.run).stopReason, "stale");
  assert.equal(h.calls.length, 2, "a pass before the latch does not replace the exit pass");
  assert.equal(h.calls[1].afterSettled, true);
  assert.equal(h.restart()?.pre_exit_pass, "ran");
});

test("W1-T8170: a running background pass is awaited at exit", async (t) => {
  const h = await phase(t, "running");
  await h.tick(2 * windowMs + 2);
  assert.equal(h.calls.length, 2);
  await h.settle();
  assert.equal(h.finished(), false, "the daemon cannot exit while the background pass is running");
  assert.equal(h.restart(), undefined);
  h.pass.resolve();
  assert.equal((await h.run).stopReason, "stale");
  assert.equal(h.calls.length, 2, "awaiting the running pass starts no replacement");
  assert.equal(h.restart()?.pre_exit_pass, "awaited_in_flight");
});

test("W1-T8170: the restart row names its pre-exit pass", async (t) => {
  for (const arm of ["ran", "skipped_ran_since_latch", "awaited_in_flight"]) {
    const h = await phase(t, arm === "awaited_in_flight" ? "running" : "completed");
    if (arm !== "ran") await h.tick(2 * windowMs + 2);
    await h.settle();
    h.pass.resolve();
    await h.run;
    assert.deepEqual(h.restart(), { old_sha: stale.oldSha, new_sha: stale.newSha, pre_exit_pass: arm });
  }
});

test("a failed background pass since the latch still requires the exit pass", async (t) => {
  const h = await phase(t, "failed");
  await h.tick(2 * windowMs + 2);
  assert.ok(h.rows.some(({ step, extra }) => step === "daemon.sweep.failed" && extra?.error === "fixture pass failed"));
  await h.settle();
  assert.equal((await h.run).stopReason, "stale");
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].afterSettled, true);
  assert.equal(h.restart()?.pre_exit_pass, "ran");
});

test("completion after the latch counts even when the full pass began before it", async (t) => {
  const h = await phase(t, "boot-running");
  await h.tick(2 * windowMs + 2);
  h.pass.resolve();
  await flush();
  await h.settle();
  assert.equal((await h.run).stopReason, "stale");
  assert.equal(h.calls.length, 1);
  assert.equal(h.restart()?.pre_exit_pass, "skipped_ran_since_latch");
});

test("a running pass takes precedence over a previously completed pass since the latch", async (t) => {
  const h = await phase(t, "running-after-completed");
  await h.tick(2 * windowMs + 2);
  await h.tick(4 * windowMs + 3);
  assert.equal(h.calls.length, 3);
  await h.settle();
  assert.equal(h.finished(), false);
  assert.equal(h.restart(), undefined);
  h.pass.resolve();
  assert.equal((await h.run).stopReason, "stale");
  assert.equal(h.calls.length, 3);
  assert.equal(h.restart()?.pre_exit_pass, "awaited_in_flight");
});

test("a full pass completing after its wait bound still counts at exit", async (t) => {
  const h = await phase(t, "running", 20);
  await h.tick(2 * windowMs + 2);
  await h.abandoned.promise;
  await flush();
  h.pass.resolve();
  await flush();
  await h.settle();
  assert.equal((await h.run).stopReason, "stale");
  assert.equal(h.calls.length, 2);
  assert.equal(h.restart()?.pre_exit_pass, "skipped_ran_since_latch");
});

async function idleExit(t: TestContext, reviewerCodeStale = false) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t8170-idle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, "[]\n");
  let nowMs = Date.now();
  let calls = 0;
  let callsAtRestartRequest: number | undefined;
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const summary = await runDaemon(loadPlan(path), {
    now: () => new Date(nowMs),
    checkFreshness: () => reviewerCodeStale ? { stale: false } : stale,
    refreshMerged: () => () => true,
    runOne: async () => { assert.fail("an empty plan cannot dispatch"); },
    sweep: async () => {
      calls++;
      return reviewerCodeStale ? { reviewerCodeStale: { oldSha: stale.oldSha, newSha: stale.newSha } } : undefined;
    },
    sleep: async () => { nowMs += windowMs; },
    log: (step, extra) => {
      rows.push({ step, extra });
      if (step === "review.stale_reviewer_restart_requested") callsAtRestartRequest = calls;
    },
  }, { freshnessMinLifetimeMs: 0 });
  assert.equal(summary.stopReason, "stale");
  assert.equal(rows.find(({ step }) => step === "daemon_selfrestart_for_freshness")?.extra?.pre_exit_pass, "ran");
  return { calls, callsAtRestartRequest };
}

test("an idle freshness exit keeps its full pass without a dispatch latch", async (t) => {
  const { calls } = await idleExit(t);
  assert.equal(calls, 2, "the boot pass cannot replace an idle exit's pass");
});

test("a reviewer-idle freshness exit keeps its full pass without a dispatch latch", async (t) => {
  const { calls, callsAtRestartRequest } = await idleExit(t, true);
  assert.ok(callsAtRestartRequest !== undefined, "the full sweep requested the reviewer freshness restart");
  assert.equal(calls, callsAtRestartRequest + 1, "the reviewer-idle exit still runs its own full pass");
});
