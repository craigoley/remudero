# status.ts comment forensics

The measured forensics, incidents and design arguments that were removed from `src/lib/status.ts` when its comments were compacted to the plain-language standard.

Each section below carries the removed block VERBATIM, under a heading naming the symbol it
explained, and the code keeps a one-line `Why:` pointer wherever the history mattered. Nothing
here was rewritten: this is the original text, so a reader chasing a bound or an incident reads
what the author of that bound actually wrote.

Line numbers are positions in `src/lib/status.ts` at the merge base of the compaction PR.

## node:fs default import

Removed from lines 8-20.

```
// Imported as the module's DEFAULT export (a plain, mutable object), not as named
// bindings (`import { existsSync } from "node:fs"`) — deliberately, and load-bearing
// for W1-T115's "assert via injected fs" proof shape. ESM named-export bindings off
// `node:fs` are non-configurable (`Object.defineProperty`/mock.method on them throws
// "Cannot redefine property"), so a test that tries to spy on the real module — the
// generic, DI-agnostic way to prove "no write syscalls happened" — cannot intercept a
// call already bound to a named import at load time, whether or not it goes through
// this module's own {@link LedgerFsDeps} injection. Calling `fs.existsSync(...)` as a
// property access AT CALL TIME (never destructured to a local const) keeps every call
// a live lookup on this same mutable object, so an external spy on `fs.existsSync`/
// `fs.readFileSync`/`fs.writeFileSync` (via `node:test`'s `mock.method`) actually
// observes it — the same guarantee {@link LedgerFsDeps} gives a caller that injects
// its own fake, extended to a caller that only has the real `node:fs` module to spy on.
```

## Module precedence (derived task status)

Removed from lines 50-99.

```
/**
 * Derived task status (MASTER-PLAN v2.1 decision, implemented here).
 *
 * Task merge-state is DERIVED FROM GITHUB, never written back to plan/tasks.yaml.
 * A YAML round-trip destroys comments, status commits spam a public repo, and a
 * machine writer racing a human editor is a conflict class we simply do not have.
 * The `status:` field in tasks.yaml is therefore DECORATIVE (initial-state only);
 * the truth of whether a task landed is computed on demand from GitHub, in a
 * fixed precedence, and cached to a machine-owned projection (state/status.json).
 *
 * Precedence for a task id — an operator correction is checked FIRST and is
 * SUPREME (MASTER-PLAN P9 / W1-T75): it is DECLARED ground truth, not inferred
 * evidence, so it outranks every rung below rather than being read only inside
 * rung (c). Then, absent a correction, a VERIFIED-MERGED credit outranks an
 * open-PR ledger claim (W1-T116, MASTER-PLAN §3): an open PR is only ever the
 * WEAKEST evidence in the system — POSSIBLY RUNNING — so every rung below is
 * checked for a GitHub-confirmed MERGED result BEFORE an open `pr.opened` row
 * is allowed to stand as this task's status:
 *   (a) state/ledger.ndjson `pr.opened` line for this task -> query that PR's state.
 *       A MERGED resolution wins outright; a non-merged one is remembered as the
 *       dedup fallback (below) but does NOT stop the remaining rungs from being
 *       checked for a merged credit;
 *   (b) an explicit `pr:` field in tasks.yaml (tasks executed by hand, pre-ledger)
 *       — checked even when (a) already found a non-merged PR, so a settled `pr:`
 *       credit is never masked by an in-flight ledger row (the W1-T1 149x root
 *       cause: `pr.opened` pointed at an open, later-dispatched PR while `pr: 2`
 *       had long since merged);
 *   (b2) a `manual.completed` ledger line (W1-T1029) — the SAME hand-execution
 *       rung as (b), widened to the two shapes a bare `pr:` NUMBER cannot
 *       express: a completion PR in ANOTHER repository (`pr:` resolves only
 *       against THIS gateway's own configured repo), and a completion with NO
 *       PR at all, because none will ever exist (a manual task whose own work
 *       is a live drill/action, not a diff). DECLARED credit, like (c)'s
 *       correction override above — never re-verified against GitHub, since a
 *       cross-repo PR is unreachable from this gateway and a no-PR completion
 *       has nothing to verify. See {@link latestManualCompletion};
 *   (c) a merged PR whose body carries the trailer `Remudero-Task: <id>` —
 *       ownership-asserted (its head branch must be this task's own `run-<id>-*`),
 *       anchor-verified (the trailer must be an exact line, not a fuzzy search
 *       hit), and correction-aware (a `correction.provenance` line debunking this
 *       exact credit is honored) — MASTER-PLAN P16 / W1-T69, the "W1-T20c
 *       false-credit" class: deriveStatus GATES DISPATCH, so a bad credit here
 *       is worse than the same class W1-T51 fixed in the retro gather.
 * The first rung to resolve a MERGED PR wins. If none merges, (a)'s own
 * non-merged resolution (if any) stands as a "possibly running" dedup signal;
 * otherwise the task is not merged.
 *
 * NOTHING in this module writes tasks.yaml. It reads the plan and the ledger and
 * queries GitHub; the only file it writes is the status.json cache.
 */
```

## GH_CALL_TIMEOUT_MS

Removed from lines 207-230.

```
/**
 * Wall-clock ceiling on ONE `gh` invocation, for every gateway in this module.
 *
 * WHAT HAS NO BOUND TODAY BLOCKS THE WHOLE DAEMON. Both gateways shell `gh` through
 * `execFileSync`, which is SYNCHRONOUS: a call that never returns does not merely stall the
 * sweep, it parks the daemon's only thread, so the poll loop, every review the sweep would post
 * and every later rung stop with it — with nothing logged, because a hang is not an error. On
 * 2026-08-13 a single sweep pass that began at 10:57 was still running at 11:54, observed on
 * `gh api --paginate repos/…/pulls/768/files`, with four PRs unreviewed the whole time.
 *
 * THE NUMBER IS SIZED SO IT CANNOT FIRE ON A HEALTHY CALL, which is this repo's recurring
 * defect when it does. MEASURED 2026-08-13 against this repo: the heaviest read the board makes
 * — a 100-row closed page carrying every body — took 0.70–0.90 s over six consecutive calls, and
 * a per-PR `--paginate` file list took 0.32–0.40 s. 60 s is ~67x the slowest healthy call
 * observed, and still inside the 60 s `DEFAULT_POLL_INTERVAL_MS`, so one stalled call cannot
 * outlive the poll that issued it.
 *
 * FIRING IS FAIL-SOFT, NEVER FAIL-WRONG. The kill surfaces as a throw, which the callers already
 * classify ({@link classifyGhFailure}, via `code: "ETIMEDOUT"` ⇒ `transport`), ledger
 * (`board_gateway.fetch_failed`) and degrade on — `lastFetchFailed` is reset by the next
 * successful fetch, and `fetchBoardPrsRest` leaves the caller's row cache untouched on a throw,
 * so recovery costs a 2-request delta rather than a cold re-walk. A bounded, named, recoverable
 * failure strictly dominates an unbounded silent hang.
 */
```

## StatusProjection.verifyHumanPending

Removed from lines 488-515.

```
  /**
   * W1-T507: this task is filed `verify: human` in the plan AND this projection's own `merged`
   * is false — the plan has already excluded it from every machine-dispatch path
   * (`isDispatchEligible` in `src/lib/drain.ts`, `assertRunnable` in `src/lib/plan.ts`, and three
   * `task-linter.ts` predicates all return/throw on `task.verify === "human"`), so nothing else
   * in `src/` ever converts that exclusion into a signal a person can see. Set by
   * {@link deriveStatus} itself (unlike `supersededBy` immediately above, which needs an
   * external git-log search dependency `deriveStatus` does not take, and is therefore attached
   * one level up in {@link projectPlan}): this flag is a pure function of `task` plus THIS
   * call's own already-resolved `merged`/`indeterminate`, so computing it here keeps every
   * caller — `projectPlan`'s hoisted pass and a standalone `deriveStatus(task, deps)` call
   * alike — DERIVATION-EQUIVALENT, never diverging by which path reached it.
   *
   * DELIBERATELY A DIFFERENT FIELD FROM `needsHuman`, never a widened one. `needsHuman` backs
   * the NEEDS ME escalation row's own "view issue"/"mark handled" affordance
   * (`escalationIssueUrl`/`escalationTitle`), which a `verify: human` task never has — it is
   * never DISPATCHED, so it never RUNS, so it never escalates. Setting `needsHuman` here would
   * render that affordance with nothing to click. A DISTINCT KIND instead, so a caller (the
   * console) groups by it rather than flattening two different reasons a row needs a person
   * into one flag.
   *
   * "Already credited merged" is exactly this projection's OWN `merged` — the same field every
   * other precedence rung already resolves from EITHER credit path (an anchored
   * `Remudero-Task:` trailer, or a `run-<taskId>-<digits>` head ref), so a task credited through
   * either route is correctly excluded here too, same as everywhere else `merged` gates.
   * Sparse, like `needsHuman`/`indeterminate`/`orphaned`/`supersededBy` — present only when
   * applicable.
   */
```

## GitHub.findMergedByTrailerAll

Removed from lines 540-556.

```
  /**
   * EVERY merged PR carrying `taskId`'s anchored trailer, newest-first (W1-T441) — the whole
   * candidate set {@link findMergedByTrailer} discards by returning only the first.
   *
   * WHY THE SINGLE ANSWER IS SYSTEMATICALLY THE WRONG ONE. The already-satisfied CLOSE path
   * manufactures duplicates: each close merges a NEWER trailer-bearing PR that displaces the
   * implementation in every later lookup. MEASURED over all 1,172 merged PR bodies (anchored
   * `^Remudero-Task: <id>$`): 496 distinct ids carry a trailer and SIXTEEN are carried by more
   * than one — W1-T254 by six, where #720 is the implementation (`fix(sweep)…`) and the other
   * five change `DECISIONS.md` alone.
   *
   * Returns null if the read FAILED (→ readFailed()/W1-T119), [] on a genuine no-such-PR — the
   * two must stay distinguishable, exactly as {@link findMergedByHeadBranch}'s own doc insists.
   * OPTIONAL (added after every pre-existing {@link GitHub} fixture was written) so no existing
   * implementer breaks — omitted ⇒ callers fall back to {@link findMergedByTrailer}'s single
   * answer and behave exactly as they did before.
   */
```

## GitHub.listOpenHeadBranches

Removed from lines 584-602.

```
  /**
   * The OPEN twin of {@link listMergedHeadBranches} (W1-T377): every OPEN PR carrying its
   * `headRefName`, so {@link projectPlan} can match `run-<taskId>-*` CLIENT-SIDE and credit a
   * task with an open PR that the ledger never recorded.
   *
   * WHY THIS IS NEEDED AT ALL. The ONLY route to an OPEN association is rung (a)'s ledger
   * `pr.opened` line — rungs (c)/(c2) are gated on `state === "MERGED"` and answer a different
   * question. So a run that opens a PR but never ledgers the line leaves its task looking
   * dispatchable, and `isDispatchEligible`'s in-flight guard (drain.ts) cannot fire. MEASURED
   * (2026-08-05, W1-T350): run 1785957031821 had its worktree reaped mid-run at 20:01:40, opened
   * PR #1377 at 20:08:02, and never wrote `pr.opened`; the task re-dispatched at 20:11:02, built
   * the whole thing a second time as #1378, merged that, and left #1377 a conflicting duplicate.
   * A full high-risk run (budget_usd 85) spent on work that already existed.
   *
   * COST: ZERO extra calls on the batched path — {@link buildBatchedGithub} already fetches
   * `--state all` and merely filters to MERGED, so the open rows are sitting in the same index.
   * OPTIONAL, like its merged twin: omitted ⇒ the corroboration is skipped and derivation behaves
   * exactly as before. Returns null if the read FAILED (→ readFailed()/W1-T119), never [].
   */
```

## GitHub.resetFailureFlags

Removed from lines 734-764.

```
  /**
   * R-24 (docs/audits/recon-2026-09-05.md): DROP THE FAILURE VERDICTS LEFT BY EARLIER ATTEMPTS, AND NOTHING ELSE — the one
   * seam that lets a gateway be held for a whole daemon/drain lifetime instead of rebuilt per
   * tick.
   *
   * WHY IT HAS TO EXIST. `buildBatchedGithub` closes over BOTH a delta cache (`knownBoardPrs`,
   * the row set `fetchBoardPrsRest`'s early stop compares against) and a set of failure
   * verdicts. Those two want opposite lifetimes: the cache is worth more the longer it lives —
   * a warm closed half stops at the delta boundary in ~2 requests where a cold one walks the
   * repo (MEASURED at 25 requests / 21.8 s at 2,400 PRs; this repo has passed 4,080) — while a
   * verdict must never outlive the tick that earned it, or one transient outage marks every
   * later tick indeterminate. `drainCommand`/`daemonCommand` used to buy the second property by
   * throwing the whole instance away every tick, which paid for it with the first. This method
   * separates them: the caller holds ONE instance and clears the verdicts at the top of each
   * tick.
   *
   * WHAT IT CLEARS, AND WHY THE EMPTY HALF GOES WITH THE FLAG. A FAILED fetch replaces its half
   * with an EMPTY one and stamps it (the W1-T181 pairing) — the empty rows are only ever safe
   * because they are read alongside `readFailed()`. Clearing the flag while leaving that stamped
   * empty half in place would hand a caller "GitHub says zero PRs" under a healthy label, which
   * is precisely the conflation W1-T181 exists to prevent. So a half is dropped exactly when its
   * failed verdict is, and the next read re-fetches it. `knownBoardPrs`/`knownIssues` are NOT
   * touched: they are already untouched on a throw, so the re-fetch is a cheap delta, not a cold
   * walk.
   *
   * A SUCCESSFUL verdict and its half are left exactly as they are — this is a reset of
   * failures, never of the cache, and it performs no I/O.
   *
   * OPTIONAL, like every other method added after the first {@link GitHub} fixture: omitted ⇒ the
   * caller's `?.()` is a no-op and the gateway keeps whatever verdict lifetime it already had.
   */
```

