## Summary

- file W1-T3996 for the core follow-up to console PR #1584
- keep durable operator-agent history/settings reads off the synchronous request path
- preserve ledger-union coverage, conservative unavailable states, and read-after-write behavior

## Acceptance

- `unit test: operator-agent reads use the refreshed memory snapshot without a synchronous union read`
- `unit test: a cold operator-agent snapshot is unavailable rather than an observed empty ledger`
- `unit test: operator-agent writes invalidate the snapshot for read-after-write`
- `grep: buildOperatorAgentRoutes in src/lib/serve.ts`
- `grep: readLedgerUnionRecordsSync in src/lib/operator-agent.ts`

This is a plan-only filing. The implementation will follow after this task is merged.
