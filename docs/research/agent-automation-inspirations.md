# Retained automation inspirations: current overlap and dispositions

Public-source comparison for W1-T10959, reviewed 2026-10-28 UTC. All four dispositions are no-change.

## Scope and evidence boundary

The Remudero baseline is `f9c288f019f48533ee4a1e883ad6cf4683486606`. GitHub's main ref
resolved to that same SHA during this review. The task record was read at that revision;
it cites no file:line premises or required symbols. Its requested output was absent from
main, so neither acceptance grep already passed. The recovered reports described by
[the research README](README.md) remain dated artifacts and were not amended.

Here, existing means code present on main. It does not attest to deployment, provider
adoption, live configuration, qualification, or measured improvement. Research and
source analogies earn no implementation or efficacy credit. No software was installed,
service started, experiment run, or public field-trial material released for this comparison.

## Ownership and duplicate-work check

GitHub API reads on 2026-10-28 found the task's dispatch reservation, no published
`run-W1-T10959-*` branch, and no open PR carrying its exact task trailer. This checkout
already has the prescribed run branch. The latest 100 closed PRs covered updates back
to 09:10 UTC that day, before the task record's 22:47 filing; none carried that trailer
or task branch. No commit touched the requested document on main since that day's start.
These are bounded observations, not a claim about every historical PR or live worker.

The open-head census covered all 27 open PRs returned by the API (a page of 100 was
not full). Every recursively enumerated tree was complete, contained `docs/research/README.md`
as a positive control, and lacked this report. Against main, each head had zero changed
blobs among these nine overlap subjects:

| Subject | Paths checked on each head |
| --- | --- |
| Execution evidence | `src/lib/task-case-file.ts`, `src/lib/benchmark-verified-outcome.ts` |
| Knowledge consolidation | `src/lib/standing-briefs.ts`, `src/lib/knowledge-dedup.ts` |
| Resource allocation | `src/lib/upgrade-allocation.ts`, `src/lib/strike-schedule.ts` |
| Operator interaction | `src/lib/presence.ts`, `src/lib/escalation-answers.ts`, `src/lib/inbox-dismissal-audit.ts` |

This census answers whether the report or these specific mechanisms differ on open
heads; it cannot rule out equivalent work under other filenames. The plan search for
the four repository names did return earlier records, including W1-T4606–4608 and
W1-T4670–4683. Their status fields were not used as merge evidence. The comparisons
below inspect source definitions and callers rather than treating those records as
proof of shipping. No new task is proposed, so there is no new implementation ownership
to assign or competing proposal to file.

## Source versions

Each version is the exact default-branch commit returned by the upstream GitHub API
on the review date, not an installed dependency or a claim about the latest release.
The timestamps are upstream commit timestamps in UTC.

| Repository | Commit | Commit date/time |
| --- | --- | --- |
| https://github.com/paperclipai/paperclip | `c2163b3ecf08c1d574685504fd1271a301d7bd1d` | 2026-10-28 23:03:08 |
| https://github.com/vectorize-io/hindsight | `6decc291bc0b9f99568ad53cb0501f75128c6d7b` | 2026-10-28 17:42:49 |
| https://github.com/NVIDIA/Model-Optimizer | `1ca8bd1fc4df9ac0bfc84045f6bf06450f3f6a0a` | 2026-10-28 22:47:26 |
| https://github.com/block/buzz | `d6196a16c1eec7268e1fc5124ca89ee3d03d6d3e` | 2026-10-28 22:42:49 |

## Paperclip: execution and completion are separate evidence

