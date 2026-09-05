# Forensics — `src/lib/drain.ts`

A verbatim archive of comment blocks compacted out of `src/lib/drain.ts`. Each heading names
the symbol the block explained. The source file keeps a one-line `// Why:` pointer where the
history mattered; this page holds the measured forensics that pointer stands in for.

Line numbers below are the block's first line in `src/lib/drain.ts` at the merge base.

## module header

Archived from `src/lib/drain.ts` lines 1-16 at the merge base.

```text
/**
 * `rmd drain` — a THIN, SAFE loop over the PROVEN run-task machinery (WS-1). It
 * resolves the next runnable task from the DAG, runs it via the existing run-task
 * path, and repeats — preserving plan sequencing. It invents NO orchestration:
 * dependency logic is `plan.ts`'s ({@link unmetDependencies}), status is
 * GitHub-derived (`status.ts`), the merge gate is unchanged, and headroom is the
 * `headroom.ts` tracker (W1-T4).
 *
 * v1 is deterministic with ZERO LLM decisions and STOPS ON ANY BLOCK — a blocked
 * task's DEPENDENTS would build on missing work, so continuing risks compounding a
 * gap. Skip-and-continue (per-block reasoning) is deliberately NOT built here — it
 * needed the diagnose loop + daemon (W1-T7 + W1-T12a) first, and now lives in the
 * PERSISTENT daemon loop (block-reason.ts, wired into `daemon.ts`'s `runDaemon`,
 * W1-T46), not in this bounded one-shot command. `rmd drain` keeps its blunt
 * stop-on-block on purpose: a human kicked it off by hand and is watching it.
 */
```

## runBranchTaskIds

Archived from `src/lib/drain.ts` lines 79-93 at the merge base.

```text
/**
 * W1-T534 (design (i) — ONE SWEEP PER PASS, NEVER ONE CALL PER CANDIDATE): the set of task ids
 * with a `run-<id>-<epochMs>` branch currently pushed to origin, parsed from the raw multi-line
 * output of a SINGLE `git ls-remote --heads origin 'run-*'` call — measured at 199 ms for 46 refs
 * and IDENTICAL `core` remaining before/after, so `ls-remote` speaks the git protocol and spends
 * neither the REST nor the GraphQL budget, against one round trip per candidate if probed
 * individually. Each line is `<sha>\trefs/heads/<branch>`; a bare `refs/heads/<branch>` or
 * `<branch>` line is also accepted, so a caller can feed either raw `ls-remote` output or a plain
 * ref-name list. Reuses `taskIdFromRunBranch` (status.ts) — the ONE named extractor this repo
 * already tests for the `run-<taskId>-<epochMs>` shape — rather than a second regex, so the
 * anchoring (design (iii): a shorter id can never satisfy a longer branch's ordinal, because the
 * extractor's own greedy match always consumes every digit of the ordinal before the trailing
 * `-<epochMs>`) is proven once and shared, never re-derived here. A line that doesn't parse is
 * skipped, never thrown — a malformed ref degrades to "not observed", never a crashed pass.
 */
```

## closedUnmergedRunBranchTaskIds

Archived from `src/lib/drain.ts` lines 107-126 at the merge base.

```text
/**
 * W1-T1207 (design (i)+(iii)): task ids whose `run-<id>-<epochMs>` branch belongs to a pull
 * request that is CLOSED AND UNMERGED — parsed from a batched, paginated `pulls?state=closed`
 * sweep (the SAME shape `rmd reap-branches` already reads; see run-task.ts's
 * `readRunBranchClosedPrsOutput`), never one lookup per branch — matching `runBranchTaskIds`'s
 * own ls-remote cost argument ("a single sweep, never one round trip per candidate").
 *
 * WHY ONLY THIS ONE STATE. A MERGED pull request's head branch is deleted by GitHub, so it can
 * never appear on the `ls-remote` sweep {@link runBranchTaskIds} parses in the first place — the
 * predicate self-clears and needs no rule here (design (i)). An OPEN or DRAFT pull request still
 * means the work is in flight, so its branch must keep blocking — this function names only the
 * ids whose PR closed WITHOUT merging, the one state that must stop blocking.
 *
 * Rows are `<head-ref>\t<unmerged>`, `unmerged` being the literal string `"true"` when
 * `merged_at` was `null` on that row (i.e. the PR closed without merging) and `"false"` when it
 * was set (a merged row — included because a `state=closed` page mixes both, but skipped here
 * since a merged head can never be a still-pushed branch anyway). A line that doesn't parse, or
 * whose second column isn't exactly `"true"`, is skipped rather than thrown — the same
 * degrade-not-crash discipline {@link runBranchTaskIds} already applies to a malformed ref.
 */
```

## NextRunnableOpts.isCreditIndeterminate

Archived from `src/lib/drain.ts` lines 145-164 at the merge base.

```text
  /**
   * W1-T2675 — CREDIT READ FAILED, WHICH IS NOT THE SAME AS "NOT MERGED". `deriveStatus`
   * (lib/status.ts) returns `{ merged: false, source: "throttled", indeterminate: true }` when the
   * GitHub credit read genuinely FAILED rather than resolving to a clean "no evidence", and
   * {@link StatusProjection.indeterminate}'s own doc states the obligation this probe discharges:
   * "a caller that gates dispatch or a ledger write off this projection MUST treat `indeterminate`
   * as DO NOT ACT, never as an ordinary queued task, because the evidence a 'not merged' conclusion
   * would rest on was never actually consulted."
   *
   * WITHOUT IT THE ADAPTER FAILS OPEN. Every {@link MergedSet} in the repo is spelled
   * `projection.get(id)?.merged ?? false`, which collapses `indeterminate` into a confident
   * `false` — so a task that really shipped is admitted, a worker spawns, and the rebuild cannot
   * pass review because the shard's criteria describe a diff already on main. That is the #3512
   * lifecycle W1-T2675 measured; the pre-existing `isMerged(t.id)` refusal at the top of
   * {@link isDispatchEligible} was never the missing piece and is unchanged.
   *
   * OMITTED ⇒ TODAY'S BEHAVIOUR, EXACTLY — the same convention every other probe on this interface
   * follows. A caller that cannot supply it holds no indeterminate evidence to act on, so there is
   * nothing to fail closed on; it is never a silently widened refusal.
   */
```

## NextRunnableOpts.openSiblingBuildFor

Archived from `src/lib/drain.ts` lines 167-178 at the merge base.

```text
  /**
   * W1-T2397 — THE OPEN-SIBLING OBSERVATION, READ OFF THE PROJECTION THIS PASS ALREADY BUILT.
   *
   * Answers, for the task about to be dispatched: is there an OPEN PR building it that is NOT its
   * own `run-<taskId>-<digits>` branch? `StatusProjection.openSiblingBuild` (status.ts) is where
   * it comes from, so this costs no read of its own.
   *
   * IT IS NOT `isOpenPr` AND MUST NEVER BECOME IT. `isOpenPr` decides eligibility; widening THAT
   * is the refusal W1-T2397 declined on measurement — the naive predicate fired four times in 72
   * hours and three of those merged. This one is consulted AFTER a task has already been chosen,
   * feeds {@link onOpenSiblingBuild} alone, and cannot change what is dispatched.
   */
```

Archived from `src/lib/drain.ts` lines 180-185 at the merge base.

```text
  /**
   * W1-T2397: called ONCE, for the task actually being dispatched, when {@link
   * openSiblingBuildFor} reports an open sibling build. The real wiring writes one ledger row and
   * prints one console line naming BOTH PRs; this module never decides anything on it. Omitted ⇒
   * the observation is not made and dispatch is byte-identical to before this existed.
   */
```

## NextRunnableOpts.isLifetimeCapExceeded

Archived from `src/lib/drain.ts` lines 231-242 at the merge base.

```text
  /**
   * THE LIFETIME DISPATCH CAP (W1-T271): true when this task has been dispatched
   * (status.ts's `isLifetimeDispatchCapExceeded`, ledger-derived, `run.start`
   * lines counted across the task's WHOLE history) the policy-capped number of
   * times, EVER — a SECOND, independent backstop alongside `isCircuitTripped`,
   * never a replacement for it. `isCircuitTripped`'s own count resets to 0 on
   * every new owned PR, which is correct for the failure it guards but makes it
   * blind to a task that re-dispatches forever while merging a genuine no-op PR
   * each time (the W1-T254 incident this cap exists to catch); this count is
   * never reset by anything. Optional — omitted, dispatch behaves exactly as
   * before this cap existed.
   */
```

## NextRunnableOpts.isSinglePathCredit

Archived from `src/lib/drain.ts` lines 262-271 at the merge base.

```text
  /**
   * W1-T951 DELIVERABLE B: true when this ALREADY-MERGED task's durable credit
   * (status.ts's `isSinglePathCredited`, over its `CreditStore`) rests on
   * EXACTLY ONE of the two credit paths — a `Remudero-Task:` trailer XOR a
   * `run-<taskId>-*` head branch, never both. Consulted ONLY on the
   * `"already-merged"` decline (a task {@link MergedSet} already refused to offer for
   * dispatch), so it can never itself change eligibility — this is observation, the
   * same discipline every other optional probe on this interface follows. Optional:
   * omitted, nothing is observed and dispatch behaves exactly as before this existed.
   */
```

