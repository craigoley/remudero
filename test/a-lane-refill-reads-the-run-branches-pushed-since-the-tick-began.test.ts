// W1-T5805 — A LANE REFILL READS THE RUN BRANCHES PUSHED SINCE THE TICK BEGAN. `refillLane` reused
// the tick's `dispatchOpts`, whose `hasPushedRunBranch` closed over ONE `git ls-remote` taken at the
// tick's start. On 2026-10-05 `run-W1-T5650-1791165209009` was pushed (with #9210 open) at ~02:16Z,
// mid-phase, and lane 0 still refilled with W1-T5650 at 02:43Z: the fleet built a duplicate, #9219.
// These drive the REAL runDaemon at three lanes; only `runOne` and the branch reader are faked.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, runLanePool, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { readPushedRunBranchesOutputAsync, type RunResult } from "../src/run-task.js";

const IDS = ["W1-T9001", "W1-T9002", "W1-T9003", "W1-T9004"];
const LATE = "W1-T9004";
const LATE_BRANCH = `5650aaaa\trefs/heads/run-${LATE}-1791165209009\n`;

type Row = { step: string; extra?: Record<string, unknown> };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const result = (id: string): RunResult =>
  ({ taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` }) as RunResult;

/** Three lanes admit 9001..9003 at the tick's start, when `readBranches` reports no run branch for
 *  9004; the test then changes what the reader returns and frees lanes while siblings still run. */
async function phase(readBranches: () => string | Promise<string>, body: (h: {
  started: string[];
  rows: Row[];
  settle: (id: string) => Promise<void>;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-refill-branches-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, IDS.map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`,
  ).join(""));
  const releases = new Map(IDS.map((id) => [id, deferred<RunResult>()]));
  const started: string[] = [];
  const rows: Row[] = [];
  const merged = new Set<string>();
  let cleaningUp = false;
  const run = runDaemon(loadPlan(path), {
    refreshMerged: () => (id: string) => merged.has(id),
    readPushedRunBranches: readBranches,
    checkStop: () => cleaningUp ? "test cleanup" : undefined,
    log: (step, extra) => { rows.push({ step, extra }); },
    runOne: async (id) => {
      started.push(id);
      return cleaningUp ? result(id) : releases.get(id)!.promise;
    },
    sleep: async () => {},
  } as DaemonDeps, { laneCount: 3, max: 10 });
  try {
    await drainMicrotasks();
    assert.deepEqual(started, IDS.slice(0, 3), "the tick's start admits three lanes");
    await body({
      started,
      rows,
      settle: async (id) => {
        merged.add(id);
        releases.get(id)!.resolve(result(id));
        for (let i = 0; i < 5; i++) await drainMicrotasks();
      },
    });
  } finally {
    cleaningUp = true;
    for (const [id, release] of releases) release.resolve(result(id));
    await run;
    rmSync(dir, { recursive: true, force: true });
  }
}

const skippedForBranch = (rows: Row[]) =>
  rows.filter((r) => r.step === "dispatch.skipped" && r.extra?.reason === "run-branch-already-pushed").map((r) => r.extra?.task);

test("a refill refuses a task whose run branch was pushed after the tick began, and refills it once the reader returns none", async () => {
  let branches = "";
  await phase(() => branches, async ({ started, rows, settle }) => {
    assert.deepEqual(skippedForBranch(rows), [], "the tick-start read held no run branch");
    branches = LATE_BRANCH;
    await settle("W1-T9001");
    assert.deepEqual(started, IDS.slice(0, 3), `${LATE} is not dispatched while its run branch is on origin`);
    assert.deepEqual(skippedForBranch(rows), [LATE]);
    const held = rows.filter((r) => r.step === "dispatch.lane_refill_held").at(-1);
    assert.equal(held?.extra?.finished_task, "W1-T9001");
    branches = "";
    await settle("W1-T9002");
    assert.deepEqual(started, IDS, `${LATE} refills once the reader returns no run branch for it`);
    assert.equal(rows.filter((r) => r.step === "dispatch.lane_refilled").at(-1)?.extra?.next_task, LATE);
  });
});

