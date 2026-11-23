import { threadName } from "./thread-names.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";
import { bundledWorkerUrl } from "./child-entry-argv.js";

import { fixedClock, systemClock, type Clock } from "./clock.js";
import { aggregateCacheHitTotals, deriveKnowledgeBudgetCap, measureKnowledgeBudgetPressure, TRIVIAL_DROPPED_WEIGHT_CHARS, type CacheHitTokens, type KnowledgeBudgetDerivation } from "./digest.js";
import {
  cohortGuardMetrics,
  cohortGuardObservations,
  EXPERIMENT_PROMOTION_VERSION,
  enterCanary,
  findScopeConflict,
  isPromotionActive,
  stepCanary,
  type CanaryStep,
  type CohortOutcome,
  type GuardObservation,
  type PromotionGuardMetric,
  type PromotionRecord,
} from "./experiment-promotion.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import { promotionCeiling, promotionFloor } from "./promotion-bars.js";
import { escapeGrepLiteral, renderAcceptanceBlock } from "./plan-pr-emitter.js";
import { parseWhitelistedProof } from "./review.js";
import { JUDGE_SHADOW_STEPS, judgeShadowSummary, type JudgeShadowRoleSummary } from "./judge-shadow.js";
import { scoreTypedAnswers, type TypedAnswer, type TypedAnswerRow, type TypedAnswerScoreGroup } from "./typed-answer-scores.js";
import { openWeightCandidatesForCapability, openWeightCapabilityForRequestedModel, type ModelSurface } from "./worker-provider.js";
import { gardenNeedsInventory, gardenPassDue, landedPrUrl, gardenStatePath, judgeGardenDecision, readGardenState, runGardenAsync, type GardenAction, type GardenCheckout, type GardenPassResult, type GardenSpec, type GardenerDeps, type PrState } from "./gardener.js";
import { buildEntryWeightIndex, DEFAULT_KNOWLEDGE_BUDGET_CHARS, loadLearningsCorpus } from "./learnings.js";
import type { LedgerLine } from "./ledger.js";
import { ledgerRotationEntries, openLedgerUnion, readLedgerUnionRecordsSync } from "./ledger-union.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import type { BillingMode } from "./env.js";
import {
  RANDOMISED_ESTIMATE_STEP,
  RANDOMISED_EXPERIMENT_STEP,
  randomisedMountRecommendations,
  recommendMounts,
  type AdoptMountRecommendation,
  type MountHeadroomCell,
  type MountRecommendation,
  type RandomisedFinding,
  type RandomisedMountRecommendation,
  type RandomisedRow,
} from "./mount-recommender.js";
import { loadMounts, mountsPath, type JudgeShadowOnlyRole } from "./mounts.js";
import { loadPlan } from "./plan.js";
import { planShards } from "./plan-gardener.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { ROUTING_EXPERIMENTS, type RoutingExperiment } from "./routing-experiments.js";
import { GATHER_RUNS_LEDGER_STEPS, gatherRuns, type LedgerRecord, type RunSummary } from "./retro.js";
import { loadCreditStore } from "./status.js";
import { deriveTaskClass } from "./task-class.js";

/**
 * lib/config-gardener.ts (W1-T4113) — worker configuration tends itself.
 *
 * Worker configuration was set once and never judged: declared `budget_usd` sat far above what
 * implement runs cost, mount recommendations waited in the inbox, and the learnings character cap
 * was derived once (2026-08-23). This gardener (a gardener.ts spec) changes each of those from its
 * own measurements, one class per pass:
 *   - RECALIBRATE-BUDGET: queued shards of one task class get `budget_usd` from that class's observed
 *     implement cost distribution (p90 with headroom for the between-turn overshoot) — no fixed floor.
 *   - ADOPT-MOUNT: a mount recommendation that cleared the recommender's evidence gates is written into
 *     its route in the mounts table (mounts.ts's `mountsPath`). W1-T12143: only a concluded randomised
 *     winner ({@link randomisedRecommendationSource}) reaches it ({@link configCandidates}): its provider on
 *     every auctioned routes row it covers.
 *   - RE-DERIVE-CAP: the learnings character cap is re-derived from the spawns measured UNDER the
 *     current cap, with the same two functions that derived it (digest.ts).
 *   - MOVE-JUDGE-TO-CASH (W1-T12187): a judge whose cash shadow cleared {@link JUDGE_CASH_BAR} gets `provider: cash`
 *     on its own one-line row in the mounts table. W1-T12417: when one shadow model of a role clears
 *     {@link JUDGE_SWITCH_BAR} on W1-T12414's per-model scores, the same edit if it is a cash model cash serves that row
 *     with, or, for a decision model, the role's `judge_shadows` line made `{ primary, threshold }`.
 *   - RETUNE-RESTART (W1-T12232): the freshness restart's `scoreLimit` or `stalenessHorizonMs` row in plan/policy.yaml
 *     moves one step from the measured waiting and restart costs of the last restart cycles ({@link restartTuneEvidence}).
 *
 * EVERY CHANGE IS A CANARY (experiment-promotion.ts). It is chosen only when its SHADOW evidence — what
 * it was derived from, read before anything is exposed — clears its guard. Its PR opening puts it in
 * shadow; the merge exposes it; from then on each pass compares the canary COHORT with the REST by
 * merge rate and cost per merged task ({@link cohortGuardObservations}). A budget cohort is a random
 * subset of the class's queued shards and the rest is the same class's other tasks over the same
 * window; a mount's or the cap's change reaches everything it routes, so its rest is the same
 * population over the equal window BEFORE exposure. A guardrail breach rolls the change back (a PR
 * reverting exactly its edits) and DEBITS the class; a promotion CREDITS it. Those verdicts settle
 * the gardener's pending class here ({@link tendConfigCanaries}), so the framework's metric for these
 * classes never moves on its own — the canary is the judge, never a second opinion.
 */

export type ConfigGardenClass = "recalibrate-budget" | "adopt-mount" | "re-derive-cap" | "move-judge-to-cash" | "retune-restart";
export const CONFIG_GARDEN_CLASSES: readonly ConfigGardenClass[] = ["recalibrate-budget", "adopt-mount", "re-derive-cap", "move-judge-to-cash", "retune-restart"];

/** One whole-line replacement in a repo file. A rollback swaps `from` and `to`. */
export interface ConfigEdit {
  path: string;
  /** W1-T12143: a block row's lines, joined by newlines, are one `from`, which its one-line `to` replaces. */
  from: string;
  to: string;
  /** W1-T12143: how many identical `from` spans the edit replaces, every one of them; absent, exactly one. Two
   *  routes rows with identical lines name the same class, model, effort and provider, so evidence covers both or
   *  neither, and one edit replaces both or neither. */
  occurrences?: number;
}

/** Who a canary exposes. `tasks`: named shards against the same class's other tasks, concurrently.
 *  `cell`/`cells`/`all`: every run it routes, against the same population over the equal window before.
 *  `cells` (W1-T12143) is the routes rows one randomised candidate edits. */
export type ConfigCohort = { kind: "tasks"; taskClass: string; taskIds: string[] } | { kind: "cell"; type: string; risk: string; taskClass: string }
  | { kind: "cells"; cells: RandomisedRow[] } | { kind: "all" };

export interface ConfigGardenAction extends GardenAction<ConfigGardenClass> {
  scope: string;
  edits: ConfigEdit[];
  cohort: ConfigCohort;
  candidate: string;
  baseline: string;
  /** Fraction of the scope the canary exposes, in (0, 1]. */
  exposure: number;
  shadowMetrics: PromotionGuardMetric[];
  shadowObservations: GuardObservation[];
  /** W1-T4711: `neverWorked` runs kept out of the class sample this action was derived from; absent when none. */
  excludedCount?: number;
  /** W1-T6466: runs of unknown cost (`costSource: "none"`) kept out of the class costs; absent when none. */
  unpriced?: number;
}

export interface ConfigCanary {
  promotion: PromotionRecord;
  actionClass: ConfigGardenClass;
  prUrl: string;
  cohort: ConfigCohort;
  edits: ConfigEdit[];
  shadowMetrics: PromotionGuardMetric[];
  shadowObservations: GuardObservation[];
  exposedAt?: string;
  rollbackPrUrl?: string;
  reason?: string;
}

export interface QueuedBudget {
  id: string;
  taskClass: string;
  budgetUsd: number;
  /** Repo-relative shard path and its exact `budget_usd:` line. */
  shard: string;
  line: string;
}

/** A run as the canaries measure it. `mountClass` is the routes row class its first `run.start` resolved
 *  (`mount_class`), which differs from its task class on a routed lane such as `routine` (W1-T12143). */
export type ConfigRun = RunSummary & { mountClass?: string };

export interface ConfigInventory {
  nowIso: string;
  runs: ConfigRun[];
  queued: QueuedBudget[];
  recommendations: AdoptMountRecommendation[];
  cap?: { current: number; derivation: KnowledgeBudgetDerivation };
  /** W1-T12187: each judge role's cash shadow record over {@link JUDGE_CASH_BAR}'s window. */
  judgeShadows?: JudgeShadowRoleSummary[];
  /** W1-T12417: W1-T12414's scores of each role's shadow models over the same window, one group per role, model and surface. */
  judgeShadowScores?: TypedAnswerScoreGroup[];
  /** W1-T12417: the least top-option probability each decision model clears the bar at, per role ({@link judgeShadowThresholds}). */
  judgeShadowThresholds?: JudgeShadowThreshold[];
  /** W1-T12232: the two freshness restart rows, when they last changed, and the `daemon.restart_cycle` rows. */
  restart?: RestartTuneInput;
  active: ConfigCanary[];
  /** Scopes whose canary was rolled back or declined within {@link CANARY_TTL_MS}: re-proposing the same
   *  change on the next pass would only repeat the verdict. */
  cooling: string[];
}

/** Where the gardener reads. Every field has a production default; a test supplies its own. */
export interface ConfigGardenSources {
  ledgerRows?: () => Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>;
  mountRecommendations?: () => AdoptMountRecommendation[] | Promise<AdoptMountRecommendation[]>;
  entryWeights?: () => Record<string, number> | Promise<Record<string, number>>;
}

export const CONFIG_GARDEN_NAME = "config";
/** Budgets carry this headroom over the class p90: `maxBudgetUsd` is checked between turns, so a run
 *  overshoots its budget by up to one turn (learnings#maxbudget-between-turns). */
export const BUDGET_HEADROOM = 1.5;
/** Below this many settled implement runs a class's p90 is noise, and it is not recalibrated. */
export const BUDGET_MIN_SAMPLES = 20;
/** A declared budget within this fraction of the derived one is left alone. */
export const BUDGET_MIN_CHANGE = 0.25;
/** BACKSTOP: past p90×headroom, at most this share of the class's history may have overrun the new
 *  budget. By construction under a tenth does, so this fires only when the derivation itself is wrong. */
export const BUDGET_MAX_SHADOW_OVERRUN = 0.1;
/** W1-T12232: the three numbers of the restart rule, new and unmeasured (2026-11-23). A proposal reads the last this many
 *  complete restart cycles since either row last changed, */
export const RESTART_TUNE_ROWS = 20;
/** moves only when one median cost is at least this many times the other, */
export const RESTART_TUNE_FACTOR = 1.5;
/** and moves its row by this fraction of its value. */
export const RESTART_TUNE_STEP = 0.25;
/** Every canary needs this many tasks on BOTH sides before it is judged (experiment-promotion's floor). A promotion bar,
 *  so it is scripts/promotion-floors-baseline.json's `canaryMinTasksPerSide` (src/lib/promotion-bars.ts). */
export const CANARY_DENOMINATOR_FLOOR = promotionFloor("canaryMinTasksPerSide");
/** PRIMARY CONTROL on exposure: a budget canary changes at most this many shards at once. */
export const CANARY_MAX_COHORT = 10;
export const CANARY_TTL_MS = 21 * 24 * 3600 * 1000;
/** How often the ledger union is re-read for planning: every tick would read it every poll. */
export const CONFIG_GARDEN_BUCKET_MS = 6 * 3600 * 1000;
/** How often the open canaries are judged. */
export const CONFIG_TEND_INTERVAL_MS = 3600 * 1000;
/** W1-T12187: what a judge's cash shadow must show before its row moves to cash. The three numbers are new and
 *  unmeasured (2026-11-17): the sample floor, the least agreement and the most calls with no usable answer. They are
 *  promotion bars, read from scripts/promotion-{floors,ceilings}-baseline.json (src/lib/promotion-bars.ts). */
export const JUDGE_CASH_BAR = { windowMs: 14 * 24 * 3600 * 1000, minPaired: promotionFloor("judgeMinPaired"),
  minAgreeShare: promotionFloor("judgeMinAgreeShare"), maxNoAnswerShare: promotionCeiling("judgeMaxNoAnswerShare") } as const;
/** W1-T12417: the per-model bar. The first three numbers are {@link JUDGE_CASH_BAR}'s; the Brier ceiling is new and
 *  unmeasured (2026-11-17: no shadow answer has a known outcome yet). It applies to a model with a Brier figure; a
 *  single answer has none (W1-T12414), and is judged on agreement. */
export const JUDGE_SWITCH_BAR = { minCompared: JUDGE_CASH_BAR.minPaired, minAgreeShare: JUDGE_CASH_BAR.minAgreeShare,
  maxNoAnswerShare: JUDGE_CASH_BAR.maxNoAnswerShare, maxBrier: promotionCeiling("judgeMaxBrier") } as const;
/** W1-T12417: judges that fail closed. No gardener proposal moves their primary off the subscription. */
export const FAIL_CLOSED_JUDGE_ROLES: ReadonlySet<string> = new Set(["risk-judge"]);
/** The mounts-table row of each shadowed role. */
export const JUDGE_ROLE_ROWS: Readonly<Record<string, "risk_judge" | "feedback_summary" | "ci_judge" | "fix_progress_judge">> = {
  "risk-judge": "risk_judge", "decision-summary": "feedback_summary", "ci-judge": "ci_judge", "fix-progress": "fix_progress_judge",
};
/** W1-T13501: the judge rows that fail closed (risk-judge.ts escalates when it cannot answer; ruling-judge.ts has
 *  FAIL_CLOSED_RULING_VERDICT). The gardener never moves one to cash, and the fail-closed guard test reads this list. */
