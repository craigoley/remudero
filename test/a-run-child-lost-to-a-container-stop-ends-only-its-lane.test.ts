// W1-T10001 — A RUN CHILD LOST TO A CONTAINER STOP ENDS ONLY ITS LANE, AND NO CHILD SPAWNS PAST A RECYCLE HOLD. On 2026-10-17
// W1-T9757's resume child waited 29 min in memory admission, spawned under a container-recycle PAUSE, died with the container,
// and its loss closed refill for every lane until the pass ended in error. The daemon tests drive the REAL runDaemon with an
// injected runOne that rejects as a lost child does; the spawn tests drive the real spawnRunChild.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { after, test } from "node:test";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { requestPause } from "#src/lib/fleet-control.js";
import type { LearnedReservation } from "#src/lib/host-memory-learning.js";
import { loadPlan } from "#src/lib/plan.js";
import * as runChild from "#src/lib/run-child.js";
import { runDir } from "#src/lib/run-child-contract.js";
import type { RunResult } from "#src/lib/run-result.js";

const scratch: string[] = [];
const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `rmd-t10001-${label}-`));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const CONTAINER_STOP = "status names container e061cc4bb7f2@proc:267906399, this is dd9d5b7c1fc4@proc:268674953";

type Row = { step: string; fields: Record<string, unknown> };

/** Two lanes over A, B, C: A's child is lost with `lossDetail`; every other task merges when it is started. */
async function lostLane(lossDetail: string) {
  const dir = tmp("daemon");
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "ABC".split("").map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const merged = new Set<string>();
  const started: string[] = [];
  const rows: Row[] = [];
  let lostOnce = false;
  let done = false;
  let stop = false;
  const run = runDaemon(loadPlan(path), {
    now: () => new Date("2026-10-17T02:30:00Z"), refreshMerged: () => (id: string) => merged.has(id),
    checkFreshness: () => ({ stale: false }),
    checkStop: () => (stop ? "STOP requested: test over" : undefined),
    readLedgerLines: () => [],
    adoptRunChildren: () => [],
    runOne: async (id: string): Promise<RunResult> => {
      started.push(id);
      await flush();
      if (id === "A" && !lostOnce) {
        lostOnce = true;
        throw new runChild.RunChildLostError(`run child run-A-1 lost: ${lossDetail}`,
          runChildLossOf(lossDetail));
      }
      merged.add(id);
      return { taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 } as RunResult;
    },
    log: (step: string, fields?: Record<string, unknown>) => rows.push({ step, fields: fields ?? {} }),
    sleep: async () => { await flush(); },
  } as unknown as DaemonDeps, { laneCount: 2, max: 12 });
  void run.then(() => { done = true; }, () => { done = true; });
  // The pass is over once every task has run and A has been offered a second time; then the test ends the daemon.
  for (let i = 0; i < 400 && !done; i++) {
    await flush();
    if (started.length >= 4 || rows.some((row) => row.step === "daemon.summary")) stop = true;
  }
  stop = true;
  for (let i = 0; i < 50 && !done; i++) await flush();
  return { summary: done ? await run : undefined, started, rows };
}

function runChildLossOf(detail: string): ConstructorParameters<typeof runChild.RunChildLostError>[1] {
  return /status names container/.test(detail) ? "container_stop" : "lost";
}

test("W1-T10001: a child lost to a container stop ends only its lane", async () => {
  const stopped = await lostLane(CONTAINER_STOP);
  assert.ok(stopped.summary, "the pass ended");
  assert.notEqual(stopped.summary.stopReason, "error", "a container stop is not a pass-ending error");
  assert.ok(!stopped.rows.some((row) => row.step === "dispatch.lane_refill_held" && row.fields.reason === "a lane rejected"),
    "the loss never closes refill for the other lane");
  assert.equal(stopped.rows.some((row) => row.step === "daemon.lane_lost" && row.fields.task === "A" && row.fields.loss === "container_stop"), true,
    "the loss is named for its task");
  assert.deepEqual(stopped.started.filter((id) => id === "A"), ["A", "A"], "the lost task is offered again, not excluded for the pass");
  assert.ok(stopped.started.includes("B") && stopped.started.includes("C"), "the other tasks still run");

  // Control: a loss that names no outside kill keeps the crashed-run path, so the test above can tell the two apart.
  const crashed = await lostLane("the child exited (1) in state running");
  assert.equal(crashed.summary?.stopReason, "error", "an unnamed loss still ends the pass as a crashed run does");
});

class FakeChild extends EventEmitter {
  pid: number | undefined = 424_242;
  unref(): void {}
}

