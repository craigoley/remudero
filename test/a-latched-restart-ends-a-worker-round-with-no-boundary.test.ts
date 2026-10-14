// W1-T8139: #10925 lets a pending container recycle end an implement round mid-worker on the end_round checkpoint path.
// The daemon's own freshness restart latch was not wired to it, so a latched restart waited for the first implement
// worker to return, for as long as that worker ran. These tests drive watchDispatchSpawn over the REAL quiet-worker
// watchdog with injected seams: a latched restart and no recycle PAUSE, an implement worker mid-stream.

import assert from "node:assert/strict";
import { test } from "node:test";
import { clockFromMillisFn } from "../src/lib/clock.js";
import {
  QuietRoundEndedError,
  RECYCLE_YIELD_LEDGER_STEP,
  runQuietWorkerWatchdog,
  type QuietWatchdogHandle,
  type QuietWatchdogOptions,
} from "../src/lib/quiet-worker-watchdog.js";
import { pendingWorkerBoundaryHandoffs } from "../src/lib/daemon.js";
import { restartLatchDetail, roundEndedHandoffRows, watchDispatchSpawn } from "../src/run-task.js";

const SHA = "e".repeat(40);
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const RECYCLE = "PAUSE requested: container recycle (deploy/recycle-container.sh)";

interface Rig {
  rows: Array<{ step: string; fields: Record<string, unknown> }>;
  commits: string[];
  pushes: number;
  spawn: ReturnType<typeof watchDispatchSpawn>;
  handle: () => QuietWatchdogHandle;
}

/** A dispatch spawn over a real watchdog; the raw worker speaks, lets the watchdog poll once, then waits for an abort. */
function rig(opts: { restart?: () => string | undefined; recycle?: () => string | undefined; workerClass?: string; refuse?: boolean }): Rig {
  const out: Rig = { rows: [], commits: [], pushes: 0, spawn: undefined as never, handle: undefined as never };
  const clock = { ms: 0 };
  let handle: QuietWatchdogHandle | undefined;
  out.handle = () => handle as QuietWatchdogHandle;
  const raw = (async (args: { signal?: AbortSignal; streamObserver?: (e: unknown) => void }) => {
    args.streamObserver?.({ kind: "working", tsMs: 0 });
    clock.ms = 1_000;
    await handle?.tick();
    if (args.signal?.aborted) throw new Error("The operation was aborted");
    return "raw-finished";
  }) as never;
  out.spawn = watchDispatchSpawn(raw, {
    enabled: true, taskId: "W1-T8139", runId: "W1-T8139-1", ledgerPath: "/state/ledger.ndjson", fallbackBoundMs: 60_000,
    spawnArgs: { cwd: "/wt", settingsFile: "/wt/settings.json", ...(opts.workerClass ? { workerClass: opts.workerClass } : {}) } as never,
    task: { files: ["src/a.ts"], acceptance: [] } as never,
    provider: () => "claude",
    log: (step, fields) => out.rows.push({ step, fields }),
    ...(opts.recycle ? { recyclePending: opts.recycle } : {}),
    ...(opts.restart ? { restartPending: opts.restart } : {}),
  }, {
    runWatchdog: ((options: QuietWatchdogOptions) => {
      handle = runQuietWorkerWatchdog({ ...options, clock: clockFromMillisFn(() => clock.ms), listProcesses: () => [], quietFloorMs: 30_000 });
      return { ...handle, start: () => () => {} };
    }) as never,
    hasUncommittedChanges: (() => true) as never,
    commit: ((_cwd: string, _files: readonly string[], message: string) => { out.commits.push(message); return opts.refuse ? { committed: false, undeclared: ["x.ts"], reason: "markers" } : { committed: true, undeclared: [] }; }) as never,
    push: (async () => { out.pushes += 1; }) as never,
    headSha: () => SHA,
  });
  return out;
}

