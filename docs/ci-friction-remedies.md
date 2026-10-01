# CI friction remedies

This file is the ledger of remedies for the causes the ci-friction gardener (W1-T4435, `src/lib/ci-friction-gardener.ts`) prices. The gardener files one parked, `verify: human` shard per priced cause, and each shard's acceptance proof is `grep: ci-friction:<kind>:<name> in docs/ci-friction-remedies.md`, so a remedy counts as landed once a person records it here on a line that names that cause. Until then the proof stays unmet, and the file must not name a cause whose remedy has not landed.

## Remedies

- `ci-friction:check:ci-log:coverage-ratchet` — inspect the coverage-ratchet report for the
  uncovered changed lines, add focused tests for those behaviors, and rerun the coverage gate
  against the same committed tree before pushing.
