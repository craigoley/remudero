/**
 * Pure dispatch calibration (W1-T3412, W1-T5112, W1-T4064). Readers supply committed filing
 * dates and ledger evidence; cost of delay and stride passes never consult the wall clock.
 */
import { createHash } from "node:crypto";
import { deriveTaskClass } from "./task-class.js";
import { streakRefusal } from "./non-worker-verdict.js";

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
  /** W1-T9323: dispatch priority (smaller outranks); absent ranks lowest. It weights the cost-of-delay urgency ({@link dispatchUrgency}). */
  priority?: number;
}

/** Precomputed evidence consumed by the otherwise-pure dispatch comparator. */
export interface DispatchValueContext {
  readonly scoreByClass: ReadonlyMap<string, number>;
  readonly openDependentFanoutByTaskId: ReadonlyMap<string, number>;
  readonly costOfDelayByTaskId?: ReadonlyMap<string, number>;
  readonly stridePassByTaskId?: ReadonlyMap<string, number>;
  readonly costOfDelayInputsByTaskId?: ReadonlyMap<string, DispatchScoreInputs>;
  readonly costOfDelayFallback?: boolean;
  /** W1-T7534: open tasks the filing history cannot date — left unscored, ordered after the scored tier. */
  readonly costOfDelayUnscored?: readonly string[];
  /** W1-T9323: open tasks the filing history cannot date — scored at age 0, never left unscored. */
  readonly costOfDelayImputed?: readonly string[];
  /** W1-T9967: each tier's measured wait, highest tier first; the ready row reports it as `tier_waits`. */
  readonly costOfDelayTierWaits?: readonly TierWait[];
  readonly costOfDelayDependentValues?: readonly DependentValueEntry[];
  readonly costOfDelayDependentCycle?: readonly string[];
}

export interface DependentValueEntry {
  readonly id: string;
  readonly open_dependents: number;
  readonly own_urgency: number;
  readonly dependent_value: number;
}

export interface DispatchScoreInputs {
  /** The installed urgency formula's priority factor, 2^-tierGap (W1-T9325). */
  readonly priority_head_start: number;
  readonly filing_age_ms: number;
  readonly median_wait_ms: number;
  readonly urgency: number;
  readonly dependent_value: number;
  readonly starts: number;
}

/** Explain the captured selection evidence without rebuilding it or consulting a clock. */
export function explainDispatchScore(task: DispatchValueTask, context?: DispatchValueContext) {
  const priority = Number.isFinite(task.priority) ? task.priority! : null;
  if (context?.stridePassByTaskId === undefined || context.costOfDelayFallback) return { basis: "priority-first" as const, priority };
  const inputs = context.costOfDelayInputsByTaskId?.get(task.id);
  return {
    basis: "cost-of-delay" as const, priority,
    priority_head_start: inputs?.priority_head_start ?? null,
    filing_age_ms: inputs?.filing_age_ms ?? null,
    median_wait_ms: inputs?.median_wait_ms ?? null,
    urgency: inputs?.urgency ?? null,
    score: context.costOfDelayByTaskId?.get(task.id) ?? null,
    stride_pass: context.stridePassByTaskId.get(task.id) ?? null,
    starts: inputs?.starts ?? null,
    open_dependents: context.openDependentFanoutByTaskId.get(task.id) ?? 0,
    dependent_value: inputs?.dependent_value ?? null,
    imputed: context.costOfDelayImputed?.includes(task.id) ?? false,
  };
}