export const FAIL_CLOSED_JUDGE_ROWS = ["risk_judge", "ruling_judge"] as const;
/** W1-T13501: one flow-map line with at most one nested mapping, e.g. `ci_judge: { ..., shadow: { ... } }`. */
const ONE_LINE_ROW = /^\w+: \{(?:[^{}]|\{[^{}]*\})*\}\s*$/;

/** W1-T13501: `line` with `provider: cash` before its top-level `shadow:` key, or before its last brace. */
function withCashProvider(line: string): string {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "{") depth++;
    else if (line[i] === "}") depth--;
    else if (depth === 1 && line.startsWith("shadow:", i) && /[{,\s]/.test(line[i - 1] ?? "")) return `${line.slice(0, i)}provider: cash, ${line.slice(i)}`;
  }
  return line.replace(/\s*\}\s*$/, ", provider: cash }");
}

export function configCanariesPath(stateDir: string): string {
  return join(stateDir, "config-gardener-canaries.json");
}

interface ConfigCanaryFile {
  canaries: ConfigCanary[];
  /** When the open canaries were last judged: judging reads the ledger union, so it is paced. */
  lastTendMs?: number;
}

export function readConfigCanaryFile(stateDir: string): ConfigCanaryFile {
  const path = configCanariesPath(stateDir);
  if (!existsSync(path)) return { canaries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ConfigCanaryFile>;
    return { canaries: Array.isArray(parsed?.canaries) ? parsed.canaries : [], ...(typeof parsed?.lastTendMs === "number" ? { lastTendMs: parsed.lastTendMs } : {}) };
  } catch (e) {
    // Reading it as empty would forget an exposed canary, which could then never be rolled back — so the
    // pass stops here and names the file in `config.gardener_failed` until a person repairs it.
    throw new Error(`config gardener: unreadable ${path}: ${String((e as Error)?.message ?? e)}`);
  }
}

export const readConfigCanaries = (stateDir: string): ConfigCanary[] => readConfigCanaryFile(stateDir).canaries;

export function writeConfigCanaries(stateDir: string, canaries: ConfigCanary[], lastTendMs?: number): void {
  const keep = lastTendMs ?? readConfigCanaryFile(stateDir).lastTendMs;
  writeAtomic(configCanariesPath(stateDir), JSON.stringify({ canaries: canaries.slice(-50), ...(keep !== undefined ? { lastTendMs: keep } : {}) }, null, 2) + "\n");
}

// ── Measurement ──────────────────────────────────────────────────────────────────────────────

/** Nearest-rank percentile. */
export function nearestRank(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

/** p90 × headroom, rounded UP to the half dollar. No floor: a class that costs little gets a small budget. */
export function recalibratedBudget(costs: number[]): number {
  return Math.ceil(nearestRank(costs, 90) * BUDGET_HEADROOM * 2) / 2;
}

const settledImplement = (r: RunSummary) => r.type === "implement" && r.verdict !== "incomplete";

/** Settled implement costs per class, `neverWorked` runs skipped and counted per class (W1-T4711):
 *  a $0 refusal is no sample of what the class costs. */
export function settledClassCosts(runs: RunSummary[]): { byClass: Map<string, number[]>; excluded: Map<string, number>; unpriced: Map<string, number> } {
  const byClass = new Map<string, number[]>();
  const excluded = new Map<string, number>();
  const unpriced = new Map<string, number>();
  for (const r of runs.filter(settledImplement)) {
    const key = r.taskClass ?? "unknown";
    if (r.neverWorked) excluded.set(key, (excluded.get(key) ?? 0) + 1);
    else if (r.costSource === "none") unpriced.set(key, (unpriced.get(key) ?? 0) + 1); // W1-T6466: unknown, not $0
    else byClass.set(key, [...(byClass.get(key) ?? []), r.costUsd]);
  }
  return { byClass, excluded, unpriced };
}

/** Distinct settled tasks among `runs`, how many merged, and their summed cost; a `neverWorked` run
 *  is no canary outcome, only `excludedCount` (W1-T4726). */
export function cohortOutcome(runs: RunSummary[]): CohortOutcome & { excludedCount?: number } {
  const tasks = new Map<string, boolean>();
  const pricedTasks = new Set<string>();
  let costUsd = 0;
  let excludedCount = 0;
  let unpriced = 0;
  for (const r of runs) {
    if (r.verdict === "incomplete") continue;
    if (r.neverWorked) { excludedCount++; continue; }
    tasks.set(r.taskId, (tasks.get(r.taskId) ?? false) || r.verdict === "merged");
    // W1-T6466: an unpriced run keeps its merge outcome but adds no cost; its $0 is unknown, not free.
    if (r.costSource === "none") { unpriced++; continue; }
    pricedTasks.add(r.taskId);
    costUsd += r.costUsd;
  }
  const merged = [...tasks.values()].filter(Boolean).length;
  const pricedMerged = [...tasks].filter(([id, m]) => m && pricedTasks.has(id)).length;
  return {
    tasks: tasks.size,
    merged,
    costUsd: unpriced > 0 && pricedTasks.size === 0 ? null : costUsd,
    ...(unpriced > 0 ? { unpriced, pricedMerged } : {}),
    ...(excludedCount > 0 ? { excludedCount } : {}),
  };
}

/** The canary cohort's runs and the rest's, per {@link ConfigCohort}, since `exposedAt`; `neverWorked`
 *  runs join neither side and are counted as `excludedCount` (W1-T4726). */
export function splitCohort(cohort: ConfigCohort, runs: ConfigRun[], exposedAt: string, nowIso: string): { canary: RunSummary[]; rest: RunSummary[]; excludedCount?: number } {
  const since = Date.parse(exposedAt);
  const at = (r: RunSummary) => Date.parse(r.startTs);
  const inWindow = (canary: RunSummary[], rest: RunSummary[]) => {
    const excludedCount = [...canary, ...rest].filter((r) => r.neverWorked).length;
    return { canary: canary.filter((r) => !r.neverWorked), rest: rest.filter((r) => !r.neverWorked), ...(excludedCount > 0 ? { excludedCount } : {}) };
  };
  if (cohort.kind === "tasks") {
    const ids = new Set(cohort.taskIds);
    const after = runs.filter((r) => settledImplement(r) && r.taskClass === cohort.taskClass && at(r) >= since);
    return inWindow(after.filter((r) => ids.has(r.taskId)), after.filter((r) => !ids.has(r.taskId)));
  }
  const cells = cohort.kind === "cells" ? cohort.cells : cohort.kind === "cell" ? [cohort] : [];
  // A routes row serves the runs that resolved to it: its class is the run's mount class, where the run logged one.
  const inScope = (r: ConfigRun) => cohort.kind === "all" ? r.type === "implement"
    : cells.some((c) => r.type === c.type && r.risk === c.risk && (r.mountClass ?? r.taskClass) === c.taskClass);
  const before = since - Math.max(0, Date.parse(nowIso) - since);
  const scoped = runs.filter((r) => inScope(r) && r.verdict !== "incomplete");
  return inWindow(scoped.filter((r) => at(r) >= since), scoped.filter((r) => at(r) >= before && at(r) < since));
}

function population(cohort: ConfigCohort): string {
  if (cohort.kind === "tasks") return `implement tasks of class ${cohort.taskClass}`;
  if (cohort.kind === "cell") return `${cohort.type} runs at ${cohort.risk} risk of class ${cohort.taskClass}`;
  if (cohort.kind === "cells") return `runs of the routes rows ${cohort.cells.map((c) => `${c.type}/${c.risk}/${c.taskClass}`).join(", ")}`;
  return "implement runs";
}

// ── Inventory ────────────────────────────────────────────────────────────────────────────────

export function queuedBudgets(repoRoot: string, stateDir: string): QueuedBudget[] {
  const plan = loadPlan(resolveRepoLayout(repoRoot).planMonolith);
  const credited = loadCreditStore(join(stateDir, "merge-credit.json"));
  const shards = planShards(repoRoot);
  const out: QueuedBudget[] = [];
  for (const t of plan.tasks) {
    const shard = shards.get(t.id);
    if (t.status !== "queued" || t.retirement || credited[t.id] || t.type !== "implement" || t.budget_usd === undefined || !shard) continue;
    const line = /^ {2}budget_usd: \S+[ \t]*$/m.exec(readFileSync(join(repoRoot, shard), "utf8"))?.[0];
    if (line) out.push({ id: t.id, taskClass: deriveTaskClass(t), budgetUsd: t.budget_usd, shard, line });
  }
  return out;
}

/** The cap re-derived from `learnings.injected` rows measured UNDER `current` — rows from an older cap
 *  measure that cap's pressure, and adding them to this one would ratchet it upward forever. */
export function capDerivation(rows: Array<Record<string, unknown>>, weights: Record<string, number>, current: number): KnowledgeBudgetDerivation {
  const underCurrent = rows.filter((r) => r.step !== "learnings.injected" || r.budget_chars === current) as LedgerLine[];
  const totals = aggregateCacheHitTotals(underCurrent);
  const mix = totals
    ? Object.values(totals.byClass).reduce<CacheHitTokens>((s, g) => ({ cacheRead: s.cacheRead + g.cacheRead, input: s.input + g.input, cacheCreation: s.cacheCreation + g.cacheCreation }), { cacheRead: 0, input: 0, cacheCreation: 0 })
    : undefined;
  return deriveKnowledgeBudgetCap(measureKnowledgeBudgetPressure(underCurrent, weights), mix, current);
}

/** W1-T5474: every step the inventory's consumers read. MEASURED 2026-10-03 on the live corpus: unfiltered, the
 *  60-day read held 2.85M rows at a 3,163 MB heap peak; filtered, 79,826 rows at 211 MB, and the runs and cap
 *  derivation over the 60-day rotations were identical either way. With no verdict line (a ledger credit can
 *  still settle the run) `gatherRuns` takes a run's FIRST `pr_url` row of any step, so each step carrying one
 *  inside a run is listed, and (W1-T5526) prices it from its worker rows only; `aggregateCacheHitTotals`
 *  folds every tokened call row. */
export const CONFIG_GARDEN_LEDGER_STEPS: readonly string[] = [
  // gatherRuns, by name, and its pr_url fallback.
  ...GATHER_RUNS_LEDGER_STEPS,
  // capDerivation: the knowledge-budget pressure, and the cache-hit mix's call rows.
  "learnings.injected", "review.reviewer", "inbox.draft_synthesized", "triage.synthesized", "retro.synthesized",
  "retro.preflight_repair", "fix.done", "fix.contract_hold", "fix.commit_line_answered", "census_push.strike", "plan.synthesized", "diagnose.worker_done",
  // W1-T5668: the rest that can be a worker run's first pr_url row (0 live rows on 2026-10-04, listed so a first one is read).
  "acceptance.repair.unrepresentable", "changeset_claim.repaired", "retro.pr.recovered", "pr.body_normalize.error",
  "pr.body_normalize.raced",
  // W1-T11756: the history guard turns a SUCCESS back to FAILURE after the run's own pr.opened; its receipt is read.
  "review.history_guarded",
  // W1-T14235: a refused code pass writes its receipt with the PR it refused.
  "review.semantic_pass_refused",
  // Automatic follow-up filing records the originating PR on this worker-priced receipt.
  "followup.filed",
  // W1-T12187: the judges' cash shadow rows, for judgeShadowSummary.
  ...JUDGE_SHADOW_STEPS,
];

// W1-T12232: the retune-restart class's inputs, read by the inventory. Declared before the measurement worker's entry
// below, which runs at module load.

/** W1-T12232: the step whose rows price one freshness restart cycle (src/lib/restart-cycle.ts). It is read beside
 *  {@link CONFIG_GARDEN_LEDGER_STEPS}, not inside it: that list is what gatherRuns and the cap price, and two census
 *  suites pin it to exactly those readers. */
export const RESTART_CYCLE_STEP = "daemon.restart_cycle";
export const RESTART_TUNE_LEDGER_STEPS: readonly string[] = [RESTART_CYCLE_STEP];
/** The policy file the two rows live in (W1-T12228 writes each row on one line). */
export const RESTART_POLICY_PATH = "plan/policy.yaml";
export type RestartPolicyRowName = "scoreLimit" | "stalenessHorizonMs";
const RESTART_POLICY_ROWS: readonly RestartPolicyRowName[] = ["scoreLimit", "stalenessHorizonMs"];

export interface RestartPolicyRow {
  name: RestartPolicyRowName;
  /** The whole line, the `from` of the one edit. */
  line: string;
  /** 1-based, for `git blame -L`. */
  lineNumber: number;
  value: number;
  min: number;
  max: number;
}

export interface RestartTuneInput {
  rows: RestartPolicyRow[];
  /** When the last commit changed either row. Absent when it is unknown, and then `unknownChange` says why. */
  changedAtMs?: number;
  unknownChange?: string;
  cycles: Array<Record<string, unknown>>;
}

/** What one pass measured, and the proposal when there is one. `reason` always says why there is or is not one. */
export interface RestartTuneEvidence {
  /** Complete rows counted: later than the last change, with a first verdict and both cost parts. At most {@link RESTART_TUNE_ROWS}. */
  rows: number;
  /** Rows later than the last change, with a first verdict, of which a cost part is null. Never counted. */
  nullPartRows: number;
  waitingMedianMs?: number;
  restartMedianMs?: number;
  stalenessReleased?: number;
  row?: RestartPolicyRow;
  to?: number;
  reason: string;
}

/** The one-line `scoreLimit` and `stalenessHorizonMs` rows of the `freshnessRestart:` block. A row that is absent, not
 *  on one line, or listed twice is not returned: one edit replaces one line. */
export function restartPolicyRows(text: string): RestartPolicyRow[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^freshnessRestart:\s*$/.test(line));
  if (start < 0) return [];
  const found = new Map<RestartPolicyRowName, RestartPolicyRow[]>();
  for (let i = start + 1; i < lines.length && /^\s/.test(lines[i]!); i++) {
    const line = lines[i]!;
    const m = /^ {2}(\w+): \{([^{}]*)\}\s*$/.exec(line);
    const name = m?.[1] as RestartPolicyRowName | undefined;
    if (!m || !name || !RESTART_POLICY_ROWS.includes(name)) continue;
    const num = (key: string): number => Number(new RegExp(`(?:^|[\\s,])${key}: (-?[0-9.]+)`).exec(m[2]!)?.[1] ?? NaN);
    const row = { name, line, lineNumber: i + 1, value: num("value"), min: num("min"), max: num("max") };
    if ([row.value, row.min, row.max].every(Number.isFinite)) found.set(name, [...(found.get(name) ?? []), row]);
  }
  return RESTART_POLICY_ROWS.flatMap((name) => (found.get(name)?.length === 1 ? found.get(name)! : []));
}

