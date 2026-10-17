# Forensics: src/lib/tick-read-worker.ts

Every measured fact, incident and design argument the longest comment blocks in `src/lib/tick-read-worker.ts`
carried when W1-T9722 moved them out of `src/run-task.ts`, archived VERBATIM. The move is otherwise
byte-for-byte; these five blocks exceed the comment-load ratchet's 25-line limit on an added block, so the code
keeps a condensed doc with a one-line `Why:` pointer to the heading here.

Nothing here is a rule. The behaviour lives in the code and its tests, and each block below is quoted exactly
as it stood in `src/run-task.ts` on `origin/main` at `0f63458cf`, under a heading naming the symbol it explained.

---

## BoardItemEscalationInfo

`src/run-task.ts:32660-32690` at `0f63458cf`, 31 comment lines, moved to
`src/lib/tick-read-worker.ts` by W1-T9722.

```
/**
 * W1-T2304's board-review rung: the OPEN BOARD, as {@link BoardItem}s the rung can reason over.
 *
 * PURE — this does the mapping and nothing else, so every field's fail-direction is testable
 * without a network. {@link defaultBoardReviewItems} below is the one real read that feeds it,
 * mirroring `defaultPlanLifecycleCounts`'s own reader/mapper split.
 *
 * WHERE EACH FIELD COMES FROM, AND WHAT ABSENCE MEANS:
 *  - `ageHours` from `createdAt`. A row without one is age ZERO, never age infinity: an unknown
 *    age must not manufacture the very "this has sat 14h" finding the rung exists to raise.
 *  - `redCheckCount` from the rollup `fetchOpenPrsRest` ALREADY hydrates per PR — no second read.
 *    `rollupUnreadable` counts as ZERO red, the same fail-open direction `checksStateFromRollup`
 *    takes: an unreadable check is not evidence of a failing one.
 *  - `unhandledEscalations` from the SAME `projectPlan` projection every other plan reader
 *    derives from (`StatusProjection.needsHuman`), joined to the PR by `prNumber`. A projection
 *    that could not be read yields zero, never a fabricated escalation.
 *  - `escalationTitle`/`escalationIssueUrl`/`escalationUnverified` (W1-T2453) and
 *    `escalationOpenedAt` (W1-T2466) from the SAME projection entry `unhandledEscalations` above
 *    already reads — `escalationsByPrNumber` carries them alongside the boolean, so naming an
 *    escalation (and dating it) costs zero extra reads: the fields were already in hand one line
 *    before this mapper, per this task's own rationale.
 *  - `originatesFromProposalId` (W1-T2465 — design (iv)'s recursion bound, MADE REACHABLE) from
 *    the SAME projection's `taskId` joined to the plan's own task, whose `origin:` names the
 *    board-review proposal that produced it (`board-review:stale:<ref>` or
 *    `board-review:escalation:<ref>`, exactly the id `board-review.ts` mints — a task's
 *    `origin:` is declared plan metadata, Standing rule 17). ABSENCE MEANS NOT-SELF-PRODUCED,
 *    NEVER SELF-PRODUCED: a PR whose task cannot be resolved, or whose `origin:` names anything
 *    else, is left unmarked — the same fail-open direction every other field on this mapper
 *    takes, because marking on an uncertain read would exclude a real board item from every
 *    depth signal and every finding, i.e. blind the rung.
 */
```

---

## reviewOrphansFor

`src/run-task.ts:42711-42763` at `0f63458cf`, 53 comment lines, moved to
`src/lib/tick-read-worker.ts` by W1-T9722.

