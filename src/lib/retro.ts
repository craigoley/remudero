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

import { execFileSync } from "node:child_process";
// The DEFAULT export -- a plain, mutable object -- so a test's `t.mock.method` can
// actually intercept the marker's read/write calls: named bindings off `node:fs` are
// non-configurable and mock.method/defineProperty against them throws "Cannot redefine
// property" instead of installing a spy. See the identical import comment atop
// src/lib/status.ts (W1-T207) -- saveMarker/loadMarker below call `fsMarker.*` as live
// property lookups at call time for exactly this reason (test/retro-marker-atomic.test.ts).
import fsMarker from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { updateProposalRegistry, type EvidenceAnchor, type Proposal, type UpdateProposalRegistryOpts } from "./inbox.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD } from "./learnings.js";
import type { Lifecycle, LearningEntry, PromotionResult } from "./learnings.js";
import { resolveMountForClass, type Mounts } from "./mounts.js";
import {
  scanPlanCoherence,
  type PlanCoherenceFinding,
  type PlanCoherenceShardEntry,
} from "./plan-coherence.js";
import type { Task } from "./plan.js";
import { findExportDefinition, isExportReachable } from "./reachability.js";
import { REPLAY_RESULT_STEP } from "./replay.js";
import { utcWeekWindowMs } from "./sweep.js";
import { DEFAULT_TASK_CLASS } from "./task-class.js";
import { lintTask, type LintOpts, type LintViolation } from "./task-linter.js";
import type { QuestionEntry } from "./worker.js";

/** One parsed ledger line (superset of ledger.ts LedgerLine, as read back). */
export interface LedgerRecord {
  ts?: string;
  run_id?: string;
  task_id?: string;
  step?: string;
  [k: string]: unknown;
}

/** Parse an NDJSON ledger, skipping malformed lines (best-effort, deterministic). */
export function parseLedger(ndjson: string): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (const line of ndjson.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as LedgerRecord);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/** The reduced summary of ONE run (all lines sharing a run_id). */
export interface RunSummary {
  runId: string;
  taskId: string;
  type: string;
  startTs: string;
  verdict: string;
  costUsd: number;
  numTurns: number;
  prUrl?: string;
  /**
   * Present only when a `correction.provenance` ledger line overrode this run's
   * ledger-claimed PR url (W1-T51/P9-b — the false-attribution class, e.g. run
   * W1-T54b-1784151420811: `verdict.pr_url` claimed #80, the correction names #91).
   * Holds the ORIGINAL claimed url that was overridden; `prUrl` above is always
   * the truth (corrected when a correction exists, the ledger's own claim otherwise).
   */
  correctedFromPrUrl?: string;
  /** The task's risk band at `run.start` time (§9 mount axis), if logged. Used
   *  by {@link mineOverrunClasses} to group overruns by (type, risk) — the same
   *  axis mounts.yaml routes on — rather than by type alone. */
  risk?: string;
  /**
   * The task's routing CLASS (W1-T167 — docs / plan-lint / the `src` default)
   * at `run.start` time, if logged. The third mount-routing axis alongside
   * type/risk; {@link aggregateByClass} groups on this so the retro can read
   * per-class cost/merge-rate and evaluate whether the routing table's cheaper
   * docs/plan-lint mounts are actually cheaper AND still merging.
   */
  taskClass?: string;
  /** The worker-error `subtype` off the terminal `verdict` line (e.g.
   *  `error_max_turns`, `error_max_budget_usd`), if the run ended in one. A
   *  clean merge or a non-error verdict carries no subtype. */
  subtype?: string;
  /** The terminal `verdict` line's prose `reason`, when logged. W1-T91/P23:
   *  the fallback input for {@link resolveGuardCheck} on a run whose verdict
   *  line predates the structured `guard`/`check`/`observed` fields below. */
  reason?: string;
  /** W1-T91/P23 part (i): the guard class (`isolation`|`containment`, ...) off
   *  the terminal `verdict` line, when a guard-block wrote it structurally.
   *  Absent on any verdict line predating this task, and on every non-guard
   *  verdict — {@link resolveGuardCheck} is the reader that tolerates both. */
  guard?: string;
  /** W1-T91/P23 part (i): the specific probe/check the guard ran (e.g.
   *  `inherited-functions`, `outside-cwd-denial`), alongside `guard` above. */
  check?: string;
  /** W1-T91/P23 part (i): what the probe OBSERVED, preserving the preflight's
   *  three-state epistemology (proven-holding | proven-broken | UNPROVEN)
   *  verbatim — never collapsed to a boolean. */
  observed?: string;
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
  outputTokens?: number;
}

const DONE_STEPS = new Set(["recon.done", "implement.done", "implement.resumed"]);

/**
 * A `correction.provenance` line for this run, if any — a FIRST-CLASS ledger
 * EVENT (MASTER-PLAN P9-iv): the operator has already written the truth (an
 * `actual_pr_url`) over a run's false ledger claim, and every reducer must honor
 * it rather than re-deriving the false claim. Last one wins if several exist.
 */
function correctionFor(lines: LedgerRecord[]): string | undefined {
  let url: string | undefined;
  for (const l of lines) {
    if (l.step === "correction.provenance" && typeof l.actual_pr_url === "string") url = l.actual_pr_url;
  }
  return url;
}

/** W1-T930: `l.tokens.output` off one ledger line, tolerating every shape a
 *  hand-built test fixture or a pre-token-ledgering line might carry (missing
 *  `tokens`, a non-object `tokens`, a non-numeric `output`) — `0`, never a
 *  thrown TypeError, on anything that isn't the real `TokenUsage` shape. */
function outputTokensOf(l: LedgerRecord): number {
  const t = l.tokens;
  if (t && typeof t === "object" && "output" in t) {
    const v = (t as { output?: unknown }).output;
    if (typeof v === "number") return v;
  }
  return 0;
}

/** Reduce ledger lines into per-run summaries, keyed by run_id (deterministic). */
export function gatherRuns(records: LedgerRecord[]): RunSummary[] {
  const byRun = new Map<string, LedgerRecord[]>();
  for (const r of records) {
    if (!r.run_id) continue;
    const arr = byRun.get(r.run_id) ?? [];
    arr.push(r);
    byRun.set(r.run_id, arr);
  }
  const runs: RunSummary[] = [];
  for (const [runId, lines] of byRun) {
    const start = lines.find((l) => l.step === "run.start");
    if (!start) continue; // a run with no start is a torn fragment — skip
    const verdictLine = lines.find((l) => l.step === "verdict");
    const numTurns = lines
      .filter((l) => l.step && DONE_STEPS.has(l.step))
      .reduce((s, l) => s + (typeof l.num_turns === "number" ? l.num_turns : 0), 0);
    // W1-T930: same DONE_STEPS scope as numTurns above — recon + implement
    // (+ its resume) are the worker calls that actually spend output tokens
    // toward this run's own work; a reviewer/dep-review call ledgers its own
    // separate run_id and is out of scope here, exactly as it already is for turns.
    const outputTokens = lines
      .filter((l) => l.step && DONE_STEPS.has(l.step))
      .reduce((s, l) => s + outputTokensOf(l), 0);
    const costLine = verdictLine ?? lines.find((l) => typeof l.cost_usd === "number");
    const prLine =
      lines.find((l) => l.step === "pr.opened") ?? verdictLine ?? lines.find((l) => l.pr_url);
    const claimedPrUrl = typeof prLine?.pr_url === "string" ? prLine.pr_url : undefined;
    const correctedUrl = correctionFor(lines);
    runs.push({
      runId,
      taskId: String(start.task_id ?? ""),
      type: String(start.type ?? "unknown"),
      startTs: String(start.ts ?? ""),
      verdict: String(verdictLine?.verdict ?? "incomplete"),
      costUsd: typeof costLine?.cost_usd === "number" ? costLine.cost_usd : 0,
      numTurns,
      outputTokens,
      prUrl: correctedUrl ?? claimedPrUrl,
      ...(correctedUrl !== undefined ? { correctedFromPrUrl: claimedPrUrl } : {}),
      ...(typeof start.risk === "string" ? { risk: start.risk } : {}),
      ...(typeof start.task_class === "string" ? { taskClass: start.task_class } : {}),
      ...(typeof verdictLine?.subtype === "string" ? { subtype: verdictLine.subtype } : {}),
      ...(typeof verdictLine?.reason === "string" ? { reason: verdictLine.reason } : {}),
      // W1-T91/P23 (i): the structured guard-cause fields, when the verdict line
      // carried them (a guard-block written after this task landed).
      ...(typeof verdictLine?.guard === "string" ? { guard: verdictLine.guard } : {}),
      ...(typeof verdictLine?.check === "string" ? { check: verdictLine.check } : {}),
      ...(typeof verdictLine?.observed === "string" ? { observed: verdictLine.observed } : {}),
    });
  }
  // Deterministic order: by start timestamp then run id.
  runs.sort((a, b) => (a.startTs < b.startTs ? -1 : a.startTs > b.startTs ? 1 : a.runId < b.runId ? -1 : 1));
  return runs;
}

/** Calibration aggregate for one task type — the numbers mounts.yaml (W1-T5) needs. */
export interface TypeCalibration {
  type: string;
  runs: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgTurns: number;
  merged: number;
}

/** Aggregate runs BY TASK TYPE (the calibration table). Deterministic, ordered. */
export function aggregateByType(runs: RunSummary[]): TypeCalibration[] {
  const byType = new Map<string, RunSummary[]>();
  for (const r of runs) {
    const arr = byType.get(r.type) ?? [];
    arr.push(r);
    byType.set(r.type, arr);
  }
  const out: TypeCalibration[] = [];
  for (const [type, rs] of byType) {
    const totalCost = rs.reduce((s, r) => s + r.costUsd, 0);
    const totalTurns = rs.reduce((s, r) => s + r.numTurns, 0);
    out.push({
      type,
      runs: rs.length,
      totalCostUsd: round(totalCost),
      avgCostUsd: round(totalCost / rs.length),
      avgTurns: round(totalTurns / rs.length),
      merged: rs.filter((r) => r.verdict === "merged").length,
    });
  }
  out.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return out;
}

/**
 * W1-T930: below this fraction of a class's runs reporting a nonzero
 * `numTurns`, the numerator `turnsPerMerge`/`outputTokensPerMerge` divide by
 * is too thin to trust — MASTER-PLAN's own worked example (4 of 14 credited
 * runs, 29%) sits well under this bar and is the exact case the design's
 * "reuse the discipline verbatim" clause names. Exported so a test can pin
 * the boundary rather than re-deriving it from a magic number.
 */
export const MIN_TURN_COVERAGE_FOR_PER_MERGE = 0.5;

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
export interface ClassCalibration {
  taskClass: string;
  runs: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgTurns: number;
  merged: number;
  mergeRate: number;
  /** W1-T930: total `TokenUsage.output` summed across every run in this
   *  class — the per-run companion to `totalCostUsd`, the dominant spend
   *  term that had no calibration column at all before this task. */
  totalOutputTokens: number;
  /** W1-T930: fraction of this class's runs with a nonzero logged
   *  `numTurns` — travels beside `turnsPerMerge`/`outputTokensPerMerge` so a
   *  thin numerator is never read as a solid one (MASTER-PLAN's "29%
   *  coverage" signal, generalized). Below {@link MIN_TURN_COVERAGE_FOR_PER_MERGE}
   *  the per-merge cells below carry a coverage caveat rather than a bare number. */
  turnCoverage: number;
  /** W1-T930: which merge-crediting mechanism `mergedForDenominator` (and
   *  therefore the per-merge fields) actually divides by — `"shipped"` when
   *  the caller passed the W1-T51 SHIPPED union (trailer-matched, closes the
   *  known ledger-verdict undercount), `"ledger"` when it did not and this
   *  fell back to the same ledger-verdict `merged` count above. Always set —
   *  a row with no nameable merge source is never emitted. */
  mergeSource: "ledger" | "shipped";
  /** W1-T930: the merge count the per-merge fields below actually divide
   *  by — NOT always equal to `merged` above (see `mergeSource`). */
  mergedForDenominator: number;
  /** W1-T930: turns spent per MERGED PR in this class — numerator is
   *  `avgTurns`'s own total (ALL turns spent, including refused runs, so
   *  a class cannot lower this by refusing more), denominator is
   *  `mergedForDenominator`. `null` only when `mergedForDenominator` is 0
   *  (division by zero is never computed and never silently reads as 0). */
  turnsPerMerge: number | null;
  /** W1-T930: output tokens spent per MERGED PR — same numerator/denominator
   *  discipline as `turnsPerMerge`. `null` only when `mergedForDenominator` is 0. */
  outputTokensPerMerge: number | null;
}

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
export function aggregateByClass(runs: RunSummary[], shipped?: ShippedRecord[]): ClassCalibration[] {
  const byClass = new Map<string, RunSummary[]>();
  for (const r of runs) {
    const key = r.taskClass ?? "unknown";
    const arr = byClass.get(key) ?? [];
    arr.push(r);
    byClass.set(key, arr);
  }
  // W1-T930: runId -> class, the join `shipped` (which carries no taskClass)
  // needs to be attributed back to the class its own run was routed under.
  const classOfRun = new Map<string, string>();
  for (const r of runs) classOfRun.set(r.runId, r.taskClass ?? "unknown");
  const shippedByClass = new Map<string, number>();
  if (shipped) {
    for (const s of shipped) {
      const key = classOfRun.get(s.runId) ?? "unknown";
      shippedByClass.set(key, (shippedByClass.get(key) ?? 0) + 1);
    }
  }
  const out: ClassCalibration[] = [];
  for (const [taskClass, rs] of byClass) {
    const totalCost = rs.reduce((s, r) => s + r.costUsd, 0);
    const totalTurns = rs.reduce((s, r) => s + r.numTurns, 0);
    const totalOutputTokens = rs.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
    const merged = rs.filter((r) => r.verdict === "merged").length;
    // W1-T930: nonzero-numTurns coverage over this class's own runs — the
    // numerator-trust signal, independent of which merge count is the
    // denominator (that is `mergeSource`/`mergedForDenominator` below).
    const runsWithTurns = rs.filter((r) => r.numTurns > 0).length;
    const turnCoverage = round(runsWithTurns / rs.length);
    const mergeSource: "ledger" | "shipped" = shipped ? "shipped" : "ledger";
    const mergedForDenominator = shipped ? (shippedByClass.get(taskClass) ?? 0) : merged;
    out.push({
      taskClass,
      runs: rs.length,
      totalCostUsd: round(totalCost),
      avgCostUsd: round(totalCost / rs.length),
      avgTurns: round(totalTurns / rs.length),
      merged,
      mergeRate: round(merged / rs.length),
      totalOutputTokens,
      turnCoverage,
      mergeSource,
      mergedForDenominator,
      turnsPerMerge: mergedForDenominator === 0 ? null : round(totalTurns / mergedForDenominator),
      outputTokensPerMerge: mergedForDenominator === 0 ? null : round(totalOutputTokens / mergedForDenominator),
    });
  }
  out.sort((a, b) => (a.taskClass < b.taskClass ? -1 : a.taskClass > b.taskClass ? 1 : 0));
  return out;
}

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
export interface ModelClassWeeklyBurn {
  /** The model tier (a `.remudero/mounts.yaml` `tiers` key) this share burned on,
   *  or `"unresolved"` for a run whose (task_type, risk) has no route in `mounts`
   *  at all (a config gap the retro surfaces rather than crashing on — this is
   *  read-only reporting over a possibly-legacy ledger, never a dispatch gate). */
  model: string;
  runs: number;
  turnsThisWeek: number;
  /** Imputed-dollar context only (clause c) — never the share driver. */
  costUsdThisWeek: number;
  /** `turnsThisWeek / (turns burned by every resolved model this week)`; `0`
   *  when the week burned zero turns across every model (an empty week, not a
   *  divide-by-zero) — the SHARE of the weekly subscription window this model
   *  tier is burning, the cross-file invariant this task ratifies. */
  shareOfWeeklyBurn: number;
}

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
export function aggregateWeeklyBurnByModelClass(runs: RunSummary[], mounts: Mounts, now: number): ModelClassWeeklyBurn[] {
  const [weekStart, weekEnd] = utcWeekWindowMs(now);
  const inWeek = runs.filter((r) => {
    const ts = Date.parse(r.startTs);
    return Number.isFinite(ts) && ts >= weekStart && ts < weekEnd;
  });
  const byModel = new Map<string, RunSummary[]>();
  for (const r of inWeek) {
    let model = "unresolved";
    try {
      model = resolveMountForClass(mounts, r.type, r.risk ?? "unknown", r.taskClass ?? DEFAULT_TASK_CLASS).mount.model;
    } catch {
      model = "unresolved"; // no route for this run's (task_type, risk) — a config gap, surfaced not thrown
    }
    const arr = byModel.get(model) ?? [];
    arr.push(r);
    byModel.set(model, arr);
  }
  const totalTurns = inWeek.reduce((s, r) => s + r.numTurns, 0);
  const out: ModelClassWeeklyBurn[] = [];
  for (const [model, rs] of byModel) {
    const turns = rs.reduce((s, r) => s + r.numTurns, 0);
    const cost = rs.reduce((s, r) => s + r.costUsd, 0);
    out.push({
      model,
      runs: rs.length,
      turnsThisWeek: turns,
      costUsdThisWeek: round(cost),
      shareOfWeeklyBurn: totalTurns === 0 ? 0 : round(turns / totalTurns),
    });
  }
  out.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return out;
}