Primary source: [execution semantics at the reviewed revision](https://github.com/paperclipai/paperclip/blob/c2163b3ecf08c1d574685504fd1271a301d7bd1d/doc/execution-semantics.md).
It separates issue ownership, dependency structure, execution locks, and task status.
Agent-owned active work requires an execution path; a blocked transition requires
a routable waiting path. Run success alone does not establish task completion.

Current overlap: [task-case-file.ts](../../src/lib/task-case-file.ts), `buildTaskCaseFile`,
projects plan, runs, PR, review, acceptance, CI, merged source, deployment, and runtime
as separate evidence fields. `CaseEvidence` retains stale, pending, and unavailable
states. [benchmark-verified-outcome.ts](../../src/lib/benchmark-verified-outcome.ts),
`joinVerifiedTaskOutcomes`, joins assignments to case files and distinguishes completed,
ended without completion, censored, and unavailable outcomes. It explicitly returns
`unavailable-no-randomized-allocation` for experimental effect. A terminal worker
verdict is therefore not interchangeable with verified completion or causal benefit.
These mechanisms already address the themes of W1-T4607 and W1-T4608.

**Disposition: no-change.** Reuse the existing case-file and outcome boundaries;
do not add a second issue orchestrator, completion store, or recovery scheduler.
Paperclip's transactional ownership system is not evidence that Remudero's separate
projections possess identical guarantees. No CPU, disk, cost, or throughput gain is
measured or claimed. Reconsider only if a concrete case-file consumer loses a named
evidence state; a general resemblance is insufficient grounds for implementation.

## Hindsight: consolidated evidence with stable identity

Primary sources: [observations](https://github.com/vectorize-io/hindsight/blob/6decc291bc0b9f99568ad53cb0501f75128c6d7b/hindsight-docs/docs/developer/observations.mdx)
and [mental models](https://github.com/vectorize-io/hindsight/blob/6decc291bc0b9f99568ad53cb0501f75128c6d7b/hindsight-docs/docs/developer/mental-models.mdx).
Observations consolidate facts with supporting evidence and proof counts, reconcile
near duplicates, and verify stale observations against newer facts. Mental models
support incremental edits that preserve unaffected material. This is a memory-service
design, including automatic consolidation; it is not a recommendation to run that service.

Current overlap: [standing-briefs.ts](../../src/lib/standing-briefs.ts), `buildStandingBrief`,
keeps claims addressed by learning ID and filters to active entries;
[learnings.ts](../../src/lib/learnings.ts), `buildShardStandingBriefs`, groups those claims
by shard. `renderFreshnessNote` adds a churn-relative verify-first note.
[knowledge-dedup.ts](../../src/lib/knowledge-dedup.ts), `mergeOrKeep`, protects meaningful
differences in numbers, negations, and names; `mergeEvidence` preserves ID/text and
adds evidence and proof count. These lexical helpers do not equal Hindsight's semantic
retrieval or consolidation engine. [knowledge-gardener.ts](../../src/lib/knowledge-gardener.ts),
`staleCitationCandidates` and `stageStaleCitationProposal`, stage reviewed corrections
for invalidated citations rather than silently rewriting downstream material.

Plan overlap includes W1-T4680–4683. W1-T4606 explicitly scopes lexical evaluation to
a read-only shadow report before the W1-T4354 live injection trial; its rationale
warns that broad score-only retrieval can add irrelevant facts.

**Disposition: no-change.** Retain the existing evidence, lifecycle, brief, and reviewed
correction mechanisms. Defer semantic retrieval and service-backed consolidation to
the existing retrieval work's evidence and authorization boundaries. No new memory
database, consolidation job, or prompt-injection lane is proposed. Potential savings
from smaller context or fewer duplicate facts remain unmeasured; this report grants
no CPU/disk/cost credit and does not certify current live brief usage.

## NVIDIA Model Optimizer: measured sensitivity under a budget

Primary sources: [AutoQuantize](https://github.com/NVIDIA/Model-Optimizer/blob/1ca8bd1fc4df9ac0bfc84045f6bf06450f3f6a0a/docs/source/announcements/20260824-autoquantize.rst)
and [speculative decoding benchmark](https://github.com/NVIDIA/Model-Optimizer/blob/1ca8bd1fc4df9ac0bfc84045f6bf06450f3f6a0a/examples/specdec_bench/README.md).
AutoQuantize estimates per-operation sensitivity and solves an integer allocation
problem under a precision cost budget. The benchmark measures acceptance, timing,
and outputs for draft/verifier decoding. These operate on model inference; neither
directly establishes an agent-task allocation policy's quality.

The older `docs/source/announcements/autoquantize.rst` path cited by W1-T4670 returns
404 at this revision. The dated announcement linked above resolves and was read;
the historical task was left unchanged.

Current overlap: [upgrade-allocation.ts](../../src/lib/upgrade-allocation.ts),
`estimateUpgradeGain`, `allocateUpgrades`, and `replayUpgradeAllocationPolicy`, already
implement the W1-T4670 analogy. Allocation ranks gain per window share; it does not
implement NVIDIA's ILP or optimize weights. Missing gain inputs remain unavailable.
[worker-provider.ts](../../src/lib/worker-provider.ts), `queuedUpgradeAllocation`, exposes
that helper additively; its documented gate leaves the existing spawn policy in place
until offline replay earns a change.
[strike-schedule.ts](../../src/lib/strike-schedule.ts), `measureStrikePassRates` and
`strikeScheduleFor`, cover W1-T4671. The caller in
[sweep.ts](../../src/lib/sweep.ts) currently supplies an empty rates map when logging
`sweep.fix.strike_schedule_plan`, preserving the default cheap-strike schedule.
Presence of a pure optimizer is not evidence of live adaptive scheduling.

**Disposition: no-change; live allocation deferred.** Reuse those helpers and their
replay gates. Do not deploy Model Optimizer, download weights, run GPU benchmarks,
or introduce a second budget allocator. Expected resource benefit is unquantified:
inference compression ratios cannot be transferred to agent CPU, disk, or API cost.
Any future activation remains contingent on qualified gain/window inputs and the
existing replay, rather than a new experiment authorized by this comparison.

## Buzz: shared events and expiring presence

Primary sources: [architecture](https://github.com/block/buzz/blob/d6196a16c1eec7268e1fc5124ca89ee3d03d6d3e/ARCHITECTURE.md)
and [README](https://github.com/block/buzz/blob/d6196a16c1eec7268e1fc5124ca89ee3d03d6d3e/README.md).
Buzz routes signed events for human and agent clients through a relay with persistence
and subscriptions. Presence is ephemeral: its documented Redis lease expires after
three heartbeat intervals. Reactions and agent interfaces share the communication
system. This is a communication platform with its own storage and relay requirements.

Current overlap: [presence.ts](../../src/lib/presence.ts), `inferOperatorPresence` and
`learnLeaseMs`, infer attendance from activity with a learned lease; the call through
[escalate.ts](../../src/lib/escalate.ts), `presenceMode`, uses that inference. This is
an activity estimate, not Buzz's signed heartbeat protocol.
[escalation-answers.ts](../../src/lib/escalation-answers.ts), `readEscalationAnswers`,
accepts authorized comments and reactions into the existing question-answer store,
with source identity used for deduplication. An answer remains input, not executable
authority. [inbox-dismissal-audit.ts](../../src/lib/inbox-dismissal-audit.ts),
`buildInboxDismissalAudit`, distinguishes unresolved outcomes and requires coverage
and controls before declaring measurements available. These overlap W1-T4674,
W1-T4676, and the auditability theme of W1-T4677; they do not create a universal feed.

**Disposition: no-change.** Keep existing attendance, answer, and audit paths. Do not
add a relay, new database, heartbeat service, or parallel operator inbox. A shared
event model alone demonstrates no reduction in operator latency, fleet CPU, disk,
or cost. Reconsider only upon a reproduced lost-answer or stale-presence case that
the existing paths cannot represent; preserve current authorization boundaries.

## Acceptance and limitations

Criterion 1 is covered by the four pinned primary-source sections and their named
Remudero definitions/callers. Criterion 2 is covered by an explicit no-change
disposition in every section. There are no proposed improvements requiring a new
bounded experiment. Existing experiments are dependencies to respect, not results
produced here. Removing any repository, citation, or disposition makes this comparison
incomplete even if the task's deliberately weak URL greps still pass.

Executable task proofs:

```sh
grep -arn -- 'https://github.com/paperclipai/paperclip' docs/research/agent-automation-inspirations.md
grep -arn -- 'https://github.com/block/buzz' docs/research/agent-automation-inspirations.md
```

Those proofs establish citation presence only. They do not measure runtime adoption,
causal improvement, readiness, or successful public release. Private runtime evidence,
account details, credentials, and topology are outside this public-source comparison.
