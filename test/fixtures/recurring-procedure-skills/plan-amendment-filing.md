---
name: plan-amendment-filing
description: Amend a task file so a build can change a file outside its scope, with a proof the review accepts.
applies-to: implement, fix
---

## Procedure

- Run `git worktree add <dir> -b plan-amend-W1-T<n>-<ms> origin/main` for a separate worktree.
- Change only `plan/tasks.d/W1-T<n>-<slug>.yaml`: add each missing path to `files`, or settle the design.
- Add an `INVARIANT <slug>: <statement>` or a `NO-INVARIANTS: <reason>` line to `design`.
- Add a `reservation hand-off: <from branch> -> <to branch>` line to `note` when the filing branch does not hold the id reservation.
- Run `npm run lint-plan:fast` and confirm it reports 0 failing.
- Commit with the subject `chore(plan): amend W1-T<n> <what changed>`.
- Add an `Acceptance:` block to the pull request body with `grep: <text> in plan/tasks.d/<file>`, where `<text>` is on a non-comment line the amendment adds and is missing on `origin/main`.
- Run `./bin/rmd check-acceptance <body file>`.

Boundaries: when the task's own filing pull request is still open, add the `files` entries on that branch and do not open an amendment. Do not change any file but the task file.

## Evidence

- Fleet fix rounds wrote 659 `fix.scope_amendment` and 299 `fix.scope_needed` rows.
- The Azure hand lane cut 66 amendment branches and 63 amendment bodies; its ship logs record 23 waits for an amendment to merge.
