- **Derive "which tasks are merged" from the `Remudero-Task:` trailer on merged PRs — never from
  ledger verdict lines.** The dominant merge path here is GATE-SIDE: the PR merges after the run
  already ended `blocked`/`blocked_ci`, so that task never writes a `merged` verdict and a
  ledger-only scan cannot see it. A ledger-built set gave 236 ids and offered long-merged work as
  runnable, naming W1-T227/W1-T192 as the frontier when both had merged weeks earlier (#527, #457).
  Trailers give 301; unioned with the ledger, 311.
