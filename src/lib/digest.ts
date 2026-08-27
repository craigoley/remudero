import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readFileSync as nodeReadFileSync, readdirSync as nodeReaddirSync } from "node:fs";
import { gunzipSync as nodeGunzipSync } from "node:zlib";

import { readLedgerLines } from "./status.js";
import { ledgerRotationEntries, rotationStampIso, type LedgerGrepFsDeps } from "./ledger-grep.js";
import { notify, type NotifyChannel, type NotifyDeps } from "./notify.js";
import { renderAlertsSummary, type AlertsPollSummary } from "./ops.js";
import { renderIssuesSummary, type IssuesPollSummary } from "./issues-intake.js";
import { renderInboxPollSummary, type InboxPollSummary } from "./inbox.js";
import type { RundownLine } from "./drain.js";
import type { LastSeenStore } from "./last-seen.js";
import {
  decideMeasurementCadence,
  readMeasurementCadenceMarker,
  recordMeasurementCadenceFire,
  type MeasurementCadenceDecision,
} from "./measurement-cadence.js";

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

/** One ledger line, loosely typed like {@link readLedgerLines}'s return. */
export type LedgerLine = Record<string, unknown>;

/** Ledger lines with `ts >= sinceIso`, in original (chronological) order. */
export function collectSince(lines: LedgerLine[], sinceIso: string): LedgerLine[] {
  return lines.filter((l) => typeof l.ts === "string" && (l.ts as string) >= sinceIso);
}

// ── W1-T929: THE CACHE-HIT RATIO — cache_read/(cache_read+input+cache_creation) ─────────────
//
// worker.ts's TokenUsage already nests `cacheRead`/`input`/`cacheCreation` on the `tokens`
// field of every worker AND brain-plane ledger line (workerLedgerFields, W1-T6); nothing read
// it. This is the ONE derivation (design note (i)): `cacheHitRatio` is the sole arithmetic,
// `aggregateCacheHitTotals` is the sole grouping traversal, and BOTH this module's `summarize`
// and status-board.ts's `buildStatusBoard` walk it — the two surfaces can disagree on how they
// RENDER a figure, never on what the figure IS.

/** The three token counts a cache-hit ratio is derived from — exactly the fields worker.ts's
 *  `TokenUsage` nests on every ledgered call line (`tokens.cacheRead`/`input`/`cacheCreation`). */
export interface CacheHitTokens {
  cacheRead: number;
  input: number;
  cacheCreation: number;
}

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
export function cacheHitRatio(tokens: CacheHitTokens): number | undefined {
  const denom = tokens.cacheRead + tokens.input + tokens.cacheCreation;
  return denom > 0 ? tokens.cacheRead / denom : undefined;
}

/**
 * One grouping's (one run, or one task class) summed token totals, plus how many of its call
 * lines actually carried usable token data — the `coveredLines`/`callLines` pair a `cacheHitRatio`
 * of `undefined` renders its coverage fraction from (design note (iii): "UNKNOWN … WITH THE
 * COVERAGE FRACTION beside the figure").
 */
export interface CacheHitGrain extends CacheHitTokens {
  /** Total worker/brain-plane call lines observed for this grouping. */
  callLines: number;
  /** Of `callLines`, how many carried a non-zero token envelope (usable data). */
  coveredLines: number;
}

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

/** A ledger line is a worker/brain-plane CALL line iff it carries `workerLedgerFields`' `model`
 *  + `effort` pair (W1-T6) — present on every call, predating the cache columns themselves, so
 *  this predicate never mistakes a `run.start`/`verdict`/poll line for a call that just has no
 *  token data. */
function isCallLine(l: LedgerLine): boolean {
  return typeof l.model === "string" && typeof l.effort === "string";
}

/** The line's token counts, off its nested `tokens` field (worker.ts's `TokenUsage`, spread
 *  verbatim by `appendLedger` — never snake_cased), or `undefined` when the shape isn't there
 *  at all (a line predating `tokens`, or malformed). */
function lineTokens(l: LedgerLine): CacheHitTokens | undefined {
  const t = l.tokens;
  if (!t || typeof t !== "object") return undefined;
  const { cacheRead, input, cacheCreation } = t as Record<string, unknown>;
  return typeof cacheRead === "number" && typeof input === "number" && typeof cacheCreation === "number"
    ? { cacheRead, input, cacheCreation }
    : undefined;
}

function emptyCacheHitGrain(): CacheHitGrain {
  return { cacheRead: 0, input: 0, cacheCreation: 0, callLines: 0, coveredLines: 0 };
}

/** Fold one call line into `grain` — always counts toward `callLines`; only adds to the token
 *  totals (and `coveredLines`) when the line's envelope actually carried a non-zero denominator,
 *  so an uncovered call can never silently pass as a healthy 0% hit rate. */
function foldCacheHitLine(grain: CacheHitGrain, tokens: CacheHitTokens): void {
  grain.callLines++;
  if (tokens.cacheRead + tokens.input + tokens.cacheCreation <= 0) return;
  grain.coveredLines++;
  grain.cacheRead += tokens.cacheRead;
  grain.input += tokens.input;
  grain.cacheCreation += tokens.cacheCreation;
}

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
export function aggregateCacheHitTotals(lines: LedgerLine[]): CacheHitTotals | undefined {
  const taskClassByRun = new Map<string, string>();
  for (const l of lines) {
    if (l.step === "run.start" && typeof l.run_id === "string") {
      taskClassByRun.set(l.run_id, typeof l.task_class === "string" ? l.task_class : "unknown");
    }
  }
  const byRun = new Map<string, CacheHitGrain>();
  const byClass = new Map<string, CacheHitGrain>();
  let anyCovered = false;
  for (const l of lines) {
    if (!isCallLine(l) || typeof l.run_id !== "string") continue;
    const tokens = lineTokens(l);
    if (!tokens) continue;
    if (tokens.cacheRead + tokens.input + tokens.cacheCreation > 0) anyCovered = true;

    const runGrain = byRun.get(l.run_id) ?? emptyCacheHitGrain();
    foldCacheHitLine(runGrain, tokens);
    byRun.set(l.run_id, runGrain);

    const taskClass = taskClassByRun.get(l.run_id) ?? "unknown";
    const classGrain = byClass.get(taskClass) ?? emptyCacheHitGrain();
    foldCacheHitLine(classGrain, tokens);
    byClass.set(taskClass, classGrain);
  }
  if (!anyCovered) return undefined;
  return { byRun: Object.fromEntries(byRun), byClass: Object.fromEntries(byClass) };
}

