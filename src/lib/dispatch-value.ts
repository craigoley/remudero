/**
 * Measured value calibration for dispatch (W1-T3412).
 *
 * This module is deliberately pure. The command layer proves its ledger union complete and
 * supplies the last two closure snapshots; the selector receives only the immutable result.
 * A missing or refused calibration therefore cannot make queue selection perform filesystem I/O
 * or turn absent history into an invented rate.
 */

import { deriveTaskClass } from "./task-class.js";
import { CLOSURE_POPULATION_FLOOR, type ClassClosure } from "./retro-closure.js";

/** A ten-percent relative movement is the largest two-cycle movement treated as stable. */
export const DISPATCH_VALUE_STABILITY_TOLERANCE = 0.1;

export interface DispatchValueTask {
  id: string;
  depends_on: readonly string[];
  files?: string[];
}

export interface ClosureCalibrationSnapshot {
  ts: string;
  rows: readonly ClassClosure[];
}

/** Precomputed evidence consumed by the otherwise-pure dispatch comparator. */
export interface DispatchValueContext {
  readonly scoreByClass: ReadonlyMap<string, number>;
  readonly openDependentFanoutByTaskId: ReadonlyMap<string, number>;
}

export type DispatchValueCalibration =
  | { kind: "ready"; context: DispatchValueContext; refusals: readonly string[] }
  | { kind: "refused"; reasons: readonly string[] };

function scoreFor(row: ClassClosure): number | undefined {
  if (row.mergeRate.kind !== "rate") return undefined;
  if (row.mergeRate.denominator < CLOSURE_POPULATION_FLOOR || row.mergeRate.merged <= 0 || row.merged <= 0) return undefined;
  if (!Number.isFinite(row.mergeRate.value) || row.mergeRate.value < 0) return undefined;
  if (row.costPerMerge === null || !Number.isFinite(row.costPerMerge) || row.costPerMerge <= 0) return undefined;
  return row.mergeRate.value / row.costPerMerge;
}

function stable(current: number, prior: number): boolean {
  const scale = Math.max(Math.abs(current), Math.abs(prior), Number.EPSILON);
  return Math.abs(current - prior) / scale <= DISPATCH_VALUE_STABILITY_TOLERANCE;
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
 * Build value only from two complete, independently-recorded closure snapshots. A class can be
 * unmeasured while the calibration as a whole remains ready: it then uses the precomputed fanout
 * tie-break. A missing prior snapshot refuses the entire calibration and leaves the historic
 * priority/scope/id order untouched.
 */
export function buildDispatchValueContext(
  tasks: readonly DispatchValueTask[],
  snapshots: readonly ClosureCalibrationSnapshot[],
  openTaskIds: ReadonlySet<string>,
  unionComplete = true,
): DispatchValueCalibration {
  if (!unionComplete) return { kind: "refused", reasons: ["incomplete-union"] };
  if (snapshots.length < 2) return { kind: "refused", reasons: ["missing-prior-snapshot"] };
  const [current, prior] = [...snapshots].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 2);
  if (!current || !prior || !current.ts || !prior.ts) return { kind: "refused", reasons: ["missing-prior-snapshot"] };

  const currentByClass = new Map(current.rows.map((row) => [row.taskClass, row]));
  const priorByClass = new Map(prior.rows.map((row) => [row.taskClass, row]));
  const scoreByClass = new Map<string, number>();
  const refusals: string[] = [];

  for (const taskClass of new Set([...currentByClass.keys(), ...priorByClass.keys()])) {
    const currentRow = currentByClass.get(taskClass);
    const priorRow = priorByClass.get(taskClass);
    if (!currentRow || !priorRow) {
      refusals.push(`${taskClass}:missing-prior-class`);
      continue;
    }
    const currentScore = scoreFor(currentRow);
    const priorScore = scoreFor(priorRow);
    if (currentScore === undefined || priorScore === undefined) {
      const reason = currentRow.mergeRate.kind === "refused" || priorRow.mergeRate.kind === "refused" ||
          (currentRow.mergeRate.kind === "rate" && currentRow.mergeRate.denominator < CLOSURE_POPULATION_FLOOR) ||
          (priorRow.mergeRate.kind === "rate" && priorRow.mergeRate.denominator < CLOSURE_POPULATION_FLOOR)
        ? "thin-class"
        : currentRow.costPerMerge === null || priorRow.costPerMerge === null || currentRow.merged <= 0 || priorRow.merged <= 0
          ? "zero-merge-class"
          : "invalid-cost";
      refusals.push(`${taskClass}:${reason}`);
      continue;
    }
    if (!stable(currentScore, priorScore)) {
      refusals.push(`${taskClass}:unstable-value`);
      continue;
    }
    scoreByClass.set(taskClass, currentScore);
  }

  // A row that failed the closure contract is not a harmless missing value: it is evidence the
  // calibration population cannot be trusted. Return no context at all so affected queue pairs
  // retain the exact historic id tie-break instead of receiving a partial policy activation.
  if (refusals.length > 0) return { kind: "refused", reasons: refusals };
  return {
    kind: "ready",
    context: Object.freeze({
      scoreByClass,
      openDependentFanoutByTaskId: openDependentFanout(tasks, openTaskIds),
    }),
    refusals,
  };
}

/** Return a task's trusted class score; absent stays absent rather than becoming a synthetic zero. */
export function measuredDispatchValue(task: Pick<DispatchValueTask, "files">, context: DispatchValueContext | undefined): number | undefined {
  return context?.scoreByClass.get(deriveTaskClass(task));
}