## DeriveDeps.inflightHolder

Removed from lines 918-940.

```
  /**
   * THE INFLIGHT-LOCK ANCHOR (the third disjunct beside `hasOpenPr`/`recentActivity`): the
   * task's current in-flight lock holder, or `null` when no lock is held. ABSENT ⇒ SKIP —
   * omitting it degrades this rung to exactly the pre-existing two-disjunct behaviour, the
   * same "absent ⇒ skip" contract {@link DeriveDeps.mergedHeadBranches} already uses, so
   * every call site that predates this is unaffected.
   *
   * WHY A LOCK AND NOT ANOTHER LEDGER STEP. {@link DeriveDeps.livenessBoundMs} infers
   * liveness from ledger CHATTER, which a genuinely-live run can stop producing: measured
   * over the unioned ledger, 96 of 664 runs (14.5%) contain an intra-run gap longer than the
   * 30-minute bound, so a working run that goes quiet renders as not-running. The lock is
   * OBSERVED STATE rather than an event, so it covers the quiet stretch that no start/terminal
   * step table can — and terminals cannot be enumerated their way out of it: of 143 runs with
   * a `run.start` and no `verdict`, 106 end at `settings.validated`, an EARLY step, because
   * the process died and wrote no terminal at all.
   *
   * NOT TRUSTED ALONE, DELIBERATELY. A lock file outlives its process: `withInflightLock`
   * releases in a `finally`, and there are NO signal handlers anywhere in src/, so SIGKILL —
   * and SIGTERM, which Node's default terminates on without unwinding — both leave the file
   * behind (`sweepStaleInflightLocks`' own doc records `W1-T1.lock` holding a pid dead for two
   * days). It is therefore paired with {@link DeriveDeps.isPidAlive} below, which is the same
   * `isStale` predicate `reclaimStaleLock` already conditions its own reclaim on.
   */
```

## W1-T951 durable merge credit, layer choice

Removed from lines 1031-1054.

```
// ── W1-T951: DURABLE MERGE CREDIT ───────────────────────────────────────────────────────────
//
// DESIGN DECISION (i), RECORDED IN WRITING per the shard's own requirement: the durable record
// belongs at THIS layer — `src/lib/status.ts`, inside `derivePrPrecedence` — not a new one
// bolted on above `deriveStatus`/`projectPlan`, and not inside `drain.ts`. Every construction
// site that reads `projection.merged` (status-board.ts:1325, panel-graph.ts:1018,
// run-task.ts:10621/:12292) goes THROUGH `deriveStatus`/`projectPlan`; neither rung (c)'s
// trailer search nor rung (c2)'s `corroborateByBranch` persists anything today (rationale (3)),
// and both already live in this one module. Adding a store here means every existing caller of
// `deriveStatus`/`projectPlan` gets the fix for free — the SAME "optional dep, real default"
// shape `readLedger`/`mergedHeadBranches`/every other {@link DeriveDeps} field already uses — with
// zero wiring changes at any of those four construction sites, so `run-task.ts` stays undeclared
// exactly as the shard's note requires (W1-T471: declaring the monolith serialises every task
// naming it).
//
// WHY NOT A NEW LAYER (e.g. a `credit.ts`, or a ledger step): a new module would need its own
// copy of the "read once per `projectPlan` call, write once at the end" batching
// `readLedgerLines`/`mergedHeadBranches` already solved for the identical N-tasks-per-projection
// shape a few lines below — reinventing it, not reusing it. A ledger step (`credit.recorded`)
// was considered and rejected: the ledger is PER-TASK (`deps.ledgerPath` is scoped to one task's
// state directory in the real caller — see `derivePrPrecedence`'s existing ledger reads), while
// credit needs to be looked up FOR a task from a store that does not require that task to have
// ever produced ledger output of its own (a durable record must survive precisely the case the
// ledger cannot: nothing local to the task's own history, only the fact that some PR merged it).
```

## CREDIT_SCAN_MAX_ROTATIONS

Removed from lines 1263-1283.

```
/**
 * How many rotations {@link readMergeCreditedTaskIds} may open before giving up on a task it has
 * not yet found a credit for.
 *
 * MEASURED on this host's real 666-gz/3-plain/1-live corpus, over BOTH credit spellings: every one
 * of the 445 ever-credited ids resolves within 24 files, and the depth distribution is
 * median 0, p90 0. The only ids needing more than 8 are `SBX-T1`/`SBX-T2`/`SBX-T3`/`SB-HELLO`/
 * `CI-GREEN-PROBE` at depth 21 — WS-1 sandbox probe ids that appear in `plan/` only inside a
 * `satisfied_by` PROSE string, never as a task id, so `buildCreditCandidates` (which iterates
 * `plan.tasks`) can never ask about them. For the ids it CAN ask about, the deepest is under 8.
 *
 * COST, measured on the same corpus: 1 file 21 ms / 3.3 MiB, 8 files 197 ms / 16.8 MiB, 24 files
 * 598 ms / 20.4 MiB. The full union is 11.42 s / 0.11 GiB — the price this cap exists to refuse,
 * and a per-pass full-corpus read would be far worse than the treadmill it replaces.
 *
 * THE CAP IS SAFE IN THE DIRECTION THAT MATTERS, which is why a bound is acceptable here at all.
 * This reader only ever ADDS ids it has actually seen, so it cannot invent a credit. Reading too
 * shallow therefore degrades to EXACTLY today's behaviour (the task is re-credited); it can never
 * strand real work by falsely reporting a task already credited. Under-read is cheap and
 * self-correcting; over-report would be the dangerous direction and is unreachable by construction.
 */
```

## readMergeCreditedTaskIds

Removed from lines 1286-1318.

```
/**
 * Every task id the ledger has EVER recorded merge credit for, read across all three ledger forms,
 * newest-first, stopping as soon as every `candidate` is resolved.
 *
 * WHY THIS EXISTS — `runCreditBackfill` asked `hasMergeCredit` against `readLedgerLines`, WHICH
 * OPENS EXACTLY ONE FILE. `verdict.merged` and `verdict`/`merged` are both registered in
 * `DECISION_RELEVANT_LEDGER_STEPS`, and the comment on {@link isMergeCreditLine} concluded from that
 * "rotation cannot drop either out from under a reader" — WHICH IS FALSE, and is the belief that
 * hid this defect. Registration stops a step being shed COMPLETELY; it does nothing about
 * `MAX_RETAINED_LINES_PER_STEP`, which keeps only the newest 200 rows PER STEP. Credit older than
 * that leaves the live file, the backfill cannot see it, the task is re-credited, and the fresh row
 * evicts another — self-sustaining.
 *
 * MEASURED at 2026-08-13 on the live corpus, and the arithmetic is exact:
 *   distinct tasks carrying `verdict.merged` in the live file : 385
 *   MAX_RETAINED_LINES_PER_STEP                               : 200
 *     => credits rotation drops                               : 185
 *   `sweep.credit_backfill` rows in the live file             : 185   <- exact match
 * Amplification over the whole corpus: 61,903 `verdict.merged` rows across 386 distinct tasks
 * (160x), with many unrelated ancient tasks sitting at EXACTLY 670 rows apiece — an identical count
 * across unrelated tasks is a systematic signature, not organic activity. And it was not
 * converging: 6,759 corrections across 4,722 full sweeps = 1.43 per sweep, sustained.
 *
 * WHY A SET AND NOT `LedgerLines`. {@link readLedgerUnionBounded} returns every line it read, which
 * is right for a rendering surface that matches steps by prefix but wrong here: this runs on every
 * full sweep and would hold ~20 MiB of raw JSON as parsed objects for a question whose whole answer
 * is a set of ids. Accumulating only the ids keeps the memory bounded by the plan, not the corpus.
 *
 * IT SHARES {@link ledgerRotationEntries} DELIBERATELY. That function is "the one definition of
 * which files in a state dir are ledger rotations", and a fourth spelling of it is the defect this
 * repo keeps re-filing. Callers differ only in how they READ each form and what they accumulate —
 * the difference that is real.
 */
```

## seedCountFromCircuitBreak

Removed from lines 1949-1991.

```
/**
 * W1-T2425 — THE PRIOR COUNT THIS PROCESS DID NOT LIVE THROUGH.
 *
 * {@link evaluateDispatchBreakerDetailed}'s regression guard refuses a count that fell with
 * nothing in the ledger to explain it, but it can only refuse what it can COMPARE against, and
 * its `priorCount` comes from {@link DispatchBreakerCache.lastCounts} — an in-memory Map
 * `breakerGateFor` (run-task.ts) rebuilds PER INVOCATION. That function's own doc scopes its
 * claim honestly to a SAME-PROCESS rotation; a rotation plus a daemon RESTART was never covered,
 * because a brand-new process starts with nothing to compare against and reads a shortened live
 * file as forward progress. MEASURED on the fleet: W1-T1279 was refused every tick for 84 hours,
 * a rotation dropped its two oldest `run.start` rows, the daemon restarted across the same gap,
 * and the fresh process read `freshCount 3 < 5` and dispatched — with no line anywhere recording
 * a reset.
 *
 * THE EVIDENCE WAS ALREADY BEING WRITTEN, JUST NOT KEPT: the `dispatch.circuit_broken` row the
 * breaker's own refusal emits carries `freshCount` — the exact number the comparison needs (78 of
 * 78 rows on the fleet). It was archived by `rotateLedger`'s PASS 1 because the step belonged to
 * none of its three retention sets; this task adds it to `DECISION_RELEVANT_LEDGER_STEPS`, where
 * PASS 4's existing per-step cap bounds it exactly as it bounds `run.start`/`pr.opened`.
 *
 * NOT A WIDER READ: this reads the SAME `lines` the caller already loaded from the live file —
 * no second open, no archive, and `readLedgerLines`' `ledger-read-intent: live` contract at the
 * call site is untouched. NOT A RESET EITHER: a seeded prior can only make the INDETERMINATE arm
 * reachable, and indeterminate already means skip-and-retry, never dispatch.
 *
 * TWO KEYS, DELIBERATELY. The reset lines key the task on `task_id` (the same field
 * {@link dispatchesWithoutNewOwnedPr} filters on), but a `dispatch.circuit_broken` row is written
 * by the DAEMON's own run — its `task_id` is `"DAEMON"` and the task it refused is carried on
 * `task`. Reading `task_id` for both would silently seed nothing, which is a zero that looks
 * exactly like "this task never tripped".
 *
 * THE RESET MIRRORS THE COUNTER'S OWN. A `dispatch.circuit_broken` row OLDER than a `pr.opened`
 * or merge credit describes a streak that has since been legitimately cleared, so forward
 * progress discards the seed exactly as it zeroes the count — otherwise a task that tripped,
 * shipped, and dispatched once would compare its 1 against a stale 5 and refuse itself.
 *
 * The step literal is written INLINE rather than through a constant on purpose:
 * `test/ledger-rotation.test.ts` re-derives the decision-relevant set by scanning consumer
 * sources for an equality comparison against a quoted step name, so hiding this read behind a
 * symbol would blind the very gate that keeps the row from being archived again. That scan is
 * TEXTUAL, not syntactic — it reads comments too, so a doc that spells the comparison out
 * verbatim mints a phantom step and fails the gate. This paragraph describes it instead.
 */
```

## dispatchesWithoutNewOwnedPr and PRE_WORKER_REFUSAL_VERDICTS

Removed from lines 2014-2085.

