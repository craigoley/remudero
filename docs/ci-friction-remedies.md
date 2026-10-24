# CI friction remedies

This file is the ledger of remedies for the causes the ci-friction gardener (W1-T4435, `src/lib/ci-friction-gardener.ts`) prices. The gardener files one parked, `verify: human` shard per priced cause, and each shard's acceptance proof is `grep: ci-friction:<kind>:<name> in docs/ci-friction-remedies.md`, so a remedy counts as landed once a person records it here on a line that names that cause. Until then the proof stays unmet, and the file must not name a cause whose remedy has not landed.

## Remedies

- `ci-friction:check:ci-log:ci` — a pull request's CI pipeline logged failures but the
  specific check that failed could not be determined from the logs. This is a catch-all cause
  that fires when ci-log dispatches occur without a clear, parseable failure signature. To fix:
  read the CI logs from the failed pull request to identify the actual check that failed and
  the error message, then apply the remedy appropriate to that specific check (inspect the
  coverage-ratchet, run commitlint, examine test output, etc.). If a check fires often this way,
  consider improving its error message or logging to make the failure more parseable.

- `ci-friction:check:ci-log:coverage-ratchet` — inspect the coverage-ratchet report for the
  uncovered changed lines, add focused tests for those behaviors, and rerun the coverage gate
  against the same committed tree before pushing.

- `ci-friction:check:ci-log:commitlint` — the required commitlint check rejected the pull
  request title. Read the check output, then rewrite the PR title as a Conventional Commit
  header (`type(scope): lower-case subject`) using an allowed type, keeping it at 100
  characters or fewer and without a final period. The check validates the PR title, so amend
  that title and rerun commitlint; changing branch commit messages alone does not fix it.

- `ci-friction:check:ci-log:coverage-ratchet:diff-coverage-blocked-this-diff-adds-source-line-s-with-zero` —
  the diff-coverage gate found added source lines with no coverage. Use the gate's uncovered-line
  report to identify each behavior, add focused tests that execute those lines, then commit the
  tested tree and rerun diff-coverage against that same commit. Confirm the lcov data instruments
  every changed source file before treating a passing diff-coverage result as evidence.

- `ci-friction:check:ci-log:coverage-shard:test-cost-anomaly-test-ts` — a test run in the
  coverage-shard phase exhibited anomalously high execution time, costing more CI minutes than
  expected. To fix: identify the specific test file and test case responsible for the cost spike
  (check the coverage-shard logs and timing report); analyze the test for expensive operations
  (file I/O, network calls, large fixture setup, or slow assertions); optimize the test by
  reducing fixture size, parallelizing independent operations where safe (respecting the
  `node --test` run-one-at-a-time constraint), or breaking the test into smaller focused cases;
  if the test is inherently expensive but necessary, document the reason in a comment and update
  the cost baseline. Run `rmd preflight --coverage` to measure the effect locally before pushing.

- `ci-friction:fix_refusal:no-anchored-commit-message-line-in-the-report` — the shell-less
  harness requires the worker's REPORT to end with an anchored `COMMIT_MESSAGE:` line that
  names the commit subject in Conventional Commits format (`type(scope): subject`, lower-case,
  no final period, at most 100 characters total). Without this line, the harness cannot commit
  the worker's edits to the branch. To fix: add `COMMIT_MESSAGE: <type>(<scope>): <subject>`
  as the last line of your REPORT, exactly anchored at the line start, following Conventional
  Commits conventions (type is one of: build, chore, ci, docs, feat, fix, perf, refactor,
  revert, style, test; subject starts lower-case).

- `ci-friction:fix_refusal:the-task-declares-no-files-so-there-is-no-surface-to-stage` — a
  task filed with an empty `files:` list (such as a plan-only task or certain synthetic tasks)
  cannot declare a surface for the worker to edit. The `commitWorkerEdits` function in
  run-task.ts refuses outright with this reason when `declaredPaths.length === 0`, preventing
  any commit even if the worker makes valid edits. To fix: if the task is a synthetic task
  (plan-only, TRIAGE, PLAN, APPROVE, or RETRO lane), pass the PR's `changedPaths` (its
  current diff) via the `fixRungTaskFor` function in sweep.ts as part of the task's surface,
  giving workers an implicit surface to commit within; or, if filing a new plan task, declare
  an explicit `files:` list matching the scope of intended changes.

