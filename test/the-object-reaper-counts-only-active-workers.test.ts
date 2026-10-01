import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LOOSE_OBJECT_FLOOR, objectReapRefusal, type ObjectReapDeps } from "../src/lib/object-reaper.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { runLockPath } from "../src/lib/worker.js";
import { logDiskReclaimRung } from "../src/run-task.js";

// MEASURED 2026-10-01: the ARMED object reaper refused 296 times in a row since 2026-09-24 while the managed checkout grew to
// 85,464 loose objects. It runs inside runTask AFTER the run's own inflight lock is taken, and it counted every lock FILE and
// every REGISTERED worktree (leftovers included), so it could never read quiet. The operator's standing rule is "no prune while
// an ACTIVE worker uses the store" — the rung now measures active, which keeps that rule exactly.

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

/** Drive the REAL wiring: the predicates logDiskReclaimRung hands the reaper, applied by the real objectReapRefusal. */
function refusalThroughWiring(inflightDir: string, worktrees: string[], ownTask: string): string | undefined {
  let refusal: string | undefined = "never reached";
  logDiskReclaimRung({ root: tmp("w1t5119-root") } as never, () => {}, {
    sweepTempDirs: () => ({ removed: [] }) as never,
    reapClonesSurvey: () => ({ reaped: [], bytesReclaimed: 0 }) as never,
    sweepWorkerHomes: () => ({ removed: [] }) as never,
    workerHomeRoot: () => "/nowhere",
    objectRepoDir: () => "/repo",
    objectInflightDir: () => inflightDir,
    objectPolicy: () => ({ enabled: true }),
    ratifications: new Map(),
    objectOwnInflightLock: `${ownTask}.lock`,
    reapObjects: ((repoDir: string, inflight: string, d: ObjectReapDeps) => {
      refusal = objectReapRefusal(repoDir, inflight, { ...d, listWorktrees: () => worktrees, openFileCount: () => 0, looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1 });
      return { pruned: 0, looseBefore: LOOSE_OBJECT_FLOOR + 1 };
    }) as never,
  });
  return refusal;
}

test("W1-T5119: the calling run own inflight lock does not refuse the reap", () => {
  const inflight = inflightDirWith({ "W1-T1": process.pid });
  assert.equal(refusalThroughWiring(inflight, [], "W1-T1"), undefined, "the caller's own lock is not another worker");
  assert.match(String(refusalThroughWiring(inflight, [], "W1-T2")), /inflight lock/, "someone else's live lock still refuses");
});

test("W1-T5119: a leftover worktree with no live run lock does not refuse the reap", () => {
  const inflight = inflightDirWith({ "W1-T1": process.pid, "W1-T9": DEAD_PID });
  const leftovers = [worktreeWithRunLock(undefined), worktreeWithRunLock(DEAD_PID)];
  assert.equal(refusalThroughWiring(inflight, leftovers, "W1-T1"), undefined, "dead locks and lockless leftovers are not active workers");
});

test("W1-T5119: a live worker worktree still refuses the reap", () => {
  const inflight = inflightDirWith({ "W1-T1": process.pid });
  const corrupt = tmp("w1t5119-corrupt");
  writeFileSync(runLockPath(corrupt), "{torn");
  assert.match(String(refusalThroughWiring(inflight, [worktreeWithRunLock(process.pid)], "W1-T1")), /worktree/);
  assert.match(String(refusalThroughWiring(inflight, [corrupt], "W1-T1")), /worktree/, "an unreadable run lock fails closed");
  const torn = inflightDirWith({ "W1-T1": process.pid });
  writeFileSync(join(torn, "W1-T3.lock"), "{torn");
  assert.match(String(refusalThroughWiring(torn, [], "W1-T1")), /inflight lock/, "an unparseable inflight lock fails closed");
});

test("W1-T5119: without the active-worker predicates the reaper still counts every lock and worktree", () => {
  const strict = { listWorktrees: () => ["/w/leftover"], listInflightLocks: () => ["W1-T1.lock"], openFileCount: () => 0 };
  assert.match(String(objectReapRefusal("/repo", "/i", strict)), /worktree/);
  assert.match(String(objectReapRefusal("/repo", "/i", { ...strict, listWorktrees: () => [] })), /inflight lock/);
});
