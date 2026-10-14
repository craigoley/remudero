# PR #4045 — which head merged while a review-gate fix was in flight? (W1-T4464)

**Scope:** W1-T4464. Read-only forensic pass: one artifact plus its docs-index entry; no source,
script, test or plan record edited, no remedy preselected. The question, from the W1-T2866 follow-up
harvest (run `DAEMON-1788584618629`): "`remudero-fleet[bot]` merged a stale head while a
review-gate fix worker was actively in flight." What does *stale* mean here, where is the gap
between fix ownership and merge authority, and is it systemic?

## Method and evidence that could not be pulled

- **Ledger.** Every rotated archive `state/ledger.*.ndjson.gz` (476 files, first row
  2026-08-08T21:59Z) plus the live `state/ledger.ndjson` (newest row 2026-10-14T02:02Z), read as a
  union (4,478,115 raw rows). `state/ledger-superseded/` was read only for the incident window
  (3 rows naming the run id) and is NOT part of the census.
- **Git.** `git fetch origin refs/pull/4045/head` (head `87ca5adab`), `git ls-remote origin
  'refs/pull/4045/*' 'refs/heads/run-W1-T2866-*'`, and commit/committer metadata for `7528cb75c`.
- **Source.** HEAD of this branch (origin/main `c49144e04`) **and** the daemon's boot sha for the
  incident, `3cf17c575` (`daemon.boot` row, committed 2026-09-05T05:02:31Z). Where they differ, both
  are named.
