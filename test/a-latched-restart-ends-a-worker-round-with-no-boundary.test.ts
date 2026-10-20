// test/a-latched-restart-ends-a-worker-round-with-no-boundary.test.ts — W1-T8139, repointed by W1-T9089 (ADR 0007 A.10).
//
// A restart latch once ended an implement round at a worker boundary and checkpointed it, so the daemon could drain the
// run inside its own process. Build runs are children a booting daemon adopts, so a pending restart reaches no round:
// only an image recycle (the PAUSE file deploy/recycle-container.sh writes) still ends one on the checkpoint path.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { clockFromMillisFn } from "#src/lib/clock.js";
import { requestPause } from "#src/lib/fleet-control.js";
import {
  QuietRoundEndedError, RECYCLE_YIELD_LEDGER_STEP, runQuietWorkerWatchdog, type QuietWatchdogOptions,
} from "#src/lib/quiet-worker-watchdog.js";
import { recyclePauseDetail } from "#src/lib/recycle-yield.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { watchDispatchSpawn } from "#src/run-task.js";

const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function rig(root: string, extraOptions: Record<string, unknown> = {}) {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const commits: string[] = [];
  const pushes: number[] = [];
  const clock = { ms: 0 };
  let tick: (() => Promise<void>) | undefined;
  const raw = (async (args: { signal?: AbortSignal; streamObserver?: (e: unknown) => void }) => {
    args.streamObserver?.({ kind: "working", tsMs: 0 });
    clock.ms = 1_000;
    await tick?.();
    if (args.signal?.aborted) throw new Error("The operation was aborted");
    return "raw-finished";
  }) as never;
  const spawn = () => watchDispatchSpawn(raw, {
    enabled: true, taskId: "W1-T9089", runId: "W1-T9089-boundary", ledgerPath: join(root, "ledger.ndjson"), fallbackBoundMs: 60_000,
    spawnArgs: { cwd: join(root, "wt"), settingsFile: join(root, "settings.json") } as never,
    task: { files: ["src/a.ts"], acceptance: [] } as never,
    provider: () => "claude",
    log: (step, fields) => rows.push({ step, fields }),
    recyclePending: () => recyclePauseDetail(root),
    ...extraOptions,
  } as never, {
    runWatchdog: ((options: QuietWatchdogOptions) => {
      const handle = runQuietWorkerWatchdog({ ...options, clock: clockFromMillisFn(() => clock.ms), listProcesses: () => [], quietFloorMs: 30_000 });
      tick = handle.tick;
      return { ...handle, start: () => () => {} };
    }) as never,
    hasUncommittedChanges: (() => true) as never,
    commit: ((_cwd: string, _files: readonly string[], message: string) => { commits.push(message); return { committed: true, undeclared: [] }; }) as never,
    push: (async () => { pushes.push(1); }) as never,
    headSha: () => "e".repeat(40),
  });
  return { rows, commits, pushes, spawn };
}

test("W1-T9089: a pending restart ends no worker round, with or without a boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9089-boundary-`));
  scratch.push(root);
  // A reader the retired latch used to consult: handed in anyway, it must reach nothing.
  const { rows, commits, pushes, spawn } = rig(root, { restartPending: () => "freshness restart latched" });
  assert.equal(await spawn()({} as never), "raw-finished");
  assert.deepEqual(commits, [], "no checkpoint commit for a restart");
  assert.deepEqual(pushes, [], "no checkpoint push for a restart");
  assert.equal(rows.some((row) => row.step === RECYCLE_YIELD_LEDGER_STEP), false, "no yield row for a restart");
});

test("W1-T9089: an image recycle still ends the round at once on the checkpoint path", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9089-boundary-`));
  scratch.push(root);
  requestPause(root, "container recycle (deploy/recycle-container.sh)");
  const { rows, commits, pushes, spawn } = rig(root);
  let ended: QuietRoundEndedError | undefined;
  await assert.rejects(spawn()({} as never), (error) => {
    assert.ok(error instanceof QuietRoundEndedError);
    ended = error;
    return true;
  });
  assert.equal(ended!.detail.trigger, "recycle");
  assert.equal(pushes.length, 1);
  assert.match(commits[0], /^chore\(checkpoint\): yield at container recycle\n/);
  assert.equal(rows.find((row) => row.step === RECYCLE_YIELD_LEDGER_STEP)?.fields.decision, "acted");
});
