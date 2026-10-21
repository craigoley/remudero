# Why a review refuses head-task-metadata-unavailable

Partial forensic record for W1-T10346: verified mechanisms and historical reports, with the missing cohort evidence identified explicitly.

Code inspected at `c8a55054a4275c3e4c7e2308e47e947460d4be70` on 2026-10-21.
The task record was read from the cached `origin/main`; its source references name
symbols rather than file:line coordinates. Those symbols still exist. Its claim
that resolved tasks without a budget still refuse is superseded by #13107.
The requested document was absent before this change, so all three acceptance
grep proofs failed with a missing-file error. This task was not already satisfied.

This record distinguishes code inspection, GitHub metadata, and other authors'
ledger reports. The session's permission profile denies the live ledger directory
`/home/node/Remudero/state`. No ledger read through an alias or another access path
was attempted. The referenced `logs-8864` and `rmd-state2` evidence directories are
also absent from `/home/node/Remudero`'s directory entries. GitHub searches found
published summaries, but no full cohort export. Consequently, criteria 1 and 2
remain incomplete: neither all 71 keys nor every refusal head can be reconstructed
from the evidence available here. A heading match does not establish completeness.

## Every refusing key

The requested window starts at `2026-10-14T00:00:00Z` and extends into 2026-10-21.
An exact upper cutoff and the corpus's newest timestamp were not supplied by the
full-cohort report and could not be independently measured here.

There are two different published measurements:

