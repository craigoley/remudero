- **PRs green on their own bases can cross a ceiling together: a `# fail 0` main red is a ratchet
  collision, and main records it (#10724).**
  Main's branch protection is not strict, so each PR is checked against its OWN base and merges
  without re-measuring against the other PRs that landed first. A recorded ceiling is checked per PR
  and crossed by the sum.

  **MEASURED 2026-10-10.** #10695 and #10697 each passed `comment-load-ratchet` against their own base.
  Together they took `src/lib/daemon.ts` to 1760 comment lines, over a recorded ceiling of 1750. Main's
  push lane went red on `main-ceiling-drift` with every test passing (`# fail 0` on ci-shard (1/8)).
  Every open PR was then held as base-red. The repair lane read only the `ci` aggregator's log, named
  three different wrong offending merges, and dispatched three fix workers that opened no PR. A human
  opened #10712, which records the bucketed value the gate printed (`ceilingForComments(1760)` = 2000)
  in `scripts/comment-load-baseline.json`.

  **HOW TO READ IT.** A main red whose failing shard printed `# fail 0` and names a BLOCKED ratchet gate
  is a collision, not a regression. Neither PR is wrong, there is no culprit to revert, and there is no
  code to fix. The remedy is to record the new value.

  **MAIN RECORDS ITSELF (#10724).** The main-health rung now reads the failing shard's own job log. It
  records the baseline itself when all of these hold:
  - every failing check is in the ci shard matrix;
  - every failing shard printed a zero-failure test summary;
  - every BLOCKED gate maps to a writer in `RATIFIED_BASELINE_RATCHET_REPAIRS`.
  It re-measures on a fresh branch in main's strict form (`MAIN_PUSH_SIGNAL_ARGS`), runs the fenced
  writer, and opens one PR carrying the baseline path alone. An open PR that already carries every
  raised row stands it down. So do not hand-open another #10712 while that lane is due; look for its
  PR first. A real failed test, a guard workflow, or an unratified gate (the learnings budget, any
  floor) still takes the ordinary fix-then-revert path. *(#10712, #10724)*
