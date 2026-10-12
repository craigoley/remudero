- **When a gate reads the ledger for a record the SAME function writes, check the WRITE ORDER before
  believing the gate's stated reason.** `armIfVerdictPermits` once ran before the `log("review.posted")`
  its own gate required, so it fail-closed to `ledger-refused` on every first pass with nothing
  retrying it — while a nearby comment asserted the line had "just" been written. Four consecutive
  PRs rewrote that path in three hours without fixing it; the ledger proved it, every refusal
  preceding its own `review.posted` by 0–1ms. (Now fixed — the call site must stay BELOW that log.)
  *(#968 → #973 → #975 → #981, diagnosed while merging #977/#978)*
