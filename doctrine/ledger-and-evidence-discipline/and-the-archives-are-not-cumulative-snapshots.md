- **And the archives are NOT cumulative snapshots.** `rotateLedger` keeps only
  `MAX_RETAINED_LINES_PER_STEP = 200` newest per step and archives the rest, so most history exists
  ONLY in older archives — deleting any destroys unique data and the newest subsumes nothing.
  Claims of the form "N occurrences", and especially "zero in the entire history", are unsupportable
  without every form. *(recon-AE §0 — the `.gz`-only idiom returned a silent **0** for a pattern with 3
  real hits, its control passing at 257k throughout)*
