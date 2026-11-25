import { loadPlan } from "./plan.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";
import { landTaskFilesAsync, type LandTaskFilesOpts, type TaskFileInput } from "./feedback-landing.js";
import { readOpsCatalogSnapshotAsync, type OpsCatalogApi } from "./ops-catalog-source.js";
import { planDestinationRepository } from "./plan-destination.js";
import { soleTaskId, type PlanGardenOps, type PlanOpsRead } from "./plan-gardener.js";
import { resolveRepoLayout } from "./repo-layout.js";

/**
 * lib/plan-gardener-ops.ts (W1-T14642) — the plan gardener's two production ops seams.
 *
 * READ: the ops task catalog at one pinned commit (ops-catalog-source.ts), each record's bytes read from the ops
 * checkout at that pin. A catalog that cannot be read is `unavailable`, never an empty catalog: what it holds is
 * unknown, so the gardener calls no dependency unknown while it is.
 * LAND: an ops edit goes through the sealed task-files landing into the plan destination, never into the public tree.
 */

export interface ProductionPlanGardenOpsOptions {
  repoRoot: string;
  stateDir: string;
  /** Daemon state root: the sealed landing's queue waits under it. */
  stateRoot: string;
  log: (step: string, extra?: Record<string, unknown>) => void;
  api?: OpsCatalogApi;
  /** The sealed landing, replaceable so a test lands nothing. */
  landTaskFiles?: typeof landTaskFilesAsync;
}

export function productionPlanGardenOps(o: ProductionPlanGardenOpsOptions): PlanGardenOps & { settled: () => Promise<void> } {
  const landings: Promise<void>[] = [];
  const landTaskFiles = o.landTaskFiles ?? landTaskFilesAsync;
  const read = async (): Promise<PlanOpsRead> => {
    const destination = planDestinationRepository(o.stateDir);
    if (destination.outcome === "off") return { outcome: "off" };
    if (destination.outcome !== "named") return { outcome: "unavailable", reason: `plan-destination-${destination.outcome}` };
    const snapshot = await readOpsCatalogSnapshotAsync({ repository: `${destination.owner}/${destination.repo}` }, o.api);
    if (snapshot.outcome !== "ok" || !snapshot.plan || !snapshot.binding) return { outcome: "unavailable", reason: `ops-${snapshot.outcome}` };
    const publicPlan = loadPlan(resolveRepoLayout(o.repoRoot).planMonolith);
    // One id held by both catalogs is ambiguous: neither copy can be edited by id.
    if (snapshot.plan.tasks.some((t) => publicPlan.byId.has(t.id))) return { outcome: "unavailable", reason: "ops-duplicate_task_id" };
    const pin = snapshot.binding.commit;
    const shards = new Map<string, string>();
    const sources = new Map<string, string>();
    for (const task of snapshot.plan.tasks) {
      const source = task.sourcePath;
      if (!source || !/^tasks\.d\/[^/]+\.ya?ml$/.test(source)) continue;
      const path = `plan/${source}`;
      if (!sources.has(path)) sources.set(path, await hostWorktreeGitAsync(destination.checkoutDir, ["show", `${pin}:${path}`]));
      // Only a record that sits alone in its file can be edited without touching a neighbour.
      if (soleTaskId(sources.get(path)!) === task.id) shards.set(task.id, path);
    }
    return { outcome: "ok", tasks: snapshot.plan.tasks, shards, sources };
  };
  const land = (inputs: readonly TaskFileInput[]): void => {
    const destination = planDestinationRepository(o.stateDir);
    if (destination.outcome !== "named") {
      o.log("plan.ops_landing_skipped", { reason: `plan-destination-${destination.outcome}`, records: inputs.length });
      return;
    }
    const opts: LandTaskFilesOpts = {
      stateRoot: o.stateRoot, targetRepository: { owner: destination.owner, repo: destination.repo }, log: o.log, lane: "plan",
    };
    landings.push(landTaskFiles(destination.checkoutDir, [...inputs], opts).then((result) => {
      o.log("plan.ops_landing", { records: inputs.length, pr_url: result.prUrl ?? null, landed: result.landed.length, waiting: result.waiting.length, refused: result.refused.length, ...(result.error ? { error: result.error } : {}) });
    }, (error: unknown) => {
      o.log("plan.ops_landing_failed", { records: inputs.length, error: String((error as Error)?.message ?? error) });
    }));
  };
  // A landing's failure is logged where it happens, so waiting on the landings never throws.
  return { read, land, settled: async () => void (await Promise.all(landings.splice(0))) };
}
