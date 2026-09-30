/** Private, replayable reviewer-finding outcome fold. It never posts a status or infers correctness from workflow activity. */
export interface FindingFlowRow {
  fingerprint: string;
  ts: string | null;
  step: string;
  prRepo: string | null;
  prNumber: number | null;
  headSha: string | null;
  runId: string | null;
  servedModel: string | null;
  reviewModel: string | null;
  findingId: string | null;
  findingCategory: string | null;
  findingAnchorStatus: "verified" | "unsupported" | null;
  findingCaptureState: "unavailable" | "zero" | "captured" | "partial" | null;
  findingInvalidCount: number | null;
  findingDroppedCount: number | null;
  findingVerifiedCount: number | null;
  findingUnverifiedCount: number | null;
  costUsd: number | null;
  billingMode: "api" | "subscription" | null;
}

/** The caller must authenticate these independently. No raw ledger/GitHub resolved-thread row is accepted as a label. */
interface FindingEvidenceBase {
  findingId: string;
  prUrl: string;
  headSha: string;
  observedAt: string;
  provenance: string;
}
interface MechanismFalsifierEvidence extends FindingEvidenceBase {
  kind: "mechanism-falsifier";
  beforeFails: boolean;
  afterPasses: boolean;
  mechanismMatched: boolean;
}
interface HumanVerdictEvidence extends FindingEvidenceBase {
  kind: "human-acceptance" | "human-rejection";
  reason: string;
}
export type VerifiedFindingEvidence = MechanismFalsifierEvidence | HumanVerdictEvidence;

export type FindingOutcome = "confirmed-repair" | "human-accepted" | "human-rejected" | "conflicting" | "unknown" | "superseded";
export interface FindingOutcomeCell {
  model: string;
  category: string;
  reviewedPrs: number;
  capturedFindings: number;
  confirmedUseful: number;
  humanAccepted: number;
  humanRejected: number;
  conflicting: number;
  unknown: number;
  superseded: number;
  captureMissingPrs: number;
  malformedOrDropped: number;
  missingReceiptCount: number;
  unmatchableEvidence: number;
  verifiedUsefulPerReviewedPr: number | null;
  knownIssueRecall: null;
  falsePositiveRateOnLabeled: number | null;
  humanEffortMinutes: null;
  timeToActionMs: number | null;
  cashCostUsd: number | null;
  notionalCostUsd: number | null;
  costMissingReviews: number;
  winnerClaim: "unsupported";
}

export interface FindingOutcomeReport {
  findings: { findingId: string; prUrl: string; headSha: string; model: string; category: string; outcome: FindingOutcome;
    evidenceProvenance: string[] }[];
  cells: FindingOutcomeCell[];
  missingFindingIds: number;
  unmatchableEvidence: number;
  duplicateReceipts: number;
  /** An empty evidence source is not a negative label. */
  evidenceSource: "not-connected" | "trusted-input";
}

function prUrl(row: FindingFlowRow): string | null {
  return row.prRepo !== null && row.prNumber !== null ? `https://github.com/${row.prRepo}/pull/${row.prNumber}` : null;
}

function evidencePolarity(evidence: VerifiedFindingEvidence): "positive" | "negative" | "invalid" {
  if (!evidence.provenance || !Number.isFinite(Date.parse(evidence.observedAt))) return "invalid";
  if (evidence.kind === "mechanism-falsifier")
    return evidence.beforeFails && evidence.afterPasses && evidence.mechanismMatched ? "positive" : "invalid";
  if (!evidence.reason.trim() || !evidence.provenance.startsWith("github-verified:")) return "invalid";
  return evidence.kind === "human-acceptance" ? "positive" : "negative";
}

