# credit-surface-gate.mjs comment forensics

The measured incidents, design arguments and rejected alternatives that were removed from
`scripts/credit-surface-gate.mjs` when its comments were compacted to the plain-language standard
(docs/comment-standard.md). Nothing was cut: each section below is the file's own prose, verbatim,
under a heading naming the symbol it explained. The file itself keeps a one-line `// Why:` pointer
wherever the history mattered.

Line numbers below are positions in `scripts/credit-surface-gate.mjs` at the merge base of the
compaction PR (`origin/main` at e3d5b64eaf7e7ec98fc0aef5789946b0c5cd08dd).

## The file header

Removed from lines 2-46.

```
// scripts/credit-surface-gate.mjs
//
// AUTHOR-TIME CREDIT-SURFACE GATE (W1-T1214).
//
// W1-T1012 (#2240) fixed the harness's OWN commits: `appendTaskTrailerToCommit` (src/run-task.ts)
// amends the `Remudero-Task: <id>` trailer onto the tip of a run the harness itself pushes. But
// that function is called at exactly two sites — the implement lane and the retro lane — both
// INSIDE the harness run loop. A branch pushed BY HAND from an operator lane's scratch worktree
// never enters that loop, so its commit is never amended, and a descriptive branch name (`fix/…`,
// `retro/…`, `ci/…`) carries no `run-<taskId>-<epochMs>` head-ref credit either. Measured in the
// task shard this script implements: since W1-T1012 merged, eight of eighty implementation-shaped
// merges to `origin/main` landed credited on NEITHER surface. Nothing anywhere refused them.
//
// THE DELIVERABLE IS THE REFUSAL, NOT THE APPEND (design (i)). Whichever seam is eventually
// chosen for WRITING the trailer onto a hand-pushed branch (push-time amend vs. merge-time
// compose — deliberately left open, see the task shard's rationale (7)/design (v)), a pull
// request whose merge would land credited on neither surface can be refused TODAY, and doing so
// does not pre-empt that seam choice.
//
// THE PREDICATE IS A DISJUNCTION OVER TWO EXISTING RULES, NEVER A THIRD ONE (design (ii)/(iv)):
// either the head commit carries an anchored `^Remudero-Task: <id>$` trailer, or the head ref
// matches the fleet's own dispatched-run shape (`run-<taskId>-<epochMs>`). Either alone is enough,
// because either alone is already enough for the READERS (`findMergedByTrailer`,
// `findMergedByHeadBranch`/`ownsBranch`) — this file adds no new credit vocabulary and does not
// touch either reader. `isDispatchedRunBranch` is imported straight out of `src/run-task.ts`
// rather than re-spelled, so the "is this a run branch" shape has exactly one home.
//
// IT MUST NOT FIRE ON A FILING (design (iii)). A plan/docs/feedback/triage pull request carries no
// trailer BY RULE (W1-T1004) — refusing one for lacking a trailer would be the exact false-credit
// defect W1-T1004 exists to prevent. `LINT_FILING_SUBJECT_RE` (src/run-task.ts,
// `classifyFailingMergeEvidence`'s own classifier) is imported and applied to the head commit's
// SUBJECT before either credit limb is even asked, so a filing is exempt independent of whether it
// happens to carry a trailer or sit on a run-shaped branch.
//
// OUT OF SCOPE, ON PURPOSE (design (v)): which seam appends the trailer to a hand-pushed branch;
// W1-T1012's harness append; W1-T1004's filing rule; back-crediting the eight already-merged
// uncredited commits; wiring this script into a CI workflow step (a separate PR, same pattern
// `scripts/acceptance-author-gate.mjs`/the coverage-ratchet producer already follow — this
// producer's diff stays free of any `.github/workflows/*.yml` edit).
//
// Usage (CI, once wired): node --import tsx scripts/credit-surface-gate.mjs --head-ref <ref>
//   (falls back to $GITHUB_HEAD_REF, which GitHub Actions sets automatically for a
//   `pull_request`-triggered job — no extra API call) with the worktree checked out at the PR's
//   actual head sha, so `git log -1 --format=%B` reads the real head commit message.
// Usage (local/test): node --import tsx scripts/credit-surface-gate.mjs --head-ref <ref> --worktree-path <path>
```

WHY THIS MATTERS. This gate exists because a correct fix (W1-T1012) covered only the harness's own
two call sites; measured over the task shard this script implements, eight of eighty
implementation-shaped merges since W1-T1012 landed credited on neither surface, and nothing
anywhere refused them. The design notes above record three decisions that still bind the code: the
gate refuses a bad merge today without pre-empting which seam eventually writes the trailer onto a
hand-pushed branch (design (i)); it is a disjunction over the two surfaces the readers
(`findMergedByTrailer`, `findMergedByHeadBranch`) already trust, adding no third rule (design
(ii)/(iv)); and it exempts a filing-shaped subject outright, because a filing carries no trailer by
rule (W1-T1004) and refusing one for that would recreate the false-credit defect W1-T1004 fixed
(design (iii)). Wiring this script into CI is deliberately out of scope of the task that wrote it
(design (v)) — see `scripts/unwired-gate-check.mjs`'s own `ALLOWANCE` entry for why it still ships
unwired today (W1-T2735, and the near-miss on PR #3704 that W1-T2732's rationale records).

## CREDIT_TRAILER_RE

Removed from lines 57-64 (the constant declaration on the following line was kept).

```
 * The SAME anchored `Remudero-Task: <id>` line shape `appendTaskTrailerToCommit`/
 * `creditsByAnchoredTrailer` (src/run-task.ts, src/lib/status.ts) already construct per-call via
 * `new RegExp(\`^Remudero-Task:\\s*${escapeRegExp(taskId)}\\s*$\`, "m")` — this gate has no
 * expected task id to anchor against (it asks "is THIS commit credited on SOME id", not "credited
 * for taskId X"), so it mirrors the same anchor and id character class as src/lib/status.ts's own
 * (unexported) `TRAILER_RE` rather than inventing a looser or stricter one.
```

## isFilingShapedSubject

Removed from lines 67-72 (`@param` line kept).

```
/**
 * Is `subject` (a commit's first line) a filing-family subject — citing a task rather than
 * implementing it? Thin wrapper over the imported {@link LINT_FILING_SUBJECT_RE} so callers never
 * need to know it is a regex, matching {@link isDispatchedRunBranch}'s own already-a-function shape.
 */
