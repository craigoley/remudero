# Troubleshooting

Symptom → cause → fix for the operator-visible failures the fleet has already paid to
diagnose. This is a **Tier B** doc (MASTER-PLAN §12A): it needs context absent from the
codebase, so it is human/Architect-authored and reviewer-gated, never generated.

**Seeded from the learnings corpus.** Every entry below traces to one `operator_impact: true`
record in [`learnings/failures.yaml`](../learnings/failures.yaml) — the incident/postmortem
shard of the durable, provenance-tagged knowledge base (W1-T33). Not every `failures.yaml`
entry gets an entry here: only the ones whose SYMPTOM is something *you*, the operator, would
actually see running `rmd` — a purely internal implementation detail with no operator-visible
symptom doesn't qualify. See [architecture.md](architecture.md) for the "why" behind the
pieces named here, and [control-surface.md](control-surface.md) for the CLI's fail-loud/STOP
contract specifically.

**Staying in sync.** A new `learnings/failures.yaml` entry with `operator_impact: true` and
no matching entry here is flagged by the reviewer rubric's `checkTroubleshootingCoverage`
(`src/lib/review.ts`, W1-T50) — the same awareness-layer pattern as `checkDocsAwareness`
(W1-T30). Add the entry (or state in the PR report why it doesn't need one) to clear it.

| Learning id | Troubleshooting entry |
|---|---|
| [`reviewer-floor-casing-blind`](../learnings/failures.yaml) | [A correct PR gets `remudero-review=failure`](#a-correct-pr-gets-remudero-reviewfailure-for-no-visible-reason) |
| [`criteria-go-stale-on-relocation`](../learnings/failures.yaml) | [A task blocks on a criterion naming something that no longer exists](#a-task-blocks-on-a-criterion-naming-something-that-no-longer-exists) |
| [`no-live-operator-in-headless-worker`](../learnings/failures.yaml) | [A task dies `error_max_turns` waiting for confirmation that never comes](#a-task-dies-error_max_turns-waiting-for-confirmation-that-never-comes) |
| [`rules-must-sweep-the-existing-queue`](../learnings/failures.yaml) | [A queued task burns an outsized budget even though it clearly violates a standing rule](#a-queued-task-burns-an-outsized-budget-even-though-it-clearly-violates-a-standing-rule) |
| [`control-surface-fail-loud-stop-one-shot`](../learnings/failures.yaml) | [`rmd` runs something you didn't ask for, or `stop` seems stuck forever](#rmd-runs-something-you-didnt-ask-for-or-stop-seems-stuck-forever) |

## A correct PR gets `remudero-review=failure` for no visible reason

**Symptom.** The worker's REPORT clearly substantiates a criterion's proof (e.g. it says
`max_turns` where the criterion's proof text says `maxTurns`, or vice versa), yet
`remudero-review` still fails and names that criterion as unmet.

**Cause.** The reviewer's deterministic keyword floor was casing/separator-blind: it
tokenized `maxTurns` and `max_turns` as two different tokens, so a report using one spelling
against a proof using the other read as a miss and false-blocked an otherwise-correct PR.

**Fix.** The floor now normalizes tokens (splits camelCase before lowercasing) before
matching, so `maxTurns`/`max_turns`/`MAX_TURNS` all match. If you still see a false block of
this shape, it's a normalization gap — check `src/lib/review.ts`'s tokenizer against the
specific spelling variant. The durable fix underneath is the criteria observing REPO STATE
directly (W1-T3F) rather than keyword-matching the report at all — a keyword floor is a
fail-closed heuristic, not a semantic reader. [learnings#reviewer-floor-casing-blind]

## A task blocks on a criterion naming something that no longer exists

**Symptom.** A task's acceptance criterion references a config knob, module, or concept that
the codebase has since moved or renamed (e.g. a criterion still says "the mount's
`maxBudgetUsd`" after budget moved to a per-task `budget_usd` field) — the criterion can never
be satisfied because the thing it names is gone.

**Cause.** A criterion goes STALE when a later PR relocates the concept it depends on. The
task that wrote the criterion pre-dates the relocation and nothing re-synced it.

**Fix.** This is an **Architect-only** fix, never a worker one: the Architect corrects the
stale criterion via a plan PR (edits `plan/tasks.yaml` with provenance), realigning it to the
current architecture — nothing about the underlying work is dropped. A worker that hits this
must escalate (`blocked_review`/`blocked_illformed` naming the stale reference) rather than
editing the criterion itself — editing acceptance criteria to match the diff is never an
available move (Standing rule 15). [learnings#criteria-go-stale-on-relocation]

## A task dies `error_max_turns` waiting for confirmation that never comes

**Symptom.** A task burns most or all of its turn budget on repro scripts (readline prompts,
retry loops) trying to get an "operator confirms" / "user selects" style interaction, then
dies `error_max_turns` having made no real progress.

**Cause.** A criterion requiring LIVE operator confirmation is unfit for a headless worker —
there is no TTY and no human on the other end to answer. The worker isn't wrong to try; the
criterion asked for something structurally unavailable to it.

**Fix.** Redesign the interactive step for no-TTY: expose `--tier`/`--yes`-style flags plus a
TTY-ABSENT safe default (logging the value it chose), and prompt interactively **only** when
`process.stdin.isTTY` is true. Test the non-interactive path via injected input / flags —
never a live human (MASTER-PLAN Standing rule 18). `rmd init --tier <pro|max5x|max20x>
[--yes]` is the reference implementation: `--tier` wins outright, confident evidence writes
with no prompt, and a TTY-absent run never blocks. If you're authoring or reviewing a task
with an "operator confirms" style criterion, that criterion itself is the bug — rewrite it
around a flag/default before it ever reaches a worker.
[learnings#no-live-operator-in-headless-worker]

## A queued task burns an outsized budget even though it clearly violates a standing rule

**Symptom.** A task that's been sitting in `plan/tasks.yaml` for a while reaches a worker,
overruns its turn/budget mount, and dies `error_max_turns` — and on inspection it obviously
violates a sizing/fitness standing rule (e.g. multiple concerns bundled at `risk: medium`,
or live-operator-context criteria).

**Cause.** Standing rules are enforced **forward-only** by default: adding a new rule governs
newly-authored tasks, but nothing automatically re-grades the tasks that were already sitting
in the open queue when the rule landed. A task authored before Rule 18/19 existed can violate
both and still reach a worker untouched.

**Fix.** `rmd retro` sweeps the entire open queue against every standing rule and files a
corrective task for each violation it finds — a new rule must be applied RETROACTIVELY, not
only to new authoring (MASTER-PLAN Standing rule 20). Run `rmd retro --dry-run` to see the
gather + calibration table without writing anything. If you spot a queued task that clearly
violates a rule added after it was written, don't wait for the next scheduled retro to flag
it. [learnings#rules-must-sweep-the-existing-queue]

## `rmd` runs something you didn't ask for, or `stop` seems stuck forever

**Symptom, two shapes:**
- You typed an unrecognized command or flag (e.g. a typo like `rmd daemon install
  --dry-run`) and instead of an error, `rmd` silently started draining the queue and merged a
  task unattended.
- You ran `rmd stop` once, and every `rmd drain` you try afterward — even much later, with
  nothing running — refuses to start, as if permanently blocked.

**Cause.** Two related control-surface hazards, both dangerous specifically because `rmd` is
meant to run unattended: (a) an unknown command/unrecognized argument fell THROUGH to the
default drain/daemon path instead of failing; (b) `STOP` was implemented as a **persistent**
latch, so one `rmd stop` silently blocked every future drain until someone manually cleared
it.

**Fix.** The control surface now fails loud on bad input: an unknown command or unrecognized
flag prints usage and exits non-zero, **spawning nothing** — flags are validated before any
spawn or lock is touched. Separately, `STOP` and `PAUSE` are now genuinely different in
lifecycle: `rmd stop` is **one-shot** — it halts the currently-running drain/daemon within one
tick and auto-clears the moment that run terminates (a no-op-that-warns if nothing is
running, never a silent latch write). `rmd pause` is the **persistent** hold you actually want
for "don't start new work until I say so" — cleared only by `rmd resume`. See
[control-surface.md](control-surface.md) for the full contract and recovery commands.
[learnings#control-surface-fail-loud-stop-one-shot]
