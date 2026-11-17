# Pooled test runs and the daemon's exit latches

The merge-sweep suites for W1-T6595, W1-T9212 and W1-T12059 failed their first pooled attempt in
ci-shard and passed on the flake retry. The cause is shared process state: two exit latches that a
daemon stop closes and that only a later daemon start reopens. This W1-T13352 report records what
was measured on 2026-11-17 and the fix filed as W1-T13363.

## What failed

OBSERVED in ci-shard first attempts (FLAKE-RETRY lines), on both runner images:

- main 44006635512 (ubuntu-24.04, green): W1-T6595 twice and W1-T9212, then passed on retry. The pool's
  probe named `test/a-freshness-restart-can-take-an-idle-moment.test.ts`.
- main 44012529966 (ubuntu-26.04): the same three failed with
  `expected direct-merged, got direct-merge-preflight-refused`. The probe named
  `test/a-no-pr-branch-of-an-ended-run-stops-blocking-dispatch.test.ts`.
- main 44019350709 and 44022915015: W1-T12059 criteria 1 to 3 failed the same way, then passed on retry.

So the runner image move did not cause it. The retry hid it, but every affected shard paid a rerun.

## How it was reproduced

OBSERVED: running the three suites with the probe's named file in one
`--experimental-test-isolation=none` process passed 25 of 25. The order or the rest of the pool mattered.

OBSERVED: shard 8/8's pool for main `cf7db0e` was rebuilt with the repository's own `partitionPool`
from `scripts/pure-test-pool.mjs`. It held 308 files, the same count CI printed (`308/308 file(s)`).
One pooled run of those files reproduced the three failures.

## The writer and the reader

OBSERVED by bisecting the other 307 files: `test/a-freshness-restart-lets-a-running-review-finish.test.ts`
is enough to make the W1-T6595 suite fail when it runs first in the same process.

OBSERVED by printing the armer's outcome in the failing test:
`{"outcome":"direct-merge-preflight-refused","directMergePreflight":{...,"remedy":"retry-later","reason":"freshness_latch"}}`.

- Writer: `runDaemon`'s freshness stop in `src/lib/daemon.ts` calls
  `closeDirectMergeAdmissions("freshness_latch")`. The latch is module state in
  `src/lib/arm-auto-merge.ts` (`directMergeAdmissionsClosedBy`).
- Reopener: `runDaemon` calls `openDirectMergeAdmissions()` on entry. A test file that never starts a
  daemon never reopens it.
- Reader: the sweep's direct-merge path in `src/lib/sweep.ts` asks the armer, whose preflight refuses
  while the latch is closed.

OBSERVED, a second latch of the same shape: `drainInFlightReviews` in `src/lib/sweep.ts` sets
`lightPassRefillsClosed = true`. After `test/a-no-pr-branch-of-an-ended-run-stops-blocking-dispatch.test.ts`
(bisected from 71 files), `test/daemon/a-recycle-wait-admits-a-review-that-ends-before-the-wait-does.test.ts`
failed 3 tests in one pooled process.

## Why the probe named a different file each run

INFERRED from `locateLeak` in `scripts/pure-test-pool.mjs` and the facts above, not measured on CI:

- `locateLeak` assumes one leaking file and a failure that grows with the prefix. Here there are two
  leaks, several daemon-stopping files can close each latch, and any later file that starts a daemon
  reopens it. A longer prefix can therefore pass where a shorter one failed, so the bisection lands on
  whichever closer sits last before the victim in that run's order.
- `test/a-freshness-restart-can-take-an-idle-moment.test.ts` also starts `runDaemon` (4 call sites), so
  it can close the same latch. The pool's file list changes when files are added on main, so each run
  bisects a different order.

The probe's narrowing is order-dependent, not wrong about the class of leak.

## Recommendation

One fix task, W1-T13363: register each process-exit latch and reopen every registered latch when a
pooled run moves to a new test file (the pooled-only `beforeEach` in `test/setup/tmp-hygiene.ts`).
Production never calls the reset, and an isolated run sees each latch exactly as before.

A census entry for the leaking files was not chosen: 241 test files call `runDaemon`, so moving them out
of the pool would cost much of its saving. A per-test fixture change would have to be repeated in every
suite that merges after a daemon stop.

OBSERVED on the W1-T13363 branch: a pooled run of the freshness-restart file followed by the W1-T6595
file reports `# fail 0` with the reset, and fails with the reset commented out. The rebuilt 308-file
pool no longer fails the merge-sweep suites.
