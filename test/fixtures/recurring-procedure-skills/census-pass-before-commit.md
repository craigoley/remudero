---
name: census-pass-before-commit
description: Run the census and ratchet checks in one pass before a commit, in the order merged runs ran them.
applies-to: implement
---

## Procedure

- Run `git add <each new or changed path>` before any check. The checks count tracked files only.
- Run `npm run comment-load-signal`.
- Run `npm run source-size-ratchet`.
- Run `npm run test:tier:check`.
- Run `node scripts/coverage-session-blanking-check.mjs`.
- Run `npm run typecheck`.
- Run `git commit`, then run `node --import tsx scripts/census-precheck.mjs --base origin/main` and confirm it prints `census-precheck: OK`.

Boundaries: do not raise a baseline or a cap to pass a check. Do not skip a check that failed. Fix the count it names.

## Evidence

- `npm run comment-load-signal` ran in 530 runs (325 merged). Then `npm run typecheck` in 138 runs, `npm run source-size-ratchet` in 126, `npm run test:tier:check` in 117.
- Runs with this census median 70 tool calls and 21,758 output tokens; all runs with tool rows median 37 and 12,723.
