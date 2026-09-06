# Forensics: src/lib/auto-triage.ts

Every measured fact, incident and design argument the comments in `src/lib/auto-triage.ts` used
to carry, archived VERBATIM when that file's comments were compacted to the plain-language
standard (`docs/comment-standard.md`).

Nothing here is a rule. `auto-triage.ts`'s behaviour lives in the code and its tests, and each
block below is quoted exactly as it stood on `origin/main` at `7cdff72ade45751b97a0d44b10e9d3675a32d733`,
under a heading naming the symbol or section it explained. The code keeps a one-line `// Why:`
pointer wherever that history still matters.

---

## Module header

`src/lib/auto-triage.ts:6-45` at `7cdff72a`, 40 comment lines.

```
/**
 * lib/auto-triage.ts — the daemon's SECOND work-generating rung (recon-DC #2).
 *
 * THE GAP THIS CLOSES. The daemon has exactly one rung that CREATES work — the retro, wired by
 * W1-T160 at daemon.ts's poll loop. Everything else consumes a queue something else filled. So
 * ~68 feedback entries sit at `status: new` while the daemon idles: `triageCommand`'s only caller
 * is the CLI (run-task.ts), and nothing turns a feedback entry into a task unattended.
 *
 * WHAT IT DOES, AND EMPHATICALLY WHAT IT DOES NOT. At most ONE entry per fire window. recon-DC
 * rejected draining the backlog in as many words — "the whole backlog is ~$64 unsupervised and 68
 * approvals — worse than idle".
 *
 * THE PER-RUN COST IS ~$1.09 MEAN, NOT THE ~$2.00 THIS COMMENT USED TO CARRY. That figure was
 * extrapolated from a SINGLE $2.03 run, and a single observation of a skewed quantity is a
 * worst-case sample, not a mean — it inflated the projected daily spend by ~2x. RE-DERIVED over 70
 * runs: mean $1.09, median $1.03, p90 $1.77, max $2.86, with only 5 of 70 at or above $2.00. The
 * restraint below is still the point; it is simply bounded against a real distribution now.
 * Three independent bounds apply, and ALL must pass:
 *   1. `enabled` — policy data, DEFAULT FALSE. A rung that ships on is a surprise, not a rung.
 *   2. `minIntervalMinutes` — the floor between two fires. This is what makes "one per idle
 *      PERIOD" enforceable rather than aspirational: the daemon polls every 60s and idled ~390
 *      times in ten hours, so a per-POLL rung would have spent ~$780 in one night.
 *   3. `maxPerDay` — a hard ceiling on a rolling 24h window, so a pathological idle/dispatch
 *      flap cannot outrun bound 2.
 *
 * FAIL-SOFT AND FAIL-CLOSED, matching the retro: an unreadable marker REFUSES to fire (never
 * replays a torn state), and every error is the caller's to log — this module throws only on
 * programmer error, never on I/O.
 *
 * ★ THE LOCK IS NOT OPTIONAL, AND IT IS WHY THIS RUNG COULD NOT BE BUILT BEFORE. The task id is
 * minted from a SNAPSHOT before the worker runs (lib/triage.ts). Two triage runs that start before
 * either pushes mint the SAME id, and since PR #1060 each writes its own
 * `plan/tasks.d/<id>-<slug>.yaml` — DIFFERENT filenames, so both merge CLEANLY and `loadPlan`
 * throws duplicate-task-id ON MAIN. Before #1060 that collision was a loud EOF conflict; now it is
 * a poisoned plan. The daemon loop being single-threaded protects daemon-vs-daemon only; NOTHING
 * stopped a hand-run racing it, and this rung makes that far likelier because the operator cannot
 * see that the daemon is about to fire. {@link triageLockPath} is therefore acquired by BOTH the
 * rung and the CLI path, through the same `drain-lock.ts` primitive (atomic `O_EXCL` create, dead
 * pid reclaimed), so `rmd triage` typed by hand during a fire REFUSES loudly.
 */
```

## The cross-host triage claim

`src/lib/auto-triage.ts:52-81` at `7cdff72a`, 30 comment lines.

