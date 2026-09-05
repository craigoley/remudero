# Removed block map — `src/lib/sweep.ts`

Every comment block compacted out of `src/lib/sweep.ts`, mapped to the heading in
[sweep.md](sweep.md) that holds it verbatim. Line numbers are the block's first line in
`src/lib/sweep.ts` at the merge base (PR #4113's `ea02cc83`).

| Base line | First five words | Forensics heading |
| --- | --- | --- |
| 46 | lib/sweep.ts — the level-triggered PR-pipeline | [module header — lib/sweep.ts](docs/forensics/sweep.md#module-header-lib-sweep-ts) |
| 202 | W1-T920 — a THREE-VALUED finding | [SupersessionStatus](docs/forensics/sweep.md#supersessionstatus) |
| 222 | W1-T920 (design note iv) — | [SupersessionDiffFinding](docs/forensics/sweep.md#supersessiondifffinding) |
| 237 | W1-T920 — one open PR's | [SupersessionVerdict](docs/forensics/sweep.md#supersessionverdict) |
| 254 | The commit sha this check's | [CiFailure.sha](docs/forensics/sweep.md#cifailure-sha) |
| 271 | WHY this failure's {@link logTail} | [logUnavailable](docs/forensics/sweep.md#logunavailable) |
| 280 | WHICH SOURCE filled {@link logTail}, | [tailSource](docs/forensics/sweep.md#tailsource) |
| 289 | WHAT THE ANNOTATION FALLBACK DID, | [CiFailure.annotationFallback](docs/forensics/sweep.md#cifailure-annotationfallback) |
| 392 | The closed set of reasons | [CiLogUnavailableCause and MAX_CI_LOG_FAILURE_DETAIL](docs/forensics/sweep.md#cilogunavailablecause-and-max-ci-log-failure-detail) |
| 414 | One sentence naming why a | [describeCiLogUnavailable](docs/forensics/sweep.md#describecilogunavailable) |
| 432 | PURE, DETERMINISTIC classification (rule 2 | [isPureConcurrentAddition](docs/forensics/sweep.md#ispureconcurrentaddition) |
| 444 | W1-T2548 — THE DECLARED GENERATOR | [REGENERABLE_ARTIFACT_GENERATORS](docs/forensics/sweep.md#regenerable-artifact-generators) |
| 475 | W1-T2548 — PURE, DETERMINISTIC classification | [isRegenerableArtifactConflict](docs/forensics/sweep.md#isregenerableartifactconflict) |
| 503 | W1-T2536 — WHICH of the | [conflictRefusalCause](docs/forensics/sweep.md#conflictrefusalcause) |
| 533 | W1-T2548 — MIXED ONLY (acceptance | [lines 533-538](docs/forensics/sweep.md#lines-533-538) |
| 550 | W1-T78 policy (policy-as-data, rule 2 | [ClarifyPolicy](docs/forensics/sweep.md#clarifypolicy) |
| 577 | W1-T121 QUEUE GOVERNOR (the 23-open-PR | [wipLimit](docs/forensics/sweep.md#wiplimit) |
| 585 | W1-T172 PARALLEL DISPATCH (P19, DECISIONS.md | [SweepPolicy.dispatchLanes](docs/forensics/sweep.md#sweeppolicy-dispatchlanes) |
| 612 | W1-T1049 — THE REVIEW LANE'S | [SweepPolicy.reviewLanes](docs/forensics/sweep.md#sweeppolicy-reviewlanes) |
| 644 | W1-T148 COST GOVERNOR (the $206/60-run | [SweepPolicy.dailyCostCeilingUsd](docs/forensics/sweep.md#sweeppolicy-dailycostceilingusd) |
| 662 | W1-T1038 (the 2026-08-19 host stall) | [memoryFloorMib](docs/forensics/sweep.md#memoryfloormib) |
| 674 | W1-T114 (the 30-issue predicate-storm fix) | [SweepPolicy.pendingCeilingMinutes](docs/forensics/sweep.md#sweeppolicy-pendingceilingminutes) |
| 692 | Retry threshold for one unchanged | [SweepPolicy.reviewOrphanCap](docs/forensics/sweep.md#sweeppolicy-revieworphancap) |
| 707 | W1-T1018 (design (i)/(ii)) — THE | [SweepPolicy.reviewOrphanBackoffMinutes](docs/forensics/sweep.md#sweeppolicy-revieworphanbackoffminutes) |
| 723 | W1-T905 — "repair the instance, | [repairFilingThreshold](docs/forensics/sweep.md#repairfilingthreshold) |
| 736 | W1-T920 — gates the SUPERSESSION | [supersessionDisposalEnabled](docs/forensics/sweep.md#supersessiondisposalenabled) |
| 747 | W1-T932 — gates whether a | [SweepPolicy.conceptCoexistenceEnabled](docs/forensics/sweep.md#sweeppolicy-conceptcoexistenceenabled) |
| 778 | W1-T984 — GATES THE `conflicted` | [SweepPolicy.mergeConflictAdmissionEnabled](docs/forensics/sweep.md#sweeppolicy-mergeconflictadmissionenabled) |
| 827 | W1-T2345 (MEASURED 2026-08-26, `sweep.disposed` ledger | [SweepPolicy.repeatDispositionBound](docs/forensics/sweep.md#sweeppolicy-repeatdispositionbound) |
| 878 | W1-T2439 (half two) — HOW | [SweepPolicy.planFilingAdmissionBound](docs/forensics/sweep.md#sweeppolicy-planfilingadmissionbound) |
| 909 | The default policy — 14-day | [DEFAULT_SWEEP_POLICY](docs/forensics/sweep.md#default-sweep-policy) |
| 957 | W1-T1049 — reads `plan/policy.yaml`'s `sweep.reviewLanes` | [validateReviewLanesRow](docs/forensics/sweep.md#validatereviewlanesrow) |
| 1120 | W1-T923 — one GATE failure | [ActionableGateFailure](docs/forensics/sweep.md#actionablegatefailure) |
| 1147 | W1-T114: ISO-8601 timestamp of the | [checksPendingSince](docs/forensics/sweep.md#checkspendingsince) |
| 1156 | W1-T913 — THE OWNERSHIP RECORD'S | [OpenPrView.reviewPendingSince](docs/forensics/sweep.md#openprview-reviewpendingsince) |
| 1178 | W1-T2299 — ISO-8601 timestamp the | [OpenPrView.reviewVerdictPostedAt](docs/forensics/sweep.md#openprview-reviewverdictpostedat) |
| 1202 | The unmet acceptance criteria from | [unmetCriteria](docs/forensics/sweep.md#unmetcriteria) |
| 1210 | W1-T440: true when a `Remudero-Task:` | [OpenPrView.criteriaRecoverable](docs/forensics/sweep.md#openprview-criteriarecoverable) |
| 1228 | W1-T923 — a SIBLING list | [OpenPrView.actionableGateFailures](docs/forensics/sweep.md#openprview-actionablegatefailures) |
| 1263 | W1-T920 — a {@link SupersessionVerdict} | [OpenPrView.supersessionVerdict](docs/forensics/sweep.md#openprview-supersessionverdict) |
| 1295 | W1-T1201 — ISO-8601 timestamp of | [OpenPrView.createdAt](docs/forensics/sweep.md#openprview-createdat) |
| 1322 | W1-T528: is this PR a | [OpenPrView.isDraft](docs/forensics/sweep.md#openprview-isdraft) |
| 1350 | W1-T196: true when this PR | [OpenPrView.isPlanFiling](docs/forensics/sweep.md#openprview-isplanfiling) |
| 1378 | Failing required-check name+log-tail evidence — | [ciFailures](docs/forensics/sweep.md#cifailures) |
| 1387 | W1-T1223 (design i) — required | [cancelledRequiredChecks](docs/forensics/sweep.md#cancelledrequiredchecks) |
| 1398 | W1-T2340 — this head's own | [workflowRuns](docs/forensics/sweep.md#workflowruns) |
| 1418 | GitHub's OWN raw `mergeable` boolean, | [mergeable](docs/forensics/sweep.md#mergeable) |
| 1450 | An operator's answer to a | [OpenPrView.pendingAnswer](docs/forensics/sweep.md#openprview-pendinganswer) |
| 1470 | W1-T176 (the #393/#391 fixture): true | [OpenPrView.reviewPostRefused](docs/forensics/sweep.md#openprview-reviewpostrefused) |
| 1495 | W1-T176 (design boundary (ii)): true | [OpenPrView.requiredContextsUnreadable](docs/forensics/sweep.md#openprview-requiredcontextsunreadable) |
| 1513 | W1-T2399 — WHY the repo-wide | [requiredContextsReadFailure](docs/forensics/sweep.md#requiredcontextsreadfailure) |
| 1521 | W1-T225 (the 2026-07-21 PRs #477/#484 | [OpenPrView.reviewOrphanedByPush](docs/forensics/sweep.md#openprview-revieworphanedbypush) |
| 1541 | Number of completed review judgments | [priorReviewAttemptsForInput](docs/forensics/sweep.md#priorreviewattemptsforinput) |
| 1567 | One PR status-check-rollup entry, structurally | [RollupCheckEntry](docs/forensics/sweep.md#rollupcheckentry) |
| 1589 | Conclusions GitHub's OWN branch-protection merge-eligibility | [REQUIRED_CHECK_OK](docs/forensics/sweep.md#required-check-ok) |
| 1603 | Conclusions that veto a required | [REQUIRED_CHECK_FAIL](docs/forensics/sweep.md#required-check-fail) |
| 1629 | Group rollup entries by check | [dedupeRollupByLatestAttempt](docs/forensics/sweep.md#deduperollupbylatestattempt) |
| 1660 | Aggregate ONLY the REQUIRED contexts | [checksStateFromRollup](docs/forensics/sweep.md#checksstatefromrollup) |
| 1716 | W1-T457: dedupe to ONE entry | [gate](docs/forensics/sweep.md#gate) |
| 1726 | ONE OK-SET, KNOWN CONTEXTS OR | [checksStateFromRollup — the one ok-set](docs/forensics/sweep.md#checksstatefromrollup-the-one-ok-set) |
| 1758 | W1-T1223 — one required check | [CancelledRequiredCheck](docs/forensics/sweep.md#cancelledrequiredcheck) |
| 1777 | W1-T2431 — GitHub's OWN `run_attempt` | [CancelledRequiredCheck.runAttempt](docs/forensics/sweep.md#cancelledrequiredcheck-runattempt) |
| 1799 | W1-T2431 — whether THIS check's | [cancelledCheckAlreadyRequeuedFromSurface](docs/forensics/sweep.md#cancelledcheckalreadyrequeuedfromsurface) |
| 1823 | W1-T1223 (design i) — which | [cancelledRequiredCheckNames](docs/forensics/sweep.md#cancelledrequiredchecknames) |
| 1871 | W1-T2340 (the corrected discriminator W1-T2327's | [stalledRunReason](docs/forensics/sweep.md#stalledrunreason) |
| 1921 | W1-T1278 (condition A) — of | [stillRedRequiredNames](docs/forensics/sweep.md#stillredrequirednames) |
| 1966 | W1-T1223 (design ii/iii) — BOUNDED | [cancelledCheckRequeueDecision](docs/forensics/sweep.md#cancelledcheckrequeuedecision) |
| 1995 | W1-T1223 (design ii) — every | [requeuedCheckKeysFromLedger](docs/forensics/sweep.md#requeuedcheckkeysfromledger) |
| 2012 | ── W1-T2204 — MAIN'S OWN | [main health section — W1-T2204](docs/forensics/sweep.md#main-health-section-w1-t2204) |
| 2035 | Check names KNOWN — from | [PUSH_VACUOUS_SUCCESS_CHECK_NAMES](docs/forensics/sweep.md#push-vacuous-success-check-names) |
| 2046 | Main's health, as read off | [MainHealthState](docs/forensics/sweep.md#mainhealthstate) |
| 2078 | Read main's own check rollup | [mainHealthFromRollup](docs/forensics/sweep.md#mainhealthfromrollup) |
| 2180 | Which of the fleet's existing | [mainHealthEscalationClass](docs/forensics/sweep.md#mainhealthescalationclass) |
| 2202 | A red trunk produces an | [mainHealthEscalationDecision](docs/forensics/sweep.md#mainhealthescalationdecision) |
| 2224 | Q3's asymmetry, held as its | [mainHealthShouldStandDownDispatch](docs/forensics/sweep.md#mainhealthshouldstanddowndispatch) |
| 2240 | ── W1-T1275 — THE REQUIRED | [CI_GATE_CHECK_NAME — the re-aggregation section](docs/forensics/sweep.md#ci-gate-check-name-the-re-aggregation-section) |
| 2258 | #2918 — `ci-gate` REPORTED AS | [withoutDownstreamGateFailure](docs/forensics/sweep.md#withoutdownstreamgatefailure) |
| 2294 | W1-T1275 (design iii/iv) — the | [StaleCiGateTransition](docs/forensics/sweep.md#stalecigatetransition) |
| 2313 | W1-T1275 (design iii) — detect | [staleCiGateTransition](docs/forensics/sweep.md#stalecigatetransition) |
| 2352 | `${headSha}@${siblingName}@${siblingStartedAt}` — the (head, sibling-transition) | [ciGateReaggregateKey](docs/forensics/sweep.md#cigatereaggregatekey) |
| 2366 | W1-T1275 (design iv) — BOUNDED | [ciGateReaggregateDecision](docs/forensics/sweep.md#cigatereaggregatedecision) |
| 2390 | W1-T1275 (design iv) — every | [reaggregatedCiGateKeysFromLedger](docs/forensics/sweep.md#reaggregatedcigatekeysfromledger) |
| 2415 | The blocked_ci shape (the #170 | [isBlockedCi](docs/forensics/sweep.md#isblockedci) |
| 2455 | W1-T1269 — does the CURRENT | [fixRungRepeatsIdenticalFailure](docs/forensics/sweep.md#fixrungrepeatsidenticalfailure) |
| 2492 | W1-T923 (design note iv) — | [actionableGateFailuresFromReasons](docs/forensics/sweep.md#actionablegatefailuresfromreasons) |
| 2515 | W1-T527 — WHY a PR | [RedCause](docs/forensics/sweep.md#redcause) |
| 2540 | The Standing rule 25 refusal | [UNSATISFIABLE_GATE_MARKER](docs/forensics/sweep.md#unsatisfiable-gate-marker) |
| 2553 | The required check failing on | [baseCausedCheckName](docs/forensics/sweep.md#basecausedcheckname) |
| 2579 | True when the review named | [namesUnsatisfiableGate](docs/forensics/sweep.md#namesunsatisfiablegate) |
| 2600 | The check whose log tail | [environmentFaultCheckName](docs/forensics/sweep.md#environmentfaultcheckname) |
| 2638 | The two classes the fix | [redCauseStandsDown](docs/forensics/sweep.md#redcausestandsdown) |
| 2650 | The stand-down reason carried on | [describeRedCause](docs/forensics/sweep.md#describeredcause) |
| 2666 | W1-T2620 (design i/v) — per | [lastBaseCausedTipFromLedger](docs/forensics/sweep.md#lastbasecausedtipfromledger) |
| 2689 | W1-T2620 (design ii/iii) — AT | [selectBaseCausedRelease](docs/forensics/sweep.md#selectbasecausedrelease) |
| 2776 | The four named "why is | [ObservedBlockerState](docs/forensics/sweep.md#observedblockerstate) |
| 2843 | THE ABSENT-CHECK-SUITE REMEDY'S DECISION (W1-T186 | [absentChecksRepushDecision and absentAgeMinutes](docs/forensics/sweep.md#absentchecksrepushdecision-and-absentageminutes) |
| 2991 | Render the named observed-blocker facts | [renderObservedFacts](docs/forensics/sweep.md#renderobservedfacts) |
| 3042 | One row of the POLICY-AS-DATA | [DispositionRule](docs/forensics/sweep.md#dispositionrule) |
| 3052 | Observed-state predicate over the PR | [lines 3052-3058](docs/forensics/sweep.md#lines-3052-3058) |
| 3063 | W1-T114: how many minutes checks | [pendingAgeMinutes](docs/forensics/sweep.md#pendingageminutes) |
| 3103 | W1-T913: how many minutes `remudero-review` | [reviewPendingAgeMinutes](docs/forensics/sweep.md#reviewpendingageminutes) |
| 3120 | W1-T913 — THE STUCK-PENDING FALSIFIER'S | [reviewPendingIsStale](docs/forensics/sweep.md#reviewpendingisstale) |
| 3142 | W1-T1018 (operator ruling 2026-08-19, "I | [reviewInputBackoffElapsed](docs/forensics/sweep.md#reviewinputbackoffelapsed) |
| 3173 | W1-T2299 — THE SUPERSEDED-INPUT DETECTOR: | [reviewVerdictOvertakenByActivity](docs/forensics/sweep.md#reviewverdictovertakenbyactivity) |
| 3201 | THE POLICY TABLE — the | [DISPOSITION_RULES — the full ordered table](docs/forensics/sweep.md#disposition-rules-the-full-ordered-table) |
| 3377 | W1-T920 (DECISIONS.md #1987, the 2026-08-16 | [disposition](docs/forensics/sweep.md#disposition) |
| 3403 | W1-T932 — LETS THIS ROW | [disposition (lines 3403-3411)](docs/forensics/sweep.md#disposition-lines-3403-3411) |
| 3426 | W1-T54's dep lane, ROUTED (the | [disposition (lines 3426-3432)](docs/forensics/sweep.md#disposition-lines-3426-3432) |
| 3438 | W1-T78: an operator's answer to | [disposition (lines 3438-3444)](docs/forensics/sweep.md#disposition-lines-3438-3444) |
| 3453 | strikeCapForAnswer returns the ADDITIONAL strikes | [lines 3453-3457](docs/forensics/sweep.md#lines-3453-3457) |
| 3464 | W1-T2299 — A CORRECTED INPUT | [DISPOSITION_RULES row 3.5 — verdict overtaken by activity](docs/forensics/sweep.md#disposition-rules-row-3-5-verdict-overtaken-by-activity) |
| 3509 | 2026-09-02 #3597 incident: GitHub can | [disposition (lines 3509-3516)](docs/forensics/sweep.md#disposition-lines-3509-3516) |
| 3536 | W1-T186 (the #420 fixture): once | [reason](docs/forensics/sweep.md#reason) |
| 3552 | W1-T100 (the #170 fix); BROADENED | [disposition (lines 3552-3559)](docs/forensics/sweep.md#disposition-lines-3552-3559) |
| 3568 | W1-T1269 — row 5.5 (table | [disposition (lines 3568-3576)](docs/forensics/sweep.md#disposition-lines-3568-3576) |
| 3584 | Reached only when checks are | [disposition (lines 3584-3597)](docs/forensics/sweep.md#disposition-lines-3584-3597) |
| 3613 | W1-T440: the SAME empty (`pr.unmetCriteria` | [disposition (lines 3613-3619)](docs/forensics/sweep.md#disposition-lines-3613-3619) |
| 3625 | head ref the same way | [lines 3625-3628](docs/forensics/sweep.md#lines-3625-3628) |
| 3638 | W1-T106 (the #170 DIRTY strand): | [DISPOSITION_RULES row 7.5 — the conflicted arm](docs/forensics/sweep.md#disposition-rules-row-7-5-the-conflicted-arm) |
| 3668 | W1-T2548: a SECOND, independent admission | [lines 3668-3671](docs/forensics/sweep.md#lines-3668-3671) |
| 3691 | W1-T106: the OTHER half of | [disposition (lines 3691-3704)](docs/forensics/sweep.md#disposition-lines-3691-3704) |
| 3717 | W1-T2860 — GitHub can carry | [disposition (lines 3717-3724)](docs/forensics/sweep.md#disposition-lines-3717-3724) |
| 3739 | POSITIVE MATCH ONLY (the #161 | [disposition (lines 3739-3742)](docs/forensics/sweep.md#disposition-lines-3739-3742) |
| 3748 | W1-T176 (the #393/#391 fixture): a | [disposition (lines 3748-3757)](docs/forensics/sweep.md#disposition-lines-3748-3757) |
| 3769 | W1-T225 (the 2026-07-21 PRs #477/#484 | [disposition (lines 3769-3783)](docs/forensics/sweep.md#disposition-lines-3769-3783) |
| 3798 | POST-REVIEW ROUTING (the 2026-07-22 #584 | [DISPOSITION_RULES row 8.5 — post-review routing](docs/forensics/sweep.md#disposition-rules-row-8-5-post-review-routing) |
| 3859 | W1-T913: a FRESH (not-yet-stale) `remudero-review` | [disposition (lines 3859-3866)](docs/forensics/sweep.md#disposition-lines-3859-3866) |
| 3878 | W1-T2340 — A HEAD PENDING | [DISPOSITION_RULES row 8.7 — stalled by a terminal run](docs/forensics/sweep.md#disposition-rules-row-8-7-stalled-by-a-terminal-run) |
| 3906 | WAIT (W1-T114, the 30-issue predicate-storm | [disposition (lines 3906-3913)](docs/forensics/sweep.md#disposition-lines-3906-3913) |
| 3924 | STALE-PENDING (W1-T114): the SAME datable-pending | [disposition (lines 3924-3929)](docs/forensics/sweep.md#disposition-lines-3924-3929) |
| 3940 | NOT-YET-SCHEDULED (W1-T1103, design i) — | [DISPOSITION_RULES — the not-yet-scheduled row](docs/forensics/sweep.md#disposition-rules-the-not-yet-scheduled-row) |
| 3979 | TERMINAL rule (matches unconditionally) — | [disposition (lines 3979-3987)](docs/forensics/sweep.md#disposition-lines-3979-3987) |
| 3995 | Derive ONE open PR's disposition | [deriveDisposition](docs/forensics/sweep.md#derivedisposition) |
| 4036 | W1-T1201 (design iii): the clamp | [clockSkewSuppressedStale](docs/forensics/sweep.md#clockskewsuppressedstale) |
| 4053 | W1-T983 — IS THIS OPEN | [isCappedReviewOrphanEscalation](docs/forensics/sweep.md#iscappedrevieworphanescalation) |
| 4089 | ARMING PARITY WITH THE RUN | [decideSweepArm](docs/forensics/sweep.md#decidesweeparm) |
| 4143 | W1-T1028 — appended LAST, the | [irreversible](docs/forensics/sweep.md#irreversible) |
| 4178 | W1-T528 — the terminal outcome | [UpdateBranchOutcome](docs/forensics/sweep.md#updatebranchoutcome) |
| 4190 | W1-T520 — ARMED AND BEHIND, | [armedButStalled](docs/forensics/sweep.md#armedbutstalled) |
| 4237 | W1-T528 — THE ACTION HALF | [selectUpdateBranchTarget](docs/forensics/sweep.md#selectupdatebranchtarget) |
| 4271 | W1-T1212 (design ii): the UNION | [combined](docs/forensics/sweep.md#combined) |
| 4296 | One PR {@link redPrWithStaleGate} selected | [StaleGatePr](docs/forensics/sweep.md#stalegatepr) |
| 4306 | W1-T1212 — A RED PR | [redPrWithStaleGate](docs/forensics/sweep.md#redprwithstalegate) |
| 4368 | ──────────────────────────────────────────────────────────────────────────── // W1-T78 — the | [lines 4368-4381](docs/forensics/sweep.md#lines-4368-4381) |
| 4383 | One recorded fix-rung strike's outcome | [StrikeAttempt](docs/forensics/sweep.md#strikeattempt) |
| 4393 | W1-T1269 — the unmet criteria | [StrikeAttempt.unmetClaims](docs/forensics/sweep.md#strikeattempt-unmetclaims) |
| 4423 | The rendered output of the | [ClarificationQuestion](docs/forensics/sweep.md#clarificationquestion) |
| 4444 | W1-T186: which of {@link ObservedBlockerState}'s | [observedState](docs/forensics/sweep.md#observedstate) |
| 4452 | Render ONE blocked-ambiguous PR's clarification | [renderClarificationQuestion](docs/forensics/sweep.md#renderclarificationquestion) |
| 4511 | W1-T186: prepend the named observed-blocker | [observedState (lines 4511-4515)](docs/forensics/sweep.md#observedstate-lines-4511-4515) |
| 4534 | Render a {@link ClarificationQuestion} into | [toQuestionEntry](docs/forensics/sweep.md#toquestionentry) |
| 4551 | ── W1-T2345 — THE UNBOUNDED-IDENTICAL-DISPOSITION | [the repeat-disposition counter section](docs/forensics/sweep.md#the-repeat-disposition-counter-section) |
| 4574 | Fold every `sweep.disposed` row (any | [repeatDispositionStreaksFromLedger](docs/forensics/sweep.md#repeatdispositionstreaksfromledger) |
| 4635 | Render the repeat-bound trip as | [renderRepeatEscalationQuestion](docs/forensics/sweep.md#renderrepeatescalationquestion) |
| 4687 | The ADDITIONAL strikes an operator's | [strikeCapForAnswer](docs/forensics/sweep.md#strikecapforanswer) |
| 4701 | W1-T2452 — THE CUMULATIVE STRIKE | [fixCeilingInForce](docs/forensics/sweep.md#fixceilinginforce) |
| 4726 | W1-T2452 — THE STRIKE BUDGET | [fixDispatchBudget](docs/forensics/sweep.md#fixdispatchbudget) |
| 4758 | W1-T435: the fix rung's OPERATOR-STEERED | [operatorVerdictEvidence](docs/forensics/sweep.md#operatorverdictevidence) |
| 4806 | The block evidence `dispatchFix` carries | [FixDispatchEvidence](docs/forensics/sweep.md#fixdispatchevidence) |
| 4834 | TERMINAL-STATE PREDICATE (W1-T177) — the | [terminalStateReason](docs/forensics/sweep.md#terminalstatereason) |
| 4857 | One fresh, live read of | [LiveStateResult](docs/forensics/sweep.md#livestateresult) |
| 4870 | The outcome names `armAutoMerge` returns | [ArmOutcomeName](docs/forensics/sweep.md#armoutcomename) |
| 4886 | W1-T947: `armAutoMergeAtOpen` refused because the | [lines 4886-4888](docs/forensics/sweep.md#lines-4886-4888) |
| 4890 | W1-T1000002: `attemptArm` refused because an | [lines 4890-4892](docs/forensics/sweep.md#lines-4890-4892) |
| 4895 | W1-T1117: `armFailureAction`'s (run-task.ts) return value, | [ArmFailureClass](docs/forensics/sweep.md#armfailureclass) |
| 4904 | W1-T1117: the richer shape `SweepDeps.arm` | [ArmAttemptOutcome](docs/forensics/sweep.md#armattemptoutcome) |
| 4918 | TRUE only for outcomes that | [armOutcomeArmed](docs/forensics/sweep.md#armoutcomearmed) |
| 4944 | W1-T2231 — the SAME "undefined | [dispatchFixSpent](docs/forensics/sweep.md#dispatchfixspent) |
| 4960 | Arm GitHub auto-merge (armAutoMerge). Idempotent | [SweepDeps.arm](docs/forensics/sweep.md#sweepdeps-arm) |
| 4982 | W1-T1000002 — WITHDRAW AN ARM | [disarmAutoMerge](docs/forensics/sweep.md#disarmautomerge) |
| 5000 | Invoke the W1-T54 dep-review lane | [depReview](docs/forensics/sweep.md#depreview) |
| 5010 | Invoke the review lane (reviewCommand) | [postReview](docs/forensics/sweep.md#postreview) |
| 5031 | W1-T2853 — choose this pass's | [selectAdaptiveReviewWidth](docs/forensics/sweep.md#selectadaptivereviewwidth) |
| 5041 | W1-T2584 — MAY THE BOUNDED | [continueReviewAdmissions](docs/forensics/sweep.md#continuereviewadmissions) |
| 5054 | Dispatch the W1-T76 fix rung | [dispatchFix](docs/forensics/sweep.md#dispatchfix) |
| 5075 | Escalate a BLOCKED-AMBIGUOUS PR. `question` | [escalate](docs/forensics/sweep.md#escalate) |
| 5082 | W1-T1223 (design ii/iv) — re-queue | [requeueCheck](docs/forensics/sweep.md#requeuecheck) |
| 5092 | W1-T1223 (design iii) — a | [escalateCancelledCheck](docs/forensics/sweep.md#escalatecancelledcheck) |
| 5101 | W1-T1275 (design ii/iii) — an | [readCiGateRollup](docs/forensics/sweep.md#readcigaterollup) |
| 5115 | W1-T1275 (design ii/iv) — re-drive | [reaggregateCiGate](docs/forensics/sweep.md#reaggregatecigate) |
| 5127 | W1-T177: an OPTIONAL fresh re-read | [readLiveState](docs/forensics/sweep.md#readlivestate) |
| 5145 | W1-T254 (the #707 fix's LIGHT-SWEEP | [actionable](docs/forensics/sweep.md#actionable) |
| 5165 | W1-T2426 — WHY {@link SweepDeps.actionable} | [SweepDeps.standDownReasonFor](docs/forensics/sweep.md#sweepdeps-standdownreasonfor) |
| 5187 | W1-T2379 — DO NOT AWAIT | [detachFixWait](docs/forensics/sweep.md#detachfixwait) |
| 5205 | THE ABSENT-CHECK-SUITE REMEDY (W1-T186 follow-up). | [repushAbsent](docs/forensics/sweep.md#repushabsent) |
| 5212 | W1-T528 — press the update-branch | [updateBranch](docs/forensics/sweep.md#updatebranch) |
| 5222 | W1-T528: task ids with a | [inFlightTaskIds](docs/forensics/sweep.md#inflighttaskids) |
| 5229 | W1-T1212 — per red PR, | [staleGateWorkflowsByPr](docs/forensics/sweep.md#stalegateworkflowsbypr) |
| 5240 | W1-T1212 (design note iv, "never | [updatedForWorkflow](docs/forensics/sweep.md#updatedforworkflow) |
| 5250 | W1-T2620 (design i) — an | [readMainTip](docs/forensics/sweep.md#readmaintip) |
| 5264 | W1-T2620 (design iv) — RELEASE | [releaseBaseCausedStandDown](docs/forensics/sweep.md#releasebasecausedstanddown) |
| 5298 | W1-T905 — "repair the instance, | [captureRepairFeedback](docs/forensics/sweep.md#capturerepairfeedback) |
| 5317 | W1-T931 COST-ANOMALY SENTINEL — the | [costAnomalyPolicy](docs/forensics/sweep.md#costanomalypolicy) |
| 5339 | W1-T254: set when this PR's | [actionError](docs/forensics/sweep.md#actionerror) |
| 5346 | W1-T2231 — set ONLY for | [spent](docs/forensics/sweep.md#spent) |
| 5373 | W1-T99: how many gated effects | [actionsFailed](docs/forensics/sweep.md#actionsfailed) |
| 5395 | `pr@head` keys, exactly like `armed`/`fixed`/`depReviewed` | [escalated](docs/forensics/sweep.md#escalated) |
| 5408 | exact-input keys with a DELIVERED | [reviewDelivered](docs/forensics/sweep.md#reviewdelivered) |
| 5425 | Exact-input keys with an explicit | [PriorActions.reviewRefused](docs/forensics/sweep.md#prioractions-reviewrefused) |
| 5455 | W1-T970 — `${prNumber}@${headSha}` keys, built | [PriorActions.riskRefused](docs/forensics/sweep.md#prioractions-riskrefused) |
| 5474 | ABSENT-check-suite re-push history, read from | [absentRepushes](docs/forensics/sweep.md#absentrepushes) |
| 5484 | One review outcome key. Fully | [reviewOutcomeKey](docs/forensics/sweep.md#reviewoutcomekey) |
| 5504 | W1-T529 (iv) — WHAT EACH | [BUDGET_FLOOR_LANE_COST](docs/forensics/sweep.md#budget-floor-lane-cost) |
| 5518 | Design (iv), verbatim: "A SKIPPED | [lines 5518-5520](docs/forensics/sweep.md#lines-5518-5520) |
| 5538 | W1-T529 (iv) — IS THIS | [budgetFloorStandDown](docs/forensics/sweep.md#budgetfloorstanddown) |
| 5569 | W1-T1213 — is `reason` the | [isReopenedClosedLifecycleRefusal](docs/forensics/sweep.md#isreopenedclosedlifecyclerefusal) |
| 5649 | W1-T970: OUTCOME-KEYED off the risk | [lines 5649-5652](docs/forensics/sweep.md#lines-5649-5652) |
| 5655 | W1-T1116: carry `issue_url` along with | [lines 5655-5658](docs/forensics/sweep.md#lines-5655-5658) |
| 5725 | W1-T1110 — HAS THE MOST | [fixRungStalledWithoutNewHead](docs/forensics/sweep.md#fixrungstalledwithoutnewhead) |
| 5801 | ── W1-T905 — "repair the | [lines 5801-5811](docs/forensics/sweep.md#lines-5801-5811) |
| 5813 | The dispositions {@link priorActionsFromLedger}'s own | [REPAIR_SURFACE_DISPOSITIONS](docs/forensics/sweep.md#repair-surface-dispositions) |
| 5844 | Deterministic — `fb-repair-<surface>-<window-bucket>` (mirrors `src/lib/issues-intake.ts`'s | [id](docs/forensics/sweep.md#id) |
| 5851 | PURE fold over already-written `sweep.disposed` | [dueRepairFilings](docs/forensics/sweep.md#duerepairfilings) |
| 5897 | W1-T2231: `acted: true` only proves | [lines 5897-5901](docs/forensics/sweep.md#lines-5897-5901) |
| 5910 | Last-write-wins per PR (lines are | [lines 5910-5914](docs/forensics/sweep.md#lines-5910-5914) |
| 5952 | Render ONE due surface's evidence | [renderRepairFilingRaw](docs/forensics/sweep.md#renderrepairfilingraw) |
| 5986 | W1-T513 — THE CROSS-CALL REVIEW-KEY | [inFlightReviewKeys](docs/forensics/sweep.md#inflightreviewkeys) |
| 6012 | W1-T2520 — THE FIX-DISPATCH MUTEX, | [inFlightFixKeys](docs/forensics/sweep.md#inflightfixkeys) |
| 6053 | W1-T2788 — select the fix-rung | [fixLedgerRowsForHead](docs/forensics/sweep.md#fixledgerrowsforhead) |
| 6116 | W1-T2520 — the fresh under-claim | [freshFixDispatchCount](docs/forensics/sweep.md#freshfixdispatchcount) |
| 6151 | W1-T2379 — THE DETACHED-WAIT REGISTRY, | [detachedSweepActions](docs/forensics/sweep.md#detachedsweepactions) |
| 6181 | W1-T2379: hand a started action | [detachSweepAction](docs/forensics/sweep.md#detachsweepaction) |
| 6197 | W1-T2379 — LET WORK ALREADY | [drainDetachedSweepActions](docs/forensics/sweep.md#draindetachedsweepactions) |
| 6216 | THE SHARED ENTRY POINT (acceptance | [runSweep and orderPendingReviews](docs/forensics/sweep.md#runsweep-and-orderpendingreviews) |
| 6325 | Dedup is keyed on the | [ledgerLines](docs/forensics/sweep.md#ledgerlines) |
| 6340 | W1-T2620 (design i) — ONE | [mainTipSha](docs/forensics/sweep.md#maintipsha) |
| 6345 | W1-T2620 (design ii/iii) — AT | [baseCausedReleaseTarget](docs/forensics/sweep.md#basecausedreleasetarget) |
| 6379 | ── W1-T931 COST-ANOMALY SENTINEL ─────────────────────────────────────────────────────────── | [lines 6379-6390](docs/forensics/sweep.md#lines-6379-6390) |
| 6403 | Filled by INDEX, never pushed | [actions](docs/forensics/sweep.md#actions) |
| 6409 | W1-T905: this pass's OWN newly-appended | [passDisposedRows](docs/forensics/sweep.md#passdisposedrows) |
| 6423 | ── W1-T473/W1-T513 — REVIEW CONCURRENCY | [claimedReviewKeys](docs/forensics/sweep.md#claimedreviewkeys) |
| 6438 | W1-T2771 — CLAIM AT ACTION | [claimReview](docs/forensics/sweep.md#claimreview) |
| 6490 | W1-T2520 — CLAIM THIS PR'S | [claimFixDispatch](docs/forensics/sweep.md#claimfixdispatch) |
| 6514 | READ UNDER THE CLAIM: a | [freshLines](docs/forensics/sweep.md#freshlines) |
| 6548 | W1-T513: carried alongside the job | [reviewKey](docs/forensics/sweep.md#reviewkey) |
| 6555 | The tail every disposition shares | [finalizeDisposition](docs/forensics/sweep.md#finalizedisposition) |
| 6583 | W1-T2620 (design v): the release | [baseCausedMainTipSha](docs/forensics/sweep.md#basecausedmaintipsha) |
| 6615 | W1-T254: the exact ambiguity that | [lines 6615-6619](docs/forensics/sweep.md#lines-6615-6619) |
| 6623 | One ledger line per disposition | [lines 6623-6627](docs/forensics/sweep.md#lines-6623-6627) |
| 6629 | W1-T2345 — this PASS's own | [repeat](docs/forensics/sweep.md#repeat) |
| 6647 | W1-T2345: `repeat_streak` rides every row | [lines 6647-6651](docs/forensics/sweep.md#lines-6647-6651) |
| 6654 | W1-T1061: the FIELD sibling to | [lines 6654-6659](docs/forensics/sweep.md#lines-6654-6659) |
| 6661 | W1-T2231: present ONLY when the | [lines 6661-6664](docs/forensics/sweep.md#lines-6661-6664) |
| 6667 | W1-T2620 (design v) — rides | [lines 6667-6670](docs/forensics/sweep.md#lines-6667-6670) |
| 6674 | W1-T905: mirrored in-memory, with THIS | [lines 6674-6677](docs/forensics/sweep.md#lines-6674-6677) |
| 6685 | ── PER-PASS HEARTBEAT, WRITTEN BEFORE | [the per-pass heartbeat row](docs/forensics/sweep.md#the-per-pass-heartbeat-row) |
| 6725 | W1-T2345 — THE UNBOUNDED-IDENTICAL-DISPOSITION COUNTER, | [priorRepeatRun](docs/forensics/sweep.md#priorrepeatrun) |
| 6738 | Skipped entirely under --dry-run (a | [lines 6738-6741](docs/forensics/sweep.md#lines-6738-6741) |
| 6744 | W1-T2381: THE LEDGER ROW IS | [sweep.repeat_escalated — the ledger row is the output](docs/forensics/sweep.md#sweep-repeat-escalated-the-ledger-row-is-the-output) |
| 6760 | W1-T254 per-PR throw containment, KEPT | [log](docs/forensics/sweep.md#log) |
| 6770 | W1-T196: a blocked-ambiguous PR that | [unattributableFiling](docs/forensics/sweep.md#unattributablefiling) |
| 6781 | W1-T78: render the clarification question | [question](docs/forensics/sweep.md#question) |
| 6793 | W1-T1000002: set ONLY by the | [lines 6793-6796](docs/forensics/sweep.md#lines-6793-6796) |
| 6798 | W1-T1110: set ONLY by the | [lines 6798-6803](docs/forensics/sweep.md#lines-6798-6803) |
| 6807 | PREFER OBSERVED STATE: GitHub's own | [riskRefusedKey](docs/forensics/sweep.md#riskrefusedkey) |
| 6824 | W1-T1000002: A HOLD IS A | [hold](docs/forensics/sweep.md#hold) |
| 6835 | W1-T1116: NAME WHICH DISJUNCT FIRED | [lines 6835-6841](docs/forensics/sweep.md#lines-6835-6841) |
| 6847 | Design (i): carry the SAME | [issueUrl](docs/forensics/sweep.md#issueurl) |
| 6864 | W1-T1110 — RE-ARM A STALLED | [lines 6864-6872](docs/forensics/sweep.md#lines-6864-6872) |
| 6883 | W1-T2427: NAME THE DEDUP. Same | [lines 6883-6887](docs/forensics/sweep.md#lines-6883-6887) |
| 6919 | W1-T254: OUTCOME-keyed — see PriorActions.reviewDelivered/reviewRefused's | [reviewKey (lines 6919-6929)](docs/forensics/sweep.md#reviewkey-lines-6919-6929) |
| 6935 | W1-T2427 — THE SENTENCE MUST | [lines 6935-6943](docs/forensics/sweep.md#lines-6935-6943) |
| 6956 | W1-T114: WAIT never gates an | [lines 6956-6961](docs/forensics/sweep.md#lines-6956-6961) |
| 6963 | W1-T1116 (design iv) — the | [lines 6963-6968](docs/forensics/sweep.md#lines-6963-6968) |
| 6975 | W1-T2789: a prior blocked-ambiguous escalation | [lines 6975-6978](docs/forensics/sweep.md#lines-6975-6978) |
| 6988 | W1-T177: set ONLY when the | [lines 6988-6994](docs/forensics/sweep.md#lines-6988-6994) |
| 6996 | W1-T1061: the FIELD twin of | [lines 6996-7001](docs/forensics/sweep.md#lines-6996-7001) |
| 7003 | W1-T2231: set ONLY by the | [lines 7003-7006](docs/forensics/sweep.md#lines-7003-7006) |
| 7008 | W1-T2620 (design v): set ONLY | [lines 7008-7011](docs/forensics/sweep.md#lines-7008-7011) |
| 7013 | W1-T254 — PER-PR THROW CONTAINMENT: | [lines 7013-7017](docs/forensics/sweep.md#lines-7013-7017) |
| 7019 | W1-T473: set true ONLY by | [lines 7019-7022](docs/forensics/sweep.md#lines-7019-7022) |
| 7026 | W1-T254 — LIGHT-SWEEP RESTRICTION: `actionable` | [lines 7026-7035](docs/forensics/sweep.md#lines-7026-7035) |
| 7046 | ARMING PARITY (see decideSweepArm): the | [armDecision](docs/forensics/sweep.md#armdecision) |
| 7063 | W1-T1117: `deps.arm` may return the | [armOutcomeName](docs/forensics/sweep.md#armoutcomename) |
| 7068 | W1-T1061: capture the concrete outcome | [lines 7068-7071](docs/forensics/sweep.md#lines-7068-7071) |
| 7078 | W1-T1117 (design ii/iv): an `arm-error-ignored` | [failureClass](docs/forensics/sweep.md#failureclass) |
| 7096 | W1-T177 — TERMINAL-STATE CHECK AT | [live](docs/forensics/sweep.md#live) |
| 7108 | FAIL OPEN, ledgered: the read | [log (lines 7108-7112)](docs/forensics/sweep.md#log-lines-7108-7112) |
| 7121 | W1-T527 — CLASSIFY BEFORE SELECTING, | [redCause](docs/forensics/sweep.md#redcause) |
| 7131 | W1-T2620 — THE BASE-CAUSED STAND-DOWN'S | [lines 7131-7140](docs/forensics/sweep.md#lines-7131-7140) |
| 7146 | The "released" sentence is set | [lines 7146-7150](docs/forensics/sweep.md#lines-7146-7150) |
| 7158 | FAIL QUIET (design vi) — | [log (lines 7158-7161)](docs/forensics/sweep.md#log-lines-7158-7161) |
| 7172 | W1-T1275 (design i/ii/iii/iv/v) — CI-GATE'S | [ciGateRollup](docs/forensics/sweep.md#cigaterollup) |
| 7192 | LEDGERED BEFORE THE CALL (design | [appendLine](docs/forensics/sweep.md#appendline) |
| 7216 | W1-T1223 (design i/ii/iii/iv/v) — A | [cancelledChecks](docs/forensics/sweep.md#cancelledchecks) |
| 7227 | W1-T2431: OR the ledger-derived reading | [decision](docs/forensics/sweep.md#decision) |
| 7236 | LEDGERED BEFORE THE CALL (design | [appendLine (lines 7236-7240)](docs/forensics/sweep.md#appendline-lines-7236-7240) |
| 7261 | A cancelled check carries no | [genuineFailures](docs/forensics/sweep.md#genuinefailures) |
| 7277 | W1-T100: the evidence shape follows | [fixEvidence](docs/forensics/sweep.md#fixevidence) |
| 7297 | W1-T2520 — THE FIX-DISPATCH CLAIM: | [fixClaim](docs/forensics/sweep.md#fixclaim) |
| 7334 | The DISPOSITION_RULES "conflicted" row already | [conflictedEvidence](docs/forensics/sweep.md#conflictedevidence) |
| 7363 | W1-T2789 — an exhausted checks-red | [lines 7363-7368](docs/forensics/sweep.md#lines-7363-7368) |
| 7441 | W1-T196: stand down instead of | [absentDecision](docs/forensics/sweep.md#absentdecision) |
| 7454 | THE REMEDY. Fires INSTEAD OF | [oldHead](docs/forensics/sweep.md#oldhead) |
| 7460 | LEDGERED, because #968's lesson was | [lines 7460-7466](docs/forensics/sweep.md#lines-7460-7466) |
| 7484 | `acted` stays FALSE, and this | [lines 7484-7489](docs/forensics/sweep.md#lines-7484-7489) |
| 7517 | W1-T473: NEVER await inline — | [lines 7517-7523](docs/forensics/sweep.md#lines-7517-7523) |
| 7533 | W1-T529 (iv) — DEGRADE, DO | [floorStandDown](docs/forensics/sweep.md#floorstanddown) |
| 7545 | W1-T99 — the canonical crash | [appendLine (lines 7545-7551)](docs/forensics/sweep.md#appendline-lines-7545-7551) |
| 7566 | W1-T1000002 — CONVERGE: WITHDRAW WHAT | [lines 7566-7573](docs/forensics/sweep.md#lines-7566-7573) |
| 7600 | W1-T2771: discovery is not execution | [reviewKey (lines 7600-7603)](docs/forensics/sweep.md#reviewkey-lines-7600-7603) |
| 7626 | ── W1-T1049 — REVIEW CONCURRENCY | [the review lane's concurrency budget wiring](docs/forensics/sweep.md#the-review-lane-s-concurrency-budget-wiring) |
| 7667 | NOT AN ERASING CATCH, and | [closeAdmissions](docs/forensics/sweep.md#closeadmissions) |
| 7717 | W1-T529 (iv) — THE ONE | [the one throw that must not leave a dedup key](docs/forensics/sweep.md#the-one-throw-that-must-not-leave-a-dedup-key) |
| 7756 | W1-T529 design (v)/W1-T2753 — THE | [appendLine (lines 7756-7762)](docs/forensics/sweep.md#appendline-lines-7756-7762) |
| 7783 | W1-T513: release `job.reviewKey` from the | [lines 7783-7793](docs/forensics/sweep.md#lines-7783-7793) |
| 7812 | W1-T2584 — FIXED-SIZE PULL POOL. | [workerCount](docs/forensics/sweep.md#workercount) |
| 7828 | Only a named admission stop | [unstartedReviews](docs/forensics/sweep.md#unstartedreviews) |
| 7864 | W1-T520 — the stall report. | [stalled](docs/forensics/sweep.md#stalled) |
| 7882 | W1-T528 — PRESS THE BUTTON. | [lines 7882-7886](docs/forensics/sweep.md#lines-7882-7886) |
| 7934 | W1-T905 — "repair the instance, | [lines 7934-7941](docs/forensics/sweep.md#lines-7934-7941) |
| 7959 | W1-T463 — THE DIAGNOSIS FOR | [runSweepLightPass](docs/forensics/sweep.md#runsweeplightpass) |
| 8006 | W1-T526/W1-T2792 — THE QUEUE-ADMISSION RULE | [now](docs/forensics/sweep.md#now) |
| 8011 | W1-T2439/W1-T2792: the light pass admits | [readLedger](docs/forensics/sweep.md#readledger) |
| 8034 | Known outcome-deduped heads did not | [outcomeDedupedNumbers](docs/forensics/sweep.md#outcomededupednumbers) |
| 8061 | W1-T2426 (criterion 7): name the | [standDownReasonFor](docs/forensics/sweep.md#standdownreasonfor) |
| 8110 | W1-T526 — WHICH OPEN PRS, | [selectReviewAdmission](docs/forensics/sweep.md#selectreviewadmission) |
| 8152 | W1-T2439 (half two) — THE | [selectReviewAdmissions](docs/forensics/sweep.md#selectreviewadmissions) |
| 8187 | W1-T2583: selection and execution must | [eligible](docs/forensics/sweep.md#eligible) |
| 8230 | W1-T2426 — THE ADMISSION KEY, | [reviewAdmissionKey](docs/forensics/sweep.md#reviewadmissionkey) |
| 8263 | THE OLDEST-HEAD-FIRST COMPARATOR ITSELF — | [oldestActivityFirst](docs/forensics/sweep.md#oldestactivityfirst) |
| 8280 | W1-T2426 — THE RANKING ITSELF, | [oldestByKey](docs/forensics/sweep.md#oldestbykey) |
| 8327 | ──────────────────────────────────────────────────────────────────────────── // W1-T121 — the | [the queue governor section](docs/forensics/sweep.md#the-queue-governor-section) |
| 8358 | The queue governor's pure predicate | [checkQueueGovernor](docs/forensics/sweep.md#checkqueuegovernor) |
| 8378 | A throttled pass is NOT | [logQueueGovernorDeferral](docs/forensics/sweep.md#logqueuegovernordeferral) |
| 8400 | ──────────────────────────────────────────────────────────────────────────── // W1-T148 — the | [the cost governor section](docs/forensics/sweep.md#the-cost-governor-section) |
| 8418 | Sums ONE ledgered dollar figure | [deriveWindowCostUsd](docs/forensics/sweep.md#derivewindowcostusd) |
| 8485 | The day's ledgered cost — | [deriveDayCostUsd](docs/forensics/sweep.md#derivedaycostusd) |
| 8497 | The WEEK-TO-DATE ledgered cost (W1-T159): | [deriveWeekCostUsd](docs/forensics/sweep.md#deriveweekcostusd) |
| 8519 | The cost governor's pure predicate: | [checkCostGovernor](docs/forensics/sweep.md#checkcostgovernor) |
| 8547 | A throttled pass is NOT | [logCostGovernorDeferral](docs/forensics/sweep.md#logcostgovernordeferral) |
| 8569 | ──────────────────────────────────────────────────────────────────────────── // W1-T1038 — the | [the memory governor section](docs/forensics/sweep.md#the-memory-governor-section) |
| 8606 | The memory governor's pure predicate | [checkMemoryGovernor](docs/forensics/sweep.md#checkmemorygovernor) |
| 8637 | THE OBSERVATION IS LEDGERED ON | [logMemoryObservation](docs/forensics/sweep.md#logmemoryobservation) |
| 8670 | How many CONSECUTIVE `sweep.post_review.failed` lines | [POST_REVIEW_STALL_THRESHOLD](docs/forensics/sweep.md#post-review-stall-threshold) |
| 8693 | The run's error text with | [normalisedError](docs/forensics/sweep.md#normalisederror) |
| 8701 | true when every failure in | [rateLimited](docs/forensics/sweep.md#ratelimited) |
| 8716 | Is the sweep's post-review path | [detectPostReviewStall](docs/forensics/sweep.md#detectpostreviewstall) |
| 8751 | ──────────────────────────────────────────────────────────────────────────── // W1-T150 — the | [the credit-backfill section](docs/forensics/sweep.md#the-credit-backfill-section) |
| 8767 | One task's observed merge-credit candidacy | [CreditCandidate](docs/forensics/sweep.md#creditcandidate) |
| 8803 | `hasMergeCredit` USED TO LIVE HERE | [the removed hasMergeCredit helper](docs/forensics/sweep.md#the-removed-hasmergecredit-helper) |
| 8822 | THE CREDIT-BACKFILL RUNG (W1-T150). For | [runCreditBackfill](docs/forensics/sweep.md#runcreditbackfill) |
| 8847 | THE CREDIT QUESTION IS "EVER", | [credited](docs/forensics/sweep.md#credited) |
| 8879 | Reflected into THIS pass's own | [lines 8879-8884](docs/forensics/sweep.md#lines-8879-8884) |
| 8889 | LOG ONLY WHAT WAS ACTED | [lines 8889-8896](docs/forensics/sweep.md#lines-8889-8896) |
| 8915 | ── ESCALATION-LIFECYCLE RECONCILER (fb-1784756088300-6a481e) ────────────────── | [the escalation-lifecycle reconciler section](docs/forensics/sweep.md#the-escalation-lifecycle-reconciler-section) |
| 8938 | QUEUE LABELS this reconciler retires | [RETIRABLE_ESCALATION_LABELS](docs/forensics/sweep.md#retirable-escalation-labels) |
| 8950 | List every OPEN issue across | [listRetirableEscalationIssues](docs/forensics/sweep.md#listretirableescalationissues) |
| 8975 | W1-T347: the W1-T346 ask-type classification | [askType](docs/forensics/sweep.md#asktype) |
| 9024 | What the candidate BUILDER saw | [intake](docs/forensics/sweep.md#intake) |
| 9032 | The closing citation posted on | [renderReconcileCloseComment](docs/forensics/sweep.md#renderreconcileclosecomment) |
| 9053 | W1-T347 — the guard {@link | [renderMootedCloseComment](docs/forensics/sweep.md#rendermootedclosecomment) |
| 9088 | Reconcile OPEN needs-human issues against | [runEscalationReconcile](docs/forensics/sweep.md#runescalationreconcile) |
| 9174 | `total: 0` USED TO BE | [intake (lines 9174-9180)](docs/forensics/sweep.md#intake-lines-9174-9180) |
| 9196 | ── POST-FIX RE-VERIFICATION RECONCILER (W1-T124) | [the post-fix re-verification reconciler section](docs/forensics/sweep.md#the-post-fix-re-verification-reconciler-section) |
| 9242 | One failure-pattern -> fix-PR class | [FixClass](docs/forensics/sweep.md#fixclass) |
| 9262 | The 2026-07-19 regression fixture's own | [CI_GATE_TIMEOUT_FIX_CLASS](docs/forensics/sweep.md#ci-gate-timeout-fix-class) |
| 9283 | W1-T474 row 1 — the | [COVERAGE_TIER_FIX_CLASS](docs/forensics/sweep.md#coverage-tier-fix-class) |
| 9304 | W1-T474 row 2 — the | [CAPABILITY_SNAPSHOT_FIX_CLASS](docs/forensics/sweep.md#capability-snapshot-fix-class) |
| 9324 | The live class table this | [DIFF_COVERAGE_BLOCK_RE](docs/forensics/sweep.md#diff-coverage-block-re) |
| 9343 | REPORTS a diff-scoped coverage block | [diffCoverageReport](docs/forensics/sweep.md#diffcoveragereport) |
| 9378 | The injected redrive effect's outcome. | [RedriveResult](docs/forensics/sweep.md#redriveresult) |
| 9396 | Re-drive the PR's matched required | [redrive](docs/forensics/sweep.md#redrive) |
| 9410 | OPTIONAL reader for a PR's | [readCiFailures](docs/forensics/sweep.md#readcifailures) |
| 9449 | THE POST-FIX RE-VERIFICATION RUNG (W1-T124, | [runPostFixReverification](docs/forensics/sweep.md#runpostfixreverification) |
| 9471 | Alias-bound call site (W1-T2393): the | [readLedger (lines 9471-9474)](docs/forensics/sweep.md#readledger-lines-9471-9474) |
| 9484 | W1-T977: the shared snapshot's own | [lines 9484-9490](docs/forensics/sweep.md#lines-9484-9490) |
| 9507 | Head-keyed dedup (mirrors runSweep's fix-dispatch | [redriveKey](docs/forensics/sweep.md#redrivekey) |
| 9528 | PER-PR THROW CONTAINMENT (the W1-T99 | [log (lines 9528-9531)](docs/forensics/sweep.md#log-lines-9528-9531) |
