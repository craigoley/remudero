# 0007. Run each build in a child process that outlives the daemon, and restart the daemon only for its own code

Status: Proposed
Date: 2026-10-13

## Context

The operator approved this direction on 2026-10-13: "Agree with all of this. Make sure that we are
optimizing other parts of the daemon's memory to account for this new pressure. Reduce parallelism if
we need to. Think about how to ensure efficiency, but keep automated flow."

Restarts are the fleet's largest single loss of build capacity:

- 2026-10-11: 17 boots idled 880 lane-min, 25% of core's capacity
  (`~/Remudero-notes/restart-churn-2026-10-11/`).
- 2026-10-12 12:00Z to 10-13 11:45Z (`~/Remudero-notes/flow-remeasure-2026-10-13b/`): core booted 28
  times, 17 for freshness (9 released by `upper_age`, the staleness horizon) and 11 for an image
  recycle. Seven freshness boots were followed by a recycle within 3 minutes. Restart idle was 1,008
  lane-min, 23.6% of capacity, and 31.7% after W1-T8927 merged. By phase, in lane-min: boot gate 321,
  review drain 186, latched holdout 176, latched exit lag 118, post-gate 105, recycle drain 59.
- 2026-10-13 03:06–10:37Z: 9 boots, 12 freed lanes refused, and one lane idle for 57 minutes behind a
  holdout.

There are three causes.

1. **Restarts are frequent.** The daemon process starts on `src/run-task.ts` (`bin/rmd` execs
   `tsx src/run-task.ts daemon`). That entry's esbuild metafile has 512 source modules, so every `src/`
   change is a change to the daemon. Two prefix lists encode this. `MATERIAL_ADVANCE_PATHS`
   (`src/lib/self-sync.ts`) starts the staleness clock on any `src/`, `bin/` or package change, and
   `coalesceFreshnessRestart` releases the restart at `upper_age`, half the 60-minute horizon.
   `DAEMON_SELF_PATH_PREFIXES` (`src/lib/deploy-judge.ts`) scores the hottest files at 18, which is the
   whole threshold. Over 2026-10-06..13, 639 of 1,377 first-parent commits on main touched `src/`, and
   330 matched the self prefixes.
2. **Each restart is expensive.** A run executes inside the daemon: `DaemonDeps.runOne` is wired to
   `runTask` in `daemonCommand`. Only the worker CLI is a child (`spawnDetachedGroup`,
   `src/lib/worker-containment.ts`), and the SDK stream that drives it lives in the daemon's memory. A
   restart must therefore drain or yield every run. The machinery that does this is
   `restartAtWorkerBoundary`, holdouts, `run.freshness_handoff` receipts, `restoreBoundaryCheckpoint`
   and the leftover-branch guards. It had six defects filed in one week (W1-T8139, W1-T8198, W1-T8503,
   W1-T8535, W1-T8676, W1-T8927), and a yielded task waits a median 62 minutes to start again
   (W1-T8927).
3. **Image recycles end every process in the container.** Core recycles about 11 times a day. In the
   window, 13 of the 14 merges that rebuilt the image touched only `BAKED_RUNTIME_SOURCE_PATHS`. That is
   the serve supervisor's source; 9 of the 13 touched `src/lib/ledger.ts`, most often its retained-step list. Daemon containers
   run from the mounted checkout, not the image (`src/lib/image-drift.ts`), so those recycles deliver
   nothing to them.

**Why this is a one-way door.** Once runs are children, the boundary between the daemon and a run
becomes an on-disk contract read by two code revisions at once: a daemon booted on one sha adopts a
child started on another. Retiring the yield machinery and moving `daemonCommand` out of
`src/run-task.ts` then means a revert has to rebuild both. That costs far more than reverting one PR.

## Decision

A build run executes in a detached child process that outlives the daemon. The daemon restarts only
when code its own process loads changes. The memory those children add is paid for by shrinking the
daemon and its other children, and build parallelism follows the memory governor instead of a fixed
lane count. Every risky step ships behind a mode switch, shadow first.

### A. A build run executes in a child process that outlives the daemon

