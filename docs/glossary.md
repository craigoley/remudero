# The Remudero glossary

One word for one thing. This page is the domain language of Remudero. Every text a person reads
uses these terms with these meanings. [The writing standard](plain-language.md) requires it.

How to use it:

- **Use the term in the first column.** Do not use a word from the "do not use" column for it.
- **A name in code or in the ledger does not change.** Ledger step names, function names and file
  paths are query keys (`DECISIONS.md`, 2026-08-15). This page governs prose, and the names of new
  things.
- **To add or change a term**, change this page in the same pull request that needs the term.

Each table row has the same four cells: term, meaning, do not use, source.

## The picture in six sentences

The **operator** owns a **plan** of **tasks**. The **daemon** takes a task, starts a **run**, and
a **worker** builds it and opens a pull request. The **sweep** visits every open pull request: it
**reviews** it, fixes it, merges it or **escalates** it. **Gates** decide what may merge.
**Gardeners** improve the system itself, and **janitors** clean up after it. Everything that
happens is a **row** in the **ledger**.

## People and machines

| Term | Meaning | Do not use | Source |
|---|---|---|---|
| operator | The person who owns the fleet and makes the decisions it cannot make. | human, user, owner | `docs/operator-guide.md` |
| fleet | Every daemon, worker and gardener that works for one operator, taken together. | swarm, system (for this meaning) | `docs/architecture.md` |
| host | One machine that runs part of the fleet. | box, node, server | `src/lib/instance-registry.ts` |
| instance | One daemon with its own state directory. Today: core, site and console. | daemon (for the pair of daemon and state) | `src/lib/instance-registry.ts` |
| daemon | The long-running loop of one instance. It sweeps, checks its limits, picks a task and runs it. | loop, service | `docs/system-diagrams.md` |
| worker | A coding agent that the daemon starts to do one piece of work. | agent (alone), lane (for this meaning), slot | `src/lib/worker.ts` |
| worker thread | A Node thread inside a process. Never call it a worker. | worker (for this meaning) | `src/lib/read-model-worker.ts` |
| Architect | The planning agent. It turns feedback and findings into changes to the plan. | planner | `src/lib/triage.ts` |
| reviewer | A worker with a fresh context that reads one pull request. It gives an advisory verdict on each criterion. | review lane | `docs/review-gate.md` |
| judge | A model call that gives an advisory answer on one question, such as risk. | reviewer (for this meaning), oracle | `src/lib/flight-judge.ts` |

## The plan

| Term | Meaning | Do not use | Source |
|---|---|---|---|
| plan | The master plan and every task. | backlog (for the whole plan), roadmap | `docs/architecture.md` |
| task | One unit of planned work, with an id, acceptance criteria and a risk. | ticket, item, shard | `docs/architecture.md` |
| task file | The YAML file under `plan/tasks.d/` that holds one task. | shard, plan record, task record | `docs/architecture.md` |
| queue | The tasks that are ready to build, in priority order. | backlog (for this meaning) | `src/lib/queue-judge-gardener.ts` |
| filing | Adding a task to the plan through a pull request. | minting, registering | `src/lib/machine-filing.ts` |
| amendment | A reviewed change to a task that is already filed. | edit, tweak | `src/lib/proof-amendment.ts` |
| criterion | One thing that must be true for a task to be done. It is a statement and a proof. | claim (alone), requirement | `src/lib/proof-grammar.ts` |
| statement | The first half of a criterion: what must be true. The field is named `claim`. | claim (in prose) | `src/lib/proof-grammar.ts` |
| proof | The second half of a criterion: the test or search that shows it. | evidence (for this meaning) | `src/lib/proof-grammar.ts` |
| falsifier | The test that fails if the change is taken out. | discriminator, canary | `docs/comment-standard.md` |
| id reservation | A hold on a task id so that no one else files the same id. | claim, lock | `src/lib/task-id-reservation.ts` |
| task claim | A lock on a task so that only one builder works on it. | reservation, lock | `src/lib/dispatch-claim.ts` |

## Work in motion