```
/**
 * How many `run.start` ledger lines exist for `taskId` SINCE its most recent
 * FORWARD-PROGRESS line (or in total, if it has never recorded one) — "dispatches
 * with no NEW owned PR" (P29(ii)'s own phrasing).
 *
 * WHAT COUNTS AS FORWARD PROGRESS, AND WHY IT IS NOT JUST `pr.opened`. The counter's
 * intent is "did this task produce work"; `pr.opened` was a PROXY for it, sound because
 * run-task.ts logs that line only after ITS OWN worker pushes ITS OWN
 * `run-<taskId>-<epochMs>` branch (worker.ts) — so no ownership check is needed here the
 * way rung (c)'s trailer search needs one. THE BRANCH CONVENTION BROKE THE PROXY. A task
 * whose PR lands on a slug-named branch (`run-W1-T377-open-pr-corroboration`) fails
 * `ownsBranch`'s `run-<taskId>-\d+$`, so no `pr.opened` is ever written, and the task is
 * recorded as MERGED by the credit-backfill and as MAKING NO PROGRESS by this counter at
 * the same time. MEASURED: W1-T377 and W1-T378 both shipped (#1386, #1391), both carry
 * `verdict.merged` from the backfill and `pr.opened` ×0, and both ran to exactly 5
 * dispatches against {@link DEFAULT_MAX_TASK_DISPATCHES} before tripping — 10 dispatches
 * re-running finished work.
 *
 * So a merge resets the streak too ({@link isMergeCreditLine}). This RESTORES the stated
 * intent rather than widening the rule: a merged task has self-evidently produced work,
 * and the doc below already said a PR that merely OPENS is enough. The evidence is sound
 * to reset a safety bound on — a `verdict.merged` line comes from `runCreditBackfill`,
 * whose candidates are built by `deriveStatus` (run-task.ts's `buildCreditCandidates`),
 * which re-verifies the trailer as its own exact anchored line locally (rung (c)) rather
 * than trusting GitHub's fuzzy body index, and which refuses to credit a plan-only
 * changeset as an implementation (W1-T413). It does NOT share the `--limit 1` weakness of
 * the raw `findMergedByTrailer` first pass.
 *
 * `pr.merged` is deliberately NOT here: any run reaching it already logged `pr.opened`,
 * so it would reset nothing that is not already reset.
 *
 * A fresh PR (even one that does not merge, e.g. blocked_ci) resets the count to 0 —
 * genuine forward progress is not what this breaker guards against; the W1-T1/W1-T29
 * shape is dispatch after dispatch producing NOTHING new. The "succeeds every time" loop
 * that resets on its own merge each pass is NOT this counter's remit and is unchanged:
 * {@link dispatchesEver} is the lifetime bound that catches it, and no step resets that.
 */
/**
 * W1-T2423 — THE RUN VERDICTS THAT MEAN THE TASK WORKER NEVER STARTED.
 *
 * Both are PREFLIGHT PROBES that run once per dispatch and refuse ahead of every worker;
 * run-task.ts says so on each in its own words — the containment probe confirms an outside-cwd
 * write is OS-denied "before any task worker runs", the isolation probe confirms a worker
 * inherits zero operator aliases "before any task worker (recon/implement) runs", and both FAIL
 * CLOSED. So a run that ends in either tested THE HOST, not the task, and nothing about this
 * task's own ability to open a PR was observed. Counting it toward "dispatched with no new owned
 * PR" measures the wrong thing.
 *
 * W1-T2249 IS SUBSUMED, NOT RE-LITIGATED. It established exactly this principle for ONE probe
 * failure mode — a probe worker that died on a 529 — and its own doc stated the general rule:
 * "A run refused for THIS reason never reached the task worker at all". It keyed the exclusion on
 * `check === "spawn-transport-failure"`, and that key is why it never fired: `check` is stamped at
 * WRITE time, so the rule is FORWARD-ONLY over a counter that reads history backwards. MEASURED
 * over the fleet's three-form union: all 94 `blocked_containment` rows across 63 distinct tasks
 * read `check: "outside-cwd-denial"`, and ZERO of 517 distinct verdict rows carry the transport
 * symbol — so its third conjunct has never once been satisfied, and W1-T1279's rows, written some
 * 31 hours before the symbol existed, could never have been reached by it at all. Every row that
 * arm matched is a strict subset of this set, so its behaviour is preserved exactly.
 *
 * WHY A VERDICT AND NOT A CHECK. `verdict` is written by the same `log("verdict", …)` call that
 * has recorded these refusals since long before either exclusion existed, so a rule keyed on it
 * reads correctly over rows already on disk — the property an allow-list of reason symbols
 * structurally cannot have. It also needs no registration: a probe that grows a new failure
 * reason is covered the day it ships, with nothing to remember to add here.
 *
 * DELIBERATELY THESE TWO AND NO MORE. Other pre-worker returns exist in run-task.ts
 * (`blocked_git_fetch`, `blocked_illformed`, `blocked_inflight`, `task_already_merged`), but they
 * are a different question — they describe the repo, plan or PR state rather than a probe of this
 * host — and they are not a live one: each reads ZERO verdict rows over the whole union, against
 * a control distribution in which nine other verdicts do appear. Widening to them would be a
 * change with no measured population behind it.
 */
```

## DEFAULT_MAX_TASK_LIFETIME_DISPATCHES

Removed from lines 2176-2197.

```
/**
 * THE THRESHOLD IS A MEASUREMENT, NOT A GUESS (W1-T271's own design note). Derived from the
 * unioned ledger's real per-task `run.start` distribution — `state/ledger.ndjson` plus all
 * 661 rotated archives, 4,165,663 lines, measured 2026-07-31, deduped by `run_id` (every
 * archive is a cumulative byte-for-byte snapshot, so the same line recurs across many
 * archive files):
 *
 *   282 tasks have ever been dispatched at least once. 274 of them (97%) were dispatched
 *   1-4 times, ever, and NO task in this entire corpus that was genuinely legitimate work
 *   needed more than 4 lifetime dispatches.
 *   The only counts at or above 5 are all documented FAILURES, not legitimate fix-rung
 *   cycles: W1-T152 (5) is named alongside W1-T1 in this file's own rationale as a
 *   producing-nothing storm; W1-T254 (6, the incident that prompted this task), W3-T1a (6),
 *   W1-T7 (6), and W1-T230 (6) are each separately-documented no-op re-dispatch closures;
 *   W1-T64 (8), W1-T29 (11), and W1-T1 (153) are the two historically largest storms (P29's
 *   own motivating incidents).
 *
 * 10 sits comfortably above the ENTIRE legitimate population (2.5x its observed max of 4) —
 * "much higher" than the 5-dispatch streak cap, per design — while cutting off well short of
 * the two genuine storm magnitudes (11, 153), so it still functions as a real backstop
 * rather than a number so high it never fires.
 */
```

## planBranchReap

Removed from lines 2769-2800.

```
/**
 * Classify remote branches for a DRY-RUN reap. PURE: no git, no network, no deletion —
 * the caller gathers {@link BranchFacts} and decides what to do with the answer.
 *
 * PROTECTION IS EVALUATED FIRST AND WINS OUTRIGHT, and that ordering is the whole safety
 * argument rather than a detail. `decisions-landing` is simultaneously the head of a MERGED PR
 * (so the delete rule matches it) and a live code constant (`DECISIONS_LANDING_BRANCH` in
 * feedback-landing.ts) — evaluated the other way round, the fleet would delete a branch its own
 * source names. `heartbeat` is the same shape against the recency rule: it carries no PR at all
 * and is force-pushed as a PARENTLESS ROOT COMMIT every five minutes, so ordinary history
 * heuristics misread it while the name grep does not.
 *
 * DELETABLE IS THREE DISJUNCTS and the third is the one needing no trust: a merged PR head, a
 * closed-unmerged PR head, or NO PR with a tip already an ancestor of main — the last means every
 * commit exists in main already, so removing the ref cannot lose information. An OPEN PR is never
 * deletable; it lands in `hold` rather than `guarded` because it is in use, not infrastructure.
 * `"unknown"` NEVER SATISFIES A DISJUNCT — an unproven `prState` and an unproven `tipInMain` both
 * read as NOT deletable, the same conservative direction W1-T119 already established for a wholly
 * failed PR read, extended here to a partially incomplete one (W1-T2246).
 *
 * `undetermined` IS THE REASON SPLIT WITHIN `hold` (W1-T2246): a branch lands there when its
 * `hold` disposition rests on a fact that could not be proven, rather than on a decisive "no PR"
 * plus a decisive "tip not in main". Disposition never changes — nothing here is swept — only the
 * label the operator reads is more honest about which of the held branches are truly the only
 * copy of their work and which are simply unread.
 *
 * `undeclaredGuards` IS AN ALARM, NOT A RESULT. A declared list alone rots — measured repeatedly
 * here — and a name grep alone cannot see a branch referenced only through a variable
 * (`LANDING_BRANCH` recreates `feedback-landing` on the next landFeedback, when no branch of that
 * name exists to be found). So both run, and a guard the grep finds but the list omits is
 * REPORTED so it fails loudly rather than being swept in silence.
 */
```

## creditsByAnchoredTrailer

Removed from lines 3018-3040.

```
/**
 * RUNG (c) ACCEPT TEST — the operator's 2026-07-30 ruling, implemented verbatim:
 * "a correct, exactly-anchored Remudero-Task trailer on a MERGED PR is sufficient
 * evidence that the PR credits that task, and the head-branch NAME must no longer
 * be able to veto it — WITH an explicit guard that a branch clearly belonging to a
 * different task can never credit."
 *
 * WHY THE OLD ASSERT WAS WRONG (all OBSERVED, recon-AO): `ownsBranch` alone refused
 * SEVEN merged, correctly-trailered PRs because their branches were hand-named
 * (`feat-*`, `fix/*`) or lacked only the `-<epochMs>` suffix. Each task then stayed
 * `queued` forever, was re-dispatched, and tripped P29(ii)'s breaker — W1-T258 burned
 * $3.40 ending in `verdict: pr_attribution_failed`. Worse, the
 * escalation-lifecycle reconciler keys on this very `merged` flag, so the defect that
 * created those escalations also made retiring them impossible.
 *
 * TRAP 2 — NO NON-MERGED CREDIT PATH. The relaxation is scoped to `MERGED` and
 * nothing else. `state` is asserted MERGED **here**, from the PrRef, rather than
 * trusted from `findMergedByTrailer`'s name: that is an INTERFACE method a fixture
 * (or a future gateway) may implement with any state, and the (c2) rung already
 * re-asserts `state === "MERGED"` for the same reason. For any non-merged state the
 * OLD strict behaviour is kept unchanged — the branch must be owned — so an OPEN or
 * CLOSED-UNMERGED PR can never earn credit through the widened path.
 */
```

## derivePrPrecedence correction supremacy

Removed from lines 3289-3314.

```
  // SUPREMACY (MASTER-PLAN P9 / W1-T75, ratifying the W1-T20c/#134 stranding): an
  // operator correction is checked FIRST, above rungs (a)/(b)/(c) — not merely
  // inside rung (c) ahead of the trailer search. A correction is DECLARED credit
  // (operator ground truth via the sanctioned `rmd correct` writer), not INFERRED
  // evidence, so it is deliberately EXEMPT from the run-branch ownership-assert
  // (that assert guards rung (c)'s fuzzy trailer search, not a human declaration) —
  // the canonical case is a merged PR on a `fix/*` head (#134), which the assert
  // would otherwise reject, making the un-strand impossible by construction.
  //
  // SUPREME OFFLINE (W1-T130, ratifying P9-iv, consuming W1-T119's read-failure
  // distinction rather than re-deriving it): a correction is LEDGER-LOCAL evidence
  // — `applyCorrection` (correct.ts) already resolved `prRef` via a REAL gateway
  // call once, at WRITE time, before the line was ever appended, so re-resolving
  // it here on every derivation buys no new information and puts a gateway call
  // back on the automated dispatch loop's hot path for every corrected task, every
  // poll cycle. That is exactly the mechanism the 2026-07-19 incident exploited:
  // under quota exhaustion `prByRef` returned null for the correction's own
  // target, this rung fell through to "queued", and the daemon re-dispatched a
  // task already SATISFIED BY PR #2 (merged 2026-07-14) — sixty run ids, 76 spends,
  // $206.15 notional, self-reinforcing since each re-dispatch burned more quota.
  // No read result — healthy, throttled, errored, or absent — may ever demote a
  // correction-credited task back to dispatchable: supremacy is UNCONDITIONAL, not
  // best-effort, so this branch returns BEFORE any `deps.github` call at all.
  // `prNumber` is decoration parsed from the URL's own text (never a gate); a
  // corrected task is reported `merged` unconditionally, never re-subjected to
  // whatever GitHub currently says (or fails to say) about `correctedUrl`.
