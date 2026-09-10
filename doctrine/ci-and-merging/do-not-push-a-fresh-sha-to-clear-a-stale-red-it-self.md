- **Do NOT push a fresh sha to clear a stale-red `ci-gate` — it self-clears.** ci-gate RE-READS
  inside a bounded grace window before concluding FAILURE, so a required check flipping
  FAILURE→SUCCESS on the SAME head sha needs no new commit and no manual re-run (W1-T261); its wait
  cap is sized against this repo's real required-check wall-clock, so a green-in-progress sibling is
  waited out rather than timed out (W1-T312, `WAIT_CAP_SECONDS` in `.github/workflows/ci-gate.yml`).
  Both are FIXED; the citations are the detail. *(#873/#877, W1-T261/#885, W1-T312)*
