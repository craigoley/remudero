# Task lifecycle

This traces what happens to **one task** from `plan/tasks.yaml` when it is run
through `rmd run-task <task-id>` (`src/run-task.ts`, `runTask`) — the machinery
`rmd drain` and `rmd daemon` both dispatch through unchanged (see
[architecture.md](architecture.md)). Every stage below either advances the
task or returns a terminal `RunResult` with a named `verdict`
(`src/lib/run-result.ts`) — nothing is left ambiguous about *why* a run
stopped.

## Status shape

The ladder below is the **derived** lifecycle — the stages a run actually moves
through, each named by the `verdict` its `RunResult` carries:

```
queued → recon → prompted → running → review → fixing / diagnosing → blocked | merged → done
```

**The stored `status:` field in `plan/tasks.yaml` does not walk it, and is not
meant to.** `plan/tasks.yaml` annotates the field in place:

```
status: queued           # decorative — real merge-state is DERIVED FROM GITHUB
```

That is W1-T367's ruling, not this document's. Measured across the monolith and
every shard by `loadPlan` (`src/lib/plan.ts`), the stored field takes exactly
three values and never the intermediate ones — no task has ever been observed
stored as `recon`, `prompted`, `running`, `review` or `fixing`.

**Real merge-state comes from GitHub**, resolved by `findMergedByTrailer` and
`findMergedByHeadBranch` (`src/lib/status.ts`) — the `Remudero-Task:` trailer on
a merged PR, and the `run-<taskId>-<epochMs>` head-branch form, which credit
independently. Neither reads the stored field.

`unmetDependencies` (`src/lib/plan.ts`) takes its merge test as an **injected**
`MergedResolver`. Its `yamlStatusMerged` default reads the stored field, but no
production caller uses that default — `drain.ts`, `inbox.ts` and `panel-graph.ts`
each pass a resolver of their own, so a dependency is satisfied by derived
merge-state rather than by anything written in the YAML.

## The guard chain (in order — each one fails closed)

1. **Sync the plan from origin** (`syncPlanFromOrigin`/`syncPlanOrRefuse`) —
   the runner never trusts a stale local checkout of `plan/tasks.yaml`; a sync
   failure is `blocked_git_fetch`, before anything else runs.
2. **`assertRunnable`** — refuses an unmerged dependency, a `blocked` task, or
   a `verify:human` task (no live operator in a headless run, Standing rule
   18/§no-live-operator).
3. **`assertLintClean`** (`src/lib/task-linter.ts`) — the §5C Layer A
   deterministic linter (sizing, headless-fitness, proof-shape, provenance) —
   `blocked_illformed`, **no worker spawned**, if it fails.
4. **Inflight lock** — refuses to double-run the same task concurrently —
   `blocked_inflight`.
5. **Containment probe** (`src/lib/containment.ts`) — spawn-and-verify the
   sandbox actually denies an out-of-tree write — `blocked_containment` if
   unproven.
6. **Isolation probe** (`src/lib/isolation.ts`) — spawn-and-verify no operator
   shell state leaked in — `blocked_isolation` if unproven.

Only once every guard above passes does real work start.

## The work itself

7. **Recon** — a bounded (`maxTurns: 8`), **read-only** worker gathers
   OBSERVED facts about the repo relevant to the task. Each observed line
   becomes a cited `CONTEXT` claim (`reconObservedToContext`) — provenance
   flows from recon into the implement prompt, never invented fresh.
8. **Implement prompt** (`renderImplementPrompt`) — the task's pre-authored
   prompt plus the recon context, rendered once, not vibed per run.
9. **Implement worker** spawns, writes the change, opens (or updates) a PR,
   and ends with a **REPORT** — the pasted proofs the review gate reads next.
   A worker error here is triaged (`workerErrorVerdict`/`noPrVerdict`/
   `isTransientResult`) into `blocked_budget`, `no_pr`, `failed`, or
   `blocked_transient` as appropriate — never silently swallowed.
