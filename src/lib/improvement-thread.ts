import type { Clock } from "./clock.js";
export const IMPROVEMENT_THREAD_VERSION = "improvement-thread-v1" as const;
export interface ImprovementThreadRequest {
  repository: string; opportunityId: string; snapshotId: string; goal: string; constraints?: string[];
  idempotencyKey: string; instance?: string;
}
export interface ImprovementThreadDeps {
  stateDir: string; actorId: string; clock?: Clock;
  /** Persistence interruption seam; never accepted from a browser request. */
  afterPersist?: (stage: "intent" | "proposal" | "messages" | "receipt") => void;
}
export type ImprovementThreadResult = {
  state: "saved"; version: typeof IMPROVEMENT_THREAD_VERSION; requestId: string; threadId: string; proposalId: string;
  repository: string; instance: string; snapshotId: string; opportunityId: string; reused: boolean;
  planning: { state: "not_requested" }; execution: { state: "not_requested" };
} | { state: "invalid_request" | "source_unavailable" | "source_stale" | "conflict" | "busy" | "uncertain"; reason: string; requestId?: string };
export async function createImprovementThread(_request: unknown, _deps: ImprovementThreadDeps): Promise<ImprovementThreadResult> {
  return { state: "source_unavailable", reason: "Saved improvement conversations are not implemented." };
}
