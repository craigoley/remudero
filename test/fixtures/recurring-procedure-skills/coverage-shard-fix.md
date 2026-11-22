---
name: coverage-shard-fix
description: Repair a red coverage shard or diff-coverage check by covering each listed line, or show that the failure is the host's.
applies-to: fix
---

## Procedure

- Open the failing check's log and copy each `<file>:<line>` under `diff-coverage: BLOCKED`, or each `not ok` test title.
- Run `git diff origin/main...HEAD -- <file>` for each listed file to see the lines the change adds.
- Run `rmd test-place <test path>` to choose the test folder.
- Add a test in the folder `rmd test-place` names that drives each listed line through its production entry path.
- Run `node --test --import tsx --import ./test/setup/tmp-hygiene.ts <test file>`.
- Run `npm run diff-coverage:local -- <test files>` and confirm it lists no line.
- Rerun each failing test file alone with the same command when the log lists `not ok` titles and no blocked line. When each passes alone on the same head, report a host flake with both results and change no file.

Boundaries: add a `diff-cov: process-boundary` directive only for a real process boundary (docs/review-gate.md). Do not delete or skip a test. In a test git repo, run `git init -b main`. To restore an env var that was unset, delete it.

## Evidence

- 3,971 `fix.dispatch` rows: coverage shards 1,348 failures over 8 shards, coverage-ratchet 230 (184 "diff-coverage: BLOCKED"), rule-checks 333, pre-push census-precheck 61.
- The Azure hand-lane triage logged 14 preflight attempts as host flakes (green alone) and 10 as real failures (red alone).