```

## W1-T485 supersession

Removed from lines 4134-4148.

```
// ── W1-T485: SUBSTANCE THAT SHIPPED UNDER ANOTHER TASK'S TRAILER ─────────────────────────────
//
// THE GAP THIS FILLS, AND THE ONE IT DOES NOT. W1-T458's `unresolved_task_scope` advisory
// (lib/review.ts) fires when a merging implementation diff resolves NO task, and its own doc says
// it is keyed on the resolved task's declared files "NEVER off whether the report/diff carries a
// `Remudero-Task:` trailer". So it answers "no task at all". It cannot answer "the WRONG task",
// and the measured case proves it: #1772 shipped that advisory at 2026-08-14T02:38:55Z, and
// #1777 merged three hours and sixteen minutes later carrying `Remudero-Task: W1-T464` while
// shipping W1-T472's substance. A task WAS resolved, so the advisory correctly stayed silent, and
// W1-T472 is still `blocked`/`verify: human` waiting on a ruling about work already on main.
//
// A REPORT, NEVER A GATE. Nothing here refuses a merge, mutates a Task, or adds a credit path. A
// merge-time refusal keyed on a trailer mismatch would fire on every FILING — filings are required
// to omit the trailer (#1527) — and a bound that fires on a healthy condition gets muted, which
// this repo has six measured instances of. A false positive here costs one line of output.
```

## buildCommitTrailerIndex

Removed from lines 4349-4385.

```
/**
 * W1-T2387 — THE SECOND TRAILER SURFACE, AS AN INDEX.
 *
 * THE ASYMMETRY THIS CLOSES. The commit trailer is MACHINE-written (`appendTaskTrailerToCommit`
 * amends the worker's tip commit, idempotently, on both PR paths) while the PR-body trailer is
 * HAND-written (`renderBody` emits it only when a caller passes `taskId`). `findMergedByTrailer`
 * read only the hand-written one, so 16 merged PRs carried the trailer in the commit and not the
 * body and nine of them were credited nowhere — four of those nine in two days.
 *
 * A UNION, NEVER A COMPARISON. This is consulted only AFTER the body surface has answered and
 * answered EMPTY, so it can only ever ADD credit. It never withdraws one, never disagrees with
 * one, and has no refuse-a-merge failure mode — which is why it lives on the read path rather
 * than in a gate. (The miss is only observable after merge, once a dispatch is already spent.)
 *
 * NO NEW FETCH. `git log` over a ref that is already local — MEASURED at 32 ms for 3.6 MB over
 * this repo's whole history — and callers memoize it, so it is O(1) subprocesses per gateway
 * instance and runs at all only once some task actually misses on the body surface.
 *
 * `null` on a failed read, never an empty Map: the failure/absence distinction every other
 * reader in this file keeps (W1-T119). Newest first, matching `findMergedByTrailer`'s own
 * documented ordering — `git log` already emits in that order.
 *
 * ⚠ THE WHOLE SURFACE DEPENDS ON A REPO SETTING THIS FILE OTHERWISE NEVER NAMES (W1-T2447).
 * This reads `git log`, which sees only what GitHub actually WROTE into the squash commit — and
 * GitHub chooses that content from the repo's `squash_merge_commit_message` setting.
 * `COMMIT_MESSAGES` concatenates the branch's own commit subjects/bodies into the squash commit,
 * which is the ONLY reason `appendTaskTrailerToCommit`'s amended tip-commit trailer is still
 * there for the `git log` below to find. The other legal value, `PR_BODY`, discards the branch
 * commits entirely and writes the PR body instead. MEASURED against this repository's own
 * settings: `squash_merge_commit_message: "COMMIT_MESSAGES"`. That is an admin-only GitHub UI
 * toggle — no commit, no review, no ledger row — and flipping it to `PR_BODY` does not break
 * this function: it keeps returning a `Map` and {@link deriveStatus} keeps reading it, but every
 * FUTURE squash stops carrying a trailer at all, so the index quietly stops growing while
 * looking exactly as healthy as it does today. Before this comment and the pinning test at
 * `test/commit-trailer-surface-squash-setting.test.ts`, nothing in `src/`, `test/` or
 * `.github/` named `squash_merge_commit_message` at all.
 */
```

## buildBatchedGithub

Removed from lines 5091-5130.

```
/**
 * A GitHub gateway that answers ALL of {@link GitHub}'s methods from ONE batched fetch of the
 * repo's PRs, held in memory (with a short TTL), instead of shelling `gh` PER call.
 *
 * WHY: {@link ghGateway}'s `findMergedByTrailer` runs a `gh pr list --search` PER task, so
 * `projectPlan` over an N-task plan makes O(N) sequential `gh` subprocesses. On the board's
 * `GET /v1/status` request path that is ~0.4s × N — at 183 tasks, ~74s, and the browser hangs at
 * "loading…". This gateway makes it O(1): the first method call fetches every PR once
 * (`number,url,state,headRefName,body`), and all N tasks in a snapshot resolve against the shared
 * in-memory index. The index refreshes after `ttlMs`, so the board stays live.
 *
 * Drop-in for `ghGateway`, but `findMergedByTrailer` matches the ANCHORED `Remudero-Task:` line
 * (not a fuzzy substring) so `W1-T1` never mis-selects a `W1-T15` PR — deriveStatus's rung (c)
 * re-verify then confirms it exactly as before.
 *
 * The underlying fetch is still LAZY by default (the first query method call triggers it) — W1-
 * T154's boot-time pre-warm (lib/serve.ts's `prewarmBoardGithub`) is what turns that into "never
 * cold on the request path", by calling the optional {@link GitHub.warm} this gateway implements
 * BEFORE the server's first request can arrive, then again on a background timer paced to `ttlMs`.
 *
 * W1-T181 (the LIVE OUTAGE this repo's PR JSON crossing 1 MiB caused): the default fetch's
 * `execFileSync` now sets `maxBuffer: 1 << 26` (64 MiB headroom, not a value tuned to today's
 * payload — orientation.ts:72's `1 << 24` is the in-repo precedent for this class of fix). That
 * alone removes today's TRIGGER, but a THROWING fetch — a network blip, an auth expiry, a `gh`
 * upgrade, or simply outgrowing 64 MiB later — is the deeper, still-live defect: the pre-fix catch
 * did `lastFetchFailed = true; return []`, converting "I could not read GitHub" into "GitHub says
 * there are zero PRs", a bare `[]` a caller cannot tell apart from a genuinely empty repo. Fixed
 * here two ways: (1) the catch now lives in {@link index} itself, wrapping the call to `fetchAll`
 * — so an INJECTED `fetchAll` (every unit-test fixture, and any future caller-supplied
 * implementation) that throws is classified and marked exactly like a real `gh` failure, not just
 * the default execFileSync path; (2) `lastFetchFailed`/`lastFetchFailureReason` back this
 * gateway's `readFailed()`/`readFailureReason()`, which `derivePrPrecedence` (below, ~line 596)
 * already consults BEFORE trusting an empty result — the exact `github_unobservable`-shaped signal
 * W1-T179's monotonic-under-darkness criterion is designed to consume (this task is the producer,
 * W1-T179 the consumer; see plan/tasks.yaml W1-T181 design (v)). A failure is also now LOUD: see
 * {@link index}'s catch for the `console.error` + injectable `opts.log` calls, and
 * {@link classifyGhFailure}'s new `"buffer_overflow"` branch — ENOBUFS carries no `gh` stderr and
 * no exit status, so without that branch this exact failure classified `"unknown"` and the
 * 2026-07-20 outage ran for hours with zero error lines anywhere.
 */
```

## board index TTL floor

Removed from lines 5448-5502.

```
  // W1-T2323: A CACHE MUST SERVE FOR AT LEAST AS LONG AS IT COST TO BUILD.
  //
  // `cache.at` is already stamped on COMPLETION, not on request — `now()` inside the cache literal
  // below runs AFTER `fetchAll` returns — so a reading is never older than it claims. That half was
  // ALREADY CORRECT and nothing asserted it; this task PINS it
  // (test/board-index-ttl-outlives-its-fetch.test.ts) rather than rewriting it.
  //
  // WHAT THIS FLOOR ACTUALLY BUYS, MEASURED RATHER THAN ASSUMED. A cold gateway's first walk is
  // FULL: 26 sequential REST calls, 18.7-19.5 s measured on the live board. Once `knownBoardPrs` is
  // populated, a later expiry is a DELTA walk — MEASURED at 825 ms across the raw 15 s boundary, not
  // another 19 s. So the raw TTL was costing sub-second delta refetches, and this floor removes
  // those: a read 15.5 s after a 19 s walk now costs 0 ms instead of 825 ms.
  //
  // WHAT IT DOES NOT BUY, SAID PLAINLY. The expensive walks are the FULL ones, and they come from
  // COLD GATEWAY INSTANCES, not from TTL expiry: `knownBoardPrs` is per-instance (declared below),
  // so every `buildBatchedGithub` call pays one ~19 s walk on its first read however long the TTL
  // is. 65 of today's 170 walks were full. THIS CHANGE DOES NOT REDUCE THAT COUNT, and the boot
  // burst of three full walks in 100 s on 2026-08-26 was three cold instances, not three expiries.
  // Reducing instance count, or separating the open and merged clocks so a cold walk is one page
  // rather than 26, is the larger win and is NOT taken here.
  //
  // THE STALENESS IT ACCEPTS, NAMED. A cached board reading may be up to
  // `max(ttlMs, lastFetchDurationMs)` old instead of `ttlMs` — 19 s rather than 15 s on today's
  // numbers, a FOUR-SECOND increase in the worst-case age of the rollup a sweep disposition reads.
  // It is not a blanket raise: it is self-sizing from a cost the gateway already paid, and can
  // never exceed one fetch.
  //
  // `ttlMs === 0` IS EXEMPT FROM THE FLOOR. A zero TTL is not "a fast cache" — it is the
  // established test-suite idiom for "never cache, refetch every call" (see
  // test/board-prs-rest.test.ts, test/read-failed-not-attempted.test.ts,
  // test/serve-board-pacer-wiring.test.ts), used to isolate a single method's behaviour from the
  // gateway's memoisation. Flooring it would silently turn "always stale" into "stale after one
  // fetch duration", breaking that idiom for no production benefit — nothing in this process ever
  // constructs a gateway with `ttlMs: 0` outside a test.
  // W1-T2323 OPTION C COMPOSES WITH THE FLOOR: ONE FLOOR PER HALF, NOT ONE PER GATEWAY.
  //
  // #2998 shipped a single `lastFetchDurationMs` because there was a single clock. There are now
  // two, and they cost two wildly different amounts: MEASURED on the live board, the open pass is
  // 376 ms and the cold merged walk is 18,753 ms. A SHARED floor would let the merged walk's
  // duration govern the open clock, holding rows that cost under half a second for nineteen
  // seconds.
  //
  // MEASURED, A SHARED FLOOR BEHAVES IDENTICALLY TODAY, and that is exactly why it is not used:
  // `index()` refreshes the open half BEFORE the merged half, so the open stamp has already aged
  // by at least the merged walk's duration by the time anything reads it, and the shared floor is
  // never the binding constraint. That is a coincidence of the current call order, written down
  // nowhere and true only until the order changes or a half is refreshed on its own. The per-half
  // form is correct by construction rather than by accident, for the same cost.
  //
  // `ttlMs === 0` STAYS EXEMPT, ON BOTH HALVES (#2998's own carve-out, and the split makes it
  // load-bearing in more places). A zero TTL is the suite's never-cache idiom, and
  // test/board-prs-rest.test.ts, test/read-failed-not-attempted.test.ts and
  // test/serve-board-pacer-wiring.test.ts all use it AND all take the split path, since they
  // inject `opts.exec` rather than `opts.fetchAll`. Flooring a zero would turn "always stale"
  // into "stale after one fetch duration" for every one of them.
```

## restFetchHalf

Removed from lines 5632-5645.

```
  /**
   * ONE HALF OF THE BOARD, OVER REST — W1-T2323 option C's whole mechanism.
   *
   * The body below is byte-for-byte what the single combined fetch always did, parameterised by
   * WHICH half it walks — but this gateway only ever calls it with `"open"` or `"closed"` (see
   * `openRows`/`mergedRows` below). A gateway built with an injected `opts.fetchAll` never reaches
   * this function at all: `bothHalves` below calls `opts.fetchAll` directly, so `"both"` stays a
   * valid {@link BoardFetchHalf} for `fetchBoardPrsRest`'s own default but is not something this
   * wrapper is ever asked to walk.
   *
   * MEASURED 2026-08-26 on this repo: `"open"` is 1 request, 6 rows, 432 ms. `"closed"` cold is
   * 25 requests, 2,400 rows, 21,813 ms. Welded together, `listOpenHeadBranches` — the daemon's
   * only board consumer on the dispatch path — paid 26 requests for the 1 it reads.
   */
```

## openSiblingBuild

Removed from lines 6644-6665.

```
/**
 * W1-T2397 — WHAT AN OPEN SIBLING BUILD LOOKS LIKE, AND WHY IT IS ONLY EVER A REPORT.
 *
 * THE ASYMMETRY THIS NAMES. `isDispatchEligible` already sees open PRs, through `opts.isOpenPr`
 * <- `lastProj?.get(id)?.prState === "OPEN"`, resolved in `corroborateOpenByBranch` off the
 * batched gateway's OPEN half — no second call. But it attributes them by {@link ownsBranch}
 * alone, `^run-<taskId>-<digits>$`: ONE surface, where the merged side now has three. So an
 * operator-briefed build on a `fix/` branch is invisible and the task is dispatched again.
 * Measured: W1-T2387's #3102 was open and 87 minutes old when the fleet produced #3109.
 *
 * A WARN, AND THE MEASUREMENT IS WHY. The naive predicate ("any open PR naming this task") fired
 * four times in 72 hours and THREE OF THOSE MERGED — a refusal would have blocked shipped work.
 * Nor does a staleness bound rescue it: time-to-merge is median 18 minutes, p90 119, p95 255,
 * p99 864, so a threshold has to sit near EIGHT HOURS before it stops firing on healthy work, and
 * a refusal that is right at eight hours still costs eight hours of stall. A warn that is wrong
 * costs one line. THAT ASYMMETRY IS THE ENTIRE ARGUMENT for building this at a population of one.
 *
 * IT MUST NEVER FEED `isOpenPr`. Widening that is what converts this observation into the refusal
 * the shard declined, because `isDispatchEligible` already treats an in-flight PR as a reason to
 * skip. Nothing here is read by any eligibility path, and a test asserts `prState` is byte-
 * identical with and without this present.
 */
```

## Second pass (2026-09-06)

A second compaction pass over `src/lib/status.ts`, to the same plain-language standard as the first
(PR #4134, archived above). Line numbers are positions in `src/lib/status.ts` at this pass's merge base,
`2ecbdbcc`. Each block below is the original text VERBATIM; the code keeps a one-line `Why:` pointer
wherever the argument, the measurement or the incident still matters.

### classifyGhFailure — the ETIMEDOUT branch

Removed from lines 87-90.

```
  // A KILLED-ON-TIMEOUT CHILD CARRIES NO STDERR either, so it is detected from the `code` exactly as ENOBUFS
  // is: MEASURED, `execFileSync` past its `timeout` throws ETIMEDOUT with empty stderr. Classified "transport"
  // — a call that never returned is a network-class failure. Why: without this branch every timeout kill would
  // ledger as "unknown"
