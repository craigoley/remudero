import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultGitRunnerAsync, loadPlan, loadPlanAtRefAsync, loadPlanQuarantiningDuplicates, MOVED_FROM_VALUE, parseTasksFromYaml, PlanError, TASK_RISKS, TASK_STATUSES, TASK_TYPES, type Plan, type Task } from "./plan.js";
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

/** W1-T13749: why one task is held out of a composition. The codes keep the names the whole-catalog refusal had. */
export type CompositionHoldReason = "duplicate_task_id" | "invalid_cross_catalog_dependency";
/** The edge that holds a task: its own, or the one a task it depends on (directly or through another) is held by. */
export interface CompositionHold {
  reason: CompositionHoldReason;
  /** The record whose own edge is invalid: an id both catalogs hold, or the task naming the bad dependency. */
  task: string;
  /** The id that task's depends_on names: one neither catalog holds, or an ops id a public task names. */
  dependsOn?: string;
}
/** The edge as one line: `TASK -> DEPENDENCY`, or `TASK in both catalogs` for a duplicate. */
export function compositionHoldEdge(hold: CompositionHold): string {
  return hold.dependsOn === undefined ? `${hold.task} in both catalogs` : `${hold.task} -> ${hold.dependsOn}`;
}

type SecondaryComposition =
  | { outcome: "ok"; plan: Plan; secondaryIds: ReadonlySet<string>; pendingMoveIds: ReadonlySet<string>;
    held: ReadonlyMap<string, CompositionHold> }
  | { outcome: "malformed" };

/** One atomic graph rule shared by observation and explicit live selection.
 *  W1-T13680: an id both catalogs hold whose ops copy carries a valid moved_from is a PENDING MOVE: it is in neither
 *  the composed tasks nor secondaryIds, so neither copy is a dispatch candidate, and every other ops task still
 *  composes. A shared id without that provenance is still a duplicate.
 *  W1-T13749: a bad edge holds its own task, never the catalog. A duplicate holds both copies (duplicate_task_id); a
 *  public task naming an ops id, and an ops task naming an id neither catalog holds once pending moves are removed,
 *  are held (invalid_cross_catalog_dependency). Every task depending on a held one, directly or through another, is
 *  held by the same edge. A held id is in neither the composed tasks nor secondaryIds; every other task composes as
 *  before. Only a snapshot failing the canonical check still refuses the whole composition, as malformed. */
