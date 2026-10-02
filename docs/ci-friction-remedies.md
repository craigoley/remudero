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

- `ci-friction:check:ci-log:coverage-ratchet:diff-coverage-blocked-this-diff-adds-source-line-s-with-zero` —
  the diff-coverage gate found added source lines with no coverage. Use the gate's uncovered-line
  report to identify each behavior, add focused tests that execute those lines, then commit the
  tested tree and rerun diff-coverage against that same commit. Confirm the lcov data instruments
  every changed source file before treating a passing diff-coverage result as evidence.

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
