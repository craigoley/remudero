# A standby daemon for a freshness restart

Design only. This document changes nothing under `src/` or `deploy/`. A build needs its own task,
filed after the operator has read this and made the decisions in [Operator decisions](#operator-decisions).

Task: W1-T12245. Measured 2026-11-11 from the core instance's ledger, window
2026-11-04T01:56Z to 2026-11-11T01:56Z (live `state/ledger.ndjson` plus the rotated `.gz` segments that
overlap the window; 2,091,858 rows scanned). Tree: `origin/main` at `9189b38a3`.

## The problem

A freshness restart runs its drain and its start one after the other. Serve does not: its supervisor
checks out `main` in a second slot, boots a standby, waits for it, and passes the socket
(`src/lib/serve-supervisor.ts`, `serve-generation.ts`, `serve-slots.ts`). The daemon has one checkout,
one process and one lock, so the fleet is down for the drain, the `sync_tree` checkout and the cold start.

What the ledger says the restart costs, 53 `daemon.freshness_exit` rows in the window
(`phases_ms`, seconds):

| phase | p50 | p95 | max |
| --- | --- | --- | --- |
| `decision_to_latch` | 0.1 | 0.4 | 0.7 |
| `pre_exit_pass` | 621.7 | 2300.0 | 7162.0 |
| `drain` | 5.1 | 577.1 | 1120.7 |
| `total` (decision to exit) | 874.8 | 3874.2 | 7576.3 |

The task record quotes a median of 18.0 minutes from the restart decision to the exit, a different
cut of the same events; this document does not reproduce that figure and does not rely on it. After the
exit the record quotes 143 s from the launcher to `daemon.start` and 583 s from the launcher to the
first admitted review (18 starts after a freshness exit). The launcher's own log lines are container
stderr and are not in the ledger, so those two numbers are **not reproduced here**. What the ledger does
reproduce: 125 `daemon.start` to `daemon.boot` pairs with a median of 18.6 s and a p95 of 39.9 s.

Most of the downtime is the pre-exit pass and the drain, which a standby does not remove. A standby
removes the part after the exit: the checkout, the cold start and the boot gate.

## Measured costs

A second daemon process beside the first costs memory, processor time and GitHub reads. Each number
below names its source. Where the ledger does not carry a number, the section says so.

### Memory

Source: 2,240 `daemon.memory` rows from 112 daemon processes (a process is one `run_id`; 126
`daemon.start` rows, 44 container ids).

| per daemon process | p50 | p95 | max |
| --- | --- | --- | --- |
| first sample, `rss_bytes` | 1.60 GiB | 2.01 GiB | 2.21 GiB |
| first sample, `heap.used_bytes` | 0.87 GiB | 1.27 GiB | 1.35 GiB |
| highest `rss_bytes` in its life | 2.59 GiB | 3.44 GiB | 3.68 GiB |
| `vm_hwm_bytes` (kernel high-water mark) | 2.80 GiB | 3.98 GiB | 4.37 GiB |

- The first sample is not the start. Its `uptime_s` has a median of 330 s (p95 475, max 719). The ledger
  holds no memory row at `daemon.start`, so the boot peak of a daemon is read from `vm_hwm_bytes`, and
  the first-sample RSS is a floor for it.
- The heap limit in the rows is 7,540,310,016 bytes (7.02 GiB), from `--max-old-space-size`
  (`deploy/install-host-units.sh`). It is a V8 limit and not the container's.
- The container's `memory.max` is **not in the rows**. `deploy/resource-policy.sh` records build
  daemons at `memory.max` 8.6 GiB with 4 GiB of swap, on a 15.6 GiB host (observed 2026-10-09), and a
  soft `memory.high` sized from a host budget. The serve supervisor's comment gives 5632 MiB for serve's
  `memory.high` on 2026-10-14.
- Overlap, by sum: the old process at the end of a long life (p95 3.44 GiB RSS) plus a standby at its
  first sample (p95 2.01 GiB) is about 5.5 GiB. A standby that reaches the old process's own peak would
  need up to 7 GiB. Against an 8.6 GiB `memory.max` that fits; against a `memory.high` near 5.5 GiB it
  does not, and the kernel throttles both processes. The sum is an upper-tail estimate from two
  independent distributions, not a measured overlap. Nobody has run two daemons together.
- The comparison that exists is serve. In the same window 152 `serve.handoff_done` rows give
  `overlapPeakBytes` p50 1.31 GiB, p95 2.15 GiB, max 2.45 GiB. The newest row (2026-11-11T01:39:42Z)
  reads `prepMs` 9,478, `readyMs` 31,745, `drainMs` 1,764 and `overlapPeakBytes` 1,496,281,088 (1.5 GB),
  which matches the record. The record counts 160 rows; this scan finds 152 and does not explain the
  difference of 8.

### Processor time

The ledger carries **no processor time for a start**. `daemon.memory` has `sample_us` (the sampler's
own cost, not the daemon's), and no row has `cpu_user` or `cpu_system` for a boot. The
`cpu_ms` and `cpu_cost` fields that exist in the ledger sit on `implement.preopen_gate` and
`sweep.plan_lane_bound` rows, not on a daemon boot row.

What can be stated:

- Wall time of a start is 18.6 s (p50) from `daemon.start` to `daemon.boot`, and the first memory sample
  arrives at 330 s of uptime. These are wall-clock under load, not CPU.
- The host has 8 cores (`nproc`). `uptime` at the time of writing reads load average 13.2, 22.0, 26.7
  (1, 5, 15 minutes). The record cites a load of 20 to 30 on 2026-11-10. A second daemon booting while
  the host is at 3x its core count competes with the build runs and the old process's drain.
- Serve's supervisor already treats this as a cost: `RMD_SERVE_CPU_SHARES` 4096 against
  `RMD_BUILD_CPU_SHARES` 512 (`deploy/resource-policy.sh`). A standby daemon in the same container
  shares the daemon's `cpu.weight`, so it takes CPU from the old process's drain, not from serve.

A build must add a measurement (`process.cpuUsage()` at `daemon.start`, at `daemon.boot`, and at the
first tick) before any claim about processor time is made. See Operator decisions, item 6.

### GitHub reads

Source: 460 `daemon.quota` rows (poll interval 60,000 ms), buckets `core` and `graphql`.

- `graphql` stayed between 9,777 and 10,000 remaining in the window. It is not a constraint.
- `core` ranged between 2,623 and 14,988 remaining. It is the bucket a start spends.
- The drop in `core` across a start: for each `daemon.start`, the last row before and the first row
  after it, within one reset window and within 30 minutes. 51 starts qualify. The drop has a median of
  1,893, a p95 of 3,766 and a max of 5,162. The median gap between the two rows is 934 s.
- That number is an **upper bound, not a cost of the start**. Rows are written when the value changes,
  the gap is 15 minutes, and the interval contains every other reader on the token: the sweep, the
  reviews, the run children. The `graphql` drop over the same pairs has a median of 4 and a max of 67.
- The reads a start does are named by W1-T12235, W1-T12236 and W1-T12239 (the lifetime history, one
  read per open pull request, the first tick read). Those tasks are queued at this HEAD, so no
  measurement of their effect exists.

A standby that reads before it holds the lock doubles the start's reads for the length of the overlap,
and 1,893 `core` calls in a median window is about 13% of the bucket at the median and 25% at the p95 (the
highest `remaining` seen is 14,988, so the limit reads as 15,000 an hour; this is inferred, not read). A standby must not do the full start read. See Lock handoff for what it may read.

## Lock handoff

Today's lock: `state/drain.lock`, taken in `src/cli/commands/daemon.ts` by `acquireDrainLock`
(`src/lib/drain-lock.ts`). It is created with `O_EXCL` (`openSync(path, "wx")`) and holds
`{ pid, host, startedAt }`. The holder is judged stale by `isHolderStale` (`src/lib/fs-race-safe.ts`),
which checks the host, the pid and the process start time against `startedAt`, and a stale lock is
reclaimed by a delete conditioned on the lock's on-disk identity. `rmd drain` shares this same file, and
other callers (`review`, `retro`, `bakeoff-trigger`, the reservation reaper) take the same primitive on
paths of their own. The lock is released by `unlink` at exit and in the `finally` of the daemon.

A second process cannot acquire it while the first lives. `acquireDrainLock` throws `DrainLockError`
and the daemon prints `REFUSED — a drain/daemon is already running`. The standby therefore needs a
handoff the primitive does not have. Nothing in `drain-lock.ts` transfers a lock; release and acquire
are two separate steps with a gap between them.

### Proposed handoff

Two files, one writer at a time:

1. `state/drain.lock` stays the lock of the active daemon and is unchanged for every other taker.
2. The standby takes `state/drain.standby.lock` with the same `acquireDrainLock` (a second standby is
   refused by the same rule that refuses a second daemon). Holding it grants reads only.
3. When the standby is ready, it writes a request file `state/drain.handoff.json`
   (`{ standbyPid, standbyStartedAt, requestedAt }`) and waits.
4. The active daemon, on seeing the request after its own freshness decision has latched and its drain
   has completed (`daemon.freshness_drain.completed`), does **not** release the lock. It rewrites
   `state/drain.lock` in place by write-to-temp and `rename` to hold the standby's identity, then writes
   `state/drain.handoff.ack`, then exits with code 75 as it does today.
5. The standby sees its own pid in `drain.lock` and the ack, removes its standby lock and the request
   file, and starts as the daemon.

The rename is atomic: at every instant `drain.lock` names exactly one holder, and no other taker sees
the file absent. The new primitive is `transferDrainLock(lockPath, from, to)`, which refuses unless the
file's current content equals `from`.

### If either process dies during the pass

| death | state left | outcome |
| --- | --- | --- |
| old, before the rename | `drain.lock` names the dead old pid, request file present | `isHolderStale` marks it stale. The standby reclaims it by the ordinary `acquireDrainLock` path and starts. This is today's crash recovery. |
| old, after the rename, before exit | `drain.lock` names the standby, which is alive | Nothing to do; the standby is the holder. The old process's run children are adopted as if it had exited. |
| standby, before the rename | `drain.standby.lock` names a dead pid; request file present | The old daemon's wait on the ack times out (bound: the operator's decision 3); it deletes the request and goes on with its normal exit. A restart then happens cold, as today. |
| standby, after the rename, before it starts | `drain.lock` names a dead pid | `isHolderStale` marks it stale; the entrypoint loop (below) starts a cold daemon, which reclaims it. Cost: today's cold restart, no worse. |
| both | `drain.lock` stale | Same as above. |

Every row degrades to today's cold restart. None leaves two daemons holding the lock, which is the
property that matters, because two daemons both select the still-unmerged task and both launch workers
(the failure `drain-lock.ts` was written against, `docs/archive/DIAGNOSIS.md`).

### What the standby may do before it holds the lock

Reads only:

- boot the process, load the plan, import modules, warm caches that are local;
- read the ledger and `state/runs/*` (the same read `adoptRunChildren` does);
- read GitHub through the shared client, under its own read budget (Operator decisions, item 4).

What it must not do before the handoff:

- any write to GitHub (a comment, a label, a merge, a review status);
- any write to a claim, a reservation or a dispatch record, including `bootSweepDispatchClaims`, which
  judges this host's pre-restart claims and ends the runs they held (W1-T10896);
- any change to a worktree or to the daemon's checkout;
- starting a review, a fix round or a run child, or running a sweep pass.

The boot code in `src/cli/commands/daemon.ts` runs the claim sweep, `adoptRunChildren`, the ledger
writes of `daemon.boot` and the first tick in one straight line after the lock. A standby needs that
line split at the lock: everything before it is the "reads only" half, everything after it waits for
the handoff. That split is the largest part of the build and it is in the file with the most state.

## Adoption order

Today a booting daemon adopts its live run children before the boot gate (W1-T9086, merged), by
`adoptRunChildren` in `src/lib/run-child.ts`. It reads `state/runs/*`, skips what does not belong to
this instance (`spec.instance`), skips `settledRunIds`, classifies each directory as live or dead, and
for a live one reserves its occupancy and starts `awaitRunChild`. Each pass writes
`run_child.adoption_pass` with `live`, `adopted`, `unreadable` and `misidentified`. A work spec the
reader does not recognise is never adopted as a build run, so a review does not take a lane.

What is adoptable is set by the placement table in the same file (W1-T9114). The
`daemon.freshness_drain.completed` row of 2026-11-08T14:06Z records it:

| kind | placement | after a restart |
| --- | --- | --- |
| `review` | child | adopted |
| `fix-dispatch` (a fix round) | child | adopted |
| `retro`, `auto-triage`, `ci-learning`, `benchmark-cohort`, `measurement-cadence`, `light-pass-action` | process | not adoptable; the drain waits for them |

The standby must adopt in this order. The reasons are given with each step:

1. **Run children (build runs) first.** They hold lanes and worktrees. The boot gate waits for them, and
   the claim sweep must not mistake their workers for orphans. This is what W1-T9086 fixed and the
   order it fixed.
2. **Fix rounds second.** A fix round is a child that pushes to a pull request's head. Adopting it before
   the reviews means the review of that head is not started on a sha the fix is about to replace.
3. **Reviews last.** A review is read-only against a head and its result is keyed to the sha
   (`review_key`). It is the cheapest to repeat, so it goes after the children whose repetition is
   expensive or unsafe.
4. **In-process work is not adopted.** The old process must finish it before it hands over (the
   drain's existing behaviour), or the handoff waits. This is the main reason the old process cannot hand
   over at the freshness decision: it hands over at `daemon.freshness_drain.completed`, with the
   process-placed work done.

The adoption pass runs **after** the lock transfer, never before: `adoptRunChildren` reserves occupancy,
and `adoptRunChildReservation` is a write. Before the transfer the standby may only run the read half,
to learn the count it will adopt (a dry pass: classify without reserving) and to ledger it
(`standby.adoption_preview`).

A child that settles between the old process's last look and the standby's pass is found by the
standby's classification (a dead directory with its result file). A child the old process spawns after
the standby's preview is covered because the old process spawns nothing after
`daemon.freshness_drain.completed`; that is a rule the build must keep, and a test must check it.

## Two checkouts

Today there is one checkout, the daemon tree (`$TREE`). `deploy/entrypoint.sh`'s `sync_tree` fetches,
refuses on tracked dirt (`status --porcelain -uno`), and detaches onto the new `origin/main` tip with
`try_checkout_target`, after the daemon has exited. The restart loop at the foot of the script
(`while :`) catches exit code 75 (`DAEMON_EXIT_STALE`), sleeps `FRESHNESS_RESTART_PAUSE_S` (5 s),
calls `sync_tree`, resolves `rmd` on `PATH` and starts the next daemon. The loop runs at most
`FRESHNESS_RESTART_MAX` (100) in-container freshness restarts before it falls through to docker's count.

A standby cannot take that tree: moving it under the running old process changes the files the old
process lazily loads and the files its run children execute. The serve supervisor solved the same
problem with two slots, `a` and `b`, git worktrees of the serve clone, never more than two
(`src/lib/serve-slots.ts`). The slot is prepared by fetching `main`, checking out the sha, and making
`node_modules` match the lockfile hash: reused as is, hard-linked from the active slot, or `npm ci`.

| while both are alive | checkout |
| --- | --- |
| old daemon | the tree it booted from: `$TREE` at the old sha, untouched |
| standby | a second worktree of the same clone, at the new sha, with its own `node_modules` |
| run children of the old process | their own run worktrees, unchanged; they execute `engineSha` from their `status` file |
| after the handoff | the standby's tree is the daemon's; the old tree becomes the next standby's slot |

Consequences a build must handle:

- `resolve_rmd_on_path` prepends `$TREE/bin` to `PATH` (W1-T3684). With two trees the `rmd` an operator
  types must resolve to the **active** daemon's tree. The pointer moves at the handoff, not at the
  standby's boot.
- `sync_tree` is a function of one tree. It must become a function of a slot, and its dirty-tree
  refusal and the `core.bare` repair apply to each slot separately.
- The daemon container bind-mounts the checkout from the host. A second worktree is a second bind or a
  path under the same mount. The host's registrations of worktrees already accumulate there
  (`git worktree prune` in `sync_tree` is the symptom), and a standby slot adds to them.
- `node_modules` is the cost the serve slots measured: a cold `npm ci` is 20 to 30 s on the fleet host
  (`SLOT_INSTALL_TIMEOUT_MS` comment), reused 0, hard-linked seconds. The same applies here.
- Disk: one more tree and, on a lockfile change, one more `node_modules`.

The entrypoint also supervises exactly one child (`wait` on it, `forward_signal` to it, the exit code
read as `rc`). A standby is a second child, so the loop, the signal forwarding and the exit evidence
(`daemon.process.exit`) each need to know which process is the active one. This is the part of the build
in `deploy/entrypoint.sh`, which is a baked path: a merge ships by an image build and a container
recycle, not at merge.

## Recommendation

**Do not build it now. Build the four smaller tasks first, measure again, and build a standby only if
a number that this document names is still above the threshold the operator sets.**

What a standby saves is the time from the old process's exit to the new process's first admitted
work: the 5 s pause, `sync_tree`, the cold start (125 starts: 18.6 s median to `daemon.boot`; the record
quotes 143 s to `daemon.start`), and the boot gate until the first admitted review (record: 583 s).
What it cannot save is the pre-exit pass (median 622 s) and the drain (median 5 s, p95 577 s), which
happen before the handoff in any design, because the old process must finish its in-process work.

After the four tasks, at this HEAD all `status: queued` (W1-T12235, W1-T12236, W1-T12237, W1-T12239;
none is merged, so the savings below are projections and not measurements):

| task | what it takes out of the restart | effect on a standby's saving |
| --- | --- | --- |
| W1-T12235 | the lifetime history read once, not at each start | removes a cost from the cold start the standby would have hidden |
| W1-T12236 | each open pull request read once before the first review | removes a cost from the boot gate the standby would have hidden |
| W1-T12237 | no new sweep after a freshness exit, a running one ended between pull requests | shortens `pre_exit_pass` (median 622 s), which a standby does not touch |
| W1-T12239 | the first tick read starts right after the token mint | removes a cost from the cold start the standby would have hidden |
| W1-T9812 | the pre-exit pass runs beside the drain (queued) | shortens `total`, which a standby does not touch |

Three of the four shrink the very interval a standby would hide, so each one reduces the standby's
saving. W1-T9086 (merged) already took the run-child wait out of the restart. The remaining saving
after all of them is the checkout, the process start and what the first tick still reads, and I cannot
state that number: it needs the measurement the four tasks and the processor-time field in Operator
decisions, item 6, would produce.

Reasons not to build now:

- The risk is asymmetric. An error in the lock, the adoption order or the checkout stops the fleet, or
  runs two daemons. The saving is bounded by an interval the four tasks are about to shrink.
- No one has run two daemons together. The memory sum in Measured costs reaches the soft limit at the
  upper tail, and the processor time is unmeasured.
- Every failure row in Lock handoff degrades to today's cold restart, so building later loses nothing.

Reasons it may still be worth building later:

- Serve already proves the pattern: 152 handoffs in 7 days, newest 9.5 s prepare, 31.7 s ready and
  1.8 s drain, with no time down.
- The restart count is high: 53 freshness exits in 7 days, about one every 3 hours.

Measure again, in this order, once the four tasks have merged and the daemon has run a week:

1. the median from `daemon.freshness_exit` to the first `sweep.review_admitted` after it (the ledger
   has both rows, so this needs no launcher log);
2. `process.cpuUsage()` at `daemon.start` and the first tick, as a new ledger field;
3. the `core` bucket drop across a start, with the quota poll written at the start and the first tick.

## Operator decisions

Each decision the operator must make before a build task is filed.

1. **Build or defer.** Defer until the four smaller tasks have merged and been measured for a week
   (recommended), or build now. Reversible: deferring costs nothing, because the failure modes all
   degrade to today's restart.
2. **The threshold.** What median from freshness exit to first admitted review is still too long after
   the four tasks. This document gives no number because the operator's tolerance is the input. Without
   it, the measurement above has no pass mark.
3. **The handoff bound.** How long the old process waits for the standby's ack before it exits cold:
   a short bound (seconds) keeps today's behaviour on any fault; a long one risks a longer outage.
4. **The standby's read budget.** Whether the standby may read GitHub before it holds the lock, and how
   many `core` calls it may spend. The upper-bound start cost is a median of 1,893 calls per window.
   Choices: reads from the local ledger only until the handoff (cheapest, saves least), a capped read
   (recommended if a standby is built), or the full start read.
5. **The memory policy.** What the standby does when `memory.high` is near: refuse to start and stay
   cold (serve's `serve.handoff_deferred` with a named `hold`), or start and be throttled. The daemon
   container's `memory.max` and `memory.high` are not in the ledger and the operator must supply them.
6. **A new measurement.** Whether to add `process.cpuUsage()` to `daemon.start`, `daemon.boot` and the
   first tick. It is a ledger field and no behaviour change. It is the only way to price the processor
   time of a second process.
7. **The checkout location.** The second tree under the same bind mount as `$TREE`, or elsewhere; and
   who owns its `node_modules` (hard-linked from the active tree, as serve's slots do, or a cold install).
8. **The deploy path.** `deploy/entrypoint.sh` is baked, so a change there ships by an image build and a
   recycle. Whether the first build may change it, or must stay in `src/` behind a kill switch of the
   serve kind (`RMD_SERVE_HANDOFF=off`, a `handoff.off` file) and leave the entrypoint for a second task.
9. **The kill switch.** Whether a standby is on by default or off until proven, and which file or
   environment variable turns it off.
10. **What the status of `verify:` is.** The record says `verify: auto` and, in its note, "Parked for the
    operator: `verify: human`". Which governs for the build task that follows, because a design with
    this blast radius should not merge without a human reading its review.
