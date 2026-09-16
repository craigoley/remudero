import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HUNG_WORKER_AGE_S,
  reapOrphanedWorkerProcesses,
  type RunLockRead,
  type WorkerProcess,
  type WorkerReapOpts,
} from "../src/lib/worker.js";

// ── W1-T3629: NOTHING REAPS AN ORPHANED WORKER PROCESS ──────────────────────────────
//
// pruneStaleRuns reclaims the WORKTREE a dead run left behind and rmd-reap-stray reclaims stray
// CONTAINERS, but the PROCESS itself was reclaimed by nobody -- a worker whose run is long gone
// kept its memory until the host died (MEASURED 2026-09-16: two `npm ci` at 80 and 71 minutes).
//
// The bound is ORPHANHOOD, and age is only the second condition (W1-T208's lesson, repeated in
// the rationale this file proves): a worker is reapable only when no LIVE run lock claims its
// parent pid AND it is past HUNG_WORKER_AGE_S. Every seam (owner-lock lookup, liveness probe, the
// kill call, the ledger sink) is injected, so these are pure decision-logic tests -- no real
// process tree or filesystem is needed to drive all four branches.

function worker(overrides: Partial<WorkerProcess> = {}): WorkerProcess {
  return { pid: 4242, ppid: 99, etimeS: HUNG_WORKER_AGE_S + 3600, args: "npm ci", ...overrides };
}

function baseOpts(overrides: Partial<WorkerReapOpts> = {}): WorkerReapOpts {
  return {
    ownerLockForPpid: () => ({ kind: "absent" }),
    isPidAlive: () => false,
    kill: () => {},
    ledger: () => {},
    ...overrides,
  };
}

test("an orphaned worker past the age bound is reaped and ledgered", () => {
  const ledgerCalls: Array<{ message: string; extra?: Record<string, unknown> }> = [];
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const w = worker({ pid: 5150, etimeS: HUNG_WORKER_AGE_S + 600, args: "npm ci" });

  const summary = reapOrphanedWorkerProcesses(
    [w],
    baseOpts({
      ownerLockForPpid: () => ({ kind: "absent" }), // no worktree's run.lock claims this parent
      ledger: (message, extra) => ledgerCalls.push({ message, extra }),
      kill: (pid, signal) => killCalls.push({ pid, signal }),
    }),
  );

  assert.equal(summary.reaped.length, 1);
  assert.deepEqual(summary.reaped[0], { pid: 5150, ageS: HUNG_WORKER_AGE_S + 600, args: "npm ci", reason: "orphan-past-age-bound" });
  assert.equal(summary.kept.length, 0);

  // Ledgered with the pid, the age and the reason.
  assert.equal(ledgerCalls.length, 1);
  assert.match(ledgerCalls[0].message, /pid=5150/);
  assert.match(ledgerCalls[0].message, new RegExp(`age=${HUNG_WORKER_AGE_S + 600}s`));
  assert.match(ledgerCalls[0].message, /reason=orphan-past-age-bound/);
  assert.equal(ledgerCalls[0].extra?.pid, 5150);
  assert.equal(ledgerCalls[0].extra?.ageS, HUNG_WORKER_AGE_S + 600);
  assert.equal(ledgerCalls[0].extra?.reason, "orphan-past-age-bound");

  // Terminated — and ledgered BEFORE the kill (same discipline as reclaimStaleConfigLock).
  assert.equal(killCalls.length, 1);
  assert.deepEqual(killCalls[0], { pid: 5150, signal: "SIGKILL" });
});

test("a worker owned by a live run is never reaped however old it is", () => {
  const killCalls: number[] = [];
  // A run started with implement.high can legitimately exceed two hours; this worker is far past
  // the age bound, and must still survive because a live run.lock names its parent pid.
  const w = worker({ pid: 6001, ppid: 777, etimeS: HUNG_WORKER_AGE_S * 10 });
  const liveLock: RunLockRead = { kind: "live", info: { pid: 777, run_id: "run-abc", startedAt: "2026-09-16T00:00:00.000Z" } };

  const summary = reapOrphanedWorkerProcesses(
    [w],
    baseOpts({
      ownerLockForPpid: (ppid) => {
        assert.equal(ppid, 777); // cross-referenced by the worker's OWN parent pid
        return liveLock;
      },
      isPidAlive: (pid) => pid === 777,
      kill: (pid) => killCalls.push(pid),
    }),
  );

  assert.equal(summary.reaped.length, 0);
  assert.equal(summary.kept.length, 1);
  assert.deepEqual(summary.kept[0], { pid: 6001, ageS: HUNG_WORKER_AGE_S * 10, reason: "live-run" });
  assert.equal(killCalls.length, 0);
});

test("a live run.lock naming a now-dead pid does not spare the worker", () => {
  // A run.lock can outlive its writer (crash without cleanup): `live` alone is not enough, the
  // named pid must actually still be alive, or the owning run is just as gone as an absent lock.
  const w = worker({ pid: 6100, ppid: 778, etimeS: HUNG_WORKER_AGE_S + 1 });
  const staleLock: RunLockRead = { kind: "live", info: { pid: 778, run_id: "run-dead", startedAt: "2026-09-01T00:00:00.000Z" } };

  const summary = reapOrphanedWorkerProcesses(
    [w],
    baseOpts({
      ownerLockForPpid: () => staleLock,
      isPidAlive: () => false, // the pid the lock names is no longer running
    }),
  );

  assert.equal(summary.reaped.length, 1);
  assert.equal(summary.reaped[0].reason, "orphan-past-age-bound");
});

