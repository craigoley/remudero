/** Blinded, opt-in bug/benign reviewer evaluation. No status, routing or live PR writes. */
import { createHash } from "node:crypto";
import type { GoldenCorpusItem } from "./golden-corpus.js";

type Arm = "bug" | "benign";
type LabelEvidence = { kind: "executable-falsifier" | "human-reviewed"; digest: string; observed: boolean };
export interface PairedReviewCase {
  id: string;
  corpusTaskId: string;
  repo: string;
  createdAt: string;
  baseSha: string;
  taskContextDigest: string;
  changedFileShapeDigest: string;
  issueCategory: string;
  bug: { headSha: string; label: "faulty"; evidence: LabelEvidence };
  benign: { headSha: string; label: "benign"; evidence: LabelEvidence };
  sealedMechanismDigest: string;
}
export interface PinnedReviewStack { harness: string; prompt: string; tool: string; scorer: string; environment: string }
export interface BlindedReviewInput {
  opaqueArmId: string;
  repo: string;
  baseSha: string;
  headSha: string;
  taskContextDigest: string;
  changedFileShapeDigest: string;
  stack: PinnedReviewStack;
  selectionPropensity: 0.5;
}
export interface ReplayFinding { id: string; anchorSupported: boolean; mechanism: string; remedy: string | null }
export interface ReviewerReplayOutput {
  verdict: "fail" | "pass" | "unknown";
  findings: ReplayFinding[] | null;
  assignmentId?: string;
  requestedModel?: string;
  servedModel?: string;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  billingMode?: "api" | "subscription";
  observedStack?: PinnedReviewStack;
}
export interface IndependentFindingScore { mechanismMatched: boolean; lineMatched: boolean; remedyActionable: boolean }
export interface PairedReviewEvalInput {
  pairs: readonly PairedReviewCase[];
  /** Admitted W1-T4619 items; proof text is never passed to review. */
  corpus: readonly GoldenCorpusItem[];
  stack: PinnedReviewStack;
  seed: string;
  /** Independently compare both real diffs and task context against the sealed manifest. */
  validatePair?: (pair: PairedReviewCase, item: GoldenCorpusItem) => boolean;
  /** Must independently recheck each sealed label against the source case file or human-authenticated record. */
  validateLabel?: (pair: PairedReviewCase, arm: Arm) => boolean;
  /** Re-read the existing paid-pilot consent/spend control before EACH call. No admission means no spend. */
  admitReview?: (input: BlindedReviewInput) => Promise<{ allowed: boolean; reason: string }>;
  /** Read-only, isolated reviewer call; this evaluator has no GitHub/ledger/status capability. */
  review: (input: BlindedReviewInput) => Promise<ReviewerReplayOutput>;
  /** Independent scorer sees sealed evidence only AFTER the reviewer call. Absent scorer means unknown diagnosis. */
  score?: (pair: PairedReviewCase, finding: ReplayFinding) => IndependentFindingScore;
}
export interface PairedReviewResult {
  caseId: string;
  sealedManifestDigest: string;
  baseSha: string;
  bugHeadSha: string;
  benignHeadSha: string;
  createdAt: string;
  issueCategory: string;
  state: "graded" | "incomplete" | "ungradable";
  reason: string | null;
  order: [string, string] | null;
  selectionPropensity: 0.5;
  bugDetected: boolean | null;
  benignSpecific: boolean | null;
  diagnosisCredit: boolean | null;
  benignFalseComments: number | null;
  findingIds: { bug: string[]; benign: string[] };
  assignments: { bug: string | null; benign: string | null };
  models: { bug: string | null; benign: string | null };
  missing: string[];
  elapsedMs: number | null;
  tokens: number | null;
  cashCostUsd: number | null;
  notionalCostUsd: number | null;
}
export interface PairedReviewReport {
  seedDigest: string;
  stack: PinnedReviewStack;
  pairs: PairedReviewResult[];
  totalPairs: number;
  gradedPairs: number;
  ungradablePairs: number;
  incompletePairs: number;
  pairedVerdicts: { bugOnly: number; benignOnly: number; bothBlock: number; neitherBlock: number };
  pairedDifference: number | null;
  pairedStandardError: number | null;
  cashCostUsd: number | null;
  notionalCostUsd: number | null;
  costMissingArms: number;
  byModel: { model: string; issueCategory: string; gradedPairs: number; bugDetected: number; benignSpecific: number;
    diagnosisCredit: number; benignFalseComments: number; cashCostUsd: number | null; notionalCostUsd: number | null }[];
  winnerClaim: "unsupported";
  causalClaims: "none";
}