/** W1-T9967: one tier's censoring-aware wait. `priority` is null for the absent-priority tier. */
export interface TierWait {
  readonly priority: number | null;
  readonly wait_ms: number;
  readonly events: number;
  readonly censored: number;
  readonly source: "own" | "pooled" | "pooled-lower-bound";
  readonly bound?: "lower";
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

const sortedByJson = new WeakSet<ReadonlyArray<Record<string, unknown>>>();

/**
 * `rows` ordered by each row's `JSON.stringify` under `localeCompare` — the evidence order calibration has
 * always used — with each row serialised ONCE. The comparator used to serialise both rows on every comparison:
 * ~2 n log n serialisations, about 2 GB of strings per sort over the fleet's 61,803 evidence rows (2026-10-10).
 * The comparisons are the same, so the order is the same. The result is frozen and remembered as sorted, so
 * {@link buildDispatchValueContext} does not sort it again.
 */
export function sortRowsByJson(rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<Record<string, unknown>> {
  if (sortedByJson.has(rows)) return rows;
  const keyed = rows.map((row) => ({ row, key: JSON.stringify(row) }));
  keyed.sort((a, b) => a.key.localeCompare(b.key));
  const sorted = Object.freeze(keyed.map(({ row }) => row));
  sortedByJson.add(sorted);
  return sorted;
}

/** The ledger steps {@link estimateClassValues} reads, for the command layer's union filter. */
export const DISPATCH_VALUE_LEDGER_STEPS = ["run.start", "verdict", "verdict.merged"] as const;

/**
 * Date each task id from `git log --first-parent --reverse --format=filing:%ct -p --unified=0` over the plan:
 * an id's first added `id:` line under a `filing:<epoch>` header is its filing time. W1-T7534: the id token
 * includes a letter suffix (W1-T12e, W1-T1B), as the plan loader accepts; a bare `\d+\b` stopped inside the
 * token, left that task undated, and (before unscored tasks were contained) refused every task's cost of delay.
 */
export function filingDatesFromPlanHistory(history: string): Map<string, number> {
  const filedAtByTaskId = new Map<string, number>();
  let at = NaN;
  for (const line of history.split("\n")) {
    const timestamp = /^filing:(\d+)$/.exec(line);
    if (timestamp) at = Number(timestamp[1]) * 1000;
    const id = /^\+\s*(?:-\s*)?id:\s*["']?([A-Z][A-Z0-9]*-T\d+[A-Za-z]*)\b/.exec(line)?.[1];
    if (id && Number.isFinite(at) && !filedAtByTaskId.has(id)) filedAtByTaskId.set(id, at);
  }
  return filedAtByTaskId;
}

/** W1-T7534: the `dispatch.cost_of_delay.ready` row. Its dedup key is per plan tree while any open task is
 * unscored or imputed, or (W1-T9967) any tier wait is reported, so each is ledgered once per tree. */
export function costOfDelayReadyRow(
  planTreeSha: string, context: Pick<DispatchValueContext, "costOfDelayUnscored" | "costOfDelayImputed" | "costOfDelayTierWaits" | "costOfDelayDependentValues" | "costOfDelayDependentCycle">,
): { key: string; plan_tree_sha: string; unscored?: readonly string[]; imputed?: readonly string[]; tier_waits?: readonly TierWait[]; dependent_value?: readonly DependentValueEntry[]; dependent_cycle?: readonly string[] } {
  const unscored = context.costOfDelayUnscored ?? [];
  const imputed = context.costOfDelayImputed ?? [];
  const tierWaits = context.costOfDelayTierWaits ?? [];
  const dependentValues = context.costOfDelayDependentValues ?? [];
  const dependentCycle = context.costOfDelayDependentCycle ?? [];
  if (unscored.length === 0 && imputed.length === 0 && tierWaits.length === 0 && dependentValues.length === 0 && dependentCycle.length === 0) return { key: "ready", plan_tree_sha: planTreeSha };
  return {
    key: `ready:${planTreeSha}`, plan_tree_sha: planTreeSha,
    ...(unscored.length === 0 ? {} : { unscored }), ...(imputed.length === 0 ? {} : { imputed }),
    ...(tierWaits.length === 0 ? {} : { tier_waits: tierWaits }),
    ...(dependentValues.length === 0 ? {} : { dependent_value: dependentValues }),
    ...(dependentCycle.length === 0 ? {} : { dependent_cycle: dependentCycle }),
  };
}

/** Float rounding only: a survival product such as 5/6 * 4/5 * 3/4 lands a hair above one half. */
const SURVIVAL_ROUNDING = 1e-12;

/**
 * W1-T9967: the Kaplan-Meier median wait, the smallest event time at which survival falls to one half or
 * below. A censored wait (a task still waiting) stays at risk through its own time, so the tail that never
 * started holds the curve up where a survivor-only median drops it. Undefined when the curve never crosses.
 */
function censoredMedianWaitMs(events: readonly number[], censored: readonly number[]): number | undefined {
  const observations = [...events.map(at => [at, 1] as const), ...censored.map(at => [at, 0] as const)].sort(([a], [b]) => a - b);
  let atRisk = observations.length;
  let survival = 1;
  for (let i = 0; i < observations.length;) {
    const at = observations[i][0];
    let ended = 0, left = 0;
    for (; i < observations.length && observations[i][0] === at; i++, left++) ended += observations[i][1];
    survival *= 1 - ended / atRisk;
    if (ended > 0 && survival <= 0.5 + SURVIVAL_ROUNDING) return at;
    atRisk -= left;
  }
  return undefined;
}

/** A tier's sort key: its declared priority, or +Infinity for the absent-priority tier below every declared one. */
const tierKey = (task: Pick<DispatchValueTask, "priority">): number =>
  typeof task.priority === "number" && Number.isFinite(task.priority) ? task.priority : Number.POSITIVE_INFINITY;

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
  if (snapshot) rows = sortRowsByJson(rows);
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

/**
 * A task's urgency: `2^-tierGap * (1 + log2(1 + waits))`, `waits` being its age in its tier's own unit (W1-T9967:
 * the largest censoring-aware tier wait at or above its tier) and `tierGap` how far its priority sits below the
 * queue head. Each tier halves the weight and each doubling of the wait adds one unit, so against a fresh task a
 * 1-tier gap closes after 1 tier unit, 2 tiers after 7, 3 after 127: intent holds, and any finite gap still
 * closes. MEASURED 2026-10-14 (median wait 9.5 h): the additive
 * `1 + waits + headStart` scored 36-day-old priority-4 W1-T3083 at 14.7x day-old priority-0.92 W1-T8950.
 */
export function dispatchUrgency(tierGap: number, waits: number): number {
  return 2 ** -Math.max(0, tierGap) * (1 + Math.log2(1 + Math.max(0, waits)));
}

/** Each open task's tier gap below the queue head (the smallest declared priority). An absent priority sits one
 * tier below the lowest declared one, so it orders after every task that carries a priority, as `compareDispatch`
 * and docs/forensics/plan.md#taskpriority have always said. A queue with no declared priority has no gap. */
export function priorityTiers(open: readonly Pick<DispatchValueTask, "priority">[]): (task: Pick<DispatchValueTask, "priority">) => number {
  const declared = open.map(task => task.priority).filter((p): p is number => typeof p === "number" && Number.isFinite(p));
  if (declared.length === 0) return () => 0;
  const head = declared.reduce((lo, p) => Math.min(lo, p), Number.POSITIVE_INFINITY);
  const lowest = declared.reduce((hi, p) => Math.max(hi, p), Number.NEGATIVE_INFINITY);
  return task => (typeof task.priority === "number" && Number.isFinite(task.priority) ? task.priority : lowest + 1) - head;
}

/** W1-T10020: each dependent contributes once, at its own urgency discounted by longest open depth. */
function dependentValue(
  tasks: readonly DispatchValueTask[], tierOf: (task: DispatchValueTask) => number, waits: ReadonlyMap<string, number>,
): { byTaskId: ReadonlyMap<string, number>; cycle: readonly string[] } {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const reverse = new Map<string, Set<string>>();
  for (const task of tasks) for (const id of task.depends_on) {
    if (byId.has(id)) (reverse.get(id) ?? reverse.set(id, new Set()).get(id)!).add(task.id);
  }
  const levels = new Map<string, number | undefined>();
  const stack: string[] = [];
  const active = new Set<string>();
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const cycle = new Set<string>();
  const visit = (id: string): void => {
    const index = indices.size;
    indices.set(id, index);
    low.set(id, index);
    stack.push(id);
    active.add(id);
    for (const dependency of byId.get(id)!.depends_on) {
      if (!byId.has(dependency)) continue;
      if (!indices.has(dependency)) {
        visit(dependency);
        low.set(id, Math.min(low.get(id)!, low.get(dependency)!));
      } else if (active.has(dependency)) low.set(id, Math.min(low.get(id)!, indices.get(dependency)!));
    }
    if (low.get(id) !== index) return;
    const members: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      active.delete(member);
      members.push(member);
    } while (member !== id);
    if (members.length > 1 || byId.get(id)!.depends_on.includes(id)) {
      for (const member of members) { cycle.add(member); levels.set(member, undefined); }
    } else {
      const below = byId.get(id)!.depends_on.map(dependency => levels.get(dependency)).filter((level): level is number => level !== undefined);
      levels.set(id, below.reduce((level, dependency) => Math.max(level, dependency + 1), 0));
    }
  };
  for (const task of tasks) if (!indices.has(task.id)) visit(task.id);
  const byTaskId = new Map<string, number>();
  for (const task of tasks) {
    let value = 0;
    const level = levels.get(task.id);
    if (level !== undefined) {
      const seen = new Set([task.id]);
      const pending = [...(reverse.get(task.id) ?? [])];
      while (pending.length > 0) {
        const id = pending.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const depth = levels.get(id);
        if (depth !== undefined) value += dispatchUrgency(tierOf(byId.get(id)!) + depth - level, waits.get(id)!);
        for (const dependent of reverse.get(id) ?? []) pending.push(dependent);
      }
    }
    byTaskId.set(task.id, value);
  }
  return { byTaskId, cycle: [...cycle].sort() };
}

/** Pool ceil(sqrt(dated runs)) nearest runs, including every equal-distance group.
 * Grouped evidence retains its whole tally; no input order or fixed age bucket decides a tie. */
export function validityShareNearAge(
  samples: ReadonlyArray<readonly [number, { readonly valid: number; readonly total: number }]>, age: number,
): { valid: number; total: number } {
  if (!Number.isFinite(age) || samples.some(([at, tally]) => !Number.isFinite(at) ||
    !Number.isSafeInteger(tally.total) || tally.total <= 0 || !Number.isSafeInteger(tally.valid) ||
    tally.valid < 0 || tally.valid > tally.total)) throw new RangeError("Invalid age-validity evidence");
  const datedRuns = samples.reduce((sum, [, tally]) => sum + tally.total, 0);
  if (!Number.isSafeInteger(datedRuns)) throw new RangeError("Invalid dated-run count");
  if (datedRuns === 0) return { valid: 0, total: 0 };
  const ordered = samples.every(([at], i) => i === 0 || samples[i - 1][0] <= at)
    ? samples : [...samples].sort(([a], [b]) => a - b);
  let lo = 0, hi = ordered.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ordered[mid][0] < age) lo = mid + 1;
    else hi = mid;
  }
  const wanted = Math.ceil(Math.sqrt(datedRuns));
  let left = lo - 1, right = lo, valid = 0, total = 0;
  while (total < wanted && (left >= 0 || right < ordered.length)) {
    const distance = Math.min(left >= 0 ? Math.abs(ordered[left][0] - age) : Infinity,
      right < ordered.length ? Math.abs(ordered[right][0] - age) : Infinity);
    while (left >= 0 && Math.abs(ordered[left][0] - age) === distance) {
      valid += ordered[left][1].valid;
      total += ordered[left--][1].total;
    }
    while (right < ordered.length && Math.abs(ordered[right][0] - age) === distance) {
      valid += ordered[right][1].valid;
      total += ordered[right++][1].total;
    }
  }
  return { valid, total };
}