```

### PrRef.headRefOid

Removed from lines 129-132.

```
  /**
   * The exact current head commit from the same board fetch (W1-T2727). Optional for legacy and
   * injected rows; omitted means unknown and must never be treated as an exact-head match.
   */
```

### StatusProjection.orphaned

Removed from lines 220-223.

```
  /** LIVENESS BOUND (W1-T179): DISPATCHED with no terminal verdict, and neither an open PR nor
   *  activity within the bound backs it up — a crashed worker's stale trace. `status` stays within
   *  {@link TaskStatus}'s closed set; this sparse flag carries the signal.
   *  Why: the W1-T1 27h21m spin-loop fixture */
```

### StatusProjection.verifyHumanPending

Removed from lines 229-236.

```
  /**
   * W1-T507: filed `verify: human` and not merged. The plan already excludes such a task from every
   * machine-dispatch path, so nothing else in `src/` turns that exclusion into a signal a person can
   * see. Set by {@link deriveStatus} itself, being a pure function of this call's own resolved
   * state, which keeps every caller DERIVATION-EQUIVALENT. DELIBERATELY NOT `needsHuman`, which
   * backs an affordance such a task never has, since it is never dispatched and so never escalates.
   * Why: setting `needsHuman` here would render that affordance with nothing to click
   */
```

### interface GitHub

Removed from lines 244-247.

```
/**
 * The GitHub queries deriveStatus needs, behind an interface so unit tests can
 * inject fixtures for all three precedence sources without touching the network.
 */
```

### GitHub.findMergedByTrailerAll

Removed from lines 253-258.

```
  /**
   * EVERY merged PR carrying `taskId`'s anchored trailer, newest-first (W1-T441) — the candidate set {@link
   * findMergedByTrailer} discards by returning only the first, because the already-satisfied CLOSE path
   * manufactures duplicates that displace the implementation. null on a FAILED read, [] on a genuine miss. Why:
   * 16 of 496 trailered ids have more than one PR — docs/forensics/status.md
   */
```

### GitHub.findMergedByHeadBranch

Removed from lines 260-265.

```
  /**
   * CORROBORATION for an empty {@link findMergedByTrailer} (W1-T256): merged PRs whose HEAD BRANCH is this
   * task's run prefix — deterministic, NOT the body index, where an exit-0 EMPTY result is INDETERMINATE rather
   * than "not merged". Callers RE-ASSERT ownership. null on FAILURE, distinct from []. Why: one body-index miss
   * caused four spurious re-dispatches
   */
```

### GitHub.creditedByCommitTrailer

Removed from lines 282-287.

```
  /**
   * W1-T2387 — DOES THE COMMIT SURFACE CARRY THIS TASK'S ANCHORED TRAILER FOR THIS PR? The SECOND anchored
   * surface, read off the SAME memoised index. NOT A RELAXATION of {@link creditsByAnchoredTrailer}: the index
   * extracts an exact anchored line and refuses every token the run-id grammar rejects, and every other W1-T20c
   * property applies unchanged. FAILS CLOSED — an unbuildable index reads FALSE, never "credited".
   */
```

### GitHub.changedFiles

Removed from lines 289-294.

```
  /**
   * The PR's changed-file paths, or `undefined` when unresolvable. Backs rung (c)'s PLAN-ONLY refusal
   * (W1-T413). `undefined` MEANS UNAVAILABLE AND KEEPS TODAY'S ANSWER, never "no files": an absent head cannot
   * be evidence FOR a credit, whereas WITHDRAWING one would re-dispatch finished work. So the head fails closed
   * and the file list fails open.
   */
```

### GitHub.readTruncated

Removed from lines 316-320.

```
  /** True if the most recent read SUCCEEDED but only PARTIALLY, hitting {@link BOARD_MAX_PAGES} (W1-T415). A
   *  THIRD accessor, because a FAILED fetch and a PARTIAL one are different facts and collapsing them recreates
   *  the conflation W1-T119 prevents. Truncation can only OMIT rows, so a credit stays sound and only "no
   *  evidence" is unsound — hence the deferral sits in the same arm as `readFailed()`, never upstream of a
   *  credit. */
```

### GitHub.resetFailureFlags

Removed from lines 322-327.

```
  /** R-24 (docs/audits/recon-2026-09-05.md): DROP THE FAILURE VERDICTS LEFT BY EARLIER ATTEMPTS, AND NOTHING
   *  ELSE — the seam that lets a gateway live a whole daemon or drain lifetime, since its delta cache and its
   *  verdicts want opposite lifetimes. THE TRAP: a FAILED fetch replaces its half with an EMPTY one and stamps
   *  it (the W1-T181 pairing), and those rows are only safe read alongside `readFailed()`, so a half is dropped
   *  exactly when its verdict is. The delta caches are NOT touched. Why: the measured cold-walk cost is in
   *  docs/forensics/status.md */
```

### GitHub.reviewState

Removed from lines 342-351.

```
  /**
   * W1-T914: the `remudero-review` commit-status state for `prUrl`'s CURRENT head, three-valued plus `"none"` —
   * the SAME vocabulary lib/review.ts posts, off the combined-status endpoint open-prs-rest.ts documents, never
   * a second call.
   *
   * FOUR ANSWERS THAT MUST NOT COLLAPSE: `"none"` means the read succeeded and found no entry;
   * `"not-applicable"` (W1-T2235) is a MERGED or CLOSED row, answered with no call at all; and `undefined`
   * means the read could not be trusted, NEVER collapsed into `"none"` — a caller that cannot tell them apart
   * would render an outage as a fact about the PR.
   */
```

### saveCreditStore

Removed from lines 514-518.

```
/**
 * Writes the durable store ATOMICALLY — temp file plus rename, the SAME pattern the status.json write uses, so
 * a reader mid-write never sees a torn store. BEST-EFFORT: a write failure is swallowed, because the projection
 * that found this credit is already correct, and the next write catches up.
 */
```

### LedgerLines

Removed from lines 567-572.

```
/**
 * {@link readLedgerLines}' return type: a plain array for every existing consumer, so it stays structurally
 * assignable with zero call-site churn, PLUS a `torn` count as a NON-ENUMERABLE own property (W1-T206) —
 * non-enumerable so `assert.deepEqual` against a plain array literal keeps working, exactly like a real array's
 * own `.length`. A consumer reads it by direct access.
 */
```

### STATUS_BOARD_MAX_ROTATIONS

Removed from lines 595-601.

```
/** Default NDJSON ledger reader: one JSON object per non-blank line, read through the injected fs and
 *  never copied first. A torn line is LOUD in TWO ways (W1-T206) — logged to stderr for a human, and
 *  counted into `.torn` for a consumer with no stderr to watch, where the old fabricated-`{}`
 *  behaviour let neither audience tell. */
/** How many dated rotations {@link readLedgerUnionBounded} opens, newest first. MEASURED: the live
 *  file plus the NINE newest held a row of every step the board reads, for 0.23s against 7.74s for the
 *  full union. 24 is that 9 with headroom, and all 24 cost 0.21s. */
```

### CREDIT_SCAN_MAX_ROTATIONS

Removed from lines 604-610.

```
/**
 * How many rotations {@link readMergeCreditedTaskIds} may open before giving up on a task. THE CAP IS SAFE IN
 * THE DIRECTION THAT MATTERS: this reader only ADDS ids it has seen, so it cannot invent a credit. Reading too
 * shallow degrades to today's behaviour — the task is re-credited — and can never strand real work, so
 * under-read is self-correcting while over-report is unreachable. Why: all 445 ever-credited ids resolve within
 * 24 files — docs/forensics/status.md
 */
```

### readMergeCreditedTaskIds

Removed from lines 613-623.

```
/**
 * Every task id the ledger has EVER recorded merge credit for, across all three ledger forms, newest-first,
 * stopping as soon as every candidate resolves.
 *
 * WHY THIS EXISTS. The backfill asked its question against {@link readLedgerLines}, WHICH OPENS EXACTLY ONE
 * FILE, on the belief that registering both credit steps meant rotation could not drop them. THAT BELIEF IS
 * FALSE and is what hid the defect: registration stops a step being shed COMPLETELY but says nothing about the
 * per-step row cap, so older credit leaves the live file, the task is re-credited, and the fresh row evicts
 * another — self-sustaining. Why: a Set rather than the lines, the shared rotation helper, and the exact
 * arithmetic — docs/forensics/status.md
 */
```

### LedgerReadIntent

Removed from lines 792-796.

```
/**
 * The two ways a `readLedgerLines` call can be answered, and the only two a caller may declare. Neither value
 * changes the return — declaring `"union"` does not make a bare call read rotations, the call site must do that
 * too. This only makes the CHOICE visible (W1-T1262).
 */
```

### LedgerReadIntentViolation

Removed from lines 799-802.

```
/**
 * One undeclared {@link readLedgerLines} call site, named — file and line — never folded into a
 * bare count (W1-T1262's fourth acceptance claim: "the check names the offending reader").
 */
```

### LedgerTailCache

Removed from lines 860-864.

```
/**
 * Persistent state a {@link readLedgerTail} caller holds ACROSS calls — one per long-lived route, never rebuilt
 * per render. `lines` is the SAME array reference every call and only ever appended to, so a caller may hold a
 * prior return value across calls and it stays valid.
 */
```

### readLedgerTail

Removed from lines 882-886.

```
/** INCREMENTAL ledger read (W1-T184): only the bytes appended since the cache's last read are parsed, so an
 *  UNCHANGED file costs one `statSync`. The fix for {@link readLedgerLines} being a full re-read — fine for
 *  one-shot CLI callers, wrong for a route polled every ~250ms. A file SHORTER than last observed degrades
 *  safely by rescanning from byte 0. Why: a console refresh degraded into an O(history) operation, behind the
 *  2026-07-20 latency outage */
```

### prNumberFromRef

Removed from lines 939-944.

```
/**
 * Parse a PR number off the END of a ref or url (W1-T130) — pure text parsing, never a gateway call. Backs ONLY
 * the correction rung's decoration: a correction's url is trusted TEXT, never re-resolved (see the SUPREME
 * OFFLINE note), so there is no `PrRef` to read `.number` off. Undefined when the string does not end in
 * digits, which degrades the decoration, never the verdict.
 */
```

### LedgerIndex

Removed from lines 964-973.

```
/**
 * ONE PASS OVER THE LEDGER, SHARED BY EVERY PER-TASK HELPER (R-23). The ledger is already read once (W1-T187),
 * but each of the ten helpers then walks that whole array once per task.
 *
 * BUCKETED ON THE TWO ID FIELDS, NOT ONE: nine helpers filter on `task_id` but one filters on `task`, so a
 * single-field bucket would silently drop its rows. Each helper re-filters its own bucket, so the bucket need
 * only be a SUPERSET in ledger order — which makes the substitution an identity, and an index that has drifted
 * falls back to a full scan, costing time and never an answer. Why: 776 ms per projection at 1,393 tasks x
 * 29,567 rows
 */
```

### DEFAULT_MAX_TASK_DISPATCHES

Removed from lines 1097-1102.

```
/**
 * PER-TASK DISPATCH CIRCUIT BREAKER (MASTER-PLAN P29(ii)) — policy-as-data, never a literal buried in a caller:
 * how many times the SAME task may be dispatched with no NEW owned PR since. §9's per-WORKER tripwire's
 * per-TASK dual, and the BACKSTOP that makes P29(i)'s fix safe to get wrong. Why: the W1-T1 storm ran ~130
 * dispatches / ~$130 / ~10h with no single RUN running away
 */
```

### isMergeCreditLine

Removed from lines 1105-1113.

```
/**
 * Does this ledger line record a MERGE CREDIT for its task? ONE DEFINITION, TWO CONSUMERS, DELIBERATELY: the
 * defect it was extracted for is two mechanisms holding the same fact and never comparing notes.
 *
 * CORRECTED 2026-08-13 — this comment used to conclude "so rotation cannot drop either out from under a
 * reader", AND THAT WAS FALSE. It is the belief that hid a live defect for months, so it is corrected rather
 * than deleted: registration stops a step being shed COMPLETELY and says nothing about the per-step row cap.
 * "Was this EVER credited" needs {@link readMergeCreditedTaskIds}.
 */
```

### seedCountFromCircuitBreak

Removed from lines 1118-1130.

```
/**
 * W1-T2425 — THE PRIOR COUNT THIS PROCESS DID NOT LIVE THROUGH. The breaker's regression guard can only refuse
 * what it can COMPARE against, and its prior lives in an in-memory Map rebuilt PER INVOCATION, so a rotation
 * plus a daemon RESTART was never covered: a new process starts with nothing to compare and reads a shortened
 * live file as forward progress. The evidence was already written and simply not kept — the refusal row carries
 * the exact count needed.
 *
 * TWO KEYS, DELIBERATELY: the reset lines key on `task_id`, but a refusal row is written by the DAEMON and
 * carries the refused task elsewhere, so reading one field for both would seed nothing — a zero that looks like
 * "never tripped". The step literal is INLINE on purpose: the rotation test scans consumer sources TEXTUALLY,
 * comments included, so a symbol would blind that gate and spelling the comparison out would mint a phantom
 * step. Why: W1-T1279 was refused every tick for 84 hours, then a restart let a fresh process dispatch
 */
