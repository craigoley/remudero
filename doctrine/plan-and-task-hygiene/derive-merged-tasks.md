- **Derive "which tasks are merged" from merged PRs' `Remudero-Task:` trailer UNIONED with their
  `run-<taskId>-*` branch, and a PR's merge state from the API — never ledger verdict lines, a
  shard's `status:` or main's log.**
  **A PR's own merge state comes from the API** (`gh pr view <n> --json state,mergedAt`, or REST
  `pulls/<n>`), never from a grep of main's log: the squash subject is the PR title at merge, and a
  PR number also appears in the subjects of later PRs that cite it. On 2026-10-16 a session called
  #12104, #12110 and #12150 unmerged after grepping main's log; all three had merged on 10-15
  (3b480a112, c715c1ba5, c4cb88373). `git log --grep='#12305'` returns #12305 and #12342, the revert
  that undid it. A `run-unfiled-*` hand PR carries no trailer, so the API is its only record.
  *(Added 2026-10-17, with the `status:` rule below folded into this headline.)*
  *(Index lines retired 2026-10-11: the W1-T3323 bullets below split this instruction across two headlines, the second opening on "AND" as a continuation of the first. They are kept verbatim; their ids resolve here through `doctrine/merged-rules.json`.)*
  *(Index line merged 2026-10-17: the LAST W1-T3323 bullet below is carried by this headline's "a shard's `status:`" clause. It is kept verbatim; its id resolves here through `doctrine/merged-rules.json`.)*

- **Derive "which tasks are merged" from the `Remudero-Task:` trailer on merged PRs — never from
  ledger verdict lines.** The dominant merge path here is GATE-SIDE: the PR merges after the run
  already ended `blocked`/`blocked_ci`, so that task never writes a `merged` verdict and a
  ledger-only scan cannot see it. A ledger-built set gave 236 ids and offered long-merged work as
  runnable, naming W1-T227/W1-T192 as the frontier when both had merged weeks earlier (#527, #457).
  Trailers give 301; unioned with the ledger, 311.
- **AND A TRAILER-ONLY SET UNDER-CREDITS, because the BRANCH NAME is a second, independent credit
  path.** `findMergedByHeadBranch` (`status.ts`) matches `run-<taskId>-<digits>` on the STRUCTURED
  head ref and credits a merge with no trailer at all. MEASURED: **#1657 carries ZERO
  `Remudero-Task:` lines** (`grep -acE '^Remudero-Task:'` on its body = 0) and W1-T444 is credited
  anyway, purely by its `run-W1-T444-1786560477` head. So union the two, or you will re-dispatch a
  task that shipped.

- **A shard's `status:` field is not a completion signal — it stays `queued` on tasks that
  shipped.** THREE THIS SESSION: W1-T1127 read `queued` on main while its build had merged as
  #2476 (both credit paths — trailer AND a `run-W1-T1127-<digits>` head); W1-T1065's
  admission-time re-check is in `daemon.ts` under its own name; W1-T1059's caller is wired in
  `run-task.ts`. Read alone it cost a full rebuild that was discarded. The credit projection above
  is the ONLY completion signal; `status:` is what the FILING wrote and nothing updates it on
  merge. Pair it with the `ls-remote` hazard already under "Investigation discipline": a deleted
  head and a stale `status:` agree on "not done" and are both wrong. *(#2476 — a whole build
  discarded on two signals that agreed)*