test("W1-T8139: a latched restart ends an implement round mid-worker", async () => {
  const latch = restartLatchDetail(() => ({ stale: true, oldSha: OLD, newSha: NEW }));
  const r = rig({ restart: latch });
  await assert.rejects(r.spawn({} as never), (error) => {
    assert.ok(error instanceof QuietRoundEndedError);
    assert.equal(error.detail.trigger, "restart");
    assert.equal(error.detail.checkpointSha, SHA);
    assert.match(error.detail.reason, /^restart pending: daemon restart latched: aaaaaaaaa\.\.bbbbbbbbb$/);
    assert.match(error.message, /for a latched daemon restart/);
    return true;
  });
  assert.equal(r.pushes, 1, "the checkpoint is pushed before the lane is released");
  assert.match(r.commits[0], /^chore\(checkpoint\): yield at daemon restart\n/);
  assert.match(r.commits[0], /Remudero-Task: W1-T8139/);
  const yielded = r.rows.find((row) => row.step === RECYCLE_YIELD_LEDGER_STEP);
  assert.equal(yielded?.fields.decision, "acted");
  assert.equal(yielded?.fields.trigger, "restart");
  assert.equal(yielded?.fields.checkpoint_sha, SHA);

  // Only implement workers end a round: a fix-rung worker is left running and the attempt is ledgered as failed.
  const fix = rig({ restart: latch, workerClass: "fix" });
  assert.equal(await fix.spawn({} as never), "raw-finished");
  assert.equal(fix.commits.length, 0);
  assert.equal(fix.rows.find((row) => row.step === RECYCLE_YIELD_LEDGER_STEP)?.fields.decision, "action_failed");

  // A refused checkpoint is ledgered action_failed and the worker keeps running to its next boundary.
  const refused = rig({ restart: latch, refuse: true });
  assert.equal(await refused.spawn({} as never), "raw-finished");
  assert.equal(refused.pushes, 0);
  const failed = refused.rows.find((row) => row.step === RECYCLE_YIELD_LEDGER_STEP);
  assert.equal(failed?.fields.decision, "action_failed");
  assert.match(String(failed?.fields.detail), /checkpoint refused: markers/);
});

test("W1-T8139: a restart round end writes a worker_round receipt", () => {
  const branch = "run-W1-T8139-1791786567586";
  const rows = roundEndedHandoffRows({ checkpointSha: SHA, reason: "restart pending: x", trigger: "restart" }, branch);
  assert.deepEqual(rows.map((r) => r.step), ["run.freshness_handoff", "verdict"]);
  assert.equal(rows[0].fields.waiting_on, "worker_round");
  assert.equal(rows[0].fields.trigger, "restart");
  assert.equal(rows[1].fields.reason, "freshness_yield");
  const lines = rows.map((r) => JSON.stringify({ ts: "2026-10-12T00:00:00.000Z", task_id: "W1-T8139", step: r.step, ...r.fields }));
  assert.deepEqual(pendingWorkerBoundaryHandoffs(lines).get("W1-T8139"), { branch, headSha: SHA }, "the next run restores this checkpoint");
});

test("W1-T8139: no latch and no recycle leaves the round running", async () => {
  for (const r of [
    rig({ restart: restartLatchDetail(() => undefined) }),
    rig({ restart: restartLatchDetail(() => undefined), recycle: () => undefined }),
    rig({}),
  ]) {
    assert.equal(await r.spawn({} as never), "raw-finished");
    assert.equal(r.commits.length, 0);
    assert.equal(r.pushes, 0);
    assert.equal(r.rows.some((row) => row.step === RECYCLE_YIELD_LEDGER_STEP), false);
  }
  assert.equal(restartLatchDetail(undefined), undefined, "a manual run has no latch to read");

  // A pending recycle still wins and keeps its own trigger.
  const both = rig({ recycle: () => RECYCLE, restart: restartLatchDetail(() => ({ stale: true, oldSha: OLD, newSha: NEW })) });
  await assert.rejects(both.spawn({} as never), (error) => error instanceof QuietRoundEndedError && error.detail.trigger === "recycle");
});

test("W1-T8139: the pending-yield read never calls the freshness fetch", async () => {
  // The watchdog is handed ONLY the in-process latch predicate (restartLatchDetail over restartAtWorkerBoundary); the
  // fetching externalWaitFreshness is not reachable from watchDispatchSpawn at all, so a poll cannot call it.
  let latchReads = 0;
  const r = rig({ restart: restartLatchDetail(() => { latchReads += 1; return undefined; }) });
  await r.spawn({} as never);
  for (let i = 0; i < 5; i++) await r.handle().tick();
  assert.ok(latchReads >= 6, `every poll reads the in-process latch (${latchReads})`);
});
