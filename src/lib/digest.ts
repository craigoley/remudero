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
 * The daily digest (W1-T8): interrupts collapse into one daily message (MASTER-PLAN §4) instead
 * of paging on every merge, block or escalation; real-time pings stay reserved for MANUAL and
 * hard-stop. This module assembles and delivers it; the daemon loop (W1-T12) owns the clock,
 * except the digest's own cadence decision ("digest cadence" below, W1-T2277), pure here and
 * wired to that loop from `src/run-task.ts`'s `buildDigestCadenceDaemonHooks`. Why: the split's
 * full rationale — docs/forensics/digest.md
 */

/** One ledger line, loosely typed like {@link readLedgerLines}'s return. */
export type LedgerLine = Record<string, unknown>;

/** Ledger lines with `ts >= sinceIso`, in original (chronological) order. */
export function collectSince(lines: LedgerLine[], sinceIso: string): LedgerLine[] {
  return lines.filter((l) => typeof l.ts === "string" && (l.ts as string) >= sinceIso);
}

// ── W1-T929: the cache-hit ratio — cache_read/(cache_read+input+cache_creation). cacheHitRatio
// is the sole arithmetic and aggregateCacheHitTotals the sole grouping traversal; this module's
// summarize and status-board.ts's buildStatusBoard both walk them, so the two surfaces can
// disagree on how they render a figure, never on what it is. Why: docs/forensics/digest.md

/** The three token counts a cache-hit ratio is derived from — exactly the fields worker.ts's
 *  `TokenUsage` nests on every ledgered call line (`tokens.cacheRead`/`input`/`cacheCreation`). */
export interface CacheHitTokens {
  cacheRead: number;
  input: number;
  cacheCreation: number;
}

/**
 * The cache-hit ratio (feedback fb-1785237559155-feef92, MASTER-PLAN §8A): `cache_read /
 * (cache_read + input + cache_creation)`. status-board.ts calls this same function rather than
 * re-deriving its own opinion. Returns `undefined`, never `0`, when the denominator is zero — a
 * line with no token data is UNKNOWN, not a fabricated 0% hit rate.
 */
export function cacheHitRatio(tokens: CacheHitTokens): number | undefined {
  const denom = tokens.cacheRead + tokens.input + tokens.cacheCreation;
  return denom > 0 ? tokens.cacheRead / denom : undefined;
}

/** One grouping's summed token totals, plus how many of its call lines carried usable token
 *  data — the `coveredLines`/`callLines` pair a `cacheHitRatio` of `undefined` renders its
 *  coverage fraction from. */
export interface CacheHitGrain extends CacheHitTokens {
  callLines: number;
  /** Of `callLines`, how many carried a non-zero token envelope (usable data). */
  coveredLines: number;
}

/** Both grains the feedback asked for: per run (a single bad run legible) and per task class
 *  (the grain that detects a regression), over the same window. */
export interface CacheHitTotals {
  /** Keyed by ledger `run_id`. */
  byRun: Record<string, CacheHitGrain>;
  /** Keyed by the run's `run.start` `task_class` field (mirrors retro.ts's `aggregateByClass`);
   *  a run with no resolvable class groups under `"unknown"` rather than being dropped. */
  byClass: Record<string, CacheHitGrain>;
}

/** A ledger line is a worker/brain-plane call iff it carries the `model`+`effort` pair every
 *  call has had since before the cache columns existed, so this never mistakes a
 *  `run.start`/`verdict`/poll line for a call that simply has no token data. */
function isCallLine(l: LedgerLine): boolean {
  return typeof l.model === "string" && typeof l.effort === "string";
}

/** The line's token counts, off its nested `tokens` field, or `undefined` when that shape
 *  isn't there (a line predating `tokens`, or malformed). */
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

/** Fold one call line into `grain` — always counts toward `callLines`, but only adds to the
 *  token totals and `coveredLines` when the envelope had a non-zero denominator, so an
 *  uncovered call can never silently read as a healthy 0% hit rate. */
function foldCacheHitLine(grain: CacheHitGrain, tokens: CacheHitTokens): void {
  grain.callLines++;
  if (tokens.cacheRead + tokens.input + tokens.cacheCreation <= 0) return;
  grain.coveredLines++;
  grain.cacheRead += tokens.cacheRead;
  grain.input += tokens.input;
  grain.cacheCreation += tokens.cacheCreation;
}