test("an orphan inside the age bound is left alone", () => {
  // Orphanhood alone is not sufficient: this worker's owning run is gone, but it has not yet
  // crossed HUNG_WORKER_AGE_S, so it must be left running exactly like a legitimate fresh worker.
  const ownerLockCalls: number[] = [];
  const w = worker({ pid: 7002, etimeS: HUNG_WORKER_AGE_S - 1 });

  const summary = reapOrphanedWorkerProcesses(
    [w],
    baseOpts({
      ownerLockForPpid: (ppid) => {
        ownerLockCalls.push(ppid);
        return { kind: "absent" };
      },
    }),
  );

  assert.equal(summary.reaped.length, 0);
  assert.equal(summary.kept.length, 1);
  assert.deepEqual(summary.kept[0], { pid: 7002, ageS: HUNG_WORKER_AGE_S - 1, reason: "within-age-bound" });
  // The age gate runs FIRST: an owner lookup for a worker inside the bound would be wasted work,
  // and never happens.
  assert.equal(ownerLockCalls.length, 0);
});

test("an unreadable run lock spares the worker rather than reaping it", () => {
  // A destructive action must fail closed: a CORRUPT owner-lock reading is possibly-live, never
  // proof of death (the inverse of pruneStaleRuns' own corrupt-is-treated-as-absent doctrine,
  // which is safe there only because that action reclaims a directory rather than killing a pid).
  const killCalls: number[] = [];
  const ledgerCalls: unknown[] = [];
  const w = worker({ pid: 8003, etimeS: HUNG_WORKER_AGE_S + 42 });

  const summary = reapOrphanedWorkerProcesses(
    [w],
    baseOpts({
      ownerLockForPpid: () => ({ kind: "corrupt", raw: "{not json" }),
      kill: (pid) => killCalls.push(pid),
      ledger: (message) => ledgerCalls.push(message),
    }),
  );

  assert.equal(summary.reaped.length, 0);
  assert.equal(summary.kept.length, 1);
  assert.deepEqual(summary.kept[0], { pid: 8003, ageS: HUNG_WORKER_AGE_S + 42, reason: "owner-unreadable" });
  assert.equal(killCalls.length, 0);
  assert.equal(ledgerCalls.length, 0); // nothing was reaped, so nothing is ledgered as a reap
});

test("dryRun records what would be reaped without sending a signal", () => {
  const killCalls: number[] = [];
  const ledgerCalls: unknown[] = [];
  const w = worker({ pid: 9004, etimeS: HUNG_WORKER_AGE_S + 10 });

  const summary = reapOrphanedWorkerProcesses(
    [w],
    baseOpts({
      dryRun: true,
      kill: (pid) => killCalls.push(pid),
      ledger: (message) => ledgerCalls.push(message),
    }),
  );

  assert.equal(summary.reaped.length, 1); // survey still records the candidate
  assert.equal(ledgerCalls.length, 1); // survey is still ledgered
  assert.equal(killCalls.length, 0); // but nothing is signalled
});

test("a kill that races the process's own exit does not lose the reap record", () => {
  // The pid can vanish between the owner-lock read and the kill call (the process exits on its
  // own in the gap). The ledger row was already written before the kill, so the reap is not
  // silently dropped just because the signal itself failed.
  const w = worker({ pid: 1010, etimeS: HUNG_WORKER_AGE_S + 5 });

  const summary = reapOrphanedWorkerProcesses(
    [w],
    baseOpts({
      kill: () => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      },
    }),
  );

  assert.equal(summary.reaped.length, 1);
  assert.equal(summary.reaped[0].pid, 1010);
});

test("multiple workers are judged independently in one pass", () => {
  const reapedPids: number[] = [];
  const keptPids: number[] = [];
  const processes = [
    worker({ pid: 1, ppid: 11, etimeS: HUNG_WORKER_AGE_S + 1 }), // orphan, past bound -> reaped
    worker({ pid: 2, ppid: 22, etimeS: HUNG_WORKER_AGE_S - 1 }), // orphan, inside bound -> kept
    worker({ pid: 3, ppid: 33, etimeS: HUNG_WORKER_AGE_S + 1 }), // live run -> kept
  ];

  const summary = reapOrphanedWorkerProcesses(
    processes,
    baseOpts({
      ownerLockForPpid: (ppid) =>
        ppid === 33
          ? { kind: "live", info: { pid: 33, run_id: "run-live", startedAt: "2026-09-16T00:00:00.000Z" } }
          : { kind: "absent" },
      isPidAlive: (pid) => pid === 33,
    }),
  );

  for (const r of summary.reaped) reapedPids.push(r.pid);
  for (const k of summary.kept) keptPids.push(k.pid);
  assert.deepEqual(reapedPids.sort(), [1]);
  assert.deepEqual(keptPids.sort(), [2, 3]);
});
