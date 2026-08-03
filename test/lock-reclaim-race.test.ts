import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reclaimStaleLock } from "../src/lib/fs-race-safe.js";
import {
  acquireInflightLock,
  InflightLockError,
  readInflightLock,
  sweepStaleInflightLocks,
} from "../src/lib/inflight-lock.js";
import { acquireDrainLock, DrainLockError, readDrainLock } from "../src/lib/drain-lock.js";
import { acquireReviewStatusLock } from "../src/lib/review.js";

/**
 * W1-T289: all three single-instance locks (plus the boot sweep) reclaimed a stale
 * holder with an UNCONDITIONAL `unlinkSync`, conditioned on nothing but a stale READ.
 * Two reclaimers of the SAME dead lock could both decide "stale"; the first to
 * unlink+recreate won a FRESH LIVE lock, and the second's unconditional unlink then
 * deleted THAT — not the dead lock it actually judged — so both came away believing
 * they held it.
 *
 * These tests FORCE the dangerous interleaving by INJECTION, not by timing: every
 * `acquireInflightLock`/`sweepStaleInflightLocks` call below takes a
 * `__beforeReclaimDelete` hook that {@link reclaimStaleLock} fires in the exact window
 * the bug lived in — after a reclaimer has read a stale holder, but before its
 * delete-time identity check runs. The hook runs a SECOND reclaimer's entire flow to
 * completion, synchronously, inside that window: single-threaded JS makes this a
 * faithful, deterministic reproduction of the interleaving rather than a sleep-based
 * test that would pass by accident.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-reclaim-race-"));
}

test(
  "acquireInflightLock: two reclaimers of one dead-pid lock, with A's unlink+recreate " +
    "forced BEFORE B reaches its unlink, cannot both end up holding",
  () => {
    const dir = tmp();
    try {
      // A crashed prior run left a stale lock — the ordinary post-crash state.
      acquireInflightLock(dir, "W1-T7", { run_id: "dead", info: { pid: 999999 }, isPidAlive: () => true });
      const isAlive = (p: number) => p !== 999999; // only the seeded dead pid is dead

      let aHandle: ReturnType<typeof acquireInflightLock> | undefined;
      const lostTraces: Array<{ lockPath: string; reason: string }> = [];
      let bErr: unknown;
      let bHandle: ReturnType<typeof acquireInflightLock> | undefined;
      try {
        bHandle = acquireInflightLock(dir, "W1-T7", {
          run_id: "B",
          info: { pid: 222 },
          isPidAlive: isAlive,
          onLostReclaim: (d) => lostTraces.push(d),
          __beforeReclaimDelete: () => {
            // B has read the dead lock and judged it stale, but has NOT yet reached its
            // delete-time identity check. A's WHOLE reclaim — read, unlink, recreate —
            // runs to completion right here, before B's unlink.
            aHandle = acquireInflightLock(dir, "W1-T7", { run_id: "A", info: { pid: 111 }, isPidAlive: isAlive });
          },
        });
      } catch (e) {
        bErr = e;
      }

      // A definitely won its reclaim: it created a fresh, live lock naming pid 111.
      assert.ok(aHandle, "A's reclaim+recreate completed inside B's window");
      assert.equal(readInflightLock(dir, "W1-T7")?.pid, 111, "A's fresh lock is the one on disk");

      // B must NOT also come away holding it. With the bug, B's unconditional unlink
      // would have deleted A's fresh lock and B would hold a SECOND handle on the same
      // task — this is the FALSIFIER: it fails on the vulnerable primitive.
      assert.equal(bHandle, undefined, "B must not also hold a handle");
      assert.ok(bErr instanceof InflightLockError, "B restarts its acquire and then refuses the now-live holder");
      assert.equal((bErr as InflightLockError).holder.pid, 111, "B's refusal names A as the real holder");

      // The lost reclaim leaves an observable trace — not a swallowed empty catch.
      assert.ok(lostTraces.length >= 1, "B's lost reclaim was traced, not silently swallowed");
      assert.match(lostTraces[0].reason, /identity|vanished/);

      aHandle!.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "sweepStaleInflightLocks: a real acquire landing between the sweep's read and its " +
    "unlink keeps its live lock, and the sweep does not report it as reaped",
  () => {
    const dir = tmp();
    try {
      // The ordinary post-crash state the sweep exists to clear.
      acquireInflightLock(dir, "W1-T1", { run_id: "dead", info: { pid: 999999 }, isPidAlive: () => true });
      const isAlive = (p: number) => p !== 999999;

      let liveHandle: ReturnType<typeof acquireInflightLock> | undefined;
      const lostTraces: Array<{ lockPath: string; reason: string }> = [];
      const out = sweepStaleInflightLocks(dir, {
        isPidAlive: isAlive,
        onLostReclaim: (d) => lostTraces.push(d),
        __beforeReclaimDelete: () => {
          // A REAL acquire lands HERE — between the sweep's stale read and its
          // unlink — reclaims the same dead lock itself, and writes a fresh live one.
          liveHandle = acquireInflightLock(dir, "W1-T1", { run_id: "real", info: { pid: 555 }, isPidAlive: isAlive });
        },
      });

      assert.ok(liveHandle, "the real acquire completed inside the sweep's window");
      assert.deepEqual(out.reaped, [], "FALSIFIER: reaping here would delete the real acquirer's live lock");
      assert.deepEqual(out.kept, ["W1-T1"]);
      assert.equal(readInflightLock(dir, "W1-T1")?.pid, 555, "the live lock the real acquire created survives");
      assert.ok(lostTraces.length >= 1, "the sweep's lost reclaim was traced, not silently swallowed");

      liveHandle!.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "acquireDrainLock: two reclaimers of one dead-pid drain lock, with A's unlink+recreate " +
    "forced BEFORE B reaches its unlink, cannot both end up holding (same shared primitive)",
  () => {
    const dir = tmp();
    const path = join(dir, "state", "drain.lock");
    try {
      acquireDrainLock(path, { info: { pid: 999999, host: "h", startedAt: "t" }, isPidAlive: () => true });
      const isAlive = (p: number) => p !== 999999;

      let aHandle: ReturnType<typeof acquireDrainLock> | undefined;
      let bErr: unknown;
      let bHandle: ReturnType<typeof acquireDrainLock> | undefined;
      try {
        bHandle = acquireDrainLock(path, {
          info: { pid: 222, host: "hB", startedAt: "t" },
          isPidAlive: isAlive,
          __beforeReclaimDelete: () => {
            aHandle = acquireDrainLock(path, { info: { pid: 111, host: "hA", startedAt: "t" }, isPidAlive: isAlive });
          },
        });
      } catch (e) {
        bErr = e;
      }

      assert.ok(aHandle, "A's reclaim+recreate completed inside B's window");
      assert.equal(readDrainLock(path)?.pid, 111);
      assert.equal(bHandle, undefined, "B must not also hold a handle");
      assert.ok(bErr instanceof DrainLockError, "B restarts its acquire and then refuses the now-live holder");
      assert.equal((bErr as DrainLockError).holder.pid, 111);

      aHandle!.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── reclaimStaleLock itself: the observable-trace contract in isolation ──────

test("reclaimStaleLock: a lost reclaim (identity changed underneath it) reports through " + "onLostReclaim, not a swallowed catch", () => {
  const dir = tmp();
  const lockPath = join(dir, "x.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
  const traces: Array<{ lockPath: string; reason: string }> = [];
  try {
    const result = reclaimStaleLock(lockPath, {
      parseHolder: (raw) => JSON.parse(raw),
      isStale: () => true,
      onLostReclaim: (d) => traces.push(d),
      beforeDelete: () => {
        // Simulate another actor having already reclaimed + recreated it.
        unlinkSync(lockPath);
        writeFileSync(lockPath, JSON.stringify({ pid: 111 }));
      },
    });
    assert.equal(result.outcome, "lost");
    assert.equal(traces.length, 1, "the loss was traced, not silently swallowed");
    assert.match(traces[0].reason, /changed identity/);
    assert.equal(traces[0].lockPath, lockPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reclaimStaleLock: with no onLostReclaim override, a lost reclaim still traces (via the default console.error), never silently", () => {
  const dir = tmp();
  const lockPath = join(dir, "y.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
  const originalError = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    const result = reclaimStaleLock(lockPath, {
      parseHolder: (raw) => JSON.parse(raw),
      isStale: () => true,
      beforeDelete: () => {
        unlinkSync(lockPath);
        writeFileSync(lockPath, JSON.stringify({ pid: 111 }));
      },
    });
    assert.equal(result.outcome, "lost");
    assert.equal(calls.length, 1, "the default onLostReclaim left a console trace instead of swallowing it");
  } finally {
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The catch arms. Every test above supplies a real on-disk lock that still exists at
// delete time, so the "it vanished underneath us" and "the bytes are garbage" arms are
// unreachable from them — the CLAUDE.md #977/#978 shape: a seam whose error paths no test
// ever enters looks covered and is not.

test("reclaimStaleLock: a lock that VANISHES before the delete-time check is lost, not reclaimed", () => {
  const dir = tmp();
  const lockPath = join(dir, "vanish.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
  const traces: Array<{ lockPath: string; reason: string }> = [];
  try {
    const result = reclaimStaleLock(lockPath, {
      parseHolder: (raw) => JSON.parse(raw),
      isStale: () => true,
      onLostReclaim: (d) => traces.push(d),
      // Another actor reclaimed it and did NOT recreate — the path is simply gone.
      beforeDelete: () => unlinkSync(lockPath),
    });
    assert.equal(result.outcome, "lost", "a vanished lock must never report as reclaimed by this call");
    assert.equal(traces.length, 1, "the loss was traced, not silently swallowed");
    assert.match(traces[0].reason, /vanished/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reclaimStaleLock: unparseable lock bytes are treated as reclaimable, not thrown", () => {
  const dir = tmp();
  const lockPath = join(dir, "garbage.lock");
  writeFileSync(lockPath, "{ this is not json");
  try {
    const result = reclaimStaleLock(lockPath, {
      // The real parsers return null for garbage rather than throwing (see review.ts's
      // parseReviewStatusLockInfo) — a holder nothing can read is not a live holder.
      parseHolder: () => null,
      isStale: () => true,
    });
    assert.equal(result.outcome, "reclaimed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reclaimStaleLock: a non-ENOENT open failure propagates rather than reading as missing", () => {
  const dir = tmp();
  const lockPath = join(dir, "eacces.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
  try {
    assert.throws(
      () =>
        reclaimStaleLock(
          lockPath,
          { parseHolder: (raw) => JSON.parse(raw), isStale: () => true },
          {
            openSync: () => {
              const e = new Error("permission denied") as NodeJS.ErrnoException;
              e.code = "EACCES";
              throw e;
            },
          } as never,
        ),
      /permission denied/,
      "a real I/O error must not be swallowed into outcome: missing",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireReviewStatusLock: a lock file holding GARBAGE bytes is reclaimed, never treated as a live holder", async () => {
  const dir = tmp();
  const lockPath = join(dir, "garbage-status.lock");
  // Not JSON at all — parseReviewStatusLockInfo's catch arm. A holder nothing can parse must
  // never read as live, or a corrupt byte on disk would wedge the review-status gate forever.
  writeFileSync(lockPath, "}}not json at all{{");
  try {
    const handle = await acquireReviewStatusLock(lockPath, {
      info: { pid: process.pid },
      isPidAlive: () => true,
      timeoutMs: 2000,
      retryMs: 10,
    });
    assert.ok(handle, "the garbage lock was reclaimed rather than waited on");
    assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid, "we now hold it");
    handle.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
