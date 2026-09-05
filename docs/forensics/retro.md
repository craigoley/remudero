# retro.ts forensics

The measured facts, incidents and design arguments that used to live as comment prose inside
`src/lib/retro.ts`, archived verbatim when that file's comments were compacted to the
plain-language standard. Each section names the symbol or the section the block explained,
gives the block's line range at the base commit, and quotes the original text unchanged.

Nothing here is a rule or an instruction. It is the record behind a rule that still lives in
the code, so a reader who needs the evidence can find it without every reader paying for it.

Base commit for every line range below: `97bdd4ba371ec823d90c4f8112c6a33bd8e92b16` (`src/lib/retro.ts` is byte-identical
there to `ea02cc8`, where the ranges were taken).

## The module header

`src/lib/retro.ts` lines 1-10 at the base commit.

```
/**
 * `rmd retro` — the DETERMINISTIC GATHER (no LLM) that feeds the Architect retro.
 *
 * MASTER-PLAN §Self-improvement: the harness must SYNC ITS OWN PLAN. Nothing here
 * calls a model — it reduces the append-only ledger + LEARNINGS into a structured
 * gather (calibration by task type, verdict distribution, merged-since list) that
 * the higher-tier Architect worker then synthesizes into a plan-only PR. Separation
 * of GENERATION (this, deterministic) from PUBLICATION (the gate + the human) is the
 * governance that stops the harness shipping garbage at the speed of light [research].
 */
```

## The `node:fs` default import (`fsMarker`)

`src/lib/retro.ts` lines 13-18 at the base commit.

```
// The DEFAULT export -- a plain, mutable object -- so a test's `t.mock.method` can
// actually intercept the marker's read/write calls: named bindings off `node:fs` are
// non-configurable and mock.method/defineProperty against them throws "Cannot redefine
// property" instead of installing a spy. See the identical import comment atop
// src/lib/status.ts (W1-T207) -- saveMarker/loadMarker below call `fsMarker.*` as live
// property lookups at call time for exactly this reason (test/retro-marker-atomic.test.ts).
```

## RunSummary.correctedFromPrUrl — the false-attribution class

`src/lib/retro.ts` lines 74-80 at the base commit.

```
  /**
   * Present only when a `correction.provenance` ledger line overrode this run's
   * ledger-claimed PR url (W1-T51/P9-b — the false-attribution class, e.g. run
   * W1-T54b-1784151420811: `verdict.pr_url` claimed #80, the correction names #91).
   * Holds the ORIGINAL claimed url that was overridden; `prUrl` above is always
   * the truth (corrected when a correction exists, the ledger's own claim otherwise).
   */
```

## `taskClass` (field)

`src/lib/retro.ts` lines 86-92 at the base commit.

```
  /**
   * The task's routing CLASS (W1-T167 — docs / plan-lint / the `src` default)
   * at `run.start` time, if logged. The third mount-routing axis alongside
   * type/risk; {@link aggregateByClass} groups on this so the retro can read
   * per-class cost/merge-rate and evaluate whether the routing table's cheaper
   * docs/plan-lint mounts are actually cheaper AND still merging.
   */
```

## `check` (field)

`src/lib/retro.ts` lines 107-108 at the base commit.

```
  /** W1-T91/P23 part (i): the specific probe/check the guard ran (e.g.
   *  `inherited-functions`, `outside-cwd-denial`), alongside `guard` above. */
```

## RunSummary.outputTokens — the unread spend term

`src/lib/retro.ts` lines 114-126 at the base commit.

```
  /**
   * W1-T930: summed `TokenUsage.output` (src/lib/worker.ts) off every DONE_STEPS
   * line, mirroring `numTurns` above exactly (same steps, same reduce shape).
   * `workerLedgerFields` already writes `tokens: {input, output, cacheRead,
   * cacheCreation}` on every `recon.done`/`implement.done`/`implement.resumed`
   * line — the dominant spend term (output runs ~5x input price) was captured
   * on every worker call and never once read back by a calibration aggregate
   * until this field. Optional (unlike `numTurns`) ONLY so a hand-built
   * `RunSummary` fixture predating this task keeps compiling unchanged;
   * {@link gatherRuns} itself always sets it (0, never omitted, same
   * "present but honestly zero" discipline `numTurns` keeps) — every reader
   * treats a genuinely absent value as 0 too (never as "unknown").
   */
```

## `correctionFor` (function)

`src/lib/retro.ts` lines 132-137 at the base commit.

```
/**
 * A `correction.provenance` line for this run, if any — a FIRST-CLASS ledger
 * EVENT (MASTER-PLAN P9-iv): the operator has already written the truth (an
 * `actual_pr_url`) over a run's false ledger claim, and every reducer must honor
 * it rather than re-deriving the false claim. Last one wins if several exist.
 */
```

## `outputTokensOf` (function)

`src/lib/retro.ts` lines 146-149 at the base commit.

```
/** W1-T930: `l.tokens.output` off one ledger line, tolerating every shape a
 *  hand-built test fixture or a pre-token-ledgering line might carry (missing
 *  `tokens`, a non-object `tokens`, a non-numeric `output`) — `0`, never a
 *  thrown TypeError, on anything that isn't the real `TokenUsage` shape. */
```

## W1-T91/P23 (i): the structured guard-cause fields,

`src/lib/retro.ts` lines 203-204 at the base commit.

```
      // W1-T91/P23 (i): the structured guard-cause fields, when the verdict line
      // carried them (a guard-block written after this task landed).
```

## MIN_TURN_COVERAGE_FOR_PER_MERGE — the thin-numerator bar

`src/lib/retro.ts` lines 250-257 at the base commit.

```
/**
 * W1-T930: below this fraction of a class's runs reporting a nonzero
 * `numTurns`, the numerator `turnsPerMerge`/`outputTokensPerMerge` divide by
 * is too thin to trust — MASTER-PLAN's own worked example (4 of 14 credited
 * runs, 29%) sits well under this bar and is the exact case the design's
 * "reuse the discipline verbatim" clause names. Exported so a test can pin
 * the boundary rather than re-deriving it from a magic number.
 */
```

## ClassCalibration — why per-merge figures sit beside per-run ones

`src/lib/retro.ts` lines 260-281 at the base commit.

```
/**
 * Calibration aggregate for one task CLASS (W1-T167 — docs / plan-lint / src) —
 * the same shape as {@link TypeCalibration}, grouped on the routing table's
 * THIRD axis instead of the first, plus `mergeRate` (merged/runs) since a
 * per-class table exists specifically to answer "is this class's cheaper
 * mount still merging" — the retro needs the rate, not just the raw count, to
 * evaluate the routing hypothesis (design note: "routing is a hypothesis to
 * be measured, not asserted").
 *
 * W1-T930 adds the PER-MERGE half beside the per-run figures above (never
 * replacing them — `avgTurns`/`merged`/`mergeRate` are untouched): turns and
 * output tokens are gameable when divided by RUN count (a refused run is
 * short, so more refusals lower the average) but not when divided by MERGE
 * count, which only rises when a class needs more work to land the same
 * result. `merged`/`mergeRate` above stay ledger-verdict-only (unchanged,
 * matching every existing caller); the new fields divide by whichever merge
 * source `aggregateByClass`'s caller could actually reach (`mergeSource`
 * names it, `mergedForDenominator` is the count actually used) — CLAUDE.md's
 * standing rule is that merge state comes from the `Remudero-Task:` trailer,
 * never a ledger verdict line, and the ledger-verdict `merged` count is the
 * one MASTER-PLAN documents as UNDERCOUNTING real ships by more than half.
 */
```

## `totalOutputTokens` (field)

`src/lib/retro.ts` lines 290-292 at the base commit.

```
  /** W1-T930: total `TokenUsage.output` summed across every run in this
   *  class — the per-run companion to `totalCostUsd`, the dominant spend
   *  term that had no calibration column at all before this task. */
```

## `turnCoverage` (field)

`src/lib/retro.ts` lines 294-298 at the base commit.

```
  /** W1-T930: fraction of this class's runs with a nonzero logged
   *  `numTurns` — travels beside `turnsPerMerge`/`outputTokensPerMerge` so a
   *  thin numerator is never read as a solid one (MASTER-PLAN's "29%
   *  coverage" signal, generalized). Below {@link MIN_TURN_COVERAGE_FOR_PER_MERGE}
   *  the per-merge cells below carry a coverage caveat rather than a bare number. */
```

## `mergeSource` (field)

`src/lib/retro.ts` lines 300-305 at the base commit.

```
  /** W1-T930: which merge-crediting mechanism `mergedForDenominator` (and
   *  therefore the per-merge fields) actually divides by — `"shipped"` when
   *  the caller passed the W1-T51 SHIPPED union (trailer-matched, closes the
   *  known ledger-verdict undercount), `"ledger"` when it did not and this
   *  fell back to the same ledger-verdict `merged` count above. Always set —
   *  a row with no nameable merge source is never emitted. */
```

## `mergedForDenominator` (field)

`src/lib/retro.ts` lines 307-308 at the base commit.

```
  /** W1-T930: the merge count the per-merge fields below actually divide
   *  by — NOT always equal to `merged` above (see `mergeSource`). */
```

## `turnsPerMerge` (field)

`src/lib/retro.ts` lines 310-314 at the base commit.

```
  /** W1-T930: turns spent per MERGED PR in this class — numerator is
   *  `avgTurns`'s own total (ALL turns spent, including refused runs, so
   *  a class cannot lower this by refusing more), denominator is
   *  `mergedForDenominator`. `null` only when `mergedForDenominator` is 0
   *  (division by zero is never computed and never silently reads as 0). */
```

## `outputTokensPerMerge` (field)

`src/lib/retro.ts` lines 316-317 at the base commit.

```
  /** W1-T930: output tokens spent per MERGED PR — same numerator/denominator
   *  discipline as `turnsPerMerge`. `null` only when `mergedForDenominator` is 0. */
```

## aggregateByClass — the runId join and the unknown bucket

`src/lib/retro.ts` lines 321-338 at the base commit.

```
/**
 * Aggregate runs BY TASK CLASS (W1-T167 calibration table) — mirrors {@link
 * aggregateByType} exactly, grouped by {@link RunSummary.taskClass} instead of
 * `type`. A run with no `taskClass` (a ledger line predating W1-T167, or any
 * step that never logged it) is grouped under `"unknown"` rather than dropped
 * — an omitted class is itself a fact the retro should see, not silently lose.
 *
 * W1-T930: `shipped` is the ALREADY-COMPUTED `RetroGather.shipped` union
 * (ledger ∪ GitHub-trailer-matched, {@link shippedSince}/{@link
 * ledgerOnlyShipped}) — optional so every existing caller (and this file's
 * own tests) keeps compiling unchanged, but `buildGather` below always
 * passes it, because that union is the accurate merge count and the
 * ledger-verdict `merged` count alone is the one MASTER-PLAN names as
 * undercounting real ships by more than half. `ShippedRecord` carries no
 * `taskClass` of its own (it is a merge-union record, not a routing
 * record), so each one is attributed back to its OWN run's class via a
 * `runId` join against `runs` — never a second, independently-scoped read.
 */
```

## `classOfRun` (const)

`src/lib/retro.ts` lines 347-348 at the base commit.

```
  // W1-T930: runId -> class, the join `shipped` (which carries no taskClass)
  // needs to be attributed back to the class its own run was routed under.
```

## `runsWithTurns` (const)

`src/lib/retro.ts` lines 364-366 at the base commit.

```
    // W1-T930: nonzero-numTurns coverage over this class's own runs — the
    // numerator-trust signal, independent of which merge count is the
    // denominator (that is `mergeSource`/`mergedForDenominator` below).
```

## ModelClassWeeklyBurn — turns, not imputed dollars

`src/lib/retro.ts` lines 391-400 at the base commit.

```
/**
 * One resolved MODEL TIER's share of THIS WEEK's burn (P34 clause (d), W1-T250) —
 * the routing objective made measurable: "weekly-limit burn per model class",
 * never imputed dollars (clause c, W1-T249's ratified rule). `turnsThisWeek` is
 * the burn unit: a subscription's weekly caps meter real usage (messages/tokens
 * of model time), not billed dollars, so turns — not `costUsd`, which stays an
 * IMPUTED API-equivalent meter on a Max plan — is what this share is computed
 * from. `costUsdThisWeek` rides along for context ONLY; it never drives
 * `shareOfWeeklyBurn`.
 */
```

## `shareOfWeeklyBurn` (field)

`src/lib/retro.ts` lines 411-414 at the base commit.

```
  /** `turnsThisWeek / (turns burned by every resolved model this week)`; `0`
   *  when the week burned zero turns across every model (an empty week, not a
   *  divide-by-zero) — the SHARE of the weekly subscription window this model
   *  tier is burning, the cross-file invariant this task ratifies. */
```

## aggregateWeeklyBurnByModelClass — the join P34(d) asserts

`src/lib/retro.ts` lines 418-436 at the base commit.

```
/**
 * Aggregate THIS WEEK's runs by the MODEL each one resolves to per
 * `.remudero/mounts.yaml`'s (task_type × risk × class) routing rows (W1-T167,
 * read via {@link resolveMountForClass}) — the genuinely atomic cross-file
 * invariant P34 clause (d) asserts: the routing table's per-class rows, READ
 * by this accounting, are the SOLE source of which model a run's burn is
 * attributed to. Neither file alone can answer "what share of this model's
 * weekly cap did this work burn": the mounts.yaml rows alone account nothing
 * (they are policy, not ledgered fact), and the ledger's per-run turns alone
 * have no model to bucket against (a run logs task_type/risk/class, never the
 * model it resolves to) — this function is the join.
 *
 * `now` fixes THIS WEEK to the current UTC ISO week ({@link utcWeekWindowMs},
 * the SAME week boundary `deriveWeekCostUsd` (sweep.ts, W1-T159) uses — one
 * shared definition of "this week", never a second one computed here). A run
 * whose (task_type, risk) has no route in `mounts` resolves to `"unresolved"`
 * rather than throwing: unlike a live dispatch decision, a stale/legacy ledger
 * line must never crash the retro's own reporting over it.
 */
```

## `ownBranchOf` (function)

`src/lib/retro.ts` lines 492-492 at the base commit.

```
/** A run's own worktree branch — deterministic, matches run-task.ts's `run-<runId>` naming. */
```

## probeGithubThrottle — the copied threshold and the cycle it avoids

`src/lib/retro.ts` lines 497-524 at the base commit.

```
/**
 * ONE cheap `gh api rate_limit` probe (W1-T132 design ii) — meant to back a
 * real `ShippedGithub.unavailable()` for `retroCommand`'s production gateway.
 * Checked ONCE per retro, BEFORE any merge is credited, so a quota exhaustion
 * (or any other `gh` CLI failure — auth expiry, network outage) is NAMED
 * rather than silently read through `findMergedByTrailer`/`headRefName`
 * returning null/undefined for every query, which looks identical to "GitHub
 * genuinely has no evidence". Self-contained: does not touch lib/status.ts's
 * `ghGateway` or its fail-soft `tryJson`, and does not depend on (or wait for)
 * W1-T119's future three-valued `deriveStatus` read — but agrees with its
 * polarity, unavailable is never silently absent. Never throws; a probe that
 * itself crashes the retro over a transient CLI hiccup would be worse than the
 * silent-zero bug this task fixes.
 *
 * W1-T2305: This probe's `.rate.remaining` read is the free, legacy `gh api rate_limit` object
 * daemon-health.ts's own module header now names as unreliable (the endpoint disagreed with
 * itself three times in one second in the measurement that task cites) — moving THIS call onto a
 * real metered response is out of scope here (design (vii) names no attempt to make GitHub's own
 * reporting accurate, and the cost of a wrong reading on this path is bounded: retroTriggerCheck
 * skips one tick and the daemon retries the next, per that task's own rationale (3)). The
 * threshold below (`<= 0`, never `=== 0`) is deliberately kept identical to
 * `isBucketExhausted`'s (lib/daemon-health.ts) — copied rather than imported: importing that
 * module here would close `retro.ts → daemon-health.ts → daemon.ts → retro.ts`, a genuinely new
 * dependency cycle (measured: it raises depcruise's own pinned no-circular count, W1-T…
 * `cli-plumbing-extraction.test.ts`'s baseline, from 13 to 19). A malformed reading that comes
 * back negative therefore still reads as exhausted here too, exactly as it does everywhere else
 * this repo asks the same question.
 */
```

## `ShippedGithub` (interface)

`src/lib/retro.ts` lines 555-562 at the base commit.

```
/**
 * The GitHub queries `shippedSince` needs: a trailer lookup for the GitHub-side
 * union half, and a PR's head branch for the P9 ownership assert — the exact
 * shape of run-task.ts's `PrHeadGateway` (W1-T62's write-side guard), applied
 * here at the READ side. A real implementation composes `status.ts`'s
 * `ghGateway` (for `findMergedByTrailer`) with a `gh pr view --json headRefName`
 * lookup (for `headRefName`), mirroring run-task.ts's `ghPrHeadGateway`.
 */
```

## ShippedGithub.unavailable — degrade loudly

`src/lib/retro.ts` lines 568-582 at the base commit.

```
  /**
   * W1-T132 DEGRADE LOUDLY (design ii): when the gateway itself is known to be
   * throttled, erroring, or otherwise unavailable (rate-limited, auth expired,
   * transport/network failure), return a human-readable reason NAMING it.
   * Returns undefined when the gateway is healthy — including for a caller that
   * never wires this optional method at all, so an untouched implementer sees
   * no behavior change. Checked ONCE per {@link buildGather} call, BEFORE any
   * credit is rendered: `RetroGather.githubUnavailable` carries the reason, and
   * `renderGather` surfaces it prominently instead of letting a zero-merge read
   * (every `findMergedByTrailer`/`headRefName` call failing silently under a
   * throttle) pass as a confirmed "nothing shipped" — the exact silent-zero
   * failure this task exists to close. Self-contained: does not depend on (or
   * wait for) W1-T119's future three-valued `deriveStatus` read, but agrees
   * with its polarity — unavailable is never silently read as absent.
   */
```

## ShippedGithub.mergedCommits — the runless-merge route

`src/lib/retro.ts` lines 584-599 at the base commit.

```
  /**
   * W1-T2288: every commit merged into this repo's own default branch, full history — the
   * SAME shape {@link GitLogCommit} already names (`citationStampPassFor`'s git-log reader,
   * run-task.ts, feeds it identically). Backs {@link runlessMergesSince}, the retro TRIGGER's
   * only route to a merge that {@link shippedSince}'s run-scoped iteration structurally
   * cannot reach (a plan/triage/feedback filing never has a run, so it never appears in
   * `runs` at all).
   *
   * OPTIONAL, DEGRADING TO ZERO ADDED MERGES — never a thrown error, and never a required
   * implementer: every `ShippedGithub` literal written before this task (every fixture in
   * test/retro-trigger-check.test.ts, `ledgerOnlyShipped`'s callers, `buildGather`'s own
   * gather) omits this method and keeps compiling, unchanged, with {@link retroTriggerCheck}
   * reading `github.mergedCommits?.() ?? []` — the identical fail-soft shape `unavailable`
   * above already uses. Wired for real only in `retroShippedGithubGateway` (run-task.ts),
   * which is the ONE production construction path; every test drives a bespoke literal.
   */
```

## shippedSince — the P9 ownership assert

`src/lib/retro.ts` lines 609-631 at the base commit.

