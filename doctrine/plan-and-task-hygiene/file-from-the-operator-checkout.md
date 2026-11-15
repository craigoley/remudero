- **File a plan task from the OPERATOR CHECKOUT — a session that cannot reserve mints on hope.**
  `rmd next-task-id` claims an id when it pushes `refs/rmd-id/<id>`. The push is the claim, so two
  minters at the same time cannot get the same number (W1-T3091 made reserving the default). Where
  the push cannot land, `--no-reserve` still prints an id, but that id is a floor, not a claim. The
  two checks at scope time cannot close the gap: a check is a snapshot, and `main` moves between
  the check and the push.
  *(2026-09-20 and 21: a Claude Code web session whose egress proxy refused each `git-receive-pack`
  update outside `refs/heads/*` made three collisions in two days, all from ids it did not reserve.
  Two shards were renumbered when another PR claimed their ids during the write, and
  `task-id-existence` found them. A third was renumbered when `main` declared the id between the
  check and the push. That one cost six red checks: two shards under one id make `loadPlan` refuse
  the plan, so `lint-plan`, `claims`, both `ci-shard` jobs and the `ci` aggregate failed together.
  The remote held 1820 `refs/rmd-id/*` refs, so the namespace works from the operator checkout.
  Only the restricted lane cannot claim.)*
  Reserving needs permission to create refs under `refs/rmd-id/*`, and nothing else: no force push
  and no delete. An existing ref rejects the push as non-fast-forward. That rejection is the "taken"
  signal, so a contested reservation is never deleted. W1-T3844 made the refusal readable; it
  cannot make the claim land.
- **Ask the host where a new plan file goes, then file there.** A host can send new plan files to
  a second repository, the plan destination (W1-T12200). Run `rmd plan-destination task` (or
  `decision`, `feedback`) before the filing. It prints the outcome, the repository and the checkout.
  *(2026-11-10, 48 hours of main: 37 of 165 merges were hand filings and amendments. No command
  told a session where a new task file goes, so a session that did not know of the switch filed in
  the public repository.)*
  - **`off` or `not_listed`:** file in a worktree of the public repository, as above.
  - **`destination`:** cut the worktree from the checkout it names. In that worktree, run
    `rmd next-task-id --branch <filing-branch>` from the public checkout's `bin/rmd`. The id
    reservation stays on the public repository, and the branch of the destination worktree is
    recorded as its holder. The fast plan lint, run in that worktree as
    `<public checkout>/bin/rmd lint-plan --base origin/main --merge-base --offline`, reads the
    code of the public checkout with no added option. Open the pull request in the destination
    repository.
  - **`unreadable`:** stop. Fix the host file first. Never read it as `off`.
- **A changed file stays in the repository that holds it.** Only a NEW file follows the switch. An
  amendment of a task, or a status edit of a feedback entry, goes in the repository whose catalog
  holds the file today, whatever `rmd plan-destination` prints.
