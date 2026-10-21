# W1-T7898 follow-up: actual repairs for PRs 10578, 10628 and 10671

The three PRs had different repairs; the inspected `Analyze (actions)` reds were cancelled jobs,
not evidence of a shared CodeQL defect.

## Scope and duplicate reference

Investigated for W1-T9594 on 2026-10-21. The checkout and its local `origin/main` both resolve to
`460af11347d02c3e8d9283ec4ecd8494422f00fb`. The task record at that revision names this findings
file and three grep proofs; it contains no source file:line citations or implementation symbols
to re-resolve. The file was absent both locally and in the pinned GitHub tree before this change,
so none of those proofs already passed. This report uses historical GitHub job logs, commit
patches and API merge states, rather than treating a task's status as merge evidence.

The [W1-T7898 record](https://github.com/craigoley/remudero/blob/460af11347d02c3e8d9283ec4ecd8494422f00fb/plan/tasks.d/W1-T7898-the-analyze-actions-gate-refused-4-pull-requests-in-this-window-and-each.yaml)
literally carries `ci_learning_prs: [10578, 10628, 10671, 10671]`. This is three distinct PRs,
with #10671 repeated, not four established PR identities. The
[historical generator](https://github.com/craigoley/remudero/blob/2493aaff78bf8af9e650f3dcbb5a25dc15feb5d6/src/lib/measurement-cadence.ts)
(`mintCiLearningShards` and `ciLearningShardYaml`) appends `cluster.prs.push(p.pr)` for each repaired
pair and serializes `draft.prs` without deduplicating PR numbers. Repeated observations can
therefore produce this list mechanically. The two cancelled actions jobs inspected for #10671
below also show that it had more than one such observation.

**Typo disposition:** there is no evidence that the second #10671 was meant to name another PR.
Treat it as a duplicate reference to the same PR; the claim of four distinct pull requests is
incorrect. Repeated-pair generation is the supported explanation, but the original input pairs
were not recovered, so their exact provenance remains unverified. Do not invent a fourth number.

## PR 10578: literal acceptance titles; cancelled CodeQL analysis

[PR #10578](https://github.com/craigoley/remudero/pull/10578) merged on 2026-10-10 at
`a0b0ea205a0fc3506609f9cc62d7bcb96ac747c7` (API `merged: true`).

- **Observed check:** `Analyze (actions)`,
  [job 114137179598](https://github.com/craigoley/remudero/actions/runs/38026109155/job/114137179598),
  ended with cancellation at 05:02:55Z. The run API says `cancelled`; subsequent unsuccessful
  SARIF upload diagnostics do not establish a source-code or workflow defect.
- **Actual follow-up repair:**
  [6102f18eb](https://github.com/craigoley/remudero/commit/6102f18eb902a8b2665f6b4f14e26f6e5dfb058e)
  replaced loop-generated test names with three literal `test(...)` titles for disk, io and
  memory gardener captures, preserving the shared assertion helper. This lets the acceptance
  resolver find the verbatim titles in
  `test/a-gardener-capture-never-defers-the-deploy-code-refresh.test.ts`.
- **What cleared:** at that head,
  [CI 38026168203](https://github.com/craigoley/remudero/actions/runs/38026168203) and
  [CodeQL 38026168242](https://github.com/craigoley/remudero/actions/runs/38026168242) succeeded.
  The PR has only two commits; the follow-up changes test naming, not CodeQL configuration.
  Temporal recovery does not make the title change a CodeQL remedy.

For clarity, the original product fix was
[32c506d51](https://github.com/craigoley/remudero/commit/32c506d518e5cba33ef6a176e66aa8f31bab3cbf):
`deploy_code_clean` excludes untracked `plan/feedback/` inbox captures from its local-edit check
while preserving their bytes. That deployment fix and the acceptance-title repair are separate
from the cancelled analysis. No gate-specific CodeQL repair was demonstrated.

## PR 10628: await evidence reads, then exercise async inventory

[PR #10628](https://github.com/craigoley/remudero/pull/10628) merged on 2026-10-10 at
`faca80c758c94f35bfb1dd4be52172b094025c0a` (API `merged: true`).

| Failing check and evidence | Repair commit | Remedy that worked |
| --- | --- | --- |
| `coverage-shard (5/8)`, [job 114197649183](https://github.com/craigoley/remudero/actions/runs/38046727257/job/114197649183): `readFixLaneEvidence makes 2 synchronous spawn call(s)` reachable from `daemonCommand`; the retry also failed. | [95e94be0d](https://github.com/craigoley/remudero/commit/95e94be0db935d18a963e8f1a56871eeebb2aac1) | Replaced synchronous evidence transport with awaited `ghJsonAsync`/`ghTextAsync`, prefetched exact-head evidence into caches, and threaded `inventoryAsync` through the ladder and garden pass. Synchronous inventory without the required injected evidence refuses instead of spawning from the loop. |
| `coverage-ratchet` / `diff-coverage`, [job 114247784635](https://github.com/craigoley/remudero/actions/runs/38062526184/job/114247784635): uncovered `fix-lane-gardener.ts` lines 242–244, 266–268, 534 and 551–553 at that historical tree. | [9a270077b](https://github.com/craigoley/remudero/commit/9a270077b8ec15a498f87091f9be82f80e1f150d) | Added the synchronous-inventory refusal assertion and `async garden inventory reads injected exact-head evidence before pricing`, checking priced classes and one source/log read each. |

The branch also merged main in `005bb867d`, `9707212e9` and `ce9ce622e`; merging main alone did
not supply the async implementation and its missing coverage. The final head `9a270077b` has
[CI 38066707158](https://github.com/craigoley/remudero/actions/runs/38066707158) and
[CodeQL 38066707357](https://github.com/craigoley/remudero/actions/runs/38066707357) successful.

The inspected `Analyze (actions)`
[job 114243376512](https://github.com/craigoley/remudero/actions/runs/38062477929/job/114243376512)
was cancelled at 15:10:20Z. Earlier CodeQL runs also succeeded while CI still failed. The useful
remedies are async transport and behavioral test coverage, not a workflow edit or an allowlist
for the two synchronous calls.

## PR 10671: cleanup, census, coverage and head identity were separate failures

[PR #10671](https://github.com/craigoley/remudero/pull/10671) merged on 2026-10-10 (API
`merged: true`). Its original change waited for a timed-out checkout's process group before
removing the temporary worktree. The repair history addresses several additional surfaces:

| Failing check and evidence | Repair commit | Actual remedy |
| --- | --- | --- |
| `proof-discrimination`, [job 114241031688](https://github.com/craigoley/remudero/actions/runs/38061674090/job/114241031688): the old checkout-timeout proof passed at both head and merge base. | [16bb121a4](https://github.com/craigoley/remudero/commit/16bb121a4fdeeb61417037c6d9471c63e1df4373) | Renamed the acceptance test to identify the new process-group/materialized-checkout scenario. The next proof-discrimination run, 38061757587, succeeded. This was proof selection, not a runtime cleanup repair. |
| Coverage shards exposed cleanup behavior and census growth: [job 114243750905](https://github.com/craigoley/remudero/actions/runs/38062562679/job/114243750905) counted 10 raw git sites against 9; [job 114246387152](https://github.com/craigoley/remudero/actions/runs/38063468054/job/114246387152) also counted two `Date.now()` calls against zero. | [94c377cf9](https://github.com/craigoley/remudero/commit/94c377cf9a450dc3e66f7e6c77453fe2414cf5e7) | Routed async cleanup through `hostWorktreeGitAsync`, canonicalized paths, checked registration before/after removal, and removed a stranded admin directory only after verifying reciprocal pointers. Added a missing-admin-HEAD regression that preserves a neighboring worktree. Changed elapsed-time polling to `performance.now()` and lowered the raw-site exception count from 9 to 8. |
| `catch-erasure-census` through `coverage-shard (3/8)`, [job 114260694002](https://github.com/craigoley/remudero/actions/runs/38068381745/job/114260694002): three bare catches in `plan-pr-emitter.ts` against baseline zero. | [bfdff0329](https://github.com/craigoley/remudero/commit/bfdff0329758f0106e330a79d3ca92b22a9fe64e) | Bound path-resolution errors, tolerated only `ENOENT`, rethrew other errors, and retained the last removal failure in the final cleanup error. No catch-erasure baseline increase. |
| `W1-T5625` fixture containment census, [job 114266778140](https://github.com/craigoley/remudero/actions/runs/38070513072/job/114266778140): the new neighbor worktree was beside its fixture directory. | [6ffd5207a](https://github.com/craigoley/remudero/commit/6ffd5207a40a050db7438288fb7223a7cb081f9a) | Moved the neighbor to `join(repo.dir, "neighbour")` and updated its assertion, so fixture cleanup owns it. |
| `coverage-shard (7/8)`, [job 114270529902](https://github.com/craigoley/remudero/actions/runs/38071780499/job/114270529902): `a tick within one poll interval of a sampled daemon.alive carries none` saw `tick` instead of no sample. | Main merge [175a960f4](https://github.com/craigoley/remudero/commit/175a960f427914eee1e5a7d82c6d54ad7b573d6d) | Brought main's idle-memory fixture correction into the branch. The resulting fixture keeps its final heartbeat-to-tick gap one millisecond inside the poll interval; at exactly the interval a new sample is due. This is a main refresh for a different test, not a checkout-cleanup repair. |
| `coverage-ratchet` / `diff-coverage`, [job 114278598219](https://github.com/craigoley/remudero/actions/runs/38073198030/job/114278598219): uncovered `in-tree-budget.ts:59` in that tree. | [3535b41c0](https://github.com/craigoley/remudero/commit/3535b41c0ff37a710d7a4395f50d31c6e8270f62) | Added `process-group teardown polls while a detached child is still alive`: start a real detached child, enter the live-group polling path, kill it, and assert that teardown observes exit. |
| `head-identity-gate`, [job 114279591938](https://github.com/craigoley/remudero/actions/runs/38074853305/job/114279591938): nonconforming branch plus missing valid trailer on the newest head. | [2493aaff7](https://github.com/craigoley/remudero/commit/2493aaff78bf8af9e650f3dcbb5a25dc15feb5d6) | Added an empty head-identification commit with `Remudero-Task: PR-10671`. Earlier identity commit `38314b82d` had cleared the same gate, but later heads needed their own trailer. |

Two intermediate changes are not interchangeable with the successful remedies:
`4a28d43b8` documented conservative probe failure; `4a84ad5eb` shortened cleanup comments, including
changing a catch to `catch {}`. The latter did not repair catch erasure: the subsequent bound-error
change `bfdff0329` did. The raw-git, clock and fixture census failures belong to the changed
population; they must not be described as random flakes merely because their suites were not
named by the changed function.

The inspected `Analyze (actions)` jobs
[114241032046](https://github.com/craigoley/remudero/actions/runs/38061674081/job/114241032046)
and [114279592116](https://github.com/craigoley/remudero/actions/runs/38074853411/job/114279592116)
were cancelled. A separate CodeQL review also
[reported an unused `realTree` variable](https://github.com/craigoley/remudero/pull/10671#discussion_r4238701692);
that JavaScript/TypeScript finding does not explain an actions-analysis cancellation. The final
head `2493aaff7` has successful
[CI 38074936292](https://github.com/craigoley/remudero/actions/runs/38074936292),
[CodeQL 38074936249](https://github.com/craigoley/remudero/actions/runs/38074936249), and
[head identity 38074936259](https://github.com/craigoley/remudero/actions/runs/38074936259).

## Evidence limits

Historical line numbers above identify the logged failure trees, not current source positions;
the repair links pin the corresponding code. A successful final run verifies the combined head,
not that each intermediate commit independently made every gate green. Merge-from-main commits
also carry unrelated changes, so their aggregate file lists are not a diagnosis.

QUESTION: Who or what initiated the inspected cancellations?
CURRENT_ASSUMPTION: The initiator is unknown; classify these as cancellations without assigning a cause.
IMPACT_IF_WRONG: low

Cancellation logs and later successful runs do not distinguish manual cancellation from
superseding runs or other causes. No shared CodeQL-specific preventive fix follows from these
three cases. The observed remedies are literal proof titles,
async evidence inventory, cleanup/error handling, fixture corrections, test coverage and head
identity, each attached to its own failing check above.