```

### PRE_WORKER_REFUSAL_VERDICTS

Removed from lines 1153-1169.

```
/**
 * How many `run.start` lines exist for `taskId` SINCE its most recent FORWARD-PROGRESS line — P29(ii)'s
 * "dispatches with no NEW owned PR".
 *
 * WHY FORWARD PROGRESS IS NOT JUST `pr.opened`. That line was a sound PROXY, logged only after a worker pushes
 * its own run branch. THE BRANCH CONVENTION BROKE IT: a PR on a slug-named branch fails `ownsBranch`, so no
 * line is written and the task reads as MERGED to the backfill and as MAKING NO PROGRESS here at once. So a
 * merge resets the streak too ({@link isMergeCreditLine}) — RESTORING the stated intent, not widening it. A
 * fresh PR resets the count even if it never merges; a "succeeds every time" loop is {@link dispatchesEver}'s
 * remit. Why: two tasks both shipped yet ran to 5 dispatches each — docs/forensics/status.md / /** W1-T2423 —
 * THE RUN VERDICTS THAT MEAN THE TASK WORKER NEVER STARTED. Both are PREFLIGHT PROBES that refuse ahead of
 * every worker and FAIL CLOSED, so a run ending in either tested THE HOST, not the task. W1-T2249 IS SUBSUMED,
 * NOT RE-LITIGATED: it keyed the exclusion on a field stamped at WRITE time, making the rule FORWARD-ONLY over
 * a counter that reads history backwards, which is why it never fired. WHY A VERDICT AND NOT A CHECK: `verdict`
 * is written by the same call that has recorded these refusals all along, so the rule reads correctly over rows
 * already on disk. Why: the measured verdict distribution is in docs/forensics/status.md
 */
```

### isDispatchBreakerTripped

Removed from lines 1210-1215.

```
/**
 * True once `taskId` has been dispatched {@link DEFAULT_MAX_TASK_DISPATCHES} times with no new owned PR since —
 * the caller must dispatch nothing further and escalate exactly once (P29(ii)). Re-derived FRESH from the
 * ledger every call, so unlike an in-memory flip it PERSISTS across restarts, which is what the W1-T1 storm
 * needed: it spanned many invocations.
 */
```

### dispatchesEver

Removed from lines 1225-1230.

```
/**
 * SIBLING LIFETIME DISPATCH COUNTER (W1-T271). The streak counter resets on every `pr.opened` — correct for the
 * failure IT guards, but BLIND BY CONSTRUCTION to a task that re-dispatches forever while merging a genuine
 * no-op PR each time. This counts EVERY `run.start` and no step resets it. Why: W1-T254 dispatched five times
 * in eighty minutes, each merge resetting the streak counter
 */
```

### DEFAULT_MAX_TASK_LIFETIME_DISPATCHES

Removed from lines 1243-1248.

```
/**
 * THE THRESHOLD IS A MEASUREMENT, NOT A GUESS (W1-T271), from the unioned ledger's real per-task distribution:
 * 274 of 282 ever-dispatched tasks (97%) were dispatched 1-4 times ever, and every count at or above 5 is a
 * documented FAILURE. 10 sits above the ENTIRE legitimate population while cutting off short of the two genuine
 * storm magnitudes. Why: the corpus and per-task counts are in docs/forensics/status.md
 */
```

### DispatchBreakerCache

Removed from lines 1263-1269.

```
/**
 * Per-process, cross-tick memory {@link evaluateDispatchBreaker} uses to notice an impossible regression
 * (W1-T206): a task's count dropping without the `pr.opened` line that would explain it. SCOPE NOTE: in-memory
 * only, so a RESTART starts with an empty baseline; {@link isDispatchBreakerTripped} covers the cross-restart
 * case, and this adds the narrower "caught it happening under a live process" guarantee a pure re-derive cannot
 * give.
 */
```

### DispatchBreakerState

Removed from lines 1280-1287.

```
/**
 * Tri-state read of the dispatch breaker (W1-T206). `"indeterminate"` fires instead of a false
 * `"clear"` in the two cases where trusting a fresh count would be trusting an ABSENCE as proof rather
 * than as missing information: the ledger file is gone after this cache has seen a nonzero count, or
 * the fresh count is LOWER with no `pr.opened` line to explain the drop. The caller must treat it as
 * skip-this-tick, never escalate on it alone, and never fold it into the escalate-now predicate.
 */
/** One dispatch-breaker outcome. */
```

### evaluateDispatchBreakerCorroborated

Removed from lines 1398-1403.

```
/**
 * W1-T414: {@link evaluateDispatchBreaker}, CORROBORATED by GitHub's own view of open PRs before a `"tripped"`
 * verdict is handed back. ONLY `"tripped"` is reconsidered, and only in ONE direction: a corroborating branch
 * downgrades it, exactly as a local `pr.opened` would. UNREADABLE FALLS BACK TO THE LOCAL COUNT — this can only
 * relax a trip, never add one.
 */
```

### taskIdFromRunBranch

Removed from lines 1491-1496.

```
/**
 * Extract the task id a fleet-dispatched run branch claims, or `undefined`. The ONE named extractor for a shape
 * tested three other ways: {@link ownsBranch} VERIFIES a known id and cannot discover one, and run-task.ts's
 * predicate is a boolean shape test with no capture group. W1-T453 lifted it out of {@link projectPlan}, where
 * it was inlined TWICE, so every caller shares one spelling.
 */
```

### taskIdFromSlugBranch

Removed from lines 1502-1510.

```
/**
 * Extract the task id a SLUG branch declares in its own name — the shape {@link taskIdFromRunBranch} cannot
 * read, having no `run-` prefix (W1-T2629). PURE: the caller decides whether the id is credited.
 *
 * TRAP 1, REUSED RATHER THAN REINVENTED. A bare prefix match would let `W1-T15` credit from a `W1-T152` branch.
 * Here the candidates are the whole plan to SEARCH, so normalisation DELETES the hyphen boundary and one check
 * replaces it: a candidate matches at the START of the normalised head AND the next character is NOT A DIGIT.
 * LONGEST MATCH WINS, since the candidates are unordered.
 */
```

### planBranchReap

Removed from lines 1631-1642.

```
/**
 * Classify remote branches for a DRY-RUN reap. PURE: no git, no network, no deletion.
 *
 * PROTECTION IS EVALUATED FIRST AND WINS OUTRIGHT, and that ordering is the whole safety argument: a landing
 * branch can be simultaneously a MERGED PR head, which the delete rule matches, AND a live code constant, so
 * the other order would delete a branch its own source names.
 *
 * DELETABLE IS THREE DISJUNCTS and the third needs no trust: a merged head, a closed-unmerged head, or no PR
 * with a tip already in main. `"unknown"` NEVER SATISFIES ONE. `undeclaredGuards` IS AN ALARM, NOT A RESULT,
 * since a declared list rots and a name grep cannot see a variable reference. Why: `heartbeat` and the
 * ephemeral landing branches — docs/forensics/status.md
 */
```

### AdjudicationCitation

Removed from lines 1726-1731.

```
/**
 * A CITATION FOR ONE ADJUDICATION VERDICT (W1-T2247) — the residue `planBranchReap` could not resolve
 * mechanically. "Still needed" is a judgement, and a judgement without a falsifier is a guess: a citation names
 * EITHER a plan task id the change would serve OR a symbol and path in the CURRENT tree, both re-checkable by a
 * grep WITHOUT re-running whatever produced the verdict.
 */
```

### admitAdjudicationVerdict

Removed from lines 1751-1756.

```
/**
 * THE VERDICT CARRIES ITS CITATION OR IT IS REFUSED (W1-T2247) — refused outright, never downgraded or accepted
 * with a caveat, because an accepted guess is indistinguishable from a checked answer downstream. PURE: it only
 * checks that a citation is PRESENT and non-empty, leaving the walk of the plan and tree to the caller, so a
 * wrong verdict is caught by a grep rather than by trust.
 */
```

### isOwnedSlugBranch

Removed from lines 1779-1787.

```
/**
 * The SLUG run-branch form — the task's own branch under a descriptive name rather than a timestamp. Third
 * accepted claim form: the old rule refused merged, correctly-trailered PRs whose branches "lacked only the
 * `-<epochMs>` suffix", so such a PR was judged to claim a DIFFERENT task and vetoed its own credit
 * permanently, since a merged PR's head never changes.
 *
 * THE TRAILING `-` IS THE ENTIRE PREFIX-COLLISION GUARD (TRAP 1). KEPT OUT OF `ownsBranch`: widening that would
 * reach the corroboration rungs and grant credit the ruling deliberately refused.
 */
```

### branchClaimsOtherTask

Removed from lines 1792-1800.

```
/**
 * RUNG (c) FOREIGN-BRANCH VETO (operator ruling 2026-07-30). `true` iff `head` is a run-branch claiming a
 * DIFFERENT task — that, and ONLY that, still vetoes a trailer credit, since a branch carrying no task claim
 * vetoes nothing.
 *
 * PREFIX COLLISION (TRAP 1) is held off by the BOUNDARY CHARACTER, not by avoiding prefix matching. An earlier
 * revision said collision was "structurally impossible here because this function never PREFIX-matches an id";
 * {@link isOwnedSlugBranch} does, and the required hyphen is what makes it safe.
 */
```

### creditsByAnchoredTrailer

Removed from lines 1807-1815.

```
/**
 * RUNG (c) ACCEPT TEST — the operator's 2026-07-30 ruling, implemented verbatim: an exactly-anchored trailer on
 * a MERGED PR is sufficient evidence, and the head-branch NAME may no longer veto it, WITH a guard that a
 * branch clearly belonging to a different task can never credit.
 *
 * TRAP 2 — NO NON-MERGED CREDIT PATH: `state` is asserted MERGED **here**, from the PrRef, not trusted from a
 * method name a fixture may implement with any state. Why: the old assert refused seven merged,
 * correctly-trailered PRs — docs/forensics/status.md
 */
```

### creditsByAnchoredTrailer — the unreadable head

Removed from lines 1835-1838.

```
  // UNREADABLE HEAD FAILS CLOSED (W1-T119, unchanged by the ruling). An ABSENT head ref is a
  // read that FAILED, not a branch that carries no claim — and an errored read is never
  // conflated with evidence. The ruling removed the veto power of a branch NAME we can SEE;
  // it did not make an unreadable one creditable.
```

### orphaned rung-(c) docs, moved to their symbols

Removed from lines 1843-1856.

```
/**
 * RUNG (c) ANCHORED-TRAILER VERIFY (P16 / W1-T69): the merged-trailer search is a fuzzy full-text body
 * search, capable of matching a PR whose trailer names a DIFFERENT, prefix-sharing id — the "W1-T20c
 * false-credit" class this rung ratifies. That hit is a first pass; this is the authoritative check.
 */
/**
 * RUNG (c) PLAN-ONLY REFUSAL (W1-T413): true iff `files` is non-empty and EVERY path is in plan scope
 * ({@link isInPlanScope}, CALLED rather than re-derived) — such a PR filed or closed a task, it did not
 * build one. EMPTY IS FALSE, deliberately: an empty list is what an unreadable read looks like, and
 * "every element of nothing is in plan scope" is the vacuous pass this repo keeps re-learning.
 * DELETIONS COUNT (the #1465 lesson).
 */
/** `findMergedByTrailerAll`'s fetch bound (W1-T441). The measured worst case is six; this leaves an
 *  order of magnitude of headroom without becoming an unbounded list. */
```

### preferImplementingPr

Removed from lines 1867-1875.

```
/**
 * Prefer the merged PR that IMPLEMENTED `taskId` over a later bookkeeping close (W1-T441). ONE LAYER, AND
 * NEWEST-WINS SURVIVES AS THE FALLBACK, so this can only NARROW. A candidate whose files cannot be read is
 * KEPT: unreadable is missing information, not evidence.
 *
 * A SECOND LAYER (prefer a candidate touching `src/`) WAS BUILT, MEASURED AND REMOVED: it changes the chosen PR
 * in ZERO of the 16 multi-hit ids, and the falsifier that should have caught its removal stayed green — which
 * is how it was found. Why: this isolates 8 of the 16, including 5/5 generators
 */
```

### ownsOwnRunBranch

Removed from lines 1892-1896.

```
/**
 * Is `head` this task's OWN run branch, in any of the three accepted forms? A free, in-hand test that lets rung
 * (c) credit a worker's own PR without ever reading its file list — the pre-filter that keeps {@link
 * isPlanOnlyChangeset}'s read off the hot path.
 */
```

### RunBranchClaimGapKind

Removed from lines 1909-1914.

```
/**
 * W1-T2429 — which shape of run-branch-claim gap {@link runBranchClaimGap} found. `"merged-untraced"`: the PR
 * MERGED and its trailer already credited the task (the merge itself was NEVER broken), but its head was never
 * an accepted claim form, so the gap leaves no trace today. `"open-unattributable"`: still OPEN on an
 * unaccepted head, so no `pr.opened` line is written and a second dispatch stays admissible until it merges.
 */
```

### runBranchClaimGap

Removed from lines 1926-1934.

```
/**
 * W1-T2429 — DETECTION, AND NOTHING ELSE (rationale §5). Does `pr` carry `taskId`'s anchored trailer on a head
 * branch that claims the task in NONE of the three accepted forms?
 *
 * A PLAN FILING NAMES NOTHING (acceptance 3): {@link hasAnchoredTrailer} is the FIRST gate, so a filing returns
 * `undefined` before the head is inspected. OWNERSHIP IS RE-USED, NEVER RE-DERIVED (acceptance 4). A MERGED PR
 * IS STILL CREDITED (acceptance 1 REPORTS, never DENIES). PURE (acceptance 6), and NEVER CONSULTED BY DISPATCH
 * (acceptance 5).
 */
