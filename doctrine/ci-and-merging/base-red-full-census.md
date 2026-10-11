- **Compare a base-red PR's failing check to main's FULL check census, not ci-gate's aggregates, or
  every shard red is held.**
  `decideBaseRed` holds a PR whose red main also has, so the fleet waits instead of "fixing" a red the
  PR did not cause. It decides by comparing the PR's failing checks to the checks main was observed
  failing.

  **THE DEFECT.** Before #10668, `main.health.observed` recorded `observed_checks` from ci-gate's required
  set (`ci`, `test-slow`), which never names a matrix shard. The reader treated any PR red absent from
  that census as main's whenever main was red. On 2026-10-10 main was red on test-slow-shard (2/2)
  alone, and eight PRs were held as base-red. Their reds were coverage shards that main ran GREEN (run
  38050132401). The fix lane stood down on eight real PR defects.

  **THE FIX.** The observer records every concluded check of the deciding run. The reader folds
  `advisory_failing_checks` into the failing list, so a shard main really fails still waits. A held
  head's stand-down sentence no longer claims "also fails on main's latest run" while main is
  undetermined.

  **THE GENERAL RULE.** An aggregate (`ci`, `ci-gate`) says only that something under it failed, so
  matching on an aggregate's name matches every red. Compare leaf check to leaf check, and treat a
  check absent from main's census as NOT main's. *(#10668)*