const hex = (value: string): boolean => /^[a-f0-9]{40,64}$/.test(value);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const finiteNonnegative = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;

function admission(pair: PairedReviewCase, item: GoldenCorpusItem | undefined,
  validate: PairedReviewEvalInput["validateLabel"], validatePair: PairedReviewEvalInput["validatePair"]): string | null {
  if (!item || !item.heldOut || item.taskId !== pair.corpusTaskId || !item.proofs.length) return "held-out-corpus-missing";
  if (!hex(pair.baseSha) || pair.baseSha !== item.baseSha || !hex(pair.bug.headSha) || pair.bug.headSha !== item.headSha ||
      !hex(pair.benign.headSha) || pair.benign.headSha === pair.bug.headSha ||
      !hex(pair.taskContextDigest) || !hex(pair.changedFileShapeDigest) || !hex(pair.sealedMechanismDigest) ||
      !Number.isFinite(Date.parse(pair.createdAt)) || !pair.repo || !pair.id || !/^[a-z][a-z0-9_-]{1,31}$/.test(pair.issueCategory))
    return "pair-provenance-invalid";
  if (pair.bug.label !== "faulty" || pair.benign.label !== "benign") return "opposite-labels-missing";
  try {
    if (!validatePair?.(pair, item)) return "pair-provenance-unverified";
    if (!pair.bug.evidence.observed || !hex(pair.bug.evidence.digest) || !validate?.(pair, "bug")) return "bug-label-unverified";
    if (!pair.benign.evidence.observed || !hex(pair.benign.evidence.digest) || !validate?.(pair, "benign")) return "benign-label-unverified";
  } catch (error) {
    // A failed independent read is an ungradable label, not permission to infer one from the manifest.
    return `independent-validation-unavailable:${error instanceof Error ? error.name : "unknown"}`;
  }
  return null;
}

function emptyResult(pair: PairedReviewCase, reason: string): PairedReviewResult {
  return { caseId: pair.id, sealedManifestDigest: hash(JSON.stringify(pair)), baseSha: pair.baseSha,
    bugHeadSha: pair.bug.headSha, benignHeadSha: pair.benign.headSha, createdAt: pair.createdAt,
    issueCategory: pair.issueCategory, state: "ungradable", reason, order: null, selectionPropensity: 0.5,
    bugDetected: null, benignSpecific: null, diagnosisCredit: null, benignFalseComments: null,
    findingIds: { bug: [], benign: [] }, assignments: { bug: null, benign: null }, models: { bug: null, benign: null },
    missing: [reason], elapsedMs: null, tokens: null, cashCostUsd: null, notionalCostUsd: null };
}

