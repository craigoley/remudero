# mount-headroom-sweep.mjs comment forensics

The measured incidents, design arguments and rejected alternatives that were removed from
`scripts/mount-headroom-sweep.mjs` when its comments were compacted to the plain-language standard
(docs/comment-standard.md). Nothing was cut: each section below is the file's own prose, verbatim,
under a heading naming the symbol or block it explained. The file itself keeps a one-line `// Why:`
pointer wherever the history mattered.

Line numbers below are positions in `scripts/mount-headroom-sweep.mjs` at the merge base of the
compaction PR.

## The file header

Removed from lines 3-76.

W1-T2574 — A MOUNT COMPARISON ACROSS UNMATCHED POPULATIONS IS NOT A MEASUREMENT. The per-class
census below (W1-T2560) reports turn/cost distributions per `task_class`, and that is correct for
what it answers, but every run of a class rode the SAME mount for as long as
`.remudero/mounts.yaml` was static — a corpus with no variation on the variable of interest
supports no counterfactual about a DIFFERENT mount, however large it grows. A second provider
(W1-T2572/W1-T2573) supplies that variation for free: `selectWorkerProvider` picks the subscription
with the most headroom in its tightest window, a function of WINDOW STATE rather than task
difficulty, so provider assignment is plausibly exogenous — but ONLY WITHIN a (type, risk, class)
cell. High-risk work rides a higher mount BY POLICY, so aggregating across cells reports "expensive
mounts fail more" when difficulty, not model, is talking.

