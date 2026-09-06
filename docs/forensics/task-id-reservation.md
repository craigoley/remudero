# task-id-reservation.ts forensics

The measured forensics, incident narratives and design arguments removed from
`src/lib/task-id-reservation.ts` when its comments were compacted to the plain-language standard.
Every block below is the removed text verbatim, nothing else changed. Headings name the symbol or
section the text explained; the code keeps a one-line `// Why:` (or, inside a JSDoc block, `Why:`)
pointer where the history mattered. CLAUDE.md's own "Plan and task hygiene" section already records
the contested-reservation rule (a contested reservation is never deleted and an unfiled one is
never free; the loser of a race renumbers; the 2026-08-18 5.76-second race) — that bullet is cited
from the module header rather than retold here. Base revision: `origin/main` at
7cdff72ade45751b97a0d44b10e9d3675a32d733; the line numbers below are that revision's.

## Module header

### Base lines 7-36 — src/lib/task-id-reservation.ts, the #1060 sharding incident and the directory-vs-history-cache argument

```
/**
 * ATOMIC RESERVATION of a minted task id — the half `mintNextTaskIdWithHistory` does not do.
 *
 * THE DEFECT. The mint is a SNAPSHOT taken before a worker runs (lib/triage.ts's ID SELECTION
 * block): the max across `plan/tasks.yaml`, every `plan/tasks.d/*.yaml` shard, the ids OPEN plan
 * PRs have minted, and — since #1051 — every id ever declared in the git history of `plan/`.
 * All four are correct. NONE of them reserves anything, so two callers that mint before either
 * pushes derive the SAME id.
 *
 * WHY THAT GOT WORSE, NOT BETTER. Before #1060 both proposals appended to the `plan/tasks.yaml`
 * monolith and collided textually at EOF: ugly, but LOUD, PRE-MERGE and unmergeable. Since #1060
 * each writes its own `plan/tasks.d/<id>-<slug>.yaml`, the slugs differ, git merges both branches
 * CLEANLY, and `loadPlan` (lib/plan.ts) then throws `duplicate task id` ON MAIN — breaking every
 * plan-loading check for everyone. Sharding traded a conflict you cannot merge for a merge that
 * poisons the plan.
 *
 * WHAT THIS IS NOT. It does NOT change what the mint COMPUTES. The four sources and their
 * precedence were fixed twice this week and are untouched: a caller mints exactly as before, then
 * reserves the result. Reservation composes ON TOP of derivation — {@link reserveTaskIdFrom} takes
 * the mint's answer as its STARTING point and only ever moves UPWARD, past ids a live holder
 * already claimed.
 *
 * WHY A DIRECTORY OF FILES, AND NOT THE HISTORY CACHE. The mint's history cache lives in the
 * shared git-common-dir so every worktree shares one copy, and it tolerates a torn write by
 * DISCARDING unparseable content and rescanning — safe there because a lost cache costs one rescan,
 * never a wrong id. A reservation cannot be built on discard-and-continue: discarding a reservation
 * IS the collision. So reservations live under `<root>/state/` beside `triage.lock` and
 * `last-auto-triage.json`, one file per id, and their atomicity comes from `O_EXCL` — not from
 * validate-then-trust. Nothing here reads or writes the git-common-dir.
 */
```

## TaskIdReservationError

### Base lines 81-96 — the paid-worker trap ($0.96 measured spawn cost) and the W1-T949 design (iv) structured-fields argument

```
/**
 * Raised when a reservation cannot be taken for a reason that is NOT contention — an unwritable
 * state directory, a full disk, a permissions fault, an unreachable remote, or an exhausted scan
 * window.
 *
 * LOUD ON PURPOSE (the paid-worker trap). `triageCommandLocked` reserves BEFORE it spawns, and a
 * triage spawn costs real money (median $0.96, measured over 23 runs). A minter that cannot
 * reserve must REFUSE rather than spend — a silent fallback to the unreserved id would spend the
 * money AND then collide, which is strictly worse than not running.
 *
 * CARRIES STRUCTURE, NOT JUST PROSE (W1-T949 design (iv)). Every throw site in this module that
 * can name the id/ref/outcome it failed on now does, on the error itself — so a caller no longer
 * has to re-parse this class's own message to log something a week-later reader can query. Fields
 * are `undefined` wherever a throw site genuinely has none to give (e.g. an unwritable directory
 * names no single id), never a placeholder string.
 */
