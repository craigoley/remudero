import type { FeedbackEntry } from "./feedback.js";
import { updateProposalRegistry, type Proposal } from "./inbox.js";
import type { RawAlert } from "./ops.js";

export const CODEQL_QUALITY_PROPOSAL_PREFIX = "codeql-quality:";

export interface CodeqlQualityAlert extends RawAlert {
  source: "code-scanning";
  ruleId: string;
  toolName: string;
  ruleTags: string[];
}

export interface CodeqlQualityPartition {
  scannedTotal: number;
  eligible: CodeqlQualityAlert[];
  excluded: RawAlert[];
  rejected: CodeqlQualityAlert[];
  covered: CodeqlQualityAlert[];
  unassigned: CodeqlQualityAlert[];
}

export interface CodeqlQualityReconciliation {
  partition: CodeqlQualityPartition;
  createdProposalId?: string;
  updatedProposalIds: string[];
  retiredProposalIds: string[];
}

function hasTag(alert: RawAlert, tag: string): boolean {
  return (alert.ruleTags ?? []).some((value) => value.trim().toLowerCase() === tag);
}

/** True only for one open CodeQL alert with GitHub's two quality-debt rule tags. */
export function isCodeqlQualityAlert(alert: RawAlert): alert is CodeqlQualityAlert {
  return (
    alert.source === "code-scanning" &&
    alert.state.toLowerCase() === "open" &&
    alert.toolName?.trim().toLowerCase() === "codeql" &&
    typeof alert.ruleId === "string" &&
    alert.ruleId.trim().length > 0 &&
    Array.isArray(alert.ruleTags) &&
    hasTag(alert, "quality") &&
    hasTag(alert, "maintainability")
  );
}

/** One CodeQL rule is one work package, so reruns have a stable proposal key. */
export function codeqlQualityProposalId(ruleId: string): string {
  return `${CODEQL_QUALITY_PROPOSAL_PREFIX}${ruleId}`;
}

function alertSort(left: CodeqlQualityAlert, right: CodeqlQualityAlert): number {
  const leftNumber = Number(left.id);
  const rightNumber = Number(right.id);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
  return left.id.localeCompare(right.id);
}

function rejectedAlertIds(feedback: FeedbackEntry[]): ReadonlySet<string> {
  return new Set(
    feedback
      .filter((entry) => entry.status === "rejected" && entry.origin.startsWith("alert#code-scanning-"))
      .map((entry) => entry.origin.slice("alert#code-scanning-".length)),
  );
}

function activeCodeqlRuleIds(proposals: Proposal[]): ReadonlySet<string> {
  return new Set(
    proposals
      .filter((proposal) => proposal.id.startsWith(CODEQL_QUALITY_PROPOSAL_PREFIX))
      .map((proposal) => proposal.id.slice(CODEQL_QUALITY_PROPOSAL_PREFIX.length)),
  );
}

/** Partition the source population before any proposal registry mutation. */
export function partitionCodeqlQualityAlerts(
  alerts: RawAlert[],
  feedback: FeedbackEntry[],
  proposals: Proposal[],
): CodeqlQualityPartition {
  const eligible = alerts.filter(isCodeqlQualityAlert).sort(alertSort);
  const rejectedIds = rejectedAlertIds(feedback);
  const coveredRuleIds = activeCodeqlRuleIds(proposals);
  const rejected = eligible.filter((alert) => rejectedIds.has(alert.id));
  const covered = eligible.filter((alert) => !rejectedIds.has(alert.id) && coveredRuleIds.has(alert.ruleId));
  const unassigned = eligible.filter((alert) => !rejectedIds.has(alert.id) && !coveredRuleIds.has(alert.ruleId));
  const excluded = alerts.filter((alert) => !isCodeqlQualityAlert(alert));
  return { scannedTotal: alerts.length, eligible, excluded, rejected, covered, unassigned };
}

function proposalSummary(ruleId: string, alerts: CodeqlQualityAlert[]): string {
  const numbers = [...alerts].sort(alertSort).map((alert) => `#${alert.id}`).join(", ");
  const count = alerts.length;
  return (
    `CodeQL quality debt for rule ${ruleId}: ${count} open alert${count === 1 ? "" : "s"} ` +
    `tagged quality and maintainability (${numbers}). Propose one bounded cleanup task for this rule; do not auto-fix or dismiss alerts.`
  );
}

function groupByRule(alerts: CodeqlQualityAlert[]): Map<string, CodeqlQualityAlert[]> {
  const grouped = new Map<string, CodeqlQualityAlert[]>();
  for (const alert of alerts) {
    const group = grouped.get(alert.ruleId) ?? [];
    group.push(alert);
    grouped.set(alert.ruleId, group);
  }
  return grouped;
}

/**
 * Refresh active CodeQL packages and create at most one new rule package. The registry update is
 * atomic; a run creates no duplicate work package for a rule already active in the registry.
 */
export function reconcileCodeqlQualityProposals(
  registryPath: string,
  alerts: RawAlert[],
  feedback: FeedbackEntry[],
): CodeqlQualityReconciliation {
  let result: CodeqlQualityReconciliation = {
    partition: partitionCodeqlQualityAlerts(alerts, feedback, []),
    updatedProposalIds: [],
    retiredProposalIds: [],
  };
  updateProposalRegistry(registryPath, (current) => {
    const partition = partitionCodeqlQualityAlerts(alerts, feedback, current);
    const actionableByRule = groupByRule([...partition.covered, ...partition.unassigned]);
    const currentCodeql = current.filter((proposal) => proposal.id.startsWith(CODEQL_QUALITY_PROPOSAL_PREFIX));
    const updatedProposalIds: string[] = [];
    const retiredProposalIds: string[] = [];
    let changed = false;
    const next = current.flatMap((proposal) => {
      if (!proposal.id.startsWith(CODEQL_QUALITY_PROPOSAL_PREFIX)) return [proposal];
      const ruleId = proposal.id.slice(CODEQL_QUALITY_PROPOSAL_PREFIX.length);
      const matched = actionableByRule.get(ruleId);
      if (!matched || matched.length === 0) {
        retiredProposalIds.push(proposal.id);
        changed = true;
        return [];
      }
      const summary = proposalSummary(ruleId, matched);
      if (proposal.summary === summary) return [proposal];
      updatedProposalIds.push(proposal.id);
      changed = true;
      return [{ ...proposal, summary }];
    });
    const activeRuleIds = activeCodeqlRuleIds(currentCodeql);
    const firstUnassignedRule = [...groupByRule(partition.unassigned).keys()].sort((left, right) => left.localeCompare(right))[0];
    let createdProposalId: string | undefined;
    if (firstUnassignedRule && !activeRuleIds.has(firstUnassignedRule)) {
      const id = codeqlQualityProposalId(firstUnassignedRule);
      next.push({
        id,
        summary: proposalSummary(firstUnassignedRule, actionableByRule.get(firstUnassignedRule) ?? []),
        evidenceAnchors: [],
        retainAfterRatification: true,
      });
      createdProposalId = id;
      changed = true;
    }
    result = { partition, createdProposalId, updatedProposalIds, retiredProposalIds };
    return changed ? next : null;
  });
  return result;
}
