// W1-T11327 — A REQUESTED RESTART EXITS IN THE CONTAINER AND KEEPS ITS CHILDREN.
//
// OBSERVED 2026-11-04: three recycles (12:26Z, 13:04Z and 14:36Z) paused the fleet for about 2.5 h and replaced
// nothing, while the daemon they were meant to replace was still writing rows. Its run children are adopted by the
// next boot (W1-T9086), so a stalled daemon whose loop is alive needs no drain: a `state/RESTART_REQUESTED` marker asks
// it to leave through its own freshness exit (DAEMON_EXIT_STALE, which deploy/entrypoint.sh restarts in place).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";

import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { consumeRestartInPlace, peekRestartInPlace, requestRestartInPlace, restartInPlaceFilePath } from "#src/lib/fleet-control.js";
import { loadPlan } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const scratch: string[] = [];
const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t11327-${label}-`));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const result = (id: string): RunResult => ({ taskId: id, runId: id, merged: false, verdict: "no_pr", costUsd: 0 });
const SHA = "c".repeat(40);

function planOf(root: string, ids: string[]) {
  const path = join(root, "tasks.yaml");
  writeFileSync(path, ids.map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  return loadPlan(path);
}

/** A one-shot request the test arms; `consumed` counts the daemon's reads of it. */
function requestSeam(now: () => number) {
  const state = { armed: undefined as { origin: string; requestedAt: string; codeSha: string } | undefined, reads: 0 };
  return {
    state,
    arm(origin = "progress-watchdog", atMs = now()) { state.armed = { origin, requestedAt: new Date(atMs).toISOString(), codeSha: SHA }; },
    consume: () => { state.reads++; const req = state.armed ?? null; state.armed = undefined; return req; },
  };
}

test("W1-T11327 criterion 1: a restart request on the dispatch tick exits stale and leaves its children running", async () => {
  const root = tmp("children");
  const rows: Array<Record<string, unknown>> = [];
  const settles = new Map(["A", "B"].map((id) => [id, deferred<RunResult>()]));
  let started = 0;
  let now = Date.now();
  let stop = false;
  const request = requestSeam(() => now);
  const run = runDaemon(planOf(root, ["A", "B"]), {
    refreshMerged: () => () => false,
    checkStop: () => stop ? "cleanup" : undefined,
    checkFreshness: () => ({ stale: false }),
    consumeRestartRequest: request.consume,
    now: () => new Date(now),
    sleep: async () => { now += 60_000; await delay(1); },
    runOne: (id, options) => {
      started++;
      const settled = settles.get(id)!.promise;
      options!.onChild!({ started: true, runId: id, dir: root, pid: process.pid, settled,
        abort: async () => { throw new Error("a requested restart never aborts a child"); } });
      return settled;
    },
    log: (step, extra) => { rows.push({ step, ...extra }); },
  }, { laneCount: 2, pollIntervalMs: 5 });
  try {
    for (let i = 0; i < 1000 && started < 2; i++) await delay(2);
    assert.equal(started, 2, "both runs started as children");
    request.arm();
    // Bounded: a request the tick never reads would otherwise wait on children that never settle.
    const summary = await Promise.race([run, delay(10_000).then(() => undefined)]);
    assert.ok(summary, "the daemon exits while both children are still running");
    assert.equal(summary.stopReason, "stale", "the requested restart leaves through the freshness exit");
    assert.match(summary.stopDetail ?? "", /restart in place requested by progress-watchdog/);
    const consumed = rows.filter((r) => r.step === "daemon.restart_request_consumed");
    assert.equal(consumed.length, 1, "the request is consumed once");
    assert.equal(consumed[0].origin, "progress-watchdog");
    assert.equal(consumed[0].at, "dispatch_tick");
    const exit = rows.find((r) => r.step === "daemon.freshness_exit");
    assert.deepEqual(exit?.children_left_running, ["A", "B"], "the children run on for the next boot to adopt");
    assert.equal((exit?.restart_request as Record<string, unknown>)?.origin, "progress-watchdog");
    assert.equal(typeof (exit?.restart_request as Record<string, unknown>)?.request_to_exit_ms, "number");
    for (const step of ["daemon.freshness_coalesced", "daemon.freshness_decision", "daemon.freshness_deferred"]) {
      assert.equal(rows.some((r) => r.step === step), false, `${step}: no coalescing or minimum-lifetime hold`);
    }
  } finally {
    stop = true;
    for (const [id, settle] of settles) settle.resolve(result(id));
    await run;
  }
});

test("W1-T11327 criterion 1: a restart request at the top of a cycle exits stale", async () => {
  const root = tmp("cycle-top");
  const rows: Array<Record<string, unknown>> = [];
  let now = Date.now();
  let sleeps = 0;
  const request = requestSeam(() => now);
  const summary = await runDaemon(planOf(root, ["A"]), {
    refreshMerged: () => (id) => id === "A",
    checkStop: () => sleeps > 20 ? "cleanup" : undefined,
    checkFreshness: () => ({ stale: false }),
    consumeRestartRequest: request.consume,
    now: () => new Date(now),
    sleep: async () => { sleeps++; now += 60_000; if (sleeps === 2) request.arm("operator"); await delay(1); },
    runOne: async (id) => result(id),
    log: (step, extra) => { rows.push({ step, ...extra }); },
  }, { pollIntervalMs: 5 });
  assert.equal(summary.stopReason, "stale", JSON.stringify(summary));
  assert.match(summary.stopDetail ?? "", /restart in place requested by operator/);
  assert.equal(rows.find((r) => r.step === "daemon.restart_request_consumed")?.at, "cycle_top");
  assert.deepEqual(rows.find((r) => r.step === "daemon.freshness_exit")?.children_left_running, []);
});

test("W1-T11327 criterion 1: an in-process lane is awaited before a requested restart exits", async () => {
  const root = tmp("in-process");
  const lane = deferred<RunResult>();
  let started = 0;
  let now = Date.now();
  let settledFirst = false;
  const request = requestSeam(() => now);
  const run = runDaemon(planOf(root, ["A"]), {
    refreshMerged: () => () => false,
    checkFreshness: () => ({ stale: false }),
    consumeRestartRequest: request.consume,
    now: () => new Date(now),
    sleep: async () => { now += 60_000; await delay(1); },
    runOne: () => { started++; return lane.promise.then((r) => { settledFirst = true; return r; }); },
    log: () => {},
  }, { laneCount: 2, pollIntervalMs: 5 });
  for (let i = 0; i < 1000 && started < 1; i++) await delay(2);
  request.arm();
  for (let i = 0; i < 1000 && request.state.reads === 0; i++) await delay(2);
  await delay(30);
  let done = false;
  void run.then(() => { done = true; });
  await delay(30);
  assert.equal(done, false, "the exit waits for the in-process lane");
  lane.resolve(result("A"));
  const summary = await run;
  assert.equal(settledFirst, true);
  assert.equal(summary.stopReason, "stale");
});

test("W1-T11327 criterion 1: STOP and PAUSE outrank a restart request", async () => {
  const root = tmp("holds");
  let now = Date.now();
  let sleeps = 0;
  const request = requestSeam(() => now);
  request.arm();
  const deps: DaemonDeps = {
    refreshMerged: () => (id) => id === "A",
    checkPause: () => sleeps < 5 ? "operator hold" : undefined,
    checkStop: () => sleeps >= 5 ? "cleanup" : undefined,
    checkFreshness: () => ({ stale: false }),
    consumeRestartRequest: request.consume,
    now: () => new Date(now),
    sleep: async () => { sleeps++; now += 60_000; await delay(1); },
    runOne: async (id) => result(id),
    log: () => {},
  };
  const summary = await runDaemon(planOf(root, ["A"]), deps, { pollIntervalMs: 5 });
  assert.equal(summary.stopReason, "stopped", "STOP wins");
  assert.equal(request.state.reads, 0, "a held daemon never reads the request");
  assert.notEqual(request.state.armed, undefined, "the request is left for the daemon that is not held");
});

test("W1-T11327 criterion 1: a request written before this process booted is answered by the boot", async () => {
  const root = tmp("pre-boot");
  const rows: Array<Record<string, unknown>> = [];
  let now = Date.now();
  let sleeps = 0;
  const request = requestSeam(() => now);
  request.arm("progress-watchdog", now - 120_000);
  const summary = await runDaemon(planOf(root, ["A"]), {
    refreshMerged: () => (id) => id === "A",
    checkStop: () => sleeps >= 3 ? "cleanup" : undefined,
    checkFreshness: () => ({ stale: false }),
    consumeRestartRequest: request.consume,
    now: () => new Date(now),
    sleep: async () => { sleeps++; now += 60_000; await delay(1); },
    runOne: async (id) => result(id),
    log: (step, extra) => { rows.push({ step, ...extra }); },
  }, { pollIntervalMs: 5 });
  assert.equal(summary.stopReason, "stopped", "the boot already answered it");
  const consumed = rows.find((r) => r.step === "daemon.restart_request_consumed");
  assert.equal(consumed?.answered_by_boot, true, JSON.stringify(consumed));
});

test("W1-T11327 criterion 1: the marker is read once, a peek leaves it, and a garbage marker is deleted unread", () => {
  const root = tmp("marker");
  assert.equal(consumeRestartInPlace(root), null, "no marker reads as no request");
  const req = requestRestartInPlace(root, "progress-watchdog");
  assert.match(restartInPlaceFilePath(root), /state[/\\]RESTART_REQUESTED$/);
  assert.deepEqual(peekRestartInPlace(root), req, "a peek reads the request");
  assert.equal(existsSync(restartInPlaceFilePath(root)), true, "and leaves it");
  assert.deepEqual(consumeRestartInPlace(root), req);
  assert.equal(consumeRestartInPlace(root), null, "consumed once");

  for (const garbage of ["{not json", JSON.stringify({ origin: 7 }), JSON.stringify({ origin: "x", requestedAt: "not a time" })]) {
    writeFileSync(restartInPlaceFilePath(root), garbage);
    assert.equal(peekRestartInPlace(root), null, `a peek never reads garbage: ${garbage}`);
    assert.equal(consumeRestartInPlace(root), null, `garbage is never acted on: ${garbage}`);
    assert.equal(existsSync(restartInPlaceFilePath(root)), false, "and is deleted");
  }
});