```
/**
 * UNION ledger-merged runs with GitHub-derived merged Remudero-Task-trailered PRs,
 * scoped to runs started strictly after `sinceTs` (W1-T51). Each ledger-ABSENT
 * merge (a run that ended some OTHER terminal verdict, whose task nonetheless has
 * a merged trailered PR on GitHub) is credited with source "github" and annotated
 * `gate-side merge; run ended <verdict>` — the gap `mergedSince` alone cannot see.
 *
 * P9 OWNERSHIP ASSERT (retro#1784155126258, the false-attribution class): before
 * crediting ANY merge — ledger OR GitHub side — the credited PR's `headRefName`
 * must equal the claiming run's OWN branch ({@link ownBranchOf}). A stale/foreign
 * trailer (the #80/W1-T54b class: PR #80 is Dependabot's own PR, not the run's)
 * or an unresolved head ref is REJECTED — never credited — and named in
 * `discrepancies` rather than silently dropped or silently trusted.
 *
 * P9 CORRECTION-AWARE: `runs` is expected to already carry the correction
 * override (see {@link gatherRuns}'s `correctedFromPrUrl` handling) — a
 * `correction.provenance` line's `actual_pr_url` is what `RunSummary.prUrl`
 * holds, so the ownership assert checks (and credits) the TRUTH, never the
 * original false claim.
 *
 * Every rejection AND every GitHub-side addition is named in `discrepancies` —
 * the SHIPPED log can never silently miss (or wrongly gain) a merge.
 */
```

## `ledgerOnlyShipped` (function)

`src/lib/retro.ts` lines 687-690 at the base commit.

```
/** The ledger-only fallback for `RetroGather.shipped` when no GitHub gateway is
 * wired — IDENTICAL to today's `mergedSince` crediting (no ownership check, no
 * annotation): a caller that hasn't wired a gateway yet gets no regression and
 * no unverified claim, rather than a default that silently trusts everything. */
```

## `RETRO_TRAILER_RE` (const)

`src/lib/retro.ts` lines 707-710 at the base commit.

```
/** The exact anchored form `findMergedByTrailer`'s own doc measures against real PR bodies
 *  (status.ts `TRAILER_RE`, autonomy.ts `TRAILER_RE`) — reused here, not reinvented, so a
 *  trailer this function fails to see is a trailer none of this repo's other credit paths see
 *  either. */
```

## `runlessMergesSince` (function)

`src/lib/retro.ts` lines 713-727 at the base commit.

```
/**
 * Every commit in `commits` merged strictly after `sinceTs` (the SAME "strictly after" boundary
 * {@link shippedSince} scopes `runs` by, `r.startTs > sinceTs`) whose task has NO run at all —
 * a commit with no `Remudero-Task:` trailer (a plan/triage/feedback filing; see run-task.ts's
 * `LINT_FILING_SUBJECT_RE` for the same filing vocabulary) is always included; a trailered commit
 * is included ONLY when `taskIdsWithRuns` (every task id a {@link RunSummary} exists for, ledgered
 * or not credited — the caller's FULL `runs` list, unscoped) does not contain its id.
 *
 * A trailered commit naming a task `taskIdsWithRuns` DOES contain is deliberately EXCLUDED:
 * that merge is `shippedSince`'s to credit — ledger-native or gate-side alike — and counting it
 * again here would double it. This is the "preserve the gate-side crediting that already works,
 * never reimplement it" boundary: this function never inspects a PR's head branch, never calls
 * `findMergedByTrailer`/`headRefName`, and never re-derives the P9 ownership assert — it only
 * decides which commits are OUTSIDE `shippedSince`'s domain in the first place.
 */
```

## `codeFilesInDiff` (function)

`src/lib/retro.ts` lines 745-749 at the base commit.

```
/**
 * Files under `src/` or `test/` touched by a unified diff. A retro is PLAN-ONLY —
 * it must touch NONE (one concern: the harness syncs its PLAN, never ships code in
 * the same PR). The retro command fails closed when this returns non-empty.
 */
```

## `assertArchitectAboveWorker` (function)

`src/lib/retro.ts` lines 773-777 at the base commit.

```
/**
 * Enforce G-17: the retro Architect MUST ride a higher tier than the implement
 * workers it reviews. Throws (fail-closed) on violation — a same-or-lower-tier
 * synthesizer is not an Architect.
 */
```

## G-17 evidence (W1-T2239): the ARCHITECT-LANE SHARE OF SPEND, measured

`src/lib/retro.ts` lines 787-804 at the base commit.

```
// ── G-17 evidence (W1-T2239): the ARCHITECT-LANE SHARE OF SPEND, measured ──
//
// MASTER-PLAN §9 gives G-17 TWO reasons: a ratification-authority half (the
// Architect adjudicates a worker's output, so it must outrank what it
// reviews — untouched by anything below) and a CAPABILITY half (a
// higher-tier model authors better harness text) that this repo has never
// measured against its own ledger. This section is that measurement, laid
// beside {@link aggregateByClass}'s per-class routing data — an INPUT to the
// retro's own re-examination, never a change to the invariant: {@link
// assertArchitectAboveWorker} above still throws unconditionally, and no
// `.remudero/mounts.yaml` row or `config.architectModel` is read, let alone
// written, by anything here.
//
// The four Architect-tier authoring lanes (src/run-task.ts call sites of
// assertArchitectAboveWorker) and the two comparison lanes (the implement
// worker and the advisory reviewer) are identified by the ONE ledger `step`
// name each writes on its terminal/telemetry line — the same discipline
// every other miner in this file uses (DONE_STEPS, REPLAY_RESULT_STEP, …).
```

## `ARCHITECT_LANE_STEPS` (const)

`src/lib/retro.ts` lines 806-808 at the base commit.

```
/** EXPORTED for scripts/mount-headroom-sweep.mjs (W1-T2668), which prices these same lanes and
 *  must not carry a second copy of the mapping — the step name is the ONE thing that identifies a
 *  synthesis rung's rows in the ledger, and two lists of it would drift silently. */
```

## `COMPARISON_LANE_STEPS` (const)

`src/lib/retro.ts` lines 816-820 at the base commit.

```
/** Non-Architect lanes reported for SCALE ONLY — "share of what" needs a
 *  denominator, and these are the two lanes whose spend the Architect lanes
 *  actually sit beside (the implement worker G-17 says the Architect must
 *  outrank, and the advisory reviewer, itself out of this shard's scope but
 *  already the dominant non-implement cost). */
```

## `UNATTRIBUTED_MODEL` (const)

`src/lib/retro.ts` lines 826-829 at the base commit.

```
/** The bucket a row with no `model` key reports under — NEVER folded into a
 *  real model's count, so a corpus that is mostly unattributed (the rationale's
 *  451-of-613 `verdict` rows) reads as unattributed rather than as a silent
 *  majority for whichever model happened to be read first. */
```

## `LaneSpend` (interface)

`src/lib/retro.ts` lines 838-839 at the base commit.

```
/** One lane's measured spend — rows, NOTIONAL (never billed) cost, the newest
 *  row it saw, and its model attribution. */
```

## `newestTs` (field)

`src/lib/retro.ts` lines 849-850 at the base commit.

```
  /** The most recent `ts` this lane's rows carried — absent only when the lane
   *  logged zero rows in the corpus this ran over. */
```

## `costOf` (function)

`src/lib/retro.ts` lines 855-857 at the base commit.

```
/** `r.cost_usd`, falling back to `r.total_cost_usd` — the SAME precedence
 *  {@link gatherRuns}'s `costLine` already uses, so this reads the identical
 *  notional figure the per-type/per-class tables above are built from. */
```

## `ArchitectLaneShareReport` (interface)

`src/lib/retro.ts` lines 884-887 at the base commit.

```
/** The whole G-17-evidence gather: the four Architect lanes, the two
 *  comparison lanes, the Architect lanes' combined share of the measured
 *  total, and the WINDOW (oldest → newest `ts` seen across every lane below)
 *  so a stale corpus cannot read as a current share. */
```

## `shareOfSpend` (field)

`src/lib/retro.ts` lines 897-898 at the base commit.

```
  /** `architectCostUsd / totalCostUsd`; `0` when the measured total is $0
   *  (an empty corpus, not a divide-by-zero). */
```

## `architectLaneShare` (function)

`src/lib/retro.ts` lines 904-911 at the base commit.

```
/**
 * Measure the Architect-lane share of spend over `records` — a PURE reduction,
 * exactly like every other miner in this file (never touches `.remudero/mounts.yaml`,
 * `config`, or any file: it takes ONLY the already-parsed ledger records `buildGather`
 * hands it, the same corpus {@link aggregateByType}/{@link aggregateByClass} read).
 * Single pass over `records`: each row is bucketed by its `step` into at most one
 * of the six named lanes (an unrecognized step contributes to none of them).
 */
```

## `architectLaneShareTable` (function)

`src/lib/retro.ts` lines 961-962 at the base commit.

```
/** Render the lane table (markdown) — Architect lanes first, then the two
 *  comparison lanes, in the SAME row shape so the share is legible at a glance. */
```

## `renderArchitectLaneShare` (function)

`src/lib/retro.ts` lines 972-975 at the base commit.

```
/** Render the full G-17-evidence section — printed beside the per-class
 *  calibration table in {@link renderGather} (W1-T2239's own acceptance:
 *  "the retro gather reports the architect-lane share of spend beside the
 *  per-class routing data it already collects"). */
```

## MAST-coded verdicts (W1-T89, ratifies P18's mineable core)

`src/lib/retro.ts` lines 1001-1011 at the base commit.

```
// ── MAST-coded verdicts (W1-T89, ratifies P18's mineable core) ─────────────
//
// MAST (Cemri et al., NeurIPS 2025 [research: mast-neurips2025]; 1,600+ annotated
// traces across 7 frameworks, kappa 0.88) names 14 failure modes across 3
// categories -- specification (~42%), inter-agent misalignment (~37%),
// verification (~21%). Remudero's ledger verdict classes are a private
// vocabulary for the same underlying failures; plan/mast-mapping.yaml holds
// the DETERMINISTIC verdict -> MAST mapping as DATA (Rule 2 -- never
// LLM-classified). Applied READ-SIDE here, at retro-gather time, so the whole
// ledger (past and future) codes against the published taxonomy with zero
// ledger rewrites.
```

## `MastMappingRow` (interface)

`src/lib/retro.ts` lines 1013-1017 at the base commit.

```
/** One row of plan/mast-mapping.yaml: a ledger verdict class (+ optional
 *  `subtype` qualifier -- the worker-error subtype off the terminal `verdict`
 *  ledger line, e.g. `error_max_turns`) coded to one MAST failure mode + its
 *  category. `provisional` marks a row an open investigation (P23) is still
 *  refining -- visible in the render, not a distinct code path. */
```

## `parseMastMapping` (function)

`src/lib/retro.ts` lines 1044-1049 at the base commit.

```
/**
 * Parse + validate raw YAML text into a {@link MastMapping}. Pure (no I/O) so a
 * test can hand it a fixture string directly, same shape as {@link parseLedger}.
 * Fails LOUDLY on a malformed row (Rule 2's own discipline: a mapping this
 * central is trusted to be well-formed, never guessed at by a lenient parser).
 */
```

## `mastRowFor` (function)

`src/lib/retro.ts` lines 1090-1095 at the base commit.

```
/**
 * Find the row coding one run, preferring an exact (verdict, subtype) row over
 * its bare-verdict sibling -- the "optional qualifiers" plan/mast-mapping.yaml's
 * design describes. Returns undefined when no row matches at all: the caller
 * codes that as unmapped, never guesses.
 */
```

## `byCategory` (field)

`src/lib/retro.ts` lines 1106-1108 at the base commit.

```
  /** category -> count, deterministic key order. `merged` runs are never
   *  counted here -- success is out of scope for a FAILURE distribution
   *  (P18's own framing); they never reach {@link mastRowFor} at all. */
```

## `unmapped` (field)

`src/lib/retro.ts` lines 1110-1112 at the base commit.

```
  /** Every failure verdict the mapping named no row for, as `verdict` (or
   *  `verdict:subtype` when the run logged a subtype) -> count. Named,
   *  visible, NEVER silently dropped or folded into a guessed category. */
```

## CREDITED_VERDICTS — the three non-defects

`src/lib/retro.ts` lines 1120-1132 at the base commit.

```
/** Verdicts the MAST failure taxonomy treats as a CREDITED outcome — out of scope for a
 *  FAILURE distribution ({@link mastCategoryDistribution}), never an infrastructure event
 *  ({@link infrastructureEvents}), and never a task defect ({@link taskDefectCounts}).
 *  `merged` (this run's own PR merged) and `already_satisfied` (W1-T272: the task's
 *  acceptance was already true on origin/main, VERIFIED via a merged PR carrying this
 *  task's own trailer — forward progress, not a defect, exactly like `merged`).
 *  `task_already_merged` (W1-T319, fb-1784773321502-86793d) is a THIRD member for a
 *  different reason — not forward progress (no worker ran, `merged: false` on the
 *  `RunResult`) but a zero-cost pre-spawn refusal: the projection already reported the
 *  TARGET merged, so nothing about a (task_type x risk) class is defective and no work was
 *  ever attempted to mine. DATA-shaped, mirrored by every MAST-taxonomy reducer below (Rule
 *  2 — one classifier, never a per-function guess) so none of these three is ever
 *  miscounted as an unmapped failure or inflates a task's defect count. */
```

## `mastCategoryDistribution` (function)

`src/lib/retro.ts` lines 1135-1139 at the base commit.

```
/**
 * Reduce a cycle's runs into a {@link MastCategoryDistribution} against `mapping`.
 * Pure and deterministic -- the mapping is DATA, so a row edit alone (zero code
 * changes) flips a fixture's outcome; see mast-mapping.test.ts.
 */
```

## `mastDistributionTable` (function)

`src/lib/retro.ts` lines 1156-1157 at the base commit.

```
/** Render the MAST category table (markdown), with an optional trend column
 *  against the PRIOR cycle's `byCategory` (the retro marker persists it, W1-T89). */
```

## W1-T91/P23: guard-fired blocks classify as INFRASTRUCTURE, never a task

`src/lib/retro.ts` lines 1181-1191 at the base commit.

```
// ── W1-T91/P23: guard-fired blocks classify as INFRASTRUCTURE, never a task
// defect ──────────────────────────────────────────────────────────────────
//
// A guard (isolation/containment) firing is the harness's OWN preflight
// catching a HOST condition before any task work ran — proof the guard
// WORKED, not evidence the task is broken (MASTER-PLAN P23, investigated:
// both novel 2026-07-16 blocks were correct fail-closed guard fires). Coded
// entirely off plan/mast-mapping.yaml's `category: infrastructure` rows
// (Rule 2 — data, never a hardcoded verdict check) so the row IS the
// classifier: remove it and these runs report unmapped, never silently
// mis-coded into an agent-failure category.
```

## GUARD_REASON_FALLBACK_ROWS — coding prose-only verdict lines

`src/lib/retro.ts` lines 1193-1202 at the base commit.

```
/**
 * DATA fallback table (Rule 2 discipline, same as {@link OVERRUN_VERDICTS}):
 * a historical `verdict` ledger line that PREDATES this task's structured
 * `guard`/`check` fields carries only prose in `reason`. Each row names the
 * verdict class, a pattern the prose must match (defense-in-depth — never
 * infer guard/check off the bare verdict alone), and the guard/check those
 * lines code to. The two 2026-07-16 lines (P23's own investigation) are
 * exactly what this table exists to code retroactively, with zero rewrite of
 * the ledger itself.
 */
```

## `resolveGuardCheck` (function)

`src/lib/retro.ts` lines 1225-1233 at the base commit.

```
/**
 * Resolve a run's guard/check — the structured fields off its own verdict
 * line when present (every guard-block written after W1-T91 lands), else the
 * {@link GUARD_REASON_FALLBACK_ROWS} match against its prose `reason` (every
 * guard-block written before). Returns undefined when NEITHER source
 * resolves it (the run isn't a guard-block at all, or predates even the
 * prose shape the fallback table expects) — the caller decides how to
 * surface that rather than guessing a guard/check that was never observed.
 */
```

## `infrastructureEvents` (function)

`src/lib/retro.ts` lines 1253-1262 at the base commit.

```
/**
 * Mine `runs` for every run plan/mast-mapping.yaml codes `category:
 * infrastructure` — driven entirely by the mapping (Rule 2): a row edit
 * alone reclassifies a verdict class into or out of this bucket, zero code
 * change. A run the mapping calls infrastructure but whose guard/check
 * resolves to neither the structured fields nor the fallback table still
 * counts (never silently dropped) — named `guard`/`check` "unknown" rather
 * than excluded, so the bucket's total always matches the mapping's own
 * count.
 */
```

## `infrastructureRecurrence` (function)

`src/lib/retro.ts` lines 1295-1296 at the base commit.

```
/** Group {@link infrastructureEvents} by (guard, check), deterministic order —
 *  the recurrence trend `renderInfrastructure` names in its report. */
```

## `taskDefectCounts` (function)

`src/lib/retro.ts` lines 1319-1328 at the base commit.

```
/**
 * Per-task DEFECT count (W1-T91/P23 part ii): every non-merged run for that
 * task EXCLUDING guard-fired infrastructure events — a guard firing
 * correctly is a host signal, never evidence the TASK is defective. Driven
 * by the SAME mapping `category` field {@link infrastructureEvents} reads
 * (Rule 2 — one classifier, not two), so a mapping row edit alone moves a
 * verdict class into or out of a task's defect count. A task with zero
 * qualifying runs never appears in the returned record (absence IS zero,
 * not a reason to guess a key into existence).
 */
```

## `renderInfrastructure` (function)

`src/lib/retro.ts` lines 1340-1341 at the base commit.

```
/** Render the infrastructure section (markdown) — printed by `--dry-run` and
 *  fed to the Architect, mirroring {@link mastDistributionTable}'s shape. */
```

## Mutation gate lifetime (W1-T393, MASTER-PLAN §11 D-10)

`src/lib/retro.ts` lines 1360-1387 at the base commit.

```
// ── Mutation gate lifetime (W1-T393, MASTER-PLAN §11 D-10) ────────────────
//
// D-10 has stood OPEN for seven retro cycles on a standing prose demand — "report, WITH DATA,
// mutants killed vs survived over `mutation-ratchet`'s LIFETIME, and whether it has EVER caught a
// real escape" — that no gather rung ever executed, because it was written as prose in a decision
// entry rather than built as one. Design clause (i): READ THE GATE'S OWN HISTORY, never re-run
// Stryker here. That history turns out not to exist anywhere durable: `scripts/mutation-
// ratchet.mjs` only ever compares a fresh Stryker report against `scripts/mutation-baseline.json`
// (a single current FLOOR, not a per-run log) and exits — it never writes the ledger, in ANY of
// its seven documented modes (grepped: zero `appendLedger`/ledger references in that file). The
// CI job (`.github/workflows/ci.yml`'s `mutation-ratchet`) doesn't either. The closest existing
// ledger traffic — `pr.checks`/`pr.polling` (src/run-task.ts's `pollToGate`) — is explicitly
// documented rotation-fodder (test/ledger-rotation.test.ts's "no-decision-consequence traffic"),
// names only the FIRST red check per poll (so a red mutation-ratchet sitting behind another red
// check is never named), and carries no mutant counts at all. THAT IS THE FINDING clause (i)
// asks for: nothing durable records this gate's per-run verdict today.
//
// Design clause (iv) is therefore the live fork: ship the emission (below) plus a gather rung
// reading it, and report the lifetime answer as "starts now, N=0" — a stated limitation, never an
// empty result. `MUTATION_GATE_VERDICT_STEP` is added to `DECISION_RELEVANT_LEDGER_STEPS`
// (src/lib/ledger.ts) in this SAME change, the `sweep.absent_repush` precedent clause (iv) names —
// a "lifetime" count that ledger rotation could silently reset would recreate the exact defect
// this task exists to close. What this change does NOT do — and NOT IN SCOPE forbids — is touch
// `scripts/mutation-ratchet.mjs` or `ci.yml` to wire the actual write call site after a real
// `npx stryker run`; that edits the gate's own file/config, out of THIS task's `files:` scope.
// Until that follow-up lands, `mutationGateLifetime` correctly reads zero records and reports the
// NO-POSITIVE-CONTROL state below — never a false "zero escapes" — which is the honest state of
// the world today, not a bug in this rung.
```

## `MUTATION_GATE_VERDICT_STEP` (const)

`src/lib/retro.ts` lines 1389-1392 at the base commit.

```
/** The ledger step this task registers for `mutation-ratchet`'s PR-gate verdict, going forward —
 *  see the module comment above for why nothing durable recorded this before now. One line per
 *  REAL Stryker run (a diff-scoped skip never calls {@link mutationGateVerdictLine} — there is no
 *  report to summarize). */