/**
 * Group `lines` into per-run and per-class {@link CacheHitGrain} totals — the one traversal both
 * `summarize` and status-board.ts's `buildStatusBoard` walk, so the two can never disagree.
 * `undefined` when nothing in `lines` carries usable cache data, so the caller omits the output
 * rather than printing an all-UNKNOWN table (the soft-compose rule {@link DigestSummary.inbox}
 * documents).
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
 * Format one {@link CacheHitGrain} as `NN.N% (coverage NN%)`, or `UNKNOWN (coverage NN%)` when
 * {@link cacheHitRatio} returns `undefined` — the one formatting rule {@link renderCacheHitLine}
 * and status-board.ts's own per-grain render share, so the two surfaces never disagree.
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

// ── W1-T940: learnings-injection drop pressure. run-task.ts's promptsmith block already logs a
// `learnings.injected` row on every spawn; this is the one aggregation over it, mirroring
// aggregateCacheHitTotals's seam. A `global_refused_reason` is kept separate from `dropped`: a
// refusal is a diagnosis, never folded into the drop count. Why: docs/forensics/digest.md

/**
 * One window's totals over every `learnings.injected` ledger row. `budgetChars` lists every
 * distinct `budget_chars` value seen, ascending, rather than one summary number, so a
 * mid-window constant change stays visible instead of averaging away. `globalRefusedReasons`
 * keys the verbatim reason string to how many rows carried it, deduped and kept off `dropped`.
 */
export interface LearningsInjectionTotals {
  rows: number;
  matched: number;
  dropped: number;
  budgetChars: number[];
  globalRefusedReasons: Record<string, number>;
}

/**
 * Group `lines` into {@link LearningsInjectionTotals} — the one traversal status-board.ts's
 * `buildStatusBoard` walks too, so the two surfaces can never disagree on which rows count.
 *
 * `undefined` when `lines` carries no `learnings.injected` rows — the caller then renders
 * explicit absence rather than a fabricated `dropped: 0` for a window that saw no spawns.
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

// ── W1-T941: the knowledge budget is a derived cap, not a picked number. Pressure is the same
// `learnings.injected` rows {@link aggregateLearningsInjection} reads, weighted per entry rather
// than just counted; cost is the same cache arithmetic this file already exports
// ({@link cacheHitRatio}), since only the Tier-1 block's own bytes are re-charged on a marginal
// increase. Why: docs/forensics/digest.md

/** One window's per-spawn dropped-fact weight pressure: p50/p90 chars of matched-but-dropped
 *  fact the budget refused, per spawn — a weight, not a count. */
