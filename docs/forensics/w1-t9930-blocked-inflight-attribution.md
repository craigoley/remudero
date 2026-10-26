# W1-T9930: blocked_inflight verdicts versus the lifetime attribution counter

Evidence: every ledger row with `task_id` W1-T9930, taken from the live `ledger.ndjson` plus all
rotated `ledger.*.ndjson.gz` archives (the full rotation union), read 2026-10-26.
Rows carried over at rotation appear in both the live file and the newest archive, so the union
was de-duplicated by raw line before counting.

## Run pairing

The proposal's premise ("2 run.start rows and 2 blocked_inflight verdicts") does not match the
ledger. By 2026-10-26T09:20Z, when the judge ran, W1-T9930 had 10 `run.start` rows in the live
ledger (plus earlier ones in archives) and 5 `blocked_inflight` verdict rows. The 2 in the
proposal is not a count of either row type.

The two sets are NOT disjoint. Each `blocked_inflight` verdict carries the same run_id as its own
`run.start`: `run.start` is logged BEFORE the claim step, so a refused dispatch does log one.
That corrects the proposal's claim that a refused dispatch never logs its own `run.start`.

`blocked_inflight` verdict runs (all also have a `run.start`):

- W1-T9930-1792870775231 (2026-10-24T19:42Z)
- W1-T9930-1792887053747 (2026-10-25T00:15Z)
- W1-T9930-1792893418531 (2026-10-25T01:59Z)
- W1-T9930-1792985773696 (2026-10-26T03:38Z)
- W1-T9930-1792998351970 (2026-10-26T07:10Z)
- W1-T9930-1793002849252 (2026-10-26T08:26Z)
- W1-T9930-1793011663127 (2026-10-26T11:02Z, after the judge)

Each refused run is paired with an EARLIER run that has a `run.start` and a successful
`dispatch.claim` but no verdict row. That earlier run held `refs/rmd-dispatch/W1-T9930` when its
container was restarted:

| earlier run (no verdict) | claim holder pid | refused run (blocked_inflight) |
| --- | --- | --- |
| 1792868174909 | 23907 | 1792870775231 |
| 1792879137993 | 33356 | 1792887053747 |
| 1792888707204 | 406756 | 1792893418531 |
| 1792981897128 | 567412 | 1792985773696 |
| 1792989891910 | 5754 | 1792998351970 |
| 1793000512068 | 6601 | 1793002849252 |
| 1793008670552 | 314751 | 1793011663127 |

The counter cannot be reproduced as 2. Running `taskAttributableLifetimeDispatches`
(`src/lib/status.ts`) over the live ledger truncated at 2026-10-26T09:20:26Z gives 4, and over the
de-duplicated rotation union gives 7. The blocked_inflight runs ARE excluded by it
(`streakRefusal` -> `LIFETIME_ONLY_REFUSAL_VERDICTS` in `src/lib/non-worker-verdict.ts`). What
remains counted are the earlier restart-killed runs above, which have no verdict row and are not
proven orphans. The 2 the judge saw is a different corpus view that this recon cannot recover.

## Reclaim path

The lock that refused these runs is the dispatch-claim ref `refs/rmd-dispatch/<task>`
(`dispatch.claim` outcome `taken`), not `state/inflight/<task>.lock`. No `inflight.refused` rows
exist for W1-T9930.

For every run.start with no verdict, the container restarted while the run held the claim. The
next dispatch of W1-T9930 found the ref held and logged `dispatch.claim` `taken`, then logged
`dispatch.claim_released` with this reason: the claim was minted before the host's PID namespace
started and the claimant pid is absent, so the claimant provably cannot exist. Example:
`refs/rmd-dispatch/W1-T9930` held by `5754@3f4c6a0e0a3a`, minted 2026-10-26T04:47:48Z, namespace
started 07:00:07Z, released 07:10:26Z.

So the staleness reclaim DID run against every such claim. It runs in the same step that
refuses: the refused run is the one that reclaims, and the claim is free for the run after it.
That is why each blocked_inflight is followed by a fresh successful `dispatch.claim` next time.
The first-ever run (1792447654488, 2026-10-19) also ended with no verdict, after two
`dispatch.claim_renew_failed` rows (`unreachable`). No later row shows what became of it.

## Conclusion

Outcome (ii): no new code defect found. The blocked_inflight verdicts are ordinary dispatch-claim
contention, each against a claim left by a run killed by a container restart. The harness
reclaimed each stale claim with a proof (namespace start versus claim mint time, pid absent), and
the verdict rows are correctly excluded from the attributable count. The ledger shows no
reclaim that failed, and the pairing above leaves no unexplained run.

Residual, not a defect: the judge's `attributableDispatches=2` cannot be reproduced from the
ledger at the cited time (4 live-only, 7 over the union). Counted work is the restart-killed
runs without a verdict. If that count matters, a follow-up could record the corpus the judge
read. No further plan-side action on W1-T9930 is needed.