/**
 * Format ONE {@link CacheHitGrain} as `NN.N% (coverage NN%)`, or `UNKNOWN (coverage NN%)` when
 * {@link cacheHitRatio} returns `undefined` (design note (iii)) — the ONE formatting rule both
 * this module's {@link renderCacheHitLine} and status-board.ts's own per-grain render share, so
 * "UNKNOWN" vs a real percentage never reads differently across the two surfaces.
 */
export function formatCacheHitFigure(g: CacheHitGrain): string {
  const ratio = cacheHitRatio(g);
  const coveragePct = g.callLines > 0 ? Math.round((g.coveredLines / g.callLines) * 100) : 0;
  return ratio === undefined ? `UNKNOWN (coverage ${coveragePct}%)` : `${(ratio * 100).toFixed(1)}% (coverage ${coveragePct}%)`;
}

/** Render one {@link CacheHitTotals} grain map as one digest line, e.g.
 *  `cache hit by run: R1=83.3% (coverage 100%), R2=UNKNOWN (coverage 0%)` — sorted by key so the
 *  render is deterministic. */
export function renderCacheHitLine(label: string, grains: Record<string, CacheHitGrain>): string {
  const parts = Object.keys(grains)
    .sort()
    .map((key) => `${key}=${formatCacheHitFigure(grains[key])}`);
  return `${label}: ${parts.join(", ")}`;
}

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

/**
 * One window's totals over every `learnings.injected` ledger row (W1-T940). `budgetChars` is
 * every DISTINCT `budget_chars` value seen (sorted ascending), not one summary number, so a
 * mid-window constant change is visible instead of averaged away. `globalRefusedReasons` keys
 * the verbatim reason string to how many rows carried it — deduped, and deliberately kept off
 * `dropped` (design note (iii)).
 */
export interface LearningsInjectionTotals {
  /** Count of `learnings.injected` ledger rows in the window. */
  rows: number;
  /** Sum of each row's `matched` count. */
  matched: number;
  /** Sum of each row's `dropped` array length. */
  dropped: number;
  /** Every distinct `budget_chars` value seen, ascending. */
  budgetChars: number[];
  /** Verbatim `global_refused_reason` string → how many rows carried it. */
  globalRefusedReasons: Record<string, number>;
}

/**
 * Group `lines` (any ledger window) into {@link LearningsInjectionTotals} — the ONE traversal
 * status-board.ts's `buildStatusBoard` walks too (grep-provable: `aggregateLearningsInjection(`
 * in src/lib/status-board.ts), so the two surfaces can never disagree on which rows count.
 *
 * `undefined` when `lines` carries NO `learnings.injected` rows at all (design note (iv), the
 * same soft-compose discipline {@link aggregateCacheHitTotals} keeps above) — the caller then
 * renders explicit absence rather than a fabricated `dropped: 0` for a window that saw no spawns.
 */
export function aggregateLearningsInjection(lines: LedgerLine[]): LearningsInjectionTotals | undefined {
  let rows = 0;
  let matched = 0;
  let dropped = 0;
  const budgetCharsSeen = new Set<number>();
  const reasonCounts = new Map<string, number>();
  for (const l of lines) {
    if (l.step !== "learnings.injected") continue;
    rows++;
    if (typeof l.matched === "number") matched += l.matched;
    if (Array.isArray(l.dropped)) dropped += l.dropped.length;
    if (typeof l.budget_chars === "number") budgetCharsSeen.add(l.budget_chars);
    if (typeof l.global_refused_reason === "string" && l.global_refused_reason.length > 0) {
      reasonCounts.set(l.global_refused_reason, (reasonCounts.get(l.global_refused_reason) ?? 0) + 1);
    }
  }
  if (rows === 0) return undefined;
  return {
    rows,
    matched,
    dropped,
    budgetChars: [...budgetCharsSeen].sort((a, b) => a - b),
    globalRefusedReasons: Object.fromEntries(reasonCounts),
  };
}

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

/**
 * One window's per-spawn DROPPED-FACT WEIGHT pressure (design note i): p50/p90 chars of
 * matched-but-dropped fact the budget refused, per spawn — not a count, a WEIGHT.
 */
export interface KnowledgeBudgetPressure {
  /** `learnings.injected` rows carrying at least one `dropped` id resolvable to a weight. */
  spawnsMeasured: number;
  /** Median per-spawn dropped-fact weight, in chars. */
  droppedWeightP50: number;
  /** 90th-percentile per-spawn dropped-fact weight, in chars — the figure {@link deriveKnowledgeBudgetCap} prices. */
  droppedWeightP90: number;
}

/** Nearest-rank percentile (0 < p <= 100) over `values` — deterministic, dependency-free, and
 *  exactly the two figures design note (i) asks for (p50, p90). Does not mutate `values`. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx];
}

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
export function measureKnowledgeBudgetPressure(
  lines: LedgerLine[],
  entryWeights: Record<string, number>,
): KnowledgeBudgetPressure | undefined {
  const perSpawn: number[] = [];
  for (const l of lines) {
    if (l.step !== "learnings.injected" || !Array.isArray(l.dropped)) continue;
    let weight = 0;
    for (const id of l.dropped) {
      if (typeof id === "string" && typeof entryWeights[id] === "number") weight += entryWeights[id];
    }
    if (weight > 0) perSpawn.push(weight);
  }
  if (perSpawn.length === 0) return undefined;
  return {
    spawnsMeasured: perSpawn.length,
    droppedWeightP50: percentile(perSpawn, 50),
    droppedWeightP90: percentile(perSpawn, 90),
  };
}

/** English-text heuristic for pricing the marginal cap increase (design note ii): ~4 characters
 *  per token. A deliberately coarse approximation — not a model-specific tokenizer count — same
 *  as every other "roughly N tokens" figure this plan already estimates in. */
