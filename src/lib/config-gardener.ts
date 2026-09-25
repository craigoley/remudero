import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { systemClock } from "./clock.js";
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
import { writeAtomic } from "./fs-race-safe.js";
import { gardenStatePath, judgeGardenDecision, readGardenState, runGarden, type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec, type PrState } from "./gardener.js";
import { buildEntryWeightIndex, DEFAULT_KNOWLEDGE_BUDGET_CHARS, loadLearningsCorpus } from "./learnings.js";
import type { LedgerLine } from "./ledger.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import type { BillingMode } from "./env.js";
import { recommendMounts, type MountHeadroomCell, type MountRecommendation } from "./mount-recommender.js";
import { loadMounts } from "./mounts.js";
import { loadPlan } from "./plan.js";
import { planShards } from "./plan-gardener.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { gatherRuns, type LedgerRecord, type RunSummary } from "./retro.js";
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
 *     its route in `.remudero/mounts.yaml`.
 *   - RE-DERIVE-CAP: the learnings character cap is re-derived from the spawns measured UNDER the
 *     current cap, with the same two functions that derived it (digest.ts).
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

export type ConfigGardenClass = "recalibrate-budget" | "adopt-mount" | "re-derive-cap";
export const CONFIG_GARDEN_CLASSES: readonly ConfigGardenClass[] = ["recalibrate-budget", "adopt-mount", "re-derive-cap"];

/** One whole-line replacement in a repo file. A rollback swaps `from` and `to`. */
export interface ConfigEdit {
  path: string;
  from: string;
  to: string;
}

/** Who a canary exposes. `tasks`: named shards against the same class's other tasks, concurrently.
 *  `cell`/`all`: every run it routes, against the same population over the equal window before. */
export type ConfigCohort = { kind: "tasks"; taskClass: string; taskIds: string[] } | { kind: "cell"; type: string; risk: string; taskClass: string } | { kind: "all" };

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

export interface ConfigInventory {
  nowIso: string;
  runs: RunSummary[];
  queued: QueuedBudget[];
  recommendations: MountRecommendation[];
  cap?: { current: number; derivation: KnowledgeBudgetDerivation };
  active: ConfigCanary[];
  /** Scopes whose canary was rolled back or declined within {@link CANARY_TTL_MS}: re-proposing the same
   *  change on the next pass would only repeat the verdict. */
  cooling: string[];
}