```

## `MutationGateVerdictInput` (interface)

`src/lib/retro.ts` lines 1395-1398 at the base commit.

```
/** The per-run fields {@link mutationGateVerdictLine} carries — the Stryker totals
 *  `scripts/mutation-ratchet.mjs`'s own `parseMutationTotals`/`tallyMutants` already compute
 *  in-process, plus the binary conclusion clause (ii) says must never be stood in for by the
 *  totals alone. */
```

## `mutationGateVerdictLine` (function)

`src/lib/retro.ts` lines 1415-1416 at the base commit.

```
/** Build (never write) the ledger line for one mutation-ratchet verdict — pure, same
 *  builder/writer split as {@link mineFollowups}/{@link recordFollowupHarvest} below. */
```

## `MutationGateVerdictDeps` (interface)

`src/lib/retro.ts` lines 1431-1432 at the base commit.

```
/** Dependencies for {@link recordMutationGateVerdict} — same injectable-writer shape as
 *  {@link FollowupHarvestDeps} (a test spies on `writeLedger` instead of touching disk). */
```

## `recordMutationGateVerdict` (function)

`src/lib/retro.ts` lines 1438-1441 at the base commit.

```
/** Append one {@link mutationGateVerdictLine}. UNWIRED in this change (see the module comment
 *  above) — no production call site invokes this yet, because that call site lives inside
 *  `scripts/mutation-ratchet.mjs`/`ci.yml`, both out of this task's scope. Shipped now so the
 *  step's shape and its rotation-survival land in the SAME change, never split across two. */
```

## `MutationGateLifetimeReport` (interface)

`src/lib/retro.ts` lines 1453-1459 at the base commit.

```
/**
 * The rung D-10 asks for, folded over `MUTATION_GATE_VERDICT_STEP` lines. `positiveControl` is
 * design clause (iii)'s P48 guard: `false` means zero verdict records were found at all — an
 * UNMEASURED history, never to be rendered or read as "zero escapes" — versus `true` with
 * `escapeCount: 0`, a genuine zero-escapes-over-N-runs result. The two must never be confused;
 * see {@link renderMutationGateLifetime} for how each renders.
 */
```

## `mutationGateLifetime` (function)

`src/lib/retro.ts` lines 1469-1475 at the base commit.

```
/**
 * READ ONLY — clause (i): never runs Stryker, never touches disk; folds whatever
 * `MUTATION_GATE_VERDICT_STEP` lines the ledger already carries. Called over the FULL `records`
 * (never marker-scoped), the same "a lifetime figure must survive past the marker window" choice
 * {@link mineFollowups} already makes for follow-ups — a marker-scoped read would silently
 * truncate "lifetime" into "since last retro", the opposite of what D-10 asked for.
 */
```

## `renderMutationGateLifetime` (function)

`src/lib/retro.ts` lines 1497-1498 at the base commit.

```
/** Render the mutation-gate-lifetime section (markdown) — printed by `--dry-run` and fed to the
 *  Architect; THE section D-10 has been waiting seven cycles for. */
```

## `ReplayCalibration` (interface)

`src/lib/retro.ts` lines 1533-1535 at the base commit.

```
/** `n passed / n goldens` for the cycle, folded over {@link REPLAY_RESULT_STEP} ledger lines.
 *  `ranThisCycle: false` (P48: no naked zero) means NO replay line was recorded in this
 *  window at all — an unmeasured cycle, never to be read as "0% pass rate". */
```

## `replayPassRateForCycle` (function)

`src/lib/retro.ts` lines 1543-1549 at the base commit.

```
/**
 * Fold `REPLAY_RESULT_STEP` lines within `sinceTs` (the cycle window, `undefined` ⇒ all-time —
 * the first retro) into the cycle's replay pass-rate. Ignores every other ledger step, and
 * tolerates a `passed` field of any non-boolean shape (a hand-built fixture, a torn line) by
 * simply not counting it, same "never throw on an unexpected shape" discipline every other
 * reducer in this file already keeps.
 */
```

## `renderReplayCalibration` (function)

`src/lib/retro.ts` lines 1561-1562 at the base commit.

```
/** Render the replay-pass-rate section (markdown) — printed by `--dry-run` and fed to the
 *  Architect, alongside the other calibration tables. */
```

## `byClass` (field)

`src/lib/retro.ts` lines 1583-1585 at the base commit.

```
  /** W1-T167: per-class (docs / plan-lint / src) cost + merge-rate — the
   *  measurement half of the routing hypothesis (the table itself is in
   *  .remudero/mounts.yaml; this is what tells the retro if it's working). */
```

## `weeklyBurnByModelClass` (field)

`src/lib/retro.ts` lines 1587-1590 at the base commit.

```
  /** P34 clause (d), W1-T250: THIS WEEK's burn, bucketed by the model tier each
   *  run resolves to per `.remudero/mounts.yaml`'s routing rows — present ONLY
   *  when `buildGather` was given a `mounts` table (omitted degrades this
   *  section out entirely, never a silent empty-array "confirmed zero"). */
```

## `degradedSuccess` (field)

`src/lib/retro.ts` lines 1598-1599 at the base commit.

```
  /** W1-T73: every MERGED run whose `review.posted` matched a degraded-success
   *  signal (a claimed PASS that used a weaker path than its criteria named). */
```

## `githubUnavailable` (field)

`src/lib/retro.ts` lines 1607-1613 at the base commit.

```
  /**
   * W1-T132: present ONLY when `opts.github.unavailable()` named a reason (a
   * throttle, an error, or any other confirmed outage) — never set for a
   * healthy gateway or for the ledger-only fallback (which carries no opinion
   * on GitHub's health at all). `renderGather` refuses to present `shipped`
   * as a complete/confirmed count while this is set.
   */
```

## `mast` (field)

`src/lib/retro.ts` lines 1615-1618 at the base commit.

```
  /** W1-T89/P18: this cycle's failure distribution BY MAST CATEGORY, mapped
   *  read-side off `opts.mastMapping` (defaults to an empty table, which
   *  reports every failure verdict unmapped — a valid, visible degrade, never
   *  a build failure). */
```

## `infrastructureEvents` (field)

`src/lib/retro.ts` lines 1624-1626 at the base commit.

```
  /** W1-T91/P23: every guard-fired block this cycle, classified INFRASTRUCTURE
   *  (never a task defect) — mined off the SAME `opts.mastMapping` as `mast`
   *  above, over the same `scoped` window. */
```

## `infrastructureRecurrence` (field)

`src/lib/retro.ts` lines 1628-1630 at the base commit.

```
  /** W1-T91/P23: `infrastructureEvents` grouped by (guard, check) — the
   *  recurrence trend that names a host signal ("the same check firing
   *  across N runs on one host"). */
```

## `taskDefectCounts` (field)

`src/lib/retro.ts` lines 1632-1634 at the base commit.

```
  /** W1-T91/P23: per-task defect counts over `scoped`, EXCLUDING every
   *  guard-fired infrastructure event — the statistic guard-fired blocks must
   *  never pollute. */
```

## `followups` (field)

`src/lib/retro.ts` lines 1636-1638 at the base commit.

```
  /** W1-T105: unharvested worker-declared follow-ups (research | task | action),
   *  mined over the FULL ledger (never marker-scoped — a discovery from three
   *  retros ago is still worth surfacing) and deduped against `opts.openTitles`. */
```

## `architectLaneShare` (field)

`src/lib/retro.ts` lines 1646-1651 at the base commit.

```
  /** W1-T2239: the G-17 Architect-lane share of spend, evidence for the tier
   *  invariant's capability rationale — computed over the FULL `records` (never
   *  `scoped`), the SAME "a figure truncated to one retro cycle is not the
   *  figure asked for" reasoning {@link mutationGateLifetime} above already
   *  uses, because a stale-corpus HISTORICAL share is still what this asks for
   *  (see {@link ArchitectLaneShareReport.windowStartTs}/`windowEndTs`). */
```

## `planCoherence` (field)

`src/lib/retro.ts` lines 1653-1664 at the base commit.

```
  /**
   * W1-T2642: the plan-coherence census — ALWAYS present, computed on EVERY `buildGather` call
   * (never optional; unlike `mast`/`weeklyBurnByModelClass`, which genuinely degrade for a
   * table `buildGather` never reads). `retroCommand` ({@link "../run-task.js".retroCommand}, via
   * {@link "../run-task.js".readPlanCoherenceInputs}) supplies the REAL `plan/tasks.yaml` +
   * `plan/tasks.d/*.yaml` bytes on every `rmd retro` cycle, so a live cycle renders a real
   * `clean`/`findings` verdict — the fourteen-cycle question answered by measurement.
   * `buildGather` still never touches disk itself: a caller that omits `opts.planCoherence`
   * gets `{ kind: "unexamined", reason }` naming that plainly rather than an omitted field,
   * because omission reads as "nothing calls this" while a stated `unexamined` is a real,
   * rendered answer.
   */
```

## `buildGather` (function)

`src/lib/retro.ts` lines 1668-1673 at the base commit.

```
/**
 * Build the whole deterministic gather from raw inputs. Pure over its injected
 * `github` gateway (deps.github omitted ⇒ `shipped` degrades to the ledger-only
 * list, same as today's `mergedSince` — no GitHub union, no ownership assert,
 * no unverified annotation; see {@link ledgerOnlyShipped}).
 */
```

## `mounts` (field)

`src/lib/retro.ts` lines 1694-1697 at the base commit.

```
  /** P34 clause (d), W1-T250: the ALREADY-LOADED `.remudero/mounts.yaml` table
   *  (buildGather never reads it from disk — same discipline as `mastMapping`
   *  above). Omit ⇒ `weeklyBurnByModelClass` is omitted entirely, never a
   *  silently-empty array. */
```

## `now` (field)

`src/lib/retro.ts` lines 1699-1702 at the base commit.

```
  /** Epoch ms defining "this week" for {@link aggregateWeeklyBurnByModelClass}
   *  ({@link utcWeekWindowMs}) — injected so buildGather stays a pure function
   *  of its inputs (no internal wall-clock read). Ignored when `mounts` is
   *  omitted. */
```

## buildGather.followupLedgerNdjson — why the union is a separate input

`src/lib/retro.ts` lines 1704-1719 at the base commit.

```
  /**
   * W1-T1013: the follow-up harvest's OWN ndjson corpus — the archive∪live ledger UNION
   * (`resolveLedgerUnion`, lib/ledger-grep.ts), scoped by the caller to the three steps
   * {@link mineFollowups} reads (`report.followups`, `followup.harvested`,
   * `followup.deduped`). buildGather stays FS-free (this is still a plain string, exactly
   * like `ledgerNdjson`) — the union read itself happens in the caller (retroCommand),
   * because only IT has a `stateDir` to glob.
   *
   * A SEPARATE, EXPLICIT input rather than swapping `ledgerNdjson` itself: every other
   * miner below (`degradedSuccess`, `mutationGateLifetime`, `mast`, …) is deliberately
   * marker-scoped or full-`records`-scoped against the SAME single-file read it has always
   * used, and re-corpusing all of them onto the union at once would change what THEY see
   * too — criterion (3) pins that they must not. Omit ⇒ falls back to `records`
   * (`ledgerNdjson` parsed) so an existing caller that has not wired the union yet keeps
   * its prior behavior unchanged.
   */
```

## `planCoherence` (field) — lines 1721-1731

`src/lib/retro.ts` lines 1721-1731 at the base commit.

```
  /**
   * W1-T2642: the plan-coherence census's raw inputs — the monolith blob plus a listing of
   * every `plan/tasks.d/*.yaml` shard (or the stated reason the directory could not be
   * listed). buildGather stays FS-free (same discipline `openTitles`/`mastMapping` above
   * already document): the caller reads `plan/tasks.yaml`/`plan/tasks.d/` and hands the bytes
   * in here — {@link "../run-task.js".readPlanCoherenceInputs} is that read, and
   * `retroCommand` passes its result on every cycle. Omit ⇒ `planCoherenceRung` still runs
   * (see the unconditional call site below) against an `{ ok: false, reason }` default, so
   * `RetroGather.planCoherence` reports `unexamined` rather than being omitted — see {@link
   * planCoherenceRung}'s own doc.
   */
```

## `githubUnavailable` (const)

`src/lib/retro.ts` lines 1742-1744 at the base commit.

```
  // W1-T132 (design ii): checked ONCE, after the union runs (so a healthy union
  // still gets full credit) — a reason here means the read layer itself is not
  // trustworthy, regardless of what shippedSince managed to resolve anyway.
```

## `mapping` (const)

`src/lib/retro.ts` lines 1746-1747 at the base commit.

```
  // W1-T91/P23: computed once, shared by the events list and its recurrence
  // trend below — never two independently-scoped reads of the same mapping.
```

## `byClass` (field) — lines 1754-1758

`src/lib/retro.ts` lines 1754-1758 at the base commit.

```
    // W1-T930: `shipped` (the ledger∪GitHub-trailer union computed above,
    // degrading gracefully to ledger-only when no `github` gateway is wired)
    // is ALWAYS passed — it is the more-accurate-or-equal merge count, so
    // the per-class per-merge figures never divide by the ledger-verdict
    // count MASTER-PLAN documents as undercounting real ships by more than half.
```

## P34 clause (d), W1-T250: computed over

`src/lib/retro.ts` lines 1760-1764 at the base commit.

```
    // P34 clause (d), W1-T250: computed over the FULL `runs` (never `scoped`) —
    // "this week" is an absolute calendar window, not marker-relative, so a
    // fresh `sinceTs` must not truncate it out from under a week already in
    // progress. Omitted entirely (never a silently-empty array) when the
    // caller supplied no `mounts` table.
```

## `degradedSuccess` (field) — lines 1770-1772

`src/lib/retro.ts` lines 1770-1772 at the base commit.

```
    // W1-T73: mined over the SAME scoped-merged set the marker window already
    // bounds, so a degraded-success finding never re-surfaces for a run the
    // marker has already moved past (matches mergedSince's own scoping).
```

## `proceduralCandidates` (field)

`src/lib/retro.ts` lines 1774-1775 at the base commit.

```
    // W1-T87/P13: same marker-scoped window as degradedSuccess above — a
    // shape never re-surfaces for a run the marker has already moved past.
```

## `mast` (field) — lines 1780-1782

`src/lib/retro.ts` lines 1780-1782 at the base commit.

```
    // W1-T89/P18: SAME `scoped` window as verdicts above (the whole cycle's
    // runs, not just the merged subset) — a failure distribution over anything
    // narrower would miss runs mergedSince already excludes by definition.
```

## `infrastructureEvents` (field) — lines 1785-1787

`src/lib/retro.ts` lines 1785-1787 at the base commit.

```
    // W1-T91/P23: SAME `scoped` window + mapping as `mast` above — one
    // classifier, read twice (category distribution, then the
    // infrastructure/defect split), never two independently-scoped reads.
```

## `followups` (field) — lines 1791-1796

`src/lib/retro.ts` lines 1791-1796 at the base commit.

```
    // W1-T105: the FULL ledger, never `scoped` — a followup must survive past the
    // marker window (idempotency comes from the followup.harvested/deduped marks
    // mineFollowups reads back, not from marker-scoping). W1-T1013: "full" now means
    // `followupRecords` — the archive∪live union, not just `records` (this string's
    // live-only parse) — because rotation truncates the live file long before the
    // marker window would, which un-scoping from the marker alone cannot fix.
```

## `mutationGateLifetime` (field)

`src/lib/retro.ts` lines 1798-1800 at the base commit.

```
    // W1-T393/D-10: the FULL `records`, never `scoped` — same "must survive past the marker
    // window" reasoning as `followups` immediately above, because a LIFETIME figure truncated to
    // one retro cycle is not a lifetime figure.
```

## `replay` (field)

`src/lib/retro.ts` lines 1802-1804 at the base commit.

```
    // W1-T165: `opts.sinceTs`-scoped (the cycle), the opposite choice from `mutationGateLifetime`
    // immediately above — see `replayPassRateForCycle`'s doc for why a per-cycle figure is what
    // the task's own proof asks for.
```

## `architectLaneShare` (field) — lines 1806-1807

`src/lib/retro.ts` lines 1806-1807 at the base commit.

```
    // W1-T2239: FULL `records`, same reasoning as `mutationGateLifetime` above — a
    // measurement of the fleet's own allocation must not truncate to the marker window.
```

## `planCoherence` (field) — lines 1809-1814

`src/lib/retro.ts` lines 1809-1814 at the base commit.

```
    // W1-T2642: UNCONDITIONAL — called on EVERY buildGather invocation, never gated behind
    // whether `opts.planCoherence` was supplied. `retroCommand` (run-task.ts) DOES pass the real
    // plan/tasks.yaml + plan/tasks.d/ bytes, so a live cycle renders a real clean/findings
    // verdict; the `{ ok: false, reason }` default below is what a caller that supplies nothing
    // gets — rendered `unexamined` with a stated reason, never the silent omission a prior
    // revision used, and never a bare zero (P48).
```

## `perMergeCell` (function)

`src/lib/retro.ts` lines 1837-1844 at the base commit.

```
/**
 * W1-T930: render one per-merge cell — `turnsPerMerge`/`outputTokensPerMerge`
 * — with the coverage discipline the design mandates ("reuse verbatim" the
 * MASTER-PLAN `37 ⚠ 29% coverage — DO NOT USE` cell): a thin-coverage figure
 * is STILL PRINTED, flagged, never laundered or blanked; only the genuine
 * zero-merge divide-by-zero case (`value === null`) renders as an explicit
 * non-numeric marker — never a bare `0`, never `NaN`.
 */
```

## `classCalibrationTable` (function)

`src/lib/retro.ts` lines 1853-1857 at the base commit.

```
/** Render the per-class calibration table (markdown, W1-T167) — the routing
 *  table's effectiveness, measured. W1-T930 appends the per-merge half
 *  (output tokens, turns/merge, output tokens/merge, and the named merge
 *  source/denominator they divide by) AFTER the existing per-run columns —
 *  every column already here is unchanged, in the same order, same format. */
```

## `modelClassWeeklyBurnTable` (function)

`src/lib/retro.ts` lines 1873-1874 at the base commit.

```
/** Render the per-model-tier weekly-burn-share table (markdown, P34 clause (d), W1-T250) —
 *  "is the routing table actually keeping cheap work off the capable model's weekly cap". */
```

## `shippedLines` (const)

`src/lib/retro.ts` lines 1888-1890 at the base commit.

```
  // W1-T132 (design ii): a throttled/errored/absent gateway must SAY SO BY NAME
  // and must NEVER let the SHIPPED section read as a confirmed zero — an empty
  // list gets an explicit INDETERMINATE line instead of the ordinary "(none)".