export const CHARS_PER_TOKEN = 4;

/**
 * Below this many p90 dropped chars, the pressure is TRIVIAL (design note iv) — less than one
 * typical dropped fact line (`entryBudgetWeight`'s rendered `- <fact> [src: learnings#<id>]`
 * line is almost never under 40 chars even for the shortest real entry), so it is not worth
 * pricing a raise over.
 */
export const TRIVIAL_DROPPED_WEIGHT_CHARS = 40;

/**
 * A derived recommendation for the knowledge-budget cap (design notes i-iv), carrying the
 * INPUTS that produced it so the recommendation is auditable, not just the number.
 */
export interface KnowledgeBudgetDerivation {
  currentCapChars: number;
  pressure: KnowledgeBudgetPressure | undefined;
  /** Proposed increase over `currentCapChars`, in chars — 0 unless `changed`. */
  deltaChars: number;
  /** `deltaChars` priced on the {@link CHARS_PER_TOKEN} heuristic. */
  deltaTokens: number;
  /** The {@link cacheHitRatio} the delta was priced at, or `undefined` when no cache-mix data was available to price it. */
  cacheHitRatioUsed: number | undefined;
  /** The cap this derivation recommends — equals `currentCapChars` unless `changed`. */
  recommendedCapChars: number;
  /** Whether this derivation recommends moving off `currentCapChars` at all. */
  changed: boolean;
  /** Human-readable justification — WHY changed is true/false, for the baseline file's record. */
  reason: string;
}

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
export function deriveKnowledgeBudgetCap(
  pressure: KnowledgeBudgetPressure | undefined,
  cacheMix: CacheHitTokens | undefined,
  currentCapChars: number,
): KnowledgeBudgetDerivation {
  const cacheHitRatioUsed = cacheMix ? cacheHitRatio(cacheMix) : undefined;

  if (!pressure) {
    return {
      currentCapChars,
      pressure,
      deltaChars: 0,
      deltaTokens: 0,
      cacheHitRatioUsed,
      recommendedCapChars: currentCapChars,
      changed: false,
      reason: "no measurable dropped-fact weight in the window (no learnings.injected rows with a resolvable dropped id)",
    };
  }
  if (pressure.droppedWeightP90 < TRIVIAL_DROPPED_WEIGHT_CHARS) {
    return {
      currentCapChars,
      pressure,
      deltaChars: 0,
      deltaTokens: 0,
      cacheHitRatioUsed,
      recommendedCapChars: currentCapChars,
      changed: false,
      reason: `p90 dropped weight ${pressure.droppedWeightP90} chars is below the ${TRIVIAL_DROPPED_WEIGHT_CHARS}-char triviality floor`,
    };
  }
  const deltaChars = pressure.droppedWeightP90;
  const deltaTokens = Math.ceil(deltaChars / CHARS_PER_TOKEN);
  if (cacheHitRatioUsed === undefined) {
    return {
      currentCapChars,
      pressure,
      deltaChars,
      deltaTokens,
      cacheHitRatioUsed,
      recommendedCapChars: currentCapChars,
      changed: false,
      reason: `p90 dropped weight ${deltaChars} chars (${deltaTokens} tokens) is non-trivial, but no cache-mix data was available to price the delta — a raise that cannot be priced is not recommended`,
    };
  }
  return {
    currentCapChars,
    pressure,
    deltaChars,
    deltaTokens,
    cacheHitRatioUsed,
    recommendedCapChars: currentCapChars + deltaChars,
    changed: true,
    reason:
      `p90 dropped weight ${deltaChars} chars (${deltaTokens} tokens) priced at the measured ` +
      `${(cacheHitRatioUsed * 100).toFixed(1)}% cache-hit ratio -- raising the cap by the measured pressure`,
  };
}

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

