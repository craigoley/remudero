// R-4 — updateProposalRegistry's LOCK (state/inbox-proposals.json.lock) judged staleness by
// `isAlive(held.pid)` ALONE and reclaimed by an UNCONDITIONAL `unlinkSync` — the exact pid-only
// predicate and exact unconditional reclaim W1-T368/W1-T289 already replaced everywhere else in
// this repo (inflight-lock.ts, drain-lock.ts, review.ts's status mutex, and R-3's
// acquireKeychainProvisionLock). Two failure modes:
//
//   (a) a live pid that is NOT the holder (the number was REUSED by an unrelated process) reads
//       as "live" forever under pid-liveness alone, so every update against it throws after
//       maxWaitMs even though the recorded holder is long gone.
//   (b) reclaiming a genuinely dead lock via a bare `unlinkSync` is conditioned on nothing but the
//       stale READ: two reclaimers of the SAME dead lock can both decide "stale", and the second's
//       unconditional unlink can delete the FIRST's freshly-created live lock rather than the dead
//       one it actually judged — losing whichever update landed in between.
//
// The fix reroutes updateProposalRegistry's reclaim through the SAME shared primitives every
// other lock in this repo already uses: {@link isHolderStale} (host + pid-liveness + start-time
// reuse) and {@link reclaimStaleLock} (delete conditioned on the lock's own on-disk dev+ino+bytes
// identity). (a) and (b) below are each written to FAIL on the pre-fix code — (a) directly, by
// deleting isHolderStale's use (see the header comment on that test); (b) because the pre-fix
// code has no `__beforeReclaimDelete` seam to interpose through at all, so the forced race this
// test drives never happens and the assertion on A's landed write comes up empty. (c) pins the
// property the fix must NOT regress: a genuinely live, non-reused holder still blocks the caller
// for up to maxWaitMs, exactly as today.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseProposalRegistry, updateProposalRegistry, type Proposal } from "../src/lib/inbox.js";

function tmpRegistry(): { dir: string; registryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inbox-registry-holder-stale-"));
  return { dir, registryPath: join(dir, "state", "inbox-proposals.json") };
}

function proposal(id: string): Proposal {
  return { id, summary: `proposal ${id}`, evidenceAnchors: [] };
}

/** A five-second ceiling on the reclaim itself — the property (a) claims is "returns promptly",
 *  not merely "returns eventually". Mirrors test/keychain-provision-lock-is-holder-stale.test.ts's
 *  own RECLAIM_MUST_RETURN_WITHIN_MS. */
const RECLAIM_MUST_RETURN_WITHIN_MS = 5_000;

