import type { FeedbackEntry } from "./feedback.js";
import { updateProposalRegistry, type Proposal } from "./inbox.js";
import type { RawAlert } from "./ops.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codeHealthFindingFingerprint, projectCodeHealth, validateCodeHealthProvenance, type CodeHealthProjectionInput, type CodeHealthScan } from "./code-health-projection.js";

export interface CodeHealthRelatedWork {
  repository: string;
  proposalId: string;
  taskId?: string;
  prUrl?: string;
  threadId?: string;
}

export interface CodeHealthImprovementOpportunity {
  id: string;
  snapshotId: string;
  repository: string;
  proposalId: string;
  ruleId: string;
  title: string;
  consequence: string;
  expectedResult: string;
  acceptanceIdeas: string[];
  uncertainty: string[];
  mayPlan: boolean;
  evidence: Array<{ fingerprint: string; sourceId: string; scanId: string; analyzedSha: string | null; observedAt: string | null; severity: string; title: string; path: string }>;
  effortMinutes: number | null;
  estimateKind: "modeled" | null;
  relatedWork: CodeHealthRelatedWork[];
}

export function qualityScanFromCollectedEvidence(input: {
  repository: string; analyzedSha: string; runId: string; requiredLanguages: string[]; artifacts: unknown[];
  analyses: Array<{ sarifId: string; analyzedSha: string; category: string; toolVersion: string; analysisKey: string; environmentHash: string; createdAt: string; rulesCount: number; error: string; warning: string }>;
  source: import("./ops.js").CodeScanningAlertsRead;
}): CodeHealthScan {
  const { repository, analyzedSha, runId, requiredLanguages } = input;
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(repository) || !/^[a-f0-9]{40}$/i.test(analyzedSha) ||
      !/^[1-9][0-9]{0,19}$/.test(runId) || !requiredLanguages.length || requiredLanguages.length > 32 ||
      new Set(requiredLanguages).size !== requiredLanguages.length || requiredLanguages.some(language => !/^[a-z][a-z0-9-]{0,63}$/.test(language)) ||
      input.artifacts.length > 32 || input.analyses.length > 100) throw new Error("Code health configured source inventory is invalid.");
  const artifacts = input.artifacts.map(value => validateCodeHealthProvenance(value, { repository, analyzedSha, runId, kind: "quality" }));
  if (new Set(artifacts.map(artifact => artifact.language)).size !== artifacts.length || artifacts.some(artifact => !requiredLanguages.includes(artifact.language!)))
    throw new Error("Code health source inventory repeats a language or includes an unconfigured analysis.");
  const reasons = new Set<string>(), matched = new Map<string, typeof input.analyses[number]>();
  for (const language of requiredLanguages) {
    const artifact = artifacts.find(value => value.language === language);
    if (!artifact || artifact.state !== "complete") { reasons.add("A configured language analysis is missing or incomplete."); continue; }
    const candidates = input.analyses.filter(value => value.sarifId === artifact.sarifId);
    const analysis = candidates[0];
    if (candidates.length !== 1 || !analysis || analysis.analyzedSha !== analyzedSha.toLowerCase() || analysis.category !== `/language:${language}` ||
        analysis.toolVersion !== artifact.toolVersion || !analysis.analysisKey || !/^[a-f0-9]{64}$/.test(analysis.environmentHash) ||
        !Number.isFinite(Date.parse(analysis.createdAt)) || Date.parse(analysis.createdAt) > Date.parse(artifact.observedAt) ||
        analysis.rulesCount !== artifact.ruleCount || analysis.error || analysis.warning) {
      reasons.add("A source artifact cannot be matched to its successful GitHub analysis."); continue;
    }
    matched.set(language, analysis);
  }
  const findings: CodeHealthScan["findings"] = [];
  if (!input.source.ok) reasons.add("The existing code-scanning read failed.");
  else {
    if (!input.source.analysisInstances || input.source.analysisInstances.length !== input.source.alerts.length) reasons.add("The alert read has incomplete analysis identities.");
    for (const alert of input.source.alerts) {
      if (alert.source !== "code-scanning" || alert.toolName?.trim().toLowerCase() !== "codeql" || !hasTag(alert, "quality") || !hasTag(alert, "maintainability")) continue;
      const instance = input.source.analysisInstances?.find(value => value.alertId === alert.id);
      const analysis = [...matched.values()].find(value => value.category === instance?.category);
      const identified = instance?.analyzedSha === analyzedSha.toLowerCase() && instance.ref === "refs/heads/main" && analysis !== undefined &&
        instance.toolVersion === analysis.toolVersion && instance.analysisKey === analysis.analysisKey && instance.environmentHash === analysis.environmentHash;
      if (!identified) reasons.add("A maintainability finding cannot be tied to the checked code and configuration.");
      if (!alert.ruleId || !/^[1-9][0-9]*$/.test(alert.id) || alert.ruleId.length > 256 ||
          !["critical", "high", "medium", "low"].includes(alert.severity) || !["open", "dismissed", "fixed"].includes(alert.state) ||
          !alert.location?.path || alert.location.path.startsWith("/") || alert.location.path.includes("\\") || alert.location.path.length > 4096 ||
          alert.location.path.split("/").some(part => !part || part === "..") || !alert.summary || alert.summary.length > 2048) {
        reasons.add("Some maintainability findings have incomplete identity, severity or location evidence."); continue;
      }
      if (alert.state === "fixed" && (!identified || instance!.instanceState !== "fixed")) {
        reasons.add("A reported fix is not yet confirmed by a matching analysis instance."); continue;
      }
      findings.push({ id: alert.id, ruleId: alert.ruleId, status: alert.state as "open" | "dismissed" | "fixed",
        severity: alert.severity as CodeHealthScan["findings"][number]["severity"], category: "maintainability", path: alert.location.path,
        title: alert.summary, effortMinutes: null });
    }
  }
  if (findings.length > 1000) throw new Error("Code health findings exceed the public contract bound; prior evidence must remain available.");
  const ordered = [...artifacts].sort((a, b) => a.language!.localeCompare(b.language!));
  const digest = (field: "scope" | "rulesVersion" | "configHash"): string | null => artifacts.length !== requiredLanguages.length ||
    artifacts.some(artifact => field === "scope" ? !artifact.scope.hash : !artifact[field]) ? null :
    createHash("sha256").update(JSON.stringify(ordered.map(artifact => [artifact.language, field === "scope" ? artifact.scope.hash : artifact[field]]))).digest("hex");
  const versions = [...new Set(artifacts.flatMap(artifact => artifact.toolVersion ? [artifact.toolVersion] : []))].sort().join(", ");
  if (!versions || versions.length > 256) reasons.add("A bounded tool-version inventory is unavailable.");
  return { kind: "quality", repository: repository.toLowerCase(), analyzedSha: analyzedSha.toLowerCase(),
    scanId: `codeql:${createHash("sha256").update(JSON.stringify(ordered.map(artifact => artifact.scanId))).digest("hex")}`,
    observedAt: ordered.map(artifact => artifact.observedAt).sort()[0] ?? "", state: !input.source.ok ? "unavailable" : reasons.size ? "partial" : "complete",
    scopeHash: digest("scope"), toolVersion: versions && versions.length <= 256 ? versions : null, rulesVersion: digest("rulesVersion"), configHash: digest("configHash"),
    exclusions: [...new Set(ordered.flatMap(artifact => artifact.exclusions))].sort(), reason: reasons.size ? [...reasons].join(" ") : null,
    checks: [{ id: "quality-maintainability-open", met: findings.every(finding => finding.status === "fixed"),
      reason: findings.some(finding => finding.status !== "fixed") ? "Known maintainability findings have not been verified as fixed." : "No open findings in the measured maintainability subset." }], findings };
}

