/**
 * Measured value calibration for dispatch (W1-T3412, reworked by W1-T5112).
 *
 * Pure. The command layer reads the ledger union and hands over its rows; the selector receives
 * only the immutable result. Value per task class is P(merge per dispatched attempt) divided by
 * cost per attempt over a trailing window, each smoothed toward the fleet-wide figure, so a thin
 * class sits near the fleet mean instead of being refused. Only an unreadable corpus refuses.
 */
import { deriveTaskClass } from "./task-class.js";

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
}

/** One class's smoothed estimate over the window. `mean` is the posterior merge probability per attempt. */
export interface ClassValueEstimate {
  readonly mean: number;
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
  const fleet: ClassValueEstimate = {
    mean: fleetRate,
    attempts: fleetAttempts,
    merges: fleetMerges,
    costPerAttempt: fleetCostPerAttempt,
    value: valueOf(fleetRate, fleetCostPerAttempt),
  };
  const byClass = new Map<string, ClassValueEstimate>();
  for (const [taskClass, t] of tally) {
    const merges = t.mergedTaskIds.size;
    const mean = (merges + priorWeight * fleetRate) / (t.attempts + priorWeight);
    const costPerAttempt = fleetCosted > 0 ? (t.cost + priorWeight * fleetCostPerAttempt) / (t.costed + priorWeight) : 0;
    byClass.set(taskClass, { mean, attempts: t.attempts, merges, costPerAttempt, value: valueOf(mean, costPerAttempt) });
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
 * Score every class the window or the open queue names. A class with attempts gets its smoothed
 * estimate; an open class with none sits exactly at the fleet prior and is named in `refusals`, so its
 * tasks tie among themselves and keep the fanout/id order. Only an unreadable corpus refuses.
 */
export function buildDispatchValueContext(
  tasks: readonly DispatchValueTask[],
  rows: ReadonlyArray<Record<string, unknown>>,
  openTaskIds: ReadonlySet<string>,
  nowMs: number,
  unionComplete = true,
): DispatchValueCalibration {
  if (!unionComplete) return { kind: "refused", reasons: ["incomplete-union"] };
  const { byClass, fleet } = estimateClassValues(rows, nowMs);
  const estimates = new Map(byClass);
  const refusals: string[] = [];
  if (fleet.attempts > 0) {
    for (const task of tasks) {
      if (!openTaskIds.has(task.id)) continue;
      const taskClass = deriveTaskClass(task);
      if (estimates.has(taskClass)) continue;
      estimates.set(taskClass, { mean: fleet.mean, attempts: 0, merges: 0, costPerAttempt: fleet.costPerAttempt, value: fleet.value });
      refusals.push(`${taskClass}:no-attempts`);
    }
  }
  const scoreByClass = new Map<string, number>();
  for (const [taskClass, estimate] of estimates) scoreByClass.set(taskClass, estimate.value);
  return {
    kind: "ready",
    context: Object.freeze({ scoreByClass, openDependentFanoutByTaskId: openDependentFanout(tasks, openTaskIds) }),
    estimates,
    fleet,
    refusals,
  };
}

/** Return a task's trusted class score; absent stays absent rather than becoming a synthetic zero. */
export function measuredDispatchValue(task: Pick<DispatchValueTask, "files">, context: DispatchValueContext | undefined): number | undefined {
  return context?.scoreByClass.get(deriveTaskClass(task));
}