export type GitRun = (args: string[]) => Promise<string>;
/** The hardened leaf (W1-T6123), awaited: the inventory runs on the measurement worker, yet a synchronous call here would
 *  count against the daemon loop (W1-T12952). A checkout it cannot pin throws, and the caller keeps that as the reason. */
const blameGit = (repoRoot: string): GitRun => (args) => hostWorktreeGitAsync(repoRoot, args, { timeout: 60_000, log: () => {} });

/** When the last commit changed any of `lineNumbers` in plan/policy.yaml, from `git blame`. A line with uncommitted
 *  edits blames to now, so no cycle is later than it. A checkout git cannot blame gives no time and its reason. */
export async function restartPolicyChangedAt(repoRoot: string, lineNumbers: readonly number[], git: GitRun = blameGit(repoRoot)): Promise<{ ms: number } | { error: string }> {
  if (lineNumbers.length === 0) return { error: `${RESTART_POLICY_PATH} holds no one-line freshnessRestart row` };
  let out: string;
  try {
    out = await git(["blame", "--porcelain", ...lineNumbers.flatMap((n) => ["-L", `${n},${n}`]), "--", RESTART_POLICY_PATH]);
  } catch (error) {
    return { error: `git blame of ${RESTART_POLICY_PATH} failed: ${String((error as Error)?.message ?? error).split("\n")[0]}` };
  }
  const times = [...out.matchAll(/^committer-time (\d+)$/gm)].map((m) => Number(m[1]) * 1000);
  return times.length ? { ms: Math.max(...times) } : { error: `git blame of ${RESTART_POLICY_PATH} named no committer time` };
}

async function restartTuneInput(repoRoot: string, ledgerRows: readonly Record<string, unknown>[]): Promise<RestartTuneInput> {
  const rows = restartPolicyRows(readFileIfExists(join(repoRoot, RESTART_POLICY_PATH)) ?? "");
  const changed = await restartPolicyChangedAt(repoRoot, rows.map((r) => r.lineNumber));
  return { rows, ...("ms" in changed ? { changedAtMs: changed.ms } : { unknownChange: changed.error }), cycles: ledgerRows.filter((r) => r.step === RESTART_CYCLE_STEP) };
}

/** W1-T12232: what the measurement worker's own read asks for: the priced steps and the restart cycle rows. */
export const CONFIG_GARDEN_READ_STEPS: readonly string[] = [...CONFIG_GARDEN_LEDGER_STEPS, ...RESTART_TUNE_LEDGER_STEPS];

/** W1-T5474: the 60-day union read bounded to `steps`, by default {@link CONFIG_GARDEN_LEDGER_STEPS}. An incomplete
 *  union fails the pass rather than pricing budgets from a partial history. */
export function readConfigGardenLedgerRows(stateDir: string, reader: typeof readLedgerUnionRecordsSync = readLedgerUnionRecordsSync, steps: readonly string[] = CONFIG_GARDEN_LEDGER_STEPS): Array<Record<string, unknown>> {
  const read = reader(stateDir, { rotationWindowMs: 60 * 24 * 3600 * 1000, minRotations: 4, step: steps, refuseIncomplete: true });
  if (!read.ok) throw new Error(`config gardener: incomplete ledger union: ${read.unread.join(", ")}`);
  return read.rows;
}

/** Ledger reads, plan loading and derivation run on a one-shot worker, including injected snapshots. */
export async function configInventory(deps: GardenerDeps, sources: ConfigGardenSources = {}, reader?: typeof readLedgerUnionRecordsSync): Promise<ConfigInventory> {
  const [rows, weights, recommendations] = await Promise.all([
    sources.ledgerRows?.() ?? (reader ? readConfigGardenLedgerRows(deps.stateDir, reader) : undefined),
    sources.entryWeights?.(),
    sources.mountRecommendations?.() ?? [],
  ]);
  return configMeasurementOffLoop<ConfigInventory>({
    kind: "inventory", stateDir: deps.stateDir, repoRoot: deps.repoRoot,
    nowMs: (deps.clock ?? systemClock).now(), rows, weights, recommendations,
  });
}

interface InventoryMeasurement {
  kind: "inventory";
  stateDir: string;
  repoRoot: string;
  nowMs: number;
  rows?: Array<Record<string, unknown>>;
  weights?: Record<string, number>;
  recommendations: AdoptMountRecommendation[];
}

type ConfigMeasurement = InventoryMeasurement | { kind: "mount"; stateDir: string; sweepScript: string };
type MeasurementReply = { ok: true; value: ConfigInventory | MountSweep } | { ok: false; reason: string };
type MountSweep = { cells: MountHeadroomCell[]; corpus?: { unread: string[] } };
const CONFIG_MEASUREMENT_WORKER_KIND = "remudero-config-measurement";

const HEAP_FLAG = /^--max[-_]old[-_]space[-_]size(?:=(.*))?$/;

/**
 * The measurement worker's options for a process started with `execArgv`. The garden child runs
 * with `--max-old-space-size=<mb>` (garden-registry), and a Worker refuses V8 heap flags in its own
 * execArgv, so passing `process.execArgv` through made 46 of 66 config passes fail with "invalid
 * execArgv flags". The worker inherits its execArgv instead (the loader comes with it, and Node
 * 24's test runner adds per-process flags a Worker also refuses), and the old-generation budget
 * the heap flag carried becomes `resourceLimits.maxOldGenerationSizeMb`. Last flag wins, as in V8.
 */
export function measurementWorkerOptions(execArgv: readonly string[]): { resourceLimits?: { maxOldGenerationSizeMb: number } } {
  let budgetMb: number | undefined;
  for (let index = 0; index < execArgv.length; index += 1) {
    const match = HEAP_FLAG.exec(execArgv[index]!);
    if (!match) continue;
    const value = match[1] ?? execArgv[index + 1];
    if (match[1] === undefined) index += 1;
    const mb = Number(value);
    if (Number.isFinite(mb) && mb > 0) budgetMb = mb;
  }
  return budgetMb === undefined ? {} : { resourceLimits: { maxOldGenerationSizeMb: budgetMb } };
}

/** A worker failure refuses this measurement; it never falls back to reading on the event loop. */
/** bundlemain: a bundled daemon starts this worker from its own worker bundle (bundledWorkerUrl); a tsx parent from
 *  this module's URL, as before. Its .ts source cannot load in a worker of a bundled main, which has no tsx loader. */
export function configMeasurementOffLoop<T>(input: ConfigMeasurement, workerUrl: URL = bundledWorkerUrl(import.meta.url)): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { name: threadName("configMeasure"), workerData: { kind: CONFIG_MEASUREMENT_WORKER_KIND, input }, ...measurementWorkerOptions(process.execArgv) });
    worker.once("message", (reply: MeasurementReply) => {
      void worker.terminate();
      if (reply.ok) resolve(reply.value as T);
      else reject(new Error(reply.reason));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`config gardener: measurement worker exited before answering (code ${code})`)));
  });
}

/** Named worker body so tests can also exercise the read and error replies in the instrumented thread. */
export async function serveConfigMeasurement(input: ConfigMeasurement, port: { postMessage(reply: MeasurementReply): void }): Promise<void> {
  try {
    let value: ConfigInventory | MountSweep;
    if (input.kind === "inventory") value = await buildConfigInventory(input);
    else {
      const m = await tsImport(pathToFileURL(input.sweepScript).href, import.meta.url) as { buildMountHeadroomSweep: (stateDir: string) => MountSweep };
      value = await cachedMountHeadroomSweep(input.stateDir, input.sweepScript, m.buildMountHeadroomSweep);
    }
    port.postMessage({ ok: true, value });
  } catch (e) {
    port.postMessage({ ok: false, reason: String((e as Error)?.message ?? e) });
  }
}

if (!isMainThread && workerData?.kind === CONFIG_MEASUREMENT_WORKER_KIND) void serveConfigMeasurement(workerData.input, parentPort!);

/** Each run with the `mount_class` of its first `run.start`, the row `gatherRuns` reads its task class from. */
function withMountClass(runs: RunSummary[], rows: readonly Record<string, unknown>[]): ConfigRun[] {
  const started = new Set<string>();
  const mountClass = new Map<string, string>();
  for (const row of rows) {
    if (row.step !== "run.start" || typeof row.run_id !== "string" || started.has(row.run_id)) continue;
    started.add(row.run_id);
    if (typeof row.mount_class === "string") mountClass.set(row.run_id, row.mount_class);
  }
  return runs.map((r) => (mountClass.has(r.runId) ? { ...r, mountClass: mountClass.get(r.runId)! } : r));
}

async function buildConfigInventory(input: InventoryMeasurement): Promise<ConfigInventory> {
  // The worker's own read is the production one, and it adds the restart cycle rows (W1-T12232); injected rows are used as given.
  const rows = input.rows ?? readConfigGardenLedgerRows(input.stateDir, readLedgerUnionRecordsSync, CONFIG_GARDEN_READ_STEPS);
  const weights = input.weights ?? buildEntryWeightIndex(loadLearningsCorpus(resolveRepoLayout(input.repoRoot).learningsDir));
  const canaries = readConfigCanaries(input.stateDir);
  return {
    nowIso: fixedClock(input.nowMs).iso(),
    runs: withMountClass(gatherRuns(rows as LedgerRecord[]), rows),
    queued: queuedBudgets(input.repoRoot, input.stateDir),
    recommendations: input.recommendations,
    cap: { current: DEFAULT_KNOWLEDGE_BUDGET_CHARS, derivation: capDerivation(rows, weights, DEFAULT_KNOWLEDGE_BUDGET_CHARS) },
    judgeShadows: judgeShadowSummary(rows, input.nowMs - JUDGE_CASH_BAR.windowMs),
    judgeShadowScores: scoreTypedAnswers(judgeShadowTypedAnswers(rows, input.nowMs - JUDGE_CASH_BAR.windowMs)).groups,
    judgeShadowThresholds: judgeShadowThresholds(rows, input.nowMs - JUDGE_CASH_BAR.windowMs),
    restart: await restartTuneInput(input.repoRoot, rows),
    active: canaries.filter((c) => isPromotionActive(c.promotion.state)),
    cooling: canaries.filter((c) => c.promotion.state === "rolled_back" && input.nowMs - Date.parse(c.promotion.createdAt) < CANARY_TTL_MS).map((c) => c.promotion.scope.policyScope),
  };
}

/** Archive metadata, covering both rotation forms. Live appends wait for the next rotation; before
 *  the first rotation, live metadata prevents a first-boot sweep from being cached forever. */
function mountSweepKey(stateDir: string, sweepScript: string): string {
  const rotations = ledgerRotationEntries(readdirSync(stateDir), stateDir).map((entry) => entry.path);
  const paths = [sweepScript, ...(rotations.length ? rotations : [join(stateDir, LEDGER_FILENAME)])];
  return JSON.stringify(paths.map((path) => {
    const stat = existsSync(path) ? statSync(path) : undefined;
    return [path, stat?.size, stat?.mtimeMs, stat?.ctimeMs];
  }));
}

export const configMountSweepCachePath = (stateDir: string): string => join(stateDir, "config-mount-headroom-sweep.json");

/** Persist cells, not recommendations: mounts and billing mode are re-evaluated on every pass. A
 *  missing, malformed or obsolete disposable cache is rebuilt, and incomplete sweeps are never saved. */
export async function cachedMountHeadroomSweep(stateDir: string, sweepScript: string, build: (stateDir: string) => MountSweep | Promise<MountSweep>): Promise<MountSweep> {
  const key = mountSweepKey(stateDir, sweepScript);
  const path = configMountSweepCachePath(stateDir);
  const raw = readFileIfExists(path);
  if (raw !== undefined) {
    let cached: { version?: number; key?: string; cells?: MountHeadroomCell[] } | undefined;
    try { cached = JSON.parse(raw); } catch { /* Disposable JSON corruption requires a new sweep. */ }
    if (cached?.version === 1 && cached.key === key && Array.isArray(cached.cells) && cached.cells.every((c) =>
      c && typeof c.cellKey === "string" && Array.isArray(c.arms) && Array.isArray(c.comparisons))) return { cells: cached.cells };
  }
  const sweep = await build(stateDir);
  const corpusIsReadable = sweep.corpus === undefined || sweep.corpus.unread.length === 0;
  if (corpusIsReadable && mountSweepKey(stateDir, sweepScript) === key) {
    writeAtomic(path, JSON.stringify({ version: 1, key, cells: sweep.cells }) + "\n");
  }
  return { cells: sweep.cells };
}

/** Mount recommendations as the gardener reads them: the recommender's own gates over the headroom
 *  sweep, kept to the recommendations. A sweep that cannot be built (no runs yet) is logged and reads as
 *  none, so the other classes still act. */