```

## `renderInfrastructure` (field)

`src/lib/retro.ts` lines 1947-1950 at the base commit.

```
    // W1-T91/P23: guard-fired blocks, already excluded from `mast`'s agent-
    // failure categories above (they land in `infrastructure` there too) —
    // this section is the dedicated per-guard/check view PLUS the per-task
    // defect exclusion the retro's own defect stats must honor.
```

## §5C plan-health sweep (W1-T20d, Standing rule 20)

`src/lib/retro.ts` lines 1966-1975 at the base commit.

```
// ── §5C plan-health sweep (W1-T20d, Standing rule 20) ─────────────────────
//
// Rules are enforced FORWARD-ONLY at authoring time (the CI half of §5C Layer
// A, task-linter.ts's `changedTaskIds` scoping). W1-T12 pre-existed Rules
// 18/19, violated both, and still reached a worker — burning 81 turns/$10.27
// (the FOURTH max_turns event) — because nothing ever re-checked an
// ALREADY-AUTHORED task against a rule added after it was written. The retro
// closes that gap: every run, it re-lints the WHOLE open queue (not just a
// PR's own edit) and turns every violation into a named corrective-task
// proposal for the Architect's plan-only PR to act on.
```

## CLOSED_TASK_STATUSES — why production never trusts yaml status:

`src/lib/retro.ts` lines 1977-1986 at the base commit.

```
/** Statuses that mean a task has already shipped, READ FROM THE DECORATIVE yaml `status:`
 *  field — plan/tasks.yaml's own header ("STATUS MODEL") is explicit that this field is
 *  initial-state only and the runner never writes it back; real merge-state is DERIVED FROM
 *  GITHUB. Scoped to {@link yamlMergedFallback}, itself scoped to pure unit tests over
 *  fixtures ONLY (mirrors plan.ts's own `yamlStatusMerged`/`MergedResolver` convention
 *  exactly — see that module's `unmetDependencies`/`assertRunnable`). W1-T367 MEASURED why a
 *  production reader must never trust this set: at cdf885a the yaml credited only 2 of 359
 *  tasks merged/done, so a skip keyed on it cleared 2 and left the sweep re-linting 357 tasks
 *  a run, 248 of them already shipped. {@link planHealthSweep}'s real caller
 *  (`planHealthSweepSectionFor`, run-task.ts) always passes an explicit derived `isMerged`. */
```

## `yamlMergedFallback` (function)

`src/lib/retro.ts` lines 1989-1990 at the base commit.

```
/** See {@link CLOSED_TASK_STATUSES}'s doc — the pure-unit-test-only default {@link planHealthSweep}
 *  falls back to when no derived `isMerged` is supplied. */
```

## `PlanHealthFlag` (interface)

`src/lib/retro.ts` lines 1995-1996 at the base commit.

```
/** One OPEN task the sweep found in violation, with its BLOCKING violations only
 *  (a WARN, e.g. budget-sanity, is visibility-only and never files a corrective task). */
```

## `CorrectiveTaskProposal` (interface)

`src/lib/retro.ts` lines 2002-2005 at the base commit.

```
/** A proposed corrective task, auto-filed per violating OPEN task — DATA for the
 *  Architect's plan-only PR to ratify, never written to plan/tasks.yaml directly by THIS function
 *  — its own scope, not a prohibition. W1-T2456: this cited "Standing rule 16", which is the
 *  mis-specified-task correction rule; §12 rule 27 permits automatic filing. */
```

## planHealthSweep — deriving already-shipped from GitHub, never yaml

`src/lib/retro.ts` lines 2020-2040 at the base commit.

```
/**
 * RE-GRADE every OPEN task against every standing rule the deterministic
 * linter encodes (sizing/Rule 19, headless-fitness/Rule 18, proof-shape,
 * provenance/Rules 16-17) — the forward-only gap Standing rule 20 names. A
 * MERGED/DONE task is out of scope (it already shipped; re-litigating it fixes
 * nothing). Pure: no I/O, no plan/tasks.yaml write — the corrective tasks are
 * PROPOSALS the retro's Architect stage files, same discipline as the
 * `learnings/` corpus shards never being hand-edited outside a reviewed PR.
 *
 * W1-T367: "already shipped" is decided by `isMerged`, NEVER by reading the decorative yaml
 * `status:` field in production — see {@link CLOSED_TASK_STATUSES}'s doc for the measured
 * defect (248/359 merged tasks re-linted every run) a yaml-trusting skip produced. `isMerged`
 * defaults to {@link yamlMergedFallback} ONLY so this stays callable from a pure unit test
 * over a plain fixture with no GitHub/projection in hand; the real caller
 * (`planHealthSweepSectionFor`, run-task.ts) always passes an explicit resolver derived from
 * `projectPlan`'s batched GitHub read — the same derived merge-state the dispatch path gates
 * on (src/run-task.ts's `runTask`). An indeterminate/unresolved read is safe to leave IN
 * scope here (worst case: one extra advisory-only corrective-task proposal for the Architect
 * to see and discard — never an auto-applied action), unlike the SHIPS-UNWIRED floor's
 * opposite direction (see `openTaskIdsFromPlan`'s doc).
 */
```

## OVERRUN_VERDICTS — the guard-fired and credited exclusions

`src/lib/retro.ts` lines 2086-2101 at the base commit.

```
/** Terminal verdicts that represent an OVERRUN/blocked outcome worth mining for
 *  a class pattern — every non-merge terminal state a run can end in EXCEPT the
 *  guard-fired classes (W1-T91/P23: `blocked_containment`/`blocked_isolation`
 *  are the harness's own preflight catching a HOST condition, never evidence a
 *  (task_type × risk) CLASS is defective — mining them for a class-level fix
 *  would propose "decompose this task class" over a host's populated
 *  `~/.bashrc`). DATA, not hardcoded logic, same pattern as task-linter.ts's
 *  lexicons.
 *
 *  `already_satisfied` (W1-T272) is DELIBERATELY ABSENT: it is forward progress that CREDITS
 *  the task, not a block — see {@link CREDITED_VERDICTS} below, which is what the MAST
 *  failure taxonomy (mastCategoryDistribution/infrastructureEvents/taskDefectCounts) checks
 *  instead, so a verified already-satisfied exit is never mined as a class-level defect.
 *  `task_already_merged` (W1-T319) is ALSO DELIBERATELY ABSENT, for a related but distinct
 *  reason: no worker ran and no turns were spent, so there is nothing about a (task_type x
 *  risk) class to mine a fix for — see {@link CREDITED_VERDICTS} below, the SAME set. */
```

## `isOverrunRun` (function)

`src/lib/retro.ts` lines 2116-2117 at the base commit.

```
/** A run counts as an overrun for mining purposes: a listed verdict, OR a
 *  `failed` run whose subtype names the max-turns runaway class specifically. */
```

## `overrunClassKey` (function)

`src/lib/retro.ts` lines 2122-2123 at the base commit.

```
/** The (task_type × risk) key — the SAME two axes mounts.yaml (§9) routes on —
 *  so a mined class maps directly onto a mount-table row, not an ad hoc bucket. */
```

## `ClassOverrunProposal` (interface)

`src/lib/retro.ts` lines 2128-2129 at the base commit.

```
/** ONE proposed class-level fix, covering every run in that (type, risk) class —
 *  never one proposal per task (the anti-pattern this mining exists to kill). */
```

## `mineOverrunClasses` (function)

`src/lib/retro.ts` lines 2139-2145 at the base commit.

```
/**
 * MINE the ledger's overrun/blocked verdicts for a task-CLASS pattern. Returns
 * ONE {@link ClassOverrunProposal} per (type, risk) class that meets
 * `opts.threshold` (default 2 — "repeated") overruns, never one per offending
 * task. Below threshold, a class is a single incident, not yet a pattern, and
 * is silently omitted (no proposal) rather than over-fitted to one data point.
 */
```

## Degraded-success mining (W1-T73)

`src/lib/retro.ts` lines 2185-2200 at the base commit.

```
// ── Degraded-success mining (W1-T73) ──────────────────────────────────────
//
// The overrun mining above reads FAILURE verdicts. It is blind to a run that
// ended MERGED — a claimed PASS — yet took a WEAKER path than its own
// acceptance criteria named: `review.posted`'s `proof_exec` array already
// records, per criterion, whether a proof was OBSERVED (`executed_pass`/
// `executed_fail`) or fell back to the keyword floor (`not_executable`/
// `exec_error`) — the field is ALREADY on the ledger (W1-T65/P15) but nothing
// read it for the retro's own report, so RETRO-1784213948025 gathered the
// same 2-run ledger that showed `proof_exec 0/N` and logged the run as a
// closed win without ever surfacing it — the same "claimed work it did not
// do" class the retro already names for FAILURE, unapplied to the gate's own
// PASS. The signal set below is DATA (a list of predicates over one run's
// most-recent `review.posted` line), same discipline as `OVERRUN_VERDICTS`
// above: the next degraded-success class is a table row, never new mining
// code.
```

## `ReviewPostedSummary` (interface)

`src/lib/retro.ts` lines 2202-2204 at the base commit.

```
/** The reduced `review.posted` facts one signal predicate judges against —
 *  the run's MOST RECENT posting (a run may re-post across fix strikes;
 *  only its latest posting reflects what actually merged). */
```

## `floorDegraded` (field)

`src/lib/retro.ts` lines 2212-2213 at the base commit.

```
  /** W1-T72's legibility flag — true when EVERY criterion fell back to the
   *  keyword floor while >=1 proof was WRITTEN in the house dialect. */
```

## `reviewerOutcome` (field)

`src/lib/retro.ts` lines 2215-2216 at the base commit.

```
  /** W1-T63/P10-a — the advisory reviewer spawn's terminal subtype, when logged
   *  (e.g. `error_max_turns`, `spawn_error`). Absent if never logged. */
```

## `latestReviewPostedByRun` (function)

`src/lib/retro.ts` lines 2220-2225 at the base commit.

```
/**
 * Reduce every `review.posted` ledger line to the LATEST posting per run_id —
 * a run may post more than once across fix strikes, and only its latest
 * posting reflects what actually merged. A run that never posted a review
 * (pre-W1-T65 history, or a synthetic fixture) has no entry — nothing to mine.
 */
```

## `DegradedSuccessSignal` (interface)

`src/lib/retro.ts` lines 2244-2249 at the base commit.

```
/**
 * One weaker-path-than-claimed signal — DATA, not a hardcoded branch (same
 * discipline as {@link OVERRUN_VERDICTS}): the next degraded-success class
 * (e.g. a future capped-but-merged shape) is a ROW added here, never new
 * executor code.
 */
```

## `DEGRADED_SUCCESS_SIGNALS` (const)

`src/lib/retro.ts` lines 2258-2262 at the base commit.

```
/** The shipped signal table. Row 1 is the canonical fixture (RETRO-1784213948025 /
 *  W1-T65): a merged run whose review posted `proof_exec` entirely unexecuted
 *  while >=1 proof was written to be runnable (house dialect). Row 2 is the
 *  W1-T73 design's named second class (a merged run whose advisory reviewer
 *  never completed a real pass) — proof the set generalizes as data. */
```

## `mineDegradedSuccess` (function)

`src/lib/retro.ts` lines 2286-2295 at the base commit.

```
/**
 * Mine MERGED runs for degraded-success telemetry (W1-T73): a run that ended
 * `verdict: merged` — a claimed PASS — whose most recent `review.posted`
 * ledger line matches a {@link DegradedSuccessSignal}. Pure over the raw
 * ledger records + the already-reduced run summaries, so calling it twice
 * over the SAME fixture returns the SAME findings — never accumulating or
 * duplicating (each call re-derives from scratch). A run matching more than
 * one signal emits one finding PER matching signal, naming every weaker-path
 * class it hit rather than only the first.
 */
```

## Procedural-success mining (W1-T87, ratifies P13)

`src/lib/retro.ts` lines 2333-2361 at the base commit.

```
// ── Procedural-success mining (W1-T87, ratifies P13) ──────────────────────
//
// Everything above mines FAILURE (overruns) or a weaker-than-claimed PASS
// (degraded success) — half the compounding loop MASTER-PLAN P13 names. The
// other half is blind: a run that merged CLEAN — first attempt, every
// acceptance criterion actually OBSERVED, not keyword-floored — is a
// POSITIVE signal whose shape is captured NOWHERE, so the prompt/recon/fix
// shape that produced it is never distilled into reusable procedural memory.
//
// This mines MERGED runs for that shape, DETERMINISTICALLY (rule 2 — the
// signal set is DATA, same discipline as OVERRUN_VERDICTS/
// DEGRADED_SUCCESS_SIGNALS above): every field a {@link ProceduralCandidate}
// carries is computed here, before any LLM ever sees it.
// {@link phraseProceduralCandidate} is the ONLY place an LLM enters this
// pipeline, and it receives nothing but the already-mined candidate — it
// PHRASES the fact, it never invents the evidence.
//
// BLOAT GUARD (design: "one success is an anecdote"): a shape needs
// `threshold` (default 2) SUPPORTING runs before it becomes a candidate —
// mirrors {@link mineOverrunClasses}'s identical guard on the failure side.
//
// NO PARALLEL STORE: a candidate, once phrased, is a {@link
// ProceduralLearningDraft} — the SAME shape (`fact`/`src`/`files`) a
// learnings.ts `LearningEntry` already carries, tagged only by `subsystem:
// "procedural"`. It rides the EXISTING lifecycle/injection/consolidation
// machinery (W1-T33/W1-T19) like any other entry; only the Architect writes
// it into a `learnings/*.yaml` shard — this function's own scope. W1-T2456: the citation here named
// a §12 rule number that carries no such doctrine; rule 15 is the goalpost rule, and rule 27 permits
// automatic filing outright.
```

## `ProceduralRunContext` (interface)

`src/lib/retro.ts` lines 2363-2363 at the base commit.

```
/** The reduced facts one {@link ProceduralSuccessSignal} judges a MERGED run against. */
```

## `ProceduralSuccessSignal` (interface)

`src/lib/retro.ts` lines 2375-2379 at the base commit.

```
/**
 * One deterministic success shape — DATA, not a hardcoded branch (mirrors
 * {@link DegradedSuccessSignal}): the next reusable-procedure class is a ROW
 * added here, never new mining code.
 */
```

## `mineProceduralCandidates` (function)

`src/lib/retro.ts` lines 2427-2435 at the base commit.

```
/**
 * MINE merged runs for a procedure shape shared by >= `opts.threshold` runs
 * (default 2 — a single success is an anecdote, not yet a pattern). Only a
 * run matching >=1 {@link ProceduralSuccessSignal} is considered at all; a
 * run matching none has nothing to contribute. Pure over the already-reduced
 * run summaries plus the raw ledger records (needed only for the
 * `fix.dispatch` count and the `review.posted` reduction) — no LLM, no I/O;
 * calling it twice over the SAME fixture returns the SAME candidates.
 */
```

## `FollowupCandidate` (interface)

`src/lib/retro.ts` lines 2511-2512 at the base commit.

```
/** One followup entry off a `report.followups` ledger event, with its provenance
 *  and a stable {@link entryId} the harvest-mark ledger lines reference. */
```

## `FollowupHarvest` (interface)

`src/lib/retro.ts` lines 2527-2531 at the base commit.

```
/** Pure mining result: what to show the Architect (`candidates`), what was
 *  recognized as already covered (`deduped`), and the ledger lines the caller
 *  (retroCommand) must append on a REAL (non-dry-run) pass — never `mineFollowups`
 *  itself — so a `--dry-run` preview stays a pure read, same discipline as
 *  {@link buildGather} itself. */
```

## `significantWords` (function)

`src/lib/retro.ts` lines 2538-2539 at the base commit.

```
/** Significant words only (>=3 chars) — drops "a"/"is"/"to"/"so" noise that would
 *  otherwise inflate overlap between two otherwise-unrelated sentences. */
```

## `followupMatchesTitle` (function)

`src/lib/retro.ts` lines 2544-2554 at the base commit.

```
/**
 * True when `text`'s content is ALREADY substantially covered by `title` — most
 * of `text`'s own significant words also appear in `titleWords` (>=60%, an
 * entry that is short relative to a fuller title still matches). Deliberately
 * asymmetric: a followup note is typically terser than the task/proposal
 * title it duplicates, so containment is judged FROM the entry's side, never
 * a strict/symmetric equality. Takes the title's word set PRE-COMPUTED (see
 * `mineFollowups`) — `openTitles` is invariant across every entry a harvest
 * pass checks it against, so its per-title tokenization runs once per title,
 * never once per (entry × title) pair.
 */
```

## W1-T2638: refuse a "flip the decorative yaml `status:` field" follow-up at harvest

`src/lib/retro.ts` lines 2563-2582 at the base commit.

```
// ── W1-T2638: refuse a "flip the decorative yaml `status:` field" follow-up at harvest ─────
//
// W1-T367's own rationale already carries the refutation this predicate states below — dispatch
// eligibility and dependency satisfaction both resolve through the GitHub-derived projection,
// never through a task's yaml `status:` field — but that text lives in a shard rationale
// `mineFollowups` never reads, so the class has now recurred a FOURTH time (this task's own
// origin follow-up: sync W1-T2473's `status:` from `queued` to `shipped`), each recurrence
// re-spending an Architect drafting slot to re-derive what the plan already contains. This is
// the narrowest place the class can die: BEFORE a candidate becomes a proposal id at all, and
// distinct from `followupMatchesTitle` (which cannot catch it — the canonical fixture matches no
// open task title).
//
// THE SCOPE FENCE IS THE HALF MOST LIKELY TO BE GOT WRONG (this task's own design note).
// Refuses ONLY an entry whose action edits a task's yaml `status:` field TOWARD a merged-meaning
// value (`merged`, `done`) or a value outside TASK_STATUSES' vocabulary. Never refuses an entry
// about `blocked` (the one status value that genuinely gates dispatch — `isDispatchEligible`,
// drain.ts:558), the `retirement:` field (a sibling field this predicate never inspects), or the
// derived projection itself (not a yaml edit at all). An entry this predicate cannot read an
// unambiguous target value out of is left untouched — ambiguity resolves toward HARVESTING,
// never toward a silent drop.
```

## `KNOWN_TASK_STATUSES` (const)

`src/lib/retro.ts` lines 2584-2585 at the base commit.

```
/** TASK_STATUSES (plan.ts:15-26), mirrored rather than imported — this module stays a leaf over
 *  the ledger and gains no dependency on the plan loader for one closed-vocabulary check. */
```

## `MERGED_MEANING_STATUSES` (const)

`src/lib/retro.ts` lines 2599-2601 at the base commit.

```
/** plan.ts's own `MERGED_STATUSES` (plan.ts:51) — the two TASK_STATUSES members that mean
 *  "landed". A follow-up asking to hand-set a yaml `status:` field to either is exactly the
 *  shape W1-T367's rationale refutes. */
```

## `STATUS_FIELD_RE` (const)

`src/lib/retro.ts` lines 2604-2611 at the base commit.

```
/** Matches an entry naming the yaml `status:` field itself — anchored on the `status:` colon
 *  spelling every one of the four recurrences has used verbatim — and NOT `retirement:`, a bare
 *  mention of the word "status" with no field syntax, or prose about the derived projection.
 *  EXPORTED (unlike this module's other `_RE` validators) so test/retro.test.ts can drive both
 *  arms directly by identifier — negative-reachability-ratchet.test.ts's fixture-less `_RE`
 *  census (W1-T2317) counts a validator regex that no test names by `SYMBOL.test(...)`, and this
 *  one is new at src/lib/retro.ts's already-at-baseline population; the fixture is the correction,
 *  not a widened allowance. */
