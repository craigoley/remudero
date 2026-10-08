import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LOOSE_OBJECT_FLOOR, objectReapRefusal, activeWorkerProbes } from "../src/lib/object-reaper.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { runLockPath } from "../src/lib/worker.js";

// Exercise the retained legacy quiet predicate with the real active-holder probes.
// Production dispatch no longer invokes object maintenance.

const DEAD_PID = 2 ** 22 + 7;
const tmp = (label: string) => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`));

function inflightDirWith(locks: Record<string, number>): string {
  const dir = tmp("w1t5119-inflight");
  for (const [task, pid] of Object.entries(locks)) {
    writeFileSync(join(dir, `${task}.lock`), JSON.stringify({ pid, run_id: `${task}-1`, host: hostname(), startedAt: new Date().toISOString() }));
  }
  return dir;
}

function worktreeWithRunLock(pid: number | undefined): string {
  const wt = tmp("w1t5119-wt");
  if (pid !== undefined) {
    mkdirSync(join(wt), { recursive: true });
    writeFileSync(runLockPath(wt), JSON.stringify({ pid, run_id: "W1-TX-1", startedAt: new Date().toISOString() }));
  }
  return wt;
}

/** Drive the real active-holder probes without restoring dispatch-time maintenance. */
async function refusalFromActiveProbes(inflightDir: string, worktrees: string[], ownTask: string): Promise<string | undefined> {
  return objectReapRefusal("/repo", inflightDir, {
    ...activeWorkerProbes(inflightDir),
    ownInflightLock: `${ownTask}.lock`,
    listWorktrees: () => worktrees,
    openFileCount: () => 0,
    looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1,
  });
}

test("W1-T5119: the calling run own inflight lock does not refuse the reap", async () => {
  const inflight = inflightDirWith({ "W1-T1": process.pid });
  assert.equal(await refusalFromActiveProbes(inflight, [], "W1-T1"), undefined, "the caller's own lock is not another worker");
  assert.match(String(await refusalFromActiveProbes(inflight, [], "W1-T2")), /inflight lock/, "someone else's live lock still refuses");
});

test("W1-T5119: a leftover worktree with no live run lock does not refuse the reap", async () => {
  const inflight = inflightDirWith({ "W1-T1": process.pid, "W1-T9": DEAD_PID });
  const leftovers = [worktreeWithRunLock(undefined), worktreeWithRunLock(DEAD_PID)];
  assert.equal(await refusalFromActiveProbes(inflight, leftovers, "W1-T1"), undefined, "dead locks and lockless leftovers are not active workers");
});

test("W1-T5119: a live worker worktree still refuses the reap", async () => {
  const inflight = inflightDirWith({ "W1-T1": process.pid });
  const corrupt = tmp("w1t5119-corrupt");
  writeFileSync(runLockPath(corrupt), "{torn");
  assert.match(String(await refusalFromActiveProbes(inflight, [worktreeWithRunLock(process.pid)], "W1-T1")), /worktree/);
  assert.match(String(await refusalFromActiveProbes(inflight, [corrupt], "W1-T1")), /worktree/, "an unreadable run lock fails closed");
  const torn = inflightDirWith({ "W1-T1": process.pid });
  writeFileSync(join(torn, "W1-T3.lock"), "{torn");
  assert.match(String(await refusalFromActiveProbes(torn, [], "W1-T1")), /inflight lock/, "an unparseable inflight lock fails closed");
});

test("W1-T5119: an unreadable worktree registry still refuses the reap", async () => {
  const inflight = inflightDirWith({ "W1-T1": process.pid });
  assert.match(String(await refusalFromActiveProbes(inflight, ["<unreadable>"], "W1-T1")), /worktree/);
});

test("W1-T5119: without the active-worker predicates the reaper still counts every lock and worktree", () => {
  const strict = { listWorktrees: () => ["/w/leftover"], listInflightLocks: () => ["W1-T1.lock"], openFileCount: () => 0 };
  assert.match(String(objectReapRefusal("/repo", "/i", strict)), /worktree/);
  assert.match(String(objectReapRefusal("/repo", "/i", { ...strict, listWorktrees: () => [] })), /inflight lock/);
});