export function mountRecommendationSource(opts: {
  build?: (stateDir: string) => { cells: MountHeadroomCell[] } | Promise<{ cells: MountHeadroomCell[] }>;
  sweepScript: string;
  stateDir: string;
  mountsFile: string;
  billingMode: BillingMode;
  log: GardenerDeps["log"];
}): () => Promise<MountRecommendation[]> {
  return async () => {
    try {
      const sweep = opts.build
        ? await cachedMountHeadroomSweep(opts.stateDir, opts.sweepScript, opts.build)
        : await configMeasurementOffLoop<{ cells: MountHeadroomCell[] }>({ kind: "mount", stateDir: opts.stateDir, sweepScript: opts.sweepScript });
      const outcomes = recommendMounts(sweep.cells, loadMounts(opts.mountsFile), { billingMode: opts.billingMode });
      return outcomes.filter((o): o is MountRecommendation => o.kind === "recommendation");
    } catch (e) {
      opts.log(`${CONFIG_GARDEN_NAME}.mount_recommendations_unread`, { error: String((e as Error)?.message ?? e) });
      return [];
    }
  };
}

/** W1-T12143: the ledger row a randomised winner the mounts table cannot express is reported as, once per evidence day. */
export const RANDOMISED_FINDING_STEP = `${CONFIG_GARDEN_NAME}.randomised_finding`;
/** Both producers write one row per experiment or cell per UTC day, a terminal result unchanged on each later day,
 *  so the newest row of every live one is days old at most; the inventory's own read spans the same 60 days. */
const RANDOMISED_EVIDENCE_DAYS = 60;

const findingKey = (step: unknown, id: unknown, day: unknown, setting: unknown): string => JSON.stringify([step, id, day, setting]);

/**
 * W1-T12143: the second source of adopt-mount candidates, beside {@link mountRecommendationSource}: the newest
 * `routing.experiment.result` row of each experiment and `routing.policy.estimate` row of each cell, streamed from
 * the ledger union as routing-policy-estimate.ts's recorder streams it, and mapped by
 * `randomisedMountRecommendations` (mount-recommender.ts). A winner the table cannot express is logged as
 * {@link RANDOMISED_FINDING_STEP} naming the setting that can, once per evidence day, and so (W1-T14305) is a winner
 * no covered routes row can take, naming those rows ({@link randomisedNoEditFindings}). An unread archive, live file
 * or directory refuses the read: a missing file could hold an experiment's newest row and let a superseded one
 * propose. A failed read is logged and proposes nothing.
 */
export function randomisedRecommendationSource(opts: {
  stateDir: string;
  mountsFile: string;
  log: GardenerDeps["log"];
  /** The host's `workerProviders.codexModel`: what a `provider: codex` routes row runs (mount-recommender.ts `RandomisedHost`). */
  codexModel: string | undefined;
  /** The experiments a result's arms are mapped through; the live list when absent. */
  experiments?: readonly RoutingExperiment[];
}): () => Promise<RandomisedMountRecommendation[]> {
  return async () => {
    try {
      const unread: string[] = [];
      const rows: Array<Record<string, unknown>> = [];
      const sinceTs = fixedClock(systemClock.now() - RANDOMISED_EVIDENCE_DAYS * 24 * 3600 * 1000).iso();
      for await (const row of openLedgerUnion(opts.stateDir, {
        step: [RANDOMISED_EXPERIMENT_STEP, RANDOMISED_ESTIMATE_STEP, RANDOMISED_FINDING_STEP], sinceTs,
        onUnreadArchive: (path) => unread.push(path), onUnreadLive: (path) => unread.push(path), onUnreadDirectory: (path) => unread.push(path),
      })) rows.push(row);
      if (unread.length > 0) throw new Error(`incomplete ledger union: ${unread.join(", ")}`);
      const outcomes = randomisedMountRecommendations(rows, loadMounts(opts.mountsFile), opts.experiments ?? ROUTING_EXPERIMENTS, { codexModel: opts.codexModel });
      const written = new Set(rows.filter((r) => r.step === RANDOMISED_FINDING_STEP).map((r) => findingKey(r.evidence_step, r.evidence_id, r.day, r.setting)));
      // W1-T14305: a winner no covered row can take is a finding too, through the same once-per-evidence-day key.
      const noEdit = randomisedNoEditFindings(outcomes.recommendations, readFileSync(opts.mountsFile, "utf8"));
      for (const f of [...outcomes.findings, ...noEdit]) {
        if (written.has(findingKey(f.step, f.id, f.day, f.setting))) continue;
        opts.log(RANDOMISED_FINDING_STEP, { evidence_step: f.step, evidence_id: f.id, day: f.day, setting: f.setting, detail: f.detail });
      }
      return outcomes.recommendations;
    } catch (e) {
      opts.log(`${CONFIG_GARDEN_NAME}.randomised_recommendations_unread`, { error: String((e as Error)?.message ?? e) });
      return [];
    }
  };
}

// ── Candidates ───────────────────────────────────────────────────────────────────────────────

const usd = (n: number) => n.toFixed(2);

function shuffled<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The class whose queued budgets are furthest from its observed costs, as one canary over a random
 *  cohort of them. The cohort is at most half the mismatched shards, so the rest can judge it. */
export function budgetCandidate(inv: ConfigInventory, rng: () => number): ConfigGardenAction | undefined {
  const { byClass, excluded, unpriced } = settledClassCosts(inv.runs);
  let best: { taskClass: string; costs: number[]; budget: number; off: QueuedBudget[] } | undefined;
  for (const [taskClass, costs] of [...byClass].sort(([a], [b]) => a.localeCompare(b))) {
    if (costs.length < BUDGET_MIN_SAMPLES) continue;
    const budget = recalibratedBudget(costs);
    if (budget <= 0) continue;
    const off = inv.queued.filter((q) => q.taskClass === taskClass && Math.abs(q.budgetUsd - budget) / q.budgetUsd >= BUDGET_MIN_CHANGE);
    if (off.length >= 2 * CANARY_DENOMINATOR_FLOOR && (!best || off.length > best.off.length)) best = { taskClass, costs, budget, off };
  }
  if (!best) return undefined;
  const size = Math.min(CANARY_MAX_COHORT, Math.max(CANARY_DENOMINATOR_FLOOR, Math.floor(best.off.length / 2)));
  const cohort = shuffled(best.off, rng).slice(0, size).sort((a, b) => a.id.localeCompare(b.id));
  const inClass = inv.queued.filter((q) => q.taskClass === best!.taskClass).length;
  const overrun = best.costs.filter((c) => c > best!.budget).length / best.costs.length;
  const cohortPop = population({ kind: "tasks", taskClass: best.taskClass, taskIds: [] });
  const excludedCount = excluded.get(best.taskClass) ?? 0;
  const unpricedCount = unpriced.get(best.taskClass) ?? 0;
  return {
    class: "recalibrate-budget",
    target: best.taskClass,
    scope: `budget:${best.taskClass}`,
    reason: `class ${best.taskClass}: p90 of ${best.costs.length} settled implement runs is $${usd(nearestRank(best.costs, 90))}; ${best.off.length} queued shard(s) declare a budget ${Math.round(BUDGET_MIN_CHANGE * 100)}%+ away from $${usd(best.budget)}.${excludedCount > 0 ? ` ${excludedCount} never-worked run(s) excluded.` : ""}${unpricedCount > 0 ? ` unpriced: ${unpricedCount} run(s) of unknown cost excluded.` : ""}`,
    edits: cohort.map((q) => ({ path: q.shard, from: q.line, to: `  budget_usd: ${usd(best!.budget)}` })),
    cohort: { kind: "tasks", taskClass: best.taskClass, taskIds: cohort.map((q) => q.id) },
    candidate: `budget_usd ${usd(best.budget)} for ${cohort.length} queued ${best.taskClass} shard(s)`,
    baseline: `declared budget_usd on those shards (${cohort.map((q) => usd(q.budgetUsd)).join(", ")})`,
    exposure: Math.min(1, cohort.length / Math.max(inClass, 1)),
    shadowMetrics: [{ metricName: "shadow_overrun_rate", unit: "fraction", direction: "max", abortThreshold: BUDGET_MAX_SHADOW_OVERRUN }],
    shadowObservations: [{ metricName: "shadow_overrun_rate", value: overrun, denominator: best.costs.length, freshness: "verified", comparisonPopulation: cohortPop, observedAt: inv.nowIso }],
    ...(excludedCount > 0 ? { excludedCount } : {}),
    ...(unpricedCount > 0 ? { unpriced: unpricedCount } : {}),
  };
}

/** The `routes.<type>.<risk>.<class>` flow-map line in a mounts.yaml text, or undefined. */
export function routeLine(text: string, type: string, risk: string, taskClass: string): string | undefined {
  const lines = text.split("\n");
  const c = routeIndex(lines, type, risk, taskClass);
  return c < 0 || !/\{.*\bmodel:.*\beffort:.*\}/.test(lines[c]!) ? undefined : lines[c];
}

/** The index of the `routes.<type>.<risk>.<class>` key line, or -1. */
function routeIndex(lines: readonly string[], type: string, risk: string, taskClass: string): number {
  const at = (from: number, indent: number, key: string) => {
    for (let i = from; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const lead = line.length - line.trimStart().length;
      if (lead < indent) return -1;
      if (lead === indent && line.trimStart().startsWith(`${key}:`)) return i;
    }
    return -1;
  };
  const routes = lines.findIndex((l) => l === "routes:");
  const t = routes < 0 ? -1 : at(routes + 1, 2, type);
  const r = t < 0 ? -1 : at(t + 1, 4, risk);
  return r < 0 ? -1 : at(r + 1, 6, taskClass);
}

/**
 * W1-T12143: a block-mapping routes row (`<class>:`, then one `key: value` line per field) as one exact edit: its
 * lines, rewritten as the one-line flow map the table's other rows use, with `provider: <provider>` last. Undefined
 * for a block holding anything but plain scalar fields at one indent (a comment, a blank line, a nested or quoted
 * value), so no text is lost. A blank line ends the block only where the next line leaves it.
 */