export interface DigestSummary {
  sinceIso: string;
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
   * W1-T178 (verdict stability): count of `review.downgrade_suppressed` ledger
   * lines inside the window — a semantic-lane downgrade suppressed because the
   * deterministic floor still passed on an unchanged head. This is the signal
   * that tells whether the semantic lane is getting noisier or quieter over
   * time; a suppression is never silent (see run-task.ts's `runReview`), but
   * this is where the COUNT is visible without reading the raw ledger.
   */
  verdictDowngradesSuppressed: number;
}

/** Reduce the day's ledger lines to the counts a digest reports. Pure over its input. */
export function summarize(lines: LedgerLine[], sinceIso: string): DigestSummary {
  const since = collectSince(lines, sinceIso);
  const summary: DigestSummary = {
    sinceIso,
    merged: [],
    blocked: [],
    escalations: [],
    costUsd: 0,
    verdictDowngradesSuppressed: 0,
  };
  for (const l of since) {
    if (l.step === "review.downgrade_suppressed") summary.verdictDowngradesSuppressed++;
    if (l.step === "verdict" && typeof l.task_id === "string") {
      if (l.verdict === "merged") {
        summary.merged.push(l.task_id);
      } else if (typeof l.verdict === "string" && l.verdict.startsWith("blocked")) {
        summary.blocked.push({ taskId: l.task_id, verdict: l.verdict, prUrl: typeof l.pr_url === "string" ? l.pr_url : undefined });
      }
      if (typeof l.cost_usd === "number") summary.costUsd += l.cost_usd;
    }
    if (l.step === "escalation.issue_opened" && typeof l.task_id === "string" && typeof l.issue_url === "string") {
      summary.escalations.push({ taskId: l.task_id, class: String(l.class ?? "?"), issueUrl: l.issue_url });
    }
    if (l.step === "ops.alerts_polled" && l.alerts && typeof l.alerts === "object") {
      summary.alerts = l.alerts as AlertsPollSummary;
    }
    if (l.step === "issues.polled" && l.issues && typeof l.issues === "object") {
      summary.issues = l.issues as IssuesPollSummary;
    }
    if (l.step === "inbox.polled" && l.inbox && typeof l.inbox === "object") {
      summary.inbox = l.inbox as InboxPollSummary;
    }
    // The rung's own row, latest-wins like the three above. Reading the ROW rather than calling the
    // rung's module keeps this file a pure ledger reader: no new import, no new seam, no write path.
    if (l.step === "board_review.ran") {
      summary.boardReview = {
        oldestOpenAgeHours: typeof l.oldestOpenAgeHours === "number" ? l.oldestOpenAgeHours : undefined,
        redCount: typeof l.redCount === "number" ? l.redCount : undefined,
        unhandledEscalationCount: typeof l.unhandledEscalationCount === "number" ? l.unhandledEscalationCount : undefined,
        itemsConsidered: typeof l.itemsConsidered === "number" ? l.itemsConsidered : undefined,
        proposals: typeof l.proposals === "number" ? l.proposals : undefined,
      };
    }
    // W1-T2345's counter trip. The sweep ALREADY writes this row; what was missing is a READER.
    // The shard's own design says so in terms — "the escalation surface is THE DIGEST … a second
    // queue nobody drains is not an answer" — and `digest.ts` referenced the step ZERO times.
    if (l.step === "sweep.repeat_escalated") {
      const prNumber = typeof l.pr_number === "number" ? l.pr_number : undefined;
      const list = (summary.repeatEscalations ??= []);
      // Dedup on PR number: the union can replay one row across overlapping rotations, and a
      // rotation artefact must never read as a second stuck PR.
      if (prNumber === undefined || !list.some((e) => e.prNumber === prNumber)) {
        list.push({
          prNumber,
          disposition: typeof l.disposition === "string" ? l.disposition : undefined,
          streak: typeof l.streak === "number" ? l.streak : undefined,
        });
      }
    }
  }
  summary.cacheHit = aggregateCacheHitTotals(since);
  return summary;
}

/**
 * Deep-link a task id to its console card (W1-T144, MASTER-PLAN §7B). A HASH route —
 * `#task=<id>` — so the link never leaves the client: no bearer token rides along in
 * message-app history, and it layers cleanly on top of whatever base URL (and its own
 * `?token=`, per apps/dashboard's `readConfig`) the operator already has bookmarked.
 * `consoleBaseUrl` is a full origin (e.g. `http://100.x.x.x:4317`, config.ts's
 * `consoleUrl`); a trailing slash is tolerated. `taskId` is percent-encoded so a link
 * for task X can never be mistaken for — or collide with — a link for a different id.
 */
export function consoleCardUrl(consoleBaseUrl: string, taskId: string): string {
  return `${consoleBaseUrl.replace(/\/+$/, "")}/#task=${encodeURIComponent(taskId)}`;
}

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
  const incomplete: string[] = [];
  if (s.read && s.read.unread.length > 0) incomplete.push(`${s.read.unread.length} rotation(s) unreadable`);
  if (s.read && s.read.archivesTruncated > 0) {
    incomplete.push(`${s.read.archivesTruncated} rotation(s) past the ${s.read.capsApplied.maxArchives} archive cap`);
  }
  if (s.read && s.read.rowsTruncated > 0) {
    incomplete.push(`${s.read.rowsTruncated} row(s) past the ${s.read.capsApplied.maxRows} row cap`);
  }
  const lines = [
    `Remudero daily digest — since ${s.sinceIso}`,
    ...(incomplete.length ? [`INCOMPLETE READ — this digest is missing rows: ${incomplete.join("; ")}`] : []),
    `merged: ${s.merged.length ? s.merged.join(", ") : "(none)"}`,
    `blocked: ${
      s.blocked.length ? s.blocked.map((b) => `${b.taskId} (${b.verdict}${b.prUrl ? ` — ${b.prUrl}` : ""})`).join(", ") : "(none)"
    }`,
    `escalations: ${
      s.escalations.length
        ? s.escalations
            .map((e) => `[${e.class}] ${e.taskId} — ${e.issueUrl}${consoleBaseUrl ? ` — ${consoleCardUrl(consoleBaseUrl, e.taskId)}` : ""}`)
            .join(", ")
        : "(none)"
    }`,
    `alerts: ${s.alerts ? renderAlertsSummary(s.alerts) : "(no poll this window)"}`,
    `issues reviewed: ${s.issues ? renderIssuesSummary(s.issues) : "(no poll this window)"}`,
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
    // W1-T929: soft-composed — present only when the window carries usable cache-token data
    // (see the `cacheHit` field's doc on DigestSummary), two lines (per-run, per-class), never
    // a "(no data)" placeholder otherwise.
    ...(s.cacheHit ? [renderCacheHitLine("cache hit by run", s.cacheHit.byRun), renderCacheHitLine("cache hit by class", s.cacheHit.byClass)] : []),
    `verdict downgrades suppressed: ${s.verdictDowngradesSuppressed}`,
    `notional cost: $${s.costUsd.toFixed(2)}`,
  ];
  return lines.join("\n");
}

/** One line for {@link DigestSummary.repeatEscalations} — every PR that tripped the repeat bound in
 *  this window, each naming the verdict that would not move and how many consecutive derivations it
 *  survived. Every field optional, so a row missing one omits that clause rather than printing
 *  `undefined`. Mirrors `renderBoardReviewSnapshot`'s shape. */
function renderRepeatEscalations(entries: RepeatEscalationDigestEntry[]): string {
  return entries
    .map((e) => {
      const who = e.prNumber !== undefined ? `#${e.prNumber}` : "(pr unknown)";
      const what = e.disposition ? ` ${e.disposition}` : "";
      const many = e.streak !== undefined ? ` x${e.streak}` : "";
      return `${who}${what}${many}`;
    })
    .join(", ");
}

/** One line for {@link DigestSummary.boardReview} — every field optional, so a row missing one omits
 *  that clause rather than printing `undefined`. Mirrors `renderAlertsSummary`'s shape. */
