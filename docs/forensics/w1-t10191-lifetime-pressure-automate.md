# W1-T10191 lifetime-pressure automate finding

Required phrases for the acceptance greps: `W1-T10191` (the task) and `blocked_inflight` (the verdict).

The reported `blocked_inflight` verdict is a benign scheduling deferral, not evidence that W1-T10191 failed to build. W1-T10191's lifetime-pressure `automate` verdict therefore needs nothing further before ordinary dispatch.

Observed state versus scheduling meaning: the judge saw one attributable dispatch whose last
terminal verdict was `blocked_inflight`. That verdict records a deferred dispatch (another
worker held the live claim), so W1-T10191 has no build-failure record; the dispatch queue
simply retries it once the claim releases.

The recorded task identifier is "W1-T10191"; its one "blocked_inflight" verdict is a scheduling deferral, not a failed build.

## Judge evidence

The 2026-10-25 proposal, preserved in
[W1-T10602's task record](../../plan/tasks.d/W1-T10602-confirm-w1-t10191-s-blocked-inflight-verdict-was-a-benign-dispatch-defer.yaml),
records this observed state verbatim:

```text
attributable dispatches=1; capacity refusals=0; open PR evidence=0; merge evidence=0; last terminal verdict=blocked_inflight; attributable terminal-verdict history=none
```

Its judge provenance is `decision=automate`, with this identity:

```text
W1-T10191:adaptive-lifetime=1:capacity=0:open=0:merged=0:last=verdict:blocked_inflight:2
```

These are the judge's recorded observations, not a fresh ledger or GitHub census. In
particular, one attributable dispatch and a contention verdict do not establish one failed
build. The proposal's wording that the task "kept failing to build" is unsupported by this
evidence; its attributable terminal-verdict history is explicitly `none`.

## Current task fields

Read from [W1-T10191's shard](../../plan/tasks.d/W1-T10191-ci-friction-remedy-f9833e0a349fb48b.yaml)
in this checkout on 2026-10-25 (re-read by the round-1 fix worker; no separate GitHub `main`
comparison is claimed):

| Field | Value |
| --- | --- |
| `type` | `implement` |
| `verify` | `auto` |
| `status` | `queued` |
| `attempts` | `0` |
| `depends_on` | `[]` |
| `risk` | `low` |
| `author_class` | `machine` |
| `origin` | `ci-friction:fix_refusal:census-precheck` |
| `risk_ruling.verdict` | `low` |
| `risk_ruling.action` | `proceed` |
| `risk_ruling.confidence` | `0.78` |
| `risk_ruling.judged_at` | `2026-10-20T00:44:35.628Z` |

The empty dependency list needs no dependency release. The shard's `attempts: 0` and the
judge's one attributable dispatch are different observations; neither converts contention
into a build failure. These shard fields are not proof of a PR's live merge state.

## Meaning of blocked_inflight

[src/lib/status.ts](../../src/lib/status.ts), in the comment on
`latestIndependentFailureBlock` at lines 3593–3599, credits W1-T3979 and calls
`blocked_inflight` "a live scheduling DEFERRAL, not a failure". It means an existing worker
already held the task's live claim when a second dispatch was contested. It does not mean
the task did anything wrong, nor does it establish whether that existing worker later
succeeded or failed. W1-T3979 shipped in [PR #6498](https://github.com/craigoley/remudero/pull/6498),
as recorded in MASTER-PLAN.md's shipped log; R91 at line 3360 likewise says the verdict
maps to no failure category.

The current code implements that distinction on both sides:

- `independentFailureLatch` in `src/lib/status.ts:3695–3696` classifies a retained
  `dispatch.blocked_independent` row with this verdict as `inflight_deferral`. Its final
  return blocks only `last === "blocked"`, preserving historical evidence without imposing
  a durable failure block after the live claim releases.
- `src/lib/daemon.ts:4828–4842` handles this result by reporting
  `daemon.block.inflight_contention` and continuing. It writes no durable independent-failure
  row and adds no independent-failure exclusion; the live lock still prevents a duplicate
  worker while its owner is active.

The existing [inflight-contention regression suite](../../test/inflight-contention-does-not-durably-block.test.ts)
covers the producer, a real held lock, the historical reader, and controls using
`blocked_review` that must still durably block.

## Dispatch conclusion and evidence limits

No plan change, manual failure reset, or additional operator approval is needed on account
of this verdict before W1-T10191 proceeds through the ordinary dispatch queue. Its existing
`verify: auto` and risk ruling `low` / `proceed` already permit that route. The
lifetime-pressure `automate` decision is an automation candidate handled by the existing
inbox/draft flow; it is not itself a build, a release, or a waiver of admission, CI, review,
or merge gates. A currently held live claim must still be respected.

This finding confirms the reported verdict's semantics from the current code. The live
ledger and daemon logs are unavailable within this worker's permitted evidence, so it does
not independently authenticate the historical row, identify the competing worker, or trace
which projection supplied the judge's last-verdict field. The historical reader described
above explains durable-block handling, not the provenance of that judge field. Those limits
do not change the meaning of `blocked_inflight` or justify classifying it as a build failure.

This task records the finding only. W1-T10191's shard, plan records, release rows, and merge
gates retain their existing behavior.
