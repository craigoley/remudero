- **A corrected PR title is observed by a RE-RUN, not only by a new sha — but `edited` still fires
  nothing.** `ci.yml`'s commitlint job reads the title LIVE (`gh pr view --json title --jq .title`),
  so re-running it picks up a title fixed after the fact. `on: pull_request` carries no `types:`, so
  the defaults `[opened, synchronize, reopened]` exclude `edited` and a retitle alone triggers no run.
  Cheapest path is retitle THEN push; backwards, re-run the job. Close/reopen fires `reopened` without
  touching another lane's branch. *(W1-T351; re-derived 2026-08-06)*
