# Contributing to Remudero

Every change lands through a PR against `main`, gated by two **required** status
checks:

- **`ci-gate`** — an always-reporting aggregator over every other check-run on the
  PR (including the granular `ci` typecheck+test job); it fails only on a real
  failure, so a legitimately skipped sibling job can never deadlock a merge.
- **`remudero-review`** — an acceptance verdict (Standing rule 4: green CI is not
  evidence that a change did what it claims). See [docs/review-gate.md](docs/review-gate.md).

GitHub merges a PR only when BOTH are green. Auto-merge is safe to leave armed.

## Automated PRs (`rmd run-task`)

`rmd run-task <task-id>` posts `remudero-review` automatically as part of its flow
(after CI is green, before it arms auto-merge). Nothing extra to do.

## Plan edits (`MASTER-PLAN.md`, `plan/tasks.yaml`) — PR only, never scp

The plan is the one artifact whose edit history matters most. It lands **only**
through a branch + PR, gated by the same `ci-gate` + `remudero-review` checks as
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

## Comments — plain language, and a ceiling on volume

Code comments follow [ISO 24495-1](https://www.iso.org/standard/78907.html) plain language, written
up in [`docs/comment-standard.md`](docs/comment-standard.md). Read it before writing a long block.
The short version: lead with a purpose sentence, one idea per sentence, and earn the space by
stating an invariant, a trap, or the falsifier test — then cite the record (PR number, task id,
`DECISIONS.md` date) instead of retelling it. Measured forensics go in `learnings/*.yaml` or a dated
page under `docs/`, with a one-line pointer left in the code.

Two limits refuse a PR, both via the `comment-load-ratchet` CI job
(`scripts/comment-load-ratchet.mjs`): no measured file may carry more comment lines than
`scripts/comment-load-baseline.json` records for it, and no diff may add a comment block longer than
40 lines. If growth is right, record it in the baseline in the same PR so a reviewer reads the
decision.

**A compaction PR migrates or keeps every phrase a test pins.** 206 assertions across 138 test files
read `src/` files as raw text and match on a literal substring (R-44,
`docs/audits/recon-2026-09-05.md`). Before shortening a block, run
`git grep -lF -- '<phrase>' test/` on the sentences in it.

## Commit messages — Conventional Commits (W1-T31, §6A)

Every commit message must follow [Conventional Commits](https://www.conventionalcommits.org/)
(`type(scope): subject`, e.g. `fix(cli): correct the flag parsing`). The `commitlint` CI job
lints the **PR title** — the squash-merge subject, read live from GitHub — and fails red on a
malformed one; individual commits on the branch are not linted (retitle, then push or re-run the
job). See `commitlint.config.mjs`. `type` still selects `feat:`/`fix:`/`BREAKING CHANGE:` (or `!`
after the type/scope) for a minor/patch/major bump, but the bump itself is deferred until releases
are cut: the project is pre-alpha, carries no semver tags, and `CHANGELOG.md` is frozen (see
README's "Pre-alpha" section). Do not run `npm run changelog` (wraps `commit-and-tag-version`) until
that changes.

## Local checks before pushing

```sh
npm ci                       # a fresh worktree has no node_modules
./bin/rmd preflight --ci-parity   # the shipped local gate: shells CI's own commands, one per ci.yml job
```

`rmd preflight --ci-parity` (`src/lib/ci-parity.ts`) is the one command to run before a first
push: its `ci` entry runs `npm run test:ci`, the same full-suite command CI runs, so a green run is
the real signal. The pieces are also available on their own — `npm run typecheck` (`tsc --noEmit`;
`npm run build` emits `dist/`), `npm run depcruise`, and `npm run check -- test/<file>.test.ts`
for one file plus a typecheck. The full suite needs a host with the pinned Chromium build and a
non-root uid; inside an agent container it cannot pass honestly — see
[docs/troubleshooting.md](docs/troubleshooting.md#the-full-test-suite-cannot-pass-inside-the-agent-container).
