import { createHash } from "node:crypto";
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

/** W1-T13610: the canonical parser's verdict per serialized tasks text, so an unchanged plan is parsed once. Keyed on
 *  the content, never the object: an in-place change makes a new key. The public plan, the ops plan and one previous
 *  of each; the oldest entry goes first. A bound on entries, not on time. */
const KEPT_SNAPSHOT_VERDICTS = 4;
const snapshotVerdicts = new Map<string, boolean>();
let snapshotParses = 0;

/** How many canonical parses the snapshot check has run in this process: the W1-T13610 tests' counting seam. */
export function snapshotParseCount(): number {
  return snapshotParses;
}

function canonicalParseVerdict(serializedTasks: string, taskCount: number): boolean {
  const key = `${taskCount}:${createHash("sha256").update(serializedTasks, "utf8").digest("hex")}`;
  const kept = snapshotVerdicts.get(key);
  if (kept !== undefined) {
    snapshotVerdicts.delete(key);
    snapshotVerdicts.set(key, kept);
    return kept;
  }
  snapshotParses++;
  let verdict: boolean;
  try {
    verdict = parseTasksFromYaml(serializedTasks, "secondary catalog shadow snapshot").length === taskCount;
  } catch (error: unknown) {
    // The parser refuses this text whenever it sees it, so its refusal is the verdict.
    void error;
    verdict = false;
  }
  snapshotVerdicts.set(key, verdict);
  if (snapshotVerdicts.size > KEPT_SNAPSHOT_VERDICTS) snapshotVerdicts.delete(snapshotVerdicts.keys().next().value!);
  return verdict;
}

function isParsedPlanSnapshot(value: unknown): value is Plan {
  try {
    if (value === null || typeof value !== "object") return false;
    const plan = value as Plan;
    if (!Array.isArray(plan.tasks) || !(plan.byId instanceof Map) || plan.byId.size !== plan.tasks.length) return false;
    // A manually constructed snapshot can bypass parse-time constraints such as not_before and precondition.
    // Revalidate a detached serialization through the canonical plan parser before trusting any task.
    const serializedTasks = JSON.stringify(plan.tasks);
    if (typeof serializedTasks !== "string" || !canonicalParseVerdict(serializedTasks, plan.tasks.length)) return false;
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

export type TaskReleasePlan =
  | { outcome: "found"; catalog: "public" | "ops"; plan: Plan }
  | Extract<TaskLookupResult, { outcome: "absent" | "unreadable" }>;

/**
 * W1-T13386: the plan an operator's release of `taskId` reads and pins from. A task the public plan holds keeps
 * that plan and opens no private reader. A task only the ops catalog holds gets the plan the daemon's tick
 * dispatches from (`composeSecondaryPlan` over the same two plans), so the pinned record is the one the tick
 * hashes. Two plans the tick cannot compose are `unreadable` with the reason `compose-<the tick's outcome code>`:
 * the tick dispatches no ops task from them, so a release would pin a record no reader holds. The `compose-`
 * prefix keeps that apart from a catalog read that failed (`ops-<outcome>`); either plan may be the cause.
 */
export async function findReleasePlanInCatalogs(taskId: string, publicPlan: Plan, sources: TaskLookupOptions = {}): Promise<TaskReleasePlan> {
  const lookup = await findTaskInCatalogs(taskId, { ...sources, byId: publicPlan.byId });
  if (lookup.outcome !== "found") return lookup;
  if (lookup.catalog === "public") return { outcome: "found", catalog: "public", plan: publicPlan };
  // An ops hit always kept its snapshot; were one ever missing, the composer reads it as malformed.
  const composition = composeSecondaryPlan(publicPlan, opsPlanForLookup(lookup) as Plan);
  if (composition.outcome !== "ok") return { outcome: "unreadable", reason: `compose-${composition.outcome}` };
  return { outcome: "found", catalog: "ops", plan: composition.plan };
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
