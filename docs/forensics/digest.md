# digest.ts comment forensics

The measured forensics, incidents and design arguments that were removed from
`src/lib/digest.ts` when its comments were compacted to the plain-language standard
(docs/comment-standard.md).

Each section below carries the removed block verbatim, under a heading naming the symbol it
explained, and the code keeps a one-line `Why:` pointer wherever the history mattered. Nothing
here was rewritten: this is the original text, so a reader chasing an incident or a design
argument reads what the author actually wrote.

Line numbers are positions in `src/lib/digest.ts` at the merge base of the compaction PR
(`79c73053373cc2f74eed423dd17b228502d0e305`).

## File header — the module's own doctrine

Removed from lines 21-36.

```
/**
 * Daily digest (W1-T8 title; assembled here, delivered here, SCHEDULED by the
 * daemon loop later (W1-T12) — this module owns no clock/cron of its own).
 *
 * MASTER-PLAN §4: "Interrupts collapse to a daily digest; real-time pings only for
 * MANUAL + hard-stop." BLOCKED escalations and ordinary run outcomes (merges,
 * blocked_* verdicts, notional cost) accumulate in the ledger all day and are
 * rolled into ONE message here, instead of paging on every one.
 *
 * W1-T2277 GIVES THIS MODULE THE CLOCK ITS OWN HEADER SAID IT DIDN'T OWN: the
 * `digest cadence` section at the bottom of this file (search "W1-T2277") is the PURE
 * decision half — `src/run-task.ts`'s `buildDigestCadenceDaemonHooks` is the PRODUCER
 * that wires it into `lib/daemon.ts`'s poll loop, mirroring `lib/measurement-cadence.ts`'s
 * own consumer/producer split exactly (see that module's header for why the split matters —
 * #1066 shipped a consumer with no producer).
 */
```

## `// ── W1-T929: THE CACHE-HIT RATIO` — the derivation's provenance

Removed from lines 46-53.

```
// ── W1-T929: THE CACHE-HIT RATIO — cache_read/(cache_read+input+cache_creation) ─────────────
//
// worker.ts's TokenUsage already nests `cacheRead`/`input`/`cacheCreation` on the `tokens`
// field of every worker AND brain-plane ledger line (workerLedgerFields, W1-T6); nothing read
// it. This is the ONE derivation (design note (i)): `cacheHitRatio` is the sole arithmetic,
// `aggregateCacheHitTotals` is the sole grouping traversal, and BOTH this module's `summarize`
// and status-board.ts's `buildStatusBoard` walk it — the two surfaces can disagree on how they
// RENDER a figure, never on what the figure IS.
```

## `cacheHitRatio` — why `undefined`, never `0`

Removed from lines 63-73.

