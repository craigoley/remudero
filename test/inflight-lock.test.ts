import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireInflightLock,
  InflightLockError,
  inflightLockPath,
  readInflightLock,
  withInflightLock,
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
