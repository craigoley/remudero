## Summary

Reframe W1-T4420 around the operator's decision: validate PR bodies in a shared library seam used by the four existing automated openers. Keep the current REST writer; add no `rmd pr open` command, CLI/parity surface, or dependency-object interface.

## Acceptance

- claim: W1-T4420 now explicitly preserves the no-new-CLI and no-new-dependency-interface constraint
  proof: 'grep: Operator constraint, 2026-09-25: Do not add a new CLI verb or dependency-object interface in plan/tasks.d/W1-T4420-a-hand-opened-pr-gets-its-body-right.yaml'