```

### derivePrPrecedence

Removed from lines 1962-1967.

```
/**
 * Derive one task's PR-precedence merge-state from GitHub (the correction/ledger/
 * pr-field/trailer rungs), in the fixed precedence — the logic `deriveStatus` carried
 * before W1-T155. Takes the ledger already read (its caller reads it once and reuses
 * it for the taxonomy layering below, rather than re-reading the file a second time).
 */
```

### derivePrPrecedence — the correction rung

Removed from lines 1969-1976.

```
  // SUPREMACY (MASTER-PLAN P9 / W1-T75): an operator correction is checked FIRST, above rungs (a)/(b)/(c). It
  // is DECLARED credit, not INFERRED evidence, so it is deliberately EXEMPT from the ownership-assert, which
  // guards the fuzzy search and not a human declaration.
  //
  // SUPREME OFFLINE (W1-T130): `applyCorrection` already resolved the ref through a real gateway call at WRITE
  // time, so re-resolving buys nothing and puts a gateway call back on the dispatch hot path. No read result
  // may demote a correction-credited task, so this returns BEFORE any `deps.github` call. Why: under quota
  // exhaustion this rung re-dispatched an already satisfied task — docs/forensics/status.md
```

### derivePrPrecedence — rung (b2)

Removed from lines 2034-2038.

```
  // (b2) LEDGER-RECORDED MANUAL COMPLETION (W1-T1029) — the same hand-execution rung as (b), widened to
  // the two shapes a `pr:` number cannot express: a PR in ANOTHER repository, and a completion with NO
  // PR because none will ever exist. DECLARED credit, never re-verified, for the correction rung's
  // reason: there is no live read this rung COULD perform. Checked BEFORE (a)/(b), since a human's
  // recorded assertion outweighs an in-flight row, and reversible by a correction checked above it.
```

### derivePrPrecedence — rung (b)

Removed from lines 2068-2073.

```
  // (b) explicit `pr:` field — W1-T116: ALWAYS consulted, even when (a) captured a non-merged result.
  // THE INVARIANT: an open-PR ledger claim is the WEAKEST evidence in the system and must never outrank
  // a VERIFIED-MERGED credit found anywhere else. A non-merged (b) result still never displaces an
  // existing one, keeping the original dedup behaviour.
  // Why: a merged `pr: 2` sat beside an open row from a later dispatch, (b) was skipped outright, and
  // the task stayed "running" forever and re-dispatched
```

### derivePrPrecedence — rungs (c) and (c2)

Removed from lines 2083-2091.

```
  // (c) a merged PR carrying the anchored `Remudero-Task:` trailer — ownership-asserted and
  // correction-aware (P16 / W1-T69). deriveStatus GATES DISPATCH, so a false credit makes the daemon
  // BUILD against an unmet dep. SIBLING CREDIT (P29(i)): reached even when (a)/(b) captured a
  // non-merged result, with the ownership assert UNCHANGED, so a foreign PR still fails.
  //
  // (c2) HEAD-BRANCH CORROBORATION (W1-T256): rung (c) reads the eventually-consistent BODY index, where
  // an exit-0 EMPTY result is INDETERMINATE rather than "not merged", so corroborate deterministically
  // by head branch and RE-ASSERT ownership. null on FAILURE and [] on a genuine miss keep the two apart.
  // Why: one body-index miss caused four spurious 07-24 re-dispatches
```

### derivePrPrecedence — rung (c3) on the rejection path

Removed from lines 2178-2181.

```
      // (c3) here too — this early return is a SECOND exit that concludes `source: "none"`, and a
      // task whose only trailer hit was foreign or unanchored is exactly as dispatchable-looking
      // as one with no hit at all. Leaving the rung out of this branch would close the gap on one
      // path and leave it open on the other.
```

### LANE_TERMINAL_STEPS

Removed from lines 2303-2308.

```
/**
 * Every REAL ledger step that CLOSES an in-flight run — deliberately NOT symmetric with {@link
 * LANE_START_STEPS} (W1-T282: "the close side is not uniform and must not be pretended uniform"). The retro and
 * triage lanes have only an error terminal, since a SUCCESSFUL run of either logs none, so their close relies
 * on the liveness bound rather than a fabricated step with no writer.
 */
```

### deriveRunState — why the step is read into a bare local

Removed from lines 2340-2345.

```
    // Read into a bare local BEFORE the typeof guard, never inline off the property access: the rotation test's
    // consumer scan greps every consumer file's raw TEXT, comments included, for a property-access equality
    // check quoting a literal, and is not fussy about WHICH literal follows — an inline guard here once had its
    // OWN type-guard literal mistaken for a decision-relevant step name. Same reason the lane tables are
    // Set-membership checks rather than case labels: this function's reads are display-only and must not be
    // harvested.
```

### latestEscalationLine

Removed from lines 2394-2399.

```
/**
 * The task's most recent escalation line, IF `escalation.issue_opened` is the LATEST signal among it and a
 * redispatch (W1-T155). DELIBERATELY DOES NOT ANSWER "is the escalation still open": the ledger is append-only,
 * so it can say one WAS opened but never that it has since closed — that needs the live join in {@link
 * resolveEscalation}. An absent url never suppresses the escalation, only the join.
 */
```

### resolveEscalation

Removed from lines 2435-2440.

```
/**
 * JOIN LIVE STATE, DO NOT PATCH THE HISTORY SCAN (W1-T182). Returns `undefined` ONLY when the issue is
 * CONFIRMED closed; every other outcome FAILS CLOSED, keeping the row and marking it unverified, because hiding
 * a possibly-open escalation is the more dangerous direction — the inverse of W1-T181's fail-direction, and the
 * two must never be unified behind one "unreadable" policy.
 */
```

### deriveStatus — verify: human

Removed from lines 2572-2580.

```
  // W1-T507: the OTHER reason a row needs a person — a task filed `verify: human`. Three call sites treat that
  // as an EXCLUSION from machine attention and nothing else, so nothing before this point tells a person such a
  // task is theirs.
  //
  // COMPUTED HERE, deliberately NOT at the projectPlan level: this is a pure function of `task` plus this
  // call's own resolved state, which keeps every caller DERIVATION-EQUIVALENT. `merged` is always false here,
  // so only `indeterminate` needs checking — flagging off an unread state is the fail-open direction W1-T119
  // prevents. DELIBERATELY A DIFFERENT FIELD FROM `needsHuman`, which backs an affordance such a task never
  // has.
```

### W1-T485 — section header

Removed from lines 2607-2613.

```
// ── W1-T485: SUBSTANCE THAT SHIPPED UNDER ANOTHER TASK'S TRAILER ─────────────────────────────
// THE GAP THIS FILLS: W1-T458's `unresolved_task_scope` advisory fires when a merging diff resolves NO
// task, so it answers "no task at all" and cannot answer "the WRONG task".
//
// A REPORT, NEVER A GATE. A merge-time refusal keyed on a trailer mismatch would fire on every FILING,
// since filings must omit the trailer (#1527), and a bound that fires on a healthy condition gets muted.
// Why: a PR merged carrying one task's trailer while shipping another's — docs/forensics/status.md
```

### proofGrepTargets

Removed from lines 2642-2653.

```
/**
 * A task's proof-derived symbols paired with every path the task declared.
 *
 * W1-T506 WIDENED THIS FROM `grep:`-ONLY, which was dialect-gated and getting worse as convention moves proofs
 * to `unit test:`, whose body carries a TITLE and never a path. The fix stops asking the proof BODY for a path
 * at all: `files:` supplies one for EVERY task.
 *
 * WHY THE PROOF TEXT AND NOT THE FILE PATH ALONE: the cheap predicate was measured and REJECTED, since a task
 * naming a busy file is flagged by a file that moves daily, while a proof pattern is forced by the linter to be
 * distinctive enough to match its own subject. Why: both motivating cases were all-`unit test:` and invisible
 * to the old predicate
 */
```

### buildCommitTrailerIndex

Removed from lines 2758-2773.

```
/**
 * W1-T2387 — THE SECOND TRAILER SURFACE, AS AN INDEX. The commit trailer is MACHINE-written while the PR-body
 * trailer is HAND-written, and the merged search read only the hand-written one.
 *
 * A UNION, NEVER A COMPARISON: consulted only AFTER the body surface answers EMPTY, so it can only ADD credit
 * and has no refuse-a-merge failure mode. NO NEW FETCH — an already-local `git log`, MEASURED at 32 ms for 3.6
 * MB. `null` on a failed read, never [].
 *
 * ⚠ THE WHOLE SURFACE DEPENDS ON A REPO SETTING THIS FILE OTHERWISE NEVER NAMES (W1-T2447):
 * `squash_merge_commit_message`, an admin-only UI toggle with no commit, review or ledger row. MEASURED as
 * `COMMIT_MESSAGES` here, which is the ONLY reason the amended trailer survives the squash. The other legal
 * value, `PR_BODY`, discards the branch commits entirely, and flipping to it does not break this function:
 * every FUTURE squash simply stops carrying a trailer, so the index quietly stops growing while looking exactly
 * as healthy as it does today. Pinned by `test/commit-trailer-surface-squash-setting.test.ts`. Why: 16 merged
 * PRs carried the trailer in the commit and not the body — docs/forensics/status.md
 */
```

### buildCommitTrailerIndex — the foreign-checkout guard

Removed from lines 2796-2801.

```
    // THE CHECKOUT MUST BE THIS GATEWAY'S OWN REPO, AND THIS IS NOT DEFENSIVE TIDINESS — IT IS A DEFECT THIS
    // TASK SHIPPED ONCE AND CAUGHT. A gateway is constructed for an explicit owner and repo, but `git log`
    // reads whatever checkout the PROCESS sits in, and the first draft consulted it unconditionally, turning
    // two suites red: a fixture asking about one repo was answered from another's history. A local commit
    // surface is evidence about the LOCAL repo and no other. AN EMPTY MAP, NOT `null`: a foreign checkout is a
    // genuine ABSENCE, not a failed read (W1-T119).
```

### RequiredContextsRead

Removed from lines 3026-3033.

```
/**
 * Read a repo's REQUIRED status-check contexts straight from GitHub branch protection (W1-T103, the #170
 * stuck-ambiguous fix) — the authoritative list the sweep gates on, read ONCE per repo and branch. Fails SOFT
 * to `undefined` on ANY error. / /** W1-T2399 — THE THREE READINGS THAT USED TO COLLAPSE INTO ONE `undefined`:
 * no required contexts, an empty list, and a read that FAILED OUTRIGHT. The caller sets one boolean from it, so
 * a repo-wide outage was reported as a claim about the PR's own checks. The same split W1-T2370 made between
 * `unverifiable` and `refuted`. FAIL-SOFT IS UNCHANGED (W1-T176 (ii) is NOT reopened).
 */
```

### ghGateway.findMergedByHeadBranch

Removed from lines 3239-3243.

```
      // Merged PRs whose HEAD BRANCH matches this task's run prefix (W1-T256). That qualifier is STRUCTURED —
      // the branch name, NOT the body index rung (c) depends on and that a single eventually-consistent miss
      // emptied. Fuzzy, since a prefix can over-match, so the head ref rides along and the caller re-asserts
      // ownership. REST's search result carries no head field, being an Issue shape, so each bounded hit pays
      // one more read to recover it.
```

### ghGateway.changedFiles

Removed from lines 3281-3283.

```
      // W1-T413. Mirrors the batched gateway's own changed-files read: the files endpoint has no
      // field-selection story, so filenames come straight off `--jq`. null on a failure is the UNAVAILABLE
      // signal the caller keeps today's answer for.
```

### buildBatchedGithub — doc moved onto the function

Removed from lines 3356-3369.

```
/**
 * A GitHub gateway that answers ALL of {@link GitHub}'s methods from ONE batched fetch of the repo's PRs, held
 * in memory with a short TTL, instead of one subprocess PER call.
 *
 * WHY: {@link ghGateway}'s trailer search runs one search PER task, so `projectPlan` over an N-task plan makes
 * O(N) sequential subprocesses — at 183 tasks, ~74s, and the browser hangs at "loading…". Its trailer search
 * matches the ANCHORED line rather than a fuzzy substring, so `W1-T1` never mis-selects a `W1-T15` PR.
 *
 * W1-T181: a THROWING fetch was the deep defect, since the pre-fix catch converted "I could not read GitHub"
 * into "GitHub says there are zero PRs". The catch now wraps `fetchAll` itself, so an INJECTED implementation
 * that throws is classified like a real failure, and the flags back `readFailed()`, consulted BEFORE trusting
 * an empty result. Why: ENOBUFS carries no stderr, so it classified "unknown" and the outage ran for hours in
 * silence
 */
```

### defaultGhCallPacer

Removed from lines 3376-3384.

```
/**
 * W1-T1005: the process-lifetime {@link GhCallPacer} every gateway shares when its caller omits `opts.pacer`.
 * Module scope, not function scope, is what makes "shared" true — a pacer built per construction would give
 * each gateway its own gap state, which is the defect under a new name.
 *
 * ITS BLOCKING WAIT IS REAL EVERYWHERE EXCEPT UNDER THE NODE TEST RUNNER: as a module singleton with a 1,500ms
 * gap, every unpaced gateway in a test file blocks on the SAME real clock — measured on test/status.test.ts
 * alone, 1.3s before this existed and 64.4s with a plain default.
 */