function renderBoardReviewSnapshot(b: BoardReviewDigestSnapshot): string {
  const parts: string[] = [];
  if (typeof b.oldestOpenAgeHours === "number") parts.push(`oldest open ${b.oldestOpenAgeHours.toFixed(1)}h`);
  if (typeof b.redCount === "number") parts.push(`${b.redCount} red`);
  if (typeof b.unhandledEscalationCount === "number") parts.push(`${b.unhandledEscalationCount} unhandled escalation(s)`);
  if (typeof b.itemsConsidered === "number") parts.push(`${b.itemsConsidered} item(s) considered`);
  if (typeof b.proposals === "number") parts.push(`${b.proposals} proposal(s)`);
  return parts.length ? parts.join(", ") : "(ran, no counts recorded)";
}

/**
 * Build the digest text straight from a ledger file, as of `sinceIso`. `consoleBaseUrl`
 * threads through to {@link renderDigest} — see its doc for the W1-T144 deep-link contract.
 */
/** The real fs behind {@link readDigestWindow} — the SAME four operations `ledger-grep.ts`'s own
 *  {@link LedgerGrepFsDeps} names, reused rather than a fifth shape, so a test drives this reader
 *  with the fixtures that module's callers already use. */
const realDigestFs: LedgerGrepFsDeps = {
  readdirSync: (dir) => nodeReaddirSync(dir),
  existsSync: () => true,
  readFileSync: (path) => nodeReadFileSync(path),
  gunzipSync: (buf) => nodeGunzipSync(buf),
};

/**
 * W1-T2388 — A BACKSTOP, NOT A POLICY. The bound that matters is the WINDOW (every archive stamped
 * before `sinceIso` is skipped unopened); this cap exists only so an unbounded corpus cannot make a
 * reporter unbounded. It sits ABOVE the whole measured corpus (672 rotations, 118.1 MiB) and above
 * the worst 24-hour window in it (649 rotations, 89.4 MiB), so it does not bite on today's data —
 * and when it does bite, {@link renderDigest} SAYS SO rather than rendering a shorter board.
 */
export const DIGEST_MAX_ARCHIVES = 1024;

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
export const DIGEST_MAX_ROWS = 250_000;

/** What one windowed union read actually reached — carried so the render can refuse to look quiet
 *  when it was merely incomplete (W1-T444's coverage-not-readability rule, applied to a reporter). */
export interface DigestWindowRead {
  lines: LedgerLine[];
  /** Rotations the enumerator classified under `<ledgerPath>`'s own directory. */
  archivesConsidered: number;
  /** In-window rows dropped because the row cap bit — always rendered, never silent. */
  rowsTruncated: number;
  /** The caps ACTUALLY applied. Carried rather than re-read from the constants, so a render can
   *  never name a bound the read did not use — the first draft printed {@link DIGEST_MAX_ROWS}
   *  beside a truncation produced by an injected cap, and its own test caught it. */
  capsApplied: { maxArchives: number; maxRows: number };
  /** Skipped UNOPENED because their own filename stamp precedes `sinceIso`. */
  archivesSkippedByStamp: number;
  /** Actually opened and parsed. */
  archivesRead: number;
  /** Found, in-window, and NOT opened because {@link DIGEST_MAX_ARCHIVES} bit. */
  archivesTruncated: number;
  /** In-window rotations that were opened and threw — partial coverage, never silence. */
  unread: string[];
}

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
export function readDigestWindow(
  ledgerPath: string,
  sinceIso: string,
  opts: { maxArchives?: number; maxRows?: number; fs?: LedgerGrepFsDeps } = {},
): DigestWindowRead {
  const fs = opts.fs ?? realDigestFs;
  const cap = opts.maxArchives ?? DIGEST_MAX_ARCHIVES;
  const rowCap = opts.maxRows ?? DIGEST_MAX_ROWS;
  const dir = dirname(ledgerPath);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // An unreadable directory is "no archives" — the live read below still answers, exactly as it
    // did before this function existed. Never a throw in a reporter.
  }
  const rotations = ledgerRotationEntries(names, dir);
  const inWindow = rotations.filter((e) => {
    const stamp = rotationStampIso(basename(e.path));
    return stamp === undefined || stamp >= sinceIso;
  });
  const skipped = rotations.length - inWindow.length;
  // Newest first, so a cap that bites drops the OLDEST in-window archives rather than an arbitrary
  // set — and `archivesTruncated` says how many.
  const ordered = [...inWindow].sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
  const opened = ordered.slice(0, cap);
  const seen = new Set<string>();
  const lines: LedgerLine[] = [];
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
  const addText = (text: string): void => {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: LedgerLine;
      try {
        parsed = JSON.parse(line) as LedgerLine;
      } catch {
        continue; // a torn line is skipped, exactly as `readLedgerLines` already skips one
      }
      if (typeof parsed.ts !== "string" || (parsed.ts as string) < sinceIso) continue;
      if (seen.has(line)) continue;
      if (lines.length >= rowCap) { rowsTruncated++; continue; }
      seen.add(line);
      lines.push(parsed);
    }
  };
  let rowsTruncated = 0;
  const unread: string[] = [];
  for (const entry of opened) {
    try {
      const buf = fs.readFileSync(entry.path);
      addText((entry.form === "gzip" ? fs.gunzipSync(buf) : buf).toString("utf8"));
    } catch {
      // An archive that cannot be read or gunzipped is RECORDED as unread, never skipped silently:
      // `DigestWindowRead.unreadArchives` is what lets the render state an incomplete read on its
      // own line instead of looking quiet (W1-T444's coverage-not-readability rule). Swallowing
      // here is deliberate — one corrupt rotation must not cost the whole digest — and the caller
      // still learns it happened.
      unread.push(entry.path);
    }
  }
  try {
    addText(fs.readFileSync(ledgerPath).toString("utf8"));
  } catch {
    // The live file may genuinely not exist yet — `readLedgerLines` returns [] for that too.
  }
  return {
    lines,
    archivesConsidered: rotations.length,
    archivesSkippedByStamp: skipped,
    archivesRead: opened.length - unread.length,
    archivesTruncated: ordered.length - opened.length,
    rowsTruncated,
    capsApplied: { maxArchives: cap, maxRows: rowCap },
    unread,
  };
}

