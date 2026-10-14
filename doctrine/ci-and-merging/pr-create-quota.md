- **`gh pr create` may die on API quota; git push is unaffected.** Open PRs via REST:
  `gh api --method POST repos/<owner>/<repo>/pulls -f title=… -f head=… -f base=main -F body=@<file>`.
  Same unpredictability as the bullet above: one PR POST succeeded at remaining 0 and the next GET
  403'd. Attempt it and handle one refusal; never gate work on a budget reading. `rmd review` and
  `gh pr view --json` still need GraphQL. *(#766; corrected 2026-09-07)*