| Term | Meaning | Do not use | Source |
|---|---|---|---|
| dispatch | The daemon starts a run for a task. | launch, kick off | `src/lib/dispatch-governor.ts` |
| run | One task taken from dispatch to an outcome. | job, execution | `docs/task-lifecycle.md` |
| attempt | One start of something that the fleet may start again, such as a worker or a judge. Always say of what. | try, spawn (as a noun) | `src/lib/risk-judge.ts` |
| round | One time the fleet starts a worker to fix a pull request. | strike, pass (for this meaning) | `src/lib/fix-round-base.ts` |
| outcome | How a run ended, such as merged or blocked. The field is named `verdict`. | verdict (for a run) | `docs/task-lifecycle.md` |
| lane | One place for a run. The daemon runs as many builds at the same time as it has lanes. | slot, worker (for this meaning), seat | `plan/policy.yaml` |
| pipeline | A fixed path of work with its own rules: build, fix, review, SRE, alert. The code names each one a lane, as in `sre-lane.ts`. | lane (for this meaning) | `docs/system-diagrams.md` |
| test slot | One permission to run tests on a host. | lane (for this meaning), ticket | `src/lib/test-slot.ts` |
| tick | One turn of the daemon loop. | iteration, cycle, pass (for this meaning) | `src/lib/daemon.ts` |
| pass | One complete execution of a sweep or of a gardener. | tick (for this meaning), run (for this meaning), cycle | `src/lib/sweep.ts` |
| sweep | The pass in which the daemon visits every open pull request and acts on each one. A light sweep only reviews. | scan, search, full pass | `src/lib/sweep.ts` |
| review | The check of whether a pull request proves each criterion of its task. Its result is the `remudero-review` status. | sweep (for this meaning) | `docs/review-gate.md` |
| verdict | The answer of a review, a reviewer or a judge: pass, fail or cannot evaluate. | outcome (for this meaning), result | `docs/review-gate.md` |
| preflight | The checks an author runs on a branch before the first push. | pre-check, local CI | `scripts/preflight-author.mjs` |
| arm | Turn on automatic merge for a pull request. | enable (alone) | `src/lib/arm-auto-merge.ts` |

## Checks and limits

| Term | Meaning | Do not use | Source |
|---|---|---|---|
| gate | A check that must pass before something may happen, such as a merge. | guard, barrier | `docs/architecture.md` |
| census | A check that reads every member of a set, such as every test file. | sweep (for this meaning), scan | `CLAUDE.md` |
| ratchet | A limit that may only move in one direction, enforced in CI. | cost check | `src/lib/gate-gardener.ts` |
| limit | The most that is allowed. | ceiling, cap, bound, threshold | — |
| floor | The least that is allowed. | minimum bound | — |
| budget | An amount that work may spend. Always say of what: dollars, memory, bytes. | allowance | `docs/system-diagrams.md` |
| pressure | How close a resource is to its limit. Always say which resource. | load (for this meaning) | `src/lib/headroom.ts` |
| governor | A rule that sets how much new work the fleet may start, from a reading of a resource. It does not stop running work. | throttle, limiter | `src/lib/lane-governor.ts` |
| admission | Permission to start something now. | clearance, go-ahead | `src/lib/host-memory-admission.ts` |

## When work does not go ahead

Use exactly one of these three. They differ in what ends the wait.

| Term | Meaning | Do not use | Source |
|---|---|---|---|
| hold | The work stops until someone or something releases it. | park, latch, freeze | `docs/control-surface.md` |
| defer | The work does not happen now, and the fleet tries again by itself. | stand down, skip, back off | `src/lib/dispatch-governor.ts` |
| refuse | A check rejects the input. The same input will be rejected again. | reject, deny, bounce | `src/lib/dispatch-governor.ts` |
| pause | A hold on new work for one instance, or for every instance. Work in flight finishes. | stop (for this meaning) | `docs/control-surface.md` |
| stop | The operator ends the running loop. | pause (for this meaning), kill | `docs/control-surface.md` |
| drain | Let the work in flight finish and start nothing new. The command `rmd drain` is different: it runs ready tasks one after another. | flush, wind down | `src/lib/recycle-yield.ts` |

## The state of a thing