export interface KnowledgeBudgetPressure {
  /** Rows carrying at least one `dropped` id resolvable to a weight. */
  spawnsMeasured: number;
  droppedWeightP50: number;
  /** The figure {@link deriveKnowledgeBudgetCap} prices. */
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
 * The pressure side: walks the same rows {@link aggregateLearningsInjection} reads, and for each
 * row's `dropped` ids sums the matching chars out of `entryWeights`; an absent id contributes
 * zero. `undefined` when no row has a resolvable id, the same soft-compose convention
 * {@link aggregateCacheHitTotals} keeps.
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

/** English-text heuristic for pricing the marginal cap increase: ~4 characters per token. A
 *  deliberately coarse approximation, not a model-specific tokenizer count. */
export const CHARS_PER_TOKEN = 4;

/** Below this many p90 dropped chars, the pressure is trivial — less than one typical dropped
 *  fact line — so it is not worth pricing a raise over. */
export const TRIVIAL_DROPPED_WEIGHT_CHARS = 40;

/** A derived recommendation for the knowledge-budget cap, carrying the inputs that produced it
 *  so the recommendation is auditable, not just the number. */
export interface KnowledgeBudgetDerivation {
  currentCapChars: number;
  pressure: KnowledgeBudgetPressure | undefined;
  /** 0 unless `changed`. */
  deltaChars: number;
  deltaTokens: number;
  /** The {@link cacheHitRatio} the delta was priced at, or `undefined` when unpriceable. */
  cacheHitRatioUsed: number | undefined;
  /** Equals `currentCapChars` unless `changed`. */
  recommendedCapChars: number;
  changed: boolean;
  /** Human-readable justification, for the baseline file's record. */
  reason: string;
}

/**
 * Combines {@link measureKnowledgeBudgetPressure}'s percentiles with `cacheMix` to recommend a
 * cap. "No change" is the default: raises only when p90 dropped weight is non-trivial (>=
 * {@link TRIVIAL_DROPPED_WEIGHT_CHARS}) and cache-mix data can price it. The new cap, when raised,
 * is `currentCapChars + droppedWeightP90` exactly, re-derivable byte for byte.
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

/** The `board_review.ran` fields {@link DigestSummary.boardReview} carries, read straight off the
 *  row the daemon tick writes. Every field is optional: a row from an older or newer writer
 *  degrades to a partial line rather than a throw. */
export interface BoardReviewDigestSnapshot {
  oldestOpenAgeHours?: number;
  redCount?: number;
  unhandledEscalationCount?: number;
  itemsConsidered?: number;
  proposals?: number;
}

/** One `sweep.repeat_escalated` trip {@link DigestSummary.repeatEscalations} carries (sweep.ts's
 *  W1-T2345 counter). Every field optional, for the same reason as {@link BoardReviewDigestSnapshot}. */
export interface RepeatEscalationDigestEntry {
  prNumber?: number;
  disposition?: string;
  streak?: number;
}

/** One `sweep.repair_filing_suppressed` trip {@link DigestSummary.repairFilingsSuppressed} carries
 *  (W1-T2416, fired when a due surface's most recent verdict for its own `repair#<surface>` origin
 *  is `rejected`). Every field optional, for the same reason as {@link BoardReviewDigestSnapshot}. */
export interface RepairFilingSuppressedDigestEntry {
  id?: string;
  surface?: string;
  distinctPrCount?: number;
  rejectedEntryId?: string;
}

/**
 * A window's digest counts. A *snapshot* field (`alerts`, `issues`, `inbox`, `boardReview`) is
 * latest-wins, never summed; an *events* field (`repeatEscalations`, `repairFilingsSuppressed`)
 * is additive, deduped by its own key since the ledger union can replay a row across rotations.
 * Every field from `inbox` on is soft-composed by {@link renderDigest}: its line is omitted,
 * never a placeholder, so a digest predating the field renders unchanged. Why: docs/forensics/digest.md
 */
export interface DigestSummary {
  sinceIso: string;
  /** What the windowed union actually reached (W1-T2388); read only to say an incomplete read,
   *  never to decide anything. {@link buildDigest} always sets it. */
  read?: DigestWindowRead;
  merged: string[];
  blocked: Array<{ taskId: string; verdict: string; prUrl?: string }>;
  escalations: Array<{ taskId: string; class: string; issueUrl: string }>;
  costUsd: number;
  /** The latest `ops.alerts_polled` snapshot inside the window. */
  alerts?: AlertsPollSummary;
  /** The latest `issues.polled` snapshot inside the window. */
  issues?: IssuesPollSummary;
  /** The latest `inbox.polled` snapshot inside the window. */
  inbox?: InboxPollSummary;
  /** Cache-hit ratio totals for this window. See {@link aggregateCacheHitTotals}. */
  cacheHit?: CacheHitTotals;
  /** The latest `board_review.ran` snapshot. Reads `.ran` alone of the rung's three steps —
   *  `.fired` duplicates it and `.skipped` is the cadence working as intended. */
  boardReview?: BoardReviewDigestSnapshot;
  /** Every `sweep.repeat_escalated` trip — a PR whose verdict hasn't moved for
   *  `repeatDispositionBound` consecutive derivations on an unchanged head. */
  repeatEscalations?: RepeatEscalationDigestEntry[];
  /** Every `sweep.repair_filing_suppressed` trip (W1-T2416). */
  repairFilingsSuppressed?: RepairFilingSuppressedDigestEntry[];
  /** Count of `review.downgrade_suppressed` lines (W1-T178): a semantic-lane downgrade
   *  suppressed because the deterministic floor still passed on an unchanged head. */
  verdictDowngradesSuppressed: number;
  /** W1-T2765: per-part prompt bytes over the window, or `undefined` when no `prompt.manifest`
   *  row was read. Rendered as "not observed", never as a zero row. */
  promptParts?: PromptPartsSummary;
}

/**
 * W1-T2765 — ONE PART'S FIGURES OVER ONE WINDOW.
 *
 * `present` and `observed` are counted separately because they answer different questions: a part
 * absent from every run (operator notes nobody wrote) is a real fact about the dialect, and folding
 * it into a byte average would report a smaller prompt than the fleet actually sends.
 */
export interface PromptPartWindow {
  name: string;
  /** Manifest rows naming this part at all. */
  observedRuns: number;
  /** Rows carrying it with `present: true` — the only rows whose bytes are counted. */
  presentRuns: number;
  /** p50/p90 bytes over the PRESENT rows only. Both 0 when the part was never present. */
  bytesP50: number;
  bytesP90: number;
}

/** W1-T2765 — the digest's prompt-parts section, or `undefined` when the window carried no
 *  `prompt.manifest` row at all. `undefined` rather than an empty summary is the P48 no-naked-zero
 *  discipline: "not observed" and "observed, zero bytes" are different claims. */
export interface PromptPartsSummary {
  /** Manifest rows in the window. Never 0 — an empty window returns `undefined`. */
  rows: number;
  parts: PromptPartWindow[];
  /** Manifest rows found BEFORE `sinceIso` in the same input. Usually 0 in the production path —
   *  see {@link summarizePromptParts}'s own note on why. */
  priorRows: number;
  /** The part whose p50 grew most against the prior window. Absent when `priorRows` is 0, or when
   *  nothing grew — never a zero-growth row standing in for "no comparison". */
  grewMost?: { name: string; fromP50: number; toP50: number };
}

/**
 * W1-T2765 — GIVE THE PROMPT MANIFEST A READER.
 *
 * W1-T2297 fingerprints every prompt part by name, sha256 and byte count into a `prompt.manifest`
 * ledger row on every run. Nothing read one: across src/, scripts/ and docs/ the step name appeared
 * only in its writer, its unit test and `buildBundle`'s independent producer. The fleet's own
 * dialect had a meter with no dial, and a compaction decision taken without it is a guess.
 *
 * BYTES, NOT TOKENS, ON PURPOSE — the manifest's unit and the ratchets' unit. No tokenizer is
 * added here.
 *
 * A NOTE ON THE PRIOR WINDOW, because it is weaker than it looks. `readDigestWindow` filters rows
 * to the window BEFORE `summarize` sees them (a memory bound, not an optimisation — an earlier
 * draft OOMed). So on the production path `priorRows` is 0 and `grewMost` is absent: growth is
 * reported only when a caller passes lines reaching further back than `sinceIso`, which the tests
 * do and `rmd digest` does not. Widening that reader is a memory decision and is not taken here.
 */
export function summarizePromptParts(lines: LedgerLine[], sinceIso: string): PromptPartsSummary | undefined {
  const partsOf = (l: LedgerLine): PromptManifestRow[] =>
    l.step === "prompt.manifest" && Array.isArray(l.parts) ? (l.parts as PromptManifestRow[]) : [];
  const fold = (rows: LedgerLine[]): Map<string, { observed: number; present: number; bytes: number[] }> => {
    const acc = new Map<string, { observed: number; present: number; bytes: number[] }>();
    for (const l of rows) {
      for (const p of partsOf(l)) {
        if (typeof p?.name !== "string") continue;
        const e = acc.get(p.name) ?? { observed: 0, present: 0, bytes: [] };
        e.observed++;
        if (p.present === true && typeof p.bytes === "number") {
          e.present++;
          e.bytes.push(p.bytes);
        }
        acc.set(p.name, e);
      }
    }
    return acc;
  };

  const manifests = lines.filter((l) => l.step === "prompt.manifest" && typeof l.ts === "string");
  const current = manifests.filter((l) => (l.ts as string) >= sinceIso);
  if (current.length === 0) return undefined;
  const prior = manifests.filter((l) => (l.ts as string) < sinceIso);

  const currentFold = fold(current);
  const parts: PromptPartWindow[] = [...currentFold.entries()]
    .map(([name, e]) => ({
      name,
      observedRuns: e.observed,
      presentRuns: e.present,
      bytesP50: e.bytes.length ? percentile(e.bytes, 50) : 0,
      bytesP90: e.bytes.length ? percentile(e.bytes, 90) : 0,
    }))
    .sort((a, b) => b.bytesP50 - a.bytesP50 || a.name.localeCompare(b.name));

  let grewMost: PromptPartsSummary["grewMost"];
  if (prior.length > 0) {
    const priorFold = fold(prior);
    let best = 0;
    for (const p of parts) {
      const before = priorFold.get(p.name);
      if (!before || before.bytes.length === 0) continue; // no comparison, never a growth-from-zero
      const fromP50 = percentile(before.bytes, 50);
      const delta = p.bytesP50 - fromP50;
      if (delta > best) {
        best = delta;
        grewMost = { name: p.name, fromP50, toP50: p.bytesP50 };
      }
    }
  }
  return { rows: current.length, parts, priorRows: prior.length, ...(grewMost ? { grewMost } : {}) };
}

/** W1-T2765 — the manifest row shape this reader consumes, structurally (never imported, so the
 *  digest keeps its "ledger lines in, string out" contract). */
interface PromptManifestRow {
  name?: unknown;
  present?: unknown;
  bytes?: unknown;
}

/** W1-T2765 — the digest's PROMPT PARTS line(s). "not observed" when the window carried no
 *  manifest row, never a zero row (P48). */
export function renderPromptParts(s: PromptPartsSummary | undefined): string {
  if (!s) return "prompt parts: (not observed this window)";
  const body = s.parts
    .map((p) => `${p.name} p50 ${p.bytesP50}B p90 ${p.bytesP90}B (present ${p.presentRuns}/${p.observedRuns})`)
    .join("; ");
  const growth = s.grewMost
    ? `; grew most: ${s.grewMost.name} ${s.grewMost.fromP50}B -> ${s.grewMost.toP50}B`
    : s.priorRows === 0
    ? "; growth: (no prior window read)"
    : "; growth: (none)";
  return `prompt parts (${s.rows} run(s)): ${body}${growth}`;
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
  // W1-T2765: folded over the FULL input, not `since` — the prior window it compares against is
  // whatever the caller read before `sinceIso`, and `collectSince` would have removed it.
  const promptParts = summarizePromptParts(lines, sinceIso);
  if (promptParts) summary.promptParts = promptParts;
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
    // The rung's own row, latest-wins like the three above — read here, never re-derived.
    if (l.step === "board_review.ran") {
      summary.boardReview = {
        oldestOpenAgeHours: typeof l.oldestOpenAgeHours === "number" ? l.oldestOpenAgeHours : undefined,
        redCount: typeof l.redCount === "number" ? l.redCount : undefined,
        unhandledEscalationCount: typeof l.unhandledEscalationCount === "number" ? l.unhandledEscalationCount : undefined,
        itemsConsidered: typeof l.itemsConsidered === "number" ? l.itemsConsidered : undefined,
        proposals: typeof l.proposals === "number" ? l.proposals : undefined,
      };
    }
    // W1-T2345's counter trip, read here. Why: docs/forensics/digest.md
    if (l.step === "sweep.repeat_escalated") {
      const prNumber = typeof l.pr_number === "number" ? l.pr_number : undefined;
      const list = (summary.repeatEscalations ??= []);
      // Dedup on PR number: a rotation artefact must never read as a second stuck PR.
      if (prNumber === undefined || !list.some((e) => e.prNumber === prNumber)) {
        list.push({
          prNumber,
          disposition: typeof l.disposition === "string" ? l.disposition : undefined,
          streak: typeof l.streak === "number" ? l.streak : undefined,
        });
      }
    }
    // W1-T2416's suppression row, read the same shape as `sweep.repeat_escalated` above.
    if (l.step === "sweep.repair_filing_suppressed") {
      const id = typeof l.id === "string" ? l.id : undefined;
      const list = (summary.repairFilingsSuppressed ??= []);
      // Dedup on the filing's own id: a rotation artefact must never read as a second suppression.
      if (id === undefined || !list.some((e) => e.id === id)) {
        list.push({
          id,
          surface: typeof l.surface === "string" ? l.surface : undefined,
          distinctPrCount: typeof l.distinct_pr_count === "number" ? l.distinct_pr_count : undefined,
          rejectedEntryId: typeof l.rejected_entry_id === "string" ? l.rejected_entry_id : undefined,
        });
      }
    }
  }
  summary.cacheHit = aggregateCacheHitTotals(since);
  return summary;
}

