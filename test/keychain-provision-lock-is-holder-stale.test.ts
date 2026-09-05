// R-3 — THE KEYCHAIN PROVISIONING LOCK IS THE LAST LOCK IN THIS REPO STILL JUDGING STALENESS BY
// PID LIVENESS ALONE, AND THE ONLY ONE WHOSE WAIT HAD NO DEADLINE.
//
// `acquireKeychainProvisionLock` (src/lib/worker-home.ts) judged a holder with
// `isStale: (held) => !isAlive(held.pid)` — the pre-W1-T368 predicate every other lock here
// (inflight-lock.ts, drain-lock.ts, review.ts's status mutex) stopped using precisely because it
// answers "is SOME process using this number", never "is it the process that wrote the lock". Its
// wait was then `Atomics.wait(20ms); continue` in an UNBOUNDED synchronous loop, reached from
// daemon.ts's boot and from worker.ts on every spawn — so a dead provisioner plus a reused pid
// froze the daemon's event loop outright: no poll ticks, no STOP/PAUSE, and a relaunch queued
// behind the same lock.
//
// The three tests below pin the three behaviours that fix has to have, and each is written so it
// FAILS on the pre-fix code rather than hanging on it:
//
//   (a) a lock whose recorded `startedAt` predates the live pid's ACTUAL start time is RECLAIMED.
//       This is the discriminator the pid-only predicate cannot make: the pid here is
//       `process.pid` — genuinely, verifiably alive — so `!isAlive(held.pid)` judges it LIVE and
//       waits. `isHolderStale`'s rung 3 compares the recorded start against the pid's real one and
//       judges it REUSED. A finite `waitDeadlineMs` is supplied so the pre-fix code turns its
//       forever-wait into a THROWN failure inside the test rather than hanging the runner — which
//       is what makes deleting the fix produce `# fail`, not a timeout with no summary.
//
//   (b) a genuinely live holder is waited on and then REFUSED BY NAME at the deadline —
//       `WorkerKeychainError`, naming the holder's pid/host/startedAt, never a silent forever-wait.
//
//   (c) a lock recorded on ANOTHER HOST is treated as live until the deadline and never reclaimed.
//       Rung 1 is deliberately the first rung: a pid is meaningful only on the host that assigned
//       it, so reclaiming here would mean stealing a lock from a peer this process cannot see.
//       (a) and (c) together are the load-bearing pair — (a) proves the new predicate reclaims
//       what the old one could not, (c) proves it did not simply become more permissive.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorkerKeychainError, acquireKeychainProvisionLock, keychainProvisionLockPath } from "../src/lib/worker-home.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-keychain-lock-"));
}

/** A five-second ceiling on the ACQUIRE ITSELF, measured with the real clock — the property (a)
 *  claims is "returns", and a poll loop that converged only after minutes would satisfy a bare
 *  `assert.ok(handle)` while still being the defect. */
const RECLAIM_MUST_RETURN_WITHIN_MS = 5_000;

/** A backstop only, and it is deliberately NOT what makes the deadline falsifiable. MEASURED
 *  while proving that: `node:test`'s own per-test timeout CANNOT interrupt the loop under test,
 *  because that loop is fully SYNCHRONOUS — deleting the deadline and running this file hangs
 *  forever with no `# tests` summary, timeout or no timeout, since a blocked event loop can never
 *  run the timer that would fire it. That is not an inconvenience to work around; it IS the defect
 *  (a wait nothing can interrupt is exactly what froze the daemon), so the deadline's own
 *  falsifier is {@link SENTINEL_SLEEP_CAP} below, which raises inside the loop rather than waiting
 *  for something outside it. This timeout stays as a bound on anything else that could wedge. */
const HUNG_TEST_TIMEOUT_MS = 15_000;

/** How many polls a bounded wait may take before the injected sleep raises instead of returning.
 *  THIS is what makes the deadline load-bearing under a delete-the-fix run: with the deadline in
 *  place (b) and (c) refuse on the FIRST pass and never sleep at all, so the cap is never
 *  approached; with it deleted the loop spins past the cap and the sentinel turns a silent,
 *  uninterruptible hang into an ordinary assertion failure with a real summary line. */
const SENTINEL_SLEEP_CAP = 50;

/** An injected {@link acquireKeychainProvisionLock} sleep that raises once the wait has clearly
 *  stopped being bounded. Never reached while the deadline works. */
function sentinelSleep(counter: { slept: number }): (ms: number) => void {
  return () => {
    counter.slept += 1;
    if (counter.slept > SENTINEL_SLEEP_CAP) {
      throw new Error(
        `SENTINEL: the provisioning-lock wait polled ${counter.slept} times without ever reaching a deadline — ` +
          "this wait is unbounded, which is the R-3 defect itself",
      );
    }
  };
}