function blockRowEdit(lines: readonly string[], c: number, provider: string): { from: string; to: string } | undefined {
  const key = /^( *)([^\s:#]+):\s*$/.exec(lines[c]!);
  if (!key) return undefined;
  const indent = key[1]!.length;
  const lead = (line: string) => line.length - line.trimStart().length;
  const fields: string[] = [];
  let end = c + 1;
  let fieldLead: number | undefined;
  for (; end < lines.length; end++) {
    const line = lines[end]!;
    if (line.trim() === "") {
      const next = lines.slice(end + 1).find((l) => l.trim() !== "");
      if (next === undefined || lead(next) <= indent) break;
      return undefined;
    }
    if (lead(line) <= indent) break;
    const field = /^ +([a-z_]+): +([^\s#,{}[\]'"]+) *$/.exec(line);
    if (!field || (fieldLead ?? lead(line)) !== lead(line)) return undefined;
    fieldLead = lead(line);
    fields.push(`${field[1]}: ${field[2]}`);
  }
  if (!fields.some((f) => f.startsWith("model: ")) || !fields.some((f) => f.startsWith("effort: "))) return undefined;
  return { from: lines.slice(c, end).join("\n"), to: `${key[1]}${key[2]}: { ${fields.join(", ")}, provider: ${provider} }` };
}

/** The exact edit that puts `provider` on a routes row (its flow-map line, or {@link blockRowEdit}), or why not. */
function providerEdit(lines: readonly string[], row: RandomisedRow, provider: string): { from: string; to: string } | string {
  const c = routeIndex(lines, row.type, row.risk, row.taskClass);
  if (c >= 0 && /\{.*\bmodel:.*\beffort:.*\}/.test(lines[c]!)) return { from: lines[c]!, to: withProvider(lines[c]!, provider) };
  return (c < 0 ? undefined : blockRowEdit(lines, c, provider)) ?? "not a row one exact edit can name";
}

/** The start of each run of `lines` equal to `span`'s lines, left to right, never overlapping. */
function spanStarts(lines: readonly string[], span: string): number[] {
  const want = span.split("\n");
  const starts: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (!want.every((w, k) => lines[i + k] === w)) continue;
    starts.push(i);
    i += want.length - 1;
  }
  return starts;
}

/** `lines` with the `span` at each of `starts` replaced by `to`'s lines. */
function replaceSpans(lines: readonly string[], starts: readonly number[], span: string, to: string): string[] {
  const out = [...lines];
  for (const i of [...starts].reverse()) out.splice(i, span.split("\n").length, ...to.split("\n"));
  return out;
}

/** `line`, a one-line flow-map row, with `provider: <provider>` as its last key, ahead of any trailing comment. */
function withProvider(line: string, provider: string): string {
  const close = line.replace(/\s+#.*$/, "").lastIndexOf("}");
  return `${line.slice(0, close).trimEnd()}, provider: ${provider} ${line.slice(close)}`;
}

/** A routes row's name as a finding or a reason names it: `routes.<type>.<risk>.<class>`. */
const routesRowName = (row: RandomisedRow): string => `routes.${row.type}.${row.risk}.${row.taskClass}`;

/**
 * W1-T12143, W1-T14305: which routes rows `rec` covers that one exact edit can name in the mounts table `text`, as
 * edits without their path, and each other row with why it was left alone. {@link randomisedMountCandidate} reads it
 * with the lines open canaries hold; {@link randomisedNoEditFindings} with none, so a row is reported only for the
 * table's own shape.
 */
function randomisedRowEdits(rec: RandomisedMountRecommendation, text: string, held: ReadonlySet<string>): {
  edits: Array<{ from: string; to: string; occurrences?: number }>;
  cells: RandomisedRow[];
  left: Array<{ row: string; reason: string }>;
} {
  const lines = text.split("\n");
  const byFrom = new Map<string, { to: string; rows: RandomisedRow[] }>();
  const left: Array<{ row: string; reason: string }> = [];
  for (const row of rec.rows) {
    const edit = providerEdit(lines, row, rec.randomised.winner.provider);
    if (typeof edit === "string") left.push({ row: routesRowName(row), reason: edit });
    else if (held.has(edit.from)) left.push({ row: routesRowName(row), reason: "an open canary holds its line" });
    else byFrom.set(edit.from, { to: edit.to, rows: [...(byFrom.get(edit.from)?.rows ?? []), row] });
  }
  const edits: Array<{ from: string; to: string; occurrences?: number }> = [];
  const cells: RandomisedRow[] = [];
  const count = (line: string, within: readonly string[]) => within.filter((l) => l === line).length;
  for (const [from, { to, rows }] of byFrom) {
    const occurrences = spanStarts(lines, from).length;
    const own = from.split("\n");
    // The revert proves a restored block by a line of it no other row holds.
    const witnessed = own.some((line) => count(line, lines) === occurrences * count(line, own));
    if (occurrences !== rows.length || lines.includes(to) || !witnessed) {
      left.push(...rows.map((row) => ({ row: routesRowName(row), reason: "its line is not one this edit can name exactly" })));
      continue;
    }
    edits.push({ from, to, ...(occurrences > 1 ? { occurrences } : {}) });
    cells.push(...rows);
  }
  return { edits, cells, left };
}

/**
 * W1-T14305, invariant no-silent-randomised-winner: each randomised recommendation that no covered routes row of the
 * mounts table `text` can take, as one finding on its evidence (step, id and day). `setting` names every covered row,
 * comma-joined, and `detail` each row's reason, so a winner the table could express never proposes nothing in silence.
 * A recommendation with one editable row is a candidate ({@link randomisedMountCandidate}) and no finding.
 */
export function randomisedNoEditFindings(recs: readonly RandomisedMountRecommendation[], text: string): RandomisedFinding[] {
  const findings: RandomisedFinding[] = [];
  for (const rec of recs) {
    const { edits, left } = randomisedRowEdits(rec, text, new Set());
    if (edits.length > 0 || left.length === 0) continue;
    const e = rec.randomised;
    findings.push({
      step: e.step,
      id: e.id,
      day: e.day,
      setting: left.map((l) => l.row).join(","),
      detail: `${rec.cellKey} concluded ${e.winner.label} on ${e.winner.provider}, but no routes row it covers is one exact edit can ` +
        `name: ${left.map((l) => `${l.row} (${l.reason})`).join("; ")}. Write a covered row as a one-line flow map, or move it by hand.`,
    });
  }
  return findings;
}

/**
 * W1-T12143: one randomised winner as one canary: the winner's provider on every routes row it covers that one
 * exact edit can name ({@link providerEdit}). A row an open canary holds (either side of its edit) is left alone, so
 * two canaries never edit one row; so is a row whose identical rows are not all covered, whose edited line is
 * already in the file, or (a block row) none of whose lines is its own — each would leave a revert that cannot
 * tell its row apart. The shadow guard is the winner's own advantage bound, above zero by its producer's decision.
 */
function randomisedMountCandidate(rec: RandomisedMountRecommendation, inv: ConfigInventory, text: string, path: string): ConfigGardenAction | undefined {
  const e = rec.randomised;
  const held = new Set(inv.active.flatMap((c) => c.edits.filter((edit) => edit.path === path).flatMap((edit) => [edit.from, edit.to])));
  const rowEdits = randomisedRowEdits(rec, text, held);
  if (rowEdits.edits.length === 0) return undefined;
  const edits: ConfigEdit[] = rowEdits.edits.map((edit) => ({ path, ...edit }));
  const cells = rowEdits.cells;
  const left = rowEdits.left.map((l) => `${l.row} (${l.reason})`);
  const cohort: ConfigCohort = { kind: "cells", cells };
  const where = `${e.capability}/${e.effort}${e.taskClass === undefined ? "" : `/${e.taskClass}`}`;
  return {
    class: "adopt-mount",
    target: rec.cellKey,
    scope: `mount:${rec.cellKey}`,
    reason: `${rec.note} Each auctioned routes row it covers takes provider ${e.winner.provider}.${left.length > 0 ? ` Left alone: ${left.join("; ")}.` : ""}`,
    edits,
    cohort,
    candidate: `provider ${e.winner.provider} on ${cells.length} routes row(s) at ${where}`,
    baseline: `the headroom auction between claude and codex on those rows`,
    exposure: 1,
    shadowMetrics: [{ metricName: "randomised_advantage_low", unit: "fraction", direction: "min", abortThreshold: 0 }],
    shadowObservations: [{ metricName: "randomised_advantage_low", value: e.advantageLow, denominator: e.minTasks, freshness: "verified", comparisonPopulation: population(cohort), observedAt: inv.nowIso }],
  };
}

/** The first recommendation whose route exists and would change. The sweep's is adopted on the same provider only —
 *  a provider switch changes more than the one line it edits; a randomised winner (W1-T12143) is a provider switch,
 *  written on every row it covers ({@link randomisedMountCandidate}). */
export function mountCandidate(inv: ConfigInventory, repoRoot: string): ConfigGardenAction | undefined {
  const full = mountsPath(repoRoot);
  const path = relative(repoRoot, full).split(sep).join("/");
  if (!existsSync(full) || inv.recommendations.length === 0) return undefined;
  const text = readFileSync(full, "utf8");
  for (const rec of inv.recommendations) {
    const randomised = "randomised" in rec ? randomisedMountCandidate(rec, inv, text, path) : undefined;
    if (randomised) return randomised;
    if ("randomised" in rec || rec.recommendedArm.provider !== rec.currentArm.provider) continue;
    const from = routeLine(text, rec.type, rec.risk, rec.taskClass);
    if (!from) continue;
    const to = from.replace(/\bmodel:\s*[^,}\s]+/, `model: ${rec.recommendedArm.servedModel}`).replace(/\beffort:\s*[^,}\s]+/, `effort: ${rec.recommendedArm.effort}`);
    if (to === from) continue;
    const cohort: ConfigCohort = { kind: "cell", type: rec.type, risk: rec.risk, taskClass: rec.taskClass };
    return {
      class: "adopt-mount",
      target: rec.cellKey,
      scope: `mount:${rec.type}/${rec.risk}/${rec.taskClass}`,
      reason: `${rec.recommendedArm.armKey} completes a task for $${usd(rec.recommendedArm.costPerCompletedTaskUsd)} against $${usd(rec.currentArm.costPerCompletedTaskUsd)} (n=${rec.recommendedArm.n}/${rec.currentArm.n}); effect interval $${usd(rec.interval.lowUsd)}–$${usd(rec.interval.highUsd)}.`,
      edits: [{ path, from, to }],
      cohort,
      candidate: `${rec.recommendedArm.servedModel}/${rec.recommendedArm.effort} on ${rec.cellKey}`,
      baseline: `${rec.currentArm.servedModel}/${rec.currentArm.effort} on ${rec.cellKey}`,
      exposure: 1,
      shadowMetrics: [{ metricName: "effect_interval_low_usd", unit: "usd", direction: "min", abortThreshold: 0 }],
      shadowObservations: [{ metricName: "effect_interval_low_usd", value: rec.interval.lowUsd, denominator: Math.min(rec.recommendedArm.n, rec.currentArm.n), freshness: "verified", comparisonPopulation: population(cohort), observedAt: inv.nowIso }],
    };
  }
  return undefined;
}

/** The baseline file's measured fields, rewritten with the re-derivation's figures: its own note forbids
 *  raising `capChars` without the re-measured pressure and priced delta beside it. A field whose line is
 *  not in `baselineText` is not edited. */
export function capBaselineEdits(baselineText: string, d: KnowledgeBudgetDerivation, nowIso: string): ConfigEdit[] {
  const path = "scripts/knowledge-budget-baseline.json";
  const values: Record<string, string> = {
    capturedAt: JSON.stringify(nowIso.slice(0, 10)),
    measuredDroppedWeightP50Chars: String(d.pressure?.droppedWeightP50),
    measuredDroppedWeightP90Chars: String(d.pressure?.droppedWeightP90),
    spawnsMeasured: String(d.pressure?.spawnsMeasured),
    ...(d.cacheHitRatioUsed !== undefined ? { cacheHitRatioUsed: String(Math.round(d.cacheHitRatioUsed * 10_000) / 10_000) } : {}),
    pricedDeltaTokens: String(d.deltaTokens),
    capChars: String(d.recommendedCapChars),
  };
  const edits: ConfigEdit[] = [];
  for (const line of baselineText.split("\n")) {
    const m = /^ {2}"(\w+)": ([^,]+)(,?)$/.exec(line);
    const to = m && values[m[1]!] !== undefined ? `  "${m[1]}": ${values[m[1]!]}${m[3]}` : undefined;
    if (to !== undefined && to !== line) edits.push({ path, from: line, to });
  }
  return edits;
}

/** The re-derived learnings cap, edited in both places the drift test pins together. */
export function capCandidate(inv: ConfigInventory, baselineText: string): ConfigGardenAction | undefined {
  const cap = inv.cap;
  const d = cap === undefined ? undefined : cap.derivation;
  if (cap === undefined || d === undefined || d.changed === false || d.pressure === undefined || d.recommendedCapChars === cap.current) return undefined;
  const cur = cap.current;
  const next = d.recommendedCapChars;
  const cohort: ConfigCohort = { kind: "all" };
  return {
    class: "re-derive-cap",
    target: "knowledge-budget",
    scope: "cap:knowledge-budget",
    reason: `${d.pressure.spawnsMeasured} spawns under the ${cur}-char cap dropped p90 ${d.pressure.droppedWeightP90} chars of matched learnings; ${d.reason}`,
    edits: [
      { path: "src/lib/learnings.ts", from: `export const DEFAULT_KNOWLEDGE_BUDGET_CHARS = ${cur};`, to: `export const DEFAULT_KNOWLEDGE_BUDGET_CHARS = ${next};` },
      ...capBaselineEdits(baselineText, d, inv.nowIso),
    ],
    cohort,
    candidate: `learnings cap ${next} chars`,
    baseline: `learnings cap ${cur} chars`,
    exposure: 1,
    shadowMetrics: [{ metricName: "dropped_weight_p90_chars", unit: "chars", direction: "min", abortThreshold: TRIVIAL_DROPPED_WEIGHT_CHARS }],
    shadowObservations: [{ metricName: "dropped_weight_p90_chars", value: d.pressure.droppedWeightP90, denominator: d.pressure.spawnsMeasured, freshness: "verified", comparisonPopulation: population(cohort), observedAt: inv.nowIso }],
  };
}

// ── Retune restart (W1-T12232) ───────────────────────────────────────────────────────────────

/** Did staleness release this restart? `upper_age` is the coalescer's staleness release; a busy pressure reason is one
 *  when its change term alone stays under the limit and change plus staleness reaches it. A withheld review is not. */
export function stalenessReleasedRestart(trigger: unknown): boolean {
  if (trigger === "upper_age") return true;
  if (typeof trigger !== "string" || trigger.includes("withheld")) return false;
  const m = /\(change (\d+) \+ staleness (\d+)[^)]*\) >= (\d+)/.exec(trigger);
  return m !== null && Number(m[1]) < Number(m[3]) && Number(m[1]) + Number(m[2]) >= Number(m[3]);
}

const costPart = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;

/** The rule: the last {@link RESTART_TUNE_ROWS} complete cycles since either row last changed. Waiting costing
 *  {@link RESTART_TUNE_FACTOR} times restarting or more lowers a row by {@link RESTART_TUNE_STEP}; restarting costing that
 *  much more raises it. Staleness releasing more than half the cycles picks `stalenessHorizonMs`, else `scoreLimit`. */
export function restartTuneEvidence(inv: ConfigInventory): RestartTuneEvidence {
  const r = inv.restart;
  if (r === undefined) return { rows: 0, nullPartRows: 0, reason: "no restart inventory was read" };
  if (r.changedAtMs === undefined) return { rows: 0, nullPartRows: 0, reason: `the last change of the policy rows is unknown: ${r.unknownChange ?? "no reason"}` };
  const changedAt = r.changedAtMs;
  const byStart = new Map<string, Record<string, unknown>>();
  for (const c of r.cycles) {
    if (typeof c.first_verdict_at !== "string" || typeof c.exit_at !== "string" || !(Date.parse(c.exit_at) > changedAt)) continue;
    byStart.set(String(c.started_at ?? c.exit_at), c);
  }
  const later = [...byStart.values()];
  const complete = later.filter((c) => costPart(c.waiting_cost_ms) && costPart(c.restart_cost_ms))
    .sort((a, b) => Date.parse(String(a.exit_at)) - Date.parse(String(b.exit_at))).slice(-RESTART_TUNE_ROWS);
  const counts = { rows: complete.length, nullPartRows: later.filter((c) => !costPart(c.waiting_cost_ms) || !costPart(c.restart_cost_ms)).length };
  if (complete.length < RESTART_TUNE_ROWS) {
    return { ...counts, reason: `${complete.length} complete restart cycle(s) since the policy rows last changed; ${RESTART_TUNE_ROWS} are needed` };
  }
  const waitingMedianMs = median(complete.map((c) => c.waiting_cost_ms as number));
  const restartMedianMs = median(complete.map((c) => c.restart_cost_ms as number));
  const stalenessReleased = complete.filter((c) => stalenessReleasedRestart(c.trigger)).length;
  const measured = { ...counts, waitingMedianMs, restartMedianMs, stalenessReleased };
  const costs = `median waiting cost ${minutes(waitingMedianMs)}, median restart cost ${minutes(restartMedianMs)}`;
  const lower = waitingMedianMs > restartMedianMs && waitingMedianMs >= RESTART_TUNE_FACTOR * restartMedianMs;
  const higher = restartMedianMs > waitingMedianMs && restartMedianMs >= RESTART_TUNE_FACTOR * waitingMedianMs;
  if (!lower && !higher) return { ...measured, reason: `${costs}: neither is ${RESTART_TUNE_FACTOR} times the other` };
  const name: RestartPolicyRowName = stalenessReleased * 2 > complete.length ? "stalenessHorizonMs" : "scoreLimit";
  const row = r.rows.find((p) => p.name === name);
  if (row === undefined) return { ...measured, reason: `${costs}, yet ${RESTART_POLICY_PATH} holds no one-line ${name} row` };
  const bound = lower ? row.min : row.max;
  if (lower ? row.value <= bound : row.value >= bound) {
    return { ...measured, row, reason: `${costs}: ${name} would move ${lower ? "lower" : "higher"}, but it is at its ${lower ? "min" : "max"} ${bound}` };
  }
  const raw = row.value * (lower ? 1 - RESTART_TUNE_STEP : 1 + RESTART_TUNE_STEP);
  const whole = name === "scoreLimit" ? Math.round(raw) : Math.round(raw / 60_000) * 60_000;
  const to = Math.min(row.max, Math.max(row.min, whole));
  if (to === row.value) return { ...measured, row, reason: `${costs}: a ${RESTART_TUNE_STEP * 100}% step of ${name} rounds to its value ${row.value}` };
  return {
    ...measured, row, to,
    reason: `the last ${complete.length} restart cycles since the policy rows changed: ${costs}; staleness released ${stalenessReleased} of them, so ${name} ${row.value} -> ${to}`,
  };
}

/** The pass row's part: the counts, always, and why there is or is not a proposal. */
export function restartTuneScorecard(e: RestartTuneEvidence): Record<string, unknown> {
  return { rows: e.rows, null_part_rows: e.nullPartRows, reason: e.reason, ...(e.to !== undefined && e.row ? { row: e.row.name, from: e.row.value, to: e.to } : {}) };
}

/** W1-T12232: {@link restartTuneEvidence}'s proposal as one edit of its row's one line. A policy row reaches every
 *  restart, so its cohort is `all`; the shadow evidence is the two medians and the count of rows. */
export function restartTuneCandidate(inv: ConfigInventory): ConfigGardenAction | undefined {
  const e = restartTuneEvidence(inv);
  if (e.to === undefined || e.row === undefined) return undefined;
  const { row, to } = e;
  const lowered = to < row.value;
  const cohort: ConfigCohort = { kind: "all" };
  const observed = { denominator: e.rows, freshness: "verified" as const, comparisonPopulation: population(cohort), observedAt: inv.nowIso };
  return {
    class: "retune-restart",
    target: `freshnessRestart.${row.name}`,
    scope: `policy:freshnessRestart.${row.name}`,
    reason: e.reason,
    edits: [{ path: RESTART_POLICY_PATH, from: row.line, to: row.line.replace(/(\bvalue: )-?[0-9.]+/, `$1${to}`) }],
    cohort,
    candidate: `freshnessRestart.${row.name} ${to}`,
    baseline: `freshnessRestart.${row.name} ${row.value}`,
    exposure: 1,
    shadowMetrics: [
      { metricName: "restart_cycles", unit: "cycles", direction: "min", abortThreshold: RESTART_TUNE_ROWS },
      lowered
        ? { metricName: "median_waiting_cost_ms", unit: "ms", direction: "min", abortThreshold: RESTART_TUNE_FACTOR * e.restartMedianMs! }
        : { metricName: "median_restart_cost_ms", unit: "ms", direction: "min", abortThreshold: RESTART_TUNE_FACTOR * e.waitingMedianMs! },
    ],
    shadowObservations: [
      { metricName: "restart_cycles", value: e.rows, ...observed },
      { metricName: "median_waiting_cost_ms", value: e.waitingMedianMs!, ...observed },
      { metricName: "median_restart_cost_ms", value: e.restartMedianMs!, ...observed },
    ],
  };
}

/** W1-T12187: does this role's cash shadow record clear {@link JUDGE_CASH_BAR}? A role with no agreement figure never does. */
export function judgeClearsCashBar(s: JudgeShadowRoleSummary): boolean {
  return s.paired >= JUDGE_CASH_BAR.minPaired && s.agreeShare !== null && s.agreeShare >= JUDGE_CASH_BAR.minAgreeShare &&
    s.noAnswerShare !== null && s.noAnswerShare <= JUDGE_CASH_BAR.maxNoAnswerShare;
}

/** W1-T12187: the first role that clears the bar and whose own row is one flow-map line that names no provider: that
 *  line with `provider: cash`. The row must name a model of the lowest tier, so cash serves it from its economy row. A
 *  role with no row, a fail-closed role, or a row over several lines gets no proposal: one edit replaces one line. */
export function judgeCashCandidate(inv: ConfigInventory, repoRoot: string): ConfigGardenAction | undefined {
  const full = mountsPath(repoRoot);
  const clear = (inv.judgeShadows ?? []).filter(judgeClearsCashBar);
  if (clear.length === 0 || !existsSync(full)) return undefined;
  const path = relative(repoRoot, full).split(sep).join("/");
  const mounts = loadMounts(full);
  const lines = readFileSync(full, "utf8").split("\n");
  const lowestTier = Math.min(...Object.values(mounts.tiers));
  for (const s of clear) {
    const key = JUDGE_ROLE_ROWS[s.role];
    if (key === undefined || (FAIL_CLOSED_JUDGE_ROWS as readonly string[]).includes(key)) continue;
    const row = mounts[key];
    const from = lines.find((line) => line.startsWith(`${key}: {`) && ONE_LINE_ROW.test(line));
    // A row that names any provider is not this class's to move: it only takes a provider-less row to cash.
    if (row === undefined || from === undefined || row.provider !== undefined || mounts.tiers[row.model] !== lowestTier) continue;
    const to = withCashProvider(from);
    const cohort: ConfigCohort = { kind: "all" };
    const observed = { denominator: s.paired, freshness: "verified" as const, comparisonPopulation: population(cohort), observedAt: inv.nowIso };
    return {
      class: "move-judge-to-cash",
      target: s.role,
      scope: `judge:${s.role}`,
      reason: `the cash shadow of the ${s.role} agreed on ${(s.agreeShare! * 100).toFixed(1)}% of ${s.paired} paired calls in 14 days, and ${(s.noAnswerShare! * 100).toFixed(1)}% of its calls gave no usable answer; median cost $${s.shadowMedianCostUsd ?? "?"} against $${s.primaryMedianCostUsd ?? "?"}.`,
      edits: [{ path, from, to }],
      cohort,
      candidate: `${key} on ${row.model}/${row.effort} with provider cash`,
      baseline: `${key} on ${row.model}/${row.effort} with ${row.provider ?? "no provider"}`,
      exposure: 1,
      shadowMetrics: [
        { metricName: "shadow_agree_share", unit: "fraction", direction: "min", abortThreshold: JUDGE_CASH_BAR.minAgreeShare },
        { metricName: "shadow_no_answer_share", unit: "fraction", direction: "max", abortThreshold: JUDGE_CASH_BAR.maxNoAnswerShare },
      ],
      shadowObservations: [
        { metricName: "shadow_agree_share", value: s.agreeShare!, ...observed },
        { metricName: "shadow_no_answer_share", value: s.noAnswerShare!, ...observed },
      ],
    };
  }
  return undefined;
}

/**
 * W1-T12417: each shadow row since `sinceMs` as one W1-T12414 typed answer, keyed by role, shadow model and model
 * surface, so `scoreTypedAnswers` gives each role and model its own figures. A refusal sent no request and gives no
 * answer. A skipped request is a rejection, an abstention is an abstention, and a decision row keeps its distribution.
 * A W1-T11075 paired row records agreement only, so its answer is `agree` or `disagree` against `agree`.
 */
export function judgeShadowTypedAnswers(rows: ReadonlyArray<Record<string, unknown>>, sinceMs?: number): TypedAnswerRow[] {
  const out: TypedAnswerRow[] = [];
  for (const row of rows) {
    const role = row.role ?? row.surface;
    const model = row.shadow_model ?? row.shadow_deployment;
    if (typeof row.step !== "string" || !JUDGE_SHADOW_STEPS.includes(row.step) || typeof role !== "string" || typeof model !== "string") continue;
    if (sinceMs !== undefined && !(Date.parse(String(row.ts)) >= sinceMs)) continue;
    if (row.step === "judge_shadow.refused" || row.refusal !== undefined) continue;
    const modelSurface: ModelSurface = row.model_surface === "decisions" ? "decisions" : "text";
    const distribution = Array.isArray(row.distribution) ? (row.distribution as Array<{ option: string; probability: number }>) : undefined;
    const base = { role, question: null, model, source: modelSurface === "decisions" ? "decisions" as const : "generative" as const, modelSurface,
      questionType: null, inputDigest: null, outcome: null };
    let answer: TypedAnswer;
    let incumbent: string | null = typeof row.primary_answer === "string" ? row.primary_answer : null;
    let options: string[] | null = distribution?.map((entry) => entry.option) ?? null;
    if (typeof row.abstained === "string") answer = { kind: "abstained", reason: row.abstained === "refusal" ? "refusal" : "cannot-tell" };
    else if (row.step === "judge_shadow.skipped" || row.step === "judge_shadow.unavailable" || row.parses === false) answer = { kind: "rejected", reason: String(row.reason ?? "no usable answer") };
    else if (typeof row.agreement !== "boolean") continue;
    else if (distribution !== undefined) answer = { kind: "distribution", distribution };
    else if (typeof row.shadow_answer === "string") answer = { kind: "single", option: row.shadow_answer };
    else {
      answer = { kind: "single", option: row.agreement ? "agree" : "disagree" };
      incumbent = "agree";
      options = ["agree", "disagree"];
    }
    out.push({ ...base, options, answer, incumbent });
  }
  return out;
}

/** W1-T12417: does one shadow model of one role clear {@link JUDGE_SWITCH_BAR}? */
export function judgeShadowModelClears(g: TypedAnswerScoreGroup): boolean {
  return g.agreement.compared >= JUDGE_SWITCH_BAR.minCompared && g.agreement.rate !== null && g.agreement.rate >= JUDGE_SWITCH_BAR.minAgreeShare &&
    (g.rejected + g.abstained) / g.answers <= JUDGE_SWITCH_BAR.maxNoAnswerShare && (g.brier === null || g.brier <= JUDGE_SWITCH_BAR.maxBrier);
}

/** W1-T12417: one tuned threshold figure: the least top-option probability among the answers that cleared
 *  {@link JUDGE_SWITCH_BAR}, for one role, model and model surface. */
export interface JudgeShadowThreshold {
  role: string;
  model: string;
  surface: ModelSurface;
  value: number;
}

/** W1-T12417: per role and decision model whose compared answers number {@link JUDGE_SWITCH_BAR}'s floor and agree with the
 *  judge's own at its agreement share, the lowest top-option probability among them (to three places, rounded down): the
 *  confidence the model was validated down to, below which its answer is not taken as primary. Any other model has no
 *  figure. A single generated answer has no probability, so a `text` surface gets none. */
export function judgeShadowThresholds(rows: ReadonlyArray<Record<string, unknown>>, sinceMs?: number): JudgeShadowThreshold[] {
  const groups = new Map<string, { role: string; model: string; answers: Array<{ top: number; agree: boolean }> }>();
  for (const row of rows) {
    const role = row.role;
    const model = row.shadow_model;
    if (row.step !== "judge_shadow.compared" || row.model_surface !== "decisions" || typeof role !== "string" || typeof model !== "string" ||
      typeof row.agreement !== "boolean" || !Array.isArray(row.distribution) || row.refusal !== undefined) continue;
    if (sinceMs !== undefined && !(Date.parse(String(row.ts)) >= sinceMs)) continue;
    const top = Math.max(...(row.distribution as Array<{ probability: number }>).map((entry) => entry.probability));
    if (!Number.isFinite(top)) continue;
    const key = `${role}\u0000${model}`;
    const group = groups.get(key) ?? { role, model, answers: [] };
    group.answers.push({ top, agree: row.agreement });
    groups.set(key, group);
  }
  const out: JudgeShadowThreshold[] = [];
  for (const { role, model, answers } of groups.values()) {
    const agreeing = answers.filter((a) => a.agree).length;
    // The bar was cleared over every one of these answers, so the least top probability among them is the least cut that clears it.
    if (answers.length < JUDGE_SWITCH_BAR.minCompared || agreeing / answers.length < JUDGE_SWITCH_BAR.minAgreeShare) continue;
    out.push({ role, model, surface: "decisions", value: Math.floor(Math.min(...answers.map((a) => a.top)) * 1000 + 1e-9) / 1000 });
  }
  return out;
}

/** W1-T12417: the judges whose own answer is exactly one option, so a decision model can be their primary. Their
 *  `judge_shadows` entry is the one line {@link judgeShadowSwitchCandidate} replaces. */
export const DECISION_PRIMARY_ROLES: readonly JudgeShadowOnlyRole[] = ["refresh-value", "head-rehome", "typed-judgment"];

/** W1-T12417: the first role and shadow model that clear {@link JUDGE_SWITCH_BAR}, as one edit that makes the model the
 *  role's primary. A decision model on a judge whose answer is one option (see {@link DECISION_PRIMARY_ROLES}) replaces the
 *  role's `judge_shadows` line with `{ primary: <model>, threshold: { model: <deployment>, surface: decisions, value } }`;
 *  the threshold is the model's own figure ({@link judgeShadowThresholds}) and is read only for that model id and surface.
 *  A cash model on a role's one-line row gets `provider: cash` when cash serves that row with it first. A fail-closed
 *  judge, a role with no such line, a role already on its candidate and a model with no threshold figure get nothing. */
export function judgeShadowSwitchCandidate(inv: ConfigInventory, repoRoot: string): ConfigGardenAction | undefined {
  const full = mountsPath(repoRoot);
  const clear = (inv.judgeShadowScores ?? []).filter((g) => !FAIL_CLOSED_JUDGE_ROLES.has(g.role) && judgeShadowModelClears(g));
  if (clear.length === 0 || !existsSync(full)) return undefined;
  const path = relative(repoRoot, full).split(sep).join("/");
  const mounts = loadMounts(full);
  const lines = readFileSync(full, "utf8").split("\n");
  for (const g of clear) {
    const edit = g.modelSurface === "decisions" ? decisionPrimaryEdit(g, inv, mounts, lines) : cashPrimaryEdit(g, mounts, lines);
    if (edit === undefined) continue;
    const cohort: ConfigCohort = { kind: "all" };
    const noAnswer = (g.rejected + g.abstained) / g.answers;
    const observed = { denominator: g.agreement.compared, freshness: "verified" as const, comparisonPopulation: population(cohort), observedAt: inv.nowIso };
    return {
      class: "move-judge-to-cash", target: g.role, scope: `judge:${g.role}`,
      reason: `the ${g.model} shadow of the ${g.role} agreed on ${(g.agreement.rate! * 100).toFixed(1)}% of ${g.agreement.compared} compared calls in 14 days, ` +
        `${(noAnswer * 100).toFixed(1)}% of its calls gave no usable answer${g.brier === null ? "" : `, and its Brier score is ${g.brier.toFixed(3)}`}; ${edit.why}`,
      edits: [{ path, from: edit.from, to: edit.to }], cohort,
      candidate: `${g.role} on ${g.model} (${g.modelSurface} surface)`,
      baseline: `${g.role} on its own judge`,
      exposure: 1,
      shadowMetrics: [
        { metricName: "shadow_agree_share", unit: "fraction", direction: "min", abortThreshold: JUDGE_SWITCH_BAR.minAgreeShare },
        { metricName: "shadow_no_answer_share", unit: "fraction", direction: "max", abortThreshold: JUDGE_SWITCH_BAR.maxNoAnswerShare },
      ],
      shadowObservations: [
        { metricName: "shadow_agree_share", value: g.agreement.rate!, ...observed },
        { metricName: "shadow_no_answer_share", value: noAnswer, ...observed },
      ],
    };
  }
  return undefined;
}

type PrimaryEdit = { from: string; to: string; why: string };

/** A decision model that clears the bar on a judge whose answer is one option: that judge's `judge_shadows` line made a primary. */
function decisionPrimaryEdit(g: TypedAnswerScoreGroup, inv: ConfigInventory, mounts: ReturnType<typeof loadMounts>, lines: readonly string[]): PrimaryEdit | undefined {
  const role = (DECISION_PRIMARY_ROLES as readonly string[]).includes(g.role) ? g.role as JudgeShadowOnlyRole : undefined;
  const candidate = mounts.decision_models !== undefined && Object.hasOwn(mounts.decision_models, g.model) ? mounts.decision_models[g.model] : undefined;
  const figure = (inv.judgeShadowThresholds ?? []).find((t) => t.role === g.role && t.model === g.model && t.surface === g.modelSurface);
  if (role === undefined || candidate === undefined || figure === undefined || mounts.judge_primaries?.[role] !== undefined) return undefined;
  const entries = lines.filter((line) => new RegExp(`^ {2}${role}: \\S`).test(line));
  if (entries.length !== 1 || mounts.judge_shadows?.[role] === undefined) return undefined;
  return { from: entries[0]!,
    to: `  ${role}: { primary: ${g.model}, threshold: { model: ${candidate.deployment}, surface: ${figure.surface}, value: ${figure.value} } }`,
    why: `${g.model} becomes the primary of ${role}, answering when its top option has at least ${figure.value}, and the judge it replaces answers when it does not.` };
}

/** A cash model that clears the bar on a role's one-line row: `provider: cash`, when cash serves the row with that model first. */
function cashPrimaryEdit(g: TypedAnswerScoreGroup, mounts: ReturnType<typeof loadMounts>, lines: readonly string[]): PrimaryEdit | undefined {
  const key = JUDGE_ROLE_ROWS[g.role];
  const row = key === undefined ? undefined : mounts[key];
  const from = key === undefined ? undefined : lines.find((line) => line.startsWith(`${key}: {`) && line.trimEnd().endsWith("}"));
  if (key === undefined || row === undefined || from === undefined || row.provider === "cash") return undefined;
  const served = openWeightCandidatesForCapability(mounts.capabilities, openWeightCapabilityForRequestedModel(mounts.capabilities, row.model), row.effort)[0];
  if (served !== g.model) return undefined;
  return { from, to: from.replace(/\s*\}\s*$/, ", provider: cash }"), why: `cash serves ${key} on ${row.model}/${row.effort} with ${g.model} first.` };
}

