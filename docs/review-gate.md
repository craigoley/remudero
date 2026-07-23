# Review-enforced merge gate (W1-T1C + W1-T1D + W1-T24 + W1-T24b)

`remudero-review` is a **REQUIRED status check** on `main`, alongside `ci-gate`.
GitHub merges a PR only when BOTH are green. This document describes the gate as
it is **wired and running** — not an aspiration.

Dependabot PRs are reviewed by a separate, second deterministic judge —
see [Dependency-PR review lane](dep-review.md) (W1-T54 + W1-T54b) — which is
the only thing that ever posts `remudero-review` on a Dependabot PR.

★ **`ci-gate` (W1-T24) is now the required aggregator context** — the operator
flipped branch protection FIRST (`gh api` PATCH below, run by Craig, VERIFIED
2026-07-15), and W1-T24b then proved the flip live, AFTER the fact, with two
probe PRs opened against the armed gate. See
[CI-gate aggregator](#ci-gate-aggregator-w1-t24) for the mechanics and
[Live-proof evidence (W1-T24b)](#live-proof-evidence-w1-t24b) for the probes.

## What each check proves

- **`ci`** (W1-T1B) — the code typechecks and its tests pass. Standing rule 4:
  green checks are **not** evidence that the task's ACCEPTANCE CRITERIA were met.
- **`remudero-review`** (W1-T1C reviewer, W1-T1D gate) — a verdict on whether the
  PR's REPORT substantiates each of the task's acceptance criteria against its
  stated proof.
- **`ci-gate`** (W1-T24) — an always-running aggregator that reads every other
  check-run on the PR's head commit and fails only if one of them genuinely
  failed (skipped/absent siblings are OK). It exists so that once tiered
  path-filtered sub-jobs land (W1-T23 security / W1-T25 quality / W1-T26
  architecture), a legitimately-skipped sub-job can never deadlock a merge —
  see [CI-gate aggregator](#ci-gate-aggregator-w1-t24).

## The call site (this is what W1-T1D actually wired)

`src/run-task.ts` owns the call site. The reviewer module (`src/lib/review.ts`)
was built and unit-tested by W1-T1C but **nothing called it** until now. In
`runTask`, after the PR is opened:

1. `waitForCiGreen(prUrl)` — poll `ci` to green (pending is never treated as pass;
   red or timeout ⇒ `blocked_ci`, no review over unproven code).
2. `runReview(...)`:
   - fetches the PR diff (`gh pr diff`) and head sha (`gh pr view --json headRefOid`);
   - spawns a **FRESH** read-only reviewer worker (`buildReviewPrompt` + a
     machine-readable verdict contract) — **never `resumeSessionId`, never
     `forkSession`**, in a throwaway cwd so it cannot mutate the diff it judges.
     This layer is **advisory**: its per-criterion verdicts can only **downgrade**
     a criterion to failure (`parseReviewerVerdicts` → `judgeReview` semantic),
     never rescue an unpasted proof, and a reviewer that fails to spawn never
     blocks the gate;
   - computes the **binding** verdict with the **deterministic** `judgeReview`
     (Standing rules 2/4/12: a merge gate is a deterministic predicate, never an
     LLM decision) and **always** posts the authoritative `remudero-review` status
     to the head sha via `postReviewStatus`. The orchestrator posting
     unconditionally is what guarantees a required check is **never missing** — a
     required status nothing posts deadlocks every merge on the repo (the exact
     regression this task fixed).
   - ledgers `review.posted` with the state, head sha, and reasons.
3. Only **after** a `remudero-review=success` does the runner arm auto-merge and
   poll to the gate. A `review=failure` is `blocked_review`: the required check is
   red, the PR is left OPEN, GitHub will not merge.

The reviewer NEVER edits code and exposes no write path (`review.ts` is read-only
+ `gh` by construction).

## Required contexts

```
required_status_checks.contexts = ["ci-gate", "remudero-review"]
```

**This is the CURRENT, live state** (flipped by the operator, VERIFIED
2026-07-15 via `gh api repos/craigoley/remudero/branches/main/protection --jq
.required_status_checks.contexts`). The prior gate, `["ci", "remudero-review"]`,
is now only the *recovery* target — see the PATCH block in
[CI-gate aggregator](#ci-gate-aggregator-w1-t24). W1-T24b proved the armed
`ci-gate` context live, after the flip, with two probe PRs — see
[Live-proof evidence (W1-T24b)](#live-proof-evidence-w1-t24b).

## CI-gate aggregator (W1-T24)

`ci` is a single unconditional job today, so it is a safe required context by
itself. That stops being true the moment a **path-filtered** sub-job is added
(W1-T23 security tier, W1-T25 quality tier, W1-T26 architecture tier): a
required check whose workflow is `if:`/`paths:`-skipped on a given PR reads as
"expected, pending" and **deadlocks that merge forever** (LEARNINGS; proven live
on the operator fleet — synthwatch #102).

The fix, `.github/workflows/ci-gate.yml`, is ONE always-running job (no `if:`,
no path filter) that:

1. reads the PR head commit's check-runs **across every workflow** via
   `gh api repos/.../commits/<sha>/check-runs` (a `needs:`-based aggregator only
   sees jobs within its own workflow file — insufficient once sub-jobs live in
   separate tier workflows);
2. waits for each name in its `REQUIRED` env list to reach a terminal
   (`completed`) state, fail-closed on timeout (15 min);
3. fails **only** if a non-ignored check's conclusion is a real failure
   (`failure`, `timed_out`, `cancelled`, `action_required`, `startup_failure`) —
   `skipped`, `neutral`, and `success` all pass, so a legitimately path-filtered
   sub-job never blocks.

Because `ci-gate` always reports, it is safe to make it (alongside
`remudero-review`) the **only** required status context — the granular sub-job
contexts (`ci`, and later the tier jobs) keep running and reporting, they are
just no longer individually *required*.

**The branch-protection flip was NOT part of the PR that added this workflow —
and it was executed FLIP-THEN-PROVE, not prove-then-flip.** A protection
mutation is not PR-shaped (§4 hard-stop: it is a HUMAN, admin-run step), so the
sequence actually run was: the operator (Craig) flipped protection FIRST with
the exact PATCH below (VERIFIED 2026-07-15 — `required_status_checks.contexts`
reads `[ci-gate, remudero-review]`), and only THEN did a headless worker
(W1-T24b) live-prove both directions AGAINST the already-armed gate — a real
red sub-check holds it red; a skipped sub-job does not deadlock it. See
[Live-proof evidence (W1-T24b)](#live-proof-evidence-w1-t24b) for the probe PRs
and run URLs. The PATCH that performed the flip:

```sh
gh api --method PATCH \
  repos/craigoley/remudero/branches/main/protection/required_status_checks \
  -f 'contexts[]=ci-gate' -f 'contexts[]=remudero-review'
```

Recovery if `ci-gate` is ever found to be misbehaving after the flip: reset
straight back to the previous, already-proven pair with the same endpoint:

```sh
gh api --method PATCH \
  repos/craigoley/remudero/branches/main/protection/required_status_checks \
  -f 'contexts[]=ci' -f 'contexts[]=remudero-review'
```

## Live-proof evidence (W1-T24b)

Final protection state, confirmed live:

```sh
$ gh api repos/craigoley/remudero/branches/main/protection \
    --jq .required_status_checks.contexts
["remudero-review","ci-gate"]
```

Two probe PRs, opened by the worker itself against the already-armed gate,
proved both directions of the aggregator end to end:

- **Skip proof — [PR #82](https://github.com/craigoley/remudero/pull/82)**
  (`probe/skip-path-filter-1784143764897`, MERGED): added
  `.github/workflows/probe-path-filter.yml`, scoped to a `paths:` glob this PR
  never touches, so it registers **no check run at all** on the head commit.
  Head-commit rollup: `ci-gate` = `SUCCESS`, `ci` = `SUCCESS`, plus every
  security-tier sub-job green or `NEUTRAL` — `probe-path-filter` absent from
  the rollup entirely (run
  [29445036456](https://github.com/craigoley/remudero/actions/runs/29445036557)).
  `remudero-review` was posted via the escape hatch (`rmd review 82`, judged
  against the PR body's own `Acceptance:` block) and the PR merged under the
  live `[ci-gate, remudero-review]` gate — a legitimately-skipped sub-job does
  **not** deadlock merge.
- **Red proof — [PR #83](https://github.com/craigoley/remudero/pull/83)**
  (`red-subcheck-1784143764897`, CLOSED, never merged, branch deleted): added
  `src/__probe/red-subcheck.ts`, a planted TypeScript type error. Head-commit
  rollup: `ci` = `FAILURE`
  ([run 29445067715](https://github.com/craigoley/remudero/actions/runs/29445067715)),
  `ci-gate` = `FAILURE`
  ([run 29445067530](https://github.com/craigoley/remudero/actions/runs/29445067530)),
  every other sub-job still green — `gh pr view --json mergeable,mergeStateStatus`
  read `mergeable: MERGEABLE, mergeStateStatus: BLOCKED`: a deliberately RED
  sub-check holds the merge closed under the required `ci-gate` context. The
  red state was captured here, then the PR was closed unmerged and its branch
  deleted — its only value was the captured evidence.

## Bootstrap ordering (LOAD-BEARING — same pattern as T1B)

Arming `remudero-review` as required **before** a poster exists would deadlock the
repo permanently (a required check that nothing posts blocks every merge). So the
sequence is strict and cannot be reordered:

1. The poster (`runReview`) lands first — **this PR merges under the CURRENT
   `ci`-only gate**.
2. Live-prove both directions *before* touching protection: a legitimate PR gets
   `remudero-review=success`; a CI-green PR that ignores a stated acceptance
   criterion gets `remudero-review=failure` and does not merge.
3. **Only then** add `remudero-review` to the required contexts:

   ```sh
   gh api --method PATCH \
     repos/craigoley/remudero/branches/main/protection/required_status_checks \
     -f 'contexts[]=ci' -f 'contexts[]=remudero-review'
   ```

4. Confirm:

   ```sh
   gh api repos/craigoley/remudero/branches/main/protection \
     --jq .required_status_checks.contexts
   # -> ["ci","remudero-review"]
   ```

Recovery if the repo is ever deadlocked (required check with no poster): reset the
contexts with the same `PATCH` endpoint down to `["ci"]`:

```sh
gh api --method PATCH \
  repos/craigoley/remudero/branches/main/protection/required_status_checks \
  -F strict=false -f 'contexts[]=ci'
```

## Manual PRs — the escape hatch (`rmd review <n>`)

Only `rmd run-task` posts `remudero-review` in its flow. A **hand-opened PR**
(plan edits, docs, any change made outside the runner) therefore sits BLOCKED with
the required check absent — a required check with no poster is a permanent
deadlock. Unblock it with the escape hatch, which invokes the **same deterministic
`judgeReview`** — never a bypass, never a `--force`:

```sh
rmd review <pr-number>
```

It resolves the head sha + diff, finds the acceptance criteria (a `Remudero-Task:`
trailer → `plan/tasks.yaml`, else an `Acceptance:` block in the PR body), judges
the PR body against each criterion's proof, and posts the status. **Absent criteria
FAIL CLOSED** — nothing to judge is never a pass. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for the `Acceptance:` block format.

**W1-T185 (Gap 2)**: this escape hatch now MATERIALIZES a throwaway worktree at
the PR's head branch — `git fetch origin` + `git worktree add <path>
origin/<headRefName>` — reusing the exact pattern the automated fix rung's
sweep-dispatch path already uses (never new machinery), so whitelisted proofs
(`grep: …` / `unit test: …`) actually EXECUTE here, matching what `rmd run-task`
observes for the same PR/proofs. The worktree is torn down on EVERY exit path —
success, a judged failure, or `runReview` throwing — via `withMaterializedWorktree`,
never just the happy path (the W1-T175 leak class exists precisely because run
worktrees already strand on disk otherwise).

FALLBACK, and it is EXPLICIT: if materialization fails for any reason (network,
disk, a detached/deleted head), `materializeReviewWorktree` returns `undefined`
rather than throwing, and the review posts with NO `headCheckoutDir` — the
operator's own working checkout is never substituted for the PR head (HEAD
DISCIPLINE, W1-T65). `judgeReview` sets `keywordOnly: true` whenever no
PR-head checkout is given, which the posted commit-status summary, the
`review.posted` ledger line, and the console output all name explicitly
(`... (keyword-only: no proof was executed on the PR head)`) — a `rmd review`
verdict can never silently pass as though it had OBSERVED proof when it hadn't.

## Zero-executed proofs (CAPPED) — and the auto-merge arming path

**W1-T185 (Gap 1)** closes a gap the observed-proof execution engine
(W1-T65/W1-T72, "W1-T128") left open: a keyword floor can substantiate a
criterion purely from report prose, so a verdict could post
`remudero-review=success` having OBSERVED nothing at all (MASTER-PLAN rule 22
fixture (iii): a PASS at `proof_exec: 0/5`, directly beneath its own
`FLOOR DEGRADED` banner, satisfying 1 of 5 criteria with zero tests on a
`tdd: strict` task).

`judgeReview` now computes `capped` UNCONDITIONALLY — true whenever a review's
`proof_exec` set is entirely `not_executable`/`exec_error` across every
criterion that could have attempted execution (an Architect `satisfied_by`
override is excluded — it never attempts execution by design). A capped
`state: "success"` NEVER renders with `passSummary`'s "substantiated"/"no test
theater" wording; the posted summary reads `remudero-review: CAPPED — 0/N
proofs executed; not certified (a keyword match is a claim, not evidence)`.

**CAPPED IS NOT FAIL** — this is load-bearing, not a simplification. `capped`
never forces `state` to `"failure"`: mapping capped to failure would red every
PR the moment one proof is unparseable, halting the fleet, which is a worse
failure than the uncertified PASS it replaces (and it would punish authors for
a dialect gap rather than surfacing it). A capped verdict still posts as a
non-blocking `success` commit status, and a task that does not declare
`principles: {tdd: strict}` is completely unaffected either way.

What CAPPED *does* gate is a separate decision layer — **the auto-merge
arming path** (`decideAutoMergeArm`/`resolveAutoMergeArm`, `lib/review.ts`),
consulted by `rmd run-task`'s autonomous flow right before it would otherwise
call `armAutoMerge`. On a task whose `principles` are `{tdd: strict}`, a
capped verdict REFUSES to arm — the #411 shape (0/5 executed, posted as a
clean PASS, merged with no human reading the diff) can no longer happen
unattended. The run instead posts a `blocked` verdict and opens a `BLOCKED`
escalation naming two options: push executable proof, or grant an **explicit,
LEDGERED operator override** —

```sh
rmd review <pr-number> --override-capped-by <name> --override-capped-reason <text>
```

— which writes an `automerge.capped_override_granted` ledger line (an
override is a decision someone made, and it must be attributable) that
`decideAutoMergeArm` looks up on the next arm attempt. Using an override to
arm is itself ledgered (`automerge.capped_override_used`, naming who) — never
a silent bypass.

KNOWN RESIDUAL GAP: `sweep.ts`'s independent "checks green + review success →
mergeable" reconciliation does not yet consult `capped`/an override (out of
this task's stated file scope, `plan/tasks.yaml` W1-T185 `files:`) — a PR the
arming path refuses stays OPEN and UNARMED, but a later sweep poll could still
arm it via that separate path. Left for a follow-up task.

## Status provenance: closing the forge attack (W1-T203)

`gh` runs OUTSIDE the OS sandbox with the operator's own ambient credential
(recon R-3/R-6), and until this task that credential was the ONLY thing on the
machine that can post a commit status — so any identity that can shell out to
`gh` (including a worker, since `gh *` is excluded from the sandbox in
`settings/worker.json`) could post its own `remudero-review=success` and
satisfy its own merge gate. THREE PARTS close it, none of which touch merge
autonomy — no change here adds a human approval to the autonomous path:

1. **A dedicated reviewer identity.** `postReviewStatus` (`src/lib/review.ts`)
   authenticates as a fine-grained token/GitHub App named by
   `REMUDERO_REVIEWER_TOKEN` (passed as `GH_TOKEN` for that one `gh` call)
   when the env var is set, instead of whatever `gh` auth the operator/workers
   share. The credential itself never reaches a worker: it lives only in the
   orchestrator's own process env (or `~/.config/remudero/`, already denied to
   every worker in `settings/worker.json`'s `filesystem.denyRead` /
   `permissions.deny`).
2. **The deny-floor blocks worker status-POSTs.** `hooks/deny-floor.sh` refuses
   any `gh api ... -X POST/--method POST .../statuses/...` call from a spawned
   worker (any role — implementer, the advisory fresh-context reviewer,
   anything else `settings/worker.json`'s PreToolUse hook covers). The
   orchestrator's own `postReviewStatus` call never reaches this hook at all —
   it's a plain `execFileSync` from the `rmd run-task` process, never a Claude
   Code tool call. See `test/deny-floor.test.ts`.
3. **Provenance is checked AT ARM TIME.** `armAutoMerge` (`src/run-task.ts`)
   re-fetches the LIVE `remudero-review` status right before arming and
   verifies GitHub attributes it (`creator.login` on the commit-status API —
   the one field a poster cannot spoof) to the identity named by
   `REMUDERO_REVIEWER_LOGIN`. `resolveReviewProvenance`/
   `decideAutoMergeArmAtSha` (`src/lib/review.ts`) implement the rule: a
   status from anyone else is **ABSENT, never a failure** — a hostile or buggy
   poster's `failure` is exactly as inert as its `success` would be, so it can
   forge neither a pass nor a denial-of-service block. See
   `test/review-status-provenance.test.ts`.

**BOOTSTRAP ORDERING, same doctrine as `ci-gate` above:** both `REMUDERO_REVIEWER_TOKEN`
and `REMUDERO_REVIEWER_LOGIN` ship unset. Until an operator provisions the
dedicated identity and sets both, `postReviewStatus` falls back to ambient
`gh` auth and `armAutoMerge` skips the provenance re-check entirely — byte
for byte the pre-W1-T203 behavior. Arming the check before the identity
exists would deadlock every merge, the same failure this doc's `ci-gate`
section already guards against.

## Live falsification (proven, not asserted)

- A legitimate PR whose REPORT substantiates its criteria → `remudero-review=success`.
- A CI-GREEN PR that IGNORES a stated acceptance criterion → `remudero-review=failure`,
  the PR stays OPEN and does not merge.
- Under the armed gate, a PR with `remudero-review=failure` reports
  `mergeStateStatus = BLOCKED`.

The pasted `gh api` outputs for each of these live in the W1-T1D PR that wired the
gate; the verdict logic itself is covered by the `test/review.test.ts` falsifiers
(non-responsive report, test theater, empty criteria, semantic downgrade, and —
W1-T58, Standing rule 15 — a non-plan-only diff that edits `plan/tasks.yaml`'s
own acceptance criteria: `ReviewVerdict.criteriaTampered` forces
`remudero-review=failure` exactly like test theater does, and the `blocked_review`
FIX RUNG (`runFixRung`, run-task.ts) refuses to dispatch an ordinary fix worker
against it — it escalates immediately instead, since a worker cannot legitimately
"fix" its own criteria).

## Coverage measurement re-based under `--enable-source-maps` (2026-07-22, W1-T210 round 2)

The coverage run (`ci.yml`, coverage-ratchet job) now passes `--enable-source-maps`, so V8
coverage positions translate to real `.ts` source lines instead of tsx-compiled output
positions. Two consequences, both deliberate:

- **`scripts/coverage-baseline.json` was re-captured** under the new instrument (lines 89.64 →
  82.75, branches 87.61 → 88.55 — set just under the CI/local measurement pair, 83.31/82.83 and
  88.65/88.61, so a cross-environment delta never reads as a regression). This is a re-basing, not a regression: the same suite on the
  same tree, measured against correctly-mapped lines — the old lines figure was over-counted by
  mis-attribution. The never-lower-to-pass rule still stands against the NEW numbers.
- **`scripts/diff-coverage.mjs` recognises non-executable added lines from the diff text**
  (blank / `//` / block-comment furniture) rather than from DA-record absence: under the flag,
  the compiled module preamble maps `DA:<line>,0` records onto a new file's leading doc
  comment, which used to false-block any new file that opens with one. A genuinely uncovered
  added *code* line still blocks (fixture-proven in `test/diff-coverage.test.ts`).

### coverage-ratchet: out-of-repo temp-dir records excluded (2026-07-23, W1-T220)

`scripts/coverage-ratchet.mjs`'s `parseLcovTotals` now counts a coverage record only
when its `SF:` path lives inside the repo checkout; a path that starts with `../` or is
absolute is dropped (and the excluded count is printed). Several tests `mkdtemp` a dir,
copy a repo script into it, and spawn node — and because `NODE_V8_COVERAGE` is inherited
by children, those low-coverage temp copies merged into the aggregate lcov under
randomized `/private/var/folders/.../T/rmd-*` paths, whose per-run count jittered the
aggregate branch percentage by a few hundredths of a point and false-blocked test-only /
plan-only PRs (#614/#622/#632). Only the repo's own `src/**` gates now; the per-diff
`diff-coverage` check still polices newly-added source lines. Falsifier: the
`temp-dir-polluted.lcov` fixture blocks pre-filter and accepts post-filter.

### diff-coverage round 3 (2026-07-23): FNDA-aware declaration lines + closer furniture

Two more source-map artifact classes recognised (instrument-only change, own PR):
a function **declaration line** whose lcov `FNDA` count shows the function was entered is
covered regardless of its `DA:0` (observed: `FN:62`/`FNDA:11` beside `DA:62,0`); and a
**closer-only punctuation line** (`};`, `})`) is non-executable furniture. An unentered
function (`FNDA:0`) still blocks on its body — the carve-outs rescue artifacts, never dead code.
