# Base-ref contract

BASE-REF CONTRACT: every diff base this repository's executable surface resolves is
origin-tracking (`origin/main`), event-supplied (a PR `BASE_SHA`/`GITHUB_BASE_REF`), caller-supplied
(an explicit `--base` argument), or a remote-API branch-name argument — never the LOCAL `main` ref,
which this checkout's `git rev-list --count main..origin/main` measured **1898** commits behind
origin at filing time (2026-09-02; ~1556 at the follow-up harvest four days earlier, 2026-08-30 —
consistent with MASTER-PLAN's standing note that the primary checkout drifts ~85–100 commits/cycle).

W1-T2630. Filed as a follow-up harvest from run W1-T2463 (2026-08-30), which measured the drift and
named the open question: does anything read the stale local ref as a diff base. This document is
the record; `test/no-consumer-resolves-a-base-from-the-local-main-ref.test.ts` is the falsifiable,
CI-enforced proof that the answer stays no.

## Ruling on the ref itself: LEAVE IT

Nothing in this task moves, deletes, or renames the local `main` ref, and nothing should.
W1-T405's note (i) already settled the principle for this class: a run worktree is ephemeral and
cut fresh from a remote-tracking ref on every dispatch (`worktreeAdd` fetches and bases on
`origin/main`, then asserts base currency against a live `ls-remote`); the long-lived ref that
actually drifts belongs to a checkout that `self-sync` deliberately REFUSES to touch while it is not
the one currently checked out (W1-T445's guard — "never move a ref that is not the checked-out
main"), and the install-root inspector marks an off-main checkout UNFIT rather than mutating it.
W1-T405 established that the target clone is created clone-once-if-absent, with nothing ever
updating its local branches afterward — only remote-tracking refs move, via the fetch inside
`worktreeAdd`. 1898 is the expected steady state of a ref nobody owns, and it will keep growing at
roughly the same per-cycle rate. **A stale ref nothing reads is inert; the remedy for a ref nobody
reads is to prove nobody reads it, not to start maintaining it.** This document and its guard are
that proof, not a repair.

## Scope of the sweep

The executable surface: `src/`, `scripts/`, `hooks/`, `.github/` (all workflow files, not only
`ci.yml`), and `deploy/` — the last one named explicitly because the prior read at filing time
(README of W1-T2463's follow-up) covered only `src`, `scripts` and `.github/workflows` with head
limits, and left `hooks/`, `deploy/`, the remaining workflow files, and any base derived from a
repository `default_branch` value unchecked. All five are covered below, including every git
invocation this sweep could find via both `execFile(Sync)`/`spawn(Sync)` argv arrays (`.ts`/`.mjs`)
and literal shell `git <subcommand>` text (`.sh`, and `run:` blocks inside `.yml`).

`apps/` and `packages/` were also checked and contain **zero** `git` invocations of any kind
(future dashboard/client shells talk to the daemon over `@remudero/api-client`, never a local
checkout) — named here so "not enumerated" cannot be read as "not looked at". `plan/` and prose docs
(including this file and MASTER-PLAN.md) are deliberately OUT of scope: they discuss `main` at
length as prose, and gating a source scan on prose would redden every plan PR — the same trap the
task's design note calls out.

## The discriminator: position, never the word

A base is only ever read from the ref operand of six git subcommands: `diff`, `log`, `merge-base`,
`rev-list`, `rev-parse`, `show`. Every occurrence of the literal text `main` anywhere else — a forge
`--base` argument, a `-b main` clone/init branch flag, a `branch === "main"` string compare, a
`default_branch ?? "main"` remote-API fallback, a `branches: [main]` Actions trigger filter, or
plain prose — is not a base read and is classified below by what it actually is, not flagged by
surface text (see W1-T81's lesson on that mistake, and the guard's own header comment).

## Classified enumeration

### origin-tracking (reads `origin/main`, a remote-tracking ref — never local `main`)

| Path | What it reads |
| --- | --- |
| `src/lib/ci-parity.ts` (`refreshOriginMain`, `mergeBaseDiffText`) | `git fetch origin main` then `git diff origin/main...HEAD` against `origin/main`; the `lint-plan` job entry's own `git rev-parse origin/main` read is inline in its `run` callback, owned by no named symbol |
| `src/lib/status-board.ts` (`resolveOriginMainSha` default) | `git rev-parse origin/main` — LOCAL read, no fetch, by design (offline-safe) |
| `src/run-task.ts` (`readOriginShardsAtRef`/`materializeOriginShards`, `commitsAhead`, `irreversibleSignalForWorktree`, `checkAcceptanceChangedFiles`, `worktreeMergeBase`, `mergedTriageSubjects`, plan-tree reads, `syncPlanFromOrigin`, drain/scope guards, `lint-plan`'s default) | `git show origin/main:<path>`, `git ls-tree --name-only origin/main plan/tasks.d/` + `git cat-file --batch` (the SHARD read — ONE batch for every shard, never one `git show` each, #4081), `git rev-list --count origin/main..HEAD`, `git diff origin/main...HEAD`, `git merge-base origin/main HEAD`, `git log origin/main`, `git rev-parse origin/main:plan`, `git reset --hard origin/main`, `git fetch origin main` |
| `src/lib/plan.ts` (`loadPlanAtRef`, `readBlobsAtRef`) | `git show <ref>:<path>` for the monolith, then `git ls-tree --name-only <ref> <dir>/tasks.d/` + ONE `git cat-file --batch` for every shard (#4081) |
| `src/lib/retro.ts` (`readFreshShardText` default) | `git fetch --quiet origin main` then `git show origin/main:<path>` |
| `src/lib/self-sync.ts` | `git diff --name-only HEAD..origin/main` after a fetch already ran |
| `src/lib/deployer.ts` (`incomingFiles`) | `git diff HEAD..origin/main` |
| `src/lib/operator-sync.ts` (`rmd sync`) | `git diff --name-only HEAD..origin/main` |
| `src/lib/merge-state.ts` (`theirsLog`) | `git log <merge-base>..origin/main` |
| `src/run-task.ts` (`is-ancestor` check, `status` command) | `git merge-base --is-ancestor origin/<name> origin/main` |
| `deploy/recycle-container.sh` | `git diff --name-only HEAD..origin/main` (dirty-guard before a container recycle) |
| `deploy/entrypoint.sh` (`resolve_target`) | tries `refs/remotes/origin/$REF` FIRST (`$REF` defaults to `main` but is event/caller-supplied — see below); the historical bug this comment documents was exactly a bare local-branch checkout, and the fix is what is now shipped |
| `.github/workflows/fleet-heartbeat-watch.yml` | `git log -1 --format=%ct/%s "origin/${branch}"` — dynamic branch name, always `origin/`-prefixed |

### event-supplied (a PR's own `BASE_SHA` / `GITHUB_BASE_REF`, read from the triggering event)

| Path | What it reads |
| --- | --- |
| `.github/workflows/ci.yml` (`ci` job) | `GITHUB_BASE_REF` after an explicit `git fetch --no-tags origin "${GITHUB_BASE_REF}"`, then `git diff --name-only "origin/${GITHUB_BASE_REF}...HEAD"` |
| `.github/workflows/ci.yml` (coverage/lint-plan/mutation-relevant/other PR-scoped jobs) | `BASE_SHA: ${{ github.event.pull_request.base.sha }}` then `git diff [--name-only] "${BASE_SHA}"...HEAD` |
| `.github/workflows/ci.yml` (`lint-plan` step) | `npm run lint-plan -- --base "$BASE_SHA"` |
| `.github/workflows/dependency-review.yml` | `--base "${{ github.event.pull_request.base.sha }}"` into GitHub's own dependency-graph compare API (not a git command at all) |

### caller-supplied (an explicit `--base <ref>` argument, no default resolution)

| Path | What it reads |
| --- | --- |
| `scripts/worker-branch-shape.mjs` | `--base <ref>`, defaulting to `"origin/main"` and DEGRADING to a skip (never a bare-`main` fallback) when that ref cannot be resolved locally |
| `src/run-task.ts` (`lintPlanCommand`, `syncPlanFromOrigin`'s `ref` param, `rmd review`'s base-proof builder) | an arbitrary caller-passed `<ref>` (CI passes the event's `BASE_SHA` into it — see event-supplied above) |

### remote-API (a branch name handed to a forge/GitHub read — never touches a local ref)

| Path | What it reads |
| --- | --- |
| `src/lib/main-health-rung.ts` | `metadata?.default_branch` from a GitHub repo-metadata API read |
| `src/lib/feedback.ts` | `gh api repos/${slug}` → `.default_branch` |
| `src/lib/onboard/inventory.ts` | `ghApiJson(["repos/{owner}/{repo}"])` → `defaultBranch ?? "main"` (the `"main"` here is a STRING FALLBACK for an unreachable API, never a local ref read) |
| `src/spike.ts`, `src/lib/env.ts` (comment), `src/run-task.ts` (×3), `src/lib/compaction.ts` | `gh pr create --fill --base main` — a forge argument, resolved remotely by GitHub |
| `src/lib/install-root.ts`, `scripts/recovery-drill.mjs` (×2), `deploy/verify-image.sh` (×2) | `git clone -b main <url>` / `git init -b main` — a branch-NAME-at-creation flag, resolved against the remote (clone) or simply naming the new repo's initial branch (init); neither reads an existing local ref |
| `.github/workflows/{codeql,dependency-review,osv-scanner,osv-scanner-pr,scorecard,semgrep,main-plan-guard}.yml` | `on: {push,pull_request}: branches: [main]` — a GitHub Actions TRIGGER FILTER deciding when the workflow runs, not a git command and not a base-ref position at all; listed here for completeness per criterion 4, not because it fits the taxonomy above |
| `hooks/deny-floor.sh` | `grep`s the literal text `main`/`master` inside a `git push --force` command to DENY it — a push-destination string match, not a base read |

### LOCAL-REF (reads the local `main` ref as a diff base)

**None found.** This is the deliverable, not an omission: `test/no-consumer-resolves-a-base-from-
the-local-main-ref.test.ts` runs the same classification mechanically over `src/`, `scripts/`,
`hooks/`, `.github/`, and `deploy/` on every PR (it rides the required `ci` context as an ordinary
`test/**/*.test.ts` file — no workflow edit was needed to wire it in) and fails loudly, naming the
offending file/line/subcommand, the day this table stops being true.

## If the sweep had found a live consumer

It would be named here and filed as a separate corrective task, never fixed inside this audit — a
behavior change smuggled into an evidence task is a second concern, and picking its correct base is
a judgement that has to be made after the finding is read, not before. That branch was not taken:
the table above is exhaustive over the stated scope and contains zero LOCAL-REF rows.
