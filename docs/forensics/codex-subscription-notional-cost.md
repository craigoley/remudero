# Codex subscription calls and their notional cost (W1-T14476)

Read-only recon, 2026-11-23. Code read at core `origin/main` 0a05a6a. Ledger read on the core fleet's host
(the live ledger plus every archive touched in the last 7 days: 160 files opened, 159 `.gz` and 1 live;
newest row 2026-11-23T21:18:58Z). Aggregate counts only.

## Summary

The task's premise was that every Codex worker row is unpriced. That premise is wrong at the ledger.
A Codex call already gets a notional list-price cost. The gap is in the readers: three of them read
`total_cost_usd`, which a Codex row always sets to 0. So a Codex model reads as free there, while a Claude
subscription call reads its notional figure from the same field.

## Where each provider's figure comes from

- **Claude subscription call.** The SDK result envelope carries `total_cost_usd`. `collectWorkerResult`
  (src/lib/worker.ts) copies it into `WorkerResult.costUsd`. When the value is finite and not negative, it also
  copies it into `sdkReportedUsageRatedUsd`. `workerLedgerFields` (src/lib/worker.ts) writes `costUsd` to
  the row as `total_cost_usd`. On a subscription this is an API-equivalent notional figure, not billed spend.
- **Codex subscription call.** `CodexJsonlAccumulator` (src/lib/worker-provider.ts) parses the token receipt
  from the Codex JSONL stream: input, output and cache-read tokens. It sets `tokenUsageState` to `observed`,
  `partial` or `unavailable`. `spawnCodexWorkerInPrivateTemp` then calls `codexNotionalCostUsd(model, tokens)`,
  but only when the state is `observed`. It returns `costUsd: 0` and puts the result in `notionalCostUsd`.
  `workerLedgerFields` writes that value as `notional_cost_usd`, beside `total_cost_usd: 0` (W1-T5629).

## Price rows for the routed Codex models

`CODEX_NOTIONAL_PRICES` is `OPENWEIGHT_PRICES` plus `gpt-6-sol` and `gpt-5.6-sol` (src/lib/worker-provider.ts).
Every model that Codex served in the window has a price row:

| Model | price row | read at |
| --- | --- | --- |
| gpt-6.2-sol | OPENWEIGHT_PRICES | 2026-11-18 |
| gpt-6.1-sol | OPENWEIGHT_PRICES | 2026-10-02 |
| gpt-6-luna | OPENWEIGHT_PRICES | 2026-09-24 |
| gpt-6-sol | CODEX_NOTIONAL_PRICES | 2026-10-08 |
| gpt-5.6-terra | OPENWEIGHT_PRICES | 2026-09-16 |

No routed Codex model is missing a price row. One known understatement remains: `codexNotionalCostUsd` prices
at the base rate and ignores `longContext`. The `gpt-6.2-sol` row sets `thresholdInputTokens: -1`, so its cash
calls always pay long-context rates, but its notional figure uses the base rate.

## What the ledger shows (core fleet, last 7 days)

- 2,458 Codex worker rows (`provider: "codex"` with `tokens`).
- 2,223 of them carry `notional_cost_usd`. Their notional total is about $2,116.
- 235 carry none:
  - 218 are `gpt-6-luna` Inbox drafts with `token_usage_state: unavailable` and 0 output tokens.
  - 17 are `gpt-6.2-sol` review and fix rows with a `partial` receipt.
- Every Codex row's `total_cost_usd` is the number 0.

## Readers that drop the notional figure

These read `total_cost_usd` (or `cost_usd`) and never read `notional_cost_usd`, so a Codex row counts as $0:

- `routingTerminalReceipt` in src/lib/analytics-route.ts sets the routing receipt's cost from
  `total_cost_usd`. Routing telemetry and the recommender objective see Codex arms as free.
- `cohortAssignments` and `deriveSnapshot` in src/lib/benchmark-cohort.ts set the cohort cost from
  `total_cost_usd`. The benchmark cohort index, which Field Trials reads, sees Codex models as free.
- `spendAmountUsd` in src/lib/spend-rows.ts is correct for budgets and caps, and must stay as it is.
  Its notional twin `notionalSpendUsd` already exists, but only retro reads it.

`field-trials-flow.ts` already keeps `notionalCostUsd` and `notionalCostReported` for each attempt, so the
Field Trials flow itself is not the gap.

## Proposed implement task

The proposed implement task is one task: **cross-provider cost comparisons read the notional figure**. Files:

- src/lib/analytics-route.ts
- src/lib/benchmark-cohort.ts
- a-codex-row-is-compared-at-its-notional-price.test.ts, in the `test/<folder>/` that `rmd test-place` computes

Design:

- In comparison readers only, read `notionalSpendUsd(row)` in place of the `total_cost_usd` read. The two
  readers are the routing terminal receipt and the cohort cost.
- Carry the figure under a field named `notionalCostUsd`, or with `billingMode: "subscription"` beside it, so
  that no figure can be summed into billed spend.
- A Codex row with no `notional_cost_usd` stays unpriced (`undefined`), never 0. Budgets, caps and spend
  series keep reading `spendAmountUsd`, unchanged.

Falsifier: a fixture with one Claude subscription row and one Codex row with `notional_cost_usd` still
compares the Codex arm at $0.

A separate, smaller follow-up would price notional calls at the long-context rate where the price row says
every request takes it (`thresholdInputTokens: -1`).

**How the result stays labelled notional.** Every published or compared figure keeps the word "notional" or
"API-equivalent" and a subscription billing mode. Field Trials may publish cost per merged task only as a
notional list-price figure, never as billed spend.
