# ci-gate.yml forensics

The measured forensics, incident narratives and design arguments removed from
`.github/workflows/ci-gate.yml` when its comments were compacted to the plain-language standard
(`docs/comment-standard.md`). Every block below is the removed text verbatim, marker
characters stripped and nothing else changed. Headings name the key or step the text explained;
the workflow keeps a one-line `# Why:` pointer where the history mattered.

Base revision: `origin/main` at f148a1303173cb5789e36cc70aee8b78d90ca57f. The line numbers below are that
revision's. The file header's two box-rule lines (base 3 and 31) are decoration, not prose, and
are not reproduced.

## File header

### Base lines 3-31 — ci-gate (W1-T24) — ONE always-reporting…

ci-gate (W1-T24) — ONE always-reporting required status check that aggregates the PR's
other check-runs, adapted from the fleet-verified pattern (craigoley/synthwatch
.github/workflows/ci-gate.yml).

WHY: a required status check that gets SKIPPED can permanently deadlock a merge (synthwatch
#102 — a Dependabot esbuild bump sat BLOCKED forever despite every check SUCCESS/SKIPPED,
because a required check's workflow was `if:`-skipped on that PR, and a skipped REUSABLE-
workflow caller creates NO check run with that nested context name, so branch protection
waits for "Expected" forever). This is a CLASS bug: ANY required check that CAN be skipped
(job `if:`, path filter, reusable caller) can deadlock a merge — this is exactly the failure
mode LEARNINGS calls out for remudero once tiered sub-jobs (W1-T23/T25/T26) add path filters.

THE FIX (GitHub's canonical answer): make branch protection require ONLY this one job. It
ALWAYS runs (no `if:`, no path filter) so its context ALWAYS reports, and it FAILS ONLY when a
sibling check actually FAILED. Skipped / absent siblings do NOT block.

NOTE ON IMPLEMENTATION: the textbook `needs: [job, …]` + `join(needs.*.result)` aggregator
only works WITHIN ONE workflow. Once the security/quality/architecture tiers (W1-T23/T25/T26)
land, remudero's required checks will live in SEPARATE workflow files, and `needs:` cannot
reference jobs across files. So ci-gate instead reads the PR head commit's CHECK RUNS (across
ALL workflows, via the REST API — `checks: read`) and applies the same logic: fail only on a
real failure conclusion.

★ Branch protection must be flipped to require ONLY `ci-gate` + `remudero-review` (dropping
  the standalone `ci` context — the granular jobs can stay; they still run + report, ci-gate
  just aggregates them). That flip is admin config, done OUTSIDE this PR, and is Craig's to
  run — see the PR description for the exact `gh api` PATCH.

## ci-gate job — timeout-minutes

### Base lines 48-53 — R-50: this job's OWN script…

R-50: this job's OWN script can legitimately run past GitHub's 360-minute default under
nothing but its own two knobs below -- WAIT_CAP_SECONDS (2400s = 40m) plus, if a required
check is failing when that wait concludes, GRACE_WINDOW_SECONDS (600s = 10m) -- 2400+600 =
3000s = 50m worst case. 60m keeps this job's own external bound strictly above that derived
worst case (the same "the bound must exceed what it bounds" property ci.yml's heavy band
already owes ci-gate) while still being a FINITE, loud ceiling rather than the 360m default.

## ci-gate job env — REQUIRED

### Base lines 59-133 — The check-run names that ALWAYS…

