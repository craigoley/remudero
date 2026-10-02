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