/** Where the gardener reads. Every field has a production default; a test supplies its own. */
export interface ConfigGardenSources {
  ledgerRows?: () => Array<Record<string, unknown>>;
  mountRecommendations?: () => MountRecommendation[];
  entryWeights?: () => Record<string, number>;
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
/** Every canary needs this many tasks on BOTH sides before it is judged (experiment-promotion's floor). */
export const CANARY_DENOMINATOR_FLOOR = 5;
/** PRIMARY CONTROL on exposure: a budget canary changes at most this many shards at once. */
export const CANARY_MAX_COHORT = 10;
export const CANARY_TTL_MS = 21 * 24 * 3600 * 1000;
/** How often the ledger union is re-read for planning: every tick would read it every poll. */
export const CONFIG_GARDEN_BUCKET_MS = 6 * 3600 * 1000;
/** How often the open canaries are judged. */
export const CONFIG_TEND_INTERVAL_MS = 3600 * 1000;

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

/** Distinct settled tasks among `runs`, how many merged, and their summed cost. */
export function cohortOutcome(runs: RunSummary[]): CohortOutcome {
  const tasks = new Map<string, boolean>();
  let costUsd = 0;
  for (const r of runs) {
    if (r.verdict === "incomplete") continue;
    tasks.set(r.taskId, (tasks.get(r.taskId) ?? false) || r.verdict === "merged");
    costUsd += r.costUsd;
  }
  return { tasks: tasks.size, merged: [...tasks.values()].filter(Boolean).length, costUsd };
}

/** The canary cohort's runs and the rest's, per {@link ConfigCohort}, since `exposedAt`. */
export function splitCohort(cohort: ConfigCohort, runs: RunSummary[], exposedAt: string, nowIso: string): { canary: RunSummary[]; rest: RunSummary[] } {
  const since = Date.parse(exposedAt);
  const at = (r: RunSummary) => Date.parse(r.startTs);
  if (cohort.kind === "tasks") {
    const ids = new Set(cohort.taskIds);
    const after = runs.filter((r) => settledImplement(r) && r.taskClass === cohort.taskClass && at(r) >= since);
    return { canary: after.filter((r) => ids.has(r.taskId)), rest: after.filter((r) => !ids.has(r.taskId)) };
  }
  const inScope = (r: RunSummary) => cohort.kind === "all" ? r.type === "implement" : r.type === cohort.type && r.risk === cohort.risk && r.taskClass === cohort.taskClass;
  const before = since - Math.max(0, Date.parse(nowIso) - since);
  const scoped = runs.filter((r) => inScope(r) && r.verdict !== "incomplete");
  return { canary: scoped.filter((r) => at(r) >= since), rest: scoped.filter((r) => at(r) >= before && at(r) < since) };
}

function population(cohort: ConfigCohort): string {
  if (cohort.kind === "tasks") return `implement tasks of class ${cohort.taskClass}`;
  if (cohort.kind === "cell") return `${cohort.type} runs at ${cohort.risk} risk of class ${cohort.taskClass}`;
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

export function configInventory(deps: GardenerDeps, sources: ConfigGardenSources = {}): ConfigInventory {
  const rows = (sources.ledgerRows ?? (() => readLedgerUnionRecordsSync(deps.stateDir, { rotationWindowMs: 60 * 24 * 3600 * 1000, minRotations: 4 }).rows))();
  const weights = (sources.entryWeights ?? (() => buildEntryWeightIndex(loadLearningsCorpus(resolveRepoLayout(deps.repoRoot).learningsDir))))();
  const nowMs = (deps.clock ?? systemClock).now();
  const canaries = readConfigCanaries(deps.stateDir);
  return {
    nowIso: new Date(nowMs).toISOString(),
    runs: gatherRuns(rows as LedgerRecord[]),
    queued: queuedBudgets(deps.repoRoot, deps.stateDir),
    recommendations: sources.mountRecommendations?.() ?? [],
    cap: { current: DEFAULT_KNOWLEDGE_BUDGET_CHARS, derivation: capDerivation(rows, weights, DEFAULT_KNOWLEDGE_BUDGET_CHARS) },
    active: canaries.filter((c) => isPromotionActive(c.promotion.state)),
    cooling: canaries.filter((c) => c.promotion.state === "rolled_back" && nowMs - Date.parse(c.promotion.createdAt) < CANARY_TTL_MS).map((c) => c.promotion.scope.policyScope),
  };
}

/** Mount recommendations as the gardener reads them: the recommender's own gates over the headroom
 *  sweep, kept to the recommendations. A sweep that cannot be built (no runs yet) is logged and reads as
 *  none, so the other classes still act. */
export function mountRecommendationSource(opts: {
  build: (stateDir: string) => { cells: MountHeadroomCell[] };
  stateDir: string;
  mountsFile: string;
  billingMode: BillingMode;
  log: GardenerDeps["log"];
}): () => MountRecommendation[] {
  return () => {
    try {
      const outcomes = recommendMounts(opts.build(opts.stateDir).cells, loadMounts(opts.mountsFile), { billingMode: opts.billingMode });
      return outcomes.filter((o): o is MountRecommendation => o.kind === "recommendation");
    } catch (e) {
      opts.log(`${CONFIG_GARDEN_NAME}.mount_recommendations_unread`, { error: String((e as Error)?.message ?? e) });
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
  const byClass = new Map<string, number[]>();
  for (const r of inv.runs.filter(settledImplement)) byClass.set(r.taskClass ?? "unknown", [...(byClass.get(r.taskClass ?? "unknown") ?? []), r.costUsd]);
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
  return {
    class: "recalibrate-budget",
    target: best.taskClass,
    scope: `budget:${best.taskClass}`,
    reason: `class ${best.taskClass}: p90 of ${best.costs.length} settled implement runs is $${usd(nearestRank(best.costs, 90))}; ${best.off.length} queued shard(s) declare a budget ${Math.round(BUDGET_MIN_CHANGE * 100)}%+ away from $${usd(best.budget)}.`,
    edits: cohort.map((q) => ({ path: q.shard, from: q.line, to: `  budget_usd: ${usd(best!.budget)}` })),
    cohort: { kind: "tasks", taskClass: best.taskClass, taskIds: cohort.map((q) => q.id) },
    candidate: `budget_usd ${usd(best.budget)} for ${cohort.length} queued ${best.taskClass} shard(s)`,
    baseline: `declared budget_usd on those shards (${cohort.map((q) => usd(q.budgetUsd)).join(", ")})`,
    exposure: Math.min(1, cohort.length / Math.max(inClass, 1)),
    shadowMetrics: [{ metricName: "shadow_overrun_rate", unit: "fraction", direction: "max", abortThreshold: BUDGET_MAX_SHADOW_OVERRUN }],
    shadowObservations: [{ metricName: "shadow_overrun_rate", value: overrun, denominator: best.costs.length, freshness: "verified", comparisonPopulation: cohortPop, observedAt: inv.nowIso }],
  };
}

/** The `routes.<type>.<risk>.<class>` flow-map line in a mounts.yaml text, or undefined. */
export function routeLine(text: string, type: string, risk: string, taskClass: string): string | undefined {
  const lines = text.split("\n");
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
  const c = r < 0 ? -1 : at(r + 1, 6, taskClass);
  return c < 0 || !/\{.*\bmodel:.*\beffort:.*\}/.test(lines[c]!) ? undefined : lines[c];
}

/** The first recommendation whose route exists and would change, adopted on the same provider only —
 *  a provider switch changes more than the one line this edits. */
export function mountCandidate(inv: ConfigInventory, repoRoot: string): ConfigGardenAction | undefined {
  const path = ".remudero/mounts.yaml";
  const full = join(repoRoot, path);
  if (!existsSync(full) || inv.recommendations.length === 0) return undefined;
  const text = readFileSync(full, "utf8");
  for (const rec of inv.recommendations) {
    if (rec.recommendedArm.provider !== rec.currentArm.provider) continue;
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

/** The re-derived learnings cap, edited in both places the drift test pins together. */
export function capCandidate(inv: ConfigInventory): ConfigGardenAction | undefined {
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
      { path: "scripts/knowledge-budget-baseline.json", from: `  "capChars": ${cur}`, to: `  "capChars": ${next}` },
    ],
    cohort,
    candidate: `learnings cap ${next} chars`,
    baseline: `learnings cap ${cur} chars`,
    exposure: 1,
    shadowMetrics: [{ metricName: "dropped_weight_p90_chars", unit: "chars", direction: "min", abortThreshold: TRIVIAL_DROPPED_WEIGHT_CHARS }],
    shadowObservations: [{ metricName: "dropped_weight_p90_chars", value: d.pressure.droppedWeightP90, denominator: d.pressure.spawnsMeasured, freshness: "verified", comparisonPopulation: population(cohort), observedAt: inv.nowIso }],
  };
}

/** A draft promotion for `action`, approved by the gardener's own draw and not yet exposed. */
export function configPromotion(action: ConfigGardenAction, nowIso: string, repo = "remudero"): PromotionRecord {
  const now = Date.parse(nowIso);
  const expiresAt = new Date(now + CANARY_TTL_MS).toISOString();
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

/** Every change any class could make now, each already clear of its shadow guard and of any scope an
 *  active canary holds. */
export function configCandidates(inv: ConfigInventory, repoRoot: string, rng: () => number): ConfigGardenAction[] {
  const all = [budgetCandidate(inv, rng), mountCandidate(inv, repoRoot), capCandidate(inv)].filter((a): a is ConfigGardenAction => a !== undefined);
  const held = inv.active.map((c) => ({ promotionId: c.promotion.promotionId, scope: c.promotion.scope, state: c.promotion.state }));
  return all.filter((a) => {
    const p = configPromotion(a, inv.nowIso);
    return !inv.cooling.includes(a.scope) && !findScopeConflict(held, p.scope, p.promotionId) && enterCanary(p, a.shadowMetrics, a.shadowObservations, inv.nowIso).verdict === "advanced";
  });
}

// ── Apply and roll back ──────────────────────────────────────────────────────────────────────

/** Apply `edits` under `root`; returns the paths changed. An edit whose `from` line is not present
 *  exactly once is skipped — the file moved on, and a guess would edit the wrong line. */
export function applyConfigEdits(root: string, edits: ConfigEdit[]): string[] {
  const changed = new Set<string>();
  for (const e of edits) {
    const path = join(root, e.path);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    const hits = lines.flatMap((l, i) => (l === e.from ? [i] : []));
    if (hits.length !== 1) continue;
    lines[hits[0]!] = e.to;
    writeFileSync(path, lines.join("\n"));
    changed.add(e.path);
  }
  return [...changed].sort();
}

export const reverseEdits = (edits: ConfigEdit[]): ConfigEdit[] => edits.map((e) => ({ path: e.path, from: e.to, to: e.from }));

function acceptance(edits: ConfigEdit[]): string[] {
  return ["## Acceptance", ...edits.flatMap((e) => [`- claim: ${e.path} carries the canary's value`, `  proof: grep: ${e.to.trim()} in ${e.path}`])];
}

function prBody(action: ConfigGardenAction): string {
  return [
    `The config gardener (W1-T4113) proposes a **${action.class}** canary on \`${action.scope}\`: ${action.reason}`,
    "",
    `Exposure: ${action.cohort.kind === "tasks" ? `${action.cohort.taskIds.length} shard(s) — ${action.cohort.taskIds.join(", ")}` : "every run this route/cap reaches"}. Once merged, the gardener compares the cohort with the rest by merge rate and cost per merged task; a guardrail breach opens a PR reverting exactly these lines and debits the class, a promotion credits it.`,
    "",
    ...action.edits.map((e) => `- \`${e.path}\`: \`${e.from.trim()}\` → \`${e.to.trim()}\``),
    "",
    ...acceptance(action.edits),
  ].join("\n");
}

const titles: Record<ConfigGardenClass, string> = {
  "recalibrate-budget": "chore(plan): the config gardener canaries recalibrated budgets",
  "adopt-mount": "chore(mounts): the config gardener canaries a recommended mount",
  "re-derive-cap": "chore(learnings): the config gardener canaries a re-derived learnings cap",
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
    fingerprint: (inv) => [inv.queued.map((q) => `${q.id}=${q.budgetUsd}`).join(","), inv.recommendations.map((r) => r.cellKey).join(","), inv.cap?.derivation.recommendedCapChars, inv.runs.length].join("|"),
    // The canary judges these classes (tendConfigCanaries settles the pending class), so the framework's
    // own metric is held still: it never credits or debits on a number the canary did not produce.
    metric: () => ({ trials: 0, successes: 0 }),
    candidates: (inv, rng) => configCandidates(inv, deps.repoRoot, rng),
    scorecard: (inv, plan) => ({ runs: inv.runs.length, queued_budgets: inv.queued.length, recommendations: inv.recommendations.length, active_canaries: inv.active.length, proposed: plan.actions.map((a) => a.scope) }),
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
 * revert of exactly the canary's lines and debits the class; a promotion credits it.
 */
export function tendConfigCanaries(deps: GardenerDeps, runs: () => RunSummary[]): TendResult[] {
  const nowMs = (deps.clock ?? systemClock).now();
  const file = readConfigCanaryFile(deps.stateDir);
  const canaries = file.canaries;
  if (!canaries.some((c) => isPromotionActive(c.promotion.state))) return [];
  if (file.lastTendMs !== undefined && nowMs - file.lastTendMs < CONFIG_TEND_INTERVAL_MS) return [];
  const nowIso = new Date(nowMs).toISOString();
  const results: TendResult[] = [];
  let measured: RunSummary[] | undefined;
  for (const [i, c] of canaries.entries()) {
    if (!isPromotionActive(c.promotion.state)) continue;
    let exposed = c.promotion.state !== "shadow";
    let step: CanaryStep;
    if (!exposed) {
      const pr: PrState = deps.prState?.(c.prUrl) ?? "unknown";
      if (pr === "closed") step = { state: "rolled_back", verdict: "rolled_back", reason: "its PR was closed unmerged; nothing was exposed" };
      else if (pr !== "merged") continue;
      else {
        exposed = true;
        c.exposedAt = nowIso;
        const entry = enterCanary(c.promotion, c.shadowMetrics, c.shadowObservations.map((o) => ({ ...o, observedAt: c.promotion.observationWindow.start })), nowIso);
        step = entry.verdict === "advanced" ? entry : { state: "rolled_back", verdict: "rolled_back", reason: `its shadow guard refused exposure: ${entry.reason ?? entry.state}` };
      }
    } else {
      measured ??= runs();
      const split = splitCohort(c.cohort, measured, c.exposedAt ?? c.promotion.observationWindow.start, nowIso);
      step = stepCanary(c.promotion, cohortGuardObservations(cohortOutcome(split.canary), cohortOutcome(split.rest), c.promotion.comparisonPopulation, nowIso), nowIso);
    }
    c.promotion = { ...c.promotion, state: step.state };
    c.reason = step.reason ?? c.reason;
    if (step.verdict === "rolled_back" && exposed) c.rollbackPrUrl = rollBack(deps, c);
    if (step.verdict === "rolled_back") settlePending(deps.stateDir, c.prUrl, "debit");
    if (step.verdict === "promoted") settlePending(deps.stateDir, c.prUrl, "credit");
    if (step.verdict === "expired") settlePending(deps.stateDir, c.prUrl, "release");
    if (step.verdict !== "waiting") deps.log(`${CONFIG_GARDEN_NAME}.canary_${step.verdict}`, { scope: c.promotion.scope.policyScope, pr_url: c.prUrl, state: step.state, reason: step.reason ?? null, rollback_pr_url: c.rollbackPrUrl ?? null });
    canaries[i] = c;
    results.push({ canary: c, step });
  }
  writeConfigCanaries(deps.stateDir, canaries, nowMs);
  return results;
}

/** Land a PR reverting exactly the canary's lines; the receipt is its url, or why there was none. */
function rollBack(deps: GardenerDeps, c: ConfigCanary): string | undefined {
  const ws = deps.openWorkspace();
  try {
    const edits = reverseEdits(c.edits);
    const paths = applyConfigEdits(ws.root, edits);
    if (paths.length === 0) {
      deps.log(`${CONFIG_GARDEN_NAME}.rollback_nothing_to_revert`, { scope: c.promotion.scope.policyScope, pr_url: c.prUrl });
      return undefined;
    }
    const body = [`The config gardener (W1-T4113) rolls back its \`${c.actionClass}\` canary from ${c.prUrl}: ${c.reason ?? "a cohort guardrail breach"}.`, "", ...acceptance(edits)].join("\n");
    return ws.land({ paths, title: `revert(config): the config gardener rolls back its ${c.actionClass} canary`, body });
  } finally {
    ws.dispose();
  }
}

type ConfigGardenSpec = GardenSpec<ConfigGardenClass, ConfigInventory, ConfigGardenAction, GardenCheckout>;

/** One pass: judge the open canaries, then let the garden act, recording any change it lands as a new
 *  canary that waits in shadow for its merge. */
export function runConfigGarden(spec: ConfigGardenSpec, deps: GardenerDeps, sources: ConfigGardenSources = {}): ReturnType<typeof runGarden<ConfigGardenClass, ConfigInventory, ConfigGardenAction, GardenCheckout>> {
  tendConfigCanaries(deps, () => configInventory(deps, sources).runs);
  const pass = runGarden(spec, deps);
  const action = pass.plan?.actions[0];
  if (pass.prUrl && action) {
    const nowIso = new Date((deps.clock ?? systemClock).now()).toISOString();
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
  const tick = () => {
    if (running) return;
    running = true;
    try {
      runConfigGarden(spec, deps, sources);
    } catch (e) {
      deps.log(`${CONFIG_GARDEN_NAME}.gardener_failed`, { error: String((e as Error)?.message ?? e) });
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
