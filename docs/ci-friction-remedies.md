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