/**
 * Deep-link a task id to its console card (W1-T144). A hash route (`#task=<id>`) so the link
 * never leaves the client and layers on top of whatever base URL the operator has bookmarked.
 * `consoleBaseUrl` is a full origin; a trailing slash is tolerated. `taskId` is percent-encoded.
 */
export function consoleCardUrl(consoleBaseUrl: string, taskId: string): string {
  return `${consoleBaseUrl.replace(/\/+$/, "")}/#task=${encodeURIComponent(taskId)}`;
}

/**
 * Render a {@link DigestSummary} as the digest text a human reads once a day. `consoleBaseUrl`,
 * when given, appends a console deep link to each escalation line; omitted, the escalations line
 * renders exactly as before that field existed.
 */
export function renderDigest(s: DigestSummary, consoleBaseUrl?: string): string {
  // W1-T2388: an incomplete read must never look like a quiet board — stated on its own line,
  // never inferred from short output. A complete read renders exactly as before this existed.
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
    // Soft-composed exactly like `stuck (repeat bound)` above — absent, never a placeholder, when
    // the window carries no trip. See the `repairFilingsSuppressed` field's doc on DigestSummary.
    ...(s.repairFilingsSuppressed?.length
      ? [`repair filings suppressed (prior rejection): ${renderRepairFilingsSuppressed(s.repairFilingsSuppressed)}`]
      : []),
    // W1-T929: soft-composed — present only when the window carries usable cache-token data
    // (see the `cacheHit` field's doc on DigestSummary), two lines (per-run, per-class), never
    // a "(no data)" placeholder otherwise.
    ...(s.cacheHit ? [renderCacheHitLine("cache hit by run", s.cacheHit.byRun), renderCacheHitLine("cache hit by class", s.cacheHit.byClass)] : []),
    `verdict downgrades suppressed: ${s.verdictDowngradesSuppressed}`,
    `notional cost: $${s.costUsd.toFixed(2)}`,
    // W1-T2765: ALWAYS rendered, unlike the soft-composed lines above — "not observed" is the
    // answer this section owes, and an absent line would read as a quiet window rather than an
    // unread meter.
    renderPromptParts(s.promptParts),
  ];
  return lines.join("\n");
}

