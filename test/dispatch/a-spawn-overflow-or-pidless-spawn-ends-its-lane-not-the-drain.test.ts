import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as drainModule from "#src/lib/drain.js";
import { runDrain, type DrainDeps } from "#src/lib/drain.js";
import { loadPlanFromYaml, type Plan } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import {
  RUN_CHILD_SCHEMA, RUN_CHILD_SPAWN_ARG_BOUND, fromRunChildFailure, readStatus, runDir, toRunChildFailure, writeStatus,
} from "#src/lib/run-child-contract.js";

// Read off the namespace so the file still loads at the merge base, where the new classes do not exist.
const { SPAWN_NO_PID_RE, laneDeliveryFailure } = drainModule;

type Row = { step: string; extra: Record<string, unknown> };

function planOf(ids: readonly string[]): Plan {
  return loadPlanFromYaml(
    ids.map((id) => `- id: ${id}\n  title: ${id} fixture\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""),
    "spawn-overflow.fixture.yaml",
  );
}

function okResult(id: string): RunResult {
  return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" } as RunResult;
}

function drainDeps(runOne: DrainDeps["runOne"], rows: Row[]): DrainDeps {
  return { refreshMerged: () => () => false, runOne, log: (step, extra = {}) => rows.push({ step, extra }) } as DrainDeps;
}

const LOUD = ["-e", "process.stdout.write('x'.repeat(200000))"];

/** Node's own overflow error, from a real spawnSync whose output passes its maxBuffer. */
function spawnSyncOverflow(): Error {
  const error = spawnSync(process.execPath, LOUD, { maxBuffer: 1024 }).error;
  assert.ok(error, "the fixture child overflowed its buffer");
  return error;
}

/** The same overflow as execFileSync throws it. */
function execFileSyncOverflow(): Error {
  try {
    execFileSync(process.execPath, LOUD, { maxBuffer: 1024 });
  } catch (error) {
    return error as Error;
  }
  throw new Error("the fixture child did not overflow");
}

/** worker-containment.ts's spawnDetachedGroup throw, verbatim in shape. */
function noPid(): Error {
  return new Error("spawnDetachedGroup: child process has no pid (spawn failed synchronously) — command=claude exists=false");
}

test("W1-T11136 criterion 1: the classifier names a spawn output overflow and a pid-less spawn as one lane's failure", () => {
  for (const overflow of [spawnSyncOverflow(), execFileSyncOverflow()]) {
    const delivery = laneDeliveryFailure(overflow);
    assert.equal(delivery?.failureClass, "spawn_output_overflow", overflow.message);
  }
  assert.equal(laneDeliveryFailure(noPid())?.failureClass, "spawn_no_pid");
  assert.equal(SPAWN_NO_PID_RE.test(noPid().message), true);
  assert.equal(SPAWN_NO_PID_RE.test("TypeError: spawnDetachedGroup: child process has no pid "), false, "anchored at the start");
  assert.equal(SPAWN_NO_PID_RE.test("the run child has no pid (spawn failed)"), false, "run-child.ts's own no-pid throw is a different site");
  for (const stopping of [
    Object.assign(new Error("ENOBUFS in prose is not the structure"), {}),
    Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS", syscall: "write" }),
    Object.assign(new Error("x"), { code: "EPIPE", syscall: "spawnSync git" }),
    new Error("worker spawned with no pid"),
    new Error(" spawnDetachedGroup: child process has no pid (a leading space breaks the anchor)"),
    "spawnDetachedGroup: child process has no pid (a string is not an Error)",
  ]) {
    assert.equal(laneDeliveryFailure(stopping), undefined, `expected NO match: ${String((stopping as Error)?.message ?? stopping)}`);
  }
});

test("W1-T11136 criterion 1: the parallel settle ends only the overflowing lane, and the drain goes on", async () => {
  const rows: Row[] = [];
  const calls: string[] = [];
  const s = await runDrain(planOf(["W9-T1", "W9-T2"]), drainDeps(async (id) => {
    calls.push(id);
    if (id === "W9-T1") throw spawnSyncOverflow();
    return okResult(id);
  }, rows), { laneCount: 2, max: 2 });
  assert.notEqual(s.stopReason, "error", `one lane's overflow ended the drain: ${s.stopDetail}`);
  assert.deepEqual([...calls].sort(), ["W9-T1", "W9-T2"]);
  assert.deepEqual(s.merged, ["W9-T2"]);
  assert.deepEqual(s.continued?.map((c) => [c.taskId, c.verdict]), [["W9-T1", "lane_failed"]]);
  assert.equal(rows.find((r) => r.step === "drain.lane_failed")?.extra.class, "spawn_output_overflow");
});

test("W1-T11136 criterion 1: the single-lane path ends a pid-less spawn's lane and runs the next task", async () => {
  const rows: Row[] = [];
  const calls: string[] = [];
  const s = await runDrain(planOf(["W9-T1", "W9-T2"]), drainDeps(async (id) => {
    calls.push(id);
    if (id === "W9-T1") throw noPid();
    return okResult(id);
  }, rows), { max: 2 });
  assert.notEqual(s.stopReason, "error", `one lane's pid-less spawn ended the drain: ${s.stopDetail}`);
  assert.deepEqual(calls, ["W9-T1", "W9-T2"]);
  assert.deepEqual(s.merged, ["W9-T2"]);
  assert.deepEqual(s.continued?.map((c) => [c.taskId, c.verdict]), [["W9-T1", "lane_failed"]]);
  const failed = rows.find((r) => r.step === "drain.lane_failed");
  assert.equal(failed?.extra.class, "spawn_no_pid");
  assert.match(String(failed?.extra.error), /^spawnDetachedGroup: child process has no pid/);
});

test("W1-T11136 criterion 2: an overflow's row names the spawned file and its first argument, in both paths", async () => {
  const delivery = laneDeliveryFailure(spawnSyncOverflow());
  assert.equal(delivery?.spawnFile, process.execPath);
  assert.equal(delivery?.spawnArg, "-e");
  assert.match(delivery?.firstLine ?? "", new RegExp(`ENOBUFS — overflowed: ${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -e$`),
    "the first line names the call, so the daemon's lane_failed row carries it too");
  for (const laneCount of [1, 2]) {
    const rows: Row[] = [];
    await runDrain(planOf(["W9-T1", "W9-T2"]), drainDeps(async (id) => {
      if (id === "W9-T1") throw execFileSyncOverflow();
      return okResult(id);
    }, rows), { laneCount, max: 2 });
    const failed = rows.find((r) => r.step === "drain.lane_failed");
    assert.equal(failed?.extra.spawn_file, process.execPath, `laneCount ${laneCount}`);
    assert.equal(failed?.extra.spawn_arg, "-e", `laneCount ${laneCount}`);
  }
});

test("W1-T11136 criterion 2: credential refusals, in-process defects and non-Errors still stop the drain, in both paths", async () => {
  const stopping: unknown[] = [
    Object.assign(new Error("Command failed: git push origin HEAD"), { stderr: "fatal: Authentication failed for 'https://github.com/o/r.git/'" }),
    new TypeError("x is not a function"),
    "a bare string",
  ];
  for (const laneCount of [1, 2]) {
    for (const reason of stopping) {
      const s = await runDrain(planOf(["W9-T1", "W9-T2"]), drainDeps(async (id) => {
        if (id === "W9-T1") throw reason;
        return okResult(id);
      }, []), { laneCount, max: 2 });
      assert.equal(s.stopReason, "error", `laneCount ${laneCount}: ${String((reason as Error)?.message ?? reason)} must stay fatal`);
    }
  }
});

/** A daemon lane's error, as it crosses the run child's status file: written by the child, read back by the daemon. */
function throughStatusFile(original: unknown): Error {
  const state = mkdtempSync(join(tmpdir(), "rmd-w11136-status-"));
  try {
    const dir = runDir(state, "W9-T1-overflow");
    writeStatus(dir, {
      schema: { ...RUN_CHILD_SCHEMA }, runId: "W9-T1-overflow",
      identity: { pid: 4242, startTicks: "proc:100", containerGeneration: { containerId: "box-a", initStart: "proc:1" } },
      engineSha: "deadbeef", entryKind: "bundle", phase: "implementing", heartbeatAt: 1_700_000_000_000,
      state: "failed", failure: toRunChildFailure(original),
    });
    const read = readStatus(dir);
    assert.ok(read.ok && read.value.failure, "the status file reads back with its failure");
    const settled = fromRunChildFailure(read.value.failure);
    assert.ok(settled.kind === "error", "an overflow settles as an error, never a lost run");
    return settled.error;
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

test("W1-T11136 criterion 1: an overflow that crossed the run child's status file is still classified spawn_output_overflow", () => {
  for (const original of [spawnSyncOverflow(), execFileSyncOverflow()]) {
    const delivery = laneDeliveryFailure(throughStatusFile(original));
    assert.equal(delivery?.failureClass, "spawn_output_overflow", "the daemon's lanes run in run children, so this is the production path");
    assert.equal(delivery?.spawnFile, process.execPath);
    assert.equal(delivery?.spawnArg, "-e");
    assert.deepEqual(delivery, laneDeliveryFailure(original), "the round trip changes nothing the classifier answers");
  }
  assert.equal(laneDeliveryFailure(throughStatusFile(noPid()))?.failureClass, "spawn_no_pid");
  const longArg = Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS", syscall: "spawnSync git", path: "git", spawnargs: ["x".repeat(5000), "y"] });
  assert.equal(toRunChildFailure(longArg).spawnArg?.length, RUN_CHILD_SPAWN_ARG_BOUND, "only one bounded argument crosses, never the argv");
});