1. **Entry and code.**
   - A new entry, `src/run-child-main.ts` (`CHILD_ENTRIES` name `run-child`), runs `runTask` from a
     spawn spec.
   - It runs as the ADR 0006 bundle under plain `node`, never tsx, from an **engine tree**:
     `<state>/engines/<sourceHash>/`. That is a detached worktree of the managed checkout at the
     revision the bundle was built from, with the W1-T8776 store's bundle materialized into its
     `dist/` and its `node_modules` linked to the install for its lockfile hash.
   - An engine tree never moves while a status file names it. A child never runs from the daemon's own
     checkout, because `deploy/entrypoint.sh`'s `sync_tree` moves that checkout on every in-container
     restart.
   - The child starts no worker thread from its own URL unless W1-T8777's worker bundles cover it
     (ADR 0006 decision 4).
   - When no current bundle exists, the child falls back to tsx from the engine tree and says so in its
     status, because its reservation must then be sized for tsx.
2. **The contract is files, not pipes,** because a pipe dies with the daemon. Each run gets a directory,
   `<state>/runs/<runId>/`, holding:
   - `spec.json`, written by the daemon before the spawn: schema major and minor, task id, run id,
     instance, engine hash and sha, the plan snapshot path, the reservation id, and the serializable
     `runTask` options the daemon passes today (`planPath`, `owner`, `allowStale`, `skipGitSync`,
     `handOffAtPrOpen`, `pairedTrialHost`).
   - `status.json`, rewritten atomically by the child (`writeAtomic`): schema; run id; identity
     `{pid, startTicks, containerGeneration}`; engine sha; entry kind (`bundle` or `tsx`); the phase,
     named as the restart boundary names phases today; `heartbeatAt`; state (`starting`, `running`,
     `done`, `failed` or `aborted`); and either the `RunResult` or a failure.
   - `stderr.log`, bounded.

   The settle loop classifies errors today by in-process identity: `TaskAdmissionError`,
   `transientGhDispatchFailure`, `isSpawnInfraBlocked`, `ghLaneReadFailure` and
   `laneDeliveryFailure`. Under this contract they become a closed failure union that the daemon maps
   back to those classes. An unknown class settles as a lost run, never as a success.

   The schema only grows within a major version. The contract module is imported by both entries, so
   changing it changes the daemon's closure and restarts the daemon (decision B). A child that reads a
   spec major it does not know writes `failed` with `contract_mismatch`.

   The daemon talks to a child only through signals and files:
   - SIGTERM to the child's process group aborts it (item 7).
   - The existing recycle pause file (`recyclePauseDetail`) asks for a recycle yield. The child reads it
     exactly as `runTask` does today.
3. **The ledger needs no new lock.** The child appends with `appendLedger`, which issues one
   `writeSync` on an `O_APPEND` descriptor. That is the existing multi-writer guarantee (W1-T206,
   `docs/forensics/ledger.md#appendledger`). Rotation is already serialized by `<ledger>.rotate.lock`,
   and the seal-and-drain re-append keeps rows that land on a replaced inode (W1-T5514). Serve, the
   workers and the measurement-cadence child already write the ledger this way.
   - The child writes the run rows a run writes today, under its own `actor_pid` and a new actor kind,
     `run_child`, in `deriveLedgerActor`.
   - The daemon writes the lane rows (`dispatch.*` and the settle) from the status file.
4. **Identity, crashes and orphans.**
   - A child is identified by (pid, start ticks from `/proc/<pid>/stat` field 22, container generation),
     never by pid alone. The measurement-cadence child's `process.kill(pid, 0)` check
     (`measurementCadenceChildAlive`) does not survive pid reuse; `isHolderStale`
     (`src/lib/fs-race-safe.ts`) and `src/lib/host-memory-ledger.ts` are the precedent.
   - Reading a run directory has four outcomes:

     | Outcome | Condition | Action |
     | --- | --- | --- |
     | live | identity holds, state not terminal | adopt |
     | terminal | state is done, failed or aborted | settle from the status file |
     | lost | gone, state not terminal | settle on the crashed-run path |
     | dead | another container generation | treat as killed by the container restart |

   - For a lost run, the daemon ledgers `run_child.lost` with the stderr tail. It then settles the lane
     through the path a crashed in-process run takes today: `sweepInflightLocksWithReceipts` reaps the
     lock, the task re-pends, and a receipt restores if one exists.
   - The inflight lock (`state/inflight/<taskId>.lock`) records the child's pid, not the daemon's.
   - `orphanSweepRunActive` counts live adopted children, so `sweepOrphanWorkers` never kills the
     worker group of a live child.
   - The child awaits its fire-and-forget work (`runPairedTrial`, `runProspectiveAaPair`) before it
     writes a terminal status.
