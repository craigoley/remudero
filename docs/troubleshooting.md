# Troubleshooting

Symptom → cause → fix for the operator-visible failures the fleet has already paid to
diagnose. This is a **Tier B** doc (MASTER-PLAN §12A): it needs context absent from the
codebase, so it is human/Architect-authored and reviewer-gated, never generated.

**Seeded from the learnings corpus.** Most entries below trace to one `operator_impact: true`
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

## You need to know which commit built the container image

**Symptom.**

- The fleet is running in a container and something merged and tested is nevertheless absent
  from it — a flag the code supports that the running image ignores, a script whose behaviour
  does not match the repo.
- You want to answer "how old is this image?" and there is no obvious place to look.

**Cause.** For a long time there was genuinely nowhere to look. `az acr build` strips `.git`
from the uploaded context, so `/app` carries no git metadata; the image had no label and no
version file; and a container cannot see its own registry tag. The published image once ran
**108 commits behind `origin/main`** with nothing anywhere saying so, and dating it required
MD5-fingerprinting the baked entrypoint against every commit that had touched it.

**Fix.** The build commit is now baked in two places, from one `--build-arg` supplied by
`.github/workflows/acr-build.yml` (the same `GITHUB_SHA` the image is tagged with):

```sh
# from INSIDE a running container — no docker, no host access needed:
cat /etc/rmd-build-sha

# from the host, without starting a container:
docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' <image>
```

Once you have the sha, `git log --oneline <sha>..origin/main | wc -l` is how far behind the
image is. Note that this dates the **baked artifacts** — the entrypoint, the CLI binary,
`node_modules` — not the code the daemon is running: `deploy/entrypoint.sh` clones or
fast-forwards on every boot, so the source tree is current regardless of image age.

`deploy/verify-image.sh` reports the value and fails only if the two carriers **disagree**,
which means one was written and the other was not. It deliberately does not fail on an old
image or on an image built before this landed: both read as `UNKNOWN` and warn. An old image
is old, not wrong.

## A background job's processes are alive and its output is growing, but the artifact never appears

**Symptom.** A long-running job — a coverage run, a full-suite run, anything writing into a
worktree — still shows live processes, its log is still growing, and yet the file it is
supposed to produce never turns up. Nothing has errored and nothing has exited non-zero.

**Cause.** The directory it is writing into was removed while it was running. On POSIX a
process keeps its open file descriptors and its current directory after the path is unlinked,
so it goes on "working" against an inode nobody can reach: `ls` in the parent shows nothing,
and the artifact is written to a location with no name. Two ways to get there. You can do it
to yourself, by cleaning up a worktree while a job you started in the background still holds
it. Or the fleet can do it to you: `reapStaleWorktrees` (`src/run-task.ts`) runs from the
daemon's per-poll sweep hook and from `rmd sweep` outside `--dry-run`, judges entries under
`<config.root>/worktrees` terminal on its own cadence, and `rm -rf`s them without asking
whether anything is still writing there. (The boot-time rung added beside `runTask` deletes
nothing today — `worktreeReapBoot.enabled` is `false` in `plan/policy.yaml`, so it only
surveys — but the two older call sites are live.)

**Fix.** Check before you remove, and do not put a long job somewhere the reaper owns.
`lsof +D <dir>` lists every process holding anything under that directory; if it prints
anything, the directory is in use and removing it will silently destroy the job's output
rather than failing. Cut interactive and long-running worktrees somewhere the fleet does not
scan — `~/Remudero/<name>-work` rather than `<config.root>/worktrees` — and commit more often
than feels necessary. If you are already in this state, the compute is not recoverable: kill
the orphaned processes by the pid you captured at spawn (never by matching the command text —
`pkill -f` matches the shell running the search) and start again in a directory nothing reaps.

## The full test suite cannot pass inside the agent container

**Symptom.** A full-suite run in the container fails widely, with failures that look unrelated
to whatever changed and that do not reproduce on the mini. Or worse, it *passes* a fixture that
should have failed.

**Cause.** Three independent causes, none of them a regression in the code under test.
**The container runs as uid 0**, and root ignores permission bits, so a fixture that does
`chmod 000` on a file to prove an unreadable-path branch reads it happily and the test passes
*vacuously* — a green that means nothing. **`browserType.launch` fails** with a hook-level
error, so every `test/serve.*.test.ts` Playwright test dies at `hookFailed` rather than
asserting anything. And **`git commit` fixtures wedge** on an unreachable MCP endpoint at
`127.0.0.1:33883`, hanging rather than failing.

**Fix.** Do not run the full suite here, and do not read a container-only green as evidence.
Run the specific test files your change touches, and let CI — which runs as a non-root user
with the pinned browser build and no MCP endpoint in the loop — be the authority on the whole
suite. Two of these fail loudly and are merely wasted time; the uid-0 one is the dangerous
member of the set, because it converts a permission-branch test into a silent pass. If you
need one of those fixtures verified, verify it on the mini or read CI's own log — a local
result on this host cannot distinguish "the branch works" from "root ignored the bits."
