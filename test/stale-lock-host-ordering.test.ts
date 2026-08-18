import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultInContainer, isHolderStale } from "../src/lib/fs-race-safe.js";
import { acquireInflightLock, InflightLockError, inflightLockPath } from "../src/lib/inflight-lock.js";

// W1-T396 — `isHolderStale`'s host guard was ordered BEHIND the pid probe, so it was
// reachable only when a foreign pid happened to collide with a live LOCAL process. The
// genuine cross-host case (a foreign pid absent from this machine's table) fell through
// rung 1 to STALE and was reclaimed — two workers holding the same task, silently.
//
// WHICH PROBES ARE REAL AND WHICH ARE SEAMS, stated per test rather than in aggregate:
//   - `hostname` is NEVER injected below except where a test says so. Every call site in
//     production (drain-lock, inflight-lock ×2, status.ts) omits it too, so these tests
//     drive the SAME `os.hostname()` default production resolves.
//   - `isPidAlive` is a REQUIRED opt with no default — every caller, production included,
//     supplies one. Injecting it is not a seam-substitution, it is the only calling form.
//   - `getProcessStartTime` IS a seam and is injected in the rung-3 tests; the real
//     `defaultGetProcessStartTime` shells out to `ps` and is covered by
//     test/lock-holder-identity.test.ts, not re-proven here.

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-host-order-"));
}

/** A host name that is not this machine's, derived from the real one so it can never
 *  accidentally equal it. */
const FOREIGN_HOST = `${hostname()}-definitely-not-this-machine`;

/** A container-id-SHAPED foreign host — 12 lowercase hex characters, matching what
 *  `looksLikeContainerId` (fs-race-safe.ts) requires — but never equal to this machine's own
 *  `hostname()` (flips its first hex digit if the real hostname already happens to look like a
 *  container id). `FOREIGN_HOST` above is deliberately NOT this shape (it is used to prove the
 *  shape gate refuses an arbitrary foreign host), so any test that needs W1-T978's container
 *  branch to actually FIRE uses this one instead. */
const FOREIGN_CONTAINER_HOST = (() => {
  const HEX = "0123456789abcdef";
  const real = hostname();
  const base = /^[0-9a-f]{12}$/.test(real) ? real : "5efb86ede91b";
  return HEX[(HEX.indexOf(base[0]) + 1) % 16] + base.slice(1);
})();

// ── The recorded shape: what production actually writes into `host` ──────────────

test("the WRITER records host as os.hostname() — the real acquire path, not a fixture assumption", () => {
  const dir = tmp();
  const handle = acquireInflightLock(dir, "W1-T396", { run_id: "W1-T396-1", isPidAlive: () => false });
  try {
    const onDisk = JSON.parse(readFileSync(inflightLockPath(dir, "W1-T396"), "utf8")) as { host?: string };
    // The value the comparator defaults to and the value the writer records must be the
    // same string, or the guard compares a field nothing populates in that shape.
    assert.equal(onDisk.host, hostname());
  } finally {
    handle.release();
  }
});

// ── DIRECTION 1: the fix — a foreign holder is NOT reclaimable ───────────────────

test("a lock held by a DIFFERENT host is NOT stale even when its pid is absent from this machine's table", () => {
  // The genuine cross-host case: the foreign pid means nothing here, so the local table
  // does not contain it. Before W1-T396 rung 1 answered STALE and the host guard never ran.
  //
  // W1-T978 pins `inContainer: () => false` explicitly, because THIS test's whole point is the
  // real-machine reading, and rung 1 now decides differently once it is told it is running in a
  // container (see the W1-T978 section below) — a genuine machine's own hostname is stable, so
  // this scenario must stay resolved this way regardless of which pole runs the suite.
  const held = { pid: 999_999, host: FOREIGN_HOST, startedAt: "2026-08-01T00:00:00.000Z" };
  const stale = isHolderStale(held, {
    isPidAlive: () => false, // absent locally — the ORDINARY cross-host reading
    getProcessStartTime: () => {
      throw new Error("must not be called — a foreign host is unresolvable before any local probe");
    },
    inContainer: () => false,
  });
  assert.equal(stale, false, "a holder this machine cannot verify must never be judged stale");
});

test("the foreign-host holder stays not-stale when its pid COINCIDENTALLY collides with a live local process", () => {
  // The only branch reachable before W1-T396. Kept so the reorder is proven to withdraw
  // nothing that already worked. `inContainer: () => false` for the same reason as the test
  // above — this is the real-machine reading, pinned so it holds on every pole.
  const held = { pid: 4242, host: FOREIGN_HOST, startedAt: "2026-08-01T00:00:00.000Z" };
  assert.equal(isHolderStale(held, { isPidAlive: () => true, inContainer: () => false }), false);
});

