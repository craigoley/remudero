- **Two PRs appending tests to one file's TAIL can conflict before a SHARED closing `});` — close
  the ours-side block yourself; esbuild says only `Unexpected end of file`.**
  *(Index line retired 2026-10-11: the W1-T3323 bullet below stated the trap with no instruction. It is kept verbatim; its id resolves here through `doctrine/merged-rules.json`.)*

- **When two PRs append tests to the same file's TAIL, the conflict region can cut just before a
  SHARED closing `});`** — keeping both sides then leaves one block unclosed, and esbuild reports
  `Unexpected end of file` rather than naming the merge. Close the ours-side block explicitly.
  *(#1399 vs #1404 — resolved by emitting `});` where the `=======` marker was)*
