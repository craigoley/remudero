import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ReviewStatusLockTimeoutError, acquireReviewStatusLock } from "../src/lib/review.js";
import { makeTempDir } from "../src/lib/tmp.js";

// ── W1-T3335 — A DEAD CONTAINER'S CLAIM MUST NOT OUTLIVE IT ───────────────────────────────────
//
// `acquireReviewStatusLock` reclaims a stale holder, but judged staleness as `!isPidAlive(pid)`
// alone — asking THIS container's process table about a pid ANOTHER container recorded. Those are
// different namespaces: a holder that died with its container reads LIVE the moment its pid number
// is reused here, and the lock is then never reclaimed.
//
// MEASURED on the fleet host 2026-09-10: 11 review-decision claims going back to Sep 4, none
// reclaimable. One recorded pid 69 on container d9089a2551dc, and the CURRENT container's pid 69
// was the live daemon. Because `claimReviewDecision` acquires with `timeoutMs: 0`, a present lock
// is an immediate `in_flight`, which `runReview` turns into a capped `failure` verdict — #4992 and
// #5004 were unmergeable for hours behind a claim whose owner died in a heap abort.

const lockIn = (dir: string) => join(dir, "review-decision-claims", "v2-deadbeef.lock");

function writeHeldLock(dir: string, holder: { pid: number; host: string; startedAt: string }): string {
  const path = lockIn(dir);
  mkdirSync(join(dir, "review-decision-claims"), { recursive: true });
  writeFileSync(path, JSON.stringify(holder, null, 2));
  return path;
}

test("W1-T3335: a claim recorded by a GONE container is reclaimed even when its pid is alive here", async () => {
  const dir = makeTempDir("w1-t3335-claim-");
  // The exact shape that pinned #4992: a foreign container id, and a pid that IS alive locally.
  // `process.pid` is unarguably alive, so a rung-2-only check must call this holder LIVE.
  const path = writeHeldLock(dir, {
    pid: process.pid,
    host: "d9089a2551dc",
    startedAt: new Date().toISOString(),
  });

  const handle = await acquireReviewStatusLock(path, {
    timeoutMs: 0, // the same zero-wait claimReviewDecision uses — no retry can mask this
    isPidAlive: () => true, // the false-negative under test, stated outright
    hostname: () => "8f3e86a35d09",
    inContainer: () => true,
  });

  assert.ok(handle, "a claim whose container is gone must be reclaimable");
  handle.release();
});

test("W1-T3335: a genuinely live SAME-HOST holder still blocks — the fix is not 'always reclaim'", async () => {
  // THE CONTROL THAT MATTERS. A reclaimer that fired unconditionally would satisfy the case above
  // and destroy the mutual exclusion this lock exists for, letting two reviews judge one decision.
  const dir = makeTempDir("w1-t3335-claim-live-");
  const path = writeHeldLock(dir, {
    pid: process.pid,
    host: "8f3e86a35d09",
    startedAt: new Date().toISOString(),
  });

  await assert.rejects(
    () =>
      acquireReviewStatusLock(path, {
        timeoutMs: 0,
        isPidAlive: () => true,
        hostname: () => "8f3e86a35d09", // the SAME host — no foreign-container rung applies
        inContainer: () => true,
        getProcessStartTime: () => null, // indeterminate, so the recycle rung cannot fire either
      }),
    ReviewStatusLockTimeoutError,
    "a live holder on this host must still block acquisition",
  );
});
