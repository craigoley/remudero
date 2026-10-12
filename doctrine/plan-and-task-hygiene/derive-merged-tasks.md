- **Derive "which tasks are merged" from merged PRs' `Remudero-Task:` trailer UNIONED with their
  `run-<taskId>-*` branch — never from ledger verdict lines.**
  *(Index lines retired 2026-10-11: the W1-T3323 bullets below split this instruction across two headlines, the second opening on "AND" as a continuation of the first. They are kept verbatim; their ids resolve here through `doctrine/merged-rules.json`.)*

- **Derive "which tasks are merged" from the `Remudero-Task:` trailer on merged PRs — never from
  ledger verdict lines.** The dominant merge path here is GATE-SIDE: the PR merges after the run
  already ended `blocked`/`blocked_ci`, so that task never writes a `merged` verdict and a
  ledger-only scan cannot see it. A ledger-built set gave 236 ids and offered long-merged work as
  runnable, naming W1-T227/W1-T192 as the frontier when both had merged weeks earlier (#527, #457).
  Trailers give 301; unioned with the ledger, 311.
- **AND A TRAILER-ONLY SET UNDER-CREDITS, because the BRANCH NAME is a second, independent credit
  path.** `findMergedByHeadBranch` (`status.ts`) matches `run-<taskId>-<digits>` on the STRUCTURED
  head ref and credits a merge with no trailer at all. MEASURED: **#1657 carries ZERO
  `Remudero-Task:` lines** (`grep -acE '^Remudero-Task:'` on its body = 0) and W1-T444 is credited
  anyway, purely by its `run-W1-T444-1786560477` head. So union the two, or you will re-dispatch a
  task that shipped.
