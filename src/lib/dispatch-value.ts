/**
 * Pure dispatch calibration (W1-T3412, W1-T5112, W1-T4064). Readers supply committed filing
 * dates and ledger evidence; cost of delay and stride passes never consult the wall clock.
 */
import { createHash } from "node:crypto";
import { deriveTaskClass } from "./task-class.js";

/** Keeps the pooled prior strictly inside (0, 1) so a zero-merge fleet still yields a proper Beta. */
const PRIOR_RATE_EPSILON = 1e-3;

/** The trailing window the estimate reads. Policy data for the estimate, never a gate on dispatch. */
export const DISPATCH_VALUE_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Pseudo-attempts of fleet-wide evidence each class starts from (the Beta prior's weight). */
export const DISPATCH_VALUE_PRIOR_WEIGHT = 2;

export interface DispatchValueTask {
  id: string;
  depends_on: readonly string[];
  files?: string[];
}

/** Precomputed evidence consumed by the otherwise-pure dispatch comparator. */
export interface DispatchValueContext {
  readonly scoreByClass: ReadonlyMap<string, number>;
  readonly openDependentFanoutByTaskId: ReadonlyMap<string, number>;
  readonly costOfDelayByTaskId?: ReadonlyMap<string, number>;
  readonly stridePassByTaskId?: ReadonlyMap<string, number>;
  readonly costOfDelayFallback?: boolean;
}

export interface CostOfDelaySnapshot {
  readonly planTreeSha: string;
  readonly filedAtByTaskId: ReadonlyMap<string, number>;
}

/** One class's smoothed estimate over the window. `mean` is the posterior merge probability per attempt. */
export interface ClassValueEstimate {
  readonly mean: number;
  /** Beta posterior parameters over P(merge per dispatched attempt): pooled prior plus this class's evidence. */
  readonly alpha: number;
  readonly beta: number;
  readonly attempts: number;
  readonly merges: number;
  readonly costPerAttempt: number;
  readonly value: number;
}

export type DispatchValueCalibration =
  | {
      kind: "ready";
      context: DispatchValueContext;
      estimates: ReadonlyMap<string, ClassValueEstimate>;
      fleet: ClassValueEstimate;
      refusals: readonly string[];
    }
  | { kind: "refused"; reasons: readonly string[] };

/** The ledger steps {@link estimateClassValues} reads, for the command layer's union filter. */
export const DISPATCH_VALUE_LEDGER_STEPS = ["run.start", "verdict", "verdict.merged"] as const;

/** A plan task's id (`W1-T123`, `CONSOLE-T7`); synthetic lane runs (RETRO, TRIAGE-…) are not build attempts. */
const PLAN_TASK_ID = /^[A-Z][A-Z0-9]*-T\d+$/;

const valueOf = (mean: number, costPerAttempt: number): number => (costPerAttempt > 0 ? mean / costPerAttempt : mean);

/** The pooled (empirical-Bayes) prior's merge rate, clamped so both Beta parameters stay positive. */
const pooledRate = (fleetRate: number): number => Math.min(1 - PRIOR_RATE_EPSILON, Math.max(PRIOR_RATE_EPSILON, fleetRate));

/** Beta(weight*rate + merges, weight*(1-rate) + failures): the class's evidence layered on the fleet-wide prior. */
function posterior(fleetRate: number, priorWeight: number, merges: number, attempts: number): { alpha: number; beta: number; mean: number } {
  const rate = pooledRate(fleetRate);
  const alpha = priorWeight * rate + merges;
  const beta = priorWeight * (1 - rate) + Math.max(0, attempts - merges);
  return { alpha, beta, mean: alpha / (alpha + beta) };
}

/** A content hash of the committed plan's task ids and dependencies: the same plan tree yields the same seed. */
export function planSeed(tasks: readonly DispatchValueTask[]): string {
  const h = createHash("sha256");
  for (const task of [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    h.update(`${task.id}:${[...task.depends_on].sort().join(",")}\n`);
  }
  return h.digest("hex");
}

/** Seeded uniforms in (0, 1): sha256 of the seed and a label, so every class draws independently of iteration order. */
function seededUniforms(seed: string, label: string): () => number {
  let counter = 0;
  return () => {
    const digest = createHash("sha256").update(`${seed}\u0000${label}\u0000${counter++}`).digest();
    return (digest.readUIntBE(0, 6) + 0.5) / 2 ** 48;
  };
}

/** Marsaglia–Tsang gamma(shape, 1) from a uniform stream; shapes below 1 use the U^(1/shape) boost. */
function gammaDraw(shape: number, uniform: () => number): number {
  if (shape < 1) return gammaDraw(shape + 1, uniform) * uniform() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    if (Math.log(uniform()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/** One reproducible draw from Beta(alpha, beta): the same (seed, label, alpha, beta) always gives the same number. */
export function betaDraw(alpha: number, beta: number, seed: string, label: string): number {
  const uniform = seededUniforms(seed, label);
  const x = gammaDraw(alpha, uniform);
  const y = gammaDraw(beta, uniform);
  const draw = x / (x + y);
  return Number.isFinite(draw) && draw > 0 ? draw : alpha / (alpha + beta);
}

/**
 * Per-class merges per dispatched attempt and cost per attempt over the trailing window. An attempt is a
 * `run.start` with a `task_class`; it counts as merged when its task carries a merge credit (`verdict.merged`,
 * or a `verdict` row reading `merged`) inside the window; its cost is its own `verdict` row's `cost_usd`.
 */
export function estimateClassValues(
  rows: ReadonlyArray<Record<string, unknown>>,
  nowMs: number,
  windowMs: number = DISPATCH_VALUE_WINDOW_MS,
  priorWeight: number = DISPATCH_VALUE_PRIOR_WEIGHT,
): { byClass: Map<string, ClassValueEstimate>; fleet: ClassValueEstimate } {
  const since = nowMs - windowMs;
  const inWindow = (row: Record<string, unknown>) => {
    const ts = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
    return !Number.isNaN(ts) && ts >= since && ts <= nowMs;
  };
  const attempts = new Map<string, { taskId: string; taskClass: string }>();
  const costByRun = new Map<string, number>();
  const mergedTasks = new Set<string>();
  for (const row of rows) {
    if (!inWindow(row)) continue;
    const runId = typeof row.run_id === "string" ? row.run_id : undefined;
    const taskId = typeof row.task_id === "string" ? row.task_id : undefined;
    if (row.step === "run.start" && runId && taskId && PLAN_TASK_ID.test(taskId) && typeof row.task_class === "string") {
      attempts.set(runId, { taskId, taskClass: row.task_class });
    } else if (row.step === "verdict.merged" && taskId) {
      mergedTasks.add(taskId);
    } else if (row.step === "verdict") {
      if (row.verdict === "merged" && taskId) mergedTasks.add(taskId);
      if (runId && typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd) && row.cost_usd >= 0) costByRun.set(runId, row.cost_usd);
    }
  }
  const tally = new Map<string, { attempts: number; mergedTaskIds: Set<string>; cost: number; costed: number }>();
  for (const [runId, { taskId, taskClass }] of attempts) {
    const t = tally.get(taskClass) ?? { attempts: 0, mergedTaskIds: new Set<string>(), cost: 0, costed: 0 };
    t.attempts += 1;
    if (mergedTasks.has(taskId)) t.mergedTaskIds.add(taskId);
    const cost = costByRun.get(runId);
    if (cost !== undefined) {
      t.cost += cost;
      t.costed += 1;
    }
    tally.set(taskClass, t);
  }
  let fleetAttempts = 0;
  let fleetMerges = 0;
  let fleetCost = 0;
  let fleetCosted = 0;
  for (const t of tally.values()) {
    fleetAttempts += t.attempts;
    fleetMerges += t.mergedTaskIds.size;
    fleetCost += t.cost;
    fleetCosted += t.costed;
  }
  const fleetRate = fleetAttempts > 0 ? fleetMerges / fleetAttempts : 0;
  const fleetCostPerAttempt = fleetCosted > 0 ? fleetCost / fleetCosted : 0;
  const fleetPosterior = posterior(fleetRate, 0, fleetMerges, fleetAttempts);
  const fleet: ClassValueEstimate = {
    mean: fleetRate,
    alpha: fleetPosterior.alpha,
    beta: fleetPosterior.beta,
    attempts: fleetAttempts,
    merges: fleetMerges,
    costPerAttempt: fleetCostPerAttempt,
    value: valueOf(fleetRate, fleetCostPerAttempt),
  };
  const byClass = new Map<string, ClassValueEstimate>();
  for (const [taskClass, t] of tally) {
    const merges = t.mergedTaskIds.size;
    const { alpha, beta, mean } = posterior(fleetRate, priorWeight, merges, t.attempts);
    const costPerAttempt = fleetCosted > 0 ? (t.cost + priorWeight * fleetCostPerAttempt) / (t.costed + priorWeight) : 0;
    byClass.set(taskClass, { mean, alpha, beta, attempts: t.attempts, merges, costPerAttempt, value: valueOf(mean, costPerAttempt) });
  }
  return { byClass, fleet };
}

/**
 * Count every transitive dependent that remains open under the caller's live merge projection.
 * The traversal is structural and bounded by the plan's finite task set; it does not consult the
 * decorative YAML status field.
 */
export function openDependentFanout(
  tasks: readonly DispatchValueTask[],
  openTaskIds: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const reverse = new Map<string, string[]>();
  for (const task of tasks) {
    if (!openTaskIds.has(task.id)) continue;
    for (const dependency of task.depends_on) {
      const dependents = reverse.get(dependency) ?? [];
      dependents.push(task.id);
      reverse.set(dependency, dependents);
    }
  }
  const fanout = new Map<string, number>();
  for (const task of tasks) {
    if (!openTaskIds.has(task.id)) continue;
    const seen = new Set<string>();
    const pending = [...(reverse.get(task.id) ?? [])];
    while (pending.length > 0) {
      const id = pending.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dependent of reverse.get(id) ?? []) pending.push(dependent);
    }
    fanout.set(task.id, seen.size);
  }
  return fanout;
}

/**
 * Score every class the window or the open queue names. A class with attempts gets its Beta posterior; an
 * open class with none sits at the pooled prior and is named in `refusals`. With a `seed`, each class's
 * score is one Thompson draw from its posterior (seeded per class, so the same seed gives the same order
 * and exploration shrinks as trials accrue); without one it is the posterior mean. A score is never absent
 * for a measured or open class and never zero. Only an unreadable corpus refuses.
 */
export function buildDispatchValueContext(
  tasks: readonly DispatchValueTask[],
  rows: ReadonlyArray<Record<string, unknown>>,
  openTaskIds: ReadonlySet<string>,
  nowMs: number,
  unionComplete = true,
  seed?: string,
  snapshot?: CostOfDelaySnapshot,
): DispatchValueCalibration {
  if (!unionComplete) return { kind: "refused", reasons: ["incomplete-union"] };
  if (snapshot) rows = [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const { byClass, fleet } = estimateClassValues(rows, nowMs);
  const estimates = new Map(byClass);
  const refusals: string[] = [];
  if (fleet.attempts > 0) {
    for (const task of tasks) {
      if (!openTaskIds.has(task.id)) continue;
      const taskClass = deriveTaskClass(task);
      if (estimates.has(taskClass)) continue;
      const prior = posterior(fleet.mean, DISPATCH_VALUE_PRIOR_WEIGHT, 0, 0);
      estimates.set(taskClass, { mean: fleet.mean, alpha: prior.alpha, beta: prior.beta, attempts: 0, merges: 0, costPerAttempt: fleet.costPerAttempt, value: fleet.value });
      refusals.push(`${taskClass}:no-attempts`);
    }
  }
  const scoreByClass = new Map<string, number>();
  for (const [taskClass, estimate] of estimates) {
    const drawSeed = snapshot?.planTreeSha ?? seed;
    const score = drawSeed === undefined ? estimate.value : valueOf(betaDraw(estimate.alpha, estimate.beta, drawSeed, taskClass), estimate.costPerAttempt);
    scoreByClass.set(taskClass, score);
  }
  const context: DispatchValueContext = { scoreByClass, openDependentFanoutByTaskId: openDependentFanout(tasks, openTaskIds) };
  if (snapshot) {
    const scheduled = costOfDelayContext(tasks, rows, openTaskIds, nowMs, snapshot, context, estimates);
    if (scheduled.kind === "refused") return scheduled;
    Object.assign(context, scheduled.context);
  }
  return {
    kind: "ready",
    context: Object.freeze(context),
    estimates,
    fleet,
    refusals,
  };
}

function costOfDelayContext(
  tasks: readonly DispatchValueTask[], rows: ReadonlyArray<Record<string, unknown>>,
  openIds: ReadonlySet<string>, nowMs: number, snapshot: CostOfDelaySnapshot,
  context: DispatchValueContext, estimates: ReadonlyMap<string, ClassValueEstimate>,
): { kind: "ready"; context: Pick<DispatchValueContext, "costOfDelayByTaskId" | "stridePassByTaskId"> }
  | { kind: "refused"; reasons: readonly string[] } {
  if (!snapshot.planTreeSha || !Number.isFinite(nowMs)) return { kind: "refused", reasons: ["unreadable-snapshot"] };
  const starts = new Map<string, { id: string; at: number }>();
  const outcomes = new Map<string, { at: number; stale: boolean }>();
  for (const row of rows) {
    const at = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(at) || at > nowMs || typeof row.run_id !== "string" || typeof row.task_id !== "string") continue;
    if ((row.step === "run.start" || row.step === "dispatch.refused_already_merged") && PLAN_TASK_ID.test(row.task_id)) {
      const previous = starts.get(row.run_id);
      if (!previous || at < previous.at) starts.set(row.run_id, { id: row.task_id, at });
    }
    if (row.step === "dispatch.refused_already_merged" || (row.step === "verdict" && typeof row.verdict === "string")) {
      const stale = row.step === "dispatch.refused_already_merged" || ["already_satisfied", "no_pr", "task_already_merged"].includes(String(row.verdict));
      const previous = outcomes.get(row.run_id);
      if (!previous || at > previous.at) outcomes.set(row.run_id, { at, stale });
    }
  }
  const ages = new Map<number, { valid: number; total: number }>();
  const counts = new Map<string, number>();
  for (const [runId, start] of [...starts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    counts.set(start.id, (counts.get(start.id) ?? 0) + 1);
    const filedAt = snapshot.filedAtByTaskId.get(start.id);
    const outcome = outcomes.get(runId);
    if (filedAt === undefined || !Number.isFinite(filedAt) || filedAt > start.at || !outcome || outcome.at < start.at) continue;
    const age = start.at - filedAt;
    const tally = ages.get(age) ?? { valid: 0, total: 0 };
    tally.total++;
    if (!outcome.stale) tally.valid++;
    ages.set(age, tally);
  }
  const samples = [...ages].sort(([a], [b]) => a - b);
  const valid = samples.reduce((sum, [, tally]) => sum + tally.valid, 0);
  const total = samples.reduce((sum, [, tally]) => sum + tally.total, 0);
  const prior = (valid + 1) / (total + 2);
  const costOfDelayByTaskId = new Map<string, number>();
  const stridePassByTaskId = new Map<string, number>();
  for (const task of [...tasks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (!openIds.has(task.id)) continue;
    const filedAt = snapshot.filedAtByTaskId.get(task.id);
    if (filedAt === undefined || !Number.isFinite(filedAt) || filedAt > nowMs) return { kind: "refused", reasons: [`${task.id}:missing-filing-date`] };
    const estimate = estimates.get(deriveTaskClass(task));
    if (!estimate || estimate.costPerAttempt <= 0) return { kind: "refused", reasons: [`${task.id}:unmeasured-cost`] };
    const age = nowMs - filedAt;
    const nearest = samples.reduce<typeof samples[number] | undefined>((best, sample) =>
      best === undefined || Math.abs(sample[0] - age) < Math.abs(best[0] - age) ? sample : best, undefined);
    const probability = nearest === undefined ? prior
      : (nearest[1].valid + DISPATCH_VALUE_PRIOR_WEIGHT * prior) / (nearest[1].total + DISPATCH_VALUE_PRIOR_WEIGHT);
    const classScore = context.scoreByClass.get(deriveTaskClass(task));
    // One unit is the task's own impact; open dependents add units. Posterior/cost-per-merge
    // gives every class a share even when its raw merge count is zero.
    const mergeProbability = estimate.alpha / (estimate.alpha + estimate.beta);
    const score = probability * (1 + (context.openDependentFanoutByTaskId.get(task.id) ?? 0)) * (classScore ?? NaN) * mergeProbability;
    // Each unique dispatch consumes one stride. Rebuilding from all starts survives restarts
    // and keeps a frequently selected high-score task from monopolizing a fixed frontier.
    const pass = (1 + (counts.get(task.id) ?? 0)) / score;
    if (!Number.isFinite(score) || !Number.isFinite(pass) || score <= 0) return { kind: "refused", reasons: [`${task.id}:unmeasured-score`] };
    costOfDelayByTaskId.set(task.id, score);
    stridePassByTaskId.set(task.id, pass);
  }
  return { kind: "ready", context: { costOfDelayByTaskId, stridePassByTaskId } };
}

/** Return a task's trusted class score; absent stays absent rather than becoming a synthetic zero. */
export function measuredDispatchValue(task: Pick<DispatchValueTask, "files">, context: DispatchValueContext | undefined): number | undefined {
  return context?.scoreByClass.get(deriveTaskClass(task));
}