- `ci-friction:fix_refusal:the-worker-changed-nothing` — `git status` after the worker's run
  showed no modified files in the repository, so the harness refused to create a commit. This
  happens when a worker completes its task but does not edit any of the declared files, or
  edits only files outside the task's declared scope. To fix: check whether the task's
  acceptance criteria are already satisfied on the current HEAD; if so, end your REPORT with
  `ALREADY_SATISFIED: <PR url or number>` naming the prior PR that already merged and carries
  `Remudero-Task: <task-id>`. Otherwise, verify you edited files in the declared `files:`
  scope and that your edits are syntactically valid (no parse errors or write failures from
  your tools); use Read/Edit/Write on declared files, never undeclared ones.

- `ci-friction:fix_refusal:every-change-the-worker-made-is-outside-its-declared-files` — the
  worker made changes to the repository, but every changed file falls outside the task's
  declared `files:` scope. The `commitWorkerEdits` function (src/run-task.ts) filters staged
  changes by the declared surface and refuses to commit when the only edited files are
  undeclared (outside `declaredPaths`), preventing progress even though changes exist. To fix:
  verify that your edits target files listed in the task's `files:` field (read the task
  record to see its declared scope); use Read/Edit/Write only on those declared paths. If the
  task's scope is genuinely too narrow and should have named more files, escalate: the task's
  `files:` declaration is the contract and cannot be unilaterally widened mid-run; file a
  follow-up task to correct it.

- `ci-friction:check:ci-log:proof-discrimination` — a pull request's acceptance proof is
  non-discriminating: it matches both the PR head and the merge base, meaning it would have
  passed before the work was done and therefore cannot prove the work was actually
  implemented. This is detected by the `proof-discrimination` gate (W1-T273), which compares
  each acceptance proof's execution at head versus the pre-work merge-base. To fix: verify
  that your acceptance criterion's proof (typically a grep) matches only at the HEAD and not
  at the merge base. Run `rmd check-proof --base` locally to test your proof against the
  merge base; adjust the proof text to be more specific or distinctive, or reword the claim
  to something your implementation genuinely changed, then verify the revised proof passes
  head-only before pushing.

- `ci-friction:check:ci-log:acceptance-author-gate` — a pull request's acceptance criteria
  failed validation at author-time (before a full CI cycle). The `acceptance-author-gate`
  required check validates the `## Acceptance` block in the PR body, any `Remudero-Task:`
  trailer, and acceptance proofs against the declared task's criteria. To fix: check the
  gate's error message for the specific defect (e.g., `proof-shape`, `trailer-body-proof-divergence`,
  `grep-proof-target-missing`, `rule-15-split`, or `plan-only-implementation-trailer`). Common
  fixes include: (1) ensure the `## Acceptance` block uses recognized proof syntax (`grep: <pattern> in <path>`
  or `unit test: <name>`); (2) verify grep proof target files exist at the current HEAD;
  (3) if a `Remudero-Task:` trailer is present, ensure its acceptance proofs match the task's
  declared criteria in the plan, or remove the trailer and author the body's own `## Acceptance` block;
  (4) if the PR is plan-only (no implementation files), remove any `Remudero-Task:` trailer
  or implement the non-plan files declared in the task; (5) for multi-commit PRs, check that
  follow-up commits do not add implementation trailers to plan-only diffs. Run `node --import tsx scripts/acceptance-author-gate.mjs --event-path <event.json>`
  locally with a test event payload to validate before pushing.

