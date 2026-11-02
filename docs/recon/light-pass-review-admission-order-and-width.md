# Light-pass review admission: order and width (W1-T10992)

Recon only. This report changes no code, configuration or ledger. Any change it recommends is a separate filing.

## Corpus

- **Window:** 2026-10-26T22:10Z to 2026-11-02T22:10:43.010Z, the 7 days before this task was built. The newest ledger ts read is 2026-11-02T22:10:43.010Z.
- **Ledger forms read** (core instance, `/mnt/rmd/state2/state` on the Azure host; read-only, niced, streamed to the Mac):
  - rotated `ledger.<ts>.ndjson.gz`: 279 files (`ledger.2026-10-26*` to `ledger.2026-11-02T22-04-34-982Z`)
  - live `ledger.ndjson`: 1 file
  - Rows were deduplicated on step, ts, PR and head, because rotation can carry a row into the live file.
- **Steps read:** `sweep.review_refilled` (301 in the window), `sweep.review_eligible`, `sweep.review_admitted` (light and full surfaces), `sweep.disposed` (post-review dispositions, and every row naming a CHANGES_REQUESTED review), `review.capacity`, `review.posted`, `review.post_refused`, `escalation.issue_opened`, `escalation.superseded`, `escalation.demoted`, `pr.terminal`.
- **GitHub reads**, all through the read broker and all read-only:
  - PR `createdAt` for PRs created from 2026-10-10 (#13717 to #16308). This is `reviewAdmissionKey` (`src/lib/sweep.ts:24428`).
  - Issue timelines (`reviewed` and `review_dismissed` events) for the 10 PRs whose sweep rows named a CHANGES_REQUESTED review.
  - Close times of the 45 needs-human escalation issues found at a queue head.

## How admission works (for reading the numbers)

- **The bound.** A light pass admits reviews under `reviewAdmissionBound(width)`, which is `width` minus the reviews in flight (`src/lib/sweep.ts:23741`). Reviews in flight are light reservations, full-pass reviews and review children. Plan-filing children count too, because every full review is registered as `kind: "review"` (`src/lib/sweep.ts:3129`).
- **The width.** `effectiveReviewWidth` (`src/lib/sweep.ts:17494`) asks the adaptive selector. The `cpu-pressure` arm sheds one lane per sample while core cgroup CPU PSI `full` avg10 is at least `cpuPsiHighPct` 20 (`src/lib/review-capacity.ts:281`, `plan/policy.yaml:665`). Width goes back to base 4 only when PSI is at or below 5.
- **Selection.** `selectReviewAdmissions` picks oldest first by `reviewAdmissionKey` (`createdAt`), in two lanes: spawning at the width, plan filings at a literal 3 (`src/lib/sweep.ts:24369`, `:6909`).
- **The refill tail.** `refillTail` is chosen once, when the pass starts (`src/lib/sweep.ts:23859`). `admitOneRefill` (`src/lib/sweep.ts:24099`) admits from it whenever a lane frees, re-reading the width but not the queue.

## 1. Refill jumps

**What counts as a jump.** A `sweep.review_refilled` row R admitted PR A at time tR. Its snapshot was taken at tR − `snapshot_age_ms`. R jumps PR J when all of these hold:

- J's head became review-eligible (`sweep.review_eligible`) after that snapshot and before tR.
- J is older than A by `createdAt`.
- At tR, J was still waiting: not admitted at that head, its head unchanged, and not closed.

The table's "wait after jump" runs from the refill until J was admitted at that head. It is an **upper bound** on the wait the jump added. The counterfactual cannot be read from the ledger, because J could still have lost to the width.

**Totals:**

| Measure | Value |
|---|---|
| Refills in the window | 301 |
| Refills that jumped at least one older eligible PR | 103 (34%) |
| Jump rows (one per jumped PR per refill) | 194, none in the plan lane (181 confirmed in the spawning lane by that PR's own stand-down; 13 unclassified) |
| Distinct jumped heads | 84, on 60 PRs |
| Refill snapshot age | median 16.3 min, p90 51.6 min, max 155 min |
| Width / in-flight on the 194 jump rows | 1 / 0: 150; 4 / 0–3: 33; 2 / 0–1: 9; 3 / 1–2: 2 |

**Wait after the jump**, per row (147 rows where J was later admitted at that head): median 29 min, p75 49 min, p90 65 min, max 171 min.

**Wait per jumped head**, counted from its first jump (64 heads admitted later): median 36 min, p75 53 min, p90 61 min, max 171 min, 41.2 h in total.

| Wait from first jump | Heads |
|---|---|
| under 10 min | 5 |
| 10 to 30 min | 24 |
| 30 to 60 min | 25 |
| 60 to 120 min | 9 |
| 120 min or more | 1 |

**Jumped and never admitted at that head:** 47 rows (34 closed or merged first, 7 head moved, 6 not admitted by the end of the window).

**Rows by day:**

| 10-26 | 10-27 | 10-28 | 10-29 | 10-30 | 10-31 | 11-01 | 11-02 |
|---|---|---|---|---|---|---|---|
| 2 | 37 | 63 | 36 | 15 | 0 | 3 | 38 |

All 194 rows are in the appendix.

## 2. Width per light pass, and the head of the queue

### Width

`policySemanticBound` (the width before in-flight is subtracted) is **not written per light pass**. I reconstructed it three ways, and they agree:

- **(a) Selector state at the pass.** `review.capacity` is written on every change of `width:reason` (`src/lib/review-capacity.ts:458`) and at least every 5 min, so the selector's width at any instant can be read back. The state resets to base on a daemon boot.
- **(b) Stand-down text at the same pass.** "bound N, in-flight M" gives width = N + M. This is exact when N > 0; when N is 0 it is only an upper bound, because the bound is clamped at zero.
- **(c) Refill rows record `width` directly.**

| Source | Width 1 | Width 2 | Width 3 | Width 4 |
|---|---|---|---|---|
| (a) at 462 light selection passes that admitted at least one review | 257 (56%) | 24 | 40 | 141 (31%) |
| (b) at 197 passes that left a bound row (112 exact) | 140 (71%) | 6 | 7 | 44 (22%) |
| (c) 301 refills | 221 (73%) | 14 | 8 | 58 (19%) |
| Selector time share over the window | 64% | 5% | 6% | 25% (mean 1.91) |

Width 1 comes from the `cpu-pressure` arm, or from the 5–20 PSI hold band after it. In the last 24 h of the window it was 75% of the time, and every `cpu-pressure` row in that span had `pressure_source: host-load`.

### Queue head

**How the head is found.** At each observable light pass, the head is the oldest PR by `createdAt` among PRs waiting in the spawning lane. A PR is waiting from its `sweep.review_eligible` row for a head until one of these: admitted at that head, a verdict on that head, a new head, or closed. Plan-only PRs are excluded.

**"Cannot merge without a person"** means either of:

- **A human CHANGES_REQUESTED review is in force.** It starts at the human `reviewed changes_requested` event in the PR timeline and ends at a later human `approved` review or a `review_dismissed` event. GitHub keeps this decision across pushes until it is dismissed or superseded.
- **A needs-human escalation is open at that exact head.** It starts at `escalation.issue_opened` with `triage_subject.headSha` equal to the head. It ends at an `escalation.superseded` or `escalation.demoted` row, or at the issue's GitHub `closed_at`, whichever comes first.

**Results:**

- **Observable light passes:** 727. These left a light selection admission or a light-only stand-down form. 709 of them had a non-empty spawning queue.
- **Head could not merge without a person: 333 of 709 passes (47.0%).**
  - Human CHANGES_REQUESTED in force: 100 passes. #14793: 94, #14543: 4, #15034: 2.
  - Needs-human escalation open at the head: 233 passes. 204 had at least one `ci` or other-cause issue; 29 had only `stage-stall` issues, which were raised because the PR had waited for review.
  - #15551: 83, #15520: 66, #15046: 44, #14567: 13, #16044: 13, #16033: 3, #14793: 2, #14176: 2, #16007: 2, #15368: 2, #14942: 1, #14986: 1, #15268: 1.
- **Was that head admitted?** 21 of the 333 passes started its review; 312 did not.
- **The pick that spends the width.** 130 passes left a "bound N" refusal with N > 0, no "admitted … ahead" list, and no `sweep.review_admitted` within 3 s. That is a pick that spent the width without starting a review. In 40 of them the head could not merge without a person: #14793 32, #14567 3, #15046 3, #15368 2.

By day, unmergeable-head passes were: 10-26 10, 10-27 15, 10-28 76, 10-29 66, 10-30 75, 10-31 55, 11-01 18, 11-02 18.

## 3. Positive control: 2026-10-29, #15538

Reproduced from the ledger as written:

- #15538 (head `15d7b525c`) became eligible at 20:02:55.539Z, on the light surface.
- The replay finds it jumped by three refills, all at width 1 / in-flight 0, from the same stale pass:

| Refill at | Admitted | Snapshot age | Wait from that refill until #15538 was admitted |
|---|---|---|---|
| 20:03:14.376Z | #15543 | 611788 ms | 79 min |
| 20:08:59.651Z | #15551 | 957451 ms | 73 min |
| 20:11:52.973Z | #15553 | 1126151 ms | 70 min |

- #15538 was admitted at 21:22:06.512Z (light surface).
- **Queue head, same evening.**
  - At 20:44:24Z, 20:53:44Z and 20:54:31Z the reconstructed queue head was #14793 (head `6aa3094dd`). At 20:53Z and 20:54Z #15133 was second.
  - #14793 carried a human CHANGES_REQUESTED review submitted 2026-10-27T18:10:38Z and dismissed at 21:13:07Z (issue timeline). So all three passes count as "head cannot merge without a person".
- **Later the same night.** #15551, the second refill above, became the most frequent escalation-held head of the window (83 passes, from 10-30).

## 4. What the ledger does not record

| Measure | How I handled it |
|---|---|
| Per-pass semantic width (`policySemanticBound`) | Reconstructed from `review.capacity` (written on every width change), stand-down "bound N, in-flight M", and refill `width`. Not written per pass. |
| Every light pass | Not recorded. `sweep.disposed` rows are deduplicated and backed off, so a pass that admits nothing may leave no row. Per-pass counts here cover the 727 observable passes only. |
| The pass's pick (`spawning[0]`) | Not recorded when it does not produce `sweep.review_admitted`. Reconstructed as the oldest waiting spawning-lane PR by `createdAt`. |
| `reviewAdmissionKey` | Not in ledger rows. Read as GitHub `createdAt`, available for PRs created from 2026-10-10. Older PRs (before #13717) are not in the queue reconstruction. |
| `isPlanFiling` per PR per pass | Not recorded. Inferred from plan-only review rows and plan-lane stand-down text. |
| CHANGES_REQUESTED dismissal or approval time | Not in the ledger. Read from GitHub issue timelines for the 10 PRs whose sweep rows named one. A human review on any other PR is not counted, so the figures above are a lower bound. |
| Escalation closed by a person | Not in the ledger. Read from GitHub `closed_at` for the 45 issues found at a queue head. |
| Added wait caused by a jump | Counterfactual, so not measurable. The report gives the upper bound: refill to the jumped PR's admission. |
| Restart-latch refusals | Out of scope by operator decision 2026-10-29. Not measured as a jump cause. |

## 5. Recommendation

**Change the queue-head rule first, and make refills re-read the queue.** Both, as one follow-up filing. Leave the width to its own filing.

**Evidence:**

- **The head rule.** In 47.0% of observable light passes (333 of 709), the oldest-first head could not merge without a person. In 40 passes such a head spent the width with no review started. #14793 alone held the head for 94 passes across 10-27 to 10-29.
  - A rule that sets aside heads blocked on a person sends the slot to a PR that can actually land.
  - "Blocked on a person" means a human CHANGES_REQUESTED in force, or an open needs-human escalation at that head that is not only a stage-stall raised by the wait itself.
  - The rule must still refresh the set-aside PR when its blocker clears; it must not drop it.
- **The refill tail.** 34% of refills (103 of 301) jumped an older PR that had become eligible after the refill's snapshot. Snapshots were a median 16 min old and up to 155 min. Jumped heads then waited up to 41 h in total (upper bound; median 36 min each).
  - Re-reading eligibility at refill time removes the class. It reuses the live head read `admitOneRefill` already makes.
- **The width is not this task's lever.** It was 1 in 64% of the window, from `cpu-pressure` on a host whose load is mostly outside the fleet (`pressure_source: host-load`).
  - The fix belongs in how CPU admission is scoped: proofs, not the LLM phase.
  - It is ranked in the operator's 2026-11-02 review-lane research notes, together with plan-only reviews being held at the code lane's CPU bound.

**What is filed or built from this:** only this report (W1-T10992). The head-rule, refill and width proposals above are not filed by this PR; each needs its own filing and the operator's call.

## Appendix: every refill jump (194 rows)

Times are UTC 2026. "Never" means the jumped PR was not admitted at that head; the reason follows.

| # | Refill (admitted PR) at | Admitted | Snapshot age | Width / in-flight | Jumped PR (head) | Jumped PR eligible | Wait after jump until jumped PR admitted |
|---|---|---|---|---|---|---|---|
| 1 | 10-26 22:19:37 | #14562 | 16.4 min | 1 / 0 | #14543 (`bd171137b`) | 10-26 22:13:49 | 48 min |
| 2 | 10-26 23:59:07 | #14618 | 6.6 min | 1 / 0 | #14543 (`11f9816d8`) | 10-26 23:56:12 | 9 min |
| 3 | 10-27 02:18:47 | #14640 | 20.1 min | 1 / 0 | #14176 (`cc4a81079`) | 10-27 02:15:41 | never — closed/merged at 10-27 10:57:58 |
| 4 | 10-27 02:18:47 | #14640 | 20.1 min | 1 / 0 | #14367 (`7d53efb6c`) | 10-27 02:15:41 | 8 min |
| 5 | 10-27 02:18:47 | #14640 | 20.1 min | 1 / 0 | #14617 (`0a05de132`) | 10-27 02:15:41 | 103 min |
| 6 | 10-27 02:18:47 | #14640 | 20.1 min | 1 / 0 | #14599 (`d49303d16`) | 10-27 02:15:41 | 31 min |
| 7 | 10-27 02:18:50 | #14658 | 20.3 min | 1 / 0 | #14176 (`cc4a81079`) | 10-27 02:15:41 | never — closed/merged at 10-27 10:57:58 |
| 8 | 10-27 02:18:50 | #14658 | 20.3 min | 1 / 0 | #14367 (`7d53efb6c`) | 10-27 02:15:41 | 8 min |
| 9 | 10-27 02:18:50 | #14658 | 20.3 min | 1 / 0 | #14617 (`0a05de132`) | 10-27 02:15:41 | 103 min |
| 10 | 10-27 02:18:50 | #14658 | 20.3 min | 1 / 0 | #14599 (`d49303d16`) | 10-27 02:15:41 | 31 min |
| 11 | 10-27 02:18:50 | #14658 | 20.3 min | 1 / 0 | #14654 (`bfec434e2`) | 10-27 02:15:41 | 50 min |
| 12 | 10-27 02:46:12 | #14579 | 19.8 min | 1 / 0 | #14531 (`a7e7adc7e`) | 10-27 02:33:37 | 22 min |
| 13 | 10-27 02:49:29 | #14599 | 23.0 min | 1 / 0 | #14531 (`a7e7adc7e`) | 10-27 02:33:37 | 19 min |
| 14 | 10-27 02:55:58 | #14620 | 29.5 min | 1 / 0 | #14531 (`a7e7adc7e`) | 10-27 02:33:37 | 13 min |
| 15 | 10-27 03:56:06 | #14681 | 47.5 min | 1 / 0 | #14176 (`af360fd53`) | 10-27 03:50:38 | 5 min |
| 16 | 10-27 03:59:07 | #14682 | 50.4 min | 1 / 0 | #14176 (`af360fd53`) | 10-27 03:50:38 | 2 min |
| 17 | 10-27 04:46:31 | #14689 | 21.0 min | 4 / 0 | #14567 (`5f39f9575`) | 10-27 04:31:44 | 27 min |
| 18 | 10-27 04:46:31 | #14689 | 21.0 min | 4 / 0 | #14683 (`12f7da7c9`) | 10-27 04:31:44 | 27 min |
| 19 | 10-27 04:46:32 | #14692 | 21.0 min | 4 / 1 | #14567 (`5f39f9575`) | 10-27 04:31:44 | 27 min |
| 20 | 10-27 04:46:32 | #14692 | 21.0 min | 4 / 1 | #14683 (`12f7da7c9`) | 10-27 04:31:44 | 27 min |
| 21 | 10-27 04:46:34 | #14696 | 21.0 min | 4 / 2 | #14567 (`5f39f9575`) | 10-27 04:31:44 | 27 min |
| 22 | 10-27 04:46:34 | #14696 | 21.0 min | 4 / 2 | #14683 (`12f7da7c9`) | 10-27 04:31:44 | 27 min |
| 23 | 10-27 04:46:35 | #14709 | 21.0 min | 4 / 3 | #14567 (`5f39f9575`) | 10-27 04:31:44 | 27 min |
| 24 | 10-27 04:46:35 | #14709 | 21.0 min | 4 / 3 | #14683 (`12f7da7c9`) | 10-27 04:31:44 | 27 min |
| 25 | 10-27 04:48:23 | #14716 | 22.8 min | 4 / 3 | #14567 (`5f39f9575`) | 10-27 04:31:44 | 25 min |
| 26 | 10-27 04:48:23 | #14716 | 22.8 min | 4 / 3 | #14683 (`12f7da7c9`) | 10-27 04:31:44 | 25 min |
| 27 | 10-27 07:05:15 | #14683 | 11.2 min | 4 / 1 | #14176 (`d6a699fc5`) | 10-27 07:04:55 | never — closed/merged at 10-27 10:57:58 |
| 28 | 10-27 07:05:15 | #14683 | 11.2 min | 4 / 1 | #14620 (`f0be7318b`) | 10-27 07:04:55 | 0 min |
| 29 | 10-27 07:05:19 | #14729 | 11.2 min | 4 / 2 | #14176 (`d6a699fc5`) | 10-27 07:04:55 | never — closed/merged at 10-27 10:57:58 |
| 30 | 10-27 07:05:19 | #14729 | 11.2 min | 4 / 2 | #14620 (`f0be7318b`) | 10-27 07:04:55 | 0 min |
| 31 | 10-27 07:26:45 | #14753 | 8.9 min | 1 / 0 | #14750 (`dcd65fb4a`) | 10-27 07:20:35 | 13 min |
| 32 | 10-27 07:30:16 | #14757 | 12.4 min | 1 / 0 | #14750 (`dcd65fb4a`) | 10-27 07:20:35 | 9 min |
| 33 | 10-27 07:32:20 | #14758 | 14.4 min | 1 / 0 | #14750 (`dcd65fb4a`) | 10-27 07:20:35 | 7 min |
| 34 | 10-27 15:02:20 | #14853 | 8.5 min | 1 / 0 | #14795 (`f485781dc`) | 10-27 14:59:24 | 78 min |
| 35 | 10-27 17:08:40 | #14877 | 20.3 min | 1 / 0 | #14809 (`198262368`) | 10-27 17:01:17 | 69 min |
| 36 | 10-27 17:13:00 | #14880 | 24.6 min | 1 / 0 | #14809 (`198262368`) | 10-27 17:01:17 | 65 min |
| 37 | 10-27 19:35:45 | #14935 | 7.3 min | 1 / 0 | #14817 (`8b2a5741c`) | 10-27 19:31:46 | never — closed/merged at 10-28 04:17:10 |
| 38 | 10-27 21:38:03 | #14967 | 12.3 min | 1 / 0 | #14897 (`f8caec690`) | 10-27 21:35:32 | never — closed/merged at 10-27 23:22:31 |
| 39 | 10-27 21:54:57 | #14972 | 10.1 min | 1 / 0 | #14957 (`7b8e3ce6d`) | 10-27 21:50:58 | never — closed/merged at 10-28 04:17:10 |
| 40 | 10-28 05:26:42 | #15053 | 17.3 min | 1 / 0 | #15027 (`df49d3127`) | 10-28 05:24:55 | 24 min |
| 41 | 10-28 05:28:28 | #15059 | 19.1 min | 1 / 0 | #15027 (`df49d3127`) | 10-28 05:24:55 | 22 min |
| 42 | 10-28 05:31:44 | #15060 | 22.4 min | 1 / 0 | #15027 (`df49d3127`) | 10-28 05:24:55 | 19 min |
| 43 | 10-28 06:06:02 | #15047 | 5.6 min | 1 / 0 | #15046 (`7e88bebc7`) | 10-28 06:04:18 | never — head moved before admission |
| 44 | 10-28 06:12:36 | #15051 | 12.1 min | 1 / 0 | #15018 (`6fafecd2d`) | 10-28 06:10:51 | 17 min |
| 45 | 10-28 06:12:36 | #15051 | 12.1 min | 1 / 0 | #15046 (`7e88bebc7`) | 10-28 06:04:18 | never — head moved before admission |
| 46 | 10-28 06:12:36 | #15051 | 12.1 min | 1 / 0 | #15041 (`db9c3893d`) | 10-28 06:10:51 | never — closed/merged at 10-29 00:52:24 |
| 47 | 10-28 06:17:14 | #15063 | 16.7 min | 1 / 0 | #15018 (`6fafecd2d`) | 10-28 06:10:51 | 12 min |
| 48 | 10-28 06:17:14 | #15063 | 16.7 min | 1 / 0 | #15046 (`7e88bebc7`) | 10-28 06:04:18 | never — head moved before admission |
| 49 | 10-28 06:17:14 | #15063 | 16.7 min | 1 / 0 | #15059 (`c7d1d1006`) | 10-28 06:04:18 | 74 min |
| 50 | 10-28 06:17:14 | #15063 | 16.7 min | 1 / 0 | #15041 (`db9c3893d`) | 10-28 06:10:51 | never — closed/merged at 10-29 00:52:24 |
| 51 | 10-28 06:20:12 | #15065 | 19.7 min | 1 / 0 | #15018 (`6fafecd2d`) | 10-28 06:10:51 | 9 min |
| 52 | 10-28 06:20:12 | #15065 | 19.7 min | 1 / 0 | #15046 (`7e88bebc7`) | 10-28 06:04:18 | never — head moved before admission |
| 53 | 10-28 06:20:12 | #15065 | 19.7 min | 1 / 0 | #15059 (`c7d1d1006`) | 10-28 06:04:18 | 71 min |
| 54 | 10-28 06:20:12 | #15065 | 19.7 min | 1 / 0 | #15041 (`db9c3893d`) | 10-28 06:10:51 | never — closed/merged at 10-29 00:52:24 |
| 55 | 10-28 06:23:24 | #15068 | 22.9 min | 2 / 0 | #15018 (`6fafecd2d`) | 10-28 06:10:51 | 6 min |
| 56 | 10-28 06:23:24 | #15068 | 22.9 min | 2 / 0 | #15046 (`7e88bebc7`) | 10-28 06:04:18 | never — head moved before admission |
| 57 | 10-28 06:23:24 | #15068 | 22.9 min | 2 / 0 | #15059 (`c7d1d1006`) | 10-28 06:04:18 | 68 min |
| 58 | 10-28 06:23:24 | #15068 | 22.9 min | 2 / 0 | #15041 (`db9c3893d`) | 10-28 06:10:51 | never — closed/merged at 10-29 00:52:24 |
| 59 | 10-28 06:23:26 | #15073 | 22.9 min | 2 / 1 | #15018 (`6fafecd2d`) | 10-28 06:10:51 | 6 min |
| 60 | 10-28 06:23:26 | #15073 | 22.9 min | 2 / 1 | #15046 (`7e88bebc7`) | 10-28 06:04:18 | never — head moved before admission |
| 61 | 10-28 06:23:26 | #15073 | 22.9 min | 2 / 1 | #15059 (`c7d1d1006`) | 10-28 06:04:18 | 68 min |
| 62 | 10-28 06:23:26 | #15073 | 22.9 min | 2 / 1 | #15041 (`db9c3893d`) | 10-28 06:10:51 | never — closed/merged at 10-29 00:52:24 |
| 63 | 10-28 09:00:29 | #15074 | 17.4 min | 1 / 0 | #15022 (`8281d7c6f`) | 10-28 08:54:02 | 24 min |
| 64 | 10-28 09:07:59 | #15083 | 24.9 min | 1 / 0 | #15022 (`8281d7c6f`) | 10-28 08:54:02 | 16 min |
| 65 | 10-28 09:07:59 | #15083 | 24.9 min | 1 / 0 | #15027 (`9eead0f08`) | 10-28 09:00:50 | 16 min |
| 66 | 10-28 09:20:08 | #15102 | 37.0 min | 1 / 0 | #14793 (`9f6e13b6b`) | 10-28 09:15:13 | 21 min |
| 67 | 10-28 09:20:08 | #15102 | 37.0 min | 1 / 0 | #15022 (`8281d7c6f`) | 10-28 08:54:02 | 4 min |
| 68 | 10-28 09:20:08 | #15102 | 37.0 min | 1 / 0 | #15027 (`9eead0f08`) | 10-28 09:00:50 | 4 min |
| 69 | 10-28 09:25:54 | #15117 | 42.8 min | 4 / 3 | #14793 (`9f6e13b6b`) | 10-28 09:15:13 | 15 min |
| 70 | 10-28 09:25:54 | #15117 | 42.8 min | 4 / 3 | #15112 (`34db3082b`) | 10-28 09:08:02 | 10 min |
| 71 | 10-28 09:53:43 | #15131 | 12.8 min | 1 / 0 | #15059 (`27426b2b1`) | 10-28 09:46:55 | 19 min |
| 72 | 10-28 09:53:43 | #15131 | 12.8 min | 1 / 0 | #15041 (`484aa1f76`) | 10-28 09:46:55 | never — closed/merged at 10-29 00:52:24 |
| 73 | 10-28 12:08:14 | #15158 | 12.8 min | 1 / 0 | #14793 (`730fa6d18`) | 10-28 12:05:40 | 36 min |
| 74 | 10-28 12:08:14 | #15158 | 12.8 min | 1 / 0 | #15022 (`3a09f53f0`) | 10-28 12:05:40 | 36 min |
| 75 | 10-28 12:08:14 | #15158 | 12.8 min | 1 / 0 | #15108 (`7051d0a6a`) | 10-28 12:05:40 | 36 min |
| 76 | 10-28 12:20:39 | #15160 | 25.2 min | 1 / 0 | #14793 (`730fa6d18`) | 10-28 12:05:40 | 23 min |
| 77 | 10-28 12:20:39 | #15160 | 25.2 min | 1 / 0 | #15022 (`3a09f53f0`) | 10-28 12:05:40 | 23 min |
| 78 | 10-28 12:20:39 | #15160 | 25.2 min | 1 / 0 | #15108 (`7051d0a6a`) | 10-28 12:05:40 | 23 min |
| 79 | 10-28 13:58:45 | #15185 | 18.1 min | 1 / 0 | #15022 (`ad4560530`) | 10-28 13:57:47 | 42 min |
| 80 | 10-28 13:58:45 | #15185 | 18.1 min | 1 / 0 | #15108 (`5f3fd7686`) | 10-28 13:57:47 | 60 min |
| 81 | 10-28 13:58:45 | #15185 | 18.1 min | 1 / 0 | #15158 (`f076c6ab1`) | 10-28 13:57:47 | never — closed/merged at 10-28 19:10:34 |
| 82 | 10-28 14:12:07 | #15186 | 31.5 min | 1 / 0 | #15022 (`ad4560530`) | 10-28 13:57:47 | 29 min |
| 83 | 10-28 14:12:07 | #15186 | 31.5 min | 1 / 0 | #15108 (`5f3fd7686`) | 10-28 13:57:47 | 47 min |
| 84 | 10-28 14:12:07 | #15186 | 31.5 min | 1 / 0 | #15158 (`f076c6ab1`) | 10-28 13:57:47 | never — closed/merged at 10-28 19:10:34 |
| 85 | 10-28 15:47:11 | #15185 | 18.3 min | 1 / 0 | #15181 (`25aa6dd58`) | 10-28 15:46:58 | 14 min |
| 86 | 10-28 17:22:55 | #15229 | 39.7 min | 1 / 0 | #15175 (`447e619c4`) | 10-28 17:09:12 | 61 min |
| 87 | 10-28 17:26:54 | #15230 | 43.7 min | 1 / 0 | #15175 (`447e619c4`) | 10-28 17:09:12 | 57 min |
| 88 | 10-28 19:20:26 | #15245 | 18.8 min | 1 / 0 | #15160 (`a3f352535`) | 10-28 19:16:43 | 24 min |
| 89 | 10-28 19:20:26 | #15245 | 18.8 min | 1 / 0 | #15183 (`a42f4d467`) | 10-28 19:16:43 | 40 min |
| 90 | 10-28 19:20:26 | #15245 | 18.8 min | 1 / 0 | #15240 (`7d642083c`) | 10-28 19:16:43 | 43 min |
| 91 | 10-28 19:34:27 | #15254 | 32.9 min | 1 / 0 | #15160 (`a3f352535`) | 10-28 19:16:43 | 10 min |
| 92 | 10-28 19:34:27 | #15254 | 32.9 min | 1 / 0 | #15183 (`a42f4d467`) | 10-28 19:16:43 | 26 min |
| 93 | 10-28 19:34:27 | #15254 | 32.9 min | 1 / 0 | #15240 (`7d642083c`) | 10-28 19:16:43 | 29 min |
| 94 | 10-28 20:00:20 | #15181 | 16.0 min | 3 / 1 | #15041 (`a688d7565`) | 10-28 19:57:06 | never — closed/merged at 10-29 00:52:24 |
| 95 | 10-28 20:00:23 | #15183 | 16.0 min | 3 / 2 | #15041 (`a688d7565`) | 10-28 19:57:06 | never — closed/merged at 10-29 00:52:24 |
| 96 | 10-28 20:02:59 | #15240 | 18.7 min | 2 / 1 | #15041 (`a688d7565`) | 10-28 19:57:06 | never — closed/merged at 10-29 00:52:24 |
| 97 | 10-28 20:14:40 | #15259 | 30.4 min | 1 / 0 | #15041 (`a688d7565`) | 10-28 19:57:06 | never — closed/merged at 10-29 00:52:24 |
| 98 | 10-28 20:14:42 | #15261 | 30.4 min | 1 / 0 | #15041 (`a688d7565`) | 10-28 19:57:06 | never — closed/merged at 10-29 00:52:24 |
| 99 | 10-28 20:20:15 | #15264 | 35.9 min | 1 / 0 | #15041 (`a688d7565`) | 10-28 19:57:06 | never — closed/merged at 10-29 00:52:24 |
| 100 | 10-28 20:36:16 | #15270 | 51.9 min | 1 / 0 | #14793 (`11eca924e`) | 10-28 20:23:45 | 12 min |
| 101 | 10-28 20:36:16 | #15270 | 51.9 min | 1 / 0 | #15041 (`a688d7565`) | 10-28 19:57:06 | never — closed/merged at 10-29 00:52:24 |
| 102 | 10-28 20:36:16 | #15270 | 51.9 min | 1 / 0 | #15186 (`482c2c2e8`) | 10-28 20:23:45 | 51 min |
| 103 | 10-29 00:48:37 | #15322 | 18.1 min | 1 / 0 | #15285 (`98494019e`) | 10-29 00:48:07 | 54 min |
| 104 | 10-29 00:53:20 | #15324 | 22.8 min | 1 / 0 | #15285 (`98494019e`) | 10-29 00:48:07 | 49 min |
| 105 | 10-29 07:27:23 | #15382 | 15.4 min | 4 / 0 | #15285 (`0a265c524`) | 10-29 07:25:12 | 49 min |
| 106 | 10-29 07:27:23 | #15382 | 15.4 min | 4 / 0 | #15345 (`682bbd855`) | 10-29 07:25:12 | 49 min |
| 107 | 10-29 07:27:24 | #15395 | 15.4 min | 4 / 1 | #15285 (`0a265c524`) | 10-29 07:25:12 | 49 min |
| 108 | 10-29 07:27:24 | #15395 | 15.4 min | 4 / 1 | #15345 (`682bbd855`) | 10-29 07:25:12 | 49 min |
| 109 | 10-29 07:27:24 | #15395 | 15.4 min | 4 / 1 | #15384 (`912b96a3a`) | 10-29 07:25:12 | never — closed/merged at 10-29 13:14:14 |
| 110 | 10-29 07:27:25 | #15401 | 15.4 min | 4 / 2 | #15285 (`0a265c524`) | 10-29 07:25:12 | 49 min |
| 111 | 10-29 07:27:25 | #15401 | 15.4 min | 4 / 2 | #15345 (`682bbd855`) | 10-29 07:25:12 | 49 min |
| 112 | 10-29 07:27:25 | #15401 | 15.4 min | 4 / 2 | #15384 (`912b96a3a`) | 10-29 07:25:12 | never — closed/merged at 10-29 13:14:14 |
| 113 | 10-29 07:27:28 | #15404 | 15.4 min | 4 / 3 | #15285 (`0a265c524`) | 10-29 07:25:12 | 48 min |
| 114 | 10-29 07:27:28 | #15404 | 15.4 min | 4 / 3 | #15345 (`682bbd855`) | 10-29 07:25:12 | 48 min |
| 115 | 10-29 07:27:28 | #15404 | 15.4 min | 4 / 3 | #15384 (`912b96a3a`) | 10-29 07:25:12 | never — closed/merged at 10-29 13:14:14 |
| 116 | 10-29 09:45:44 | #15438 | 10.4 min | 1 / 0 | #14793 (`47863a5f9`) | 10-29 09:42:26 | 10 min |
| 117 | 10-29 09:45:44 | #15438 | 10.4 min | 1 / 0 | #15345 (`ce06b50c4`) | 10-29 09:42:26 | 25 min |
| 118 | 10-29 10:35:05 | #15384 | 17.8 min | 1 / 0 | #15148 (`50eb30cc1`) | 10-29 10:25:44 | 59 min |
| 119 | 10-29 10:35:05 | #15384 | 17.8 min | 1 / 0 | #15285 (`55c3d1232`) | 10-29 10:25:44 | never — closed/merged at 10-29 13:14:14 |
| 120 | 10-29 10:35:19 | #15422 | 18.0 min | 1 / 0 | #15148 (`50eb30cc1`) | 10-29 10:25:44 | 59 min |
| 121 | 10-29 10:35:19 | #15422 | 18.0 min | 1 / 0 | #15285 (`55c3d1232`) | 10-29 10:25:44 | never — closed/merged at 10-29 13:14:14 |
| 122 | 10-29 10:35:37 | #15438 | 18.3 min | 1 / 0 | #15148 (`50eb30cc1`) | 10-29 10:25:44 | 59 min |
| 123 | 10-29 10:35:37 | #15438 | 18.3 min | 1 / 0 | #15285 (`55c3d1232`) | 10-29 10:25:44 | never — closed/merged at 10-29 13:14:14 |
| 124 | 10-29 10:35:47 | #15448 | 18.4 min | 1 / 0 | #15148 (`50eb30cc1`) | 10-29 10:25:44 | 58 min |
| 125 | 10-29 10:35:47 | #15448 | 18.4 min | 1 / 0 | #15285 (`55c3d1232`) | 10-29 10:25:44 | never — closed/merged at 10-29 13:14:14 |
| 126 | 10-29 19:43:10 | #15547 | 27.5 min | 1 / 0 | #15520 (`9dca5f809`) | 10-29 19:34:23 | never — head moved before admission |
| 127 | 10-29 19:43:10 | #15547 | 27.5 min | 1 / 0 | #15543 (`d1679fd38`) | 10-29 19:34:23 | 20 min |
| 128 | 10-29 20:03:14 | #15543 | 10.2 min | 1 / 0 | #15538 (`15d7b525c`) | 10-29 20:02:55 | 79 min |
| 129 | 10-29 20:08:59 | #15551 | 16.0 min | 1 / 0 | #15548 (`c59a37ee1`) | 10-29 20:02:55 | 16 min |
| 130 | 10-29 20:08:59 | #15551 | 16.0 min | 1 / 0 | #15550 (`3a22ac86c`) | 10-29 20:02:55 | never — closed/merged at 10-30 01:37:25 |
| 131 | 10-29 20:08:59 | #15551 | 16.0 min | 1 / 0 | #15538 (`15d7b525c`) | 10-29 20:02:55 | 73 min |
| 132 | 10-29 20:11:52 | #15553 | 18.8 min | 1 / 0 | #15548 (`c59a37ee1`) | 10-29 20:02:55 | 13 min |
| 133 | 10-29 20:11:52 | #15553 | 18.8 min | 1 / 0 | #15550 (`3a22ac86c`) | 10-29 20:02:55 | never — closed/merged at 10-30 01:37:25 |
| 134 | 10-29 20:11:52 | #15553 | 18.8 min | 1 / 0 | #15538 (`15d7b525c`) | 10-29 20:02:55 | 70 min |
| 135 | 10-29 22:37:18 | #15566 | 35.0 min | 4 / 0 | #15539 (`f7e64c96f`) | 10-29 22:27:28 | 53 min |
| 136 | 10-29 22:37:22 | #15572 | 35.1 min | 4 / 1 | #15539 (`f7e64c96f`) | 10-29 22:27:28 | 53 min |
| 137 | 10-29 22:37:28 | #15573 | 35.1 min | 4 / 2 | #15539 (`f7e64c96f`) | 10-29 22:27:28 | 53 min |
| 138 | 10-29 22:37:37 | #15575 | 35.2 min | 4 / 3 | #15539 (`f7e64c96f`) | 10-29 22:27:28 | 53 min |
| 139 | 10-30 00:23:50 | #15589 | 53.8 min | 1 / 0 | #15539 (`8ae026a02`) | 10-30 00:17:12 | 18 min |
| 140 | 10-30 01:34:12 | #15618 | 23.7 min | 1 / 0 | #15404 (`5ad3608a9`) | 10-30 01:31:11 | never — closed/merged at 10-30 11:37:07 |
| 141 | 10-30 02:28:31 | #15623 | 41.9 min | 1 / 0 | #15108 (`1be5ada76`) | 10-30 02:20:15 | 20 min |
| 142 | 10-30 02:28:31 | #15623 | 41.9 min | 1 / 0 | #15621 (`9a65d9b10`) | 10-30 02:00:42 | 20 min |
| 143 | 10-30 04:43:22 | #15602 | 33.4 min | 1 / 0 | #15532 (`ea33776f4`) | 10-30 04:39:34 | 61 min |
| 144 | 10-30 04:49:32 | #15621 | 39.6 min | 1 / 0 | #15532 (`ea33776f4`) | 10-30 04:39:34 | 55 min |
| 145 | 10-30 05:01:32 | #15649 | 51.6 min | 1 / 0 | #15532 (`ea33776f4`) | 10-30 04:39:34 | 43 min |
| 146 | 10-30 05:01:32 | #15649 | 51.6 min | 1 / 0 | #15646 (`4783e8bf8`) | 10-30 04:46:13 | 48 min |
| 147 | 10-30 12:36:49 | #15728 | 14.3 min | 1 / 0 | #15532 (`25fec8ecf`) | 10-30 12:35:22 | 80 min |
| 148 | 10-30 12:36:49 | #15728 | 14.3 min | 1 / 0 | #15702 (`441a94d7d`) | 10-30 12:35:22 | 47 min |
| 149 | 10-30 14:45:53 | #15746 | 49.4 min | 1 / 0 | #15745 (`6ebb25291`) | 10-30 14:18:50 | never — closed/merged at 10-30 18:54:29 |
| 150 | 10-30 14:45:53 | #15746 | 49.4 min | 1 / 0 | #15744 (`d814b2e19`) | 10-30 14:18:50 | never — closed/merged at 10-30 16:44:30 |
| 151 | 10-30 17:44:41 | #15756 | 22.9 min | 1 / 0 | #15638 (`b03885de6`) | 10-30 17:34:18 | 13 min |
| 152 | 10-30 20:54:43 | #15812 | 15.3 min | 4 / 0 | #15638 (`7aae62aa8`) | 10-30 20:48:03 | 12 min |
| 153 | 10-30 20:55:00 | #15814 | 15.3 min | 4 / 1 | #15638 (`7aae62aa8`) | 10-30 20:48:03 | 12 min |
| 154 | 11-01 04:48:53 | #15977 | 8.8 min | 1 / 0 | #15975 (`6793ce050`) | 11-01 04:48:35 | 17 min |
| 155 | 11-01 04:55:24 | #15978 | 15.3 min | 1 / 0 | #15975 (`6793ce050`) | 11-01 04:48:35 | 10 min |
| 156 | 11-01 04:59:03 | #15980 | 18.9 min | 1 / 0 | #15975 (`6793ce050`) | 11-01 04:48:35 | 6 min |
| 157 | 11-02 04:07:32 | #16040 | 110.5 min | 1 / 0 | #16037 (`25bb1e812`) | 11-02 04:05:21 | 19 min |
| 158 | 11-02 12:27:43 | #16160 | 56.7 min | 1 / 0 | #16041 (`7e1a34701`) | 11-02 12:19:11 | 171 min |
| 159 | 11-02 12:37:55 | #16162 | 67.0 min | 1 / 0 | #16041 (`7e1a34701`) | 11-02 12:19:11 | 161 min |
| 160 | 11-02 12:43:00 | #16168 | 72.0 min | 1 / 0 | #16041 (`7e1a34701`) | 11-02 12:19:11 | 156 min |
| 161 | 11-02 17:43:20 | #16186 | 145.0 min | 1 / 0 | #15532 (`dd024de08`) | 11-02 17:39:37 | 56 min |
| 162 | 11-02 17:43:20 | #16186 | 145.0 min | 1 / 0 | #15656 (`bc3c3d192`) | 11-02 17:39:37 | 56 min |
| 163 | 11-02 17:43:20 | #16186 | 145.0 min | 1 / 0 | #16095 (`e04427bc3`) | 11-02 17:39:37 | 56 min |
| 164 | 11-02 17:53:18 | #16189 | 155.0 min | 1 / 0 | #15532 (`dd024de08`) | 11-02 17:39:37 | 46 min |
| 165 | 11-02 17:53:18 | #16189 | 155.0 min | 1 / 0 | #15656 (`bc3c3d192`) | 11-02 17:39:37 | 46 min |
| 166 | 11-02 17:53:18 | #16189 | 155.0 min | 1 / 0 | #16095 (`e04427bc3`) | 11-02 17:39:37 | 46 min |
| 167 | 11-02 20:22:27 | #16187 | 104.8 min | 1 / 0 | #15368 (`c9c0b40f8`) | 11-02 19:39:08 | 53 min |
| 168 | 11-02 20:35:09 | #16191 | 117.5 min | 1 / 0 | #15368 (`c9c0b40f8`) | 11-02 19:39:08 | 41 min |
| 169 | 11-02 20:39:37 | #16192 | 122.0 min | 1 / 0 | #15368 (`c9c0b40f8`) | 11-02 19:39:08 | 36 min |
| 170 | 11-02 20:46:58 | #16197 | 129.3 min | 1 / 0 | #15368 (`c9c0b40f8`) | 11-02 19:39:08 | 29 min |
| 171 | 11-02 20:52:57 | #16199 | 135.3 min | 1 / 0 | #15368 (`c9c0b40f8`) | 11-02 19:39:08 | 23 min |
| 172 | 11-02 20:52:57 | #16199 | 135.3 min | 1 / 0 | #15520 (`e87ce4c69`) | 11-02 20:48:33 | 35 min |
| 173 | 11-02 20:55:35 | #16205 | 138.0 min | 1 / 0 | #15368 (`c9c0b40f8`) | 11-02 19:39:08 | 20 min |
| 174 | 11-02 20:55:35 | #16205 | 138.0 min | 1 / 0 | #15520 (`e87ce4c69`) | 11-02 20:48:33 | 32 min |
| 175 | 11-02 20:55:35 | #16205 | 138.0 min | 1 / 0 | #16201 (`578c6f428`) | 11-02 20:48:33 | 48 min |
| 176 | 11-02 20:58:59 | #16210 | 141.4 min | 1 / 0 | #15368 (`c9c0b40f8`) | 11-02 19:39:08 | 17 min |
| 177 | 11-02 20:58:59 | #16210 | 141.4 min | 1 / 0 | #15520 (`e87ce4c69`) | 11-02 20:48:33 | 29 min |
| 178 | 11-02 20:58:59 | #16210 | 141.4 min | 1 / 0 | #16201 (`578c6f428`) | 11-02 20:48:33 | 45 min |
| 179 | 11-02 21:02:08 | #16221 | 144.4 min | 1 / 0 | #15368 (`c9c0b40f8`) | 11-02 19:39:08 | 14 min |
| 180 | 11-02 21:02:08 | #16221 | 144.4 min | 1 / 0 | #15520 (`e87ce4c69`) | 11-02 20:48:33 | 26 min |
| 181 | 11-02 21:02:08 | #16221 | 144.4 min | 1 / 0 | #15638 (`35fa0751d`) | 11-02 21:01:11 | never — not admitted by window end |
| 182 | 11-02 21:02:08 | #16221 | 144.4 min | 1 / 0 | #15656 (`39247b567`) | 11-02 21:01:11 | never — not admitted by window end |
| 183 | 11-02 21:02:08 | #16221 | 144.4 min | 1 / 0 | #16192 (`c5662e2b9`) | 11-02 21:01:11 | 38 min |
| 184 | 11-02 21:02:08 | #16221 | 144.4 min | 1 / 0 | #16201 (`578c6f428`) | 11-02 20:48:33 | 41 min |
| 185 | 11-02 21:02:08 | #16221 | 144.4 min | 1 / 0 | #16213 (`335d2de90`) | 11-02 20:48:33 | 45 min |
| 186 | 11-02 21:02:08 | #16221 | 144.4 min | 1 / 0 | #16212 (`7af8bc3a2`) | 11-02 20:48:33 | never — not admitted by window end |
| 187 | 11-02 21:03:12 | #16226 | 145.5 min | 1 / 0 | #15368 (`c9c0b40f8`) | 11-02 19:39:08 | 13 min |
| 188 | 11-02 21:03:12 | #16226 | 145.5 min | 1 / 0 | #15520 (`e87ce4c69`) | 11-02 20:48:33 | 25 min |
| 189 | 11-02 21:03:12 | #16226 | 145.5 min | 1 / 0 | #15638 (`35fa0751d`) | 11-02 21:01:11 | never — not admitted by window end |
| 190 | 11-02 21:03:12 | #16226 | 145.5 min | 1 / 0 | #15656 (`39247b567`) | 11-02 21:01:11 | never — not admitted by window end |
| 191 | 11-02 21:03:12 | #16226 | 145.5 min | 1 / 0 | #16192 (`c5662e2b9`) | 11-02 21:01:11 | 37 min |
| 192 | 11-02 21:03:12 | #16226 | 145.5 min | 1 / 0 | #16201 (`578c6f428`) | 11-02 20:48:33 | 40 min |
| 193 | 11-02 21:03:12 | #16226 | 145.5 min | 1 / 0 | #16213 (`335d2de90`) | 11-02 20:48:33 | 44 min |
| 194 | 11-02 21:03:12 | #16226 | 145.5 min | 1 / 0 | #16212 (`7af8bc3a2`) | 11-02 20:48:33 | never — not admitted by window end |
