/**
 * W1-T368: A LOCK MUST IDENTIFY ITS HOLDER, NOT JUST NAME A NUMBER.
 *
 * Before this task, every `reclaimStaleLock` consumer (and deriveStatus's own inflight-lock
 * disjunct) judged a lock's holder by `!isAlive(held.pid)` alone — "is SOME process using this
 * number", never "is it the process that wrote the lock". The pid space wraps (measured on the
 * fleet host: kern.maxproc 4000, kern.maxprocperuid 2666), so a dead holder's pid gets reissued
 * in the ordinary course of things. When that happens the recycled pid used to read as LIVE
 * forever: `acquireInflightLock` refused every future dispatch of the task it named, the boot
 * sweep counted it `kept`, and `deriveStatus` rendered the dead run as RUNNING.
 *
 * `isHolderStale` (src/lib/fs-race-safe.ts) is now the ONE predicate every consumer declared
 * for this task shares, and closes two gaps the lock's own `host`/`startedAt` fields already
 * recorded but nothing ever read: a same-host pid whose ACTUAL start time is later than the
 * lock's own `startedAt` is a reused number (a different, newer process), and a lock naming a
 * DIFFERENT host is not judged by a purely local pid probe at all.
 *
 * Every reuse scenario below is forced by INJECTION (a fake `isPidAlive` plus a fake
 * `getProcessStartTime`), never by waiting for a real pid wrap — the design's own requirement
 * for a deterministic falsifying test.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isHolderStale } from "../src/lib/fs-race-safe.js";
import { acquireInflightLock, readInflightLock, sweepStaleInflightLocks } from "../src/lib/inflight-lock.js";
import { acquireDrainLock, readDrainLock } from "../src/lib/drain-lock.js";
import { deriveStatus, type DeriveDeps, type GitHub } from "../src/lib/status.js";
import type { Task } from "../src/lib/plan.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-lock-identity-"));
}

// ── THE SHARED PRIMITIVE, tested directly ────────────────────────────────────────────────

test("isHolderStale: an alive pid that started AFTER the lock's own startedAt is judged STALE (pid reuse)", () => {
  const held = { pid: 4242, host: "same-host", startedAt: "2026-08-01T00:00:00.000Z" };
  const stale = isHolderStale(held, {
    isPidAlive: () => true, // the number IS currently in use by SOME process
    hostname: () => "same-host", // same host — the pid probe is meaningful
    getProcessStartTime: () => Date.parse("2026-08-01T12:00:00.000Z"), // started 12h AFTER the lock
  });
  assert.equal(stale, true, "a live pid whose start time postdates the lock means the number was reused");
});

test("isHolderStale: an alive pid whose start time PRECEDES the lock's startedAt is judged LIVE (same process)", () => {
  const held = { pid: 4242, host: "same-host", startedAt: "2026-08-01T12:00:00.000Z" };
  const stale = isHolderStale(held, {
    isPidAlive: () => true,
    hostname: () => "same-host",
    getProcessStartTime: () => Date.parse("2026-08-01T00:00:00.000Z"), // started BEFORE writing the lock
  });
  assert.equal(stale, false, "the process that wrote the lock necessarily started before its own startedAt");
});

test("isHolderStale: a dead pid is stale regardless of any injected start time", () => {
  const held = { pid: 999999, host: "same-host", startedAt: "2026-08-01T00:00:00.000Z" };
  const stale = isHolderStale(held, {
    isPidAlive: () => false,
    hostname: () => "same-host",
    getProcessStartTime: () => Date.parse("2026-08-01T00:00:00.000Z"), // even a MATCHING start time
  });
  assert.equal(stale, true, "a dead pid is dead — start time never overrides that");
});

test("isHolderStale: a lock naming a DIFFERENT host is not judged by the local pid probe at all", () => {
  const held = { pid: 4242, host: "other-host", startedAt: "2026-08-01T00:00:00.000Z" };
  const stale = isHolderStale(held, {
    isPidAlive: () => true, // some LOCAL process happens to use this number — coincidence, not the holder
    hostname: () => "this-host",
    getProcessStartTime: () => {
      throw new Error("must not be called — the host mismatch alone must short-circuit");
    },
  });
  assert.equal(stale, false, "unresolvable from here, so not judged stale — never reap a lock this process can't verify");
});

test("isHolderStale: an indeterminate start time (probe returns null) is NOT evidence of staleness", () => {
  const held = { pid: 4242, host: "same-host", startedAt: "2026-08-01T00:00:00.000Z" };
  const stale = isHolderStale(held, {
    isPidAlive: () => true,
    hostname: () => "same-host",
    getProcessStartTime: () => null, // e.g. `ps` unavailable, or the pid died in the gap
  });
  assert.equal(stale, false, "an unanswerable probe defers to 'still alive', never invents staleness");
});

test("defaultGetProcessStartTime: parses ps -o etime= output through an injected execFileSync", async () => {
  const { defaultGetProcessStartTime } = await import("../src/lib/fs-race-safe.js");
  const before = Date.now();
  const fakeExec = (() => "   05:30\n") as unknown as typeof import("node:child_process").execFileSync;
  const start = defaultGetProcessStartTime(4242, { execFileSync: fakeExec });
  assert.ok(start !== null);
  // 5 minutes 30 seconds ago, computed against Date.now() at call time.
  assert.ok(start! <= before - 5 * 60_000 + 1000 && start! >= before - 5 * 60_000 - 6 * 60_000);
});

test("defaultGetProcessStartTime: a probe failure (pid gone, ps missing) is null, not a throw", async () => {
  const { defaultGetProcessStartTime } = await import("../src/lib/fs-race-safe.js");
  const throwingExec = (() => {
    throw new Error("ESRCH");
  }) as unknown as typeof import("node:child_process").execFileSync;
  assert.equal(defaultGetProcessStartTime(999999, { execFileSync: throwingExec }), null);
});

test("defaultGetProcessStartTime: unrecognized ps output is null, not a throw", async () => {
  const { defaultGetProcessStartTime } = await import("../src/lib/fs-race-safe.js");
  const garbageExec = (() => "not-an-etime\n") as unknown as typeof import("node:child_process").execFileSync;
  assert.equal(defaultGetProcessStartTime(1, { execFileSync: garbageExec }), null);
});

// ── acquireInflightLock: the DISPATCH-STALL arm ──────────────────────────────────────────

test("acquireInflightLock: a lock naming an alive-but-REUSED pid is RECLAIMED, not refused", () => {
  const dir = tmp();
  try {
    const lockStart = "2026-08-01T00:00:00.000Z";
    acquireInflightLock(dir, "W1-T7", {
      run_id: "old",
      info: { pid: 4242, host: hostname(), startedAt: lockStart },
    });
    // A NEW acquire: pid 4242 reads alive (some unrelated process now owns that number), but its
    // ACTUAL start time is 12h after the lock's own startedAt — a different, newer process.
    const h = acquireInflightLock(dir, "W1-T7", {
      run_id: "new",
      info: { pid: 555 },
      isPidAlive: () => true,
      getProcessStartTime: (pid) => (pid === 4242 ? Date.parse(lockStart) + 12 * 60 * 60_000 : null),
    });
    assert.equal(readInflightLock(dir, "W1-T7")?.run_id, "new", "the reused-pid lock was reclaimed, not refused");
    h.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── sweepStaleInflightLocks: the MISRENDER-lingers arm ───────────────────────────────────

test("sweepStaleInflightLocks: a lock naming an alive-but-REUSED pid is REAPED, not kept", () => {
  const dir = tmp();
  try {
    const lockStart = "2026-08-01T00:00:00.000Z";
    acquireInflightLock(dir, "W1-T7", { run_id: "old", info: { pid: 4242, host: hostname(), startedAt: lockStart } });
    const out = sweepStaleInflightLocks(dir, {
      isPidAlive: () => true,
      getProcessStartTime: () => Date.parse(lockStart) + 60_000, // 1 minute AFTER — a newer process
    });
    assert.deepEqual(out.reaped, ["W1-T7"], "FALSIFIER: a recycled pid must not linger as 'kept' forever");
    assert.deepEqual(out.kept, []);
    assert.equal(readInflightLock(dir, "W1-T7"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── SHARED PREDICATE, claim 4: drain-lock and deriveStatus reach the SAME verdict ────────

test("acquireDrainLock: a lock naming an alive-but-REUSED pid is reclaimed too — the SAME predicate as inflight-lock", () => {
  const dir = tmp();
  const path = join(dir, "state", "drain.lock");
  try {
    const lockStart = "2026-08-01T00:00:00.000Z";
    acquireDrainLock(path, { info: { pid: 4242, host: hostname(), startedAt: lockStart } });
    const h = acquireDrainLock(path, {
      info: { pid: 555 },
      isPidAlive: () => true,
      getProcessStartTime: (pid) => (pid === 4242 ? Date.parse(lockStart) + 60_000 : null),
    });
    assert.equal(readDrainLock(path)?.pid, 555, "reclaimed via the same isHolderStale predicate");
    h.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function noGitHub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

test("deriveStatus: a quiet run whose lock names an alive-but-REUSED pid is NOT rescued as running — the SAME predicate", () => {
  const taskId = "W1-T900";
  const task: Task = { id: taskId, title: "reused-pid lock", repo: "remudero", type: "implement" } as Task;
  const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString(); // past the 30-minute liveness bound
  const lines = [
    { ts: old, run_id: "r-quiet", task_id: taskId, step: "run.start" },
    { ts: old, run_id: "r-quiet", task_id: taskId, step: "recon.done" },
  ];
  const deps: DeriveDeps = {
    ledgerPath: "/nonexistent/ledger.ndjson",
    github: noGitHub(),
    readLedger: () => lines,
    inflightHolder: () => ({ pid: 4242, host: hostname(), startedAt: old }),
    isPidAlive: () => true, // 4242 reads alive — some unrelated process now owns that number
    getProcessStartTime: () => Date.parse(old) + 60_000, // but started a MINUTE AFTER the lock
  };
  const p = deriveStatus(task, deps);
  assert.notEqual(p.status, "running", "a reused pid must not be trusted as the lock's original writer");
  assert.equal(p.orphaned, true);
});

test("deriveStatus: a quiet run whose lock names a genuinely-live holder (start time precedes the lock) still renders running", () => {
  const taskId = "W1-T901";
  const task: Task = { id: taskId, title: "genuine holder", repo: "remudero", type: "implement" } as Task;
  const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  const earlier = new Date(Date.now() - 4 * 60 * 60_000).toISOString(); // the holder started BEFORE the lock
  const lines = [
    { ts: old, run_id: "r-quiet", task_id: taskId, step: "run.start" },
    { ts: old, run_id: "r-quiet", task_id: taskId, step: "recon.done" },
  ];
  const deps: DeriveDeps = {
    ledgerPath: "/nonexistent/ledger.ndjson",
    github: noGitHub(),
    readLedger: () => lines,
    inflightHolder: () => ({ pid: 4242, host: hostname(), startedAt: old }),
    isPidAlive: () => true,
    getProcessStartTime: () => Date.parse(earlier),
  };
  const p = deriveStatus(task, deps);
  assert.equal(p.status, "running", "a genuinely live holder must still rescue the quiet run");
});
