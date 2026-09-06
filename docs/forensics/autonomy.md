# autonomy.ts forensics

The measured forensics, incident narratives and design arguments removed from
`src/lib/autonomy.ts` when its comments were compacted to the plain-language standard.
Every block below is the removed text verbatim, marker characters stripped and nothing
else changed. Headings name the symbol the text explained; the code keeps a one-line
`Why:` pointer where the history mattered. Base revision: origin/main at 7ce3b525569bd7cfa98f5f858874e8667274d1dc;
the line numbers below are that revision's.

## Module header

### Base lines 1-81 — lib/autonomy.ts — THE QUANTITY HALF…

lib/autonomy.ts — THE QUANTITY HALF (W1-T437), sibling to lib/verdict-calibration.ts's
CORRECTNESS join (W1-T424).

THE GAP THIS CLOSES. `decideAutoMergeArm` and the arming ledger, strike counts and breaker
gates are all CORRECTNESS machinery — they answer "was this merge safe". Nothing answers the
QUANTITY question Warp's factory framing puts first: what fraction of shipped changes went
out with ZERO human steering, and what did the steered remainder cost. This module is that
number: {@link zeroTouchMergeRate}, pure over an injected merge corpus and ledger union.

THE CORPUS: every commit on the target ref whose body carries an anchored
`Remudero-Task: <id>` trailer (this repo's own PR-body convention — see
`findMergedByTrailer`'s measured anchor `^Remudero-Task: <id>$`), read from the SAME git-log
dump shape `defaultVerdictCalibrationGitLog` (run-task.ts) already produces —
{@link parseTrailerMerges} runs over `lib/verdict-calibration.ts`'s `parseGitEventDump`
output, so this module adds no new git plumbing.

THE TOUCH SIGNALS, each named on the row it fires for (never collapsed into a bare boolean):
  - not auto-armed: no `automerge.armed` ledger line for the task at all — the merge shipped
    by some path {@link import("./review.js").decideAutoMergeArm} never blessed.
  - fix-rung strikes: a `fix.resolved` or `fix.exhausted` line naming `strikes > 0` — a worker
    needed at least one automated repair round. (Strikes are dispatched fix WORKERS, not a
    human hand — but design note (i) counts them as a touch because a strike-bearing merge
    needed MORE than the first pass, which is exactly the "cost" half of the dial; see the
    module's own falsifier test for why this reads correctly against "zero human steering":
    a strike is machine-only, but it is not zero-cost, and the rate this module reports is
    framed as ZERO-TOUCH, not zero-strike — see {@link MergeTouchRow.touches}' wording.)
  - reframe: a `ratify.reframed` line for the task — an operator sent the proposal back for
    rework before it shipped.
  - operator note: a `panel.operator_note_added` line for the task — an operator hand-authored
    guidance into this task's run.
  - capped override: an `automerge.capped_override_granted` line for the task — an operator
    explicitly approved arming a CAPPED (zero-proof) verdict.
  - fix-rung human evidence: a `fix.stood_down` line carrying `issue_url` — the fix rung
    detected a foreign (human) push mid-strike and stood down rather than clobbering it.

A row with NONE of the above is zero-touch. A row with any of them is human-touched, and
EVERY firing touch is named on it — never just the first one found (design (iv)'s falsifier:
"deleting the touch attribution fails this").

THE ZGROUP-UNION LESSON, STRUCTURAL: {@link mineAutonomyLedgerLines} reads the ledger through
`lib/ledger-grep.ts`'s `resolveLedgerUnion` — archives + live file, never the live file alone.
When zero archive files are found, {@link zeroTouchMergeRate} reports the WHOLE window
UNMEASURED, naming the missing-archive reason, rather than silently computing a rate over
whatever the live file alone happened to hold — the same undercount `resolveLedgerUnion`'s own
module doc measured at 3.1x.

SPLIT BY VERDICT CLASS (design (ii)): every row is also classified `full-pass` /
`keyword-floor` / `degraded-arm` (or `null` when no `review.posted` line for the task could be
found), reusing lib/verdict-calibration.ts's exact three-way vocabulary — the class split is
what makes the number actionable, because it says where the next ratchet notch is safe: a
zero-touch rate over full-PASS proof-executed merges is a different trust signal than one over
capped/override merges.

THE RATCHET IS AN OPERATOR ACT, NOT THIS MODULE'S: {@link CURRENT_ARMING_POSTURE} is a fixed
description of what `decideAutoMergeArm` does TODAY, printed alongside the measured rate so a
reader can see posture and evidence side by side — this module changes no policy, writes no
policy file, and proposes no threshold.

NOT IN SCOPE: changing decideAutoMergeArm or any arming policy; W1-T424's revert-join
correctness measurement (that is the quality of what shipped; this is the quantity that
shipped untouched); alerting or thresholds on the rate.

PER-REPO SPLIT (W1-T2492): a harness that works on OTHER repos (`onboard`, `managed-repos.ts`,
`rmd daemon --repo`) but only ever measures itself reports one blended rate that a foreign
repo's merges cannot move once this repo dominates the denominator — the unstated-denominator
shape this repo already refuses everywhere else. `zeroTouchMergeRate` now ALSO splits every row
into a `repos: RepoOutcome[]` breakdown, ADDITIVELY: the top-level fields are unchanged, and
`repos` carries the same population-floor and no-naked-zero discipline the class split already
has (below {@link MIN_REPO_POPULATION_FLOOR} rows prints the count and refuses the rate; zero
rows still prints, never omits). A merge's repo comes from `opts.repoOf(taskId)` — this module
does no plan I/O of its own, so a caller (run-task.ts's `autonomyRateCommand`) supplies it from
the loaded plan's `task.repo` field; a taskId the resolver cannot place lands in
{@link UNATTRIBUTABLE_REPO}, never dropped. `opts.knownRepos` names every repo that should be
reported even at zero merges (an onboarded-but-idle repo is a finding, not an absent row) —
omitted, only repos that actually appear in the corpus are reported. Omitting `repoOf` entirely
(every existing caller before this task) makes every merge unattributable, which is the honest
answer when the caller supplies no way to place a merge — see the module's own falsifier test
for why a single explicit `repoOf` mapping every merge to ONE repo string reproduces exactly
the report this module already printed (design: "absent a second repo the per-repo report is
the single-repo report it already prints").

## AutonomyVerdictClass

### Base lines 87-98 — W1-T1020: this module's OWN extension…

W1-T1020: this module's OWN extension of `verdict-calibration.ts`'s three-way
{@link VerdictClass} vocabulary with a fourth bucket — `"partial-pass"`, a row whose
`review.posted` line carries `partially_executed: true` (SOME but not ALL executable
criteria observed). Local to autonomy.ts, never added to `verdict-calibration.ts` itself:
that module's own correctness-join corpus and this module's quantity report are deliberately
separate measurements (see this module's header doc), and widening the shared three-way type
would ripple into verdict-calibration.ts's report shape for no reason this task asked for.
Before this, a partially-executed row fell through `verdictClassOf`'s `capped`/`floor_degraded`
checks into the catch-all `"full-pass"` return — indistinguishable from a review that actually
observed every executable criterion.

## TRAILER_RE

### Base lines 111-113 — Anchored exactly like `findMergedByTrailer`'s…

Anchored exactly like `findMergedByTrailer`'s own measured form (`^Remudero-Task: <id>$`,
one trailer line, no prefix/suffix noise) — MEASURED over 1,169+ merged PR bodies elsewhere
in this repo's own history as the trailer's real shape.

## mineAutonomyLedgerLines

### Base lines 156-167 — Mine every touch-relevant ledger line…

Mine every touch-relevant ledger line under `stateDir`, over the ledger UNION (never the live
file alone — see the module doc). Pure apart from the injected fs.

`opts.since` (W1-T2484) is this module's proof of `resolveLedgerUnion`'s new window parameter:
a caller who only wants merges from some instant onward can pass it straight through, and any
rotation stamped before it is skipped WITHOUT being opened (see `LedgerUnionOptions.since` and
`ledger-grep.ts`'s module doc for why that skip cannot drop a matching row). OMITTED, this
reads the same unwindowed union it always has — the eight other `resolveLedgerUnion` callers
are deliberately left unconverted (see this repo's W1-T2484 plan record) and stay correct
exactly because the parameter is optional.

## MIN_REPO_POPULATION_FLOOR

### Base lines 265-268 — Below this many rows for a repo…

Below this many rows for a repo, the per-repo report prints the count and REFUSES the rate —
same discipline as `lib/verdict-calibration.ts`'s `MIN_POPULATION_FLOOR`, kept as this
module's OWN constant (not imported) because the two reports measure different populations
and moving one floor must never silently move the other.

## zeroTouchMergeRate (entry export)

### Base lines 404-413 — ENTRY EXPORT (the name is load-bearing…

ENTRY EXPORT (the name is load-bearing — see the module doc and the acceptance grep). PURE
over its two supplied corpora: `merges` (from {@link parseTrailerMerges}) and
`ledgerMining` (from {@link mineAutonomyLedgerLines}) — no I/O of its own.

FALSIFIER-shaped by construction (design (iv)): a window with one auto-armed strike-free merge
and one reframed merge reports 50% with the reframed merge's touch NAMED; a window whose
ledger union could not be read (`ledgerMining.ledger.ok === false`) reports UNMEASURED with
the missing-archive reason, never a rate computed from the live file alone.