/** One line for {@link DigestSummary.repeatEscalations}, naming the verdict that would not move
 *  and how many consecutive derivations it survived. Every field optional. */
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

/** One line for {@link DigestSummary.repairFilingsSuppressed} (W1-T2416), naming the surface, its
 *  distinct-PR count, and the rejected entry that suppressed it. */
function renderRepairFilingsSuppressed(entries: RepairFilingSuppressedDigestEntry[]): string {
  return entries
    .map((e) => {
      const who = e.surface ?? "(surface unknown)";
      const count = e.distinctPrCount !== undefined ? ` x${e.distinctPrCount}` : "";
      const why = e.rejectedEntryId ? ` — suppressed by ${e.rejectedEntryId}` : "";
      return `${who}${count}${why}`;
    })
    .join(", ");
}

/** One line for {@link DigestSummary.boardReview}. Every field optional. */
function renderBoardReviewSnapshot(b: BoardReviewDigestSnapshot): string {
  const parts: string[] = [];
  if (typeof b.oldestOpenAgeHours === "number") parts.push(`oldest open ${b.oldestOpenAgeHours.toFixed(1)}h`);
  if (typeof b.redCount === "number") parts.push(`${b.redCount} red`);
  if (typeof b.unhandledEscalationCount === "number") parts.push(`${b.unhandledEscalationCount} unhandled escalation(s)`);
  if (typeof b.itemsConsidered === "number") parts.push(`${b.itemsConsidered} item(s) considered`);
  if (typeof b.proposals === "number") parts.push(`${b.proposals} proposal(s)`);
  return parts.length ? parts.join(", ") : "(ran, no counts recorded)";
}