export interface CodeHealthStoredSnapshot {
  version: "code-health-snapshot-v1";
  snapshotId: string;
  contentHash: string;
  input: CodeHealthProjectionInput;
}
export type CodeHealthSnapshotRead = { state: "observed"; snapshot: CodeHealthStoredSnapshot } | { state: "not_collected" | "unavailable"; reason: string };
export function readCodeHealthSnapshot(_stateDir: string, _repository: string, _snapshotId?: string): CodeHealthSnapshotRead {
  return { state: "not_collected", reason: "Code health has not been collected." };
}
export function publishCodeHealthSnapshot(_opts: { stateDir: string; input: CodeHealthProjectionInput; expectedSnapshotId: string | null; clock?: import("./clock.js").Clock }):
  { state: "published" | "duplicate"; snapshotId: string } | { state: "busy" | "superseded" | "unavailable"; reason: string } {
  return { state: "unavailable", reason: "Code health publication is not implemented." };
}

/** A read-only briefing over existing evidence and opportunity identities; never files or ranks. */
export function buildCodeHealthOpportunities(input: CodeHealthProjectionInput, relatedWork: readonly CodeHealthRelatedWork[] = []): CodeHealthImprovementOpportunity[] {
  const assessment = projectCodeHealth(input), scan = input.scans.find(value => value.kind === "quality");
  if (!scan) return [];
  const source = assessment.sources.find(value => value.kind === "quality")!;
  const retained = new Map(assessment.findings.map(finding => [finding.fingerprint, finding]));
  const groups = new Map<string, Set<string>>();
  for (const finding of scan.findings) {
    const fingerprint = codeHealthFindingFingerprint(assessment.repository, scan.kind, finding);
    if (finding.status !== "open" || !retained.has(fingerprint)) continue;
    const group = groups.get(finding.ruleId) ?? new Set<string>(); group.add(fingerprint); groups.set(finding.ruleId, group);
  }
  // The source scan IDs and normalized content, not the time a page read them, pin this briefing.
  const normalizedScans = (scans: readonly CodeHealthProjectionInput["scans"][number][]) => [...scans].sort((a, b) => a.kind.localeCompare(b.kind)).map(value => {
    const findings = new Map(value.findings.map(finding => [codeHealthFindingFingerprint(assessment.repository, value.kind, finding),
      [finding.id, finding.ruleId, finding.status, finding.severity, finding.category, finding.path, finding.title, finding.effortMinutes]]));
    return [value.kind, value.scanId, [...findings].sort(([a], [b]) => a.localeCompare(b))];
  });
  const snapshotId = createHash("sha256").update(JSON.stringify([assessment.repository, assessment.currentSha, assessment.analyzedSha, assessment.baselineSha,
    assessment.policyVersion, assessment.sources, assessment.checks, assessment.findings,
    normalizedScans(input.scans), normalizedScans(input.baseline?.scans ?? [])])).digest("hex");
  const scopedRelated = (proposalId: string): CodeHealthRelatedWork[] => {
    const rows = relatedWork.filter(work => work.repository.toLowerCase() === assessment.repository && work.proposalId === proposalId).map(work => {
      const value: CodeHealthRelatedWork = { repository: assessment.repository, proposalId };
      if (typeof work.taskId === "string" && /^[A-Z][A-Z0-9]*-T[0-9]+[A-Za-z]?$/.test(work.taskId)) value.taskId = work.taskId;
      if (typeof work.threadId === "string" && /^thread:[A-Za-z0-9:._/-]{1,500}$/.test(work.threadId)) value.threadId = work.threadId;
      if (typeof work.prUrl === "string" && URL.canParse(work.prUrl)) {
        const url = new URL(work.prUrl);
        if (url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.search && !url.hash &&
            url.pathname.toLowerCase().startsWith(`/${assessment.repository}/pull/`) && /^\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/[1-9][0-9]*$/i.test(url.pathname)) value.prUrl = url.href;
      }
      return value;
    });
    return [...new Map(rows.map(value => [JSON.stringify(value), value])).values()];
  };
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([ruleId, fingerprints]) => {
    const findings = [...fingerprints].sort().map(id => retained.get(id)!);
    const totalEffort = findings.every(finding => finding.effortMinutes !== null) ? findings.reduce((total, finding) => total + finding.effortMinutes!, 0) : null;
    const effortMinutes = totalEffort !== null && Number.isFinite(totalEffort) ? totalEffort : null;
    const mayPlan = source.state === "complete" && source.analyzedSha === assessment.currentSha && source.observedAt !== null;
    const proposalId = codeqlQualityProposalId(ruleId);
    return { id: `${assessment.repository}/${proposalId}`, snapshotId, repository: assessment.repository, proposalId, ruleId,
      title: findings.length === 1 ? findings[0]!.title : `Review ${findings.length} related maintainability findings`,
      consequence: `The scan reports: ${findings[0]!.title} Its effect on delivery has not been measured.`,
      expectedResult: "The same scan confirms these findings are fixed without narrowing the measured scope.",
      acceptanceIdeas: ["Repeat the analysis with the same tool, rules and measured scope.", "Verify each linked finding is fixed; disappearance or dismissal alone is insufficient.", "Keep the repository's required checks passing."],
      uncertainty: [...(assessment.state !== "measured" ? ["Some required checks have incomplete or incomparable evidence."] : []),
        ...(!mayPlan ? ["Refresh this finding's source before starting an actionable plan."] : [])], mayPlan,
      evidence: findings.map(finding => ({ fingerprint: finding.fingerprint, sourceId: source.id, scanId: scan.scanId, analyzedSha: source.analyzedSha,
        observedAt: source.observedAt, severity: finding.severity, title: finding.title, path: finding.path })),
      effortMinutes, estimateKind: effortMinutes === null ? null : "modeled" as const, relatedWork: scopedRelated(proposalId) };
  });
}

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