5. **Adopt on boot.** Before its boot gate, a booting daemon reads every non-terminal run directory for
   its instance. It adopts each live child into the lane pool as an occupied lane. The lane settles
   when the status turns terminal or the child is lost: an `fs.watch` with a poll fallback, as
   `measurementCadenceChildRunner`'s settle polls its state file (W1-T5723, which records `adopted`,
   `restarted` and `discarded`). The boot gate never holds an adopted lane.
6. **A restart waits for nothing it does not own.**
   - With runs as children, a freshness restart does not latch dispatch, ask for yields, or hold out.
     Refill stays open until the exit.
   - The daemon exits once its in-process work has drained (reviews and detached sweep actions), and
     the next boot adopts the children. A daemon restart costs only its own boot.
   - An image recycle or a host reboot still ends the children. The checkpoint and receipt path
     therefore stays, but only a recycle triggers it.
7. **Kill and abort.**
   - The child is a process-group leader (`detached: true`, `unref`). An abort is SIGTERM to the group.
     The child's handler stops at its next safe point through the run's existing `AbortController` and
     `withWorkerGroupTeardown`, writes `aborted` and exits.
   - If no terminal status arrives within the run's learned teardown time (the yield-cost history kept
     today), the daemon sends SIGKILL to the group, and the lost path settles the run.
   - The existing hung-run watchdogs abort through this path. STOP and PAUSE keep their meaning: no new
     dispatch, and running work completes.
   - The daemon's own SIGTERM never touches a child. `docker stop` ends the container and the children
     with it.
8. **State the child owns.**
   - The GitHub installation token: the child refreshes it itself (`startInstallationTokenRefresh`),
     instead of inheriting an environment snapshot that expires within the hour.
   - The git credential socket: one per child. Its socket thread is a self-URL worker, so this needs
     W1-T8777. A push then never depends on a daemon that is mid-boot.
   - The gh read floor is already cross-process (a stamp file and a lock).
   - The plan: the daemon writes the snapshot it admitted the task against to a file keyed by plan sha.
     The child reads that file instead of parsing more than 3,500 shards again.
9. **Migration: `sweep.runChild.mode` takes `off`, `shadow`, `on` or `auto`.**
   - `shadow`: each in-process run also starts a probe child. The probe loads what a run child loads
     (engine tree, bundle, plan snapshot), round-trips the contract, records `run_child.shadow` (load
     time, tree peak, entry kind) and exits. It never touches the task.
   - `on`: every build run is a child, and adoption is live.
   - `auto`: behaves as `on` while the evidence holds.
     - It promotes only after a whole daemon boot cycle in which every probe or child round-tripped,
       every live child was adopted, and the measured child peak fit the class reservation. The window
       is the boot cycle, not a count.
     - A lost or misidentified child, or a contract failure, demotes it to `shadow` and ledgers why.
   - The order of tasks is: contract; then engine tree and reservation; shadow; credentials; spawn; adopt;
     `auto`. The memory offsets in decision C land before `auto` can promote.
10. **What becomes deletable** once `auto` has held through a measured window (one task):
    - In `runDaemon`:
      - the `restartAtWorkerBoundary` closure;
      - the `inFlightFreshness` / `latchRestart` latch;
      - `restartHoldouts`, `holdoutDeadlines`, `yieldAsked`, `admittedUnderLatch` and
        `restartStillWaitingOnHoldout`;
      - the latch wait before `stopForFreshness`;
      - the freshness polling in `actOnDispatchFreshness` and `onDispatchTick`;
      - the `refillClosed ??= "stale code"` arms. `refillClosed` itself stays.
    - Ledger rows: `daemon.restart_holdout`, `daemon.restart_yield_asked` and
      `daemon.freshness_restart_waiting`.
    - Restart history: `restartWorkHistory`, `readRestartHistory` and `RESTART_HISTORY_WINDOW_MS`.
    - Watchdog: `restartLatchDetail` and its `restartPending` reading.
    - In `src/run-task.ts`: the `restartAtWorkerBoundary` branch of `yieldAtWorkerBoundary`, and the
      daemon override in `ciWaitFreshness`.
    - `DAEMON_SELF_PATH_PREFIXES` and `DAEMON_SELF_COMMIT_SCOPE`.
    - The in-process `runOne` path.

    What stays, triggered by a recycle only:
    - `commitAndPushRestartCheckpoint` and `restoreBoundaryCheckpoint`;
    - the `run.freshness_handoff` receipts and their readers;
    - the leftover-branch guards;
    - `externalWaitRecycle` and `inflight.recycle_yield`;
    - `deploy.drain_handoff`;
    - `drainBeforeRestart`, which drains reviews.

