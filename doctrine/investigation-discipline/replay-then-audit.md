- **Replay a projected effect on the ledger before building for it; audit a shipped mechanism's
  first live rows for contradictions.**
  **REPLAY FIRST.** A change built for a projected effect (fewer restarts, faster admission, a shorter
  queue) is a hypothesis until the ledger says the effect exists. Replay the projection over recorded
  rows before building, and name the expected count in the filing. W1-T9092 (#12428, 32a76279e) made
  the daemon stale only when its own closure changed. Measured after merge: the daemon entry's closure
  is 569 of 602 src files, 0 of 11 recorded restarts would have been avoided, and a 7-day replay gives
  about 2% fewer material commits. The lever the replay names is a narrower daemon entry
  (W1-T9091), not the closure check.

  **THEN AUDIT THE FIRST LIVE ROWS.** A green suite proves the code does what its tests say, not what
  production does. After a mechanism ships, read its first live ledger rows and look for one that
  contradicts its design. W1-T9761 (#12435) admits a deferred garden on an aged rung once it has
  waited its cadence. The first core rows after the 2026-10-17 boots showed selector-shadow aged at
  attempt 0 with 0 deferrals, because a restart seed counted as waiting (fixed by #12502, c14715f92).
  They also showed every enforce row naming `cadence_basis` scheduled at 60000 ms, the poll tick
  rather than the garden's interval (W1-T9975). *(#12428, #12435, #12502)*
