import { planDestinationRepository, type PlanDestinationRepositoryRead } from "./plan-destination.js";
import type { Plan, Task } from "./plan.js";
import type { VerbPlanRoot } from "./repo-location.js";
import { findTaskInCatalogs, type TaskLookupOptions, type TaskLookupResult } from "./task-lookup.js";

/** W1-T10925's public resolution: the plan root (cwd's, or the instance target's) whose plan holds the id. */
export type PublicVerbPlan =
  | (Extract<VerbPlanRoot, { ok: true }> & { plan: Plan; planPath: string })
  | Extract<VerbPlanRoot, { ok: false }>;

/** The task a per-task operator verb acts on, its catalog, and the owner/repo the verb writes to.
 *  `owner` undefined means the caller's default owner, as before. */
export type VerbTaskResolution =
  | (Extract<PublicVerbPlan, { ok: true }> & { catalog: "public"; task: Task; repo: string; owner?: string })
  | { ok: true; catalog: "ops"; task: Task; repo: string; owner?: string; target?: undefined }
  | { ok: false; error: string };

/**
 * W1-T14828: `rmd release` and `rmd correct` found their task with the public plan alone, so an id
 * only the ops catalog holds (every task filed since 11-17) was refused as unknown. A public hit resolves exactly as
 * before and never opens the ops catalog; only a public miss asks the two-catalog lookup. A miss names both catalogs.
 * `publicPlan` is the verb's public resolution exactly as before (run-task.ts's verbTaskPlan); `stateDir` is
 * `<config.root>/state`, `undefined` with no instance config, read only on a public miss; `lookup` is the two-catalog
 * lookup rmd approve uses; `destination` names the ops catalog's repository, whose owner the verb writes under.
 */
export async function resolveVerbTask(
  taskId: string,
  publicPlan: (taskId: string) => PublicVerbPlan,
  stateDir: () => string | undefined,
  lookup: (taskId: string, sources: TaskLookupOptions & Pick<Plan, "byId">) => Promise<TaskLookupResult> = findTaskInCatalogs,
  destination: (stateDir: string | undefined) => PlanDestinationRepositoryRead = planDestinationRepository,
): Promise<VerbTaskResolution> {
  const located = publicPlan(taskId);
  if (located.ok) {
    const task = located.plan.byId.get(taskId)!;
    return { ...located, catalog: "public", task, repo: task.repo, owner: located.target?.owner };
  }
  let dir: string | undefined;
  try {
    dir = stateDir();
  } catch (e) {
    return { ok: false, error: `${located.error}; ops catalog unreadable (instance config: ${(e as Error).message})` };
  }
  const found = await lookup(taskId, { stateDir: dir, byId: new Map() });
  if (found.outcome === "unreadable") return { ok: false, error: `${located.error}; ops catalog unreadable (${found.reason})` };
  const named = destination(dir);
  // A host with no ops catalog misses exactly as before; one with a catalog says it was searched too.
  if (found.outcome === "absent") {
    return { ok: false, error: named.outcome === "off" ? located.error : `${located.error}; not in the ops catalog either` };
  }
  // The public plan already missed and the lookup's public map is empty, so a hit is the ops catalog's.
  return {
    ok: true, catalog: "ops", task: found.task, repo: found.task.repo,
    owner: named.outcome === "named" ? named.owner : undefined,
  };
}