| Term | Meaning | Do not use | Source |
|---|---|---|---|
| stale | Out of date: a newer fact exists. | old, expired | — |
| stuck | Not moving, although nothing holds it. | stalled, wedged, hung | — |
| orphaned | No owner is alive to finish it. | stranded, abandoned | — |
| unreadable | The fleet tried to read it and could not. This is never the same as "empty" or "none". | missing, unknown (for this meaning) | `docs/operator-message-standard.md` |

## When the fleet needs a person

| Term | Meaning | Do not use | Source |
|---|---|---|---|
| finding | Something a check or a gardener noticed. | proposal, observation | `src/lib/scout-gardener.ts` |
| incident | A group of the same error, tracked from first seen to fixed. | outage, alert | `src/lib/incident-lifecycle.ts` |
| escalation | A GitHub issue that asks the operator for a decision or an action, with options and a recommendation. | needs-human issue, ticket | `src/lib/escalate.ts` |
| inbox item | One entry in the console inbox. | proposal, card | `src/lib/inbox-owner.ts` |
| intervention | Something the operator did by hand that the fleet should have done. | manual fix | `src/lib/operator-interventions.ts` |
| triage | The Architect reads one piece of feedback and decides what to do with it. | intake, sorting | `src/lib/triage.ts` |
| grill | An escalation that asks the operator to settle unclear feedback. | clarification | `src/lib/escalate.ts` |

## The record

| Term | Meaning | Do not use | Source |
|---|---|---|---|
| ledger | The append-only log of everything the fleet did. | log, journal, event store | `src/lib/ledger.ts` |
| row | One line of the ledger. | line, record, entry, event | `src/lib/ledger.ts` |
| step | The dotted name of a row, such as `run.start`. | event name, type | `src/lib/ledger-steps.ts` |
| doctrine | The rules agents follow, under `doctrine/`, indexed by `CLAUDE.md`. | guidelines, policy | `CLAUDE.md` |
| learning | A fact with its source, under `learnings/`, that is given to workers. | lesson, memory | `src/lib/learnings.ts` |
| retro | A digest of the ledger that the Architect turns into changes to the plan. | post-mortem | `src/lib/retro.ts` |

## The caretakers

A caretaker is a part of the fleet that looks after the fleet itself. Each kind has one job.

| Term | Meaning | Do not use | Source |
|---|---|---|---|
| gardener | Improves something the fleet owns, then measures whether it helped. Each has a name, such as the flow gardener. | garden, optimizer | `src/lib/gardener.ts` |
| overseer | The gardener that watches the other gardeners. | supervisor | `src/lib/gardener-overseer.ts` |
| janitor | Removes what is finished: old workspaces and temporary files. | cleaner, sweeper | `deploy/mac/JANITOR.md` |
| reaper | Removes what was abandoned: branches, clones and processes with no owner. | janitor (for this meaning), killer | `src/lib/clone-reaper.ts` |
| tuner | Adjusts one setting from a measurement, such as a memory limit. | optimizer | `deploy/memory-high-tuner.sh` |
| watchdog | Restarts or reports something that stopped making progress. | monitor, guardian | `src/lib/progress-watchdog.ts` |

## The console and the server

| Term | Meaning | Do not use | Source |
|---|---|---|---|
| console | The web application at app.remudero.com. | dashboard, UI | `docs/control-surface.md` |
| serve | The process that answers the console over HTTP. | API server, backend | `src/lib/serve.ts` |
| view | One prepared answer for one console screen. | endpoint, page model | `docs/views.md` |
| read model | The database that serve builds from the ledger to answer views. | projection, cache | `src/lib/views.ts` |

## Change and release

| Term | Meaning | Do not use | Source |
|---|---|---|---|
| deploy | Move a daemon to new code and restart it. | release, roll out | `src/lib/deployer.ts` |
| recycle | Replace a container with a new one on a new image. | restart, relaunch, bounce | `docs/operator-guide.md` |
| self-sync | A command updates its own checkout before it runs. | auto-update | `src/lib/self-sync.ts` |
| seed | A shared, ready-made set of installed dependencies. | cache, donor | `src/lib/dependency-seeds.ts` |
| prime | Give a checkout its dependencies from a seed. | install, hydrate | `src/lib/dependency-seeds.ts` |