- **NOT READ — GitHub's own event stream.** `gh api repos/craigoley/remudero/pulls/4045` was
  refused by `deny-floor.sh` (W1-T3275, 180 s read floor; every attempt reported "0s after the last
  one", so the floor was not overridden — `RMD_GH_COOLDOWN_S=0` is the operator's choice). So the
  PR **timeline events, `merged_by`, the auto-merge-enabled event and actor, the check-run attempts
  and the PR body's edit history are UNREAD.** Every row below that would have come from them says
  so. The merge instant is taken from the squash commit's committer date (GitHub is the committer),
  which is GitHub's own timestamp, not a ledger inference.

## EVIDENCE TIMELINE

All times UTC, 2026-09-05. Head SHA is the PR's remote head; `87ca5ad` = `87ca5adab68f96b62c60b3d06b9118c8ca9c4ae6`.
PR number 4045 on every row. "src" is where the row came from.

| time | head | actor / run id | event | src |
|---|---|---|---|---|
| 04:51:31 | `87ca5ad` | cao825 (author) | PR head commit authored (single commit over `47869abeb`, +26/−1 on W1-T2857's plan shard) | git |
| 04:52:40–05:02:34 | `87ca5ad` | `DAEMON-1788583232559` | five `sweep.disposed` rows: `wait`, checks pending | ledger |
| 05:03:38 | — | `DAEMON-1788584618629` | the run that will harvest the incident boots on `3cf17c575` | ledger |
| 05:05:41 | `87ca5ad` | `DAEMON-1788584618629` | `sweep.post_review.attempt` | ledger |
| 05:05:48 | `87ca5ad` | `review-PR4045-1788584747351` | `review.pending_posted`, input digest `v1:2413d712…` | ledger |
| 05:05:55 | `87ca5ad` | same | `automerge.disarmed` ("remudero-review is not success") — nothing was armed | ledger |
| 05:05:56 | `87ca5ad` | same | `review.posted` **failure**: criterion 3 ("empty or unreadable mount inspection remains a failed postcondition…", `unit test: test/container-runtime-contract.test.ts`) executed and failed; `planOnly:true` | ledger |
| 05:09:04 | `87ca5ad` | `DAEMON-1788584618629` | `sweep.disposed` `blocked-fixable` ("1 unmet criterion — strike 1/2"); `sweep.fix.synthetic_task` | ledger |
| ≈05:09:08 | `87ca5ad` | fix worker (`session c15e40e6…`) | **fix worker active** — start derived as the `fix.dispatch` row's ts minus its `elapsed_ms` (559 206 ms). The ledger has no row at the START of a fix: `fix.dispatch` is written at the end | ledger (derived) |
| 05:13:22 | — | GitHub (#4041) | main advances to `fa2105c03`; PR #4045 is now **2 commits behind** (`3cf17c575`, `fa2105c03`) | git |
| 05:13:36 | `87ca5ad` | `DAEMON-1788584618629` | `sweep.disposed` `blocked-fixable`, `acted:false`: "duplicate fix-dispatch key (W1-T2866@87ca5ad…) already claimed this pass — a concurrent sweep is already dispatching this PR's fix rung" — **the sweep knew the fix was in flight** | ledger |
| 05:14:43 | `87ca5ad` | `DAEMON-1788584618629` | `sweep.post_review.attempt` — disposition `post-review`: "checks green, remudero-review failed but the PR has seen activity since that verdict was posted … the exact current input has no completed judgment" | ledger |
| 05:14:52 | `87ca5ad` | `review-PR4045-1788585291153` | `review.pending_posted`, input digest `v1:a8f6d422…` — **a different digest from 05:05:48 on the same head** | ledger |
| 05:14:54.976 | `87ca5ad` | same | `review.posted` **success**, `planOnly:true`, `capped:true`, five criteria — **different claims from the failed verdict's five** (the PR body had changed) | ledger |
| **05:14:56** | `87ca5ad` | GitHub (committer) | **squash commit `7528cb75c`** created; its changed lines are byte-identical to the PR head's patch (sorted `+/−` lines hash equal) and `refs/pull/4045/head` still reads `87ca5ad` | git |
| 05:14:58.021 | `87ca5ad` | same review run | `automerge.armed`, outcome `armed` (ledgered **after** the merge instant — `gh pr merge --auto` on a PR already satisfying every required check merges immediately) | ledger |
| 05:18:27.424 | `87ca5ad` | `DAEMON-1788584618629` | `fix.dispatch` (strike 1/2, `round:resume`, `elapsed_ms 559206`) and `fix.done` (`success`, 51 turns, $1.63); `report.followups`: "PR #4045 was squash-merged (commit `7528cb75`) before this round's corrective commit (`4be6c7c4`, adding the SCOPE BOUNDARY note) reached origin" | ledger |
| 05:18:28 | `87ca5ad` | same | `pr.head_provider` `availability:unavailable`, `reason:live-head-mismatch` | ledger |
| 05:18:29 | — | same | `fix.ci_not_green` ×2 | ledger |
| 05:18:30 | — | same | `fix.stood_down` `rung.strike`: "state is MERGED (only an OPEN PR carries a live block)" | ledger |
| — | — | GitHub | PR timeline, `merged_by`, auto-merge-enabled actor/instant, check-run attempts, PR-body edit history | **UNREAD** |
| — | — | fix worker | who edited the PR body between 05:05:56 and 05:14:52 (digest changed on an unchanged head) | **UNREAD** (no ledger row records a body write) |

Facts this table fixes: the PR had exactly one remote head, `87ca5ad`, for its whole life (the only
`head_sha` on every ledger row; `refs/pull/4045/head` is still `87ca5ad`); no `run-W1-T2866-*`
branch exists on origin; object `4be6c7c4` is not present after fetching the PR head.

## STALE HEAD CLASSIFICATION

Exactly one classification, with the other five meanings tested:

| meaning | verdict | deciding evidence |
|---|---|---|
| obsolete remote head merged | **RULED OUT** | the head merged (`87ca5ad`) is the only head the PR ever had; the squash's patch equals the head's patch |
| **current remote head merged while a newer fix was only local** | **SUPPORTED — the classification** | head before merge `87ca5ad`; merge SHA `7528cb75c`; the fix worker's own report names a corrective commit `4be6c7c4` that "had not reached origin"; `pr.head_provider` read `live-head-mismatch`; `refs/pull/4045/head` stayed `87ca5ad` and `git ls-remote` found no `run-W1-T2866-*` branch (other origin refs were not searched) |
| stale base | **UNDECIDED, not the mechanism** | the PR was 2 commits behind main at merge and branch protection is non-strict, but the diff is one plan shard and the ledger carries no base-related refusal; GitHub's mergeability record is UNREAD |
| stale PR body | **RULED OUT as the merge cause** | the digest *changed* (`2413d712…` → `a8f6d422…`) and a fresh verdict judged the new input before the merge — the review lane did the right thing; this is the reverse of W1-T2851's defect |
| stale review verdict | **RULED OUT** | the merging verdict (05:14:54.976, `success`) is for the exact head and the exact current digest; the superseded failure was replaced, not carried |
| NOT DETERMINABLE | not needed for the classification | but two sub-facts remain UNREAD: who rewrote the body, and the merge-event actor |

Fix-worker SHAs, as asked: observed `87ca5ad` (every ledger row); base `87ca5ad`
(`fix.dispatch.head_sha`); result `4be6c7c4` — **claimed by the worker, never pushed** (not on
origin, not in the object store after fetching the PR head). An unpushed local commit is not the PR
head and this report does not call it one.

Consequence: the "stale" in the harvest is the fix worker's view — it was repairing a head that GitHub
merged under it — not a defect of the merged tree. The merged tree passed a verdict bound to its
exact head and digest. What was lost was the fix worker's unpushed SCOPE BOUNDARY note: it is absent
from `plan/tasks.d/W1-T2857-*.yaml` on main today (`grep -c "SCOPE BOUNDARY"` → 0).

## CANDIDATE MECHANISMS

Every production path that can arm, directly merge, withdraw, dispatch a fix, or push. Source named
at HEAD (`c49144e04`); `†` marks a path that lived elsewhere at the incident sha `3cf17c575`
(arm cluster moved to `src/lib/arm-auto-merge.ts` in W1-T2887).

| mechanism | verdict | deciding symbol and event |
|---|---|---|
| ledger-gated arm (`armAutoMergeDetailed` → `armDetailedSteps` → `decideArmFromLedgerVerdict`) † | **RULED IN as the merge path** — and behaving as designed | `automerge.armed` 05:14:58 on `87ca5ad`; the gate re-reads the live head and the ledger verdict (W1-T230). It has **no input about fix activity** |
| direct-merge fallback (`directMergePreflightSteps`, `mergeDirectViaRest`, outcome `direct-merged`) | **RULED OUT** | the arm row's outcome is `armed`, not `direct-merged`/`direct-merge-*`; W1-T2855's preflight is present at HEAD and was absent at `3cf17c575` (0 matches), so it could not have gated this merge either way |
| withdrawal (`withdrawArmIfVerdictRefuses` / `disarmAutoMerge`, run-task.ts) | **RULED OUT** | its only firing, `automerge.disarmed` 05:05:55, found nothing armed; no arm stood during the fix, so there was nothing to lose a race against (W1-T1215 not engaged) |
| second review admission (`deriveDisposition` row W1-T2299, `reviewVerdictOvertakenByActivity`, `priorReviewAttemptsForInput === 0`, sweep.ts ~9755) | **RULED IN as the trigger** | `sweep.disposed` `post-review` at 05:14:58 re-admitted a failed head while a fix was in flight; its `when` does not read the in-flight fix |
| fix-in-flight visibility to disposition (`inFlightFixKeys`, sweep.ts:13687, written/read only in `claimFixDispatch`) | **RULED IN as the gap** | the set exists and fired at 05:13:36 (`duplicate fix-dispatch key`), but it is a module-level `Set` consulted by one function; neither `deriveDisposition`'s `post-review`/`mergeable` rows nor the arm gate read it |
| W1-T2677 repair claim (`claimRepair`, `repairClaimRef` `refs/rmd-repair/<n>`, dispatch-claim.ts:652–820) | **RULED IN as an unwired input** | `git grep` on origin/main finds **zero callers outside dispatch-claim.ts**: nothing claims a repair before spending, and nothing in the mergeable/arm path reads the claim. At `3cf17c575` the symbol already existed (15 matches) with the same zero production callers |
| fix path posts a pending state before spending | **RULED OUT for this incident** | the fix worker ran 05:09–05:18 with no `remudero-review` pending row of its own; the only `review.pending_posted` rows (05:05:48, 05:14:52) belong to the review lane, and the second *replaced* the failure — nothing in the fix path held the status at pending |
| previously armed PR becoming mergeable during repair | **RULED OUT for #4045** | no arm stood before 05:14:56; the PR became mergeable only because the second verdict made it so. The broader question is answered by the census below |
| fix push (`pr.head_provider` source `fix`, `live-head-mismatch`) | **RULED IN as the loss** | the fix result did not match the live head at 05:18:28; the worker's commit was never pushed because the PR was already merged |
| concurrent sweeps in one daemon | **RULED IN as the substrate** | 05:13:36 shows a second sweep pass overlapping the fix; the daemon runs sweep passes while a 9-minute fix round is awaited |

The linearization gap, stated once: three decisions about one PR head — *dispatch a fix*, *admit a
review*, *admit a merge* — each consult a different store (an in-process `Set`, the ledger's
`review.posted` rows, the live head), and **no single record orders them**. The fix's start is not
even ledgered until the fix ends (`fix.dispatch` is written at 05:18:27 for a round that began
≈05:09:08), so the ledger could not have told any reader the fix was running.

## RECURRENCE CENSUS

**Window:** 2026-08-08T21:59:00Z (first ledger row) → 2026-10-14T02:02Z (live ledger, read
2026-10-14). 476 archives + live ledger; the filtered corpus (`fix.dispatch`, `fix.done`,
`automerge.armed`, `automerge.disarmed`, `fix.stood_down`, `pr.head_provider`) is 20,199 distinct rows
after de-duplicating rows that appear in two rotation files (32,940 before).

**Newest timestamp per corpus (so an old archive cannot manufacture a zero):**
`fix.dispatch` 2026-10-14T01:42:35Z · `automerge.armed` 2026-10-14T02:00:26Z · `automerge.disarmed`
2026-10-14T00:21:35Z · `fix.stood_down` 2026-10-14T01:45:37Z · `pr.head_provider` 2026-10-14T01:45:02Z.
Oldest: `fix.dispatch` 2026-08-12T00:18:52Z · `automerge.armed` 2026-08-08T22:57:35Z.

**Query.** A *fix interval* is a distinct `fix.dispatch` row's `[ts − elapsed_ms, ts]` (the row is
written at the end). An interval is *overlapped* if a same-`task_id` `automerge.armed` row falls in
it (head-matched when both rows carry a head), or an earlier arm stands with no later
`automerge.disarmed` before the interval's end. Partition of overlapped intervals:

- **confirmed race** — overlapped, and a same-task `fix.stood_down` whose reason contains `MERGED`
  lands within 120 s after the fix ends (the PR merged while the fix was active);
- **confirmed safe** — overlapped, and an `automerge.disarmed` for the task falls between the first
  in-interval arm and the end of the fix;
- **NOT DETERMINABLE** — overlapped with neither signal. Also counted separately: 212 intervals with
  no `elapsed_ms` (start unknown) cannot be placed at all.

| bucket | intervals |
|---|---|
| distinct fix intervals | 2 932 |
| no overlap with an arm | 2 154 |
| no `elapsed_ms` — start unplaceable | 212 |
| **confirmed race** | **6** |
| **confirmed safe** | **1** |
| **NOT DETERMINABLE** | **559** (32 with an arm inside the interval; 527 only on a task-level standing arm, a deliberately loose signal because the arm row carries a `task_id` and an old arm of the same task counts) |

The six confirmed races (task, fix end): `RETRO-1788374498685` 2026-09-02T19:45:37Z · **`W1-T2866`
2026-09-05T05:18:27Z (this incident)** · `PR-4188` 2026-09-06T02:19:04Z · `W1-T3217`
2026-09-08T22:27:35Z · `PR-5163` 2026-09-11T21:43:32Z · `RETRO-1789844881088` 2026-09-19T19:47:24Z.
All six had an arm inside the interval; none fall after 2026-09-19 in this corpus.

**Positive controls.** (1) The query classifies this very incident (`W1-T2866`, 05:09:08 → 05:18:27)
as a confirmed race — it can see the corpus. (2) The corpus holds 36 `fix.stood_down … MERGED` rows
and 130 `live-head-mismatch` rows in total, so the MERGED signal is observable, not vacuous.
(3) 7 866 distinct `automerge.armed` rows exist, so "no arm in the interval" is a measured
answer for 2 154 intervals.

**What the number does and does not say.** 6 of 2 932 intervals (0.2 %) ended with the PR merged
under an active fix; the race is real and recurring, not unique to #4045, but rare. It is a floor for
the race and **not** a count of lost work: a `MERGED` stand-down does not say whether the fix had
an unpushed commit, so each of the other five may equally have lost nothing. The 559 NOT
DETERMINABLE intervals are the larger uncertainty and cannot be narrowed from the ledger alone
(GitHub's merge events would). The census is also blind to a merge that completes while a fix is
active but whose fix never reaches `fix.stood_down` with `MERGED`.

## OWNERSHIP DISPOSITION

Criterion by criterion against the six comparison owners. "Owns" means a stated criterion would, if
satisfied at HEAD, have prevented this merge-under-fix.

| task | status | what it decides | owns this mechanism? |
|---|---|---|---|
| W1-T230 | merged | an arm needs the orchestrator's `review.posted` verdict **for the exact live head** | **No.** The gate held: the arm was bound to `87ca5ad`'s verdict. The defect is not a wrong-head arm |
| W1-T1215 | merged | a withdrawn arm can lose to GitHub's queue; the disarm's result must be followed | **No.** No arm stood during the fix, so no withdrawal was attempted or needed |
| W1-T2677 | merged | repairs get an atomic cross-agent claim; the claim "is evidence, not a lock" and holding it never blocks a push | **No, by its own criteria.** It makes a repair *visible*, explicitly not *binding on merge admission*, and at HEAD it has no production caller, so even the visibility is unwired |
| W1-T2722 | merged | two semantic verdicts for **one** decision input must not flip failure to success | **No.** The two verdicts here judged **different** inputs (digests `2413d712…` vs `a8f6d422…`) |
| W1-T2851 | blocked | a success status certifying an **old** PR body is routed to re-review | **No.** The reverse: the body changed and a new verdict was correctly requested; here the re-review itself is the trigger |
| W1-T2855 | merged | a direct merge must refresh a stale base and re-check first | **No.** No direct merge occurred (`armed`, not `direct-merged`); base staleness (2 behind) is UNDECIDED and not the mechanism |

Net: the mechanism that ordered *fix in flight* against *review admission* and *merge admission* is
owned by none of the six. Nearest, W1-T2677, stops at "evidence".

## SUCCESSOR FILING

One narrowly scoped successor is warranted — the falsifier ("file nothing if no stale merge occurred
or an existing task fully owns the mechanism") is **not** met: a merge did occur under an active fix,
it recurs (6 confirmed in the window), and no listed task owns it. Not filed by this task (it edits
no plan record; a plan filing is the Architect's act under standing rule 15); recorded here for that
filing:

- **Title (draft):** "a PR with a fix round in flight can be admitted for review and merge — the fix's
  ownership is not an input to either admission".
- **Required invariant:** for a PR head, at the instant the arm gate or the `post-review`
  disposition admits it, either (a) no fix round holds that PR, or (b) the admission is recorded as an
  *override* that names the fix round it overrode. "Holds" must be decidable from a durable record,
  not the in-process `inFlightFixKeys` `Set`.
- **Production insertion points (candidates, not a chosen remedy):** `claimFixDispatch`
  (src/lib/sweep.ts ~15597) as the place a durable record is first written — today it writes none,
  and `fix.dispatch` is ledgered only at fix end; and a reader of that record in
  `armDetailedSteps` (src/lib/arm-auto-merge.ts ~1020) and/or the `post-review` row's `when`
  (src/lib/sweep.ts ~9755). Wiring `claimRepair` (dispatch-claim.ts:700), which already exists,
  uncalled, is one way to supply the durable record; whether the answer is "block admission",
  "defer the merge", or "make the fix push first" is a design choice this audit does not make.
- **Not in scope of the successor:** the 559 NOT DETERMINABLE intervals (needs GitHub merge events);
  the unread body-edit actor; a ledger row at the START of a fix round (a prerequisite the successor
  may subsume).
- **Falsifier for the successor:** re-run the RECURRENCE CENSUS query after it ships; the confirmed
  race count over a window of comparable length must be 0, with the positive control still reading 6
  historical races.
