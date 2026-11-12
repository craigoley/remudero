import type { Task } from "./plan.js";
import { planDestinationRepository } from "./plan-destination.js";
import { readOpsCatalogSnapshotAsync, type OpsCatalogApi } from "./ops-catalog-source.js";
import type { PlanCriteriaAtHeadResult } from "./review.js";

export interface TaskLookupOptions {
  stateDir?: string;
  api?: OpsCatalogApi;
}
export interface TaskLookupDeps extends TaskLookupOptions {
  readPublic: (taskId: string) => Task | undefined | Promise<Task | undefined>;
}
export type TaskLookupResult =
  | { outcome: "found"; task: Task; catalog: "public" | "ops"; commit?: string }
  | { outcome: "absent"; task?: undefined; catalog?: undefined }
  | { outcome: "unreadable"; reason: string; task?: undefined; catalog?: undefined };

/** Resolve a host-private task. The existing public reader owns its reads; only a proven miss opens ops. */
export async function findTaskInCatalogs(taskId: string, deps: TaskLookupDeps): Promise<TaskLookupResult> {
  let publicTask: Task | undefined;
  try { publicTask = await deps.readPublic(taskId); }
  catch (error) {
    // The public read failed, not the task lookup: retain that distinction without echoing plan bytes.
    return { outcome: "unreadable", reason: error instanceof Error ? "public-plan-error" : "public-plan-thrown" };
  }
  if (publicTask !== undefined) return { outcome: "found", task: publicTask, catalog: "public" };
  const destination = planDestinationRepository(deps.stateDir);
  if (destination.outcome === "off") return { outcome: "absent" };
  if (destination.outcome === "unreadable") return { outcome: "unreadable", reason: "destination-unreadable" };
  const snapshot = await readOpsCatalogSnapshotAsync({ repository: `${destination.owner}/${destination.repo}` }, deps.api);
  if (snapshot.outcome !== "ok" || snapshot.plan === undefined) {
    return { outcome: "unreadable", reason: `ops-${snapshot.outcome}` };
  }
  const task = snapshot.plan.byId.get(taskId);
  return task === undefined ? { outcome: "absent" } : { outcome: "found", task, catalog: "ops", commit: snapshot.binding?.commit };
}

/** Private contract for review/fix, never a PR-body or status serializer. */
export function catalogTaskContract(result: Extract<TaskLookupResult, { outcome: "found" }>): PlanCriteriaAtHeadResult {
  const task = result.task;
  return {
    taskId: task.id, criteria: task.acceptance ?? [], taskDeclaredFiles: task.files,
    taskRisk: task.risk, taskBudgetUsd: task.budget_usd,
    taskNarrative: {
      ...(task.design === undefined ? {} : { design: task.design }),
      ...(task.amendment === undefined ? {} : { amendment: task.amendment }),
      ...(task.narrativeUnavailable ? { narrativeUnavailable: true as const } : {}),
    },
    source: `${result.catalog} catalog task ${task.id}` + (result.commit ? ` at ${result.commit}` : ""),
  };
}
