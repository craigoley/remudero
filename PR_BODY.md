## Summary

Amend the merged W1-T3920 plan record to include `src/lib/producer-completeness.ts`. The implementation now supplies the raw `mergeable` and `mergeableState` fields in production, so the stale `KNOWN_UNWIRED` entries must be removed in the implementation PR and the plan must declare that source surface.

## Acceptance

- claim: the W1-T3920 plan record declares the producer-completeness source that the implementation must update when raw merge facts become wired
  proof: grep: W1-T3920 producer census path in plan/tasks.d/W1-T3920-stale-blocked-auto-merge-refresh.yaml

## Validation

- `npm run --silent lint-plan -- --base origin/main`: 0 blocking violations (6 advisory warnings)
- `npm run --silent task-id-existence:check -- --base origin/main --require-open-prs --head-ref plan-W1-T3920-producer-census-1789958000002`: passed

This is a plan-record amendment only; no implementation source or test files are changed here.