The check-run names that ALWAYS appear on a PR today (run, or report a SKIPPED run) —
the gate WAITS for all of these to reach a terminal state before deciding, so a slow-to-
register check can never let the gate pass prematurely (the registration race). Keep in
sync as tiered sub-jobs (W1-T23 security / W1-T25 quality / W1-T26 architecture) land —
each adds its job name here once it is live on main.
`lint-plan` (W1-T20c, §5C Layer A) added: UNCONDITIONAL (no path filter, runs every PR),
same safety property as `ci` — a path-filtered required check is the synthwatch #102
deadlock class this list must never reproduce.
`depcruise` (W1-T26, §5 TIER 3 architecture fitness) added: same UNCONDITIONAL shape —
no path filter, runs every PR.
`containment-probe` (W1-T28, §5 TIER 1 "containment probe as a REQUIRED check") added:
same UNCONDITIONAL shape — no path filter, runs every PR; internally scoped to diffs
touching sandbox/hooks/env/deny-floor via containmentTrigger() (src/lib/specialist-panel.ts).
`coverage-ratchet` (W1-T25, §5 TIER 2 quality gate 1/4) added: UNCONDITIONAL (no path
filter, no `if:`), same safety property as `ci`/`lint-plan` above.
`mutation-ratchet` (W1-T96, §5 TIER 2 quality gate 2/4) added: same UNCONDITIONAL shape —
no path filter, runs every PR (scoped internally to one module, and — as of W1-T108 —
diff-scoped the same way as `containment-probe` above: the check run always registers,
the expensive Stryker run inside it only fires when the diff can move the score — see
ci.yml's comment).
`jscpd-gate` (W1-T97, §5 TIER 2 quality gate 3/4) added: same UNCONDITIONAL shape — no
path filter, runs every PR; jscpd's own --threshold flag enforces the ceiling natively.
`claims` (W1-T29, §12A the AWARENESS LAYER for prose) added: same UNCONDITIONAL shape —
no path filter, runs every PR; a red claim means THE PLAN IS LYING ABOUT THE SYSTEM.
`learnings-budget-ratchet` (W1-T38, §8A "compression is a deliverable" ENFORCED) added:
same UNCONDITIONAL shape — no path filter, runs every PR; a corpus-growing PR that pushes
the active learnings corpus past the recorded cap goes red until compressed or the cap is
deliberately raised.
`commitlint` (W1-T31, §6A Conventional Commits) added: same UNCONDITIONAL shape — no path
filter, runs every PR; lints only this PR's own base..head commit range.
`api-client-drift` (W3-T1b, §7A "packages/api-client is GENERATED... drift between the
committed client and the surface is caught in CI") added: same UNCONDITIONAL shape — no
path filter, runs every PR; a stale/hand-edited packages/api-client/src/schema.d.ts goes
red against a fresh regeneration from openapi/daemon.yaml.
`no-hand-rolled-fetch` (W3-T1c, §7A "No client may hand-roll a fetch to the daemon -- a
grep gate fails the build") added: same UNCONDITIONAL shape — no path filter, runs every
PR; a direct fetch/axios/XHR call anywhere under apps/** or packages/** (except the
sanctioned packages/api-client) goes red. The companion consumer-typecheck half of W3-T1c
(packages/daemon-client-smoke) needs no new required check here: it typechecks for free
under the already-required `ci` job (tsconfig.json's `include` covers
`packages/*/src/**/*.ts`).
`scan-pr / osv-scan` (W1-T211, §5 Tier-1 security stack) added: osv-scanner-pr.yml is the
ONLY scanner in the stack configured `fail-on-vuln: true` (CodeQL/Semgrep/Scorecard are
advisory-only SARIF uploads by design) — a hard-failing check that ci-gate never listed
was invisible to branch protection once protection was flipped to require only `ci-gate` +
`remudero-review` (see the file header above), so a planted/real CVE could turn this check
run red and still merge. Same UNCONDITIONAL shape — no path filter, runs every PR. The
check-run name is namespaced by GitHub as `<caller job> / <reusable workflow job>` because
osv-scanner-pr.yml calls google/osv-scanner-action's reusable workflow instead of running
inline (verified against a live PR's check-runs API response, not assumed from the yaml).
`License Review` (W1-T934, §5 §5C §6A "a dependency-licence allow-list gate") added: a
NATIVE job in dependency-review.yml (not a `uses:` reusable-workflow caller), so — same as
the existing `dependency-review` job's own `name: Review` in that same file, already relied
on by test/scanner-gate-config.test.ts — its registered check-run name is simply its own
`name:` field, not the job id `license-review`. Same UNCONDITIONAL shape as every entry
above: no path filter, no `if:`, runs every PR; unlike the pre-existing `dependency-review`
/ `Review` job (kept warn-only, `continue-on-error: true`, NOT in this list), `License
Review` carries no continue-on-error and fails on a disallowed, unresolved, or (via its own
follow-up step) undeterminable-licence dependency introduced by the PR.
`leak-grep` / `assertion-discrimination` / `task-id-existence` (all three ci.yml jobs) and
`acceptance-author-gate` (its own file) / `unwired-gate` (its own file) added (R-51,
docs/audits/recon-2026-09-05.md): all five already ran UNCONDITIONALLY on every PR — no
path filter, no job `if:` beyond `github.event_name == 'pull_request'` (or, for
acceptance-author-gate, no `if:` at all) — but none was in this list, so a red run on any
of them could never hold a merge; a hand-opened PR could carry a leaked secret, a
comment-stripped assertion that never executes, an unreserved/colliding task id, an
acceptance block that fails author-time parsing, or a newly added gate-shaped script no
workflow invokes, and merge anyway. Measured wall-clock on PR #4075 (sha 761365c,
2026-09-05, via the check-runs API — one read per job, not re-timed here): leak-grep 6s,
unwired-gate 19s, acceptance-author-gate 20s, task-id-existence 25s,
assertion-discrimination 26s — all five comfortably inside WAIT_CAP_SECONDS (2400s), no cap
change needed. Same UNCONDITIONAL shape as every entry above.
One entry per line (JSON array, folded-scalar YAML) so concurrent PRs each adding a new
required check append a line instead of both editing the same line — avoiding the merge
conflict that a single-line array forces on every simultaneous gate addition.

## ci-gate job env — IGNORE

### Base lines 158-159 — Not quality gates — never wait…

Not quality gates — never wait on or fail for these (ci-gate is self; remudero-review is
a separate required context posted directly by the orchestrator, not a check-run).

## ci-gate job env — ADVISORY

### Base lines 162-173 — ADVISORY (R-51) — every OTHER…

ADVISORY (R-51) — every OTHER check-run this repo's workflows register on a `pull_request`
event, named here ONLY so test/every-pr-check-is-required-or-advisory.test.ts can prove
completeness: a job that is neither REQUIRED nor ADVISORY is a silent gap, exactly the
shape this repo's own history keeps producing (a gate that runs and reddens without ever
blocking a merge — the defect R-51 fixes for the five names above). ci-gate's aggregator
script never reads this key; it exists for that test alone. Membership here is a claim
that the check-run is EITHER (a) a path-filtered / conditionally-skippable job, which can
never be REQUIRED without reproducing the synthwatch #102 deadlock class this file's own
header describes, or (b) a documented advisory-only scanner/aggregation-internal shard, or
(c) explicitly deferred pending a currently-red state (docs-index-check, see its own file's
header) — promoting any of these is a future, separate, one-concern PR, not a side effect
of adding a name here.

## ci-gate job env — GRACE_WINDOW_SECONDS

### Base lines 194-195 — W1-T261 RE-AGGREGATE grace window —…

W1-T261 RE-AGGREGATE grace window — see the step below for the mechanism. Kept as env
(not a literal) so tests can shrink both to seconds instead of minutes.

## ci-gate job env — WAIT_CAP_SECONDS

### Base lines 198-209 — W1-T312 WAIT CAP — sized…

W1-T312 WAIT CAP — sized from a MEASURED distribution of this repo's own required-check
wall-clock (max(completed_at) - min(started_at) across the REQUIRED set), not a guess:
n=10 samples on 2026-08-03 via `gh api repos/craigoley/remudero/commits/<sha>/check-runs`
— 8 routine PR merges clustered 241-550s (241, 292, 297, 298, 300, 304, 306, 550), plus the
2 real timeout incidents this task was filed from (#1229: ~1114s; #1234: ~1345s, both
derived from the failing run's own log timestamps — ci-gate started, then the `ci` job it
was waiting on finished 3m26s / past-cap minutes later). p95 of this n=10 sample ≈ 1345s
(the max). The OLD 900s cap sat BELOW that p95, so ci-gate timed out on green-in-progress
siblings on the routine-but-slow tail — the exact defect this task fixes. 2400s (40min)
gives ~79% headroom over the measured p95/max while staying a FINITE, loud bound (the cap
exists to catch a genuinely stuck check, not to be deleted — see the step below). Kept as
env (like GRACE_WINDOW_SECONDS) so tests can shrink it to seconds instead of minutes.