Archived from `src/lib/drain.ts` lines 273-281 at the merge base.

```text
  /**
   * Called ALONGSIDE (never instead of) `onFiltered(task, "already-merged")` when
   * `isSinglePathCredit` says so — the DISCOVERABLE SIGNAL design (iii) requires:
   * a task credited by exactly one path is indistinguishable from one credited by
   * both until the single path disappears (rationale (2)/(4) — GitHub deletes the
   * head ref on merge), so a caller watching the dispatch loop (a daemon log line,
   * an idle-reason tally) gets a chance to notice the fragile population BEFORE it
   * silently re-exposes a shipped task as dispatchable `verify: auto` work.
   */
```

## NextRunnableOpts.creditFor

Archived from `src/lib/drain.ts` lines 283-296 at the merge base.

```text
  /**
   * W1-T2675 (criteria 2 and 3 of this task's own filing): resolves the {@link AlreadyMergedCredit}
   * — WHICH credit path matched and the PR that carried it — for a task {@link MergedSet} already
   * refused. Consulted ONLY on the `"already-merged"` decline, exactly where `isSinglePathCredit`
   * above is consulted, and for the identical reason: this can never itself change eligibility,
   * `isMerged(t.id)` alone already decided that. Returns `undefined` when the caller holds no such
   * detail (a bare boolean `MergedSet` carries none) — the refusal still fires, unnamed, byte-
   * identical to before this probe existed. NEITHER THIS PROBE NOR ITS CALLBACK EVER READS
   * `t.status` OR `t.retirement` — the credit union this reports comes entirely from the caller's
   * own GitHub-derived projection (status.ts), never from the hand-authored plan shard; see
   * {@link isDispatchEligible}'s `already-merged` arm, which checks `isMerged(t.id)` before this is
   * even reached and never touches the task's `status` field on this branch, matching CLAUDE.md's
   * rule that a shard's `status:` is not a completion signal and nothing here treats it as one.
   */
```

## NextRunnableOpts.readLiveState

Archived from `src/lib/drain.ts` lines 306-320 at the merge base.

```text
  /**
   * W1-T177 (TERMINAL-STATE CHECK AT EVERY SPENDING SITE): an OPTIONAL fresh
   * re-read of ONE candidate in-flight PR's live GitHub state, consulted
   * ONLY when `isOpenPr` reports a task in-flight — CONFIRMS, with a read
   * that is never the cached `isOpenPr` snapshot (`lastProj`, re-derived
   * once per drain TICK, not once per candidate), whether that PR is
   * genuinely still open right now. Returns the freshly observed state
   * string (e.g. "OPEN"/"MERGED"/"CLOSED"), or `undefined` on a
   * failed/indeterminate read. This site differs in KIND from a spending
   * site: a stale OPEN here wrongly BLOCKS a runnable task rather than
   * wrongly spending on one, so the FAIL-OPEN direction is the same shape
   * but the failure mode is a skip, not a spend — an unreadable state still
   * means "treat as in-flight, skip it" (never "assume terminal, dispatch").
   * Omitted ⇒ behaves EXACTLY as before this check existed.
   */
```

## NextRunnableOpts.isLiveMergeCredited

Archived from `src/lib/drain.ts` lines 344-369 at the merge base.

```text
  /**
   * W1-T1035 (STOOD-DOWN-MERGED-TASK-STILL-ADMITTED). `isMerged(t.id)`, consulted at the TOP of
   * `isDispatchEligible`, is the CREDIT PROJECTION for this whole pass — built ONCE by
   * `refreshMerged()` before the per-candidate walk below it even starts, so by the time this
   * in-flight guard takes its OWN fresh read (`readLiveState`, per candidate) that projection can
   * already be behind it. A fresh MERGED here is therefore ambiguous on its own, and this is the
   * ONE PLACE the chain has fresher information than `isMerged(t.id)` and, before this task, did
   * nothing with it (measured: 24 of 32 `dispatch.stood_down MERGED` rows in the corpus later
   * produced `dispatch.refused_already_merged` for the SAME task — the daemon admitted it, spawned
   * a worker, and the worker refused because the credit projection had simply caught up).
   *
   * TWO SUB-CASES, TOLD APART HERE ONLY WHEN THIS IS SUPPLIED:
   *   - THE STALE-CREDIT CASE — `true`: this exact merge (`prNumber`) DOES credit `taskId` per the
   *     SAME credit rule `isMerged` applies, re-checked fresh rather than read from the pass-start
   *     snapshot. Admitting now would just re-invite `dispatch.refused_already_merged`; the guard
   *     excludes the task instead (see the call site).
   *   - THE W1-T177 CASE — `false` (or this probe omitted entirely): the merge does NOT credit
   *     `taskId` — a PR can merge without crediting the task that opened it, and that task
   *     genuinely still needs a run (`test/drain.test.ts`'s three W1-T177 assertions, which must
   *     keep passing untouched). The task stays admitted, exactly as before this field existed.
   *
   * Consulted ONLY when `readLiveState` has just answered `"MERGED"` for this candidate's open PR
   * — never for `"OPEN"` (still in-flight, already handled) or `"CLOSED"` (abandoned, never
   * credits anyone, always stays admitted). Omitted ⇒ `isDispatchEligible` behaves EXACTLY as
   * before this discrimination existed — the unconditional W1-T177 fall-through.
   */
```

## NextRunnableOpts.hasPushedRunBranch

Archived from `src/lib/drain.ts` lines 380-402 at the merge base.

```text
  /**
   * W1-T534: true when a `run-<taskId>-<epochMs>` branch already exists on origin — AUGMENTS
   * `isOpenPr`, never replaces it (design (ii)): `isOpenPr` reads a CACHED projection
   * (`run-task.ts`'s `lastProj`, re-derived once per drain TICK), so a PR opened — or a branch
   * merely PUSHED, ahead of its PR — after that snapshot was taken is invisible to it, and
   * `isOpenPr` returns `undefined` even though the same id is already in flight. This probe
   * closes exactly that blind spot: it is consulted regardless of what `isOpenPr` answered,
   * because the two checks cover disjoint windows rather than one superseding the other. Build
   * the closure from ONE {@link runBranchTaskIds} sweep per PASS — never one `ls-remote` per
   * candidate, which is the whole cost argument — e.g. `(id) => sweep.has(id)`. Omitted ⇒
   * behaves EXACTLY as before this check existed.
   *
   * W1-T1207: THIS PROBE HAS NO UPPER BOUND OF ITS OWN, AND MUST NOT GAIN ONE HERE — the fix is
   * to read the pull request's state, never to guess when a branch stopped mattering (design
   * (v)). A branch's PR being OPEN or DRAFT, or there being no PR at all, both keep this true,
   * exactly as before; a branch is a leftover, not a signal, ONLY once its PR is CLOSED AND
   * UNMERGED (design (i)) — GitHub does not delete the head on close, only on merge, so a
   * closed-unmerged PR would otherwise leave this predicate answering `true` forever for a task
   * nothing is working on. The caller is expected to build this closure as `sweep.has(id) &&
   * !closedUnmerged.has(id)`, subtracting {@link closedUnmergedRunBranchTaskIds}'s own once-
   * per-pass sweep — never a second predicate threaded separately through this chain, so the
   * "one sweep, never one call per candidate" cost argument above holds for the subtraction too.
   */
```

Archived from `src/lib/drain.ts` lines 404-419 at the merge base.

