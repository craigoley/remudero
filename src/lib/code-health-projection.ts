import type { CodeHealthAssessment } from "./code-health-contract.js";

export interface CodeHealthScanFinding {
  id: string;
  ruleId: string;
  status: "open" | "fixed" | "dismissed";
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  path: string;
  title: string;
  effortMinutes: number | null;
}

/** An existing collector's immutable result; reading it again is not a new scan. */
export interface CodeHealthScan {
  kind: "quality" | "coverage";
  repository: string;
  scanId: string;
  analyzedSha: string;
  observedAt: string;
  state: "complete" | "partial" | "stale" | "not_collected" | "unavailable";
  scopeHash: string | null;
  toolVersion: string | null;
  rulesVersion: string | null;
  configHash: string | null;
  exclusions: string[];
  reason: string | null;
  checks: Array<{ id: string; met: boolean; reason: string }>;
  findings: CodeHealthScanFinding[];
}

/** Checks describe source facts or an existing repository policy, never a new weighted grade. */
export interface CodeHealthCheckRegistry {
  version: string;
  checks: Array<{
    id: string;
    sourceKind: CodeHealthScan["kind"];
    category: CodeHealthAssessment["checks"][number]["category"];
    description: string;
  }>;
}

export interface CodeHealthProjectionInput {
  repository: string;
  currentSha: string;
  observedAt: string;
  nextDueAt: string | null;
  registry: CodeHealthCheckRegistry;
  scans: CodeHealthScan[];
  baseline: null | { analyzedSha: string; policyVersion: string; scans: CodeHealthScan[] };
}

export interface CodeHealthComparison {
  state: "comparable" | "measurement_changed" | "insufficient_evidence";
  newFindings: string[];
  existingFindings: string[];
  fixedFindings: string[];
  unconfirmedMissingFindings: string[];
  reason: string;
}

export function projectCodeHealth(_input: CodeHealthProjectionInput): CodeHealthAssessment {
  throw new Error("Code health projection is not implemented");
}

export function compareCodeHealthEvidence(_input: CodeHealthProjectionInput): CodeHealthComparison {
  throw new Error("Code health comparison is not implemented");
}