test("R-3 (a): a provisioning lock whose recorded start time predates its LIVE pid's actual one is reclaimed — pid liveness alone judges it live forever", { timeout: HUNG_TEST_TIMEOUT_MS }, () => {
  const root = tmp();
  try {
    const keychainPath = join(root, "state", "remudero-worker.keychain-db");
    mkdirSync(join(root, "state"), { recursive: true });
    const lockPath = keychainProvisionLockPath(keychainPath);

    // THE HOLDER IS THIS VERY PROCESS'S PID — alive by construction, so no injected liveness
    // probe is needed or wanted here: `defaultIsPidAlive(process.pid)` is genuinely true, and
    // that is the whole point. What makes it STALE is the recorded start: 2020, against a process
    // that (per the injected probe below) started now. A pid that outlives the lock's own claimed
    // start by six years is a pid that was REUSED.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), startedAt: "2020-01-01T00:00:00.000Z" }, null, 2),
    );

    const startedWaitingAt = Date.now();
    const lock = acquireKeychainProvisionLock(keychainPath, {
      // The live pid's REAL start time, as rung 3 reads it. Injected rather than probed so the
      // assertion does not depend on `ps` being present or on this container's process table.
      getProcessStartTime: () => Date.now(),
      // FINITE, and short: on the pre-fix predicate this lock reads LIVE forever, so without a
      // deadline this test would HANG instead of failing. With one, deleting the fix turns the
      // hang into a thrown WorkerKeychainError and a real `# fail` line.
      waitDeadlineMs: 1_000,
    });
    const elapsedMs = Date.now() - startedWaitingAt;

    assert.ok(
      elapsedMs < RECLAIM_MUST_RETURN_WITHIN_MS,
      `the stale lock must be reclaimed promptly, not waited out; took ${elapsedMs}ms`,
    );
    assert.equal(lock.path, lockPath);

    // The reclaim REPLACED the holder rather than merely deleting it: this call now owns the lock,
    // and the file on disk names THIS process, with a host and a start time of its own.
    const held = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; host?: string; startedAt: string };
    assert.equal(held.pid, process.pid);
    assert.equal(held.host, hostname(), "the lock records this host — isHolderStale's rung 1 has nothing to read without it");
    assert.notEqual(held.startedAt, "2020-01-01T00:00:00.000Z", "the abandoned holder's payload must be gone, not reused");

    lock.release();
    assert.equal(existsSync(lockPath), false, "release removes the lock rather than leaving it for the next dispatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R-3 (b): a genuinely live holder is refused at the deadline with a WorkerKeychainError naming it — never an unbounded wait", { timeout: HUNG_TEST_TIMEOUT_MS }, () => {
  const root = tmp();
  try {
    const keychainPath = join(root, "state", "remudero-worker.keychain-db");
    mkdirSync(join(root, "state"), { recursive: true });
    const lockPath = keychainProvisionLockPath(keychainPath);

    const startedAt = new Date().toISOString();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), startedAt }, null, 2));

    const counter = { slept: 0 };
    assert.throws(
      () =>
        acquireKeychainProvisionLock(keychainPath, {
          // A live pid whose ACTUAL start time matches what the lock recorded: rung 3 finds no
          // reuse signal, so this holder is live on every rung. Exactly the case the lock is
          // RIGHT to wait on — and exactly the case that used to wait forever.
          getProcessStartTime: () => Date.parse(startedAt),
          sleepSyncMs: sentinelSleep(counter),
          waitDeadlineMs: 0,
        }),
      (e: unknown) => {
        assert.ok(e instanceof WorkerKeychainError, `expected a WorkerKeychainError, got ${String(e)}`);
        assert.equal(e.reasonClass, "keychain-provision-lock-timeout");
        assert.match(e.message, new RegExp(`holder pid ${process.pid}`), "the refusal must NAME the holder it waited on");
        assert.match(e.message, new RegExp(`on host ${hostname()}`));
        assert.ok(e.message.includes(startedAt), "the refusal must carry the holder's recorded start time");
        assert.ok(e.message.includes(lockPath), "the refusal must name the lock an operator would have to clear");
        return true;
      },
    );

    assert.equal(counter.slept, 0, "a zero deadline refuses on the first pass — the deadline is checked BEFORE sleeping, not after");
    assert.equal(existsSync(lockPath), true, "a live holder's lock is left exactly where it was; nothing was stolen");
    const held = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; startedAt: string };
    assert.equal(held.startedAt, startedAt, "the live holder's own payload is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R-3 (c): a lock recorded on ANOTHER host is treated as live until the deadline — a pid means nothing off the host that assigned it", { timeout: HUNG_TEST_TIMEOUT_MS }, () => {
  const root = tmp();
  try {
    const keychainPath = join(root, "state", "remudero-worker.keychain-db");
    mkdirSync(join(root, "state"), { recursive: true });
    const lockPath = keychainProvisionLockPath(keychainPath);

    // Everything a LOCAL probe can see says "reclaim me": the pid is not alive, and its start time
    // is unresolvable. Rung 1 refuses to consult either, because both answer a question about THIS
    // machine's process table and the holder is not on this machine. `host` is deliberately
    // human-named, not container-id-shaped, so W1-T978's container carve-out does not apply.
    const foreign = { pid: 4242, host: "some-other-box", startedAt: "2020-01-01T00:00:00.000Z" };
    writeFileSync(lockPath, JSON.stringify(foreign, null, 2));

    assert.throws(
      () =>
        acquireKeychainProvisionLock(keychainPath, {
          isPidAlive: () => false,
          getProcessStartTime: () => null,
          hostname: () => "this-box",
          inContainer: () => false,
          sleepSyncMs: sentinelSleep({ slept: 0 }),
          waitDeadlineMs: 0,
        }),
      (e: unknown) => {
        assert.ok(e instanceof WorkerKeychainError, `expected a WorkerKeychainError, got ${String(e)}`);
        assert.equal(e.reasonClass, "keychain-provision-lock-timeout");
        assert.match(e.message, /on host some-other-box/, "the refusal names the FOREIGN holder, not this host");
        return true;
      },
    );

    assert.deepEqual(
      JSON.parse(readFileSync(lockPath, "utf8")),
      foreign,
      "a foreign-host lock is never reclaimed — reclaiming it would mean stealing a peer's lock on evidence this host cannot have",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