/** Verdict distribution across runs (deterministic key order). */
export function verdictDistribution(runs: RunSummary[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const r of runs) dist[r.verdict] = (dist[r.verdict] ?? 0) + 1;
  return Object.fromEntries(Object.entries(dist).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Merged runs strictly AFTER the marker ts, keyed by task (Remudero-Task trailer). */
export function mergedSince(runs: RunSummary[], sinceTs: string | undefined): RunSummary[] {
  return runs.filter((r) => r.verdict === "merged" && (!sinceTs || r.startTs > sinceTs));
}

// ── W1-T51: the SHIPPED union (ledger ∪ GitHub-derived trailered merges) ──────
//
// `mergedSince` above keys ONLY on ledger verdict==='merged', so a PR that merges
// GATE-SIDE after its run ended some other terminal verdict (a Rule-16 Architect
// fix landing after a blocked_review run) is INVISIBLE to it — the gap this task
// closes. `mergedSince` itself is left untouched (no regression, MASTER-PLAN P11);
// `shippedSince` below is the sibling that unions both sources.

/** A run's own worktree branch — deterministic, matches run-task.ts's `run-<runId>` naming. */
export function ownBranchOf(runId: string): string {
  return `run-${runId}`;
}

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
export function probeGithubThrottle(): string | undefined {
  try {
    const out = execFileSync("gh", ["api", "rate_limit", "--jq", ".rate.remaining"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const remaining = Number(out);
    if (Number.isFinite(remaining) && remaining <= 0) {
      return "GitHub API rate limit exhausted (0 remaining)";
    }
    return undefined;
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = String(err.stderr ?? err.message ?? "").trim();
    return `gh rate_limit probe failed: ${stderr || "unknown error"}`;
  }
}

/** One credited SHIPPED entry — either a ledger-native merge or a GitHub-discovered gate-side merge. */
export interface ShippedRecord {
  taskId: string;
  runId: string;
  prUrl: string;
  costUsd: number;
  numTurns: number;
  source: "ledger" | "github";
  /** Present ONLY for a GitHub-discovered merge whose run did NOT end verdict=merged. */
  annotation?: string;
}

/**
 * The GitHub queries `shippedSince` needs: a trailer lookup for the GitHub-side
 * union half, and a PR's head branch for the P9 ownership assert — the exact
 * shape of run-task.ts's `PrHeadGateway` (W1-T62's write-side guard), applied
 * here at the READ side. A real implementation composes `status.ts`'s
 * `ghGateway` (for `findMergedByTrailer`) with a `gh pr view --json headRefName`
 * lookup (for `headRefName`), mirroring run-task.ts's `ghPrHeadGateway`.
 */
export interface ShippedGithub {
  /** Find a MERGED PR whose body contains `Remudero-Task: <taskId>`. null if none. */
  findMergedByTrailer(taskId: string): { number: number; url: string } | null;
  /** The PR's head branch name, or undefined if it cannot be resolved. */
  headRefName(prUrl: string): string | undefined;
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
  unavailable?(): string | undefined;
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
  mergedCommits?(): GitLogCommit[];
}

/** The result of the SHIPPED union: what got credited, and every named discrepancy. */
export interface ShippedResult {
  shipped: ShippedRecord[];
  discrepancies: string[];
}

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
export function shippedSince(
  runs: RunSummary[],
  sinceTs: string | undefined,
  github: ShippedGithub,
): ShippedResult {
  const scoped = sinceTs ? runs.filter((r) => r.startTs > sinceTs) : runs;
  const shipped: ShippedRecord[] = [];
  const discrepancies: string[] = [];

  for (const r of scoped) {
    const ownBranch = ownBranchOf(r.runId);
    if (r.verdict === "merged") {
      if (!r.prUrl) {
        discrepancies.push(`${r.taskId} (${r.runId}): ledger verdict=merged but has no pr_url — cannot credit`);
        continue;
      }
      const head = github.headRefName(r.prUrl);
      if (head !== ownBranch) {
        discrepancies.push(
          `${r.taskId} (${r.runId}): REJECTED — ledger claims ${r.prUrl} but its head branch ` +
            `("${head ?? "unresolved"}") is not this run's own branch ("${ownBranch}") — stale/foreign trailer, never credited`,
        );
        continue;
      }
      shipped.push({ taskId: r.taskId, runId: r.runId, prUrl: r.prUrl, costUsd: r.costUsd, numTurns: r.numTurns, source: "ledger" });
    } else {
      const pr = github.findMergedByTrailer(r.taskId);
      if (!pr) continue; // no GitHub evidence either — genuinely not shipped
      const head = github.headRefName(pr.url);
      if (head !== ownBranch) {
        discrepancies.push(
          `${r.taskId} (${r.runId}): REJECTED — GitHub trailer names ${pr.url} but its head branch ` +
            `("${head ?? "unresolved"}") is not this run's own branch ("${ownBranch}") — stale/foreign trailer, never credited`,
        );
        continue;
      }
      shipped.push({
        taskId: r.taskId,
        runId: r.runId,
        prUrl: pr.url,
        costUsd: r.costUsd,
        numTurns: r.numTurns,
        source: "github",
        annotation: `gate-side merge; run ended ${r.verdict}`,
      });
      discrepancies.push(
        `${r.taskId} (${r.runId}): ledger verdict=${r.verdict} but GitHub shows ${pr.url} MERGED — gate-side merge, now credited`,
      );
    }
  }

  shipped.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  return { shipped, discrepancies };
}

/** The ledger-only fallback for `RetroGather.shipped` when no GitHub gateway is
 * wired — IDENTICAL to today's `mergedSince` crediting (no ownership check, no
 * annotation): a caller that hasn't wired a gateway yet gets no regression and
 * no unverified claim, rather than a default that silently trusts everything. */
function ledgerOnlyShipped(merged: RunSummary[]): ShippedRecord[] {
  return merged
    .filter((r): r is RunSummary & { prUrl: string } => typeof r.prUrl === "string")
    .map((r) => ({ taskId: r.taskId, runId: r.runId, prUrl: r.prUrl, costUsd: r.costUsd, numTurns: r.numTurns, source: "ledger" as const }));
}

// ── W1-T2288: the retro TRIGGER's merges beyond shippedSince's reach ─────────────────────────
//
// `shippedSince` above iterates `runs` (a RunSummary[], reduced from the LEDGER) — a merge with
// NO run at all has no loop iteration and is therefore structurally unreachable, not merely
// undercounted. A plan/triage/feedback filing is exactly that case: it is merged from a branch
// that was never `ownBranchOf` any run, and it never had a run to begin with. `runlessMergesSince`
// below is the DISJOINT complement, read off this repo's own `git log` (via
// `ShippedGithub.mergedCommits`) rather than the ledger or a per-task GitHub search — commit
// history needs no ledger and cannot rotate out from under a slow-moving marker.

/** The exact anchored form `findMergedByTrailer`'s own doc measures against real PR bodies
 *  (status.ts `TRAILER_RE`, autonomy.ts `TRAILER_RE`) — reused here, not reinvented, so a
 *  trailer this function fails to see is a trailer none of this repo's other credit paths see
 *  either. */
const RETRO_TRAILER_RE = /^Remudero-Task:\s*(\S+)\s*$/m;

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
export function runlessMergesSince(
  commits: GitLogCommit[],
  sinceTs: string | undefined,
  taskIdsWithRuns: ReadonlySet<string>,
): GitLogCommit[] {
  return commits.filter((c) => {
    if (sinceTs && !(c.date > sinceTs)) return false;
    const taskId = RETRO_TRAILER_RE.exec(c.message)?.[1];
    return !taskId || !taskIdsWithRuns.has(taskId);
  });
}

/** Count LEARNINGS entries (top-level `- ` bullets) — used for the added-since delta. */
export function learningsCount(learningsMd: string): number {
  return learningsMd.split("\n").filter((l) => /^- /.test(l)).length;
}

/**
 * Files under `src/` or `test/` touched by a unified diff. A retro is PLAN-ONLY —
 * it must touch NONE (one concern: the harness syncs its PLAN, never ships code in
 * the same PR). The retro command fails closed when this returns non-empty.
 */
export function codeFilesInDiff(diff: string): string[] {
  return [...diff.matchAll(/^\+\+\+ b\/(\S+)/gm)]
    .map((m) => m[1])
    .filter((f) => /^(src|test)\//.test(f));
}

// ── The Tier Invariant (G-17): the retro Architect outranks implement workers ──

/** Model → tier rank. Higher = more capable. Substring-matched, lineup-config'd. */
export const MODEL_TIER: Record<string, number> = {
  haiku: 1,
  sonnet: 2,
  opus: 3,
  fable: 3,
};

/** Tier rank of a model string (substring match; unknown → 0). */
export function tierOf(model: string): number {
  const m = model.toLowerCase();
  for (const [name, rank] of Object.entries(MODEL_TIER)) if (m.includes(name)) return rank;
  return 0;
}

/**
 * Enforce G-17: the retro Architect MUST ride a higher tier than the implement
 * workers it reviews. Throws (fail-closed) on violation — a same-or-lower-tier
 * synthesizer is not an Architect.
 */
export function assertArchitectAboveWorker(architectModel: string, workerModel: string): void {
  if (tierOf(architectModel) <= tierOf(workerModel)) {
    throw new Error(
      `G-17 Tier Invariant: retro Architect (${architectModel}, tier ${tierOf(architectModel)}) must ` +
        `ride a HIGHER tier than implement workers (${workerModel}, tier ${tierOf(workerModel)}).`,
    );
  }
}

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

const ARCHITECT_LANE_STEPS: Readonly<Record<string, string>> = {
  retro: "retro.synthesized",
  triage: "triage.synthesized",
  plan: "plan.synthesized",
  inbox_draft: "inbox.draft_synthesized",
};

/** Non-Architect lanes reported for SCALE ONLY — "share of what" needs a
 *  denominator, and these are the two lanes whose spend the Architect lanes
 *  actually sit beside (the implement worker G-17 says the Architect must
 *  outrank, and the advisory reviewer, itself out of this shard's scope but
 *  already the dominant non-implement cost). */
const COMPARISON_LANE_STEPS: Readonly<Record<string, string>> = {
  implement: "verdict",
  reviewer: "review.reviewer",
};

/** The bucket a row with no `model` key reports under — NEVER folded into a
 *  real model's count, so a corpus that is mostly unattributed (the rationale's
 *  451-of-613 `verdict` rows) reads as unattributed rather than as a silent
 *  majority for whichever model happened to be read first. */
export const UNATTRIBUTED_MODEL = "unattributed";

/** One model's row-count within a single lane (see {@link UNATTRIBUTED_MODEL}). */
export interface LaneModelShare {
  model: string;
  rows: number;
}

/** One lane's measured spend — rows, NOTIONAL (never billed) cost, the newest
 *  row it saw, and its model attribution. */
export interface LaneSpend {
  lane: string;
  step: string;
  rows: number;
  /** Sum of each row's `cost_usd` (falling back to `total_cost_usd`, the same
   *  precedence {@link gatherRuns}'s `costLine` uses) — NOTIONAL / API-equivalent
   *  price on a subscription install, never billed spend (MASTER-PLAN's own
   *  cost semantics; see {@link ModelClassWeeklyBurn}'s doc for the same caveat). */
  costUsd: number;
  /** The most recent `ts` this lane's rows carried — absent only when the lane
   *  logged zero rows in the corpus this ran over. */
  newestTs?: string;
  models: LaneModelShare[];
}

/** `r.cost_usd`, falling back to `r.total_cost_usd` — the SAME precedence
 *  {@link gatherRuns}'s `costLine` already uses, so this reads the identical
 *  notional figure the per-type/per-class tables above are built from. */
function costOf(r: LedgerRecord): number {
  if (typeof r.cost_usd === "number") return r.cost_usd;
  if (typeof r.total_cost_usd === "number") return r.total_cost_usd;
  return 0;
}

function laneSpendOf(lane: string, step: string, rows: LedgerRecord[]): LaneSpend {
  const models = new Map<string, number>();
  let newestTs: string | undefined;
  for (const r of rows) {
    const model = typeof r.model === "string" && r.model.length > 0 ? r.model : UNATTRIBUTED_MODEL;
    models.set(model, (models.get(model) ?? 0) + 1);
    if (typeof r.ts === "string" && (newestTs === undefined || r.ts > newestTs)) newestTs = r.ts;
  }
  return {
    lane,
    step,
    rows: rows.length,
    costUsd: round(rows.reduce((s, r) => s + costOf(r), 0)),
    ...(newestTs !== undefined ? { newestTs } : {}),
    models: [...models.entries()]
      .map(([model, n]) => ({ model, rows: n }))
      .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)),
  };
}

/** The whole G-17-evidence gather: the four Architect lanes, the two
 *  comparison lanes, the Architect lanes' combined share of the measured
 *  total, and the WINDOW (oldest → newest `ts` seen across every lane below)
 *  so a stale corpus cannot read as a current share. */
export interface ArchitectLaneShareReport {
  architectLanes: LaneSpend[];
  comparisonLanes: LaneSpend[];
  architectRows: number;
  /** NOTIONAL / API-equivalent — see {@link LaneSpend.costUsd}. */
  architectCostUsd: number;
  totalRows: number;
  /** NOTIONAL / API-equivalent — see {@link LaneSpend.costUsd}. */
  totalCostUsd: number;
  /** `architectCostUsd / totalCostUsd`; `0` when the measured total is $0
   *  (an empty corpus, not a divide-by-zero). */
  shareOfSpend: number;
  windowStartTs?: string;
  windowEndTs?: string;
}

/**
 * Measure the Architect-lane share of spend over `records` — a PURE reduction,
 * exactly like every other miner in this file (never touches `.remudero/mounts.yaml`,
 * `config`, or any file: it takes ONLY the already-parsed ledger records `buildGather`
 * hands it, the same corpus {@link aggregateByType}/{@link aggregateByClass} read).
 * Single pass over `records`: each row is bucketed by its `step` into at most one
 * of the six named lanes (an unrecognized step contributes to none of them).
 */
export function architectLaneShare(records: LedgerRecord[]): ArchitectLaneShareReport {
  const laneOfStep = new Map<string, string>();
  for (const [lane, step] of Object.entries(ARCHITECT_LANE_STEPS)) laneOfStep.set(step, lane);
  for (const [lane, step] of Object.entries(COMPARISON_LANE_STEPS)) laneOfStep.set(step, lane);

  const rowsByLane = new Map<string, LedgerRecord[]>();
  for (const lane of laneOfStep.values()) rowsByLane.set(lane, []);
  let windowStartTs: string | undefined;
  let windowEndTs: string | undefined;
  for (const r of records) {
    const lane = typeof r.step === "string" ? laneOfStep.get(r.step) : undefined;
    if (!lane) continue;
    rowsByLane.get(lane)!.push(r);
    if (typeof r.ts === "string") {
      if (windowStartTs === undefined || r.ts < windowStartTs) windowStartTs = r.ts;
      if (windowEndTs === undefined || r.ts > windowEndTs) windowEndTs = r.ts;
    }
  }

  const architectLanes = Object.entries(ARCHITECT_LANE_STEPS).map(([lane, step]) =>
    laneSpendOf(lane, step, rowsByLane.get(lane) ?? []),
  );
  const comparisonLanes = Object.entries(COMPARISON_LANE_STEPS).map(([lane, step]) =>
    laneSpendOf(lane, step, rowsByLane.get(lane) ?? []),
  );
  const allLanes = [...architectLanes, ...comparisonLanes];
  const architectRows = architectLanes.reduce((s, l) => s + l.rows, 0);
  const architectCostUsd = round(architectLanes.reduce((s, l) => s + l.costUsd, 0));
  const totalRows = allLanes.reduce((s, l) => s + l.rows, 0);
  const totalCostUsd = round(allLanes.reduce((s, l) => s + l.costUsd, 0));
  return {
    architectLanes,
    comparisonLanes,
    architectRows,
    architectCostUsd,
    totalRows,
    totalCostUsd,
    shareOfSpend: totalCostUsd === 0 ? 0 : round(architectCostUsd / totalCostUsd),
    ...(windowStartTs !== undefined ? { windowStartTs } : {}),
    ...(windowEndTs !== undefined ? { windowEndTs } : {}),
  };
}

/** Render one {@link ArchitectLaneShareReport} lane row (markdown table body). */
function laneSpendRow(l: LaneSpend): string {
  const models = l.models.length ? l.models.map((m) => `${m.model}×${m.rows}`).join(", ") : "(no rows)";
  return `| ${l.lane} (\`${l.step}\`) | ${l.rows} | $${l.costUsd.toFixed(2)} | ${l.newestTs ?? "(none)"} | ${models} |`;
}

/** Render the lane table (markdown) — Architect lanes first, then the two
 *  comparison lanes, in the SAME row shape so the share is legible at a glance. */
export function architectLaneShareTable(g: ArchitectLaneShareReport): string {
  return [
    "| lane (`step`) | rows | notional $ (api-equivalent, NOT billed) | newest row | models (unattributed = no `model` key) |",
    "|---|---|---|---|---|",
    ...g.architectLanes.map(laneSpendRow),
    ...g.comparisonLanes.map(laneSpendRow),
  ].join("\n");
}

/** Render the full G-17-evidence section — printed beside the per-class
 *  calibration table in {@link renderGather} (W1-T2239's own acceptance:
 *  "the retro gather reports the architect-lane share of spend beside the
 *  per-class routing data it already collects"). */
export function renderArchitectLaneShare(g: ArchitectLaneShareReport): string {
  const windowLine =
    g.windowStartTs !== undefined && g.windowEndTs !== undefined
      ? `Window covered: ${g.windowStartTs} → ${g.windowEndTs} · newest row seen: ${g.windowEndTs} — ` +
        `a corpus this stale reads as a HISTORICAL share, never a current one.`
      : "Window covered: (no rows in any of the six lanes below) — no window, no share to trust.";
  return [
    "## G-17 Architect-lane share of spend (W1-T2239 — evidence for the capability half, not a tier move)",
    "MASTER-PLAN §9's ratification-authority half of G-17 is unaffected by anything below; this " +
      "measures ONLY the capability half (a higher-tier Architect authors better harness text), " +
      "which this repo has never tested against its own ledger. `assertArchitectAboveWorker` keeps " +
      "throwing on a same-or-lower-tier Architect regardless of this number, and no mount row moves.",
    windowLine,
    `Architect lanes (retro + triage + plan + inbox-draft): ${g.architectRows} rows, ` +
      `$${g.architectCostUsd.toFixed(2)} notional — ${(g.shareOfSpend * 100).toFixed(1)}% of the ` +
      `${g.totalRows}-row / $${g.totalCostUsd.toFixed(2)}-notional measured total below.`,
    "Every $ figure on this table is NOTIONAL / API-EQUIVALENT price on a subscription install " +
      "(MASTER-PLAN's own cost semantics) — never billed spend.",
    "",
    architectLaneShareTable(g),
  ].join("\n");
}

// ── The full gather + its rendering ───────────────────────────────────────

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

/** One row of plan/mast-mapping.yaml: a ledger verdict class (+ optional
 *  `subtype` qualifier -- the worker-error subtype off the terminal `verdict`
 *  ledger line, e.g. `error_max_turns`) coded to one MAST failure mode + its
 *  category. `provisional` marks a row an open investigation (P23) is still
 *  refining -- visible in the render, not a distinct code path. */
export interface MastMappingRow {
  verdict: string;
  subtype?: string;
  mastMode: string;
  category: string;
  provisional?: boolean;
  comment?: string;
}

/** The whole parsed mapping table -- an ordered list of rows, matched most-specific-first. */
export interface MastMapping {
  rows: MastMappingRow[];
}

/** plan/mast-mapping.yaml is structurally invalid (not a fixture bug, a file bug). */
export class MastMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MastMappingError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse + validate raw YAML text into a {@link MastMapping}. Pure (no I/O) so a
 * test can hand it a fixture string directly, same shape as {@link parseLedger}.
 * Fails LOUDLY on a malformed row (Rule 2's own discipline: a mapping this
 * central is trusted to be well-formed, never guessed at by a lenient parser).
 */
export function parseMastMapping(yamlText: string): MastMapping {
  const raw = parseYaml(yamlText);
  if (!isPlainObject(raw) || !Array.isArray(raw.rows)) {
    throw new MastMappingError("mast-mapping.yaml must be a mapping with a 'rows' array.");
  }
  const rows: MastMappingRow[] = raw.rows.map((row: unknown, i: number) => {
    if (!isPlainObject(row)) throw new MastMappingError(`mast-mapping.yaml rows[${i}] must be a mapping.`);
    const { verdict, subtype, mast_mode, category, provisional, comment } = row;
    if (typeof verdict !== "string" || !verdict) {
      throw new MastMappingError(`mast-mapping.yaml rows[${i}].verdict must be a non-empty string.`);
    }
    if (typeof mast_mode !== "string" || !mast_mode) {
      throw new MastMappingError(`mast-mapping.yaml rows[${i}].mast_mode must be a non-empty string.`);
    }
    if (typeof category !== "string" || !category) {
      throw new MastMappingError(`mast-mapping.yaml rows[${i}].category must be a non-empty string.`);
    }
    if (subtype !== undefined && typeof subtype !== "string") {
      throw new MastMappingError(`mast-mapping.yaml rows[${i}].subtype must be a string when present.`);
    }
    if (provisional !== undefined && typeof provisional !== "boolean") {
      throw new MastMappingError(`mast-mapping.yaml rows[${i}].provisional must be a boolean when present.`);
    }
    return {
      verdict,
      ...(typeof subtype === "string" ? { subtype } : {}),
      mastMode: mast_mode,
      category,
      ...(provisional === true ? { provisional: true } : {}),
      ...(typeof comment === "string" ? { comment } : {}),
    };
  });
  return { rows };
}

/** Load + parse plan/mast-mapping.yaml (or any path holding the same shape) from disk. */
export function loadMastMapping(path: string): MastMapping {
  return parseMastMapping(fsMarker.readFileSync(path, "utf8"));
}

/**
 * Find the row coding one run, preferring an exact (verdict, subtype) row over
 * its bare-verdict sibling -- the "optional qualifiers" plan/mast-mapping.yaml's
 * design describes. Returns undefined when no row matches at all: the caller
 * codes that as unmapped, never guesses.
 */
export function mastRowFor(mapping: MastMapping, run: Pick<RunSummary, "verdict" | "subtype">): MastMappingRow | undefined {
  if (run.subtype) {
    const exact = mapping.rows.find((r) => r.verdict === run.verdict && r.subtype === run.subtype);
    if (exact) return exact;
  }
  return mapping.rows.find((r) => r.verdict === run.verdict && r.subtype === undefined);
}

/** The per-cycle MAST failure distribution `rmd retro` reports (W1-T89). */
export interface MastCategoryDistribution {
  /** category -> count, deterministic key order. `merged` runs are never
   *  counted here -- success is out of scope for a FAILURE distribution
   *  (P18's own framing); they never reach {@link mastRowFor} at all. */
  byCategory: Record<string, number>;
  /** Every failure verdict the mapping named no row for, as `verdict` (or
   *  `verdict:subtype` when the run logged a subtype) -> count. Named,
   *  visible, NEVER silently dropped or folded into a guessed category. */
  unmapped: Record<string, number>;
}

function sortedCountRecord(m: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)));
}

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
const CREDITED_VERDICTS: ReadonlySet<string> = new Set(["merged", "already_satisfied", "task_already_merged"]);

/**
 * Reduce a cycle's runs into a {@link MastCategoryDistribution} against `mapping`.
 * Pure and deterministic -- the mapping is DATA, so a row edit alone (zero code
 * changes) flips a fixture's outcome; see mast-mapping.test.ts.
 */
export function mastCategoryDistribution(runs: RunSummary[], mapping: MastMapping): MastCategoryDistribution {
  const byCategory: Record<string, number> = {};
  const unmapped: Record<string, number> = {};
  for (const r of runs) {
    if (CREDITED_VERDICTS.has(r.verdict)) continue;
    const row = mastRowFor(mapping, r);
    if (row) {
      byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
    } else {
      const key = r.subtype ? `${r.verdict}:${r.subtype}` : r.verdict;
      unmapped[key] = (unmapped[key] ?? 0) + 1;
    }
  }
  return { byCategory: sortedCountRecord(byCategory), unmapped: sortedCountRecord(unmapped) };
}

/** Render the MAST category table (markdown), with an optional trend column
 *  against the PRIOR cycle's `byCategory` (the retro marker persists it, W1-T89). */
export function mastDistributionTable(dist: MastCategoryDistribution, priorByCategory?: Record<string, number>): string {
  const categories = [...new Set([...Object.keys(dist.byCategory), ...Object.keys(priorByCategory ?? {})])].sort();
  const rows = categories.map((c) => {
    const cur = dist.byCategory[c] ?? 0;
    if (!priorByCategory) return `| ${c} | ${cur} |`;
    const before = priorByCategory[c] ?? 0;
    const delta = cur - before;
    const trend = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "±0";
    return `| ${c} | ${cur} | ${trend} |`;
  });
  const unmappedLines = Object.entries(dist.unmapped).map(([k, n]) => `- ${k}: ${n}`);
  return [
    priorByCategory ? "| category | count | trend vs prior cycle |" : "| category | count |",
    priorByCategory ? "|---|---|---|" : "|---|---|",
    ...(rows.length ? rows : ["| (no coded failures this cycle) | 0 |" + (priorByCategory ? " |" : "")]),
    "",
    unmappedLines.length
      ? "Unmapped verdict classes (named, never guessed):"
      : "Unmapped verdict classes: (none)",
    ...unmappedLines,
  ].join("\n");
}

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
export interface GuardReasonFallbackRow {
  verdict: string;
  pattern: RegExp;
  guard: string;
  check: string;
}

export const GUARD_REASON_FALLBACK_ROWS: readonly GuardReasonFallbackRow[] = [
  {
    verdict: "blocked_isolation",
    pattern: /isolation_preflight_failed/i,
    guard: "isolation",
    check: "inherited-functions",
  },
  {
    verdict: "blocked_containment",
    pattern: /containment (?:preflight|UNPROVEN)/i,
    guard: "containment",
    check: "outside-cwd-denial",
  },
];

/**
 * Resolve a run's guard/check — the structured fields off its own verdict
 * line when present (every guard-block written after W1-T91 lands), else the
 * {@link GUARD_REASON_FALLBACK_ROWS} match against its prose `reason` (every
 * guard-block written before). Returns undefined when NEITHER source
 * resolves it (the run isn't a guard-block at all, or predates even the
 * prose shape the fallback table expects) — the caller decides how to
 * surface that rather than guessing a guard/check that was never observed.
 */
export function resolveGuardCheck(r: Pick<RunSummary, "verdict" | "guard" | "check" | "reason">): { guard: string; check: string } | undefined {
  if (r.guard && r.check) return { guard: r.guard, check: r.check };
  const row = GUARD_REASON_FALLBACK_ROWS.find((f) => f.verdict === r.verdict && r.reason && f.pattern.test(r.reason));
  return row ? { guard: row.guard, check: row.check } : undefined;
}

/** One guard-fired block, classified INFRASTRUCTURE (never a task defect). */
export interface InfrastructureEvent {
  runId: string;
  taskId: string;
  verdict: string;
  guard: string;
  check: string;
  /** The preflight's observed state (three-state epistemology, never a
   *  boolean) — carried through when the run logged it structurally; absent
   *  on a prose-only historical line the fallback table coded by pattern. */
  observed?: string;
}

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
export function infrastructureEvents(runs: RunSummary[], mapping: MastMapping): InfrastructureEvent[] {
  const out: InfrastructureEvent[] = [];
  for (const r of runs) {
    if (CREDITED_VERDICTS.has(r.verdict)) continue;
    const row = mastRowFor(mapping, r);
    if (row?.category !== "infrastructure") continue;
    const gc = resolveGuardCheck(r) ?? { guard: "unknown", check: "unknown" };
    out.push({
      runId: r.runId,
      taskId: r.taskId,
      verdict: r.verdict,
      guard: gc.guard,
      check: gc.check,
      ...(r.observed !== undefined ? { observed: r.observed } : {}),
    });
  }
  out.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return out;
}

/** Recurrence of ONE (guard, check) pair across runs — "the same check firing
 *  across N runs on one host IS a host signal" (design note ii): a repeated
 *  guard/check is worth trending even though NONE of its runs count as a
 *  task defect. */
export interface InfrastructureRecurrence {
  guard: string;
  check: string;
  count: number;
  taskIds: string[];
  runIds: string[];
}

/** Group {@link infrastructureEvents} by (guard, check), deterministic order —
 *  the recurrence trend `renderInfrastructure` names in its report. */
