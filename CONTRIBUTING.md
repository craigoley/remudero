# Contributing to Remudero

Every change lands through a PR against `main`, gated by two **required** status
checks:

- **`ci`** — typecheck + the full test suite.
- **`remudero-review`** — an acceptance verdict (Standing rule 4: green CI is not
  evidence that a change did what it claims). See [docs/review-gate.md](docs/review-gate.md).

GitHub merges a PR only when BOTH are green. Auto-merge is safe to leave armed.

## Automated PRs (`rmd run-task`)

`rmd run-task <task-id>` posts `remudero-review` automatically as part of its flow
(after `ci` is green, before it arms auto-merge). Nothing extra to do.

## Plan edits (`MASTER-PLAN.md`, `plan/tasks.yaml`) — PR only, never scp

The plan is the one artifact whose edit history matters most. It lands **only**
through a branch + PR, gated by the same `ci` + `remudero-review` checks as
code — never scp'd, rsync'd, or manually copied into the tree. See
[docs/plan-sync.md](docs/plan-sync.md) for the full flow.

## Manual PRs (plan edits, docs, hand-run changes) — you MUST post the review

Because only `rmd run-task` posts `remudero-review`, a **hand-opened PR sits
BLOCKED** with the required check absent. Unblock it with the escape hatch — the
**same deterministic judge**, invoked by hand (never a bypass, never `--force`):

```sh
rmd review <pr-number>
```

`rmd review`:

1. resolves the PR head sha and diff;
2. finds the acceptance criteria — from the `Remudero-Task: <id>` trailer
   (→ `plan/tasks.yaml`) if present, otherwise from an **`Acceptance:` block in the
   PR body** (see below);
3. judges the PR body (the REPORT) against each criterion's proof with the same
   `judgeReview` the runner uses, and posts the `remudero-review` status.

**A PR with no acceptance criteria FAILS CLOSED** — nothing to judge is never a
pass. So a manual PR that wants to merge must state what it claims and how it is
proven. Put this in the PR body:

```
Acceptance:
- <claim> | <proof — observable system state: gh api output, a test result, a grep>
- <claim> | <proof>
```

Then paste the actual proof text into the PR body (it is what the judge reads),
and run `rmd review <pr-number>`. A proof that only *describes* a mechanism instead
of showing its observable state will not substantiate its criterion (LEARNINGS.md:
"a doc that describes a mechanism is never proof it exists").

## If branch protection is ever misconfigured (deadlock recovery)

A required check that nothing posts blocks every merge. To reset the required
contexts back to `ci`-only:

```sh
gh api --method PATCH \
  repos/craigoley/remudero/branches/main/protection/required_status_checks \
  -F strict=false -f 'contexts[]=ci'
```

To restore the full gate afterward, add `-f 'contexts[]=remudero-review'`.

## Architecture — fitness rules and irreversible decisions

`src/lib` is the reusable core and must never import the CLI entrypoint
(`src/run-task.ts`) or the scratch spike script (`src/spike.ts`) —
`.dependency-cruiser.cjs` enforces this (`npm run depcruise`) and CI runs it
on every PR.

A one-way-door change (one materially harder to revert than an ordinary PR)
gets a short Architecture Decision Record in [`docs/adr/`](docs/adr/README.md)
landed in the same PR. Reversible, PR-shaped changes stay in
[`DECISIONS.md`](DECISIONS.md)/auto-choose — see
[`docs/adr/README.md`](docs/adr/README.md) for which is which.

## Local checks before pushing

```sh
npm ci            # a fresh worktree has no node_modules
npm run build     # typecheck (tsc)
npm run depcruise # architecture fitness rules
npm test          # full suite
```