/** One pair is the unit of randomization and analysis; generic blocks never earn diagnosis credit. */
export async function runPairedReviewEvaluation(input: PairedReviewEvalInput): Promise<PairedReviewReport> {
  const corpus = new Map(input.corpus.map((item) => [item.taskId, item]));
  const results: PairedReviewResult[] = [];
  const seen = new Set<string>();
  let costMissingArms = 0;
  const stackPinned = Object.values(input.stack).every((value) => hex(value));
  for (const pair of input.pairs) {
    const why = seen.has(pair.id) ? "duplicate-case" : !stackPinned || !input.seed ? "stack-or-seed-unpinned"
      : admission(pair, corpus.get(pair.corpusTaskId), input.validateLabel, input.validatePair);
    seen.add(pair.id);
    if (why !== null) { results.push(emptyResult(pair, why)); continue; }
    const order: [Arm, Arm] = parseInt(hash(`${input.seed}:${pair.id}`).slice(0, 2), 16) % 2 ? ["bug", "benign"] : ["benign", "bug"];
    const observed: Partial<Record<Arm, ReviewerReplayOutput>> = {};
    const missing: string[] = [];
    for (const arm of order) {
      const blinded: BlindedReviewInput = { opaqueArmId: hash(`${input.seed}:${pair.id}:${pair[arm].headSha}`), repo: pair.repo,
        baseSha: pair.baseSha, headSha: pair[arm].headSha, taskContextDigest: pair.taskContextDigest,
        changedFileShapeDigest: pair.changedFileShapeDigest, stack: input.stack, selectionPropensity: 0.5 };
      let admission: { allowed: boolean; reason: string } | undefined;
      try { admission = await input.admitReview?.(blinded); }
      catch (error) { admission = { allowed: false, reason: `admission-read-failed:${error instanceof Error ? error.name : "unknown"}` }; }
      if (admission?.allowed !== true) { missing.push(`${arm}:admission-paused:${admission?.reason ?? "no-paid-pilot-admission"}`); continue; }
      try { observed[arm] = await input.review(blinded); }
      catch (error) {
        // A failed call has no spend receipt either; it is missing, never a PASS or a caught bug.
        missing.push(`${arm}:replay-error:${error instanceof Error ? error.name : "unknown"}`);
        costMissingArms++;
      }
    }
    const bug = observed.bug;
    const benign = observed.benign;
    const armMissing = (arm: Arm, output: ReviewerReplayOutput | undefined): void => {
      if (!output) return;
      if (!output.assignmentId || !output.servedModel) missing.push(`${arm}:assignment-missing`);
      if (!output.observedStack || Object.keys(input.stack).some((key) => output.observedStack?.[key as keyof PinnedReviewStack] !== input.stack[key as keyof PinnedReviewStack]))
        missing.push(`${arm}:stack-unpinned`);
      if (output.findings === null) missing.push(`${arm}:finding-extraction-missing`);
      if (!finiteNonnegative(output.costUsd) || !output.billingMode) { missing.push(`${arm}:cost-missing`); costMissingArms++; }
    };
    armMissing("bug", bug);
    armMissing("benign", benign);
    if (bug?.servedModel && benign?.servedModel && bug.servedModel !== benign.servedModel) missing.push("served-model-mismatch");
    const scoreable = bug && benign && bug.findings !== null && benign.findings !== null;
    const bugDetected = scoreable ? bug.verdict === "fail" : null;
    const benignSpecific = scoreable ? benign.verdict === "pass" : null;
    let diagnosisCredit: boolean | null = null;
    if (scoreable && input.score) {
      try {
        diagnosisCredit = bug.verdict === "fail" && bug.findings!.some((finding) => {
          if (!finding.anchorSupported) return false;
          const scored = input.score!(pair, finding);
          return scored.mechanismMatched && scored.lineMatched && scored.remedyActionable;
        });
      } catch (error) { missing.push(`independent-scorer-error:${error instanceof Error ? error.name : "unknown"}`); }
    }
    if (scoreable && !input.score) missing.push("independent-scorer-missing");
    const calls = [bug, benign].filter((value): value is ReviewerReplayOutput => value !== undefined);
    const knownCosts = calls.filter((value) => finiteNonnegative(value.costUsd) && value.billingMode !== undefined);
    const costComplete = calls.length === 2 && knownCosts.length === 2;
    const measure = (key: "elapsedMs" | "inputTokens" | "outputTokens"): number | null =>
      calls.length === 2 && calls.every((call) => finiteNonnegative(call[key]))
        ? calls.reduce((sum, call) => sum + call[key]!, 0) : null;
    const inputTokens = measure("inputTokens");
    const outputTokens = measure("outputTokens");
    const incomplete = !scoreable || missing.some((reason) => reason.includes(":admission-paused:") || reason.includes(":replay-error:") || reason.endsWith("assignment-missing") ||
      reason.endsWith("finding-extraction-missing") || reason.endsWith("stack-unpinned") || reason === "served-model-mismatch" ||
      reason.startsWith("independent-scorer-"));
    results.push({ caseId: pair.id, sealedManifestDigest: hash(JSON.stringify(pair)), baseSha: pair.baseSha,
      bugHeadSha: pair.bug.headSha, benignHeadSha: pair.benign.headSha, createdAt: pair.createdAt,
      issueCategory: pair.issueCategory, state: incomplete ? "incomplete" : "graded",
      reason: incomplete ? "replay-or-extraction-incomplete" : null,
      order: [hash(`${input.seed}:${pair.id}:${pair[order[0]].headSha}`), hash(`${input.seed}:${pair.id}:${pair[order[1]].headSha}`)],
      selectionPropensity: 0.5, bugDetected, benignSpecific, diagnosisCredit,
      benignFalseComments: scoreable ? benign.findings!.length : null,
      findingIds: { bug: bug?.findings?.map((item) => item.id) ?? [], benign: benign?.findings?.map((item) => item.id) ?? [] },
      assignments: { bug: bug?.assignmentId ?? null, benign: benign?.assignmentId ?? null },
      models: { bug: bug?.servedModel ?? null, benign: benign?.servedModel ?? null }, missing,
      elapsedMs: measure("elapsedMs"), tokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
      cashCostUsd: costComplete ? knownCosts.filter((call) => call.billingMode === "api").reduce((sum, call) => sum + call.costUsd!, 0) : null,
      notionalCostUsd: costComplete ? knownCosts.filter((call) => call.billingMode === "subscription").reduce((sum, call) => sum + call.costUsd!, 0) : null });
  }
  const graded = results.filter((result) => result.state === "graded" && result.bugDetected !== null && result.benignSpecific !== null);
  const bothBlock = graded.filter((result) => result.bugDetected && !result.benignSpecific).length;
  const bugOnly = graded.filter((result) => result.bugDetected && result.benignSpecific).length;
  const benignOnly = graded.filter((result) => !result.bugDetected && !result.benignSpecific).length;
  const neitherBlock = graded.filter((result) => !result.bugDetected && result.benignSpecific).length;
  const n = graded.length;
  const differences = graded.map((result) => Number(result.bugDetected) - Number(!result.benignSpecific));
  const pairedDifference = n ? differences.reduce((sum, value) => sum + value, 0) / n : null;
  const pairedStandardError = n > 1 && pairedDifference !== null
    ? Math.sqrt(differences.reduce((sum, value) => sum + (value - pairedDifference) ** 2, 0) / (n * (n - 1))) : null;
  const costs = results.filter((result) => result.cashCostUsd !== null || result.notionalCostUsd !== null);
  const byModel = new Map<string, PairedReviewReport["byModel"][number]>();
  for (const result of graded) {
    const model = result.models.bug!;
    const key = `${model}\n${result.issueCategory}`;
    const cell = byModel.get(key) ?? { model, issueCategory: result.issueCategory, gradedPairs: 0, bugDetected: 0,
      benignSpecific: 0, diagnosisCredit: 0, benignFalseComments: 0, cashCostUsd: null, notionalCostUsd: null };
    cell.gradedPairs++;
    cell.bugDetected += Number(result.bugDetected);
    cell.benignSpecific += Number(result.benignSpecific);
    cell.diagnosisCredit += Number(result.diagnosisCredit);
    cell.benignFalseComments += result.benignFalseComments ?? 0;
    if (result.cashCostUsd !== null) cell.cashCostUsd = (cell.cashCostUsd ?? 0) + result.cashCostUsd;
    if (result.notionalCostUsd !== null) cell.notionalCostUsd = (cell.notionalCostUsd ?? 0) + result.notionalCostUsd;
    byModel.set(key, cell);
  }
  return { seedDigest: hash(input.seed), stack: { ...input.stack }, pairs: results, totalPairs: results.length, gradedPairs: n,
    ungradablePairs: results.filter((result) => result.state === "ungradable").length,
    incompletePairs: results.filter((result) => result.state === "incomplete").length,
    pairedVerdicts: { bugOnly, benignOnly, bothBlock, neitherBlock }, pairedDifference, pairedStandardError,
    cashCostUsd: costMissingArms === 0 && costs.length ? costs.reduce((sum, result) => sum + result.cashCostUsd!, 0) : null,
    notionalCostUsd: costMissingArms === 0 && costs.length ? costs.reduce((sum, result) => sum + result.notionalCostUsd!, 0) : null,
    costMissingArms, byModel: [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model) || a.issueCategory.localeCompare(b.issueCategory)),
    winnerClaim: "unsupported", causalClaims: "none" };
}