export function infrastructureRecurrence(events: InfrastructureEvent[]): InfrastructureRecurrence[] {
  const byKey = new Map<string, InfrastructureEvent[]>();
  for (const e of events) {
    const key = `${e.guard} ${e.check}`;
    const arr = byKey.get(key) ?? [];
    arr.push(e);
    byKey.set(key, arr);
  }
  const out: InfrastructureRecurrence[] = [...byKey.entries()].map(([key, es]) => {
    const [guard, check] = key.split(" ");
    return {
      guard,
      check,
      count: es.length,
      taskIds: [...new Set(es.map((e) => e.taskId))].sort(),
      runIds: es.map((e) => e.runId).sort(),
    };
  });
  out.sort((a, b) => (a.guard + a.check < b.guard + b.check ? -1 : a.guard + a.check > b.guard + b.check ? 1 : 0));
  return out;
}

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
export function taskDefectCounts(runs: RunSummary[], mapping: MastMapping): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of runs) {
    if (CREDITED_VERDICTS.has(r.verdict)) continue;
    const row = mastRowFor(mapping, r);
    if (row?.category === "infrastructure") continue; // guard-fired, not a task defect
    out[r.taskId] = (out[r.taskId] ?? 0) + 1;
  }
  return sortedCountRecord(out);
}

/** Render the infrastructure section (markdown) — printed by `--dry-run` and
 *  fed to the Architect, mirroring {@link mastDistributionTable}'s shape. */
export function renderInfrastructure(events: InfrastructureEvent[], recurrence: InfrastructureRecurrence[]): string {
  if (events.length === 0) {
    return "## Infrastructure events (guard-fired blocks — never a task defect)\n\nNone this cycle.";
  }
  const recurLines = recurrence
    .filter((r) => r.count >= 2)
    .map((r) => `- ${r.guard}/${r.check}: ${r.count}x across ${r.taskIds.join(", ")} — a HOST signal, not a task signal`);
  return [
    "## Infrastructure events (guard-fired blocks — never a task defect)",
    "",
    `${events.length} guard-fired block(s) this cycle, excluded from every task's defect count:`,
    ...events.map((e) => `- ${e.taskId} (${e.runId}): ${e.guard}/${e.check}${e.observed ? ` — observed: ${e.observed}` : ""}`),
    "",
    recurLines.length ? "### Recurrence trend (same check firing repeatedly on one host)" : "### Recurrence trend: none (each check fired once)",
    ...recurLines,
  ].join("\n");
}

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

/** The ledger step this task registers for `mutation-ratchet`'s PR-gate verdict, going forward —
 *  see the module comment above for why nothing durable recorded this before now. One line per
 *  REAL Stryker run (a diff-scoped skip never calls {@link mutationGateVerdictLine} — there is no
 *  report to summarize). */
export const MUTATION_GATE_VERDICT_STEP = "mutation.ratchet_verdict";

/** The per-run fields {@link mutationGateVerdictLine} carries — the Stryker totals
 *  `scripts/mutation-ratchet.mjs`'s own `parseMutationTotals`/`tallyMutants` already compute
 *  in-process, plus the binary conclusion clause (ii) says must never be stood in for by the
 *  totals alone. */
export interface MutationGateVerdictInput {
  /** Identifies this CI run (e.g. the head sha or GitHub Actions run id) — the gate has no
   *  Remudero `run_id` of its own; it is a required check on every PR, not an `rmd`-dispatched
   *  run. */
  runId: string;
  taskId?: string;
  prUrl?: string;
  /** Whether `scripts/mutation-ratchet.mjs`'s ratchet comparison passed or failed THIS run —
   *  clause (ii)'s decision variable; never let `killed`/`survived` stand in for this. */
  conclusion: "success" | "failure";
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
}

/** Build (never write) the ledger line for one mutation-ratchet verdict — pure, same
 *  builder/writer split as {@link mineFollowups}/{@link recordFollowupHarvest} below. */
export function mutationGateVerdictLine(input: MutationGateVerdictInput): LedgerLine {
  return {
    run_id: input.runId,
    task_id: input.taskId ?? "mutation-ratchet",
    step: MUTATION_GATE_VERDICT_STEP,
    ...(input.prUrl ? { pr_url: input.prUrl } : {}),
    conclusion: input.conclusion,
    killed: input.killed,
    survived: input.survived,
    timeout: input.timeout,
    no_coverage: input.noCoverage,
  };
}

/** Dependencies for {@link recordMutationGateVerdict} — same injectable-writer shape as
 *  {@link FollowupHarvestDeps} (a test spies on `writeLedger` instead of touching disk). */
export interface MutationGateVerdictDeps {
  ledgerPath: string;
  writeLedger?: typeof appendLedger;
}

/** Append one {@link mutationGateVerdictLine}. UNWIRED in this change (see the module comment
 *  above) — no production call site invokes this yet, because that call site lives inside
 *  `scripts/mutation-ratchet.mjs`/`ci.yml`, both out of this task's scope. Shipped now so the
 *  step's shape and its rotation-survival land in the SAME change, never split across two. */
export function recordMutationGateVerdict(input: MutationGateVerdictInput, deps: MutationGateVerdictDeps): void {
  const writeLedger = deps.writeLedger ?? appendLedger;
  writeLedger(deps.ledgerPath, mutationGateVerdictLine(input));
}

/** One PR on which `mutation-ratchet` concluded FAILURE — clause (ii)'s escape count, named. */
export interface MutationGateEscape {
  runId: string;
  prUrl?: string;
}

/**
 * The rung D-10 asks for, folded over `MUTATION_GATE_VERDICT_STEP` lines. `positiveControl` is
 * design clause (iii)'s P48 guard: `false` means zero verdict records were found at all — an
 * UNMEASURED history, never to be rendered or read as "zero escapes" — versus `true` with
 * `escapeCount: 0`, a genuine zero-escapes-over-N-runs result. The two must never be confused;
 * see {@link renderMutationGateLifetime} for how each renders.
 */
export interface MutationGateLifetimeReport {
  positiveControl: boolean;
  runCount: number;
  killed: number;
  survived: number;
  escapeCount: number;
  escapes: MutationGateEscape[];
}

/**
 * READ ONLY — clause (i): never runs Stryker, never touches disk; folds whatever
 * `MUTATION_GATE_VERDICT_STEP` lines the ledger already carries. Called over the FULL `records`
 * (never marker-scoped), the same "a lifetime figure must survive past the marker window" choice
 * {@link mineFollowups} already makes for follow-ups — a marker-scoped read would silently
 * truncate "lifetime" into "since last retro", the opposite of what D-10 asked for.
 */
export function mutationGateLifetime(records: LedgerRecord[]): MutationGateLifetimeReport {
  const verdicts = records.filter((r) => r.step === MUTATION_GATE_VERDICT_STEP);
  if (verdicts.length === 0) {
    return { positiveControl: false, runCount: 0, killed: 0, survived: 0, escapeCount: 0, escapes: [] };
  }
  let killed = 0;
  let survived = 0;
  const escapes: MutationGateEscape[] = [];
  for (const r of verdicts) {
    killed += typeof r.killed === "number" ? r.killed : 0;
    survived += typeof r.survived === "number" ? r.survived : 0;
    if (r.conclusion === "failure") {
      escapes.push({
        runId: String(r.run_id ?? "?"),
        ...(typeof r.pr_url === "string" ? { prUrl: r.pr_url } : {}),
      });
    }
  }
  return { positiveControl: true, runCount: verdicts.length, killed, survived, escapeCount: escapes.length, escapes };
}

/** Render the mutation-gate-lifetime section (markdown) — printed by `--dry-run` and fed to the
 *  Architect; THE section D-10 has been waiting seven cycles for. */
export function renderMutationGateLifetime(r: MutationGateLifetimeReport): string {
  if (!r.positiveControl) {
    return [
      "## Mutation gate lifetime (D-10, W1-T393) — NO POSITIVE CONTROL: 0 verdicts recorded",
      "",
      "This is NOT \"zero escapes\" — it is an unmeasured history (P48: no naked zero). No " +
        `\`${MUTATION_GATE_VERDICT_STEP}\` ledger line has ever been recorded — this rung starts ` +
        "now, N=0, a stated limitation, never an empty result. The CI-side emission call site " +
        "(inside `scripts/mutation-ratchet.mjs`/`ci.yml`, after a real `npx stryker run`) is a " +
        "follow-up, not yet wired (out of this task's scope).",
    ].join("\n");
  }
  const escapeLines = r.escapes.length
    ? r.escapes.map((e) => `- ${e.runId}${e.prUrl ? ` → ${e.prUrl}` : ""}`)
    : ["- (none)"];
  return [
    `## Mutation gate lifetime (D-10, W1-T393): ${r.runCount} run(s) recorded`,
    "",
    `Has \`mutation-ratchet\` EVER concluded FAILURE on a PR: ${r.escapeCount > 0 ? "YES" : "NO"} (${r.escapeCount} escape(s))`,
    `Killed ${r.killed} / survived ${r.survived} (supporting totals — never a stand-in for the escape count above)`,
    "",
    "Escapes:",
    ...escapeLines,
  ].join("\n");
}

// ── §5A/§9 replay pass-rate (W1-T165) — the missing Self-Harness leg ────────
//
// READ ONLY, like the mutation-gate rung above: never runs a golden, never touches sandbox;
// folds whatever {@link REPLAY_RESULT_STEP} lines replay.ts's `recordReplayResults` already
// wrote. Scoped to THIS CYCLE (`sinceTs`), not lifetime — the task's own rewritten proof asks
// for "the replay pass-rate ... for the cycle", the same per-cycle framing `mast`/`verdicts`
// already use, deliberately unlike `mutationGateLifetime`'s all-time figure.

/** `n passed / n goldens` for the cycle, folded over {@link REPLAY_RESULT_STEP} ledger lines.
 *  `ranThisCycle: false` (P48: no naked zero) means NO replay line was recorded in this
 *  window at all — an unmeasured cycle, never to be read as "0% pass rate". */
export interface ReplayCalibration {
  ranThisCycle: boolean;
  total: number;
  passed: number;
  rate: number;
}

/**
 * Fold `REPLAY_RESULT_STEP` lines within `sinceTs` (the cycle window, `undefined` ⇒ all-time —
 * the first retro) into the cycle's replay pass-rate. Ignores every other ledger step, and
 * tolerates a `passed` field of any non-boolean shape (a hand-built fixture, a torn line) by
 * simply not counting it, same "never throw on an unexpected shape" discipline every other
 * reducer in this file already keeps.
 */
export function replayPassRateForCycle(records: LedgerRecord[], sinceTs?: string): ReplayCalibration {
  const lines = records.filter((r) => {
    if (r.step !== REPLAY_RESULT_STEP || typeof r.passed !== "boolean") return false;
    if (!sinceTs) return true;
    return typeof r.ts === "string" && r.ts > sinceTs;
  });
  const total = lines.length;
  const passed = lines.filter((r) => r.passed === true).length;
  return { ranThisCycle: total > 0, total, passed, rate: total ? passed / total : 0 };
}

/** Render the replay-pass-rate section (markdown) — printed by `--dry-run` and fed to the
 *  Architect, alongside the other calibration tables. */
export function renderReplayCalibration(r: ReplayCalibration): string {
  if (!r.ranThisCycle) {
    return [
      "## Replay pass-rate (golden-task regression suite, W1-T165) — the Self-Harness leg",
      "",
      "No replay run recorded this cycle — NOT a confirmed 0% (P48: no naked zero); the golden " +
        "suite simply did not run against a candidate harness this cycle.",
    ].join("\n");
  }
  return [
    "## Replay pass-rate (golden-task regression suite, W1-T165) — the Self-Harness leg",
    "",
    `Replay pass-rate this cycle: ${r.passed}/${r.total} goldens (${(r.rate * 100).toFixed(0)}%)`,
  ].join("\n");
}

export interface RetroGather {
  sinceTs?: string;
  totalRuns: number;
  byType: TypeCalibration[];
  /** W1-T167: per-class (docs / plan-lint / src) cost + merge-rate — the
   *  measurement half of the routing hypothesis (the table itself is in
   *  .remudero/mounts.yaml; this is what tells the retro if it's working). */
  byClass: ClassCalibration[];
  /** P34 clause (d), W1-T250: THIS WEEK's burn, bucketed by the model tier each
   *  run resolves to per `.remudero/mounts.yaml`'s routing rows — present ONLY
   *  when `buildGather` was given a `mounts` table (omitted degrades this
   *  section out entirely, never a silent empty-array "confirmed zero"). */
  weeklyBurnByModelClass?: ModelClassWeeklyBurn[];
  verdicts: Record<string, number>;
  mergedSince: RunSummary[];
  /** The SHIPPED union (W1-T51) — ledger ∪ GitHub-derived, ownership-asserted, correction-aware. */
  shipped: ShippedRecord[];
  /** Every named discrepancy the union found (gate-side additions AND rejected foreign trailers). */
  discrepancies: string[];
  /** W1-T73: every MERGED run whose `review.posted` matched a degraded-success
   *  signal (a claimed PASS that used a weaker path than its criteria named). */
  degradedSuccess: DegradedSuccessFinding[];
  /** W1-T87/P13: the other half of the flywheel — merged-run shapes shared by
   *  >=2 runs, mined as procedural-learning candidates for the Architect to
   *  phrase and ratify (never auto-filed). */
  proceduralCandidates: ProceduralCandidate[];
  learningsNow: number;
  learningsAtMarker: number;
  /**
   * W1-T132: present ONLY when `opts.github.unavailable()` named a reason (a
   * throttle, an error, or any other confirmed outage) — never set for a
   * healthy gateway or for the ledger-only fallback (which carries no opinion
   * on GitHub's health at all). `renderGather` refuses to present `shipped`
   * as a complete/confirmed count while this is set.
   */
  githubUnavailable?: string;
  /** W1-T89/P18: this cycle's failure distribution BY MAST CATEGORY, mapped
   *  read-side off `opts.mastMapping` (defaults to an empty table, which
   *  reports every failure verdict unmapped — a valid, visible degrade, never
   *  a build failure). */
  mast: MastCategoryDistribution;
  /** The PRIOR cycle's `mast.byCategory`, when the retro marker carried one —
   *  present so `renderGather` can show a trend without re-reading the marker
   *  itself. Absent on the very first MAST-coded retro. */
  priorMastCategoryCounts?: Record<string, number>;
  /** W1-T91/P23: every guard-fired block this cycle, classified INFRASTRUCTURE
   *  (never a task defect) — mined off the SAME `opts.mastMapping` as `mast`
   *  above, over the same `scoped` window. */
  infrastructureEvents: InfrastructureEvent[];
  /** W1-T91/P23: `infrastructureEvents` grouped by (guard, check) — the
   *  recurrence trend that names a host signal ("the same check firing
   *  across N runs on one host"). */
  infrastructureRecurrence: InfrastructureRecurrence[];
  /** W1-T91/P23: per-task defect counts over `scoped`, EXCLUDING every
   *  guard-fired infrastructure event — the statistic guard-fired blocks must
   *  never pollute. */
  taskDefectCounts: Record<string, number>;
  /** W1-T105: unharvested worker-declared follow-ups (research | task | action),
   *  mined over the FULL ledger (never marker-scoped — a discovery from three
   *  retros ago is still worth surfacing) and deduped against `opts.openTitles`. */
  followups: FollowupHarvest;
  /** W1-T393/D-10: `mutation-ratchet`'s LIFETIME kill/survive/escape record, folded over the
   *  FULL ledger (never `scoped` — see {@link mutationGateLifetime}'s doc for why). */
  mutationGateLifetime: MutationGateLifetimeReport;
  /** W1-T165: the golden-task replay pass-rate FOR THIS CYCLE (`sinceTs`-scoped, unlike
   *  `mutationGateLifetime` above — see {@link replayPassRateForCycle}'s doc for why). */
  replay: ReplayCalibration;
  /** W1-T2239: the G-17 Architect-lane share of spend, evidence for the tier
   *  invariant's capability rationale — computed over the FULL `records` (never
   *  `scoped`), the SAME "a figure truncated to one retro cycle is not the
   *  figure asked for" reasoning {@link mutationGateLifetime} above already
   *  uses, because a stale-corpus HISTORICAL share is still what this asks for
   *  (see {@link ArchitectLaneShareReport.windowStartTs}/`windowEndTs`). */
  architectLaneShare: ArchitectLaneShareReport;
  /**
   * W1-T2642: the plan-coherence census (`planCoherenceRung`) — present ONLY when
   * `buildGather` was given `opts.planCoherence` (the monolith blob + shard listing; buildGather
   * never reads `plan/tasks.yaml` or `plan/tasks.d/*` itself, same discipline `openTitles`
   * above already documents for this exact directory). Omitted entirely when the caller hasn't
   * wired the read yet — never a silent `clean` render standing in for a scan that never ran.
   * THE LIVE CALL SITE (this field's only producer, `buildGather` below) is what answers the
   * fourteen-cycle "does plan/tasks.yaml and plan/tasks.d/*.yaml disagree" question by
   * measurement, every retro cycle `renderGather` runs, rather than leaving this rung a signal
   * only its own tests import.
   */
  planCoherence?: PlanCoherenceReport;
}

/**
 * Build the whole deterministic gather from raw inputs. Pure over its injected
 * `github` gateway (deps.github omitted ⇒ `shipped` degrades to the ledger-only
 * list, same as today's `mergedSince` — no GitHub union, no ownership assert,
 * no unverified annotation; see {@link ledgerOnlyShipped}).
 */
export function buildGather(opts: {
  ledgerNdjson: string;
  learningsMd: string;
  sinceTs?: string;
  learningsAtMarker?: number;
  /** GitHub gateway for the SHIPPED union (W1-T51/P9). Omit to fall back ledger-only. */
  github?: ShippedGithub;
  /** W1-T89/P18: the deterministic verdict -> MAST mapping (plan/mast-mapping.yaml,
   *  already loaded — buildGather itself never touches disk). Omit ⇒ an empty
   *  table, so every failure verdict reports unmapped rather than the gather
   *  refusing to build. */
  mastMapping?: MastMapping;
  /** The prior cycle's `RetroGather.mast.byCategory` (the retro marker persists
   *  it under `mast_category_counts`) — threaded through unchanged for the trend
   *  column; buildGather never reads the marker itself. */
  priorMastCategoryCounts?: Record<string, number>;
  /** W1-T105 design (iv): existing open task titles / open proposal text, for the
   *  follow-up harvest's dedup — buildGather never reads plan/tasks.yaml or
   *  MASTER-PLAN.md itself. Omit ⇒ every follow-up mints (no dedup source). */
  openTitles?: string[];
  /** P34 clause (d), W1-T250: the ALREADY-LOADED `.remudero/mounts.yaml` table
   *  (buildGather never reads it from disk — same discipline as `mastMapping`
   *  above). Omit ⇒ `weeklyBurnByModelClass` is omitted entirely, never a
   *  silently-empty array. */
  mounts?: Mounts;
  /** Epoch ms defining "this week" for {@link aggregateWeeklyBurnByModelClass}
   *  ({@link utcWeekWindowMs}) — injected so buildGather stays a pure function
   *  of its inputs (no internal wall-clock read). Ignored when `mounts` is
   *  omitted. */
  now?: number;
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
  followupLedgerNdjson?: string;
  /**
   * W1-T2642: the plan-coherence census's raw inputs — the monolith blob plus a listing of
   * every `plan/tasks.d/*.yaml` shard (or the stated reason the directory could not be
   * listed). buildGather stays FS-free (same discipline `openTitles`/`mastMapping` above
   * already document): the caller (`retroCommand`, run-task.ts) reads `plan/tasks.yaml` and
   * `plan/tasks.d/` and hands the bytes in here. Omit ⇒ `RetroGather.planCoherence` is
   * omitted entirely, never a silent clean/zero render for a census that never ran — see
   * {@link planCoherenceRung}'s own doc for the `unexamined`/`clean`/`findings` states this
   * produces once wired.
   */
  planCoherence?: { monolith: { path: string; text: string }; shards: PlanCoherenceShardListing };
}): RetroGather {
  const records = parseLedger(opts.ledgerNdjson);
  const followupRecords = opts.followupLedgerNdjson !== undefined ? parseLedger(opts.followupLedgerNdjson) : records;
  const runs = gatherRuns(records);
  const scoped = opts.sinceTs ? runs.filter((r) => r.startTs > opts.sinceTs!) : runs;
  const merged = mergedSince(runs, opts.sinceTs);
  const { shipped, discrepancies } = opts.github
    ? shippedSince(runs, opts.sinceTs, opts.github)
    : { shipped: ledgerOnlyShipped(merged), discrepancies: [] as string[] };
  // W1-T132 (design ii): checked ONCE, after the union runs (so a healthy union
  // still gets full credit) — a reason here means the read layer itself is not
  // trustworthy, regardless of what shippedSince managed to resolve anyway.
  const githubUnavailable = opts.github?.unavailable?.();
  // W1-T91/P23: computed once, shared by the events list and its recurrence
  // trend below — never two independently-scoped reads of the same mapping.
  const mapping = opts.mastMapping ?? { rows: [] };
  const infraEvents = infrastructureEvents(scoped, mapping);
  return {
    sinceTs: opts.sinceTs,
    totalRuns: scoped.length,
    byType: aggregateByType(scoped),
    // W1-T930: `shipped` (the ledger∪GitHub-trailer union computed above,
    // degrading gracefully to ledger-only when no `github` gateway is wired)
    // is ALWAYS passed — it is the more-accurate-or-equal merge count, so
    // the per-class per-merge figures never divide by the ledger-verdict
    // count MASTER-PLAN documents as undercounting real ships by more than half.
    byClass: aggregateByClass(scoped, shipped),
    // P34 clause (d), W1-T250: computed over the FULL `runs` (never `scoped`) —
    // "this week" is an absolute calendar window, not marker-relative, so a
    // fresh `sinceTs` must not truncate it out from under a week already in
    // progress. Omitted entirely (never a silently-empty array) when the
    // caller supplied no `mounts` table.
    ...(opts.mounts ? { weeklyBurnByModelClass: aggregateWeeklyBurnByModelClass(runs, opts.mounts, opts.now ?? Date.now()) } : {}),
    verdicts: verdictDistribution(scoped),
    mergedSince: merged,
    shipped,
    discrepancies,
    // W1-T73: mined over the SAME scoped-merged set the marker window already
    // bounds, so a degraded-success finding never re-surfaces for a run the
    // marker has already moved past (matches mergedSince's own scoping).
    degradedSuccess: mineDegradedSuccess(merged, records),
    // W1-T87/P13: same marker-scoped window as degradedSuccess above — a
    // shape never re-surfaces for a run the marker has already moved past.
    proceduralCandidates: mineProceduralCandidates(merged, records),
    learningsNow: learningsCount(opts.learningsMd),
    learningsAtMarker: opts.learningsAtMarker ?? 0,
    ...(githubUnavailable ? { githubUnavailable } : {}),
    // W1-T89/P18: SAME `scoped` window as verdicts above (the whole cycle's
    // runs, not just the merged subset) — a failure distribution over anything
    // narrower would miss runs mergedSince already excludes by definition.
    mast: mastCategoryDistribution(scoped, mapping),
    ...(opts.priorMastCategoryCounts ? { priorMastCategoryCounts: opts.priorMastCategoryCounts } : {}),
    // W1-T91/P23: SAME `scoped` window + mapping as `mast` above — one
    // classifier, read twice (category distribution, then the
    // infrastructure/defect split), never two independently-scoped reads.
    infrastructureEvents: infraEvents,
    infrastructureRecurrence: infrastructureRecurrence(infraEvents),
    taskDefectCounts: taskDefectCounts(scoped, mapping),
    // W1-T105: the FULL ledger, never `scoped` — a followup must survive past the
    // marker window (idempotency comes from the followup.harvested/deduped marks
    // mineFollowups reads back, not from marker-scoping). W1-T1013: "full" now means
    // `followupRecords` — the archive∪live union, not just `records` (this string's
    // live-only parse) — because rotation truncates the live file long before the
    // marker window would, which un-scoping from the marker alone cannot fix.
    followups: mineFollowups(followupRecords, opts.openTitles ?? []),
    // W1-T393/D-10: the FULL `records`, never `scoped` — same "must survive past the marker
    // window" reasoning as `followups` immediately above, because a LIFETIME figure truncated to
    // one retro cycle is not a lifetime figure.
    mutationGateLifetime: mutationGateLifetime(records),
    // W1-T165: `opts.sinceTs`-scoped (the cycle), the opposite choice from `mutationGateLifetime`
    // immediately above — see `replayPassRateForCycle`'s doc for why a per-cycle figure is what
    // the task's own proof asks for.
    replay: replayPassRateForCycle(records, opts.sinceTs),
    // W1-T2239: FULL `records`, same reasoning as `mutationGateLifetime` above — a
    // measurement of the fleet's own allocation must not truncate to the marker window.
    architectLaneShare: architectLaneShare(records),
    // W1-T2642: THE LIVE CALL SITE. Runs every cycle `buildGather` runs (retroCommand's own
    // unconditional call, run-task.ts) whenever the caller supplied `opts.planCoherence` —
    // omitted entirely otherwise, never a silent clean/zero for a census that did not run.
    ...(opts.planCoherence
      ? { planCoherence: planCoherenceRung(opts.planCoherence.monolith, opts.planCoherence.shards) }
      : {}),
  };
}

