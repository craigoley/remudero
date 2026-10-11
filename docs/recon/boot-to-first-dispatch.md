# Boot to first dispatch — why dispatch waits for the first full pass (W1-T8197)

Recon, no source change. Read at origin/main `a2d49eada` (`src/lib/daemon.ts`).

## What could and could not be measured here

The worker sandbox cannot run `rmd ledger-grep` (the tsx IPC pipe is refused with `EPERM`), and the
operator's copy `~/Remudero-notes/restart-churn-2026-10-11/ledger-copy` is not mounted. So the 7-day
reproduction below is NOT re-derived by this run. The only boot data is the 2026-10-11 table the task
record carries (one day, 17 boots). The 7-day span and the per-rotation-form control are therefore
UNMET by this run and are listed as a follow-up for a worker with ledger access. Nothing in this
document claims otherwise.

## Boot timeline (carried from the task record, 2026-10-11, one day)

| boot | gate opened | first run.start | gate (min) | gate to run (min) |
|---|---|---|---|---|
| 00:03:28 | 00:05:42 | 00:06:08 | 2.2 | 0.4 |
| 04:08:26 | 04:12:30 | 04:12:58 | 4.1 | 0.5 |
| 05:13:24 | 05:17:01 | 05:17:49 | 3.6 | 0.8 |
| 06:36:08 | 06:41:59 | 06:43:14 | 5.9 | 1.3 |
| 08:31:10 | 08:34:45 | 08:35:29 | 3.6 | 0.7 |
| 09:06:09 | 09:11:02 | 09:11:28 | 4.9 | 0.4 |
| 10:01:07 | 10:03:35 | 10:04:18 | 2.5 | 0.7 |
| 13:07:04 | 13:14:45 | 13:16:13 | 7.7 | 1.5 |
| 14:01:45 | 14:10:08 | 14:12:48 | 8.4 | 2.7 |
| 14:30:17 | 14:37:04 | 14:38:32 | 6.8 | 1.5 |
| 16:06:38 | 16:11:31 | 16:12:47 | 4.9 | 1.3 |
| 17:22:40 | 17:27:10 | 17:27:41 | 4.5 | 0.5 |
| 18:14:58 | 18:18:55 | 18:19:24 | 4.0 | 0.5 |

(13 of the 17 boots are in the record; the remaining four are in its totals only.) Totals over 17
boots: 210 lane-min boot gate, 53 lane-min gate to first run, 17 lane-min down = 280, ~16.5 per boot.

Positive control: NOT RUN in this worker (no ledger access). The control the follow-up must run: for
each rotation form (live `ledger.jsonl`, each rotated/compacted segment, each archived form) assert
that `daemon.boot` rows were read from it, and fail if any form yields zero rows while its file exists.
A table built from the live ledger alone is rejected by the task's falsifier.

## The mechanism, verified at this HEAD

- `daemon.ts:3237-3267`: the boot gate. `bootGateHolds` is true when a sweep is wired and any garden or
  `BOOT_GATED_CADENCES` entry exists. It opens on the first full pass returning, or on the
  `BOOT_CADENCE_GATE_BOUND_MS` (10 min, `:287`) backstop.
- `:4366`: tick 1 starts the restricted boot review pass (not awaited).
- `:4528-4532`: `await bootReviewPass; ... await bootGateOpened;` sits in the tick body BEFORE
  `startDueRungsTimer`, the orphan sweep and every cadence, and the dispatch code (`:4985` onward) is later
  in the same tick body. So dispatch is serialized behind the gate even though the gate's own comment
  speaks of "cadences" only. Nothing in the dispatch code reads `bootGateTrigger`.

## Dispatch inputs: is the first full pass needed?

| input | where read | produced/refreshed by first full pass? | valid at boot without it? |
|---|---|---|---|
| plan snapshot | `reloadPlanBinding()` `:4231`, `planForBatch` `:4234` | no, reloaded by the tick | yes |
| merged set | `refreshMerged(Async)` `:4335`, per tick | no, own read in the tick | yes |
| open-PR ownership | `deps.isOpenPr` `:5004`, check at `:4352` | partly: the sweep's PR-pipeline pass refreshes dispositions | yes for ownership, stale for dispositions: needed from the first pass only for the "rearmed" park release |
| parked blockers | `parkedBlockers` re-arm loop `:4350` | no | yes (in-memory, empty at boot) |
| run-branch state | `readPushedRunBranches` `:4990`, a fresh read per tick | no, own read | yes |
| resumable handoffs | `pendingWorkerBoundaryHandoffs(bootLedgerLines)` `:3129` | no, derived from the ledger at boot | yes |
| run-length history (refill bound) | `dispatchRunHistory(bootLedgerLines)` `:3128`, bound `:5543` | no | yes (falls back to `DISPATCH_PHASE_REFILL_BOUND_MS` when no samples) |
| plan-only run-branch receipts | `sweepCycleOutcome?.planOnlyRunBranchReceipts` `:5001` | needed from the first pass (defaults to `[]` when absent) | no; absent receipts only mean a plan-only branch is not recognised as proven yet |
| merged-credit pending set | `pendingMergedCredit` `:3036` | no | yes |

Reading: of nine inputs, one is needed from the first pass (plan-only run-branch receipts), one partly
(PR dispositions). The rest are read by the tick itself or derived from the boot ledger. No claim is
made that this is exhaustive of every `NextRunnableOpts` field; the follow-up oracle covers that.

## Candidates and the failure each risks

1. Today's wait. Cost: 210 + 53 lane-min per day at this restart rate. Failure risked: none new.
2. Dispatch beside the first pass. Failure risked: the 10-05 incident class W1-T5720 was built for (first
   `sweep.pass` 6.7-15.8 min after boot; cadences and the pass contending for the loop). Dispatch spawning
   workers while the pass is reconciling PRs risks a task being started that the pass is about to credit as
   merged or park, and a plan-only branch re-run for lack of receipts.
3. Dispatch after one cheap input read (receipts and PR dispositions only, no cadences). Failure risked:
   a stale disposition for a few seconds; same class as (2) but bounded to the two inputs above.

Oracle that would prove (3) safe in a test: a daemon fixture with a first pass that never returns,
asserting that (a) a runnable task dispatches, (b) a task with a plan-only run branch not yet receipted
is NOT dispatched, (c) a task whose PR is open is NOT dispatched, and (d) the cadences in
`BOOT_GATED_CADENCES` still do not run until the gate opens (the W1-T5720 contract is unchanged).

## Recommendation:

File ONE implementation task: move `await bootGateOpened` (`:4531`) so that it holds only the cadences
and the due-rungs timer, and let the dispatch section run after a single bounded read of the two inputs
the pass produces (plan-only receipts, PR dispositions), adaptive to whether the pass has already
returned (no fixed wait: if the pass is done the read is the pass's result; if not, read directly).

Measured saving: at most the boot gate component, 210 lane-min over the 17 boots on 2026-10-11, about
12.4 lane-min per boot; the 53 lane-min gate-to-first-run component remains. This is an upper bound from
one day of data; the implementation task's first step must reproduce the table over 7 days with the
positive control above before it claims a number.

Oracle: the four-assertion fixture above.

## Follow-ups

- task: reproduce this table over 7 days with `rmd ledger-grep` across the live ledger and every
  rotation form, with a per-form positive control (needs ledger access this worker lacked).
- research: confirm with W1-T5724 whether its lighter boot path shortens the gate enough to make the
  recommendation moot.