```

## reserveTaskIdFrom

### Base lines 156-172 — the phantom-id trap, naming the four already-lost ids (W1-T199, W1-T224, W1-T247, W1-T263)

```
/**
 * Reserve the first id at or above `startId` that no LIVE holder has claimed, and return a handle.
 *
 * CONTENTION ADVANCES, IT DOES NOT REFUSE — this is the whole point. Two callers that mint the
 * same id both arrive here with the same `startId`; `O_EXCL` lets exactly one create the file, and
 * the loser moves to `startId + 1` and wins that. Both get an id, neither collides, and no caller
 * has to wait. Refusing on contention would merely convert a plan-poisoning collision into a
 * stalled queue.
 *
 * A DEAD HOLDER IS RECLAIMED, NEVER BURNED (the phantom-id trap). This repo already has four ids
 * that were filed and folded away (W1-T199, W1-T224, W1-T247, W1-T263); a reservation that
 * outlived its process would be a FIFTH mechanism for holes in the id space. So a file whose pid
 * is dead — or whose contents are garbage — is unlinked and the SAME id retried, exactly as
 * `acquireDrainLock` reclaims a stale lock. Reclamation is LAZY, at acquire time: no background
 * reaper exists or is needed, and a crashed minter's id returns to the pool the moment anyone next
 * looks at it.
 */
```

## FirstUnreservedOpts.readRemoteHeld

### Base lines 246-257 — the injected-reader design argument and the unchanged-default-behaviour guarantee

```
  /**
   * Reads which ids are held on a store OTHER than `dir` — in production, the remote's
   * `refs/rmd-id/*` namespace (W1-T509), which every writer shares and `dir` (a worker sandbox's
   * local, ephemeral directory) does not. Returns the held ids, or the literal `"unknown"` when
   * that store could not be read.
   *
   * DEFAULTS TO REPORTING NOTHING HELD — today's local-only behaviour, unchanged for every
   * existing caller. The reader is INJECTED, never opened here: this function still performs no
   * I/O beyond `dir`, and a caller that never supplies one gets exactly the read it got before
   * this parameter existed.
   */
```

## firstUnreservedAtOrAbove

### Base lines 260-276 — the advisory-read design argument and the asymmetric-failure rule

```
/**
 * The first id at or above `startId` that no LIVE holder has claimed — WITHOUT reserving it.
 *
 * For advisory readers (`rmd next-task-id`) which must SEE reservations but must not take one: an
 * operator asking "what id is next" thousands of times must not burn thousands of ids, and a
 * reservation held by a process that exits microseconds later reserves nothing anyway. Reporting
 * a number and claiming it are different acts, and only the caller that will actually FILE should
 * claim.
 *
 * THE FAIL DIRECTION IS NOT SYMMETRIC BETWEEN THE TWO STORES. `dir` missing is a NORMAL state — a
 * fresh worker sandbox that has reserved nothing locally yet — and reads as "nothing held here",
 * exactly as it always has. `readRemoteHeld` reporting `"unknown"` is DIFFERENT: it means a store
 * that may hold something could not be consulted, and folding that into a number would be exactly
 * the defect this function exists to close — reporting an id FREE when the remote already holds
 * it. So `"unknown"` propagates straight through as this function's own result instead of being
 * silently treated as "nothing held there either".
 */
