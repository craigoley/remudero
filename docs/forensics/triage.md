# Forensics: src/lib/triage.ts

Every measured fact, incident and design argument the comments in `src/lib/triage.ts` used to
carry, archived VERBATIM when that file's comments were compacted to the plain-language standard
(`docs/comment-standard.md`).

Nothing here is a rule. `triage.ts`'s behaviour lives in the code and its tests, and each block
below is quoted exactly as it stood on `origin/main` at `c185258e295d83d32371612edc2c39bde5d0fd4e`,
under a heading naming the symbol it explained. The code keeps a one-line `// Why:` pointer
wherever that history still matters.

---

## Module header

`src/lib/triage.ts:11-80` at `c185258e`, 70 comment lines.

```
/**
 * `rmd triage` — the Architect intake worker (MASTER-PLAN §7B, W1-T41).
 *
 * "An Architect worker over a feedback entry. Tools: Read/Glob/Grep/WebSearch/WebFetch + Write
 * scoped to plan files ONLY (never src/). Grounds against plan/learnings/ledger/DECISIONS,
 * researches via server-side WebSearch, then (if clear) opens a plan PR naming the §sections
 * changed, tasks added/rewired, rationale, and provenance back to feedback#<id>." [MASTER-PLAN §7B]
 *
 * ★ TRIAGE MUST RUN STRICTLY SERIALLY — WITH ITSELF AND WITH ANY HAND-RUN. READ THIS BEFORE
 * ADDING A CALLER (a daemon rung, a cron, a second lane).
 *
 * The task id is minted by the HARNESS from a snapshot BEFORE the worker starts (see the ID
 * SELECTION block in `triagePrompt` below). Two runs that start before either opens its PR
 * therefore mint the SAME id. Because each writes its own `plan/tasks.d/<id>-<slug>.yaml` and the
 * slugs differ, the two branches touch DIFFERENT FILES — so git merges both cleanly and `loadPlan`
 * (lib/plan.ts) then throws duplicate-task-id ON MAIN, breaking every plan-loading check for
 * everyone.
 *
 * This is WORSE than it was before proposals were sharded. When both runs appended to the
 * `plan/tasks.yaml` monolith they collided textually at EOF: ugly, but LOUD, PRE-MERGE and
 * unmergeable. Sharding traded a conflict you cannot merge for a merge that poisons the plan.
 * That trade is only safe while something serialises triage.
 *
 * What serialises it TODAY — CORRECTED, this paragraph was stale and said "nothing explicit":
 *   (1) The daemon's poll loop is single-threaded and awaits each dispatch, so daemon-initiated
 *       runs cannot overlap each other.
 *   (2) PR #1069 added a SHARED lock across triage's two paths: `triageCommand` (run-task.ts)
 *       acquires it before doing anything and refuses loudly if held, and `decideAutoTriage`
 *       (lib/auto-triage.ts) refuses on `lockHeld`. The hand-run-versus-daemon race the previous
 *       wording described as open has been closed since 2026-08-01.
 *   (3) The minted id is now RESERVED atomically (lib/task-id-reservation.ts's
 *       `reserveTaskIdFrom`, one `O_EXCL` file per id under `<root>/state/task-id-reservations/`)
 *       BEFORE the worker spawns. That is the "atomic claim at mint time" this comment used to ask
 *       for, and it covers a caller the LOCK cannot: the lock is triage-specific, so it never
 *       excluded `rmd plan --mode=create`, a second machine, or a cross-repo instance filing into
 *       this plan. Contention ADVANCES the id rather than refusing, so no caller waits.
 *
 * `assertProposedPlanLoads` remains the pre-push backstop (it re-loads monolith + shards from the
 * worker's own worktree, so a collision against MAIN is refused before anything is pushed).
 *
 * STILL NOT COVERED, and the reason this comment stays long: `rmd plan --mode=create` does not
 * call the mint AT ALL — `planArchitectPrompt` receives no minted id, so its worker picks one by
 * reading the plan files. Nothing reserves what was never minted. Routing that lane through the
 * mint is the remaining work.
 *
 * THE THREE-WAY VERDICT, deterministic (mirroring lib/dep-review.ts's `decideDepReview` — the
 * judge is CODE, the LLM layer is advisory only, Standing rule 2):
 *   - ALREADY_DECIDED — the ground step found the feedback's answer already settled somewhere in
 *     plan/learnings/DECISIONS. No plan files change. NO redundant task is created — the whole
 *     point of grounding (re-deciding a settled question is a failure mode, not a feature).
 *   - AMBIGUOUS        — the item needs a human's judgment call. No plan files change. Status
 *     parks at `grilling`, and the harness (run-task.ts's `triageCommand`) opens a `needs-human`
 *     GitHub issue reusing §4's escalation machinery (W1-T42) — the ONLY viable grill mechanism.
 *     ★ VERIFIED (LEARNINGS.md "AskUserQuestion neither works headlessly nor stalls"):
 *     AskUserQuestion silently auto-resolves EMPTY with no TTY (~37ms, no error, nothing
 *     collected) rather than hanging, and this worker always runs via spawnWorker — a subprocess
 *     with no TTY BY CONSTRUCTION, regardless of the invoking shell — so the interactive branch
 *     MASTER-PLAN §7B names is structurally unreachable here; `.remudero/skills/feedback.yaml`
 *     no longer lists `AskUserQuestion` in its tools. Because the async issue is the only path,
 *     the AMBIGUOUS verdict below must always carry actionable OPTION:/RECOMMENDATION: lines —
 *     `escalate()` refuses a bare-alert issue with no options.
 *   - PROPOSED         — a plan-only PR naming the §sections/tasks changed, with `origin:
 *     feedback#<id>` provenance on every new/rewired task.
 *
 * THE WORKER NEVER RUNS GIT (`.remudero/skills/feedback.yaml`'s `tools:` carries no `Bash`, unlike
 * `retro.yaml`) — it only GROUNDS/RESEARCHES/EDITS plan files via Read/Grep/Glob/WebSearch/Write.
 * The commit/push/PR-open/gate sequence is HARNESS-OWNED (run-task.ts's `triageCommand`),
 * deterministic, and identical in shape for all three verdicts — the same "the harness eats
 * first" discipline `regenerateOrientation` already established for the retro's docs write.
 */
```

## missingFeedbackMessage

`src/lib/triage.ts:113-123` at `c185258e`, 11 comment lines.

```
/**
 * Build `rmd triage`'s exit-2 message when `feedbackId` is absent from the fresh
 * `origin/main` worktree it reads from. Before W1-T243 this printed the byte-identical
 * "no such feedback entry: <id>" whether the id was a genuine typo OR simply not yet
 * landed by the durable-inbox commit bridge (feedback-landing.ts) — indistinguishable and
 * misleading, since a captured entry can sit locally for a while before its landing PR
 * merges. Pure (no I/O) so the two branches are unit-testable without spawning `gh`;
 * `triageCommand` (run-task.ts) supplies `existsLocally` (a plain `existsSync` check
 * against `repoRoot`) and `landingPrUrl` (best-effort, via
 * {@link "./feedback-landing.js".findPendingLandingPr}).
 */
```

## triagePrompt

`src/lib/triage.ts:140-160` at `c185258e`, 21 comment lines. (Originally sat above `feedbackEntryBlock`,
one function above where `triagePrompt` itself is declared — an orphaned doc comment of the same
shape `docs/comment-standard.md`'s `ledger.ts` example describes. Moved to sit directly above
`triagePrompt` when compacted; no code changed.)

```
/**
 * The triage Architect prompt — fed one feedback entry, told to GROUND -> RESEARCH ->
 * GRILL-OR-PROPOSE, and required to end with exactly one of the three verdict markers this
 * module's {@link parseTriageVerdict} anchors on. The worker has NO Bash/git — it only edits
 * files; the caller (run-task.ts) owns commit/push/PR.
 *
 * `mintedId` (W1-T263): the id the HARNESS derived — the worker has no Bash tool, so the
 * old "run this grep and pick the next integer" instruction was an instruction it could not
 * execute, leaving id selection to eyeballing the files it happened to read. When present,
 * the prompt HANDS the id over instead of describing how to compute one.
 *
 * `additionalReservedIds` (W1-T949 design (ii)): the REST of a reserved block, beyond
 * `mintedId` itself — the harness now reserves a block up front (`reserveTaskIdBlock` +
 * `reserveTaskIdBlockRemote`) exactly as `rmd plan` already does, so a multi-task filing has
 * every id it might use ALREADY held on the shared remote, not merely `mintedId`. As long as
 * this prompt told the worker to "number them upward" instead of naming the reserved set, a
 * reserved block and a filed set could diverge by construction — the harness could hold five
 * ids while the worker invented a sixth. Defaults to empty so every existing caller that passes
 * only `mintedId` (a single reservation, or none at all) is BYTE-IDENTICAL to before this
 * parameter existed; only a caller that actually reserved more states the fuller instruction.
 */
```

## parseGrillOptions

`src/lib/triage.ts:293-305` at `c185258e`, 13 comment lines.

```
/**
 * `OPTION: <label>|<detail>` lines anywhere in the worker's output — the grill's actionable
 * choices (escalate.ts's `EscalationOption[]` shape), mirroring `rmd escalate --option`'s CLI
 * parsing (run-task.ts's `parseOptionFlags`). Only meaningful when the verdict resolves to
 * AMBIGUOUS (decideTriage validates count/shape there); harmless if unused otherwise.
 *
 * W1-T2205: IDEMPOTENT on the `(label, detail)` pair — belt AND braces alongside
 * {@link "./worker.js".workerTranscript}'s join fix, because not every duplicate-OPTION source
 * is transcript-shaped (a model restating its own choices, or quoting the prompt's own OPTION
 * examples back, doubles a line with no join involved). Order is preserved and the FIRST
 * occurrence of a pair wins; a genuinely single choice repeated verbatim still collapses to one
 * option, so {@link decideTriage}'s `< 2` guard still fires for it exactly as it must.
 */
```

## THE THIRD STATE

`src/lib/triage.ts:366-374` at `c185258e`, 9 comment lines.

```
// ── THE THIRD STATE (W1-T2212), AS A TYPE ────────────────────────────────────
//
// `parseTriageVerdict` already refused to fabricate a verdict on unparseable output (`null`,
// never a fake `TriageVerdict`) — the defect this task removes was one layer down, in
// `decideTriage`, which folded that `null` into `action: "error"`, the SAME action a worker that
// physically misbehaved (touched a non-plan file) also produces. `TriageOutcome` below is the
// discriminated union that makes "unparseable" a state distinct from "produced a verdict" BEFORE
// either ever reaches `decideTriage` — {@link runTriageWithRetry}'s retry branch (design (i)) is
// reachable ONLY from `kind: "unparseable"`, never from `kind: "verdict"` (adverse or not).
```

## TriageDecision, error.cause

`src/lib/triage.ts:419-437` at `c185258e`, 19 comment lines.

```
      /**
       * THE CAUSE AS DATA, NOT PROSE ALONE (W1-T2212 acceptance criterion 7): three shapes share
       * `action: "error"` for the sole reason that none may ever produce a plan PR, but they are
       * NOT the same failure. `non_plan_files` is a worker that physically misbehaved.
       * `unparseable_verdict` is a worker whose output {@link runTriageWithRetry} could not read
       * after exhausting its bounded retries (never retried further past that bound — the SAME
       * escalation fires as before, design (iii)). `inconsistent_verdict` is a worker that DID
       * answer parseably but contradicted itself against the files it touched (or, for AMBIGUOUS,
       * against its own OPTION/RECOMMENDATION contract). A reader (or a future caller) can now
       * branch on this field instead of pattern-matching `reason`'s prose.
       *
       * OPTIONAL, not required on every `error`: the AMBIGUOUS-with-fewer-than-2-OPTION-lines
       * branch below deliberately omits it — main's pre-existing
       * `decideTriage: a verdict genuinely offering ONE choice twice ... still fails the < 2
       * guard` test (test/triage.test.ts, outside this task's declared scope) asserts that
       * exact shape with `assert.deepEqual`, which fails closed on any extra key. Widening
       * `cause` to that branch too is a genuine follow-up, not a regression — see this PR's
       * Follow-ups.
       */
      cause?: "non_plan_files" | "unparseable_verdict" | "inconsistent_verdict";
```

## decideTriage — MASTER-PLAN.md guard

`src/lib/triage.ts:448-454` at `c185258e`, 7 comment lines.

```
  // MASTER-PLAN.md is a plan file BY THE PROMPT'S OWN CONTRACT (the PROPOSED
  // instruction above names "plan/tasks.yaml and/or MASTER-PLAN.md") but lives
  // at the repo root, so a bare `plan/`-prefix filter classified it non-plan
  // and fail-closed every proposal that touched it — first reachable 2026-07-22
  // once #550 let the worker actually edit (feedback 728bc1: "triage worker
  // touched non-plan file(s): MASTER-PLAN.md; leaving no PR"). The guard and
  // the prompt must agree on what "plan file" means.
```

## decideTriage — third state's terminal shape

`src/lib/triage.ts:464-470` at `c185258e`, 7 comment lines.

```
    // THE THIRD STATE'S TERMINAL SHAPE (W1-T2212): reached either directly (a caller with no
    // retry loop, `attempts` undefined — the message stays BYTE-IDENTICAL to before this field
    // existed) or via runTriageWithRetry once its bound is exhausted (`attempts` present) — "at
    // the bound the SAME escalation fires as today, with the same class and the same blocking
    // effect" (design iii). `cause: "unparseable_verdict"` distinguishes this from a worker that
    // physically misbehaved (`non_plan_files`, above) as DATA (acceptance criterion 7), never
    // only as prose a reader has to pattern-match.
```

## decideTriage — ambiguous grill guard

`src/lib/triage.ts:500-504` at `c185258e`, 5 comment lines.

```
    // The async needs-human issue is the ONLY grill mechanism (W1-T42, LEARNINGS.md
    // "AskUserQuestion neither works headlessly nor stalls") — an AMBIGUOUS verdict with fewer
    // than 2 OPTION: lines, or a RECOMMENDATION: that doesn't name one of them, is not an
    // actionable escalation; fail loud rather than let escalate() throw deeper in the pipeline
    // (or worse, silently drop the recommendation).
```

## The bounded retry (banner + TRIAGE_VERDICT_MAX_ATTEMPTS)

`src/lib/triage.ts:534-549` at `c185258e`, 15 comment lines.

```
// ── W1-T2212: THE BOUNDED, BYTE-IDENTICAL RETRY (design ii/iii) ──────────────────────────────
//
// "The retry RE-REQUESTS, it never RE-ASKS." `runTriageWithRetry` calls `deps.spawnAttempt` with
// the SAME `prompt` value on every attempt — nothing about the request may vary between them.
// This is deliberately NOT the relint loop (run-task.ts's `runRelintLoop`, which re-prompts the
// worker WITH the prior round's violations folded in — a genuine RE-ASK): that loop exists to
// correct a worker's PLAN LINT violations, a completely different failure mode from "the worker's
// output could not be parsed at all". Reusing it here would smuggle a re-ask in under a retry's
// name — exactly the laundering hazard design (v) warns splitting this task in two would risk.

/** BACKSTOP (W1-T1266): the healthy path — a PARSED verdict, adverse or not — returns on attempt
 *  1, always; this bound fires only once something else has already failed (the worker
 *  repeatedly producing unparseable output), never as the thing that normally stops the loop.
 *  The small, hard bound on unparseable-response retries — mirrors risk-judge.ts's
 *  `RISK_JUDGE_MAX_ATTEMPTS` exactly (design v: the retry contract must be IDENTICAL in both
 *  rungs). Never applies to a PARSED verdict, adverse or not. */
export const TRIAGE_VERDICT_MAX_ATTEMPTS = 3;
```

## runTriageWithRetry (and TriageRetryDeps)

`src/lib/triage.ts:562-587` at `c185258e`, comment portions totalling 13 lines.

```
export interface TriageRetryDeps {
  /** Spawn ONE triage attempt with the given prompt and return its raw result. Called with the
   *  IDENTICAL `prompt` value on every attempt — see this section's own doc above. */
  spawnAttempt: (prompt: string) => Promise<TriageAttemptResult>;
  /** One ledger-shaped line per attempt (design iii: "each attempt writes its own ledger row so
   *  the count is auditable after the fact rather than inferred"). No-op default. */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

/**
 * Spawn up to `maxAttempts` triage attempts with the SAME `prompt`, retrying ONLY while
 * {@link classifyTriageOutcome} reports `unparseable` (design i: the retry branch is reachable
 * ONLY from that arm — never from a parsed verdict, adverse or not, which returns on its very
 * first attempt). At the bound, falls through to {@link decideTriage} with `verdict: null` —
 * the SAME `action: "error"`/`cause: "unparseable_verdict"` outcome a single unparseable
 * response has always produced (design iii: "the SAME escalation fires as today"). An unreadable
 * verdict therefore still blocks and nothing proceeds on it at any point in this loop.
 */
```

## assertProposedPlanLoads

`src/lib/triage.ts:615-624` at `c185258e`, 9 comment lines.

```
/**
 * ID-COLLISION GUARD (the 2026-07-22 W1-T236 triple-mint): the triage worker picks new task ids
 * by reading plan/tasks.yaml, which misses the plan/tasks.d/ shards (W1-T122) — three PRs in one
 * batch each minted W1-T236 while plan/tasks.d/W1-T236-*.yaml already owned it on main, and every
 * plan-loading CI check went red AFTER the PR opened. Load the FULL merged plan (monolith +
 * shards) from the worker's own worktree BEFORE anything is pushed: `loadPlan` throws PlanError
 * naming the duplicate, so a doomed proposal is refused pre-push with the collision named instead
 * of opening a PR that every plan-loading check rejects. (A collision between two OPEN PRs'
 * fragments is still possible — that needs id reservation, tracked separately in feedback.)
 */
```

## nonPlanFilesInDiff / the empty-diff-triage-merge incident

`src/lib/triage.ts:631-660` at `c185258e`, comment portions totalling 19 lines.

```
/**
 * Files OUTSIDE `plan/` touched by a unified diff. A triage PR is PLAN-ONLY by construction
 * (`.remudero/skills/feedback.yaml`'s Write-scoped-to-plan design) — this is the same deterministic
 * fail-closed guard `lib/retro.ts`'s `codeFilesInDiff` gives the retro, generalized from
 * "never src/test/" to "never outside plan/" (a triage may legitimately touch MASTER-PLAN.md,
 * which a retro's narrower guard already covers, plus plan/tasks.yaml and plan/feedback/*).
 */
export function nonPlanFilesInDiff(diff: string): string[] {
  // Same "plan file" definition as decideTriage's guard above: this function's
  // own doc already said "a triage may legitimately touch MASTER-PLAN.md" while
  // the filter contradicted it (the 728bc1 fail-close, 2026-07-22).

/** Whether a diff carries the `feedback#<id>` provenance token the PROPOSED contract requires. */

// ── W1-T963: the empty-diff-triage-merge incident (#2075/#2077/#2078) ───────────────────────────
//
// Three triage PRs for the SAME feedback entry merged and PASSED REVIEW despite changing nothing:
// `gh pr diff`/`nonPlanFilesInDiff` above compare a triage branch against its OWN (frozen,
// fork-point) merge-base, so they stay non-empty even once a SIBLING triage PR for the identical
// entry has already landed the SAME change on `origin/main` — the branch's own history never
// shows that, only a diff against the LIVE default branch tip does. See `diffEmptyAgainstScope`'s
// own doc (lib/review.js) for the structural check; this is the triage-specific SCOPE + DISPOSITION
// wired around it.
```

## triageDeclaredScope / TriageEmptyScopeDisposition / triageEmptyScopeDisposition

`src/lib/triage.ts:662-687` at `c185258e`, comment portions totalling 16 lines.

```
/**
 * The declared SCOPE of a `no_task`/`grill` triage decision — the ONE path its entire
 * contribution is: the feedback entry's own status flip. Deliberately NOT used for `propose`
 * (its contribution also includes a NEW plan/tasks.d/ shard, so an empty diff against this
 * narrower scope would never discriminate a genuinely-new proposal from a duplicate one).
 */

/** The terminal outcome a triage merge gate takes once it knows whether the LIVE diff against
 *  {@link triageDeclaredScope} is empty — CLOSE (never merge; design (v): a refusal that leaves
 *  the PR open forever is not the outcome either), or PROCEED to the ordinary review/arm gate. */
export interface TriageEmptyScopeDisposition {
  action: "close" | "proceed";
  /** Present only for `action: "close"` — the `gh pr close --comment` text naming WHY. */
  comment?: string;
}

/**
 * Decide whether to CLOSE this triage PR (its declared scope is empty against the LIVE default
 * branch — a sibling already did the work) or let it PROCEED to the ordinary review/arm gate.
 * Pure: `liveDiffFiles` is the caller's OWN fresh `git diff --name-only origin/main HEAD -- <scope>`
 * read (never this function's concern — a live git read cannot be pure), so this is trivially
 * testable without spawning git at all.
 */
```

## Commit-body line budget

`src/lib/triage.ts:705-713` at `c185258e`, 9 comment lines.

```
// ── Commit-BODY line budget (the 2026-07-22 triage-lane commitlint outage) ──────────────────
// `shapeCommitMessage` protects the HEADER (W1-T136), but commitlint also enforces
// body-max-line-length (100) over every body line, and the templates below interpolate LLM
// free text (`decision.detail`) plus 23-char feedback ids — six triage PRs in one batch went
// ci-gate-red on exactly this. Two shapes, two tools: free-standing PROSE lines word-wrap
// across lines; an `Acceptance:` BULLET must stay ONE line (parseAcceptanceBlock ends the
// block at the first non-bullet line, so a wrapped bullet would orphan every later criterion)
// and is therefore truncated with an ellipsis instead. Truncation only trims keyword-floor
// prose — the full detail always appears (wrapped) in the body above the block.
```

## triageAcceptanceProof

`src/lib/triage.ts:740-759` at `c185258e`, 20 comment lines.

```
/**
 * The EXECUTABLE proof for a triage outcome: the feedback entry's own status flip, in the house
 * `grep: <pattern> in <path>` dialect {@link "./review.js".parseWhitelistedProof} accepts.
 *
 * WHY THIS EXISTS. Every triage PR used to carry a FIXED ENGLISH PHRASE here — "feedback yaml flips
 * to rejected", "in-diff provenance; status proposed", "needs-human issue; grilling". They named a
 * true, checkable fact and no parser could read any of them, so EVERY triage PR posted
 * `CAPPED — 0/1 proofs executed`: 25 of the 28 capped verdicts in the two days after the
 * `capped_reason` field was added were this, one per triage fire, now firing every 15 minutes
 * (state/recon-GY-no-dialect-caps.md). It was never an authoring failure — no model writes this
 * string — so no prompt could have fixed it.
 *
 * DERIVED FROM `decision.status`, never re-typed: the proof asserts exactly the status
 * `run-task.ts`'s `setFeedbackStatus(worktreePath, feedbackId, decision.status)` writes into the
 * same diff, so the two cannot drift into a proof that greps for a status the harness never wrote.
 *
 * IT DISCRIMINATES. The entry reads `status: new` on the merge base and the flipped value on the
 * head, so the grep MISSES the base — a pattern matching both is downgraded to `executed_stale`
 * (W1-T273) and would leave the verdict capped exactly as before.
 */
```

## acceptanceCriterionLines

`src/lib/triage.ts:764-781` at `c185258e`, 18 comment lines.

```
/**
 * One Acceptance criterion as the LABELLED TWO-LINE form (`- claim: …` + an indented `proof: …`),
 * which {@link "./review.js".parseAcceptanceBlock} recognises alongside the single-line
 * `- claim | proof` shape.
 *
 * WHY TWO LINES AND NOT THE ONE-LINER. commitlint's `body-max-line-length` is 100 and is a REQUIRED
 * check ({@link COMMIT_BODY_MAX_LINE}), while a real proof for a long feedback id is already ~90
 * characters on its own — `grep: status: rejected in plan/feedback/fb-alert-craigoley-remudero-code-scanning-17.yaml`
 * is 89. A single-line bullet carrying both would be ~170 and {@link fitAcceptanceBullet} would
 * elide it — which is how four of the shipped bodies ended up with a `…` mid-phrase. Splitting the
 * criterion gives the proof a line of its own with room to spare.
 *
 * THE CLAIM IS ELIDED, THE PROOF NEVER IS. Truncating prose costs legibility; truncating a proof
 * costs execution, which is the whole defect this function exists to end. If a feedback id is ever
 * long enough that the PROOF line alone exceeds the budget, that is returned UNTRUNCATED and
 * commitlint will say so loudly — a caught red beats a silent cap. `test/triage-proof-dialect.test.ts`
 * pins the worst id length that still fits.
 */
```

## triageCommitMessage

`src/lib/triage.ts:786-794` at `c185258e`, 9 comment lines.

```
/**
 * The commit message (and, via `gh pr create --fill`, the PR title+body) the HARNESS authors for
 * a triage outcome — never the LLM, so the `Acceptance:`/`Remudero-Task:` contract can never be
 * skipped or malformed the way a free-text worker report could be. Title line first (conventional
 * commit style, matching this repo's `chore(plan): ...` convention), blank line, then an
 * `Acceptance:` block `rmd review`'s PR-body fallback path parses ({@link
 * "./review.js".parseAcceptanceBlock}) since a synthetic `TRIAGE-<id>` task carries no
 * plan/tasks.yaml entry of its own, then the provenance trailer.
 */
```

## buildGrillEscalation

`src/lib/triage.ts:859-867` at `c185258e`, 7 comment lines.

```
/**
 * Build the `Escalation` (lib/escalate.ts) for an AMBIGUOUS feedback item — the async
 * needs-human GitHub issue that IS the grill (★ VERIFIED the only viable mechanism: see this
 * module's header doc and LEARNINGS.md "AskUserQuestion neither works headlessly nor stalls").
 * Pure — `run-task.ts`'s `triageCommand` is the only caller that hands this to the real
 * `escalate()`/`ghIssueGateway()` I/O, mirroring how `triageCommitMessage` stays pure while the
 * caller owns git/gh. `class: "GRILL"` reuses escalate.ts's SAME machinery (labels, ledger line,
 * digest-only — no real-time ping) rather than inventing a second one, per this task's directive.
 */
```