test(
  "R-4 (a): a lock naming a LIVE pid that is NOT the holder (pid reuse) is reclaimed and the " +
    "update lands -- FALSIFIER: deleting isHolderStale's use (reverting to bare pid-liveness) " +
    "makes this hang until maxWaitMs and throw instead",
  () => {
    const { dir, registryPath } = tmpRegistry();
    try {
      updateProposalRegistry(registryPath, () => [proposal("seed")]);
      const lockPath = `${registryPath}.lock`;

      // THE HOLDER IS THIS VERY PROCESS'S PID -- alive by construction, so no injected liveness
      // probe is needed or wanted: `defaultIsPidAlive(process.pid)` is genuinely true, and that is
      // the whole point pid-liveness alone cannot see past. What makes it STALE is the recorded
      // start: 2020, against a process that (per the injected probe below) started just now -- a
      // pid that outlives the lock's own claimed start by six years is a pid that was REUSED.
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: "2020-01-01T00:00:00.000Z" }));

      const startedWaitingAt = Date.now();
      const result = updateProposalRegistry(registryPath, (current) => [...current, proposal("landed")], {
        // The live pid's REAL start time, as isHolderStale's rung 3 reads it. Injected rather
        // than probed via `ps` so this assertion does not depend on that binary's presence.
        getProcessStartTime: () => Date.now(),
        maxWaitMs: 5_000,
        pollIntervalMs: 5,
      });
      const elapsedMs = Date.now() - startedWaitingAt;

      assert.ok(elapsedMs < RECLAIM_MUST_RETURN_WITHIN_MS, `the stale lock must be reclaimed promptly, not waited out; took ${elapsedMs}ms`);
      assert.deepEqual(
        (result ?? []).map((p) => p.id),
        ["seed", "landed"],
        "the update must actually land -- a reclaim that merely clears the lock without retrying the write would satisfy timing alone",
      );
      assert.deepEqual(parseProposalRegistry(readFileSync(registryPath, "utf8")).map((p) => p.id), ["seed", "landed"]);
      assert.equal(existsSync(lockPath), false, "the lock is released again after the reclaimed update completes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "R-4 (b): two concurrent reclaimers of one dead lock never both land a write -- the loser's " +
    "reclaim is lost and it retries against the winner's fresh state, applying both updates in " +
    "order -- FALSIFIER: the pre-fix unconditional unlinkSync has no interposition seam, so A never " +
    "runs inside B's window and the assertion on A's landed write comes up empty",
  () => {
    const { dir, registryPath } = tmpRegistry();
    try {
      updateProposalRegistry(registryPath, () => [proposal("seed")]);
      const lockPath = `${registryPath}.lock`;
      // A crashed prior holder -- dead pid, real host, an ancient startedAt -- the ordinary
      // post-crash state this lock is reclaimed out of every day.
      writeFileSync(lockPath, JSON.stringify({ pid: 999_999, host: hostname(), startedAt: "2020-01-01T00:00:00.000Z" }));

      let aResult: Proposal[] | null | undefined;
      const bResult = updateProposalRegistry(registryPath, (current) => [...current, proposal("B")], {
        isPidAlive: (pid) => pid !== 999_999, // only the seeded dead pid is dead
        __beforeReclaimDelete: () => {
          // B has read the dead lock and judged it stale, but has NOT yet reached its
          // delete-time identity check. A's WHOLE updateProposalRegistry call -- its own
          // reclaim, a real read-modify-write, and release -- runs to completion right here,
          // inside B's window. Single-threaded JS makes this a faithful, deterministic
          // reproduction of the interleaving rather than a sleep-based test passing by luck.
          aResult = updateProposalRegistry(registryPath, (current) => [...current, proposal("A")], {
            isPidAlive: (pid) => pid !== 999_999,
          });
        },
      });

      assert.deepEqual(
        (aResult ?? []).map((p) => p.id),
        ["seed", "A"],
        "A's reclaim-and-write must land its own update over the reclaimed seed, inside B's window",
      );
      assert.deepEqual(
        (bResult ?? []).map((p) => p.id),
        ["seed", "A", "B"],
        "B's update must be computed against A's already-written result, off B's OWN retry after losing the race -- neither update is lost",
      );
      assert.deepEqual(parseProposalRegistry(readFileSync(registryPath, "utf8")).map((p) => p.id), ["seed", "A", "B"]);
      assert.equal(existsSync(lockPath), false, "the lock is released again after both updates complete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "R-4 (c): a genuinely live, non-reused holder still blocks the caller within maxWaitMs -- " +
    "staleness never overrides a real live holder",
  () => {
    const { dir, registryPath } = tmpRegistry();
    try {
      updateProposalRegistry(registryPath, () => [proposal("seed")]);
      const lockPath = `${registryPath}.lock`;
      const startedAt = new Date().toISOString();
      // This process's OWN pid, with a recorded start time matching what the injected probe
      // below reports as its ACTUAL start -- no reuse signal on any rung, so this is the
      // ordinary "the previous caller is still mid-critical-section" case, not a crash.
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), startedAt }));

      let polls = 0;
      const result = updateProposalRegistry(registryPath, (current) => [...current, proposal("after-wait")], {
        getProcessStartTime: () => Date.parse(startedAt),
        maxWaitMs: 5_000,
        pollIntervalMs: 5,
        sleep: () => {
          polls += 1;
          if (polls === 3) writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), startedAt })); // no-op rewrite: still held
          if (polls === 5) rmSync(lockPath, { force: true }); // the real holder finally releases
        },
      });

      assert.ok(polls >= 5, `the caller must genuinely wait on the live holder rather than reclaiming it early; polled ${polls} times`);
      assert.deepEqual((result ?? []).map((p) => p.id), ["seed", "after-wait"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "R-4 (c, timeout side): a live holder that outlasts maxWaitMs still makes the caller throw " +
    "loud, naming the holder pid -- the fix must not turn a real deadlock into a silent reclaim",
  () => {
    const { dir, registryPath } = tmpRegistry();
    try {
      updateProposalRegistry(registryPath, () => [proposal("seed")]);
      const lockPath = `${registryPath}.lock`;
      const startedAt = new Date().toISOString();
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), startedAt }));

      assert.throws(
        () =>
          updateProposalRegistry(registryPath, (current) => [...current, proposal("unreachable")], {
            getProcessStartTime: () => Date.parse(startedAt),
            maxWaitMs: 20,
            pollIntervalMs: 5,
            sleep: () => {},
          }),
        new RegExp(`timed out.*pid ${process.pid}`),
      );
      assert.equal(existsSync(lockPath), true, "a live holder's lock is left exactly where it was -- nothing was stolen");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
