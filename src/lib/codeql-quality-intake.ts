import type { FeedbackEntry } from "./feedback.js";
import { updateProposalRegistry, type Proposal } from "./inbox.js";
import type { RawAlert } from "./ops.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  deltas: CodeqlQualityDelta[];
}

export interface CodeqlFilingSnapshot {
  proposalId: string;
  ruleId: string;
  alertNumbers: string[];
  scannerSha?: string;
}

export interface CodeqlQualityDelta extends CodeqlFilingSnapshot {
  sourceProposalId: string;
}

export function codeqlSnapshot(proposal: Proposal): CodeqlFilingSnapshot | undefined {
  const line = proposal.summary.split("\n").find((row) => row.startsWith("CodeQL-Snapshot: "));
  if (!line) return undefined;
  const value = JSON.parse(line.slice("CodeQL-Snapshot: ".length)) as CodeqlFilingSnapshot;
  if (value.proposalId !== proposal.id || !value.ruleId || !Array.isArray(value.alertNumbers) ||
    value.alertNumbers.some((id) => typeof id !== "string" || !id)) throw new Error(`invalid CodeQL snapshot: ${proposal.id}`);
  return value;
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
      .map((proposal) => codeqlSnapshot(proposal)?.ruleId ?? proposal.id.slice(CODEQL_QUALITY_PROPOSAL_PREFIX.length)),
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

function snapshotSummary(snapshot: CodeqlFilingSnapshot, alerts: CodeqlQualityAlert[]): string {
  return `${proposalSummary(snapshot.ruleId, alerts)}\nCodeQL-Snapshot: ${JSON.stringify(snapshot)}`;
}

function filedSnapshots(registryPath: string): CodeqlFilingSnapshot[] {
  try {
    const rows = JSON.parse(readFileSync(join(dirname(registryPath), "opportunity-outcomes.json"), "utf8")) as Array<{ task?: unknown; codeql?: CodeqlFilingSnapshot }>;
    if (!Array.isArray(rows)) throw new Error("malformed opportunity filing receipts");
    return rows.filter((r) => r.task && r.codeql).map((r) => r.codeql!);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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
  options: { scannerSha?: string; ratified?: readonly CodeqlFilingSnapshot[] } = {},
): CodeqlQualityReconciliation {
  const ratified = options.ratified ?? filedSnapshots(registryPath);
  let result: CodeqlQualityReconciliation = {
    partition: partitionCodeqlQualityAlerts(alerts, feedback, []),
    updatedProposalIds: [],
    retiredProposalIds: [],
    deltas: [],
  };
  updateProposalRegistry(registryPath, (current) => {
    const partition = partitionCodeqlQualityAlerts(alerts, feedback, current);
    const actionableByRule = groupByRule([...partition.covered, ...partition.unassigned]);
    const currentCodeql = current.filter((proposal) => proposal.id.startsWith(CODEQL_QUALITY_PROPOSAL_PREFIX));
    const updatedProposalIds: string[] = [];
    const retiredProposalIds: string[] = [];
    const deltas: CodeqlQualityDelta[] = [];
    let changed = false;
    const next = current.flatMap((proposal) => {
      if (!proposal.id.startsWith(CODEQL_QUALITY_PROPOSAL_PREFIX)) return [proposal];
      if (ratified.some((pin) => pin.proposalId === proposal.id) || proposal.id.includes(":delta:")) return [proposal];
      const ruleId = proposal.id.slice(CODEQL_QUALITY_PROPOSAL_PREFIX.length);
      const matched = actionableByRule.get(ruleId);
      if (!matched || matched.length === 0) {
        retiredProposalIds.push(proposal.id);
        changed = true;
        return [];
      }
      const summary = snapshotSummary({ proposalId: proposal.id, ruleId, alertNumbers: matched.map((a) => a.id), scannerSha: options.scannerSha }, matched);
      if (proposal.summary === summary) return [proposal];
      updatedProposalIds.push(proposal.id);
      changed = true;
      return [{ ...proposal, summary }];
    });
    const activeRuleIds = new Set(activeCodeqlRuleIds(currentCodeql));
    for (const pin of ratified) activeRuleIds.add(pin.ruleId);
    const firstUnassignedRule = [...groupByRule(partition.unassigned).keys()].sort((left, right) => left.localeCompare(right))[0];
    let createdProposalId: string | undefined;
    if (firstUnassignedRule && !activeRuleIds.has(firstUnassignedRule)) {
      const id = codeqlQualityProposalId(firstUnassignedRule);
      next.push({
        id,
        summary: snapshotSummary({ proposalId: id, ruleId: firstUnassignedRule, alertNumbers: (actionableByRule.get(firstUnassignedRule) ?? []).map((a) => a.id), scannerSha: options.scannerSha }, actionableByRule.get(firstUnassignedRule) ?? []),
        evidenceAnchors: [],
        retainAfterRatification: true,
      });
      createdProposalId = id;
      changed = true;
    }
    for (const pin of ratified) {
      const known = new Set(ratified.filter((s) => s.ruleId === pin.ruleId).flatMap((s) => s.alertNumbers));
      for (const proposal of next) {
        const snapshot = codeqlSnapshot(proposal);
        if (proposal.id.includes(":delta:") && snapshot?.ruleId === pin.ruleId) for (const id of snapshot.alertNumbers) known.add(id);
      }
      const added = partition.eligible.filter((a) => a.ruleId === pin.ruleId && !known.has(a.id) && !partition.rejected.includes(a));
      if (added.length === 0) continue;
      const alertNumbers = added.map((a) => a.id);
      const suffix = createHash("sha256").update(JSON.stringify(alertNumbers)).digest("hex").slice(0, 16);
      const delta: CodeqlQualityDelta = { proposalId: `${pin.proposalId}:delta:${suffix}`, sourceProposalId: pin.proposalId, ruleId: pin.ruleId, alertNumbers, scannerSha: options.scannerSha };
      deltas.push(delta);
      next.push({ id: delta.proposalId, summary: snapshotSummary(delta, added), evidenceAnchors: [], retainAfterRatification: true });
      changed = true;
    }
    result = { partition, createdProposalId, updatedProposalIds, retiredProposalIds, deltas };
    return changed ? next : null;
  });
  return result;
}
