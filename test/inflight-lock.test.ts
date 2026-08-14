import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireInflightLock,
  InflightLockError,
  inflightLockPath,
  readInflightLock,
  withInflightLock,
  sweepStaleInflightLocks,
} from "../src/lib/inflight-lock.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-inflight-"));
}

// ── GUARD 1: no two runs of the SAME task can overlap — whatever launched them ──

test("acquireInflightLock: a 2nd run of the SAME task with a LIVE holder REFUSES, naming pid + run_id", () => {
  const dir = tmp();
  try {
    const h1 = acquireInflightLock(dir, "W1-T7", {
      run_id: "W1-T7-1784074904419",
      info: { pid: 4242, host: "boxA", startedAt: "2026-07-15T00:21:44Z" },
      isPidAlive: () => true,
    });
    assert.ok(existsSync(inflightLockPath(dir, "W1-T7")));
    assert.deepEqual(readInflightLock(dir, "W1-T7"), {
      pid: 4242,
      run_id: "W1-T7-1784074904419",
      host: "boxA",
      startedAt: "2026-07-15T00:21:44Z",
    });

    // The SECOND drain (or a manual run-task) tries the SAME task while the first is live.
    let err: unknown;
    try {
      acquireInflightLock(dir, "W1-T7", { run_id: "W1-T7-1784075267898", isPidAlive: () => true });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof InflightLockError, "a live same-task lock must throw InflightLockError");
    const de = err as InflightLockError;
    assert.equal(de.holder.pid, 4242);
    assert.equal(de.holder.run_id, "W1-T7-1784074904419");
    assert.match(de.message, /4242/, "names the holder pid");
    assert.match(de.message, /W1-T7-1784074904419/, "names the holder run_id");

    h1.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// W1-T368: the strengthened isHolderStale predicate must still honour a GENUINELY live
// holder — same host as this process, and a real start time that precedes the lock's own
// startedAt — not merely one that survives via the host-mismatch short-circuit the other
// fixtures in this file lean on (their placeholder "boxA"/"boxB" hosts).
test("acquireInflightLock: a lock whose holder is on THIS host with a start time PRECEDING the lock is honoured — refuses a 2nd acquire", () => {
  const dir = tmp();
  try {
    const lockStart = "2026-08-01T12:00:00.000Z";
    const earlierStart = "2026-08-01T00:00:00.000Z"; // the holder started BEFORE writing the lock
    acquireInflightLock(dir, "W1-T7", {
      run_id: "genuine",
      info: { pid: 4242, host: hostname(), startedAt: lockStart },
    });
    let err: unknown;
    try {
      acquireInflightLock(dir, "W1-T7", {
        run_id: "second",
        isPidAlive: () => true,
        getProcessStartTime: (pid) => (pid === 4242 ? Date.parse(earlierStart) : null),
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof InflightLockError, "the genuine holder's lock must still refuse a 2nd acquire");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireInflightLock: a DIFFERENT task is NOT blocked by another task's live lock", () => {
  const dir = tmp();
  try {
    const a = acquireInflightLock(dir, "W1-T7", { run_id: "r1", isPidAlive: () => true });
    const b = acquireInflightLock(dir, "W1-T8", { run_id: "r2", isPidAlive: () => true }); // different task ⇒ fine
    assert.ok(existsSync(inflightLockPath(dir, "W1-T7")));
    assert.ok(existsSync(inflightLockPath(dir, "W1-T8")));
    a.release();
    b.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireInflightLock: a STALE (dead-pid) lock is RECLAIMED, not refused", () => {
  const dir = tmp();
  try {
    acquireInflightLock(dir, "W1-T7", { run_id: "old", info: { pid: 999999 }, isPidAlive: () => true });
    const deadPid = (p: number) => p !== 999999;
    const h = acquireInflightLock(dir, "W1-T7", { run_id: "new", info: { pid: 321 }, isPidAlive: deadPid });
    assert.equal(readInflightLock(dir, "W1-T7")?.run_id, "new", "the stale lock was reclaimed");
    assert.equal(readInflightLock(dir, "W1-T7")?.pid, 321);
    h.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireInflightLock: a garbage/unreadable lock is treated as stale and reclaimed", () => {
  const dir = tmp();
  try {
    acquireInflightLock(dir, "W1-T7", { run_id: "seed", isPidAlive: () => true }).release();
    writeFileSync(inflightLockPath(dir, "W1-T7"), "}{ not json");
    const h = acquireInflightLock(dir, "W1-T7", { run_id: "fresh", info: { pid: 7 }, isPidAlive: () => true });
    assert.equal(readInflightLock(dir, "W1-T7")?.run_id, "fresh");
    h.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ERROR-PATH RELEASE: a crash must not leave a permanent stale lock ──

test("withInflightLock: RELEASES the lock even when the body THROWS (error path)", () => {
  const dir = tmp();
  try {
    let threw = false;
    try {
      withInflightLock(dir, "W1-T7", () => {
        assert.ok(existsSync(inflightLockPath(dir, "W1-T7")), "held inside the body");
        throw new Error("boom");
      }, { run_id: "r", isPidAlive: () => true });
    } catch (e) {
      threw = true;
      assert.match((e as Error).message, /boom/);
    }
    assert.ok(threw);
    assert.ok(!existsSync(inflightLockPath(dir, "W1-T7")), "released on the error path");
    // proof the release is real: re-acquire without a stale-lock fight
    acquireInflightLock(dir, "W1-T7", { run_id: "r2", isPidAlive: () => true }).release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release() is idempotent and removes the file", () => {
  const dir = tmp();
  try {
    const h = acquireInflightLock(dir, "W1-T7", { run_id: "r", isPidAlive: () => true });
    h.release();
    assert.ok(!existsSync(inflightLockPath(dir, "W1-T7")));
    h.release(); // no throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── boot-time reap of locks whose holder is gone (R-35) ─────────────────────
// OBSERVABILITY, not liveness: acquireInflightLock already steals a dead
// holder's lock, so a stale lock has never blocked dispatch. It lingers because
// it is only cleared by the NEXT acquire of that same task — and a
// circuit-broken task is never re-dispatched. Observed 2026-07-21: W1-T1.lock
// held pid 65304, dead since 2026-07-19, still present two days later.

test("sweepStaleInflightLocks: a lock whose holder pid is DEAD is reaped", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-sweep-"));
  acquireInflightLock(dir, "W1-T1", { run_id: "R1", info: { pid: 65304, host: hostname(), startedAt: "t" } });
  const out = sweepStaleInflightLocks(dir, { isPidAlive: () => false });
  assert.deepEqual(out.reaped, ["W1-T1"]);
  assert.deepEqual(out.kept, []);
  assert.equal(readInflightLock(dir, "W1-T1"), null, "the lock file is actually gone from disk");
});

test("sweepStaleInflightLocks: a lock whose holder is ALIVE is left strictly alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-sweep-"));
  acquireInflightLock(dir, "W1-T184", { run_id: "R2" });
  const out = sweepStaleInflightLocks(dir, { isPidAlive: () => true });
  assert.deepEqual(out.reaped, [], "FALSIFIER: reaping a LIVE holder's lock would let a second run of the same task start");
  assert.deepEqual(out.kept, ["W1-T184"]);
  assert.ok(readInflightLock(dir, "W1-T184"), "the live lock survives");
});

test("sweepStaleInflightLocks: mixed dir reaps only the dead, and ignores non-lock files", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-sweep-"));
  acquireInflightLock(dir, "DEAD-1", { run_id: "R1", info: { pid: 1, host: hostname(), startedAt: "t" } });
  acquireInflightLock(dir, "LIVE-1", { run_id: "R2", info: { pid: 2, host: hostname(), startedAt: "t" } });
  writeFileSync(join(dir, "notes.txt"), "not a lock");
  const out = sweepStaleInflightLocks(dir, { isPidAlive: (pid) => pid === 2 });
  assert.deepEqual(out.reaped, ["DEAD-1"]);
  assert.deepEqual(out.kept, ["LIVE-1"]);
  assert.ok(existsSync(join(dir, "notes.txt")), "a non-.lock file is never touched");
});

test("sweepStaleInflightLocks: an unparseable lock names no live holder, so it is reaped", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-sweep-"));
  writeFileSync(join(dir, "GARBAGE.lock"), "{ not json");
  const out = sweepStaleInflightLocks(dir, { isPidAlive: () => true });
  assert.deepEqual(out.reaped, ["GARBAGE"], "leaving it would preserve the misleading state this exists to remove");
});

test("sweepStaleInflightLocks: a missing directory is a no-op, never a throw at boot", () => {
  const out = sweepStaleInflightLocks(join(tmpdir(), "rmd-does-not-exist-" + process.pid));
  assert.deepEqual(out, { reaped: [], kept: [], live: [], unverifiableForeignHost: [] });
});

// ── W1-T461: `kept` collapsed a confirmed-live holder with an unverifiable foreign-host one ──
// into one bucket, so a container replacement's permanently-stuck lock (isHolderStale's rung 1,
// W1-T396, never reaps a foreign host) read exactly like a healthy live worker. These prove the
// split, without touching isHolderStale's ordering or return shape.

test("sweepStaleInflightLocks: a SAME-HOST live holder is reported as `live`, not `unverifiableForeignHost`", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-sweep-"));
  try {
    acquireInflightLock(dir, "W1-T184", { run_id: "R2", info: { host: hostname() } });
    const out = sweepStaleInflightLocks(dir, { isPidAlive: () => true });
    assert.deepEqual(out.reaped, []);
    assert.deepEqual(out.kept, ["W1-T184"], "still counted in the total kept, for callers that only want that");
    assert.deepEqual(out.live, ["W1-T184"], "a same-host confirmed-alive holder is `live`");
    assert.deepEqual(out.unverifiableForeignHost, [], "never named here — it names no foreign host");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepStaleInflightLocks: a lock naming a DIFFERENT host is reported as `unverifiableForeignHost`, with its own count distinct from `live`", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-sweep-"));
  try {
    // isPidAlive/getProcessStartTime are never even consulted for a foreign host — rung 1 of
    // isHolderStale short-circuits before either fires — so wiring them to throw proves this
    // classification never reaches past the host check either.
    writeFileSync(
      inflightLockPath(dir, "W1-T395"),
      JSON.stringify({ pid: 4242, run_id: "stranded", host: "container-shaped-abc123", startedAt: "2026-08-11T00:00:00Z" }),
    );
    const out = sweepStaleInflightLocks(dir, {
      isPidAlive: () => {
        throw new Error("must not probe a foreign host's pid table");
      },
    });
    assert.deepEqual(out.reaped, [], "a foreign-host lock is never reaped by this classification");
    assert.deepEqual(out.kept, ["W1-T395"]);
    assert.deepEqual(out.live, [], "NOT reported as live — that would claim a verification that never happened");
    assert.deepEqual(out.unverifiableForeignHost, ["W1-T395"], "distinct count from `live`, per the split");
    assert.ok(existsSync(inflightLockPath(dir, "W1-T395")), "no lock naming a foreign host is deleted by this change");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepStaleInflightLocks: a SAME-HOST dead holder is still reaped exactly as before — W1-T396's ordering untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-sweep-"));
  try {
    acquireInflightLock(dir, "W1-T1", { run_id: "R1", info: { pid: 65304, host: hostname(), startedAt: "t" } });
    const out = sweepStaleInflightLocks(dir, { isPidAlive: () => false });
    assert.deepEqual(out.reaped, ["W1-T1"], "a same-host dead holder is reaped, same as pre-split behaviour");
    assert.deepEqual(out.kept, []);
    assert.deepEqual(out.live, []);
    assert.deepEqual(out.unverifiableForeignHost, []);
    assert.equal(readInflightLock(dir, "W1-T1"), null, "the lock file is actually gone from disk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepStaleInflightLocks: mixed dir — foreign-host, same-host live, and same-host dead all classify independently", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-sweep-"));
  try {
    writeFileSync(
      inflightLockPath(dir, "FOREIGN-1"),
      JSON.stringify({ pid: 1, run_id: "f", host: "some-other-container", startedAt: "2026-08-11T00:00:00Z" }),
    );
    acquireInflightLock(dir, "LIVE-1", { run_id: "l", info: { pid: 2, host: hostname(), startedAt: "t" } });
    acquireInflightLock(dir, "DEAD-1", { run_id: "d", info: { pid: 3, host: hostname(), startedAt: "t" } });
    const out = sweepStaleInflightLocks(dir, { isPidAlive: (pid) => pid === 2 });
    assert.deepEqual(out.reaped, ["DEAD-1"]);
    assert.deepEqual(out.live.sort(), ["LIVE-1"]);
    assert.deepEqual(out.unverifiableForeignHost, ["FOREIGN-1"]);
    assert.deepEqual(out.kept.sort(), ["FOREIGN-1", "LIVE-1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