### B. The daemon restarts only when code its own process loads changes

1. **Scope is an import closure, not a prefix list.** Materiality and the staleness clock come from the
   closure of the daemon process's entry. `MATERIAL_ADVANCE_PATHS` stops deciding this, and so does
   `DAEMON_SELF_PATH_PREFIXES`. The closure is made of:
   - the affected-suites graph's static-import edges (`buildAffectedSuitesGraph`'s `directImports`),
     read with `git grep` at both shas, as `importClosureAt` already does;
   - plus each closure module's named data edges, which are repo files the daemon reads (for example
     `plan/policy.yaml`);
   - minus named edges to child entries, because a spawn delivers its own code at spawn;
   - plus the install inputs (`package.json`, `package-lock.json`) and the launcher (`bin/rmd`).

   Type-only imports count, so the closure fails toward restarting. The esbuild metafile of the same
   entry is the test oracle: the closure must contain every metafile input.
2. **The staleness clock starts only inside the closure.** An advance outside it never starts the
   clock, so `upper_age` never fires for it. Inside the closure, weighting is unchanged:
   `deterministicDeployWorth`, the quiet-window coalescing (W1-T6093) and the horizon. Decision B
   changes which advances count, not how they are weighed.
3. **The closure narrows only when the entry does.** While runs execute in-process, the daemon entry is
   `src/run-task.ts`, and the closure is nearly all of `src/`. After decision A, `daemonCommand` moves
   to a narrow `src/daemon-main.ts` whose static graph never reaches `src/run-task.ts`, as W1-T7728 did
   for check-proof.
   - `src/lib/daemon.ts`'s own metafile has 244 modules. The entry's real closure is measured when it is
     split.
   - Over 2026-10-06..13, 444 of 1,377 commits touched that closure, the install inputs or the launcher,
     against the 639 that count as material today. About 30% of material advances would stop counting.
     They include the 76 commits that touched `src/run-task.ts` and nothing in that closure.
4. **A `src/run-task.ts` change reaches the next run at spawn.**
   - After each fast-forward of the managed checkout, the daemon builds the store bundle for the new
     main revision (W1-T8776) and materializes its engine tree.
   - Each new child spawns on the newest engine whose bundle is current, and any lag is ledgered. A
     running child finishes on the engine it started on.
   - Every other engine-code child the daemon spawns (garden, measurement cadence, preflight) also
     resolves the newest engine, not `process.argv[1]` or the daemon's own tree. Otherwise those
     children would age with a daemon that no longer restarts.
5. **One boot per advance, and fewer recycles.**
   - An advance whose baked files the running image predates is delivered by the recycle, without an
     in-place restart first (W1-T8171).
   - An image rebuilt only for `BAKED_RUNTIME_SOURCE_PATHS` recycles serve only. A daemon container
     recycles only when an image input it executes changed: `deploy/Dockerfile`,
     `deploy/entrypoint.sh`, `.dockerignore`, the image CLI manifest or the Codex requirements.
6. **Boot to first dispatch.** Adoption runs before the boot gate, so a running lane never idles across
   a boot. For freed lanes, W1-T9072 (filed the same day) stops dispatch waiting behind the boot
   cadence gate.

### C. Memory: pay for the children by shrinking the daemon, and let lanes adapt

**Sizing.** Core's `daemon.alive` rows give 1,955 samples from 2026-10-11 22:56Z to 10-13 11:45Z.
Values are in MiB.

| Measure | p50 | p90 | max |
| --- | --- | --- | --- |
| Daemon RSS | 1,933 | 2,539 | 3,311 |
| Daemon VmSwap | 451 | — | — |
| Daemon heap used | 910 | — | — |
| Read-plane thread heap | 180 | 401 | 514 |
| Container `memory.current` | 5,155 | 6,569 | 8,379 |

- The container runs against `memory.high` 8,379 and `memory.max` 8,820.
- The daemon's heap limit is 8,384 MiB, because `--max-old-space-size=8192` still applies to the
  daemon itself (`daemon.memory_policy` rows).
- A boot peaks higher. VmHWM was 2,806 MiB four minutes after the 11:43Z boot. RSS has a p50 of 2,235 in
  the first 10 minutes of uptime, against 1,789 at 10–30 minutes.
- A run adds little to the daemon today. Heap used rises about 10 MiB per active worker (least squares
  over 1,634 rows with uptime above 15 minutes), and RSS shows no rise. Moving runs out frees about that
  much, no more.
