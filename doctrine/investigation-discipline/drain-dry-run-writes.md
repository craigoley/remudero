- **Prove a dispatch change in-process with `assertLintClean`, never `rmd drain --dry-run` — it writes
  the LIVE ledger and reads origin/main's plan.**
  *(Index line retired 2026-10-11: the W1-T3323 bullet below said what the dry-run cannot do, not what to run instead. It is kept verbatim; its id resolves here through `doctrine/merged-rules.json`.)*
  *(Headline folded 2026-10-27: its closing "not your branch" moved here. Reading origin/main's plan means the dry-run never sees your branch; the bullet below says so.)*

- **`rmd drain --dry-run` is neither side-effect-free nor able to see your branch.** `drainCommand`
  resolves the LIVE ledger and appends to it before the dry-run branch is reached, and its W1-T60
  self-sync dispatches from **origin/main's** plan blob, never the working tree. Prove a dispatch
  change in-process with the choke point's own objects — `assertLintClean(task, preDispatchLint)`
  over `git show origin/main:<planfile>` versus yours. Only `proof-dialect` blocks at dispatch;
  `proof-resolvability` is demoted to `warn` there, so the blocking count is smaller than
  `lint-plan`'s. *(#982)*
