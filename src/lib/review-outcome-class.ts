import { createHash } from "node:crypto";
import { classifyDowngrade, parseReviewerUnable, parseReviewerVerdicts, withoutReviewerFollowUpRecords, type CriterionVerdict } from "./review.js";
import { requiredSemanticRefusal } from "./required-semantic-review.js";

export type ReviewOutcomeClass = "posted" | "withheld" | "refused";
export interface ReviewReplayInput {
  stage: "setup" | "semantic";
  plan_only: boolean;
  required_semantic: boolean;
  criteria_count: number;
  risk_present: boolean;
  budget_present: boolean;
  untasked: boolean;
  head_task_resolved: boolean;
  own_task_record_missing: boolean;
  reviewer_outcome: string;
  verdict_lines: readonly string[] | "unrecorded";
  setup_unavailable?: boolean;
  publication_refusal?: string;
  /** W1-T13849: criteria (1-based) with an explained, untagged FAIL on a proof that executed and passed. */
  downgrade_unclassified?: readonly number[];
  /** W1-T13849: an earlier attempt at this head and input already withheld for that reason. */
  downgrade_unclassified_withheld?: boolean;
}
export const DOWNGRADE_UNCLASSIFIED = "downgrade-unclassified";

/** W1-T13849: the criteria an explained, untagged FAIL would downgrade although their proof executed and passed. */
export function unclassifiedDowngrades(semantic: readonly (boolean | undefined)[] | undefined,
  clauses: readonly (string | undefined)[] | undefined,
  proofs: ReadonlyArray<Pick<CriterionVerdict, "proof_exec" | "floorMet">> | undefined): number[] {
  return (proofs ?? []).flatMap((proof, i) => {
    const clause = clauses?.[i];
    return semantic?.[i] === false && clause !== undefined && proof.floorMet === true &&
      proof.proof_exec === "executed_pass" && classifyDowngrade(clause).class === "unclassified" ? [i + 1] : [];
  });
}
export interface ReviewOutcomeDecision { class: ReviewOutcomeClass; reason: string }

/** Both production gates and the recorded-input replay use this decision. */
export function classifyReviewOutcome(input: ReviewReplayInput): ReviewOutcomeDecision {
  if (input.required_semantic && !input.plan_only) {
    if (!input.untasked && !input.head_task_resolved && !input.own_task_record_missing &&
        (!input.risk_present || !input.budget_present)) {
      return { class: "refused", reason: "head-task-metadata-unavailable" };
    }
    if (input.setup_unavailable) return { class: "refused", reason: "semantic-setup-unavailable" };
  }
  if (input.stage === "semantic" && input.verdict_lines !== "unrecorded") {
    const reason = requiredSemanticRefusal({ required: input.required_semantic, planOnly: input.plan_only,
      outcome: input.reviewer_outcome, criteriaCount: input.criteria_count,
      verdicts: parseReviewerVerdicts(input.verdict_lines.join("\n"), input.criteria_count),
      unable: parseReviewerUnable(input.verdict_lines.join("\n"), input.criteria_count) });
    if (reason !== undefined) return { class: "withheld", reason };
    if (!input.plan_only && (input.downgrade_unclassified?.length ?? 0) > 0 && input.downgrade_unclassified_withheld !== true) {
      return { class: "withheld", reason: DOWNGRADE_UNCLASSIFIED };
    }
  }
  if (input.publication_refusal) return { class: "withheld", reason: input.publication_refusal };
  return { class: "posted", reason: input.verdict_lines === "unrecorded" ? "setup-gate-only" : "review-gates-complete" };
}

/** Scan independently of the verdict parser; keep tokens, never the reviewer's prose. */
export function recordedReviewVerdictLines(transcript: string, count: number): string[] {
  const byCriterion = new Map<number, Map<string, string>>();
  for (const line of withoutReviewerFollowUpRecords(transcript).split(/\r?\n/)) {
    // W1-T11428: UNABLE is recorded as its own token, so a replay sees an answered-but-unable criterion.
    for (const match of line.matchAll(/REVIEW_VERDICT[ \t]+(\d+)[ \t]*:[ \t]*(PASS|FAIL|UNABLE)\b/gi)) {
      if (match[0].length > 128) continue;
      const criterion = Number(match[1]);
      if (criterion < 1 || criterion > count) continue;
      let tokens = byCriterion.get(criterion);
      if (!tokens) byCriterion.set(criterion, tokens = new Map());
      // One of each token retains contradictory evidence without unbounded duplicate lines.
      if (!tokens.has(match[2]!.toUpperCase())) tokens.set(match[2]!.toUpperCase(), match[0]);
    }
  }
  return [...byCriterion.values()].flatMap(tokens => [...tokens.values()]);
}

export function reviewReplayInputDigest(input: ReviewReplayInput): string {
  return createHash("sha256").update(JSON.stringify([
    input.stage, input.plan_only, input.required_semantic, input.criteria_count, input.risk_present,
    input.budget_present, input.untasked, input.head_task_resolved, input.own_task_record_missing,
    input.reviewer_outcome, input.verdict_lines, input.setup_unavailable === true,
    input.publication_refusal ?? null,
    ...(input.downgrade_unclassified === undefined ? [] : [input.downgrade_unclassified, input.downgrade_unclassified_withheld === true]),
  ])).digest("hex");
}

export function reviewReplayLedgerFields(input: ReviewReplayInput, decision: ReviewOutcomeDecision,
  identity: { pr_url: string; head_sha: string; reviewer_code_sha: string | null }): Record<string, unknown> {
  return { ...identity, input, input_digest: reviewReplayInputDigest(input),
    recorded_class: decision.class, reason: decision.reason };
}