/** A draft promotion for `action`, approved by the gardener's own draw and not yet exposed. */
export function configPromotion(action: ConfigGardenAction, nowIso: string, repo = "remudero"): PromotionRecord {
  const now = Date.parse(nowIso);
  const expiresAt = fixedClock(now + CANARY_TTL_MS).iso();
  return {
    version: EXPERIMENT_PROMOTION_VERSION,
    promotionId: `config-${action.scope}-${now}`,
    candidate: action.candidate,
    baseline: action.baseline,
    scope: { repo, policyScope: action.scope },
    comparisonPopulation: population(action.cohort),
    denominatorFloor: CANARY_DENOMINATOR_FLOOR,
    observationWindow: { start: nowIso, end: expiresAt },
    guardMetrics: cohortGuardMetrics(),
    maxExposure: action.exposure,
    owner: "config gardener (W1-T4113)",
    expiresAt,
    rollback: { plan: `revert the ${action.edits.length} edited line(s) in one PR`, reason: "a cohort guardrail breach" },
    createdAt: nowIso,
    state: "approved",
  };
}

const readIfPresent = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** Every change any class could make now, each already clear of its shadow guard and of any scope an
 *  active canary holds. */
export function configCandidates(inv: ConfigInventory, repoRoot: string, rng: () => number): ConfigGardenAction[] {
  // W1-T12143, invariant randomised-evidence-only: an adopt-mount candidate comes only from a concluded randomised
  // source, whatever else the inventory read. The observational sweep's recommendations change no mount.
  const randomised = inv.recommendations.filter((rec): rec is RandomisedMountRecommendation => "randomised" in rec);
  const all = [budgetCandidate(inv, rng), mountCandidate({ ...inv, recommendations: randomised }, repoRoot), capCandidate(inv, readIfPresent(join(repoRoot, "scripts", "knowledge-budget-baseline.json"))), judgeCashCandidate(inv, repoRoot),
    judgeShadowSwitchCandidate(inv, repoRoot), restartTuneCandidate(inv)].filter((a): a is ConfigGardenAction => a !== undefined);
  const held = inv.active.map((c) => ({ promotionId: c.promotion.promotionId, scope: c.promotion.scope, state: c.promotion.state }));
  return all.filter((a) => {
    const p = configPromotion(a, inv.nowIso);
    return !inv.cooling.includes(a.scope) && !findScopeConflict(held, p.scope, p.promotionId) && enterCanary(p, a.shadowMetrics, a.shadowObservations, inv.nowIso).verdict === "advanced";
  });
}