```

## `statusFlipTarget` (function)

`src/lib/retro.ts` lines 2614-2618 at the base commit.

```
/**
 * The value a `STATUS_FIELD_RE`-matching entry's text asks to set the field TO, or `undefined`
 * when the text does not spell out an unambiguous single target — callers treat `undefined` as
 * "leave it alone" (see the scope-fence note above the section header: ambiguity always harvests).
 */
```

## `decorativeStatusFlipReason` (function)

`src/lib/retro.ts` lines 2627-2635 at the base commit.

```
/**
 * `undefined` unless `text` is, in scope, a decorative yaml `status:` flip — see the section doc
 * above for the exact fence (never `blocked`, never the `retirement:` field, never an ambiguous
 * read). When in scope, returns the REASON to record: the refutation itself (dispatch eligibility
 * and dependency satisfaction are GitHub-derived, so the field is decorative) plus, for a value
 * outside the schema, the fail-close it causes — and names the sanctioned remedy for a task that
 * is GENUINELY uncredited, an operator correction rather than a yaml edit. The reason must teach,
 * per this task's own design, never just decline.
 */
```

## mineFollowups — the run_id:ts:index key and the 36.5% collision

`src/lib/retro.ts` lines 2658-2690 at the base commit.

```
/**
 * Mine every `report.followups` event for entries not yet harvested or
 * deduped — PURE over `records` (idempotent: re-mining the same ledger twice
 * with no new events yields the same result), never itself writing a ledger
 * line. An entry already named by a `followup.harvested`/`followup.deduped`
 * line (matched on {@link FollowupCandidate.entryId}, `${runId}:${ts}:${index}`
 * within its source event) is skipped — the mechanism `mineOverrunClasses`'
 * sibling miners get for free from marker-scoping, but a followup must
 * survive PAST the marker window (a discovery from three retros ago is still
 * worth surfacing), so this module tracks it explicitly instead.
 *
 * W1-T2252: the key carries the source row's own `ts`, not just `run_id` and
 * the entry's position within that row. A single run emits `report.followups`
 * from up to five call sites (`harvestFollowupsFromReport`, four call sites in
 * run-task.ts), so `run_id` ALONE is not enough to disambiguate — with `index`
 * restarting at zero for every row, a second row's entry 0 collided onto the
 * SAME id as the first row's entry 0 and was silently dropped by
 * `processed.has(entryId)` before ever being considered (measured: 521 of
 * 1,426 declared entries, 36.5%). `ts` is written by the ledger appender on
 * every row without exception and is never repeated across a run's multiple
 * rows, so `run_id:ts:index` needs no writer change and no backfill — it is
 * computed purely from fields a `report.followups` row already carries. The
 * one cost: marks already written under the OLD `run_id:index` spelling will
 * not match the new key, so the first mine pass after this change re-surfaces
 * every entry it can see as though unharvested — a ONE-TIME re-surfacing of
 * already-seen candidates (not a loop, not a crash, not a silent false match)
 * that a later real retro harvests again under the new key and then never
 * repeats. `openTitles` (W1-T105 design iv) is the caller-supplied set of
 * existing open task titles / open proposal text — an entry whose
 * significant-word content is largely already covered by one of them (see
 * {@link followupMatchesTitle}) is DEDUPED rather than minted a second time
 * as a candidate for the same work.
 */
```

## `openTitleWordSets` (const)

`src/lib/retro.ts` lines 2699-2700 at the base commit.

```
  // Tokenized ONCE per title, not once per (entry × title) comparison below —
  // `openTitles` is the same set for every entry this pass mines.
```

## `FollowupHarvestDeps` (interface)

`src/lib/retro.ts` lines 2745-2746 at the base commit.

```
/** Dependencies for {@link recordFollowupHarvest} — same injectable-writer shape as
 *  {@link ContradictionResolutionDeps} (a test spies on `writeLedger` instead of disk). */
```

## `recordFollowupHarvest` (function)

`src/lib/retro.ts` lines 2752-2758 at the base commit.

```
/**
 * Append every {@link FollowupHarvest.harvestLines} entry so a later
 * {@link mineFollowups} pass over the updated ledger mints neither the
 * candidate nor the dedup match again. The caller (retroCommand) invokes this
 * ONLY on a real (non-`--dry-run`) retro — `mineFollowups` itself never
 * writes, so a dry-run preview stays side-effect-free.
 */
```

## `renderFollowupCandidates` (function)

`src/lib/retro.ts` lines 2764-2767 at the base commit.

```
/** Render the follow-up harvest (markdown) — printed by `--dry-run` and fed to the
 *  Architect. Every line here is a CANDIDATE citing its origin verbatim, never an instruction to
 *  file a task — this function's own scope. W1-T2456: this cited "Rule 15", which carries no such
 *  doctrine; §12 rule 27 permits automatic filing. */
```

## Follow-up routing (W1-T2458)

`src/lib/retro.ts` lines 2797-2812 at the base commit.

```
// ── Follow-up routing (W1-T2458) ───────────────────────────────────────────────────────────
//
// `mineFollowups` above finds candidates; until this task, `renderFollowupCandidates` only ever
// rendered them into a markdown section headed "never auto-filed (rule 15)" that no rung read
// back — of the seven modules calling `updateProposalRegistry` (inbox.ts's single writer), none
// read a follow-up, and no plan task has ever been filed FROM one (measured 2026-08-29: 463
// distinct task_ids, 2,115 declared entries, zero routed). `routeFollowupsToRegistry` below is
// the missing consumer: it takes the SAME `FollowupHarvest` `mineFollowups` already produces and
// files each still-open candidate through `updateProposalRegistry` — the SAME single writer
// board-review.ts/rule-efficacy.ts/feedback-docket.ts already use — instead of only rendering
// prose nobody reads. THE ROUTING CHOICE IS THIS LANE'S OWN, NOT A RULE'S: a routed follow-up is
// a PROPOSAL CANDIDATE for the inbox's own tiering and an operator's `rmd approve` to act on,
// rather than a task this lane commits directly. §12 rule 27 PERMITS the fleet to file its own
// work; routing through the inbox here is a deliberate narrower choice about where a harvested
// candidate should be judged, not a prohibition inherited from another rule — and it is now
// enforced by a writer instead of a caption.
```

## `FOLLOWUP_TYPE_ROUTES` (const)

`src/lib/retro.ts` lines 2814-2833 at the base commit.

```
/**
 * `FollowupEntry.type` semantics — WRITTEN HERE because nothing previously defined what the
 * three worker-report prefixes MEAN: `parseFollowups` (worker.ts) documents them only as parse
 * prefixes, and the sole prior read of `.type` was `renderFollowupCandidates` picking a display
 * label. Any code that branches on `.type` cites THIS definition rather than guessing one, per
 * this task's own rationale ("IF THE THREE SHOULD ROUTE DIFFERENTLY, DEFINING THE TYPE IS THE
 * FIRST DELIVERABLE").
 *
 *  - "research": an open question a worker surfaced but did not answer. ROUTABLE — the inbox's
 *    own drafting/ratification loop is exactly the mechanism for turning an open question into a
 *    scoped task, so this becomes a registry proposal.
 *  - "task": concrete follow-up work a worker named but that was out of ITS OWN one-concern
 *    scope. ROUTABLE for the same reason as "research": a proposal IS a candidate plan task, and
 *    this type names one directly.
 *  - "action": an ask of a HUMAN/OPERATOR (flip a flag, confirm a choice, run a live check) —
 *    NOT plan-shaped work. NOT ROUTABLE: minting it as a `Proposal` would hand `classifyProposal`
 *    something to tier as though it were buildable, which it is not. Declining still leaves the
 *    entry harvested (`recordFollowupHarvest`, unchanged by this task, already ledgered it) — it
 *    is simply never promoted to a `Proposal`.
 */
```

## `FollowupRouteOutcome` (type)

`src/lib/retro.ts` lines 2840-2843 at the base commit.

```
/** One candidate's routing outcome. A decline always NAMES the arm that declined it — never a
 *  bare boolean — so a reader can tell "already covered by the existing title dedup" from
 *  "not plan-shaped work" from "restates its own declaring task" or "dispatch-only" from
 *  "re-decides a settled question" without re-deriving any of the five from `harvest` by hand. */
```

## textAsksToImplementItsOwnTask — 23 of 317 live rows

`src/lib/retro.ts` lines 2853-2870 at the base commit.

```
/**
 * True when `text`'s own ask IS "implement `taskId`" — the shape W1-T2617's own recon measured
 * in 23 of 317 live registry rows (2026-09-01): a follow-up minted by a run declaring task X
 * whose text simply restates "implement X" back at the plan, so routing it would duplicate a
 * plan record (task or shipped PR) that already exists on whichever side of the merge X falls.
 *
 * DELIBERATELY NARROW, matching only a LEADING "implement <taskId>" claim (case-insensitive,
 * word-bounded): the entry's ask must literally BE its own declaring task, not merely mention it.
 * A follow-up that cites its own task id while asking for DIFFERENT work — "W1-T2530's fix should
 * also cover X" — does not start with this shape and is left untouched; per this task's own
 * design note, the dangerous direction is silently dropping a genuine discovery, not admitting a
 * duplicate the registry already tolerates today, so this predicate refuses the narrower set,
 * never the wider one.
 *
 * Shared verbatim by {@link isSelfReferentialFollowup} (candidate-shaped, admission time) and
 * {@link pruneSelfReferentialFollowups} (proposal-shaped, parsed back off an already-minted
 * summary) — ONE predicate, not two copies that could drift apart.
 */
```

## `isSelfReferentialFollowup` (function)

`src/lib/retro.ts` lines 2878-2883 at the base commit.

```
/** Admission-time self-reference check: does `candidate.text` simply ask to implement
 *  `candidate.taskId` — the SAME task that declared the candidate? Both fields already ride on
 *  every `FollowupCandidate` (`mineFollowups` sets them), so this needs no new read and no
 *  merged/queued distinction at all — it holds identically whether the declaring task is queued,
 *  merged, or anything else, which is exactly why it reaches the still-queued majority
 *  `retireSettledFollowups`'s merged-only signal cannot (W1-T2563). */
```

## W1-T2613: the third refusal arm — "dispatch-only"

`src/lib/retro.ts` lines 2888-2918 at the base commit.

```
// ── W1-T2613: the third refusal arm — "dispatch-only" ──────────────────────────────────────────
//
// MEASURED 2026-09-01 over the live 317-proposal registry: 2 routed proposals asked for NOTHING
// but "task X is ready, hand it off" — W1-T2457 (the ordinary drain had already merged it as
// #3272, so ratifying the proposal could only re-dispatch merged work) and W1-T2482 (status:
// queued — already dispatchable through the ordinary drain, so ratifying it could only duplicate
// a task already in the plan). Neither the title-dedup arm nor type-not-plan-shaped arm above
// declines either: both are typed `task:` (FOLLOWUP_TYPE_ROUTES says "propose") and neither
// title-matches an open task/proposal.
//
// THE SIGNAL THIS ARM USES, deliberately narrow: the entry names its OWN originating task
// (`FollowupCandidate.taskId` — by construction always an already-filed id; a `report.followups`
// row is only ever emitted by a run dispatched AGAINST a filed task, so no live plan re-read is
// needed to confirm "already-filed") AND its text carries a bare-dispatch marker phrase ("ready to
// implement", "hand off") AND carries NO OTHER action-verb marker. The W1-T2470 control this
// task's own rationale names — "re-run this task's own falsifier check ... the task must be
// closed rather than built if that's confirmed" — also mentions its own task id, but the
// action-verb check (`re-run`/`verify`/`close`/`check`/`audit`) keeps it routed: it
// names real work, not a bare dispatch ask.
//
// A cross-task ask ("W1-T<n> needs picked up") is NOT this arm's shape and stays routed — the
// claim here is narrowly about an entry's OWN already-filed referent, never about a task the
// entry merely mentions in passing.
//
// HEURISTIC OVER FREE PROSE, NOT A PARSER — stated, never claimed otherwise (this task's own
// rationale, Q on the mechanism: "a predicate over free prose WILL misfire in both directions").
// A live entry that pairs a bare-dispatch marker phrase with real follow-up work worded outside
// this arm's action-verb list (a phrasing this arm does not recognize as "real work") is WRONGLY
// DECLINED here, right alongside every entry it declines correctly — named in every declined
// outcome's own `reason`, never hidden behind a "0 false declines" claim this predicate cannot
// back.
```

## `DISPATCH_ONLY_MARKERS` (const)

`src/lib/retro.ts` lines 2920-2922 at the base commit.

```
/** Marker phrases signalling a followup's text is a BARE DISPATCH ask ("this task is ready,
 *  hand it off") rather than a description of work still to be done. Free prose, so this is a
 *  heuristic — see the arm's own doc above for the false-decline risk it knowingly accepts. */
```

## `NAMES_REAL_WORK_MARKERS` (const)

`src/lib/retro.ts` lines 2925-2927 at the base commit.

```
/** Verbs that mean the entry names REAL follow-up work of its own, not only a dispatch ask — ANY
 *  match here overrides {@link DISPATCH_ONLY_MARKERS}, keeping the W1-T2470 control ("re-run this
 *  task's own falsifier check ... must be closed rather than built") routed rather than declined. */
```

## `dispatchOnlyReferent` (function)

`src/lib/retro.ts` lines 2930-2934 at the base commit.

```
/**
 * `undefined` unless `candidate` is a BARE dispatch ask for its own already-filed originating
 * task — see the arm's doc above for the exact three-part test. When it returns a task id, that
 * id is always `candidate.taskId` itself (never a different, merely-mentioned id).
 */
```

## W1-T2645: the fifth refusal arm — "settled-question"

`src/lib/retro.ts` lines 2944-2970 at the base commit.

```
// ── W1-T2645: the fifth refusal arm — "settled-question" ────────────────────────────────────────
//
// title-dedup (lexical word-overlap) and type-not-plan-shaped (FOLLOWUP_TYPE_ROUTES) are the two
// arms this function's own doc named before this task; dispatch-only and self-referential added
// two more, and NONE of the four asks whether a candidate's REMEDY contradicts a question the
// plan has already, on record, decided. The regression corpus this arm is seeded from, verbatim:
// "sync plan/tasks.d/W1-T2473-*.yaml status: from queued to shipped (PR #3304 already merged it),
// stale status could cause a scheduler to re-offer completed work" — the FOURTH recorded instance
// of one misdiagnosis (DECISIONS.md's W1-T1/W1-T12a/W1-T99 each independently concluding that a
// task's yaml `status:` field is decorative and never drives dispatch). `followupMatchesTitle`
// cannot catch it (the text matches no open task title), and `decorativeStatusFlipReason`
// (W1-T2638, harvest-time) cannot either — that guard requires the literal word "field"
// immediately after `status:` (`STATUS_FIELD_RE`), which this exact phrasing lacks.
//
// THE TABLE IS DATA, NOT BRANCHES (this task's own design note (i)): a second settled question
// later is a ROW added to `SETTLED_QUESTIONS`, never a new `if` in `routeFollowupsToRegistry` —
// the W1-T81/W1-T92/W1-T101 precision-family discipline applied here.
//
// FAIL-OPEN IS THE CORRECT POLARITY (design note (iii), the opposite of this repo's usual
// default): refusing a genuine follow-up loses work permanently, so each row's `matches`
// predicate is narrow on purpose — it matches the proposed-WRITE shape ("status: from X to Y"),
// never the bare word "status", so an entry that merely mentions status or proposes work on a
// status BOARD still routes and mints its proposal.
//
// THIS ARM DECLINES PROMOTION ONLY, NEVER THE HARVEST (design note (ii)): a matched candidate
// already rode through `mineFollowups`/`recordFollowupHarvest` unchanged (exactly as the existing
// "action" decline leaves its entry harvested) — only the mint into the registry is refused here.
```

## `SettledQuestionRow` (interface)

`src/lib/retro.ts` lines 2972-2973 at the base commit.

```
/** One row of the settled-question table: a candidate whose remedy re-decides a question the plan
 *  has already, on record, answered. DATA, never a code branch — see the section doc above. */
```

## `matches` (field)

`src/lib/retro.ts` lines 2976-2978 at the base commit.

```
  /** True when `text` proposes the exact write/remedy this row's question was decided against.
   *  Narrow by design — matches a proposed WRITE, never the mere appearance of a word, so
   *  ambiguity routes rather than being silently declined. */
```

## `TASK_STATUS_FIELD_WRITE_RE` (const)

`src/lib/retro.ts` lines 2988-2995 at the base commit.

```
/** Matches a candidate proposing to hand-write a task's yaml `status:` field to a new value —
 *  e.g. "status: from queued to shipped" or "status: field ... to done" — deliberately narrower
 *  than `STATUS_FIELD_RE` (which requires the literal word "field"): this is the settled-question
 *  routing gate, not the W1-T2638 harvest-time guard, and it must catch the phrasing that guard
 *  does not ("status: from queued to shipped" — no "field" anywhere in the text). Does NOT match
 *  a bare mention of the word "status" or prose about a status BOARD — the fail-open scope fence
 *  (design note (iii)). EXPORTED (like `STATUS_FIELD_RE` above) so a test can drive both arms
 *  directly by identifier per test/negative-reachability-ratchet.test.ts's `_RE` census. */
```

## `SETTLED_QUESTIONS` (const)

`src/lib/retro.ts` lines 2999-3002 at the base commit.

```
/** Seeded with EXACTLY the one row this task's own rationale justifies — four independent
 *  recurrences of one misdiagnosis (DECISIONS.md's W1-T1/W1-T12a/W1-T99 plus this task's own
 *  occasioning follow-up). A second settled question later is another row, never a code change to
 *  {@link routeFollowupsToRegistry} — see the section doc above. */
```

## `findSettledQuestion` (function)

`src/lib/retro.ts` lines 3022-3027 at the base commit.

```
/** The first row of `rows` whose `matches` predicate fires on `text`, or `undefined` when none
 *  does — EXPORTED, and `rows` is a plain parameter (defaulting to {@link SETTLED_QUESTIONS}
 *  rather than closing over it), so a test can prove the table is DATA directly: pass a table
 *  with an added row and watch a fresh candidate decline with no change to this function or to
 *  `routeFollowupsToRegistry`, or pass `[]` and watch the seeded candidate route exactly as it
 *  would have before this arm existed. */
```

## `settledQuestions` (field)

`src/lib/retro.ts` lines 3034-3037 at the base commit.

```
  /** Injectable — defaults to {@link SETTLED_QUESTIONS}. A test overrides this to prove the
   *  settled-question arm is driven by DATA, not a branch: an empty array here must route every
   *  candidate exactly as `routeFollowupsToRegistry` did before this arm existed, and a table with
   *  an added row must decline a fresh candidate with no change to this function's own code. */
```

## `followupProposalId` (function)

`src/lib/retro.ts` lines 3048-3053 at the base commit.

```
/** Stable, deterministic registry id for one followup candidate. `entryId` already carries
 *  `mineFollowups`'s own uniqueness key (`run_id:ts:index`), so prefixing it is enough — the
 *  SAME entry always re-resolves to the SAME proposal id, which is what lets
 *  `updateProposalRegistry`'s own existing-id check (mirrored below) refuse to re-add it on a
 *  later pass. Never derived from `text`: the free-prose entry can be re-harvested verbatim and
 *  must still resolve to the id it was filed under the first time. */