/** The real fs behind {@link readDigestWindow} — the same shape {@link LedgerGrepFsDeps} names,
 *  so a test drives this reader with the fixtures that module's callers already use. */
const realDigestFs: LedgerGrepFsDeps = {
  readdirSync: (dir) => nodeReaddirSync(dir),
  existsSync: () => true,
  readFileSync: (path) => nodeReadFileSync(path),
  gunzipSync: (buf) => nodeGunzipSync(buf),
};

/** A BACKSTOP, not a policy — the window is the real bound. Exists only so an unbounded corpus
 *  can't make a reporter unbounded; when it bites, {@link renderDigest} says so.
 *  Why: docs/forensics/digest.md */
export const DIGEST_MAX_ARCHIVES = 1024;

/** THE PRIMARY CONTROL — binds on memory, not wall clock, since retaining every in-window row
 *  from the busiest measured window died with a heap OOM. {@link DIGEST_MAX_ARCHIVES} is the
 *  backstop; this is the bound that actually binds. Why: docs/forensics/digest.md */
export const DIGEST_MAX_ROWS = 250_000;

/** What one windowed union read actually reached — carried so the render can refuse to look quiet
 *  when it was merely incomplete. */
export interface DigestWindowRead {
  lines: LedgerLine[];
  archivesConsidered: number;
  /** Rows dropped because the row cap bit — always rendered, never silent. */
  rowsTruncated: number;
  /** Carried rather than re-read from the constants, so a render never names a bound the read
   *  did not use. */
  capsApplied: { maxArchives: number; maxRows: number };
  /** Skipped unopened because their filename stamp precedes `sinceIso`. */
  archivesSkippedByStamp: number;
  archivesRead: number;
  /** In-window, but not opened because {@link DIGEST_MAX_ARCHIVES} bit. */
  archivesTruncated: number;
  /** Opened and threw — partial coverage, never silence. */
  unread: string[];
}

