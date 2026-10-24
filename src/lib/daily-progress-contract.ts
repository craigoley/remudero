import type { ContractResult } from "./code-health-contract.js";

export const DAILY_PROGRESS_VERSION = "daily-progress-v1" as const;
export type EvidenceState = "complete" | "partial" | "stale" | "not_collected" | "unavailable" | "unauthorized";
export interface SourceCoverage {
  id: string; repository: string; kind: "pull_requests" | "ledger_activity" | "deployments";
  required: boolean; state: EvidenceState; lastAttemptAt: string | null; lastSuccessAt: string | null;
  coverageStart: string | null; coverageThrough: string | null; nextDueAt: string | null;
  reason: string | null;
}
export interface MeasuredCount { value: number | null; precision: "exact" | "at_least" | "unavailable" }
export interface DailyProgressEvent {
  id: string; repository: string; kind: "merged" | "activity" | "deployment";
  sourceId: string; occurredAt: string; observedAt: string;
  fleetAttribution: "confirmed" | "unknown" | "non_fleet";
  taskIds: string[]; title: string; url: string | null;
}
export interface DailyProgressReport {
  version: typeof DAILY_PROGRESS_VERSION;
  scope: { kind: "repository"; repository: string } | { kind: "all" };
  reportDate: string; timeZone: string; windowStart: string; windowEnd: string;
  revision: number; correctionReason: string | null; generatedAt: string;
  phase: "provisional" | "finalizing" | "complete" | "corrected";
  coverage: { state: EvidenceState; expectedRepositories: string[]; includedRepositories: string[]; sources: SourceCoverage[] };
  totals: { mergedChanges: MeasuredCount; completedTasks: MeasuredCount };
  events: DailyProgressEvent[];
  page: { totalEvents: number; nextCursor: string | null };
  currentWork: null | { asOf: string; items: Array<{ repository: string; id: string; title: string; url: string | null }> };
}
export interface RepositoryEvidenceInventory {
  version: "repository-evidence-inventory-v1";
  repositories: Array<{ repository: string; instanceIds: string[]; expectedDailySources: string[]; expectedQualitySources: string[] }>;
  unresolvedInstances: string[];
  measurementState: "not_collected";
}

export function buildRepositoryEvidenceInventory(_instances: ReadonlyArray<{ instanceId: string; options: { instanceRepository?: string } }>): RepositoryEvidenceInventory {
  return { version: "repository-evidence-inventory-v1", repositories: [], unresolvedInstances: [], measurementState: "not_collected" };
}

export function validateDailyProgressReport(_value: unknown): ContractResult<DailyProgressReport> {
  return { ok: false, reason: "report validation is not implemented" };
}