// ── DIRECTION 2: the regression lock — same-host dead holders MUST stay reclaimable ──

test("REGRESSION LOCK: a SAME-host holder with a dead pid is STILL stale, so an abandoned lock stays reclaimable", () => {
  // This is the direction that matters most. A reorder that over-corrects makes every lock
  // permanent, which is strictly worse than the bug: reclaim is the ONLY recovery for a
  // SIGKILLed run, and the signal handlers in run-task.ts release the DRAIN lock only —
  // never a per-task inflight lock — so a signalled run strands its inflight lock too.
  const held = { pid: 999_998, host: hostname(), startedAt: "2026-08-01T00:00:00.000Z" };
  const stale = isHolderStale(held, { isPidAlive: () => false });
  assert.equal(stale, true, "a dead holder on THIS machine must remain reclaimable");
});

test("REGRESSION LOCK: a holder recording NO host at all keeps the pre-W1-T368 pid-only behaviour", () => {
  // `host` is optional on HolderIdentity; an absent one must not become unreclaimable.
  assert.equal(isHolderStale({ pid: 999_997 }, { isPidAlive: () => false }), true);
  assert.equal(isHolderStale({ pid: 999_997 }, { isPidAlive: () => true }), false);
});

// ── Rung 3 is still reachable — the reorder withdraws no detection that exists today ──

test("the SAME-host pid-reuse rung still fires, so reordering withdraws no detection", () => {
  const lockStart = Date.parse("2026-08-01T00:00:00.000Z");
  const held = { pid: 4243, host: hostname(), startedAt: "2026-08-01T00:00:00.000Z" };
  const stale = isHolderStale(held, {
    isPidAlive: () => true,
    getProcessStartTime: () => lockStart + 60_000, // started a minute AFTER the lock — reuse
  });
  assert.equal(stale, true, "a pid that started after the lock is a different, newer process");
  // POSITIVE CONTRAST, same record, only the start time moved: a process that predates the
  // lock is the original holder and must stay live.
  const notStale = isHolderStale(held, {
    isPidAlive: () => true,
    getProcessStartTime: () => lockStart - 60_000,
  });
  assert.equal(notStale, false, "the original holder must not be reclaimed");
});

// ── The consequence, end to end through the real acquire path ───────────────────

test("acquireInflightLock REFUSES to steal a foreign-host lock whose pid is absent locally — the two-workers case", () => {
  // acquireInflightLock is an UNEDITED call site (W1-T978 design note iv): it never forwards
  // `inContainer`, so it always resolves through isHolderStale's REAL default probe. This still
  // holds unconditionally, on every pole, because FOREIGN_HOST is not container-id-shaped —
  // W1-T978's shape gate (see "a host that merely LOOKS container-ish by name" below) refuses it
  // regardless of whether THIS process happens to be containerised. Only a `host` actually
  // shaped like a container id gets the new behaviour; W1-T978's own tests below cover that
  // case directly rather than through this synthetic, human-suffixed fixture.
  const dir = tmp();
  const lockPath = inflightLockPath(dir, "W1-T396-e2e");
  acquireInflightLock(dir, "W1-T396-e2e", { run_id: "seed", isPidAlive: () => false }).release();
  // Re-plant the lock as a FOREIGN host's, with a pid this machine does not have.
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999_996, run_id: "foreign-run", host: FOREIGN_HOST, startedAt: "2026-08-01T00:00:00.000Z" }),
  );
  // Real acquireInflightLock, real reclaimStaleLock, real isHolderStale. Only isPidAlive is
  // supplied, exactly as production supplies it.
  assert.throws(
    () => acquireInflightLock(dir, "W1-T396-e2e", { run_id: "second-worker", isPidAlive: () => false }),
    InflightLockError,
    "a second worker must not acquire a task a foreign host still holds",
  );
  // And the foreign lock is still on disk, unreclaimed.
  const after = JSON.parse(readFileSync(lockPath, "utf8")) as { run_id?: string };
  assert.equal(after.run_id, "foreign-run", "the foreign holder's lock must survive untouched");
});

test("acquireInflightLock STILL reclaims a SAME-host lock whose pid is dead — recovery is preserved", () => {
  const dir = tmp();
  const lockPath = inflightLockPath(dir, "W1-T396-recover");
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999_995, run_id: "dead-run", host: hostname(), startedAt: "2026-08-01T00:00:00.000Z" }),
  );
  const handle = acquireInflightLock(dir, "W1-T396-recover", { run_id: "recovering", isPidAlive: () => false });
  try {
    const after = JSON.parse(readFileSync(lockPath, "utf8")) as { run_id?: string };
    assert.equal(after.run_id, "recovering", "an abandoned same-host lock must be reclaimable");
  } finally {
    handle.release();
  }
});