export function buildDigest(ledgerPath: string, sinceIso: string, consoleBaseUrl?: string): string {
  // W1-T2388: the WINDOWED union, not the live file alone. `readLedgerLines` stays imported and in
  // use elsewhere in this module; only the digest's own read moves.
  const read = readDigestWindow(ledgerPath, sinceIso);
  const summary = summarize(read.lines, sinceIso);
  return renderDigest({ ...summary, read }, consoleBaseUrl);
}

/** Build the digest from `ledgerPath` and deliver it over the SAME notify channel as real-time pings. */
export function sendDigest(ledgerPath: string, sinceIso: string, deps: NotifyDeps, consoleBaseUrl?: string): string {
  const text = buildDigest(ledgerPath, sinceIso, consoleBaseUrl);
  notify(text, deps);
  return text;
}

/**
 * Render a post-drain {@link RundownLine} array as ONE digest-channel message (W1-T144):
 * the PUSH counterpart to `drain.ts`'s own `renderRundown` (a pull-view printed to the
 * terminal that kicked the drain off). Every non-merged line — `blocked`/`escalated`,
 * the outcomes an operator who stepped away actually needs to see — carries a
 * {@link consoleCardUrl} deep link to that task's card; a `merged` line stays a bare
 * confirmation, since there is nothing to act on. Mirrors `renderRundown`'s own
 * "(no tasks attempted)" empty-state text so the two views never disagree on shape.
 */
export function renderRundownPush(lines: RundownLine[], consoleBaseUrl: string): string {
  const body =
    lines.length === 0
      ? ["(no tasks attempted)"]
      : lines.map((l) => {
          if (l.outcome === "merged") return `merged     : ${l.taskId}`;
          const link = consoleCardUrl(consoleBaseUrl, l.taskId);
          if (l.outcome === "escalated") return `escalated  : ${l.taskId} — [${l.escalation!.class}] ${l.escalation!.issueUrl} — ${link}`;
          return `blocked    : ${l.taskId}${l.detail ? ` — ${l.detail}` : ""} — ${link}`;
        });
  return ["Remudero drain rundown", ...body].join("\n");
}

/**
 * Deliver a post-drain rundown over the SAME notify channel as {@link sendDigest} and
 * `run-task.ts`'s MANUAL/HARD_STOP escalation pings (grep-provable: this is the ONE call
 * to `notify()` a drain's push runs through, not a second/parallel sender — W1-T144
 * acceptance "a drain rundown emits through the SAME channel, not a second transport").
 */
export function sendRundown(lines: RundownLine[], consoleBaseUrl: string, deps: NotifyDeps): string {
  const text = renderRundownPush(lines, consoleBaseUrl);
  notify(text, deps);
  return text;
}

// ── W1-T163: the digest becomes MARKER-AWARE, sharing lib/last-seen.ts's per-token marker with
// the console recap (lib/recap.ts) — so a pushed digest and a pulled recap, read off the SAME
// token's SAME marker, cover the identical window: "push and pull tell ONE story." ────────────

/** The digest's pre-marker default lookback (unchanged from before this feature existed) — used
 *  ONLY the very first time a token is seen, so a first-ever digest for a token still reports
 *  the last day rather than the entire ledger's history. Every later call reads that token's
 *  OWN previously-advanced marker instead. */
export function defaultDigestSinceIso(nowIso: string): string {
  return new Date(Date.parse(nowIso) - 24 * 60 * 60 * 1000).toISOString();
}

/** The `sinceIso` a marker-aware digest for `tokenId` would use RIGHT NOW, without advancing
 *  anything — the same value {@link buildMarkerAwareDigest}/{@link sendMarkerAwareDigest} resolve
 *  internally, exposed so a caller (e.g. a `--dry-run` preview) can show it explicitly. */
export function resolveMarkerAwareSince(store: LastSeenStore, tokenId: string, nowIso: string): string {
  return store.get(tokenId) ?? defaultDigestSinceIso(nowIso);
}

/**
 * Build (never send, never advance the marker) the digest text for `tokenId` off its CURRENT
 * marker — a read-only preview, exactly like `buildDigest` but marker-aware instead of taking an
 * explicit `sinceIso`. Used by `rmd digest --dry-run` so a preview never mutates state.
 */
export function buildMarkerAwareDigest(
  ledgerPath: string,
  store: LastSeenStore,
  tokenId: string,
  nowIso: string,
  consoleBaseUrl?: string,
): { text: string; sinceIso: string } {
  const sinceIso = resolveMarkerAwareSince(store, tokenId, nowIso);
  return { text: buildDigest(ledgerPath, sinceIso, consoleBaseUrl), sinceIso };
}

/**
 * Send a marker-aware digest for `tokenId`: read its CURRENT marker (or the pre-marker 24h
 * default on a first-ever send), deliver exactly like {@link sendDigest}, then advance the SAME
 * {@link LastSeenStore} `tokenId` to `nowIso` — the identical store `lib/board.ts`'s `GET
 * /v1/status` advances on a board view (see lib/last-seen.ts's module header). Whichever of the
 * two — a digest send or a board view — happens first moves the marker forward; the other then
 * only ever reports what's left, so the two never double-report or silently skip a window.
 */
export function sendMarkerAwareDigest(
  ledgerPath: string,
  store: LastSeenStore,
  tokenId: string,
  deps: NotifyDeps,
  nowIso: string,
  consoleBaseUrl?: string,
): string {
  const sinceIso = resolveMarkerAwareSince(store, tokenId, nowIso);
  const text = sendDigest(ledgerPath, sinceIso, deps, consoleBaseUrl);
  store.advance(tokenId, nowIso);
  return text;
}

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

// ── The cadence: its OWN row, its OWN marker (claim: "fires on its own cadence ... existing
//    three cadence verbs keep their own row and are not dragged to the digest interval") ──────

/** The digest cadence's policy shape — deliberately a SUBSET of
 *  {@link "./measurement-cadence.js".MeasurementCadencePolicy} (no `escalate`: the digest never
 *  drafts a proposal, it only reads and sends) so `plan/policy.yaml`'s `digestCadence` row can
 *  never be mistaken for `measurementCadence`'s. */
