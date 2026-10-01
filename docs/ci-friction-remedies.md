# CI friction remedies

This file is the ledger of remedies for the causes the ci-friction gardener (W1-T4435, `src/lib/ci-friction-gardener.ts`) prices. The gardener files one parked, `verify: human` shard per priced cause, and each shard's acceptance proof is `grep: ci-friction:<kind>:<name> in docs/ci-friction-remedies.md`, so a remedy counts as landed once a person records it here on a line that names that cause. Until then the proof stays unmet, and the file must not name a cause whose remedy has not landed.

## Remedies

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