// ── W1-T978: a replaced container can reclaim its own abandoned lock ────────────
//
// os.hostname() INSIDE A CONTAINER IS THE CONTAINER ID, so `held.host` (written by the
// container that has since been replaced) never again equals `myHost` (this container's) —
// even though nothing genuinely foreign ever touched the lock. Fixture values below are the
// ones MEASURED during the live outage this task fixes: state/drain.lock held
// {"pid":46,"host":"5efb86ede91b",...}; the replacement container was eae16667008a; rung 1
// compared the two, found them different, and refused to boot forever.

test("W1-T978: a replaced container's own abandoned lock is reclaimable", () => {
  const held = { pid: 46, host: "5efb86ede91b", startedAt: "2026-08-18T02:04:23.465Z" };
  const stale = isHolderStale(held, {
    isPidAlive: () => false,
    inContainer: () => true, // this process is the replacement container, eae16667008a
  });
  assert.equal(stale, true, "a replaced container must be able to reclaim its own abandoned lock");
});

test("W1-T978: a lock from a genuinely different machine is still never reclaimed", () => {
  // The falsifier for "just drop rung 1" (design note i): off a container's local bind mount,
  // a host mismatch is exactly as unverifiable as it always was, and must stay that way.
  const held = { pid: 999_994, host: FOREIGN_HOST, startedAt: "2026-08-01T00:00:00.000Z" };
  const stale = isHolderStale(held, {
    isPidAlive: () => false,
    inContainer: () => false, // a real machine — no bind-mount alibi for the mismatch
  });
  assert.equal(stale, false, "off this machine's own bind mount, a host mismatch is still unresolvable");
});

test("W1-T978: a live process reusing the recorded pid does not make a lock reclaimable", () => {
  // The falsifier for "fall through to rung 2/3 in a container" (design note ii, the attractive
  // wrong fix): a container's pid NAMESPACE resets on every replacement (measured: the
  // abandoned lock's pid 46 came back as pid 49 in the replacement), so the recorded pid is
  // exactly as likely to collide with a live, UNRELATED local process as to look cleanly dead.
  // Neither call below may fire — the container branch must decide this WITHOUT the local
  // process table, so a pid collision never gets a vote either way.
  const held = { pid: 46, host: "5efb86ede91b", startedAt: "2026-08-18T02:04:23.465Z" };
  const stale = isHolderStale(held, {
    isPidAlive: () => {
      throw new Error("must not be called — the container branch never consults the local pid table");
    },
    getProcessStartTime: () => {
      throw new Error("must not be called — the container branch never consults process start time");
    },
    inContainer: () => true,
  });
  assert.equal(stale, true, "reclamation must not hinge on a pid the new container's namespace cannot vouch for");
});

test("W1-T978: the container discriminator runs its real probe when nothing is injected", () => {
  // Environment-independent by construction: the expectation is computed from the SAME real
  // probe isHolderStale falls back to, so this holds whether the suite runs on the mini, ci, or
  // the containerised azure host (host-parity.ts's three poles) without hardcoding any of them.
  // Uses FOREIGN_CONTAINER_HOST (not FOREIGN_HOST) so the shape gate never masks what this test
  // is actually proving — it is the ONLY thing left to vary once the shape already matches.
  const held = { pid: 999_993, host: FOREIGN_CONTAINER_HOST, startedAt: "2026-08-01T00:00:00.000Z" };
  const reallyInContainer = defaultInContainer();
  const stale = isHolderStale(held, { isPidAlive: () => false }); // opts.inContainer omitted
  assert.equal(
    stale,
    reallyInContainer,
    "omitting inContainer must fall back to the REAL /.dockerenv probe, not a hardcoded answer",
  );
});

test("defaultInContainer reads the injected /.dockerenv probe rather than the real filesystem when given one", () => {
  assert.equal(defaultInContainer({ existsSync: () => true }), true);
  assert.equal(defaultInContainer({ existsSync: () => false }), false);
});

test("W1-T978: a host that merely LOOKS container-ish by name is still not reclaimed in a container", () => {
  // The shape gate, falsified: "container-shaped-abc123" (the exact fixture
  // test/daemon.test.ts's runInflightLockSweepRung test already uses for "a host this process
  // can never verify or clear") is not actually 12 or 64 lowercase hex characters, so it must
  // stay unverifiable even though this process is (for this test) containerised — the discovery
  // that motivated adding the shape check at all: "am I in a container" alone would have swept
  // this in and silently changed what every OTHER foreign-host test in this repo asserts.
  const held = { pid: 4242, host: "container-shaped-abc123", startedAt: "2026-08-11T00:00:00Z" };
  const stale = isHolderStale(held, { isPidAlive: () => false, inContainer: () => true });
  assert.equal(stale, false, "a host that is not actually container-id-shaped is never this cell's own history");
});