export function composeSecondaryPlan(primary: Plan, secondary: Plan): SecondaryComposition {
  if (!isParsedPlanSnapshot(primary) || !isParsedPlanSnapshot(secondary)) return { outcome: "malformed" };
  const primaryIds = new Set(primary.tasks.map(task => task.id));
  const held = new Map<string, CompositionHold>();
  const pendingMoveIds = new Set<string>();
  for (const task of secondary.tasks) {
    if (!primaryIds.has(task.id)) continue;
    if (task.moved_from !== undefined && MOVED_FROM_VALUE.test(task.moved_from)) pendingMoveIds.add(task.id);
    else held.set(task.id, { reason: "duplicate_task_id", task: task.id });
  }
  const opsOnlyIds = new Set(secondary.tasks.filter(task => !primaryIds.has(task.id)).map(task => task.id));
  const candidates = [...primary.tasks.filter(task => !pendingMoveIds.has(task.id)),
    ...secondary.tasks.filter(task => opsOnlyIds.has(task.id))];
  for (const task of candidates) {
    if (held.has(task.id)) continue;
    const ops = opsOnlyIds.has(task.id);
    const bad = task.depends_on.find(id => ops ? !primaryIds.has(id) && !opsOnlyIds.has(id) : opsOnlyIds.has(id));
    if (bad !== undefined) held.set(task.id, { reason: "invalid_cross_catalog_dependency", task: task.id, dependsOn: bad });
  }
  // Close the held set over dependants until it stops growing; each inherits the edge of its first held dependency.
  for (let grew = held.size > 0; grew;) {
    grew = false;
    for (const task of candidates) {
      if (held.has(task.id)) continue;
      const via = task.depends_on.find(id => held.has(id));
      if (via !== undefined) { held.set(task.id, held.get(via)!); grew = true; }
    }
  }
  const tasks = candidates.filter(task => !held.has(task.id));
  const secondaryIds = new Set([...opsOnlyIds].filter(id => !held.has(id)));
  return { outcome: "ok", secondaryIds, pendingMoveIds, held, plan: { tasks, byId: new Map(tasks.map(task => [task.id, task])) } };
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
  | { outcome: "held"; hold: CompositionHold }
  | Extract<TaskLookupResult, { outcome: "absent" | "unreadable" }>;

/**
 * W1-T13386: the plan an operator's release of `taskId` reads and pins from. A task the public plan holds keeps
 * that plan. A task only the ops catalog holds gets the plan the daemon's tick
 * dispatches from (`composeSecondaryPlan` over the same two plans), so the pinned record is the one the tick
 * hashes. Two plans the tick cannot compose (a malformed snapshot) are `unreadable` with the reason
 * `compose-<the tick's outcome code>`; the `compose-` prefix keeps that apart from a catalog read that failed
 * (`ops-<outcome>`). W1-T13749: an ops task the composition holds is `held` with its edge, so it is never released
 * while the tick holds it, and a sound ops task beside it is `found` as if the bad edge were absent.
 * W1-T13785: a public hit while a destination is named reads the ops catalog too, because the tick holds public
 * records as well (a duplicate's public copy, a public task naming an ops id, and their dependants). A public task
 * the composition holds is `held`. A sound public hit, an off destination, an unreadable ops catalog or a
 * malformed composition keeps the public plan. Approve checks for public holds before applying the strict loader's
 * working-tree fallback for unresolved dependencies. It composes again against the fallback before releasing.
 */
export async function findReleasePlanInCatalogs(taskId: string, publicPlan: Plan, sources: TaskLookupOptions = {}): Promise<TaskReleasePlan> {
  const lookup = await findTaskInCatalogs(taskId, { ...sources, byId: publicPlan.byId });
  if (lookup.outcome !== "found") return lookup;
  if (lookup.catalog === "public") {
    const composition = await readReleaseComposition(publicPlan, sources);
    const hold = composition?.outcome === "ok" ? composition.held.get(taskId) : undefined;
    return hold === undefined ? { outcome: "found", catalog: "public", plan: publicPlan } : { outcome: "held", hold };
  }
  // An ops hit always kept its snapshot; were one ever missing, the composer reads it as malformed.
  const composition = composeSecondaryPlan(publicPlan, opsPlanForLookup(lookup) as Plan);
  if (composition.outcome !== "ok") return { outcome: "unreadable", reason: `compose-${composition.outcome}` };
  const hold = composition.held.get(taskId);
  if (hold !== undefined) return { outcome: "held", hold };
  return { outcome: "found", catalog: "ops", plan: composition.plan };
}

async function readReleaseComposition(publicPlan: Plan, sources: TaskLookupOptions): Promise<SecondaryComposition | undefined> {
  const destination = planDestinationRepository(sources.stateDir);
  if (destination.outcome !== "named") return undefined;
  const snapshot = sources.opsSnapshot ?? await readOpsCatalogSnapshotAsync({ repository: `${destination.owner}/${destination.repo}` }, sources.api);
  if (snapshot.outcome !== "ok" || snapshot.plan === undefined) return undefined;
  return composeSecondaryPlan(publicPlan, snapshot.plan);
}

/**
 * W1-T13785: the strict public loader's dependency check over a plan read with deferred dependencies. Deferring lets a
 * public hold reach its held answer. The strict loader's fallback may still supply a valid plan for a sound neighbour.
 */
export function publicReleaseDependencyError(plan: Plan): PlanError | undefined {
  for (const task of plan.tasks) {
    for (const dependency of task.depends_on) {
      if (!plan.byId.has(dependency)) return new PlanError(`task ${task.id}: depends_on unknown task '${dependency}'`);
    }
  }
  return undefined;
}

/** Which public plan a release composed against: the checkout's origin/main, or its working tree and why. */
export type ReleasePublicPlan =
  | { plan: Plan; read: "origin/main" }
  | { plan: Plan; read: "working_tree"; reason: string };

/** A public-to-ops dependency must reach approve's composition so it can hold the task and its dependants. */
export function loadLocalReleasePlan(path: string, stateDir: string): Plan {
  return planDestinationRepository(stateDir).outcome === "named" ? loadPublicPlanWithDeferredDependencies(path) : loadPlan(path);
}

function loadPublicPlanWithDeferredDependencies(path: string): Plan {
  try {
    return loadPlan(path);
  } catch (error) {
    if (!(error instanceof PlanError) || !/^task .*: depends_on unknown task /.test(error.message)) throw error;
    // The quarantine reader and loadPlan share the public parser. Keep unseen edges only if it read every record.
    const { plan, quarantined } = loadPlanQuarantiningDuplicates(path, undefined, undefined, () => true);
    if (quarantined.length !== 0) throw error;
    return plan;
  }
}

/**
 * The public view for release composition. Pin origin/main before reading its blobs so the refusal row can name
 * that commit. A working-tree fallback records its digest with no commit.
 */
export async function readReleasePublicPlan(
  checkoutRoot: string, { keepUnseenDependencies = false } = {},
): Promise<ReleasePublicPlan & { commit?: string }> {
  const keepsUnseenDependency = keepUnseenDependencies ? () => true : undefined;
  try {
    const runGit = defaultGitRunnerAsync(checkoutRoot);
    const commit = (await runGit(["rev-parse", "--verify", "origin/main"])).trim();
    return { read: "origin/main", commit, plan: await loadPlanAtRefAsync(checkoutRoot, "plan/tasks.yaml", commit, runGit, keepsUnseenDependency) };
  } catch (error) {
    const reason = error instanceof Error ? "origin-main-unreadable" : "origin-main-thrown";
    const path = join(checkoutRoot, "plan", "tasks.yaml");
    const plan = keepsUnseenDependency ? loadPublicPlanWithDeferredDependencies(path) : loadPlan(path);
    return { plan, read: "working_tree", reason };
  }
}

/**
 * W1-T13749: the release plan `rmd approve` uses for `taskId`; `undefined` keeps the local plan's own public record.
 * A local miss composes against `readPublic()` (readReleasePublicPlan of the checkout). A local hit that origin/main
 * no longer holds (an id moved to the ops catalog after the boot) is resolved through the catalogs, and released
 * from the ops catalog when that is where it lives now; any other local hit is released as before.
 * W1-T13785: a local hit the public view still holds is `held` when the composition over that view holds it, and
 * `undefined` for a sound public record, retaining its local pin. Lookup answers over parsed plans are per-record.
 */
export async function findApproveReleasePlan(taskId: string, localPlan: Plan, readPublic: (keepUnseenDependencies?: boolean) => Promise<ReleasePublicPlan>,
  sources: TaskLookupOptions = {}): Promise<TaskReleasePlan | undefined> {
  const localHit = localPlan.byId.has(taskId);
  const named = planDestinationRepository(sources.stateDir).outcome === "named";
  if (!named) return localHit ? undefined : findReleasePlanInCatalogs(taskId, (await readPublic(false)).plan, sources);
  const publicView = await readPublic(true);
  if (localHit && publicView.read === "working_tree" && !publicView.plan.byId.has(taskId)) return undefined;
  const release = await findReleasePlanInCatalogs(taskId, publicView.plan, sources);
  if (!localHit || release?.outcome === "held" || (release?.outcome === "found" && release.catalog === "ops")) return release;
  return undefined;
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