- A child costs one Node process. The run-task bundle peaks at 166–182 MiB loaded (ADR 0006; W1-T8775's
  measurement), against 519–547 MiB for cold tsx and 284 MiB warm. On top of that comes the run's own
  working set, which nothing measures today; the shadow mode measures it. The estimate is 220–330 MiB
  per child on the bundle.
- The new pressure is about 0.65–1.0 GiB at 3 build lanes (`sweep.dispatchLanes`), 0.9–1.3 GiB at the
  policy maximum of 4, and 1.6–2.1 GiB if the children fall back to tsx. At the container's p90,
  1.8 GiB is left below `memory.high`. Unoffset, the children would push p90 to the ceiling.

**Offsets.** Each is its own task, and each lands before `auto` can promote:

1. **Gardens and check-proof run on the bundle** (lever E: W1-T8775 and W1-T8778, filed earlier and
   raised here). A garden child drops from about 519 to about 175 MiB. With two at once that saves about
   0.7 GiB at peak.
2. **The daemon's heap ceiling is learned and applied** (lever A: W1-T8883's shadow, then a task that
   applies it). This targets the GC slack between an RSS p90 of 2.5 GiB and a live set of about 0.9 GiB;
   heap-growing-percent 50 is already in force. Decision A makes a learned ceiling safe: a heap-limit
   exit costs one boot, and the ceiling raises itself on that evidence. Estimate: 0.5–0.9 GiB.
3. **The daemon's ledger memos are bounded** (lever B).
   - `dispatchSelectionLedgerUnion` keeps parsed rotation rows for the life of the process.
   - `terminalUnionScans` keeps every PR key of every archive.
   - `mergeLogEvidenceByRoot` and `dispatchFilingCache` grow with history.

   Their sizes are measured on `daemon.alive` first, then bounded to what selection reads. Heap used at
   p50 910 MiB is the upper bound of what they hold.
4. **Test fan-out is sized from learned peaks** (lever D). `TEST_FILE_PEAK_BYTES` sizes every test file
   at a fixed 512 MiB, while files peak at 300–570 MiB (the 2026-10-10 census) and at 737 MiB in one file
   seen at 11:47Z. The learned `test`-class peaks already exist.
5. **The daemon's entry is narrowed** (B.3). The daemon then loads about half the modules and never
   transforms run code. Estimate: 50–150 MiB, and a shorter boot.
6. **Run-path state leaves the daemon with the runs:** gateway memos, `liveWorkerRunIds` and
   `runningWorkers`. That is about 10 MiB per run.

**Parallelism adapts.**
- Today the build lane count is a fixed policy number: `sweep.dispatchLanes` is 3, with a maximum of 4.
  The adaptive parts are the WIP bound (`src/lib/adaptive-wip.ts`), the memory floor gate (a fixed
  `memoryFloorMib` of 3072) and the review width.
- The build lane count becomes the memory governor's output: the largest *n* whose projected container
  claim fits under the learned onset. The claim adds up the learned per-class tails of *n* run trees
  (each a child plus its worker plus its tests), the daemon's measured growth, in-flight reviews and
  gardens. The onset is `memory.high` through W1-T8472's lift-gated container arm.
- Lanes shrink at once while the container is pressed, and grow back one lane per settled tick with no
  pressure.
- The task ships in shadow first: `dispatch.lane_target` rows beside the fixed count. Enforcement
  follows W1-T8472, and `dispatchLanes` is retired when it does.

**How the governor counts children.**
- Each child's reservation is opened on the child's own root (pid, start time). The 15-second tree
  sampler (`createTreePeakSampler`) then counts orchestration, worker and test runner as one tree, and
  the implement and fix class peaks learn the child's cost with no new constant.
- Reservations are host-wide files bound to (pid, start time), so they survive a daemon restart, and an
  adopted child stays claimed.
- The daemon opens the reservation before the spawn and passes its id in the spec. The child never
  admits itself, so enforce mode's waiting queue and W1-T7095's wait state stay in the daemon.
- `activeWorkerCount`, the review width and `daemon.alive`'s `active_workers` count live children.
- `createDaemonMemoryGovernor` keeps counting the daemon alone; its growth figure drops as runs leave.

**Efficiency.**
- A run pays no cold start beyond loading the bundle: no tsx and no transform cache.
- The store builds once per main revision.
- The plan snapshot file is shared.
- `node_modules` is shared through the install root.
- The gh floor is shared through its stamp.

## Alternatives considered

