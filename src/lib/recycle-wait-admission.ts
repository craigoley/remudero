import { deriveDrainWait, type DrainWaitLane } from "./deployer.js";

/** W1-T12241: the kinds the restart admission names (src/lib/daemon.ts `RestartAdmission`). */
export type RecycleWaitKind = "review" | "plan-review" | "fix-dispatch" | "dispatch-refill";

/** One build run or fix round that a recycle waits for. No `predictedLeftMs`: its prediction is unreadable. */
export interface RecycleWaitRun {
  readonly runId: string;
  readonly kind: "build" | "fix";
  readonly ageMs: number;
  readonly predictedLeftMs?: number;
}

export interface RecycleWaitInput {
  /** The measured length of a review of each kind; absent when none is measured. */
  readonly lengthsMs: { readonly review?: number; readonly "plan-review"?: number };
  readonly runs: readonly RecycleWaitRun[];
}

/** The run predicted to end first. Undefined when no run is in flight or when any prediction is unreadable. */
export function soonestRecycleWaitRun(input: RecycleWaitInput): (RecycleWaitRun & { predictedLeftMs: number }) | undefined {
  let soonest: (RecycleWaitRun & { predictedLeftMs: number }) | undefined;
  for (const run of input.runs) {
    const leftMs = run.predictedLeftMs;
    if (leftMs === undefined || !Number.isFinite(leftMs)) return undefined;
    if (soonest === undefined || leftMs < soonest.predictedLeftMs) soonest = { ...run, predictedLeftMs: leftMs };
  }
  return soonest;
}

/** Admit a review or a plan review only when its measured length is shorter than the smallest predicted time left
 *  of the runs in flight, so that it ends before the first of them. Every other kind is refused. */
export function recycleWaitAdmits(kind: RecycleWaitKind, input: RecycleWaitInput): boolean {
  if (kind !== "review" && kind !== "plan-review") return false;
  const lengthMs = input.lengthsMs[kind];
  if (lengthMs === undefined || !Number.isFinite(lengthMs) || lengthMs <= 0) return false;
  const soonest = soonestRecycleWaitRun(input);
  return soonest !== undefined && lengthMs < soonest.predictedLeftMs;
}

/** The predicted time left of each run in flight, as the deployer predicts its wait (`deriveDrainWait`) over the run
 *  lengths the ledger shows. A run judged `ended` is not waited for. A run older than every observed run, or any run
 *  when no length is observed, has no prediction. */
export function predictRecycleWaitRuns(
  kind: RecycleWaitRun["kind"],
  observedMs: readonly number[],
  lanes: readonly DrainWaitLane[],
): RecycleWaitRun[] {
  if (lanes.length === 0) return [];
  const derived = deriveDrainWait(observedMs, lanes);
  if (derived.source === "no_history_fallback") {
    return lanes.filter((lane) => lane.judged !== "ended").map((lane) => ({ runId: lane.runId, kind, ageMs: lane.ageS * 1000 }));
  }
  return derived.lanes.filter((read) => read.basis !== "ended").map((read) => ({
    runId: read.run_id, kind, ageMs: read.age_s * 1000,
    ...(read.basis === "conditioned_quantile" ? { predictedLeftMs: read.remaining_s * 1000 } : {}),
  }));
}