```

## routeFollowupsToRegistry — the five refusal arms

`src/lib/retro.ts` lines 3058-3096 at the base commit.

```
/**
 * Route one `mineFollowups` harvest into the ACTIVE-proposal registry — the single writer
 * (inbox.ts's `updateProposalRegistry`) board-review.ts/rule-efficacy.ts/feedback-docket.ts
 * already use — replacing "nobody reads this markdown section" with an actual consumer.
 *
 * FIVE REFUSAL ARMS, each named on its own outcome, neither re-implemented here:
 *   - `"title-dedup"`: `harvest.deduped` — `mineFollowups`'s OWN `followupMatchesTitle` arm,
 *     the existing duplicate refusal this function reuses verbatim rather than re-scoring.
 *   - `"type-not-plan-shaped"`: {@link FOLLOWUP_TYPE_ROUTES} says the entry's type is not
 *     routable — the type definition decided above, cited, never re-guessed per call.
 *   - `"settled-question"` (W1-T2645): {@link findSettledQuestion} says the entry's text
 *     proposes a remedy the plan has already, on record, decided against (seeded with the one
 *     row four independent recurrences justify — a hand-written task `status:` field flip).
 *     Checked before dispatch-only/self-referential: a candidate re-deciding a settled question
 *     should never reach a drafting slot regardless of how it otherwise reads.
 *   - `"self-referential"` (W1-T2617): {@link isSelfReferentialFollowup} says the entry's own
 *     ask IS the task that declared it ("implement <taskId>" naming its own `taskId`) — routing
 *     it would mint a duplicate of a plan record (task or shipped PR) that already exists on
 *     whichever side of the merge the declaring task falls. Checked after the more-specific
 *     type and dispatch-only refusals but before minting: a self-referential "task" entry is the
 *     exact shape 21-of-23 measured rows carried and would otherwise be proposed unchecked.
 *   - `"dispatch-only"` (W1-T2613): the entry's whole content is a bare ask to dispatch its own
 *     already-filed originating task ({@link dispatchOnlyReferent}) — no other action-verb marker,
 *     so ratifying it could only duplicate a task already in the plan. See that function's own
 *     doc for the exact test and the false-decline risk it knowingly accepts.
 *
 * EVERY MINTED PROPOSAL CARRIES `evidenceAnchors: []`, STATED, NEVER SYNTHESIZED. A
 * `FollowupEntry` is free prose with no `git grep`-able pattern (Q2 of this task's own
 * rationale); inventing one would hand `classifyProposal`'s evidence arm a fabricated claim
 * nobody actually asserted. The candidate's OWN `runId`/`taskId`/`prUrl` rides instead, verbatim,
 * in the proposal's `summary` — sufficient for ATTRIBUTION (where the claim came from), never
 * for the evidence-anchor arm (what is still true on a ref) — the referent/anchor distinction
 * this task's rationale draws.
 *
 * IDEMPOTENT: a candidate already present in the registry (same {@link followupProposalId}, a
 * prior pass having already routed it) is never re-added — `updateRegistry`'s own existing-id
 * check, read fresh under its lock, same discipline board-review.ts's `diagnoseBoardFindings`
 * wiring already relies on.
 */
```

## Follow-up retirement (W1-T2563)

`src/lib/retro.ts` lines 3188-3224 at the base commit.

```
// ── Follow-up retirement (W1-T2563) ─────────────────────────────────────────────────────────
//
// `routeFollowupsToRegistry` above appends every routable candidate; its own idempotence check
// (`existingIds`) refuses to re-add one already present — correct, and NOT this gap. THE GAP IS
// THAT NOTHING EVER REMOVES ONE. MEASURED 2026-09-01: the registry held 317 proposals, every one
// `followup:`-prefixed, against 16 two days earlier that were all `board-review:` — the registry
// only grows.
//
// W1-T2451 solved the SAME shape for board-review findings by keying retirement off a referent
// (`Proposal.originatingItemId`, a `BoardItem.id`) whose live/resolved state a batched read
// supplies. A routed follow-up CANNOT be retired the same way: `evidenceAnchors: []` is
// permanent by design (a `FollowupEntry` is free prose with no git-grep-able pattern —
// synthesizing one would fabricate a claim nobody asserted, see `routeFollowupsToRegistry`'s own
// doc), so an anchor-drift check would read vacuously true for every followup and retire the
// whole population on its first pass.
//
// THE REFERENT THIS FAMILY DOES CARRY is the originating TASK (`FollowupCandidate.taskId`) —
// stated, verbatim, in the minted proposal's own summary (`... — from <taskId> (run ...)`),
// never as a structured field: `Proposal.originatingItemId` is board-review's OWN referent
// vocabulary (inbox.ts, `UnderstoodRequest.threadId`'s doc: "reusing the field would wire this
// proposal into the board-referent-retirement mechanism for a referent it can never resolve")
// and a follow-up's taskId is not a `BoardItem.id`. {@link followupOriginatingTaskId} recovers
// it by PARSING THE SUMMARY AT READ TIME — the exact discipline W1-T2460's own
// `deriveLegacyReferent` established for board-review ids minted before a structured field
// existed — so this needs no registry migration and no change to `routeFollowupsToRegistry`'s
// own mint shape.
//
// THE SIGNAL: the originating task has MERGED. Chosen because it is the one candidate already
// AVAILABLE without new machinery — not because it is reliable. IT IS NOT: a merged task can
// leave real follow-up work undone, so this signal retires some LIVE candidates alongside
// genuinely settled ones. This task's own rationale weighed the other two candidates and found
// each weaker for a first cut — title-supersession needs the paraphrase-blind match W1-T2455
// measured at 3 of 32 (too weak to lean on as though it were strong), and bare age states only
// "nothing has picked this up", never "resolved". EVERY RETIREMENT OUTCOME NAMES THIS RISK
// EXPLICITLY in its own `reason` — never a silent "this one is definitely done" — because every
// candidate signal here has a false-retirement cost and a mechanism that claims none has not
// measured it.
```

## `FollowupReferentRead` (type)

`src/lib/retro.ts` lines 3226-3232 at the base commit.

```
/**
 * The ONE batched read this retirement pass needs: which task ids (of the routed follow-ups'
 * OWN `taskId` referents) have merged, read ONCE per pass — never a read per proposal, mirroring
 * inbox.ts's `BoardReferentRead` (W1-T2451). `"unreadable"` means the whole batched read failed
 * (GitHub/ledger unavailable): every followup proposal is left exactly as it is — cannot-observe
 * means WAIT (W1-T130), never a guessed retirement.
 */
```

## `followupOriginatingTaskId` (function)

`src/lib/retro.ts` lines 3235-3244 at the base commit.

```
/**
 * Recover a routed follow-up's originating task id from its OWN minted summary —
 * `routeFollowupsToRegistry`'s `... — from <taskId> (run ...)` shape, parsed at read time rather
 * than stored as a structured field (see this section's own header doc for why). Returns
 * `undefined` for anything that is not a `followup:`-prefixed proposal, or whose summary does
 * not match the shape this module itself mints (a hand-edited or foreign entry) — a caller must
 * never guess a referent for either, so such a proposal is simply left alone by
 * {@link retireSettledFollowups}, mirroring how a board-review id `deriveLegacyReferent` cannot
 * parse falls through to "live" rather than a guessed retirement.
 */
```

## `FollowupRetireOutcome` (interface)

`src/lib/retro.ts` lines 3250-3252 at the base commit.

```
/** One proposal this pass actually retired, naming BOTH what settled it and the false-positive
 *  risk that decision carries — acceptance: "the retirement names which still-live candidates it
 *  wrongly removes, rather than claiming none". */
```

## `retireSettledFollowups` (function)

`src/lib/retro.ts` lines 3270-3284 at the base commit.

```
/**
 * Retire every routed follow-up whose originating task has merged — the missing counterpart to
 * `routeFollowupsToRegistry`'s append-only write, closing this task's own gap ("nothing anywhere
 * removes a followup-prefixed proposal"). Unlike board-review's referent retirement
 * (`classifyProposal`, inbox.ts), which keeps a resolved proposal in the registry forever as a
 * record and only changes how it RENDERS, this ACTUALLY REMOVES the entry from the registry
 * through the single writer — the growth this task measures (317 proposals, all followup-
 * prefixed) is a registry-SIZE problem, not only a rendering one, so the fix has to shrink it.
 *
 * `read.kind === "unreadable"` retires nothing and returns `[]` — cannot-observe means WAIT, the
 * same discipline inbox.ts's own board-referent resolution applies when its batched read fails.
 *
 * ONE registry write for the whole pass (never one call per proposal), mirroring
 * `routeFollowupsToRegistry`'s own single-write discipline above.
 */
```

## `followupSummaryText` (function)

`src/lib/retro.ts` lines 3326-3330 at the base commit.

```
/** Parse a routed follow-up's own free-text `text` back out of its minted `summary` —
 *  `routeFollowupsToRegistry`'s `follow-up harvest [type]: <text> — from <taskId> (run ...)`
 *  shape, the SAME string this whole followup family already parses for its `taskId` referent
 *  (see {@link followupOriginatingTaskId}'s own doc for why a structured field is never used).
 *  Returns `undefined` for anything that does not match the shape this module itself mints. */
```

## `FollowupPruneOutcome` (interface)

`src/lib/retro.ts` lines 3335-3337 at the base commit.

```
/** One proposal this pass actually removed, naming what it matched — mirrors
 *  {@link FollowupRetireOutcome}'s shape so a caller already familiar with retirement outcomes
 *  reads this one for free. */
```

## `pruneSelfReferentialFollowups` (function)

`src/lib/retro.ts` lines 3356-3372 at the base commit.

```
/**
 * Apply {@link isSelfReferentialFollowup}'s own predicate — parsed back off each already-minted
 * `followup:`-prefixed proposal's `summary` rather than a `FollowupCandidate`, since the
 * population this heals predates the admission arm and was never re-offered as a candidate — to
 * every proposal currently in the registry, and remove every match through the single writer in
 * ONE write for the whole pass, exactly as {@link retireSettledFollowups} does for its own signal.
 *
 * NEEDS NO BATCHED READ AT ALL: unlike `retireSettledFollowups`'s merged-task set (one read per
 * pass, `"unreadable"` means wait), this predicate is local to each proposal's own summary text —
 * the same "no referent read" property {@link isSelfReferentialFollowup} carries at admission
 * time — so it runs identically for a still-queued declaring task and a merged one, and a second
 * pass over an already-pruned registry finds nothing left to remove (idempotent).
 *
 * A proposal outside the `followup:` family, or a hand-authored/foreign summary this module did
 * not mint, is left exactly alone — {@link followupOriginatingTaskId} and
 * {@link followupSummaryText} both return `undefined` for either, and neither is ever guessed.
 */
```

## `ProceduralPhraseDeps` (interface)

`src/lib/retro.ts` lines 3406-3411 at the base commit.

```
/**
 * Injected phrasing dependency — receives ONLY the already-mined {@link
 * ProceduralCandidate}, never raw ledger records or other candidates
 * (mirrors learnings.ts's `PromotionJudgeDeps.judge` shape: evidence is
 * deterministic, the model only phrases/judges over it).
 */
```

## `ProceduralLearningDraft` (interface)

`src/lib/retro.ts` lines 3416-3422 at the base commit.

```
/**
 * ONE draft, shaped to become a `LearningEntry` (learnings.ts) once the
 * Architect ratifies it into a `learnings/*.yaml` shard — same fields, NO
 * parallel store. `subsystem: "procedural"` is the only tag distinguishing
 * it; once admitted it rides the EXACT SAME `active|superseded|quarantined`
 * lifecycle and `selectLearnings` matcher as any other entry.
 */
```

## `phraseProceduralCandidate` (function)

`src/lib/retro.ts` lines 3436-3444 at the base commit.

```
/**
 * PHRASE one mined candidate into a {@link ProceduralLearningDraft}. The
 * ONLY step in this whole pipeline that touches an LLM — `deps.phrase`
 * receives NOTHING but the candidate {@link mineProceduralCandidates}
 * already computed (never the ledger, never sibling candidates), so a
 * stubbed `deps` proves the evidence/phrasing split by construction: a test
 * asserting the stub's received argument deep-equals the input candidate is
 * the falsifier.
 */
```

## PROMOTION PROPOSALS (W1-T1059)

`src/lib/retro.ts` lines 3459-3479 at the base commit.

```
// ── PROMOTION PROPOSALS (W1-T1059) ─────────────────────────────────────────
//
// `runPromotionPass` (learnings.ts) shipped under P32/W1-T146 with NO production
// caller, so `promotion.scrub`/`promotion.verdict`/`promotion.promoted` could never
// fire. This section is the caller's PURE half: it turns one pass's results into a
// rendered PROPOSAL for the Architect to ratify. It writes nothing, anywhere — a
// promoted entry reaches disk only through a reviewed PR (shard design (ii): "the
// machine never ratifies on its own judgment"). The I/O half — loading the corpus and
// supplying the judge — lives at the call site in run-task.ts, split out so every
// decision below is a pure function with its own test.
//
// WHY THIS CLASSIFIER DOES NOT REUSE `PromotionStage`. `PromotionResult.stage` answers
// `"judge"` for TWO DISTINCT OUTCOMES: a judge that decided `project-specific` (a
// considered NO) and a judge that said `broadly-applicable` below the confidence
// threshold (uncertainty, which by `planPromotionFromVerdict`'s own doc must never
// promote). Only the free-text `reason` separates them. That is a real
// one-value-for-several-outcomes conflation and it is REPORTED, NOT FIXED here —
// learnings.ts is deliberately outside this task's declared `files:` (shard design
// (vi)), and widening it would be fixing a second concern in silence. This module
// therefore reads `verdict.applicability` and `verdict.confidence` directly rather than
// branching on `stage`, so the two stay distinguishable in the report an Architect reads.
```

## `PromotionDisposition` (type)

`src/lib/retro.ts` lines 3481-3481 at the base commit.

```
/** What one {@link PromotionResult} means for the Architect, with the two `stage: "judge"` outcomes kept apart. */
```

## `classifyPromotionResult` (function)

`src/lib/retro.ts` lines 3489-3495 at the base commit.

```
/**
 * The pure decision on ONE promotion result (Standing rule 12 — judgment is advisory,
 * acting on it is a pure function). One arm per outcome, and never a shared arm for two:
 * a scrub block, a top-layer entry, a considered `project-specific` NO and a
 * below-threshold `broadly-applicable` call are four different things to a reader
 * deciding what to ratify.
 */
```

## `renderPromotionProposals` (function)

`src/lib/retro.ts` lines 3520-3526 at the base commit.

```
/**
 * Render one pass as a retro-report section. THREE ZERO-LOOKING STATES ARE KEPT APART,
 * because collapsing them is how "built and unreachable" stayed invisible for as long as
 * it did: the pass did not run (no judge), the pass ran over an EMPTY corpus, and the
 * pass ran over a real corpus and proposed nothing. Only the third is a finding about
 * the corpus.
 */
```

## Consolidation contradiction detection (W1-T88, ratifies P14, extends W1-T33)

`src/lib/retro.ts` lines 3571-3596 at the base commit.

```
// ── Consolidation contradiction detection (W1-T88, ratifies P14, extends W1-T33) ──
//
// W1-T33 gave supersession a LIFECYCLE (active|superseded|quarantined) but
// marking an entry superseded is MANUAL, and nothing DETECTS when a
// newly-distilled learning CONTRADICTS an existing one — recency silently
// wins, which is correct for a REFINEMENT but wrong for a CONTRADICTION (a
// wrong late lesson could bury a right early one with no signal). This
// section is the missing DETECTION step, same three-stage discipline as
// procedural-success mining above: (1) candidate PAIRS are found
// DETERMINISTICALLY (rule 2 — {@link keyContradictionCandidates} never
// touches an LLM), (2) an advisory judge is asked, PER PAIR, whether the two
// facts OPPOSE ({@link flagContradictions} — the ONLY step that touches an
// LLM, mirroring {@link ProceduralPhraseDeps}'s injected-`deps.judge` shape),
// (3) an opposing verdict is NEVER auto-resolved — {@link
// applyContestedLifecycle} flips BOTH entries to `lifecycle: contested`
// (learnings.ts's `selectLearnings` already excludes anything not
// `lifecycle === "active"`, so a contested pair is excluded from injection
// for free — no new filter needed) and the pair is rendered into the retro
// report ({@link renderContradictions}) and the §2 question backlog
// ({@link contradictionQuestion}, worker.ts's `QuestionEntry`/
// `appendQuestion`), naming the decision an Architect must make: which one
// governs. Resolution is a SEPARATE, explicit, Architect-authored step
// ({@link applyContradictionResolution}) that ledgers the decision — no code
// path in this file ever picks a winner itself. A non-opposing (refining)
// pair is simply never flagged: recency-overwrite for ordinary supersession
// is completely untouched.
```

## `ContradictionCandidatePair` (interface)

`src/lib/retro.ts` lines 3598-3606 at the base commit.

```
/**
 * ONE deterministically-keyed candidate pair for opposition judging: two
 * currently-`active` entries sharing the SAME `subsystem` (the topic key)
 * with >=1 overlapping `files` glob (exact string overlap — the same
 * discipline `matchCount` in learnings.ts uses for concrete file matches,
 * kept simple and auditable rather than a fuzzy glob-intersection). `key` is
 * the deterministic grouping key (`${subsystem}:${sharedGlobs}`), stable
 * across calls for the same pair regardless of scan order.
 */
```

## `keyContradictionCandidates` (function)

`src/lib/retro.ts` lines 3618-3626 at the base commit.

```
/**
 * MINE every candidate contradiction pair, PURE and deterministic — no LLM,
 * no I/O; calling it twice over the SAME corpus returns the SAME pairs. Only
 * `lifecycle === "active"` entries are considered (a `superseded`/
 * `quarantined`/already-`contested` entry is never re-proposed — it either
 * already lost a resolution or was pulled for an unrelated reason). Iterates
 * entries SORTED BY ID first so pair order — and therefore `key` — never
 * depends on the corpus's on-disk/array order.
 */
```

## `ContradictionJudgeDeps` (interface)

`src/lib/retro.ts` lines 3654-3658 at the base commit.

```
/**
 * Dependencies {@link flagContradictions} needs injected — mirrors {@link
 * ProceduralPhraseDeps}/learnings.ts's `PromotionJudgeDeps.judge`: evidence
 * (the candidate pair) is deterministic, the model only JUDGES over it.
 */
```

## `flagContradictions` (function)

`src/lib/retro.ts` lines 3676-3681 at the base commit.

```
/**
 * Judge every candidate pair and return ONLY the ones flagged opposing — a
 * non-opposing (refining) pair produces NO finding, so it never gets marked
 * contested and ordinary recency-overwrite for it is untouched. Pairs are
 * judged independently and in order; nothing here mutates `pair.a`/`pair.b`.
 */
```

## `applyContestedLifecycle` (function)

`src/lib/retro.ts` lines 3704-3715 at the base commit.

```
/**
 * NEVER AUTO-RESOLVED: flip BOTH entries of every confirmed finding to
 * `lifecycle: contested`, recording each entry's partner via
 * `contestedWith`. Pure — returns a NEW array, never mutates `entries` — and
 * leaves every entry untouched by a finding exactly as it was (including an
 * entry whose `lifecycle` was already `superseded`/`quarantined` for an
 * unrelated reason; a finding can only originate from an `active` pair per
 * {@link keyContradictionCandidates}, so this never overwrites a prior
 * decision). Once flipped, `learnings.ts`'s `selectLearnings` excludes both
 * from injection automatically — `contested` is filtered exactly like
 * `superseded`/`quarantined`, no new matcher logic needed.
 */