```

## reserveTaskIdBlock

### Base lines 298-318 — why a block exists at all, the #1075 triage gap it closes, and the phantom-id trap restated for the block case

```
/**
 * Reserve `count` ids at or above `startId`, as a block.
 *
 * WHY A BLOCK EXISTS AT ALL. `rmd plan --mode=create` and `--mode=expand` both file "one or more"
 * tasks, and the count is not knowable until the worker has run — but the ids must be reserved
 * BEFORE it spawns, or the reservation guarantees nothing. Reserving a bounded block up front and
 * releasing the whole of it afterwards is the only ordering that both spends nothing on a collision
 * and leaves no id stranded.
 *
 * THIS ALSO CLOSES A GAP #1075 LEFT IN TRIAGE, which is worth stating plainly: triage reserves ONE
 * id and then tells its worker "if you need more, number them upward" (lib/triage.ts) — so a triage
 * run filing two tasks has its SECOND id unreserved, and that id is exactly what a concurrent plan
 * run would take. A block is what makes "more than one" safe for either lane.
 *
 * EVERY ID IS RELEASED, INCLUDING THE ONES NOBODY USES — the phantom-id trap. The four ids this repo
 * has already lost (W1-T199, W1-T224, W1-T247, W1-T263) were lost by being filed and folded away; a
 * block that reserved five and released one would be a fifth way to punch holes in the id space.
 * {@link TaskIdReservationBlock.releaseAll} is called from the caller's `finally`, so the used and
 * the unused are freed on exactly the same path, and a partial failure mid-acquire releases what it
 * already took before rethrowing.
 */
```

## Remote reservation (W1-T509)

### Base lines 354-389 — the four falsification results measured against the real remote at c271f298, and the clone-hygiene argument for the `refs/rmd-id/` namespace

```
// ── REMOTE RESERVATION (W1-T509) — the substrate the design above never had ───
//
// EVERYTHING ABOVE IS RIGHT AND STAYS. `O_EXCL` is a genuine create-if-absent and the
// contention-advances rule is the correct policy. What it lacked was a substrate any OTHER
// writer can see: `taskIdReservationsDir` resolves under `<config.root>/state`, and for a worker
// that is a path inside a bwrap sandbox discarded when the worker exits — not merely local,
// EPHEMERAL BY CONSTRUCTION. Two writers on two hosts never observe each other's files, which is
// why eight id collisions landed in four days and two of them refused `loadPlan` on origin/main.
//
// THE SUBSTRATE EVERY WRITER SHARES IS THE REMOTE'S REF STORE, AND THREE OBVIOUS WAYS TO USE IT
// DO NOT LOCK. All four results below were reproduced against the real remote at c271f298:
//
//   (1) A TAG IS NOT A LOCK. `git push <sha>:refs/tags/X` onto an EXISTING tag holding that SAME
//       sha exits 0 with `Everything up-to-date`. A reservation is exactly that case whenever
//       writers share an anchor commit, so the second writer is told it succeeded. Only a
//       DIFFERING sha is rejected (`the tag already exists in the remote`).
//   (2) `--force-with-lease=<ref>:` (an empty expected value, i.e. "require this ref to be
//       absent") DOES NOT RESCUE IT: against an existing ref holding that sha it also exits 0
//       with `Everything up-to-date`, because git elides the push when local and remote already
//       agree — no ref update is negotiated, so no lease is ever checked. CONTROL: the identical
//       lease against a genuinely absent ref creates it.
//   (3) `git update-ref --stdin` with `create` is LOCAL ONLY. It reports success and the remote
//       never hears about it (measured: local ref 1, remote ref 0).
//
// (4) WHAT DOES WORK IS A PAYLOAD UNIQUE TO THE WRITER. Push an ORPHAN commit — no parents, empty
//     tree — and two writers can never share a sha. The second push is then a non-fast-forward
//     against an unrelated history, which the server refuses STRUCTURALLY rather than by policy:
//     writer A -> `[new reference]` rc=0; writer B on the SAME id -> rc=1 rejected; writer B on a
//     different id -> rc=0. THE CAS IS A PROPERTY OF THE PAYLOAD, NOT OF THE NAMESPACE.
//
// THE NAMESPACE IS `refs/rmd-id/`, AND THAT IS ABOUT CLONE HYGIENE RATHER THAN LOCKING. Measured:
// with probe refs live, a default `git fetch` brought down NONE of them while a probe TAG on the
// same fetch DID — so a tag scheme would put a ref per id in every clone forever. It is also
// outside `reapBranchesCommand`'s view by construction: that command enumerates
// `git ls-remote --heads`, which is `refs/heads/` only, so a reservation can never read as
// undeclared branch drift against `DECLARED_BRANCH_GUARDS`.
```

## remoteReservedTaskIds

### Base lines 407-420 — the measured 793-reservation-ref namespace and the allocatable-filter argument

```
/**
 * Every ALLOCATABLE id the `refs/rmd-id/` namespace already holds on origin, from ONE `ls-remote`
 * — the whole namespace in a single round trip, against one failed push per taken id.
 *
 * ⚠ THE ALLOCATABLE FILTER IS LOAD-BEARING, NOT TIDINESS. Measured on this repo's origin: 793
 * reservation refs, whose highest numbers are 1000002 and 1000003 — far above
 * {@link MAX_ALLOCATABLE_TASK_ID}. Seeding from a raw maximum would move every future mint to
 * 1000004 and keep it there permanently, converting a slow allocator into a broken one. The same
 * bound `mintNextTaskId` applies per source applies here, for the same reason.
 *
 * `"unknown"` on any failure: this is an optimisation, so a remote that cannot be enumerated
 * degrades to today's walk rather than refusing. That is the opposite of {@link
 * RemoteRefReserver.attempt}'s fail-closed posture, and deliberately so — a bad READ here costs
 * attempts, while a bad read THERE would skip a live id.
 */
