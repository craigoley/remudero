# Architecture

Remudero is a headless fleet of Claude Code agents that carries plan items from
`plan/tasks.yaml` through to a merged PR, unattended. This document is the
conceptual map of how the pieces fit together — not a generated API reference
(that is Tier A, §12A of `MASTER-PLAN.md`, not built yet), but the mental model
a reader needs before touching `src/lib/*`.

## The three planes

**Plan plane — what to do.** `MASTER-PLAN.md` (narrative intent) and
`plan/tasks.yaml` (the machine-readable DAG, loaded by `src/lib/plan.ts`) are
the source of truth for *what* work exists. A task carries an `id`, acceptance
criteria (`claim`/`proof` pairs), `depends_on`, `risk`, and provenance
(`origin`/`plan_refs`). The control plane flips a task's `status`; humans and
the Architect edit the narrative and criteria. Both files land through the
**same PR gate as code** — see [plan-sync.md](plan-sync.md) — never scp'd in.

**Control plane — when to run it, and how far.** Three layers, each built on
the one below, never reimplementing it:

- `src/run-task.ts` runs exactly **one** task end to end (see
  [task-lifecycle.md](task-lifecycle.md) for the full walk): pre-flight guards,
  a recon pass, a pre-authored prompt, a worker spawn, a PR, the CI +
  review gate, and a merge.
- `src/lib/drain.ts` (`rmd drain`) is a **thin, bounded** loop over
  `run-task`: pick the next runnable task from the DAG
  (`unmetDependencies` in `plan.ts`), run it, repeat — **stop on any block**.
  It invents no orchestration of its own; dependency logic, status derivation,
  and the merge gate are all reused verbatim.
- `src/lib/daemon.ts` (`rmd daemon`) is the **same** machinery — `nextRunnable`,
  the fleet-control gates, the headroom tracker — reused wholesale but wired
  into a **persistent**, self-pacing loop instead of a one-shot pass: new work
  landing later (a plan PR merges, a dependency lands out of band) is picked up
  without a human re-invoking anything.

**Assurance plane — proving the work is real, not vibed.** Standing rule 2/4/12
(`MASTER-PLAN.md` §12): a merge gate is a **deterministic predicate**, never an
LLM decision. This shows up as three enforcement layers (§5):

1. **Deterministic gates** — CI (typecheck + tests) is the floor; the merge
   gate itself (`src/lib/review.ts`'s `judgeReview`) is a **pure function**
   over the PR diff and the implement REPORT, so its falsifier is a unit
   fixture, not a live call. `remudero-review` posts this verdict; `ci-gate`
   aggregates every check-run so a legitimately skipped sub-job never
   deadlocks a merge (see [review-gate.md](review-gate.md)).
2. **Reviewer rubric** (`review.ts`'s `judgeRubric`) — advisory judgment
   items over the same (diff, report): one concern per PR, all callers
   audited, test theater, refactor-phase honesty, **docs awareness** (this
   document's own reason for existing — see below), and the
   `satisfied_by` guard. Each item is an independently exported, independently
   falsifiable pure predicate.
3. **Prompt layer** — Promptsmith injects the repo's principles profile into
   every worker prompt. Weakest layer; never load-bearing.

Two more structural guarantees worth knowing up front:

- **Containment and isolation are PROVEN PER RUN, never assumed** —
  `src/lib/containment.ts` spawns a worker and confirms the sandbox actually
  denies an out-of-tree write; `src/lib/isolation.ts` confirms the worker
  inherited no operator shell state. Both fail closed: unproven means the run
  does not proceed (Standing rule 11).
- **Everything is ledgered** — `src/lib/ledger.ts` appends one NDJSON line per
  step (`{run_id, task_id, step, ...}`), so a run's provenance is inspectable
  after the fact without re-deriving it from logs. `rmd retro`
  (`src/lib/retro.ts`) reduces the ledger + `LEARNINGS.md` into a calibration
  gather that feeds the Architect's own plan-health sweep — the harness syncs
  its own plan, deterministically, before any LLM synthesizes a plan PR.

## Why "docs awareness" is architectural, not cosmetic

A diff that changes the CLI surface, config, the gate, or a verdict shape
(`RunResult.verdict`, `TaskStatus`, `RubricKey`, …) silently invalidates this
document and its siblings — a behavior change with no doc update is
indistinguishable, from the outside, from a doc that was simply never written.
The `docs-awareness` rubric item (`checkDocsAwareness` in `review.ts`) is the
mechanism that ties the two together: it flags exactly that class of diff,
described further in [task-lifecycle.md](task-lifecycle.md#the-review-gate)
and `MASTER-PLAN.md` §12A (the fuller Tier A/Tier B split this seeds).

## Fleet control

`src/lib/fleet-control.ts` exposes `rmd stop|pause|resume` as two flag files
under `<root>/state/`, checked at the top of every drain/daemon tick — **stop**
is a one-shot hard kill (auto-clears when the halted run terminates); **pause**
is a persistent drain-and-hold (cleared only by `resume`). See
[control-surface.md](control-surface.md) for the full contract, including why
an unrecognized CLI command must fail loud rather than fall through to a
spawn.

## Module map (non-exhaustive; see each file's own header comment)

| Concern | Module |
|---|---|
| Plan loading/validation | `src/lib/plan.ts` |
| Single-task runner (CLI) | `src/run-task.ts` |
| Bounded drain loop | `src/lib/drain.ts` |
| Persistent daemon loop | `src/lib/daemon.ts` |
| Stop/pause/resume | `src/lib/fleet-control.ts` |
| Merge gate + reviewer rubric | `src/lib/review.ts` |
| Pre-dispatch plan linter | `src/lib/task-linter.ts` |
| Worker spawn (Claude Agent SDK) | `src/lib/worker.ts` |
| Sandbox containment probe | `src/lib/containment.ts` |
| Shell isolation probe | `src/lib/isolation.ts` |
| Append-only ledger | `src/lib/ledger.ts` |
| Usage/headroom tracking | `src/lib/headroom.ts` |
| Subscription tier detection | `src/lib/tier.ts` |
| Deterministic self-retro | `src/lib/retro.ts` |
| Advisory turn-level judge | `src/lib/flight-judge.ts` |

For the operator-facing view of these pieces (commands, escalation paths, day
to day usage) see [operator-guide.md](operator-guide.md); for what happens to
one task from `queued` to `merged`, see [task-lifecycle.md](task-lifecycle.md).
