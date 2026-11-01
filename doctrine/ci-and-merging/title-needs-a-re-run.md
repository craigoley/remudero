- **A RETITLE RE-LINTS ITSELF on user/App edits; `GITHUB_TOKEN` edits need a re-run. Stale-red
  `ci-gate` self-clears.** The PR-title commitlint is `.github/workflows/pr-title-lint.yml`'s
  `commitlint` job. Its `on: pull_request` lists `types: [opened, synchronize, reopened, edited]`,
  and it reads the title LIVE (`gh pr view --json title`), so the edit's own run sees the new title.
  Since #6062 (W1-T3781), 2026-09-19. `ci.yml`'s `commitlint` key is the `light-gates` job and lints no title
  (its W1-T5695 header names `pr-title-lint.yml` as the title lint), and `ci.yml`'s
  `on: pull_request` still has no `types:`, so an edit re-runs none of its jobs. Other workflows
  that DO fire on `edited`: `acceptance-author-gate.yml` and `proof-discrimination-gate.yml` (the
  same four types), and `ci-gate.yml` (`edited` only, W1-T4400: it re-aggregates the required
  `ci-gate` after a body or title repair). Because those gates re-run, a body edit is never free:
  editing after review discards the finished review (#11942). *(W1-T351; corrected 2026-10-16 after #6062
  in #12391: the frozen rule below predates the correction.)*

An edit made with a workflow's `GITHUB_TOKEN` fires no workflow. For that retitle, re-run the
`commitlint` job in `pr-title-lint.yml`, which reads the title live, or close and reopen the PR:
`reopened` fires without touching the branch. User and App edits trigger the normal `edited` runs.

*(Index line merged 2026-10-16: the superseded W1-T3323 bullet below no longer ships beside its successor; its id resolves here through `doctrine/merged-rules.json`.)*
*(Index line merged 2026-10-17: the LAST W1-T3323 bullet below is carried by this headline's stale-red `ci-gate` clause. It is kept verbatim; its id resolves here through `doctrine/merged-rules.json`.)*

- **A corrected PR title is observed by a RE-RUN, not only by a new sha — but `edited` still fires
  nothing.** `ci.yml`'s commitlint job reads the title LIVE (`gh pr view --json title --jq .title`),
  so re-running it picks up a title fixed after the fact. `on: pull_request` carries no `types:`, so
  the defaults `[opened, synchronize, reopened]` exclude `edited` and a retitle alone triggers no run.
  Cheapest path is retitle THEN push; backwards, re-run the job. Close/reopen fires `reopened` without
  touching another lane's branch. *(W1-T351; re-derived 2026-08-06)*

- **Do NOT push a fresh sha to clear a stale-red `ci-gate` — it self-clears.** ci-gate RE-READS
  inside a bounded grace window before concluding FAILURE, so a required check flipping
  FAILURE→SUCCESS on the SAME head sha needs no new commit and no manual re-run (W1-T261); its wait
  cap is sized against this repo's real required-check wall-clock, so a green-in-progress sibling is
  waited out rather than timed out (W1-T312, `WAIT_CAP_SECONDS` in `.github/workflows/ci-gate.yml`).
  Both are FIXED; the citations are the detail. *(#873/#877, W1-T261/#885, W1-T312)*