```
// ── THE CROSS-HOST TRIAGE CLAIM (W1-T1132) ───────────────────────────────────────────────────
//
// WHAT THE LOCK ABOVE CANNOT DO, AND WHY THIS IS NOT A SECOND SPELLING OF IT. `triageLockPath` is
// a file under `<root>/state` reclaimed by PID liveness (`drain-lock.ts`), so it protects ONE
// host. W1-T300's in-flight guard IS cross-host — it reads an OPEN triage PR on GitHub, which
// every host shares — and W1-T1019's wiring landed 2026-08-20. The collisions this closes are
// 2026-08-22, TWO DAYS LATER: #2452 and #2462 wrote mirror-image verdicts for entries the other
// had already decided, and neither could merge because resolving them means PICKING A TRIAGE
// VERDICT, which no merge strategy can do.
//
// THE DEFECT IS THE SIGNAL'S TIMING, NOT ITS REACH. A triage PR does not exist until the triage
// FINISHES. The entry is read, grounded, researched and only then written, with an Architect call
// in the middle, so the window between "lane starts" and "lane publishes" is MINUTES. Two lanes
// starting anywhere inside it both ask "is there an open PR for this entry", both are correctly
// told NO, and both spend. A guard that reads PUBLISHED work cannot see work in flight — so this
// claim is taken BEFORE the Architect call, which is the one thing an open-PR read can never be.
// It ADDS to W1-T300's guard; that guard still correctly refuses an entry whose PR is already open.
//
// MIRRORS `reserveTaskIdRemote` (W1-T509) RATHER THAN INVENTING A PRIMITIVE. Same substrate (a
// ref on origin, created only if absent, so the winner is decided by git's own atomic ref update),
// same anchor shape (an orphan commit whose payload is unrelated to every other writer's), and the
// SAME `classifyPushFailure` — imported, not re-derived, because two copies of "is this contention
// or an unreachable remote" is two places for it to drift. A PID is deliberately NOT used: a
// second host cannot ask whether a pid on the first is alive, which is exactly why the file lock
// could never have been widened into this.
//
// THE LOSER REFUSES; IT DOES NOT ADVANCE. `reserveTaskIdRemote` advances on contention because for
// a MINT the next id serves the caller equally well. A triage has no substitute: the second lane's
// output is either a contradicting verdict that cannot merge, or a rediscovery of a verdict already
// reached. Both are waste, so the loser refuses THIS entry and is free to take a different one.
```

## decideTriageClaim

`src/lib/auto-triage.ts:101-108` at `7cdff72a`, 8 comment lines.

```
/**
 * PURE. Turn one attempt outcome into the proceed/refuse verdict and its wording.
 *
 * AN UNREACHABLE ORIGIN REFUSES, matching `reserveTaskIdRemote`'s own fail-closed choice for the
 * same reason: proceeding optimistically is precisely today's behaviour, and today's behaviour
 * spent two Architect calls on unmergeable mirror-image verdicts. Refusing is loud and costs
 * nothing — the caller has not yet spent when this fires.
 */
```

`src/lib/auto-triage.ts:112-114` at `7cdff72a`, 3 comment lines, inside the `"taken"` branch.

```
    // NAMED, NOT ANONYMOUS: the ref AND the anchor a live holder wrote. "Someone else is doing it"
    // is unactionable; a ref an operator can `git ls-remote` and an anchor they can `git show` is
    // the difference between a refusal and a mystery.
```

## decideTriageClaimRelease

`src/lib/auto-triage.ts:155-172` at `7cdff72a`, 18 comment lines.

```
/**
 * PURE. The three-arm release, in order, with NO TIME-BASED EXPIRY.
 *
 *  1. HOLDER — the lane that took the claim drops it on completion, in a `finally`, success or not.
 *  2. EVIDENCE — a claim whose entry has an OBSERVABLE triage outcome is releasable by ANY host.
 *     The entry is demonstrably done, so the claim is demonstrably stale; no liveness question is
 *     asked because none can be answered.
 *  3. OPERATOR — anything else. Cross-host liveness is NOT decidable (that is the whole reason a
 *     pid lock could not be widened), so the honest answer is a person, not a guess.
 *
 * WHY NOT A TIMER, BY NAME. W1-T1067's stranded `drain.lock` is the precedent for what a
 * time-or-restart-shaped release does when the releasing signal never arrives. And the failure
 * runs the other way too: a triage is MINUTES long with an Architect call in the middle, so any
 * expiry short enough to clear a stuck claim promptly is short enough to fire on healthy work —
 * this repo's own recurring "a bound that fires on a HEALTHY condition" defect. A claim that
 * outlives its lane is a visible ref an operator can drop; a claim that expires under a running
 * lane re-opens the exact race this exists to close.
 */
```

## recordAutoTriageFire

`src/lib/auto-triage.ts:411-424` at `7cdff72a`, 14 comment lines.