- `ci-friction:check:ci-log:comment-load-ratchet` — a pull request's added or changed code
  carries more comment lines than are allowed. The comment-load-ratchet gate measures comment
  density and enforces ceilings to manage the context burden that comment lines impose on every
  agent session opening the file (see docs/comment-standard.md). A failure means either: (1)
  a file's total comment count now exceeds its recorded baseline (check
  `scripts/comment-load-baseline.json`), or (2) a single added comment block contains more
  than 25 consecutive lines. To fix: review the added comments against the four principles in
  docs/comment-standard.md (relevant, findable, understandable, usable); shorten or remove
  comments that do not state an invariant, name a trap, point to a falsifier, or cite a record;
  split large blocks into smaller focused comments; or, if the diff inherited growth from
  the merge base (the file already carried more comments there), the baseline will be recorded
  automatically. Run `npm run --silent comment-load-signal` locally to check your own changes
  before pushing.

### comment-load-ratchet recurrence since the ratchet repair wiring

W1-T10240 observation, 2026-10-21: the post-wiring fix-round count is **unavailable**,
not a measured zero. This worker has no permitted live ledger corpus; the checkout has no
`state/` directory. The wiring's deployment time, observation-window bounds, newest ledger
timestamp, positive controls and live policy enablement are therefore unverified. No conclusion
about recurrence or its absence follows from this observation.

At the inspected checkout, `src/lib/sweep.ts::recordableRatchetRepairFor` is called by the
blocked-fixable disposition's reason builder. Execution separately uses
`ratifiedBaselineRatchetRepairFor`: it requires `recordableRatchetRepairEnabled`, a
`repairRecordableRatchet` executor and an entirely admitted red-check set. Success logs
`sweep.ratchet_repaired`; a declined repair can fall through to an ordinary fix round.
`src/lib/policy.ts` defaults the enablement flag to false when omitted. These source facts
establish a conditional repair path, not that a deployed daemon took it.

