- **`rmd drain --dry-run` is neither side-effect-free nor able to see your branch.** `drainCommand`
  resolves the LIVE ledger and appends to it before the dry-run branch is reached, and its W1-T60
  self-sync dispatches from **origin/main's** plan blob, never the working tree. Prove a dispatch
  change in-process with the choke point's own objects — `assertLintClean(task, preDispatchLint)`
  over `git show origin/main:<planfile>` versus yours. Only `proof-dialect` blocks at dispatch;
  `proof-resolvability` is demoted to `warn` there, so the blocking count is smaller than
  `lint-plan`'s. *(#982)*