```text
  /**
   * Called once per task excluded because its run branch already exists on origin (W1-T534) —
   * the SAME kind of event `onSkip` already logs (design (v): "REUSE THE ROW THAT ALREADY
   * EXISTS"), just for the window `isOpenPr` cannot see, so the real wiring rides the same
   * `dispatch.skipped` row with a distinct reason string rather than minting a new one. No PR
   * number is available in this window — that IS the defect this closes: the branch predates or
   * outpaces the cached PR snapshot — so this callback is PR-number-free where `onSkip` is not.
   * The refusal is a SKIP, never a terminal state (design (iv)): the task is not marked done,
   * burns no strike, and is offered again on a later pass once the branch is gone.
   *
   * W1-T1205: fired ALONGSIDE (never instead of) `opts.onFiltered?.(t, "run-branch-already-
   * pushed")` — this callback feeds the ledger row, `onFiltered` feeds any reader of the neutral
   * {@link DispatchFilterReason} tally (status-board.ts's `deriveQueueHead`, W1-T1205's own
   * caller). Before W1-T1205 this exclusion reached ONLY this ledger row, invisible to every
   * other surface; the tally entry is what makes it nameable there too.
   */
```

## dispatchOrder

Archived from `src/lib/drain.ts` lines 423-465 at the merge base.

```text
/**
 * The next runnable task in FILE ORDER (ties broken by declaration order, so plan
 * sequencing is preserved): not itself merged, `verify: auto`, not `blocked`, all
 * `depends_on` merged, and — per `opts.isOpenPr` (W1-T80) — not IN-FLIGHT under an
 * OPEN PR. An OPEN PR means the task's next action belongs to the merge queue, the
 * fix rung (W1-T76), or a human — never a duplicate fresh build (the #143/#145
 * race: a reviewed-green #143 was still un-merged, async, when the drain started
 * again and rebuilt the same task end-to-end as #145). A CLOSED (unmerged) PR does
 * NOT block — an abandoned/superseded attempt leaves the task runnable. Reuses
 * `unmetDependencies` — the DAG logic is never reimplemented here. Returns
 * `undefined` when nothing is runnable.
 */
/**
 * DISPATCH ORDER (impl-DQ). Sort the plan's tasks into a stable, meaningful order before selection.
 *
 * THE DEFECT THIS REPLACES. `loadPlan` (lib/plan.ts) parses `plan/tasks.yaml` and then APPENDS every
 * `plan/tasks.d/*.yaml` shard's tasks with `tasks.push(t)`. Measured on today's plan: the monolith
 * occupies indices 0–268 and the shards 269–312, contiguously after. Both selectors below iterated
 * that array with no sort, so EVERY shard task ranked behind EVERY monolith task, permanently.
 * Dispatch priority was file placement.
 *
 * That became load-bearing on 2026-08-01, when PR #1060 redirected `rmd triage` to propose into
 * shards: from that point everything newly filed sorted last, behind 269 older entries.
 *
 * WHY TASK ID, AND WHAT IT COSTS. Ids are minted monotonically at filing time (the minter maxes over
 * every source and adds one), so ascending id IS filing order — a real, committed, deterministic
 * signal that exists on every task and needs no migration. It makes file placement irrelevant, which
 * is the whole point.
 *
 * THE COST, NAMED RATHER THAN GLOSSED: this DISCARDS the monolith's positional signal. Position in
 * `plan/tasks.yaml` was a soft priority an operator could express by moving a block, and after this
 * change moving a block does nothing. That trade is deliberate — an implicit signal that only half
 * the plan can express, and that silently starves the other half, is worse than a uniform one — but
 * it is a real loss, and an explicit `priority:` field is now the honest successor (W1-T422): the
 * comparator below reads it FIRST, before id, so the operator has a real instrument to front a task
 * again — one that, unlike file placement, exists on every task and needs no migration.
 *
 * DETERMINISM IS ABSOLUTE. The comparator reads only `priority` and `id`, both committed content. It
 * never consults file order, mtime, or enumeration order. Absent `priority` sorts after every task
 * that carries one (`?? +Infinity`), so a plan with no priorities set is byte-identical in order to
 * before this field existed. The numeric-then-lexicographic id tiebreak makes it a TOTAL order, so
 * two runs over the same plan always select the same task.
 */
```

## undeclaredScopeLast

Archived from `src/lib/drain.ts` lines 491-499 at the merge base.

```text
/**
 * W1-T476: 1 when `t.files` is absent or empty, 0 otherwise — an UNDECLARED-SCOPE task sorts
 * LAST among its priority tier instead of by the accident of its id. This does NOT change
 * `overlappingPaths`' fail-closed treatment of that same task (it still serializes against
 * every co-dispatched candidate once it IS offered — see dispatch-overlap.ts); what changes is
 * only that it can no longer do so from the QUEUE HEAD, where a single such task starved every
 * lane behind it (MEASURED: 1 lane admitted where 11 disjoint tasks were eligible). The name is
 * load-bearing — grepped by this task's own acceptance criterion.
 */
```

## idOrdinal

Archived from `src/lib/drain.ts` lines 504-512 at the merge base.

```text
/**
 * Workstream-aware id ordinal: `W<workstream>-T<ordinal>` parses into its two numeric parts,
 * compared workstream-first then task-ordinal — so `W2-T1` no longer outranks `W1-T400` by the
 * accident of a regex over the id's trailing digits (the PRIOR implementation here took the
 * LAST integer run in the id — despite a doc comment that, wrongly, called it "the first integer
 * run" — which is exactly the accident: `W2-T1`'s only integer run is `1`, so it ranked ordinal 1,
 * ahead of the entire W1 backlog). Ids that don't match `W<n>-T<m>` (no workstream prefix) sort
 * after every id that does, then lexicographically via `compareDispatch`'s own final tiebreak.
 */
```

## observeOpenSibling

Archived from `src/lib/drain.ts` lines 519-530 at the merge base.

```text
/**
 * W1-T2397 — the observation, fired for a task THIS PASS HAS ALREADY CHOSEN.
 *
 * ONE EMITTER FOR BOTH SELECTORS. `nextRunnable` (the drain's single-lane pick) and
 * {@link runnableCandidates} (the DAEMON's batch pick) are different loops, and the daemon uses
 * ONLY the second — so an observation living in `nextRunnable` alone never reaches the lane that
 * carries the dispatches (`daemon.boot` 347 / `run.start` 558 against `drain.start` 16, measured
 * over the container's ledger union). Sharing this one function is what stops them drifting.
 *
 * A THROW IS STILL ONLY AN OBSERVATION: W1-T2397's whole argument is that a wrong warn costs one
 * line, and a warn that cost a dispatch would invert it.
 */
```

## DispatchFilterReason

Archived from `src/lib/drain.ts` lines 555-573 at the merge base.

```text
/**
 * Why the eligibility filter declined a task. FIVE of these are the conditions that used to
 * return silently — every OTHER filter (indeterminate, circuit, lifetime cap, open PR) already
 * ledgers itself through its own dedicated `onXxx` callback. `"run-branch-already-pushed"`
 * (W1-T1205) is the exception that proves that split deliberate rather than accidental: it is
 * ALSO ledgered through its own callback (`onSkipRunBranch`, mirroring `onSkip`'s in-flight
 * legibility), but design (iii) of W1-T1205 puts it here too — unlike an open PR or a tripped
 * breaker, nothing is IN FLIGHT and nothing clears it on its own, so a caller reading only this
 * tally (queue-head's own consumer, `deriveQueueHead`) must still be able to name it, never see
 * a task vanish with no reason recorded anywhere this union is consulted. Order matters and is
 * the filter's own: see {@link tallyDispatchFilters} on first-match.
 *
 * `"retired"` (W1-T2474) is `"blocked"`'s own split, not a new gate: `status: "blocked"` still
 * refuses every task it always refused, byte-identical, but a `blocked` task ALSO carrying a
 * `retirement` ruling (plan.ts's `RETIREMENT_REASONS`, W1-T1287) is a deliberate record that will
 * never be built rather than a dependency-stalled one waiting to clear — the two populations a
 * human should read apart, per this task's own rationale. A `blocked` task with no `retirement`
 * files under `"blocked"`, unchanged.
 */
```

## tallyDispatchFilters

Archived from `src/lib/drain.ts` lines 606-615 at the merge base.

```text
/**
 * Accumulate the filter's declines so an idle daemon can say WHY it is idle.
 *
 * FIRST-MATCH, NOT EXHAUSTIVE — and this is deliberate. `isDispatchEligible` short-circuits: a task
 * that is BOTH already-merged AND `verify != auto` is counted only under `already-merged`, because
 * that is the condition that actually stopped it. Evaluating all four to give a "fuller" picture
 * would mean running `unmetDependencies` (a graph walk) on tasks the filter never needed to test,
 * on the hot path, to report a reason that was not the blocking one. The buckets therefore sum to
 * the number of tasks declined by these conditions, never to something larger.
 */
```

Archived from `src/lib/drain.ts` lines 627-631 at the merge base.

```text
    // W1-T988: in the SNAPSHOT (which is what `daemon.idle_reasons` carries), never in
    // idle-reasons-panel.ts's `IDLE_REASON_ORDER`. That asymmetry is load-bearing and already
    // exists — `continued-this-pass` is in the union and not in the panel's order — because the
    // panel returns `kind: "unknown"` the moment any LISTED key is missing from a row, so adding
    // a key there would make EVERY HISTORICAL ROW unreadable.
```

## taskTargetsRepo

Archived from `src/lib/drain.ts` lines 652-669 at the merge base.

```text
/**
 * The exact per-task eligibility chain {@link nextRunnable} and {@link
 * runnableCandidates} both apply, factored out so the two can never drift: a task
 * ineligible for SOLO dispatch must never be offered as a concurrent candidate
 * either. Order matters (see the inline comments on each guard) and is preserved
 * verbatim from nextRunnable's original single-task walk.
 */
/**
 * W1-T988 — the BARE repo name, which is canonical here. MEASURED across the plan: every `repo:`
 * value is bare (1321 `remudero`, 1 `remudero-site`, 1 `none`), and zero carry an owner slug —
 * while `resolveDaemonTarget`'s own doc documents `--repo owner/name` as an ACCEPTED input. So
 * normalisation reduces a slug to its last path segment before comparing, and never the reverse:
 * a task never carries an owner to compare against, so expanding the bare side would have to
 * invent one.
 *
 * A guard that compared raw strings would strand EVERY task the moment an operator passed the
 * slug form — the shape that stops the fleet rather than protecting it.
 */
```

Archived from `src/lib/drain.ts` lines 676-696 at the merge base.

```text
/**
 * W1-T988 — does this task belong to the repo this daemon targets?
 *
 * ⚠ THIS IS A SAFETY GUARD ON A SINGLE-TARGET DAEMON. It is NOT multi-repo support, NOT routing,
 * and NOT the second checkout the architecture would need — that is a second daemon with its own
 * `config.root`, and an operator's decision rather than this predicate's. All this does is refuse
 * work that is not this daemon's own.
 *
 * THE FAILURE IT CLOSES IS A PLAUSIBLE-LOOKING PULL REQUEST, NOT AN ERROR. `repo` is required and
 * validated on every task (`plan.ts`'s `req(e.repo, "repo", id)`), the plan already carries a
 * `remudero-site` task, and MEASURED at origin/main `drain.ts` and `daemon.ts` read a task's
 * `repo` ZERO times — against controls of 75 and 38 id reads in the same modules. A foreign task
 * handed to a worker whose worktree is a `remudero` checkout edits the wrong tree and opens a PR
 * against the wrong repository, with nothing on the path flagging it. The only reason it has not
 * happened is that the one such task carries `verify: human`, which parks it earlier — a property
 * of that task, not a fence.
 *
 * ⚠ ABSENT TARGET MEANS NO GUARD, NEVER REFUSE-ALL. `targetRepo` is optional, so every existing
 * caller — `runnableCandidates`, the panel, every test that builds opts by hand — keeps
 * byte-identical behaviour. A guard that defaults to refusing is the shape that stops the fleet.
 */
```

## runnableCandidates

Archived from `src/lib/drain.ts` lines 843-857 at the merge base.

```text
/**
 * Up to `limit` runnable tasks, packed disjointness-first (W1-T476; see {@link
 * packDisjointFirst}) over dispatchOrder — the multi-candidate generalization of
 * {@link nextRunnable} for a concurrent dispatcher (P19 rung 1, W1-T171; wired by
 * the lane scheduler in W1-T172) to hand to `dispatch-overlap.ts`'s
 * `partitionByFileOverlap`. Applies the EXACT SAME eligibility chain as
 * `nextRunnable` (see {@link isDispatchEligible}) — a task ineligible for solo
 * dispatch is never offered as a concurrent candidate either. `limit <= 0` yields
 * an empty array. This function does not decide `files:` overlap ADMISSION —
 * that partition remains `dispatch-overlap.ts`'s job, kept separate so the
 * DAG/status eligibility logic here never duplicates the pure glob predicate
 * there — but it DOES now consult that same predicate to choose WHICH `limit`
 * candidates to offer, so a disjoint set doesn't get truncated away before
 * `partitionByFileOverlap` ever sees it.
 */
```

Archived from `src/lib/drain.ts` lines 865-873 at the merge base.

```text
  // W1-T2397: OBSERVE, THEN DISPATCH ANYWAY — the SAME placement `nextRunnable` uses, one level
  // over. AFTER eligibility has said yes AND after the pack has chosen, so it fires once per task
  // actually dispatched rather than once per eligible candidate (which is what keeps it quiet: 101
  // of 105 dispatches in 72 hours had no open sibling at all), and BEFORE `collected` is returned
  // UNCHANGED — structurally incapable of altering which tasks this batch dispatches.
  //
  // THIS IS THE DAEMON'S SELECTOR. `runDaemon` calls `runnableCandidates`, never `nextRunnable`, so
  // the observation wired into the latter alone could not reach the lane that carries 97% of
  // dispatches — measured, and the reason this branch exists at all.
```

## packDisjointFirst

Archived from `src/lib/drain.ts` lines 878-896 at the merge base.

```text
/**
 * W1-T476's greedy disjointness-first pack: fills up to `limit` slots from `eligible` (already in
 * dispatchOrder), on each slot preferring the EARLIEST remaining candidate that stays `files:`
 * -disjoint from every candidate already collected — checked via the real `partitionByFileOverlap`
 * (dispatch-overlap.ts), never a re-derived glob comparison — falling back to the next candidate
 * in dispatchOrder when none remain disjoint. This REPLACES the previous plain truncation (take
 * the first `limit` eligible tasks in dispatchOrder), which handed `partitionByFileOverlap`
 * downstream a head that could contain far fewer than `limit` pairwise-disjoint tasks even when a
 * disjoint set of size `limit` existed further back in the eligible list — MEASURED: at lanes
 * 2/3/4 the plain-truncation order admitted 1/1/1 where a disjoint set of that size existed.
 *
 * DETERMINISM: the scan for the next disjoint candidate always walks `remaining` in its current
 * (dispatchOrder-derived) order and takes the first match, so equal inputs yield equal outputs.
 *
 * STABILITY CONTAINMENT (the falsifier's second direction): when NO two candidates in `eligible`
 * are pairwise disjoint, every slot after the first falls back to "next in dispatchOrder" — so
 * the result is byte-identical to the old plain-truncation order. The pack never reorders what it
 * cannot improve.
 */
```

Archived from `src/lib/drain.ts` lines 909-915 at the merge base.

```text
/** True iff `candidate`'s EFFECTIVE scope (declared `files:` unioned with `observedByTask`, W1-T2286)
 *  overlaps NONE of `collected`'s — one pairwise `partitionByFileOverlap` check per already-collected
 *  task, so an undeclared-scope task (which `overlappingPaths` fail-closes as overlapping everything)
 *  never passes once anything is collected, exactly mirroring the real downstream partition's own
 *  verdict. `observedByTask` is passed straight through to that same check — see its own call site
 *  in `runnableCandidates` for why this must be the SAME map the caller later hands the real
 *  `partitionByFileOverlap` pass, not a second, possibly-different one. */
```

## StopReason

Archived from `src/lib/drain.ts` lines 930-937 at the merge base.

```text
  /**
   * W1-T172: the queue governor's WIP ceiling leaves ZERO lane headroom this
   * tick (`laneDispatchBudget` returned 0) — runnable work may well exist,
   * held back by the governor rather than absent (distinct from
   * `no_runnable`, which means nothing is eligible at all). Only reachable
   * via the multi-lane path ({@link runDrainLanes}); the single-lane path
   * never consults the governor and can never produce it.
   */
```

Archived from `src/lib/drain.ts` lines 939-948 at the merge base.

```text
  /**
   * W1-T290: `/usage` came back unreadable on more than {@link
   * UNREADABLE_DEGRADED_LIMIT} (or `DrainOpts.unreadableDegradedLimit`)
   * CONSECUTIVE ticks — the daemon's bounded-degraded ceiling, ported to the
   * drain. Distinct from `headroom_exhausted` (a confirmed at/near-limit
   * reading): this is "the reader itself has gone dark for too long to keep
   * dispatching blind." Only reachable when `DrainOpts.headroomEnabled` is
   * not explicitly `false` — the 2026-07-28 governor ruling makes an
   * unreadable read ABSENT TELEMETRY, never a hold, on a host that opted out.
   */
```

Archived from `src/lib/drain.ts` lines 950-957 at the merge base.

```text
  /**
   * W1-T317: the DAILY COST CEILING (`checkCostGovernor`, sweep.ts) reports the day's ledgered
   * spend at/over `policy.dailyCostCeilingUsd` — new dispatch is held back this pass, distinct
   * from `headroom_exhausted` (an API-usage window) and from `blocked` (a real task failure):
   * drainage is unaffected, only NEW dispatch stops. A future pass (the next `rmd drain`
   * invocation, or the daemon's own idle heartbeat) re-derives the day's spend fresh and resumes
   * once it drops back under the ceiling.
   */
```

Archived from `src/lib/drain.ts` lines 959-968 at the merge base.

```text
  /**
   * W1-T321 (wiring `checkQueueGovernor`, sweep.ts, the W1-T121 23-open-PR incident): the open-PR
   * WIP count is at/over `policy.wipLimit` — new dispatch is held back this pass, distinct from
   * `cost_governor_deferred` above (a spend ceiling) and from the lanes path's own PRE-EXISTING
   * `laneDispatchBudget` throttle (W1-T172, `dispatch.wip_deferred`, which only SIZES a still-open
   * lanes pass and never stops one outright). Drainage (sweep/heal/arm/merge, at any depth) is
   * unaffected, only NEW dispatch stops — see `checkQueueGovernor`'s own asymmetry note. A future
   * pass (the next `rmd drain` invocation, or the daemon's own idle heartbeat) re-derives the open
   * count fresh and resumes once it drops back under the limit.
   */
```

## DrainOpts.curated

Archived from `src/lib/drain.ts` lines 976-989 at the merge base.

```text
  /**
   * A CURATED selection (W1-T140, the drain preview + curation panel): an explicit
   * ordered list of task ids. When present, dispatch iterates EXACTLY this list, in
   * this order, in place of the natural DAG scan ({@link nextRunnable}'s plan-file-
   * order walk) — the operator's curation-panel choice (reorder / unselect / set
   * depth) drives exactly which tasks run and in what sequence. An id already merged
   * or currently in-flight (an open PR, the same W1-T80 guard the natural path uses)
   * is skipped, never re-dispatched; an id this list OMITS is never dispatched at
   * all, regardless of what the natural DAG scan would otherwise pick next. This is
   * an INPUT to the existing loop, not a reimplementation of it — every other
   * `runDrain` mechanic (stop/pause/headroom/max) is unchanged. Build this field with
   * {@link applyCuratedSelection} rather than setting it directly, so `max` stays
   * consistent with the selection's `depth`.
   */
```

Archived from `src/lib/drain.ts` lines 1009-1023 at the merge base.

```text
  /**
   * W1-T290: the headroom governor switch — the SAME resolved posture
   * `daemon.ts`'s identically-named `DaemonOpts.headroomEnabled` reads
   * (operator ruling fb-1784894405468-a4153e; config.ts's
   * `resolveHeadroomEnabled`). Gates ONLY the new unreadable-degraded ceiling
   * below (`headroom_degraded`) — the existing at/near-limit
   * `headroom_exhausted` stop is unconditional, unchanged by this option, on
   * both loops. When `false`, an unreadable `/usage` read is ABSENT
   * TELEMETRY, never a hold: no `drain.headroom.unavailable`/`.degraded`
   * line, no consecutive-count escalation, dispatch proceeds regardless.
   * Defaults to `true` so an unconfigured caller's behavior — and every
   * existing test — is unchanged; the real `rmd drain` CLI entry resolves
   * this from config/env and passes it explicitly, mirroring the daemon's
   * own wiring.
   */
```

Archived from `src/lib/drain.ts` lines 1025-1032 at the merge base.

```text
  /**
   * W1-T290: CONSECUTIVE unreadable `/usage` reads this drain tolerates
   * before stopping with `headroom_degraded` (default {@link
   * UNREADABLE_DEGRADED_LIMIT}, the SAME shared constant `daemon.ts`'s
   * `DEFAULT_UNREADABLE_DEGRADED_LIMIT` resolves to — one policy number, two
   * consumers, never a second drift-prone literal). A single successful read
   * resets the count to zero, exactly as the daemon's does.
   */
```

## DEFAULT_MAX

Archived from `src/lib/drain.ts` lines 1062-1078 at the merge base.

```text
/**
 * Default iteration cap — a sane bound, never infinite (an unattended loop).
 *
 * W1-T253 (P37 CONSUMERS): mirrors `plan/policy.yaml`'s `drain.max` (lifted FROM this
 * literal by the W1-T252 substrate) but stays a literal HERE rather than self-loading via
 * `policy.ts`'s `loadDefaultPolicy` (a `readFileSync`, see review.ts/worker.ts/sweep.ts's
 * siblings in this same task) — `daemon.ts` imports THIS module at the VALUE level
 * (`nextRunnable`), and daemon.ts's own file header is explicit: "this pure module never
 * touches the filesystem" (Rule 16 — `runDaemon` must stay callable thousands of times
 * against an injected clock in a unit test with zero real I/O). An eager fs read here would
 * leak into every daemon.ts import transitively. So this stays the fs-free fallback for a
 * direct/test caller, and `drainCommand`/`daemonCommand` (run-task.ts) — the real `rmd
 * drain`/`rmd daemon` CLI entries — load `plan/policy.yaml`'s `drain.max` and thread it in
 * explicitly on every real invocation, so a policy edit moves the LIVE bound with zero code
 * change even though this constant is provably dead on that path
 * (test/policy-consumers.test.ts).
 */
```

## DrainSummary.continued

Archived from `src/lib/drain.ts` lines 1084-1096 at the merge base.

```text
  /**
   * Tasks that did NOT merge and did NOT halt the drain — see {@link NON_HALTING_VERDICTS}.
   *
   * SEPARATE FROM `merged` ON PURPOSE. A continued task's work is pushed but NOT merged, so
   * crediting it here would make its dependents dispatchable against work that has not landed —
   * the exact hazard stop-on-block exists to prevent. This list records what happened; it grants
   * nothing.
   *
   * OPTIONAL, and the reason is diff hygiene rather than semantics: both production `summary()`
   * helpers always populate it, but making it required forced a `continued: []` into ten existing
   * fixtures across five test files that have nothing to do with the halt rule. Every reader
   * defaults it to empty, and "absent" and "empty" mean the same thing to all of them.
   */
```

Archived from `src/lib/drain.ts` lines 1101-1116 at the merge base.

```text
  /**
   * How many candidates the FINAL selection declined as INDETERMINATE (W1-T119) — a gateway that
   * could not ANSWER, never a task that is genuinely ineligible. Reset each pass, deliberately:
   * see the reset's own comment in `runDrain` for why a lifetime total would mislead.
   *
   * WHY A NUMBER AND NOT PROSE. `stopDetail` is for the operator; this is for `drainCommand`,
   * which decides whether to look at the rate-limit buckets. A caller forced to regex a sentence
   * to learn what happened is how a reporting field becomes load-bearing by accident.
   *
   * `zero is overloaded`, MEASURED five times in this repo. A `no_runnable` with this at 0 is a
   * genuinely empty frontier; the same verdict with it non-zero is a fleet that could not SEE.
   * The two were byte-identical before this field existed, and an operator had to run
   * `gh api rate_limit` BY HAND to tell them apart. The dispatch PREDICATE was already correct —
   * rung 6 declines on unknown distinctly from rung 1's not-merged — so nothing here changes what
   * is dispatched, only what the terminal is able to say about it.
   */
```

## NON_HALTING_VERDICTS

Archived from `src/lib/drain.ts` lines 1122-1265 at the merge base.

```text
/**
 * Verdicts that are NOT `merged` and yet must NOT stop the drain.
 *
 * THE ARGUMENT IS THIS MODULE'S OWN HEADER, WHICH JUSTIFIES STOP-ON-BLOCK AS: "a blocked task's
 * DEPENDENTS would build on missing work, so continuing risks compounding a gap." That is exactly
 * right for a real block — and it is FALSE for `blocked_ci`. A `blocked_ci` run has pushed its
 * branch, opened its PR and done the work; the only thing outstanding is CI's own verdict. Its
 * dependents would build on work that exists and is about to land. MEASURED: #1492 and #1495 both
 * returned `blocked_ci` and both merged afterwards, unchanged.
 *
 * SO THE HALT WAS A CORRECT RULE APPLIED TO A CASE IT WAS NEVER ARGUED FOR, and the cost is real:
 * the drain stops at the first non-merged verdict, so one CI stall ends a `--max 6` budget after
 * one task with five dispatches unspent.
 *
 * NOTHING IS CREDITED BY BEING HERE. Membership means "keep going", never "this task is done" —
 * `continued` is deliberately not `merged`, and the dependency filter is unchanged.
 *
 * `no_pr` JOINS THE SET TOO, and this REVERSES what the paragraph below used to say — recorded
 * rather than quietly edited, because the earlier reasoning was explicit and deserves an explicit
 * answer. It ran: "nothing was produced at all, which is strictly worse than a block, and its own
 * doc argues the halt explicitly (`a blind auto-retry carries NO new information`)."
 *
 * THAT IS TRUE ABOUT THE RUN AND IRRELEVANT TO THE HALT. "Strictly worse" ranks how much VALUE a
 * run delivered; the halt exists for a different question — whether continuing would COMPOUND a
 * gap. The header's own justification is that "a blocked task's DEPENDENTS would build on missing
 * work". A `no_pr` run produced nothing and advanced nothing, so its dependents face exactly the
 * state they started from. And they cannot be selected regardless: `isDispatchEligible` (this
 * file) filters any task with `unmetDependencies(...).length > 0` as `unmet-deps`, and it is the
 * SINGLE predicate behind both `nextRunnable` and `runnableCandidates`. Dependents are protected
 * by the dependency machinery, not by the halt.
 *
 * THE HALT ALSO DOES NOT DO THE THING THE RETRY ARGUMENT WANTS. It never prevents the `no_pr` task
 * being dispatched again — a later pass re-offers it either way. All it prevents is OTHER,
 * UNRELATED tasks running now. And within a pass there is no blind retry to fear: `excludeIds`
 * means a continued-past task is never offered again in the same pass.
 *
 * RE-DISPATCH REMAINS BOUNDED, and by the instrument built for exactly this shape.
 * `isDispatchBreakerTripped` (status.ts) counts `dispatchesWithoutNewOwnedPr`, which resets ONLY
 * on a `pr.opened` line — and a `no_pr` run never writes one, so for this verdict the counter is
 * monotonic and trips at the streak cap. `isLifetimeDispatchCapExceeded` is the second backstop
 * and never resets at all. Both read the running config's ledger, so they are PER-HOST and a fresh
 * container starts from zero; the task's own yaml `attempts:` field bounds nothing, since
 * `parseTasksFromYaml` defaults it to 0 and nothing in `src/` ever writes it back.
 *
 * THE COST WAS MEASURED, on the container path where the header's OTHER justification — "a human
 * kicked it off by hand and is watching it" — is simply false, because the drain IS the unattended
 * path there. Four dispatches ended `no_pr` in one day (W1-T388, W1-T392 twice, W1-T393), each
 * confirmed by `git rev-list --count origin/main..<run-branch>` = 0, and one drain reported
 * `stopped: blocked — W1-T393 → no_pr` after two dispatches of a `--max 6` budget. That is four
 * budgeted runs surrendered to protect nothing.
 *
 * BOTH SHAPES INSIDE `no_pr` ARE TREATED THE SAME, deliberately: a worker that produced nothing,
 * and a worker whose `ALREADY_SATISFIED` claim failed to verify and fell through (run-task.ts's
 * `resolveAlreadySatisfied`). Neither opened a PR, neither committed, neither advanced the task —
 * the halt decision cannot tell them apart and has no reason to.
 *
 * `blocked_illformed` JOINS THEM, AND THE ARGUMENT IS STRONGER HERE THAN FOR EITHER PREDECESSOR.
 * The header justifies stop-on-block as "a blocked task's DEPENDENTS would build on missing work,
 * so continuing risks compounding a gap". For `blocked_ci` the work was pushed and a PR is open;
 * for `no_pr` a worker ran and produced nothing. FOR THIS ONE THE LINTER REFUSED BEFORE DISPATCH.
 * `runTask` (run-task.ts) returns it from a `catch (TaskLintError)` whose own comment reads
 * "linter-failing task BEFORE the inflight lock is even taken — no lock, no worktree, no worker
 * ever spawns", and the returned result carries `costUsd: 0`. No process started, no branch was
 * cut, no state changed. There is nothing to compound, and nothing was spent discovering it.
 *
 * THE HEADER'S OTHER JUSTIFICATION IS FALSE WHERE THIS BITES. It says `rmd drain` "keeps its blunt
 * stop-on-block on purpose: a human kicked it off by hand and is watching it." In a container the
 * drain IS the unattended path — nobody is watching, and a surrendered budget is simply lost.
 *
 * MEASURED: one `--max 6` drain dispatched W1-T393 (merged), W1-T399 (`no_pr`, correctly continued),
 * then W1-T24 — refused pre-dispatch with three `proof-dialect` violations — and HALTED, giving up
 * three remaining dispatches to protect nothing. The population is not marginal: `lint-plan` reports
 * 472 `proof-dialect` violations plan-wide. The frontier is clean, so a drain only meets one once it
 * works past the recent shards — which is exactly what a drain does. (How often this has already
 * happened is UNMEASURED: the mini is down and the ledger is unreachable.)
 *
 * THE REFUSAL IS NOT SWALLOWED, which is the precondition for skipping it. `runTask` `say`s
 * "REFUSED: task <id> failed the pre-dispatch linter" with every violation enumerated, and ledgers
 * `lint.blocked` carrying them; the drain then ledgers `drain.continued`, and `buildRundown` (this
 * file) gives the task its OWN line — `blocked : <id> — blocked_illformed — drain continued` —
 * rather than the drain's `stopDetail`. A skipped ill-formed task is louder after this change than
 * a halted one was, because the drain no longer stops at the first.
 *
 * WHY NO OTHER VERDICT JOINS THIS SET, verdict by verdict. `blocked`, `blocked_review`,
 * `blocked_containment`, `blocked_isolation`, `failed` and
 * `pr_attribution_failed` all leave the work unfinished or unattributable, so the header's
 * argument applies unchanged. `blocked_budget`, `blocked_transient` and `blocked_git_fetch` are
 * environmental and say nothing about this task alone: the next dispatch would meet the same
 * condition, so continuing burns runs rather than making progress. `blocked_inflight` means
 * another holder owns the task right now.
 * `already_satisfied` never reaches this predicate: it returns `merged: true` and behaves as
 * forward progress.
 *
 * `task_already_merged` NOW JOINS THE SET, AND ITS ARGUMENT IS THE STRONGEST OF THE FOUR. The
 * sentence that used to sit in the paragraph above left it alone as "a separate concern"; that
 * concern is now MEASURED, so the deferral is spent and the sentence is replaced rather than
 * quietly dropped.
 *
 * Put the four side by side against the header's own justification — "a blocked task's DEPENDENTS
 * would build on missing work, so continuing risks compounding a gap":
 *
 *   - `blocked_ci`          — the work was pushed and the PR left open.
 *   - `no_pr`               — the task did not advance.
 *   - `blocked_illformed`   — the linter refused BEFORE dispatch.
 *   - `task_already_merged` — THE TASK IS DONE.
 *
 * The first three each argue that nothing was LOST. This one argues something stronger: its
 * dependents CAN build on it, because that is what merged MEANS. There is no gap to compound —
 * the gap is filled, by a merged PR the projection can name. Halting to protect dependents from
 * work that is already finished inverts the rule it is applying.
 *
 * AND IT COSTS NOTHING TO DISCOVER. `runTask`'s refusal (run-task.ts, the W1-T319 guard) fires
 * before `assertRunnable`, before the §5C linter, before the inflight lock, before worktree
 * materialization and before any spawn — its own comment says "zero cost beyond the map lookup" —
 * and the result it returns carries `costUsd: 0`.
 *
 * MEASURED: a `--max 6` drain attempted ONE task and stopped at $0.00 —
 * `REFUSED: W1-T24 is already merged (…/pull/75) — pass --rerun to dispatch anyway`, then
 * `stopped : blocked — W1-T24 → task_already_merged`. Five live tasks sat behind it (W1-T395,
 * W1-T399, W1-T400, W1-T401, W1-T402): five budgeted dispatches surrendered to protect work that
 * was already merged.
 *
 * WHY THE TASK WAS OFFERED AT ALL IS A SEPARATE DEFECT, NOT FIXED HERE — AND THIS CHANGE IS NOT
 * MERELY ITS SYMPTOM. Rung 1 of `isDispatchEligible` DID run, and returned false: `drainCommand`
 * builds its projection from `ghGateway` while `runTask` builds its own from
 * `buildBatchedGithub` (changed the same day, #1529) — two gateways answering one question at two
 * points of a single dispatch, which is the "never a second read path" rule `drainCommand`'s own
 * comments repeat. Aligning them would make this verdict RARE. It cannot make it impossible: a
 * task can merge in the window BETWEEN the drain's selection and the runner's refusal, and that
 * window survives any gateway alignment. The halt would still be wrong whenever it fired.
 *
 * THE REFUSAL IS NOT SWALLOWED, the same precondition the three predecessors needed. `runTask`
 * `say`s `REFUSED: <id> is already merged (<pr_url>) — pass --rerun to dispatch anyway` and
 * ledgers `dispatch.refused_already_merged` carrying that PR url; the drain then ledgers
 * `drain.continued`, and `buildRundown` (this file) gives the task its OWN line rather than the
 * drain's `stopDetail`. A drain that silently skipped merged tasks would hide a stale plan; this
 * one names every one it skipped.
 *
 * NOT FIXED HERE, AND NOT LOST: the reason `blocked_ci` fires on healthy PRs at all is that
 * `checkWaitStalled`'s window is a 30-second elapsed bound (five identical polls at six seconds)
 * measured against a `ci` job that needs minutes, so a long healthy job reads as a stall. Teaching
 * that predicate to count a still-running check as forward motion is the right second fix and a
 * different concern; this change makes the misfire cheap rather than making it rarer.
 */
```

## noRunnableDetail

Archived from `src/lib/drain.ts` lines 1282-1310 at the merge base.

```text
/**
 * The `stopDetail` for a `no_runnable` stop: whether the frontier was READ AND EMPTY, or merely
 * UNREADABLE.
 *
 * Both end the drain with the same `stopReason`, and until this existed they printed the same
 * single word. The operator's recourse was to run `gh api rate_limit` BY HAND and infer which of
 * the two had happened — from outside the process that already knew.
 *
 * A COUNT, NOT A SHARE, and the reason is worth stating rather than leaving as an omission: the
 * drain loops do not wire `onFiltered`, so there is no denominator here — and wiring one would not
 * help, because `DispatchFilterReason` has no indeterminate bucket. `tallyDispatchFilters` counts
 * the four ORDINARY declines; rung 6 has always reported through `onIndeterminate` instead. So
 * "N declined as indeterminate" is the strongest true statement available without changing the
 * dispatch predicate, and it is the one that distinguishes the two cases.
 *
 * ALWAYS RETURNS A SENTENCE, INCLUDING FOR ZERO. Returning `undefined` on the healthy path would
 * leave the terminal printing the pre-existing bare `no_runnable`, and an operator could not tell
 * a build that counts from a frontier that was clean. The zero case is a positive claim — the
 * frontier was read — not the absence of one.
 *
 * NO FILE-OVERLAP ARM, AND THAT IS A CORRECTION RATHER THAN AN OMISSION. The lanes loop's third
 * `no_runnable` sits AFTER `partitionByFileOverlap`, so the obvious reading is that a stop there
 * means candidates were found and then serialized away — and an earlier draft of this function
 * said so. It cannot happen: that partition's first candidate meets an EMPTY `dispatch` array, so
 * `dispatch.find(...)` returns undefined and it is placed unconditionally. `dispatch` is therefore
 * empty only when `candidates` was, which the guard one branch earlier already returned on. A
 * sentence for a population that cannot be observed is the same defect as a bound that fires on a
 * healthy condition, so it is not written.
 */
```

## headroomDegradedDetail

Archived from `src/lib/drain.ts` lines 1318-1342 at the merge base.

```text
/**
 * The `headroom_degraded` stop detail — the sentence an operator reads when a drain surrenders the
 * rest of its budget.
 *
 * IT NO LONGER SAYS "unreadable", BECAUSE THIS CODE CANNOT SEE THAT. `readUsage` is
 * `() => readUsageSnapshot(config)` at both drain call sites (src/run-task.ts), and that function
 * fails in TWO ways it deliberately keeps apart: `UsageProbeFailureStage` is `"spawn" | "parse"`,
 * and its own comment records that conflating them "cost this fleet its headroom read for hours on
 * 2026-07-31" — the probe had returned a perfect 1015-byte reading and only the PARSER threw.
 * Both branches then return `undefined`, so by the time the value reaches here the stage is gone
 * and only one bit survives. Asserting "unreadable" over that bit is a claim this function cannot
 * substantiate, and it points an operator at a broken API when the real fault may be a parser.
 *
 * SO IT NAMES THE ROW THAT DOES KNOW. `ledgerUsageProbeFailure` (src/run-task.ts) already writes
 * `usage.probe_failed` DURABLY with the stage and the reason, on every failed probe, precisely so
 * the next surprise names itself on the first tick. The detail below is a pointer to evidence that
 * already exists rather than a second, weaker guess at it. The RETURN POLARITY and the BOUND are
 * untouched: the read genuinely failed, and the bound behaved correctly on a true input.
 *
 * ONE BUILDER, TWO CALL SITES. `runDrain`'s single-lane loop and `runDrainLanes`' multi-lane pass
 * both stop this way, and W1-T290 shipped the ceiling to both precisely so the `--lanes` path did
 * not stay a latent fail-open. A hand-copied sentence at each site is the drift this repo argues
 * against everywhere else (`INSTRUMENT_SURFACE`'s own one-path-set note), so the wording lives here
 * once and both sites call it.
 */
```

## buildRundown

Archived from `src/lib/drain.ts` lines 1513-1530 at the merge base.

```text
/**
 * Build the post-drain rundown (W1-T141): one classified outcome line per `summary.attempted`
 * task, in attempt order — the pull-view counterpart to `digest.ts`'s push summary, read right
 * after a drain finishes rather than batched into the next daily send.
 *
 * `runDrain` STOPS ON THE FIRST non-merged verdict (this module's own header), so every
 * `attempted` id except possibly the LAST is necessarily in `summary.merged` — classified
 * `"merged"`. The last id, when not merged, classifies `"escalated"` when the ledger already
 * carries an `escalation.issue_opened` line naming it (escalate.ts — e.g. the BLOCKED class
 * opened after two-strikes-exhausted, during the SAME `runOne` call that produced the
 * non-merged verdict), carrying that issue's URL + class as its ref; otherwise it classifies
 * `"blocked"`, carrying `summary.stopDetail` as its detail. Escalation lookup is task-id-keyed,
 * latest-wins — the SAME dedup key `ops.ts`'s alert-escalation guard and `digest.ts`'s
 * summarizer already use, never a second convention. `ledgerLines` defaults to none, so a
 * caller with no ledger handy still gets a correct merged/blocked split, just never
 * `"escalated"` (degrades to the coarser truth, same as `digest.ts`'s own escalations list
 * when nothing is passed).
 */
```

Archived from `src/lib/drain.ts` lines 1539-1543 at the merge base.

```text
  // A CONTINUED TASK MUST CARRY ITS OWN DETAIL, NEVER THE DRAIN'S `stopDetail`. Before
  // NON_HALTING_VERDICTS existed this could not go wrong: only the LAST attempted id could be
  // non-merged, so `stopDetail` always described that id. Now an earlier id can be non-merged too,
  // and blindly attaching `stopDetail` would print one task's line against a DIFFERENT task's
  // verdict — a self-contradicting record, which is worse than a terse one.
```

## DrainDeps.readPushedRunBranches

Archived from `src/lib/drain.ts` lines 1618-1634 at the merge base.

```text
  /**
   * W1-T916 — THE SUPPLIER W1-T534 DECLARED AND NOBODY PASSED. Raw `git ls-remote --heads origin
   * 'run-*'` output, read ONCE PER PASS and parsed by {@link runBranchTaskIds} into the closure
   * {@link NextRunnableOpts.hasPushedRunBranch} consumes. Injected rather than executed here
   * because THIS MODULE IS PURE — it carries no `child_process` import and no `execFileSync`, the
   * same discipline `refreshMerged`/`isOpenPr`/`runOne` already follow.
   *
   * WHY A READER AND NOT A PREDICATE: the cost argument is ONE REF SWEEP PER PASS (46 refs in
   * 199 ms, `core` remaining identical before and after, because `ls-remote` speaks the git
   * protocol and spends neither budget) against one round trip per candidate. Handing this module
   * a per-task predicate would let a caller satisfy the type while making exactly the
   * per-candidate call the design refuses; handing it the RAW OUTPUT makes one-sweep-per-pass the
   * only shape that type-checks, and the parse is hoisted ABOVE the dispatch loop for the same
   * reason.
   *
   * Optional — omitted, dispatch behaves EXACTLY as before this existed.
   */
```

## DrainDeps.readClosedRunBranchPrs

Archived from `src/lib/drain.ts` lines 1636-1655 at the merge base.

```text
  /**
   * W1-T1207 (design (iii)): raw `pulls?state=closed` rows for the SAME run-branch sweep above —
   * ONE BATCHED, PAGINATED read per pass, never one lookup per branch, parsed by {@link
   * closedUnmergedRunBranchTaskIds} into the set the caller subtracts from `readPushedRunBranches`'
   * blocking set immediately above the dispatch loop. Exists ONLY to answer "did an OPERATOR close
   * this run branch's pull request without merging it" — a sweep-INITIATED close is already free
   * from the ledger row it writes (design (iii)'s "two things are already free"), so this read is
   * needed only for the operator-initiated half, which is exactly how the five measured exclusions
   * (W1-T1098, W1-T1101, W1-T1104, W1-T1109, W1-T1000002) arose.
   *
   * FAILS TOWARD STILL BLOCKING — the OPPOSITE direction from `readPushedRunBranches`'s own fail
   * OPEN: a throw (network blip, auth) is expected to degrade to `""`, which parses to an EMPTY
   * exclusion set, so every pushed run branch keeps blocking exactly as it did before this
   * dependency existed. That asymmetry is deliberate (design (ii)): "a false block delays one
   * task, a false dispatch races a live run" — an unreadable closed-PR sweep must never become the
   * reason a task dispatches.
   *
   * Optional — omitted, `hasPushedRunBranch` behaves EXACTLY as before this existed: it blocks on
   * ANY pushed run branch regardless of its pull request's state.
   */
```

## DrainDeps.checkCostGovernor

Archived from `src/lib/drain.ts` lines 1701-1715 at the merge base.

```text
  /**
   * W1-T317 (wiring `checkCostGovernor`, sweep.ts): THE DAILY COST CEILING, re-derived from the
   * ledger each call — same freshness contract as `isCircuitTripped`/`isLifetimeCapExceeded`
   * above. UNLIKE those, this is NOT task-specific — one answer per tick, never keyed by taskId
   * — so it is consulted directly in the loop below, alongside `checkStop`/`checkPause`/headroom,
   * rather than threaded through `NextRunnableOpts`'s per-task chain. A defined return means
   * "defer — do not open a new run this pass", carrying the observed day-cost/ceiling that
   * produced it; `undefined` means proceed normally. The real wiring (run-task.ts) also LEDGERS
   * the deferral itself (`logCostGovernorDeferral`) before returning, so this loop never needs
   * `ledgerPath`/`runId` to report it. Optional — omitted, dispatch behaves exactly as before
   * this governor existed. Never consulted from `runSweep` or any of its deps (arm/dispatchFix/
   * close/escalate) — drainage of already-open PRs is a separate code path this predicate is
   * never wired into (see `checkCostGovernor`'s own doc: "stranding in-flight work to save money
   * is a worse failure than the spend itself").
   */
```

Archived from `src/lib/drain.ts` lines 1717-1735 at the merge base.

```text
  /**
   * W1-T321 (wiring `checkQueueGovernor`, sweep.ts, the W1-T121 23-open-PR incident): THE WIP
   * CEILING, re-derived from the current open-PR count each call — same freshness contract as
   * `checkCostGovernor` immediately above. Like the cost governor and UNLIKE
   * `isCircuitTripped`/`isLifetimeCapExceeded` below, this is NOT task-specific — one answer per
   * pass — so it is consulted directly in the loop below, in the SAME position as
   * `checkCostGovernor`, before `nextRunnable` is ever called. A defined return means "defer — do
   * not open a new run this pass", carrying the observed open count/limit that produced it;
   * `undefined` means proceed normally. STOPS the pass outright (this is a bounded, one-shot
   * command, the same shape `cost_governor_deferred` already uses) — drainage of already-open PRs
   * never runs through this loop at all. Distinct from `openPrCount` below: that field feeds the
   * lanes path's own PRE-EXISTING `laneDispatchBudget` throttle (W1-T172), which only SIZES a
   * still-open lanes pass; this field is the hard governor gate, consulted on BOTH the single-lane
   * and lanes loops. The real wiring (run-task.ts) also LEDGERS the deferral itself
   * (`logQueueGovernorDeferral`) before returning, so this loop never needs `ledgerPath`/`runId` to
   * report it. Optional — omitted, dispatch behaves exactly as before this governor existed. Never
   * consulted from `runSweep` or any of its deps (arm/dispatchFix/close/escalate) — see
   * `checkQueueGovernor`'s own asymmetry note for why drainage must never be gated by it.
   */
```

## runDrain

Archived from `src/lib/drain.ts` lines 1821-1829 at the merge base.

```text
  // CIRCUIT BREAKER ESCALATION DEDUP (P29(ii)): `nextRunnable`/`nextCurated` are
  // re-invoked every tick, so a task that stays tripped (never dispatched, never
  // resolved) would otherwise be re-observed — and re-escalated — on EVERY
  // subsequent tick for as long as the drain keeps running (e.g. an unrelated
  // independent task still dispatches successfully first, so the drain does not
  // stop at "no_runnable" the very first time the breaker is consulted). That
  // violates "exactly one escalation" — this Set bounds the CALLBACK to the
  // drain's own first observation of each task id; `isCircuitTripped` itself is
  // still consulted (and still excludes the task from dispatch) every tick.
```

Archived from `src/lib/drain.ts` lines 1882-1891 at the merge base.

```text
    // HEADROOM: never hammer a nearly-exhausted pool. An at/near-limit reading
    // STOPS the drain outright, with the reset time reported (unchanged by
    // this task). An unreadable read is BOUNDED best-effort (W1-T290, ported
    // from daemon.ts's identical mechanism): within `unreadableDegradedLimit`
    // CONSECUTIVE misses the drain still dispatches — max + the budget
    // tripwire still bound it — but beyond the allowance it stops rather than
    // dispatching blind against a pool that may already be exhausted; a
    // single successful read resets the count to zero. Gated by
    // `headroomEnabled` (2026-07-28 ruling): disabled, an unreadable read is
    // absent telemetry, never a hold.
```

Archived from `src/lib/drain.ts` lines 2072-2079 at the merge base.

```text
    // CURATION (W1-T140): a curated selection overrides the natural DAG scan
    // entirely — dispatch honors EXACTLY the operator's list and order, never
    // falling back to nextRunnable's plan-file-order walk.
    // RESET PER SELECTION, NOT ACCUMULATED OVER THE DRAIN. `onIndeterminate` fires only from the
    // selection call below, and the question the terminal has to answer is about the pass that
    // actually GAVE UP — not about a gateway hiccup three passes ago that has since cleared.
    // A lifetime counter would report an unreadable frontier on a stop whose final pass read
    // perfectly, which is the always-blames-the-quota failure this change exists to avoid.
```

Archived from `src/lib/drain.ts` lines 2102-2108 at the merge base.

```text
      // CONTINUED, NOT CREDITED (see NON_HALTING_VERDICTS): the drain keeps its remaining budget,
      // but the task is NOT added to `merged`, so the dependency filter still refuses its
      // dependents. HOW FAR THE TASK GOT VARIES BY VERDICT and this comment used to name only the
      // `blocked_ci` shape ("the work is pushed and its PR is open"), which is untrue for the other
      // two: `no_pr` ran a worker that produced nothing, and `blocked_illformed` never dispatched at
      // all. What they share is the only thing this branch needs — none of them advanced the task,
      // so none of them may credit it.
```

## runDrainLanes

Archived from `src/lib/drain.ts` lines 2120-2130 at the merge base.

```text
// ────────────────────────────────────────────────────────────────────────────
// W1-T172 — PARALLEL DISPATCH. Ratifies P19's dispatch half (DECISIONS.md
// 2026-07-21): "N parallel dispatch lanes bounded by the governor's WIP limit
// (start N=2), with W1-T80 dedup + W1-T149's circuit breaker as the per-task
// guards." Both are reused UNCHANGED via `runnableCandidates` (they are the
// exact same `isDispatchEligible` chain the single-lane loop above applies —
// see that function's own doc). W1-T171's `partitionByFileOverlap` adds the
// ACROSS-candidate check the single-task loop never needed. Little's law is
// still the argument, one layer up: lanes raise the RATE at which the
// governor's bounded WIP fills; they never raise the bound itself.
// ────────────────────────────────────────────────────────────────────────────
```

Archived from `src/lib/drain.ts` lines 2158-2178 at the merge base.

```text
/**
 * The concurrent-lane pass loop (W1-T172), entered only via {@link runDrain}
 * when `opts.laneCount >= 2`. Each pass: the SAME per-tick checks as the
 * single-lane loop (fleet control, `--until`, headroom) → this pass's lane
 * BUDGET ({@link laneDispatchBudget}, the governor ceiling) → up to `budget`
 * runnable candidates ({@link runnableCandidates} — the EXACT SAME per-task
 * guards the single-lane path applies, W1-T80's open-PR dedup and W1-T149's
 * circuit breaker, reused, never reimplemented) → partitioned for `files:`
 * overlap ACROSS the co-dispatched set (W1-T171's `partitionByFileOverlap`)
 * → the surviving dispatch set run CONCURRENTLY via `Promise.allSettled` —
 * never `Promise.all`, whose first rejection would abort every sibling
 * promise still in flight; every lane's result is awaited and recorded
 * before this pass decides anything (LANE-LOCAL BLOCK SEMANTICS: one lane's
 * block or throw never halts, cancels, or races ahead of its siblings) →
 * `dispatch.concurrent_set` ledgers the co-dispatched ids (the evidence
 * trail P19's banked rung 2 needs) → on any block or lane failure THIS pass,
 * the WHOLE drain stops afterward — same STOP-ON-BLOCK doctrine as the
 * single-lane loop's header, just evaluated at pass granularity instead of
 * per task; W1-T46's smarter successor block reasoner is what would change
 * WHAT happens to a blocked lane, not whether its siblings survive the pass.
 */
```

## runDrainLanes per-lane governor gate

Archived from `src/lib/drain.ts` lines 2419-2429 at the merge base.

```text
    // PRE-DISPATCH OVERLAP CHECK (W1-T171), ACROSS the co-dispatched set: a
    // deferred task is simply absent from THIS pass — it is re-considered
    // next tick, by which point the task it collided with is either merged
    // or (far more commonly) has an OPEN PR of its own, so the in-flight
    // guard above excludes it from candidates entirely and the collision
    // never recurs. Self-resolving; no bookkeeping needed here.
    //
    // W1-T2286: `deps.observedByTask` — the SAME map `skipOpts.observedByTask` fed the pack step
    // above — is passed EXPLICITLY rather than omitted, so this call site no longer relies on
    // `partitionByFileOverlap`'s own default parameter. `?? NO_OBSERVED_SCOPE` keeps today's
    // behaviour byte-identical when no observer is wired (no production caller supplies one yet).
```

Archived from `src/lib/drain.ts` lines 2441-2465 at the merge base.

```text
    // W1-T342's PER-DISPATCH GOVERNOR GATE, APPLIED PER LANE (the half that fix did not reach).
    //
    // The pass-level `checkCostGovernor`/`checkQueueGovernor` reads far above STOP the whole pass.
    // They are not the same thing as this: one reading taken before any lane was admitted stood in
    // for EVERY lane in the batch, so a ceiling that trips between lane 1 and lane 2 admitted lane 2
    // anyway. `checkDispatchGovernors`' own doc names this exact call site: "W1-T343's loop must call
    // THIS function again per lane it admits, never hoist a single call above the loop."
    //
    // WHERE THE CHECK SITS, AND WHY IT IS HERE RATHER THAN INSIDE THE `.map`. A check inside
    // `dispatchSet.map(...)` would LOOK per-lane and not be: `.map`'s callback runs SYNCHRONOUSLY
    // for every element, so all N readings would be taken in the same tick of the event loop, before
    // any lane has done any work — one reading wearing N hats. Admission therefore happens in this
    // SEQUENTIAL loop, each iteration taking its own fresh reading, and only the admitted subset is
    // handed to `allSettled`.
    //
    // WHAT THAT DOES AND DOES NOT BUY, stated rather than overclaimed: because lanes run
    // concurrently, lane 1's own spend is still un-ledgered when lane 2 is admitted, so this does
    // NOT let lane 2 see lane 1's cost. What it does catch is a ceiling crossed by ANY OTHER writer
    // between readings (a previous batch's late-ledgered cost, the sweep, a second process) and an
    // observation that becomes UNREADABLE for a later lane — both of which the single reading
    // silently admitted through. That is the same value W1-T342 bought in runDaemon.
    //
    // A MID-PASS REFUSAL MUST NOT ABORT THE PASS. `break` stops ADMITTING; it never touches lanes
    // already admitted, and the pass proceeds to dispatch them and record every outcome exactly as
    // before. Refusing lane 2 is a deferral of lane 2, not a failure of lane 1.
```