```
/**
 * W1-T225's producer: was this PR's `remudero-review` posted against a head that has since been
 * superseded, and across how many distinct prior heads?
 *
 * DERIVED FROM THE LEDGER THE PASS ALREADY READ — `buildOpenPrViews` holds `readLedgerLines` for
 * `unmetFromLedger`/`priorStrikesFor`/`reviewPostRefusedFor` already, so this costs ZERO additional
 * REST requests. That is the shape the field's own SCOPE note asked for: "buildOpenPrViews would
 * derive it the SAME way it already derives `reviewPostRefused`: scan the ledger for a prior
 * `review.posted`/`review.post_refused` line for this `taskId` at a head sha OTHER than the current
 * one." This is that historical scan. The action-bearing retry count is intentionally separate:
 * {@link reviewAttemptsForInput} cannot let old heads or refused posts spend a new input's budget.
 *
 * ── THE FALSE-POSITIVE BOUNDARY, which is the whole risk surface ────────────────────────────────
 * Three states must NOT read as orphaned, and each is excluded by construction:
 *
 *   1. NEVER REVIEWED AT ALL — no posted line for this task. `prior` is empty ⇒ false/0. A PR
 *      awaiting its first review is not orphaned, and the cap row's own comment requires exactly
 *      this ("a PR awaiting its FIRST review never matches this row").
 *   2. REVIEW IS CURRENT — the only posted lines carry the CURRENT head. Filtering on
 *      `head_sha !== headSha` leaves nothing ⇒ false/0.
 *   3. A HEAD THE LEDGER HAS NOT SEEN YET — the race between a push and the next poll. This is the
 *      subtle one, and it resolves correctly for a reason worth stating: a brand-new head has no
 *      posted line of its own, but the PRIOR head's line is still there, so this reads TRUE — which
 *      is CORRECT, because that is precisely what "orphaned by a push" means. What it must not do
 *      is read true when the review simply has not been *observed* yet, and it cannot: a line only
 *      exists once a verdict was actually posted for that sha.
 *
 * A LINE WITH NO `head_sha` IS IGNORED, never counted as a prior head. The ledger carries such rows
 * (the pre-#981 blind-arm class wrote outcomes with no sha), and treating an absent sha as "some
 * other head" would manufacture an orphan out of missing information — the same
 * unknown-as-a-definite-answer mistake `mergeable` taught today in the other direction.
 *
 * BLAST RADIUS IF WRONG: `buildOpenPrViews` consumes only `orphanedByPush`; the count and timestamp
 * are retained for compatibility/tests and do not drive a disposition. A false positive therefore
 * changes the reason string, not whether the lane runs or whether the exact-input cap is spent.
 *
 * W1-T1018 design (iv), ADDED ON TOP OF THE ABOVE, NEVER REPLACING IT (operator ruling
 * 2026-08-19): `diffDigestForHead` is OPTIONAL. Supplied, it counts DISTINCT DIGESTS among the
 * qualifying prior heads rather than distinct SHAS — two heads whose PR-own diff (against `main`)
 * digests identically (rationale (2)'s #2159 base-repair merges: "own diff: 2 files +212/-8" on
 * both) are ONE orphan, not two, because the second push changed nothing reviewable. A digest read
 * as `undefined` (an unreadable/best-effort-failed compare, or simply no fetcher wired) is NEVER
 * merged with anything else; it counts on its own within this diagnostic history.
 *
 * SCOPE (honest, mirrors how `pendingAnswer`/`reviewOrphanedByPush` themselves shipped their
 * mechanism ahead of their producer — see those fields' own SCOPE notes, lib/sweep.ts): this
 * parameter and the counting change are the full MECHANISM, wired end-to-end and unit-tested
 * here — but `buildOpenPrViews` below does not pass a digest fetcher yet (that needs a bounded,
 * best-effort GitHub compare call per prior head, the SAME shape `hydrateMergeConflictEvidence`,
 * lib/open-prs-rest.ts, already uses for merge-conflict evidence, scoped to the small set of
 * already-orphaned PRs). Until that wiring lands, every prior head still counts individually in
 * this diagnostic result. That limitation no longer affects retry/backoff behavior.
 */
```

---

## fetchCiFailures

`src/run-task.ts:42852-42883` at `0f63458cf`, 32 comment lines, moved to
`src/lib/tick-read-worker.ts` by W1-T9722.

```
/**
 * W1-T100 (the #170 fix): failing required-check names + a tail of each one's
 * log — the ci-log fix mode's ONLY input (deriveFixMode/renderFixPrompt,
 * W1-T94). Best-effort: a log-fetch failure degrades to an EMPTY tail and
 * NEVER throws, so one unreadable log never strands the sweep — but it no
 * longer degrades SILENTLY. Every empty tail now carries a
 * {@link CiLogUnavailableCause} naming why, because an unrecorded failed read
 * is byte-indistinguishable from a check that simply printed nothing, and all
 * three {@link DEFAULT_FIX_CLASSES} rows match by REGEX ON `logTail` — so an
 * unexplained empty tail silently made every one of them unmatchable.
 * `owner`/`repo` are REQUIRED and passed as `--repo` on the `gh` call — the
 * daemon/sweep can target a repo other than its own checkout's cwd (the
 * daemon-repo-targeting design), so this must never rely on `gh`'s ambient
 * cwd-inferred repo, which would silently query the WRONG repo's job ids.
 *
 * DEDUPED AND ALIGNED WITH `checksStateFromRollup` (W1-T457). This function used to filter to
 * `FAILURE`/`ERROR` only, over the RAW (non-deduped) rollup — TWO drifts from the red predicate
 * in lib/sweep.ts: (1) a stale SUPERSEDED attempt of a check name could still appear here even
 * after a later attempt of the SAME name went green, and (2) `checksStateFromRollup` vetoes on
 * the wider {@link REQUIRED_CHECK_FAIL} set (also TIMED_OUT/CANCELLED/ACTION_REQUIRED/
 * STARTUP_FAILURE), so a required check red for one of THOSE reasons made `checksState` "red"
 * while this producer named nothing — the #1728 defect: an empty failing list dispatched behind
 * a red disposition, burning a ci-log fix-rung strike with nothing to fix (5 of 6 measured
 * `fix.dispatch` rows for this shape carried `unmet_count: 0`). Deduping first with the SAME
 * {@link dedupeRollupByLatestAttempt} rule and filtering on the SAME `REQUIRED_CHECK_FAIL` set
 * makes this producer and that predicate agree BY CONSTRUCTION — one drifting without the other
 * is no longer possible, since both read the one shared definition.
 *
 * EXPORTED (previously module-private) so this contract has its own direct test coverage —
 * test/sweep-superseded-check-run.test.ts drives it straight, rather than only indirectly through
 * the wider sweep pipeline.
 */
```