const SHA = "b".repeat(40);
const HASH = "a".repeat(64);
const TASKS = [{ id: "T-1", title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", status: "queued" }];

function spawnFixture(label: string) {
  const root = tmp(label);
  const state = join(root, "state");
  const engine = join(state, "engines", HASH);
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ sha: SHA, sourceHash: HASH, builtAt: Date.now() }));
  const rows: Array<Record<string, unknown> & { step: string }> = [];
  const released: string[] = [];
  const handle = {
    id: "reservation-1", workerClass: "implement", estimateMib: 1, estimateSource: "default",
    bindRoot: () => {}, releaseOccupancy: () => { released.push("reservation-1"); },
  } as unknown as LearnedReservation;
  const spawned: string[] = [];
  const children: FakeChild[] = [];
  const input = {
    taskId: "T-1", stateRoot: state, repoDir: root, root, options: { skipGitSync: false, handOffAtPrOpen: true, pairedTrialHost: "daemon" as const },
    plan: async () => ({ plan: { tasks: TASKS } }),
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
  };
  const base = {
    mainSha: async () => SHA, engine: { isCurrent: () => true }, watch: false, pollMs: 60_000, reserve: async () => handle,
    spawn: () => { spawned.push("child"); const child = new FakeChild(); children.push(child); return child as never; },
  };
  const runDirs = (): string[] => existsSync(join(state, "runs")) ? readdirSync(join(state, "runs")) : [];
  return { root, state, rows, released, spawned, children, input, base, runDirs };
}

test("W1-T10001: no child spawns past a recycle hold", async () => {
  // The hold is the one the recycle script writes; the default port reads it from the instance root.
  const held = spawnFixture("hold-default");
  requestPause(held.root, "container recycle (deploy/recycle-container.sh)");
  const withheld = await runChild.spawnRunChild(held.input, held.base);
  assert.equal(withheld.started, false);
  assert.equal(withheld.abandoned, true, "the caller treats the task as not started and never runs it in-process");
  assert.deepEqual(held.spawned, [], "no child spawns under the hold");
  assert.deepEqual(held.released, ["reservation-1"], "the admitted reservation is released");
  assert.deepEqual(held.runDirs(), [], "no run directory is left behind");
  const row = held.rows.find((r) => r.step === "run_child.spawn_withheld");
  assert.equal(row?.task_id, "T-1");
  assert.match(String(row?.hold), /PAUSE requested: container recycle/);
  assert.equal(held.rows.some((r) => r.step === "run_child.spawned"), false);

  // Control: with no hold the same reservation spawns, so the withhold above is the hold's doing.
  const clear = spawnFixture("hold-clear");
  const launched = await runChild.spawnRunChild(clear.input, clear.base);
  assert.ok(launched.started, JSON.stringify(launched));
  launched.settled.catch(() => {});
  launched.detach?.();
  assert.deepEqual(clear.spawned, ["child"]);

  // An injected hold port wins over the default and may name STOP.
  const stop = spawnFixture("hold-port");
  const viaPort = await runChild.spawnRunChild(stop.input, { ...stop.base, workerAdmissionHold: () => ({ control: "STOP", detail: "STOP requested" }) });
  assert.equal(viaPort.started, false);
  assert.deepEqual(stop.spawned, []);
  assert.match(String(stop.rows.find((r) => r.step === "run_child.spawn_withheld")?.hold), /fleet STOP hold: STOP requested/);
});

test("W1-T10001: a real child lost to a container stop rejects with its loss named", async () => {
  const fx = spawnFixture("real-loss");
  const launched = await runChild.spawnRunChild(fx.input, fx.base);
  assert.ok(launched.started, JSON.stringify(launched));
  appendFileSync(join(runDir(fx.state, launched.runId), runChild.RUN_CHILD_STDERR_FILE), CONTAINER_STOP);
  fx.children[0]!.emit("exit", null, "SIGKILL");
  const error = await launched.settled.then(() => undefined, (reason: unknown) => reason);
  assert.ok(error instanceof runChild.RunChildLostError, String(error));
  assert.equal(error.loss, "container_stop");
  assert.equal(runChild.runChildOutsideKill(error), "container_stop");
  launched.acknowledge?.({ status: "rejected", reason: error });
  const settled = fx.rows.find((r) => r.step === "run_child.settled");
  assert.equal(settled?.loss, "container_stop", "the settle row names the loss");
  assert.equal(runChild.runChildOutsideKill(new Error("run child x lost: unknown")), undefined);
  assert.equal(runChild.runChildOutsideKill(new runChild.RunChildLostError("x", "lost")), undefined);
});
