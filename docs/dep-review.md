# Dependency-PR review lane (W1-T54 + W1-T54b)

`remudero-review` is a **REQUIRED status check** on `main` (see
[docs/review-gate.md](review-gate.md)). Nothing ever posted it on a Dependabot
PR, so every dependency bump sat **UNMERGEABLE — fail-closed, but frozen**,
never even surfaced as actionable. `rmd dep-review <pr>` (`src/lib/dep-review.ts`
+ `src/run-task.ts`'s `depReviewCommand`) is a **second deterministic judge**,
scoped to Dependabot PRs only, that fixes that. This document describes the
lane as it is **wired and running** — not an aspiration — and records its live
proof.

## The five-way verdict

`decideDepReview` (`src/lib/dep-review.ts`) is a pure function, no LLM ever, run
in this fail-closed order:

1. **`refuse`** — the PR author is not `dependabot[bot]` (normalized across the
   REST spelling `dependabot[bot]` and the GraphQL spelling `app/dependabot`),
   or the diff touches a file outside the manifest/lockfile allowlist
   (`package.json`, lockfiles for several ecosystems, and
   `.github/workflows/*.yml` for the actions ecosystem). A "dependency bump"
   that also edits source is not a dependency bump. **Nothing is posted** —
   identical to today's silence, but now a deliberate outcome. Exit 2.
2. **`migrate`** — a parseable major bump, confined to manifests. Red checks on
   the bot PR are treated as migration evidence, not as a reason to wait for a
   branch the lane will never edit. `rmd dep-review` captures one durable
   feedback entry keyed by `owner/repo + dependency@target-major`, comments the
   exact Dependabot command `@dependabot ignore this major version`, and closes
   the PR without deleting its branch. It posts no successful
   `remudero-review` status and never arms auto-merge. Exit 0 only after
   capture, command, and close all complete.
3. **`escalate`** — a bump whose semver level cannot be parsed, or a major
   whose dependency identity cannot be safely extracted. That still uses the
   existing `MANUAL` needs-human escalation issue carrying the PR's release
   notes. Exit 1.
4. **`hold`** — a minor/patch bump with a required check genuinely red or still
   pending. **Nothing is posted**; the caller (a future poll / `rmd drain`)
   tries again later. Exit 1.
5. **`arm`** — a minor/patch bump, confined to manifests, every required gate
   green: post `remudero-review=success` and arm GitHub auto-merge. Exit 0.

The semver level is the **worst** constituent bump across every `from X to Y`
pair Dependabot lists in the title/body — a grouped PR with even one major
constituent migrates the whole PR (never split the difference on a mixed-risk
group). Dependency identities are parsed only from Dependabot's own anchored
summary lines (`Updates \`pkg\` from X to Y`, `Bumps [pkg](...) from X to Y`,
or the title's `bump pkg from X to Y`), never from release-note prose.

## The call site

`rmd dep-review <pr> [--repo <name>]` (`src/run-task.ts`): fetches the PR
(author, title, body, head sha, status-check rollup) and diff via `gh`, runs
`decideDepReview`, ledgers `dep-review.decided`, then acts on the verdict
exactly as above. The `migrate` branch is deliberately staged: durable feedback
capture first, then the Dependabot ignore comment, then PR close. If capture
fails, the PR is left untouched. If comment or close fails, the migration entry
remains and the incomplete action is ledgered so the next sweep pass retries it
instead of treating feedback existence as resolution. It never shells out a
decision — `lib/dep-review.ts` decides, this command only posts.

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
- **Historical major proof — [PR #81](https://github.com/craigoley/remudero/pull/81)**
  (`build(deps-dev): bump @types/node from 22.20.1 to 26.1.1`) used the old
  `escalate` behavior: `rmd dep-review 81` posted `remudero-review=failure`
  and opened **[issue #89](https://github.com/craigoley/remudero/issues/89)**.
  That proved major bumps did not auto-merge, but it did not create a durable
  migration queue or suppress the major proposal. The same `@types/node` 26
  target recurred as #3654, and red checks then held the PR before it reached
  the old major branch. The current lane converts that class to `migrate`
  before checking red gates.

The lane is now proven by unit fixtures rather than another live Dependabot
write: a confined minor/patch bump merges unattended, a parseable major becomes
durable migration feedback and is closed/suppressed only after capture, and an
unparseable proposal still fail-closes through the MANUAL escalation path.
