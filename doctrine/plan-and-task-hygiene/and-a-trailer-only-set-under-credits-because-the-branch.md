- **AND A TRAILER-ONLY SET UNDER-CREDITS, because the BRANCH NAME is a second, independent credit
  path.** `findMergedByHeadBranch` (`status.ts`) matches `run-<taskId>-<digits>` on the STRUCTURED
  head ref and credits a merge with no trailer at all. MEASURED: **#1657 carries ZERO
  `Remudero-Task:` lines** (`grep -acE '^Remudero-Task:'` on its body = 0) and W1-T444 is credited
  anyway, purely by its `run-W1-T444-1786560477` head. So union the two, or you will re-dispatch a
  task that shipped.