```

## ReserveRemoteOpts.maxScan

### Base lines 523-526 — the measured 11,213-call GraphQL rate-limit incident

```
  /** How far above `startId` to advance before refusing. Bounded and LOUD: an unbounded retry
   *  against a network service is how 11,213 GraphQL calls were spent against a 5,000/hour limit
   *  in one morning, and this loop talks to the same host. */
```

## withIdReservationLogging

### Base lines 549-563 — the W1-T949 design (iv) argument for one wrapper instead of three lane-local catch blocks

```
/**
 * Run `body`; on a {@link TaskIdReservationError} emit ONE durable ledger row under `step` before
 * rethrowing the error UNCHANGED. Any other error passes through untouched and unlogged.
 *
 * WHY A WRAPPER AND NOT A `catch` AT EACH CALL SITE (W1-T949 design (iv)): all three filing lanes
 * — triage, plan and approve — need the identical refusal record, and each had written its own
 * `catch` around its own `reserveTaskIdBlockRemote` call. Three copies of one policy is three
 * places for it to drift, and none of them was reachable from a unit test: they live inside
 * `run-task.ts`'s lane bodies, so the only way to execute them is to drive a whole lane into a
 * remote failure. Here the policy is one function with both arms exercised directly, and the
 * lanes carry only the step name and any lane-specific field.
 *
 * `extra` is spread FIRST so a lane-specific key (approve's `proposal_id`) leads the row and can
 * never shadow the four fields {@link idReservationFailureFields} contributes.
 */