export interface DigestCadencePolicy {
  enabled: boolean;
  minIntervalMinutes: number;
  maxPerDay: number;
}

/** `<root>/state/last-digest-cadence.json` — the digest's OWN fire marker, distinct from
 *  `measurementCadenceMarkerPath`'s `last-measurement-cadence.json` (design above): the two
 *  cadences never read or write each other's file, so they can never throttle one another. */
export function digestCadenceMarkerPath(root: string): string {
  return join(root, "state", "last-digest-cadence.json");
}

/** The digest cadence's real decision, assembled from live state — mirrors
 *  `measurement-cadence.ts`'s own `measurementCadenceCheck` shape exactly, reusing
 *  {@link decideMeasurementCadence} (the SAME pure function) rather than a second one. */
export function digestCadenceCheck(opts: { root: string; policy: DigestCadencePolicy; now?: Date }): MeasurementCadenceDecision {
  const marker = readMeasurementCadenceMarker(digestCadenceMarkerPath(opts.root));
  return decideMeasurementCadence({
    policy: { ...opts.policy, escalate: false },
    marker,
    now: opts.now ?? new Date(),
  });
}

/** Record a digest fire on the digest's OWN marker file — the SAME rolling-24h window
 *  {@link recordMeasurementCadenceFire} already implements, just pointed at
 *  {@link digestCadenceMarkerPath} instead of the measurement-cadence family's file. */
export function recordDigestCadenceFire(root: string, at: Date): void {
  const path = digestCadenceMarkerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  recordMeasurementCadenceFire(path, at, 24 * 60 * 60 * 1000);
}

// ── The interval: read from policy, every console-offered value checked against the declared
//    bound (claim: "the interval is read from policy and every value the console offers is
//    inside the declared bounds") ──────────────────────────────────────────────────────────────

/** The console's offered digest-interval choices, in HOURS — {1, 2, 4, 8, 12, 24}. Exported so
 *  a caller (a console route, or this file's own bound check below) never hand-copies the set. */
export const DIGEST_INTERVAL_OPTIONS_HOURS: readonly number[] = [1, 2, 4, 8, 12, 24];

/** {@link DIGEST_INTERVAL_OPTIONS_HOURS}, converted to the minutes unit
 *  `digestCadence.minIntervalMinutes` is stored in. */
export function digestIntervalOptionsMinutes(): number[] {
  return DIGEST_INTERVAL_OPTIONS_HOURS.map((h) => h * 60);
}

/** One console-offered interval value that falls OUTSIDE a declared `[min, max]` bound. */
export interface DigestIntervalBoundViolation {
  hours: number;
  minutes: number;
  reason: string;
}

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
export function digestIntervalOptionsOutOfBounds(bounds: { min: number; max: number }): DigestIntervalBoundViolation[] {
  const out: DigestIntervalBoundViolation[] = [];
  for (const hours of DIGEST_INTERVAL_OPTIONS_HOURS) {
    const minutes = hours * 60;
    if (minutes < bounds.min || minutes > bounds.max) {
      out.push({ hours, minutes, reason: `${minutes}m (${hours}h) is outside the declared bound [${bounds.min}, ${bounds.max}]` });
    }
  }
  return out;
}

// ── The two halves, marked per item (claims: "every deterministic figure carries the query
//    that reproduces it, and an item without one fails the render" / "a generated item is
//    marked per item rather than only by its section") ────────────────────────────────────────

/** A RE-RUNNABLE, checkable figure — merged/blocked/cost/etc. `query` is the literal
 *  instruction a reader re-runs to reproduce `value` byte-for-byte (a ledger predicate, a grep,
 *  a command) — never prose describing the number, an actual re-runnable step. */
export interface DeterministicDigestItem {
  kind: "deterministic";
  label: string;
  value: string;
  query: string;
}

/** Text somebody (or something) WROTE — a suggestion, never a measurement. Marked per item
 *  (`kind: "generative"`) rather than only by a section heading, so a single line quoted out of
 *  the digest still identifies itself. This module never GENERATES this text (Law 5's "the
 *  digest never spawns a worker to judge a task" — see {@link runDigestCadenceReport}'s doc):
 *  it only renders whatever a caller already produced. */
export interface GenerativeDigestItem {
  kind: "generative";
  text: string;
}

export type DigestCadenceItem = DeterministicDigestItem | GenerativeDigestItem;

/**
 * Render ONE {@link DigestCadenceItem}. THE MECHANICAL TEST (design note (iv) of this task's
 * rationale): a deterministic item with no re-runnable `query` is a BUG and FAILS THE RENDER —
 * thrown, never silently printed unattributed; a generative item is always marked
 * `[SUGGESTED]`, per item, never relying on a section heading alone.
 */
export function renderDigestCadenceItem(item: DigestCadenceItem): string {
  if (item.kind === "deterministic") {
    if (!item.query || item.query.trim().length === 0) {
      throw new Error(
        `digest cadence: deterministic item "${item.label}" carries no re-runnable query — refusing to render an unattributed figure`,
      );
    }
    return `[FIGURE] ${item.label}: ${item.value}  (query: ${item.query})`;
  }
  return `[SUGGESTED] ${item.text}`;
}

/** Render every item — see {@link renderDigestCadenceItem}'s doc; throws on the FIRST
 *  unattributed deterministic item, same fail-loud contract. */
export function renderDigestCadenceItems(items: DigestCadenceItem[]): string[] {
  return items.map(renderDigestCadenceItem);
}

/** The re-runnable query strings for the four counting figures {@link summarize} reduces —
 *  the SAME reduction, described rather than re-derived, so {@link runDigestCadenceReport} can
 *  mark each one deterministic with its own query (claim 4) without a second traversal. */
