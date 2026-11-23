# Review status writers

Who can post the `remudero-review` status on a pull request head, and what happened when two of them disagreed on #19922.

This page records the finding of the recon task W1-T14178. The task changes no gate. The finding was
first posted as a comment on #20066 on 2026-11-21. The evidence is the ledgers and the GitHub status
history of #19922, read on 2026-11-21.

## W1-T14178 overriding PASS writer

The `remudero-review` status on #19922 head `66e66ab8941c` changed four times. Each post used reviewer
code `ebea9d1a5`.

| Time (UTC, 2026-11-21) | State | Writer |
| --- | --- | --- |
| 18:49:57 | pending | Run `review-PR19922-1795286994954`, "review in progress" |
| 19:00:03 | failure | The fleet daemon, run `review-PR19922-1795287178193`: FAIL with unmet criteria |
| 19:02:55 | failure | The fleet daemon's restore of that FAIL, run `review-PR19922-1795287774413` |
| 19:03:28 | success | Run `review-PR19922-1795286994954`: "PASS — 3 criteria substantiated, no test theater" |

The PR merged at 19:03:35Z, seven seconds after the PASS.

W1-T14178 overriding PASS writer: run `review-PR19922-1795286994954`, execution mode semantic.

The writer of the 19:03:28Z PASS is run `review-PR19922-1795286994954`. It was a hand review from the
operator's Mac (agent account). The run is logged in that account's own ledger, not in the fleet
daemon's ledger. It posted through the operator's GitHub identity, so the status creator is the
operator's account and not the fleet's GitHub App.

The run's ledger rows:

- 18:49:56.628Z `review.semantic_mode`: execution mode semantic, task risk high, hard cap 4.5 USD.
- 18:49:57.685Z `review.pending_posted`.
- 18:50:03Z `worker.assignment`: the semantic reviewer, effort high.
- 19:03:24.047Z `review.reviewer`: subtype success, downgrades 0.
- 19:03:28.888Z `review.posted`: state success, reviewer code `ebea9d1a5`.
- 19:03:37Z `automerge.armed`: "verdict is a full PASS".

## What this corrects

The task record inferred that the PASS came from a run without semantic mode, as on #19673. That is
wrong. The run used execution mode semantic, and its semantic reviewer recorded 0 downgrades.

So the event on #19922 is two semantic reviews that disagreed on one head and one reviewer code. The
fleet's semantic review posted FAIL twice (19:00:03Z, and the daemon's restore at 19:02:55Z). The hand
review posted PASS at 19:03:28Z. No rule compared the two verdicts. The later post replaced the
standing FAIL, and its run armed auto-merge just before the merge.

## Ledgers searched and ruled out

No row in these ledgers names run `review-PR19922-1795286994954` or a review of `66e66ab89` at 19:03Z:

- The fleet daemon's live ledger on the Azure host, and its archives for 18:00 to 19:24Z.
- The ops, console and site ledgers on the Azure host.
- The log of the backlog sweep's gated review runner.
- The log of the hand review queue on the Azure host.
- The ledger of the operator's own Mac account.

## Follow-ups

- W1-T14179 (in progress): a PASS cannot replace a standing FAIL from another writer on the same head
  and review input digest unless it answers each of the FAIL's unmet criteria. Otherwise the
  disagreement goes to a person or a third review, not to the post that lands last.
- W1-T14235 (filed): the success status of a code PR needs a semantic judgement.
- Hand reviews from the operator's machines are on hold since 2026-11-22. They stay on hold until the
  operator lifts the hold.