10. **`ensureTaskTrailer`** stamps the PR body with `Remudero-Task: <id>` so
    later stages (and `rmd review`'s escape hatch) can resolve criteria from
    the PR alone.

## The review gate

11. **`waitForCiGreen`** polls the `ci` status to a terminal green — pending
    is never treated as a pass; red or timeout is `blocked_ci`. Standing rule
    4: a green check is not evidence the *acceptance criteria* were met, only
    that the code typechecks and its own tests pass.
12. **`runReview`** — fetches the PR diff and head sha, optionally spawns a
    **fresh, read-only** advisory reviewer worker (never `resumeSessionId`,
    never the implementer's own session — the maker cannot talk the verifier
    into agreement with its own narrative), and computes the **binding**
    verdict with `judgeReview` (`src/lib/review.ts`) — a pure function over
    the diff, the REPORT, and (optionally) the advisory semantic verdicts. A
    semantic verdict can only **downgrade** a criterion to failure, never
    rescue an unpasted proof. `judgeReview` always posts `remudero-review`,
    even when the advisory worker never ran — a required status nothing posts
    deadlocks every future merge.
13. **The reviewer rubric** (`judgeRubric`, same module) runs alongside: one
    concern per PR, all callers audited, test theater, refactor-phase
    honesty, **docs awareness**, and the `satisfied_by` guard. This is
    *advisory* — the GitHub-enforced `remudero-review` + `ci-gate` checks
    decide (Standing rule 3B) — but every item is independently exported and
    independently falsifiable by a unit fixture in `test/review.test.ts`.

### The docs-awareness item, specifically

`checkDocsAwareness` (`src/lib/review.ts`) is the mechanism this document
itself depends on staying honest: a diff that touches a CLI/config/gate/
verdict-shaped module (`bin/`, `src/run-task.ts`, `src/lib/config.ts`,
`src/lib/review.ts`, `src/lib/run-result.ts`, …) must **also** touch `docs/`
in the same diff, or the REPORT must **state why not** (a bare "no docs
update" with nothing after it does not count — the excuse itself must be
present, not just the phrase). Silence fails the item. This is the Tier-B half
of the awareness layer described in `MASTER-PLAN.md` §12A: "docs are not
evidence unless CI proves they match the code" — Tier A (generated docs,
CI byte-equality) is a separate, later mechanism.

That surface also covers what DEFINES a gate's measurement, not just the gate
code (W1-T212): `.github/workflows/`, `scripts/*-ratchet.mjs`, every
`scripts/*-baseline.json` floor, `scripts/mutation-relevant-paths.json`, and
`stryker.conf.json` all trip the same item — a diff that lowers a ratchet
floor or edits `ci-gate.yml`'s REQUIRED list is exactly as "user-visible" as
editing `review.ts` itself, so it can no longer clear this rung silently.

## Terminal verdicts

Only when `remudero-review=success` (and, once armed, `ci-gate=success`) does
the runner arm auto-merge. The full `RunResult.verdict` space
(`src/lib/run-result.ts`):

| Verdict | Meaning |
|---|---|
| `merged` | CI, review, and the gate aggregator all went green; GitHub merged the PR. |
| `blocked_ci` | `ci` never reached green (or timed out). |
| `blocked_review` | `remudero-review=failure` — an unmet criterion, test theater, or an empty criteria list. |
| `blocked_budget` | The worker's own budget guard tripped. |
| `blocked_containment` / `blocked_isolation` | A safety probe could not be proven on this run. |
| `blocked_inflight` | The task was already running elsewhere. |
| `blocked_git_fetch` | The plan could not be synced from origin before the run started. |
| `blocked_illformed` | The pre-dispatch linter refused the task — no worker was ever spawned. |
| `task_already_merged` | A by-id dispatch found the target already merged; refused at zero cost — no worker was ever spawned. |
| `blocked_transient` | A recoverable environment hiccup, not a genuine failure. |
| `no_pr` | The worker ended without opening a PR. |
| `pr_attribution_failed` | The PR found does not actually belong to this task/run. |
| `failed` | Every other terminal error. |

A `blocked_*` verdict always **names** the gate that stopped it — never a bare
"failed" with the reason buried in a transcript. See
[operator-guide.md](operator-guide.md#reviewing-a-merged-or-blocked-task) for
what to do with each of these day to day, and
[review-gate.md](review-gate.md) for the live-proof evidence that the gate
actually holds.
