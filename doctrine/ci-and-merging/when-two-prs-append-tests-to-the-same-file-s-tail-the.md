- **When two PRs append tests to the same file's TAIL, the conflict region can cut just before a
  SHARED closing `});`** — keeping both sides then leaves one block unclosed, and esbuild reports
  `Unexpected end of file` rather than naming the merge. Close the ours-side block explicitly.
  *(#1399 vs #1404 — resolved by emitting `});` where the `=======` marker was)*