```
  // W1: THE DIRECTORY IS CREATED, NOT ASSUMED — and the failure mode this closes is the expensive
  // one. A bare write into an absent `state/` throws ENOENT BEFORE the marker lands, and an absent
  // marker correctly resolves to NO PRIOR FIRE, so the cadence check reads `fire: true` on every
  // tick forever and each fire pays for a whole re-read. MEASURED on a root without `state/`:
  // three consecutive ticks, all `fire: true`, no marker on disk, every run throwing.
  //
  // FOUR OF THE SEVEN `last-*.json` WRITERS ALREADY DO THIS (`last-seen.ts`, `digest.ts`,
  // `feedback-docket.ts`'s `writeFeedbackDocketMarker`, `retro.ts`) — one of them,
  // `recordDigestCadenceFire`, mkdirs and then delegates HERE, which is a caller working around
  // this very gap. This makes the writer carry the guarantee instead of its callers.
  //
  // IT CHANGES NOTHING ELSE. Same path, same contents, same rolling-window argument, and the
  // read side is untouched: a marker that EXISTS and cannot be parsed still fails closed, while an
  // ABSENT marker still means no prior fire. That distinction is the point and survives.
```

## AutoTriagePolicy maxPerDay

`src/lib/auto-triage.ts:442-447` at `7cdff72a`, 6 comment lines.

```
  /**
   * The hard ceiling on a rolling 24h window. WITH THE CURVE GONE THIS IS THE ONLY SPEND BOUND
   * LEFT, and is load-bearing for the first time: the interval used to stop the rung long before
   * the cap could, so the cap has bound only 12 times ever. At the measured ~$1.07 mean per
   * triage, 24/day is about $26 against a `dailyCostCeilingUsd` of 500.
   */
```

## AutoTriageInputs deferralPending

`src/lib/auto-triage.ts:453-468` at `7cdff72a`, 16 comment lines.

```
  /**
   * W1-T469 — THE PARTITIONER DEFERRED AT LEAST ONE PAIRING THIS TICK, i.e. capacity AND runnable
   * work both existed and `partitionByFileOverlap` refused to pair them. This REPLACES the former
   * `idle` conjunct on the operator's ruling.
   *
   * WHY NOT `idle`. The pre-W1-T469 field was set only inside `daemon.ts`'s idle branch, so its
   * guard was UNREACHABLE from the daemon and a BUSY TICK LOGGED NOTHING AT ALL — measured: 0 of
   * 1,214 `auto_triage.skipped` rows carried its reason, against 666 carrying the daily-cap reason
   * on the same corpus.
   *
   * THIS IS NO LONGER THE ONLY TRIGGER — see {@link AutoTriageInputs.dispatchCount}. W1-T469 shipped
   * it as the sole conjunct and that was CIRCULAR: a deferral requires TWO eligible tasks to collide,
   * so with zero eligible tasks there is nothing to defer, and the rung that CREATES work could only
   * fire when work already existed. MEASURED on a starved daemon: `auto_triage.skipped — "no deferral
   * this pass"` beside `dispatch.starvation.escalated — blocked: 5, unmet_deps: 3`, with ~87 feedback
   * entries unread while the fleet starved for thirteen hours.
   */
```

## AutoTriageInputs dispatchCount and laneBudget

`src/lib/auto-triage.ts:471-486` at `7cdff72a`, 16 comment lines.

```
  /**
   * How many tasks this tick ACTUALLY dispatched, and the lane budget it had to fill. Together they
   * carry the second trigger: `dispatchCount < laneBudget` means THE QUEUE COULD NOT FILL THE
   * AVAILABLE CAPACITY, which is precisely the state that most needs more tasks.
   *
   * NUMBERS, NOT A PRECOMPUTED BOOLEAN, so this module owns the predicate and can name WHICH state
   * refused it — a caller passing `capacityUnfilled: false` could not tell "the governor left no
   * lanes" apart from "the queue filled every lane", and those are opposite conditions.
   *
   * ★ THIS DOES NOT FIRE ON A FULL FLEET, and that is arithmetic rather than a promise.
   * `laneDispatchBudget` (`src/lib/drain.ts`) returns `Math.min(lanes, headroom)` over two
   * `Math.max(0, …)` terms, so the budget is never negative; when the governor holds every lane it
   * is exactly 0, `runnableCandidates` returns `[]` at `limit <= 0`, and `0 < 0` is FALSE. The four
   * states, enumerated: lanes full ⇒ 0/0, silent. Starved ⇒ 0/N, FIRES. Partial fill ⇒ 1/N, FIRES
   * (the queue ran out below capacity — still "send more work"). Full fill ⇒ N/N, silent.
   */
