import { loadPlanAtRefAsync } from "./plan.js";
import { repoRoot } from "./repo-location.js";
import type { TaskHoldReading } from "./review.js";
import { findTaskInCatalogs, type TaskLookupResult } from "./task-lookup.js";

/**
 * W1-T14902: the one reader of a named task's `dispatch_hold`, for the review's guarded poster and the merge path alike.
 * It reads the plan of this checkout at origin/main first, then the ops catalog, never the pull request's head: a hold
 * added on main is seen, and a head cannot release its own hold.
 *
 * INVARIANT an-unread-hold-holds: a plan that cannot be read, a refused ops read, and an ops answer served from the last
 * good snapshot (it may predate the hold) all answer `unread`, which holds. Only a record read fresh says `clear`.
 */
export interface TaskDispatchHoldSources {
  /** The plan at origin/main. Default: this checkout's `plan/tasks.yaml` at `origin/main`. */
  readMainPlan?: () => Promise<{ byId: ReadonlyMap<string, { dispatch_hold?: boolean }> }>;
  /** The ops catalog lookup. Default: {@link findTaskInCatalogs} with no public plan, under `stateDir`. */
  lookup?: (taskId: string) => Promise<TaskLookupResult>;
  /** The instance state dir naming the ops catalog (its plan destination). */
  stateDir: string;
}

const TASK_ID = /^[A-Z][A-Z0-9]*-T\d+$/;

export async function readTaskDispatchHold(taskId: string | undefined, sources: TaskDispatchHoldSources): Promise<TaskHoldReading> {
  // A synthetic review key (`PR-<n>`, `dep-review-PR<n>`) or no trailer names no task: it reviews and arms as today.
  if (taskId === undefined || !TASK_ID.test(taskId)) return { outcome: "clear" };
  let main: { byId: ReadonlyMap<string, { dispatch_hold?: boolean }> };
  try {
    main = await (sources.readMainPlan ?? (() => loadPlanAtRefAsync(repoRoot, "plan/tasks.yaml", "origin/main")))();
  } catch (error) {
    return { outcome: "unread", taskId, reason: `the plan at origin/main is unreadable: ${String((error as Error)?.message ?? error)}` };
  }
  const inMain = main.byId.get(taskId);
  if (inMain !== undefined) return inMain.dispatch_hold === true ? { outcome: "held", taskId } : { outcome: "clear" };
  const lookup = sources.lookup ?? ((id: string) => findTaskInCatalogs(id, { byId: new Map(), stateDir: sources.stateDir }));
  let found: TaskLookupResult;
  try {
    found = await lookup(taskId);
  } catch (error) {
    return { outcome: "unread", taskId, reason: `the ops catalog lookup threw: ${String((error as Error)?.message ?? error)}` };
  }
  if (found.outcome === "unreadable") return { outcome: "unread", taskId, reason: found.reason };
  if (found.outcome === "absent") return { outcome: "clear" };
  if (found.lastGood !== undefined) return { outcome: "unread", taskId, reason: `served from the last good ops snapshot (${found.lastGood.refusal})` };
  return found.task.dispatch_hold === true ? { outcome: "held", taskId } : { outcome: "clear" };
}