```

### resetDefaultGhCallPacerForTest

Removed from lines 3387-3392.

```
/**
 * TEST-ONLY (W1-T1005). Installs or clears the module-scoped {@link defaultGhCallPacer} so test/status.test.ts
 * can prove the DEFAULT is shared and overridable without depending on load order across that file's other ~140
 * tests, many of which would otherwise be the ones that lazily create — and thereby pin — the real default
 * first. No production path calls this.
 */
```

### BOARD_PREWARM_WORKER_KIND

Removed from lines 3397-3407.

```
// ── W1-T2440 — THE PRE-WARM'S WALK, OFF THE REQUEST-SERVING THREAD ──────────────────────────
// `GitHub.warm?(): void` is fire-and-forget and cannot be awaited, since the signature returns `void`.
// Before this task it called the two index builders DIRECTLY, and both walk the same synchronous call
// {@link GH_CALL_TIMEOUT_MS} names as parking the whole process: a COLD walk is 18-22s, so a request
// arriving during it queued behind a refresh it never asked for. Widening the signature to a promise
// reaches every implementer and caller, which this task does not own.
//
// SO THE WALK MOVES TO A SEPARATE OS THREAD INSTEAD OF A DIFFERENT CALL SHAPE, reusing the same exported
// fetch helpers UNCHANGED, so there is no second walk mechanism to drift — only a second THREAD running
// the first one. THIS FILE IS LOADED TWICE, with `isMainThread`/`workerData` gating the branch. SCOPED
// TO THE REAL DEFAULT: `workerData` is structured-cloned, so an injected exec keeps the sync path.
```

### postPrewarmWorkerResponse

Removed from lines 3504-3511.

```
/**
 * THE WORKER BRANCH's whole body, as a named function rather than an inline statement.
 *
 * EXTRACTED FOR COVERAGE, AND THE EXEMPTION ROUTE IS CLOSED BY DESIGN: Node's coverage instruments the PARENT
 * only, so a statement running solely inside a spawned `Worker` records zero hits, and the diff-coverage script
 * refuses the process-boundary directive unless the declaration is re-exec or exit glue. So the line earns real
 * coverage instead. The guard below stays a ONE-LINE `if` on purpose.
 */
```

### buildBatchedGithub.mergedTtlMs

Removed from lines 3553-3558.

```
    /**
     * W1-T2323 OPTION C — THE MERGED HALF'S OWN CLOCK, separate from `ttlMs`, which now governs the OPEN half
     * alone. DEFAULTS TO `ttlMs`, DELIBERATELY, AND THE DEFAULT IS THE ARGUMENT: MEASURED, full walks come from
     * COLD gateways with no cache to expire, not from TTL expiry on warm ones. THE WIN IS LAZINESS, NOT LENGTH
     * — the merged half is no longer fetched by a consumer wanting open rows.
     */
```

### buildBatchedGithub — the per-half TTL floor

Removed from lines 3573-3584.

```
  // W1-T2323: A CACHE MUST SERVE FOR AT LEAST AS LONG AS IT COST TO BUILD. The completion stamp was ALREADY
  // CORRECT and nothing asserted it; this task PINS it rather than rewriting it.
  //
  // WHAT IT DOES NOT BUY, SAID PLAINLY: the expensive walks are the FULL ones, and they come from COLD GATEWAY
  // INSTANCES, not from TTL expiry, so this DOES NOT REDUCE THAT COUNT. Reducing instance count is the larger
  // win and is NOT taken here.
  //
  // ONE FLOOR PER HALF, NOT ONE PER GATEWAY: a SHARED floor would let the merged walk's duration govern the
  // open clock. MEASURED it behaves identically today, but only because the open half refreshes first — a
  // coincidence of call order, written down nowhere. `ttlMs === 0` IS EXEMPT ON BOTH HALVES, being the suite's
  // never-cache idiom (#2998's carve-out). Why: the measured per-half walk costs are in
  // docs/forensics/status.md
```

### FetchOutcome

Removed from lines 3596-3603.

```
  // W1-T119: reflects only the MOST RECENT fetch attempt, reset every call, because this gateway
  // refreshes on its own cadence.
  /**
   * W1-T2323: PER HALF, because the halves attempt independently and a single pair of flags would let the
   * second attempt ERASE the first one's verdict — an open-half outage masked by a merged-half success is
   * the "GitHub says zero PRs" reading W1-T181 prevents, arriving by a new route. `readFailed()` reports
   * their OR, strictly no weaker than the single flag it replaces.
   */
```

### reviewStateCache

Removed from lines 3662-3670.

```
  /**
   * W1-T914: per-URL memo for {@link GitHub.reviewState}, TTL-matched to the index's own clock for an OPEN row,
   * since that context is exactly the value this feature keeps LIVE.
   *
   * W1-T2217 tried memoising a terminal row forever; W1-T2235 found that memo UNREACHABLE for exactly those
   * rows, because the guard consulted the cached state only on a cache HIT, so a terminal row fell through to a
   * call keyed on a branch name GitHub deletes on merge — a 404 the catch never cached, so the row re-failed on
   * every paint. The fix: a MERGED or CLOSED row never reaches this cache at all.
   */
```

### splitHalves

Removed from lines 3720-3724.

```
  /** W1-T2323: TRUE ONLY WHEN THIS GATEWAY OWNS ITS OWN FETCHES. An injected `opts.fetchAll` returns the WHOLE
   *  board in one call and every fixture counts on it being called exactly once per refresh, so a gateway built
   *  with one keeps the single combined clock it has always had — calling an injected fetch twice to fill two
   *  halves would change what those fixtures measure without changing anything in production. Real gateways go
   *  down the split path. */
```

### attemptFetch — the loud catch

Removed from lines 3868-3872.

```
        // LOUD (W1-T181 design (ii)/(v)): the pre-fix catch was silent for hours, with zero error lines,
        // because ENOBUFS classified "unknown" and nothing surfaced it. `console.error` guarantees this reaches
        // whatever log the process is redirected into even if a caller never wires `opts.log`; the injectable
        // log ALSO fires, so a caller with a ledger can key an alert off the classified reason without scraping
        // console output.
```

### attemptFetch — the paired empty result

Removed from lines 3875-3880.

```
        // W1-T181 design (v): a bare [] here is what converted "I could not read GitHub" into "GitHub says
        // there are zero PRs" — every task then silently derived not-merged from an outage that had nothing to
        // do with the repo's actual PRs. The [] below is now always PAIRED with the failure flags, which
        // `readFailed()`/`readFailureReason()` surface to `derivePrPrecedence`: a caller that consults those
        // BEFORE trusting an empty result sees a MARKED failure, never a bare absence — the signal W1-T179
        // consumes.
```

### openRows — the warm guard

Removed from lines 3900-3904.

```
    // W1-T2440: a background worker already owns this channel's refresh, and serving the possibly stale,
    // possibly absent cache beats a SECOND synchronous walk racing it on THIS thread — which is exactly the
    // block this task removes, reintroduced one layer up. A caller that needs to tell "no PRs" from "not
    // fetched yet" already has `readState()`, which reports `"in_flight"` for the whole time this guard is
    // taken.
```

### openRows — rows stored verbatim

Removed from lines 3909-3912.

```
      // STORED VERBATIM — these rows ARE GitHub's answer to the open-state query, and re-deciding their state
      // here would be a second, weaker opinion about a question the query already settled. The open filter
      // still exists in exactly the two places it always did, so both answers are computed from the same
      // predicate over the same rows as before this task.
```

### openRows — the cross-half invalidation

Removed from lines 3915-3922.

```
      // W1-T2323: WHAT SEPARATE CLOCKS COST, AND THE ONE LINE THAT PAYS MOST OF IT BACK. The merged half can
      // now be older, so the merged searches can answer "not merged" about a PR that has in fact merged — and
      // the consumer that acts on that decides a task's disposition, not a display.
      //
      // A PR IN THIS REPO ALWAYS MERGES OUT OF THE OPEN SET, so a successful open pass returning without a
      // number the previous one had IS the merge or close, observed. Expiring the merged clock here makes the
      // miss window ZERO for the case that actually happens. GUARDED ON A SUCCESSFUL FETCH, since treating a
      // failed pass's `[]` as "every open PR just merged" would be the W1-T181 hazard again.
```

### mergedRows

Removed from lines 3936-3941.

```
  /**
   * THE MERGED/CLOSED HALF, ON `mergedTtlMs` — W1-T2323. STILL BUILT AND STILL SHARED: all three merged lookups
   * read off this one index, which is W1-T377's design, and its walk still stops on the delta boundary with the
   * same ceiling. The change is WHEN it is fetched: lazily, by a consumer that actually needs a merged row,
   * instead of by every consumer of any row at all.
   */
```

### bothHalves

Removed from lines 3957-3961.

```
  /**
   * THE COMBINED PATH, for a gateway built with an injected `opts.fetchAll` — ONE call, ONE clock, both halves
   * stamped alike. The pre-split behaviour unchanged, and what every existing fixture runs, so "the split" is a
   * production behaviour rather than a rewrite of what the suite measures.
   */
```

### buildBatchedGithub.resetFailureFlags

Removed from lines 4011-4021.

```
  /**
   * R-24 — THE PER-TICK VERDICT RESET. See {@link GitHub.resetFailureFlags} for the contract.
   *
   * PER HALF, mirroring the outcome split (W1-T2323): a half whose last attempt SUCCEEDED keeps verdict and
   * rows, so a reset never costs a re-fetch it did not have to pay, while a FAILED half loses both together —
   * the verdict AND the stamped EMPTY half it is the only safe pairing for. Dropping one without the other is
   * the W1-T181 hazard in reverse.
   *
   * The delta caches are DELIBERATELY UNTOUCHED: they are the reason a caller holds one gateway across ticks,
   * and clearing them would convert recovery into the cold walk this exists to stop.
   */
```

### buildBatchedGithub — the commit surface

Removed from lines 4048-4052.

```
  // W1-T2387 — the COMMIT surface, memoized and lazy; mirrors {@link ghGateway}'s own fallback exactly, same
  // doc and same precedence. Built at most ONCE per gateway instance and only after a task has actually missed
  // on the body index, so a board whose PRs all carry the body trailer never shells out. Deliberately NOT TTL'd
  // alongside the body halves: commits are append-only, so a stale index can only LACK a very recent merge,
  // which is the case the body index answers.
```

### batched findMergedByTrailerAll

Removed from lines 4252-4255.

```
      // W1-T441: NO ADDITIONAL FETCH. The merged index already carries every merged PR's body from the ONE
      // batched read, so returning every anchored match is a filter over data in hand — the same lookup this
      // gateway already ran, widened. null on a fetch failure (W1-T119), never [] — the failure/absence
      // distinction.
```

### batched listOpenHeadBranches

Removed from lines 4275-4279.

```
      // W1-T377: ZERO extra calls beyond the one this half costs, with the same null-on-failure contract as the
      // merged twin. W1-T2323: THE OPEN HALF ONLY — the single behavioural change to a public method. MEASURED,
      // a cold gateway answering this walked 26 REST requests over 22.2 s for 6 open rows; it now walks 1
      // request over 432 ms. THE VALUE IS UNCHANGED, not merely similar: the rows come from GitHub's own
      // open-state query rather than from filtering an all-states fetch.
```

### batched reviewState

Removed from lines 4325-4328.

```
      // W1-T914: the console's three-state read, over the SAME combined-status endpoint open-prs-rest.ts
      // documents — never a second, independently-shaped call. Keyed off the PR's own head BRANCH NAME, already
      // on this batched index at zero cost, rather than its sha: the endpoint accepts any git ref, and this
      // gateway never fetches a head oid at all.
```

### uncreditedBuildWarning

Removed from lines 4477-4485.

```
/**
 * W1-T2392 — DOES THIS TASK HAVE A MERGED BUILD NOBODY CREDITED? THE CREDIT CHECK IS NOT RE-IMPLEMENTED HERE:
 * this is only consulted on a projection that is NOT merged, and "not merged" already means all three paths
 * came back empty, so no fourth path is built.
 *
 * THE PLAN-ONLY REFUSAL IS LOAD-BEARING, not hygiene: the largest naming population is shard FILINGS, whose
 * titles name their own id by convention, so without it every filed task would warn about the PR that filed it.
 * It fails OPEN, exactly as rung (c)'s own plan-only refusal does (W1-T413).
 */
```

### OpenSiblingBuild

Removed from lines 4504-4515.

```
/**
 * W1-T2397 — WHAT AN OPEN SIBLING BUILD LOOKS LIKE, AND WHY IT IS ONLY EVER A REPORT.
 *
 * THE ASYMMETRY THIS NAMES: the eligibility check already sees open PRs but attributes them by {@link
 * ownsBranch} alone — ONE surface, where the merged side now has three — so an operator-briefed build on a
 * `fix/` branch is invisible and the task is dispatched again.
 *
 * A WARN, AND THE MEASUREMENT IS WHY: the naive predicate fired four times in 72 hours and THREE OF THOSE
 * MERGED, and no staleness bound rescues it, since a threshold must sit near EIGHT HOURS before it stops firing
 * on healthy work. A warn that is wrong costs one line. IT MUST NEVER FEED THE ELIGIBILITY SIGNAL. Why: the
 * time-to-merge distribution is in docs/forensics/status.md
 */
```