```
/**
 * THE cache-hit ratio (feedback fb-1785237559155-feef92, MASTER-PLAN §8A): `cache_read /
 * (cache_read + input + cache_creation)` — the SAME formula the feedback named, computed off
 * ONE set of summed token counts (a single line, or a whole run/class grain). Exported so
 * status-board.ts calls this SAME function (grep-provable: `cacheHitRatio(` in
 * src/lib/status-board.ts) instead of re-deriving a second opinion of the same number.
 *
 * Returns `undefined` — NEVER `0` — when the denominator is zero: a line predating the cache
 * columns, or a call whose envelope carried no tokens at all (e.g. a genuine transport
 * failure), is UNKNOWN, not a fabricated 0% hit rate (design note (iii)).
 */
```

## `CacheHitTotals` — the two grains

Removed from lines 92-104.

```
/** Both grains the feedback asked for (design note (ii)): per RUN (a single bad run legible)
 *  and per task CLASS (the grain that detects a regression), over the SAME window. */
export interface CacheHitTotals {
  /** Keyed by ledger `run_id`. */
  byRun: Record<string, CacheHitGrain>;
  /**
   * Keyed by the run's `run.start` line `task_class` field — mirrors retro.ts's
   * `aggregateByClass`: a run whose `run.start` line predates W1-T167, or fell outside this
   * window, is grouped under `"unknown"` rather than dropped, so an omitted class is itself a
   * fact this table shows, not silently loses.
   */
  byClass: Record<string, CacheHitGrain>;
}
```

## `isCallLine` — why this predicate never misfires

Removed from lines 106-112.

```
/** A ledger line is a worker/brain-plane CALL line iff it carries `workerLedgerFields`' `model`
 *  + `effort` pair (W1-T6) — present on every call, predating the cache columns themselves, so
 *  this predicate never mistakes a `run.start`/`verdict`/poll line for a call that just has no
 *  token data. */
```

## `lineTokens`

Removed from lines 114-116.

```
/** The line's token counts, off its nested `tokens` field (worker.ts's `TokenUsage`, spread
 *  verbatim by `appendLedger` — never snake_cased), or `undefined` when the shape isn't there
 *  at all (a line predating `tokens`, or malformed). */
```

## `foldCacheHitLine`

Removed from lines 130-132.

```
/** Fold one call line into `grain` — always counts toward `callLines`; only adds to the token
 *  totals (and `coveredLines`) when the line's envelope actually carried a non-zero denominator,
 *  so an uncovered call can never silently pass as a healthy 0% hit rate. */
```

## `aggregateCacheHitTotals`

Removed from lines 142-150.

```
/**
 * Group `lines` (any ledger window) into per-run and per-class {@link CacheHitGrain} totals —
 * the ONE traversal both `summarize` (below) and status-board.ts's `buildStatusBoard` walk, so
 * the two surfaces can never disagree on WHICH lines count or how they're bucketed.
 *
 * `undefined` when NOTHING in `lines` carries usable cache data at all (design note (iv), the
 * same soft-compose discipline `DigestSummary.inbox` already keeps) — the caller then omits its
 * cache-hit output entirely rather than printing an all-UNKNOWN table for a window that simply
 * predates this feature.
 */
```

## `formatCacheHitFigure`

Removed from lines 181-186.

```
/**
 * Format ONE {@link CacheHitGrain} as `NN.N% (coverage NN%)`, or `UNKNOWN (coverage NN%)` when
 * {@link cacheHitRatio} returns `undefined` (design note (iii)) — the ONE formatting rule both
 * this module's {@link renderCacheHitLine} and status-board.ts's own per-grain render share, so
 * "UNKNOWN" vs a real percentage never reads differently across the two surfaces.
 */
```

## `// ── W1-T940: LEARNINGS INJECTION DROP PRESSURE` — why the aggregation exists

Removed from lines 181-192 (pre-existing line numbers before the cache-hit section above was
compacted; content unaffected).

```
// ── W1-T940: LEARNINGS INJECTION DROP PRESSURE ──────────────────────────────────────────────
//
// run-task.ts's promptsmith block already logs a `learnings.injected` row on every spawn —
// `matched`, `matched_ids`, `dropped` (ids), `budget_chars`, and `global_refused_reason` — but
// nothing read it (measured: zero occurrences of "learnings" in status-board.ts before this
// task). This is the ONE aggregation (mirrors `aggregateCacheHitTotals` above, W1-T929's same
// seam): it walks the SAME ledger lines the board already read and totals `matched`/`dropped`
// across the window, the DISTINCT `budget_chars` values seen (a mid-window constant change stays
// visible rather than getting averaged away), and the DISTINCT `global_refused_reason` strings
// with their counts — a refusal is a diagnosis, never folded into the drop count (design note
// (iii): a `global_refused_reason` is a layer contributing ZERO entries; a budget drop is a
// ranked entry losing a tie).
```

## `LearningsInjectionTotals`

Removed from lines 194-200.

```
/**
 * One window's totals over every `learnings.injected` ledger row (W1-T940). `budgetChars` is
 * every DISTINCT `budget_chars` value seen (sorted ascending), not one summary number, so a
 * mid-window constant change is visible instead of averaged away. `globalRefusedReasons` keys
 * the verbatim reason string to how many rows carried it — deduped, and deliberately kept off
 * `dropped` (design note (iii)).
 */
```

## `aggregateLearningsInjection`

Removed from lines 214-221.

```
/**
 * Group `lines` (any ledger window) into {@link LearningsInjectionTotals} — the ONE traversal
 * status-board.ts's `buildStatusBoard` walks too (grep-provable: `aggregateLearningsInjection(`
 * in src/lib/status-board.ts), so the two surfaces can never disagree on which rows count.
 *
 * `undefined` when `lines` carries NO `learnings.injected` rows at all (design note (iv), the
 * same soft-compose discipline {@link aggregateCacheHitTotals} keeps above) — the caller then
 * renders explicit absence rather than a fabricated `dropped: 0` for a window that saw no spawns.
 */
```

## `// ── W1-T941: THE KNOWLEDGE BUDGET IS A DERIVED CAP` — why 1800 became a formula

Removed from lines 249-261.

```
// ── W1-T941: THE KNOWLEDGE BUDGET IS A DERIVED CAP, NOT A PICKED NUMBER ─────────────────────
//
// DEFAULT_KNOWLEDGE_BUDGET_CHARS (src/lib/learnings.ts) carried no derivation: 1800 was a
// literal with no measurement behind it, while the observed effect was large (an
// operator-reported spawn matched 16 entries and injected 3). The feedback that filed this
// task said "measure, don't assume" — both halves already exist as machinery: PRESSURE is the
// same `learnings.injected` ledger rows {@link aggregateLearningsInjection} above reads (not a
// second traversal), joined against the corpus's own per-entry weight (a dropped COUNT alone,
// which is all that aggregate totals, cannot size a char cap — the WEIGHT of what was refused
// is the figure that matters); COST is the SAME cache arithmetic this file already exports
// ({@link cacheHitRatio}) — §8A's stable-first/volatile-last ordering means only the Tier-1
// block's own bytes are re-charged, so a marginal cap increase prices as `delta chars` at the
// measured cache mix, never a whole-prompt re-render.
```

## `KnowledgeBudgetPressure`

Removed from lines 263-265.

```
/**
 * One window's per-spawn DROPPED-FACT WEIGHT pressure (design note i): p50/p90 chars of
 * matched-but-dropped fact the budget refused, per spawn — not a count, a WEIGHT.
 */
```

## `measureKnowledgeBudgetPressure`

Removed from lines 285-296.

```
/**
 * PRESSURE SIDE (design note i): walks the SAME `learnings.injected` ledger rows {@link
 * aggregateLearningsInjection} reads — not a second traversal shape — and for each row's
 * `dropped` id array sums the matching chars out of `entryWeights` (an id -> weight lookup,
 * e.g. src/lib/learnings.ts's `buildEntryWeightIndex` over the live corpus). An id absent from
 * `entryWeights` (an entry since deleted/superseded/renamed) contributes zero — this is the
 * best-available signal off the CURRENT corpus, not a perfect historical replay.
 *
 * `undefined` when no row has at least one resolvable dropped id — the same soft-compose
 * convention {@link aggregateLearningsInjection}/{@link aggregateCacheHitTotals} keep above: no
 * measurable pressure is a fact this function reports explicitly, never a fabricated zero.
 */
```

## `CHARS_PER_TOKEN`

Removed from lines 318-320.

```
/** English-text heuristic for pricing the marginal cap increase (design note ii): ~4 characters
 *  per token. A deliberately coarse approximation — not a model-specific tokenizer count — same
 *  as every other "roughly N tokens" figure this plan already estimates in. */
```

## `TRIVIAL_DROPPED_WEIGHT_CHARS`

Removed from lines 323-328.

```
/**
 * Below this many p90 dropped chars, the pressure is TRIVIAL (design note iv) — less than one
 * typical dropped fact line (`entryBudgetWeight`'s rendered `- <fact> [src: learnings#<id>]`
 * line is almost never under 40 chars even for the shortest real entry), so it is not worth
 * pricing a raise over.
 */
```

## `KnowledgeBudgetDerivation`

Removed from lines 331-334.

```
/**
 * A derived recommendation for the knowledge-budget cap (design notes i-iv), carrying the
 * INPUTS that produced it so the recommendation is auditable, not just the number.
 */
```

## `BoardReviewDigestSnapshot`, `RepeatEscalationDigestEntry`, `RepairFilingSuppressedDigestEntry`

Removed from lines 389-421.

```
/** The `board_review.ran` fields {@link DigestSummary.boardReview} carries, read straight off the row
 *  the daemon tick writes (daemon.ts's `log("board_review.ran", …)`). Every field is optional: this
 *  reads a row written by another module, so a row from an older or newer writer degrades to a
 *  partial line rather than a throw. */
export interface BoardReviewDigestSnapshot {
  oldestOpenAgeHours?: number;
  redCount?: number;
  unhandledEscalationCount?: number;
  itemsConsidered?: number;
  proposals?: number;
}

/** One `sweep.repeat_escalated` trip {@link DigestSummary.repeatEscalations} carries, read straight
 *  off the row the sweep writes (sweep.ts's W1-T2345 counter). Every field optional: this reads a row
 *  written by another module, so a row from an older or newer writer degrades to a partial line
 *  rather than a throw. */
export interface RepeatEscalationDigestEntry {
  prNumber?: number;
  disposition?: string;
  streak?: number;
}

/** One `sweep.repair_filing_suppressed` trip {@link DigestSummary.repairFilingsSuppressed}
 *  carries, read straight off the row {@link "../run-task.js".captureRepairFeedbackWithPriorVerdict}
 *  writes (W1-T2416) when a due surface's most recent prior verdict for its own `repair#<surface>`
 *  origin is `rejected`. Every field optional: this reads a row written by another module, so a
 *  row from an older or newer writer degrades to a partial line rather than a throw. */
export interface RepairFilingSuppressedDigestEntry {
  id?: string;
  surface?: string;
  distinctPrCount?: number;
  rejectedEntryId?: string;
}
```

## `DigestSummary` — the field-by-field soft-compose contract

Removed from lines 425-535. This is the fullest statement of the soft-compose rule the compacted
source now states once and points back to: a field that reads a *snapshot* (`alerts`, `issues`,
`inbox`, `boardReview`) is **latest wins**, never summed; a field that reads *events* (`cacheHit`
is the derived exception since it aggregates counters, but `repeatEscalations` and
`repairFilingsSuppressed` are the clear cases) is **additive** and deduped by the row's own
natural key (PR number, filing id) because the ledger union can replay one row across
overlapping rotations. Every one of `inbox`/`cacheHit`/`boardReview`/`repeatEscalations`/
`repairFilingsSuppressed` is **soft-composed** by `renderDigest`: its line is omitted entirely,
never printed as an empty placeholder, so a digest predating the field (or a quiet window) reads
byte-identical to before the field existed.

```
  /** W1-T2388: what the windowed union actually reached. OPTIONAL, so every existing caller of
   *  {@link summarize}/{@link renderDigest} (and every fixture) type-checks and renders unchanged;
   *  {@link buildDigest} always sets it. Read ONLY to say so when the read was incomplete — never
   *  to decide anything. */
  read?: DigestWindowRead;
  merged: string[];
  blocked: Array<{ taskId: string; verdict: string; prUrl?: string }>;
  escalations: Array<{ taskId: string; class: string; issueUrl: string }>;
  costUsd: number;
  /**
   * The LATEST `ops.alerts_polled` snapshot inside the window (W1-T55, lib/ops.ts)
   * — a snapshot of OPEN alert counts+ages, not an additive event count like
   * `merged`/`blocked`, so "latest wins" rather than summing repeated polls.
   * Undefined when `rmd ops` never polled inside this window.
   */
  alerts?: AlertsPollSummary;
  /**
   * The LATEST `issues.polled` snapshot inside the window (W1-T57, lib/issues-intake.ts) — the
   * issues-reviewed count so "issues reviewed regularly" is a ledgered fact, not an intention.
   * Same "latest wins" rule as `alerts`. Undefined when `rmd issues` never polled inside this window.
   */
  issues?: IssuesPollSummary;
  /**
   * The LATEST `inbox.polled` snapshot inside the window (W1-T112, lib/inbox.ts) — the
   * ready-proposal count so the morning pulse answers "what needs me" without a separate
   * `rmd inbox` check. Same "latest wins" rule as `alerts`/`issues`. Undefined when `rmd
   * inbox` never polled inside this window — {@link renderDigest} SOFT-COMPOSES this one:
   * it OMITS the "inbox: N ready" line entirely rather than falling back to a "(no poll
   * this window)" placeholder, so a digest predating `rmd inbox` (or one where it simply
   * hasn't run yet) renders byte-identical to before this field existed.
   */
  inbox?: InboxPollSummary;
  /**
   * W1-T929: cache-hit ratio totals for this window, per run and per task class (design note
   * (ii)) — `undefined` when NOTHING in the window carries usable cache-token data, so
   * {@link renderDigest} SOFT-COMPOSES this one exactly like `inbox` above: it OMITS the
   * "cache hit by …" lines entirely rather than printing an all-UNKNOWN table for a window
   * that simply predates this feature (design note (iv)). See {@link aggregateCacheHitTotals}.
   */
  cacheHit?: CacheHitTotals;
  /**
   * The LATEST `board_review.ran` snapshot inside the window (the board-review rung, daemon.ts) —
   * what the last board read SAW: the oldest open item's age, the red count, the unhandled
   * escalation count, how many items it considered and how many proposals it drafted.
   *
   * `.ran` ALONE, of the rung's three steps, and the choice is the point. `.fired` is 1:1 with
   * `.ran` and carries only the trigger reason, so sweeping both double-counts one event and adds
   * nothing a reader can act on. `.skipped` fires when a REAL depth trigger is held off by the
   * cadence — that is the cadence WORKING, and five "would have run, but only 92 minutes since the
   * last one" lines a day is exactly the correct-behaviour noise a digest must not carry.
   *
   * LATEST WINS, not additive — the same rule as `alerts`/`issues`/`inbox` above and for the same
   * reason: these are snapshot counts of a board's current state, never an event tally.
   *
   * SOFT-COMPOSED by {@link renderDigest} exactly like `inbox`: a window with no `board_review.ran`
   * omits the line ENTIRELY rather than printing a "(no run this window)" placeholder, so a digest
   * over a window predating the rung renders byte-identical to before this field existed. A QUIET
   * BOARD THEREFORE SHOWS NOTHING HERE — the rung only runs when a depth trigger fires, so silence
   * is the honest reading rather than an absence dressed up as a measurement.
   */
  boardReview?: BoardReviewDigestSnapshot;
  /**
   * Every `sweep.repeat_escalated` trip inside the window — the W1-T2345 counter firing on a PR whose
   * verdict has not moved on an unchanged head for `repeatDispositionBound` consecutive derivations.
   *
   * ADDITIVE, NOT LATEST-WINS, and the difference from `boardReview` above is the point. A board read
   * is a SNAPSHOT of one board's current state, so the newest row supersedes the older ones. A repeat
   * trip is an EVENT about one particular PR, fires at most once per PR per unchanged head by
   * construction (`repeatAlreadyEscalated`, sweep.ts), and two trips are two DIFFERENT PRs stuck —
   * collapsing them to "latest" would report one and hide the rest.
   *
   * DEDUPED BY PR NUMBER anyway, because the ledger union can carry the same row twice across
   * overlapping rotations, and a digest counting a rotation artefact as a second stuck PR would be
   * wrong in the direction that costs an operator a look.
   *
   * SOFT-COMPOSED by {@link renderDigest} exactly like `boardReview`: a window with no trip omits the
   * line ENTIRELY rather than printing a "(none this window)" placeholder, so a digest over a quiet
   * board — or one predating the counter — renders byte-identical to before this field existed. A
   * QUIET BOARD SHOWS NOTHING HERE, which is the honest reading: the counter only fires when a PR is
   * demonstrably stuck.
   */
  repeatEscalations?: RepeatEscalationDigestEntry[];
  /**
   * Every `sweep.repair_filing_suppressed` trip inside the window — W1-T2416's verdict read
   * refusing to re-file a `repair#<surface>` recurrence whose most recent prior entry for that
   * SAME origin is already `rejected` (design ii/iii of that task). ADDITIVE, not latest-wins,
   * mirroring `repeatEscalations` immediately above and for the same reason: two trips name two
   * DIFFERENT surfaces stood down in the same window, and collapsing to "latest" would report
   * one and hide the rest.
   *
   * DEDUPED BY THE FILING'S OWN `id`, mirroring `repeatEscalations`'s PR-number dedup: the ledger
   * union can carry the same row twice across overlapping rotations, and a digest counting a
   * rotation artefact as a second suppression would be wrong in the direction that costs an
   * operator a look.
   *
   * SOFT-COMPOSED by {@link renderDigest} exactly like `repeatEscalations`: a window with no trip
   * omits the line ENTIRELY rather than printing a "(none this window)" placeholder, so a digest
   * over a quiet board — or one predating this reader — renders byte-identical to before this
   * field existed. This IS the reader design (iii) requires: the row the filer already writes had
   * no consumer until this field, and a ledger row nothing reads is not an answer.
   */
  repairFilingsSuppressed?: RepairFilingSuppressedDigestEntry[];
  /**
   * W1-T178 (verdict stability): count of `review.downgrade_suppressed` ledger
   * lines inside the window — a semantic-lane downgrade suppressed because the
   * deterministic floor still passed on an unchanged head. This is the signal
   * that tells whether the semantic lane is getting noisier or quieter over
   * time; a suppression is never silent (see run-task.ts's `runReview`), but
   * this is where the COUNT is visible without reading the raw ledger.
   */
  verdictDowngradesSuppressed: number;
```

## `summarize` — the `board_review.ran`/`sweep.repeat_escalated`/`sweep.repair_filing_suppressed` readers

Removed inline comments, originally near lines 501-535.

```
    // The rung's own row, latest-wins like the three above. Reading the ROW rather than calling the
    // rung's module keeps this file a pure ledger reader: no new import, no new seam, no write path.
    if (l.step === "board_review.ran") {
```

```
    // W1-T2345's counter trip. The sweep ALREADY writes this row; what was missing is a READER.
    // The shard's own design says so in terms — "the escalation surface is THE DIGEST … a second
    // queue nobody drains is not an answer" — and `digest.ts` referenced the step ZERO times.
    if (l.step === "sweep.repeat_escalated") {
```

```
    // W1-T2416's suppression row. The filer already writes this row (run-task.ts's
    // `captureRepairFeedbackWithPriorVerdict`); what was missing is a READER — the same gap
    // W1-T2345's `sweep.repeat_escalated` closed above, and the same precedent this task follows.
    if (l.step === "sweep.repair_filing_suppressed") {
```

## `consoleCardUrl`

Removed from lines 546-552.

```
/**
 * Deep-link a task id to its console card (W1-T144, MASTER-PLAN §7B). A HASH route —
 * `#task=<id>` — so the link never leaves the client: no bearer token rides along in
 * message-app history, and it layers cleanly on top of whatever base URL (and its own
 * `?token=`, per apps/dashboard's `readConfig`) the operator already has bookmarked.
 * `consoleBaseUrl` is a full origin (e.g. `http://100.x.x.x:4317`, config.ts's
 * `consoleUrl`); a trailing slash is tolerated. `taskId` is percent-encoded so a link
 * for task X can never be mistaken for — or collide with — a link for a different id.
 */
```

## `renderDigest` — doc and the soft-composed lines

Removed from lines 559-568, 593-610.

```
/**
 * Render a {@link DigestSummary} as the digest text — what a human reads, once a day.
 * `consoleBaseUrl`, when given, appends a W1-T144 console deep link to each escalation
 * line so a needs-human item read off the message channel jumps straight to its task
 * card. Omitted (the default), the escalations line renders EXACTLY as before this
 * field existed — no caller that predates W1-T144 sees any change.
 */
export function renderDigest(s: DigestSummary, consoleBaseUrl?: string): string {
  // W1-T2388: AN INCOMPLETE READ MUST NEVER LOOK LIKE A QUIET BOARD — that is the failure this
  // task exists to remove, so it is stated on its own line rather than inferred from short output.
  // A COMPLETE read adds nothing: a clean board renders byte-identically to before this task.
```

```
    // W1-T112: soft-composed — present only when `rmd inbox` polled inside this window, an
    // absent entirely (not a "(no poll this window)" placeholder) line otherwise, see the
    // `inbox` field's doc on DigestSummary.
    ...(s.inbox ? [`inbox: ${renderInboxPollSummary(s.inbox)}`] : []),
    // Soft-composed exactly like `inbox` above — absent, never a placeholder, when the window
    // carries no `board_review.ran`. See the `boardReview` field's doc on DigestSummary.
    ...(s.boardReview ? [`board review: ${renderBoardReviewSnapshot(s.boardReview)}`] : []),
    // Soft-composed exactly like `board review` above — absent, never a placeholder, when the
    // window carries no trip. See the `repeatEscalations` field's doc on DigestSummary.
    ...(s.repeatEscalations?.length ? [`stuck (repeat bound): ${renderRepeatEscalations(s.repeatEscalations)}`] : []),
    // Soft-composed exactly like `stuck (repeat bound)` above — absent, never a placeholder, when
    // the window carries no trip. See the `repairFilingsSuppressed` field's doc on DigestSummary.
    ...(s.repairFilingsSuppressed?.length
      ? [`repair filings suppressed (prior rejection): ${renderRepairFilingsSuppressed(s.repairFilingsSuppressed)}`]
      : []),
    // W1-T929: soft-composed — present only when the window carries usable cache-token data
    // (see the `cacheHit` field's doc on DigestSummary), two lines (per-run, per-class), never
    // a "(no data)" placeholder otherwise.
    ...(s.cacheHit ? [renderCacheHitLine("cache hit by run", s.cacheHit.byRun), renderCacheHitLine("cache hit by class", s.cacheHit.byClass)] : []),
```

## `renderRepeatEscalations`, `renderRepairFilingsSuppressed`, `renderBoardReviewSnapshot`

Removed from lines 611-614, 626-629, 641-642.

```
/** One line for {@link DigestSummary.repeatEscalations} — every PR that tripped the repeat bound in
 *  this window, each naming the verdict that would not move and how many consecutive derivations it
 *  survived. Every field optional, so a row missing one omits that clause rather than printing
 *  `undefined`. Mirrors `renderBoardReviewSnapshot`'s shape. */
```

```
/** One line for {@link DigestSummary.repairFilingsSuppressed} — every due surface whose recurrence
 *  filing was suppressed because its own most recent verdict is already `rejected` (W1-T2416),
 *  each naming the surface, how many distinct PRs its own evidence carried, and the rejected
 *  entry that suppressed it. Mirrors `renderRepeatEscalations`'s shape. */
```

```
/** One line for {@link DigestSummary.boardReview} — every field optional, so a row missing one omits
 *  that clause rather than printing `undefined`. Mirrors `renderAlertsSummary`'s shape. */
```

## `realDigestFs` and the orphaned `buildDigest` doc

Removed from lines 653-659. This JSDoc for `buildDigest` (lines 653-656) sat orphaned above
`realDigestFs`, not above `export function buildDigest` itself (line 838) — the same
displaced-comment hazard `docs/comment-standard.md` documents for `src/lib/ledger.ts:338`. The
compaction moves a short version of it down to sit above the real `buildDigest`.

```
/**
 * Build the digest text straight from a ledger file, as of `sinceIso`. `consoleBaseUrl`
 * threads through to {@link renderDigest} — see its doc for the W1-T144 deep-link contract.
 */
/** The real fs behind {@link readDigestWindow} — the SAME four operations `ledger-grep.ts`'s own
 *  {@link LedgerGrepFsDeps} names, reused rather than a fifth shape, so a test drives this reader
 *  with the fixtures that module's callers already use. */
```

## `DIGEST_MAX_ARCHIVES`

Removed from lines 667-673.

```
/**
 * W1-T2388 — A BACKSTOP, NOT A POLICY. The bound that matters is the WINDOW (every archive stamped
 * before `sinceIso` is skipped unopened); this cap exists only so an unbounded corpus cannot make a
 * reporter unbounded. It sits ABOVE the whole measured corpus (672 rotations, 118.1 MiB) and above
 * the worst 24-hour window in it (649 rotations, 89.4 MiB), so it does not bite on today's data —
 * and when it does bite, {@link renderDigest} SAYS SO rather than rendering a shorter board.
 */
```

## `DIGEST_MAX_ROWS` — the OOM incident

Removed from lines 676-696.

```
/**
 * W1-T2388 — THE PRIMARY CONTROL, AND IT BINDS ON MEMORY RATHER THAN WALL CLOCK. MEASURED, and
 * the measurement is why this exists at all: the busiest real 24-hour window in this corpus holds
 * 649 of its 672 rotations, and a reader that retained every in-window row from them DIED with a
 * V8 heap OOM at 4.1 GB — twice, once before the window filter was added and again after it, because
 * in a busy window the rows ARE in window. Wall clock was never the binding constraint (the digest's
 * own cadence floor is `minIntervalMinutes` >= 15, i.e. 900,000 ms, against a ~3 s union), so
 * bounding seconds would have bounded the wrong thing.
 *
 * ROWS, NOT ARCHIVES, and NEWEST FIRST: archives are read newest-first, so the rows kept are the
 * most recent ones — which is what a digest of a window wants — and the count dropped is RENDERED
 * rather than silently shortening the board. 250,000 is ~14x the live file's own 17,509 lines and
 * comfortably inside heap on this host; it is a ceiling on the pathological case, not a target.
 *
 * KIND: PRIMARY CONTROL, and the pairing is the point — {@link DIGEST_MAX_ARCHIVES} above is the
 * BACKSTOP. This is the bound the measurement says actually binds (the OOM was rows retained, not
 * archives opened), so it is the one a reader must reason about first; the archive cap exists to
 * stop a pathological directory before this one is even reached. Declared in the vocabulary
 * `test/bound-kind-declared.test.ts` reads rather than grandfathered: grandfathering is for bounds
 * that predate the property, and this one was added by the same change.
 */
```

## `DigestWindowRead`

Removed from lines 699, 707-709.

```
/** What one windowed union read actually reached — carried so the render can refuse to look quiet
 *  when it was merely incomplete (W1-T444's coverage-not-readability rule, applied to a reporter). */
```

```
  /** The caps ACTUALLY applied. Carried rather than re-read from the constants, so a render can
   *  never name a bound the read did not use — the first draft printed {@link DIGEST_MAX_ROWS}
   *  beside a truncation produced by an injected cap, and its own test caught it. */
```

## `readDigestWindow` — the windowed-union defect and design

Removed from lines 721-750 (the doc) and inline comments at 764-765, 773-774, 779-788, 813-817.
This is the longest single block in the pre-compaction file.

```
/**
 * W1-T2388 — THE DIGEST'S OWN WINDOWED UNION READ.
 *
 * THE DEFECT. `buildDigest` read ONE live path. `rotateLedger` fires on `statSize(path) > 4 MiB` —
 * a BYTE ceiling, not a clock — measured at 6.1 rotation events a day, with a rotation landing
 * inside the digest's cadence in 96.7% of windows and roughly 16% of a day's rows surviving to a
 * daily digest. Only 3 of the 10 steps the digest sweeps are in `DECISION_RELEVANT_LEDGER_STEPS`,
 * and they are there because some DECIDER elsewhere consults them, not for the digest's sake — so
 * the other seven (`board_review.ran`, `inbox.polled`, `issues.polled`, `learnings.injected`,
 * `ops.alerts_polled`, `review.downgrade_suppressed`, `sweep.repeat_escalated`) simply vanished.
 *
 * THE WINDOW IS THE BOUND, AND IT IS FREE. `rotationStampIso`'s own doc establishes the property
 * this rests on — "every line in a rotation is at or before the instant in its name", verified on
 * this host over an 18-archive sample — so an archive stamped before `sinceIso` can hold only older
 * rows and is provably irrelevant WITHOUT BEING OPENED. An UNPARSEABLE name is read, never skipped:
 * that same doc says a caller must treat "cannot decide" as "read it", and skipping would drop a
 * real corpus file.
 *
 * ONE ENUMERATOR. `ledgerRotationEntries` is THE definition of the corpus (W1-T444: two
 * hand-maintained filters once disagreed and each read a different half). This adds no second
 * suffix matcher.
 *
 * NOT `readLedgerUnionBounded`, AND ITS OWN DOC IS WHY: "every rung this serves reads the NEWEST
 * row of a step, never a count, so stopping early cannot under-count anything." The digest COUNTS —
 * it sums `cost_usd`, tallies `verdictDowngradesSuppressed`, and pushes arrays — so that reader's
 * early exit would under-report silently, which is this defect wearing a different hat.
 *
 * DEDUPED BY EXACT LINE TEXT, because rotations overlap heavily: `run.start` reads 257,438 RAW
 * lines across the `.gz` half and 779 DISTINCT over the union.
 */
```

```
    // An unreadable directory is "no archives" — the live read below still answers, exactly as it
    // did before this function existed. Never a throw in a reporter.
```

```
  // Newest first, so a cap that bites drops the OLDEST in-window archives rather than an arbitrary
  // set — and `archivesTruncated` says how many.
```

```
  // FILTER BEFORE RETAINING, WHICH IS A MEMORY BOUND AND NOT AN OPTIMISATION — MEASURED: an
  // earlier draft parsed and deduped every line first and DIED with a V8 heap OOM at 4.1 GB on
  // this corpus's 4,356,624 lines. An in-window archive is mostly OLD rows (rotations overlap
  // heavily), so the window predicate is what keeps the retained set proportional to the WINDOW
  // rather than to the archives' total size. The dedup `Set` is likewise fed only by retained
  // rows, so it cannot grow past the window either.
  //
  // The predicate is `collectSince`'s own, applied one step earlier — a row with no string `ts`
  // is dropped there today and is dropped here, so `summarize`'s later `collectSince` call is a
  // no-op over this input rather than a second, different opinion.
```

```
      // An archive that cannot be read or gunzipped is RECORDED as unread, never skipped silently:
      // `DigestWindowRead.unreadArchives` is what lets the render state an incomplete read on its
      // own line instead of looking quiet (W1-T444's coverage-not-readability rule). Swallowing
      // here is deliberate — one corrupt rotation must not cost the whole digest — and the caller
      // still learns it happened.
```

## `buildDigest`

Removed inline comment, originally at lines 839-840.

```
  // W1-T2388: the WINDOWED union, not the live file alone. `readLedgerLines` stays imported and in
  // use elsewhere in this module; only the digest's own read moves.
```

## `renderRundownPush`, `sendRundown`

Removed from lines 810-817, 832-837.

```
/**
 * Render a post-drain {@link RundownLine} array as ONE digest-channel message (W1-T144):
 * the PUSH counterpart to `drain.ts`'s own `renderRundown` (a pull-view printed to the
 * terminal that kicked the drain off). Every non-merged line — `blocked`/`escalated`,
 * the outcomes an operator who stepped away actually needs to see — carries a
 * {@link consoleCardUrl} deep link to that task's card; a `merged` line stays a bare
 * confirmation, since there is nothing to act on. Mirrors `renderRundown`'s own
 * "(no tasks attempted)" empty-state text so the two views never disagree on shape.
 */
```

```
/**
 * Deliver a post-drain rundown over the SAME notify channel as {@link sendDigest} and
 * `run-task.ts`'s MANUAL/HARD_STOP escalation pings (grep-provable: this is the ONE call
 * to `notify()` a drain's push runs through, not a second/parallel sender — W1-T144
 * acceptance "a drain rundown emits through the SAME channel, not a second transport").
 */
```

## `// ── W1-T163` — marker-aware digest section banner

Removed from lines 844-846.

```
// ── W1-T163: the digest becomes MARKER-AWARE, sharing lib/last-seen.ts's per-token marker with
// the console recap (lib/recap.ts) — so a pushed digest and a pulled recap, read off the SAME
// token's SAME marker, cover the identical window: "push and pull tell ONE story." ────────────
```

## `sendMarkerAwareDigest`

Removed from lines 879-885.

```
/**
 * Send a marker-aware digest for `tokenId`: read its CURRENT marker (or the pre-marker 24h
 * default on a first-ever send), deliver exactly like {@link sendDigest}, then advance the SAME
 * {@link LastSeenStore} `tokenId` to `nowIso` — the identical store `lib/board.ts`'s `GET
 * /v1/status` advances on a board view (see lib/last-seen.ts's module header). Whichever of the
 * two — a digest send or a board view — happens first moves the marker forward; the other then
 * only ever reports what's left, so the two never double-report or silently skip a window.
 */
```

## `// ── W1-T2277` — the cadence/interval/delivery section banner

Removed from lines 901-913.

```
// ═══════════════════════════════════════════════════════════════════════════════════════════
// W1-T2277 — THE DIGEST'S OWN CADENCE, INTERVAL, ITEM-MARKING AND DELIVERY SEAM
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// This section closes the three gaps this module's own header used to name (no clock, no
// configurable window, no delivery adapter that runs on this fleet). It fits the EXISTING
// cadence machinery rather than inventing a second one: `decideMeasurementCadence`
// (measurement-cadence.ts) is reused VERBATIM — the same pure two-bound (minIntervalMinutes +
// maxPerDay) decision function `rule-efficacy`/`verdict-calibration`/`autonomy-rate` already
// share — but against the digest's OWN marker file and OWN `plan/policy.yaml` row, so a short
// digest interval can never drag those three verbs to it (and a change to their cadence can
// never drag the digest), and no new decision function had to be written at all.
```

## `DigestCadencePolicy`, `digestCadenceMarkerPath`, `digestCadenceCheck`, `recordDigestCadenceFire`

Removed from lines 917-920, 927-929, 934-936, 946-948.

```
/** The digest cadence's policy shape — deliberately a SUBSET of
 *  {@link "./measurement-cadence.js".MeasurementCadencePolicy} (no `escalate`: the digest never
 *  drafts a proposal, it only reads and sends) so `plan/policy.yaml`'s `digestCadence` row can
 *  never be mistaken for `measurementCadence`'s. */
```

```
/** `<root>/state/last-digest-cadence.json` — the digest's OWN fire marker, distinct from
 *  `measurementCadenceMarkerPath`'s `last-measurement-cadence.json` (design above): the two
 *  cadences never read or write each other's file, so they can never throttle one another. */
```

```
/** The digest cadence's real decision, assembled from live state — mirrors
 *  `measurement-cadence.ts`'s own `measurementCadenceCheck` shape exactly, reusing
 *  {@link decideMeasurementCadence} (the SAME pure function) rather than a second one. */
```

```
/** Record a digest fire on the digest's OWN marker file — the SAME rolling-24h window
 *  {@link recordMeasurementCadenceFire} already implements, just pointed at
 *  {@link digestCadenceMarkerPath} instead of the measurement-cadence family's file. */
```

## `// ── The interval` banner and `digestIntervalOptionsOutOfBounds`

Removed from lines 955-957, 976-985.

```
// ── The interval: read from policy, every console-offered value checked against the declared
//    bound (claim: "the interval is read from policy and every value the console offers is
//    inside the declared bounds") ──────────────────────────────────────────────────────────────
```

```
/**
 * Every console-offered interval value that falls outside `bounds` — CHECKED, never assumed
 * (mirrors this task's own rationale: "the requested window set fits the declared bounds —
 * checked, not assumed"). Empty when every offered value is inside `bounds`; a future console
 * change that widens the option set without widening `plan/policy.yaml`'s declared
 * `digestCadence.minIntervalMinutes` bound is caught here rather than silently clamped.
 * `bounds` is the caller's own read of `Policy.bounds["digestCadence.minIntervalMinutes"]`
 * (policy.ts) — this function never reads `plan/policy.yaml` itself, so it stays a pure
 * unit-testable predicate.
 */
```

## `// ── The two halves, marked per item` banner and the item types

Removed from lines 969-971, 973-975, 983-987, 995-999, 1013-1014, 1019-1021.

```
// ── The two halves, marked per item (claims: "every deterministic figure carries the query
//    that reproduces it, and an item without one fails the render" / "a generated item is
//    marked per item rather than only by its section") ────────────────────────────────────────
```

```
/** A RE-RUNNABLE, checkable figure — merged/blocked/cost/etc. `query` is the literal
 *  instruction a reader re-runs to reproduce `value` byte-for-byte (a ledger predicate, a grep,
 *  a command) — never prose describing the number, an actual re-runnable step. */
```

```
/** Text somebody (or something) WROTE — a suggestion, never a measurement. Marked per item
 *  (`kind: "generative"`) rather than only by a section heading, so a single line quoted out of
 *  the digest still identifies itself. This module never GENERATES this text (Law 5's "the
 *  digest never spawns a worker to judge a task" — see {@link runDigestCadenceReport}'s doc):
 *  it only renders whatever a caller already produced. */
```

```
/**
 * Render ONE {@link DigestCadenceItem}. THE MECHANICAL TEST (design note (iv) of this task's
 * rationale): a deterministic item with no re-runnable `query` is a BUG and FAILS THE RENDER —
 * thrown, never silently printed unattributed; a generative item is always marked
 * `[SUGGESTED]`, per item, never relying on a section heading alone.
 */
```

```
/** Render every item — see {@link renderDigestCadenceItem}'s doc; throws on the FIRST
 *  unattributed deterministic item, same fail-loud contract. */
```

```
/** The re-runnable query strings for the four counting figures {@link summarize} reduces —
 *  the SAME reduction, described rather than re-derived, so {@link runDigestCadenceReport} can
 *  mark each one deterministic with its own query (claim 4) without a second traversal. */
```

## `// ── The retro is cited` banner and `RetroCitation`

Removed from lines 1051-1052, 1054-1059.

```
// ── The retro is cited, never re-derived (claim: "a retro that landed inside the window is
//    cited rather than re-derived") ─────────────────────────────────────────────────────────
```

```
/** One retro PR that landed (merged) inside the digest window — a CITATION, not a
 *  re-computation: this reads the SAME `verdict` lines {@link summarize} already reduces
 *  (`task_id === "RETRO"`, the id every retro run ledgers under — `src/run-task.ts`'s
 *  `retroCommand`/`buildGather`), and names the PR. It never imports rule-efficacy.ts /
 *  verdict-calibration.ts / autonomy.ts, so it is structurally incapable of re-deriving a
 *  retro's own findings — the only thing it can ever do is point at the PR that already has them. */
```

## `// ── The delivery seam` banner, `inboxDigestsPath`, `inboxNotifyChannel`

Removed from lines 1078-1083, 1085-1088, 1108-1115.

```
// ── The delivery seam: the digest depends on NotifyChannel, never a concrete target (claim:
//    "the digest depends on the notify channel interface and never on a concrete delivery
//    target") — an INBOX adapter, because notify.ts's only shipped adapter (imessageChannel) is
//    Darwin-only and this fleet runs on Linux (this module's own header). Kept HERE, not in
//    notify.ts, precisely because an inbox adapter is an IMPLEMENTATION of NotifyChannel and
//    requires no change to that interface at all. ─────────────────────────────────────────────
```

```
/** `<root>/state/inbox-digests.json` — the console inbox's digest feed, mirroring
 *  `lib/inbox.ts`'s own `inbox-proposals.json`/`inbox-drafts.json` convention (both live under
 *  `config.root`, served by `GET /v1/inbox`). A plain JSON array of `{ts, text}` entries,
 *  newest last. */
```

```
/**
 * A {@link NotifyChannel} implementation over the console inbox — the digest's ON-THIS-FLEET
 * delivery target: a plain file write has no platform gate, unlike `notify.ts`'s
 * `imessageChannel`, whose `unavailable()` refuses on every non-Darwin host. The digest's own
 * producer ({@link runDigestCadenceReport}) never imports this by name in a way that couples it
 * to the digest's logic — it only ever depends on the {@link NotifyChannel} TYPE, and this is
 * ONE implementation of it, freely swappable (a test fake today, an email adapter later) with
 * zero change to {@link sendDigest}/{@link runDigestCadenceReport} themselves.
 */
```

## `// ── The producer` banner, `DigestCadenceRunResult`, `runDigestCadenceReport`

Removed from lines 1132-1133, 1135-1138, 1145-1158.

```
// ── The producer: Law 5, unconditionally (claim: "the digest files nothing, mints nothing, and
//    spawns no worker to judge a task") ─────────────────────────────────────────────────────────
```

```
/** {@link runDigestCadenceReport}'s return: the text actually sent, which channel name it went
 *  out under, and whether the channel reported itself deliverable (mirrors `notify()`'s own
 *  `delivered` ledger field, surfaced here for a caller/test that wants it without re-parsing
 *  the ledger line `notify()` already writes). */
```

```
/**
 * THE PRODUCER'S BODY for the digest cadence rung — mirrors `measurement-cadence.ts`'s
 * `runMeasurementCadenceReport` role exactly. Builds the SAME digest text this module always
 * shipped ({@link renderDigest} over {@link summarize}) — no rebuild of what already exists —
 * plus this section's deterministic-figure queries, the retro citation, and any already-written
 * `suggestions` (generative items — see {@link GenerativeDigestItem}'s doc: this function never
 * GENERATES that text itself), then delivers over `opts.deps.channel`.
 *
 * LAW 5, UNCONDITIONALLY (claim 7): every parameter below is data, a {@link NotifyChannel} or a
 * ledger path — there is no `spawn`/`gh`/task-filing/id-minting dependency anywhere in this
 * function's signature for a caller to even wire one in, and its body opens no file other than
 * the ledger it already reads and the channel's own `send`. It NEVER spawns a worker to decide
 * what to say about a task (it reports on work already done); if a caller wants a generative
 * half, it must have already produced that text itself and hands it in via `suggestions`.
 */
```

## `deriveKnowledgeBudgetCap`

Removed from lines 352-364.

```
/**
 * THE derivation (design notes i-iv): combines {@link measureKnowledgeBudgetPressure}'s
 * dropped-weight percentiles with `cacheMix` (any {@link CacheHitTokens} grain, e.g. a
 * {@link CacheHitTotals} class/run total) to recommend a cap.
 *
 * "NO CHANGE" is explicitly legal and is the DEFAULT (design note iv) — this function only
 * recommends raising the cap when BOTH: (a) p90 dropped weight is non-trivial (>=
 * {@link TRIVIAL_DROPPED_WEIGHT_CHARS}), AND (b) there is cache-mix data to price the delta
 * against (`cacheMix` is provided) — a non-trivial pressure with no cache data to price is left
 * UNCHANGED too, because a raise that cannot be priced cannot be argued. When it does
 * recommend raising, the new cap is `currentCapChars + droppedWeightP90` exactly (no headroom
 * padding), so the baseline can be re-derived byte for byte from the same inputs.
 */
```