// ── Apply and roll back ──────────────────────────────────────────────────────────────────────

/** Apply `edits` under `root`; returns the paths changed. An edit whose `from` line is not present
 *  exactly once (exactly `occurrences` times, W1-T12143) is skipped — the file moved on, and a guess
 *  would edit the wrong line. The read is one ENOENT-guarded `readFileIfExists` and the write a
 *  temp-then-rename `writeAtomic`, so no separate existence check opens a window between checking
 *  the path and writing it. */
export function applyConfigEdits(root: string, edits: ConfigEdit[]): string[] {
  const changed = new Set<string>();
  for (const e of edits) {
    const path = join(root, e.path);
    const raw = readFileIfExists(path);
    if (raw === undefined) continue;
    const lines = raw.split("\n");
    const hits = spanStarts(lines, e.from);
    if (hits.length !== (e.occurrences ?? 1)) continue;
    writeAtomic(path, replaceSpans(lines, hits, e.from, e.to).join("\n"));
    changed.add(e.path);
  }
  return [...changed].sort();
}

export const reverseEdits = (edits: ConfigEdit[]): ConfigEdit[] => edits.map((e) => ({ ...e, from: e.to, to: e.from }));

/** Check every rollback line in memory before writing any file. A line already at its baseline is
 * safe to leave alone and is not one of the `applied` edits; a missing or ambiguous line refuses the
 * whole rollback PR. `applied` is exactly the set of lines this revert puts back, so its proofs are
 * chosen by the same rule that chose its writes. */
function applyExactConfigRollback(root: string, edits: ConfigEdit[]): { paths: string[]; applied: ConfigEdit[] } {
  const staged = new Map<string, string>();
  const applied: ConfigEdit[] = [];
  for (const edit of edits) {
    const raw = staged.get(edit.path) ?? readFileIfExists(join(root, edit.path));
    if (raw === undefined) throw new Error(`config gardener: rollback source unreadable: ${edit.path}`);
    const lines = raw.split("\n");
    const from = spanStarts(lines, edit.from);
    const to = spanStarts(lines, edit.to);
    const count = edit.occurrences ?? 1;
    if (from.length === 0 && to.length === count) continue;
    if (from.length !== count || to.length !== 0) throw new Error(`config gardener: rollback line changed or ambiguous: ${edit.path}`);
    staged.set(edit.path, replaceSpans(lines, from, edit.from, edit.to).join("\n"));
    applied.push(edit);
  }
  for (const [path, text] of staged) writeAtomic(join(root, path), text);
  return { paths: [...staged.keys()].sort(), applied };
}

/** One code point of a proven line. A control character other than tab, such as a CRLF file's carriage return, is
 *  `[[:cntrl:]]`, because a PR body cannot carry the byte. Every other character, `|` and `"` included, is the house
 *  literal escape ({@link escapeGrepLiteral}): the renderer quotes a proof holding `|` and reads it back verbatim, and a
 *  bare `|` is literal in the executor's basic regex. */
type LineAtom = { kind: "char"; ch: string } | { kind: "cntrl" };
const isBodyUnsafeControl = (ch: string): boolean => ch !== "\t" && /[\0-\x1f\x7f]/.test(ch);
/** POSIX `[:cntrl:]`, which grep matches: every C0 control character and DEL, tab included. */
const isPosixControl = (ch: string | undefined): boolean => ch !== undefined && /[\0-\x1f\x7f]/.test(ch);

function lineAtoms(line: string): LineAtom[] {
  return [...line].map((ch): LineAtom => (isBodyUnsafeControl(ch) ? { kind: "cntrl" } : { kind: "char", ch }));
}

function linePattern(line: string): string {
  return `^${lineAtoms(line).map((a) => (a.kind === "cntrl" ? "[[:cntrl:]]" : escapeGrepLiteral(a.ch))).join("")}$`;
}

/** The `grep:` proof that `path` holds `line` as one whole line, anchored at both ends, so `budget_usd: 5` never matches
 *  `budget_usd: 50.00` and the line's own leading and trailing spaces stay part of what it must equal. */
export function exactLineProof(path: string, line: string): string {
  return `grep: ${linePattern(line)} in ${path}`;
}

/** What the executor's `grep -arn -- <pattern> <path>` answers for {@link exactLineProof}: some line of `text` matches every
 *  atom of `line` (the same character, or a control character for a control character). */
export function holdsExactLine(text: string, line: string): boolean {
  const atoms = lineAtoms(line);
  return text.split("\n").some((candidate) => {
    const chars = [...candidate];
    return chars.length === atoms.length &&
      atoms.every((a, i) => (a.kind === "cntrl" ? isPosixControl(chars[i]) : chars[i] === a.ch));
  });
}

/** The revert's Acceptance block: one proof per line it put back, and none for a line already at its baseline.
 *  Preflight runs each body proof through check-proof and refuses one that already holds on the tree before the
 *  revert, so the canary would keep its edits and its class would stay pending. So each proof is checked here the
 *  way the executor will run it: it must parse to the argv this pattern names, hold after the revert and not before.
 *  `renderAcceptanceBlock` refuses a block the reviewer's parser would not read back verbatim. A proof that would already
 *  hold before the revert, such as a `|` widened to `.` beside a look-alike line, refuses the revert before any PR opens. */
function rollbackAcceptance(applied: readonly ConfigEdit[], before: ReadonlyMap<string, string>, root: string): string {
  return renderAcceptanceBlock(applied.map((e) => {
    const after = readFileIfExists(join(root, e.path)) ?? "";
    // One restored line the tree before held nowhere: the line itself, or (a restored block, W1-T12143) its own line.
    const line = e.to.split("\n").find((l) => holdsExactLine(after, l) && !holdsExactLine(before.get(e.path) ?? "", l));
    const parsed = line === undefined ? undefined : parseWhitelistedProof(exactLineProof(e.path, line));
    if (line === undefined || parsed?.kind !== "grep" || parsed.args.join("\0") !== ["-arn", "--", linePattern(line), e.path].join("\0")) {
      throw new Error(`config gardener: the rollback proof for ${e.path} would not tell the revert from the tree before it`);
    }
    return { claim: `${e.path} is back at its line from before the canary`, proof: exactLineProof(e.path, line) };
  }));
}

/** The canary PR's own Acceptance block: each edited file carries the canary's line. */
function acceptance(edits: ConfigEdit[]): string[] {
  return ["## Acceptance", ...edits.flatMap((e) => [`- claim: ${e.path} carries the canary's value`, `  proof: ${exactLineProof(e.path, e.to)}`])];
}

/** An edit's side as one inline-code span: a block's lines joined (W1-T12143). */
const shownLines = (text: string): string => text.split("\n").map((line) => line.trim()).join(" ");

function prBody(action: ConfigGardenAction): string {
  return [
    `The config gardener (W1-T4113) proposes a **${action.class}** canary on \`${action.scope}\`: ${action.reason}`,
    "",
    `Exposure: ${action.cohort.kind === "tasks" ? `${action.cohort.taskIds.length} shard(s) — ${action.cohort.taskIds.join(", ")}` : "every run this route/cap reaches"}. Once merged, the gardener compares the cohort with the rest by merge rate and cost per merged task; a guardrail breach opens a PR reverting exactly these lines and debits the class, a promotion credits it.`,
    "",
    ...action.edits.map((e) => `- \`${e.path}\`: \`${shownLines(e.from)}\` → \`${shownLines(e.to)}\`${e.occurrences === undefined ? "" : ` (${e.occurrences} identical rows)`}`),
    "",
    ...acceptance(action.edits),
  ].join("\n");
}