```

## `contradictionQuestion` (function)

`src/lib/retro.ts` lines 3749-3755 at the base commit.

```
/**
 * Render ONE finding into the §2 QUESTION contract's own shape (worker.ts's
 * `QuestionEntry`) for the durable question backlog (mirrors sweep.ts's
 * `toQuestionEntry`) — `current_assumption` names what stays true while the
 * pair is unresolved: BOTH entries stay excluded from injection, never one
 * silently winning by recency.
 */
```

## `ContradictionResolution` (interface)

`src/lib/retro.ts` lines 3769-3775 at the base commit.

```
/**
 * An Architect-authored decision for ONE contested pair: `activeId` governs
 * (re-admitted to injection), `supersededId` loses (marked `superseded`,
 * `supersededBy: activeId`). There is deliberately NO code path that derives
 * this from the judge's verdict or from recency — a human (or the Architect
 * worker, standing rule 15) must name the winner explicitly.
 */
```

## `applyContradictionResolution` (function)

`src/lib/retro.ts` lines 3791-3801 at the base commit.

```
/**
 * APPLY a resolution: `activeId` is re-admitted (`lifecycle: active`,
 * `contestedWith` cleared), `supersededId` is marked `superseded` +
 * `supersededBy: activeId` (`contestedWith` cleared there too). Appends ONE
 * `contradiction.resolved` ledger line naming both ids, `by`, and `reason` —
 * the durable, ledgered record standing rule 15 requires for any learnings
 * write. Entries not named in `resolution` are returned untouched. This is
 * the ONLY function in this module that ever assigns `active`/`superseded`
 * to a previously-`contested` entry — every other path here only ever
 * PROPOSES `contested`, never resolves it.
 */
```

## Citation mining (W1-T419)

`src/lib/retro.ts` lines 3831-3847 at the base commit.

```
// ── Citation mining (W1-T419) ───────────────────────────────────────────────
//
// selectLearnings (learnings.ts) already tiebreaks on `cited` after file-relevance and layer —
// this corpus has the RANKING half of the Stack-Overflow-shaped loop. The signal feeding it was
// dead: entries carried hand-stamped `cited` dates from the consolidation era, and origin/main's
// full commit history carried effectively zero `learnings#<id>` citations (2 bare-prefix hits, no
// ids, measured at db22bd8). This section mines the two real evidence sources —
//   (a) `learnings.injected` ledger rows' `matched_ids` (run-task.ts, this same task's design
//       (i) — the id list sitting beside the pre-existing count) via lib/ledger-grep.ts's
//       archive+live union, and
//   (b) `learnings#<id>` mentions in git-log commit subjects/bodies, the citation form the
//       rationale's `git log --format='%s%b' | grep -c 'learnings#'` measured —
// and stamps `cited` (latest evidence date) + `cited_count` (total occurrences) onto each ACTIVE
// entry. An id with no evidence in either source is left untouched — the budget ratchet
// (scripts/learnings-budget-ratchet.mjs) renders that absence as `never-cited`, never as zero or
// an omission. selectLearnings' ranking is UNCHANGED by any of this: it already reads `cited`,
// this section only makes that field carry a measured value instead of a hand-stamped one.
```

## `CitationEvidence` (interface)

`src/lib/retro.ts` lines 3849-3849 at the base commit.

```
/** One evidence occurrence for a learning id — WHEN it was cited, regardless of source. */
```

## `mineLedgerCitations` (function)

`src/lib/retro.ts` lines 3856-3863 at the base commit.

```
/**
 * Mine `learnings.injected` ledger rows for per-id citation evidence — one {@link
 * CitationEvidence} per id per row's `matched_ids`. A PRE-TASK row (every row before this task
 * shipped: it logs `matched` as a bare count with no `matched_ids` array at all) contributes
 * NOTHING, never a throw — old-format rows are the expected majority of history, not a parse
 * error (W1-T419 design iv's falsifier). A malformed/non-array `matched_ids`, or a non-string
 * entry within it, is skipped the same way rather than crashing the pass.
 */
```

## `GitLogCommit` (interface)

`src/lib/retro.ts` lines 3878-3883 at the base commit.

```
/**
 * One git-log commit reduced to just what {@link mineGitLogCitations} needs — a caller resolves
 * these from `git log --format=...` however its own environment shells out (this repo's `rmd`
 * CLI, a retro script, or a test fixture); this module stays a PURE reducer over already-read
 * text, the same discipline {@link parseLedger} keeps for ledger lines.
 */
```

## `mineGitLogCitations` (function)

`src/lib/retro.ts` lines 3889-3894 at the base commit.

```
/**
 * Mine git-log commit messages for `learnings#<id>` citations — ONE {@link CitationEvidence} per
 * (commit, id) pair, deduplicated WITHIN a commit so a message citing the same id twice (once in
 * the subject, once in a body bullet) counts as one piece of evidence rather than inflating
 * `cited_count` per mention.
 */
```

## `pattern` (const)

`src/lib/retro.ts` lines 3897-3900 at the base commit.

```
  // Ids in this corpus are alphanumeric + hyphen only (no `.`/`_` — verified against every
  // learnings/*.yaml id at filing time), so the class stops short of `.` deliberately: a
  // sentence-ending period right after an id (`...see learnings#foo.`) must never be captured
  // into the id itself.
```

## `aggregateCitationEvidence` (function)

`src/lib/retro.ts` lines 3918-3924 at the base commit.

```
/**
 * Reduce raw {@link CitationEvidence} — from any number of sources, ledger and git-log alike, the
 * caller concatenates before calling this — into ONE {@link CitationStamp} per id: `citedCount`
 * sums every occurrence, `cited` is the latest date seen. An id with zero evidence across all
 * sources has no key in the returned map; {@link stampCitations} leaves such an entry's
 * `cited`/`citedCount` exactly as it already was.
 */
```

## `stampCitations` (function)

`src/lib/retro.ts` lines 3939-3946 at the base commit.

```
/**
 * Stamp mined citation evidence onto every ACTIVE entry — pure, returns a NEW array (same
 * discipline as {@link applyContestedLifecycle}), never mutates `entries`. Only entries WITH
 * measured evidence this cycle change; an entry absent from `evidence` keeps whatever
 * `cited`/`citedCount` it already carried — a mining pass that simply found nothing new never
 * blanks an entry back to unevidenced. A non-active entry (superseded/quarantined/contested) is
 * never stamped: selectLearnings never injects it, so citation evidence for it is moot.
 */
```

## `changedCitationStamps` (function)

`src/lib/retro.ts` lines 3956-3965 at the base commit.

```
/**
 * W1-T1248: THE PRODUCTION CALLER for the four citation miners above shipped under W1-T419 with
 * none — this is the write half. Which ids' `cited`/`citedCount` actually MOVED between `entries`
 * and what {@link stampCitations} would write given `evidence` — an entry with no evidence this
 * cycle, or a non-active (superseded/quarantined/contested) entry, is UNCHANGED (byte-identical)
 * in `stampCitations`' own return, so it never appears here. This is deliberately the exact set
 * {@link stampCitationsAndCommit} is scoped to write to disk: a mining pass that finds nothing new
 * must produce a NO-OP diff, never a touched-but-unchanged shard file, and a superseded entry can
 * never be resurrected onto disk by a stamp it was never eligible for in memory either.
 */
```

## `EntryBlockLocation` (interface)

`src/lib/retro.ts` lines 3982-3996 at the base commit.

```
/**
 * Text-surgery stamp of ONE learning entry's `cited`/`cited_count` fields within a shard's raw
 * YAML text — mirrors scripts/learnings-assert-check.mjs's `quarantineEntryInText` discipline
 * (that script's own header names the reason): touches only the lines that change, never
 * round-trips the whole document through the `yaml` stringifier, which would reflow EVERY other
 * entry's block scalars (`fact: >-`) and flow sequences (`files: [...]`) into a noisy whole-file
 * diff on every retro cycle. A no-op (returns `text` unchanged, referentially) when `id`'s block
 * is not present in this shard's text — callers loop every stamp over every shard file without
 * needing to know up front which file owns which id (mirrors `loadLearningsCorpus`'s own
 * "current directory of the whole corpus" discovery, never a maintained id->file index for this).
 *
 * Adds a `cited_count` line immediately after `cited` when the entry doesn't carry one yet (true
 * of all 38 entries at this task's filing — every one was hand-stamped with `cited` alone); once
 * present, a later stamp updates it in place like `cited` itself.
 */
```

## `locateEntryBlock` (function)

`src/lib/retro.ts` lines 4003-4007 at the base commit.

```
/** Locate ONE learning entry's block (from its `- id: <id>` header up to, but excluding, the
 *  next entry's header or end-of-text) within a shard's raw YAML text. Shared by {@link
 *  stampCitationInShardText} (the write) and {@link extractEntryBlock}/{@link
 *  captureCitationBaselines} (the W1-T1267 baseline capture/compare) so both agree, byte for
 *  byte, on where one entry ends and the next begins. */
```

## `extractEntryBlock` (function)

`src/lib/retro.ts` lines 4021-4025 at the base commit.

```
/** W1-T1267: read-only counterpart to {@link locateEntryBlock} — the raw text of one entry's
 *  block, or `undefined` when `id` has no block in `text` at all (a different shard, a stale id,
 *  or an id genuinely absent from this ref). Used both to CAPTURE a baseline (design ii, "the
 *  entry block the decision was made against") and to read the FRESH block a baseline is later
 *  compared to — never to write; {@link stampCitationInShardText} owns every actual edit. */
```

## `trailingWs` (const)

`src/lib/retro.ts` lines 4040-4042 at the base commit.

```
    // No prior `cited:` line (a freshly-added entry, never yet hand-stamped or mined) — append
    // right before the block's trailing whitespace, the same "no anchor to replace" fallback
    // learnings-assert-check.mjs's own quarantineEntryInText uses.
```

## `captureCitationBaselines` (function)

`src/lib/retro.ts` lines 4056-4064 at the base commit.

```
/**
 * W1-T1267: read, for each id in `ids`, the RAW block text as it stands in `learningsDir` RIGHT
 * NOW — "the entry block the decision was made against" (design ii). Callers invoke this
 * immediately after computing `changed` (the same corpus read {@link changedCitationStamps}'
 * eligibility decision came from), so the returned map is the "plan time" baseline the write
 * phase later compares a FRESH read against. An id absent from every shard here is simply
 * absent from the returned map — {@link stampCitationsAndCommit}'s own no-op-when-absent
 * behavior stays the single source of truth for "this id isn't in this corpus".
 */
```

## `compareCitationBaseline` (function)

`src/lib/retro.ts` lines 4117-4124 at the base commit.

```
/**
 * W1-T1267: compare the entry block the eligibility decision was made against (`baseline`,
 * design ii) with a FRESH read of the same id's CURRENT block (`fresh`). Returns `undefined`
 * when nothing outside `cited`/`cited_count` moved — the write may proceed. Otherwise names the
 * id, the first differing field, and both of its values (design iii) — never merely "entry
 * changed". `fresh === undefined` means the id's block is genuinely gone from the fresh read
 * (not "we couldn't get a fresh read at all" — callers only invoke this once they HAVE one).
 */
```

## Every compared line matched but the

`src/lib/retro.ts` lines 4138-4140 at the base commit.

```
  // Every compared line matched but the loop above would have already returned on the first
  // divergence in length (one side has `""` where the other has a real line) — kept as a
  // defined fallback rather than silently treating a real mismatch as "no change".
```

## `defaultFreshShardTextReader` (function)

`src/lib/retro.ts` lines 4144-4157 at the base commit.

```
/**
 * W1-T1267: default `readFreshShardText` for {@link stampCitationsAndCommit} — one `git fetch`
 * (memoized across every shard this call checks, only paid when a baseline actually needs
 * checking) then `git show origin/main:<relPath>`, the SAME "read the blob, never the working
 * tree" idiom `syncPlanFromOrigin` (run-task.ts) already uses for the plan. This is what closes
 * the window the task's rationale names: the worktree's OWN `learnings/` copy is origin/main AS
 * OF THE CUT and is never refreshed for the rest of the retro — re-reading it would see nothing
 * a concurrent lane merged since. Only a fresh read of origin/main's CURRENT ref can.
 *
 * Best-effort like the rest of this pass: no `origin` remote, no network, or the path not (yet)
 * existing at `origin/main` all resolve to `undefined` — "no signal available" — rather than a
 * false refusal. {@link stampCitationsAndCommit} treats that as "skip the guard for this id",
 * the same as if no baseline had been supplied at all.
 */
```

## stampCitationsAndCommit — stamp-only, and the W1-T1267 refusal

`src/lib/retro.ts` lines 4193-4215 at the base commit.

```
/**
 * Apply every {@link changedCitationStamps} entry onto its shard's raw text via {@link
 * stampCitationInShardText}, `git add` the touched shards, and commit ONLY if something actually
 * staged — mirrors {@link "./plan-pr-emitter.js".regeneratePlanIndexAndCommit}'s
 * write/add/diff-cached-quiet/commit-if-changed discipline (design (iv): "commit the stamped
 * corpus the way generated docs are already committed"). That helper is not imported here to
 * avoid a retro.ts -> plan-pr-emitter.ts dependency neither module otherwise needs; this repeats
 * the same three `git` calls rather than sharing them, the same way `probeGithubThrottle` above
 * repeats its own `gh` call instead of threading a shared gateway through for one line of reuse.
 *
 * PASS ONE, STAMP ONLY (design ii): this never adds an entry, drops one, or touches `lifecycle` —
 * `stampCitationInShardText` is a two-line surgical edit, nothing else in a shard moves, and an
 * empty `changed` map (nothing newly evidenced) short-circuits before touching disk or git at
 * all, so a quiet retro cycle produces a genuinely empty diff, not an empty commit.
 *
 * W1-T1267: `baselines` (see {@link captureCitationBaselines}) carries, per id, the entry block
 * the eligibility decision was made against. When present for an id, this function re-reads that
 * id's CURRENT block via `readFreshShardText` (default: a real `origin/main` — see {@link
 * defaultFreshShardTextReader}) immediately before writing, and REFUSES (design iv: drops for
 * this cycle, never retries, never blocks any other id) when anything outside the two stamped
 * lines moved. An id with no baseline entry — including every call site that predates this task
 * and passes no `baselines` at all — gets no guard, unchanged from before this task.
 */
```

## `mismatch` (const)

`src/lib/retro.ts` lines 4259-4261 at the base commit.

```
          // A real fresh read — a genuine signal either way (design ii/iv). `fresh === undefined`
          // (no origin remote, offline, shard not yet on origin/main) means no signal at all —
          // fall through and stamp exactly as if no baseline had been supplied.
```

## `mast_category_counts` (field)

`src/lib/retro.ts` lines 4303-4306 at the base commit.

```
  /** W1-T89/P18: this cycle's `RetroGather.mast.byCategory`, carried forward so
   *  the NEXT retro's render can show a trend column. Optional/backward-compatible
   *  — a marker written before this field existed just yields no trend, never a
   *  parse failure (loadMarker below does no schema validation on this key). */
```

## `MarkerCorruptError` (class)

`src/lib/retro.ts` lines 4310-4318 at the base commit.

```
/**
 * Thrown by loadMarker when state/last-retro.json EXISTS but fails to parse -- a torn
 * write, manual corruption, or a foreign format. This is DISTINCT from the marker
 * being genuinely absent (RetroMarker | undefined, the only legitimate
 * first-ever-retro signal): a corrupt-but-present marker must never be silently
 * collapsed into "no marker" the way the pre-fix reader did, because that replays the
 * whole already-consumed run window and double-counts SHIPPED/learnings. Every caller
 * MUST fail closed on this (abort the retro), never catch-and-treat-as-undefined.
 */
```

## `resolveMarkerForGather` (function)

`src/lib/retro.ts` lines 4360-4373 at the base commit.

```
/**
 * Resolve the last-retro marker for the gather step. A caller (retroCommand) MUST
 * branch on `.kind` rather than reduce this back to `marker | undefined`, because
 * "absent" and "corrupt" require OPPOSITE handling:
 *  - "absent"  — genuinely no marker has ever been written. The ONLY state that
 *                legitimately widens the gather to the full run history
 *                (sinceTs=undefined) — this is the real first-ever-retro case.
 *  - "corrupt" — the marker file exists but failed to parse (a torn write, manual
 *                edit, ...). MUST fail closed and abort — never fall through to
 *                "absent"'s full-history gather, which would reprocess the run
 *                window the corrupt marker already recorded as consumed and
 *                double-count SHIPPED/learnings.
 *  - "ok"      — a valid marker; gather scopes to sinceTs = marker.ts.
 */
```

## `saveMarker` (function)

`src/lib/retro.ts` lines 4384-4392 at the base commit.

```
/**
 * Save the last-retro marker as ONE atomic unit: staged into a same-directory temp
 * file with a single writeSync call, then swapped into place with a single
 * renameSync (atomic on any POSIX filesystem). A plain writeFileSync here would let
 * a reader (loadMarker) observe a torn/partial file mid-write and — pre-fix — that
 * torn read was misread as FIRST-EVER-RETRO, reprocessing the whole already-consumed
 * run window and double-counting SHIPPED/learnings. The rename swap makes that torn
 * state unreachable: a reader only ever sees the whole old file or the whole new one.
 */
```

## `DEFAULT_RETRO_MERGES_THRESHOLD` (const)

`src/lib/retro.ts` lines 4420-4422 at the base commit.

```
/** Policy-data default: fire once at least this many merges have landed since
 *  the marker. Overridable via {@link RetroTriggerPolicy} — never hardcode a
 *  literal 25 at a call site. */
```

## `followupsThreshold` (field)

`src/lib/retro.ts` lines 4437-4445 at the base commit.

```
  /**
   * W1-T2289 — OPTIONAL. Fire once at least this many unharvested `report.followups` candidates
   * are pending — the retro's OWN input depth, as distinct from `mergesThreshold`/
   * `daysThreshold`, which both describe the FLEET's shipped activity rather than what the retro
   * itself still has to process (this task's shared property). Undefined ⇒ reuses
   * `mergesThreshold`: both are "how much has piled up since the marker" counts of the same
   * rough order, and a genuinely distinct, measured number belongs in `plan/policy.yaml` as its
   * own reviewed follow-up (see this task's REPORT), not invented here without evidence.
   */
```

## evaluateRetroTrigger — the third signal and the tie-break

`src/lib/retro.ts` lines 4465-4492 at the base commit.

```
/**
 * PURE trigger predicate (W1-T160): fires on `mergesSinceMarker >=
 * policy.mergesThreshold` OR `daysSinceMarker >= policy.daysThreshold`,
 * whichever crosses first. `markerTs` undefined (no marker has ever been
 * written — the same "absent" state {@link resolveMarkerForGather} names)
 * makes `daysSinceMarker` `Infinity`, so a repo with no retro history is
 * always eligible via `reason: "days"` unless the merge count alone already
 * clears the threshold.
 *
 * W1-T2289 — A THIRD, INDEPENDENT SIGNAL: `followupsPending >=
 * (policy.followupsThreshold ?? policy.mergesThreshold)` fires with
 * `reason: "followups"`. `mergesSinceMarker`/`daysSinceMarker` both describe
 * the FLEET's shipped activity — a proxy this task's record names as the
 * shared defect — never the retro's OWN queue: the unharvested
 * `report.followups` candidates {@link mineFollowups} would otherwise mine on
 * the next real run. `followupsPending` defaults to 0, so every existing
 * caller that does not pass it is UNCHANGED. This is a WIDENING, not a
 * replacement: the two existing thresholds are checked first and keep their
 * exact prior behaviour.
 *
 * TIE-BREAK: when more than one threshold is already crossed at the SAME
 * evaluation (a daemon that was paused/down a while, or the marker-absent
 * case above with a high merge count), `reason` prefers "merges", then
 * "days" — the more informative signals, never silently masked by a
 * staleness or backlog floor. Each threshold is independently sufficient to
 * fire; this only decides which name a simultaneous crossing gets in the
 * ledger line.
 */
