import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireDrainLock,
  DrainLockError,
  readDrainLock,
  withDrainLock,
} from "../src/lib/drain-lock.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-drainlock-"));
}

// ── GUARD 1: two drains cannot co-run — a live holder REFUSES, a dead one is reclaimed ──

test("acquireDrainLock: writes {pid,host,startedAt}; a 2nd acquire with a LIVE holder REFUSES and names the pid", () => {
  const dir = tmp();
  const path = join(dir, "state", "drain.lock");
  try {
    const alive = () => true; // the holder's pid is alive
    const h1 = acquireDrainLock(path, {
      info: { pid: 4242, host: "boxA", startedAt: "2026-07-15T00:20:57.452Z" },
      isPidAlive: alive,
    });
    assert.ok(existsSync(path), "lock file is written on acquire");
    assert.deepEqual(readDrainLock(path), { pid: 4242, host: "boxA", startedAt: "2026-07-15T00:20:57.452Z" });

    // A second drain, while the first's pid is alive, must be refused — and name the holder.
    let err: unknown;
    try {
      acquireDrainLock(path, { isPidAlive: alive });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof DrainLockError, "a live lock must throw DrainLockError");
    const de = err as DrainLockError;
    assert.equal(de.holder.pid, 4242);
    assert.match(de.message, /4242/, "the refusal message names the running pid");
    assert.match(de.message, /2026-07-15T00:20:57\.452Z/, "the refusal message names the start time");

    h1.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireDrainLock: a STALE lock (holder pid DEAD) is RECLAIMED, not refused", () => {
  const dir = tmp();
  const path = join(dir, "state", "drain.lock");
  try {
    // A crashed prior drain left a lock naming a now-dead pid (acquire creates state/).
    acquireDrainLock(path, { info: { pid: 9999, host: "boxA", startedAt: "t0" }, isPidAlive: () => true });
    assert.equal(readDrainLock(path)?.pid, 9999);

    const deadPid = (p: number) => p !== 9999; // 9999 is dead, everything else alive
    const h = acquireDrainLock(path, { info: { pid: 123, host: "boxB", startedAt: "t1" }, isPidAlive: deadPid });
    assert.equal(readDrainLock(path)?.pid, 123, "the stale lock was reclaimed by the new holder");
    h.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireDrainLock: an UNREADABLE/garbage lock is treated as stale and reclaimed", () => {
  const dir = tmp();
  const path = join(dir, "state", "drain.lock");
  try {
    acquireDrainLock(path, { isPidAlive: () => true }).release(); // create state dir
    writeFileSync(path, "}{ not json");
    const h = acquireDrainLock(path, { info: { pid: 7, host: "h", startedAt: "t" }, isPidAlive: () => true });
    assert.equal(readDrainLock(path)?.pid, 7);
    h.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ERROR-PATH RELEASE: a crash must not leave a permanent stale lock ──

test("withDrainLock: RELEASES the lock even when the body THROWS (error path)", () => {
  const dir = tmp();
  const path = join(dir, "state", "drain.lock");
  try {
    let threw = false;
    try {
      withDrainLock(path, () => {
        assert.ok(existsSync(path), "lock is held inside the body");
        throw new Error("boom");
      }, { isPidAlive: () => true });
    } catch (e) {
      threw = true;
      assert.match((e as Error).message, /boom/);
    }
    assert.ok(threw, "the body error propagates");
    assert.ok(!existsSync(path), "the lock is released on the error path");

    // proof the release is real: a subsequent acquire succeeds without a stale-lock fight
    const h = acquireDrainLock(path, { isPidAlive: () => true });
    assert.ok(existsSync(path));
    h.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release() is idempotent and removes the file", () => {
  const dir = tmp();
  const path = join(dir, "state", "drain.lock");
  try {
    const h = acquireDrainLock(path, { isPidAlive: () => true });
    h.release();
    assert.ok(!existsSync(path));
    h.release(); // no throw on double release
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