```

## The decideAutoTriage trigger

`src/lib/auto-triage.ts:524-531` at `7cdff72a`, 8 comment lines.

```
  // ── THE TRIGGER: ANY ONE OF THREE SIGNALS (W1-T2289 widens the W1-T469/operator-ruling OR) ───
  // Two shapes of "the fleet could use more work" already existed here, and BOTH describe THIS
  // TICK's dispatch rather than the queue this rung exists to drain — a fleet that is busy AND
  // fully dispatching (3 lanes full for 33h, 2026-08-25) can hold both false forever while
  // `candidates` grows without bound, because neither predicate can be made false by a backlog
  // growing or true by one. `backlogPresent` is the THIRD signal that closes that gap, and it is
  // read off the SAME `candidates` this function already received — a reordering of an existing
  // read (rationale (9): "already paid for"), never a new one.
```

## Naming the declined branch

`src/lib/auto-triage.ts:535-540` at `7cdff72a`, 6 comment lines.

```
    // THE REFUSAL NAMES WHICH BRANCH DECLINED, because one undifferentiated string would rebuild
    // the exact blindness W1-T469 existed to fix, one layer further in. The two lane-signal false
    // cases are OPPOSITE conditions and must never read the same in the ledger; the depth signal
    // is a THIRD, independently named way to decline (note (vii)) — appended, never merged into
    // either lane phrase, so a later investigation can tell "the lanes disagreed" from "the queue
    // itself was empty" without cross-referencing candidates.length by hand.
```

## The interval floor

`src/lib/auto-triage.ts:556-562` at `7cdff72a`, 7 comment lines.

```
  // THE FLOOR, READ DIRECTLY (W1-T475 ruling). The adaptive curve that used to sit here was a
  // SECOND, WEAKER GOVERNOR on the same quantity `maxPerDay` already bounds exactly, and it was
  // keyed to a proxy that is uncorrelated with capacity in BOTH directions: `depth` counted the
  // recoverable backlog of tasks that CANNOT run, so a queue of purely colliding-but-eligible
  // work read 0 and triaged at the FAST end while lanes sat empty, and a dependency-blocked
  // queue read high and throttled to 60m with no capacity problem at all. Deleting it leaves the
  // cap as the single bound and this floor as the only thing stopping a per-tick fire.
```

## The named refusal reason

`src/lib/auto-triage.ts:569-572` at `7cdff72a`, 4 comment lines.

```
      // STILL LOGGED, STILL NAMED. This reason string is how the rung is measured at all; a
      // branch that stopped emitting would leave the next investigation blind (this repo already
      // has one rung whose "daemon is not idle" reason is unreachable and appears 0 times in
      // 1,214 skip rows). One wording now, because there is one interval.
```

## Oldest first

`src/lib/auto-triage.ts:587-599` at `7cdff72a`, 13 comment lines.

```
  // OLDEST FIRST. Two reasons, and the second is the load-bearing one. (a) An entry that has waited
  // longest has, by construction, been declined by every prior fire — newest-first would starve the
  // tail forever, which is exactly the state the backlog is in now. (b) It is STABLE: the same
  // input yields the same pick, so a fire that fails and retries next period does not skip ahead.
  // THE REASON NAMES THE GATE THAT ACTUALLY HELD. It read "idle, under both bounds, …" until
  // W1-T469, which is the wording of a conjunct that no longer exists — a fired row asserting
  // idleness while the rung fires precisely on a BUSY tick would send the next investigation
  // looking for an idle period that never happened.
  // AND THE FIRED ROW NAMES ITS TRIGGER TOO. A fire that said only "under both bounds" would leave
  // the next investigation unable to tell a collision-driven fire from a starvation-driven one —
  // the same question the refusal above answers, asked from the other side. W1-T2289 adds the
  // THIRD name: a depth-admitted fire says so explicitly, carrying the count AND the age of the
  // oldest entry as two SEPARATE numbers (note (ii)) rather than folding one into the other.
```

## feedbackEntriesOldestFirst

`src/lib/auto-triage.ts:613-624` at `7cdff72a`, 12 comment lines.

```
/**
 * THE ONE READ of `<root>/plan/feedback/*.yaml` — both {@link newFeedbackIdsOldestFirst} (the
 * COUNT) and {@link oldestFeedbackAgeMs} (the AGE) build on this, so there is exactly one place
 * that walks the directory and exactly one root-passing convention for a caller to get right
 * (W1-T2289 note (ix): a caller that passes `config.root` here instead of `repoRoot` finds no
 * directory at all and answers empty/zero without erroring — a false "healthy" reading a second
 * copy of this walk could silently reintroduce).
 *
 * Deliberately reads only each entry's OWN state. recon-CQ/recon-CS classified a large subset
 * (17 ANSWERED, 14 CLEARLY LIVE, 38 UNCERTAIN) but those verdicts live in report files, not in the
 * entries — consuming them would couple this rung to a markdown artifact nobody maintains.
 */
```