The originating [PR #12776](https://github.com/craigoley/remudero/pull/12776) is closed and
unmerged according to the GitHub API. Its
[closing discussion](https://github.com/craigoley/remudero/pull/12776#issuecomment-6256733167)
attributes the old task's rounds to a sibling mutation failure's incorrect attribution and
an instrument-scope gap. Those rounds do not establish post-wiring comment-load recurrence.

Decision: retain this follow-up pending measurement; a further remedy is **undetermined**.
Withdrawal requires a covered post-deployment window with a measured zero. The measurement
must count distinct ordinary fix rounds actually attributed to comment-load-ratchet, retain
each PR's other failing gates and disposition, and distinguish successful deterministic
repairs from declined repairs and disabled policy. Read the retained ledger union, record
its window and positive controls, and deduplicate rounds by their identifiers rather than
counting repeated sweep observations. A nonzero count warrants examining those individual
causes before proposing another remedy.

- `ci-friction:check:ci-log:task-id-existence` — a pull request's diff cites a task id
  (e.g., `W1-T1234`) in source code, documentation, or plan files, but that id is not
  declared in any plan shard and has no reservation ref (`refs/rmd-id/W1-T<n>` on the
  remote). This gate enforces that every cited id is either declared in the plan or
  reserved before being shipped. To fix: (1) if the id is a legitimate task reference that
  was filed and merged, add it to the baseline exemptions (scripts/task-id-existence-baseline.json)
  with a written reason (e.g., "issued in W1-TNNNN, merged and folded away"); or (2) if
  it is a new id being cited, reserve it with `rmd mint --reserve` and re-run the gate, or
  remove the citation if it is not a real task; or (3) if the citation is an EXAMPLE (to
  illustrate a placeholder), use the placeholder form instead (e.g., `W1-T<n>` or `W1-TNNNN`)
  — these carry no digits and will not match the citation scan.

- `ci-friction:check:ci-log:lint-plan` — the required `lint-plan` CI job refused a plan change.
  Reproduce the diff-scoped check locally with `npm run --silent lint-plan:fast`, which runs the
  offline linter against the merge base and `origin/main` scope used by CI. If it reports a
  violation, fix the offending task shard's proof, metadata, or other reported field; lint-plan
  violations are repaired in that shard, not in a shared baseline. If CI reports
  `lint-plan:error` before the linter runs, inspect the `lint-plan:base-refresh` output and restore
  a reachable, pinned `origin/main` ref, then rerun the linter. Keep the failure output with the
  fix so the changed plan can be checked again before pushing.

- `ci-friction:conflict:merge-conflict` — a pull request cannot be merged automatically
  because the branch has diverged from main and git cannot resolve the conflicts in the
  files being changed. This commonly occurs when multiple PRs modify the same file (such as
  `plan/tasks.d/*.yaml`, `package.json`, `MASTER-PLAN.md`, or similar shared files) and
  merge in an order that creates overlapping changes. To fix: fetch the latest main branch
  locally, rebase your PR's branch onto the current main (`git fetch origin && git rebase
  origin/main`), resolve any conflicts manually by editing the conflicting files, run the
  tests to verify the resolution is correct, then force-push the rebased branch (`git push
  --force-with-lease` or `git push -f`). If the conflict is in a plan file, coordinate with
  other in-flight PRs to sequence merges carefully, or consider splitting the plan changes
  into separate PRs to minimize collision surface.

- `ci-friction:check:gate-fix` — a pull request failed review with no unmet acceptance
  criteria, but the sweep identified one or more structured gate failures with a single,
  unambiguous remedy for each (W1-T2236, W1-T923). The fix rung dispatches in `gate-fix` mode
  carrying that specific remedy instead of the old behavior of "empty reviewer-unmet" dispatches.
  To fix: read the dispatch prompt's `actionableGateFailures` section carefully; it names a
  SINGLE remedy that the sweep has already verified is both structured and actionable (not a
  choice). Implement that exact remedy — for example, if it names "fix a merge conflict in
  CHANGELOG.md", resolve that conflict, test, and commit; if it names a specific lint-plan
  violation, repair the plan shard and re-run the linter. The remedy text is VERBATIM from the
  gate's own structured failure ledger, not a human interpretation — follow it precisely.
  Do not attempt to guess additional remedies or solve for criteria; the sweep already
  determined that applying this one remedy is the correct path forward.

- `ci-friction:check:reviewer-unmet` — a pull request's acceptance proof for a criterion
  is non-executable: typically, a `unit test:` proof whose title does not match any actual
  test name in the test files. This includes titles that appear only in comments rather than
  in actual `test(...)` invocations. When a worker writes an acceptance criterion with such a
  proof, the PR enters reviewer-unmet mode and dispatches to a fix worker, only to have the
  reviewer reject the criterion's proof at review time. The pre-push hook (see
  `scripts/proof-resolve-precheck.mjs` and `certainHeadRefusals` in `src/lib/review.ts`)
  catches certain proof failures before pushing. To fix: (1) when authoring acceptance
  criteria, ensure your `unit test:` proofs match the exact test name or file path in the
  codebase (run `npm run --silent source-text-census -- test/` to verify your test file
  names); (2) if adding a new acceptance criterion with a test proof, write the test first
  and verify the proof matches its actual name before opening the PR; (3) the pre-push hook
  will warn you of certain mismatches (`no file under test/ contains the title` or `only in
  comments`) — fix those before pushing. If the hook passes but the reviewer still rejects
  the proof, re-read the test file to ensure the title is in a `test(...)` invocation, not
  only in a comment header.

- `ci-friction:check:ci-log:head-identity-gate` — the PR head did not expose an identity the
  required `head-identity-gate` could verify. For new work, use a session branch shaped
  `run-<taskId>-<epochMs>` for a filed task or `run-unfiled-<epochMs>` for unfiled work. For an
  existing PR whose head ref cannot be renamed, amend its head commit with an anchored
  `Remudero-Task: <id>` trailer and push that update. The gate inspects the actual PR head commit,
  following first parents and ignoring merge commits, so a base-branch update merge cannot supply
  the identity; check the exact head ref and commit before retrying the gate.

- `ci-friction:check:ci-log:ci-shard` — a `ci-shard (N/8)` job in `.github/workflows/ci.yml` went
  red with no node-test summary (`# tests` / `# pass` / `# fail`) anywhere in its output. Its
  step exits with `::error::` and a `W1-T2597: NO-SUMMARY SHARD` line in `$GITHUB_STEP_SUMMARY`,
  because a killed or timed-out run prints only the assertions it reached. That red is UNVERIFIED:
  its failure set is a subset by construction, so it is not a diagnosed failure. To fix: do not
  push a code change against the failing test names read from that shard. Read the shard's
  step summary to see whether it timed out or was killed, then re-run that one shard (or the whole
  PR's CI if the aggregate is stale) to obtain a complete summary before deciding what is broken.
  Do not raise `timeout-minutes` on a shard without reading the W1-T1009 invariant that keeps it
  below `ci-gate.yml`'s `WAIT_CAP_SECONDS`.

## W1-T5309 root mechanism

The W1-T4810 remedy entry exists: the `ci-friction:check:ci-log:coverage-ratchet`
bullet above advises adding tests and measuring the same committed tree. Its owning shard is
`plan/tasks.d/W1-T4810-check-ci-log-coverage-ratchet.yaml`; that advice changed no execution
path. W1-T5309's shard records 458 rounds on 292 PRs and a later scope refusal: its declared
`src/lib/ci-parity.ts` and test file could not change the dispatch logic in `src/run-task.ts`.
Those counts are historical class-level evidence, not 458 diagnoses of one defect.

### Where the check and the rounds live

In `src/lib/ci-parity.ts`, `CI_PARITY_TABLE`'s `coverage-ratchet` entry refreshes the base,
runs `testWithCoverageLeaf` (or explicitly leased `testWithCoverageShards`), then executes
`scripts/coverage-ratchet.mjs` and `scripts/diff-coverage.mjs` against the resulting lcov.
`runPreflightCoverage` supplies the opt-in full coverage/diff-coverage path. These local
engines do not decide whether the fix rung dispatches a worker.

In `src/run-task.ts`, `coveragePrecheck` selects affected suites and delegates to
`judgeCoverage` in `src/lib/coverage-narrow.ts`. It first tries the diff's own tests and
direct importers, then the reach-based tiers, with
`PREFLIGHT_SCOPED_COVERAGE_SUITE_CEILING = 40` and manifest-derived execution bounds.
`coveragePushRefusal` refuses only `uncovered`: `unavailable` and `uncovered-narrow` are
logged and allowed through. `pushFixRoundPrechecked` uses that decision for fix pushes;
the implement lane's `fallback_push` uses it before initial publication and invokes
`repairCensusRefusedPush` only on a confirmed refusal. That repair itself spends worker
strikes; moving a refusal there alone does not eliminate paid repair work.

The concrete escape is an unproven source head: a reach set above 40 suites, a full-run
selection, timeout, spawn failure or missing instrumentation can leave no authoritative
pre-push verdict. A narrow run with gaps becomes advisory when the reach cannot be run;
`coverage-narrow.ts` documents the prior 2,503-suite reach for a `src/run-task.ts` change
on PR #11677. CI can subsequently report uncovered added lines from a wider run.
`runFixRung` constructs `ciFailures` evidence, derives the `ci-log` mode, spawns the repair
worker and records `fix.dispatch` with `ci_failures`. Publishing before coverage is settled
therefore permits the late-discovery/test-repair cycle the existing paragraph cannot prevent.

### What the evidence excludes

The hosted `coverage-ratchet` name also aggregates shard/test failures, missing artifacts
and coverage checks; it is not synonymous with an uncovered-line diagnosis. The gardener's
`ciLogCauses` in `src/lib/ci-friction-gardener.ts` drops that aggregator when a producer
signature identifies the failure. W1-T5309's historical rows do not include enough per-PR
diagnostics to establish which subtype dominates, or how often today's narrow pass escapes.
The path above establishes a mechanism, not a measured current share of all rounds.

The installed behavioral tests preserve this distinction:
`test/the-coverage-precheck-asks-the-diffs-own-suites-first.test.ts` asserts that an
over-ceiling narrow gap returns `uncovered-narrow`, while
`test/a-worker-catches-its-own-diff-coverage-drop-before-pushing.test.ts` asserts that
`coveragePushRefusal` permits `unavailable`. Raising the ceiling alone would restore the
failure recorded in `test/a-coverage-precheck-too-large-to-be-quick-is-skipped.test.ts`:
a 1,839-suite synchronous precheck held the daemon for 42 minutes and its push then failed
on an expired token. The fallback must therefore run in an admitted child off the daemon loop.

Retuning aggregate floors is unsupported: the installed `scripts/coverage-baseline.json`
has neither `linesPct` nor `branchesPct`, and `classifyCoverageTier` in
`scripts/coverage-ratchet.mjs` makes branch tiers nonblocking. Diff coverage remains a
separate blocking check. Suppressing every round named coverage-ratchet would also suppress
real test and artifact failures. Another advice paragraph or a change confined to the
local parity table cannot close the publication gap in the orchestrator.

W1-T5309 chosen structural fix: add an orchestrator-owned full coverage fallback before
publishing a source head whose scoped precheck is `unavailable` or `uncovered-narrow`,
reusing the existing coverage engine and diff gate in an admitted child off the daemon loop
on that same committed head. Keep an
unmeasured result explicit and defer publication; return confirmed uncovered-line evidence
to the author before PR creation. This targets the demonstrated escape without changing
coverage policy or treating unrelated aggregator failures as repairable coverage debt.
The implementation needs `src/run-task.ts` in its declared scope; this section records
the proposal only. Validate it with an over-ceiling fixture that cannot publish until an
authoritative result exists, and compare later head-linked precheck/CI dispositions before
claiming fewer fix rounds.

## PR-13834 tested-merge-parent observation

W1-T10529 fixes the cohort at **PR #13834 only**, from 2026-10-23 21:29:15Z through
21:42:14Z. Its disposition is **refresh observed; identical material subtrees verified;
necessity and causal delay not established**. This packet records an observation, not a
landed refresh remedy. Existing remedies and other PR dispositions above remain applicable.

### Checkout and refresh provenance

The trusted checkout evidence is the `actions/checkout` step in
[CI run 40027123854, job 120666003041](https://github.com/craigoley/remudero/actions/runs/40027123854/job/120666003041).
The retrieved log explicitly fetches the fixed SHA into `refs/remotes/pull/13834/merge`;
its `git log -1 --format=%H` output at **21:29:34.8817714Z** is
`4c25bdf9ac1717701f9fde8372486bb9096d9293`. The immutable
[checkout commit object](https://api.github.com/repos/craigoley/remudero/git/commits/4c25bdf9ac1717701f9fde8372486bb9096d9293)
independently supplies these ordered parents and tree:

| Object | SHA |
| --- | --- |
| Exact reviewed PR head | `f6d321730212dfae23dda6d4688fd71f0c5d5c2d` |
| Checkout first parent, tested main | `358ab4af0c10e845281c657fbfec5edb9ba1ef3b` |
| Checkout second parent | `f6d321730212dfae23dda6d4688fd71f0c5d5c2d` |
| Checkout root tree | `49f1c3179442194c7da22978afffcaeb09c081ae` |
| Actual refreshed head | `7fb436e4ed6f376f2136fe5ad79e8353b09f1704` |
| Refresh first parent | `f6d321730212dfae23dda6d4688fd71f0c5d5c2d` |
| Refresh second parent, new main | `28bced98f83bf1a35eab0419b507b11538b419ae` |
| Refresh root tree | `112027c8d2fed6c3ddded025cf32fa8037a6513a` |

The [refresh commit object](https://api.github.com/repos/craigoley/remudero/git/commits/7fb436e4ed6f376f2136fe5ad79e8353b09f1704)
timestamps the merge at 21:42:12Z, verified at 21:42:13Z. Both objects name the same
reviewed head, despite opposite parent ordering. The
[run metadata](https://api.github.com/repos/craigoley/remudero/actions/runs/40027123854)
says attempt 1, event `pull_request`, head `f6d3217`, and ultimately `cancelled`, updated
21:44:06Z. That head field alone does not identify the tested main parent. A rerun needs
its own attempt/job checkout evidence; a moving pull merge ref or current main cannot
substitute for the SHA logged by the actual job. Missing, contradictory or unmatched
head/parent evidence is UNKNOWN. Checkout evidence establishes the tree used, not that
every check completed or passed on it.

The task's pinned rationale records this decision sequence on 2026-10-23:

| UTC time | Recorded event and disposition |
| --- | --- |
| 21:41:31 | `sweep.update_branch.pending_guard` |
| 21:42:11 | `sweep.refresh.decided`: `path: general`, `ci_in_flight: true`, `decision: refresh`, judge `overlap` |
| 21:42:13 | `sweep.update_branch.updated` |

That exact decision is reported with `strict: false`, `update_reason: distance-unknown`,
`overlap_count: 0`, `overlap_files: []`, `predicted_cost_ci_min: 36.6`, and
`predicted_benefit: 0.005`. These fields are **secondary evidence from the filed task**;
the raw daemon ledger was not available to this worker. Historical branch-protection
strictness is recorded false there, not independently certified from a historical protection
snapshot. The judge's generated reason is **UNKNOWN**; the policy's generic sentence
"the judge ruled overlap" is not the model's explanation. The native machine-filing
judge's separate, real `proceed` ruling is in the task's `risk_ruling`, judged
2026-10-24T00:14:35.499Z, pin
`543e6bf3ccbd66bef26821cd16a5553e1640a3ffabe9723dece8972d1fddebd9`.
It authorizes this bounded documentation task, not a refresh-policy change.

### Control: already-tested source is not new main overlap

Direct Git Trees API reads of both root trees give identical mode/type/SHA entries
everywhere except `plan`. The following subtree IDs are equal at checkout and refresh:

| Subtree | Object ID at both endpoints |
| --- | --- |
| `src` | `92e7d80c1bfe89fc84af0f6137af693b5df104db` |
| `test` | `9d7bf4e8aca61b364d69c38a7ded1c587d32c4ce` |
| `scripts` | `48dab399af991e7ae916e1b7db042ccb8fd25666` |
| `.github` | `a7f0c85d3bb6b33df2cea302eb5337f2160216fa` |

Walking the differing `plan` trees (`cc0d556659bc384107f9c49847ae73f09ea7d5ae` and
`d3c02ad14f44102c4e3fda2492e83943b35ef14d`) finds only `feedback` different. Both feedback
responses contain 466 entries and `truncated: false`; their sole differing entry is
**`plan/feedback/incident-ac8200367eff4984.yaml`**, blob
`1f4d0d7e8b68994fb54d778e5266a4fb24549564` becoming
`65390af44c24b3dd81beac872cd709f0b251f8aa`. Root and plan responses are also untruncated.
This is the complete endpoint path delta, with the differing feedback blob as a positive
control that the traversal detects change. Equal material trees do not prove a plan-file
change cannot affect a check that reads plan data.

The ordinary [three-dot comparison](https://github.com/craigoley/remudero/compare/4c25bdf9ac1717701f9fde8372486bb9096d9293...7fb436e4ed6f376f2136fe5ad79e8353b09f1704)
instead reports a diverged history with merge base `358ab4a`, and lists the feedback file,
`src/lib/review.ts`, `src/run-task.ts`, and
`test/review/a-reviewers-explanation-reaches-the-binding-verdict.test.ts`.
It includes the PR's own changes relative to that ancestor; it is not the endpoint tree
delta. The equal subtree objects are the control against treating that list or a branch's
behind-count as proof that running CI missed source changes.

Keep a separate **controlled counterexample**, not another observed fleet disposition:
a tested checkout contains version A of a PR path `src/mine.ts`; subsequent main changes
that path to version B, and the proposed merge retains B. Its endpoint blob and `src` tree
then differ, so the running checkout genuinely has not tested B. Such a reaching change
must not be removed merely because the PR head is unchanged or some other subtrees match.
An in-memory Git-object control was executed with A = `export const value = 1;\n` and
B = `export const value = 2;\n` (each escape denotes one newline). SHA-1 of the Git object
header plus body gives these independently reproducible objects:

| Constructed object | A, present in checkout | B, only in proposed merge |
| --- | --- | --- |
| `src/mine.ts` blob | `efeee5db16c087416d13e29bc506c998eeaf0827` | `44439d586e1d6f28c15c50f049a1dd236a64c2c6` |
| `src` tree | `e0fa89872730f07aa4ab773082d39c4c4401913f` | `c9e36d9512e114c69d5f22b80f72000ab6e70737` |

Each tree body is `100644 mine.ts`, NUL, then the raw 20-byte blob ID; object headers are
`<type> <body-byte-length>` followed by NUL. Assertions verified A/A tree equality,
A/B tree inequality, and the exact endpoint delta `["src/mine.ts"]`. This constructed
counterexample has a new main version absent from the modeled checkout, not merely an
ancestry distance. It is not a second historical case or evidence of CI completion.
The installed test `a ready PR 2 commits behind whose own file main changed is selected
with reason ready-overlap` in
`test/a-ready-pr-is-refreshed-when-main-changed-its-files-since-its-ci-ran.test.ts`
provides the behavioral reach control: `src/mine.ts` appears in both the PR paths and the
main delta, and the sweep updates that PR with `matching_base_files: ["src/mine.ts"]`.
This fixture verifies reach behavior; it does not reconstruct historical checkout objects
or establish a second live occurrence. Its ready state also differs from #13834's pending CI.

### UNKNOWN and separate refresh-policy decision

At this checkout, `buildBehindMainByPr` in `src/lib/tick-read-worker.ts` reads
`compare/<pr-head>...main`, and records a main list only when a files array and finite distance
are available; 300 or more files marks it truncated. `buildRefreshValueGate` in
`src/lib/sweep.ts` sends those files and `view.changedFiles` to the judge, with no tested
checkout or tested parent. Missing PR files become `[]`; missing main files become `[]`
with `baseTruncated: true`. `refreshOverlapOf` treats unknown/truncated lists as ambiguous.
`decideRefresh` in `src/lib/refresh-value.ts` allows the in-flight arm to refresh after an
overlap ruling. `parseRefreshJudgeReply` retains the verdict, not the model reason.
These symbols still exist; the filed task cites symbols rather than file:line locations.

For the historical decision, PR files are **UNKNOWN** (availability and completeness both
unknown); main-delta files are **UNKNOWN** (availability and truncation both unknown).
Neither list is certified known-empty. The recorded empty overlap is an intersection/reach
result, not a snapshot of either input. Current PR file lists or reconstructed tree deltas
cannot certify what the judge received then. The input mismatch is therefore a plausible
mechanism supported by the installed wiring, not proof of the model's reasoning.

Exact corpus opened for this packet: the local instructions, task shard, existing guide,
the named source functions and reach-control test; remote main copies of the shard and
guide; task-ID PR search results #13844/#13861; PR #13834 metadata; run 40027123854 metadata;
job 120666003041's decoded log; both immutable commit objects; both root trees, both plan
trees and both feedback trees; and the three-dot comparison above. The log ends at
2026-10-23T21:38:46.0020522Z, before the decision; the run's metadata extends to 21:44:06Z.
The newest timestamp in this selected historical corpus is PR #13834's `updated_at`,
2026-10-24T01:30:53Z. It merged at 01:30:50Z as `49192236f733b419c470769c047c703635a06a7f`.
The corpus answers what this job checked out and how its tree differs from this refresh;
it does not cover the daemon's ledger union, other jobs' completed checks, or the fleet.
No fleet-wide absence, recurrence count, saved-run count or measured latency follows.

The unnecessary-source-refresh hypothesis is falsified by a mismatched head/parent pair,
a differing allegedly equal subtree, or evidence that this refresh served a distinct
mandatory repair or strict-protection trigger. A second case with another mechanism keeps
its own disposition and defeats grouping it into this explanation. The run's cancellation
is observed, but attributing final PR delay to this refresh is an inference: later pin
repairs, additional pushes and reconciliation confound the interval to merge.

A possible separately reviewed input is the exact tested merge parent plus checkout tree,
joined to head, run attempt and job, followed by the proposed merge's endpoint tree delta.
Only verified equality can identify already-tested material. Missing, truncated,
contradictory or unmatched evidence must remain **UNKNOWN**, retaining existing refresh
evaluation rather than granting an equality-based exemption. Assess plan-data reach too.
Any class-wide implementation requires its own reviewed proposal after this observation.
This packet changes no runtime, automatic refresh, judging, budget, check or assertion,
and authorizes no worker, claim, service, model-routing or main-protection action.