```

## evaluateCreditSurfaceGate

Removed from lines 85-96 (`@param` line kept).

```
/**
 * THE GATE'S OWN PREDICATE (design (ii)/(iii)): classify the head commit's subject first — a
 * filing is exempt outright, independent of either credit limb — then ask the disjunction. Pure
 * over its inputs; never reads git/env itself (see {@link main}/{@link readHeadCommitMessage} for
 * the impure edges), so this is trivially unit-testable with fixture strings.
 *
 * Returns `{ ok: true, message }` when either credit limb (or the filing exemption) is satisfied,
 * `{ ok: false, defect: "uncredited-merge", message }` otherwise — the message NAMES BOTH ways to
 * satisfy it (design (i): "a message naming both ways to satisfy it"), never only the one the
 * caller happens to be closer to.
 */
```

## readHeadCommitMessage

Removed from lines 133-138 (`@param` line kept).

```
/**
 * The worktree's actual HEAD commit message, read fresh from git — never re-derived, so a caller
 * cannot drift from what will actually be squash-merged. Best-effort: returns `undefined` on any
 * git failure rather than throwing, matching {@link "../src/run-task.js".lastCommitSubject}'s own
 * contract at the analogous call site.
 */
```

## resolveHeadRef

Removed from lines 148-155 (`@param` lines kept).

```
/**
 * Resolve the PR's head ref from the flag, falling back to `$GITHUB_HEAD_REF` — the env var GitHub
 * Actions sets automatically on a `pull_request`-triggered job, so this costs no event-payload
 * parse and no API call (the same "no extra call" property `scripts/acceptance-author-gate.mjs`'s
 * own doc insists on for its own inputs).
 *
 * EXTRACTED AND PURE so its refusal arm is reachable from a test, the same
 * extraction-and-injection shape `scripts/acceptance-author-gate.mjs`'s `resolveEventPath` uses.
 */
```
