export const CODE_HEALTH_VERSION = "code-health-v1" as const;
export const CODE_HEALTH_SOURCE_KINDS = ["quality", "coverage"] as const;
export type ContractResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface CodeHealthAssessment {
  version: typeof CODE_HEALTH_VERSION;
  repository: string;
  analyzedSha: string;
  currentSha: string;
  baselineSha: string | null;
  policyVersion: string;
  observedAt: string;
  nextDueAt: string | null;
  state: "measured" | "partial" | "stale" | "not_collected" | "unavailable";
  sources: Array<{
    id: string; kind: string; required: boolean; state: "complete" | "partial" | "stale" | "not_collected" | "unavailable";
    analyzedSha: string | null; observedAt: string | null; scopeHash: string | null;
    toolVersion: string | null; rulesVersion: string | null; configHash: string | null;
    baseline: null | { sha: string; scopeHash: string; toolVersion: string; rulesVersion: string; configHash: string };
    exclusions: string[]; reason: string | null;
  }>;
  checks: Array<{ id: string; category: "maintainability" | "security" | "reliability" | "tests"; state: "met" | "not_met" | "not_measured"; sourceIds: string[]; reason: string }>;
  findings: Array<{ fingerprint: string; sourceId: string; severity: "critical" | "high" | "medium" | "low"; category: string; status: "new" | "existing" | "unknown"; path: string; title: string; effortMinutes: number | null; estimateKind: "modeled" | null }>;
  summary: { met: number; assessed: number; expected: number; healthy: boolean | null };
}

export function codeHealthSourceRequirements(): readonly string[] {
  return CODE_HEALTH_SOURCE_KINDS;
}

export function validateCodeHealthAssessment(_value: unknown): ContractResult<CodeHealthAssessment> {
  return { ok: false, reason: "assessment validation is not implemented" };
}
