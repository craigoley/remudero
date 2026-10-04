import type { DeployDeps } from "./deployer.js";
import { firstParentChain, workflowsForPaths, type MainRunGapReader, type WorkflowPushTrigger } from "./main-run-gaps.js";

export interface FleetStateRow {
  pipeline: "ci" | "image" | "deploy" | "failure-latch";
  target: string;
  desired: string;
  evidence?: Record<string, unknown>;
  observe(): boolean | undefined | Promise<boolean | undefined>;
  inFlight?(): boolean | undefined | Promise<boolean | undefined>;
  repair(): void | Promise<void>;
}

const gapId = (row: Pick<FleetStateRow, "pipeline" | "target">): string => JSON.stringify([row.pipeline, row.target]);

/** Ledger-backed attempts survive a new sweep process; unknown reads authorize no effects. */
export async function reconcileFleetState(
  rows: readonly FleetStateRow[],
  history: readonly Record<string, unknown>[],
  record: (event: Record<string, unknown> & { step: string }) => void,
  onEscalated?: (gap: Pick<FleetStateRow, "pipeline" | "target" | "desired"> & { gap_id: string; reason: string }) => void,
): Promise<void> {
  const attempted = new Set(history.filter((e) => e.step === "reconcile.repaired" || e.step === "reconcile.repair_failed").map((e) => e.gap_id));
  const escalated = new Set(history.filter((e) => e.step === "reconcile.escalated").map((e) => e.gap_id));
  const visited = new Set<string>();
  for (const row of rows) {
    const gap_id = gapId(row);
    if (visited.has(gap_id)) continue;
    visited.add(gap_id);
    const fields = { ...row.evidence, gap_id, pipeline: row.pipeline, target: row.target, desired: row.desired };
    try {
      const observed = await row.observe();
      if (observed !== false) continue;
      if (row.inFlight && await row.inFlight() !== false) continue;
      if (attempted.has(gap_id)) {
        if (!escalated.has(gap_id)) {
          const event = { ...fields, step: "reconcile.escalated", observed, reason: "gap persists after its repair attempt" };
          record(event);
          escalated.add(gap_id);
          onEscalated?.(event);
        }
        continue;
      }
      attempted.add(gap_id);
      try {
        await row.repair();
        record({ ...fields, step: "reconcile.repaired", observed });
      } catch (error) {
        record({ ...fields, step: "reconcile.repair_failed", observed, reason: String((error as Error)?.message ?? error) });
      }
    } catch (error) {
      record({ ...fields, step: "reconcile.unreadable", reason: String((error as Error)?.message ?? error) });
    }
  }
}

export interface MainWorkflowStateReader extends MainRunGapReader {
  changedFiles(sha: string): Promise<readonly string[] | undefined>;
  countWorkflowRuns(sha: string, workflow: string): Promise<number | undefined>;
  dispatch(workflow: string): void | Promise<void>;
}

/** A newer run proves delivery had time to happen; each expected workflow needs its own run. */
export async function mainWorkflowStateRows(
  reader: MainWorkflowStateReader,
  triggers: readonly WorkflowPushTrigger[],
  history: readonly Record<string, unknown>[],
  lookback: number,
): Promise<FleetStateRow[]> {
  const chain = firstParentChain(await reader.listMainCommits(lookback)).slice(0, lookback);
  const head = chain[0];
  if (!head) return [];
  const rows: FleetStateRow[] = [];
  const dispatched = new Map<string, Promise<void>>();
  let newerHasRuns = false;
  for (const commit of chain) {
    const count = await reader.countRunsForSha(commit);
    if (newerHasRuns && count !== undefined) {
      const changed = await reader.changedFiles(commit);
      if (changed !== undefined) {
        for (const workflow of workflowsForPaths(triggers, changed)) {
          const target = `${commit}:${workflow}`;
          const prior = history.find((e) => e.step === "reconcile.repaired" && e.gap_id === gapId({ pipeline: "ci", target }));
          const legacy = history.find((e) => e.step === "main.run_gap.dispatched" && e.commit === commit &&
            Array.isArray(e.workflows) && e.workflows.includes(workflow));
          const repairedHead = prior?.head ?? legacy?.head;
          rows.push({
            pipeline: "ci", target, desired: `${workflow} run covering main commit ${commit}`,
            evidence: { commit, workflow, head },
            observe: async () => {
              const own = await reader.countWorkflowRuns(commit, workflow);
              if (own === undefined || own > 0) return own === undefined ? undefined : true;
              if (typeof repairedHead !== "string") return false;
              const covering = await reader.countWorkflowRuns(repairedHead, workflow);
              return covering === undefined ? undefined : covering > 0;
            },
            repair: async () => {
              if (!dispatched.has(workflow)) {
                dispatched.set(workflow, Promise.resolve().then(() => reader.dispatch(workflow)));
              }
              await dispatched.get(workflow);
            },
          });
        }
      }
    }
    if (count !== undefined && count > 0) newerHasRuns = true;
  }
  return rows;
}

export interface DeployStateReader {
  deploy: Pick<DeployDeps, "newestBakedSha" | "imagePublished" | "imageBuildInFlight" | "dispatchImageBuild" | "imageBakedCommitsBehind" | "imageRecycleManual">;
  requestDeploy(): void;
  deployRequested(): boolean;
  failedAt(): number | undefined;
  clearFailure(failedAt: number): void;
}

export function deployStateRows(
  reader: DeployStateReader,
  history: readonly Record<string, unknown>[],
  onUnreadableLatch?: (error: unknown) => void,
): FleetStateRow[] {
  const rows: FleetStateRow[] = [];
  const baked = reader.deploy.newestBakedSha?.();
  if (baked) {
    rows.push({
      pipeline: "image", target: baked, desired: `published image containing ${baked}`,
      observe: () => reader.deploy.imagePublished?.(baked),
      inFlight: () => reader.deploy.imageBuildInFlight?.(),
      repair: () => {
        if (!reader.deploy.dispatchImageBuild) throw new Error("image build dispatch unavailable");
        reader.deploy.dispatchImageBuild();
      },
    }, {
      pipeline: "deploy", target: baked, desired: `healthy deployed image containing ${baked}`,
      observe: () => {
        const behind = reader.deploy.imageBakedCommitsBehind?.();
        return behind === undefined ? undefined : behind === 0;
      },
      inFlight: () => {
        if (reader.deploy.imageRecycleManual?.() === true) return true;
        const published = reader.deploy.imagePublished?.(baked);
        return published === true ? false : published === false ? true : undefined;
      },
      repair: () => { if (!reader.deployRequested()) reader.requestDeploy(); },
    });
  }
  const healthyAt = Math.max(0, ...history.filter((e) => e.step === "deploy.ok")
    .map((e) => Date.parse(String(e.ts))).filter(Number.isFinite));
  let failedAt: number | undefined;
  try {
    failedAt = reader.failedAt();
  } catch (error) {
    if (!onUnreadableLatch) throw error;
    onUnreadableLatch(error);
    return rows;
  }
  if (failedAt !== undefined && failedAt < healthyAt) {
    rows.push({
      pipeline: "failure-latch", target: String(failedAt), desired: "no failure latch older than the last healthy deploy",
      evidence: { failed_at: failedAt, healthy_at: healthyAt },
      observe: () => reader.failedAt() !== failedAt,
      repair: () => reader.clearFailure(failedAt),
    });
  }
  return rows;
}
