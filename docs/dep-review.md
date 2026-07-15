# Dependency-PR review lane (W1-T54 + W1-T54b)

`remudero-review` is a **REQUIRED status check** on `main` (see
[docs/review-gate.md](review-gate.md)). Nothing ever posted it on a Dependabot
PR, so every dependency bump sat **UNMERGEABLE — fail-closed, but frozen**,
never even surfaced as actionable. `rmd dep-review <pr>` (`src/lib/dep-review.ts`
+ `src/run-task.ts`'s `depReviewCommand`) is a **second deterministic judge**,
scoped to Dependabot PRs only, that fixes that. This document describes the
lane as it is **wired and running** — not an aspiration — and records its live
proof.

## The four-way verdict

`decideDepReview` (`src/lib/dep-review.ts`) is a pure function, no LLM ever, run
in this fail-closed order:

1. **`refuse`** — the PR author is not `dependabot[bot]` (normalized across the
   REST spelling `dependabot[bot]` and the GraphQL spelling `app/dependabot`),
   or the diff touches a file outside the manifest/lockfile allowlist
   (`package.json`, lockfiles for several ecosystems, and
   `.github/workflows/*.yml` for the actions ecosystem). A "dependency bump"
   that also edits source is not a dependency bump. **Nothing is posted** —
   identical to today's silence, but now a deliberate outcome. Exit 2.
2. **`hold`** — a required check is genuinely red or still pending. **Nothing
   is posted**; the caller (a future poll / `rmd drain`) tries again later.
   Exit 1.
3. **`arm`** — a minor/patch bump, confined to manifests, every required gate
   green: post `remudero-review=success` and arm GitHub auto-merge. Exit 0.
4. **`escalate`** — a **major** bump, or one whose semver level cannot be
   parsed from the title/body (fail-closed — MASTER-PLAN §5 FLEET FINDING: a
   28-minute production outage once rode in on an unvetted major). Post
   `remudero-review=failure` (so the PR can **never** auto-merge) and open a
   `MANUAL` needs-human escalation issue carrying the PR's release notes, via
   the shipped `escalate()` path (`src/lib/escalate.ts`, W1-T8). Exit 1.

The semver level is the **worst** constituent bump across every `from X to Y`
pair Dependabot lists in the title/body — a grouped PR with even one major
constituent escalates the whole PR (never split the difference on a
mixed-risk group).

## The call site

`rmd dep-review <pr> [--repo <name>]` (`src/run-task.ts`): fetches the PR
(author, title, body, head sha, status-check rollup) and diff via `gh`, runs
`decideDepReview`, ledgers `dep-review.decided`, then acts on the verdict
exactly as above. It never shells out a decision — `lib/dep-review.ts` decides,
this command only posts.

## Live-proof evidence (W1-T54b)

W1-T54 (machine half, PR #87) shipped the code + fixtures under the current
gate. The **live** proof — this task, W1-T54b — is provable only against real
Dependabot PRs under the real `[ci-gate, remudero-review]` gate; a
worker-opened seed is refused by the lane's own author gate, and
`remudero-sandbox` has no `package.json` to bump (see `plan/tasks.yaml`'s
W1-T54b entry for the full bootstrap-ordering rationale). remudero had two
real parked Dependabot PRs, #80 (semver-minor group / patch-level constituent)
and #81 (semver-**major**), and both directions were run live, against them,
by a prior instance of this task
(`dep-review-PR80-1784150298601` / `dep-review-PR81-*`, ledgered
`2026-07-15T21:18–21:26Z` in `state/ledger.ndjson`):

- **Arm proof — [PR #80](https://github.com/craigoley/remudero/pull/80)**
  (`build(deps): bump @anthropic-ai/claude-agent-sdk from 0.3.209 to 0.3.210`):
  `rmd dep-review 80` decided `arm` (`"patch bump, confined to manifests, gates
  green — safe to auto-merge"`), posted `remudero-review=success` to the head
  commit (`a3c41541...`, verified live via
  `gh api repos/craigoley/remudero/commits/<sha>/status` —
  `{"context":"remudero-review","state":"success","description":"remudero-review:
  PASS — patch dependency bump, confined + gates green"}`), and armed
  auto-merge (ledger step `automerge.armed`, `2026-07-15T21:18:22Z`). **PR #80
  is MERGED** (`state: MERGED`, `mergedAt: 2026-07-15T21:18:21Z`, verified live
  via `gh pr view 80 --json state,mergedAt`) — the arm direction merges
  through the live `[ci-gate, remudero-review]` gate end to end.
- **Escalate proof — [PR #81](https://github.com/craigoley/remudero/pull/81)**
  (`build(deps-dev): bump @types/node from 22.20.1 to 26.1.1`): `rmd
  dep-review 81` decided `escalate` (`"MAJOR version bump — excluded from
  auto-merge at the dep-review lane"`), posted `remudero-review=failure` to
  the head commit (verified live — `statusCheckRollup` reads
  `{"context":"remudero-review","state":"FAILURE"}`), and opened
  **[issue #89](https://github.com/craigoley/remudero/issues/89)**
  (`[MANUAL] dep-review-PR81: major dependency bump needs human review`),
  carrying the release notes and a merge/close choice, recommendation
  "merge" (ledger step `dep-review.escalated`,
  `issue_url: https://github.com/craigoley/remudero/issues/89`). **PR #81 is
  still OPEN** (`state: OPEN`, verified live) — the escalate direction blocks
  auto-merge end to end; only an admin override could land it.

Both directions of the lane are proven, live, against the real required gate:
a confined minor/patch bump merges unattended, and a major bump is held open
with a human decision point, never silently merged.

The ledger also shows two intermediate `hold` decisions for PR #81 between
the first and final `escalate` runs (`redChecks: ["remudero-review"]` — the
lane's own previously-posted `remudero-review=failure` status reads back as a
red required check on a re-run, since `FAILURE` is a red conclusion). That is
`decideDepReview`'s fail-closed design working as documented: on re-run it
never assumes a prior red status is stale, and the caller (a repeated `rmd
dep-review 81` invocation, per the module doc's own description of `hold`)
tried again until the escalation issue was actually opened.
