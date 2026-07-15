# Review-enforced merge gate (W1-T1C + W1-T1D + W1-T24)

`remudero-review` is a **REQUIRED status check** on `main`, alongside `ci`. GitHub
merges a PR only when BOTH are green. This document describes the gate as it is
**wired and running** — not an aspiration.

★ **`ci-gate` (W1-T24)** now exists as a workflow
(`.github/workflows/ci-gate.yml`) but is **not yet** a required context — see
[CI-gate aggregator](#ci-gate-aggregator-w1-t24) below for why the flip to
`main`'s required contexts is a separate, admin-run step.

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
required_status_checks.contexts = ["ci", "remudero-review"]
```

**This is the CURRENT state.** W1-T24 lands `ci-gate` as a workflow so it can run
and be live-proven on real PRs (a real failing sub-check holds it red; a
deliberately-skipped sub-job does not deadlock it) **before** it becomes a
required context — see [CI-gate aggregator](#ci-gate-aggregator-w1-t24). Once
that live proof exists, the target state is:

```
required_status_checks.contexts = ["ci-gate", "remudero-review"]
```

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

**The branch-protection flip is intentionally NOT part of the PR that adds this
workflow.** Per the same bootstrap-ordering discipline as `remudero-review`
below: land the aggregator, prove it live (a real red sub-check holds it red; a
skipped sub-job does not deadlock it), and only then repoint
`required_status_checks.contexts` — an admin `gh api` PATCH that is Craig's to
run:

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

## Live falsification (proven, not asserted)

- A legitimate PR whose REPORT substantiates its criteria → `remudero-review=success`.
- A CI-GREEN PR that IGNORES a stated acceptance criterion → `remudero-review=failure`,
  the PR stays OPEN and does not merge.
- Under the armed gate, a PR with `remudero-review=failure` reports
  `mergeStateStatus = BLOCKED`.

The pasted `gh api` outputs for each of these live in the W1-T1D PR that wired the
gate; the verdict logic itself is covered by the `test/review.test.ts` falsifiers
(non-responsive report, test theater, empty criteria, semantic downgrade).
