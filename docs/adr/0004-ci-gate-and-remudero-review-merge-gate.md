# 0004. `ci-gate` + `remudero-review` are the only required merge gate

Status: Accepted
Date: 2026-07-15

## Context

Two required GitHub status checks decide whether any PR can merge to `main`:
`remudero-review` (an acceptance-criteria verdict from a deterministic judge
over a fresh-context reviewer's findings) and `ci-gate` (an aggregator over
every other check-run on the head commit). `docs/review-gate.md` describes
both as "wired and running... not an aspiration", and MASTER-PLAN §12 rule 3B
states the invariant this ADR records: "The merge gate is a GitHub-enforced
CONTRACT (required status checks), never a runner-side decision that can be
raced... GitHub does the merging. The runner ARMS auto-merge and observes."

Provenance, from git history:

- `remudero-review` became a required check with PR #12 (W1-T1D,
  2026-07-14): "the gate enforces the reviewer — remudero-review required
  check." Before this, `src/lib/review.ts` existed (W1-T1C) but nothing
  called it.
- `ci-gate` itself — the always-running, no-`if:`, no-path-filter aggregator
  workflow — was added by PR #75 (W1-T24, 2026-07-15), specifically to solve
  a deadlock: `docs/review-gate.md` explains that a plain `ci` job is a safe
  required context only as long as it is unconditional; the moment a
  path-filtered sub-job exists, a required check that GitHub sees as
  "skipped" for a given PR reads as "expected, pending" and never resolves,
  deadlocking the merge forever (cited there as proven on the operator's
  other fleet, "synthwatch #102").
- The branch-protection setting that makes `ci-gate` (rather than the bare
  `ci` job) the second required context is a GitHub API/UI change, not a file
  in this repo, so it leaves no commit to cite directly. `docs/review-gate.md`
  states it was "flipped by the operator, VERIFIED 2026-07-15" via
  `gh api repos/craigoley/remudero/branches/main/protection`, with the prior
  `["ci", "remudero-review"]` pair kept only as a recovery target. This
  checkout cannot re-verify a point-in-time GitHub API response, so that date
  is carried here as reported by `docs/review-gate.md`, not independently
  re-confirmed.

## Decision

`main` is protected by exactly two required status-check contexts:
`ci-gate` and `remudero-review`. No other check may gate a merge; a new
tiered check (the security/quality/architecture sub-jobs `docs/review-gate.md`
names as future work) attaches as an input `ci-gate` aggregates, never as a
third required context of its own.

## Consequences

- Adding a new required-sounding check safely means adding it as an
  unconditional or `ci-gate`-aggregated signal, not as a third top-level
  required context — doing the latter reopens the exact path-filter deadlock
  `ci-gate` exists to prevent.
- The runner's own exit code/telemetry around a PR is advisory only; per rule
  3B, only the two GitHub-enforced contexts can actually block or allow a
  merge, which is what makes "leave auto-merge armed" safe.
- The branch-protection setting itself lives outside version control, so this
  decision's live state can drift from what this ADR (or `docs/review-gate.md`)
  describes without a diff ever showing it; re-verifying it means an operator
  re-running the `gh api ... /branches/main/protection` query, not reading git
  history.

**How to reverse:** removing either required context is a single
branch-protection API call, but doing so for `ci-gate` alone reintroduces the
exact path-filter deadlock risk it was built to close the moment any tiered
sub-job ships; removing `remudero-review` reopens merging on CI-green alone,
which rule 4 (§12) explicitly calls insufficient evidence of met acceptance
criteria. Cheap to flip, expensive to want to.
