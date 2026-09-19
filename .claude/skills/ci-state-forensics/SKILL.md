---
name: ci-state-forensics
description: Establish the actual pull-request and CI state before reporting completion or taking another delivery action.
license: Apache-2.0
applies-to: implement
---

# CI State Forensics

Use this procedure when the task creates, updates, or reports on a pull request. Treat every
GitHub status as an observation with a timestamp and head SHA, not as proof by itself.

1. Identify the exact PR and head SHA. If GitHub access is unavailable, report `NOT OBSERVED`
   instead of inferring state from a local branch, PR title, or an older transcript.
2. Read the PR's `mergeable`, `mergeStateStatus`, reviews, and complete check list. A green
   subset is not a green PR: every required check must be terminal and successful.
3. Separate required checks from informational checks. Record each required check as
   `PASS`, `FAIL`, `PENDING`, `CANCELLED`, or `NOT OBSERVED`, including the check name and
   the observed commit when available.
4. Interpret conflicts before waiting on CI. `mergeable: CONFLICTING` or
   `mergeStateStatus: DIRTY` is a conflict, even when the check list is empty or reports zero
   checks; it is not a queued CI run.
5. Do not push a fresh commit only to clear a stale red aggregate. Re-read the current PR and
   check attempt first; a stale aggregate may self-clear. If a rerun is the sanctioned action,
   record who or what requested it and the exact attempt that was rerun.
6. Before reporting delivery, verify the final head SHA again and state the remaining blocker
   if any. `PENDING`, `FAIL`, `CANCELLED`, conflict, missing required check, or unavailable
   evidence means delivery is not proven.

Boundaries:

- Do not merge, enable auto-merge, deploy, or change branch protection.
- Do not treat a PR title, plan status, ledger line, or local test result as material GitHub state.
- Do not retry a check, push a no-op commit, or edit a PR body unless the task's acceptance
  criteria explicitly authorize that action and the current state supports it.
- Report OBSERVED, INFERRED, and NOT OBSERVED separately. Name the one observation that would
  falsify an inference before acting on it.
