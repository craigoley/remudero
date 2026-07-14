# Review-enforced merge gate (W1-T1C + W1-T1D)

`remudero-review` is a **REQUIRED status check** on `main`, alongside `ci`. GitHub
merges a PR only when BOTH are green. This document describes the gate as it is
**wired and running** — not an aspiration.

## What each check proves

- **`ci`** (W1-T1B) — the code typechecks and its tests pass. Standing rule 4:
  green checks are **not** evidence that the task's ACCEPTANCE CRITERIA were met.
- **`remudero-review`** (W1-T1C reviewer, W1-T1D gate) — a verdict on whether the
  PR's REPORT substantiates each of the task's acceptance criteria against its
  stated proof.

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
contexts with the same `PATCH` endpoint down to `["ci"]`.

## Live falsification (proven, not asserted)

- A legitimate PR whose REPORT substantiates its criteria → `remudero-review=success`.
- A CI-GREEN PR that IGNORES a stated acceptance criterion → `remudero-review=failure`,
  the PR stays OPEN and does not merge.
- Under the armed gate, a PR with `remudero-review=failure` reports
  `mergeStateStatus = BLOCKED`.

The pasted `gh api` outputs for each of these live in the W1-T1D PR that wired the
gate; the verdict logic itself is covered by the `test/review.test.ts` falsifiers
(non-responsive report, test theater, empty criteria, semantic downgrade).