- **Full-cohort report:** [PR #13355](https://github.com/craigoley/remudero/pull/13355)
  reports 71 keys, including the `PR-13121` positive control, from 401 gzip
  rotations, zero plain rotations, and one live file. Its detailed control window
  is 2026-10-21 06:02Z–10:41Z. These are reported corpus counts and window bounds;
  they are not this session's file census or exact per-key first/last timestamps.
- **Later filing's narrower corpus:** the W1-T10346 shard reports deduplicated
  rows from rotations starting at 2026-10-17T22:33Z plus the live file.
  [The filing PR #13400](https://github.com/craigoley/remudero/pull/13400)
  describes 67 rotations from October 18 and a newest row at October 21 10:31Z
  for its evidence overall. That description does not establish a per-form
  manifest or the newest timestamp of the earlier 401-archive cohort.

Do not merge those counts: a narrower corpus reports 60 TRIAGE rows and 31
main-repair rows where the full-cohort summary reports 95 and 56. The control is
82 rows in the shard's narrower measurement and 156 in #13355's detailed report.
Those differences are not evidence of new refusals after a fix.

Only these eight keys are named in the available reports. `Unknown` means the
evidence was unavailable, rather than zero events. Counts below are attributed
reports, not a fresh deduplicated measurement.

| Key | Full-cohort reported rows | Narrower shard-reported rows | Reported missing fields | Exact first / last timestamp | PR and refusal heads |
| --- | ---: | ---: | --- | --- | --- |
| W1-T9653 | 146 | 146 | budget_usd | Unknown; shard names a burst from October 20 03:11Z | #13028 is linked by its task trailer; exact refusal heads unknown |
| W1-T9659 | 131 | 131 | budget_usd | Unknown / unknown | #13035 is linked by its task trailer; exact refusal heads unknown |
| W1-T10184 | 96 | 96 | budget_usd | Unknown / unknown | #13066 is linked by its task trailer; exact refusal heads unknown |
| W1-T9399 | Unknown | 8 | budget_usd | Unknown / unknown | Shard names build #12776; exact refusal heads unknown |
| TRIAGE-evidence-coverage-inbox-response-served-model | 95 | 60 | risk, budget_usd | Unknown / unknown | #13151 has this trailer; exact refusal heads unknown |
| main-repair-ratchet-105b1219ee15 | 56 | 31 | risk, budget_usd | Unknown / unknown | #13169 has this trailer; exact refusal heads unknown |
| TRIAGE-fb-1791916356285-50ef47 | Unknown | 5 | risk, budget_usd | Unknown / unknown | Unknown |
| PR-13121 | 156 in #13355's detailed control report | 82 | risk, budget_usd | Exact endpoints unknown; published control window is October 21 06:02Z–10:41Z | **#13305**, reported heads `01ac886`, `fcf607b`, `8f2e8b5` |

The other **63 keys are not enumerated** by the available material. The task shard
says 23 of the 71 were TRIAGE/main-repair identities, but does not name them all.
Neither this table nor its totals constitute the required complete inventory.

The `PR-13121` control must be joined by PR URL, not interpreted as PR #13121.
GitHub's PR metadata identifies #13121 as W1-T10070 on
`run-W1-T10070-1792497572954`, with terminal head
`eadbb29cdb1f3c765bfa8d1d2019844baffac4f0`. By contrast, #13355 reports that
**PR #13305** carried the foreign body trailer `Remudero-Task: PR-13121` and
therefore received that review key. GitHub confirms #13305's terminal head as
`8f2e8b5a045f476541dbf3eb936ecc39cfdbfe2d` on
`fix-merge-round-census-and-escalation-1792544312770`.

GitHub metadata and immutable file reads additionally establish these snapshots.
Terminal PR heads identify available snapshots; they do **not** establish every
head at which a historical review refused.

| Key | PR | Terminal head | Snapshot evidence |
| --- | --- | --- | --- |
| W1-T9653 | [#13028](https://github.com/craigoley/remudero/pull/13028) | `5d5d01b3419bf1489addd6fd94787607730c91da` | [Shard at that head](https://github.com/craigoley/remudero/blob/5d5d01b3419bf1489addd6fd94787607730c91da/plan/tasks.d/W1-T9653-record-the-root-mechanism-behind-the-coverage-ratchet-ci-friction-cause.yaml): risk low, three criteria, no budget_usd |
| W1-T9659 | [#13035](https://github.com/craigoley/remudero/pull/13035) | `4039866c7978909fb3872fa1405576dac203323b` | [Shard at that head](https://github.com/craigoley/remudero/blob/4039866c7978909fb3872fa1405576dac203323b/plan/tasks.d/W1-T9659-record-the-current-locations-of-reportstuckstage-matchduplicateescalatio.yaml): risk low, two criteria, no budget_usd |
| W1-T10184 | [#13066](https://github.com/craigoley/remudero/pull/13066) | `701e350f22325896da6be1e162813276f9cacbf2` | [Shard at that head](https://github.com/craigoley/remudero/blob/701e350f22325896da6be1e162813276f9cacbf2/plan/tasks.d/W1-T10184-check-test-test-quiet-hours-dispatch-gate-test-ts-flaky.yaml): risk low, one criterion, no budget_usd |
| TRIAGE-evidence-coverage-inbox-response-served-model | [#13151](https://github.com/craigoley/remudero/pull/13151) | `905ddd132c609cf1302495b7cda04169341eec4f` | Branch `run-TRIAGE-evidence-coverage-inbox-response-served-model-1792509478967` |
| main-repair-ratchet-105b1219ee15 | [#13169](https://github.com/craigoley/remudero/pull/13169) | `327bed1b219b71bef9ce06fb2968bdf86ba3a042` | Branch `run-main-repair-ratchet-105b1219ee15-1792516867067` |

### Completing the inventory in an authorized environment

Acquire an immutable ledger export through the operator's permitted environment.
Use the installed `rmd ledger-grep` union reader, or its explicit read-only
`rmd inspect --state-dir <absolute-export-directory> ledger-grep <pattern>` entry.
The installed command accepts a pattern; do not assume invented JSON/date flags.
Inspect `resolveLedgerUnion` in `src/lib/ledger-union.ts` for programmatic reads.

The export and analysis must retain:

1. A filename manifest and successful-read count separately for
   `ledger.*.ndjson.gz`, `ledger.*.ndjson`, and `ledger.ndjson`; any unread file
   makes the census incomplete. Record the newest timestamp across the corpus,
   the exact closed analysis window, and the distinct-row policy. Deduplicate
   identical complete rows, not timestamps alone: different events can share a ts.
2. Every distinct row with step `review.reviewer.skipped`, reason
   `head-task-metadata-unavailable`, and ts in the window. Group by task_id,
   reporting count, min/max ts, distinct missing-field sets, PR URLs and heads.
   Count `review.semantic_setup_refused` separately; adding the paired steps
   would double-count review attempts.
3. The same query's `PR-13121` rows as a positive control, showing which PR URLs
   they actually name. A successful control establishes visibility, not window
   coverage or a correct causal classification.
4. A join to setup-refusal/admission rows for skip rows without PR/head fields.
   Use run identity, host and temporal evidence; mark ambiguous joins unresolved.
   Preserve original rows and their filenames so every classification is auditable.
5. The reviewer code SHA for each attempt, independently of the PR head SHA.
   Current code emits `reviewer_code_sha` through `reviewerHealthRowFields`.
   Older missing provenance requires deployment/boot evidence; a merge timestamp
   alone does not prove which reviewer code ran.

## Cause per key

The refusal occurs during setup, before pending status, materialization, or a
verdict, except for the distinct missing-own-record repair path. A retry at the
same head under the same reviewer and metadata repeats the same deterministic
failure. Admission therefore supplies activity without progress.

The historical sequence matters:

| Change | GitHub-confirmed merge | Effect relevant to this investigation |
| --- | --- | --- |
| [#12954](https://github.com/craigoley/remudero/pull/12954), `8b37a0a1b86ba558af3a56dce2308ce819de59f4` | 2026-10-20 01:15:49Z | Explicit semantic mode refuses missing metadata before publishing a verdict |
| [#13107](https://github.com/craigoley/remudero/pull/13107), `37f54024e9efde2b0d6741e724759ba443fe5ff3` | 2026-10-20 16:00:08Z | Resolved head tasks with criteria receive missing metadata defaults and still require semantic review |
| [#13355](https://github.com/craigoley/remudero/pull/13355), `03e4f4ac78db35cb7185656674a877f0a1ad8d41` | 2026-10-21 13:43:33Z | Synthetic PR identities receive defaults on any branch; setup refusal no longer masquerades as a live review at the stall backstop |

**W1-T9653, W1-T9659 and W1-T10184:** the shard-present/missing-budget class
is supported by the task filing, #13107's incident report, and the immutable
terminal-head shard reads above. At inspected HEAD, all three still declare risk
low and omit budget_usd, with nonempty criteria. #12954 is the identified commit
that made missing metadata a setup refusal; #13107 is the shipped repair for a
resolved shard. The exact commit that first omitted each field and each refusing
reviewer's version remain unmeasured. These are not proven instances of a head
predating its shard.

**W1-T9399:** the task filing reports the same missing-budget class and eight
rows. The current shard has risk low, one criterion and no budget_usd. Its own
rationale names build #12776 and a later withdrawal. Historical refusal heads,
the original omission commit, and reviewer versions are unavailable here; the
current shard alone cannot establish the metadata at each refusal.

For these four keys, W1-T9232's refresh path does not repair an omitted budget:
`reviewCommand` considers missing-own-record recovery only when the head has no
criteria, risk or budget and no divergence. The corresponding
`headLacksOwnTaskRecord` helper requires main to contain the record. A present
record with criteria and risk fails the absence predicate. Refreshing such a
branch does not by itself supply the optional field.

**TRIAGE-evidence-coverage-inbox-response-served-model:** missing risk/budget
is reported, but a branch mismatch is **not established**. The actual terminal
branch from #13151 matches the generated identity exactly and is admitted by
today's `usesUntaskedReviewMetadata` predicate. The historical refusing branch,
reviewer SHA and any resolver divergence must be recovered before attributing
these rows to that predicate. Earlier reviewer code is a competing explanation.

**main-repair-ratchet-105b1219ee15:** the same limitation applies. #13169's
actual terminal branch matches today's accepted generated identity shape,
including the twelve-hex revision. Calling this a rejected branch shape solely
from its missing fields would contradict the available branch evidence.

**TRIAGE-fb-1791916356285-50ef47:** the filing supplies five rows missing both
fields. No PR URL, head, branch or reviewer version was available. Its cause is
unresolved; the spelling of a lane identity does not prove its historical branch.

**PR-13121:** #13355's report establishes a synthetic identity on #13305's
`fix-merge-round-census-and-escalation-1792544312770` branch. The earlier predicate
did not admit synthetic PR identities, so no shard resolved and neither field
was defaulted. Removing that foreign body trailer at October 21 11:01:33Z changed
the review key to PR-13305; the reported next admission was 11:04Z and PASS was
11:16:23Z. GitHub confirms #13305 merged at 11:16:31Z. #13355 subsequently repaired
the synthetic-id predicate. This is evidence for that key's mechanism, not proof
that the other 70 keys shared it.

**Remaining 63 keys:** identities and causal evidence are unavailable. No
classification, first/last timestamp, PR mapping or omission commit is asserted.

### Current code and the hours-long loop

At inspected HEAD, `reviewCommand` in `src/run-task.ts` sets `headTaskResolved`
only for a divergence-free resolution with nonempty criteria. That condition
enables `review.reviewer.metadata_defaults`; body-fallback criteria do not turn
an unresolved filed task into a resolved one. `src/lib/plan.ts` already defaults
risk to `medium`, while budget_usd remains optional.

`usesUntaskedReviewMetadata` in `src/lib/tick-read-worker.ts` admits absent ids,
`unfiled`, and positive-decimal `PR-<n>` identities. Generated lane identities
require both an allowed id shape and the matching task-bearing run branch.
A resolver divergence prevents their defaults in `reviewCommand`.

#13355 reports that each sweep re-admitted #13305 about a minute before setup
refused. The backstop treated the newest admission as a live owner, deferred the
stage, and later diagnosed it incorrectly. Current `reportStuckStage` in
`src/lib/sweep.ts` instead checks same-head `review.semantic_setup_refused` rows
and whether a pending/closing event followed. A refused setup cannot defer the
backstop just because another admission exists. That explains a measured long
loop for the control; it does not establish a twelve-hour span for every key.

## Remedy proposal

The smallest action depends on the recorded cause and executing reviewer version.
No review, metadata, cap, escalation or dispatch behavior changes in this task.

| Cause class | Smallest remedy and present disposition | Named falsifier |
| --- | --- | --- |
| Resolved head shard omits budget_usd | #13107 already supplies the review cap while preserving required semantic review. First replay W1-T9653 against its actual reviewer SHA and audit post-deployment rows; do not duplicate the defaulting patch or require an optional build field merely to satisfy review setup. | W1-T9653 resolves with criteria and no divergence under a reviewer containing #13107, yet still returns metadata-unavailable with only budget_usd missing. Such a replay disproves that the shipped path covers that attempt. |
| Head genuinely predates its own shard | Reuse W1-T9232's pending cause and single refresh from main. Only file an implementation repair if a named cohort key proves the absence predicate should have fired and did not. | For a recovered key, immutable head lacks the task, main at that attempt has it, both plans load, but no own-task-record-missing-at-head cause or refresh occurs. No key in this cohort is established in this class yet. |
| Generated identity rejected on its historical branch | Preserve the guard until actual refusing branch and resolver evidence are known. If replay proves a legitimate producer emits an incompatible branch, propose a separate producer/identity repair limited to that shape, preserving refusal for unrelated filed ids. | Replay TRIAGE-evidence-coverage-inbox-response-served-model on its recovered refusing branch. If today's predicate admits it and resolution has no divergence, broadening the guard would not fix that attempt. #13151's terminal branch already passes the shape check. |
| Synthetic PR identity on a fix branch | #13355 already admits it; audit attempts after deployment and keep the same-head stall diagnosis. Foreign PR attribution is a separate concern already filed as W1-T10345. | PR-13121 on #13305's recorded fix branch still refuses metadata under a reviewer containing #13355, or a later genuine pending event is incorrectly treated as a refusal stall. |
| Unreadable/divergent plan or unknown reviewer deployment | Recover the resolver error or deployed SHA, then repair that exact read/deployment failure. Do not supply defaults for unresolved filed tasks or interpret unavailable evidence as a missing shard. | A recovered refusal resolves its own shard and criteria without divergence under the expected deployed reviewer; that eliminates this explanation. |

**Operator decision:** selecting or changing default risk or a dollar cap is an
operator decision. The values above describe existing code: `DEFAULT_RISK` is
`medium` and `UNTASKED_REVIEW_BUDGET_USD` is 15. This investigation selects no new
value and does not infer fresh approval from their existence.

The requested separate implementation filings are not performed: the only
declared task file is this forensic document, and creating `plan/tasks.d/` records
would exceed that scope. Existing fixes and W1-T10345 are identified instead of
inventing new task ids. Any further filing must follow the complete cohort replay
and the operator-checkout reservation workflow. Unknown keys may reveal further
cause classes, so the proposal table is provisional rather than an exhaustive
repair program.

### Validation and limits

Existing behavior probes are in:

- `test/an-untasked-pr-silently-skips-the-semantic-reviewer.test.ts`: resolved
  missing-budget defaults; synthetic PR defaults; generated TRIAGE/main-repair
  defaults; exact generated-branch guard; missing filed-task refusal.
- `test/a-build-head-missing-its-own-task-record-is-refreshed-not-escalated.test.ts`:
  missing-own-record pending cause, refresh, conflict/second-miss escalation,
  and absent/unreadable-plan controls.
- `test/a-stalled-stage-escalation-waits-for-a-live-review-and-never-holds-a-fix.test.ts`:
  repeated setup refusal escalates with its cause, while a later live review defers.

These tests drive local fixtures and validate current control flow. They neither
run a production semantic model nor establish historical per-key outcomes. Their
results must not be substituted for the missing ledger census. The three task
grep proofs establish the requested section headings only; substantive cohort
completeness remains explicitly unproven.

Validation on the inspected code SHA completed with TAP summaries: the three
behavior files above reported `# tests 22`, `# fail 0`. The census-selected
`test/the-knowledge-gardener-pins-its-own-retirement-golden.test.ts` and accompanying
`test/docs-index.test.ts` reported `# tests 36`, `# fail 0` in a separate run.
The census command was given the two edited paths explicitly because its default
input is the committed diff, while these edits are left for the harness to commit.
It also reported unmodelled candidates; no complete census-coverage claim is made.
Both cheap ratchets returned OK. The source-size command could not refresh
origin/main because FETCH_HEAD is read-only, and named cached base `c8a55054a427`;
it measured zero changed source files. Docs-index freshness and path checks pass.
