# Triage of incident-901cace1adefcf4b was decided twice: investigation (W1-T11812)

Read-only investigation. Hypothesis under test: the first triage (#17389, "already decided, no task")
released `refs/rmd-triage/incident-901cace1adefcf4b` through the holder arm of
`decideTriageClaimRelease` while its PR was still open and the entry still read `status: new`, so a second
triage (#17394, "ambiguous, parked for the grill") could acquire the claim and overwrite the verdict.
Nothing was modified: not the claim refs, the feedback record, either PR, or needs-human issue #17393.

corpus positive control: PRESENT for the window, ABSENT for the two runs. Corpus searched: the live ledger
`state/ledger.ndjson` only (22041 rows, 11.1 MB, first row 2026-09-13T14:01:13.868Z, last row 2026-11-08
~22:57Z). No rotated archive exists beside it (`ledger.*.ndjson.gz` and `ledger.*.ndjson` both match 0
files; only `ledger.ndjson.carried.json` and `.retained-steps.json` sit there). The window 2026-11-08
14:00Z-16:00Z holds 329 rows (first 14:06:25.220Z in hour 14). Control row: `triage.claim`, ts
2026-11-08T15:38:28.880Z, run `TRIAGE-fb-1794149944233-e4c97f-1794152303864`, pid 15423, host Mac-mini
(ledger rows carry no `seq` field, so ts and pid identify it). The corpus therefore sees triage rows in the
window. But a search of the ledger for `incident-901cace1adefcf4b` finds ONLY the later
`review-PR17394-*` rows (21:09Z) and the 22:21Z-22:57Z plan and worker rows for this task. Searching
`1794148822712`, `1794149957761`, `24389313-06c2-434e-bf65-78b754c60f6b` and
`558f7e87-0437-4259-8601-4eb66c90a844` finds 0 rows. No `triage.claim`, `triage.claim_released`,
`auto_triage.*`, `pr.opened` or `run.awaiting_external` row exists for either run. This is NOT treated as
evidence of absence: the control proves only that the query sees this corpus. Why they are missing is not
known. The runs may have written to a ledger on another host or process, or the rows may have been lost.
The ledger carries no row for these runs either way.

investigation timeline: (ts UTC, source, event, run). Git rows come from the fetched PR heads and main. PR
rows come from the unauthenticated GitHub REST API. No ledger rows exist for either run (see above).

| ts | source | event | run |
|---|---|---|---|
| 14:39:45 | git 7cac4f4f4 | main commit #17385, the base of both triage branches; entry reads `status: new` | - |
| 14:40:22 | run-id suffix 1794148822712 | run 1 starts (decoded) | 1 |
| 14:42:53 | git 6bcb025c7 | run 1 commit "already decided, no task"; base 7cac4f4f4, head sha at open and at merge 6bcb025c7 | 1 |
| 14:46:16 | GitHub | #17389 opened | 1 |
| 14:59:17 | run-id suffix 1794149957761 | run 2 starts (decoded), while #17389 is OPEN and main reads `status: new` | 2 |
| 15:05:05 | GitHub | #17389 merged, merge commit f4c4af2df, entry now `status: rejected` | 1 |
| 15:05:48 | git c1788c97d | run 2 commit "ambiguous, parked for the grill"; parent 7cac4f4f4, so its worktree was cut BEFORE #17389 merged | 2 |
| 15:12:07 | GitHub | #17394 opened | 2 |
| 20:04:21 | GitHub | #17394 closed | 2 |
| 20:06:40 | GitHub | #17394 head ref deleted | 2 |
| 20:38:22 | git f530ea9e0 | second #17394 commit "preserve needs-human disposition"; base 8665e22d5; head sha at merge f530ea9e0 | 2 |
| 20:57:37 | GitHub | #17394 reopened | 2 |
| 21:14:16 | GitHub | #17394 merged, merge commit 5c2269508, entry now `status: grilling` | 2 |
| now | git ls-remote | `refs/rmd-triage/incident-901cace1adefcf4b` absent (released); the claim ref was never observable | - |

Receipts that would decide the hypothesis and are missing: run 1 `triage.claim`; run 1
`triage.claim_released` (arm holder); run 2 `triage.claim` (proceed true, not stale_released); an
`auto_triage.fired` or `auto_triage.stood_down` row versus a direct triage invocation for run 2.

What the sources do establish: (1) run 2 started about 12 minutes after #17389 opened and about 6 minutes
before it merged, and its commit has the same pre-merge parent, so it read `status: new` while #17389 was
open. This matches the shape of the hypothesis, in which the open-PR guard did not stop it. (2) Nothing
here shows when run 1's claim was released, or whether run 2 took a free ref, claimed through the
stale/evidence arm, or never consulted the claim at all. (3) The open-PR guard in `src/lib/daemon.ts`
(`isFeedbackOpenPr`, `readFeedbackLiveState`) belongs to the auto-triage daemon path. Whether a direct
triage command consults it was not established, and run 2's entry point is unknown.

investigation verdict: unknown. Deciding rows: none. The hypothesis is neither proved nor refuted. The
refuters (run 2 claim acquired before run 1's release; #17389 merged before run 2 started; run 2 claimed
through the stale/evidence arm) cannot be tested, and the proof order (claim 1, PR open, release, claim 2)
cannot be shown. One refuter is already excluded by GitHub data: #17389 merged at 15:05:05Z, after run 2
started at 14:59:17Z. Minimum missing evidence: the `triage.claim` and `triage.claim_released` rows of
runs `TRIAGE-incident-901cace1adefcf4b-1794148822712` and `-1794149957761`, plus run 2's entry-point rows.
Retention is not the cause: the live ledger reaches back to 2026-09-13 and has no archive. The gap is an
emission or host gap: those runs' rows never reached this ledger. Which host ran them is not recorded here.

follow-up: none. The verdict is unknown, not proved, so no implement task is filed. Scoping a fix without
the claim receipts would choose between holding the claim until the PR merges or closes (overlaps W1-T6117)
and making direct triage consult the open-PR guard, and the receipts are what pick one. Proposed next
step, not filed here: find where those two runs' ledger rows went, or reproduce the sequence against a
fixture.
