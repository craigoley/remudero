- **File a plan task from the OPERATOR CHECKOUT — a session that cannot reserve mints on hope.**
  `rmd next-task-id` claims an id by pushing `refs/rmd-id/<id>`, and that push IS the claim: two
  concurrent minters cannot leave with the same number (W1-T3091 made reserving the default for
  exactly this). Where the push cannot land, `--no-reserve` still prints an id — but it prints a
  FLOOR, not a claim, and the two scope-time checks cannot close the gap either, because a check
  is a snapshot and `main` moves between the check and the push.
  *(2026-09-20/21, a Claude Code web session whose egress proxy refuses every `git-receive-pack`
  update outside `refs/heads/*`: THREE collisions in two days, all from unreserved mints. Two
  shards renumbered when another PR claimed their ids mid-write, caught by `task-id-existence`;
  a third when `main` came to declare the id between the check and the push. That last one cost
  SIX red checks off one duplicate — two shards under one id make `loadPlan` refuse the plan, so
  `lint-plan`, `claims`, both `ci-shard`s and the `ci` aggregate all fall together. 1820
  `refs/rmd-id/*` refs exist on that remote, so the namespace works from the operator checkout;
  only the restricted lane cannot claim.)*
  Reserving needs CREATE on `refs/rmd-id/*` and nothing else — no force, no delete; an existing
  ref rejects the push non-fast-forward and THAT rejection is the "taken" signal, which is also
  why a contested reservation is never deleted. W1-T3844 made the refusal legible; it cannot make
  the claim land.