/**
 * The digest's own windowed union read (W1-T2388), replacing an earlier read of the live ledger
 * path alone that missed every already-rotated row. An archive stamped before `sinceIso` is
 * skipped unopened; an unparseable stamp is read, never skipped. Deliberately not
 * `readLedgerUnionBounded` — that reader's early exit is sound only for callers reading a step's
 * newest row, never a count, and the digest sums and tallies. Deduped by exact line text.
 * Why: docs/forensics/digest.md
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
    // An unreadable directory reads as "no archives" — the live read below still answers. Never
    // a throw in a reporter.
  }
  const rotations = ledgerRotationEntries(names, dir);
  const inWindow = rotations.filter((e) => {
    const stamp = rotationStampIso(basename(e.path));
    return stamp === undefined || stamp >= sinceIso;
  });
  const skipped = rotations.length - inWindow.length;
  // Newest first, so a cap that bites drops the oldest in-window archives, and
  // `archivesTruncated` says how many.
  const ordered = [...inWindow].sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
  const opened = ordered.slice(0, cap);
  const seen = new Set<string>();
  const lines: LedgerLine[] = [];
  // Filtering before retaining is a memory bound, not an optimisation — an earlier draft parsed
  // and deduped every line first and died with a heap OOM. This predicate is `collectSince`'s
  // own, applied one step earlier, so `summarize`'s later call is a no-op over this input.
  // Why: the OOM measurement — docs/forensics/digest.md
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
      // Recorded as unread, never skipped silently, so the render can state an incomplete read
      // instead of looking quiet — one corrupt rotation must not cost the whole digest.
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

/**
 * Build the digest text straight from a ledger file, as of `sinceIso` — reading the windowed
 * union (W1-T2388), not the live file alone. `consoleBaseUrl` threads through to
 * {@link renderDigest}'s deep-link contract.
 */