/** Render the calibration table (markdown) — printed by --dry-run and fed to the Architect. */
export function calibrationTable(byType: TypeCalibration[]): string {
  const rows = byType.map(
    (t) => `| ${t.type} | ${t.runs} | ${t.merged} | $${t.avgCostUsd.toFixed(3)} | ${t.avgTurns} | $${t.totalCostUsd.toFixed(3)} |`,
  );
  return [
    "| task_type | runs | merged | avg $ | avg turns | total $ |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/**
 * W1-T930: render one per-merge cell — `turnsPerMerge`/`outputTokensPerMerge`
 * — with the coverage discipline the design mandates ("reuse verbatim" the
 * MASTER-PLAN `37 ⚠ 29% coverage — DO NOT USE` cell): a thin-coverage figure
 * is STILL PRINTED, flagged, never laundered or blanked; only the genuine
 * zero-merge divide-by-zero case (`value === null`) renders as an explicit
 * non-numeric marker — never a bare `0`, never `NaN`.
 */
function perMergeCell(value: number | null, turnCoverage: number): string {
  if (value === null) return `n/a (0 merges)`;
  if (turnCoverage < MIN_TURN_COVERAGE_FOR_PER_MERGE) {
    return `${value} ⚠ ${(turnCoverage * 100).toFixed(0)}% coverage — DO NOT USE`;
  }
  return `${value}`;
}

/** Render the per-class calibration table (markdown, W1-T167) — the routing
 *  table's effectiveness, measured. W1-T930 appends the per-merge half
 *  (output tokens, turns/merge, output tokens/merge, and the named merge
 *  source/denominator they divide by) AFTER the existing per-run columns —
 *  every column already here is unchanged, in the same order, same format. */
export function classCalibrationTable(byClass: ClassCalibration[]): string {
  const rows = byClass.map(
    (c) =>
      `| ${c.taskClass} | ${c.runs} | ${c.merged} | ${(c.mergeRate * 100).toFixed(0)}% | $${c.avgCostUsd.toFixed(3)} | ${c.avgTurns} | $${c.totalCostUsd.toFixed(3)} | ` +
      `${c.totalOutputTokens} | ${c.mergeSource} (n=${c.mergedForDenominator}) | ` +
      `${perMergeCell(c.turnsPerMerge, c.turnCoverage)} | ` +
      `${perMergeCell(c.outputTokensPerMerge, c.turnCoverage)} |`,
  );
  return [
    "| task_class | runs | merged | merge rate | avg $ | avg turns | total $ | output tokens | merge source | turns/merge | output tokens/merge |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** Render the per-model-tier weekly-burn-share table (markdown, P34 clause (d), W1-T250) —
 *  "is the routing table actually keeping cheap work off the capable model's weekly cap". */
export function modelClassWeeklyBurnTable(byModel: ModelClassWeeklyBurn[]): string {
  const rows = byModel.map(
    (m) => `| ${m.model} | ${m.runs} | ${m.turnsThisWeek} | ${(m.shareOfWeeklyBurn * 100).toFixed(1)}% | $${m.costUsdThisWeek.toFixed(3)} |`,
  );
  return [
    "| model | runs | turns this week | share of weekly burn | $ this week (context only) |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** Render the full gather as a human/Architect-readable report. */
export function renderGather(g: RetroGather): string {
  // W1-T132 (design ii): a throttled/errored/absent gateway must SAY SO BY NAME
  // and must NEVER let the SHIPPED section read as a confirmed zero — an empty
  // list gets an explicit INDETERMINATE line instead of the ordinary "(none)".
  const shippedLines = g.shipped.length
    ? g.shipped.map(
        (s) =>
          `- ${s.taskId} → ${s.prUrl} · $${s.costUsd.toFixed(3)} · ${s.numTurns} turns` +
          (s.annotation ? ` · (${s.annotation})` : ""),
      )
    : g.githubUnavailable
      ? [`- INDETERMINATE — GitHub gateway unavailable (${g.githubUnavailable}); this is NOT a confirmed zero, never read it as "nothing shipped"`]
      : ["- (none)"];
  return [
    `# Retro gather${g.sinceTs ? ` (since ${g.sinceTs})` : " (all-time — first retro)"}`,
    "",
    ...(g.githubUnavailable
      ? [
          `## ⚠ GITHUB GATEWAY UNAVAILABLE — ${g.githubUnavailable}`,
          "The SHIPPED count below is INCOMPLETE — degrading LOUDLY (W1-T132) rather than silently " +
            "presenting a ledger-only read as a complete one. Gate-side merges may exist that this " +
            "gather could not observe; do not treat this run's SHIPPED list as authoritative.",
          "",
        ]
      : []),
    `Runs in scope: ${g.totalRuns}`,
    `Verdicts: ${JSON.stringify(g.verdicts)}`,
    `LEARNINGS entries: ${g.learningsNow} now (${g.learningsNow - g.learningsAtMarker} added since marker)`,
    "",
    "## Calibration (BY TASK TYPE) — the numbers mounts.yaml (W1-T5) needs",
    calibrationTable(g.byType),
    "",
    "## Calibration (BY TASK CLASS, W1-T167) — is the docs/plan-lint routing discount paying off",
    classCalibrationTable(g.byClass),
    "",
    renderArchitectLaneShare(g.architectLaneShare),
    "",
    renderReplayCalibration(g.replay),
    "",
    ...(g.weeklyBurnByModelClass
      ? [
          "## Weekly burn BY MODEL CLASS (P34 clause (d), W1-T250) — objective: weekly-limit burn per model class, never imputed dollars",
          modelClassWeeklyBurnTable(g.weeklyBurnByModelClass),
          "",
        ]
      : []),
    "## Merged since marker (keyed by Remudero-Task)",
    ...(g.mergedSince.length
      ? g.mergedSince.map((r) => `- ${r.taskId} → ${r.prUrl ?? "(no pr)"} · $${r.costUsd.toFixed(3)} · ${r.numTurns} turns`)
      : ["- (none)"]),
    "",
    "## SHIPPED since marker (W1-T51 — ledger ∪ GitHub-derived trailered merges, ownership-asserted)",
    ...shippedLines,
    ...(g.discrepancies.length
      ? ["", "## Discrepancies (ledger vs GitHub — every gate-side addition and rejected foreign trailer)", ...g.discrepancies.map((d) => `- ${d}`)]
      : []),
    "",
    "## Failure distribution BY MAST CATEGORY (W1-T89, ratifies P18 — plan/mast-mapping.yaml)",
    mastDistributionTable(g.mast, g.priorMastCategoryCounts),
    "",
    // W1-T91/P23: guard-fired blocks, already excluded from `mast`'s agent-
    // failure categories above (they land in `infrastructure` there too) —
    // this section is the dedicated per-guard/check view PLUS the per-task
    // defect exclusion the retro's own defect stats must honor.
    renderInfrastructure(g.infrastructureEvents, g.infrastructureRecurrence),
    "",
    renderMutationGateLifetime(g.mutationGateLifetime),
    "",
    renderDegradedSuccess(g.degradedSuccess),
    "",
    renderProceduralCandidates(g.proceduralCandidates),
    "",
    renderFollowupCandidates(g.followups),
    // W1-T2642: present only when `buildGather` was handed `opts.planCoherence` — omitted
    // rather than rendering a stale/absent census as a silent clean pass (see that field's
    // own doc, `RetroGather.planCoherence`, for the "never a bare zero" discipline).
    ...(g.planCoherence ? ["", renderPlanCoherence(g.planCoherence)] : []),
  ].join("\n");
}

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
const CLOSED_TASK_STATUSES = new Set(["merged", "done"]);

/** See {@link CLOSED_TASK_STATUSES}'s doc — the pure-unit-test-only default {@link planHealthSweep}
 *  falls back to when no derived `isMerged` is supplied. */
function yamlMergedFallback(task: Task): boolean {
  return CLOSED_TASK_STATUSES.has(task.status);
}

/** One OPEN task the sweep found in violation, with its BLOCKING violations only
 *  (a WARN, e.g. budget-sanity, is visibility-only and never files a corrective task). */
export interface PlanHealthFlag {
  taskId: string;
  violations: LintViolation[];
}

/** A proposed corrective task, auto-filed per violating OPEN task — DATA for the
 *  Architect's plan-only PR to ratify, never written to plan/tasks.yaml directly by THIS function
 *  — its own scope, not a prohibition. W1-T2456: this cited "Standing rule 16", which is the
 *  mis-specified-task correction rule; §12 rule 27 permits automatic filing. */
export interface CorrectiveTaskProposal {
  /** The OPEN task this proposal corrects. */
  forTaskId: string;
  title: string;
  /** Always `retro#plan-health` — the sweep is the origin, satisfying Rule 17. */
  origin: string;
  violations: LintViolation[];
}

export interface PlanHealthReport {
  flags: PlanHealthFlag[];
  correctiveTasks: CorrectiveTaskProposal[];
}

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
export function planHealthSweep(
  tasks: Task[],
  optsFor: (task: Task) => LintOpts = () => ({}),
  isMerged: (task: Task) => boolean = yamlMergedFallback,
): PlanHealthReport {
  const flags: PlanHealthFlag[] = [];
  const correctiveTasks: CorrectiveTaskProposal[] = [];
  for (const task of tasks) {
    if (isMerged(task)) continue; // out of scope — already shipped (derived; see doc above)
    const { violations } = lintTask(task, optsFor(task));
    const blocking = violations.filter((v) => v.severity === "block");
    if (blocking.length === 0) continue; // clean, or WARN-only — nothing to file
    flags.push({ taskId: task.id, violations: blocking });
    correctiveTasks.push({
      forTaskId: task.id,
      title: `Plan-health: fix ${task.id} — ${blocking.map((v) => v.check).join(", ")}`,
      origin: "retro#plan-health",
      violations: blocking,
    });
  }
  return { flags, correctiveTasks };
}

/** Render the plan-health report (markdown) — printed by `--dry-run` and fed to the Architect. */
export function renderPlanHealth(report: PlanHealthReport): string {
  if (report.flags.length === 0) return "## Plan-health sweep\n\nNo violations across the open queue.";
  return [
    "## Plan-health sweep — OPEN queue re-graded against every standing rule",
    "",
    ...report.flags.map(
      (f) => `- ${f.taskId}: ${f.violations.map((v) => `[${v.check}] ${v.message}`).join("; ")}`,
    ),
    "",
    "### Corrective tasks proposed (for the Architect's plan-only PR)",
    ...report.correctiveTasks.map((c) => `- ${c.title} (origin: ${c.origin})`),
  ].join("\n");
}

// ── Mining overruns for a CLASS-level fix (W1-T20d, Standing rule 20/§5C) ──
//
// "If a CLASS of task overruns... propose a CLASS-level fix... NOT another
// per-task patch" (MASTER-PLAN §5C). W1-T6, W1-T9, W1-T12 were three SEPARATE
// per-task rescues for the SAME class (implement × medium) before the pattern
// was named — the reactive-diagnosis anti-pattern this sweep exists to kill.

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
export const OVERRUN_VERDICTS: ReadonlySet<string> = new Set([
  "blocked",
  "blocked_ci",
  "blocked_review",
  "blocked_budget",
  "blocked_inflight",
  "blocked_git_fetch",
  "blocked_illformed",
  "blocked_transient",
  "no_pr",
  "pr_attribution_failed",
  "failed",
]);

/** A run counts as an overrun for mining purposes: a listed verdict, OR a
 *  `failed` run whose subtype names the max-turns runaway class specifically. */
function isOverrunRun(r: RunSummary): boolean {
  return OVERRUN_VERDICTS.has(r.verdict);
}

/** The (task_type × risk) key — the SAME two axes mounts.yaml (§9) routes on —
 *  so a mined class maps directly onto a mount-table row, not an ad hoc bucket. */
function overrunClassKey(r: RunSummary): string {
  return `${r.type}:${r.risk ?? "unknown"}`;
}

/** ONE proposed class-level fix, covering every run in that (type, risk) class —
 *  never one proposal per task (the anti-pattern this mining exists to kill). */
export interface ClassOverrunProposal {
  taskType: string;
  risk: string;
  count: number;
  taskIds: string[];
  verdicts: string[];
  proposal: string;
}

/**
 * MINE the ledger's overrun/blocked verdicts for a task-CLASS pattern. Returns
 * ONE {@link ClassOverrunProposal} per (type, risk) class that meets
 * `opts.threshold` (default 2 — "repeated") overruns, never one per offending
 * task. Below threshold, a class is a single incident, not yet a pattern, and
 * is silently omitted (no proposal) rather than over-fitted to one data point.
 */
export function mineOverrunClasses(
  runs: RunSummary[],
  opts: { threshold?: number } = {},
): ClassOverrunProposal[] {
  const threshold = opts.threshold ?? 2;
  const byClass = new Map<string, RunSummary[]>();
  for (const r of runs) {
    if (!isOverrunRun(r)) continue;
    const key = overrunClassKey(r);
    const arr = byClass.get(key) ?? [];
    arr.push(r);
    byClass.set(key, arr);
  }
  const out: ClassOverrunProposal[] = [];
  for (const [key, rs] of byClass) {
    if (rs.length < threshold) continue; // one incident is not yet a pattern
    const [taskType, risk] = key.split(":");
    out.push({
      taskType,
      risk,
      count: rs.length,
      taskIds: [...new Set(rs.map((r) => r.taskId))].sort(),
      verdicts: [...new Set(rs.map((r) => r.subtype ?? r.verdict))].sort(),
      proposal:
        `${rs.length} overrun(s) across ${taskType}×${risk} (${[...new Set(rs.map((r) => r.taskId))].sort().join(", ")}) ` +
        `— propose ONE class-level fix (raise this class to risk:high / decompose at plan time per Rule 19, ` +
        `or adjust mounts.yaml's ${taskType}×${risk} turn budget), not ${rs.length} per-task patches`,
    });
  }
  out.sort((a, b) => (a.taskType + a.risk < b.taskType + b.risk ? -1 : a.taskType + a.risk > b.taskType + b.risk ? 1 : 0));
  return out;
}

/** Render the mined overrun proposals (markdown) — printed by `--dry-run` and fed to the Architect. */
export function renderOverrunProposals(proposals: ClassOverrunProposal[]): string {
  if (proposals.length === 0) return "## Overrun mining\n\nNo class-level pattern found (each class is below threshold).";
  return ["## Overrun mining — CLASS-level fixes proposed", "", ...proposals.map((p) => `- ${p.proposal}`)].join("\n");
}

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

/** The reduced `review.posted` facts one signal predicate judges against —
 *  the run's MOST RECENT posting (a run may re-post across fix strikes;
 *  only its latest posting reflects what actually merged). */
export interface ReviewPostedSummary {
  runId: string;
  taskId: string;
  /** Count of criteria whose `proof_exec` is `executed_pass`/`executed_fail`. */
  executed: number;
  /** Total criteria judged (the ledgered `proof_exec` array's length). */
  total: number;
  /** W1-T72's legibility flag — true when EVERY criterion fell back to the
   *  keyword floor while >=1 proof was WRITTEN in the house dialect. */
  floorDegraded: boolean;
  /** W1-T63/P10-a — the advisory reviewer spawn's terminal subtype, when logged
   *  (e.g. `error_max_turns`, `spawn_error`). Absent if never logged. */
  reviewerOutcome?: string;
}

/**
 * Reduce every `review.posted` ledger line to the LATEST posting per run_id —
 * a run may post more than once across fix strikes, and only its latest
 * posting reflects what actually merged. A run that never posted a review
 * (pre-W1-T65 history, or a synthetic fixture) has no entry — nothing to mine.
 */
export function latestReviewPostedByRun(records: LedgerRecord[]): Map<string, ReviewPostedSummary> {
  const out = new Map<string, ReviewPostedSummary>();
  for (const r of records) {
    if (r.step !== "review.posted" || !r.run_id) continue;
    const proofExec = Array.isArray(r.proof_exec) ? (r.proof_exec as unknown[]) : [];
    const executed = proofExec.filter((p) => p === "executed_pass" || p === "executed_fail").length;
    out.set(String(r.run_id), {
      runId: String(r.run_id),
      taskId: String(r.task_id ?? ""),
      executed,
      total: proofExec.length,
      floorDegraded: r.floor_degraded === true,
      ...(typeof r.reviewer_outcome === "string" ? { reviewerOutcome: r.reviewer_outcome } : {}),
    });
  }
  return out;
}

/**
 * One weaker-path-than-claimed signal — DATA, not a hardcoded branch (same
 * discipline as {@link OVERRUN_VERDICTS}): the next degraded-success class
 * (e.g. a future capped-but-merged shape) is a ROW added here, never new
 * executor code.
 */
export interface DegradedSuccessSignal {
  /** Stable identifier, named on every finding this signal produces. */
  key: string;
  matches: (r: ReviewPostedSummary) => boolean;
  /** Human-readable explanation, folded into the finding's rendered line. */
  describe: (r: ReviewPostedSummary) => string;
}

/** The shipped signal table. Row 1 is the canonical fixture (RETRO-1784213948025 /
 *  W1-T65): a merged run whose review posted `proof_exec` entirely unexecuted
 *  while >=1 proof was written to be runnable (house dialect). Row 2 is the
 *  W1-T73 design's named second class (a merged run whose advisory reviewer
 *  never completed a real pass) — proof the set generalizes as data. */
export const DEGRADED_SUCCESS_SIGNALS: ReadonlyArray<DegradedSuccessSignal> = [
  {
    key: "zero_executed_dialect",
    matches: (r) => r.total > 0 && r.executed === 0 && r.floorDegraded,
    describe: (r) =>
      `proof_exec ${r.executed}/${r.total} executed, floor_degraded — >=1 dialect-prefixed proof was ` +
      `present yet nothing was OBSERVED on the PR head`,
  },
  {
    key: "reviewer_error_max_turns",
    matches: (r) => r.reviewerOutcome === "error_max_turns",
    describe: () => "reviewer_outcome=error_max_turns — the advisory reviewer never completed a real pass",
  },
];

/** One DEGRADED-SUCCESS finding — a MERGED run whose review.posted matched a signal. */
export interface DegradedSuccessFinding {
  runId: string;
  taskId: string;
  signal: string;
  description: string;
}

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
export function mineDegradedSuccess(
  runs: RunSummary[],
  records: LedgerRecord[],
  signals: ReadonlyArray<DegradedSuccessSignal> = DEGRADED_SUCCESS_SIGNALS,
): DegradedSuccessFinding[] {
  const posted = latestReviewPostedByRun(records);
  const findings: DegradedSuccessFinding[] = [];
  for (const r of runs) {
    if (r.verdict !== "merged") continue;
    const summary = posted.get(r.runId);
    if (!summary) continue; // no review.posted line for this run — nothing to mine
    for (const signal of signals) {
      if (signal.matches(summary)) {
        findings.push({ runId: r.runId, taskId: r.taskId, signal: signal.key, description: signal.describe(summary) });
      }
    }
  }
  findings.sort((a, b) => {
    const ka = a.taskId + a.signal;
    const kb = b.taskId + b.signal;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return findings;
}

/** Render the mined degraded-success findings (markdown) — printed by `--dry-run` and fed to the Architect. */
export function renderDegradedSuccess(findings: DegradedSuccessFinding[]): string {
  if (findings.length === 0) {
    return "## Degraded-success mining\n\nNo merged run posted a weaker-path-than-claimed signal.";
  }
  return [
    "## Degraded-success mining — a PASS that used a weaker path than its criteria named",
    "",
    ...findings.map((f) => `- ${f.taskId} (${f.runId}): [${f.signal}] ${f.description}`),
  ].join("\n");
}

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

/** The reduced facts one {@link ProceduralSuccessSignal} judges a MERGED run against. */
export interface ProceduralRunContext {
  runId: string;
  taskId: string;
  taskType: string;
  numTurns: number;
  /** Count of `fix.dispatch` ledger lines for this run — zero means it never needed a fix rung. */
  fixDispatchCount: number;
  /** This run's latest `review.posted` reduction, if any (see {@link latestReviewPostedByRun}). */
  review?: ReviewPostedSummary;
}

/**
 * One deterministic success shape — DATA, not a hardcoded branch (mirrors
 * {@link DegradedSuccessSignal}): the next reusable-procedure class is a ROW
 * added here, never new mining code.
 */
export interface ProceduralSuccessSignal {
  key: string;
  matches: (ctx: ProceduralRunContext) => boolean;
  describe: (ctx: ProceduralRunContext) => string;
}

/** The shipped signal table (W1-T87/P13): "single-strike merges" and "proof_exec executed_pass patterns" (design note), named exactly. */
export const PROCEDURAL_SUCCESS_SIGNALS: ReadonlyArray<ProceduralSuccessSignal> = [
  {
    key: "clean_single_strike",
    matches: (ctx) => ctx.fixDispatchCount === 0,
    describe: (ctx) => `merged with zero fix.dispatch lines — resolved on the first attempt (${ctx.numTurns} turns)`,
  },
  {
    key: "fully_executed_proof",
    matches: (ctx) =>
      ctx.review !== undefined && ctx.review.total > 0 && ctx.review.executed === ctx.review.total && !ctx.review.floorDegraded,
    describe: (ctx) =>
      `proof_exec ${ctx.review!.executed}/${ctx.review!.total} executed — every criterion OBSERVED, never keyword-floored`,
  },
];

/** Count of `fix.dispatch` ledger lines per `run_id` — zero means a run never needed a fix rung. */
export function fixDispatchCountByRun(records: LedgerRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    if (r.step !== "fix.dispatch" || !r.run_id) continue;
    const key = String(r.run_id);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** ONE mined procedural-success candidate — a reusable shape shared by >= `threshold` merged runs. */
export interface ProceduralCandidate {
  /** Always `"procedural"` — the tag a drafted learning carries once the Architect ratifies it. */
  kind: "procedural";
  /** Deterministic grouping key: `${taskType}:${signals.join("+")}`. */
  shapeKey: string;
  taskType: string;
  /** The matched signal keys this shape shares, sorted. */
  signals: string[];
  runIds: string[];
  taskIds: string[];
  supportingRuns: number;
}

/**
 * MINE merged runs for a procedure shape shared by >= `opts.threshold` runs
 * (default 2 — a single success is an anecdote, not yet a pattern). Only a
 * run matching >=1 {@link ProceduralSuccessSignal} is considered at all; a
 * run matching none has nothing to contribute. Pure over the already-reduced
 * run summaries plus the raw ledger records (needed only for the
 * `fix.dispatch` count and the `review.posted` reduction) — no LLM, no I/O;
 * calling it twice over the SAME fixture returns the SAME candidates.
 */
export function mineProceduralCandidates(
  runs: RunSummary[],
  records: LedgerRecord[],
  opts: { threshold?: number; signals?: ReadonlyArray<ProceduralSuccessSignal> } = {},
): ProceduralCandidate[] {
  const threshold = opts.threshold ?? 2;
  const signals = opts.signals ?? PROCEDURAL_SUCCESS_SIGNALS;
  const fixCounts = fixDispatchCountByRun(records);
  const reviewByRun = latestReviewPostedByRun(records);

  const byShape = new Map<string, RunSummary[]>();
  const shapeSignals = new Map<string, string[]>();
  for (const r of runs) {
    if (r.verdict !== "merged") continue;
    const ctx: ProceduralRunContext = {
      runId: r.runId,
      taskId: r.taskId,
      taskType: r.type,
      numTurns: r.numTurns,
      fixDispatchCount: fixCounts.get(r.runId) ?? 0,
      review: reviewByRun.get(r.runId),
    };
    const matched = signals
      .filter((s) => s.matches(ctx))
      .map((s) => s.key)
      .sort();
    if (matched.length === 0) continue; // nothing this run demonstrates — not a candidate
    const shapeKey = `${r.type}:${matched.join("+")}`;
    const arr = byShape.get(shapeKey) ?? [];
    arr.push(r);
    byShape.set(shapeKey, arr);
    shapeSignals.set(shapeKey, matched);
  }

  const out: ProceduralCandidate[] = [];
  for (const [shapeKey, rs] of byShape) {
    if (rs.length < threshold) continue; // one success is an anecdote, not a procedure
    const taskType = shapeKey.slice(0, shapeKey.indexOf(":"));
    out.push({
      kind: "procedural",
      shapeKey,
      taskType,
      signals: shapeSignals.get(shapeKey) ?? [],
      runIds: [...new Set(rs.map((r) => r.runId))].sort(),
      taskIds: [...new Set(rs.map((r) => r.taskId))].sort(),
      supportingRuns: rs.length,
    });
  }
  out.sort((a, b) => (a.shapeKey < b.shapeKey ? -1 : a.shapeKey > b.shapeKey ? 1 : 0));
  return out;
}

/** Render the mined procedural candidates (markdown) — printed by `--dry-run` and fed to the Architect, which drafts the actual learning. W1-T2456: this cited "Standing rule 15", which carries no such doctrine — see §12 rule 27. */
export function renderProceduralCandidates(candidates: ProceduralCandidate[]): string {
  if (candidates.length === 0) {
    return "## Procedural-success mining (P13)\n\nNo shape shared by >=2 merged runs yet.";
  }
  return [
    "## Procedural-success mining (P13) — reusable shapes proposed for a procedural learning",
    "",
    ...candidates.map((c) => `- ${c.taskType} × [${c.signals.join(", ")}] — ${c.supportingRuns} run(s): ${c.taskIds.join(", ")}`),
  ].join("\n");
}

// ── Follow-up harvest (W1-T105) ────────────────────────────────────────────
//
// The operator's requirement, verbatim: "ensure that if any implementations come
// back with follow-up research, actions, tasks, etc — they get added to the plan."
// A worker's REPORT may carry an OPTIONAL `## Follow-ups` section (§2 OUTPUT
// CONTRACT, parsed by `parseFollowups` in worker.ts); run-task.ts ledgers each one
// as a `report.followups` event, verbatim, with run/task/PR provenance. This
// module mines that event stream deterministically, and its OUTPUT is proposal candidates for
// the Architect's retro PR to cite rather than a filed task — this module's own scope.
// W1-T2456: the citation here read "rule 15 stays intact"; see §12 rule 27.

/** One followup entry off a `report.followups` ledger event, with its provenance
 *  and a stable {@link entryId} the harvest-mark ledger lines reference. */
export interface FollowupCandidate {
  entryId: string;
  type: "research" | "task" | "action";
  text: string;
  runId: string;
  taskId: string;
  /** Set ONLY when this entry lands in `deduped` via a NAMED refusal arm that owes the reader
   *  more than "matched an open title" — currently just {@link decorativeStatusFlipReason}
   *  (W1-T2638). Absent (never `undefined`-but-present) for a plain `followupMatchesTitle`
   *  match, so existing dedup call sites that never read this field see no shape change. */
  reason?: string;
  prUrl?: string;
}

/** Pure mining result: what to show the Architect (`candidates`), what was
 *  recognized as already covered (`deduped`), and the ledger lines the caller
 *  (retroCommand) must append on a REAL (non-dry-run) pass — never `mineFollowups`
 *  itself — so a `--dry-run` preview stays a pure read, same discipline as
 *  {@link buildGather} itself. */
export interface FollowupHarvest {
  candidates: FollowupCandidate[];
  deduped: FollowupCandidate[];
  harvestLines: LedgerLine[];
}

/** Significant words only (>=3 chars) — drops "a"/"is"/"to"/"so" noise that would
 *  otherwise inflate overlap between two otherwise-unrelated sentences. */
function significantWords(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));
}

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
function followupMatchesTitle(text: string, titleWords: Set<string>): boolean {
  const textWords = significantWords(text);
  if (textWords.size === 0) return false;
  let overlap = 0;
  for (const w of textWords) if (titleWords.has(w)) overlap++;
  return overlap / textWords.size >= 0.6;
}

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

/** TASK_STATUSES (plan.ts:15-26), mirrored rather than imported — this module stays a leaf over
 *  the ledger and gains no dependency on the plan loader for one closed-vocabulary check. */
const KNOWN_TASK_STATUSES = new Set([
  "queued",
  "recon",
  "prompted",
  "running",
  "review",
  "fixing",
  "diagnosing",
  "blocked",
  "merged",
  "done",
]);

/** plan.ts's own `MERGED_STATUSES` (plan.ts:51) — the two TASK_STATUSES members that mean
 *  "landed". A follow-up asking to hand-set a yaml `status:` field to either is exactly the
 *  shape W1-T367's rationale refutes. */
const MERGED_MEANING_STATUSES = new Set(["merged", "done"]);

/** Matches an entry naming the yaml `status:` field itself — anchored on the `status:` colon
 *  spelling every one of the four recurrences has used verbatim — and NOT `retirement:`, a bare
 *  mention of the word "status" with no field syntax, or prose about the derived projection.
 *  EXPORTED (unlike this module's other `_RE` validators) so test/retro.test.ts can drive both
 *  arms directly by identifier — negative-reachability-ratchet.test.ts's fixture-less `_RE`
 *  census (W1-T2317) counts a validator regex that no test names by `SYMBOL.test(...)`, and this
 *  one is new at src/lib/retro.ts's already-at-baseline population; the fixture is the correction,
 *  not a widened allowance. */
export const STATUS_FIELD_RE = /`?status:`?\s*field/i;

/**
 * The value a `STATUS_FIELD_RE`-matching entry's text asks to set the field TO, or `undefined`
 * when the text does not spell out an unambiguous single target — callers treat `undefined` as
 * "leave it alone" (see the scope-fence note above the section header: ambiguity always harvests).
 */
function statusFlipTarget(text: string): string | undefined {
  const fromTo = text.match(/field\s+from\s+[`'"]?[a-z0-9]+[`'"]?\s+to\s+[`'"]?([a-z0-9]+)[`'"]?/i);
  if (fromTo) return fromTo[1]!.toLowerCase();
  const bareTo = text.match(/status:`?\s*field[^.]*?\bto\s+[`'"]?([a-z0-9]+)[`'"]?/i);
  if (bareTo) return bareTo[1]!.toLowerCase();
  return undefined;
}

/**
 * `undefined` unless `text` is, in scope, a decorative yaml `status:` flip — see the section doc
 * above for the exact fence (never `blocked`, never the `retirement:` field, never an ambiguous
 * read). When in scope, returns the REASON to record: the refutation itself (dispatch eligibility
 * and dependency satisfaction are GitHub-derived, so the field is decorative) plus, for a value
 * outside the schema, the fail-close it causes — and names the sanctioned remedy for a task that
 * is GENUINELY uncredited, an operator correction rather than a yaml edit. The reason must teach,
 * per this task's own design, never just decline.
 */
function decorativeStatusFlipReason(text: string): string | undefined {
  if (!STATUS_FIELD_RE.test(text)) return undefined;
  const target = statusFlipTarget(text);
  if (!target || target === "blocked") return undefined;
  const outOfVocabulary = !KNOWN_TASK_STATUSES.has(target);
  if (!outOfVocabulary && !MERGED_MEANING_STATUSES.has(target)) return undefined;
  return (
    "decorative yaml `status:` flip refused (W1-T2638, refutation per W1-T367): dispatch " +
    "eligibility (drain.ts's isDispatchEligible) resolves through isMerged's GitHub-derived " +
    "projection before ever comparing t.status, and dependency satisfaction runs through an " +
    "injected MergedResolver whose yaml-trusting default (plan.ts's yamlStatusMerged) is scoped " +
    "to fixture tests only — so the field is decorative and neither harm this class of entry " +
    "cites is reachable" +
    (outOfVocabulary
      ? `; "${target}" is additionally not a TASK_STATUSES member, so writing it fail-closes ` +
        "loadPlan over the whole merged plan"
      : "") +
    ". If the task named here is genuinely uncredited, the sanctioned remedy is an operator " +
    "correction (`rmd correct <id> --pr <n>`, W1-T75), never a yaml edit."
  );
}

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
export function mineFollowups(records: LedgerRecord[], openTitles: string[] = []): FollowupHarvest {
  const processed = new Set<string>();
  for (const r of records) {
    if (r.step === "followup.harvested" || r.step === "followup.deduped") {
      const id = typeof r.entry_id === "string" ? r.entry_id : undefined;
      if (id) processed.add(id);
    }
  }
  // Tokenized ONCE per title, not once per (entry × title) comparison below —
  // `openTitles` is the same set for every entry this pass mines.
  const openTitleWordSets = openTitles.map(significantWords);
  const candidates: FollowupCandidate[] = [];
  const deduped: FollowupCandidate[] = [];
  const harvestLines: LedgerLine[] = [];
  for (const r of records) {
    if (r.step !== "report.followups") continue;
    const entries = Array.isArray(r.entries) ? (r.entries as Array<{ type?: string; text?: string }>) : [];
    entries.forEach((e, i) => {
      const type = e?.type;
      const text = e?.text;
      if (type !== "research" && type !== "task" && type !== "action") return;
      if (typeof text !== "string" || !text.trim()) return;
      const entryId = `${r.run_id ?? "?"}:${r.ts ?? "?"}:${i}`;
      if (processed.has(entryId)) return;
      const candidate: FollowupCandidate = {
        entryId,
        type,
        text,
        runId: String(r.run_id ?? "?"),
        taskId: String(r.task_id ?? "?"),
        ...(typeof r.pr_url === "string" ? { prUrl: r.pr_url } : {}),
      };
      const statusFlipReason = decorativeStatusFlipReason(text);
      const isDup = statusFlipReason !== undefined || openTitleWordSets.some((titleWords) => followupMatchesTitle(text, titleWords));
      if (isDup) {
        deduped.push(statusFlipReason !== undefined ? { ...candidate, reason: statusFlipReason } : candidate);
        harvestLines.push({
          run_id: candidate.runId,
          task_id: candidate.taskId,
          step: "followup.deduped",
          entry_id: entryId,
          type,
          text,
          ...(statusFlipReason !== undefined ? { reason: statusFlipReason } : {}),
        });
      } else {
        candidates.push(candidate);
        harvestLines.push({ run_id: candidate.runId, task_id: candidate.taskId, step: "followup.harvested", entry_id: entryId, type, text });
      }
    });
  }
  return { candidates, deduped, harvestLines };
}

/** Dependencies for {@link recordFollowupHarvest} — same injectable-writer shape as
 *  {@link ContradictionResolutionDeps} (a test spies on `writeLedger` instead of disk). */
export interface FollowupHarvestDeps {
  ledgerPath: string;
  writeLedger?: typeof appendLedger;
}

/**
 * Append every {@link FollowupHarvest.harvestLines} entry so a later
 * {@link mineFollowups} pass over the updated ledger mints neither the
 * candidate nor the dedup match again. The caller (retroCommand) invokes this
 * ONLY on a real (non-`--dry-run`) retro — `mineFollowups` itself never
 * writes, so a dry-run preview stays side-effect-free.
 */
export function recordFollowupHarvest(harvest: FollowupHarvest, deps: FollowupHarvestDeps): void {
  const writeLedger = deps.writeLedger ?? appendLedger;
  for (const line of harvest.harvestLines) writeLedger(deps.ledgerPath, line);
}

/** Render the follow-up harvest (markdown) — printed by `--dry-run` and fed to the
 *  Architect. Every line here is a CANDIDATE citing its origin verbatim, never an instruction to
 *  file a task — this function's own scope. W1-T2456: this cited "Rule 15", which carries no such
 *  doctrine; §12 rule 27 permits automatic filing. */
export function renderFollowupCandidates(harvest: FollowupHarvest): string {
  const lines = [
    // W1-T2456: this heading cited "(rule 15)" for a doctrine §12 rule 15 does not carry. The
    // harvest still emits CANDIDATES rather than tasks — its own scope — so the shape is unchanged
    // and only the false citation is dropped.
    "## Follow-up harvest (W1-T105) — PROPOSAL CANDIDATES, not filed by this rung",
    "",
  ];
  if (harvest.candidates.length === 0) {
    lines.push("No unharvested follow-up this cycle.");
  } else {
    lines.push(
      ...harvest.candidates.map(
        (c) => `- [${c.type}] ${c.text} — from ${c.taskId} (${c.runId}${c.prUrl ? `, ${c.prUrl}` : ""})`,
      ),
    );
  }
  if (harvest.deduped.length > 0) {
    lines.push(
      "",
      `(${harvest.deduped.length} entr${harvest.deduped.length === 1 ? "y" : "ies"} matched an existing open ` +
        "title and was not re-minted: " +
        harvest.deduped.map((d) => `"${d.text}"`).join("; ") +
        ")",
    );
  }
  return lines.join("\n");
}

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
export const FOLLOWUP_TYPE_ROUTES: Readonly<Record<FollowupCandidate["type"], "propose" | "not-plan-shaped">> = {
  research: "propose",
  task: "propose",
  action: "not-plan-shaped",
};

/** One candidate's routing outcome. A decline always NAMES the arm that declined it — never a
 *  bare boolean — so a reader can tell "already covered by the existing title dedup" from
 *  "not plan-shaped work" from "restates its own declaring task" or "dispatch-only" without
 *  re-deriving any of the four from `harvest` by hand. */
export type FollowupRouteOutcome =
  | { candidate: FollowupCandidate; routed: true; proposalId: string }
  | {
      candidate: FollowupCandidate;
      routed: false;
      arm: "title-dedup" | "type-not-plan-shaped" | "self-referential" | "dispatch-only";
      reason: string;
    };

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
function textAsksToImplementItsOwnTask(text: string, taskId: string): boolean {
  const trimmed = taskId.trim();
  if (!trimmed || trimmed === "?") return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*implement\\s+${escaped}\\b`, "i").test(text);
}

/** Admission-time self-reference check: does `candidate.text` simply ask to implement
 *  `candidate.taskId` — the SAME task that declared the candidate? Both fields already ride on
 *  every `FollowupCandidate` (`mineFollowups` sets them), so this needs no new read and no
 *  merged/queued distinction at all — it holds identically whether the declaring task is queued,
 *  merged, or anything else, which is exactly why it reaches the still-queued majority
 *  `retireSettledFollowups`'s merged-only signal cannot (W1-T2563). */
export function isSelfReferentialFollowup(candidate: FollowupCandidate): boolean {
  return textAsksToImplementItsOwnTask(candidate.text, candidate.taskId);
}

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

/** Marker phrases signalling a followup's text is a BARE DISPATCH ask ("this task is ready,
 *  hand it off") rather than a description of work still to be done. Free prose, so this is a
 *  heuristic — see the arm's own doc above for the false-decline risk it knowingly accepts. */
const DISPATCH_ONLY_MARKERS: RegExp[] = [/\bready to implement\b/i, /\bready to build\b/i, /\bhand(?: it)? off\b/i];

/** Verbs that mean the entry names REAL follow-up work of its own, not only a dispatch ask — ANY
 *  match here overrides {@link DISPATCH_ONLY_MARKERS}, keeping the W1-T2470 control ("re-run this
 *  task's own falsifier check ... must be closed rather than built") routed rather than declined. */
const NAMES_REAL_WORK_MARKERS: RegExp[] = [/\bre-?run\b/i, /\bverify\b/i, /\bclose[ds]?\b/i, /\bcheck\b/i, /\baudit\b/i];

/**
 * `undefined` unless `candidate` is a BARE dispatch ask for its own already-filed originating
 * task — see the arm's doc above for the exact three-part test. When it returns a task id, that
 * id is always `candidate.taskId` itself (never a different, merely-mentioned id).
 */
function dispatchOnlyReferent(candidate: FollowupCandidate): string | undefined {
  if (candidate.taskId === "?" || candidate.taskId === "") return undefined;
  const escapedId = candidate.taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`\\b${escapedId}\\b`).test(candidate.text)) return undefined;
  if (!DISPATCH_ONLY_MARKERS.some((re) => re.test(candidate.text))) return undefined;
  if (NAMES_REAL_WORK_MARKERS.some((re) => re.test(candidate.text))) return undefined;
  return candidate.taskId;
}

export interface RouteFollowupsDeps {
  registryPath: string;
  /** Injectable — production takes `updateProposalRegistry` (the W1-T240 single writer),
   *  mirroring board-review.ts's `updateRegistry` seam so a test never touches disk. */
  updateRegistry?: (
    registryPath: string,
    update: (current: Proposal[]) => Proposal[] | null,
    opts?: UpdateProposalRegistryOpts,
  ) => Proposal[] | null;
}

/** Stable, deterministic registry id for one followup candidate. `entryId` already carries
 *  `mineFollowups`'s own uniqueness key (`run_id:ts:index`), so prefixing it is enough — the
 *  SAME entry always re-resolves to the SAME proposal id, which is what lets
 *  `updateProposalRegistry`'s own existing-id check (mirrored below) refuse to re-add it on a
 *  later pass. Never derived from `text`: the free-prose entry can be re-harvested verbatim and
 *  must still resolve to the id it was filed under the first time. */
export function followupProposalId(candidate: FollowupCandidate): string {
  return `followup:${candidate.entryId}`;
}

/**
 * Route one `mineFollowups` harvest into the ACTIVE-proposal registry — the single writer
 * (inbox.ts's `updateProposalRegistry`) board-review.ts/rule-efficacy.ts/feedback-docket.ts
 * already use — replacing "nobody reads this markdown section" with an actual consumer.
 *
 * FOUR REFUSAL ARMS, each named on its own outcome, neither re-implemented here:
 *   - `"title-dedup"`: `harvest.deduped` — `mineFollowups`'s OWN `followupMatchesTitle` arm,
 *     the existing duplicate refusal this function reuses verbatim rather than re-scoring.
 *   - `"type-not-plan-shaped"`: {@link FOLLOWUP_TYPE_ROUTES} says the entry's type is not
 *     routable — the type definition decided above, cited, never re-guessed per call.
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
export function routeFollowupsToRegistry(harvest: FollowupHarvest, deps: RouteFollowupsDeps): FollowupRouteOutcome[] {
  const updateRegistry = deps.updateRegistry ?? updateProposalRegistry;
  const outcomes: FollowupRouteOutcome[] = [];

  for (const candidate of harvest.deduped) {
    outcomes.push({
      candidate,
      routed: false,
      arm: "title-dedup",
      reason: "already declined by mineFollowups' own followupMatchesTitle dedup arm (harvest.deduped)",
    });
  }

  const routable: FollowupCandidate[] = [];
  for (const candidate of harvest.candidates) {
    if (FOLLOWUP_TYPE_ROUTES[candidate.type] !== "propose") {
      outcomes.push({
        candidate,
        routed: false,
        arm: "type-not-plan-shaped",
        reason: `"${candidate.type}" is an operator ask, not plan-shaped work (FOLLOWUP_TYPE_ROUTES)`,
      });
      continue;
    }
    const dispatchOnlyId = dispatchOnlyReferent(candidate);
    if (dispatchOnlyId !== undefined) {
      outcomes.push({
        candidate,
        routed: false,
        arm: "dispatch-only",
        reason:
          `text asks only to dispatch its own already-filed task (${dispatchOnlyId}) — a bare-` +
          `dispatch marker phrase with no other action-verb marker — so ratifying this as a ` +
          `proposal could only duplicate a task already in the plan (W1-T2613). HEURISTIC OVER ` +
          `FREE PROSE, NOT A PARSER: a live entry that pairs a dispatch marker with real ` +
          `follow-up work worded outside this arm's action-verb list (re-run/verify/close/` +
          `check/audit) is wrongly declined here, right alongside every entry it declines ` +
          `correctly.`,
      });
      continue;
    }
    if (isSelfReferentialFollowup(candidate)) {
      outcomes.push({
        candidate,
        routed: false,
        arm: "self-referential",
        reason:
          `this entry's own text asks to implement ${candidate.taskId} — the SAME task that ` +
          `declared it — so routing it would duplicate a plan record that already exists on ` +
          `whichever side of the merge ${candidate.taskId} falls (isSelfReferentialFollowup)`,
      });
      continue;
    }
    routable.push(candidate);
  }

  if (routable.length > 0) {
    updateRegistry(deps.registryPath, (current) => {
      const existingIds = new Set(current.map((p) => p.id));
      const additions: Proposal[] = routable
        .filter((c) => !existingIds.has(followupProposalId(c)))
        .map((c) => ({
          id: followupProposalId(c),
          summary:
            `follow-up harvest [${c.type}]: ${c.text} — from ${c.taskId} (run ${c.runId}` +
            `${c.prUrl ? `, ${c.prUrl}` : ""})`,
          // Stated, never synthesized — see this function's own doc for why a fabricated
          // git-grep pattern would be worse than an honest empty set.
          evidenceAnchors: [] as EvidenceAnchor[],
        }));
      return additions.length > 0 ? [...current, ...additions] : null;
    });
    for (const candidate of routable) {
      outcomes.push({ candidate, routed: true, proposalId: followupProposalId(candidate) });
    }
  }

  return outcomes;
}

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

/**
 * The ONE batched read this retirement pass needs: which task ids (of the routed follow-ups'
 * OWN `taskId` referents) have merged, read ONCE per pass — never a read per proposal, mirroring
 * inbox.ts's `BoardReferentRead` (W1-T2451). `"unreadable"` means the whole batched read failed
 * (GitHub/ledger unavailable): every followup proposal is left exactly as it is — cannot-observe
 * means WAIT (W1-T130), never a guessed retirement.
 */
export type FollowupReferentRead = { kind: "ok"; merged: ReadonlySet<string> } | { kind: "unreadable" };

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
export function followupOriginatingTaskId(proposal: Proposal): string | undefined {
  if (!proposal.id.startsWith("followup:")) return undefined;
  return /— from (\S+) \(run /.exec(proposal.summary)?.[1];
}

/** One proposal this pass actually retired, naming BOTH what settled it and the false-positive
 *  risk that decision carries — acceptance: "the retirement names which still-live candidates it
 *  wrongly removes, rather than claiming none". */
export interface FollowupRetireOutcome {
  proposalId: string;
  taskId: string;
  reason: string;
}

export interface RetireFollowupsDeps {
  registryPath: string;
  /** Injectable — production takes {@link updateProposalRegistry}, mirroring
   *  {@link RouteFollowupsDeps.updateRegistry}'s own test seam. */
  updateRegistry?: (
    registryPath: string,
    update: (current: Proposal[]) => Proposal[] | null,
    opts?: UpdateProposalRegistryOpts,
  ) => Proposal[] | null;
}

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
export function retireSettledFollowups(read: FollowupReferentRead, deps: RetireFollowupsDeps): FollowupRetireOutcome[] {
  if (read.kind === "unreadable") return [];

  const updateRegistry = deps.updateRegistry ?? updateProposalRegistry;
  let outcomes: FollowupRetireOutcome[] = [];

  updateRegistry(deps.registryPath, (current) => {
    const settled: FollowupRetireOutcome[] = [];
    for (const p of current) {
      const taskId = followupOriginatingTaskId(p);
      if (taskId === undefined || !read.merged.has(taskId)) continue;
      settled.push({
        proposalId: p.id,
        taskId,
        reason:
          `${p.id}'s originating task (${taskId}) has merged, so this routed follow-up is retired ` +
          `and removed from the registry. KNOWN FALSE-POSITIVE RISK, NAMED RATHER THAN CLAIMED ` +
          `AWAY: a task can merge while leaving real follow-up work undone — this signal cannot ` +
          `tell that still-live candidate apart from a genuinely settled one, and wrongly retires ` +
          `it right alongside every proposal it retires correctly.`,
      });
    }
    outcomes = settled;
    if (settled.length === 0) return null;
    const retiredIds = new Set(settled.map((o) => o.proposalId));
    return current.filter((p) => !retiredIds.has(p.id));
  });

  return outcomes;
}

// ── Self-referential follow-up prune (W1-T2617) ─────────────────────────────────────────────
//
// `isSelfReferentialFollowup` above (the admission-time arm `routeFollowupsToRegistry` now
// checks) stops FUTURE self-referential mints. It does nothing for the 21-of-23 rows already
// minted before this task, sitting in the registry today (2026-09-01 measurement, this task's
// own rationale). THE W1-T190 DOCTRINE, verbatim: heal existing drift, not only future mints.
// This section is that heal — a ONE-TIME pass any caller (a script, a test, a future retro run)
// can invoke, through the SAME single writer `routeFollowupsToRegistry` and
// `retireSettledFollowups` both use, in ONE write for the whole pass.

/** Parse a routed follow-up's own free-text `text` back out of its minted `summary` —
 *  `routeFollowupsToRegistry`'s `follow-up harvest [type]: <text> — from <taskId> (run ...)`
 *  shape, the SAME string this whole followup family already parses for its `taskId` referent
 *  (see {@link followupOriginatingTaskId}'s own doc for why a structured field is never used).
 *  Returns `undefined` for anything that does not match the shape this module itself mints. */
function followupSummaryText(summary: string): string | undefined {
  return /^follow-up harvest \[[a-z]+\]: ([\s\S]*) — from \S+ \(run /.exec(summary)?.[1];
}

/** One proposal this pass actually removed, naming what it matched — mirrors
 *  {@link FollowupRetireOutcome}'s shape so a caller already familiar with retirement outcomes
 *  reads this one for free. */
export interface FollowupPruneOutcome {
  proposalId: string;
  taskId: string;
  reason: string;
}

export interface PruneFollowupsDeps {
  registryPath: string;
  /** Injectable — production takes {@link updateProposalRegistry}, mirroring
   *  {@link RouteFollowupsDeps.updateRegistry} and {@link RetireFollowupsDeps.updateRegistry}'s
   *  own test seam. */
  updateRegistry?: (
    registryPath: string,
    update: (current: Proposal[]) => Proposal[] | null,
    opts?: UpdateProposalRegistryOpts,
  ) => Proposal[] | null;
}

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
export function pruneSelfReferentialFollowups(deps: PruneFollowupsDeps): FollowupPruneOutcome[] {
  const updateRegistry = deps.updateRegistry ?? updateProposalRegistry;
  let outcomes: FollowupPruneOutcome[] = [];

  updateRegistry(deps.registryPath, (current) => {
    const matched: FollowupPruneOutcome[] = [];
    for (const p of current) {
      const taskId = followupOriginatingTaskId(p);
      if (taskId === undefined) continue;
      const text = followupSummaryText(p.summary);
      if (text === undefined) continue;
      if (!textAsksToImplementItsOwnTask(text, taskId)) continue;
      matched.push({
        proposalId: p.id,
        taskId,
        reason:
          `${p.id}'s own text asks to implement ${taskId} — the SAME task that declared it — so ` +
          `it duplicates a plan record that already exists on whichever side of the merge ` +
          `${taskId} falls. Pruned by the SAME predicate (isSelfReferentialFollowup /` +
          `textAsksToImplementItsOwnTask) routeFollowupsToRegistry now refuses at admission time.`,
      });
    }
    outcomes = matched;
    if (matched.length === 0) return null;
    const prunedIds = new Set(matched.map((o) => o.proposalId));
    return current.filter((p) => !prunedIds.has(p.id));
  });

  return outcomes;
}

// ── Phrasing — the ONLY step where an LLM enters (W1-T87/P13) ────────────

/**
 * Injected phrasing dependency — receives ONLY the already-mined {@link
 * ProceduralCandidate}, never raw ledger records or other candidates
 * (mirrors learnings.ts's `PromotionJudgeDeps.judge` shape: evidence is
 * deterministic, the model only phrases/judges over it).
 */
export interface ProceduralPhraseDeps {
  phrase: (candidate: ProceduralCandidate) => string | Promise<string>;
}

/**
 * ONE draft, shaped to become a `LearningEntry` (learnings.ts) once the
 * Architect ratifies it into a `learnings/*.yaml` shard — same fields, NO
 * parallel store. `subsystem: "procedural"` is the only tag distinguishing
 * it; once admitted it rides the EXACT SAME `active|superseded|quarantined`
 * lifecycle and `selectLearnings` matcher as any other entry.
 */
export interface ProceduralLearningDraft {
  id: string;
  subsystem: "procedural";
  fact: string;
  src: string;
  files: string[];
}

/** Deterministic id for a candidate's draft — stable across calls for the same shape. */
function proceduralDraftId(candidate: ProceduralCandidate): string {
  return `procedural-${candidate.shapeKey.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}`;
}

/**
 * PHRASE one mined candidate into a {@link ProceduralLearningDraft}. The
 * ONLY step in this whole pipeline that touches an LLM — `deps.phrase`
 * receives NOTHING but the candidate {@link mineProceduralCandidates}
 * already computed (never the ledger, never sibling candidates), so a
 * stubbed `deps` proves the evidence/phrasing split by construction: a test
 * asserting the stub's received argument deep-equals the input candidate is
 * the falsifier.
 */
export async function phraseProceduralCandidate(
  candidate: ProceduralCandidate,
  deps: ProceduralPhraseDeps,
): Promise<ProceduralLearningDraft> {
  const fact = await deps.phrase(candidate);
  return {
    id: proceduralDraftId(candidate),
    subsystem: "procedural",
    fact,
    src: `retro#procedural (${candidate.taskIds.join(", ")})`,
    files: [],
  };
}

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

/** What one {@link PromotionResult} means for the Architect, with the two `stage: "judge"` outcomes kept apart. */
export type PromotionDisposition =
  | "proposed"
  | "declined-scrub"
  | "declined-top-layer"
  | "declined-project-specific"
  | "declined-low-confidence";

/**
 * The pure decision on ONE promotion result (Standing rule 12 — judgment is advisory,
 * acting on it is a pure function). One arm per outcome, and never a shared arm for two:
 * a scrub block, a top-layer entry, a considered `project-specific` NO and a
 * below-threshold `broadly-applicable` call are four different things to a reader
 * deciding what to ratify.
 */
export function classifyPromotionResult(
  result: PromotionResult,
  confidenceThreshold: number = DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD,
): PromotionDisposition {
  if (result.stage === "scrub") return "declined-scrub";
  if (result.stage === "top-layer") return "declined-top-layer";
  if (result.promoted) return "proposed";
  const verdict = result.verdict;
  if (verdict && verdict.applicability === "broadly-applicable" && verdict.confidence < confidenceThreshold) {
    return "declined-low-confidence";
  }
  return "declined-project-specific";
}

/** What {@link renderPromotionProposals} needs, so an empty corpus and an all-declined pass never render the same line. */
export interface PromotionProposalInput {
  /** Entries handed to the pass — NOT the number that reached the judge. */
  corpusSize: number;
  /** False when no judge was configured, in which case `results` is empty because the pass never ran. */
  ranPass: boolean;
  results: PromotionResult[];
  confidenceThreshold?: number;
}

/**
 * Render one pass as a retro-report section. THREE ZERO-LOOKING STATES ARE KEPT APART,
 * because collapsing them is how "built and unreachable" stayed invisible for as long as
 * it did: the pass did not run (no judge), the pass ran over an EMPTY corpus, and the
 * pass ran over a real corpus and proposed nothing. Only the third is a finding about
 * the corpus.
 */
export function renderPromotionProposals(input: PromotionProposalInput): string {
  const head = "## Learnings promotion (P32/W1-T146) — proposals for the Architect to ratify";
  if (!input.ranPass) {
    return [
      head,
      "",
      "The pass did NOT run: no promotion judge was supplied to this retro. Nothing was scrubbed,",
      "judged or proposed. Supplying a judge makes the pass run over the active corpus and renders",
      "its proposals here; it still writes nothing — ratification stays an Architect PR.",
    ].join("\n");
  }
  if (input.corpusSize === 0) {
    return [
      head,
      "",
      "The pass ran over an EMPTY corpus — no entries were handed to it. This is not a statement",
      "about what is promotable; it is a statement that nothing was read.",
    ].join("\n");
  }
  const threshold = input.confidenceThreshold;
  const rows = input.results.map((r) => ({ result: r, disposition: classifyPromotionResult(r, threshold) }));
  const proposed = rows.filter((r) => r.disposition === "proposed");
  const lines = [head, ""];
  if (proposed.length === 0) {
    lines.push("The pass ran over the active corpus and proposed nothing to promote.");
  } else {
    lines.push("PROPOSED — ratify by landing each entry at the named layer in a reviewed PR:");
    for (const { result } of proposed) {
      const to = result.promotedEntry?.layer ?? "?";
      const confidence = result.verdict?.confidence ?? 0;
      lines.push(`- ${result.entryId} -> ${to} (confidence ${confidence}) — ${result.verdict?.rationale ?? ""}`);
    }
  }
  const declined = rows.filter((r) => r.disposition !== "proposed");
  if (declined.length > 0) {
    lines.push("", "DECLINED, by reason — each arm is a different decision, not one bucket:");
    for (const { result, disposition } of declined) {
      lines.push(`- ${result.entryId}: ${disposition} — ${result.reason}`);
    }
  }
  lines.push("", "NOTHING ABOVE HAS BEEN WRITTEN. A promotion is a proposal; the Architect ratifies it in a PR.");
  return lines.join("\n");
}

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

/**
 * ONE deterministically-keyed candidate pair for opposition judging: two
 * currently-`active` entries sharing the SAME `subsystem` (the topic key)
 * with >=1 overlapping `files` glob (exact string overlap — the same
 * discipline `matchCount` in learnings.ts uses for concrete file matches,
 * kept simple and auditable rather than a fuzzy glob-intersection). `key` is
 * the deterministic grouping key (`${subsystem}:${sharedGlobs}`), stable
 * across calls for the same pair regardless of scan order.
 */
export interface ContradictionCandidatePair {
  key: string;
  a: LearningEntry;
  b: LearningEntry;
}

/** The `files` globs two entries share, sorted (empty ⇒ no overlap, no pair). */
function sharedFileGlobs(a: string[], b: string[]): string[] {
  return a.filter((g) => b.includes(g)).sort();
}

/**
 * MINE every candidate contradiction pair, PURE and deterministic — no LLM,
 * no I/O; calling it twice over the SAME corpus returns the SAME pairs. Only
 * `lifecycle === "active"` entries are considered (a `superseded`/
 * `quarantined`/already-`contested` entry is never re-proposed — it either
 * already lost a resolution or was pulled for an unrelated reason). Iterates
 * entries SORTED BY ID first so pair order — and therefore `key` — never
 * depends on the corpus's on-disk/array order.
 */
export function keyContradictionCandidates(entries: LearningEntry[]): ContradictionCandidatePair[] {
  const active = entries
    .filter((e) => e.lifecycle === "active")
    .slice()
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const out: ContradictionCandidatePair[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.subsystem !== b.subsystem) continue;
      const shared = sharedFileGlobs(a.files, b.files);
      if (shared.length === 0) continue;
      out.push({ key: `${a.subsystem}:${shared.join("+")}`, a, b });
    }
  }
  return out;
}

/** The advisory judge's verdict on ONE candidate pair — phrasing/judgment only, never new evidence. */
export interface ContradictionVerdict {
  /** True iff the two facts give MUTUALLY-EXCLUSIVE guidance (never both true at once). */
  opposing: boolean;
  /** Why, for the retro report + question backlog. */
  reasoning?: string;
}

/**
 * Dependencies {@link flagContradictions} needs injected — mirrors {@link
 * ProceduralPhraseDeps}/learnings.ts's `PromotionJudgeDeps.judge`: evidence
 * (the candidate pair) is deterministic, the model only JUDGES over it.
 */
export interface ContradictionJudgeDeps {
  /** The advisory opposition eval. Receives ONLY the candidate pair — never the whole corpus, never other pairs. */
  judge: (pair: ContradictionCandidatePair) => ContradictionVerdict | Promise<ContradictionVerdict>;
  /** Optional structured-event sink (same shape as flight-judge.ts's `deps.log`); no-op if omitted. */
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** ONE confirmed contradiction — a candidate pair the judge flagged `opposing: true`. */
export interface ContradictionFinding {
  key: string;
  aId: string;
  bId: string;
  aFact: string;
  bFact: string;
  reasoning?: string;
}

/**
 * Judge every candidate pair and return ONLY the ones flagged opposing — a
 * non-opposing (refining) pair produces NO finding, so it never gets marked
 * contested and ordinary recency-overwrite for it is untouched. Pairs are
 * judged independently and in order; nothing here mutates `pair.a`/`pair.b`.
 */
export async function flagContradictions(
  pairs: ContradictionCandidatePair[],
  deps: ContradictionJudgeDeps,
): Promise<ContradictionFinding[]> {
  const log = deps.log ?? (() => {});
  const findings: ContradictionFinding[] = [];
  for (const pair of pairs) {
    const verdict = await deps.judge(pair);
    log("contradiction.verdict", { key: pair.key, a: pair.a.id, b: pair.b.id, opposing: verdict.opposing });
    if (!verdict.opposing) continue; // a refinement, not a contradiction — recency-overwrite unchanged
    findings.push({
      key: pair.key,
      aId: pair.a.id,
      bId: pair.b.id,
      aFact: pair.a.fact,
      bFact: pair.b.fact,
      reasoning: verdict.reasoning,
    });
  }
  return findings;
}

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
export function applyContestedLifecycle(entries: LearningEntry[], findings: ContradictionFinding[]): LearningEntry[] {
  const partnerOf = new Map<string, string>();
  for (const f of findings) {
    if (!partnerOf.has(f.aId)) partnerOf.set(f.aId, f.bId);
    if (!partnerOf.has(f.bId)) partnerOf.set(f.bId, f.aId);
  }
  return entries.map((e) => {
    const other = partnerOf.get(e.id);
    if (!other) return e;
    const contested: Lifecycle = "contested";
    return { ...e, lifecycle: contested, contestedWith: other };
  });
}

/** Render the confirmed contradictions (markdown) — printed alongside the retro report. */
export function renderContradictions(findings: ContradictionFinding[]): string {
  if (findings.length === 0) {
    return "## Consolidation contradiction detection (P14)\n\nNo contradicting pair found this cycle.";
  }
  return [
    "## Consolidation contradiction detection (P14) — CONTESTED, excluded from injection until an Architect resolves which governs",
    "",
    ...findings.flatMap((f) =>
      [
        `- CONTESTED (${f.key}): ${f.aId} vs ${f.bId}`,
        `    - ${f.aId}: ${f.aFact}`,
        `    - ${f.bId}: ${f.bFact}`,
        f.reasoning ? `    - why: ${f.reasoning}` : undefined,
      ].filter((line): line is string => line !== undefined),
    ),
  ].join("\n");
}

/**
 * Render ONE finding into the §2 QUESTION contract's own shape (worker.ts's
 * `QuestionEntry`) for the durable question backlog (mirrors sweep.ts's
 * `toQuestionEntry`) — `current_assumption` names what stays true while the
 * pair is unresolved: BOTH entries stay excluded from injection, never one
 * silently winning by recency.
 */
export function contradictionQuestion(finding: ContradictionFinding, ts: string): QuestionEntry {
  return {
    ts,
    task: "retro",
    question:
      `Consolidation found a CONTESTED learnings pair (${finding.key}) — which governs? ` +
      `${finding.aId}: "${finding.aFact}" vs ${finding.bId}: "${finding.bFact}"` +
      (finding.reasoning ? ` — judge: ${finding.reasoning}` : ""),
    current_assumption: `Both ${finding.aId} and ${finding.bId} stay lifecycle: contested — excluded from injection — until answered.`,
    impact_if_wrong: "med",
  };
}

/**
 * An Architect-authored decision for ONE contested pair: `activeId` governs
 * (re-admitted to injection), `supersededId` loses (marked `superseded`,
 * `supersededBy: activeId`). There is deliberately NO code path that derives
 * this from the judge's verdict or from recency — a human (or the Architect
 * worker, standing rule 15) must name the winner explicitly.
 */
export interface ContradictionResolution {
  activeId: string;
  supersededId: string;
  by?: string;
  reason?: string;
}

/** Dependencies {@link applyContradictionResolution} needs injected — same shape as correct.ts's `writeLedger` override. */
export interface ContradictionResolutionDeps {
  /** Absolute path to state/ledger.ndjson. */
  ledgerPath: string;
  /** Defaults to the real {@link appendLedger}; tests inject a spy instead of touching disk. */
  writeLedger?: typeof appendLedger;
}

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
export function applyContradictionResolution(
  entries: LearningEntry[],
  resolution: ContradictionResolution,
  deps: ContradictionResolutionDeps,
): LearningEntry[] {
  const writeLedger = deps.writeLedger ?? appendLedger;
  const updated = entries.map((e) => {
    if (e.id === resolution.activeId) {
      const active: Lifecycle = "active";
      return { ...e, lifecycle: active, contestedWith: undefined };
    }
    if (e.id === resolution.supersededId) {
      const superseded: Lifecycle = "superseded";
      return { ...e, lifecycle: superseded, supersededBy: resolution.activeId, contestedWith: undefined };
    }
    return e;
  });
  writeLedger(deps.ledgerPath, {
    run_id: `CONTRADICTION-${resolution.activeId}-${resolution.supersededId}`,
    task_id: "retro",
    step: "contradiction.resolved",
    active_id: resolution.activeId,
    superseded_id: resolution.supersededId,
    by: resolution.by ?? "architect",
    reason: resolution.reason ?? null,
  });
  return updated;
}

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

/** One evidence occurrence for a learning id — WHEN it was cited, regardless of source. */
export interface CitationEvidence {
  id: string;
  /** ISO date (or full timestamp); only lexicographic ("latest wins") order matters. */
  date: string;
}

/**
 * Mine `learnings.injected` ledger rows for per-id citation evidence — one {@link
 * CitationEvidence} per id per row's `matched_ids`. A PRE-TASK row (every row before this task
 * shipped: it logs `matched` as a bare count with no `matched_ids` array at all) contributes
 * NOTHING, never a throw — old-format rows are the expected majority of history, not a parse
 * error (W1-T419 design iv's falsifier). A malformed/non-array `matched_ids`, or a non-string
 * entry within it, is skipped the same way rather than crashing the pass.
 */
export function mineLedgerCitations(records: LedgerRecord[]): CitationEvidence[] {
  const out: CitationEvidence[] = [];
  for (const r of records) {
    if (r.step !== "learnings.injected") continue;
    const ids = r.matched_ids;
    if (!Array.isArray(ids)) continue; // pre-task row (count-only) or malformed — no evidence
    const date = typeof r.ts === "string" ? r.ts : "";
    for (const id of ids) {
      if (typeof id === "string" && id.length > 0) out.push({ id, date });
    }
  }
  return out;
}

/**
 * One git-log commit reduced to just what {@link mineGitLogCitations} needs — a caller resolves
 * these from `git log --format=...` however its own environment shells out (this repo's `rmd`
 * CLI, a retro script, or a test fixture); this module stays a PURE reducer over already-read
 * text, the same discipline {@link parseLedger} keeps for ledger lines.
 */
export interface GitLogCommit {
  date: string;
  message: string;
}

/**
 * Mine git-log commit messages for `learnings#<id>` citations — ONE {@link CitationEvidence} per
 * (commit, id) pair, deduplicated WITHIN a commit so a message citing the same id twice (once in
 * the subject, once in a body bullet) counts as one piece of evidence rather than inflating
 * `cited_count` per mention.
 */
export function mineGitLogCitations(commits: GitLogCommit[]): CitationEvidence[] {
  const out: CitationEvidence[] = [];
  // Ids in this corpus are alphanumeric + hyphen only (no `.`/`_` — verified against every
  // learnings/*.yaml id at filing time), so the class stops short of `.` deliberately: a
  // sentence-ending period right after an id (`...see learnings#foo.`) must never be captured
  // into the id itself.
  const pattern = /learnings#([A-Za-z0-9][A-Za-z0-9-]*)/g;
  for (const commit of commits) {
    const ids = new Set<string>();
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(commit.message))) ids.add(match[1]);
    for (const id of ids) out.push({ id, date: commit.date });
  }
  return out;
}

/** Per-entry mined evidence, reduced: total occurrences and the latest (max, lexicographic) date. */
export interface CitationStamp {
  citedCount: number;
  cited: string;
}

/**
 * Reduce raw {@link CitationEvidence} — from any number of sources, ledger and git-log alike, the
 * caller concatenates before calling this — into ONE {@link CitationStamp} per id: `citedCount`
 * sums every occurrence, `cited` is the latest date seen. An id with zero evidence across all
 * sources has no key in the returned map; {@link stampCitations} leaves such an entry's
 * `cited`/`citedCount` exactly as it already was.
 */
export function aggregateCitationEvidence(evidence: CitationEvidence[]): Map<string, CitationStamp> {
  const out = new Map<string, CitationStamp>();
  for (const e of evidence) {
    const prior = out.get(e.id);
    if (!prior) {
      out.set(e.id, { citedCount: 1, cited: e.date });
      continue;
    }
    prior.citedCount += 1;
    if (e.date > prior.cited) prior.cited = e.date;
  }
  return out;
}

/**
 * Stamp mined citation evidence onto every ACTIVE entry — pure, returns a NEW array (same
 * discipline as {@link applyContestedLifecycle}), never mutates `entries`. Only entries WITH
 * measured evidence this cycle change; an entry absent from `evidence` keeps whatever
 * `cited`/`citedCount` it already carried — a mining pass that simply found nothing new never
 * blanks an entry back to unevidenced. A non-active entry (superseded/quarantined/contested) is
 * never stamped: selectLearnings never injects it, so citation evidence for it is moot.
 */
export function stampCitations(entries: LearningEntry[], evidence: Map<string, CitationStamp>): LearningEntry[] {
  return entries.map((e) => {
    if (e.lifecycle !== "active") return e;
    const stamp = evidence.get(e.id);
    if (!stamp) return e;
    return { ...e, cited: stamp.cited, citedCount: stamp.citedCount };
  });
}

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
export function changedCitationStamps(
  entries: LearningEntry[],
  evidence: Map<string, CitationStamp>,
): Map<string, CitationStamp> {
  const stamped = stampCitations(entries, evidence);
  const out = new Map<string, CitationStamp>();
  for (let i = 0; i < entries.length; i++) {
    const before = entries[i];
    const after = stamped[i];
    if (after.cited !== before.cited || after.citedCount !== before.citedCount) {
      out.set(after.id, { cited: after.cited as string, citedCount: after.citedCount as number });
    }
  }
  return out;
}

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
interface EntryBlockLocation {
  start: number;
  end: number;
  block: string;
}

/** Locate ONE learning entry's block (from its `- id: <id>` header up to, but excluding, the
 *  next entry's header or end-of-text) within a shard's raw YAML text. Shared by {@link
 *  stampCitationInShardText} (the write) and {@link extractEntryBlock}/{@link
 *  captureCitationBaselines} (the W1-T1267 baseline capture/compare) so both agree, byte for
 *  byte, on where one entry ends and the next begins. */
function locateEntryBlock(text: string, id: string): EntryBlockLocation | undefined {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startRe = new RegExp(`^- id: ${escapedId}\\s*$`, "m");
  const startMatch = startRe.exec(text);
  if (!startMatch) return undefined; // id not in this shard
  const start = startMatch.index;
  const afterHeader = start + startMatch[0].length;
  const rest = text.slice(afterHeader);
  const nextMatch = /^- id: /m.exec(rest);
  const end = nextMatch ? afterHeader + nextMatch.index : text.length;
  return { start, end, block: text.slice(start, end) };
}

/** W1-T1267: read-only counterpart to {@link locateEntryBlock} — the raw text of one entry's
 *  block, or `undefined` when `id` has no block in `text` at all (a different shard, a stale id,
 *  or an id genuinely absent from this ref). Used both to CAPTURE a baseline (design ii, "the
 *  entry block the decision was made against") and to read the FRESH block a baseline is later
 *  compared to — never to write; {@link stampCitationInShardText} owns every actual edit. */
export function extractEntryBlock(text: string, id: string): string | undefined {
  return locateEntryBlock(text, id)?.block;
}

export function stampCitationInShardText(text: string, id: string, stamp: CitationStamp): string {
  const loc = locateEntryBlock(text, id);
  if (!loc) return text; // id not in this shard — no-op
  const { start, end } = loc;
  let block = loc.block;
  const citedLine = `  cited: "${stamp.cited}"`;
  const countLine = `  cited_count: ${stamp.citedCount}`;
  if (/^  cited:.*$/m.test(block)) {
    block = block.replace(/^  cited:.*$/m, citedLine);
  } else {
    // No prior `cited:` line (a freshly-added entry, never yet hand-stamped or mined) — append
    // right before the block's trailing whitespace, the same "no anchor to replace" fallback
    // learnings-assert-check.mjs's own quarantineEntryInText uses.
    const trailingWs = /\s*$/.exec(block)?.[0] ?? "";
    block = `${block.slice(0, block.length - trailingWs.length)}\n${citedLine}${trailingWs}`;
  }
  if (/^  cited_count:.*$/m.test(block)) {
    block = block.replace(/^  cited_count:.*$/m, countLine);
  } else {
    block = block.replace(citedLine, `${citedLine}\n${countLine}`);
  }
  return text.slice(0, start) + block + text.slice(end);
}

const CITATION_STAMP_COMMIT_MESSAGE = "chore(learnings): stamp measured citation evidence (W1-T1248)";

/**
 * W1-T1267: read, for each id in `ids`, the RAW block text as it stands in `learningsDir` RIGHT
 * NOW — "the entry block the decision was made against" (design ii). Callers invoke this
 * immediately after computing `changed` (the same corpus read {@link changedCitationStamps}'
 * eligibility decision came from), so the returned map is the "plan time" baseline the write
 * phase later compares a FRESH read against. An id absent from every shard here is simply
 * absent from the returned map — {@link stampCitationsAndCommit}'s own no-op-when-absent
 * behavior stays the single source of truth for "this id isn't in this corpus".
 */
export function captureCitationBaselines(learningsDir: string, ids: Iterable<string>): Map<string, string> {
  const remaining = new Set(ids);
  const out = new Map<string, string>();
  if (remaining.size === 0) return out;
  let filenames: string[];
  try {
    filenames = fsMarker
      .readdirSync(learningsDir)
      .filter((f) => f.endsWith(".yaml"))
      .sort();
  } catch {
    return out; // no corpus directory — no baselines to capture
  }
  for (const filename of filenames) {
    if (remaining.size === 0) break;
    let text: string;
    try {
      text = fsMarker.readFileSync(join(learningsDir, filename), "utf8");
    } catch {
      continue;
    }
    for (const id of remaining) {
      const block = extractEntryBlock(text, id);
      if (block !== undefined) {
        out.set(id, block);
        remaining.delete(id);
      }
    }
  }
  return out;
}

/** One entry's baseline-vs-fresh mismatch (design iii): named so an operator reading the ledger
 *  row can tell a lifecycle flip from a hand-edited fact without opening the shard. */
export interface CitationBaselineRefusal {
  id: string;
  /** The YAML key of the first line that differs (e.g. `"lifecycle"`), or `"block"` when the
   *  block's line count itself changed rather than any one line's content. */
  field: string;
  before: string;
  after: string;
}

const CITATION_STAMP_LINE_RE = /^ {2}(cited|cited_count):.*$/;

/** Strip the two lines {@link stampCitationInShardText} itself owns — a baseline-vs-fresh
 *  compare must judge everything ELSE about the entry (design ii: "anything OUTSIDE the two
 *  stamped lines"), never the fields this very pass is about to write. */
function withoutCitationStampLines(block: string): string[] {
  return block.split("\n").filter((line) => !CITATION_STAMP_LINE_RE.test(line));
}

/**
 * W1-T1267: compare the entry block the eligibility decision was made against (`baseline`,
 * design ii) with a FRESH read of the same id's CURRENT block (`fresh`). Returns `undefined`
 * when nothing outside `cited`/`cited_count` moved — the write may proceed. Otherwise names the
 * id, the first differing field, and both of its values (design iii) — never merely "entry
 * changed". `fresh === undefined` means the id's block is genuinely gone from the fresh read
 * (not "we couldn't get a fresh read at all" — callers only invoke this once they HAVE one).
 */
export function compareCitationBaseline(id: string, baseline: string, fresh: string | undefined): CitationBaselineRefusal | undefined {
  const beforeLines = withoutCitationStampLines(baseline);
  const afterLines = fresh === undefined ? [] : withoutCitationStampLines(fresh);
  if (beforeLines.join("\n") === afterLines.join("\n")) return undefined;
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i++) {
    const b = beforeLines[i] ?? "";
    const a = afterLines[i] ?? "";
    if (b !== a) {
      const field = (b.match(/^\s*([\w-]+):/) ?? a.match(/^\s*([\w-]+):/))?.[1] ?? "block";
      return { id, field, before: b.trim() || "(absent)", after: a.trim() || "(absent)" };
    }
  }
  // Every compared line matched but the loop above would have already returned on the first
  // divergence in length (one side has `""` where the other has a real line) — kept as a
  // defined fallback rather than silently treating a real mismatch as "no change".
  return { id, field: "block", before: "(present)", after: "(missing)" };
}

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
function defaultFreshShardTextReader(worktreePath: string): (relPath: string) => string | undefined {
  let fetchAttempted = false;
  let fetchOk = false;
  return (relPath: string): string | undefined => {
    if (!fetchAttempted) {
      fetchAttempted = true;
      try {
        execFileSync("git", ["-C", worktreePath, "fetch", "--quiet", "origin", "main"], { stdio: "pipe" });
        fetchOk = true;
      } catch {
        fetchOk = false;
      }
    }
    if (!fetchOk) return undefined;
    try {
      return execFileSync("git", ["-C", worktreePath, "show", `origin/main:${relPath}`], { encoding: "utf8" });
    } catch {
      return undefined; // e.g. a brand-new shard not yet on origin/main
    }
  };
}

export interface StampCitationsAndCommitResult {
  committed: boolean;
  /** Ids actually written to a shard file this pass (subset of `changed`'s keys — an id absent
   *  from every shard, e.g. a stale/renamed one, is silently skipped rather than throwing: the
   *  corpus on disk is the truth, not the evidence map). */
  stampedIds: string[];
  /** W1-T1267: ids whose baseline (design ii) no longer matches a fresh read of `origin/main` —
   *  refused this pass, never retried (design iv). Always present, empty when nothing refused. */
  refused: CitationBaselineRefusal[];
  /** `git show` of the new commit (patch + stat) — omitted when `committed` is false. */
  diff?: string;
}

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
export function stampCitationsAndCommit(opts: {
  worktreePath: string;
  /** Absolute path, typically `join(worktreePath, "learnings")`. */
  learningsDir: string;
  changed: Map<string, CitationStamp>;
  commitMessage?: string;
  /** Per-id baseline block (design ii), from {@link captureCitationBaselines}. */
  baselines?: Map<string, string>;
  /** Injectable so a test can simulate a mid-pass mutation without a real `origin` remote
   *  (design vi: "drive it by mutating the shard on disk between the two halves"). Default:
   *  {@link defaultFreshShardTextReader}. */
  readFreshShardText?: (relPath: string) => string | undefined;
}): StampCitationsAndCommitResult {
  if (opts.changed.size === 0) return { committed: false, stampedIds: [], refused: [] };
  let filenames: string[];
  try {
    filenames = fsMarker
      .readdirSync(opts.learningsDir)
      .filter((f) => f.endsWith(".yaml"))
      .sort();
  } catch {
    return { committed: false, stampedIds: [], refused: [] }; // no corpus directory — nothing to stamp
  }
  const readFresh = opts.readFreshShardText ?? defaultFreshShardTextReader(opts.worktreePath);
  const stampedIds = new Set<string>();
  const refused: CitationBaselineRefusal[] = [];
  const touchedRelPaths: string[] = [];
  for (const filename of filenames) {
    const path = join(opts.learningsDir, filename);
    const relPath = relative(opts.worktreePath, path);
    const before = fsMarker.readFileSync(path, "utf8");
    let after = before;
    let fresh: string | undefined;
    let freshLoaded = false;
    for (const [id, stamp] of opts.changed) {
      if (extractEntryBlock(before, id) === undefined) continue; // id not in this shard
      const baseline = opts.baselines?.get(id);
      if (baseline !== undefined) {
        if (!freshLoaded) {
          fresh = readFresh(relPath);
          freshLoaded = true;
        }
        if (fresh !== undefined) {
          // A real fresh read — a genuine signal either way (design ii/iv). `fresh === undefined`
          // (no origin remote, offline, shard not yet on origin/main) means no signal at all —
          // fall through and stamp exactly as if no baseline had been supplied.
          const mismatch = compareCitationBaseline(id, baseline, extractEntryBlock(fresh, id));
          if (mismatch) {
            refused.push(mismatch);
            continue;
          }
        }
      }
      const next = stampCitationInShardText(after, id, stamp);
      if (next !== after) {
        after = next;
        stampedIds.add(id);
      }
    }
    if (after !== before) {
      fsMarker.writeFileSync(path, after, "utf8");
      touchedRelPaths.push(relPath);
    }
  }
  if (touchedRelPaths.length === 0) return { committed: false, stampedIds: [...stampedIds], refused };
  execFileSync("git", ["-C", opts.worktreePath, "add", ...touchedRelPaths]);
  try {
    execFileSync("git", ["-C", opts.worktreePath, "diff", "--cached", "--quiet"]);
    // exit 0 ⇒ nothing staged ⇒ content is unchanged from HEAD; nothing to commit.
    return { committed: false, stampedIds: [...stampedIds], refused };
  } catch {
    // non-zero ⇒ staged changes exist ⇒ commit them as their own, clearly-labeled commit.
    execFileSync("git", ["-C", opts.worktreePath, "commit", "-m", opts.commitMessage ?? CITATION_STAMP_COMMIT_MESSAGE]);
    const diff = execFileSync("git", ["-C", opts.worktreePath, "show", "--stat=200", "-p", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    return { committed: true, stampedIds: [...stampedIds], refused, diff };
  }
}

// ── The retro marker (state/last-retro.json) ──────────────────────────────

export interface RetroMarker {
  ts: string;
  learnings_count: number;
  runs_seen: number;
  /** W1-T89/P18: this cycle's `RetroGather.mast.byCategory`, carried forward so
   *  the NEXT retro's render can show a trend column. Optional/backward-compatible
   *  — a marker written before this field existed just yields no trend, never a
   *  parse failure (loadMarker below does no schema validation on this key). */
  mast_category_counts?: Record<string, number>;
}

/**
 * Thrown by loadMarker when state/last-retro.json EXISTS but fails to parse -- a torn
 * write, manual corruption, or a foreign format. This is DISTINCT from the marker
 * being genuinely absent (RetroMarker | undefined, the only legitimate
 * first-ever-retro signal): a corrupt-but-present marker must never be silently
 * collapsed into "no marker" the way the pre-fix reader did, because that replays the
 * whole already-consumed run window and double-counts SHIPPED/learnings. Every caller
 * MUST fail closed on this (abort the retro), never catch-and-treat-as-undefined.
 */
export class MarkerCorruptError extends Error {
  readonly markerPath: string;
  constructor(path: string, cause: unknown) {
    super(
      `retro marker at ${path} exists but is not parseable JSON (${String((cause as Error)?.message ?? cause)})` +
        " -- refusing to treat a corrupt marker as first-ever-retro (that would reprocess the whole" +
        " already-consumed run window and double-count SHIPPED/learnings); fix or remove it manually",
    );
    this.name = "MarkerCorruptError";
    this.markerPath = path;
  }
}

/**
 * Load the last-retro marker.
 *  - File absent (ENOENT)         -> undefined (the ONLY legitimate first-ever-retro signal).
 *  - File present, unparseable    -> throws MarkerCorruptError. NEVER undefined -- see the
 *                                     class doc for why collapsing this to undefined is the bug.
 *  - File present, parseable      -> the RetroMarker.
 */
export function loadMarker(path: string): RetroMarker | undefined {
  let raw: string;
  try {
    raw = fsMarker.readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(raw) as RetroMarker;
  } catch (e) {
    throw new MarkerCorruptError(path, e);
  }
}

/** The three states `resolveMarkerForGather` distinguishes for a retro caller. */
export type MarkerResolution =
  | { kind: "absent" }
  | { kind: "corrupt"; error: MarkerCorruptError }
  | { kind: "ok"; marker: RetroMarker };

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
export function resolveMarkerForGather(path: string): MarkerResolution {
  try {
    const marker = loadMarker(path);
    return marker === undefined ? { kind: "absent" } : { kind: "ok", marker };
  } catch (e) {
    if (e instanceof MarkerCorruptError) return { kind: "corrupt", error: e };
    throw e;
  }
}

/**
 * Save the last-retro marker as ONE atomic unit: staged into a same-directory temp
 * file with a single writeSync call, then swapped into place with a single
 * renameSync (atomic on any POSIX filesystem). A plain writeFileSync here would let
 * a reader (loadMarker) observe a torn/partial file mid-write and — pre-fix — that
 * torn read was misread as FIRST-EVER-RETRO, reprocessing the whole already-consumed
 * run window and double-counting SHIPPED/learnings. The rename swap makes that torn
 * state unreachable: a reader only ever sees the whole old file or the whole new one.
 */
export function saveMarker(path: string, marker: RetroMarker): void {
  fsMarker.mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const buf = Buffer.from(JSON.stringify(marker, null, 2) + "\n", "utf8");
  const fd = fsMarker.openSync(tmpPath, "w");
  try {
    const written = fsMarker.writeSync(fd, buf, 0, buf.length);
    if (written !== buf.length) {
      throw new Error(`short write staging ${tmpPath} for ${path} (${written}/${buf.length} bytes)`);
    }
  } finally {
    fsMarker.closeSync(fd);
  }
  fsMarker.renameSync(tmpPath, path);
}

// ── W1-T160: retro cadence trigger + integrity gate ────────────────────────
//
// The retro runs on an OPERATOR today (someone types `rmd retro`). This section
// makes it a LOOP: a pure TRIGGER predicate the daemon's poll evaluates against
// the marker (state/last-retro.json) — fire on merges-since-marker >= N OR
// days-since-marker >= D, whichever crosses first — plus an INTEGRITY GATE the
// AUTOMATED (unattended) path enforces before it ever writes: the gather must
// credit the window's merges, or the retro refuses to write (no PR, no marker
// advance). N/D are POLICY DATA (rule 2) — a caller changes the threshold by
// passing a different RetroTriggerPolicy, never a source edit.

/** Policy-data default: fire once at least this many merges have landed since
 *  the marker. Overridable via {@link RetroTriggerPolicy} — never hardcode a
 *  literal 25 at a call site. */
export const DEFAULT_RETRO_MERGES_THRESHOLD = 25;

/** Policy-data default: fire once at least this many days have elapsed since
 *  the marker, even with zero (or few) merges — a staleness floor so the retro
 *  still runs on a quiet week. Overridable via {@link RetroTriggerPolicy}. */
export const DEFAULT_RETRO_DAYS_THRESHOLD = 7;

/** Policy-as-data (rule 2) for the retro cadence trigger — same `?? DEFAULT`
 *  override shape daemon.ts's own headroom/backoff policy already uses
 *  (see e.g. `DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS`), not a bespoke pattern
 *  invented for this task. */
export interface RetroTriggerPolicy {
  mergesThreshold: number;
  daysThreshold: number;
  /**
   * W1-T2289 — OPTIONAL. Fire once at least this many unharvested `report.followups` candidates
   * are pending — the retro's OWN input depth, as distinct from `mergesThreshold`/
   * `daysThreshold`, which both describe the FLEET's shipped activity rather than what the retro
   * itself still has to process (this task's shared property). Undefined ⇒ reuses
   * `mergesThreshold`: both are "how much has piled up since the marker" counts of the same
   * rough order, and a genuinely distinct, measured number belongs in `plan/policy.yaml` as its
   * own reviewed follow-up (see this task's REPORT), not invented here without evidence.
   */
  followupsThreshold?: number;
}

export function defaultRetroTriggerPolicy(): RetroTriggerPolicy {
  return { mergesThreshold: DEFAULT_RETRO_MERGES_THRESHOLD, daysThreshold: DEFAULT_RETRO_DAYS_THRESHOLD };
}

export type RetroTriggerDecision =
  | { fire: false; mergesSinceMarker: number; daysSinceMarker: number; followupsPending?: number }
  | {
      fire: true;
      reason: "merges" | "days" | "followups";
      mergesSinceMarker: number;
      daysSinceMarker: number;
      followupsPending?: number;
    };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
export function evaluateRetroTrigger(
  mergesSinceMarker: number,
  markerTs: string | undefined,
  now: Date,
  policy: RetroTriggerPolicy = defaultRetroTriggerPolicy(),
  followupsPending = 0,
): RetroTriggerDecision {
  const daysSinceMarker = markerTs === undefined ? Infinity : (now.getTime() - Date.parse(markerTs)) / MS_PER_DAY;
  if (mergesSinceMarker >= policy.mergesThreshold) {
    return { fire: true, reason: "merges", mergesSinceMarker, daysSinceMarker, followupsPending };
  }
  if (daysSinceMarker >= policy.daysThreshold) {
    return { fire: true, reason: "days", mergesSinceMarker, daysSinceMarker, followupsPending };
  }
  const followupsThreshold = policy.followupsThreshold ?? policy.mergesThreshold;
  if (followupsPending >= followupsThreshold) {
    return { fire: true, reason: "followups", mergesSinceMarker, daysSinceMarker, followupsPending };
  }
  return { fire: false, mergesSinceMarker, daysSinceMarker, followupsPending };
}

export interface RetroIntegrityResult {
  ok: boolean;
  /** Present iff `!ok` — the loud, human-readable reason the automated retro refused to write. */
  reason?: string;
}

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
export function checkRetroIntegrity(priorMergesSinceMarker: number, gatherShippedCount: number): RetroIntegrityResult {
  if (priorMergesSinceMarker > 0 && gatherShippedCount === 0) {
    return {
      ok: false,
      reason:
        `retro integrity gate: the trigger observed ${priorMergesSinceMarker} merge(s) since the marker, ` +
        `but the gather credited 0 -- refusing to write (R8-class silent under-count, no human watching to catch it)`,
    };
  }
  return { ok: true };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── docs/ORIENTATION.md — the Architect handoff doc (W1-T39) ──────────────
//
// "A fresh Architect session should orient from ONE small doc, not re-derive
// state from a 900-line plan + a ledger." ORIENTATION.md states: current
// state, the next runnable task, and the never-do invariants. It is
// MAINTAINED BY `rmd retro` (never hand-edited) so it can never go stale —
// the retro already computes the gather and derives the next task from the
// SAME GitHub-projected status drain uses; this only renders it.

/** Normalise ONE physical line of a rule: drop the `**TITLE**` emphasis the Standing rules use
 *  (it reads oddly in the rendered list) and squeeze runs of whitespace. Pure text transform — no
 *  interpretation of meaning, and DELIBERATELY per-line: it never joins a line to its neighbour. */
function cleanRuleLine(s: string): string {
  return s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

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
function joinRuleLines(lines: string[]): string {
  const cleaned = lines.map(cleanRuleLine);
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === "") cleaned.pop();
  return cleaned.join("\n");
}

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
export function extractStandingRules(masterPlanMd: string): string[] {
  const lines = masterPlanMd.split("\n");
  const startIdx = lines.findIndex((l) => /^## 12\. Standing rules\s*$/.test(l));
  if (startIdx === -1) return [];
  let endIdx = lines.findIndex((l, i) => i > startIdx && /^## /.test(l));
  if (endIdx === -1) endIdx = lines.length;
  const section = lines.slice(startIdx + 1, endIdx);

  const rules: string[] = [];
  let current: string[] = [];
  const isRuleStart = (l: string) => /^\d+[A-Z]?\.\s+\S/.test(l);
  const isBullet = (l: string) => /^[-*]\s+\S/.test(l);
  const flush = (): void => {
    if (current.length > 0) rules.push(joinRuleLines(current));
    current = [];
  };
  for (const raw of section) {
    const line = raw.trim();
    if (isRuleStart(line)) {
      flush();
      current = [line];
    } else if (isBullet(line)) {
      // A markdown bullet (`- ...`) is NOT a numbered rule's wrapped continuation —
      // it marks trailing prose after the numbered list (e.g. this section's closing
      // notes on how MASTER-PLAN.md itself is maintained). Stop extracting: nothing
      // past the numbered list is a Standing rule, however this section is worded later.
      flush();
      break;
    } else if (current.length > 0) {
      // A continuation line — INCLUDING a blank one. Blanks before the first rule are still
      // ignored (nothing is open yet); inside a rule they are the paragraph breaks §12 writes.
      current.push(line);
    }
  }
  flush();
  return rules;
}

/** Everything {@link renderOrientation} needs to render docs/ORIENTATION.md. */
export interface OrientationInput {
  /** ISO timestamp of this retro run — injected by the caller (retro.ts is pure; it never calls Date itself). */
  generatedAt: string;
  /** The same deterministic gather the retro's plan-sync PR is built from. */
  gather: RetroGather;
  /** The next runnable task per the SAME DAG + GitHub-derived-status logic
   *  `rmd drain` dispatches from ({@link import("./drain.js").nextRunnable}) —
   *  `undefined` when nothing is currently runnable. */
  nextTask?: Task;
  /** MASTER-PLAN §12 Standing rules, extracted via {@link extractStandingRules}. */
  standingRules: string[];
}

/**
 * Render ONE standing rule as a markdown list item that KEEPS its own line breaks (W1-T2483):
 * the first line carries the bullet, and every continuation is indented two spaces so it stays
 * inside that item rather than becoming stray top-level prose. A blank line stays truly blank —
 * markdown reads an indented block after one as a further paragraph of the SAME item.
 */
function orientationBullet(rule: string): string[] {
  const [first, ...rest] = rule.split("\n");
  return [`- ${first}`, ...rest.map((l) => (l === "" ? "" : `  ${l}`))];
}

/**
 * Render docs/ORIENTATION.md: current state (the deterministic gather),
 * the next runnable task (DAG + GitHub-derived, matching `rmd drain`'s own
 * pick), and the never-do invariants (MASTER-PLAN §12, extracted verbatim).
 * Pure — no I/O; the caller writes the returned string to disk.
 */
export function renderOrientation(input: OrientationInput): string {
  const { gather, nextTask, standingRules } = input;
  const shippedLines = gather.shipped.length
    ? gather.shipped.map(
        (s) => `- ${s.taskId} → ${s.prUrl}${s.annotation ? ` (${s.annotation})` : ""}`,
      )
    : ["- (none since the last retro marker)"];
  const nextTaskBlock = nextTask
    ? [
        `**${nextTask.id}** — ${nextTask.title}`,
        "",
        `- risk: ${nextTask.risk ?? "medium"} · depends_on: ${nextTask.depends_on?.length ? nextTask.depends_on.join(", ") : "(none)"}`,
      ].join("\n")
    : "(none runnable right now — the DAG is exhausted, every remaining task is blocked/unmet, or awaits `verify: human`)";
  const invariantLines = standingRules.length
    ? standingRules.flatMap(orientationBullet)
    : ["- (none extracted — see MASTER-PLAN.md §12 Standing rules directly)"];

  return [
    "# ORIENTATION",
    "",
    `_MAINTAINED BY \`rmd retro\` — regenerated ${input.generatedAt}. Hand edits are overwritten on the` +
      " next retro; change MASTER-PLAN.md or plan/tasks.yaml instead, never this file directly._",
    "",
    "A fresh Architect session should be able to orient from THIS doc alone plus the plan index —",
    "not by re-deriving state from the full plan and ledger.",
    "",
    "## Current state",
    "",
    `${gather.totalRuns} run(s) since the last retro marker. Verdicts: ${JSON.stringify(gather.verdicts)}.`,
    "",
    "### Shipped since marker",
    ...shippedLines,
    "",
    "## Next runnable task",
    "",
    nextTaskBlock,
    "",
    "## Never-do invariants (MASTER-PLAN §12 Standing rules — extracted verbatim; §12 is authoritative)",
    "",
    ...invariantLines,
  ].join("\n");
}

// ── SHIPS-UNWIRED advisory floor — RETRO-TIME CONSUMER (W1-T322, design (iii)) ────────────

/** A backtick-quoted, function-shaped identifier a NET STATE sentence names — the retro-time
 *  mirror of review-time's `unwired_export` reason. DELIBERATELY NARROW (requires an internal
 *  case-transition or underscore): a bare CLI word (`` `rmd` ``, `` `main` ``) or a config key
 *  reads identically to a real export's name from punctuation alone, and this scan's own
 *  "silence, not a verdict" discipline (see {@link "./reachability.js".findExportDefinition}'s
 *  doc) means anything this pattern can't tell apart from ordinary prose is simply never
 *  considered — never a false claim, just nothing said about it. */
const BACKTICK_SYMBOL_RE = /`([a-zA-Z_][a-zA-Z0-9_]*)`/g;

function looksLikeSymbolName(name: string): boolean {
  return /[a-z][A-Z]|_/.test(name);
}

/** A short, human-legible window of `text` around `index` — collapsed whitespace, trimmed to
 *  roughly one sentence's worth either side, never the whole (often paragraph-length) NET STATE
 *  bullet. */
function snippetAround(text: string, index: number, radius = 140): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** One MASTER-PLAN NET STATE capability sentence naming a symbol {@link
 *  "./reachability.js".isExportReachable} reports as unreached — the retro-time `net_state_claim`
 *  reason code (see lib/review.ts's `ReviewVerdict.unwiredAdvisories` doc for the full set). */
export interface NetStateCapabilityAdvisory {
  symbol: string;
  file: string;
  snippet: string;
}

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
export function netStateCapabilityAdvisories(netStateText: string, checkoutDir: string): NetStateCapabilityAdvisory[] {
  const out: NetStateCapabilityAdvisory[] = [];
  const seen = new Set<string>();
  for (const m of netStateText.matchAll(BACKTICK_SYMBOL_RE)) {
    const symbol = m[1];
    if (!looksLikeSymbolName(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    const file = findExportDefinition(symbol, checkoutDir);
    if (!file) continue; // not a real export — silence, not a verdict
    if (isExportReachable(symbol, file, checkoutDir)) continue;
    out.push({ symbol, file, snippet: snippetAround(netStateText, m.index ?? 0) });
  }
  return out;
}

/** Render {@link netStateCapabilityAdvisories}'s findings as a retro-report section — printed
 *  alongside the plan-health sweep, never blocking anything (this whole floor is advisory-only
 *  by design; see lib/review.ts's `ReviewVerdict.unwiredAdvisories` doc for the full rationale). */
export function renderNetStateUnwiredAdvisories(advisories: NetStateCapabilityAdvisory[]): string {
  if (advisories.length === 0) {
    return "## SHIPS-UNWIRED — NET STATE capability claims\n\nNo NET STATE claim names a symbol this scan finds unreached.";
  }
  return [
    "## SHIPS-UNWIRED — NET STATE capability claims (ADVISORY ONLY, W1-T322)",
    "",
    "Each line below names a MASTER-PLAN NET STATE capability sentence whose named symbol has no",
    "caller this scan can find — never a verdict on the claim's truth, only a pointer to re-check it:",
    "",
    ...advisories.map((a) => `- \`${a.symbol}\` (${a.file}) — "${a.snippet}"`),
  ].join("\n");
}

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

/** One `not-shipped` phrase this rung recognises — MASTER-PLAN's own vocabulary for asserting a
 *  task/proposal is unbuilt (`Still PLANNED, not shipped` is covered by the `not shipped`
 *  alternative; the literal string is not its own pattern). No `g` flag — every use here is a
 *  single-shot `.test()` per line/clause, never a `.match()` loop, so global-flag `lastIndex`
 *  state is never at risk of leaking between calls. */
const NOT_SHIPPED_PHRASE_RE = /not shipped|unbuilt|did not ship/i;

/** A task id in either its full (`W1-T149`) or bare (`T342`) form — MASTER-PLAN's prose uses
 *  both. `g`-flagged and consumed ONLY via `String.prototype.match`, which resets `lastIndex`
 *  to 0 at the start of every call (spec-guaranteed), so reuse across clauses is safe. */
const TASK_ID_RE = /\b(?:W\d+-T\d+|T\d+)\b/g;

/** A proposal id (`P29`, `P29(i)`, `P43(ii)`) — deliberately NOT `g`-flagged: it is consumed
 *  only via `.test()` below, and a `g`-flagged regex used with repeated `.test()` calls carries
 *  `lastIndex` across them, silently alternating match/no-match. Presence-only; no capture of
 *  which proposal, since this rung's chosen handling (design (ii)) is to report the SKIPPED
 *  COUNT rather than resolve a proposal to the task ids that implement it. */
const PROPOSAL_ID_RE = /\bP\d+[A-Za-z]?(?:\([ivxlc]+\))?/i;

/** Strong clause delimiters this prose actually uses to separate an unbuilt phrase's subject
 *  from adjacent, unrelated data on the same line (see the P29(i) sibling-rejection example
 *  above). Deliberately narrow: an en-dash (`–`, distinct from the em-dash `—` here) or a comma
 *  is NOT a clause boundary in this corpus's usage and splitting on one would sever a bound
 *  assertion (e.g. `"W1-T149 did not ship"*, and the standing rule…"` keeps id and phrase in
 *  one clause across its trailing comma). */
const CLAUSE_SPLIT_RE = /[—;]/;

/** A bare `T\d+` is shorthand for `W1-T\d+` throughout this corpus (every measured occurrence
 *  — see the module doc above); a full `W\d+-T…` id is returned unchanged. */
function normalizeAssertedTaskId(raw: string): string {
  return /^W\d+-/.test(raw) ? raw : `W1-${raw}`;
}

/** {@link extractAssertedUnbuiltTaskIds}'s result: the bound-to-subject task ids (deduped,
 *  normalized), how many not-shipped-phrase-bearing lines were examined (the "size of the set
 *  examined" acceptance criterion 4 requires), and how many of those lines' bound subject is a
 *  proposal id rather than a task id (design (ii) — reported, never silently dropped). */
export interface AssertedUnbuiltExtraction {
  ids: string[];
  examinedLines: number;
  proposalOnlyLines: number;
}

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
export function extractAssertedUnbuiltTaskIds(masterPlanMd: string): AssertedUnbuiltExtraction {
  const ids = new Set<string>();
  let examinedLines = 0;
  let proposalOnlyLines = 0;
  for (const line of masterPlanMd.split("\n")) {
    if (!NOT_SHIPPED_PHRASE_RE.test(line)) continue;
    examinedLines++;
    let boundTaskId = false;
    let boundProposalOnly = false;
    for (const clause of line.split(CLAUSE_SPLIT_RE)) {
      if (!NOT_SHIPPED_PHRASE_RE.test(clause)) continue;
      const taskMatches = clause.match(TASK_ID_RE) ?? [];
      if (taskMatches.length > 0) {
        for (const m of taskMatches) ids.add(normalizeAssertedTaskId(m));
        boundTaskId = true;
        continue;
      }
      if (PROPOSAL_ID_RE.test(clause)) boundProposalOnly = true;
    }
    if (!boundTaskId && boundProposalOnly) proposalOnlyLines++;
  }
  return { ids: [...ids], examinedLines, proposalOnlyLines };
}

/** What the merge resolver the retro gather already holds (`projectPlan`'s batched GitHub
 *  read) reports for one task id — the same two fields {@link PlanHealthReport}'s caller
 *  already reads off `StatusProjection` (`merged`, `prUrl`), passed as a plain function so this
 *  rung stays keyed by raw STRING id rather than a `Task` object: a prose-extracted id may not
 *  even resolve to a known plan task (retired, renamed, or simply not in `plan/tasks.yaml`),
 *  and `undefined` here means exactly that — "the resolver has no opinion on this id", never
 *  "unmerged" (see design (iii)'s positive control, which this distinction exists to serve). */
export type PlanStateTruthResolver = (taskId: string) => { merged: boolean; prUrl?: string } | undefined;

/** One task id the plan asserts unbuilt while the resolver reports it merged — design (v):
 *  "name the false claim, not the count". */
export interface PlanStateTruthFinding {
  taskId: string;
  prUrl?: string;
}

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
export type PlanStateTruthReport =
  | { kind: "unavailable" }
  | { kind: "unexamined"; reason: string; examinedLines: number; proposalOnlyLines: number }
  | { kind: "clean"; examinedLines: number; proposalOnlyLines: number; idsChecked: number }
  | {
      kind: "findings";
      findings: PlanStateTruthFinding[];
      examinedLines: number;
      proposalOnlyLines: number;
      idsChecked: number;
    };

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
export function planStateTruthRung(masterPlanMd: string, resolve?: PlanStateTruthResolver): PlanStateTruthReport {
  if (!resolve) return { kind: "unavailable" };
  const { ids, examinedLines, proposalOnlyLines } = extractAssertedUnbuiltTaskIds(masterPlanMd);
  if (ids.length === 0) {
    return {
      kind: "unexamined",
      reason: `extraction yielded zero task ids across ${examinedLines} not-shipped-phrase-bearing line(s)`,
      examinedLines,
      proposalOnlyLines,
    };
  }
  const findings: PlanStateTruthFinding[] = [];
  let idsChecked = 0;
  for (const id of ids) {
    const resolution = resolve(id);
    if (!resolution) continue; // the resolver has no opinion on this id — not "unmerged"
    idsChecked++;
    if (resolution.merged) findings.push({ taskId: id, prUrl: resolution.prUrl });
  }
  if (idsChecked === 0) {
    return {
      kind: "unexamined",
      reason: `extracted ${ids.length} asserted-unbuilt id(s) but none resolved through the merge resolver at all`,
      examinedLines,
      proposalOnlyLines,
    };
  }
  if (findings.length > 0) return { kind: "findings", findings, examinedLines, proposalOnlyLines, idsChecked };
  return { kind: "clean", examinedLines, proposalOnlyLines, idsChecked };
}

/** Render {@link planStateTruthRung}'s report as a retro-report section — see that function's
 *  doc for the four states this renders distinctly. Printed ahead of the plan-health sweep
 *  (design (iv): a contradiction here outranks that advisory floor). */
export function renderPlanStateTruth(report: PlanStateTruthReport): string {
  const header = "## Plan-state truth rung — MASTER-PLAN unbuilt assertions vs. merge state (W1-T410)";
  if (report.kind === "unavailable") {
    return `${header}\n\nUNAVAILABLE — no merge resolver in hand this run; the rung did not scan. Distinct from a clean result: this run is not vouching for MASTER-PLAN's unbuilt assertions at all.`;
  }
  const scanned = `(examined ${report.examinedLines} not-shipped-phrase-bearing line(s); ${report.proposalOnlyLines} proposal-subject line(s) skipped — proposal-subject assertions are outside this rung's reach, reported here rather than silently dropped)`;
  if (report.kind === "unexamined") {
    return `${header}\n\nUNEXAMINED — ${report.reason} ${scanned}. Treat as a scan failure, never as a clean result.`;
  }
  if (report.kind === "clean") {
    return `${header}\n\nNo contradiction: ${report.idsChecked} asserted-unbuilt id(s) resolved through the merge resolver, all still unmerged, agreeing with the plan's assertion ${scanned}.`;
  }
  return [
    header,
    "",
    `BLOCKING — the plan asserts ${report.findings.length} id(s) unbuilt that the merge resolver reports MERGED (this outranks the plan-health sweep below for KICK ORDER purposes — design (iv)):`,
    "",
    ...report.findings.map(
      (f) =>
        `- ${f.taskId}: MASTER-PLAN asserts UNBUILT, the merge resolver reports MERGED${f.prUrl ? ` via ${f.prUrl}` : " (no PR url on record)"}`,
    ),
    "",
    scanned,
  ].join("\n");
}

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
/** What the caller found trying to LIST `plan/tasks.d/` — `ok: true` with every shard entry it
 *  read, or `ok: false` with a stated reason it could not list the directory at all (see {@link
 *  planCoherenceRung}'s doc for why this is `unexamined` and not folded into a zero-shard
 *  `clean` result). A discriminated union rather than `T[] | { reason }` because `Array.isArray`
 *  does not reliably narrow a `readonly T[] | object` union. */
export type PlanCoherenceShardListing =
  | { ok: true; entries: readonly PlanCoherenceShardEntry[] }
  | { ok: false; reason: string };

export type PlanCoherenceReport =
  | { kind: "unexamined"; reason: string }
  | { kind: "clean"; shardsExamined: number; monolithRecordsExamined: number }
  | {
      kind: "findings";
      findings: PlanCoherenceFinding[];
      shardsExamined: number;
      monolithRecordsExamined: number;
    };

/**
 * THE RUNG (W1-T2642 design, mirroring W1-T410's shape). Re-derives, on every retro cycle, the
 * question "does plan/tasks.yaml and plan/tasks.d/*.yaml disagree about which tasks EXIST" that
 * NET STATE has carried as unmeasured prose for fourteen cycles — see this task's rationale for
 * the full "harvest (a)" history. Calls {@link scanPlanCoherence} (plan-coherence.ts, this
 * rung's ONLY consumer) with the monolith blob and every shard entry the caller read off disk.
 *
 * `shards` carries `{ ok: false, reason }` exactly when the caller could not
 * LIST `plan/tasks.d/` at all (a permissions error, say — NOT the back-compat "directory does
 * not exist yet" case {@link "./plan.js".loadPlan}'s own `listShardFiles` tolerates by reading
 * as an empty listing, which this rung also reads as zero shards examined, not unexamined) —
 * `unexamined`, never a silent `clean` render over a scan that never actually ran (P48: never a
 * bare zero indistinguishable from a check that did not run).
 */
export function planCoherenceRung(
  monolith: { path: string; text: string },
  shards: PlanCoherenceShardListing,
): PlanCoherenceReport {
  if (!shards.ok) {
    return { kind: "unexamined", reason: `plan/tasks.d/ could not be listed: ${shards.reason}` };
  }
  const scan = scanPlanCoherence(monolith, shards.entries);
  const counts = { shardsExamined: scan.shardsExamined, monolithRecordsExamined: scan.monolithRecordsExamined };
  if (scan.findings.length === 0) return { kind: "clean", ...counts };
  return { kind: "findings", findings: scan.findings, ...counts };
}

/** One {@link PlanCoherenceFinding} rendered as a single markdown bullet — one clause per
 *  finding kind, naming both disagreeing values and the path(s) involved. */
function renderPlanCoherenceFinding(f: PlanCoherenceFinding): string {
  switch (f.kind) {
    case "filename-id-mismatch":
      return `- ${f.path}: filename id "${f.filenameId}" disagrees with the record id inside it, "${f.recordId}"`;
    case "filing-count":
      return `- ${f.path}: holds ${f.recordCount} task record(s) (${f.recordIds.join(", ") || "none"}), expected exactly 1`;
    case "unparseable-path":
      return `- ${f.path}: does not match the plan/tasks.d/<id>-<slug>.yaml convention shardSlugFromPath expects — invisible to the duplicate-title corpus and every git log --grep recipe`;
    case "cross-file-duplicate":
      return `- ${f.id}: held by BOTH ${f.firstPath} and ${f.secondPath}`;
  }
}

/** Render {@link planCoherenceRung}'s report as a retro-report section — see that function's
 *  doc for the three states this renders distinctly. NEVER A BARE ZERO (P48): a clean corpus
 *  states the counts it examined, so a check that did not run is distinguishable from one that
 *  passed. */
export function renderPlanCoherence(report: PlanCoherenceReport): string {
  const header = "## Plan-coherence rung — filename id vs. record id, one-task-per-file (W1-T2642)";
  if (report.kind === "unexamined") {
    return `${header}\n\nUNEXAMINED — ${report.reason}. Treat as a scan failure, never as a clean result.`;
  }
  const scanned = `${report.shardsExamined} shard(s) and ${report.monolithRecordsExamined} monolith record(s) examined`;
  if (report.kind === "clean") {
    return `${header}\n\nNo disagreements: ${scanned}, zero filename/record-id or one-task-per-file disagreements.`;
  }
  return [
    header,
    "",
    `${report.findings.length} disagreement(s) found (${scanned}):`,
    "",
    ...report.findings.map(renderPlanCoherenceFinding),
  ].join("\n");
}

/**
 * Convenience composition — {@link renderPlanCoherence}(`planCoherenceRung`(…)) — for a caller
 * with the monolith blob and shard listing already in hand. NO production caller today (only
 * its own test exercises it) — the genuine live wiring is `buildGather`/`renderGather` above,
 * called unconditionally every `rmd retro` cycle, entirely inside this file. `retroCommand`
 * (src/run-task.ts, outside this task's declared scope) populating `opts.planCoherence` with a
 * real `plan/tasks.yaml`/`plan/tasks.d/` read is the one remaining, named follow-up.
 */
export function planCoherenceSectionFor(
  monolith: { path: string; text: string },
  shards: PlanCoherenceShardListing,
): string {
  return renderPlanCoherence(planCoherenceRung(monolith, shards));
}
