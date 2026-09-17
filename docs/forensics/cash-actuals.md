# src/lib/cash-actuals.ts forensics

The measured forensics removed from the module header of `src/lib/cash-actuals.ts` when it was
compacted to the plain-language standard (`comment-load-ratchet`, 25-line block ceiling). The code
keeps a one-line pointer here; this page keeps the numbers.

## Why this module exists

`openWeightCommittedUsd` charges `settledUsd ?? reservedUsd`, so a request that never settles counts
at its conservative CEILING for the rest of the UTC day. MEASURED on the live fleet allowance for
2026-09-15, against Azure's own token counters for the same day:

```
Azure truth (InputTokens/OutputTokens x OPENWEIGHT_PRICES)   $0.9646
local settled sum                                             $0.9270   -4%
local charge against dailyCapUsd                              $2.6771  +189%
```

So the local ledger is not vaguely wrong, it is wrong in exactly one place — and Azure can say what
it actually billed to within 4%. A `dailyCapUsd` of $25 was refusing work at roughly a third of the
figure it names.

## Why the Metrics API and not Cost Management

Cost Management reports DOLLARS, which would need no price table at all — and is the wrong
instrument twice over: its ActualCost data lags hours, and it is aggressively throttled (MEASURED
2026-09-17: HTTP 429 on three of five attempts, spaced over minutes). Azure Monitor's per-deployment
token counters lag MINUTES and are not throttled that way, so they are the only reading a same-day
cap can act on.

## Why there is no secret here

The reading is authorised by the host's SystemAssigned MANAGED IDENTITY via IMDS, which mints a
short-lived ARM token in-process and writes nothing to disk — deliberately unlike
`OPENWEIGHT_API_KEY_ENV`, whose only copy lives in the running container's environment and was lost
by a container replacement on 2026-09-15, taking the whole cash lane down for two days (W1-T3728).

FALSIFIER: `test/the-cash-cap-can-read-what-azure-billed.test.ts`. Citations: W1-T3729, W1-T3728,
W1-T1266.