interface TierPass { readonly id: string; readonly tier: number; readonly blocked: boolean; readonly pass0: number; readonly passF: number }

/**
 * W1-T9968 (operator 2026-10-17: fan-out never jumps a tier): the no-fan-out passes fix which tier owns each
 * position; inside a tier the members take that tier's passes in their with-fan-out order. Every cross-tier
 * comparison reads what it would with no fan-out, and the result stays a total order. A pairwise rule
 * (without fan-out across tiers, with it inside one) is not transitive. Blocked tasks (an open dependency) trade
 * slots only among themselves: a chain's blocked members carry the fan-out and would push a ready task back.
 * MEASURED 2026-10-16: W1-T9874 (P2, 29 open dependents) scored 17x the fresh P1 W1-T9926.
 */
function fanoutWithinTier(passes: readonly TierPass[]): Map<string, number> {
  const byGroup = new Map<string, TierPass[]>();
  for (const entry of passes) {
    const group = `${entry.tier}:${entry.blocked}`;
    (byGroup.get(group) ?? byGroup.set(group, []).get(group)!).push(entry);
  }
  const stridePassByTaskId = new Map<string, number>();
  for (const members of byGroup.values()) {
    const slots = members.map(m => m.pass0).sort((a, b) => a - b);
    const ranked = [...members].sort((a, b) => a.passF - b.passF || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    ranked.forEach((m, k) => stridePassByTaskId.set(m.id, slots[k]));
  }
  return stridePassByTaskId;
}

function costOfDelayContext(
  tasks: readonly DispatchValueTask[], rows: ReadonlyArray<Record<string, unknown>>,
  openIds: ReadonlySet<string>, nowMs: number, snapshot: CostOfDelaySnapshot,
  context: DispatchValueContext, estimates: ReadonlyMap<string, ClassValueEstimate>,
): { kind: "ready"; context: Pick<DispatchValueContext, "costOfDelayByTaskId" | "stridePassByTaskId" | "costOfDelayInputsByTaskId" | "costOfDelayUnscored" | "costOfDelayImputed" | "costOfDelayTierWaits" | "costOfDelayDependentValues" | "costOfDelayDependentCycle"> }
  | { kind: "refused"; reasons: readonly string[] } {
  if (!snapshot.planTreeSha || !Number.isFinite(nowMs)) return { kind: "refused", reasons: ["unreadable-snapshot"] };
  const starts = new Map<string, { id: string; at: number }>();
  const outcomes = new Map<string, { at: number; stale: boolean }>();
  const lastVerdicts = new Map<string, { at: number; row: Record<string, unknown> }>();
  let windowStart = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const at = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    if (Number.isFinite(at) && at <= nowMs && at < windowStart) windowStart = at;
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
    if (row.step === "verdict") {
      const previous = lastVerdicts.get(row.run_id);
      if (!previous || at > previous.at) lastVerdicts.set(row.run_id, { at, row });
    }
  }
  const ages = new Map<number, { valid: number; total: number }>();
  const counts = new Map<string, number>();
  for (const [runId, start] of [...starts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    // A run no worker tried (restart yield, claim race, infra refusal, failed harness checkpoint) spends no
    // stride: the breaker's own set, {@link streakRefusal}. MEASURED 2026-10-11: W1-T7742's 7 starts were all
    // non-worker, so its pass was 8/score and every fresh priority-1 task outranked it.
    const verdict = lastVerdicts.get(runId);
    if (!verdict || streakRefusal(verdict.row) === undefined) counts.set(start.id, (counts.get(start.id) ?? 0) + 1);
    const filedAt = snapshot.filedAtByTaskId.get(start.id);
    const outcome = outcomes.get(runId);
    if (filedAt === undefined || !Number.isFinite(filedAt) || filedAt > start.at || !outcome || outcome.at < start.at) continue;
    const age = start.at - filedAt;
    const tally = ages.get(age) ?? { valid: 0, total: 0 };
    tally.total++;
    if (!outcome.stale) tally.valid++;
    ages.set(age, tally);
  }
  // W1-T9323: the measured wait — each task's first start minus its filing time — is the unit that turns age
  // into urgency. W1-T9967: measured per tier, counting a still-waiting open task as censored. Nothing is
  // fixed: with no wait sample the schedule is refused.
  const firstStartByTask = new Map<string, number>();
  const lastStartByTask = new Map<string, number>();
  for (const start of starts.values()) {
    const previous = firstStartByTask.get(start.id);
    if (previous === undefined || start.at < previous) firstStartByTask.set(start.id, start.at);
    if (start.at > (lastStartByTask.get(start.id) ?? -Infinity)) lastStartByTask.set(start.id, start.at);
  }
  const keyById = new Map(tasks.map(task => [task.id, tierKey(task)]));
  const pooled = { events: [] as number[], censored: [] as number[] };
  const byTier = new Map<number, { events: number[]; censored: number[] }>();
  const sampleOf = (key: number) => byTier.get(key) ?? byTier.set(key, { events: [], censored: [] }).get(key)!;
  for (const [id, at] of firstStartByTask) {
    const filedAt = snapshot.filedAtByTaskId.get(id);
    if (filedAt === undefined || !Number.isFinite(filedAt) || filedAt > at) continue;
    pooled.events.push(at - filedAt);
    // A task outside the plan has no tier; it informs only the pooled curve.
    const key = keyById.get(id);
    if (key !== undefined) sampleOf(key).events.push(at - filedAt);
  }
  for (const task of tasks) {
    if (!openIds.has(task.id)) continue;
    const sample = sampleOf(tierKey(task));
    const filedAt = snapshot.filedAtByTaskId.get(task.id);
    // Censored only when no start follows its filing. Filed before the window's earliest row, a task may have
    // started unseen: never read that as still waiting.
    if (filedAt === undefined || !Number.isFinite(filedAt) || filedAt > nowMs || filedAt < windowStart ||
      (lastStartByTask.get(task.id) ?? -Infinity) >= filedAt) continue;
    sample.censored.push(nowMs - filedAt);
    pooled.censored.push(nowMs - filedAt);
  }
  const pooledMedian = censoredMedianWaitMs(pooled.events, pooled.censored);
  // A pooled curve that never crosses one half still bounds the wait from below by its longest event.
  const pooledWaitMs = pooledMedian ?? pooled.events.reduce((hi, wait) => Math.max(hi, wait), 0);
  if (!(pooledWaitMs > 0)) return { kind: "refused", reasons: ["no-wait-evidence"] };
  const costOfDelayTierWaits: TierWait[] = [];
  const unitByTier = new Map<number, number>();
  let envelope = 0;
  for (const [key, sample] of [...byTier].sort(([a], [b]) => a - b)) {
    const own = censoredMedianWaitMs(sample.events, sample.censored);
    const source = own !== undefined && own > 0 ? "own" : pooledMedian !== undefined ? "pooled" : "pooled-lower-bound";
    const waitMs = source === "own" ? own as number : pooledWaitMs;
    costOfDelayTierWaits.push({
      priority: Number.isFinite(key) ? key : null, wait_ms: waitMs, events: sample.events.length, censored: sample.censored.length,
      source, ...(source === "pooled-lower-bound" ? { bound: "lower" as const } : {}),
    });
    // A lower tier ages in the largest wait at or above it, so it never closes a gap faster than a higher tier waits.
    envelope = Math.max(envelope, waitMs);
    unitByTier.set(key, envelope);
  }
  // Priority weights the urgency (it is not a one-rank head start); an absent priority is the lowest tier.
  const open = tasks.filter(task => openIds.has(task.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const tierOf = priorityTiers(open);
  const ageById = new Map(open.map(task => {
    const filedAt = snapshot.filedAtByTaskId.get(task.id);
    const dated = filedAt !== undefined && Number.isFinite(filedAt) && filedAt <= nowMs;
    return [task.id, dated ? nowMs - filedAt : 0] as const;
  }));
  const waits = new Map(open.map(task => [task.id, ageById.get(task.id)! / unitByTier.get(tierKey(task))!]));
  const dependents = dependentValue(open, tierOf, waits);
  const samples = [...ages].sort(([a], [b]) => a - b);
  const valid = samples.reduce((sum, [, tally]) => sum + tally.valid, 0);
  const total = samples.reduce((sum, [, tally]) => sum + tally.total, 0);
  const prior = (valid + 1) / (total + 2);
  const costOfDelayByTaskId = new Map<string, number>();
  const passes: TierPass[] = [];
  const costOfDelayInputsByTaskId = new Map<string, DispatchScoreInputs>();
  const costOfDelayImputed: string[] = [];
  const costOfDelayDependentValues: DependentValueEntry[] = [];
  for (const task of open) {
    const filedAt = snapshot.filedAtByTaskId.get(task.id);
    // W1-T9323: an undatable task (an id the filing scan cannot read, a snapshot one selection behind, a
    // future date) is scored at age 0 and named as imputed, so it joins the stride order instead of trailing it.
    const dated = filedAt !== undefined && Number.isFinite(filedAt) && filedAt <= nowMs;
    if (!dated) costOfDelayImputed.push(task.id);
    const estimate = estimates.get(deriveTaskClass(task));
    if (!estimate || estimate.costPerAttempt <= 0) return { kind: "refused", reasons: [`${task.id}:unmeasured-cost`] };
    const age = ageById.get(task.id)!;
    const share = validityShareNearAge(samples, age);
    const probability = share.total === 0 ? prior
      : (share.valid + DISPATCH_VALUE_PRIOR_WEIGHT * prior) / (share.total + DISPATCH_VALUE_PRIOR_WEIGHT);
    const classScore = context.scoreByClass.get(deriveTaskClass(task));
    // Posterior/cost-per-merge gives every class a share even when its raw merge count is zero.
    const mergeProbability = estimate.alpha / (estimate.alpha + estimate.beta);
    const urgency = dispatchUrgency(tierOf(task), waits.get(task.id)!);
    const dependent_value = dependents.byTaskId.get(task.id)!;
    const factor = probability * (classScore ?? NaN) * mergeProbability;
    const score0 = factor * urgency;
    const score = factor * (urgency + dependent_value);
    const open_dependents = context.openDependentFanoutByTaskId.get(task.id) ?? 0;
    if (open_dependents > 0) costOfDelayDependentValues.push({ id: task.id, open_dependents, own_urgency: urgency, dependent_value });
    // Each unique dispatch consumes one stride. Rebuilding from all starts survives restarts
    // and keeps a frequently selected high-score task from monopolizing a fixed frontier.
    const strides = 1 + (counts.get(task.id) ?? 0);
    const pass0 = strides / score0, passF = strides / score;
    if (![score0, score, pass0, passF].every(Number.isFinite) || score0 <= 0) return { kind: "refused", reasons: [`${task.id}:unmeasured-score`] };
    costOfDelayByTaskId.set(task.id, score);
    passes.push({ id: task.id, tier: tierKey(task), blocked: task.depends_on.some(id => openIds.has(id)), pass0, passF });
    costOfDelayInputsByTaskId.set(task.id, Object.freeze({
      priority_head_start: 2 ** -tierOf(task), filing_age_ms: age,
      median_wait_ms: unitByTier.get(tierKey(task)) as number, urgency, dependent_value, starts: counts.get(task.id) ?? 0,
    }));
  }
  const stridePassByTaskId = fanoutWithinTier(passes);
  return {
    kind: "ready",
    context: { costOfDelayByTaskId, stridePassByTaskId, costOfDelayInputsByTaskId, costOfDelayTierWaits,
      costOfDelayDependentValues, costOfDelayDependentCycle: dependents.cycle,
      ...(costOfDelayImputed.length === 0 ? {} : { costOfDelayImputed }) },
  };
}

/** Return a task's trusted class score; absent stays absent rather than becoming a synthetic zero. */
export function measuredDispatchValue(task: Pick<DispatchValueTask, "files">, context: DispatchValueContext | undefined): number | undefined {
  return context?.scoreByClass.get(deriveTaskClass(task));
}
