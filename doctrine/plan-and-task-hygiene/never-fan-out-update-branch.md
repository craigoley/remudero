- **Never fan out update-branch after a main fix: protection is non-strict, and each refresh re-runs
  CI and voids the review.**
  Main's branch protection is NOT strict (`requiresStrictStatusChecks: false`; the required contexts
  are `remudero-review` and `ci-gate`). GitHub never needs a branch to be up to date before it merges.
  A refresh buys nothing unless the PR's red is base-red and main has since been fixed.
  *(Headline folded 2026-10-27: "~16 min of CI" became "CI"; the measured cost is below.)*

  **WHAT A REFRESH COSTS (MEASURED 2026-10-10, W1-T7735).** Each new head re-runs CI (median start to
  green: 16.4 min) and voids the exact-input review. 37 of 108 head pushes after 09:30Z (34%) were
  main-merge refreshes, about 600 PR-minutes of CI. #10339 was reviewed 11 times and #10600 8 times.

  **THE BURST.** At about 15:10Z, 16 PRs were refreshed at once under the operator's git identity (15
  merge commits authored "Craig", one by cao825). It is still open whether that was rmd running under an
  operator `GH_TOKEN` or another session. Either way, 16 full CI runs and 16 voided reviews were spent
  on merges GitHub did not need.

  **WHAT ALREADY PACES IT.** The daemon refreshes at most one PR per pass (`SweepDeps.updateBranch`),
  including the base-fixed refresh after a base-red hold lifts (`decideBaseRed`). W1-T7735 (queued)
  routes every refresh through one paced decision (`decideRefresh`) that writes a row, so the next
  burst is either rmd's (it has rows) or a session's (it has none).

  **BY HAND:** after fixing main, leave the PR fleet alone. If one PR truly needs main's change, refresh
  that one PR. *(the 15:10Z 16-PR burst, 2026-10-10; W1-T7735)*