---

## resolveOpenPrTaskId

`src/run-task.ts:43515-43542` at `0f63458cf`, 28 comment lines, moved to
`src/lib/tick-read-worker.ts` by W1-T9722.

```
/**
 * Resolve a PR's task id (W1-T453): the fleet's own `run-<taskId>-<epochMs>` branch naming
 * ({@link taskIdFromRunBranch}, status.ts) is readable everywhere EXCEPT here — `projectPlan`
 * uses it twice, `isDispatchedRunBranch`/`fixHeadAcceptable` use its shape — so a fleet-built
 * PR with no `Remudero-Task:` trailer could never arm `armAutoMerge` (`automerge.ledger_refused
 * (W1-T230): no task id resolvable`, observed 6x on PR #1722, which the fleet had already
 * reviewed PASS) and reported `criteriaRecoverable: false` even after a passing review.
 *
 * TRAILER FIRST, head-ref only as a FALLBACK: an author's trailer is a deliberate statement,
 * while a branch name is minted by `worktreeAdd` — on a genuine disagreement (a worker that
 * opens a PR for task A from a worktree cut for task B) the explicit statement wins.
 *
 * The head-ref fallback is WITHHELD for a plan-only filing PR: #1527 deliberately strips the
 * trailer from a filing PR so merging it cannot credit the task(s) it just filed as IMPLEMENTED.
 * A filing PR dispatched from an existing task's own `run-<taskId>-*` worktree sits on that
 * task's run branch too — falling back to the head ref unconditionally would re-open that exact
 * hole by crediting the DISPATCHED task from a plan-only diff, the trap design (iii) of this
 * task names explicitly.
 *
 * `planOnlyFiling` is the caller's ALREADY-COMPUTED {@link classifyPlanFiling} verdict for this
 * exact PR (W1-T3505) — never re-derived from `isPlanOnlyFilingPr` alone here. `buildOpenPrViews`
 * classifies every open PR through both the emitter-ledger receipt AND, absent one, a GitHub file
 * list read (`planFilingClassifications`); a PR whose diff is provably plan-only by that second,
 * `"github-files"`-sourced read must withhold the head-ref fallback exactly like an emitter-ledger
 * hit does. Resolving task identity from the narrower emitter-only signal instead let a
 * `github-files`-classified plan filing (PR #5340) keep its dispatched run branch's task id,
 * offering the plan-only diff to the code-fixer lane as if it were that task's implementation.
 */
```

---

## actionableGateFailuresFromLedger

`src/run-task.ts:43688-43714` at `0f63458cf`, 27 comment lines, moved to
`src/lib/tick-read-worker.ts` by W1-T9722.

```
/**
 * W1-T923's producer: recover a GATE failure's named remedy for a task/PR from the ledger — the
 * SAME `review.posted` scan {@link unmetFromLedger} runs above, but reading it for the shape
 * that function's OWN result leaves empty: a failing review whose `unmet_criteria` came back
 * `[]` (no unmet acceptance criterion), which is exactly the #1991 motivating case (12/12
 * criteria `executed_pass`, `unmet_criteria: []`, yet `state: "failure"`).
 *
 * STRUCTURED, NEVER PARSED (design note vi): this reads the LENGTH of the ledger's structured
 * `reasons` array, never the CONTENT of `failure_reason` (`verdict.summary`, free prose a regex
 * over which design note vi forbids). Exactly ONE structured reason is treated as one
 * unambiguous, single-form remedy (design note iv) and copied through VERBATIM — the same
 * pass-through {@link unmetFromLedger} already does for a criterion's own `reason`, never a
 * re-derivation. TWO OR MORE reasons name a CHOICE between forms (or several independent
 * problems) and are EXCLUDED entirely, never included-but-flagged: #1991's own falsifier is a
 * provenance check that accepts `Chosen (RECOMMENDED, auto)` OR an operator-attribution line,
 * crediting different authors — a worker acting on the wrong one misattributes a ratified
 * `DECISIONS.md` ruling. ZERO reasons (today's shape for most gate failures, including #1991's
 * OWN ledger row, which carries `reasons: []`) yields `[]`: nothing structured was named, so
 * nothing is claimed to be — the honest outcome design note vi asks for rather than a parser.
 *
 * `failure_class`/`failure_reason` are NEVER read here (design note v): #1991 is classed
 * `test_theater` — the class this design would otherwise treat as unautomatable — while its
 * `reasons` (once a check populates them) would still name the remedy; keying on the class would
 * mis-sort the very case this function exists for. The single-form-vs-choice DECISION itself is
 * {@link actionableGateFailuresFromReasons} (lib/sweep.ts) — this function's own job is only the
 * ledger scan, mirroring `unmetFromLedger` immediately above.
 */
```