```

## reserveTaskIdRemote

### Base lines 578-596 — the fail-closed rationale (origin/main taken down twice) and the hole-is-not-a-defect argument (~24 KiB corpus size)

```
/**
 * Reserve the first id at or above `startId` that no other writer holds ON THE REMOTE.
 *
 * SAME POLICY AS {@link reserveTaskIdFrom}: contention ADVANCES rather than refusing, so two
 * writers that minted the same candidate both leave with an id and neither poisons the plan.
 *
 * AN UNREACHABLE REMOTE REFUSES TO MINT, and that is the fail-closed choice rather than an
 * oversight. A writer that cannot reserve could mint optimistically and reconcile later — but
 * "mint optimistically" is precisely today's behaviour, and today's behaviour took `origin/main`
 * down twice. Refusing is loud, local, and immediately actionable; the caller has not yet spent
 * anything when it fires.
 *
 * NOTHING RELEASES A RESERVATION, AND THAT IS DELIBERATE. An abandoned filing burns an id
 * forever; ids are integers and a ref is a few dozen bytes, so the whole corpus of ~550 costs
 * around 24 KiB. Release-on-merge would add a distributed-state problem (who releases, on what
 * event, what if it half-fails) to buy back something free, and a gap in the id sequence is
 * already normal — this repo carries four ids that were filed and folded away. A HOLE IS NOT A
 * DEFECT; A COLLISION IS.
 */
```

## reserveTaskIdRemote — seeding

### Base lines 604-614 — the measured 15-attempt, 13.50-second single-id discovery cost

```
  // SEED FROM THE NAMESPACE THIS FUNCTION ALREADY OWNS. The advisory mint derives its number from
  // plan/tasks.yaml, the shards, open PRs and plan history — four surfaces, none of which is
  // `refs/rmd-id/`. So the reservations THIS function created are invisible to the number it is
  // handed, and it rediscovered them one failed push at a time: measured on this host, 15 attempts
  // and 13.50s for a single id, growing by one with every id the fleet takes.
  //
  // ONLY EVER UPWARDS (`Math.max`): a floor below the caller's own start would hand back an id a
  // plan surface already owns, which is the collision this allocator exists to prevent. And only
  // for the DEFAULT id family — a caller supplying `idFor` is minting in some other namespace that
  // `refs/rmd-id/W1-T<n>` says nothing about.
```

## reserveTaskIdBlockRemote

### Base lines 653-673 — the W1-T949 design (i), (iii) and (v) arguments: partial-acquire-throws, the paired falsifier, and the local-block parallel

```
/**
 * Reserve `count` ids at or above `startId`, EACH on the remote — the remote-substrate twin of
 * {@link reserveTaskIdBlock}, and the fix W1-T949 exists for: `reserveTaskIdRemote` alone has
 * exactly one call site and reserves exactly one ref, while a filing that mints N ids (triage's
 * own "number them upward" instruction, or the plan/approve lanes' local block) needs N refs
 * pushed to the ONE store every writer shares — not one, and not a fixed count regardless of N
 * (design (v): the paired falsifier a fixed-block implementation would still pass).
 *
 * SAME CONTIGUOUS-FROM-THE-WINNER CHAINING {@link reserveTaskIdBlock} uses locally: each
 * reservation asks ABOVE the id the previous one actually won (`next = h.id + 1`), so contention
 * on any one candidate advances the whole rest of the block past it rather than re-colliding.
 *
 * PARTIAL ACQUIRE THROWS, IT DOES NOT RETURN A SHORT BLOCK (design (i)). A caller must never be
 * handed a block claiming to hold `count` ids while actually holding fewer — so a failure partway
 * through (an unreachable remote, an exhausted scan) throws the SAME {@link TaskIdReservationError}
 * {@link reserveTaskIdRemote} throws, carrying the id/ref/outcome it failed on, rather than
 * returning a partial result the caller could mistake for the whole. Whatever refs were already
 * pushed before the failure STAY pushed — there is nothing to roll back to (see this module's own
 * "NOTHING RELEASES A RESERVATION" doctrine): a hole in the id space is not a defect here, exactly
 * as it is not one for {@link reserveTaskIdBlock}'s unused-but-reserved local ids (design (iii)).
 */
```