/** Projected rows only; verified evidence enters through a distinct, authenticated caller seam. */
export function deriveReviewFindingOutcomes(rows: readonly FindingFlowRow[], evidence: readonly VerifiedFindingEvidence[] = []): FindingOutcomeReport {
  const posted = rows.filter((row) => row.step === "review.posted" && prUrl(row) !== null && row.headSha !== null);
  const reviews = new Map<string, FindingFlowRow>();
  for (const row of posted) {
    const key = `${prUrl(row)}|${row.headSha}`;
    if (!reviews.has(key) || (reviews.get(key)!.ts ?? "") < (row.ts ?? "")) reviews.set(key, row);
  }
  const findings = new Map<string, FindingFlowRow>();
  let duplicateReceipts = 0;
  let missingFindingIds = 0;
  for (const row of rows) {
    if (row.step !== "review.finding") continue;
    if (!row.findingId || !prUrl(row) || !row.headSha) { missingFindingIds++; continue; }
    const key = `${row.findingId}|${prUrl(row)}|${row.headSha}`;
    if (findings.has(key)) { duplicateReceipts++; continue; }
    findings.set(key, row);
  }
  const evidenceByKey = new Map<string, VerifiedFindingEvidence[]>();
  let unmatchableEvidence = 0;
  for (const item of evidence) {
    const key = `${item.findingId}|${item.prUrl}|${item.headSha}`;
    if (!findings.has(key) || evidencePolarity(item) === "invalid") { unmatchableEvidence++; continue; }
    evidenceByKey.set(key, [...(evidenceByKey.get(key) ?? []), item]);
  }
  const labeled = [...findings].map(([key, row]) => {
    const proof = evidenceByKey.get(key) ?? [];
    const positive = proof.some((item) => evidencePolarity(item) === "positive");
    const negative = proof.some((item) => evidencePolarity(item) === "negative");
    const repair = proof.some((item) => item.kind === "mechanism-falsifier" && evidencePolarity(item) === "positive");
    const review = reviews.get(`${prUrl(row)}|${row.headSha}`);
    const superseded = posted.some((candidate) => prUrl(candidate) === prUrl(row) && candidate.headSha !== row.headSha &&
      (candidate.ts ?? "") > (row.ts ?? ""));
    const outcome: FindingOutcome = positive && negative ? "conflicting" : row.findingAnchorStatus !== "verified" ? "unknown"
      : repair ? "confirmed-repair" : positive ? "human-accepted" : negative ? "human-rejected" : superseded ? "superseded" : "unknown";
    return { findingId: row.findingId!, prUrl: prUrl(row)!, headSha: row.headSha!, model: row.servedModel ?? row.reviewModel ?? review?.reviewModel ?? "unknown",
      category: row.findingCategory ?? "unknown", outcome, evidenceProvenance: proof.map((item) => item.provenance).sort(),
      observedAt: row.ts, actionAt: proof.map((item) => item.observedAt).sort()[0] ?? null };
  });
  const models = new Set([...posted.map((row) => row.reviewModel ?? "unknown"), ...labeled.map((item) => item.model)]);
  const categories = new Set(labeled.map((item) => item.category));
  if (categories.size === 0) categories.add("all");
  const cells: FindingOutcomeCell[] = [];
  for (const model of [...models].sort()) for (const category of [...categories].sort()) {
    const units = labeled.filter((item) => item.model === model && (category === "all" || item.category === category));
    if (units.length === 0 && category !== "all") continue;
    const modelReviews = [...reviews.values()].filter((row) => (row.reviewModel ?? "unknown") === model);
    const count = (outcome: FindingOutcome) => units.filter((item) => item.outcome === outcome).length;
    const missingReceipts = modelReviews.map((review) => {
      const declared = review.findingVerifiedCount === null || review.findingUnverifiedCount === null ? null
        : review.findingVerifiedCount + review.findingUnverifiedCount;
      const actual = labeled.filter((item) => item.prUrl === prUrl(review) && item.headSha === review.headSha).length;
      return declared === null ? 0 : Math.max(0, declared - actual);
    });
    const reviewerCalls = rows.filter((row) => row.step === "review.reviewer" && row.runId !== null &&
      modelReviews.some((review) => review.runId === row.runId));
    const knownCost = reviewerCalls.filter((row) => row.costUsd !== null && row.billingMode !== null);
    const actionTimes = units.map((unit) => unit.actionAt && unit.observedAt ? Date.parse(unit.actionAt) - Date.parse(unit.observedAt) : null)
      .filter((ms): ms is number => ms !== null && Number.isFinite(ms) && ms >= 0);
    const labeledCount = count("confirmed-repair") + count("human-accepted") + count("human-rejected");
    cells.push({ model, category, reviewedPrs: modelReviews.length, capturedFindings: units.length,
      confirmedUseful: count("confirmed-repair"), humanAccepted: count("human-accepted"), humanRejected: count("human-rejected"),
      conflicting: count("conflicting"), unknown: count("unknown"), superseded: count("superseded"),
      captureMissingPrs: modelReviews.filter((row, index) => row.findingCaptureState === null || row.findingCaptureState === "unavailable" || row.findingCaptureState === "partial" || missingReceipts[index]! > 0).length,
      malformedOrDropped: modelReviews.reduce((sum, row) => sum + (row.findingInvalidCount ?? 0) + (row.findingDroppedCount ?? 0), 0),
      missingReceiptCount: missingReceipts.reduce((sum, count) => sum + count, 0),
      unmatchableEvidence,
      verifiedUsefulPerReviewedPr: modelReviews.length ? count("confirmed-repair") / modelReviews.length : null,
      knownIssueRecall: null, falsePositiveRateOnLabeled: labeledCount ? count("human-rejected") / labeledCount : null,
      humanEffortMinutes: null, timeToActionMs: actionTimes.length ? actionTimes.reduce((sum, ms) => sum + ms, 0) / actionTimes.length : null,
      cashCostUsd: knownCost.length ? knownCost.filter((row) => row.billingMode === "api").reduce((sum, row) => sum + row.costUsd!, 0) : null,
      notionalCostUsd: knownCost.length ? knownCost.filter((row) => row.billingMode === "subscription").reduce((sum, row) => sum + row.costUsd!, 0) : null,
      costMissingReviews: modelReviews.length - new Set(knownCost.map((row) => row.runId)).size,
      winnerClaim: "unsupported" });
  }
  return { findings: labeled.map(({ observedAt: _observedAt, actionAt: _actionAt, ...item }) => item), cells,
    missingFindingIds, unmatchableEvidence, duplicateReceipts, evidenceSource: evidence.length ? "trusted-input" : "not-connected" };
}