`computeArmSweep`/`compareArms` below are the fix: runs are grouped into CELLS (type x risk x
class) and, WITHIN each cell only, into ARMS (provider x served_model x effort — `served_model` is
`workerLedgerFields`'s own field, W1-T2572; `provider`/`effort` ride the same line). Every arm
reports its own `n`. `compareArms` REFUSES — throwing `MountHeadroomSweepError` and naming BOTH
cells — the moment it is asked to compare two arms that do not share a cell; the per-cell
`comparisons` array below never attempts one (comparisons are built pairwise WITHIN one cell's own
arm list), so the refusal is structural, not merely a check someone could skip. Every comparison
also carries the corpus's own `newestTs` (see below), and reports whether the cheaper-looking arm's
advantage HOLDS or DISAPPEARS once a re-dispatch's cost is charged to the one completed task it
belongs to (`costPerCompletedTaskUsd`, not the naive per-run `costP50`).

NOTHING MEASURES WHICH TASK CLASSES COULD TAKE A CHEAPER MOUNT. Every row in
`.remudero/mounts.yaml` was chosen BY ARGUMENT, never by an observed distribution, so a model or
effort change today is a guess in either direction. The ledger already carries turn counts, costs
and outcomes for every retained run (`implement.done`/`recon.done`'s `num_turns`, the terminal
`verdict` line's `cost_usd`/`verdict`) — this script is the ONE verb that reads them together, per
`task_class`, so "sonnet would do here" becomes a measurement instead of an opinion. It REPORTS; it
changes no mount, dispatches no worker, and recommends no model — that ruling belongs to a human
(or W1-T2559, which owns any mount edit and depends on this task).

PERCENTILES, NEVER A MEAN (see src/lib/cost-anomaly.ts's own identical rule): the mean is dragged
by exactly the outlier a headroom sweep exists to find. Every distribution below is p50/p90/max.

OUTCOME BEFORE COST. A class that is cheap because it fails early is not a cheaper-mount candidate
— the cost column alone argues the opposite of the truth. Every class row below carries how many
of its settled runs reached a passing verdict, how many ended `blocked_ci`, and how many were
themselves a RE-DISPATCH (a later attempt at a task that already had one) — visible as such rather
than folded into a bare average.

COST PER COMPLETED TASK, NEVER PER REQUEST. `costPerCompletedTaskUsd` divides a class's total
settled cost by its DISTINCT settled task_id count — not its run count — so a task needing two
attempts (a fix strike, a re-dispatch) shows its real price instead of hiding it behind a per-run
average that a second attempt would otherwise dilute.

THIS SCRIPT CARRIES ITS OWN CONTROLS, because every prior census in this repo that did not has been
wrong (this session alone produced a $1,279 figure and an $80,118 figure for the SAME corpus, both
wrong, from queries that looked fine):
  - ALL THREE ROTATION FORMS are read (`ledger.*.ndjson.gz`, plain `ledger.*.ndjson`, and the live
    `ledger.ndjson`) via `ledgerRotationEntries` (src/lib/ledger-grep.ts) — the ONE shared
    definition of "which files are ledger rotations", not a second glob that silently answers from
    a subset. `corpus.formsOpened` NAMES which of the three this run actually saw.
  - ROWS ARE DEDUPED BY run_id (via `gatherRuns`, src/lib/retro.ts, over exact-line-deduped records
    — rotations duplicate heavily, so a raw row is not a run), and `corpus.rowToRunRatio` prints how
    much a raw count would have overstated by, so archive duplication cannot inflate a figure
    silently.
  - `corpus.newestTs` is the corpus's own newest row, printed beside every number — a sweep
    answering about a stale window is visible as such rather than looking current.
  - A CORPUS THAT RESOLVES ZERO DISTINCT RUNS REFUSES (`MountHeadroomSweepError`) rather than
    printing a report whose every class reads zero — a zero is not a measurement until a positive
    control (the forms/archives/rows above) proves the query could see its corpus at all; see this
    repo's own $1,279/$80,118 near-misses for why that distinction is load-bearing.

NOT IN SCOPE, DELIBERATELY: changing `.remudero/mounts.yaml` (W1-T2559), spawning any worker, and
recommending a model — this script makes no `child_process` call and writes nothing.

Usage: `node --import tsx scripts/mount-headroom-sweep.mjs [--root <repo-root>] [--state-dir <dir>]
[--json]`. Defaults: `--root` `process.cwd()`, `--state-dir` `<root>/state` (the same "state/
ledger.ndjson, siblings rotate beside it" layout src/lib/log-rotation.ts's own header documents).

## computeSynthesisSweep the three rows this instrument was blind to

Removed from lines 294-314 (W1-T2668).

`computeClassSweep` above groups by `task_class` over `gatherRuns`, which requires a `run.start`
and sums turns from implement/recon done-steps. retro, triage and inbox_draft are not task runs:
they carry no `task_class`, so they landed in "unknown" or nowhere at all. The one verb built to
turn "sonnet would do here" into a measurement could not see the three rows an operator would act
on — and `.remudero/mounts.yaml`'s own "$827 across 219 invocations" came from a hand query that
nothing re-derives.

NEITHER THE POPULATION NOR THE STEP NAMES ARE A NEW LIST. The rungs come from `SYNTHESIS_ROLES`
(src/lib/mounts.ts) — the same constant `loadMounts` validates the `synthesis:` block against — so
a fourth synthesis row added tomorrow is priced tomorrow. The step each writes comes from
`ARCHITECT_LANE_STEPS` (src/lib/retro.ts), the ONE map that already identifies these lanes by "the
ONE ledger `step` name each writes". A second copy of either would drift; the export is this task's
only edit outside its own two files, and it is one line.

THE DIVISOR IS NAMED, NOT REUSED. `computeClassSweep` divides by DISTINCT settled `task_id` — cost
per completed TASK. A synthesis rung has no `task_id` and completes no task, so dividing by
anything and calling it the same thing would be a category error. These rows report cost per
INVOCATION and say so in the field name (`costPerInvocationUsd`), which is what the shard requires:
"a stated equivalent (per invocation, named as such) rather than a silent reuse".

## armFieldsByRunId resume precedence

Removed from lines 385-402.

provider / served_model / effort per run_id, read directly off the raw (pre-`gatherRuns`) ledger
records. `workerLedgerFields` (src/lib/worker.ts, W1-T2572) writes `served_model` and `effort`
UNCONDITIONALLY on every `ARM_DONE_STEPS` line (`served_model` defaults to the literal `null`,
never an omitted key) and `provider` only when `WorkerResult.provider` was set. So:
  - `servedModel` reads `"unreported"` for an explicit `served_model: null` (checked — the provider
    named nothing, W1-T2572's own honest-unknown) and `"unknown"` only when the key is absent
    altogether (a ledger line predating W1-T2572).
  - `provider` reads `"unknown"` when absent (a line predating provider ledgering).

The FIRST IMPLEMENTATION line for a run_id wins, regardless of where any `recon.done` row appears
in the ledger. `recon.done` is only a fallback for a recon-only run. The mount being measured
routes the implementation worker, so allowing a recon row to win would label the implementation
outcome with the recon model. Within implementation resumes, first still wins: the retained
production corpus has no run whose implementation resumes disagree on provider/model/effort, and
silently switching attribution on a later resume would be no more honest than silently taking a
recon row.

## compareArms outcome before cost restated for a pair

Removed from lines 512-527.

Compare TWO ARMS and REFUSE — loudly, naming BOTH cells — when they do not share the SAME (type,
risk, class) cell: provider assignment is only quasi-random WITHIN a cell (`selectWorkerProvider`
picks off window headroom, not task difficulty); across cells it tracks POLICY (high-risk work
rides a higher mount on purpose), so a cross-cell comparison reports difficulty talking, not model
— see this script's own header. This is the ONE function that compares two arms, so it is the ONE
place the refusal has to hold.

OUTCOME BEFORE COST, restated for a pair: `cheaperByCostP50` is the NAIVE per-settled-run figure (a
re-dispatch's second run reads as just another row, same as any other run's).
`cheaperByCostPerCompletedTask` is the CHARGED figure (`computeArmSweep`'s
`costPerCompletedTaskUsd`, which already sums BOTH of a re-dispatched task's attempts over its ONE
completion). When the two disagree, the arm that looked cheaper per run is NOT actually cheaper
once its re-dispatches are charged to it: `advantageHoldsUnderRedispatch: false`, and `note` names
which arm's advantage disappeared.

## LANE_RESTORE_BASELINE the 2026-09-01 vs 09-02 figure

Removed from lines 746-773.

W1-T2708 — THE LANE-RESTORE BASELINE, RECORDED IN THIS INSTRUMENT'S OWN VOCABULARY.

`dispatchLanes`' comment in plan/policy.yaml holds the fleet at 2 and states the release: "Restore
to 3 once burn per run is down, and record the measurement that justifies it rather than restoring
on optimism." That posture is right. What it lacked was a comparable left-hand side: the only
per-run figures in the table sat one block over, in `reviewLanes` prose — "a review lane is cheap
($0.63/run measured, against implement at $5.28)", 2026-09-01 — naming no STATISTIC, no CORPUS
WINDOW and no COMMAND.

THAT AMBIGUITY FLIPS THE ANSWER, WHICH IS WHY IT IS NOT PEDANTRY. Measured 2026-09-02 over 67
archives, all three rotation forms, 801,987 raw rows deduped to 749 distinct runs: class `src` read
cost p50 4.94 / p90 11.34 / max 38.46. If `$5.28` was a MEDIAN, today's p50 is a 6.4% improvement
and the condition is MET. If it was a MEAN, today's mean is necessarily ABOVE 4.94 (a p90 of 11.34
and a max of 38.46 guarantee it) and burn may be UP. The same two numbers support opposite rulings,
and nothing recorded decides between them — an operator session already came within a step of
comparing 5.28 against a p50 as though the statistics matched.

SO THE 2026-09-01 FIGURE IS NOT RESTATED, IT IS SUPERSEDED. Its statistic is unrecoverable, and a
figure that can be read two ways is worse than none. The baseline below is the 2026-09-02 reading,
which names all four fields BECAUSE IT CAME FROM THIS SCRIPT — the one instrument that commits to
"PERCENTILES, NEVER A MEAN" (see this file's header).

A CONSTANT, NOT PROSE, BECAUSE THE DELIVERABLE IS A COMPUTED CONDITION. "A prose figure re-copied
into the right row is the same defect one row over" — so the comparison is READ OFF THE TOOL rather
than argued, and a test pins plan/policy.yaml's own comment to this object so the two cannot drift.