export function buildDigest(ledgerPath: string, sinceIso: string, consoleBaseUrl?: string): string {
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
 * Render a post-drain {@link RundownLine} array as one digest-channel message (W1-T144), the
 * push counterpart to `drain.ts`'s pull-view `renderRundown`. Every non-merged line carries a
 * {@link consoleCardUrl} deep link; a `merged` line stays a bare confirmation.
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

/** Deliver a post-drain rundown over the same notify channel as {@link sendDigest} and
 *  `run-task.ts`'s MANUAL/HARD_STOP escalation pings — never a second, parallel sender. */
export function sendRundown(lines: RundownLine[], consoleBaseUrl: string, deps: NotifyDeps): string {
  const text = renderRundownPush(lines, consoleBaseUrl);
  notify(text, deps);
  return text;
}

// ── W1-T163: the digest is marker-aware, sharing lib/last-seen.ts's per-token marker with the
// console recap, so a pushed digest and a pulled recap cover the identical window.

/** The digest's pre-marker default lookback, used only the first time a token is seen so it
 *  reports the last day rather than the entire ledger's history. */
export function defaultDigestSinceIso(nowIso: string): string {
  return new Date(Date.parse(nowIso) - 24 * 60 * 60 * 1000).toISOString();
}

/** The `sinceIso` a marker-aware digest for `tokenId` would use right now, without advancing
 *  anything — exposed so a `--dry-run` preview can show it explicitly. */
export function resolveMarkerAwareSince(store: LastSeenStore, tokenId: string, nowIso: string): string {
  return store.get(tokenId) ?? defaultDigestSinceIso(nowIso);
}

/** Build (never send, never advance the marker) the digest text for `tokenId` off its current
 *  marker — a read-only preview used by `rmd digest --dry-run`. */
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

/** Send a marker-aware digest for `tokenId`: deliver like {@link sendDigest}, then advance the
 *  same {@link LastSeenStore} `lib/board.ts`'s board view advances, so whichever happens first
 *  moves the marker and the other reports what's left. */
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

// ── W1-T2277: the digest's own cadence, interval, item-marking and delivery seam, reusing
// decideMeasurementCadence verbatim against the digest's own marker file and policy row.
// Why: docs/forensics/digest.md

/** The digest cadence's policy shape — a subset of
 *  {@link "./measurement-cadence.js".MeasurementCadencePolicy} with no `escalate`, since the
 *  digest only reads and sends, never drafts a proposal. */
export interface DigestCadencePolicy {
  enabled: boolean;
  minIntervalMinutes: number;
  maxPerDay: number;
}

/** The digest's own fire marker, distinct from `measurementCadenceMarkerPath`'s file, so the
 *  two cadences can never throttle one another. */
export function digestCadenceMarkerPath(root: string): string {
  return join(root, "state", "last-digest-cadence.json");
}

/** The digest cadence's real decision, reusing {@link decideMeasurementCadence} rather than a
 *  second decision function. */
export function digestCadenceCheck(opts: { root: string; policy: DigestCadencePolicy; now?: Date }): MeasurementCadenceDecision {
  const marker = readMeasurementCadenceMarker(digestCadenceMarkerPath(opts.root));
  return decideMeasurementCadence({
    policy: { ...opts.policy, escalate: false },
    marker,
    now: opts.now ?? new Date(),
  });
}

/** Record a digest fire, reusing {@link recordMeasurementCadenceFire}'s rolling-24h window. */
export function recordDigestCadenceFire(root: string, at: Date): void {
  const path = digestCadenceMarkerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  recordMeasurementCadenceFire(path, at, 24 * 60 * 60 * 1000);
}

// ── The interval: read from policy, every console-offered value checked against the declared bound.

/** The console's offered digest-interval choices, in hours. Exported so no caller hand-copies. */
export const DIGEST_INTERVAL_OPTIONS_HOURS: readonly number[] = [1, 2, 4, 8, 12, 24];

/** {@link DIGEST_INTERVAL_OPTIONS_HOURS} converted to minutes. */
export function digestIntervalOptionsMinutes(): number[] {
  return DIGEST_INTERVAL_OPTIONS_HOURS.map((h) => h * 60);
}

/** One console-offered interval value that falls OUTSIDE a declared `[min, max]` bound. */
export interface DigestIntervalBoundViolation {
  hours: number;
  minutes: number;
  reason: string;
}

/** Every console-offered interval value outside `bounds` — checked, never assumed, so a future
 *  console change that widens the option set without widening the declared bound is caught here
 *  rather than silently clamped. */
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

// ── The two halves, marked per item: every deterministic figure carries the re-runnable query
// that reproduces it, and a generated item is marked per item, never only by its section.

/** A re-runnable, checkable figure. `query` is the literal instruction a reader re-runs to
 *  reproduce `value`, never prose describing the number. */
export interface DeterministicDigestItem {
  kind: "deterministic";
  label: string;
  value: string;
  query: string;
}

/** Text somebody wrote — a suggestion, never a measurement (Law 5: never generated here). */
export interface GenerativeDigestItem {
  kind: "generative";
  text: string;
}

export type DigestCadenceItem = DeterministicDigestItem | GenerativeDigestItem;

/** Render one {@link DigestCadenceItem}. A deterministic item with no re-runnable `query` is a
 *  bug and fails the render, thrown rather than silently printed unattributed. */
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

/** Render every item, same fail-loud contract as {@link renderDigestCadenceItem}. */
export function renderDigestCadenceItems(items: DigestCadenceItem[]): string[] {
  return items.map(renderDigestCadenceItem);
}

/** The re-runnable query strings for the four counting figures {@link summarize} reduces. */
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

// ── The retro is cited, never re-derived.

/** One retro PR merged inside the digest window — a citation: reads the same `verdict` lines
 *  {@link summarize} reduces and names the PR, importing none of rule-efficacy.ts /
 *  verdict-calibration.ts / autonomy.ts, so it cannot re-derive a retro's own findings. */
export interface RetroCitation {
  taskId: "RETRO";
  prUrl?: string;
}

/** Every retro that merged inside `[sinceIso, now]`. */
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

// ── The delivery seam: the digest depends on NotifyChannel, never a concrete target. An inbox
// adapter lives here (not in notify.ts) since notify.ts's only shipped adapter is Darwin-only
// and this fleet runs on Linux; an adapter is an implementation of NotifyChannel, not a change
// to it.

/** The console inbox's digest feed. A plain JSON array of `{ts, text}`, newest last. */
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

/** A {@link NotifyChannel} implementation over the console inbox — a plain file write has no
 *  platform gate, unlike `notify.ts`'s Darwin-only `imessageChannel`. */
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

// ── The producer: Law 5, unconditionally — the digest files nothing, mints nothing, and spawns
// no worker to judge a task.

/** {@link runDigestCadenceReport}'s return: the text actually sent, which channel it went out
 *  under, and whether the channel reported itself deliverable (mirrors `notify()`'s own
 *  `delivered` ledger field). */
export interface DigestCadenceRunResult {
  text: string;
  channelName: string;
  delivered: boolean;
}

/**
 * The producer for the digest cadence rung: builds the digest text plus the deterministic-figure
 * queries, the retro citation and any `suggestions`, then delivers over `opts.deps.channel`. Law
 * 5, unconditionally: every parameter is data or a {@link NotifyChannel} — no spawn/gh/task-filing
 * dependency anywhere in the signature.
 */
export function runDigestCadenceReport(opts: {
  ledgerPath: string;
  sinceIso: string;
  deps: NotifyDeps;
  consoleBaseUrl?: string;
  /** Already-written generative items, never generated inside this function. Defaults to none. */
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