```

## `checkRetroIntegrity` (function)

`src/lib/retro.ts` lines 4520-4533 at the base commit.

```
/**
 * The INTEGRITY GATE (W1-T160): a HARD precondition inside the AUTOMATED
 * (daemon-triggered) retro path only — an operator-run `rmd retro` is watched
 * by a human and keeps its existing behavior unchanged. `priorMergesSinceMarker`
 * is the count the TRIGGER observed when it decided to fire (see
 * {@link evaluateRetroTrigger}); `gatherShippedCount` is the REAL gather's
 * `RetroGather.shipped.length` the retro run itself computes moments later. A
 * mismatch — the trigger saw real merge activity but the actual gather credits
 * NONE — means the credit union degraded between trigger and run (a GitHub
 * throttle, an ownership-assert rejecting everything, a gateway outage) and the
 * retro must ABORT rather than silently write on a zero-credit gather (the
 * R8-class silent under-count, now fail-closed because no human is watching an
 * unattended run to catch it).
 */
```

## `cleanRuleLine` (function)

`src/lib/retro.ts` lines 4559-4561 at the base commit.

```
/** Normalise ONE physical line of a rule: drop the `**TITLE**` emphasis the Standing rules use
 *  (it reads oddly in the rendered list) and squeeze runs of whitespace. Pure text transform — no
 *  interpretation of meaning, and DELIBERATELY per-line: it never joins a line to its neighbour. */
```

## joinRuleLines — why collapsing rules reddened every retro

`src/lib/retro.ts` lines 4566-4581 at the base commit.

```
/**
 * Join a rule's physical lines back into ONE rule string while KEEPING those lines.
 *
 * W1-T2483 — WHY THIS NO LONGER COLLAPSES. This used to fold every continuation onto one line.
 * That is not what "verbatim" means, and it broke a real gate:
 * `test/rule-15-16-filing-misattribution.test.ts` judges a citation inside a THREE-LINE window,
 * which is a proximity proxy — and proximity is a property of line breaks that a renderer owns.
 * §12's rule 27 carries the bare prose "rule 15 itself stands" about ninety lines from any wording
 * about who may file; collapsed onto one line, all ~108 of its lines became mutually adjacent and
 * the gate fired on an adjacency the plan never had, reddening EVERY retro from that rule's
 * landing onward (first observed on PR #3309). The gate is correct and is not touched.
 *
 * Blank lines are kept too, because a paragraph break is line structure as much as a wrap is —
 * and dropping them would manufacture exactly the kind of adjacency this fix exists to remove.
 * Trailing blanks are trimmed so a rule never ends in whitespace.
 */
```

## `extractStandingRules` (function)

`src/lib/retro.ts` lines 4588-4598 at the base commit.

```
/**
 * Extract the numbered "never-do" invariants from MASTER-PLAN.md's own
 * `## 12. Standing rules` section — a pure text extraction (no LLM, no
 * interpretation) so ORIENTATION.md's invariant list can never drift from
 * the source of truth by hand-copy. Each rule (numbered `N.` or `NB.` at the
 * start of a line) is returned as one collapsed, re-wrapped line; a rule's
 * continuation lines (indented markdown wrap) are folded back in. Returns
 * `[]` if the section heading is not found (fail-soft — a missing section
 * yields an empty invariants list, never a thrown error, since ORIENTATION
 * generation must never abort a retro over a heading rename).
 */
```

## `orientationBullet` (function)

`src/lib/retro.ts` lines 4651-4656 at the base commit.

```
/**
 * Render ONE standing rule as a markdown list item that KEEPS its own line breaks (W1-T2483):
 * the first line carries the bullet, and every continuation is indented two spaces so it stays
 * inside that item rather than becoming stray top-level prose. A blank line stays truly blank —
 * markdown reads an indented block after one as a further paragraph of the SAME item.
 */
```

## `renderOrientation` (function)

`src/lib/retro.ts` lines 4662-4667 at the base commit.

```
/**
 * Render docs/ORIENTATION.md: current state (the deterministic gather),
 * the next runnable task (DAG + GitHub-derived, matching `rmd drain`'s own
 * pick), and the never-do invariants (MASTER-PLAN §12, extracted verbatim).
 * Pure — no I/O; the caller writes the returned string to disk.
 */
```

## `BACKTICK_SYMBOL_RE` (const)

`src/lib/retro.ts` lines 4714-4720 at the base commit.

```
/** A backtick-quoted, function-shaped identifier a NET STATE sentence names — the retro-time
 *  mirror of review-time's `unwired_export` reason. DELIBERATELY NARROW (requires an internal
 *  case-transition or underscore): a bare CLI word (`` `rmd` ``, `` `main` ``) or a config key
 *  reads identically to a real export's name from punctuation alone, and this scan's own
 *  "silence, not a verdict" discipline (see {@link "./reachability.js".findExportDefinition}'s
 *  doc) means anything this pattern can't tell apart from ordinary prose is simply never
 *  considered — never a false claim, just nothing said about it. */
```

## `NetStateCapabilityAdvisory` (interface)

`src/lib/retro.ts` lines 4736-4738 at the base commit.

```
/** One MASTER-PLAN NET STATE capability sentence naming a symbol {@link
 *  "./reachability.js".isExportReachable} reports as unreached — the retro-time `net_state_claim`
 *  reason code (see lib/review.ts's `ReviewVerdict.unwiredAdvisories` doc for the full set). */
```

## `netStateCapabilityAdvisories` (function)

`src/lib/retro.ts` lines 4745-4754 at the base commit.

```
/**
 * THE RETRO-TIME CONSUMER (design (iii)): the SAME reachability scan the review-time consumer
 * uses (lib/review.ts's `unwired_export` reason), run over MASTER-PLAN's own NET STATE prose
 * instead of a diff. A claim naming a symbol with no caller gets an advisory line in the retro
 * report — REPORTS, never REWRITES (the doc pass is read-only by design; editing MASTER-PLAN.md
 * is explicitly NOT IN SCOPE per this task's own design doc). `netStateText` is the NET STATE
 * section's own text (the caller slices it out of MASTER-PLAN.md — this function has no opinion
 * on where that section starts/ends); `checkoutDir` is the live tree the claim is checked
 * against (retro runs against the CURRENT mainline checkout, never a PR diff).
 */
```

## `renderNetStateUnwiredAdvisories` (function)

`src/lib/retro.ts` lines 4770-4772 at the base commit.

```
/** Render {@link netStateCapabilityAdvisories}'s findings as a retro-report section — printed
 *  alongside the plan-health sweep, never blocking anything (this whole floor is advisory-only
 *  by design; see lib/review.ts's `ReviewVerdict.unwiredAdvisories` doc for the full rationale). */
```

## PLAN-STATE TRUTH RUNG (W1-T410, split from W1-T392)

`src/lib/retro.ts` lines 4787-4803 at the base commit.

```
// ── PLAN-STATE TRUTH RUNG (W1-T410, split from W1-T392) ──────────────────────────────────
//
// Re-derives every task id MASTER-PLAN.md asserts UNBUILT against the merge resolver the
// retro gather already holds (`retroCommand`'s single batched `projectPlan` pass — see
// src/run-task.ts's `planStateTruthSectionFor`). No new network call, no new gateway.
//
// THE EXTRACTOR MUST BIND THE ASSERTION TO ITS SUBJECT (design (i)). A LINE-scoped extractor
// is refuted by measurement: over MASTER-PLAN.md at 0503802, the line
//   "rejections are SIBLING (T342 ×2, T349, T350, T353, T356) — P29(i), unbuilt for an EIGHTH cycle."
// carries FIVE task ids that are sibling REJECTION COUNTS, not the unbuilt subject — the
// subject is the proposal P29(i), on the OTHER side of the em-dash. A CLAUSE-scoped extractor
// (split on the strong delimiters this prose actually uses — em-dash, semicolon — and only
// bind an id found in the SAME clause as the not-shipped phrase) reads that line correctly:
// the clause carrying "unbuilt" carries P29(i) (a proposal id, tracked separately, never
// resolved) and no task id at all, so it yields ZERO. A tighter clause, e.g.
// `*"W1-T149 did not ship"*`, keeps the id and the phrase adjacent with no delimiter between
// them, so it still binds.
```

## `NOT_SHIPPED_PHRASE_RE` (const)

`src/lib/retro.ts` lines 4805-4809 at the base commit.

```
/** One `not-shipped` phrase this rung recognises — MASTER-PLAN's own vocabulary for asserting a
 *  task/proposal is unbuilt (`Still PLANNED, not shipped` is covered by the `not shipped`
 *  alternative; the literal string is not its own pattern). No `g` flag — every use here is a
 *  single-shot `.test()` per line/clause, never a `.match()` loop, so global-flag `lastIndex`
 *  state is never at risk of leaking between calls. */
```

## `TASK_ID_RE` (const)

`src/lib/retro.ts` lines 4812-4814 at the base commit.

```
/** A task id in either its full (`W1-T149`) or bare (`T342`) form — MASTER-PLAN's prose uses
 *  both. `g`-flagged and consumed ONLY via `String.prototype.match`, which resets `lastIndex`
 *  to 0 at the start of every call (spec-guaranteed), so reuse across clauses is safe. */
```

## `PROPOSAL_ID_RE` (const)

`src/lib/retro.ts` lines 4817-4821 at the base commit.

```
/** A proposal id (`P29`, `P29(i)`, `P43(ii)`) — deliberately NOT `g`-flagged: it is consumed
 *  only via `.test()` below, and a `g`-flagged regex used with repeated `.test()` calls carries
 *  `lastIndex` across them, silently alternating match/no-match. Presence-only; no capture of
 *  which proposal, since this rung's chosen handling (design (ii)) is to report the SKIPPED
 *  COUNT rather than resolve a proposal to the task ids that implement it. */
```

## `CLAUSE_SPLIT_RE` (const)

`src/lib/retro.ts` lines 4824-4829 at the base commit.

```
/** Strong clause delimiters this prose actually uses to separate an unbuilt phrase's subject
 *  from adjacent, unrelated data on the same line (see the P29(i) sibling-rejection example
 *  above). Deliberately narrow: an en-dash (`–`, distinct from the em-dash `—` here) or a comma
 *  is NOT a clause boundary in this corpus's usage and splitting on one would sever a bound
 *  assertion (e.g. `"W1-T149 did not ship"*, and the standing rule…"` keeps id and phrase in
 *  one clause across its trailing comma). */
```

## `AssertedUnbuiltExtraction` (interface)

`src/lib/retro.ts` lines 4838-4841 at the base commit.

```
/** {@link extractAssertedUnbuiltTaskIds}'s result: the bound-to-subject task ids (deduped,
 *  normalized), how many not-shipped-phrase-bearing lines were examined (the "size of the set
 *  examined" acceptance criterion 4 requires), and how many of those lines' bound subject is a
 *  proposal id rather than a task id (design (ii) — reported, never silently dropped). */
```

## `extractAssertedUnbuiltTaskIds` (function)

`src/lib/retro.ts` lines 4848-4860 at the base commit.

```
/**
 * Extract every task id MASTER-PLAN.md prose ASSERTS unbuilt — bound to its subject via
 * clause-scoping (see the module doc above for why a line-scoped extractor is measurably
 * wrong: 5 of the 6 ids it yields over this corpus are sibling rejection counts, not the
 * unbuilt subject). Pure text extraction, no interpretation of meaning, same discipline as
 * {@link extractStandingRules}.
 *
 * Design (ii): a phrase-bearing line whose bound clause carries a PROPOSAL id but no task id
 * (13 of 23 measured at 0503802 — the corpus asserts unbuiltness about proposals far more often
 * than about tasks) is counted in `proposalOnlyLines`, NEVER silently dropped, and NEVER
 * resolved to the task ids that implement the proposal — that resolution is explicitly out of
 * this rung's reach; a reader of the rendered section is told how many were skipped instead.
 */
```

## `PlanStateTruthResolver` (type)

`src/lib/retro.ts` lines 4885-4891 at the base commit.

```
/** What the merge resolver the retro gather already holds (`projectPlan`'s batched GitHub
 *  read) reports for one task id — the same two fields {@link PlanHealthReport}'s caller
 *  already reads off `StatusProjection` (`merged`, `prUrl`), passed as a plain function so this
 *  rung stays keyed by raw STRING id rather than a `Task` object: a prose-extracted id may not
 *  even resolve to a known plan task (retired, renamed, or simply not in `plan/tasks.yaml`),
 *  and `undefined` here means exactly that — "the resolver has no opinion on this id", never
 *  "unmerged" (see design (iii)'s positive control, which this distinction exists to serve). */
```

## `PlanStateTruthReport` (type)

`src/lib/retro.ts` lines 4901-4917 at the base commit.

```
/**
 * {@link planStateTruthRung}'s result — THREE STATES, THREE RENDERINGS (design (vii)), plus the
 * fourth "unexamined" failure mode design (iii)/(vi) require:
 *
 * - `unavailable`: no resolver in hand this run (mirrors `netStateAdvisorySectionFor`'s and
 *   `planHealthSweepSectionFor`'s degrade-on-unreachable-gateway discipline). Distinct from a
 *   clean result — the rung did not scan, it is not vouching for anything.
 * - `unexamined`: the positive control failed — either extraction yielded zero ids, or none of
 *   the extracted ids resolved through the resolver at all (design (iii): "must fail loudly
 *   when either is empty"). Distinct from `clean` — an empty scan must never render as a clean
 *   result (acceptance criterion 4).
 * - `clean`: every extracted id that resolved is reported UNMERGED by the resolver — the plan's
 *   assertion agrees with the truth.
 * - `findings`: at least one extracted id the plan asserts unbuilt is reported MERGED — a
 *   BLOCKING contradiction (design (iv): outranks the plan-health sweep beside it, because it
 *   decides the KICK ORDER, not one task's proofs).
 */
```

## `planStateTruthRung` (function)

`src/lib/retro.ts` lines 4930-4947 at the base commit.

```
/**
 * THE RUNG (W1-T410 design). Re-derives every task id MASTER-PLAN.md asserts unbuilt
 * ({@link extractAssertedUnbuiltTaskIds}) against `resolve`, the SAME merge resolver the retro
 * gather already computed (`retroCommand`'s single batched `projectPlan` pass — no new network
 * call, no new gateway; see src/run-task.ts's `planStateTruthSectionFor`).
 *
 * `resolve` omitted (design (vii)): the caller has no projection in hand (an unreachable
 * gateway, degraded the same way `isTaskMerged` degrades to `undefined` in `retroCommand`) —
 * `unavailable`, never a silent skip.
 *
 * BOTH CONTROLS ARE BLOCKING (design (iii)), not merely test-time assertions: a run whose
 * extraction is empty, or whose extracted ids the resolver has no opinion on AT ALL (as opposed
 * to an opinion of "unmerged"), reports `unexamined` — loud, not a clean pass. A run whose only
 * bound subjects are proposals is exactly the `proposalOnlyLines` count on an OTHERWISE-clean or
 * OTHERWISE-findings report, never folded into `unexamined` by itself (a plan that correctly
 * asserts nothing about tasks and everything about live proposals is not an unexamined scan —
 * it is real information the render already carries via `proposalOnlyLines`).
 */
```

## `renderPlanStateTruth` (function)

`src/lib/retro.ts` lines 4979-4981 at the base commit.

```
/** Render {@link planStateTruthRung}'s report as a retro-report section — see that function's
 *  doc for the four states this renders distinctly. Printed ahead of the plan-health sweep
 *  (design (iv): a contradiction here outranks that advisory floor). */
```

## `PlanCoherenceShardListing` (type)

`src/lib/retro.ts` lines 5008-5024 at the base commit.

```
/**
 * {@link planCoherenceRung}'s result — MIRRORS {@link PlanStateTruthReport}'s shape (W1-T410)
 * rather than inventing a second vocabulary: `clean` carries the counts it examined,
 * `findings` names EVERY offender, `unexamined` carries a stated reason.
 *
 * DELIBERATELY NO `unavailable` STATE, unlike {@link PlanStateTruthReport}: this rung reads no
 * gateway (it is handed plain text, never a network/GitHub call), so it can never degrade for
 * a reason {@link planStateTruthRung} must. The one way it can fail to scan is the caller not
 * being able to LIST `plan/tasks.d/` at all — that is `unexamined`, not `unavailable`.
 */
/** What the caller found trying to ASSEMBLE the corpus — `ok: true` with every shard entry it
 *  read, or `ok: false` with a stated reason it could not (an unlistable `plan/tasks.d/`, or a
 *  `plan/tasks.yaml` that exists but will not read; see {@link planCoherenceRung}'s doc for why
 *  either is `unexamined` and not folded into a zero-shard `clean` result — and {@link
 *  "../run-task.js".readPlanCoherenceInputs} for the production read that produces both arms).
 *  A discriminated union rather than `T[] | { reason }` because `Array.isArray` does not
 *  reliably narrow a `readonly T[] | object` union. */
```

## `planCoherenceRung` (function)

`src/lib/retro.ts` lines 5039-5053 at the base commit.

```
/**
 * THE RUNG (W1-T2642 design, mirroring W1-T410's shape). Re-derives, on every retro cycle, the
 * question "does plan/tasks.yaml and plan/tasks.d/*.yaml disagree about which tasks EXIST" that
 * NET STATE has carried as unmeasured prose for fourteen cycles — see this task's rationale for
 * the full "harvest (a)" history. Calls {@link scanPlanCoherence} (plan-coherence.ts, this
 * rung's ONLY consumer) with the monolith blob and every shard entry the caller read off disk.
 *
 * `shards` carries `{ ok: false, reason }` exactly when the caller could not ASSEMBLE the
 * corpus — it could not LIST `plan/tasks.d/` (a permissions error, say), or the monolith itself
 * would not read. NOT the back-compat "directory does not exist yet" case {@link
 * "./plan.js".loadPlan}'s own `listShardFiles` tolerates by reading as an empty listing, which
 * this rung also reads as zero shards examined, not unexamined. Either failure renders
 * `unexamined`, never a silent `clean` over a scan that never actually ran (P48: never a bare
 * zero indistinguishable from a check that did not run).
 */
```

## A blob that is not a

`src/lib/retro.ts` lines 5065-5071 at the base commit.

```
    // A blob that is not a parseable task list throws `PlanError` out of `parseTasksFromYaml`,
    // exactly as plan-coherence.ts's own doc says it does. THE MODULE STAYS STRICT AND THE RUNG
    // DEGRADES: `retroCommand` now hands this REAL production bytes every cycle, and an
    // unattended retro must not ABORT on one malformed shard the way a loader may — it must say
    // so and carry on. `unexamined` with the parser's own message, never a silent `clean` over a
    // scan that did not complete (P48: a bare zero is indistinguishable from a check that never
    // ran, and a crashed retro reports nothing at all).
```

## `renderPlanCoherence` (function)

`src/lib/retro.ts` lines 5094-5097 at the base commit.

```
/** Render {@link planCoherenceRung}'s report as a retro-report section — see that function's
 *  doc for the three states this renders distinctly. NEVER A BARE ZERO (P48): a clean corpus
 *  states the counts it examined, so a check that did not run is distinguishable from one that
 *  passed. */
```
