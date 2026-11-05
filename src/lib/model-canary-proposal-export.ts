/** Pure private proposal drafts from repeated evidence; never measures or activates a change. */
import { createHash } from "node:crypto";

export type ImprovementFailureClassV1 =
  | "wrong-model-selection" | "fallback-mismatch" | "tool-use-failure" | "context-loss"
  | "latency-regression" | "cost-regression" | "scorer-disagreement";
export interface ImprovementEvidenceRowV1 {
  signatureId: string;
  failureClass: ImprovementFailureClassV1;
  caseId: string;
  sourceFamilyId: string;
  incidentRootId: string;
  evidenceDigest: string;
  executionSource: "native-provider-execution" | "synthetic-control-replay";
}
export interface BuildExperimentProposalInputV1 {
  evidence: readonly ImprovementEvidenceRowV1[];
  maxProposals?: number;
}
export interface ExperimentProposalDraftV1 {
  proposalDigest: string;
  failureClass: ImprovementFailureClassV1;
  repeatedEvidence: number;
  independentClusters: number;
  sourceEvidenceDigests: string[];
  hypothesis: string;
  falsifier: string;
  boundedScope: { area: "smart-router-evaluation"; maxFiles: 3; maxChangedLines: 200 };
  verification: string[];
  rollbackRequirement: string;
  outcome: "unmeasured";
  activation: "not-authorized";
}
export interface ExperimentProposalExportV1 {
  version: "model-canary-experiment-proposals-v1";
  private: true;
  state: "available" | "unavailable";
  proposals: ExperimentProposalDraftV1[];
  exclusions: { syntheticControlEvidence: number };
  effects: { measured: false; createsTasks: false; createsSchedules: false;
    writesLedger: false; writesRoutingPolicy: false; writesPromotionState: false };
}
const DIGEST = /^[0-9a-f]{64}$/;
const FAILURE_CLASSES: readonly ImprovementFailureClassV1[] = [
  "wrong-model-selection", "fallback-mismatch", "tool-use-failure", "context-loss",
  "latency-regression", "cost-regression", "scorer-disagreement",
];
const MAX_EVIDENCE = 10_000, MAX_ID = 160, MAX_PROPOSALS = 32;
const proposalExportText = (value: unknown, max = MAX_ID): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const proposalExportCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const proposalExportSha256 = (value: string) => createHash("sha256").update(value).digest("hex");
class Union {
  parent = new Map<string, string>();
  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) { this.parent.set(x, x); return x; }
    if (p === x) return x;
    const root = this.find(p); this.parent.set(x, root); return root;
  }
  join(a: string, b: string) {
    const x = this.find(a), y = this.find(b);
    if (x !== y) this.parent.set(proposalExportCompare(x, y) < 0 ? y : x, proposalExportCompare(x, y) < 0 ? x : y);
  }
}
const proposalExportHypothesis: Record<ImprovementFailureClassV1, { hypothesis: string; falsifier: string }> = {
  "wrong-model-selection": { hypothesis: "A bounded router feature or calibration change may reduce wrong-model selection on the affected evaluation slice.",
    falsifier: "On a preregistered sealed holdout, the changed router does not reduce wrong-model selections versus the frozen qualified baseline." },
  "fallback-mismatch": { hypothesis: "A bounded fallback-selection change may preserve task fit when the primary route is unavailable.",
    falsifier: "On a preregistered sealed holdout with primary-route failures, fallback task success is not higher than the frozen qualified baseline." },
  "tool-use-failure": { hypothesis: "A bounded tool-capability routing change may reduce tool-use failures for the affected task class.",
    falsifier: "On a preregistered sealed holdout, tool-use failure rate is not lower than the frozen qualified baseline." },
  "context-loss": { hypothesis: "A bounded context-retention routing change may reduce failures associated with missing required context.",
    falsifier: "On a preregistered sealed holdout, context-loss failures are not lower than the frozen qualified baseline." },
  "latency-regression": { hypothesis: "A bounded routing constraint may reduce tail latency while preserving task success.",
    falsifier: "The changed route does not reduce p95 latency or reduces task success on the preregistered sealed holdout." },
  "cost-regression": { hypothesis: "A bounded routing constraint may reduce cost while preserving task success.",
    falsifier: "The changed route does not reduce cost per successful task or reduces task success on the preregistered sealed holdout." },
  "scorer-disagreement": { hypothesis: "A bounded scorer-calibration review may resolve systematic disagreement without changing router policy.",
    falsifier: "Independent adjudication does not confirm a repeated scorer disagreement on the preregistered sample." },
};
function validateProposalEvidenceRow(value: unknown): ImprovementEvidenceRowV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("experiment-proposal-evidence-invalid");
  const row = value as Record<string, unknown>;
  const keys = ["signatureId", "failureClass", "caseId", "sourceFamilyId", "incidentRootId", "evidenceDigest", "executionSource"];
  if (Object.keys(row).sort().join("\0") !== [...keys].sort().join("\0")
    || !proposalExportText(row.signatureId, 128) || !FAILURE_CLASSES.includes(row.failureClass as ImprovementFailureClassV1)
    || !proposalExportText(row.caseId) || !proposalExportText(row.sourceFamilyId) || !proposalExportText(row.incidentRootId)
    || typeof row.evidenceDigest !== "string" || !DIGEST.test(row.evidenceDigest)
    || (row.executionSource !== "native-provider-execution" && row.executionSource !== "synthetic-control-replay"))
    throw new Error("experiment-proposal-evidence-invalid");
  return value as ImprovementEvidenceRowV1;
}
export function buildExperimentProposal(input: BuildExperimentProposalInputV1): ExperimentProposalExportV1 {
  if (!input || !Array.isArray(input.evidence) || input.evidence.length > MAX_EVIDENCE)
    throw new Error("experiment-proposal-input-invalid");
  const maxProposals = input.maxProposals ?? 16;
  if (!Number.isSafeInteger(maxProposals) || maxProposals < 1 || maxProposals > MAX_PROPOSALS)
    throw new Error("experiment-proposal-bound-invalid");
  const unique = new Map<string, ImprovementEvidenceRowV1>();
  let syntheticControlEvidence = 0;
  for (const raw of input.evidence) {
    const row = validateProposalEvidenceRow(raw);
    if (row.executionSource === "synthetic-control-replay") { syntheticControlEvidence++; continue; }
    const key = JSON.stringify([row.signatureId, row.caseId, row.sourceFamilyId, row.incidentRootId]);
    const prior = unique.get(key);
    if (prior && (prior.failureClass !== row.failureClass || prior.evidenceDigest !== row.evidenceDigest))
      throw new Error("experiment-proposal-duplicate-evidence-contradictory");
    unique.set(key, row);
  }
  const groups = new Map<string, ImprovementEvidenceRowV1[]>();
  for (const row of unique.values()) {
    const key = JSON.stringify([row.signatureId, row.failureClass]);
    const rows = groups.get(key) ?? []; rows.push(row); groups.set(key, rows);
  }
  const proposals: ExperimentProposalDraftV1[] = [];
  for (const [key, rows] of [...groups.entries()].sort(([a], [b]) => proposalExportCompare(a, b))) {
    if (proposals.length >= maxProposals) break;
    const union = new Union();
    for (const row of rows) union.join(JSON.stringify(["family", row.sourceFamilyId]), JSON.stringify(["root", row.incidentRootId]));
    const clusters = new Set(rows.map(row => union.find(JSON.stringify(["family", row.sourceFamilyId]))));
    const cases = new Set(rows.map(row => row.caseId));
    if (clusters.size < 2 || cases.size < 2) continue;
    const category = rows[0]!.failureClass, statements = proposalExportHypothesis[category];
    const sourceEvidenceDigests = [...new Set(rows.map(row => row.evidenceDigest))].sort(proposalExportCompare);
    const body = JSON.stringify([key, sourceEvidenceDigests, clusters.size, cases.size]);
    proposals.push({ proposalDigest: proposalExportSha256(body), failureClass: category, repeatedEvidence: rows.length,
      independentClusters: clusters.size, sourceEvidenceDigests, ...statements,
      boundedScope: { area: "smart-router-evaluation", maxFiles: 3, maxChangedLines: 200 },
      verification: ["predeclare the endpoint and sealed holdout before observing outcomes",
        "compare against the frozen qualified baseline using independent source-family clusters",
        "retain benchmark, observational, and randomized denominators separately"],
      rollbackRequirement: "Revert the bounded change if the preregistered sealed-holdout falsifier is met or required evidence is incomplete.",
      outcome: "unmeasured", activation: "not-authorized" });
  }
  return { version: "model-canary-experiment-proposals-v1", private: true,
    state: proposals.length ? "available" : "unavailable", proposals, exclusions: { syntheticControlEvidence },
    effects: { measured: false, createsTasks: false, createsSchedules: false, writesLedger: false,
      writesRoutingPolicy: false, writesPromotionState: false } };
}