const titles: Record<ConfigGardenClass, string> = {
  "recalibrate-budget": "chore(plan): the config gardener canaries recalibrated budgets",
  "adopt-mount": "chore(mounts): the config gardener canaries a recommended mount",
  "re-derive-cap": "chore(learnings): the config gardener canaries a re-derived learnings cap",
  "move-judge-to-cash": "chore(mounts): the config gardener canaries a judge's primary on a candidate model",
  "retune-restart": "chore(policy): the config gardener canaries a retuned freshness restart row",
};

/** Modification times of the plan and mounts, and the current read bucket: an idle tick costs a few stats. */
export function configCheapFingerprint(repoRoot: string, nowMs: number): string {
  const layout = resolveRepoLayout(repoRoot);
  const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  return [mtime(join(dirname(layout.planMonolith), "tasks.d")), mtime(join(repoRoot, ".remudero", "mounts.yaml")), Math.floor(nowMs / CONFIG_GARDEN_BUCKET_MS)].join(",");
}

/** Worker configuration as a gardener spec. */
export function configGardenSpec(deps: GardenerDeps, sources: ConfigGardenSources = {}): ConfigGardenSpec {
  return {
    name: CONFIG_GARDEN_NAME,
    classes: CONFIG_GARDEN_CLASSES,
    cheapFingerprint: () => configCheapFingerprint(deps.repoRoot, (deps.clock ?? systemClock).now()),
    inventory: () => configInventory(deps, sources),
    fingerprint: (inv) => [inv.queued.map((q) => `${q.id}=${q.budgetUsd}`).join(","), inv.recommendations.map((r) => r.cellKey).join(","), inv.cap?.derivation.recommendedCapChars, inv.runs.length, (inv.judgeShadows ?? []).filter(judgeClearsCashBar).map((s) => s.role).join(","),
      (inv.judgeShadowScores ?? []).filter(judgeShadowModelClears).map((g) => `${g.role}/${g.model}/${g.modelSurface}`).join(","), inv.restart?.cycles.length].join("|"),
    // The canary judges these classes (tendConfigCanaries settles the pending class), so the framework's
    // own metric is held still: it never credits or debits on a number the canary did not produce.
    metric: () => ({ trials: 0, successes: 0 }),
    candidates: (inv, rng) => configCandidates(inv, deps.repoRoot, rng),
    scorecard: (inv, plan) => ({ runs: inv.runs.length, queued_budgets: inv.queued.length, recommendations: inv.recommendations.length, active_canaries: inv.active.length, proposed: plan.actions.map((a) => a.scope),
      restart_tune: restartTuneScorecard(restartTuneEvidence(inv)) }),
    apply: (ws, plan) => {
      const action = plan.actions[0];
      if (!action) return undefined;
      const paths = applyConfigEdits(ws.root, action.edits);
      return paths.length === 0 ? undefined : { paths, title: titles[action.class], body: prBody(action) };
    },
  };
}

// ── Judging ──────────────────────────────────────────────────────────────────────────────────

/** Settle the gardener's pending class for `prUrl`: a promotion credits it, a rollback debits it, and
 *  an expiry releases it unjudged. The fingerprints are cleared so the next pass plans afresh. */
function settlePending(stateDir: string, prUrl: string, verdict: "credit" | "debit" | "release"): void {
  const path = gardenStatePath(stateDir, CONFIG_GARDEN_NAME);
  const state = readGardenState(path, CONFIG_GARDEN_CLASSES);
  if (state.pending?.prUrl !== prUrl) return;
  const settled = verdict === "release" ? { ...state, pending: undefined } : judgeGardenDecision(state, verdict === "credit" ? "merged" : "closed").state;
  writeAtomic(path, JSON.stringify({ ...settled, lastCheap: undefined, lastPass: undefined }, null, 2) + "\n");
}

export interface TendResult {
  canary: ConfigCanary;
  step: CanaryStep;
}

/**
 * Judge every open canary once, at most once per {@link CONFIG_TEND_INTERVAL_MS}. Shadow: a closed PR
 * ends it with nothing exposed and debits the class — a person declined it; a merged one is exposed —
 * its shadow guard is re-read and the canary begins, or, refused, it is reverted at once. Canary and
 * observing: the cohort against the rest, one guarded step ({@link stepCanary}). A breach lands a
 * revert of exactly the canary's lines and debits the class; a promotion credits it. An expiry — the
 * cohort never cleared its floor in time — lands the same revert, so an unvalidated change never stays
 * on main, and releases the class unjudged: a change nobody measured is not evidence of harm.
 */
/** Whether {@link tendConfigCanaries} would tend anything now: an active canary whose tend interval has
 *  elapsed. Read the same way, writing nothing, so a parent can skip a config pass that would do nothing. */
export function configCanariesDue(stateDir: string, clock: Clock = systemClock): boolean {
  const file = readConfigCanaryFile(stateDir);
  if (!file.canaries.some((c) => isPromotionActive(c.promotion.state))) return false;
  return file.lastTendMs === undefined || clock.now() - file.lastTendMs >= CONFIG_TEND_INTERVAL_MS;
}

export async function tendConfigCanaries(deps: GardenerDeps, runs: () => Promise<ConfigRun[]>): Promise<TendResult[]> {
  const nowMs = (deps.clock ?? systemClock).now();
  const file = readConfigCanaryFile(deps.stateDir);
  const canaries = file.canaries;
  if (!canaries.some((c) => isPromotionActive(c.promotion.state))) return [];
  if (file.lastTendMs !== undefined && nowMs - file.lastTendMs < CONFIG_TEND_INTERVAL_MS) return [];
  const nowIso = fixedClock(nowMs).iso();
  const results: TendResult[] = [];
  const failures: unknown[] = [];
  let measured: ConfigRun[] | undefined;
  for (const [i, c] of canaries.entries()) {
    if (!isPromotionActive(c.promotion.state)) continue;
    const untended = structuredClone(c);
    // A pre-exposure refusal can be persisted if the shadow snapshot predates a later clock
    // reading. Its PR may already have merged, so the edits must be reconciled before release.
    const refusedBeforeExposure = c.exposedAt === undefined &&
      (c.promotion.state === "approved" || c.promotion.state === "regressed" || c.promotion.state === "unmeasurable");
    let exposed = c.promotion.state !== "shadow" && !refusedBeforeExposure;
    let step: CanaryStep;
    let excludedCount: number | undefined;
    if (c.promotion.state === "shadow" || refusedBeforeExposure) {
      const pr: PrState = deps.prState?.(c.prUrl) ?? "unknown";
      if (pr === "closed") step = { state: "rolled_back", verdict: "rolled_back", reason: "its PR was closed unmerged; nothing was exposed" };
      else if (pr !== "merged") continue;
      else {
        exposed = true;
        if (refusedBeforeExposure) {
          step = { state: "rolled_back", verdict: "rolled_back", reason: `its merged PR carried a pre-exposure ${c.promotion.state} shadow refusal` };
        } else {
          c.exposedAt = nowIso;
          const entry = enterCanary(c.promotion, c.shadowMetrics, c.shadowObservations.map((o) => ({ ...o, observedAt: c.promotion.observationWindow.start })), nowIso);
          step = entry.verdict === "advanced" ? entry : { state: "rolled_back", verdict: "rolled_back", reason: `its shadow guard refused exposure: ${entry.reason ?? entry.state}` };
        }
      }
    } else {
      measured ??= await runs();
      const split = splitCohort(c.cohort, measured, c.exposedAt ?? c.promotion.observationWindow.start, nowIso);
      excludedCount = split.excludedCount;
      step = stepCanary(c.promotion, cohortGuardObservations(cohortOutcome(split.canary), cohortOutcome(split.rest), c.promotion.comparisonPopulation, nowIso), nowIso);
    }
    c.promotion = { ...c.promotion, state: step.state };
    c.reason = step.reason ?? c.reason;
    if ((step.verdict === "rolled_back" || step.verdict === "expired") && exposed) {
      try {
        c.rollbackPrUrl = await rollBack(deps, c);
      } catch (error) {
        // A revert that cannot land leaves this canary exactly as it was, so a later pass steps it again and its class
        // stays pending. The pass still tends the rest and records them before it fails, so a revert another canary
        // opened in this pass is kept and never opened twice.
        canaries[i] = untended;
        failures.push(error);
        continue;
      }
    }
    if (step.verdict === "rolled_back") settlePending(deps.stateDir, c.prUrl, "debit");
    if (step.verdict === "promoted") settlePending(deps.stateDir, c.prUrl, "credit");
    if (step.verdict === "expired") settlePending(deps.stateDir, c.prUrl, "release");
    if (step.verdict !== "waiting") deps.log(`${CONFIG_GARDEN_NAME}.canary_${step.verdict}`, { scope: c.promotion.scope.policyScope, pr_url: c.prUrl, state: step.state, reason: step.reason ?? null, rollback_pr_url: c.rollbackPrUrl ?? null, ...(excludedCount ? { excluded_count: excludedCount } : {}) });
    canaries[i] = c;
    results.push({ canary: c, step });
  }
  writeConfigCanaries(deps.stateDir, canaries, nowMs);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new Error(failures.map((f) => (f instanceof Error ? f.message : String(f))).join("; "));
  return results;
}

/** Land a PR reverting exactly the canary's lines; the receipt is its url, or why there was none. */
async function rollBack(deps: GardenerDeps, c: ConfigCanary): Promise<string | undefined> {
  const ws = await deps.openWorkspace();
  try {
    const edits = reverseEdits(c.edits);
    const before = new Map([...new Set(edits.map((e) => e.path))].map((path) => [path, readFileIfExists(join(ws.root, path)) ?? ""]));
    const { paths, applied } = applyExactConfigRollback(ws.root, edits);
    if (paths.length === 0) {
      deps.log(`${CONFIG_GARDEN_NAME}.rollback_nothing_to_revert`, { scope: c.promotion.scope.policyScope, pr_url: c.prUrl });
      return undefined;
    }
    const body = [`The config gardener (W1-T4113) rolls back its \`${c.actionClass}\` canary from ${c.prUrl}: ${c.reason ?? "a cohort guardrail breach"}.`, "", rollbackAcceptance(applied, before, ws.root)].join("\n");
    // A revert keeps its own PR. The shared task-files landing counts a path its open PR already holds as carried,
    // whatever that PR's content, so a budget revert riding it could be recorded while the canary's values stay.
    const prUrl = landedPrUrl(await ws.land({ paths, title: `revert(config): the config gardener rolls back its ${c.actionClass} canary`, body, sealedLanding: false }), "config gardener");
    if (!prUrl) throw new Error(`config gardener: rollback PR was not opened for ${c.prUrl}`);
    return prUrl;
  } finally {
    await ws.dispose();
  }
}

type ConfigGardenSpec = Omit<GardenSpec<ConfigGardenClass, ConfigInventory, ConfigGardenAction, GardenCheckout>, "inventory"> & {
  inventory: () => Promise<ConfigInventory>;
};

/** One pass: judge the open canaries, then let the garden act, recording any change it lands as a new
 *  canary that waits in shadow for its merge. */
export async function runConfigGarden(spec: ConfigGardenSpec, deps: GardenerDeps, sources: ConfigGardenSources = {}): Promise<GardenPassResult<ConfigGardenClass, ConfigGardenAction>> {
  await tendConfigCanaries(deps, async () => (await configInventory(deps, sources)).runs);
  if (!gardenPassDue(spec, deps)) return { ran: false };
  // W1-T5668: a pending PR keeps the pass due, yet the pass then returns on an unchanged cheap fingerprint
  // without reading the inventory, so build the 60-day inventory only when the pass would use it. The
  // pending PR's state is read once and handed to the pass, which would otherwise ask for it again.
  const pending = readGardenState(gardenStatePath(deps.stateDir, spec.name), spec.classes).pending;
  const prState = pending ? (deps.prState?.(pending.prUrl) ?? "unknown") : undefined;
  const passDeps: GardenerDeps = pending ? { ...deps, prState: () => prState! } : deps;
  const inventory = gardenNeedsInventory(spec, deps, prState) ? await spec.inventory() : undefined;
  const pass = await runGardenAsync({
    ...spec,
    inventory: () => {
      if (inventory === undefined) throw new Error("config gardener: the pass read an inventory gardenNeedsInventory ruled out");
      return inventory;
    },
  }, passDeps);
  const action = pass.plan?.actions[0];
  if (pass.prUrl && action) {
    // The action's shadow evidence was measured by the inventory. Starting the window from a
    // later clock reading made that very evidence predate it by milliseconds (PR #7141).
    const nowIso = action.shadowObservations[0]?.observedAt ?? (deps.clock ?? systemClock).iso();
    const promotion = configPromotion(action, nowIso);
    const shadow = enterCanary(promotion, action.shadowMetrics, action.shadowObservations, nowIso);
    const canary: ConfigCanary = {
      // The canary step itself is taken on the merge; until then it waits in shadow.
      promotion: { ...promotion, state: shadow.verdict === "advanced" ? "shadow" : shadow.state },
      actionClass: action.class,
      prUrl: pass.prUrl,
      cohort: action.cohort,
      edits: action.edits,
      shadowMetrics: action.shadowMetrics,
      shadowObservations: action.shadowObservations,
    };
    writeConfigCanaries(deps.stateDir, [...readConfigCanaries(deps.stateDir), canary]);
    deps.log(`${CONFIG_GARDEN_NAME}.canary_opened`, { scope: action.scope, pr_url: pass.prUrl, cohort: action.cohort, exposure: action.exposure });
  }
  return pass;
}

/** Run passes on their own timer beside the main loop, never two at once. */
export function startConfigGarden(spec: ConfigGardenSpec, deps: GardenerDeps, sources: ConfigGardenSources, intervalMs: number): { stop: () => void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runConfigGarden(spec, deps, sources);
    } catch (e) {
      deps.log(`${CONFIG_GARDEN_NAME}.gardener_failed`, { error: String((e as Error)?.message ?? e) });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
