import { parseTasksFromYaml, TASK_RISKS, TASK_STATUSES, TASK_TYPES, type Plan, type Task } from "./plan.js";
import { planDestinationRepository } from "./plan-destination.js";
import { readOpsCatalogSnapshotAsync, type OpsCatalogApi, type OpsCatalogSnapshot } from "./ops-catalog-source.js";
import type { PlanCriteriaAtHeadResult } from "./review.js";

export interface TaskLookupOptions {
  stateDir?: string;
  api?: OpsCatalogApi;
  /** A caller that already read and pinned both catalogs can reuse that exact ops snapshot. */
  opsSnapshot?: OpsCatalogSnapshot;
}
export type TaskLookupResult =
  | { outcome: "found"; task: Task & { catalog?: "public" | "ops" }; catalog: "public" | "ops"; commit?: string }
  | { outcome: "absent"; task?: undefined; catalog?: undefined }
  | { outcome: "unreadable"; reason: string; task?: undefined; catalog?: undefined };

// Keep the complete private snapshot off enumerable lookup results and serializers.
// Only the exact lookup result can recover the already-read Plan; no second reader is opened.
const opsLookupPlans = new WeakMap<object, Plan>();
export function opsPlanForLookup(result: TaskLookupResult): Plan | undefined {
  return result.outcome === "found" && result.catalog === "ops" ? opsLookupPlans.get(result) : undefined;
}

function isParsedPlanTask(value: unknown): value is Task {
  if (value === null || typeof value !== "object") return false;
  const task = value as Task;
  return typeof task.id === "string" && task.id.length > 0 &&
    typeof task.title === "string" && task.title.length > 0 &&
    typeof task.repo === "string" && task.repo.length > 0 &&
    Array.isArray(task.depends_on) && task.depends_on.every((dependency) => typeof dependency === "string") &&
    TASK_TYPES.includes(task.type) && TASK_RISKS.includes(task.risk) && TASK_STATUSES.includes(task.status) &&
    (task.verify === "auto" || task.verify === "human") &&
    (task.dispatch_hold === undefined || typeof task.dispatch_hold === "boolean") &&
    (task.priority === undefined || typeof task.priority === "number");
}

function isParsedPlanSnapshot(value: unknown): value is Plan {
  try {
    if (value === null || typeof value !== "object") return false;
    const plan = value as Plan;
    if (!Array.isArray(plan.tasks) || !(plan.byId instanceof Map) || plan.byId.size !== plan.tasks.length) return false;
    // A manually constructed snapshot can bypass parse-time constraints such as not_before and precondition.
    // Revalidate a detached serialization through the canonical plan parser before trusting any task.
    const serializedTasks = JSON.stringify(plan.tasks);
    if (typeof serializedTasks !== "string" || parseTasksFromYaml(serializedTasks, "secondary catalog shadow snapshot").length !== plan.tasks.length) return false;
    const seen = new Set<string>();
    for (const value of plan.tasks) {
      if (!isParsedPlanTask(value)) return false;
      const task = value;
      if (seen.has(task.id) || plan.byId.get(task.id) !== task) return false;
      seen.add(task.id);
    }
    for (const [id, task] of plan.byId) {
      if (typeof id !== "string" || !seen.has(id) || task?.id !== id) return false;
    }
    return true;
  } catch (error: unknown) {
    // A hostile snapshot getter/proxy is malformed; never expose its value or partially trust it.
    void error;
    return false;
  }
}

type SecondaryComposition =
  | { outcome: "ok"; plan: Plan; secondaryIds: ReadonlySet<string> }
  | { outcome: "malformed" | "duplicate_task_id" | "invalid_cross_catalog_dependency"; taskId?: string };

/** One atomic graph rule shared by observation and explicit live selection. */
export function composeSecondaryPlan(primary: Plan, secondary: Plan): SecondaryComposition {
  if (!isParsedPlanSnapshot(primary) || !isParsedPlanSnapshot(secondary)) return { outcome: "malformed" };
  const primaryIds = new Set(primary.tasks.map(task => task.id));
  const duplicate = secondary.tasks.find(task => primaryIds.has(task.id));
  if (duplicate) return { outcome: "duplicate_task_id", taskId: duplicate.id };
  const secondaryIds = new Set(secondary.tasks.map(task => task.id));
  if (primary.tasks.some(task => task.depends_on.some(id => secondaryIds.has(id))) ||
    secondary.tasks.some(task => task.depends_on.some(id => !primaryIds.has(id) && !secondaryIds.has(id)))) {
    return { outcome: "invalid_cross_catalog_dependency" };
  }
  return { outcome: "ok", secondaryIds, plan: {
    tasks: [...primary.tasks, ...secondary.tasks], byId: new Map([...primary.byId, ...secondary.byId]),
  } };
}

/** Resolve a host-private task. The existing public reader owns its reads; only a proven miss opens ops. */
export async function findTaskInCatalogs(taskId: string, sources: TaskLookupOptions & Pick<Plan, "byId">): Promise<TaskLookupResult> {
  let publicTask: Task | undefined;
  try { publicTask = sources.byId.get(taskId); }
  catch (error) {
    // The public read failed, not the task lookup: retain that distinction without echoing plan bytes.
    return { outcome: "unreadable", reason: error instanceof Error ? "public-plan-error" : "public-plan-thrown" };
  }
  if (publicTask !== undefined) return { outcome: "found", task: publicTask, catalog: "public" };
  const destination = planDestinationRepository(sources.stateDir);
  if (destination.outcome === "off") return { outcome: "absent" };
  if (destination.outcome === "unreadable") return { outcome: "unreadable", reason: "destination-unreadable" };
  const snapshot = sources.opsSnapshot ?? await readOpsCatalogSnapshotAsync({ repository: `${destination.owner}/${destination.repo}` }, sources.api);
  if (snapshot.outcome !== "ok" || snapshot.plan === undefined) {
    return { outcome: "unreadable", reason: `ops-${snapshot.outcome}` };
  }
  const task = snapshot.plan.byId.get(taskId);
  if (task === undefined) return { outcome: "absent" };
  const result: Extract<TaskLookupResult, { outcome: "found" }> = {
    outcome: "found", task: { ...task, catalog: "ops" }, catalog: "ops", commit: snapshot.binding?.commit,
  };
  opsLookupPlans.set(result, snapshot.plan);
  return result;
}

export type CatalogTaskContract = PlanCriteriaAtHeadResult & { taskCatalog?: "public" | "ops" };

/** Private contract for review/fix, never a PR-body or status serializer. */
export function catalogTaskContract(result: Extract<TaskLookupResult, { outcome: "found" }>): CatalogTaskContract {
  const task = result.task;
  return {
    taskCatalog: result.catalog, taskId: task.id, criteria: task.acceptance ?? [], taskDeclaredFiles: task.files,
    taskRisk: task.risk, taskBudgetUsd: task.budget_usd,
    taskNarrative: {
      ...(task.design === undefined ? {} : { design: task.design }),
      ...(task.amendment === undefined ? {} : { amendment: task.amendment }),
      ...(task.narrativeUnavailable ? { narrativeUnavailable: true as const } : {}),
    },
    source: `${result.catalog} catalog task ${task.id}` + (result.commit ? ` at ${result.commit}` : ""),
  };
}
