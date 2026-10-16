/**
 * lib/repair-memory-demand.ts — W1-T9706: a repair the sweep refused for host memory outranks a new build start.
 *
 * DEMAND. createSweepFixAdmissionController (sweep.ts) notes each claim it refuses on a readable pressure reading
 * ({@link noteRepairMemoryRefusal}). An admission for that PR, or a pass that no longer derives it, clears it. The sweep
 * and the build dispatch run in one daemon process, so the demand lives in memory and never in a file. A refusal stays
 * fresh for HOST_MEMORY_PRIORITY_PROPOSAL.demandRefreshBoundMs, the bound review demand already uses.
 *
 * YIELD. memoryGovernorGateFor (run-task.ts) asks {@link buildYieldsToRepair} once checkMemoryGovernor admits. A new
 * build yields ("yield-to-repair") only while a fresh repair waits, live work in this container can still free memory,
 * and that repair outranks the build under rankDemand. The build's wait starts at its first yield in the current
 * streak, so a build held long enough outranks the repair and starts. No fixed threshold and no policy value is added.
 */

import { systemClock, type Clock } from "./clock.js";
import { HOST_MEMORY_PRIORITY_PROPOSAL, priorityScore, rankDemand, type HostMemoryPriorityPolicy, type WaitingDemand } from "./host-memory-priority.js";

/** One repair waiting for host memory: the PR, when its blocker began waiting, what it was short, when it was refused. */
export interface RepairMemoryDemand {
  prNumber: number;
  waitingSinceMs: number;
  shortMib: number;
  refusedAtMs: number;
}

/** Why a build start did or did not yield to the top waiting repair, as dispatch_memory_observed records it. */
export interface RepairYieldDecision {
  yielded: boolean;
  reason: "repair-outranks" | "nothing-live" | "build-outranks";
  repair: RepairMemoryDemand;
  repairWaitMs: number;
  repairScore: number;
  buildWaitMs: number;
  buildScore: number;
}

const waiting = new Map<number, RepairMemoryDemand & { seq: number }>();
let seq = 0;
let buildYieldSinceMs: number | undefined;

/** A refusal on a readable pressure reading. A PR still fresh keeps its older wait, so its age keeps growing. */
export function noteRepairMemoryRefusal(demand: RepairMemoryDemand, policy: HostMemoryPriorityPolicy = HOST_MEMORY_PRIORITY_PROPOSAL): void {
  const prior = waiting.get(demand.prNumber);
  const fresh = prior !== undefined && demand.refusedAtMs - prior.refusedAtMs <= policy.demandRefreshBoundMs;
  const waitingSinceMs = fresh ? Math.min(prior.waitingSinceMs, demand.waitingSinceMs) : demand.waitingSinceMs;
  waiting.set(demand.prNumber, { ...demand, waitingSinceMs, seq: ++seq });
}

/** An admission for that PR: it no longer waits. */
export function clearRepairMemoryDemand(prNumber: number): void {
  waiting.delete(prNumber);
}

/** Taken when a pass starts; {@link settleRepairMemoryPass} clears what that pass did not refuse again. */
export function repairMemoryDemandMark(): number {
  return seq;
}

/** A pass that no longer derives a repair clears it: every refusal noted before `mark`, for the PRs the pass saw
 *  (`prNumbers`), or for every PR when the pass saw the whole board (undefined). */
export function settleRepairMemoryPass(mark: number, prNumbers?: readonly number[]): void {
  for (const [prNumber, entry] of waiting) {
    if (entry.seq <= mark && (prNumbers === undefined || prNumbers.includes(prNumber))) waiting.delete(prNumber);
  }
}

/** The repairs whose refusal is still within the refresh bound. */
export function freshRepairMemoryDemand(nowMs: number, policy: HostMemoryPriorityPolicy = HOST_MEMORY_PRIORITY_PROPOSAL): RepairMemoryDemand[] {
  return [...waiting.values()].filter((entry) => nowMs - entry.refusedAtMs <= policy.demandRefreshBoundMs)
    .map(({ seq: _seq, ...demand }) => demand);
}

/** Forget all demand and the build's yield streak (a test's fresh process state). */
export function resetRepairMemoryDemand(): void {
  waiting.clear();
  buildYieldSinceMs = undefined;
}

/** The gate's verdict after checkMemoryGovernor: unchanged when it already defers or no fresh repair waits; else it
 *  carries the yield decision, and is deferred as "yield-to-repair" when the build yields. */
export function buildYieldsToRepair<R extends { deferred: boolean; tier?: string; repairYield?: RepairYieldDecision }>(
  result: R,
  ownWorkLive: () => boolean,
  clock: Clock = systemClock,
  policy: HostMemoryPriorityPolicy = HOST_MEMORY_PRIORITY_PROPOSAL,
): R {
  if (result.deferred) return result;
  const nowMs = clock.now();
  const repairs = freshRepairMemoryDemand(nowMs, policy).map((repair) =>
    ({ instance: `repair#${repair.prNumber}`, workerClass: "fix" as const, waitingSinceMs: repair.waitingSinceMs, repair }));
  if (repairs.length === 0) {
    buildYieldSinceMs = undefined;
    return result;
  }
  const top = rankDemand(repairs, policy, nowMs)[0]!;
  const build: WaitingDemand = { instance: "build", workerClass: "implement", waitingSinceMs: buildYieldSinceMs ?? nowMs };
  const decision = {
    repair: top.repair,
    repairWaitMs: Math.max(0, nowMs - top.waitingSinceMs),
    repairScore: priorityScore(top, policy, nowMs),
    buildWaitMs: Math.max(0, nowMs - build.waitingSinceMs),
    buildScore: priorityScore(build, policy, nowMs),
  };
  const reason = !ownWorkLive() ? "nothing-live" : rankDemand([build, top], policy, nowMs)[0] === build ? "build-outranks" : "repair-outranks";
  if (reason !== "repair-outranks") {
    buildYieldSinceMs = undefined;
    return { ...result, repairYield: { ...decision, yielded: false, reason } };
  }
  buildYieldSinceMs = build.waitingSinceMs;
  return { ...result, deferred: true, tier: "yield-to-repair", repairYield: { ...decision, yielded: true, reason } };
}

/** The dispatch_memory_observed fields for a yield decision; none when no repair was waiting. */
export function repairYieldLedgerFields(decision: RepairYieldDecision | undefined): Record<string, unknown> {
  if (decision === undefined) return {};
  return {
    ...(decision.yielded ? { tier: "yield-to-repair" } : {}),
    repair_yield: decision.yielded,
    repair_yield_reason: decision.reason,
    repair_pr: decision.repair.prNumber,
    repair_wait_ms: decision.repairWaitMs,
    repair_short_mib: decision.repair.shortMib,
    repair_score: decision.repairScore,
    build_wait_ms: decision.buildWaitMs,
    build_score: decision.buildScore,
  };
}
