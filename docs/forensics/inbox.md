# `src/lib/inbox.ts` — archived comment forensics

`src/lib/inbox.ts` is the ratification inbox (MASTER-PLAN §7B): it tiers open proposals, drafts a
candidate through a bounded Architect worker, and ratifies an approved draft into a plan PR.

Its comments used to carry 1,537 lines against 1,458 lines of code. A comment-compaction change cut
them to the plain-language standard and moved the measured forensics — incident counts, spend
figures, ledger measurements and the design argument behind each remedy — to this page. Every block
below is reproduced VERBATIM from `src/lib/inbox.ts` at `origin/main` commit `d2a1c77`, as it stood
before that compaction. Nothing here is a rule: the code and its tests are the authority, and this
page is only the record of why each mechanism looks the way it does.

The code keeps a one-line `// Why:` pointer wherever the history mattered.

## Contents

- [The module header](#the-module-header) — base lines 36-84
- [DAEMON_DRAFT_BATCH_CAP](#daemon_draft_batch_cap) — base lines 387-435
- [evictRefusalPoisonedKeys](#evictrefusalpoisonedkeys) — base lines 454-489
- [evictRefusalPoisonedKeys — the alreadyReopened exclusion](#evictrefusalpoisonedkeys-the-alreadyreopened-exclusion) — base lines 494-501
- [evictRefusalPoisonedKeys — the restart-surviving bound](#evictrefusalpoisonedkeys-the-restart-surviving-bound) — base lines 508-512
- [mergeDraftCaches](#mergedraftcaches) — base lines 520-539
- [DraftDeferralCache](#draftdeferralcache) — base lines 550-574
- [decideDraftDeferral](#decidedraftdeferral) — base lines 599-610
- [deferralFromOutcomes](#deferralfromoutcomes) — base lines 625-636
- [ReadinessContext.depsUnobservable](#readinesscontextdepsunobservable) — base lines 775-795
- [approveRunBranch](#approverunbranch) — base lines 835-874
- [priorApproveRunBranch](#priorapproverunbranch) — base lines 889-904
- [classifyProposal — the board-referent check](#classifyproposal-the-board-referent-check) — base lines 1032-1041
- [INBOX_DRAFT_DISALLOWED_TOOLS](#inbox_draft_disallowed_tools) — base lines 1141-1167
- [stripMarkdownFence](#stripmarkdownfence) — base lines 1258-1272
- [DraftRungOutcome — the refused arm](#draftrungoutcome-the-refused-arm) — base lines 1347-1355
- [runDraftRung](#rundraftrung) — base lines 1358-1374
- [runDraftRung — the indexed worker pool](#rundraftrung-the-indexed-worker-pool) — base lines 1486-1490
- [ProposalRegistryParseResult](#proposalregistryparseresult) — base lines 1644-1658
- [Proposal sharding (W1-T2490)](#proposal-sharding-w1-t2490) — base lines 1694-1710
- [loadProposalRegistry](#loadproposalregistry) — base lines 1785-1800
- [updateProposalRegistry](#updateproposalregistry) — base lines 1810-1858
- [updateProposalRegistry — the shard write half](#updateproposalregistry-the-shard-write-half) — base lines 1998-2008
- [writeDraftAttemptPair](#writedraftattemptpair) — base lines 2040-2061
- [ReopenedKeysCache](#reopenedkeyscache) — base lines 2075-2085
- [pruneRatifiedProposals](#pruneratifiedproposals) — base lines 2149-2164
- [draftedDuplicate — the duplicate check at the ratification seam](#draftedduplicate-the-duplicate-check-at-the-ratification-seam) — base lines 2177-2210
- [draftedShardSlugs](#draftedshardslugs) — base lines 2212-2221
- [approveProposal](#approveproposal) — base lines 2439-2463
- [approveCommitMessage](#approvecommitmessage) — base lines 2552-2562
- [ratificationShardFiles](#ratificationshardfiles) — base lines 2597-2618
- [writeRatificationShards](#writeratificationshards) — base lines 2656-2666
- [planRatificationBatch — ratify a batch](#planratificationbatch-ratify-a-batch) — base lines 2698-2711
- [planRatificationBatch](#planratificationbatch) — base lines 2763-2777
- [approveBatch](#approvebatch) — base lines 2874-2892
- [materializeDraftTaskIds — the placeholder handoff](#materializedrafttaskids-the-placeholder-handoff) — base lines 2956-2964
- [reframeProposal](#reframeproposal) — base lines 3110-3127

## The module header

Explained `the module header`. Base lines 36-84; first words: "`rmd inbox` — the ratification".

```
/**
 * `rmd inbox` — the ratification inbox's DETERMINISTIC CORE (MASTER-PLAN P25(i), W1-T110).
 *
 * P25's operator requirement, verbatim: "rmd should recommend what's ready to be ratified
 * and just request a thumbs up on each to agree, or a way to provide feedback to
 * reframe/replan the item." The 2026 field finding this task encodes is that approval
 * controls fail by FATIGUE — reflexive approval is a documented clickthrough
 * vulnerability, and the cure is risk-tiering plus surfacing only what is genuinely
 * actionable [research: hitl-approval-fatigue-2026]. This module is the TIERING: only
 * READY proposals ever surface, readiness is COMPUTED not asserted, and a proposal whose
 * trigger has not fired is DEFERRED-WITH-TRIGGER, never recommended (the P19/WS-2
 * dead-consumer discipline, now code).
 *
 * THE SPLIT (mirrors lib/plan-architect.ts and lib/dep-review.ts): drafting a candidate
 * ratification — a `plan/tasks.yaml` fragment + the MASTER-PLAN.md stamp line — is the
 * LLM's job (a bounded Architect worker, harness-spawned by run-task.ts, via
 * {@link runDraftRung} below). EVERYTHING AFTER drafting is deterministic:
 * {@link classifyProposal} is a PURE function (rule 2, policy-as-data) over an
 * already-drafted candidate + injected facts about the world (dependency merge-state,
 * evidence-anchor grep-truth, lint cleanliness, open conflicts) — no LLM call anywhere in
 * this module, so every branch is a unit fixture.
 *
 * DAEMON-SIDE, NOT CLI-PULL (W1-T192): the draft rung runs on the daemon's own poll cadence
 * (run-task.ts's `buildInboxDraftHook`, riding the SAME `deps.sweep()` seam the W1-T150
 * credit-backfill rung occupies) — a fired trigger or an invalidated (reframed) draft gets
 * redrafted there, with NO CLI invocation required. `rmd inbox` (`inboxCommand`) is a
 * viewer AND a manual force, never the only trigger — see {@link proposalsNeedingDraft}
 * (the shared, unthrottled predicate) vs {@link draftsDueOnDaemon} (the daemon's own
 * idempotence-throttled selection) below.
 *
 * READY = drafted tasks' deps all merged (deriveStatus, corrections-supreme, via the
 * caller's injected {@link MergedResolver}) AND the proposal's cited evidence anchors
 * still grep-true on main AND the drafted fragment passes `rmd lint-plan` AND no open
 * proposal conflicts. Otherwise the proposal is NOT_READY, each failing predicate named
 * (dep-unmet / evidence-drifted / draft-unclean / conflict) — or, when the proposal
 * names an unfired trigger (the P19/WS-2 "unbuilt consumer" case), DEFERRED_WITH_TRIGGER,
 * checked FIRST and unconditionally: a proposal whose consumer is not yet real is never
 * surfaced as a recommendation, no matter what the other four predicates say.
 *
 * `rmd approve` / `rmd reframe` (MASTER-PLAN P25 ii-iv, W1-T111) — the other half of the
 * inbox loop, appended below: APPROVE ({@link approveProposal}) is one bit that INITIATES
 * the plan PR for a READY classification's cached draft (never re-derived) through a
 * gate-injected {@link RatifyGateway}, refusing anything not READY with zero side effects;
 * REFRAME ({@link reframeProposal}) captures the operator's feedback verbatim, invalidates
 * the stale draft, and rides it into the NEXT {@link inboxDraftPrompt}. Both ledger exactly
 * one `ratify.*` line per call; {@link ratifyTelemetry} reduces those lines into the
 * approve/reframe rate the retro surfaces — the field's failure mode is a rubber-stamp
 * queue, so that rate is instrumentation, not decoration.
 */
```

## DAEMON_DRAFT_BATCH_CAP

Explained `DAEMON_DRAFT_BATCH_CAP`. Base lines 387-435; first words: "W1-T2561: the MOST proposals one".

```
/**
 * W1-T2561: the MOST proposals one daemon poll may spawn an Architect for.
 *
 * THE THROTTLE THIS SITS BESIDE BOUNDS REPETITION, NOT VOLUME. {@link DraftAttemptCache} already
 * guarantees ONE attempt per cause — it is why the same proposal is not redrafted every poll. It
 * says nothing about how many DISTINCT proposals may be drafted at once, and until this constant
 * the answer was "every one that is due", sequentially, in a single awaited batch.
 *
 * THAT IS UNBOUNDED BY CONSTRUCTION ONCE A PRODUCER IS WIRED TO THE REGISTRY.
 * `routeFollowupsToRegistry` (lib/retro.ts) appends every routable harvested follow-up with no cap
 * and no expiry, so the registry only grows. MEASURED 2026-09-01: the registry holds 317
 * proposals, all `followup:`-prefixed, 285 of them still needing a draft, against an
 * `inbox.draft_synthesized` mean of $8.52 — roughly $2,400 of latent spend behind a throttle whose
 * key (`anchorFingerprint::reframeCount`) any reframe round invalidates. In the seven hours to
 * 11:52Z the drafting rung spent $401 of a $540 total, 74% of the pipeline, and $1,992 across the
 * retained ledger.
 *
 * WHY A CAP RATHER THAN A HEADROOM GATE — AND THIS IS THE MEASUREMENT THAT DECIDED IT. The
 * intuitive fix is to refuse to draft while the governor is over its ceiling. Classifying every
 * retained `inbox.draft_synthesized` row by the `daemon.headroom` state in force at that instant
 * REFUTES it: 998 spawns costing $1,991.95 happened while `over_ceiling` was FALSE, against 24
 * spawns costing $0.00 while it was TRUE. The rung is not spending THROUGH exhaustion; it is what
 * DRIVES the account there, entirely while the governor still reads healthy. A gate on the
 * exhausted state would therefore have bounded $0 of the $1,992 actually spent. Pacing the arrival
 * rate is the lever; refusing at the ceiling is not.
 *
 * A CAP DELAYS WORK, IT NEVER DROPS IT. Whatever this slice defers stays due — no attempt key is
 * written for a proposal that was not attempted — so the next poll takes the next batch and the
 * queue drains at a bounded rate instead of in one stampede. Three is the arrival rate at roughly
 * one poll's own cadence: at the measured mean it caps a poll near $26 rather than near $2,400,
 * and a genuine burst of new proposals still reaches the Architect within a few minutes.
 *
 * PRIMARY CONTROL: this is the normal pacing lever, not a backstop reached only after another
 * control fails. POLICY DATA (rule 2) — a literal here, W1-T252/W1-T253's policy file is its
 * eventual home, the same disposition {@link UNREADABLE_DEGRADED_LIMIT} in lib/headroom.ts records
 * for its own bound.
 *
 * The tag above must be the ONLY token in this block that satisfies the gate. `KIND_TAG_RE`
 * (test/bound-kind-declared.test.ts) matches the upper-case spellings ANYWHERE in the preceding
 * comment block, so writing the other kind in upper case here would keep this constant passing
 * even with the tag deleted — which is why "backstop" above is lower case, and must stay that way.
 */
// W1-T2569 CORRECTION, MEASURED 2026-09-01: this is a per-batch SIZE, never a concurrency limit.
// `runDraftRung` below is a sequential `for (const p of toDraft) { await ... }`, so a batch of 3
// costs 3 x the per-draft duration END TO END (measured median 316s => ~948s per batch), and the
// observed max concurrent draft workers was 2 — both of which came from two OVERLAPPING batches,
// never from within one. The rung's real cadence was measured at a ~715s median between
// `inbox.draft_batch` rows; the "300s poll cadence" this file used to cite was wrong on both
// counts and is corrected above.
```

## evictRefusalPoisonedKeys

Explained `evictRefusalPoisonedKeys`. Base lines 454-489; first words: "W1-T2564 MIGRATION: re-open every attempt".

```
/**
 * W1-T2564 MIGRATION: re-open every attempt key that never produced a draft.
 *
 * WHY A MIGRATION IS REQUIRED AT ALL. Not writing a key for a refusal fixes the write path
 * FORWARD and repairs nothing already on disk. MEASURED 2026-09-01: of 353 proposals ever
 * drafted, 267 had never once actually been drafted — every row for them a refusal — and all 267
 * carried a key with no cached draft. `draftsDueOnDaemon` filters on
 * `attempts[p.id] !== draftAttemptKey(p)`, and a routed follow-up's key is the literal `::0`
 * (empty anchors, no reframes), so that comparison is false forever. Without this they stay dead.
 *
 * ⚠ WHAT IT RE-OPENS BESIDES REFUSALS, STATED RATHER THAN CLAIMED ABSENT. The predicate is
 * "keyed, still live in the registry, and no cached draft" — which is NOT refusal-specific and
 * cannot be, because the ledger evidence a refusal leaves is not on disk in either cache. So it
 * ALSO re-opens genuine failures W1-T192 deliberately throttled: a worker that ran and emitted
 * unparseable output, and a spawn that threw. Those get ONE more attempt each.
 *
 * THAT COST IS BOUNDED ONLY BECAUSE OF WHERE THE CALLER RUNS IT, AND THAT IS NOT THIS FUNCTION'S
 * DOING. A re-opened genuine failure runs, fails the same way, and is keyed again by the unchanged
 * W1-T192 write. Called ONCE PER DAEMON START and BEFORE the batch (buildInboxDraftHook, run-task.ts)
 * that is one extra attempt per proposal per boot. CALLED PER POLL IT IS AN UNBOUNDED RETRY LOOP:
 * it would evict the key W1-T192 had just written in that same poll and re-open it forever. That is
 * not hypothetical — the per-poll form was written first and `test/run-task.test.ts`'s "an ORDINARY
 * failure still writes its attempt key" reddened on it. A new call site must place itself the same
 * way. `DAEMON_DRAFT_BATCH_CAP` (W1-T2561) bounds how many re-opened proposals can run per poll.
 *
 * THE ALTERNATIVE WAS WORSE. Keying refusals correctly going forward and leaving the 267 dead
 * trades a bounded one-off cost for permanent silent loss.
 *
 * NARROWED TO LIVE PROPOSALS. A key whose proposal has left the registry is left exactly as it
 * is: re-opening it could not schedule work (nothing selects it) and would only grow the file.
 *
 * IDEMPOTENT OVER UNCHANGED STATE — it mutates `attempts` in place and returns the ids it freed, so
 * an immediate second pass returns `[]`. That is what lets the daemon run it on EVERY BOOT rather
 * than behind a one-shot marker file a freshly-provisioned host would never have, while the
 * caller's own once-per-process flag is what stops it re-firing within a run.
 */
```

## evictRefusalPoisonedKeys — the alreadyReopened exclusion

Explained `evictRefusalPoisonedKeys`. Base lines 494-501; first words: "W1-T2566 — ids this host".

```
  /**
   * W1-T2566 — ids this host has ALREADY re-opened once, read from {@link ReopenedKeysCache}.
   * An EXCLUSION, not a change to the predicate above: "keyed, live, no cached draft" still
   * decides what is poisoned, and the predicate itself is explicitly out of this task's scope.
   * What this adds is that a given id is re-opened AT MOST ONCE EVER rather than once per boot.
   *
   * Defaults to empty, so every existing caller is byte-identical.
   */
```

## evictRefusalPoisonedKeys — the restart-surviving bound

Explained `evictRefusalPoisonedKeys`. Base lines 508-512; first words: "W1-T2566: a proposal that fails".

```
    // W1-T2566: a proposal that fails GENUINELY and repeatedly never acquires a cached draft, so
    // it satisfies the predicate on EVERY boot. The closure flag that bounds this within a
    // process cannot see across the restart that resets it, and at a MEASURED median daemon
    // lifetime of 50.5 minutes (479 processes, 32% under 30 min) that is ~29 re-opens a day per
    // stuck proposal at an $8.52 draft mean. This is the bound that survives a restart.
```

## mergeDraftCaches

Explained `mergeDraftCaches`. Base lines 520-539; first words: "W1-T2569: MERGE this batch's own".

```
/**
 * W1-T2569: MERGE this batch's own results onto the caches AS THEY ARE ON DISK RIGHT NOW, rather
 * than onto the snapshot this batch read when it started.
 *
 * THE LOST UPDATE IS INDEPENDENT OF THE RE-ENTRANCY GUARD AND MUST BE FIXED SEPARATELY.
 * `buildInboxDraftHook` reads `drafts`/`attempts` at the top of a batch and writes
 * `{...drafts, ...mine}` at the bottom. Any overlap at all — a guard that is bypassed, a lock
 * reclaimed as stale while its holder is in fact alive, a second host — makes the later writer's
 * spread silently drop everything the earlier one produced. A guard makes overlap unlikely; this
 * makes a lost update impossible, which is the half that still holds when the guard is wrong.
 *
 * MEASURED 2026-09-01, the defect this closes: 16 Architect spawns over 5 distinct proposals cost
 * $123.30 and left the drafts cache frozen at 62 entries, because each batch's write reverted the
 * previous batch's. Eligible read 285 -> 282 and then never moved again.
 *
 * PRECEDENCE IS THIS BATCH'S OWN RESULTS. Where both this batch and a concurrent writer produced
 * an entry for the SAME id, this batch's wins — it is the fresher observation, and the alternative
 * (dropping it) is the very lost update this exists to stop. Every id THIS batch did not touch is
 * carried through from disk verbatim.
 */
```

## DraftDeferralCache

Explained `DraftDeferralCache`. Base lines 550-574; first words: "W1-T2590: `<config.root>/state/inbox-draft-deferred-until.json` — the instant".

```
/**
 * W1-T2590: `<config.root>/state/inbox-draft-deferred-until.json` — the instant the account itself
 * said its window reopens, after a draft was refused for a usage/session limit.
 *
 * WHY THIS EXISTS, AND WHY IT IS A PREREQUISITE RATHER THAN A NICETY. Before W1-T2564 a refused
 * draft wrote a {@link DraftAttemptCache} key and was never retried — the work was silently LOST.
 * After it, a refusal writes no key, stays due, and RETRIES ON THE NEXT POLL. That is the correct
 * fix and it changed what the batch cap bounds: during a live account outage
 * {@link DAEMON_DRAFT_BATCH_CAP} became the ONLY thing limiting a retry storm, in exactly the
 * condition that produced 494 refusals in seven hours. Raising the cap for recovery throughput
 * would raise the storm ceiling with it. THIS IS WHAT MAKES RAISING IT SAFE LATER.
 *
 * RETRYING INTO A SHUT DOOR IS THE THING BEING STOPPED. The refusal already states when the door
 * reopens: `detectUsageLimitRefusal` (lib/classify.ts) recovers it from the provider's own text —
 * MEASURED on the real captured string, `resetsAtMs` 2026-09-01T11:50:00.000Z, which was more
 * accurate than the headroom governor's own belief at that instant.
 *
 * ⚠ AN ABSENT RESET IS NOT A LICENCE TO DEFER FOREVER, AND IT IS THE COMMON-ENOUGH CASE.
 * `resetsAtMs` is present ONLY when the refusal stated a time AND that time carried an explicit
 * UTC marker — a bare clock time in an unknown zone is deliberately never converted, because
 * guessing the operator's zone would produce a confident wrong resume time. So a refusal can
 * legitimately arrive with NO usable instant, and {@link decideDraftDeferral} must then decline to
 * defer at all rather than invent a window. A deferral with no stated end is an outage that never
 * ends.
 */
```

## decideDraftDeferral

Explained `decideDraftDeferral`. Base lines 599-610; first words: "Should this poll's draft batch".

```
/**
 * Should this poll's draft batch run, or is the account's own stated window still shut?
 *
 * PURE, so the decision is a unit fixture rather than a clock race. Returns the remaining wait
 * when deferring, so the caller can ledger a number an operator can act on instead of a bare
 * refusal.
 *
 * THE DEFERRAL IS SELF-LIMITING BY CONSTRUCTION — it is an INSTANT, not a duration or a latch. Past
 * that instant the rung runs again with no operator action and no expiry sweep, which is what makes
 * this safe to write from an unattended rung: the W1-T1067 failure mode (a stranded marker that
 * suppresses a rung forever) cannot occur because there is nothing here to strand.
 */
```

## deferralFromOutcomes

Explained `deferralFromOutcomes`. Base lines 625-636; first words: "The deferral a batch's own".

```
/**
 * The deferral a batch's own outcomes justify, or `undefined` when they justify none.
 *
 * THE LATEST STATED RESET WINS. Two refusals in one batch can name different instants (a retry
 * that crossed a window boundary); deferring to the EARLIER one would resume into a door that is
 * still shut for the other. Taking the latest is the only choice that cannot under-wait.
 *
 * ⚠ A REFUSAL WITHOUT A STATED INSTANT CONTRIBUTES NOTHING — see {@link DraftDeferralCache}'s doc.
 * A batch of nothing but zone-less refusals defers nothing at all, and that is deliberate: it
 * retries on the next poll exactly as it does today, bounded by the batch cap, rather than
 * stopping the rung on a window whose end nobody stated.
 */
```

## ReadinessContext.depsUnobservable

Explained `ReadinessContext.depsUnobservable`. Base lines 775-795; first words: "W1-T510: the readiness predicate's THIRD".

```
  /**
   * W1-T510: the readiness predicate's THIRD value for a dependency's landed-ness. `isMerged`
   * above is (necessarily — see {@link "./plan.js".MergedResolver}'s own two-valued signature,
   * untouched by this task) a plain boolean, so it CANNOT itself distinguish "read, and not
   * merged" from "never actually read" (throttled/auth/transport/truncated — W1-T119's
   * `indeterminate`). This is that distinction, queried per DEPENDENCY task id: returns the
   * classified {@link GhFailureReason} when the id's latest GitHub read was indeterminate, or
   * `undefined` when it was genuinely observed (merged either way, `isMerged`'s answer stands).
   * OPTIONAL, exactly like {@link isRatified}'s/{@link draftSpawnedAt}'s own optional siblings —
   * every existing fixture/caller that never had a reason to think about an unobservable read
   * behaves precisely as before (every id reports observed, so `isMerged`'s verdict is trusted
   * outright, exactly as pre-W1-T510).
   *
   * {@link classifyProposal} consults this for every dependency id `isMerged` reported unmerged:
   * an id THIS reports unobservable for is NEVER folded into the `deps_merged` dep-unmet
   * predicate (the read never actually concluded "not merged", so no such claim is made) — it
   * surfaces instead as its own `deps_observable` predicate naming the classified reason. THE
   * POLARITY DOES NOT FLIP: an unobservable dep still keeps the proposal out of READY and
   * `rmd approve` still refuses it — cannot-observe means WAIT (W1-T130), never READY on an
   * unread dependency. Only WHAT IS SAID changes.
   */
```

## approveRunBranch

Explained `approveRunBranch`. Base lines 835-874; first words: "THE ONE PLACE an approve".

```
/**
 * THE ONE PLACE an approve run's `run_id` becomes a GIT REF NAME (and, through
 * `join(worktreesDir(config), branch)`, a WORKTREE DIRECTORY NAME). Sanitising happens HERE, at
 * the branch-name boundary, and NEVER on the proposal id itself: that id is a registry key in
 * `state/inbox-proposals.json` and a `task_id` VALUE on every ledger row the proposal ever wrote,
 * so rewriting it would orphan both.
 *
 * WHY IT EXISTS (MEASURED 2026-08-28T20:24:45Z and again at :46Z, the fleet host's ledger):
 * `approveCommand` mints `APPROVE-${proposalId}-${Date.now()}`, and `board-review.ts` mints
 * proposal ids of the form `board-review:escalation:#3039`. A COLON IS ILLEGAL IN A GIT REF, so
 * `git worktree add -b run-APPROVE-board-review:escalation:#3039-...` died with
 * `fatal: '...' is not a valid branch name` and NO proposal has ever been ratified — 0
 * `ratify.approved` rows across a 533,478-row three-form ledger union, against a control of 137
 * inbox/board-review rows in the same corpus. `#` is NOT the offender and never was: measured
 * through `git check-ref-format --branch`, `run-APPROVE-board-review-escalation-#3039-1` is
 * LEGAL while `run-APPROVE-board-review:escalation-3039-1` is ILLEGAL.
 *
 * NOT ONLY `board-review:`. Of the id shapes this codebase MINTS, three carry a colon and are
 * illegal — `board-review:stale:<ref>` and `board-review:escalation:<ref>` (lib/board-review.ts)
 * and `rule-efficacy:<ruleId>` ({@link ruleEfficacyProposalId}, lib/rule-efficacy.ts, latent
 * today because no such proposal is open) — while the feedback docket's `FD-<date>-<slug>`
 * (lib/feedback-docket.ts, already slugged at the mint) and the registry's own prose `P<N>` ids
 * are legal. So this is a general boundary defect, not a board-review special case, which is why
 * the transform below is TOTAL rather than a targeted replacement.
 *
 * INJECTIVITY — the property that stops two distinct runs sharing one branch, and hence one
 * worktree. The readable half is deliberately LOSSY (`board-review:x` and `board-review-x` slug
 * identically), so injectivity does NOT rest on it: a 12-hex-character SHA-256 prefix of the
 * ORIGINAL, unslugged `runId` is appended unconditionally. Two distinct run ids therefore reach
 * the same branch only on a 48-bit SHA-256 prefix collision. Unconditional, never "hash only when
 * the name was illegal", because a conditional transform reintroduces exactly the ambiguity the
 * digest exists to remove — a legal id could otherwise be crafted to equal some illegal id's
 * slugged form.
 *
 * SAFE TO CHANGE THE NAME FOR ALREADY-LEGAL SHAPES TOO: this lane has never pushed a branch.
 * `git ls-remote --heads origin 'run-APPROVE-*'` reads 0 (control: `run-W1-*` reads 59), and no
 * `run-APPROVE-*` worktree exists on the fleet host — so there is no prior name to preserve, and
 * {@link priorApproveRunBranch}, which derives a RESUME candidate from ledger evidence, routes
 * through this same function so the two derivations can never drift apart.
 */
```

## priorApproveRunBranch

Explained `priorApproveRunBranch`. Base lines 889-904; first words: "W1-T903: the branch a PRIOR".

```
/**
 * W1-T903: the branch a PRIOR `rmd approve <proposalId>` run would have pushed, derived PURELY
 * from ledger evidence — `approveCommand` (run-task.ts) mints `run_id`s of the shape
 * `APPROVE-<proposalId>-<ms>` and its gateway always pushes `run-<run_id>`, so any ledger line
 * this proposal's own run_id ever appended (`approve.id_materialized`, `approve.error`,
 * `worktree.prune`, ...) names the branch by construction. EVIDENCE ONLY — the REMOTE read that
 * turns "a run_id exists" into "and it actually got pushed" is the caller's job (design iii);
 * this function never touches git or GitHub.
 *
 * SAFE TO TAKE THE MOST RECENT MATCH ONLY. `approveProposal` is reachable again for this
 * proposal only when the ledger does NOT already carry `ratify.approved` for it (a ratified
 * proposal classifies `ratified` and is refused before any gateway call, see refusalReason) — so
 * every EARLIER `APPROVE-<proposalId>-*` run already failed short of ratifying it, and only the
 * latest is worth resuming. `run_id`'s `<ms>` suffix is `Date.now()`, a fixed digit count for
 * centuries yet, so plain string comparison sorts it exactly as a numeric one would.
 */
```

## classifyProposal — the board-referent check

Explained `classifyProposal`. Base lines 1032-1041; first words: "W1-T2451: a board-review proposal's referent".

```
  // W1-T2451: a board-review proposal's referent is checked next, before drafting/trigger/the
  // four AND-clauses below. RESOLVED (the referent left the open board) is a terminal override,
  // exactly like the ratified check above — a proposal about a PR that already merged, died, or
  // had its escalation handled must never render READY, drafting, or deferred no matter what the
  // rest of this function would otherwise say, because there is no longer a live referent for any
  // of those states to be ABOUT. UNREADABLE never short-circuits: it only sets a flag threaded
  // into whatever classification the rest of this function computes normally, so a proposal is
  // never held out of a legitimate READY (or hidden into one) just because this pass's batched
  // read failed — cannot-observe means WAIT (W1-T130), not "guess in either direction". LIVE (or
  // no referent at all — every non-board-review proposal) changes nothing below.
```

## INBOX_DRAFT_DISALLOWED_TOOLS

Explained `INBOX_DRAFT_DISALLOWED_TOOLS`. Base lines 1141-1167; first words: "W1-T2591 — THE TOOLS THE".

```
/**
 * W1-T2591 — THE TOOLS THE DRAFT PROMPT ALREADY CLAIMS THIS RUNG DOES NOT HAVE, now enforced.
 *
 * {@link inboxDraftPrompt} tells the worker, in as many words: "You have NO Write/Edit/Bash tools
 * — you cannot touch a file or run git." That sentence was the ONLY thing standing between a
 * draft worker and the checkout, and after #3588 (W1-T2664) parallelised `runDraftRung` into an
 * indexed worker pool it stopped being enough: `draftProposalBatch` materialises ONE worktree per
 * batch and hands that same `worktreePath` to every lane as `cwd`, so up to
 * `DAEMON_DRAFT_BATCH_CAP` workers now share one checkout where exactly one ran before. Worker
 * HOMES are already isolated per spawn (`perRunWorkerHomeDir(..., { perSpawn: true })`); the cwd
 * is not.
 *
 * MEASURED 2026-09-04, which is why prose was not enough: `settings/worker.json` carries
 * `allow: []` and a `deny` list of four READ paths (ssh, aws, remudero config, service-tokens) —
 * nothing about Write, Edit or Bash — and the spawn passes `permissionMode: "bypassPermissions"`.
 *
 * THE RUNG NEEDS NONE OF THEM, which is what makes enforcement the cheap remedy rather than
 * per-lane worktrees: the plan text is passed IN the prompt (`currentPlanText`), and the outcome
 * is parsed from the worker's TRANSCRIPT (`parseDraftedCandidate`), never read back off disk. So
 * the sharing becomes provably read-only instead of asserted read-only — the distinction this
 * task's own criterion is written around. Per-lane worktrees remain the stronger option and were
 * costed rather than dismissed: they multiply checkout disk by the cap on a host that hit 100%
 * full on 2026-09-01 (W1-T2585).
 *
 * `NotebookEdit` is listed alongside the prompt's own three because it is a write path the
 * sentence predates — the list enforces the CLAIM, not its 2026 wording.
 */
```

## stripMarkdownFence

Explained `stripMarkdownFence`. Base lines 1258-1272; first words: "Strip a markdown code fence".

```
/**
 * Strip a markdown code fence wrapping an Architect-drafted fragment — a ```yaml (or bare
 * ```) opening line and its matching ``` closing line — so a FENCED draft parses as plain
 * YAML instead of falsely failing draft-rung's `lint_clean` predicate (W1-T173; the P19
 * fixture: the inbox's own INAUGURAL ratification arrived fenced and was rejected as
 * draft-unclean even though its YAML content was perfectly well-formed — an LLM emitting
 * fenced YAML is the overwhelmingly common case, not an edge case). {@link inboxDraftPrompt}
 * now also instructs raw-YAML-only output, so this strip is a safety net, not the sole guard.
 *
 * A NO-OP when the fragment isn't fenced at all — returned byte-identical, so an already-
 * clean draft is untouched. FAILS LOUD (throws {@link PlanError}) on a malformed fence — an
 * opening ``` with no matching close, or a stray ``` line elsewhere in the document — rather
 * than guessing where the real content ends: a silent partial strip could truncate real
 * tasks unseen, which is strictly worse than a loud, named parse failure.
 */
```

## DraftRungOutcome — the refused arm

Explained `DraftRungOutcome`. Base lines 1347-1355; first words: "W1-T2564: `refused` marks a run".

```
  /**
   * W1-T2564: `refused` marks a run the ACCOUNT turned away (a session/usage limit), as distinct
   * from a run that happened and failed. THE DIFFERENCE IS NOT COSMETIC — it decides whether a
   * {@link DraftAttemptCache} key is written. W1-T192 records a key on failure deliberately, so a
   * genuinely failing cause is not retried every poll; but a REFUSAL IS NOT AN ATTEMPT, and keying
   * it retires work that never ran. MEASURED: 267 of 353 proposals ever drafted had never once
   * actually been drafted, all 267 keyed, none with a cached draft — and because a routed
   * follow-up's key is the literal `::0` and never changes, none could ever become due again.
   */
```

## runDraftRung

Explained `runDraftRung`. Base lines 1358-1374; first words: "Draft EVERY proposal in `toDraft`".

```
/**
 * Draft EVERY proposal in `toDraft` against `currentPlanText`, via {@link inboxDraftPrompt} +
 * {@link parseDraftedCandidate}. Independent proposals run concurrently up to
 * {@link DAEMON_DRAFT_BATCH_CAP}; a single proposal's bounded self-lint retries remain serial.
 * The same ceiling also protects the manual, unthrottled inbox caller from turning a large queue
 * into unbounded simultaneous subscription use. Each proposal's spawn+parse is isolated in its OWN try/catch
 * — W1-T192's fail-soft requirement: a genuine spawn-level exception for one proposal (a
 * network hiccup, an API error — distinct from the "no FRAGMENT/STAMP markers" malformed-
 * output case, which was already tolerated pre-W1-T192) never prevents the REST of the batch
 * from being attempted. This is what makes the SAME loop safe to call from an unattended
 * daemon poll, not only from a human watching `rmd inbox`'s output. Never throws.
 */
/** cc71f2: the draft rung's own bounded self-lint. The first attempt is the ordinary draft;
 *  each further attempt is a redraft carrying the prior fragment's linter violations. Keeps the
 *  Architect from re-rolling blind while never looping unboundedly. */
// impl-FU: re-exported from lib/relint.ts so triage/plan/inbox share ONE bound. The name is
// kept because test/inbox.test.ts imports it.
```

## runDraftRung — the indexed worker pool

Explained `runDraftRung`. Base lines 1486-1490; first words: "W1-T2664: the daemon's volume cap".

```
  // W1-T2664: the daemon's volume cap was also an accidental wall-clock multiplier. Live
  // evidence on 2026-09-02 showed three independent drafts starting sequentially inside one full
  // sweep; one completed after 347s and the batch crossed the sweep's 559s await bound. A tiny
  // indexed worker pool makes elapsed time approach the slowest proposal instead of their sum,
  // while preserving input order and keeping the existing cap as the hard concurrency ceiling.
```

## ProposalRegistryParseResult

Explained `ProposalRegistryParseResult`. Base lines 1644-1658; first words: "W1-T1270: the discriminated outcome {@link".

```
/** W1-T1270: the discriminated outcome {@link parseProposalRegistryResult} reports —
 *  the same four input classes {@link parseProposalRegistry} collapses to `[]` kept
 *  apart, so a caller that cares WHY a read came back with no proposals can tell "this
 *  path has never fired" from "it fired and was drained" from "the file was torn on the
 *  last concurrent write" (the exact hazard {@link updateProposalRegistry}'s own header
 *  doc names: "a torn read becomes a SILENT empty registry").
 *   - `"absent"`  — no text at all: the file was never created. The normal
 *     pre-population state for a path that has never fired, NOT a fault.
 *   - `"fault"`   — text was present but unusable: a `JSON.parse` throw (`reason:
 *     "malformed"`, e.g. a reader observing a torn concurrent write) or a parsed value
 *     whose `proposals` key is missing/not-an-array (`reason: "wrong-shape"`, a
 *     foreign or corrupted blob).
 *   - `"ok"`      — a well-shaped registry. `proposals` may legitimately be `[]` (a
 *     fired-and-drained registry, or one freshly initialised empty) — that emptiness is
 *     never a fault. */
```

## Proposal sharding (W1-T2490)

Explained `loadProposalRegistry`. Base lines 1694-1710; first words: "── W1-T2490: PROPOSAL SHARDING —".

```
// ── W1-T2490: PROPOSAL SHARDING — a proposal gets the same one-record-per-file home
// `plan/tasks.d/` already gave tasks and `plan/decisions.d/` gave decisions ───────────────
//
// `state/inbox-proposals.json` was the last plan artifact still a single blob: an arriving
// proposal was a whole-file rewrite, and two minters filing DIFFERENT proposals in the same
// window contended on the same file — exactly the collision shape `plan/tasks.d/` was built
// to retire (the nine-PR appender train, #271). This mirrors that fix, not a new one:
// `loadProposalRegistry` merges the legacy blob with a sibling `inbox-proposals.d/` shard
// directory exactly as plan.ts's `loadPlan` merges `tasks.yaml` with `tasks.d/`, including
// its duplicate-id refusal — the property that makes the merge safe rather than merely
// convenient. `updateProposalRegistry` (below) is the only writer, so this is invisible to
// every caller of it: same signature, same `Proposal[]` shape in and out.
//
// NOT IN SCOPE (this task's own rationale): changing what any minter proposes or when, the
// inbox's tiering/`classifyProposal`, or deleting the legacy blob — an existing blob-sourced
// proposal stays right where it is until an operator runs a migration codemod later; only a
// NEW or actively-rewritten proposal ever lands in a shard file.
```

## loadProposalRegistry

Explained `loadProposalRegistry`. Base lines 1785-1800; first words: "Load `registryPath` (the legacy `state/inbox-proposals.json`".

```
/**
 * Load `registryPath` (the legacy `state/inbox-proposals.json` blob) merged with any shards
 * under the sibling `inbox-proposals.d/` directory, as ONE population — exactly as plan.ts's
 * `loadPlan` merges `tasks.yaml` with `tasks.d/`. SAME signature and return shape as the
 * `parseProposalRegistry(readFileIfExists(registryPath))` idiom every current reader already
 * uses (a path in, a `Proposal[]` out) — a future caller can swap to this with NO other
 * change, which is the point: the modules reading this registry today must not need to
 * learn sharding exists.
 *
 * A proposal id present in BOTH the blob and a shard resolves to the shard's copy, ONCE —
 * the expected steady state once {@link updateProposalRegistry} starts sharding new/edited
 * proposals instead of rewriting the whole blob for them (this task's rationale: "a proposal
 * that exists in the blob and as a shard must resolve once, not twice"). A proposal id
 * claimed by TWO DIFFERENT SHARD FILES is the genuine collision {@link readProposalShards}
 * refuses — that guard is what stops the both-places case from silently resolving twice.
 */
```

## updateProposalRegistry

Explained `updateProposalRegistry`. Base lines 1810-1858; first words: "── W1-T240: the ONE registry-write".

```
// ── W1-T240: the ONE registry-write helper every writer of state/inbox-proposals.json
// goes through ─────────────────────────────────────────────────────────────────────────
//
// FOUR independent read-modify-write round trips on this file used to exist, each a
// plain `readFileSync` + `JSON.parse` + `writeFileSync` with no mutual exclusion and no
// atomicity: `rmd inbox`'s ratified-registry heal, `rmd approve`'s remove-on-ratify,
// `rmd reframe`'s feedback write (all three run-task.ts), and the serve daemon's OWN
// `GET /v1/inbox` heal (lib/panel-graph.ts) — the multi-writer path is genuine, not
// theoretical, because `rmd serve` is a LONG-LIVED daemon, so any concurrent CLI
// invocation overlaps it by construction. Two DIFFERENT failure modes result:
//   - TORN FILE — a reader's `readFileSync` lands mid another writer's `writeFileSync`
//     and observes a truncated/partial blob, which {@link parseProposalRegistry}'s
//     deliberate fail-soft "malformed → []" discipline turns into a SILENT empty
//     registry (every active proposal vanishes from `rmd inbox`), not a visible error.
//   - LOST UPDATE — two updaters both read the same old content, both compute a new
//     version from it, and whichever writes last wins outright, discarding the other's
//     change (a pruned/consumed proposal resurrected, or a heal silently undone).
//
// {@link updateProposalRegistry} fixes both, and is the ONLY sanctioned way to write
// this file (a fifth caller inherits the property by construction, never re-deriving
// it): an O_EXCL lockfile (`${registryPath}.lock`) serializes every call against this
// SAME path across every process that can write it — CLI invocations are independent OS
// processes, so an in-process "single writer function" alone cannot prevent a lost
// update between two of them; only a real inter-process lock can — and the write itself
// lands via a sibling temp file + `renameSync` (POSIX rename is atomic on the same
// filesystem, the SAME idiom already proven in this codebase at lib/status.ts's
// projection cache, lib/worker.ts's run.lock, and lib/ledger.ts's rotation writer), so a
// reader never observes a partial file. Unlike lib/drain-lock.ts / lib/inflight-lock.ts
// (both "refuse immediately, a whole SECOND long-running process is the bug" guards),
// a live holder of THIS lock is polled/retried up to `maxWaitMs` rather than refused —
// every real critical section here is a synchronous JSON read-transform-write done in
// microseconds, so a live holder means "wait a beat, it is about to release," not "a
// second command must not run." A holder judged stale (a crash mid-update, or a dead
// pid whose number a later process has since reused) is reclaimed via the SAME
// {@link isHolderStale} predicate and {@link reclaimStaleLock} primitive
// lib/drain-lock.ts and lib/inflight-lock.ts use (W1-T289/W1-T368): staleness is never
// pid-liveness alone (a live PID reused by an unrelated process must not read as "the
// same holder still running"), and the reclaim's delete is conditioned on the lock's
// own on-disk identity (dev+ino+bytes) so two reclaimers racing over one dead lock
// cannot both come away believing they hold it — the SAME lost-update hazard this
// module's own header above describes for the registry file itself, previously left
// open on the LOCK file that guards it.
//
// `update` receives a FRESH parse of whatever is on disk RIGHT NOW (read under the
// lock), never a value some earlier, unlocked read produced — so a caller whose
// intended change was computed against a possibly-stale snapshot (e.g. "drop this one
// proposal id", or a ledger-derived set of ids to prune) still applies correctly
// against the latest state. Returning `null` skips the write entirely (the common,
// already-consistent case never touches disk).
```

## updateProposalRegistry — the shard write half

Explained `updateProposalRegistry`. Base lines 1998-2008; first words: "A `next` proposal that is".

```
    // A `next` proposal that is NEW (its id was not in `current` at all) or already had a
    // shard mirror gets its OWN file, atomically (sibling temp file + rename — the SAME
    // idiom the blob write below uses) — MIRRORED alongside the blob write below, never
    // instead of it. This is the write half of the sharded-home fix: a newly minted
    // proposal is a single new file a reviewer can open on its own, while the blob write
    // below is UNCHANGED from before this task — every one of the eight existing readers
    // that still parses the blob directly keeps seeing the exact same complete population
    // it always has ("the read path must not notice"). Promoting an UNTOUCHED legacy entry
    // to a shard of its own is a migration step an operator takes later, not a side effect
    // of an unrelated write (this task's own scope) — only a NEW or actively-rewritten
    // proposal ever gains a mirror here.
```

## writeDraftAttemptPair

Explained `writeDraftAttemptPair`. Base lines 2040-2061; first words: "── W1-T241: the ONE atomic-write".

```
// ── W1-T241: the ONE atomic-write helper for the daemon draft rung's cache PAIR ───────────
//
// buildInboxDraftHook (run-task.ts) used to write `state/inbox-drafts.json` and
// `state/inbox-draft-attempts.json` (the two caches above) as two independent plain
// `writeFileSync` calls — each individually torn-write-prone (a reader's `readFileSync`
// landing mid the write observes a truncated/partial blob, the same hazard
// {@link updateProposalRegistry}'s own header doc describes for the registry), and the PAIR
// itself non-atomic: a crash between the two calls could leave one file reflecting this
// poll's outcome while the other still reflects the previous one.
//
// {@link writeDraftAttemptPair} fixes both. Each file lands via a sibling temp file +
// `renameSync` — the SAME idiom {@link updateProposalRegistry} uses above — so a reader never
// observes anything but a complete, previous-OR-next file, never a torn one. The two renames
// then commit in a FIXED, safe order: drafts before attempts. That order is what makes a
// crash BETWEEN the two renames self-healing rather than wedging: the only one-sided state it
// can land is a fresh draft cached with no matching attempts entry yet — {@link
// proposalsNeedingDraft} sees that cached draft as no longer stale and simply stops selecting
// the proposal, so nothing re-attempts it — never the reverse (an attempt recorded with no
// draft to show for it, which would let {@link draftsDueOnDaemon} throttle that cause FOREVER
// with nothing ever having landed — exactly the idempotence violation this task closes). A
// FAILED-outcome proposal whose attempts entry is lost to the same crash window merely gets
// re-attempted next poll — a redundant redraft, never a stall.
```

## ReopenedKeysCache

Explained `ReopenedKeysCache`. Base lines 2075-2085; first words: "`<config.root>/state/inbox-reopened-keys.json` (W1-T2566) — one entry".

```
/**
 * `<config.root>/state/inbox-reopened-keys.json` (W1-T2566) — one entry per proposal id this host
 * has re-opened, with the ISO stamp it happened at. The third cache beside `inbox-drafts.json` and
 * `inbox-draft-attempts.json`.
 *
 * ⚠ KEYED ON PROPOSAL ID, NEVER A GLOBAL "MIGRATION DONE" FLAG, AND THAT DISTINCTION IS THE
 * DELIVERABLE. W1-T2564 chose a closure flag precisely because every boot runs it, so a
 * freshly-provisioned host recovers with no operator step. A per-id marker preserves that — an id
 * never seen before is still re-opened on first sight — whereas one global flag would not, and
 * would reintroduce exactly the gap the closure flag was chosen to avoid.
 */
```

## pruneRatifiedProposals

Explained `pruneRatifiedProposals`. Base lines 2149-2164; first words: "W1-T190 (round 2): the read-side".

```
/**
 * W1-T190 (round 2): the read-side override in {@link classifyProposal} stops a drifted
 * registry entry from ever being MISCLASSIFIED again, but the drifted entry itself — the
 * P19-shaped row `rmd approve`'s registry write never reached — otherwise sits in
 * `state/inbox-proposals.json` forever, unless something actually writes the correction
 * back. "The ledger receipt is authoritative — a registry disagreeing with it is DETECTED
 * and corrected, not trusted" means BOTH halves: classification never trusts the stale
 * flag (already true), AND the stale flag itself gets healed, not merely worked around, the
 * next time anything classifies these proposals against the ledger. This is that healing
 * step: given the SAME proposals + classifications one inbox pass already computed, prune
 * every proposal the ledger now says is ratified, so any OTHER consumer of the registry
 * file that does not itself call {@link classifyProposal} — a future feature, a support
 * script, a human `cat`ing the JSON — sees the corrected state too, not just this pass's
 * in-memory override. A no-op (same array reference, empty `prunedIds`) when nothing needs
 * healing, so callers can skip the write entirely on the common (already-clean) path.
 */
```

## draftedDuplicate — the duplicate check at the ratification seam

Explained `draftedDuplicate`. Base lines 2177-2210; first words: "── W1-T2455: THE DUPLICATE CHECK".

```
// ── W1-T2455: THE DUPLICATE CHECK AT THE RATIFICATION SEAM ──────────────────────────────────
//
// `duplicateTitleViolations` (task-linter.ts) has been WIRED since W1-T1076 — `duplicateCorpusOpts`
// (run-task.ts) supplies its corpus — but TWO things keep it off the ratification path: its
// severity is `warn` and `lintPlanCommand` only counts a task as failing inside
// `if (blocking.length)`; and it is scoped to the `--base` pass and returns `{}` for the
// whole-plan one. So `rmd approve` can file a task for a defect that already shipped, and on
// 2026-08-29 it would have: of 32 drafted shards across the 18 cached drafts, TWO score a perfect
// 1.00 against a shard already on `origin/main` (W1-T2452, W1-T2453) and one scores 0.57
// (W1-T2451) — all three already merged.
//
// W1-T2486 CORRECTS A THIRD REASON THIS COMMENT USED TO GIVE, WHICH WAS FALSE: it used to also
// claim `lint-plan` is not a required check — it is (ci-gate.yml's REQUIRED list names it, and
// has since ci-gate started aggregating it). That third reason was also never load-bearing for
// the conclusion above: a required check only holds merge on a REAL failure, and a `warn`-severity
// violation never enters `lintPlanCommand`'s `blocking` array in the first place (see the first
// reason above) — so being required changes nothing about whether THIS check's warn can stop a
// ratification. The two reasons above are sufficient on their own and are the whole of why this
// path stays open. `duplicateTitleViolations`' own escalation, added narrowly in task-linter.ts
// (W1-T2486, `unansweredDuplicateTitleViolations`) for an UNANSWERED near-certain match, targets
// the PLAN-FILING path, not this ratification seam, which is why THIS module's own
// `draftedDuplicate` check below still carries the separate burden of catching it here.
//
// IT KEYS ON THE DRAFTED SHARD SLUG, NEVER ON THE PROPOSAL. Eleven proposal summaries read
// literally `board-review: #NNNN carries 1 unhandled escalation(s)` — near-identical yet
// LEGITIMATELY DISTINCT, one per PR. A proposal-level similarity check would collapse exactly
// those. Scored on the slug instead, they land at 0.00-0.10, well under the cutoff.
//
// HONEST RECALL, MEASURED, NOT CLAIMED: this is a LEXICAL check and it catches the exact and
// near-exact re-draft (3 of 32 at the shipped {@link DEFAULT_DUPLICATE_CUTOFF}). The ~21 drafts
// that describe the SAME defect in different words score 0.08-0.18 and are NOT caught. No cutoff
// is invented here to reach them: there is no clean separation between 0.18 and 0.10 in the
// measured set, and lowering it would refuse sibling tasks in one arc. That residue is named, not
// papered over.
```

## draftedShardSlugs

Explained `draftedShardSlugs`. Base lines 2212-2221; first words: "The slug stem of each".

```
/**
 * The slug stem of each shard a drafted fragment would be filed as — the SAME stems
 * {@link ratificationShardFiles} emits, so the check scores exactly what would land on disk.
 *
 * PLACEHOLDER-TOLERANT BY NECESSITY: at approve time the fragment still carries `NEW-<n>` ids
 * (`materializeDraftTaskIds` runs later, inside the gateway's branch creation), so
 * `shardSlugFromPath` — whose regex requires a real `W1-T<n>` id — returns `undefined` for every
 * one of these paths. Measured: it scored 0 of 32 drafted shards. This reads the stem after the
 * FIRST `-` instead, which is the same text `planShardSlugCorpus` stores for a filed shard.
 */
```

## approveProposal

Explained `approveProposal`. Base lines 2439-2463; first words: "`rmd approve <P##>` — valid".

```
/**
 * `rmd approve <P##>` — valid ONLY for a READY classification. Approving anything else is
 * REFUSED, naming the state, with ZERO gateway calls (a bit on a non-ready item initiates
 * NOTHING — rule 15). On a READY classification with NO evidence of a prior push, calls
 * {@link RatifyGateway.createRatificationBranch} then {@link RatifyGateway.openPlanPr} EXACTLY
 * once each (today's PROCEED path, unchanged), with the payload carrying the cached draft's
 * fragment + stamp verbatim.
 *
 * W1-T903 design (iii): when `gateway.findPushedBranch` names a branch a PRIOR run of this
 * SAME proposal already pushed (evidence the caller has already confirmed against the remote),
 * this checks for an existing PR FIRST — never creating anything before asking:
 *   - a PR is found (ADOPT): neither `createRatificationBranch` nor `openPlanPr` is called at
 *     all — the found PR is ledgered as this proposal's ratification, and nothing is opened.
 *   - no PR, but `completeRatificationBranch` is offered (COMPLETE): that replaces
 *     `createRatificationBranch` (no second mint/commit/push), then `openPlanPr` runs as usual.
 *   - the gateway offers `findPushedBranch` but not `completeRatificationBranch`: falls back to
 *     the PROCEED path — safe (a fresh branch is always correct), just not the cheapest option.
 *
 * Every outcome — approved (any of the three shapes above) or refused — ledgers exactly one
 * `ratify.*` line (`ratify.approved` / `ratify.approve_refused`), and `ratify.approved` is
 * appended ONLY after a pull request is confirmed to exist (adopted or freshly opened) — never
 * before, and never on a thrown gateway error (design vii: a throttled `openPlanPr` propagates,
 * decorated via {@link describeApproveGatewayError}, and ledgers nothing here at all — the
 * proposal stays exactly as READY as it was before this call).
 */
```

## approveCommitMessage

Explained `approveCommitMessage`. Base lines 2552-2562; first words: "The harness-authored commit message for".

```
/** The harness-authored commit message for a `rmd approve` ratification branch — never
 *  the LLM (mirrors lib/plan-architect.ts's `planCommitMessage` discipline in spirit: the
 *  fragment and stamp are the Architect's drafted TEXT, but the commit framing around
 *  them is the harness's, deterministically). Unlike `planCommitMessage`, this carries NO
 *  `Remudero-Task:` trailer: a ratification branch is a plan-FILING PR (it introduces the
 *  ratified task(s) into plan/tasks.yaml, it does not implement them), and
 *  `findMergedByTrailer` (lib/status.ts) would credit a trailer here as that task being
 *  DONE — permanently marking a brand-new, never-built task complete on merge. Uses
 *  {@link "./plan-pr-emitter.js".buildPlanPrCommitMessage} so the stamp line (#387: a real
 *  673-char single-paragraph stamp blew commitlint's body-max-line-length when spliced in
 *  raw) is WRAPPED, never spliced verbatim. */
```

## ratificationShardFiles

Explained `ratificationShardFiles`. Base lines 2597-2618; first words: "Split a drafted fragment into".

```
/**
 * Split a drafted fragment into ONE `plan/tasks.d/` shard per task it carries.
 *
 * WHY THIS EXISTS: `applyFragmentToPlanYaml` below appends to `plan/tasks.yaml`, and `lint-plan`'s
 * `monolith-filing` rule refuses exactly that for a NEW id — "New tasks belong in their own shard".
 * The ratification path was the last writer still appending to the monolith, and because no
 * proposal had ever been ratified (0 `ratify.approved` rows before 2026-08-29) the write had never
 * once met the gate. Every READY proposal would have failed identically.
 *
 * TEXT SPLITTING, NEVER A YAML RE-SERIALIZATION — the same discipline `applyFragmentToPlanYaml`'s
 * own doc states, and for the same reason: the drafted block is authored, prose-heavy YAML (long
 * titles, block scalars, comments) and round-tripping it through a parser would reformat what a
 * human wrote and reviewed. Blocks are cut on a top-level `- ` at column zero, the only place a
 * new element can begin in a valid top-level sequence.
 *
 * N TASKS PRODUCE N FILES. A fragment may draft more than one (`NEW-1`, `NEW-2`, ...) and {@link
 * materializeDraftTaskIds} already returns `ids: string[]`, so the plural was supported upstream
 * and only the write site collapsed it into a single append.
 *
 * REFUSES RATHER THAN GUESSES: a block whose `- id:` cannot be read yields no file at all, because
 * writing a shard under a guessed name puts a task somewhere `lint-plan` cannot match to its id.
 */
```

## writeRatificationShards

Explained `writeRatificationShards`. Base lines 2656-2666; first words: "Compose {@link ratificationShardFiles} and WRITE".

```
/**
 * Compose {@link ratificationShardFiles} and WRITE them under `worktreePath`, returning the
 * repo-relative paths written. THROWS on a refusal rather than returning a partial result: a
 * ratification that cannot name its own shard must write nothing, commit nothing and open no PR,
 * the same all-or-nothing contract {@link materializeDraftTaskIds} already states for the mint.
 *
 * EXTRACTED FROM THE GATEWAY so it is reachable by a test. `createRatificationBranch`
 * (run-task.ts) needs a real worktree, a real mint and real id reservations to run at all, so a
 * loop living inline there is untestable by construction — and an untestable write is exactly what
 * let the monolith append survive until the first ratification in the repo's history met the gate.
 */
```

## planRatificationBatch — ratify a batch

Explained `planRatificationBatch`. Base lines 2698-2711; first words: "── W1-T2471: RATIFY A BATCH".

```
// ── W1-T2471: RATIFY A BATCH — one branch, one commit, one MASTER-PLAN block, one PR ───────
//
// `approveProposal` above ships exactly ONE proposal per branch/commit/PR/review-spawn. With
// 17 ready proposals in the inbox that is 17 full PR lifecycles for a diff that is pure plan
// text, and PARALLEL single-approves cannot fix it: `applyStampToMasterPlan` REPLACES an
// existing bullet but otherwise APPENDS AT EOF, so N independent branches built off one base
// each append their own stamp at the SAME point and conflict pairwise on merge (measured).
//
// The fix folds N stamps SEQUENTIALLY in ONE working copy instead. `applyStampToMasterPlan` is
// already a pure `(md, id, line) => md`, so N calls chained through ONE accumulator produce N
// appended lines with no conflict — there is only ever one branch to conflict on. Everything
// below is ADDITIVE: `approveProposal`/`RatifyGateway`/the single-proposal path above are
// UNCHANGED, and this is a second, parallel entry point over an EXPLICIT, ORDERED set of
// proposal ids the caller names — never a discovered or implicit "approve everything ready".
```

## planRatificationBatch

Explained `planRatificationBatch`. Base lines 2763-2777; first words: "Reduce a batch of already-computed".

```
/**
 * Reduce a batch of already-computed {@link InboxClassification}s into a {@link RatifyBatchPlan}
 * — PURE, no fs/git/network, mirroring {@link approveProposal}'s own read-only decision/side-
 * effect split. `classifications` is the EXPLICIT, ORDERED set the caller named (Q4) — this
 * function never discovers, expands, or reorders it; each member was already classified
 * INDIVIDUALLY by the caller's own {@link classifyProposal} call.
 *
 * Q5 (within-batch duplicates): `opts.duplicateCorpus` seeds the check exactly as
 * {@link RatifyLedgerDeps.duplicateCorpus} does for a single approve, and GROWS by one accepted
 * member's own {@link draftedShardSlugs} before the NEXT member is checked — so two members
 * drafting the same title are caught even though neither is on origin/main yet. The growth is
 * PURELY ADDITIVE: an empty/omitted `duplicateCorpus` still fails open (the first member of an
 * empty-corpus batch is never refused for a duplicate it can't possibly have) — identical to
 * {@link draftedDuplicate}'s own existing corpus-empty contract, just re-seeded each iteration.
 */
```

## approveBatch

Explained `approveBatch`. Base lines 2874-2892; first words: "`rmd approve <P##> <P##> ...`".

```
/**
 * `rmd approve <P##> <P##> ...` — the N-proposal counterpart of {@link approveProposal}. Every
 * member is classified INDIVIDUALLY by the caller (this function never re-derives readiness)
 * and an unready one is SKIPPED, carrying its own named reason, NEVER admitting the rest and
 * NEVER aborting the whole batch (Q4) — except for the one batch-level precondition
 * {@link planRatificationBatch} checks before anything is written: two accepted members
 * colliding on the same shard path, which refuses the WHOLE batch before either gateway call.
 *
 * ONE gateway call each — `createRatificationBranch` then `openPlanPr` — for the WHOLE accepted
 * set, never once per member. Ledgers exactly one `ratify.approve_refused` line per skipped
 * member (same shape {@link approveProposal} writes for a single refusal) and exactly one
 * `ratify.approved` line per ACCEPTED member once the one PR exists — a reader diffing the
 * ledger sees the same one-line-per-proposal receipt whether it was ratified singly or in a
 * batch, just sharing one `pr_url`/`branch` across every accepted row.
 *
 * A batch of exactly ONE READY classification produces a `payload`/`shardFiles`/`masterPlanMd`
 * BYTE-IDENTICAL to what {@link approveProposal} would produce for that same classification —
 * test/ratify-batch.test.ts pins this directly against the single-proposal functions above.
 */
```

## materializeDraftTaskIds — the placeholder handoff

Explained `materializeDraftTaskIds`. Base lines 2956-2964; first words: "── Draft placeholder ids ->".

```
// ── Draft placeholder ids -> concrete ids AT APPROVE TIME (feedback#fb-1784766965325-c7b673,
//    the SEQUENCING half; lib/task-id.ts is the DERIVATION half) ─────────────────────────────
//
// {@link inboxDraftPrompt} now hands the drafting worker NO real id at all — it emits `NEW-1`,
// `NEW-2`, ... placeholders (never W1-T shaped, so a cached draft can never pin a concrete id
// even by accident). `rmd approve`'s `createRatificationBranch` calls {@link
// materializeDraftTaskIds} to mint + RESERVE the real ids and rewrite every placeholder — the
// fragment's `- id:` lines, any intra-fragment `depends_on` reference, and the stamp line's
// task-id list — in one pass, before anything is written to the ratification worktree.
```

## reframeProposal

Explained `reframeProposal`. Base lines 3110-3127; first words: "`rmd reframe <P##> --feedback "<text>"".

```
/**
 * `rmd reframe <P##> --feedback "<text>" [--supersedes <rounds>]` — the operator's objection
 * is captured VERBATIM (never summarized) and ledgered as `ratify.reframed`; the cached
 * draft is invalidated so the next `rmd inbox` pass re-drafts rather than re-surfacing the
 * candidate the operator just objected to; the feedback joins the proposal's
 * `reframeHistory` so {@link inboxDraftPrompt}'s NEXT invocation carries it into the
 * redraft — "the reframe history rides the proposal until resolution" (design). Opens NO
 * PR: reframe is feedback, not a ratification, and is valid for ANY classification state (a
 * READY item the operator still wants to object to is exactly the "one bit OR feedback"
 * choice P25 promises).
 *
 * `supersedes` (W1-T194, {@link parseSupersedesExpr}'s output — pre-validated 1-indexed
 * round numbers) marks those EXISTING rounds `retracted: true` in place: their text is
 * PRESERVED verbatim in `reframeHistory` (and the ORIGINAL `ratify.reframed` ledger line
 * for each is never touched — retraction is a NEW ledger line, this call's own) but
 * {@link inboxDraftPrompt} stops emitting them into the next redraft. Omitted/empty leaves
 * every prior round exactly as it was — retraction only ever happens on an explicit ask.
 */
```