- **Hot module reload in the daemon.** Rejected. ESM has no unload: the old graph stays reachable
  through closures, timers and memos, so every reload adds heap, the opposite of decision C. There is
  also no way to prove that in-flight run state is compatible across two revisions.
- **Keep runs in-process and make restarts cheaper.** This is the path W1-T7806, W1-T8139, W1-T8198,
  W1-T8503, W1-T8535, W1-T8676 and W1-T8927 took. Restart idle is still 23.6% of capacity, and it rose to
  31.7% in the 3 hours after the most recent of them merged. Each fix added a yield-or-hold decision with its own failure
  modes. The coupling itself is the source of the defects.
- **A cron restart window.** Rejected. It is a fixed threshold, it holds fixes for hours, and runs still
  yield at the window. W1-T6093's quiet window already coalesces restarts, and `upper_age` still fired
  nine times in a day.
- **A container per run.** Rejected. It adds a second runtime per lane, which costs memory, and it
  multiplies what each image recycle costs.

## Consequences

**Easier:**
- A daemon restart costs one boot.
- Most of the restart machinery can be deleted.
- Restart scope is computed, not curated.
- A run's memory is visible as its own process tree.
- The daemon's heap can be capped by evidence, because an exit is cheap.

**Harder:**
- Two code revisions read one on-disk contract, and that contract needs schema discipline.
- Each live revision holds an engine worktree on disk until its last child ends.
- A run's failures surface in its status and stderr files, not in the daemon's heap and log.
- The shadow budget samples more processes.
- A recycle still ends every run, so the checkpoint path stays.

**Open questions for the operator:**
- **Reviews and fix actions as children.** Reviews and detached sweep actions still run inside the
  daemon, so the restart still drains them: 186 lane-min of review drain in the window. The same
  contract could host them. Not filed here.
- **The daemon on the bundle.** Running the daemon itself from the bundle would save tsx's overhead
  (284 against 173–182 MiB in ADR 0006) and the cold transform at each boot. ADR 0006 decision 1 keeps
  the daemon on tsx, and W1-T8777 removes the obstacle it named. Not filed here.

Layer 1, which keeps freed lanes productive during a restart latch, is filed separately as W1-T9069.
It stays useful until `auto` holds; W1-T9089 retires it with the rest of the latch.

## Tasks filed for this record

They are filed in a companion plan-only PR on branch `plan-file-1791892714679`, because Standing rule 15
refuses plan criteria and non-plan paths in one diff.

| Task | Priority | What it does | Depends on |
| --- | --- | --- | --- |
| W1-T9070 | 1 | The run-child contract: spec, status, failure union, identity | — |
| W1-T9077 | 1 | Engine trees pinned per revision (A.1, B.4) | W1-T9070, W1-T8776 |
| W1-T9080 | 1 | A child's reservation on its own root; governors count children | W1-T9070 |
| W1-T9082 | 1 | `sweep.runChild.mode`, and the shadow probe that measures a child | W1-T9077, W1-T9080, W1-T8777 |
| W1-T9083 | 1 | The child's own token refresh and credential socket | W1-T9082 |
| W1-T9085 | 1 | Runs execute as children under `on`; settle and abort | W1-T9083, W1-T8778 |
| W1-T9086 | 1 | Adoption before the boot gate; a restart waits for no child | W1-T9085 |
| W1-T9087 | 1 | `auto` promotes and demotes on evidence | W1-T9086, W1-T9105, W1-T9102 |
| W1-T9089 | 2 | The restart-yield, holdout and latch machinery retires (A.10) | W1-T9087 |
| W1-T9091 | 1.5 | The narrow daemon entry (B.3) | W1-T9089 |
| W1-T9092 | 1.5 | Materiality and the staleness clock from the closure (B.1, B.2) | — |
| W1-T9094 | 1 | A serve-only image change recycles serve only (B.5) | — |
| W1-T9097 | 1 | The build lane count follows the memory governor | W1-T9080, W1-T8472 |
| W1-T9102 | 1 | Test fan-out sized by learned per-file peaks (offset 4) | — |
| W1-T9105 | 1 | The daemon's ledger memos are measured and bounded (offset 3) | — |
| W1-T9106 | 2 | The learned daemon heap ceiling is applied at boot (offset 2) | W1-T8883, W1-T9086 |

That filing also raises W1-T8776, W1-T8777 and W1-T8778 to 1 (offset 1 and the bundle the children run on) and
W1-T8883 to 1.5 (offset 2). W1-T8171 (one boot per advance, already priority 1) is decision B.5's first half, and
W1-T9072 (already priority 1) is B.6.
