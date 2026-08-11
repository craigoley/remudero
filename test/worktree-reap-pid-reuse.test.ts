/**
 * test/worktree-reap-pid-reuse.test.ts — W1-T406's discriminator: a run lock naming a pid that
 * is alive only because a CONTAINER'S PID NAMESPACE RESTARTED must be judged stale, using the
 * `startedAt` the lock already records.
 *
 * THE HAZARD, MEASURED IN THIS TASK'S PLAN SHARD. `defaultIsPidAlive` (drain-lock.ts) is
 * `process.kill(pid, 0)`, which answers in THIS process's pid namespace. Every container boot
 * restarts pids at 1, so a previous boot's `run.lock` naming a low pid very often finds that
 * number ALIVE as an entirely unrelated process today — and `reapStaleWorktrees`'s live-pid
 * guard then keeps that worktree FOREVER (permanent non-reclamation, not destruction).
 *
 * `worktreeLockIsPidAlive` (src/lib/worker.ts) is the fix: it reuses `isHolderStale`'s rung-3
 * start-time comparison (fs-race-safe.ts, W1-T396/W1-T368) exactly as written, applied to
 * `RunLockInfo`'s `{pid, startedAt}` — which structurally satisfies `HolderIdentity` with no
 * `host` key, so isHolderStale's host rung is skipped by construction (there is nothing for it
 * to read; RunLockInfo deliberately carries no host field — see this task's plan shard for why
 * adding one would be the wrong fix).
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { worktreeLockIsPidAlive, type RunLockInfo } from "../src/lib/worker.js";

const LOCK_STARTED_AT = "2026-08-08T12:00:00.000Z";
const LOCK_STARTED_MS = Date.parse(LOCK_STARTED_AT);

function lockInfo(over: Partial<RunLockInfo> = {}): RunLockInfo {
  return { pid: 42, run_id: "W1-T406-fixture", startedAt: LOCK_STARTED_AT, ...over };
}

test("THE PID-REUSE HAZARD: a pid alive only because the container restarted (its ACTUAL start is AFTER the lock's startedAt) is judged NOT alive", () => {
  // The container-restart shape: pid 42 IS currently alive (isPidAlive: true), but it is a
  // brand-new process that started an hour after the lock claims — the lock's real writer is
  // long gone and pid 42 was simply reissued by the fresh pid namespace.
  const aliveButReused = worktreeLockIsPidAlive(42, lockInfo(), {
    isPidAlive: () => true,
    getProcessStartTime: () => LOCK_STARTED_MS + 60 * 60 * 1000, // started 1h AFTER the lock
  });
  assert.equal(aliveButReused, false, "a pid that started after the lock claims is a DIFFERENT process, not the holder");
});

test("the SAME process (start time at or before the lock's startedAt, within tolerance) is judged alive", () => {
  const genuinelyLive = worktreeLockIsPidAlive(42, lockInfo(), {
    isPidAlive: () => true,
    getProcessStartTime: () => LOCK_STARTED_MS - 500, // started slightly BEFORE the lock was written
  });
  assert.equal(genuinelyLive, true, "a pid that started before the lock was written is consistent with being its writer");
});

test("a dead pid is judged not alive regardless of startedAt — the ordinary case still holds", () => {
  const dead = worktreeLockIsPidAlive(42, lockInfo(), {
    isPidAlive: () => false,
    getProcessStartTime: () => LOCK_STARTED_MS, // never reached — isPidAlive answers first
  });
  assert.equal(dead, false);
});

test("an INDETERMINATE start-time probe (ps missing, pid died in the gap) defers to alive — never treated as evidence of reuse", () => {
  const indeterminate = worktreeLockIsPidAlive(42, lockInfo(), {
    isPidAlive: () => true,
    getProcessStartTime: () => null, // ps couldn't resolve it
  });
  assert.equal(indeterminate, true, "no evidence of reuse ⇒ the ordinary alive-pid answer stands, exactly as isHolderStale's own doc requires");
});

test("no host field anywhere: RunLockInfo carries none, and the predicate never asks for one", () => {
  // Structural proof, not just a doc claim: a RunLockInfo literal has no `host` key at all, so
  // there is nothing for isHolderStale's rung-1 host check to read — it is skipped by
  // construction. Threading a foreign `isPidAlive: () => false` through here still reaches the
  // dead-pid branch directly, never a "different host, so keep" branch.
  const info = lockInfo();
  assert.equal("host" in info, false);
  const result = worktreeLockIsPidAlive(info.pid, info, { isPidAlive: () => false });
  assert.equal(result, false);
});

test("defaults reach the REAL syscalls: the current process's own pid is judged alive against its own recent startedAt", () => {
  // No `deps` at all — the default path runs defaultIsPidAlive (process.kill) and
  // defaultGetProcessStartTime (a real `ps -o etime=`) for real, against THIS test process.
  const recentLock = lockInfo({ pid: process.pid, startedAt: new Date().toISOString() });
  assert.equal(worktreeLockIsPidAlive(recentLock.pid, recentLock), true);
});