test("a refill awaits a promised branch read before it decides", async () => {
  let branches = "";
  let reads = 0;
  await phase(async () => { reads++; return branches; }, async ({ started, rows, settle }) => {
    branches = LATE_BRANCH;
    await settle("W1-T9001");
    assert.equal(reads, 2, "one read at the tick's start, one for the refill");
    assert.deepEqual(started, IDS.slice(0, 3));
    assert.deepEqual(skippedForBranch(rows), [LATE]);
  });
});

test("a refill whose branch read throws or rejects logs it and decides on the tick-start read", async () => {
  for (const failing of [
    () => { throw new Error("ls-remote exited 128"); },
    () => Promise.reject(new Error("ls-remote exited 128")),
  ]) {
    let reader: () => string | Promise<string> = () => LATE_BRANCH;
    await phase(() => reader(), async ({ started, rows, settle }) => {
      reader = failing;
      await settle("W1-T9001");
      assert.deepEqual(started, IDS.slice(0, 3), "the failed read neither drops what the tick saw nor holds the lane");
      assert.equal(skippedForBranch(rows).at(-1), LATE);
      const failed = rows.filter((r) => r.step === "dispatch.run_branch_read_failed");
      assert.deepEqual(failed.map((r) => r.extra), [{ site: "lane-refill", error: "ls-remote exited 128" }]);
    });
  }
});

test("a tick-start branch read that rejects logs it and refuses no task", async () => {
  let reader: () => Promise<string> = () => Promise.reject(new Error("no remote"));
  await phase(() => reader(), async ({ started, rows, settle }) => {
    assert.deepEqual(rows.filter((r) => r.step === "dispatch.run_branch_read_failed").map((r) => r.extra),
      [{ site: "tick", error: "no remote" }]);
    reader = async () => "";
    await settle("W1-T9001");
    assert.deepEqual(started, IDS);
  });
});

test("a lane pool holds its result while a promised refill is pending, and a rejected refill ends only that lane", async () => {
  const runs = new Map(["a", "b", "c"].map((id) => [id, deferred<string>()]));
  const pendingRefill = deferred<{ id: string } | undefined>();
  const refills: string[] = [];
  let resolved = false;
  const pool = runLanePool([{ id: "a" }, { id: "b" }], (id) => runs.get(id)!.promise, (_lane, finished) => {
    refills.push(finished.id);
    if (finished.id === "a") return pendingRefill.promise;
    if (finished.id === "b") return Promise.reject(new Error("refill read failed"));
    return undefined;
  });
  void pool.then(() => { resolved = true; });
  runs.get("a")!.resolve("a");
  await drainMicrotasks();
  runs.get("b")!.resolve("b");
  await drainMicrotasks();
  assert.deepEqual(refills, ["a", "b"], "b's lane may refill while a's refill read is pending");
  assert.equal(resolved, false, "a pending refill keeps the pool open");
  pendingRefill.resolve({ id: "c" });
  await drainMicrotasks();
  assert.equal(resolved, false);
  runs.get("c")!.resolve("c");
  const settled = await pool;
  assert.deepEqual(settled.map((s) => s.status === "fulfilled" && s.value), ["a", "b", "c"]);
  assert.deepEqual(refills, ["a", "b"], "the last lane to settle never refills");
});

test("the daemon's branch read runs ls-remote as an awaited child bounded by its timeout", async () => {
  const calls: unknown[][] = [];
  const out = await readPushedRunBranchesOutputAsync(async (...args: unknown[]) => {
    calls.push(args);
    return { stdout: LATE_BRANCH };
  }, 1234);
  assert.equal(out, LATE_BRANCH);
  assert.deepEqual(calls[0].slice(0, 2), ["git", ["ls-remote", "--heads", "origin", "run-*"]]);
  assert.equal((calls[0][2] as { timeout: number }).timeout, 1234);
  await assert.rejects(readPushedRunBranchesOutputAsync(undefined, 1), "a real child past its bound rejects");
});