function digestSummaryToDeterministicItems(s: DigestSummary, sinceIso: string): DeterministicDigestItem[] {
  return [
    {
      kind: "deterministic",
      label: "merged",
      value: String(s.merged.length),
      query: `ledger: step=="verdict" && verdict=="merged" && ts>="${sinceIso}"`,
    },
    {
      kind: "deterministic",
      label: "blocked",
      value: String(s.blocked.length),
      query: `ledger: step=="verdict" && verdict.startsWith("blocked") && ts>="${sinceIso}"`,
    },
    {
      kind: "deterministic",
      label: "escalations",
      value: String(s.escalations.length),
      query: `ledger: step=="escalation.issue_opened" && ts>="${sinceIso}"`,
    },
    {
      kind: "deterministic",
      label: "notional cost",
      value: `$${s.costUsd.toFixed(2)}`,
      query: `ledger: sum(cost_usd) over step=="verdict" && ts>="${sinceIso}"`,
    },
  ];
}

// ── The retro is cited, never re-derived (claim: "a retro that landed inside the window is
//    cited rather than re-derived") ─────────────────────────────────────────────────────────

/** One retro PR that landed (merged) inside the digest window — a CITATION, not a
 *  re-computation: this reads the SAME `verdict` lines {@link summarize} already reduces
 *  (`task_id === "RETRO"`, the id every retro run ledgers under — `src/run-task.ts`'s
 *  `retroCommand`/`buildGather`), and names the PR. It never imports rule-efficacy.ts /
 *  verdict-calibration.ts / autonomy.ts, so it is structurally incapable of re-deriving a
 *  retro's own findings — the only thing it can ever do is point at the PR that already has them. */
export interface RetroCitation {
  taskId: "RETRO";
  prUrl?: string;
}

/** Every retro that merged inside `[sinceIso, now]` — see {@link RetroCitation}'s doc for why
 *  this is a citation and not a re-derivation. */
export function citeRetrosInWindow(lines: LedgerLine[], sinceIso: string): RetroCitation[] {
  const since = collectSince(lines, sinceIso);
  const out: RetroCitation[] = [];
  for (const l of since) {
    if (l.step === "verdict" && l.task_id === "RETRO" && l.verdict === "merged") {
      out.push({ taskId: "RETRO", prUrl: typeof l.pr_url === "string" ? l.pr_url : undefined });
    }
  }
  return out;
}

// ── The delivery seam: the digest depends on NotifyChannel, never a concrete target (claim:
//    "the digest depends on the notify channel interface and never on a concrete delivery
//    target") — an INBOX adapter, because notify.ts's only shipped adapter (imessageChannel) is
//    Darwin-only and this fleet runs on Linux (this module's own header). Kept HERE, not in
//    notify.ts, precisely because an inbox adapter is an IMPLEMENTATION of NotifyChannel and
//    requires no change to that interface at all. ─────────────────────────────────────────────

/** `<root>/state/inbox-digests.json` — the console inbox's digest feed, mirroring
 *  `lib/inbox.ts`'s own `inbox-proposals.json`/`inbox-drafts.json` convention (both live under
 *  `config.root`, served by `GET /v1/inbox`). A plain JSON array of `{ts, text}` entries,
 *  newest last. */
export function inboxDigestsPath(root: string): string {
  return join(root, "state", "inbox-digests.json");
}

interface InboxDigestEntry {
  ts: string;
  text: string;
}

function readInboxDigests(path: string): InboxDigestEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as InboxDigestEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * A {@link NotifyChannel} implementation over the console inbox — the digest's ON-THIS-FLEET
 * delivery target: a plain file write has no platform gate, unlike `notify.ts`'s
 * `imessageChannel`, whose `unavailable()` refuses on every non-Darwin host. The digest's own
 * producer ({@link runDigestCadenceReport}) never imports this by name in a way that couples it
 * to the digest's logic — it only ever depends on the {@link NotifyChannel} TYPE, and this is
 * ONE implementation of it, freely swappable (a test fake today, an email adapter later) with
 * zero change to {@link sendDigest}/{@link runDigestCadenceReport} themselves.
 */
export function inboxNotifyChannel(root: string): NotifyChannel {
  return {
    send(message: string) {
      const path = inboxDigestsPath(root);
      mkdirSync(dirname(path), { recursive: true });
      const entries = readInboxDigests(path);
      entries.push({ ts: new Date().toISOString(), text: message });
      writeFileSync(path, JSON.stringify(entries, null, 2));
    },
    // No unavailable() at all — a file write is always available on every platform this fleet
    // runs on, unlike osascript/Messages.app; omitting it (NotifyChannel's own optional field)
    // means `notify()` always attempts the send, never reports a false "not delivered".
  };
}

// ── The producer: Law 5, unconditionally (claim: "the digest files nothing, mints nothing, and
//    spawns no worker to judge a task") ─────────────────────────────────────────────────────────

/** {@link runDigestCadenceReport}'s return: the text actually sent, which channel name it went
 *  out under, and whether the channel reported itself deliverable (mirrors `notify()`'s own
 *  `delivered` ledger field, surfaced here for a caller/test that wants it without re-parsing
 *  the ledger line `notify()` already writes). */
export interface DigestCadenceRunResult {
  text: string;
  channelName: string;
  delivered: boolean;
}

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
export function runDigestCadenceReport(opts: {
  ledgerPath: string;
  sinceIso: string;
  deps: NotifyDeps;
  consoleBaseUrl?: string;
  /** Already-written generative items (never generated inside this function) — see
   *  {@link GenerativeDigestItem}'s doc. Defaults to none: a purely deterministic digest. */
  suggestions?: GenerativeDigestItem[];
}): DigestCadenceRunResult {
  const lines = readLedgerLines(opts.ledgerPath);
  const summary = summarize(lines, opts.sinceIso);
  const retros = citeRetrosInWindow(lines, opts.sinceIso);
  const deterministicItems = digestSummaryToDeterministicItems(summary, opts.sinceIso);
  const itemLines = renderDigestCadenceItems([...deterministicItems, ...(opts.suggestions ?? [])]);
  const retroLines = retros.map((r) => `retro cited: ${r.taskId}${r.prUrl ? ` — ${r.prUrl}` : ""}`);
  const text = [renderDigest(summary, opts.consoleBaseUrl), ...retroLines, ...itemLines].join("\n");
  const unavailable = opts.deps.channel.unavailable?.();
  notify(text, opts.deps);
  return { text, channelName: opts.deps.channelName ?? "imessage", delivered: unavailable === undefined };
}
